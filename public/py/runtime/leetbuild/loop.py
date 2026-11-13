"""
The event loop checks run on: Pyodide's WebLoop with its timers on the virtual clock.

While a check runs (the clock installed and frozen), `call_later` and `call_at` put a timer in a
queue instead of a host setTimeout. Ready callbacks still run as host macrotasks, in order. When none
is pending and no host I/O (a Postgres query) is in flight, the clock jumps to the earliest timer and
runs it, the rule the TypeScript and Go clocks follow. So concurrent waits overlap: `asyncio.gather`
over calls of 0.3, 0.5 and 0.2 s takes 0.5 s, sleeps wake in deadline order, and `asyncio.wait_for`
and `asyncio.timeout` expire on the virtual clock. With the clock following real time (uninstalled
for a program run), timers are WebLoop's own setTimeouts.
"""
from __future__ import annotations

import asyncio
import contextlib
import heapq
import itertools
import math

from pyodide.webloop import WebLoop

from .clock import CLOCK


class VirtualLoop(WebLoop):
    def __init__(self) -> None:
        super().__init__()
        # (when, sequence, handle), `when` on `self.time()`: the clock's monotonic reading.
        self._timers: list[tuple[float, int, asyncio.TimerHandle]] = []
        self._sequence = itertools.count()
        # Callbacks handed to the host and not yet run, and host requests in flight: the clock
        # jumps only when both are zero, so no timer fires ahead of work that is still due first.
        self._ready = 0
        self._io = 0
        self._jump_pending = False

    def call_soon(self, callback, *args, context=None):
        handle = asyncio.Handle(callback, args, self, context=context)
        self._post(handle)
        return handle

    def call_later(self, delay, callback, *args, context=None):
        if not CLOCK.virtual:
            return WebLoop.call_later(self, delay, callback, *args, context=context)
        return self.call_at(self.time() + delay, callback, *args, context=context)

    def call_at(self, when, callback, *args, context=None):
        if not CLOCK.virtual:
            return WebLoop.call_at(self, when, callback, *args, context=context)
        handle = asyncio.TimerHandle(when, callback, args, self, context=context)
        if math.isinf(when):
            return handle  # never due, as WebLoop's
        heapq.heappush(self._timers, (when, next(self._sequence), handle))
        self._after()
        return handle

    def reset(self) -> None:
        """Drop the timers a check left behind: the next check starts its clock afresh."""
        for _when, _sequence, handle in self._timers:
            handle.cancel()
        self._timers.clear()

    def _post(self, handle: asyncio.Handle) -> None:
        self._ready += 1

        def run() -> None:
            self._ready -= 1
            try:
                if not handle.cancelled():
                    handle._run()
            finally:
                self._after()

        WebLoop.call_later(self, 0, run)

    def _after(self) -> None:
        """Run the timers now due; if nothing else can run, jump the clock to the next one."""
        now = self.time()
        while self._timers and self._timers[0][0] <= now:
            handle = heapq.heappop(self._timers)[2]
            if not handle.cancelled():
                self._post(handle)
        if self._jump_pending or self._ready or self._io or not self._timers:
            return
        self._jump_pending = True
        WebLoop.call_later(self, 0, self._jump)

    def _jump(self) -> None:
        self._jump_pending = False
        if self._ready or self._io or not CLOCK.virtual:
            return  # what ran meanwhile settles again when it finishes
        while self._timers and self._timers[0][2].cancelled():
            heapq.heappop(self._timers)
        if not self._timers:
            return
        gap = self._timers[0][0] - self.time()
        if gap > 0:
            CLOCK.advance(gap)
        self._after()


LOOP: VirtualLoop | None = None


def install() -> VirtualLoop:
    """Make the virtual-time loop the one tasks run on (`run_checks` creates its task there)."""
    global LOOP
    LOOP = VirtualLoop()
    asyncio.set_event_loop(LOOP)
    return LOOP


@contextlib.contextmanager
def host_request():
    """Hold the clock while the host serves a request (a Postgres query): no timer jumps past it."""
    loop = LOOP
    if loop is None:
        yield
        return
    loop._io += 1
    try:
        yield
    finally:
        loop._io -= 1
