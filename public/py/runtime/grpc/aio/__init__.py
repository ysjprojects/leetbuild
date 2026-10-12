"""`grpc.aio` in the LeetBuild runtime: asyncio channels, calls and servers over leetbuild.grpcsim."""
from __future__ import annotations

import asyncio

from leetbuild import grpcsim as _sim
from leetbuild.grpcsim import EOF, AioServer as _AioServer, AioServicerContext as ServicerContext, AioStream, CallError as AioRpcError, RpcError, StatusCode

__all__ = [
    "AioRpcError",
    "Channel",
    "EOF",
    "Metadata",
    "RpcError",
    "Server",
    "ServicerContext",
    "StatusCode",
    "insecure_channel",
    "secure_channel",
    "server",
    "init_grpc_aio",
    "shutdown_grpc_aio",
]


class Metadata(list):
    """grpc.aio.Metadata: a list of (key, value) pairs that also answers to `metadata['key']`."""

    def __init__(self, *pairs) -> None:
        super().__init__(pairs)

    def __getitem__(self, key):
        if isinstance(key, str):
            for k, v in self:
                if k == key:
                    return v
            raise KeyError(key)
        return super().__getitem__(key)

    def get(self, key, default=None):
        for k, v in self:
            if k == key:
                return v
        return default

    def add(self, key, value) -> None:
        self.append((key, value))


class UnaryUnaryCall:
    """Awaitable: `reply = await stub.Method(request, timeout=…)`; also `.code()`/`.details()` after."""

    def __init__(self, path, request, timeout, metadata, serializer, deserializer) -> None:
        self._coro = _sim.invoke_aio(path, request, timeout, metadata, serializer, deserializer)
        self._code = None
        self._details = ""
        self._ctx = None
        self._done = False
        self._cancelled = False

    def __await__(self):
        return self._run().__await__()

    async def _run(self):
        try:
            result, self._ctx = await self._coro
        except AioRpcError as exc:
            self._code, self._details, self._done = exc.code(), exc.details(), True
            raise
        self._code, self._done = StatusCode.OK, True
        return result

    async def code(self):
        return self._code

    async def details(self):
        return self._details

    async def initial_metadata(self):
        return ()

    async def trailing_metadata(self):
        return self._ctx.trailing_metadata() if self._ctx else ()

    def cancel(self) -> bool:
        self._cancelled = True
        return not self._done

    def cancelled(self) -> bool:
        return self._cancelled

    def done(self) -> bool:
        return self._done

    def time_remaining(self):
        return self._ctx.time_remaining() if self._ctx else None

    def add_done_callback(self, callback) -> None:
        callback(self)

    async def wait_for_connection(self) -> None:
        pass


class _MultiCallable:
    def __init__(self, path: str, request_serializer, response_deserializer) -> None:
        self._path = path
        self._serializer = request_serializer
        self._deserializer = response_deserializer


class UnaryUnaryMultiCallable(_MultiCallable):
    def __call__(self, request, *, timeout=None, metadata=None, credentials=None, wait_for_ready=None, compression=None):
        return UnaryUnaryCall(self._path, request, timeout, metadata, self._serializer, self._deserializer)


class UnaryStreamMultiCallable(_MultiCallable):
    def __call__(self, request, *, timeout=None, metadata=None, credentials=None, wait_for_ready=None, compression=None):
        call = AioStream(self._path, request, timeout, metadata, self._serializer, self._deserializer, request_streaming=False)
        call._ensure_started()
        return call


class StreamUnaryMultiCallable(_MultiCallable):
    def __call__(self, request_iterator=None, timeout=None, metadata=None, credentials=None, wait_for_ready=None, compression=None):
        call = AioStream(self._path, None, timeout, metadata, self._serializer, self._deserializer, request_streaming=True, request_iterator=request_iterator)
        call._ensure_started()
        return call


class StreamStreamMultiCallable(_MultiCallable):
    def __call__(self, request_iterator=None, timeout=None, metadata=None, credentials=None, wait_for_ready=None, compression=None):
        call = AioStream(self._path, None, timeout, metadata, self._serializer, self._deserializer, request_streaming=True, request_iterator=request_iterator)
        call._ensure_started()
        return call


class Channel:
    def __init__(self, target: str, options=None, credentials=None, compression=None, interceptors=None) -> None:
        self.target = target
        self.options = tuple(options or ())
        self.credentials = credentials

    def unary_unary(self, method, request_serializer=None, response_deserializer=None, _registered_method=False):
        return UnaryUnaryMultiCallable(method, request_serializer, response_deserializer)

    def unary_stream(self, method, request_serializer=None, response_deserializer=None, _registered_method=False):
        return UnaryStreamMultiCallable(method, request_serializer, response_deserializer)

    def stream_unary(self, method, request_serializer=None, response_deserializer=None, _registered_method=False):
        return StreamUnaryMultiCallable(method, request_serializer, response_deserializer)

    def stream_stream(self, method, request_serializer=None, response_deserializer=None, _registered_method=False):
        return StreamStreamMultiCallable(method, request_serializer, response_deserializer)

    async def channel_ready(self) -> None:
        pass

    def get_state(self, try_to_connect=False):
        from grpc import ChannelConnectivity

        return ChannelConnectivity.READY

    async def wait_for_state_change(self, last_observed_state) -> None:
        await asyncio.sleep(0)

    async def close(self, grace=None) -> None:
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc) -> bool:
        return False


def insecure_channel(target: str, options=None, compression=None, interceptors=None) -> Channel:
    return Channel(target, options)


def secure_channel(target: str, credentials, options=None, compression=None, interceptors=None) -> Channel:
    return Channel(target, options, credentials)


Server = _AioServer


def server(migration_thread_pool=None, handlers=None, interceptors=None, options=None, maximum_concurrent_rpcs=None, compression=None) -> _AioServer:
    s = _AioServer()
    if handlers:
        s.add_generic_rpc_handlers(handlers)
    return s


def init_grpc_aio() -> None:
    pass


def shutdown_grpc_aio() -> None:
    pass
