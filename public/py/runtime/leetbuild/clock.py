"""
Virtual clock for the runtime: `time.time()`, `time.monotonic()`, `time.perf_counter()`,
`time.sleep()` and `asyncio.sleep()` all run on it. Sleeping advances the clock instead of
blocking, so TTLs, rate-limit windows and backoffs are testable in milliseconds; after
`sleep_limit` positive sleeps a KeyboardInterrupt ends `while True:` loops the way Ctrl-C would.
"""
import asyncio
import time


class Clock:
    def __init__(self) -> None:
        self._real_time = time.time
        self._real_monotonic = time.monotonic
        self._real_sleep = time.sleep
        self._real_async_sleep = asyncio.sleep
        self.offset = 0.0
        self.sleeps = 0
        self.sleep_limit: int | None = None

    def install(self) -> None:
        time.time = self.time
        time.monotonic = self.monotonic
        time.perf_counter = self.monotonic
        time.sleep = self.sleep
        asyncio.sleep = self.async_sleep
        asyncio.tasks.sleep = self.async_sleep

    def reset(self, sleep_limit: int | None = None) -> None:
        self.offset = 0.0
        self.sleeps = 0
        self.sleep_limit = sleep_limit

    def time(self) -> float:
        return self._real_time() + self.offset

    def monotonic(self) -> float:
        return self._real_monotonic() + self.offset

    def advance(self, seconds: float) -> None:
        """Move the clock forward: keys expire, windows roll over, deadlines pass."""
        self.offset += float(seconds)

    def sleep(self, seconds: float) -> None:
        self._tick(seconds)

    async def async_sleep(self, delay: float, result=None):
        self._tick(delay)
        await self._real_async_sleep(0)
        return result

    def _tick(self, seconds: float) -> None:
        seconds = float(seconds)
        if seconds <= 0:
            return
        self.sleeps += 1
        if self.sleep_limit is not None and self.sleeps > self.sleep_limit:
            raise KeyboardInterrupt(f"stopped after {self.sleep_limit} sleeps")
        self.offset += seconds


CLOCK = Clock()
