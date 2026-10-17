"""
Postgres for the runtime: a real PGlite instance on the host, reached through
`leetbuild_host.db_query`. The API is async (the host call is a promise) and psycopg-flavoured:

    async with db.transaction() as cur:
        await cur.execute("INSERT INTO outbox (id, topic) VALUES (%s, %s)", (event_id, topic))
        rows = await cur.fetchall()

`%s` placeholders become `$1…$n`; rows are dicts keyed by column name.
"""
from __future__ import annotations

import json
import re
from typing import Any, Callable, Sequence

_PLACEHOLDER = re.compile(r"%(%|s)")


class DbError(Exception):
    pass


def dollarize(sql: str) -> str:
    """psycopg-style `%s` → PGlite's `$n`; `%%` → `%`."""
    n = 0

    def sub(m: re.Match) -> str:
        nonlocal n
        if m.group(1) == "%":
            return "%"
        n += 1
        return f"${n}"

    return _PLACEHOLDER.sub(sub, sql)


def _plain(value: Any) -> Any:
    """Parameters as PGlite takes them: lists/tuples stay arrays (`= ANY(%s)`), dicts become JSON text."""
    if isinstance(value, (bytes, bytearray)):
        return bytes(value).decode("utf-8", "replace")
    if isinstance(value, dict):
        return json.dumps(value)
    if isinstance(value, (list, tuple)):
        return [_plain(v) for v in value]
    return value


class Cursor:
    def __init__(self, db: "Db") -> None:
        self._db = db
        self._rows: list[dict] = []
        self.rowcount = -1

    async def execute(self, sql: str, params: Sequence[Any] = ()) -> "Cursor":
        self._rows, self.rowcount = await self._db._run(sql, params)
        return self

    async def executemany(self, sql: str, seq_of_params) -> None:
        for params in seq_of_params:
            await self.execute(sql, params)

    async def fetchall(self) -> list[dict]:
        rows, self._rows = self._rows, []
        return rows

    async def fetchone(self) -> dict | None:
        if not self._rows:
            return None
        return self._rows.pop(0)

    async def fetchmany(self, size: int = 1) -> list[dict]:
        out, self._rows = self._rows[:size], self._rows[size:]
        return out

    def __aiter__(self):
        return self

    async def __anext__(self) -> dict:
        row = await self.fetchone()
        if row is None:
            raise StopAsyncIteration
        return row


class _Transaction:
    def __init__(self, db: "Db") -> None:
        self._db = db

    async def __aenter__(self) -> Cursor:
        await self._db._run("BEGIN", ())
        self._db.events.append("BEGIN")
        return Cursor(self._db)

    async def __aexit__(self, exc_type, exc, tb) -> bool:
        if exc_type is None:
            await self._db._run("COMMIT", ())
            self._db.events.append("COMMIT")
        else:
            await self._db._run("ROLLBACK", ())
            self._db.events.append("ROLLBACK")
        return False


class DbProbe:
    def __init__(self, pattern: str, fn: Callable[[], Any]) -> None:
        self.pattern = pattern
        self.fn = fn
        self.fired = False
        self.result: Any = None
        self.error: BaseException | None = None


class Db:
    def __init__(self) -> None:
        self.events: list[str] = []
        self.statements: list[str] = []
        # What the server was asked, in order: (sql, params) — the query log a DBA would read.
        self.queries: list[tuple[str, list]] = []
        self.probes: list[DbProbe] = []

    def transaction(self) -> _Transaction:
        return _Transaction(self)

    async def execute(self, sql: str, params: Sequence[Any] = ()) -> list[dict]:
        """One statement outside a transaction (autocommit); returns the rows."""
        rows, _ = await self._run(sql, params)
        return rows

    async def reset(self, schema: str = "") -> None:
        """Drop everything and apply `schema` (DDL); the harness calls this before a check that needs tables."""
        import leetbuild_host

        self.events = []
        self.statements = []
        self.queries = []
        try:
            await leetbuild_host.db_exec("DROP SCHEMA public CASCADE; CREATE SCHEMA public;" + schema)
        except Exception as exc:
            raise DbError(_message(exc)) from None

    async def _run(self, sql: str, params: Sequence[Any]) -> tuple[list[dict], int]:
        import leetbuild_host

        self.statements.append(sql)
        self.queries.append((sql, list(params)))
        try:
            out = await leetbuild_host.db_query(dollarize(sql), json.dumps([_plain(p) for p in params]))
        except Exception as exc:
            self._fire(sql)
            raise DbError(_message(exc)) from None
        self._fire(sql)
        data = json.loads(out)
        return data["rows"], data.get("affected", -1)

    def after(self, pattern: str, fn: Callable[[], Any]) -> "DbProbe":
        """
        Run `fn` once, right after the first statement containing `pattern` (case-insensitive) has run
        on the server — succeeded or failed — before its caller sees the outcome: a slow write (advance
        the clock while the transaction is open), a snapshot of the world mid-transaction, or another
        client acting at that instant.
        """
        probe = DbProbe(pattern.lower(), fn)
        self.probes.append(probe)
        return probe

    def _fire(self, sql: str) -> None:
        for probe in [p for p in self.probes if not p.fired and p.pattern in sql.lower()]:
            probe.fired = True
            try:
                probe.result = probe.fn()
            except Exception as exc:  # reported through the probe, not inside the learner's query
                probe.error = exc


def _message(exc: BaseException) -> str:
    text = str(exc)
    return text[7:] if text.startswith("Error: ") else text


DB = Db()
