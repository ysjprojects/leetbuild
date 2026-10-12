"""
gRPC without a network: channels route calls through a REGISTRY of method handlers that fake
peers (registered by the harness) or the learner's own servicers (started through grpc.aio.server)
install. Deadlines, latency and injected failures run on the virtual clock, so "sets a deadline"
and "retries UNAVAILABLE once" are observable outcomes.

The `grpc` and `grpc.aio` packages of this runtime are thin re-exports of what is defined here,
shaped exactly like what grpcio's generated `*_pb2_grpc.py` modules expect.
"""
from __future__ import annotations

import asyncio
import enum
import inspect
from typing import Any, Callable

from .clock import CLOCK


class StatusCode(enum.Enum):
    OK = (0, "ok")
    CANCELLED = (1, "cancelled")
    UNKNOWN = (2, "unknown")
    INVALID_ARGUMENT = (3, "invalid argument")
    DEADLINE_EXCEEDED = (4, "deadline exceeded")
    NOT_FOUND = (5, "not found")
    ALREADY_EXISTS = (6, "already exists")
    PERMISSION_DENIED = (7, "permission denied")
    RESOURCE_EXHAUSTED = (8, "resource exhausted")
    FAILED_PRECONDITION = (9, "failed precondition")
    ABORTED = (10, "aborted")
    OUT_OF_RANGE = (11, "out of range")
    UNIMPLEMENTED = (12, "unimplemented")
    INTERNAL = (13, "internal")
    UNAVAILABLE = (14, "unavailable")
    DATA_LOSS = (15, "data loss")
    UNAUTHENTICATED = (16, "unauthenticated")


class RpcError(Exception):
    """Base class, as in grpcio; the raised errors carry `code()` and `details()`."""


class CallError(RpcError):
    def __init__(self, code: StatusCode, details: str = "", trailing=()) -> None:
        super().__init__(f"<RpcError status = {code}, details = {details!r}>")
        self._code = code
        self._details = details
        self._trailing = tuple(trailing)

    def code(self) -> StatusCode:
        return self._code

    def details(self) -> str:
        return self._details

    def initial_metadata(self):
        return ()

    def trailing_metadata(self):
        return self._trailing

    def debug_error_string(self) -> str:
        return f'{{"created":"@leetbuild","description":"{self._details}","grpc_status":{self._code.value[0]}}}'

    def __str__(self) -> str:
        return f"<RpcError of RPC that terminated with:\n\tstatus = {self._code}\n\tdetails = \"{self._details}\"\n>"


class AbortError(Exception):
    def __init__(self, code: StatusCode, details: str) -> None:
        super().__init__(details)
        self.code = code
        self.details = details


class RpcMethodHandler:
    def __init__(self, request_streaming, response_streaming, request_deserializer, response_serializer, unary_unary=None, unary_stream=None, stream_unary=None, stream_stream=None):
        self.request_streaming = request_streaming
        self.response_streaming = response_streaming
        self.request_deserializer = request_deserializer
        self.response_serializer = response_serializer
        self.unary_unary = unary_unary
        self.unary_stream = unary_stream
        self.stream_unary = stream_unary
        self.stream_stream = stream_stream

    @property
    def behavior(self):
        return self.unary_unary or self.unary_stream or self.stream_unary or self.stream_stream


class Call:
    """One invocation as the registry saw it."""

    def __init__(self, path: str, request, metadata, timeout) -> None:
        self.path = path
        self.request = request
        self.metadata = tuple(metadata or ())
        self.timeout = timeout
        self.started = CLOCK.time()
        self.code: StatusCode | None = None

    @property
    def method(self) -> str:
        return self.path.rsplit("/", 1)[-1]

    def __repr__(self) -> str:
        return f"Call({self.path}, timeout={self.timeout}, code={self.code})"


class Registry:
    def __init__(self) -> None:
        self.reset()

    def reset(self) -> None:
        self.handlers: dict[str, RpcMethodHandler] = {}
        self.latency: dict[str, float] = {}
        self.failures: dict[str, list[tuple[StatusCode, str]]] = {}
        self.calls: list[Call] = []
        self.contexts: list[ServicerContext] = []

    # ---- peers ----------------------------------------------------------------------------------
    def register(self, service: str, method: str, handler: RpcMethodHandler) -> None:
        self.handlers[f"/{service}/{method}"] = handler

    def serve(self, add_servicer_to_server: Callable, servicer) -> None:
        """Install a fake peer: `registry.serve(x_pb2_grpc.add_XServicer_to_server, XServicer())`."""
        add_servicer_to_server(servicer, Server())

    def find(self, path: str) -> RpcMethodHandler | None:
        return self.handlers.get(path)

    # ---- faults -----------------------------------------------------------------------------------
    def set_latency(self, method: str, seconds: float) -> None:
        """Every call to `method` ('/pkg.Svc/M' or just 'M') takes `seconds` of virtual time."""
        self.latency[self._path(method)] = seconds

    def fail(self, method: str, code: StatusCode, details: str = "", times: int = 1) -> None:
        """The next `times` calls to `method` fail with `code` before reaching any handler."""
        self.failures.setdefault(self._path(method), []).extend([(code, details)] * times)

    def pop_failure(self, path: str) -> tuple[StatusCode, str] | None:
        queue = self.failures.get(path)
        if queue:
            return queue.pop(0)
        return None

    def calls_to(self, method: str) -> list[Call]:
        """Calls whose path ends with `method` ('/pkg.Svc/M' or 'M'), oldest first."""
        suffix = method if method.startswith("/") else "/" + method
        return [c for c in self.calls if c.path.endswith(suffix)]

    def _path(self, method: str) -> str:
        if method.startswith("/"):
            return method
        for path in list(self.handlers) + list(self.latency) + list(self.failures):
            if path.endswith("/" + method):
                return path
        return "/" + method

    def _lookup(self, path: str) -> float:
        if path in self.latency:
            return self.latency[path]
        return self.latency.get("/" + path.rsplit("/", 1)[-1], 0.0)

    def _pop(self, path: str) -> tuple[StatusCode, str] | None:
        return self.pop_failure(path) or self.pop_failure("/" + path.rsplit("/", 1)[-1])


REGISTRY = Registry()


# ---- servicer contexts ---------------------------------------------------------------------------


class ServicerContext:
    def __init__(self, metadata, timeout) -> None:
        self._metadata = tuple(metadata or ())
        self._deadline = None if timeout is None else CLOCK.time() + timeout
        self._code: StatusCode | None = None
        self._details: str | None = None
        self._cancelled = False
        self._done = False
        self._callbacks: list[Callable] = []
        self._trailing = ()
        self._initial = ()
        REGISTRY.contexts.append(self)

    def invocation_metadata(self):
        return self._metadata

    def time_remaining(self):
        if self._deadline is None:
            return None
        return max(0.0, self._deadline - CLOCK.time())

    def is_active(self) -> bool:
        return not (self._cancelled or self._done)

    def cancelled(self) -> bool:
        return self._cancelled

    def done(self) -> bool:
        return self._done or self._cancelled

    def add_callback(self, callback: Callable) -> bool:
        self._callbacks.append(callback)
        return True

    def add_done_callback(self, callback: Callable) -> None:
        self._callbacks.append(callback)

    def set_code(self, code: StatusCode) -> None:
        self._code = code

    def set_details(self, details: str) -> None:
        self._details = details

    def code(self):
        return self._code

    def details(self):
        return self._details

    def set_trailing_metadata(self, metadata) -> None:
        self._trailing = tuple(metadata)

    def trailing_metadata(self):
        return self._trailing

    def send_initial_metadata(self, metadata) -> None:
        self._initial = tuple(metadata)

    def set_compression(self, compression) -> None:
        pass

    def disable_next_message_compression(self) -> None:
        pass

    def peer(self) -> str:
        return "ipv4:127.0.0.1:54321"

    def peer_identities(self):
        return None

    def peer_identity_key(self):
        return None

    def auth_context(self):
        return {}

    def abort(self, code: StatusCode, details: str = "") -> None:
        raise AbortError(code, details)

    def abort_with_status(self, status) -> None:
        raise AbortError(status.code, status.details)

    def _cancel(self) -> None:
        if not self._cancelled:
            self._cancelled = True
            self._finish()

    def _finish(self) -> None:
        if self._done:
            return
        self._done = True
        for cb in self._callbacks:
            try:
                arity = len(inspect.signature(cb).parameters)
            except (TypeError, ValueError):
                arity = 1
            cb(self) if arity else cb()


class AioServicerContext(ServicerContext):
    """grpc.aio's servicer context; on streaming calls it also offers the explicit `read()`/`write()` API."""

    def __init__(self, metadata, timeout) -> None:
        super().__init__(metadata, timeout)
        self._stream: "AioStream | None" = None
        self._handler: RpcMethodHandler | None = None
        self._requests = None

    async def abort(self, code: StatusCode, details: str = "", trailing_metadata=()) -> None:  # type: ignore[override]
        raise AbortError(code, details)

    async def abort_with_status(self, status) -> None:  # type: ignore[override]
        raise AbortError(status.code, status.details)

    async def send_initial_metadata(self, metadata) -> None:  # type: ignore[override]
        self._initial = tuple(metadata)

    async def read(self):
        """The next request of a streaming call (the same iterator the handler was given), or `grpc.aio.EOF`."""
        if self._requests is None:
            raise RuntimeError("context.read() is only available on calls that stream requests")
        try:
            return await self._requests.__anext__()
        except StopAsyncIteration:
            return EOF

    async def write(self, message) -> None:
        """Send a response on a streaming call without yielding it (e.g. from a forwarding task)."""
        if self._stream is None or self._handler is None:
            raise RuntimeError("context.write() is only available on calls that stream responses")
        self._stream._responses.put_nowait(_roundtrip(message, self._handler.response_serializer, self._stream._deserializer))
        await asyncio.sleep(0)


# ---- the transport ------------------------------------------------------------------------------


def _roundtrip(message, serializer, deserializer):
    """Serialize with the caller's serializer and parse with the callee's: a wrong message type fails here."""
    if serializer is None or deserializer is None:
        return message
    return deserializer(serializer(message))


def _begin(path: str, request, timeout, metadata) -> tuple[Call, RpcMethodHandler]:
    call = Call(path, request, metadata, timeout)
    REGISTRY.calls.append(call)
    failure = REGISTRY._pop(path)
    if failure is not None:
        call.code = failure[0]
        raise CallError(failure[0], failure[1] or failure[0].value[1])
    latency = REGISTRY._lookup(path)
    if timeout is not None and latency > timeout:
        CLOCK.advance(timeout)
        call.code = StatusCode.DEADLINE_EXCEEDED
        raise CallError(StatusCode.DEADLINE_EXCEEDED, "Deadline Exceeded")
    CLOCK.advance(latency)
    handler = REGISTRY.find(path)
    if handler is None:
        call.code = StatusCode.UNAVAILABLE
        raise CallError(StatusCode.UNAVAILABLE, f"failed to connect to all addresses; nothing serves {path}")
    return call, handler


def _translate(exc: BaseException, ctx: ServicerContext, call: Call) -> CallError:
    if isinstance(exc, AbortError):
        error = CallError(exc.code, exc.details, ctx.trailing_metadata())
    elif isinstance(exc, CallError):
        error = exc
    elif ctx._code is not None and ctx._code is not StatusCode.OK:
        error = CallError(ctx._code, ctx._details or "", ctx.trailing_metadata())
    else:
        error = CallError(StatusCode.UNKNOWN, f"Exception calling application: {exc!r}", ctx.trailing_metadata())
    call.code = error.code()
    return error


def _settle(ctx: ServicerContext, call: Call) -> None:
    ctx._finish()
    if ctx._code is not None and ctx._code is not StatusCode.OK:
        call.code = ctx._code
        raise CallError(ctx._code, ctx._details or "", ctx.trailing_metadata())
    call.code = StatusCode.OK


def invoke_sync(path, request, timeout, metadata, serializer, deserializer):
    call, handler = _begin(path, request, timeout, metadata)
    ctx = ServicerContext(metadata, timeout)
    try:
        req = _roundtrip(request, serializer, handler.request_deserializer)
        response = handler.behavior(req, ctx)
        if inspect.isawaitable(response) or inspect.isasyncgen(response):
            raise CallError(StatusCode.INTERNAL, "an async servicer needs a grpc.aio channel")
        result = _roundtrip(response, handler.response_serializer, deserializer)
    except BaseException as exc:
        ctx._finish()
        raise _translate(exc, ctx, call) from None
    _settle(ctx, call)
    return result, ctx


def invoke_sync_stream(path, request, timeout, metadata, serializer, deserializer):
    """Server-streaming over a sync channel: a generator that translates aborts as they happen."""
    call, handler = _begin(path, request, timeout, metadata)
    ctx = ServicerContext(metadata, timeout)
    req = _roundtrip(request, serializer, handler.request_deserializer)

    def generator():
        try:
            for item in handler.behavior(req, ctx):
                yield _roundtrip(item, handler.response_serializer, deserializer)
        except BaseException as exc:
            ctx._finish()
            raise _translate(exc, ctx, call) from None
        _settle(ctx, call)

    return generator(), ctx


async def invoke_aio(path, request, timeout, metadata, serializer, deserializer):
    call, handler = _begin(path, request, timeout, metadata)
    ctx = AioServicerContext(metadata, timeout)
    try:
        req = _roundtrip(request, serializer, handler.request_deserializer)
        response = handler.behavior(req, ctx)
        if inspect.isawaitable(response):
            response = await response
        result = _roundtrip(response, handler.response_serializer, deserializer)
    except BaseException as exc:
        ctx._finish()
        raise _translate(exc, ctx, call) from None
    _settle(ctx, call)
    return result, ctx


class _Closed:
    pass


CLOSED = _Closed()


class AioStream:
    """
    A streaming call on an aio channel: the handler runs as a task feeding a response queue, the
    client reads with `async for` / `read()`, writes with `write()` (bidi) and may `cancel()`.
    """

    def __init__(self, path, request, timeout, metadata, serializer, deserializer, request_streaming: bool, request_iterator=None):
        self._path = path
        self._deserializer = deserializer
        self._serializer = serializer
        self._responses: asyncio.Queue = asyncio.Queue()
        self._requests: asyncio.Queue | None = asyncio.Queue() if request_streaming and request_iterator is None else None
        self._request_iterator = request_iterator
        self._request = request
        self._timeout = timeout
        self._metadata = metadata
        self._request_streaming = request_streaming
        self._ctx: AioServicerContext | None = None
        self._call: Call | None = None
        self._code: StatusCode | None = None
        self._details = ""
        self._error: CallError | None = None
        self._task: asyncio.Task | None = None
        self._cancelled = False
        self._done_callbacks: list[Callable] = []

    def _ensure_started(self) -> None:
        if self._task is None:
            self._task = asyncio.ensure_future(self._run())

    async def _requests_iter(self):
        if self._request_iterator is not None:
            if hasattr(self._request_iterator, "__aiter__"):
                async for item in self._request_iterator:
                    yield item
            else:
                for item in self._request_iterator:
                    yield item
            return
        assert self._requests is not None
        while True:
            item = await self._requests.get()
            if item is CLOSED:
                return
            yield item

    async def _run(self) -> None:
        try:
            self._call, handler = _begin(self._path, self._request, self._timeout, self._metadata)
        except CallError as exc:
            self._error = exc
            self._code = exc.code()
            self._details = exc.details()
            self._responses.put_nowait(exc)
            self._fire_done()
            return
        ctx = self._ctx = AioServicerContext(self._metadata, self._timeout)
        ctx._stream = self
        ctx._handler = handler
        try:
            if self._request_streaming:
                requests = self._requests_iter()
                # The handler receives already-deserialized messages; round-trip each one lazily. The
                # same iterator backs `context.read()`, so either style sees every request once.
                async def typed_requests():
                    async for item in requests:
                        yield _roundtrip(item, self._serializer, handler.request_deserializer)

                ctx._requests = typed_requests()
                response = handler.behavior(ctx._requests, ctx)
            else:
                req = _roundtrip(self._request, self._serializer, handler.request_deserializer)
                response = handler.behavior(req, ctx)
            if inspect.isasyncgen(response):
                async for item in response:
                    if ctx.cancelled():
                        break
                    self._responses.put_nowait(_roundtrip(item, handler.response_serializer, self._deserializer))
            elif inspect.isawaitable(response):
                result = await response
                if inspect.isasyncgen(result):
                    async for item in result:
                        if ctx.cancelled():
                            break
                        self._responses.put_nowait(_roundtrip(item, handler.response_serializer, self._deserializer))
                elif result is not None:
                    self._responses.put_nowait(_roundtrip(result, handler.response_serializer, self._deserializer))
            elif inspect.isgenerator(response):
                for item in response:
                    self._responses.put_nowait(_roundtrip(item, handler.response_serializer, self._deserializer))
            elif response is not None:
                self._responses.put_nowait(_roundtrip(response, handler.response_serializer, self._deserializer))
        except asyncio.CancelledError:
            ctx._cancel()
            self._code = StatusCode.CANCELLED
            self._responses.put_nowait(CallError(StatusCode.CANCELLED, "Locally cancelled by application!"))
            self._fire_done()
            return
        except BaseException as exc:
            ctx._finish()
            error = _translate(exc, ctx, self._call)
            self._error = error
            self._code = error.code()
            self._details = error.details()
            self._responses.put_nowait(error)
            self._fire_done()
            return
        ctx._finish()
        if ctx._code is not None and ctx._code is not StatusCode.OK:
            error = CallError(ctx._code, ctx._details or "", ctx.trailing_metadata())
            self._error, self._code, self._details = error, error.code(), error.details()
            self._call.code = error.code()
            self._responses.put_nowait(error)
        else:
            self._code = StatusCode.CANCELLED if self._cancelled else StatusCode.OK
            self._call.code = self._code
            self._responses.put_nowait(CLOSED)
        self._fire_done()

    def _fire_done(self) -> None:
        for cb in self._done_callbacks:
            cb(self)
        self._done_callbacks = []

    # ---- client surface ---------------------------------------------------------------------------
    def __aiter__(self):
        return self

    async def __anext__(self):
        item = await self.read()
        if item is EOF:
            raise StopAsyncIteration
        return item

    async def read(self):
        """The next response, or `grpc.aio.EOF` once the server is done."""
        if self._cancelled:
            raise CallError(StatusCode.CANCELLED, "Locally cancelled by application!")
        self._ensure_started()
        item = await self._responses.get()
        if item is CLOSED:
            self._responses.put_nowait(CLOSED)
            return EOF
        if isinstance(item, CallError):
            self._responses.put_nowait(item)
            raise item
        return item

    async def write(self, message) -> None:
        if self._requests is None:
            raise RuntimeError("write() is only available on calls that stream requests without an iterator")
        self._ensure_started()
        self._requests.put_nowait(message)
        await asyncio.sleep(0)

    async def done_writing(self) -> None:
        if self._requests is not None:
            self._requests.put_nowait(CLOSED)
            await asyncio.sleep(0)

    def cancel(self) -> bool:
        if self._cancelled or (self._task is not None and self._task.done()):
            return False
        self._cancelled = True
        if self._ctx is not None:
            self._ctx._cancel()
        if self._requests is not None:
            self._requests.put_nowait(CLOSED)
        if self._task is not None and not self._task.done():
            self._task.cancel()
        self._code = StatusCode.CANCELLED
        return True

    def cancelled(self) -> bool:
        return self._cancelled

    def done(self) -> bool:
        return self._task is not None and self._task.done()

    def add_done_callback(self, callback: Callable) -> None:
        if self.done():
            callback(self)
        else:
            self._done_callbacks.append(callback)

    async def wait_for_connection(self) -> None:
        self._ensure_started()

    async def code(self) -> StatusCode:
        self._ensure_started()
        if self._task is not None:
            try:
                await self._task
            except (asyncio.CancelledError, Exception):
                pass
        return self._code or StatusCode.OK

    async def details(self) -> str:
        await self.code()
        return self._details

    async def initial_metadata(self):
        return ()

    async def trailing_metadata(self):
        return self._ctx.trailing_metadata() if self._ctx else ()

    def time_remaining(self):
        return self._ctx.time_remaining() if self._ctx else self._timeout

    def __await__(self):
        """Awaiting a stream-unary call yields its single response."""
        return self._single().__await__()

    async def _single(self):
        item = await self.read()
        if item is EOF:
            raise CallError(StatusCode.INTERNAL, "the handler returned no response")
        return item


class _Eof:
    def __repr__(self) -> str:
        return "EOF"


EOF = _Eof()


# ---- servers -------------------------------------------------------------------------------------


class GenericRpcHandler:
    def __init__(self, service: str, method_handlers: dict[str, RpcMethodHandler]) -> None:
        self.service_name = service
        self.method_handlers = dict(method_handlers)

    def service(self, handler_call_details):
        return self.method_handlers.get(handler_call_details.method.rsplit("/", 1)[-1])


class Server:
    """A sync server (or a fake peer): handlers are registered as soon as they are added."""

    def __init__(self, *args, **kwargs) -> None:
        self.ports: list[str] = []
        self._stopped = asyncio.Event()

    def add_generic_rpc_handlers(self, generic_rpc_handlers) -> None:
        for handler in generic_rpc_handlers:
            for method, rpc_handler in handler.method_handlers.items():
                REGISTRY.register(handler.service_name, method, rpc_handler)

    def add_registered_method_handlers(self, service_name: str, method_handlers: dict) -> None:
        for method, rpc_handler in method_handlers.items():
            REGISTRY.register(service_name, method, rpc_handler)

    def add_insecure_port(self, address: str) -> int:
        self.ports.append(address)
        return int(address.rsplit(":", 1)[-1] or 0) if address.rsplit(":", 1)[-1].isdigit() else 0

    def add_secure_port(self, address: str, server_credentials) -> int:
        return self.add_insecure_port(address)

    def start(self) -> None:
        pass

    def stop(self, grace=None):
        self._stopped.set()
        return self._stopped

    def wait_for_termination(self, timeout=None) -> bool:
        return True


class AioServer(Server):
    async def start(self) -> None:  # type: ignore[override]
        pass

    async def stop(self, grace=None) -> None:  # type: ignore[override]
        self._stopped.set()

    async def wait_for_termination(self, timeout=None) -> bool:  # type: ignore[override]
        if timeout is None:
            await self._stopped.wait()
            return True
        try:
            await asyncio.wait_for(self._stopped.wait(), timeout)
            return True
        except asyncio.TimeoutError:
            return False


class HandlerCallDetails:
    def __init__(self, method: str, invocation_metadata) -> None:
        self.method = method
        self.invocation_metadata = invocation_metadata
