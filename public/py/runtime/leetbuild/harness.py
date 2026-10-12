"""
Runs a step's harness against the learner's files. A harness is a Python module with one
`check_<id>(ctx)` per check (sync or async); each check starts from a clean world — empty Redis,
empty broker, no gRPC peers, the clock at zero, every learner/support module unloaded — and
passes unless it raises. `AssertionError` messages become the verdict's explanation.

`ctx` is the harness's handle on that world: the learner's modules (`ctx.load`), Redis probes
(`ctx.redis`, `ctx.redis_bytes`), the broker (`ctx.kafka`), the gRPC registry (`ctx.grpc`), the
clock (`ctx.clock`), Postgres (`ctx.db`), an in-memory HTTP client for ASGI apps (`ctx.client`)
and `ctx.drain`, which runs a consumer/sweeper loop until the runtime stops it.
"""
from __future__ import annotations

import asyncio
import importlib
import inspect
import sys
import traceback
from typing import Any, Awaitable, Callable

import fakeredis
import httpx

from .clock import CLOCK
from .db import DB
from .grpcsim import REGISTRY
from .kafka import BROKER

WORK = "/work"
SUPPORT = "/support"
SERVER = fakeredis.FakeServer()


class Ctx:
    def __init__(self, files: dict[str, str]) -> None:
        self.files = files
        self.redis = fakeredis.FakeRedis(server=SERVER, decode_responses=True)
        self.redis_bytes = fakeredis.FakeRedis(server=SERVER)
        self.kafka = BROKER
        self.grpc = REGISTRY
        self.clock = CLOCK
        self.db = DB

    def load(self, stem: str) -> Any:
        """Import a learner (or support) module fresh, by module name (`thumb_cache`, `payments.db`)."""
        _purge_modules()
        return importlib.import_module(stem)

    def source(self, stem: str) -> str:
        """The learner's source for a file stem, for the rare property only the text shows."""
        for name, text in self.files.items():
            if name == stem or name.rsplit(".", 1)[0] == stem:
                return text
        raise KeyError(stem)

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
    _purge_modules()


def _explain(exc: BaseException) -> str:
    """`NotImplementedError: … — thumb_cache.py:12 in get_thumb`: the error and where in the learner's code."""
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
            results.append({"id": cid, "passed": True})
        except AssertionError as exc:
            results.append({"id": cid, "passed": False, "message": str(exc) or "assertion failed"})
        except KeyboardInterrupt as exc:
            results.append({"id": cid, "passed": False, "message": f"the loop never ended ({exc})"})
        except BaseException as exc:
            results.append({"id": cid, "passed": False, "message": _explain(exc)})
        finally:
            await _cancel_stray_tasks()
    return results
