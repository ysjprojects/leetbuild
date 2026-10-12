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

    from .harness import SERVER

    class Redis(fakeredis.FakeRedis):
        def __init__(self, *args, **kwargs) -> None:
            kwargs.setdefault("server", SERVER)
            super().__init__(*args, **kwargs)

    class AsyncRedis(fakeredis.FakeAsyncRedis):
        def __init__(self, *args, **kwargs) -> None:
            kwargs.setdefault("server", SERVER)
            super().__init__(*args, **kwargs)

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
