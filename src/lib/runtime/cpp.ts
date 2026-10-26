/**
 * The C++ runtime, shared by the browser worker and `yarn verify` (Node). Clang compiled to
 * WebAssembly (`@yowasp/clang`) compiles the learner's step file with the step's C++ harness and
 * the runtime's models of the libraries the courses use (cppruntime/include: cpp-httplib,
 * redis-plus-plus, …) into one WebAssembly program, against a WASI sysroot built with C++
 * exceptions. Each check runs in a fresh instance of that program, in the world the TypeScript
 * runtime also uses: the Redis server, PGlite, the virtual clock. The program's threads are green
 * threads: each has its own stack, and JSPI (`WebAssembly.Suspending`/`promising`) suspends the
 * running one at every blocking call — a lock, a sleep, a query — and resumes another. The
 * runtime's pthreads (cppruntime/include/lb/pthread.h) are what libc++'s std::thread, mutexes and
 * condition variables run on. Needs JSPI and exception references: Chrome 137, Firefox 153, Node 24.
 */
import {type Bridge, type BridgeWorld} from './cpp/bridge';
import {dbBridge} from './cpp/db';
import {COMPILE_FLAGS, LINK_FLAGS} from './cpp/flags';
import {kafkaBridge} from './cpp/kafka';
import {type Tree} from './cpp/pack';
import {generateCppProtos, ProtoError} from './cpp/protogen';
import {redisBridge} from './cpp/redis';
import {CPP_UNSUPPORTED, cppSupported} from './cpp/support';
import {type DbBridge} from './db';
import {CLOCK, nextMacrotask} from './ts/clock';
import {CHECK_BUDGET_MS, resetResources, snapshotMetrics} from './ts/harness';
import * as pg from './ts/pg';
import * as redis from './ts/redis';
import type {RunJob, RunResult, RuntimeCheckResult} from './types';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace WebAssembly {
    /** JSPI: an import that suspends the WebAssembly calling it until its promise settles. */
    class Suspending {
      constructor(fn: (...args: never[]) => Promise<unknown>);
    }
    /** JSPI: an export whose call returns a promise, so the imports it reaches may suspend. */
    function promising(fn: unknown): (...args: unknown[]) => Promise<unknown>;
  }
}

/** `@yowasp/clang`'s `clang++` command: arguments, the file tree it sees, its output streams; the tree after. */
export type ClangCommand = (
  /** null: only fetch the compiler's own files. */
  args: string[] | null,
  files: Tree,
  options: {
    stdout: ((bytes: Uint8Array | null) => void) | null;
    stderr: ((bytes: Uint8Array | null) => void) | null;
    /** The compiler's own download (its first run in a session); the worker reports it as a phase instead. */
    fetchProgress?: () => void;
  },
) => Promise<Tree | undefined> | Tree | undefined;

export interface CppHost {
  clang: () => Promise<ClangCommand>;
  /** The WASI sysroot (cut by scripts/fetch-cpp.ts): paths under it, and their bytes. */
  sysroot: () => Promise<Tree>;
  /** The runtime's pack (cppruntime/include and libleetbuild.a, built by `yarn build:cpp`), mounted at /lb. */
  runtime: () => Promise<Tree>;
  db: DbBridge;
  luaEval: redis.LuaEval;
  /**
   * Programs compiled before, by what they were compiled from (`key`: the work tree and the flags;
   * the host adds the runtime pack's identity): `yarn verify` keeps them on disk, so worker
   * processes can compile its jobs in parallel ahead of the checks.
   */
  programs?: {
    get(key: string): Promise<Uint8Array | null>;
    put(key: string, wasm: Uint8Array): Promise<void>;
  };
}

export interface CppRuntime {
  /** Compile and run the job's checks; `started` is called once the program compiled and its checks begin. */
  run(job: RunJob, started?: () => void): Promise<RunResult>;
  /** Compile the job's program only (into `programs`, when the host keeps them): the compile error, if any. */
  compile(job: RunJob): Promise<string | null>;
}

// ---- compiling ---------------------------------------------------------------------------------

const WORK = '/work';
/** The harness and the generated translation unit, beside the learner's files. */
const HARNESS = '.lb/harness.cpp';
const MAIN = '.lb/main.cpp';

/** Headers generated from the course's .proto files (./cpp/protogen.ts), as protoc would write them. */
const GEN = 'gen';

/** The program: the learner's files beside the harness, then the runtime's library before libc. */
const FLAGS = [...COMPILE_FLAGS, `-I${WORK}`, `-I${WORK}/${GEN}`, '-ferror-limit=10', ...LINK_FLAGS];

/** `Check` + the id in CamelCase: the harness function a check runs (the Go runtime's convention). */
export function checkName(id: string): string {
  return `Check${id
    .split(/[-_ ]+/)
    .filter(part => part !== '')
    .map(part => part[0].toUpperCase() + part.slice(1))
    .join('')}`;
}

/** The translation unit: the learner's file (found through -I/work), then the harness, then the check table. */
const mainUnit = (entry: string, checks: readonly string[]): string =>
  [
    `#include "${entry}"`,
    '#include "harness.cpp"',
    '#include <lb/checks.h>',
    `LB_CHECKS(${checks.map(checkName).join(', ')})`,
    '',
  ].join('\n');

/**
 * Clang's diagnostics with the virtual paths gone (`/work/token_bucket.cpp:3:1` reads
 * `token_bucket.cpp:3:1`), and without the generated translation unit the learner never sees.
 */
const tidy = (text: string): string =>
  text
    .replaceAll(`${WORK}/.lb/main.cpp`, 'main.cpp')
    .replaceAll(`${WORK}/.lb/harness.cpp`, 'harness.cpp')
    .replaceAll(`${WORK}/`, '')
    .replaceAll('/lb/include/', '')
    .replace(/^In file included from main\.cpp:\d+:\n/gm, '');

/**
 * The first error, as the check's message: whose code it is in, then clang's line. An error inside
 * a library header (a model's template) is the code that instantiated it: the first line of the
 * learner's (or the harness's) that clang's notes lead back to is named.
 */
const explainCompile = (diagnostics: string, entry: string): string => {
  const lines = diagnostics.split('\n');
  const at = lines.findIndex(line => /: (fatal )?error: /.test(line));
  const first = at >= 0 ? lines[at] : lines.find(line => line.trim() !== '') ?? 'clang failed';
  const ours = (line: string): boolean => line.startsWith(`${entry}:`);
  const harness = (line: string): boolean => line.startsWith('harness.cpp:') || line.startsWith('main.cpp:');
  if (harness(first)) return `the harness does not compile against your code: ${first}`;
  if (ours(first) || at < 0) return `your code does not compile: ${first}`;
  const origin = lines.slice(at + 1).find(line => ours(line) || harness(line));
  if (origin !== undefined && harness(origin)) return `the harness does not compile against your code: ${first}`;
  const where = origin?.match(/^([^:]+:\d+:\d+)/)?.[1];
  return `your code does not compile: ${first}${where === undefined ? '' : ` (from ${where})`}`;
};

type Compiled = {module: WebAssembly.Module} | {error: string; diagnostics: string};

// ---- the program's world -----------------------------------------------------------------------

/** The program called exit() (or returned from a thread that ends the process): the exit status. */
class ProgramExit extends Error {
  constructor(readonly status: number) {
    super(`exit status ${status}`);
  }
}

interface Thread {
  id: number;
  /** The stack pointer the thread suspended at. */
  sp: number;
  /** Its stack's allocation (null: the program's own stack). */
  stack: number | null;
  /** The reply to its last bridge call, until it reads it. */
  reply: Uint8Array;
  /** Its exceptions in flight (libc++abi's __cxa_eh_globals) while another thread runs. */
  eh: Uint8Array;
}

interface Exports {
  memory: WebAssembly.Memory;
  __stack_pointer: WebAssembly.Global;
  malloc: (size: number) => number;
  free: (ptr: number) => void;
  _initialize: () => void;
  lb_check: (index: number) => void;
  lb_thread_main: (task: number) => void;
  lb_invoke: (handle: number) => void;
  lb_deliver: (handle: number, data: number, size: number) => void;
  lb_eh_globals: () => number;
}

const STACK_BYTES = 256 * 1024;

/** The resources a program reaches, each a bridge module (./cpp/bridge.ts). */
const BRIDGES: ((world: BridgeWorld) => Bridge)[] = [redisBridge, dbBridge, kafkaBridge];

/** libc++abi's __cxa_eh_globals on wasm32: the caught exceptions' stack, the count of uncaught ones. */
const EH_BYTES = 8;

const MS_NS = BigInt(1e6);

/**
 * Virtual time in nanoseconds, exactly: milliseconds since the epoch times 10⁶ is past a double's
 * integers, and an elapsed 250 ms must read 250 ms, not 249.9999 (libc++'s wait_for judges a timeout by it).
 */
const virtualNanoseconds = (): bigint => {
  const ms = CLOCK.now();
  const whole = Math.floor(ms);
  return BigInt(whole) * MS_NS + BigInt(Math.round((ms - whole) * 1e6));
};

const nanosecondsToMs = (ns: bigint): number => Number(ns / MS_NS) + Number(ns % MS_NS) / 1e6;

const ERRNO = {SUCCESS: 0, BADF: 8, NOENT: 44, NOSYS: 52, NOTSUP: 58, SPIPE: 70};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Functions of the runtime, the standard library and libc: a crash site is the first frame that is none of them. */
const RUNTIME_FRAME =
  /^(std::|lb::|harness::|httplib::|sw::redis::|RdKafka::|rd_kafka_|abi::|__|_[A-Z]|abort$|exit$|operator |dlmalloc|dlfree|malloc$|free$|memcpy|memset|strlen|lb_|void std::)/;

/** Where a trap happened: the innermost function of the program's own code on its stack (names from wasm's name section). */
const crashSite = (error: unknown): string => {
  const stack = error instanceof Error ? error.stack ?? '' : '';
  for (const m of stack.matchAll(/at program\.wasm\.(.+?) \(wasm:/g)) {
    const name = m[1].replace(/^undefined_weak:/, '');
    if (!RUNTIME_FRAME.test(name)) return ` (in ${name})`;
  }
  return '';
};

/** What a trap means, for the check's message. */
const describeCrash = (error: unknown): string => {
  if (error instanceof ProgramExit) return `the program exited: ${error.message}`;
  const text = error instanceof Error ? error.message : String(error);
  const site = crashSite(error);
  if (/unreachable/.test(text))
    return `the program aborted${site} (abort(), std::terminate, or a throw from a noexcept function)`;
  if (/out of bounds|null function|signature mismatch/i.test(text))
    return `the program crashed${site}: ${text} (a bad pointer or an object used after it was freed?)`;
  if (/call stack|stack overflow/i.test(text))
    return `the program crashed${site}: stack overflow (unbounded recursion?)`;
  return `the program crashed${site}: ${text}`;
};

/**
 * One instance of the compiled program: its memory, its green threads, its output, its calls into
 * the world. Once over (`stop`) nothing of it runs again: a thread whose wait ends afterwards (a
 * query that was in flight) stays suspended for good rather than act on the next check's world.
 */
class Instance {
  stdout = '';
  stderr = '';
  /** Why the program cannot go on (a trap, an exit, an exception escaping a thread): the check fails with it. */
  crash: string | null = null;
  /** The check's verdict, as the C++ side reported it (null: passed). */
  failure: string | null = null;
  private exports!: Exports;
  private readonly threads = new Map<number, Thread>();
  /** The program's own thread: static initialization and the check run on it. */
  private readonly main: Thread = {id: 1, sp: 0, stack: null, reply: new Uint8Array(), eh: new Uint8Array(EH_BYTES)};
  private current: Thread = this.main;
  private nextThreadId = 2;
  private readonly parked = new Map<number, (woken: number) => void>();
  private live = true;
  /** The status the program exited with (exit() on one of its threads): from then on only the check's thread runs. */
  private exitStatus: number | null = null;
  private inFlight = 0;
  /** The resources this program reaches (Redis, Postgres, …), each answering its model's requests. */
  private readonly bridges: Bridge[];
  private readonly crashed: Promise<void>;
  private onCrash!: () => void;
  private schedulerStack = 0;
  /** Where libc++abi keeps the exceptions in flight: one struct, swapped with each thread's own. */
  private ehGlobals = 0;
  /** Whether a thread has the CPU: it runs, or was handed the CPU and is about to resume. */
  private busy = false;
  /** Threads whose wait ended (or that are new), in order, waiting for the CPU. */
  private readonly ready: (() => void)[] = [];
  /** Settles in progress: `settle.release` ends them early (a Drain whose function returned). */
  private readonly settling = new Set<() => void>();
  /** Calls into the program made synchronously from inside one of its own (a harness hook): no stack to suspend there. */
  private synchronous = 0;

  constructor(private readonly onOutput: ((stream: 'stdout' | 'stderr', text: string) => void) | null) {
    this.crashed = new Promise(resolve => {
      this.onCrash = resolve;
    });
    this.bridges = BRIDGES.map(make => make(this.world()));
  }

  private get memory(): DataView {
    return new DataView(this.exports.memory.buffer);
  }

  async start(module: WebAssembly.Module): Promise<void> {
    const imports = {wasi_snapshot_preview1: this.wasi(), lb: this.bridge()} as WebAssembly.Imports;
    const instance = await WebAssembly.instantiate(module, imports);
    this.exports = instance.exports as unknown as Exports;
    this.main.sp = this.exports.__stack_pointer.value as number;
    this.threads.set(this.main.id, this.main);
    this.schedulerStack = this.exports.malloc(64 * 1024) + 64 * 1024;
    this.ehGlobals = this.exports.lb_eh_globals();
  }

  /** Static initialization, then check `index`, on the program's own thread; resolves when it ends or the program crashes. */
  async runCheck(index: number): Promise<void> {
    const main = this.main;
    // Each call of the program's own thread holds the CPU from its start to its end, as every thread does.
    const segment = async (entry: (...args: number[]) => void, ...args: number[]): Promise<void> => {
      await this.acquire();
      this.enter(main);
      try {
        await WebAssembly.promising(entry)(...args);
      } finally {
        this.release();
      }
    };
    const run = async (): Promise<void> => {
      await segment(this.exports._initialize);
      await segment(this.exports.lb_check, index);
    };
    await Promise.race([run().catch(error => this.die(error)), this.crashed]);
  }

  /** Cut the program off: its waits never end, what it holds (a database connection) is released. */
  async stop(): Promise<void> {
    this.live = false;
    for (const bridge of this.bridges) await bridge.stop?.();
  }

  private die(error: unknown): void {
    this.fail(describeCrash(error));
  }

  /** The program cannot go on: the check fails with `message` (the first one stands). */
  private fail(message: string): void {
    this.crash ??= message;
    this.onCrash();
  }

  /** Make `thread` the running one: its stack, its exceptions in flight. */
  private enter(thread: Thread): void {
    this.current = thread;
    this.exports.__stack_pointer.value = thread.sp;
    this.bytes(this.ehGlobals, EH_BYTES).set(thread.eh);
  }

  /** The running thread waits: keep where its stack and its exceptions in flight are. */
  private leave(thread: Thread): void {
    thread.sp = this.exports.__stack_pointer.value as number;
    thread.eh = this.bytes(this.ehGlobals, EH_BYTES).slice();
  }

  private bytes(ptr: number, len: number): Uint8Array {
    return new Uint8Array(this.exports.memory.buffer, ptr, len);
  }

  private text(ptr: number, len: number): string {
    return decoder.decode(this.bytes(ptr, len));
  }

  /** Call into the program from outside any thread (freeing a finished thread's stack) on a stack of its own. */
  private outside<T>(fn: () => T): T {
    const sp = this.exports.__stack_pointer.value as number;
    this.exports.__stack_pointer.value = this.schedulerStack;
    try {
      return fn();
    } finally {
      this.exports.__stack_pointer.value = sp;
    }
  }

  /**
   * Wait for the CPU. One thread runs at a time, and a thread whose wait ended resumes only once the
   * running one waits or ends: JSPI resumes a stack a microtask after its import's promise settles,
   * so two threads woken together would otherwise both set the stack pointer before either resumed.
   */
  private acquire(): Promise<void> {
    return new Promise(resolve => {
      this.ready.push(resolve);
      this.dispatch();
    });
  }

  /** The running thread waits or ended: the next ready one gets the CPU. */
  private release(): void {
    this.busy = false;
    this.dispatch();
  }

  private dispatch(): void {
    if (this.busy) return;
    const next = this.ready.shift();
    if (next === undefined) return;
    this.busy = true;
    next();
  }

  /** An import the calling thread waits on: its stack is saved, the CPU handed on, and both taken back when the wait ends. */
  private suspending<A extends unknown[], R>(fn: (...args: A) => Promise<R>): WebAssembly.Suspending {
    return new WebAssembly.Suspending((async (...args: A): Promise<R> => {
      const self = this.current;
      this.leave(self);
      this.release();
      const result = await fn(...args);
      await this.acquire();
      // Over (the next check's world is not this program's), or the process exited: never resume.
      if (!this.live || (this.exitStatus !== null && self.id !== 1)) {
        this.release();
        await new Promise<never>(() => undefined);
      }
      this.enter(self);
      return result;
    }) as unknown as (...args: never[]) => Promise<unknown>);
  }

  /** Start a green thread running `entry` on a fresh stack, once it gets the CPU. */
  private spawn(entry: (thread: Thread) => Promise<unknown>): number {
    const stack = this.exports.malloc(STACK_BYTES);
    const thread: Thread = {
      id: this.nextThreadId++,
      sp: stack + STACK_BYTES,
      stack,
      reply: new Uint8Array(),
      eh: new Uint8Array(EH_BYTES),
    };
    this.threads.set(thread.id, thread);
    void this.acquire().then(() => {
      if (!this.live || this.exitStatus !== null) {
        this.release();
        return;
      }
      this.enter(thread);
      entry(thread).then(
        () => this.finish(thread),
        error => {
          this.finish(thread);
          // exit() on a thread of the program ends the process, not the check: the harness reads the status.
          if (error instanceof ProgramExit) this.exitStatus ??= error.status;
          else this.die(error);
        },
      );
    });
    return thread.id;
  }

  /**
   * exit() on one of the program's threads: the status is the program's, and the thread stops where
   * it is, running nothing more. A JS exception would unwind it instead, and C++ catches those
   * (`catch (...)`) and runs every local destructor on the way out, which exit() must not.
   */
  private exit(status: number): Promise<never> {
    this.exitStatus ??= status;
    // The check's own thread exited: the check cannot go on.
    if (this.current === this.main) this.die(new ProgramExit(status));
    this.release();
    return new Promise<never>(() => undefined);
  }

  /** A thread ended: its stack is freed and the CPU handed on. */
  private finish(thread: Thread): void {
    this.threads.delete(thread.id);
    const stack = thread.stack;
    if (stack !== null && this.live) this.outside(() => this.exports.free(stack));
    this.release();
  }

  /** Asynchronous work a thread waits on (a database statement): the world is not settled while any is in flight. */
  private async tracked<T>(work: Promise<T>): Promise<T> {
    this.inFlight += 1;
    try {
      return await work;
    } finally {
      this.inFlight -= 1;
    }
  }

  private setReply(value: unknown): number {
    this.current.reply = encoder.encode(JSON.stringify(value ?? null));
    return this.current.reply.length;
  }

  /** The world as a bridge module sees it: callbacks into this program, in-flight tracking. */
  private world(): BridgeWorld {
    return {
      deliver: (handle, payload) => this.deliver(handle, payload),
      invoke: handle => {
        this.synchronous += 1;
        try {
          this.exports.lb_invoke(handle);
        } finally {
          this.synchronous -= 1;
        }
      },
      tracked: work => this.tracked(work),
      live: () => this.live,
    };
  }

  /** The synchronous requests C++ makes through lb::call: op name to handler of the JSON request. */
  private calls(): Record<string, (request: never) => unknown> {
    return {
      'check.failed': (message: string): void => {
        this.failure ??= message;
      },
      'program.exit': (): number | null => this.exitStatus,
      // As std::terminate would end a real program: an exception escaped a std::thread's function.
      'thread.uncaught': (message: string): void => {
        this.fail(`a thread of the program threw ${message}, and nothing caught it`);
      },
      'clock.advance': (ms: number): void => CLOCK.advance(ms),
      'clock.sleeps': (): number => CLOCK.sleeps,
      'clock.slept': (): number => CLOCK.slept,
      'clock.setSleepLimit': (n: number): void => {
        CLOCK.setSleepLimit(n);
      },
      // End the settles in progress now: what the harness drained has returned (Go's Drain selects on both).
      'settle.release': (): void => {
        for (const release of [...this.settling]) release();
      },
      ...Object.assign({}, ...this.bridges.map(b => b.calls ?? {})),
    };
  }

  /** Requests C++ waits on (lb::call_async): a query, a connection. */
  private asyncCalls(): Record<string, (request: never) => Promise<unknown>> {
    return Object.assign({}, ...this.bridges.map(b => b.asyncCalls ?? {}));
  }

  /** A callback into the program on a thread of its own (a published message): `handle`'s function gets `payload`. */
  private deliver(handle: number, payload: string): void {
    if (!this.live) return;
    const bytes = encoder.encode(payload);
    this.spawn(async () => {
      const ptr = this.exports.malloc(bytes.length);
      this.bytes(ptr, bytes.length).set(bytes);
      await WebAssembly.promising(this.exports.lb_deliver)(handle, ptr, bytes.length);
    });
  }

  /** The `lb` imports (cppruntime/include/lb/runtime.h). */
  private bridge(): Record<string, unknown> {
    const calls = this.calls();
    const asyncCalls = this.asyncCalls();
    const request = (opPtr: number, opLen: number, reqPtr: number, reqLen: number): [string, unknown] => [
      this.text(opPtr, opLen),
      JSON.parse(this.text(reqPtr, reqLen)),
    ];
    return {
      spawn: (task: number): number => this.spawn(() => WebAssembly.promising(this.exports.lb_thread_main)(task)),
      self: (): number => this.current.id,
      park: this.suspending(
        (token: number) =>
          new Promise<number>(resolve => {
            this.parked.set(token, resolve);
          }),
      ),
      park_for: this.suspending(
        (token: number, ms: number) =>
          new Promise<number>(resolve => {
            const timer = globalThis.setTimeout(() => {
              if (this.parked.get(token) !== wake) return;
              this.parked.delete(token);
              resolve(0);
            }, Math.max(0, ms));
            const wake = (woken: number): void => {
              globalThis.clearTimeout(timer);
              resolve(woken);
            };
            this.parked.set(token, wake);
          }),
      ),
      unpark: (token: number): number => {
        const wake = this.parked.get(token);
        if (wake === undefined) return 0;
        this.parked.delete(token);
        wake(1);
        return 1;
      },
      yield: this.suspending(() => Promise.resolve()),
      now: (): number => CLOCK.now(),
      sleep: this.suspending((ms: number) => CLOCK.sleepUntil(CLOCK.now() + Math.max(0, ms))),
      // Once every other thread waits, no sleep is pending and nothing is in flight (or the sleep budget
      // ran out), or settle.release ends it first.
      settle: this.suspending(
        () =>
          new Promise<void>(resolve => {
            const done = (): void => {
              this.settling.delete(done);
              resolve();
            };
            this.settling.add(done);
            const check = (): void => {
              if (!this.settling.has(done)) return;
              if (!CLOCK.interrupted && (CLOCK.hasPendingSleeps() || this.inFlight > 0)) nextMacrotask(check);
              else done();
            };
            nextMacrotask(check);
          }),
      ),
      // Once every other thread waits and nothing is in flight, the clock held where it is: pending sleeps wait.
      tick: this.suspending(
        () =>
          new Promise<void>(resolve => {
            CLOCK.hold();
            const check = (): void => {
              if (this.inFlight > 0) {
                nextMacrotask(check);
                return;
              }
              CLOCK.release();
              resolve();
            };
            nextMacrotask(check);
          }),
      ),
      call: (opPtr: number, opLen: number, reqPtr: number, reqLen: number): number => {
        const [op, body] = request(opPtr, opLen, reqPtr, reqLen);
        const handler = calls[op];
        if (handler === undefined) throw new Error(`the C++ runtime has no call ${op}`);
        return this.setReply(handler(body as never));
      },
      call_async: this.suspending(async (opPtr: number, opLen: number, reqPtr: number, reqLen: number) => {
        const [op, body] = request(opPtr, opLen, reqPtr, reqLen);
        const handler = asyncCalls[op];
        if (handler === undefined) throw new Error(`the C++ runtime has no call ${op}`);
        const self = this.current;
        const reply = await handler(body as never);
        this.current = self;
        return this.setReply(reply);
      }),
      reply: (into: number): void => {
        this.bytes(into, this.current.reply.length).set(this.current.reply);
      },
    };
  }

  /** WASI preview 1, as far as a program without files or sockets uses it; time is the virtual clock. */
  private wasi(): Record<string, unknown> {
    const out = (stream: 'stdout' | 'stderr', text: string): void => {
      this[stream] += text;
      this.onOutput?.(stream, text);
    };
    const streams = {1: new TextDecoder(), 2: new TextDecoder()};
    const ns = virtualNanoseconds;
    const args = ['program'];
    const known: Record<string, unknown> = {
      args_sizes_get: (argc: number, size: number): number => {
        this.memory.setUint32(argc, args.length, true);
        this.memory.setUint32(
          size,
          args.reduce((sum, a) => sum + encoder.encode(a).length + 1, 0),
          true,
        );
        return ERRNO.SUCCESS;
      },
      args_get: (argv: number, buf: number): number => {
        let at = buf;
        args.forEach((arg, i) => {
          const bytes = encoder.encode(arg);
          this.memory.setUint32(argv + i * 4, at, true);
          this.bytes(at, bytes.length).set(bytes);
          this.memory.setUint8(at + bytes.length, 0);
          at += bytes.length + 1;
        });
        return ERRNO.SUCCESS;
      },
      environ_sizes_get: (count: number, size: number): number => {
        this.memory.setUint32(count, 0, true);
        this.memory.setUint32(size, 0, true);
        return ERRNO.SUCCESS;
      },
      environ_get: (): number => ERRNO.SUCCESS,
      clock_res_get: (_id: number, res: number): number => {
        this.memory.setBigUint64(res, BigInt(1000), true);
        return ERRNO.SUCCESS;
      },
      clock_time_get: (_id: number, _precision: bigint, time: number): number => {
        this.memory.setBigUint64(time, ns(), true);
        return ERRNO.SUCCESS;
      },
      fd_write: (fd: number, iovs: number, count: number, written: number): number => {
        if (fd !== 1 && fd !== 2) return ERRNO.BADF;
        let total = 0;
        let text = '';
        for (let i = 0; i < count; i++) {
          const ptr = this.memory.getUint32(iovs + i * 8, true);
          const len = this.memory.getUint32(iovs + i * 8 + 4, true);
          text += streams[fd].decode(this.bytes(ptr, len), {stream: true});
          total += len;
        }
        out(fd === 1 ? 'stdout' : 'stderr', text);
        this.memory.setUint32(written, total, true);
        return ERRNO.SUCCESS;
      },
      fd_read: (fd: number, _iovs: number, _count: number, read: number): number => {
        if (fd !== 0) return ERRNO.BADF;
        this.memory.setUint32(read, 0, true);
        return ERRNO.SUCCESS;
      },
      fd_fdstat_get: (fd: number, stat: number): number => {
        if (fd > 2) return ERRNO.BADF;
        this.memory.setUint8(stat, 2); // a character device
        this.memory.setUint16(stat + 2, 0, true);
        this.memory.setBigUint64(stat + 8, BigInt(0), true);
        this.memory.setBigUint64(stat + 16, BigInt(0), true);
        return ERRNO.SUCCESS;
      },
      fd_fdstat_set_flags: (): number => ERRNO.SUCCESS,
      fd_filestat_get: (fd: number, stat: number): number => {
        if (fd > 2) return ERRNO.BADF;
        this.bytes(stat, 64).fill(0);
        this.memory.setUint8(stat + 16, 2);
        return ERRNO.SUCCESS;
      },
      fd_prestat_get: (): number => ERRNO.BADF,
      fd_prestat_dir_name: (): number => ERRNO.BADF,
      fd_seek: (): number => ERRNO.SPIPE,
      fd_tell: (): number => ERRNO.SPIPE,
      fd_close: (): number => ERRNO.SUCCESS,
      fd_sync: (): number => ERRNO.SUCCESS,
      path_open: (): number => ERRNO.NOENT,
      path_filestat_get: (): number => ERRNO.NOENT,
      random_get: (buf: number, len: number): number => {
        for (let at = 0; at < len; at += 65536) {
          crypto.getRandomValues(this.bytes(buf + at, Math.min(65536, len - at)));
        }
        return ERRNO.SUCCESS;
      },
      // Not async: inside a synchronous call there is no stack to suspend, and exit() can only unwind.
      proc_exit: new WebAssembly.Suspending(((status: number): Promise<never> => {
        if (this.synchronous > 0) throw new ProgramExit(status);
        return this.exit(status);
      }) as unknown as (...args: never[]) => Promise<unknown>),
      sched_yield: this.suspending(async () => ERRNO.SUCCESS),
      // Sleeps (nanosleep, std::this_thread::sleep_for): wait on the virtual clock until the earliest
      // clock subscription is due; a read of stdin is ready at once (end of input).
      poll_oneoff: this.suspending(async (inPtr: number, outPtr: number, count: number, eventsPtr: number) => {
        const now = ns();
        const deadline = (sub: number): bigint => {
          const timeout = this.memory.getBigUint64(sub + 24, true);
          return (this.memory.getUint16(sub + 40, true) & 1) === 1 ? timeout : now + timeout;
        };
        let wake: bigint | null = null;
        let ready = false;
        for (let i = 0; i < count; i++) {
          const sub = inPtr + i * 48;
          if (this.memory.getUint8(sub + 8) !== 0) {
            ready = true;
            continue;
          }
          const at = deadline(sub);
          if (wake === null || at < wake) wake = at;
        }
        const sleep = !ready && wake !== null && wake > now ? wake : null;
        if (sleep !== null) await CLOCK.sleepUntil(nanosecondsToMs(sleep));
        // The deadline slept for is due even if the clock reads a hair before it (ms in a double).
        const due = sleep !== null && sleep > ns() ? sleep : ns();
        let events = 0;
        for (let i = 0; i < count; i++) {
          const sub = inPtr + i * 48;
          const tag = this.memory.getUint8(sub + 8);
          if (tag === 0 && deadline(sub) > due) continue;
          const event = outPtr + events * 32;
          this.bytes(event, 32).fill(0);
          this.memory.setBigUint64(event, this.memory.getBigUint64(sub, true), true);
          this.memory.setUint8(event + 10, tag);
          events += 1;
        }
        this.memory.setUint32(eventsPtr, events, true);
        return ERRNO.SUCCESS;
      }),
    };
    // Everything else (sockets, the rest of the file system) does not exist here.
    return new Proxy(known, {get: (target, name: string) => target[name] ?? ((): number => ERRNO.NOSYS)});
  }
}

export async function createCppRuntime(host: CppHost): Promise<CppRuntime> {
  redis.SERVER.lua = host.luaEval;
  pg.DB.bridge = host.db;
  const [clang, sysroot, runtime] = await Promise.all([host.clang(), host.sysroot(), host.runtime()]);
  // Fetch the compiler's own files now, quietly: its first command would otherwise print its progress.
  await clang(null, {}, {stdout: null, stderr: null, fetchProgress: () => undefined});
  /** Programs already compiled this session, by their sources: a second Submit of the same code compiles nothing. */
  const modules = new Map<string, Compiled>();

  const compile = async (job: RunJob): Promise<Compiled> => {
    const entry = job.entry ?? Object.keys(job.files)[0];
    const work: Tree = {};
    const put = (path: string, text: string): void => {
      const parts = path.split('/');
      let dir = work;
      for (const part of parts.slice(0, -1)) dir = (dir[part] ??= {}) as Tree;
      dir[parts[parts.length - 1]] = text;
    };
    for (const [path, text] of Object.entries(job.support)) put(path, text);
    const protos = Object.fromEntries(Object.entries(job.support).filter(([path]) => path.endsWith('.proto')));
    if (Object.keys(protos).length > 0) {
      try {
        for (const [path, text] of Object.entries(generateCppProtos(protos))) put(`${GEN}/${path}`, text);
      } catch (error) {
        if (!(error instanceof ProtoError)) throw error;
        return {error: `the course's .proto files: ${error.message}`, diagnostics: error.message};
      }
    }
    for (const [name, text] of Object.entries(job.files)) put(name, text);
    put(HARNESS, job.harness);
    put(MAIN, mainUnit(entry, job.checks));
    const key = JSON.stringify(work);
    const cached = modules.get(key);
    if (cached !== undefined) return cached;
    const programKey = JSON.stringify({work, flags: FLAGS});
    const stored = (await host.programs?.get(programKey)) ?? null;
    if (stored !== null) {
      const result: Compiled = {module: await WebAssembly.compile(stored)};
      modules.set(key, result);
      return result;
    }
    let diagnostics = '';
    const collect = (bytes: Uint8Array | null): void => {
      if (bytes !== null) diagnostics += decoder.decode(bytes, {stream: true});
    };
    let result: Compiled;
    try {
      const files = await clang(
        [...FLAGS, `${WORK}/${MAIN}`, '-o', `${WORK}/program.wasm`],
        {sysroot, lb: runtime, work},
        {
          stdout: collect,
          stderr: collect,
          fetchProgress: () => undefined,
        },
      );
      const wasm = ((files as Tree).work as Tree)['program.wasm'] as Uint8Array;
      result = {module: await WebAssembly.compile(wasm)};
      await host.programs?.put(programKey, wasm);
    } catch (error) {
      const text = tidy(diagnostics || (error instanceof Error ? error.message : String(error)));
      result = {error: explainCompile(text, entry), diagnostics: text};
    }
    modules.set(key, result);
    return result;
  };

  return {
    async compile(job: RunJob): Promise<string | null> {
      const compiled = await compile(job);
      return 'error' in compiled ? compiled.error : null;
    },
    async run(job: RunJob, started?: () => void): Promise<RunResult> {
      const began = CLOCK.real();
      if (!cppSupported()) return {checks: [], stdout: '', stderr: '', error: CPP_UNSUPPORTED, ms: 0};
      const compiled = await compile(job);
      if ('error' in compiled) {
        return {
          checks: job.checks.map(id => ({id, passed: false, message: compiled.error})),
          stdout: '',
          stderr: compiled.diagnostics,
          ms: Math.round(CLOCK.real() - began),
        };
      }
      started?.();
      const checks: RuntimeCheckResult[] = [];
      const stdout: string[] = [];
      const stderr: string[] = [];
      for (const [index, id] of job.checks.entries()) {
        resetResources();
        CLOCK.install();
        // Time moves only when advanced or slept: a run is the same on a slow machine as on a fast one.
        CLOCK.freeze();
        const program = new Instance(null);
        let budget: ReturnType<typeof CLOCK.realTimeout> | null = null;
        try {
          const timedOut = new Promise<'timeout'>(resolve => {
            budget = CLOCK.realTimeout(() => resolve('timeout'), CHECK_BUDGET_MS);
          });
          await program.start(compiled.module);
          const outcome = await Promise.race([program.runCheck(index).then(() => 'done' as const), timedOut]);
          const metrics = snapshotMetrics();
          stdout.push(program.stdout);
          stderr.push(program.stderr);
          if (outcome === 'timeout') {
            checks.push({
              id,
              passed: false,
              message: `the check did not finish within ${CHECK_BUDGET_MS / 1000} s`,
              metrics,
            });
            continue;
          }
          const message = program.failure ?? program.crash;
          checks.push(message === null ? {id, passed: true, metrics} : {id, passed: false, message, metrics});
        } catch (error) {
          checks.push({id, passed: false, message: describeCrash(error)});
        } finally {
          await program.stop();
          if (budget !== null) CLOCK.realClearTimeout(budget);
          CLOCK.uninstall();
        }
      }
      resetResources();
      return {checks, stdout: stdout.join(''), stderr: stderr.join(''), ms: Math.round(CLOCK.real() - began)};
    },
  };
}
