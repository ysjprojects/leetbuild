"""
Virtual clock for the runtime: `time.time()`, `time.monotonic()`, `time.perf_counter()` (and their
`_ns` forms), `time.sleep()` and `asyncio.sleep()` all run on it, and so does everything that reads the system
clock: `time.gmtime()`, `time.localtime()`, `time.strftime(fmt)` (no tuple given), and in the
learner's and the harness's code `datetime.now()` (with or without a tz), `datetime.utcnow()`,
`datetime.today()`, `date.today()`. The machine's timezone stays the one the host reports (as
`datetime.fromtimestamp` and `time.mktime` see it). `time.sleep()` advances the clock at once, as a
blocking sleep holds the whole program; `asyncio.sleep()` waits on the event loop, whose timers run
on this clock while it is frozen (`loop.py`), so concurrent waits overlap. Either way TTLs, rate-limit
windows and backoffs are testable in milliseconds; after `sleep_limit` positive sleeps a
KeyboardInterrupt ends `while True:` loops the way Ctrl-C would. A harness check runs it frozen
(`freeze`): time moves only when advanced, slept or waited, never with real time.
"""
import asyncio
import builtins
import datetime
import math
import time
import types

_real_date = datetime.date
_real_datetime = datetime.datetime


class _ClockType(type):
    """`isinstance(x, datetime)` holds for real datetimes too: a library (pydantic, a driver) makes real instances."""

    def __instancecheck__(cls, obj) -> bool:
        real = cls.__dict__.get("_real")
        return isinstance(obj, real) if real is not None else type.__instancecheck__(cls, obj)


class _AsReal:
    """Reads, pickles and validates as the real class: the C repr prefixes a subclass's bare __name__,
    pickle looks the class up as `datetime.datetime` (the real one: libraries keep the real module),
    and pydantic knows `datetime` fields by the real class."""

    def __repr__(self) -> str:
        text = super().__repr__()
        return f"datetime.{text}" if "_real" in type(self).__dict__ else text

    def __reduce_ex__(self, protocol):
        reduced = super().__reduce_ex__(protocol)
        return (self._real, *reduced[1:]) if "_real" in type(self).__dict__ else reduced

    @classmethod
    def __get_pydantic_core_schema__(cls, source, handler):
        return handler.generate_schema(cls._real)


class _Date(_AsReal, _real_date, metaclass=_ClockType):
    """`datetime.date` reading the clock `time.time()` is: the virtual one while installed."""

    _real = _real_date

    @classmethod
    def today(cls):
        return cls.fromtimestamp(time.time())


class _Datetime(_AsReal, _real_datetime, metaclass=_ClockType):
    """`datetime.datetime` reading the clock `time.time()` is: the virtual one while installed."""

    _real = _real_datetime

    @classmethod
    def now(cls, tz=None):
        return cls.fromtimestamp(time.time(), tz)

    @classmethod
    def utcnow(cls):
        return cls.fromtimestamp(time.time(), datetime.timezone.utc).replace(tzinfo=None)

    @classmethod
    def today(cls):
        return cls.fromtimestamp(time.time())


for _cls, _name in ((_Date, "date"), (_Datetime, "datetime")):
    _cls.__module__ = "datetime"
    _cls.__qualname__ = _cls.__name__ = _name

# The `datetime` module the learner's and the harness's code import: the real one with the two
# classes above. Libraries keep the real module, so their own subclasses of `date` (pydantic v1's,
# with a metaclass of their own) and their type-keyed tables (encoders, adapters) are untouched.
_DATETIME = types.ModuleType("datetime", datetime.__doc__)
_DATETIME.__dict__.update({**vars(datetime), "date": _Date, "datetime": _Datetime})


def _imports_virtual_datetime(globals) -> bool:
    """Code the clock governs: the learner's and the course's modules (/work, /support) and the harness."""
    if not globals:
        return False
    return globals.get("__name__") == "harness" or str(globals.get("__file__") or "").startswith(("/work/", "/support/"))


class Clock:
    def __init__(self) -> None:
        self._real_time = time.time
        self._real_monotonic = time.monotonic
        self._real_perf_counter = time.perf_counter
        self._real_ns = (time.time_ns, time.monotonic_ns, time.perf_counter_ns)
        self._real_sleep = time.sleep
        self._real_async_sleep = asyncio.sleep
        self._real_gmtime = time.gmtime
        self._real_localtime = time.localtime
        self._real_strftime = time.strftime
        self._real_import = builtins.__import__
        self.offset = 0.0
        self.sleeps = 0
        # Virtual seconds the sleeps covered.
        self.slept = 0.0
        self.sleep_limit: int | None = None
        # (wall, monotonic) real readings the clock stopped at (`freeze`); None while it follows real time.
        self._frozen: tuple[float, float] | None = None
        # The task the harness runs its checks in. Past the limit only its sleeps raise: a background
        # task's KeyboardInterrupt would escape the event loop, and the harness cancels those tasks
        # when the check ends. None: every sleep raises.
        self.task: asyncio.Task | None = None
        # Background timers (Kafka's auto-commit) — they outlive `reset`, which only rewinds time.
        self._listeners: list = []
        self._installed = False

    def install(self) -> None:
        self._installed = True
        time.time = self.time
        time.monotonic = self.monotonic
        time.perf_counter = self.monotonic
        time.time_ns = self.time_ns
        time.monotonic_ns = time.perf_counter_ns = self.monotonic_ns
        time.sleep = self.sleep
        time.gmtime = self.gmtime
        time.localtime = self.localtime
        time.strftime = self.strftime
        asyncio.sleep = self.async_sleep
        asyncio.tasks.sleep = self.async_sleep
        builtins.__import__ = self.import_

    def uninstall(self) -> None:
        """Give the real clock back: a program run (`python file.py`) times itself in real time."""
        self._installed = False
        time.time = self._real_time
        time.monotonic = self._real_monotonic
        time.perf_counter = self._real_perf_counter
        time.time_ns, time.monotonic_ns, time.perf_counter_ns = self._real_ns
        time.sleep = self._real_sleep
        time.gmtime = self._real_gmtime
        time.localtime = self._real_localtime
        time.strftime = self._real_strftime
        asyncio.sleep = self._real_async_sleep
        asyncio.tasks.sleep = self._real_async_sleep
        builtins.__import__ = self._real_import

    def reset(self, sleep_limit: int | None = None) -> None:
        self.offset = 0.0
        self.sleeps = 0
        self.slept = 0.0
        self.sleep_limit = sleep_limit

    def freeze(self) -> None:
        """Stop following real time, at the real time now: the clock moves only when advanced or slept,
        so a check reads the same on a loaded machine as on an idle one (the TypeScript, Go and C++
        checks run this way). It stops on a whole second, as the TypeScript clock does; a `reset` in
        the middle of a check rewinds to that instant and stays frozen."""
        self._frozen = (float(math.floor(self._real_time())), self._real_monotonic())

    @property
    def virtual(self) -> bool:
        """Whether the event loop's timers wait on this clock rather than in real time: installed and frozen, as while a check runs."""
        return self._installed and self._frozen is not None

    def time(self) -> float:
        return (self._real_time() if self._frozen is None else self._frozen[0]) + self.offset

    def monotonic(self) -> float:
        return (self._real_monotonic() if self._frozen is None else self._frozen[1]) + self.offset

    def time_ns(self) -> int:
        return round(self.time() * 1e9)

    def monotonic_ns(self) -> int:
        return round(self.monotonic() * 1e9)

    def gmtime(self, secs: float | None = None) -> time.struct_time:
        return self._real_gmtime(self.time() if secs is None else secs)

    def localtime(self, secs: float | None = None) -> time.struct_time:
        return self._real_localtime(self.time() if secs is None else secs)

    def strftime(self, format: str, t=None) -> str:
        return self._real_strftime(format, self._real_localtime(self.time()) if t is None else t)

    def import_(self, name, globals=None, locals=None, fromlist=(), level=0):
        """`__import__` handing the learner's and the harness's code the clock's `datetime` module."""
        module = self._real_import(name, globals, locals, fromlist, level)
        return _DATETIME if name == "datetime" and level == 0 and _imports_virtual_datetime(globals) else module

    def advance(self, seconds: float) -> None:
        """Move the clock forward: keys expire, windows roll over, deadlines pass, background timers fire."""
        self.offset += float(seconds)
        self._fire()

    def on_advance(self, fn) -> None:
        """Run `fn()` whenever virtual time moves forward: a background timer (it checks its own interval)."""
        self._listeners.append(fn)

    def sleep(self, seconds: float) -> None:
        self._tick(seconds)

    async def async_sleep(self, delay: float, result=None):
        """`asyncio.sleep`: counted like `time.sleep`, then a timer on the event loop, which waits on this clock."""
        self._count(delay)
        return await self._real_async_sleep(delay, result)

    async def wait(self, seconds: float) -> None:
        """Wait on the event loop without counting a sleep: a call's latency, not the learner's backoff."""
        await self._real_async_sleep(seconds)

    def _count(self, seconds: float) -> float:
        """Count a positive sleep in `sleeps` and `slept`; past `sleep_limit` the check's own sleeps raise."""
        seconds = float(seconds)
        if seconds <= 0:
            return 0.0
        self.sleeps += 1
        if self.sleep_limit is not None and self.sleeps > self.sleep_limit:
            if self.task is None or asyncio.current_task() is self.task:
                raise KeyboardInterrupt(f"stopped after {self.sleep_limit} sleeps")
        self.slept += seconds
        return seconds

    def _tick(self, seconds: float) -> None:
        seconds = self._count(seconds)
        if seconds:
            self.offset += seconds
            self._fire()

    def _fire(self) -> None:
        for fn in list(self._listeners):
            fn()


CLOCK = Clock()
