/**
 * Virtual clock for the TypeScript runtime. While a check runs, `Date.now()`, `performance.now()`
 * and the timer globals run on it: a `setTimeout` does not wait for wall time — on the next turn of
 * the event loop the clock jumps to the earliest pending sleep and fires it, so a backoff of 2 s
 * costs nothing and a TTL of a day is tested by `advance(86400)`. Intervals (background jobs) fire
 * only as virtual time passes them, by a sleep or an explicit advance, so a flusher cannot race the
 * clock forward on its own. A sleep limit ends `while (true)` loops the way Ctrl-C would: past it,
 * no more sleeps resolve and `interrupted` fires for the harness's `drain`.
 */

interface Timer {
  id: number;
  at: number;
  fn: () => void;
  interval: number | null;
}

const realNow = Date.now.bind(Date);
const realPerformanceNow = globalThis.performance?.now.bind(globalThis.performance);
const realSetTimeout = globalThis.setTimeout.bind(globalThis);
const realClearTimeout = globalThis.clearTimeout.bind(globalThis);
const realSetInterval = globalThis.setInterval.bind(globalThis);
const realClearInterval = globalThis.clearInterval.bind(globalThis);

/** The timer globals the runtime swaps: the lib types them as readonly, but a runtime is exactly what replaces them. */
interface TimerGlobals {
  setTimeout: unknown;
  clearTimeout: unknown;
  setInterval: unknown;
  clearInterval: unknown;
}
const GLOBALS: TimerGlobals = globalThis;

/** Virtual timer ids start high so a host library clearing one of its own real timers never hits ours. */
const FIRST_TIMER_ID = 1 << 30;

/** A real macrotask without `setTimeout(0)`'s clamping: a message to ourselves, or the real timer where there is no channel. */
const nextMacrotask: (fn: () => void) => void = (() => {
  if (typeof MessageChannel === 'undefined') return (fn: () => void): void => void realSetTimeout(fn, 0);
  const channel = new MessageChannel();
  const queue: (() => void)[] = [];
  channel.port1.onmessage = (): void => queue.shift()?.();
  // Node keeps the process alive for a listening port; the pump must not (`yarn verify` exits when done).
  if ('unref' in channel.port1 && typeof channel.port1.unref === 'function') channel.port1.unref();
  return (fn: () => void): void => {
    queue.push(fn);
    channel.port2.postMessage(null);
  };
})();

export class Clock {
  /** Milliseconds added to real time. */
  offset = 0;
  sleeps = 0;
  /** Virtual milliseconds the sleeps covered. */
  slept = 0;
  sleepLimit: number | null = null;
  interrupted = false;
  /** Real wall time, for the host's own bookkeeping. */
  readonly real = realNow;
  /** A real timer, for the host's own budgets. */
  readonly realTimeout = realSetTimeout;
  readonly realClearTimeout = realClearTimeout;
  private timers: Timer[] = [];
  private nextTimer = FIRST_TIMER_ID;
  private readonly advanceListeners: (() => void)[] = [];
  private readonly interruptListeners: (() => void)[] = [];
  private installed = false;
  private pumpScheduled = false;

  now(): number {
    return realNow() + this.offset;
  }

  reset(sleepLimit: number | null = null): void {
    this.offset = 0;
    this.sleeps = 0;
    this.slept = 0;
    this.sleepLimit = sleepLimit;
    this.interrupted = false;
    this.timers = [];
  }

  /** Move the clock forward: keys expire, windows roll over, deadlines pass, timers and background jobs fire. */
  advance(ms: number): void {
    this.offset += ms;
    this.fire();
  }

  /** Run `fn()` whenever virtual time moves forward: a background timer (it checks its own interval). */
  onAdvance(fn: () => void): void {
    this.advanceListeners.push(fn);
  }

  /** Run `fn()` when the sleep limit is hit: the harness's `drain` resolves and the loop stays suspended. */
  onInterrupt(fn: () => void): void {
    this.interruptListeners.push(fn);
  }

  /** `await clock.sleep(ms)`: a virtual sleep like any `setTimeout` of the learner's. */
  sleep(ms: number): Promise<void> {
    return new Promise(resolve => this.setTimeout(resolve, ms));
  }

  // ---- the globals the learner's code sees -------------------------------------------------------

  /** Replace `Date.now`, `performance.now`, `setTimeout`/`setInterval` (and their clears) with virtual ones. */
  install(): void {
    if (this.installed) return;
    this.installed = true;
    Date.now = () => this.now();
    const perf = globalThis.performance;
    if (perf !== undefined) perf.now = () => this.now();
    GLOBALS.setTimeout = (fn: () => void, ms?: number): number => this.setTimeout(fn, ms);
    GLOBALS.clearTimeout = (id?: number): void => {
      if (id === 0 || id === undefined) return;
      this.timers = this.timers.filter(t => t.id !== id);
    };
    GLOBALS.setInterval = (fn: () => void, ms?: number): number => {
      const every = Math.max(1, Number(ms) || 1);
      const id = this.nextTimer++;
      this.timers.push({id, at: this.now() + every, fn, interval: every});
      return id;
    };
    GLOBALS.clearInterval = (id?: number): void => {
      this.timers = this.timers.filter(t => t.id !== id);
    };
  }

  /** Restore the real globals (the host runs on real time between checks). */
  uninstall(): void {
    if (!this.installed) return;
    this.installed = false;
    Date.now = realNow;
    const perf = globalThis.performance;
    if (perf !== undefined && realPerformanceNow !== undefined) perf.now = realPerformanceNow;
    GLOBALS.setTimeout = realSetTimeout;
    GLOBALS.clearTimeout = realClearTimeout;
    GLOBALS.setInterval = realSetInterval;
    GLOBALS.clearInterval = realClearInterval;
  }
  private fire(): void {
    for (const fn of [...this.advanceListeners]) fn();
    // Timers fire in due order; a callback may schedule more.
    for (;;) {
      const now = this.now();
      const due = this.timers.filter(t => t.at <= now).sort((a, b) => a.at - b.at)[0];
      if (due === undefined) return;
      if (due.interval === null) this.timers = this.timers.filter(t => t !== due);
      else due.at += due.interval;
      due.fn();
    }
  }

  /**
   * One turn of virtual time, on a real macrotask so every promise continuation runs first: the
   * earliest pending sleep becomes due (intervals on the way fire too). Nothing left to sleep for,
   * or the sleep limit reached, and the pump stops. A turn scheduled before a reset still runs and
   * simply finds the new timers: dropping it would lose the wake-up they are waiting for.
   */
  private schedulePump(): void {
    if (this.pumpScheduled) return;
    this.pumpScheduled = true;
    nextMacrotask(() => {
      this.pumpScheduled = false;
      if (!this.installed) return;
      const sleeps = this.timers.filter(t => t.interval === null).sort((a, b) => a.at - b.at);
      if (sleeps.length === 0) return;
      if (this.sleepLimit !== null && this.sleeps >= this.sleepLimit) {
        if (!this.interrupted) {
          this.interrupted = true;
          for (const fn of [...this.interruptListeners]) fn();
        }
        return;
      }
      this.sleeps += 1;
      const target = sleeps[0].at;
      if (target > this.now()) {
        this.slept += target - this.now();
        this.offset += target - this.now();
      }
      this.fire();
      if (this.timers.some(t => t.interval === null)) this.schedulePump();
    });
  }

  private setTimeout(fn: () => void, ms?: number): number {
    const delay = Math.max(0, Number(ms) || 0);
    if (delay === 0) {
      realSetTimeout(fn, 0);
      return 0;
    }
    const id = this.nextTimer++;
    this.timers.push({id, at: this.now() + delay, fn, interval: null});
    this.schedulePump();
    return id;
  }
}

export const CLOCK = new Clock();
