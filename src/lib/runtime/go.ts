/**
 * The Go runtime, shared by the browser worker and `yarn verify` (Node): yaegi, a Go interpreter
 * compiled to WebAssembly (goruntime/, built by `yarn build:go` into public/go/runtime.wasm.gz),
 * compiles the learner's step file with the step's Go harness and runs one check at a time, in the
 * world the TypeScript runtime also uses — the Redis server, PGlite, the virtual clock — which the
 * Go side reaches through `globalThis.__lbGo`. Kafka, gRPC, HTTP and the process are modelled on
 * the Go side. A Go program that exits (a crash) is started again for the next check.
 */
import './wasmExec.js';

import {type DbBridge} from './db';
import {CLOCK, nextMacrotask} from './ts/clock';
import {CHECK_BUDGET_MS, resetResources, snapshotMetrics} from './ts/harness';
import * as pg from './ts/pg';
import * as redis from './ts/redis';
import type {RunJob, RunMetrics, RunResult, RuntimeCheckResult} from './types';

export interface GoHost {
  /** The runtime's WebAssembly, decompressed. */
  wasm: () => Promise<BufferSource>;
  db: DbBridge;
  luaEval: redis.LuaEval;
}

export interface GoRuntime {
  run(job: RunJob): Promise<RunResult>;
}

/** wasm_exec.js's `Go`: one program instance. */
interface GoProgram {
  run(instance: WebAssembly.Instance): Promise<void>;
  importObject: WebAssembly.Imports;
  exited: boolean;
}

/** What the program exposes (goruntime/cmd/wasm). */
interface GoApi {
  run(job: string, check: string): Promise<string>;
  metrics(): string;
}

interface GoCheckResult {
  id: string;
  passed: boolean;
  message?: string;
  stdout: string;
  stderr: string;
}

type Tagged = {r: redis.Reply} | {e: string};

const tagged = (run: () => redis.Reply): Tagged => {
  try {
    return {r: run()};
  } catch (e) {
    return {e: e instanceof Error ? e.message : String(e)};
  }
};

const each = (replies: (redis.Reply | redis.ReplyError)[]): Tagged[] =>
  replies.map(r => (r instanceof redis.ReplyError ? {e: r.message} : {r}));

/** Asynchronous work the Go side is waiting on (database statements): the world is not settled while any is in flight. */
let inFlight = 0;

/** A bridge call the Go side blocks on: settling waits for it. */
const tracked = async <T>(work: Promise<T>): Promise<T> => {
  inFlight += 1;
  try {
    return await work;
  } finally {
    inFlight -= 1;
  }
};

/** Every function of a bridge (nested objects too) throwing once `live()` turns false. */
const guarded = <T extends object>(tree: T, live: () => boolean): T =>
  Object.fromEntries(
    Object.entries(tree).map(([name, value]: [string, unknown]) => [
      name,
      typeof value === 'function'
        ? (...args: unknown[]): unknown => {
            if (!live()) throw new Error('this Go runtime was stopped');
            return (value as (...a: unknown[]) => unknown)(...args);
          }
        : typeof value === 'object' && value !== null
        ? guarded(value, live)
        : value,
    ]),
  ) as T;

/**
 * `globalThis.__lbGo` for one Go program: the JavaScript half of the world, as goruntime/jsworld
 * calls it. Timers go through the globals, which the clock swaps for virtual ones while a check
 * runs. `disable` cuts off a program that was abandoned (its check ran out of time): its calls
 * throw from then on, and database connections it still holds are released, their transaction
 * rolled back, so the next program's statements neither wait on them nor run inside them.
 */
const makeBridge = (): {bridge: object; disable: () => Promise<void>} => {
  let live = true;
  const held = new Set<() => void>();
  const bridge = {
    clock: {
      now: (): number => CLOCK.now(),
      setTimeout: (fn: () => void, ms: number): unknown => globalThis.setTimeout(fn, ms),
      clearTimeout: (id: ReturnType<typeof setTimeout>): void => globalThis.clearTimeout(id),
      setInterval: (fn: () => void, ms: number): unknown => globalThis.setInterval(fn, ms),
      clearInterval: (id: ReturnType<typeof setInterval>): void => globalThis.clearInterval(id),
      advance: (ms: number): void => CLOCK.advance(ms),
      sleeps: (): number => CLOCK.sleeps,
      slept: (): number => CLOCK.slept,
      setSleepLimit: (n: number): void => {
        CLOCK.sleepLimit = n;
      },
    },
    redis: {
      execute: (args: string[], record: boolean): Tagged => tagged(() => redis.SERVER.execute(args, record)),
      pipeline: (cmds: string[][]): Tagged[] => each(redis.SERVER.executePipeline(cmds)),
      transaction: (cmds: string[][]): Tagged[] => each(redis.SERVER.executeTransaction(cmds)),
      fingerprint: (key: string): string => redis.SERVER.fingerprint(key),
      probe: (key: string, fn: () => void): void => {
        redis.SERVER.probes.push({key, fn, fired: false, result: undefined, error: undefined});
      },
      subscribe: (
        name: string,
        pattern: boolean,
        fn: (pattern: string | null, channel: string, message: string) => void,
      ): (() => void) =>
        pattern
          ? redis.SERVER.psubscribe(name, (p, channel, message) => fn(p, channel, message))
          : redis.SERVER.subscribe(name, (channel, message) => fn(null, channel, message)),
      trips: (): string[][] => redis.SERVER.trips,
    },
    /** Postgres for the Go driver (goruntime/models/pq/backend.go), through the shared Db's lock and counts. */
    db: {
      hold: async (): Promise<() => void> => {
        const release = await tracked(pg.DB.hold());
        let released = false;
        const once = (): void => {
          if (released) return;
          released = true;
          held.delete(once);
          release();
        };
        held.add(once);
        return once;
      },
      run: (sql: string, args: (string | Uint8Array | null)[], held: boolean, counted: boolean): Promise<string> =>
        tracked(pg.DB.runText(sql, args, held, counted)),
      reset: (schema: string): Promise<void> => tracked(pg.DB.resetSchema(schema)),
    },
    /** `fn` once every goroutine is blocked, no sleep is pending and nothing is in flight (or the sleep budget ran out). */
    settle: (fn: () => void): void => {
      const check = (): void => {
        if (!CLOCK.interrupted && (CLOCK.hasPendingSleeps() || inFlight > 0)) nextMacrotask(check);
        else fn();
      };
      nextMacrotask(check);
    },
    /** `fn` once every goroutine is blocked and nothing is in flight, the clock held where it is: pending sleeps wait. */
    tick: (fn: () => void): void => {
      CLOCK.hold();
      const check = (): void => {
        if (inFlight > 0) {
          nextMacrotask(check);
          return;
        }
        CLOCK.release();
        fn();
      };
      nextMacrotask(check);
    },
    onInterrupt: (fn: () => void): void => CLOCK.onInterrupt(fn),
  };
  return {
    bridge: guarded(bridge, () => live),
    disable: async (): Promise<void> => {
      live = false;
      const open = [...held];
      for (const release of open) release();
      if (open.length > 0) await pg.DB.runText('ROLLBACK', [], false, false).catch(() => undefined);
    },
  };
};

/** Whether a job reaches the database: PGlite then boots before the checks, outside their budgets. */
const usesDatabase = (job: RunJob): boolean =>
  [job.harness, ...Object.values(job.files), ...Object.values(job.support)].some(src =>
    /"database\/sql"|"github\.com\/lib\/pq"|\bctx\.DB\./.test(src),
  );

const goMetrics = (api: GoApi): Partial<RunMetrics> => JSON.parse(api.metrics()) as Partial<RunMetrics>;

export async function createGoRuntime(host: GoHost): Promise<GoRuntime> {
  redis.SERVER.lua = host.luaEval;
  pg.DB.bridge = host.db;
  const compiled = await WebAssembly.compile(await host.wasm());
  let api: GoApi | null = null;
  let exited: Promise<void> = Promise.resolve();
  let disable = async (): Promise<void> => undefined;

  /** A fresh Go program on a fresh bridge; the previous program, if any, is cut off first. */
  const start = async (): Promise<GoApi> => {
    await disable();
    const made = makeBridge();
    disable = made.disable;
    const scope = globalThis as unknown as {Go: new () => GoProgram; __lbGo?: object; __lbGoRuntime?: GoApi};
    scope.__lbGo = made.bridge;
    delete scope.__lbGoRuntime;
    const program = new scope.Go();
    const instance = await WebAssembly.instantiate(compiled, program.importObject);
    // run() executes main up to its `select {}` synchronously, so the API is in place on return.
    exited = program.run(instance).catch(() => undefined);
    const started = scope.__lbGoRuntime;
    if (started === undefined) throw new Error('the Go runtime did not start');
    return started;
  };

  return {
    async run(job: RunJob): Promise<RunResult> {
      const began = CLOCK.real();
      api ??= await start();
      // PGlite's first open takes seconds: not part of any check's budget.
      if (usesDatabase(job)) await host.db.exec('SELECT 1');
      const payload = JSON.stringify({
        files: job.files,
        support: job.support,
        harness: job.harness,
        entry: job.entry ?? '',
        checks: job.checks,
      });
      const checks: RuntimeCheckResult[] = [];
      const stdout: string[] = [];
      const stderr: string[] = [];
      for (const id of job.checks) {
        resetResources();
        CLOCK.install();
        // Interpreted Go is slow enough for real time to show: time moves only when advanced or slept.
        CLOCK.freeze();
        let budget: ReturnType<typeof CLOCK.realTimeout> | null = null;
        try {
          const timedOut = new Promise<'timeout'>(resolve => {
            budget = CLOCK.realTimeout(() => resolve('timeout'), CHECK_BUDGET_MS);
          });
          const outcome = await Promise.race([api.run(payload, id), timedOut, exited.then(() => 'exited' as const)]);
          if (outcome === 'exited') {
            checks.push({id, passed: false, message: 'the Go runtime crashed during this check'});
            api = await start();
            continue;
          }
          const metrics = {...snapshotMetrics(), ...goMetrics(api)};
          if (outcome === 'timeout') {
            checks.push({
              id,
              passed: false,
              message: `the check did not finish within ${CHECK_BUDGET_MS / 1000} s`,
              metrics,
            });
            // The check is still running in that program: the next one gets a fresh program.
            api = await start();
            continue;
          }
          const result = JSON.parse(outcome) as GoCheckResult;
          stdout.push(result.stdout);
          stderr.push(result.stderr);
          checks.push(
            result.passed
              ? {id, passed: true, metrics}
              : {id, passed: false, message: result.message ?? 'failed', metrics},
          );
        } finally {
          if (budget !== null) CLOCK.realClearTimeout(budget);
          CLOCK.uninstall();
        }
      }
      resetResources();
      return {checks, stdout: stdout.join(''), stderr: stderr.join(''), ms: Math.round(CLOCK.real() - began)};
    },
  };
}
