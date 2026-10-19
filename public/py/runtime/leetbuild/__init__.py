"""
The LeetBuild Python runtime: boots once per Pyodide instance and turns the learner's code into
something that runs without a network. `boot()` installs the virtual clock, makes FastAPI run its
sync endpoints inline (Pyodide has no threads), points `redis` at a shared fakeredis server with
Lua scripting restored, and puts the learner's files (/work) and the course's support modules
(/support) on the import path. `confluent_kafka`, `grpc` and `uvicorn` are packages of this
runtime; they need no patching.
"""
from __future__ import annotations

import importlib
import os
import sys

WORK = "/work"
SUPPORT = "/support"


def _inline_threadpools() -> None:
    import anyio.to_thread
    import starlette.concurrency

    async def run_inline(func, *args, **kwargs):
        if "limiter" in kwargs:
            kwargs.pop("limiter")
        if "abandon_on_cancel" in kwargs:
            kwargs.pop("abandon_on_cancel")
        if "cancellable" in kwargs:
            kwargs.pop("cancellable")
        return func(*args, **kwargs)

    async def iterate_inline(iterator):
        for item in iterator:
            yield item

    anyio.to_thread.run_sync = run_inline
    starlette.concurrency.run_in_threadpool = run_inline
    starlette.concurrency.iterate_in_threadpool = iterate_inline
    # Modules that bound the name at import time.
    for name in ("starlette.routing", "starlette.background", "starlette.requests", "fastapi.routing", "fastapi.dependencies.utils", "fastapi.concurrency"):
        try:
            module = importlib.import_module(name)
        except ImportError:
            continue
        if hasattr(module, "run_in_threadpool"):
            module.run_in_threadpool = run_inline
        if hasattr(module, "iterate_in_threadpool"):
            module.iterate_in_threadpool = iterate_inline


def _patch_redis() -> None:
    import fakeredis
    import redis
    import redis.asyncio
    from redis.asyncio.client import Pipeline as _AsyncPipeline
    from redis.client import Pipeline as _SyncPipeline

    from .harness import SERVER
    from .metrics import METRICS

    # The learner's clients count what they send (one trip per command, one per pipeline or
    # transaction); the harness uses fakeredis's own classes, so its reads stay out of the count.
    class Pipeline(_SyncPipeline):
        def execute(self, raise_on_error=True):
            METRICS.redis_trip(len(self.command_stack))
            return super().execute(raise_on_error)

        def immediate_execute_command(self, *args, **options):
            METRICS.redis_trip(1)
            return super().immediate_execute_command(*args, **options)

    class Redis(fakeredis.FakeRedis):
        def __init__(self, *args, **kwargs) -> None:
            kwargs.setdefault("server", SERVER)
            super().__init__(*args, **kwargs)

        def execute_command(self, *args, **options):
            METRICS.redis_trip(1)
            return super().execute_command(*args, **options)

        def pipeline(self, transaction=True, shard_hint=None):
            return Pipeline(self.connection_pool, self.response_callbacks, transaction, shard_hint)

    class AsyncPipeline(_AsyncPipeline):
        async def execute(self, raise_on_error=True):
            METRICS.redis_trip(len(self.command_stack))
            return await super().execute(raise_on_error)

        async def immediate_execute_command(self, *args, **options):
            METRICS.redis_trip(1)
            return await super().immediate_execute_command(*args, **options)

    class AsyncRedis(fakeredis.FakeAsyncRedis):
        def __init__(self, *args, **kwargs) -> None:
            kwargs.setdefault("server", SERVER)
            super().__init__(*args, **kwargs)

        async def execute_command(self, *args, **options):
            METRICS.redis_trip(1)
            return await super().execute_command(*args, **options)

        def pipeline(self, transaction=True, shard_hint=None):
            return AsyncPipeline(self.connection_pool, self.response_callbacks, transaction, shard_hint)

    redis.Redis = Redis
    redis.StrictRedis = Redis
    redis.from_url = Redis.from_url
    redis.asyncio.Redis = AsyncRedis
    redis.asyncio.StrictRedis = AsyncRedis
    redis.asyncio.from_url = AsyncRedis.from_url


def boot() -> None:
    from .clock import CLOCK

    CLOCK.install()
    _inline_threadpools()
    _patch_redis()
    from . import lua

    lua.install()
    for path in (WORK, SUPPORT):
        os.makedirs(path, exist_ok=True)
        if path not in sys.path:
            sys.path.insert(0, path)
