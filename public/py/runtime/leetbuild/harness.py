"""
Runs a step's harness against the learner's files. A harness is a Python module with one
`check_<id>(ctx)` per check (sync or async); each check starts from a clean world — empty Redis,
empty broker, no gRPC peers, the clock at zero, every learner/support module unloaded — and
passes unless it raises. `AssertionError` messages become the verdict's explanation.

`ctx` is the harness's handle on that world: the learner's modules (`ctx.load`), Redis
(`ctx.redis`, `ctx.redis_bytes`, and `ctx.redis_after` to land a parallel request between two of
the learner's commands), the broker (`ctx.kafka`: records, commits, stalls), the gRPC registry
(`ctx.grpc`: peers at addresses, latency, failures, the calls made), the clock (`ctx.clock`),
Postgres (`ctx.db`: rows, transactions, the queries run), an in-memory HTTP client for ASGI apps
(`ctx.client`) and `ctx.drain`, which runs a consumer/sweeper loop until the runtime stops it.

A check grades what the code does, never what it looks like: there is deliberately no access to
the learner's source.
"""
from __future__ import annotations

import asyncio
import importlib
import inspect
import sys
import traceback
from typing import Any, Awaitable, Callable, Sequence

import fakeredis
from fakeredis._socket._base import BaseFakeSocket
import httpx

from .clock import CLOCK
from .db import DB
from .grpcsim import REGISTRY
from .kafka import BROKER
from .metrics import METRICS

WORK = "/work"
SUPPORT = "/support"
SERVER = fakeredis.FakeServer()


class RedisProbe:
    def __init__(self, key: bytes, fn: Callable[[], Any]) -> None:
        self.key = key
        self.fn = fn
        self.fired = False
        self.result: Any = None
        self.error: BaseException | None = None


_PROBES: list[RedisProbe] = []
_process_command = BaseFakeSocket._process_command


def _process_command_with_probes(self, fields: list[bytes]) -> None:
    """The server's dispatch with probes: they fire after a command — or a whole MULTI/EXEC, or a Lua
    script, which run atomically — has executed, before its client reads the reply."""
    if not _PROBES or not fields:
        return _process_command(self, fields)
    if getattr(self, "_queueing", False):
        if bytes(fields[0]).lower() != b"exec":
            return _process_command(self, fields)  # queued: it runs, and is observed, at EXEC
        queued = getattr(self, "_transaction", None) or []
        touched = {bytes(a) for _func, _sig, args in queued for a in args if isinstance(a, (bytes, bytearray, memoryview))}
    else:
        touched = {bytes(a) for a in fields[1:] if isinstance(a, (bytes, bytearray, memoryview))}
    _process_command(self, fields)
    for probe in [p for p in _PROBES if not p.fired and p.key in touched]:
        probe.fired = True
        try:
            probe.result = probe.fn()
        except Exception as exc:  # reported through the probe, not inside the learner's Redis call
            probe.error = exc


BaseFakeSocket._process_command = _process_command_with_probes


class HarnessDb:
    """
    The harness's handle on Postgres: the same database the learner's code uses, but statements run
    through it are the harness's own and stay out of the learner's metrics. The logs (`events`,
    `statements`, `queries`) are the shared ones.
    """

    def __init__(self, db) -> None:
        self._db = db

    async def execute(self, sql: str, params: Sequence[Any] = ()) -> list[dict]:
        rows, _ = await self._db._run(sql, params, counted=False)
        return rows

    def __getattr__(self, name: str) -> Any:
        return getattr(self._db, name)


class Ctx:
    def __init__(self, files: dict[str, str]) -> None:
        self.files = files
        self.redis = fakeredis.FakeRedis(server=SERVER, decode_responses=True)
        self.redis_bytes = fakeredis.FakeRedis(server=SERVER)
        self.kafka = BROKER
        self.grpc = REGISTRY
        self.clock = CLOCK
        self.db = HarnessDb(DB)

    def load(self, stem: str) -> Any:
        """Import a learner (or support) module fresh, by module name (`thumb_cache`, `payments.db`)."""
        _purge_modules()
        return importlib.import_module(stem)

    def reload(self, stem: str) -> Any:
        """A second instance of the learner's module (another replica): the same as `load`, which always imports fresh."""
        return self.load(stem)

    def redis_after(self, key: str, fn: Callable[[], Any]) -> "RedisProbe":
        """
        Run `fn` once, right after the first command that touches `key` has executed on the Redis
        server — from any client, a pipeline's EXEC or a Lua script included — and before that client
        reads its reply: another worker's request landing between two of the learner's commands (a
        race, the way two app servers produce one), or a snapshot of the world at that instant. The
        probe records whether `key` was touched at all (`fired`), and what `fn` returned or raised.
        """
        probe = RedisProbe(key.encode(), fn)
        _PROBES.append(probe)
        return probe

    def db_after(self, pattern: str, fn: Callable[[], Any]):
        """
        Run `fn` once, right after the first SQL statement containing `pattern` has run on Postgres —
        succeeded or failed — before its caller sees the outcome: make a write slow
        (`ctx.clock.advance(6)` while its transaction is open lets Kafka's auto-commit timer fire), or
        snapshot the world mid-transaction. Returns the probe (`fired`, `result`, `error`).
        """
        return DB.after(pattern, fn)

    def client(self, app, base_url: str = "http://service", **kwargs) -> httpx.AsyncClient:
        """An HTTP client that calls the ASGI `app` in-process: `async with ctx.client(m.app) as c:`."""
        return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url=base_url, **kwargs)

    def drain(self, fn: Callable, *args, **kwargs):
        """Run a loop (consumer, sweeper) until the runtime interrupts it; returns what it returned, if anything."""
        try:
            return fn(*args, **kwargs)
        except KeyboardInterrupt:
            return None

    async def drain_async(self, awaitable: Awaitable):
        try:
            return await awaitable
        except KeyboardInterrupt:
            return None


def _purge_modules() -> None:
    for name, module in list(sys.modules.items()):
        file = getattr(module, "__file__", None) or ""
        if file.startswith(WORK) or file.startswith(SUPPORT):
            del sys.modules[name]
    importlib.invalidate_caches()


def reset_world() -> None:
    CLOCK.reset()
    fakeredis.FakeRedis(server=SERVER).flushall()
    BROKER.reset()
    REGISTRY.reset()
    DB.events.clear()
    DB.statements.clear()
    DB.queries.clear()
    DB.probes.clear()
    METRICS.reset()
    _PROBES.clear()
    _purge_modules()


def _explain(exc: BaseException) -> str:
    """`NotImplementedError: … — thumb_cache.py:12 in get_thumb`: the error and where in the learner's code."""
    if isinstance(exc, SyntaxError) and (exc.filename or "").startswith(WORK + "/"):
        # Raised compiling the learner's file: no frame of theirs, the place is on the error itself.
        return f"{type(exc).__name__}: {exc.msg} — {exc.filename[len(WORK) + 1:]}:{exc.lineno}"
    head = f"{type(exc).__name__}: {exc}" if str(exc) else type(exc).__name__
    frames = traceback.extract_tb(exc.__traceback__)
    learner = [f for f in frames if f.filename.startswith(WORK + "/")]
    harness = [f for f in frames if f.filename == "<harness>"]
    if learner:
        f = learner[-1]
        return f"{head} — {f.filename[len(WORK) + 1:]}:{f.lineno} in {f.name}"
    if harness:
        return f"{head} — raised by the check at line {harness[-1].lineno}"
    return head


async def _cancel_stray_tasks() -> None:
    current = asyncio.current_task()
    stray = [t for t in asyncio.all_tasks() if t is not current and not t.done()]
    for task in stray:
        task.cancel()
    for task in stray:
        try:
            await task
        except BaseException:
            pass


def _metrics() -> dict:
    """What the learner's code did in the check so far, read off the resources (they are reset per check)."""
    events = BROKER.events
    return {
        "redisTrips": METRICS.redis_trips,
        "redisCommands": METRICS.redis_commands,
        "kafkaProduced": sum(1 for e in events if e[0] == "produce"),
        "kafkaDelivered": sum(1 for e in events if e[0] == "deliver"),
        "kafkaCommits": sum(1 for e in events if e[0] == "commit"),
        "grpcCalls": sum(1 for c in REGISTRY.calls if not c.from_harness),
        "sqlStatements": METRICS.sql_statements,
        "sleeps": CLOCK.sleeps,
        "sleptMs": round(CLOCK.slept * 1000),
    }


async def run_checks(harness_src: str, check_ids: list[str], files: dict[str, str]) -> list[dict]:
    namespace: dict[str, Any] = {"__name__": "harness"}
    try:
        exec(compile(harness_src, "<harness>", "exec"), namespace)
    except BaseException as exc:
        return [{"id": cid, "passed": False, "message": f"the harness failed to load: {_explain(exc)}"} for cid in check_ids]
    results: list[dict] = []
    for cid in check_ids:
        name = "check_" + cid.replace("-", "_")
        check = namespace.get(name)
        if check is None:
            results.append({"id": cid, "passed": False, "message": f"the harness defines no {name}"})
            continue
        reset_world()
        ctx = Ctx(files)
        try:
            outcome = check(ctx)
            if inspect.isawaitable(outcome):
                await outcome
            results.append({"id": cid, "passed": True, "metrics": _metrics()})
        except AssertionError as exc:
            results.append({"id": cid, "passed": False, "message": str(exc) or "assertion failed", "metrics": _metrics()})
        except KeyboardInterrupt as exc:
            results.append({"id": cid, "passed": False, "message": f"the loop never ended ({exc})", "metrics": _metrics()})
        except BaseException as exc:
            results.append({"id": cid, "passed": False, "message": _explain(exc), "metrics": _metrics()})
        finally:
            await _cancel_stray_tasks()
    return results
