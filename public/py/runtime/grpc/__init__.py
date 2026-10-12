"""`grpc` in the LeetBuild runtime: grpcio's API over the in-process transport in leetbuild.grpcsim."""
from __future__ import annotations

import enum
from typing import Any, Callable

from leetbuild import grpcsim as _sim
from leetbuild.grpcsim import (
    CallError as _CallError,
    GenericRpcHandler,
    HandlerCallDetails,
    RpcError,
    RpcMethodHandler,
    Server as _Server,
    ServicerContext,
    StatusCode,
)

__version__ = "1.84.0"


class ChannelConnectivity(enum.Enum):
    IDLE = (0, "idle")
    CONNECTING = (1, "connecting")
    READY = (2, "ready")
    TRANSIENT_FAILURE = (3, "transient failure")
    SHUTDOWN = (4, "shutdown")


class Compression(enum.IntEnum):
    NoCompression = 0
    Deflate = 1
    Gzip = 2


class Status:
    def __init__(self, code: StatusCode, details: str = "", trailing_metadata=()) -> None:
        self.code = code
        self.details = details
        self.trailing_metadata = trailing_metadata


# ---- credentials (carried, never checked) ---------------------------------------------------------


class ChannelCredentials:
    def __init__(self, kind: str = "ssl", **options) -> None:
        self.kind = kind
        self.options = options


class CallCredentials:
    def __init__(self, kind: str, **options) -> None:
        self.kind = kind
        self.options = options


class ServerCredentials:
    def __init__(self, **options) -> None:
        self.options = options


def ssl_channel_credentials(root_certificates=None, private_key=None, certificate_chain=None) -> ChannelCredentials:
    return ChannelCredentials("ssl", root_certificates=root_certificates, private_key=private_key, certificate_chain=certificate_chain)


def local_channel_credentials(local_connect_type=None) -> ChannelCredentials:
    return ChannelCredentials("local")


def insecure_channel_credentials() -> ChannelCredentials:
    return ChannelCredentials("insecure")


def composite_channel_credentials(channel_credentials, *call_credentials) -> ChannelCredentials:
    return ChannelCredentials("composite", channel=channel_credentials, calls=call_credentials)


def composite_call_credentials(*call_credentials) -> CallCredentials:
    return CallCredentials("composite", calls=call_credentials)


def metadata_call_credentials(metadata_plugin, name=None) -> CallCredentials:
    return CallCredentials("metadata", plugin=metadata_plugin)


def access_token_call_credentials(access_token) -> CallCredentials:
    return CallCredentials("token", token=access_token)


def ssl_server_credentials(private_key_certificate_chain_pairs, root_certificates=None, require_client_auth=False) -> ServerCredentials:
    return ServerCredentials(pairs=private_key_certificate_chain_pairs, root=root_certificates, mtls=require_client_auth)


def local_server_credentials(local_connect_type=None) -> ServerCredentials:
    return ServerCredentials(local=True)


# ---- channels -------------------------------------------------------------------------------------


class _SyncCall:
    """The `call` half of `with_call()` / the iterator of a streaming call."""

    def __init__(self, ctx: ServicerContext | None, code: StatusCode = StatusCode.OK, details: str = "", iterator=None) -> None:
        self._ctx = ctx
        self._code = code
        self._details = details
        self._iterator = iterator

    def code(self) -> StatusCode:
        return self._code

    def details(self) -> str:
        return self._details

    def initial_metadata(self):
        return ()

    def trailing_metadata(self):
        return self._ctx.trailing_metadata() if self._ctx else ()

    def is_active(self) -> bool:
        return False

    def time_remaining(self):
        return self._ctx.time_remaining() if self._ctx else None

    def cancel(self) -> bool:
        if self._ctx is not None:
            self._ctx._cancel()
        return True

    def cancelled(self) -> bool:
        return self._ctx.cancelled() if self._ctx else False

    def done(self) -> bool:
        return True

    def running(self) -> bool:
        return False

    def add_callback(self, callback) -> bool:
        callback()
        return True

    def __iter__(self):
        return self

    def __next__(self):
        if self._iterator is None:
            raise StopIteration
        try:
            return next(self._iterator)
        except _CallError as exc:
            self._code, self._details = exc.code(), exc.details()
            raise


class _CompletedFuture(_SyncCall):
    def __init__(self, result=None, exception: _CallError | None = None, ctx=None) -> None:
        super().__init__(ctx, exception.code() if exception else StatusCode.OK, exception.details() if exception else "")
        self._result = result
        self._exception = exception

    def result(self, timeout=None):
        if self._exception is not None:
            raise self._exception
        return self._result

    def exception(self, timeout=None):
        return self._exception

    def traceback(self, timeout=None):
        return None

    def add_done_callback(self, fn) -> None:
        fn(self)


class UnaryUnaryMultiCallable:
    def __init__(self, path: str, request_serializer, response_deserializer) -> None:
        self._path = path
        self._serializer = request_serializer
        self._deserializer = response_deserializer

    def __call__(self, request, timeout=None, metadata=None, credentials=None, wait_for_ready=None, compression=None):
        result, _ = _sim.invoke_sync(self._path, request, timeout, metadata, self._serializer, self._deserializer)
        return result

    def with_call(self, request, timeout=None, metadata=None, credentials=None, wait_for_ready=None, compression=None):
        result, ctx = _sim.invoke_sync(self._path, request, timeout, metadata, self._serializer, self._deserializer)
        return result, _SyncCall(ctx)

    def future(self, request, timeout=None, metadata=None, credentials=None, wait_for_ready=None, compression=None):
        try:
            result, ctx = _sim.invoke_sync(self._path, request, timeout, metadata, self._serializer, self._deserializer)
        except _CallError as exc:
            return _CompletedFuture(exception=exc)
        return _CompletedFuture(result, ctx=ctx)


class UnaryStreamMultiCallable(UnaryUnaryMultiCallable):
    def __call__(self, request, timeout=None, metadata=None, credentials=None, wait_for_ready=None, compression=None):
        iterator, ctx = _sim.invoke_sync_stream(self._path, request, timeout, metadata, self._serializer, self._deserializer)
        return _SyncCall(ctx, iterator=iterator)


class StreamUnaryMultiCallable(UnaryUnaryMultiCallable):
    # Request iterators reach the handler as-is (serialization is per message, which a stream defers).
    def __call__(self, request_iterator, timeout=None, metadata=None, credentials=None, wait_for_ready=None, compression=None):
        result, _ = _sim.invoke_sync(self._path, request_iterator, timeout, metadata, None, self._deserializer)
        return result

    def with_call(self, request_iterator, timeout=None, metadata=None, credentials=None, wait_for_ready=None, compression=None):
        result, ctx = _sim.invoke_sync(self._path, request_iterator, timeout, metadata, None, self._deserializer)
        return result, _SyncCall(ctx)


class StreamStreamMultiCallable(UnaryUnaryMultiCallable):
    def __call__(self, request_iterator, timeout=None, metadata=None, credentials=None, wait_for_ready=None, compression=None):
        iterator, ctx = _sim.invoke_sync_stream(self._path, request_iterator, timeout, metadata, None, self._deserializer)
        return _SyncCall(ctx, iterator=iterator)


class Channel:
    def __init__(self, target: str, options=None, credentials: ChannelCredentials | None = None, compression=None) -> None:
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

    def subscribe(self, callback, try_to_connect=False) -> None:
        callback(ChannelConnectivity.READY)

    def unsubscribe(self, callback) -> None:
        pass

    def close(self) -> None:
        pass

    def __enter__(self):
        return self

    def __exit__(self, *exc) -> bool:
        return False


def insecure_channel(target: str, options=None, compression=None) -> Channel:
    return Channel(target, options)


def secure_channel(target: str, credentials: ChannelCredentials, options=None, compression=None) -> Channel:
    return Channel(target, options, credentials)


def intercept_channel(channel: Channel, *interceptors) -> Channel:
    return channel


def channel_ready_future(channel: Channel):
    return _CompletedFuture(None)


# ---- servers --------------------------------------------------------------------------------------


def unary_unary_rpc_method_handler(behavior, request_deserializer=None, response_serializer=None) -> RpcMethodHandler:
    return RpcMethodHandler(False, False, request_deserializer, response_serializer, unary_unary=behavior)


def unary_stream_rpc_method_handler(behavior, request_deserializer=None, response_serializer=None) -> RpcMethodHandler:
    return RpcMethodHandler(False, True, request_deserializer, response_serializer, unary_stream=behavior)


def stream_unary_rpc_method_handler(behavior, request_deserializer=None, response_serializer=None) -> RpcMethodHandler:
    return RpcMethodHandler(True, False, request_deserializer, response_serializer, stream_unary=behavior)


def stream_stream_rpc_method_handler(behavior, request_deserializer=None, response_serializer=None) -> RpcMethodHandler:
    return RpcMethodHandler(True, True, request_deserializer, response_serializer, stream_stream=behavior)


def method_handlers_generic_handler(service: str, method_handlers: dict) -> GenericRpcHandler:
    return GenericRpcHandler(service, method_handlers)


def server(thread_pool=None, handlers=None, interceptors=None, options=None, maximum_concurrent_rpcs=None, compression=None, xds=False) -> _Server:
    s = _Server()
    if handlers:
        s.add_generic_rpc_handlers(handlers)
    return s


Server = _Server


class ServerInterceptor:
    def intercept_service(self, continuation, handler_call_details):
        return continuation(handler_call_details)


class ClientCallDetails:
    def __init__(self, method, timeout=None, metadata=None, credentials=None, wait_for_ready=None, compression=None) -> None:
        self.method = method
        self.timeout = timeout
        self.metadata = metadata
        self.credentials = credentials
        self.wait_for_ready = wait_for_ready
        self.compression = compression


from . import aio  # noqa: E402  (grpc.aio is reachable as an attribute, like grpcio)

__all__ = [
    "aio",
    "RpcError",
    "StatusCode",
    "Status",
    "ChannelConnectivity",
    "Compression",
    "Channel",
    "ChannelCredentials",
    "CallCredentials",
    "ServerCredentials",
    "ServicerContext",
    "RpcMethodHandler",
    "GenericRpcHandler",
    "HandlerCallDetails",
    "insecure_channel",
    "secure_channel",
    "intercept_channel",
    "channel_ready_future",
    "ssl_channel_credentials",
    "local_channel_credentials",
    "insecure_channel_credentials",
    "composite_channel_credentials",
    "composite_call_credentials",
    "metadata_call_credentials",
    "access_token_call_credentials",
    "ssl_server_credentials",
    "local_server_credentials",
    "unary_unary_rpc_method_handler",
    "unary_stream_rpc_method_handler",
    "stream_unary_rpc_method_handler",
    "stream_stream_rpc_method_handler",
    "method_handlers_generic_handler",
    "server",
    "Server",
]
