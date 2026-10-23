/**
 * The TypeScript harness runner. A step's harness is a TypeScript module exporting one
 * `check_<id>(ctx)` per check (`-` in the id becomes `_`), run in order against the learner's files
 * in a world reset before each: empty Redis, empty broker, no gRPC peers, the clock at zero with a
 * sleep budget, fresh module instances. `assert` is in scope. Checks grade outcomes — what is in
 * Redis, what the broker holds, what the app answered — never the learner's source.
 *
 *   ctx.load(stem)           the learner's module `/work/<stem>.ts` (fresh per check)
 *   ctx.redis                the server, synchronously: `ctx.redis.get(key)`, `.ttl`, `.keys()`, `.hgetall` …
 *   ctx.redisAfter(key, fn)  run `fn` right after the first command touching `key`, before its caller sees the reply
 *   ctx.db                   Postgres: `await ctx.db.execute(sql, params)`, `await ctx.db.reset(schema)`, `.events`, `.queries`
 *   ctx.dbAfter(pattern, fn) run `fn` right after the first statement containing `pattern`
 *   ctx.kafka                the broker: seed, records, values, keys, lag, commits, committedOffset, onCommit,
 *                            failNext, stall, resume, loseAcks, failover
 *   ctx.grpc                 peers: serve(serviceDef, impl, target?), stop(target), setLatency, fail, callsTo, status
 *   ctx.proto(file)          the course's .proto as `loadPackageDefinition(loadSync(file))`
 *   ctx.clock                advance(seconds), now() in ms, sleeps
 *   ctx.client(app)          in-process HTTP: get/post/put/patch/delete/request → {status, headers, text, json()}
 *   ctx.drain(promise)       await the learner's loop until it ends or the sleep budget stops it
 */
import type {RunMetrics} from '../types';
import {Buffer} from './buffer';
import {CLOCK} from './clock';
import * as grpc from './grpc';
import {type FastifyInstance, type InjectOptions} from './http';
import {BROKER} from './kafka';
import {type ModuleSystem, HARNESS, WORK} from './loader';
import {assert, PROCESS} from './node';
import {DB} from './pg';
import {type Probe, type Reply, byteStringToBytes, fromByteString, SERVER, toByteString} from './redis';

export interface CheckResult {
  id: string;
  passed: boolean;
  message?: string;
  metrics?: RunMetrics;
}

/** Virtual sleeps one check may take before its loops are stopped. */
export const SLEEP_LIMIT = 500;
/** Real time one check may take; a check still running past it fails and the next one starts. */
export const CHECK_BUDGET_MS = 10_000;

export interface HttpResponse {
  json<T = unknown>(): T;
  status: number;
  headers: Record<string, string>;
  text: string;
  /** The body verbatim (a binary response, e.g. an image or a board blob). */
  bytes: Uint8Array;
}

export interface RequestOptions {
  headers?: Record<string, string>;
  /** Sent as JSON with `content-type: application/json`. */
  json?: unknown;
  /** Sent verbatim. */
  body?: string;
  query?: Record<string, string | number | boolean | undefined>;
  remoteAddress?: string;
}

export interface HttpClient {
  get(url: string, options?: RequestOptions): Promise<HttpResponse>;
  post(url: string, options?: RequestOptions): Promise<HttpResponse>;
  put(url: string, options?: RequestOptions): Promise<HttpResponse>;
  patch(url: string, options?: RequestOptions): Promise<HttpResponse>;
  delete(url: string, options?: RequestOptions): Promise<HttpResponse>;
  request(method: string, url: string, options?: RequestOptions): Promise<HttpResponse>;
}

const httpClient = (app: FastifyInstance): HttpClient => {
  const request = async (method: string, url: string, options: RequestOptions = {}): Promise<HttpResponse> => {
    const inject: InjectOptions = {
      method,
      url,
      headers: {...options.headers},
      query: options.query,
      remoteAddress: options.remoteAddress,
    };
    if (options.json !== undefined) {
      inject.payload = JSON.stringify(options.json);
      inject.headers = {'content-type': 'application/json', ...inject.headers};
    } else if (options.body !== undefined) inject.payload = options.body;
    const response = await app.inject(inject);
    return {
      status: response.statusCode,
      headers: response.headers,
      text: response.body,
      bytes: response.rawPayload,
      json: <T>(): T => response.json<T>(),
    };
  };
  return {
    request,
    get: (url, options) => request('GET', url, options),
    post: (url, options) => request('POST', url, options),
    put: (url, options) => request('PUT', url, options),
    patch: (url, options) => request('PATCH', url, options),
    delete: (url, options) => request('DELETE', url, options),
  };
};

/** `redirect` → `/work/redirect.ts`; an absolute path (`/support/notify/db.ts`) is taken as is. */
const modulePath = (stem: string): string => {
  const path = stem.includes('/') || stem.endsWith('.ts') ? stem : `${WORK}/${stem}.ts`;
  return path.startsWith('/') ? path : `${WORK}/${path}`;
};

/**
 * The server, synchronously, every command a method: `ctx.redis.get('k')`, `.hgetall('h')` as an
 * object, `.getBuffer('k')` for binary values — text in, text out, as an ioredis client would see it.
 */
type SyncRedis = Record<string, (...args: (string | number | Uint8Array)[]) => unknown> & {
  call(command: string, ...args: (string | number | Uint8Array)[]): unknown;
};

const syncRedis = (): SyncRedis => {
  const call = (method: string, ...args: (string | number | Uint8Array)[]): unknown => {
    const lower = method.toLowerCase();
    const asBuffer = lower.length > 6 && lower.endsWith('buffer');
    const command = asBuffer ? lower.slice(0, -6) : lower;
    const reply = SERVER.execute([command, ...args.map(a => toByteString(a))], false);
    const decode = (r: Reply): unknown => {
      if (typeof r === 'string') return asBuffer ? Buffer.from(byteStringToBytes(r)) : fromByteString(r);
      if (Array.isArray(r)) return r.map(decode);
      return r;
    };
    if (command === 'hgetall' && Array.isArray(reply)) {
      const out: Record<string, unknown> = {};
      for (let i = 0; i + 1 < reply.length; i += 2) out[fromByteString(String(reply[i]))] = decode(reply[i + 1]);
      return out;
    }
    return decode(reply);
  };
  const target = {call} as SyncRedis;
  return new Proxy(target, {
    get: (_target, prop) => {
      if (prop === 'call') return call;
      if (typeof prop !== 'string') return undefined;
      return (...args: (string | number | Uint8Array)[]): unknown => call(prop, ...args);
    },
  });
};

export class Ctx {
  readonly redis = syncRedis();
  readonly db = DB;
  readonly kafka = BROKER;
  readonly grpc = {
    serve: grpc.serve,
    stop: (target: string): void => grpc.REGISTRY.stop(target),
    setLatency: (method: string, seconds: number, target: string | null = null): void =>
      grpc.REGISTRY.setLatency(method, seconds, target),
    fail: (method: string, code: grpc.StatusCode, details = '', times = 1, target: string | null = null): void =>
      grpc.REGISTRY.fail(method, code, details, times, target),
    callsTo: (method: string, target: string | null = null): grpc.Call[] => grpc.REGISTRY.callsTo(method, target),
    calls: grpc.REGISTRY.calls,
    status: grpc.status,
    Metadata: grpc.Metadata,
  };
  /** The learner's `process`: `ctx.process.emit('SIGTERM')` delivers a signal; `exited` is the code `process.exit` was called with, or null. */
  readonly process = PROCESS;
  readonly clock = {
    advance: (seconds: number): void => CLOCK.advance(seconds * 1000),
    now: (): number => CLOCK.now(),
    get sleeps(): number {
      return CLOCK.sleeps;
    },
  };
  private interrupted: Promise<void>;

  constructor(private readonly modules: ModuleSystem) {
    this.interrupted = new Promise<void>(resolve => CLOCK.onInterrupt(resolve));
  }

  /** @internal a fresh interrupt promise per check. */
  _rearm(): void {
    this.interrupted = new Promise<void>(resolve => CLOCK.onInterrupt(resolve));
  }

  load(stem: string): Record<string, unknown> {
    return this.modules.load(modulePath(stem));
  }

  /** A second, fresh instance of the learner's module (another replica of the service): module state starts over. */
  reload(stem: string): Record<string, unknown> {
    const path = modulePath(stem);
    this.modules.forget(path);
    return this.modules.load(path);
  }

  /** Run `fn` once right after the first command touching `key`; the probe records `fired`, `result`, `error`. */
  redisAfter(key: string, fn: () => unknown): Probe {
    const probe: Probe = {key: toByteString(key), fn, fired: false, result: undefined, error: undefined};
    SERVER.probes.push(probe);
    return probe;
  }

  /** Subscribe to a channel as another connection would; `fn(channel, message)` per PUBLISH. Returns the unsubscribe. */
  redisSubscribe(channel: string, fn: (channel: string, message: string) => void): () => void {
    return SERVER.subscribe(toByteString(channel), (ch, message) => fn(fromByteString(ch), fromByteString(message)));
  }

  /** Every round trip the learner's clients made so far, as upper-case command names: `[['SMEMBERS'], ['MGET']]`; a pipeline is one trip (`['GET', 'GET']`), a transaction `['MULTI', …, 'EXEC']`. */
  redisRoundTrips(): string[][] {
    return SERVER.trips.map(t => [...t]);
  }

  dbAfter(pattern: string, fn: () => unknown): void {
    DB.after(pattern, fn);
  }

  proto(file: string): Record<string, unknown> {
    return grpc.loadPackageDefinition(grpc.loadSync(file));
  }

  client(app: FastifyInstance): HttpClient {
    return httpClient(app);
  }

  /** Await the learner's work; resolves `undefined` when the sleep budget stops a loop that never ends. */
  async drain<T>(promise: Promise<T>): Promise<T | undefined> {
    return Promise.race([promise, this.interrupted.then(() => undefined)]);
  }
}

/** `Error: not implemented — redirect.ts:12 in resolve`: the error and where in the learner's code it was raised. */
const explain = (error: unknown, modules: ModuleSystem): string => {
  const head =
    error instanceof Error ? (error.message === '' ? error.name : `${error.name}: ${error.message}`) : String(error);
  const frames = modules.frames(error);
  const learner = frames.filter(f => f.file.startsWith(WORK));
  const harness = frames.filter(f => f.file === HARNESS);
  if (learner.length > 0) {
    const f = learner[0];
    const fn = f.fn?.replace(/^(?:async\s+)?(?:Object|exports|module\.exports)\./, '') ?? null;
    return `${head} — ${f.file.slice(WORK.length + 1)}:${f.line}${fn === null || fn === '' ? '' : ` in ${fn}`}`;
  }
  if (harness.length > 0) return `${head} — raised by the check at line ${harness[0].line}`;
  return head;
};

/** The JavaScript resources every runtime shares, emptied before each check: the clock at zero with its sleep budget. */
export const resetResources = (): void => {
  CLOCK.reset(SLEEP_LIMIT);
  SERVER.reset();
  BROKER.reset();
  grpc.REGISTRY.reset();
  DB.clear();
  PROCESS.reset();
};

const resetWorld = (modules: ModuleSystem): void => {
  resetResources();
  modules.purge();
};

/** What the learner's code did in the check so far, read off the resources (they are reset per check). */
export const snapshotMetrics = (): RunMetrics => {
  const events = BROKER.events;
  const count = (kind: string): number => events.reduce((n, e) => (e[0] === kind ? n + 1 : n), 0);
  return {
    redisTrips: SERVER.trips.length,
    redisCommands: SERVER.trips.reduce((n, t) => n + t.filter(c => c !== 'MULTI' && c !== 'EXEC').length, 0),
    kafkaProduced: count('produce'),
    kafkaDelivered: count('deliver'),
    kafkaCommits: count('commit'),
    grpcCalls: grpc.REGISTRY.calls.reduce((n, c) => (c.fromHarness ? n : n + 1), 0),
    sqlStatements: DB.learnerStatements,
    sleeps: CLOCK.sleeps,
    sleptMs: Math.round(CLOCK.slept),
  };
};

type Check = (ctx: Ctx) => unknown;

interface Console {
  log: typeof console.log;
  info: typeof console.info;
  warn: typeof console.warn;
  error: typeof console.error;
  debug: typeof console.debug;
}

let currentOutput: {stdout: string[]; stderr: string[]} | null = null;

/**
 * A promise the learner's code left un-awaited and that rejected (a fire-and-forget send on a dead
 * broker): production would log it; the host must not die of it. Hosts route their unhandled
 * rejections here.
 */
export function reportUnhandledRejection(reason: unknown): void {
  const text = reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason);
  currentOutput?.stderr.push(`unhandled rejection: ${text}`);
}

/** Run `checkIds` of the harness against the prepared module tree; the learner's console output is collected. */
export async function runChecks(
  modules: ModuleSystem,
  checkIds: string[],
  output: {stdout: string[]; stderr: string[]},
): Promise<CheckResult[]> {
  modules.harnessGlobals = {assert};
  const ctx = new Ctx(modules);
  const results: CheckResult[] = [];
  const realConsole: Console = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
    debug: console.debug,
  };
  const line = (args: unknown[]): string =>
    args.map(a => (typeof a === 'string' ? a : JSON.stringify(a) ?? String(a))).join(' ');
  currentOutput = output;
  for (const id of checkIds) {
    resetWorld(modules);
    ctx._rearm();
    CLOCK.install();
    console.log = console.info = console.debug = (...args: unknown[]) => void output.stdout.push(line(args));
    console.warn = console.error = (...args: unknown[]) => void output.stderr.push(line(args));
    let budget: ReturnType<typeof CLOCK.realTimeout> | null = null;
    try {
      const harness = modules.load(HARNESS);
      const name = `check_${id.replace(/-/g, '_')}`;
      const check = harness[name];
      if (typeof check !== 'function') {
        results.push({id, passed: false, message: `the harness has no ${name}`});
        continue;
      }
      const timeout = new Promise<never>((_, reject) => {
        budget = CLOCK.realTimeout(
          () => reject(new Error(`the check did not finish within ${CHECK_BUDGET_MS / 1000} s`)),
          CHECK_BUDGET_MS,
        );
      });
      await Promise.race([(check as Check)(ctx), timeout]);
      results.push({id, passed: true, metrics: snapshotMetrics()});
    } catch (e) {
      results.push({id, passed: false, message: explain(e, modules), metrics: snapshotMetrics()});
    } finally {
      if (budget !== null) CLOCK.realClearTimeout(budget);
      CLOCK.uninstall();
      Object.assign(console, realConsole);
    }
  }
  resetWorld(modules);
  currentOutput = null;
  return results;
}
