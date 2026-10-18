/**
 * Redis for the TypeScript runtime: one in-memory server (strings, hashes, lists, sets, sorted
 * sets, expiry on the virtual clock, MULTI/EXEC, Lua through the host's VM) behind an ioredis-shaped
 * client — `new Redis(…)`, `redis.set(key, v, 'EX', 60, 'NX')`, `redis.pipeline()…exec()`,
 * `redis.eval(script, numkeys, …)`, `redis.defineCommand`. The learner's clients and the harness
 * share the SERVER, so the harness reads state and lands probes between commands exactly as another
 * worker's request would land.
 */
import {Buffer} from './buffer';
import {CLOCK} from './clock';

export type Reply = string | number | null | Reply[];

export class ReplyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReplyError';
  }
}

type Value =
  | {kind: 'string'; value: string}
  | {kind: 'hash'; value: Map<string, string>}
  | {kind: 'list'; value: string[]}
  | {kind: 'set'; value: Set<string>}
  | {kind: 'zset'; value: Map<string, number>};

export interface Probe {
  key: string;
  fn: () => unknown;
  fired: boolean;
  result: unknown;
  error: unknown;
}

const WRONGTYPE = 'WRONGTYPE Operation against a key holding the wrong kind of value';
const NOT_INT = 'ERR value is not an integer or out of range';
const NOT_FLOAT = 'ERR value is not a valid float';

const str = (v: unknown): string => (v instanceof Uint8Array ? bytesToByteString(v) : String(v));

const isAscii = (s: string): boolean => {
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) > 0x7f) return false;
  return true;
};
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const bytesToByteString = (bytes: Uint8Array): string => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return s;
};

export const byteStringToBytes = (s: string): Uint8Array => {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
};

/**
 * The server stores byte strings (one char per byte), as Redis stores bytes: text arrives UTF-8
 * encoded, Buffers verbatim. `fromByteString` is what a client decoding a reply as UTF-8 sees.
 */
export const toByteString = (v: string | number | boolean | Uint8Array): string => {
  if (v instanceof Uint8Array) return bytesToByteString(v);
  const text = String(v);
  return isAscii(text) ? text : bytesToByteString(encoder.encode(text));
};

export const fromByteString = (s: string): string => (isAscii(s) ? s : decoder.decode(byteStringToBytes(s)));

const int = (v: string): number => {
  if (!/^-?\d+$/.test(v)) throw new ReplyError(NOT_INT);
  return Number(v);
};

const float = (v: string): number => {
  const n = v === '+inf' || v === 'inf' ? Infinity : v === '-inf' ? -Infinity : Number(v);
  if (Number.isNaN(n) || v.trim() === '') throw new ReplyError(NOT_FLOAT);
  return n;
};

/** RESP2 reply / Lua value as the host's Lua bridge exchanges them: `{t:'int'|'str'|'nil'|'arr'|'ok'|'err', v}`. */
export type Tagged =
  | {t: 'int'; v: number}
  | {t: 'str'; v: string}
  | {t: 'nil'}
  | {t: 'arr'; v: Tagged[]}
  | {t: 'ok'; v: string}
  | {t: 'err'; v: string};

/** Lua scripts run on the host (fengari); the server hands them a `redis.call` that runs commands here. */
export type LuaEval = (
  script: string,
  keysJson: string,
  argvJson: string,
  redisCall: (argsJson: string) => string,
) => string;

/** Commands whose string reply is a status line (`+OK`), which Lua sees as `{ok = …}`. */
const STATUS_REPLIES = new Set([
  'set',
  'mset',
  'setex',
  'psetex',
  'flushall',
  'flushdb',
  'ltrim',
  'ping',
  'hmset',
  'rename',
  'select',
]);

const tag = (reply: Reply, status: boolean): Tagged => {
  if (reply === null) return {t: 'nil'};
  if (typeof reply === 'number') return {t: 'int', v: reply};
  if (typeof reply === 'string') return status ? {t: 'ok', v: reply} : {t: 'str', v: reply};
  return {t: 'arr', v: reply.map(r => tag(r, false))};
};

const untag = (value: Tagged): Reply => {
  switch (value.t) {
    case 'nil':
      return null;
    case 'int':
      return value.v;
    case 'str':
    case 'ok':
      return value.v;
    case 'arr':
      return value.v.map(untag);
    case 'err':
      throw new ReplyError(value.v);
  }
};

export type Subscriber = (channel: string, message: string) => void;
export type PatternSubscriber = (pattern: string, channel: string, message: string) => void;

export class RedisServer {
  readonly probes: Probe[] = [];
  /** Every round trip a client made, as upper-case command names: `['GET']`, a pipeline `['GET', 'GET']`, a transaction `['MULTI', 'HSET', 'EXEC']`. */
  readonly trips: string[][] = [];
  lua: LuaEval | null = null;
  private data = new Map<string, Value>();
  private expires = new Map<string, number>();
  private readonly subscribers = new Map<string, Set<Subscriber>>();
  private readonly patternSubscribers = new Map<string, Set<PatternSubscriber>>();

  flushall(): void {
    this.data.clear();
    this.expires.clear();
  }

  reset(): void {
    this.flushall();
    this.probes.length = 0;
    this.trips.length = 0;
    this.subscribers.clear();
    this.patternSubscribers.clear();
  }

  // ---- pub/sub: a connection's subscriptions, delivered asynchronously as replies would arrive ----------

  subscribe(channel: string, fn: Subscriber): () => void {
    const set = this.subscribers.get(channel) ?? new Set();
    set.add(fn);
    this.subscribers.set(channel, set);
    return () => {
      set.delete(fn);
      if (set.size === 0) this.subscribers.delete(channel);
    };
  }

  psubscribe(pattern: string, fn: PatternSubscriber): () => void {
    const set = this.patternSubscribers.get(pattern) ?? new Set();
    set.add(fn);
    this.patternSubscribers.set(pattern, set);
    return () => {
      set.delete(fn);
      if (set.size === 0) this.patternSubscribers.delete(pattern);
    };
  }

  /** PUBLISH: the number of connections the message went to; delivery lands on the next microtask. */
  publish(channel: string, message: string): number {
    let count = 0;
    for (const fn of this.subscribers.get(channel) ?? []) {
      count += 1;
      queueMicrotask(() => fn(channel, message));
    }
    for (const [pattern, fns] of this.patternSubscribers) {
      if (!globToRegExp(pattern).test(channel)) continue;
      for (const fn of fns) {
        count += 1;
        queueMicrotask(() => fn(pattern, channel, message));
      }
    }
    return count;
  }

  /** Channels with at least one subscriber (PUBSUB CHANNELS). */
  channels(pattern = '*'): string[] {
    const re = globToRegExp(pattern);
    return [...this.subscribers.keys()].filter(c => re.test(c)).sort();
  }

  /** Every live key (expired ones dropped), for the harness. */
  keys(pattern = '*'): string[] {
    this.sweep();
    const re = globToRegExp(pattern);
    return [...this.data.keys()].filter(k => re.test(k)).sort();
  }

  // ---- dispatch ----------------------------------------------------------------------------------

  /**
   * Run one command as the server would, probes included: a probe on a key fires right after the
   * first command touching it, before the caller sees the reply. MULTI/EXEC and EVAL run atomically
   * and are observed as one unit. `record: false` keeps the harness's own reads out of `trips`.
   */
  execute(args: string[], record = true): Reply {
    const name = args[0]?.toLowerCase();
    if (record) this.trips.push([name.toUpperCase()]);
    const result = this.run(name, args.slice(1));
    this.fireProbes(args.slice(1));
    return result;
  }

  /** A MULTI/EXEC block: every queued command runs back to back; probes fire once, afterwards. */
  executeTransaction(commands: string[][]): (Reply | ReplyError)[] {
    this.trips.push(['MULTI', ...commands.map(c => c[0].toUpperCase()), 'EXEC']);
    const replies = commands.map(c => {
      try {
        return this.run(c[0].toLowerCase(), c.slice(1));
      } catch (e) {
        return e instanceof ReplyError ? e : new ReplyError(String(e));
      }
    });
    this.fireProbes(commands.flatMap(c => c.slice(1)));
    return replies;
  }

  /** A pipeline: the commands go to the server in one round trip and run back to back, each observed as it runs. */
  executePipeline(commands: string[][]): (Reply | ReplyError)[] {
    this.trips.push(commands.map(c => c[0].toUpperCase()));
    return commands.map(c => {
      try {
        const reply = this.run(c[0].toLowerCase(), c.slice(1));
        this.fireProbes(c.slice(1));
        return reply;
      } catch (e) {
        this.fireProbes(c.slice(1));
        return e instanceof ReplyError ? e : new ReplyError(String(e));
      }
    });
  }

  private fireProbes(args: string[]): void {
    if (this.probes.length === 0) return;
    const touched = new Set(args);
    for (const probe of this.probes) {
      if (probe.fired || !touched.has(probe.key)) continue;
      probe.fired = true;
      try {
        probe.result = probe.fn();
      } catch (e) {
        probe.error = e;
      }
    }
  }

  private run(name: string, a: string[]): Reply {
    this.sweep();
    switch (name) {
      case 'ping':
        return 'PONG';
      case 'publish':
        return this.publish(a[0], a[1]);
      case 'pubsub': {
        const sub = a[0]?.toUpperCase();
        if (sub === 'CHANNELS') return this.channels(a[1] ?? '*');
        if (sub === 'NUMSUB') return a.slice(1).flatMap(c => [c, this.subscribers.get(c)?.size ?? 0]);
        if (sub === 'NUMPAT') return [...this.patternSubscribers.values()].reduce((n, s) => n + s.size, 0);
        throw new ReplyError(`ERR unknown subcommand '${a[0]}'`);
      }
      case 'echo':
        return a[0];
      case 'flushall':
      case 'flushdb':
        this.flushall();
        return 'OK';
      case 'dbsize':
        return this.data.size;
      case 'keys':
        return this.keys(a[0] ?? '*');
      case 'exists':
        return a.filter(k => this.data.has(k)).length;
      case 'del':
      case 'unlink': {
        let n = 0;
        for (const k of a) if (this.data.delete(k)) (n += 1), this.expires.delete(k);
        return n;
      }
      case 'type': {
        const v = this.data.get(a[0]);
        return v === undefined ? 'none' : v.kind;
      }
      case 'expire':
      case 'pexpire': {
        if (!this.data.has(a[0])) return 0;
        const ms = int(a[1]) * (name === 'expire' ? 1000 : 1);
        const flag = a[2]?.toUpperCase();
        const current = this.expires.get(a[0]);
        const has = current !== undefined;
        if ((flag === 'NX' && has) || (flag === 'XX' && !has)) return 0;
        if (flag === 'GT' && current !== undefined && CLOCK.now() + ms <= current) return 0;
        if (flag === 'LT' && current !== undefined && CLOCK.now() + ms >= current) return 0;
        this.expires.set(a[0], CLOCK.now() + ms);
        return 1;
      }
      case 'persist':
        return this.expires.delete(a[0]) ? 1 : 0;
      case 'ttl':
      case 'pttl': {
        if (!this.data.has(a[0])) return -2;
        const at = this.expires.get(a[0]);
        if (at === undefined) return -1;
        const left = at - CLOCK.now();
        return name === 'ttl' ? Math.ceil(left / 1000) : Math.ceil(left);
      }
      // ---- strings -------------------------------------------------------------------------------
      case 'get':
        return this.string(a[0]);
      case 'mget':
        return a.map(k => this.string(k));
      case 'getdel': {
        const v = this.string(a[0]);
        this.data.delete(a[0]);
        this.expires.delete(a[0]);
        return v;
      }
      case 'set': {
        const [key, value, ...opts] = a;
        let ttl: number | null = null;
        let nx = false;
        let xx = false;
        let get = false;
        let keepTtl = false;
        for (let i = 0; i < opts.length; i++) {
          const o = opts[i].toUpperCase();
          if (o === 'EX') ttl = int(opts[++i]) * 1000;
          else if (o === 'PX') ttl = int(opts[++i]);
          else if (o === 'EXAT') ttl = int(opts[++i]) * 1000 - CLOCK.now();
          else if (o === 'PXAT') ttl = int(opts[++i]) - CLOCK.now();
          else if (o === 'NX') nx = true;
          else if (o === 'XX') xx = true;
          else if (o === 'GET') get = true;
          else if (o === 'KEEPTTL') keepTtl = true;
          else throw new ReplyError('ERR syntax error');
        }
        if (ttl !== null && ttl <= 0) throw new ReplyError('ERR invalid expire time in set');
        const exists = this.data.has(key);
        const previous = get ? this.string(key) : null;
        if ((nx && exists) || (xx && !exists)) return get ? previous : null;
        this.data.set(key, {kind: 'string', value});
        if (ttl !== null) this.expires.set(key, CLOCK.now() + ttl);
        else if (!keepTtl) this.expires.delete(key);
        return get ? previous : 'OK';
      }
      case 'setex':
        return this.run('set', [a[0], a[2], 'EX', a[1]]);
      case 'psetex':
        return this.run('set', [a[0], a[2], 'PX', a[1]]);
      case 'setnx':
        return this.run('set', [a[0], a[1], 'NX']) === null ? 0 : 1;
      case 'mset': {
        for (let i = 0; i + 1 < a.length; i += 2) this.run('set', [a[i], a[i + 1]]);
        return 'OK';
      }
      case 'getset': {
        const prev = this.string(a[0]);
        this.run('set', [a[0], a[1]]);
        return prev;
      }
      case 'incr':
        return this.incr(a[0], 1);
      case 'decr':
        return this.incr(a[0], -1);
      case 'incrby':
        return this.incr(a[0], int(a[1]));
      case 'decrby':
        return this.incr(a[0], -int(a[1]));
      case 'incrbyfloat': {
        const current = this.string(a[0]);
        const next = (current === null ? 0 : float(current)) + float(a[1]);
        this.data.set(a[0], {kind: 'string', value: String(next)});
        return String(next);
      }
      case 'append': {
        const current = this.string(a[0]) ?? '';
        this.data.set(a[0], {kind: 'string', value: current + a[1]});
        return current.length + a[1].length;
      }
      case 'strlen':
        return (this.string(a[0]) ?? '').length;
      case 'getrange': {
        const s = this.string(a[0]) ?? '';
        const [start, end] = [int(a[1]), int(a[2])].map(i => (i < 0 ? s.length + i : i));
        return s.slice(start, end + 1);
      }
      case 'setrange': {
        const s = this.string(a[0]) ?? '';
        const offset = int(a[1]);
        const padded = s.length < offset ? s + '\0'.repeat(offset - s.length) : s;
        const next = padded.slice(0, offset) + a[2] + padded.slice(offset + a[2].length);
        this.data.set(a[0], {kind: 'string', value: next});
        return next.length;
      }
      // ---- hashes --------------------------------------------------------------------------------
      case 'hset': {
        const h = this.hash(a[0], true);
        let added = 0;
        for (let i = 1; i + 1 < a.length; i += 2) {
          if (!h.has(a[i])) added += 1;
          h.set(a[i], a[i + 1]);
        }
        return added;
      }
      case 'hmset':
        this.run('hset', a);
        return 'OK';
      case 'hsetnx': {
        const h = this.hash(a[0], true);
        if (h.has(a[1])) return 0;
        h.set(a[1], a[2]);
        return 1;
      }
      case 'hget':
        return this.hash(a[0], false)?.get(a[1]) ?? null;
      case 'hmget': {
        const h = this.hash(a[0], false);
        return a.slice(1).map(f => h?.get(f) ?? null);
      }
      case 'hgetall': {
        const h = this.hash(a[0], false);
        return h === null ? [] : [...h.entries()].flat();
      }
      case 'hvals':
        return [...(this.hash(a[0], false)?.values() ?? [])];
      case 'hkeys':
        return [...(this.hash(a[0], false)?.keys() ?? [])];
      case 'hlen':
        return this.hash(a[0], false)?.size ?? 0;
      case 'hexists':
        return this.hash(a[0], false)?.has(a[1]) ? 1 : 0;
      case 'hdel': {
        const h = this.hash(a[0], false);
        if (h === null) return 0;
        let n = 0;
        for (const f of a.slice(1)) if (h.delete(f)) n += 1;
        if (h.size === 0) this.data.delete(a[0]);
        return n;
      }
      case 'hincrby': {
        const h = this.hash(a[0], true);
        const next = int(h.get(a[1]) ?? '0') + int(a[2]);
        h.set(a[1], String(next));
        return next;
      }
      case 'hincrbyfloat': {
        const h = this.hash(a[0], true);
        const next = float(h.get(a[1]) ?? '0') + float(a[2]);
        h.set(a[1], String(next));
        return String(next);
      }
      // ---- lists ---------------------------------------------------------------------------------
      case 'lpush':
      case 'rpush': {
        const l = this.list(a[0], true);
        for (const v of a.slice(1)) name === 'lpush' ? l.unshift(v) : l.push(v);
        return l.length;
      }
      case 'lpop':
      case 'rpop': {
        const l = this.list(a[0], false);
        if (l === null || l.length === 0) return null;
        const count = a[1] === undefined ? null : int(a[1]);
        const take = (): string => (name === 'lpop' ? l.shift() : l.pop()) ?? '';
        const out = count === null ? take() : Array.from({length: Math.min(count, l.length)}, take);
        if (l.length === 0) this.data.delete(a[0]);
        return out;
      }
      case 'llen':
        return this.list(a[0], false)?.length ?? 0;
      case 'lrange': {
        const l = this.list(a[0], false) ?? [];
        const [start, end] = this.range(l.length, a[1], a[2]);
        return l.slice(start, end + 1);
      }
      case 'ltrim': {
        const l = this.list(a[0], false);
        if (l === null) return 'OK';
        const [start, end] = this.range(l.length, a[1], a[2]);
        const kept = l.slice(start, end + 1);
        if (kept.length === 0) this.data.delete(a[0]);
        else this.data.set(a[0], {kind: 'list', value: kept});
        return 'OK';
      }
      case 'lindex': {
        const l = this.list(a[0], false) ?? [];
        const i = int(a[1]);
        return l[i < 0 ? l.length + i : i] ?? null;
      }
      case 'lrem': {
        const l = this.list(a[0], false);
        if (l === null) return 0;
        const count = int(a[1]);
        let removed = 0;
        const limit = count === 0 ? Infinity : Math.abs(count);
        const order = count < 0 ? [...l].reverse() : [...l];
        const kept: string[] = [];
        for (const v of order) {
          if (v === a[2] && removed < limit) removed += 1;
          else kept.push(v);
        }
        const next = count < 0 ? kept.reverse() : kept;
        if (next.length === 0) this.data.delete(a[0]);
        else this.data.set(a[0], {kind: 'list', value: next});
        return removed;
      }
      // ---- sets ----------------------------------------------------------------------------------
      case 'sadd': {
        const s = this.set(a[0], true);
        let n = 0;
        for (const v of a.slice(1)) if (!s.has(v)) s.add(v), (n += 1);
        return n;
      }
      case 'srem': {
        const s = this.set(a[0], false);
        if (s === null) return 0;
        let n = 0;
        for (const v of a.slice(1)) if (s.delete(v)) n += 1;
        if (s.size === 0) this.data.delete(a[0]);
        return n;
      }
      case 'smembers':
        return [...(this.set(a[0], false) ?? [])].sort();
      case 'sismember':
        return this.set(a[0], false)?.has(a[1]) ? 1 : 0;
      case 'scard':
        return this.set(a[0], false)?.size ?? 0;
      // ---- sorted sets ---------------------------------------------------------------------------
      case 'zadd': {
        const z = this.zset(a[0], true);
        let i = 1;
        let nx = false;
        let xx = false;
        let ch = false;
        let incr = false;
        for (; i < a.length; i++) {
          const o = a[i].toUpperCase();
          if (o === 'NX') nx = true;
          else if (o === 'XX') xx = true;
          else if (o === 'CH') ch = true;
          else if (o === 'INCR') incr = true;
          else if (o === 'GT' || o === 'LT') continue;
          else break;
        }
        let added = 0;
        let changed = 0;
        for (; i + 1 < a.length; i += 2) {
          const score = float(a[i]);
          const member = a[i + 1];
          const has = z.has(member);
          if ((nx && has) || (xx && !has)) continue;
          if (incr) {
            const next = (z.get(member) ?? 0) + score;
            z.set(member, next);
            return String(next);
          }
          if (!has) added += 1;
          else if (z.get(member) !== score) changed += 1;
          z.set(member, score);
        }
        return ch ? added + changed : added;
      }
      case 'zincrby': {
        const z = this.zset(a[0], true);
        const next = (z.get(a[2]) ?? 0) + float(a[1]);
        z.set(a[2], next);
        return String(next);
      }
      case 'zscore': {
        const s = this.zset(a[0], false)?.get(a[1]);
        return s === undefined ? null : String(s);
      }
      case 'zcard':
        return this.zset(a[0], false)?.size ?? 0;
      case 'zrem': {
        const z = this.zset(a[0], false);
        if (z === null) return 0;
        let n = 0;
        for (const m of a.slice(1)) if (z.delete(m)) n += 1;
        if (z.size === 0) this.data.delete(a[0]);
        return n;
      }
      case 'zrank':
      case 'zrevrank': {
        const sorted = this.sortedMembers(a[0], name === 'zrevrank');
        const i = sorted.findIndex(([m]) => m === a[1]);
        return i === -1 ? null : i;
      }
      case 'zrange':
      case 'zrevrange': {
        const withScores = a[3]?.toUpperCase() === 'WITHSCORES';
        const sorted = this.sortedMembers(a[0], name === 'zrevrange');
        const [start, end] = this.range(sorted.length, a[1], a[2]);
        return sorted.slice(start, end + 1).flatMap(([m, s]) => (withScores ? [m, String(s)] : [m]));
      }
      case 'zrangebyscore':
      case 'zrevrangebyscore': {
        const rev = name === 'zrevrangebyscore';
        const [lo, hi] = rev ? [a[2], a[1]] : [a[1], a[2]];
        const within = this.sortedMembers(a[0], rev).filter(([, s]) => scoreIn(s, lo, hi));
        let out = within;
        let withScores = false;
        for (let i = 3; i < a.length; i++) {
          const o = a[i].toUpperCase();
          if (o === 'WITHSCORES') withScores = true;
          else if (o === 'LIMIT') {
            const offset = int(a[i + 1]);
            const count = int(a[i + 2]);
            out = out.slice(offset, count < 0 ? undefined : offset + count);
            i += 2;
          }
        }
        return out.flatMap(([m, s]) => (withScores ? [m, String(s)] : [m]));
      }
      case 'zcount':
        return this.sortedMembers(a[0], false).filter(([, s]) => scoreIn(s, a[1], a[2])).length;
      case 'zremrangebyscore': {
        const z = this.zset(a[0], false);
        if (z === null) return 0;
        let n = 0;
        for (const [m, s] of [...z.entries()]) if (scoreIn(s, a[1], a[2])) z.delete(m), (n += 1);
        if (z.size === 0) this.data.delete(a[0]);
        return n;
      }
      case 'zremrangebyrank': {
        const sorted = this.sortedMembers(a[0], false);
        const z = this.zset(a[0], false);
        if (z === null) return 0;
        const [start, end] = this.range(sorted.length, a[1], a[2]);
        const victims = sorted.slice(start, end + 1);
        for (const [m] of victims) z.delete(m);
        if (z.size === 0) this.data.delete(a[0]);
        return victims.length;
      }
      // ---- scripting -----------------------------------------------------------------------------
      case 'eval':
      case 'evalsha': {
        if (this.lua === null) throw new ReplyError('ERR Lua scripting is not available in this runtime');
        const numkeys = int(a[1]);
        const keys = a.slice(2, 2 + numkeys);
        const argv = a.slice(2 + numkeys);
        const statusCommand = (cmd: string): boolean => STATUS_REPLIES.has(cmd);
        let out: string;
        try {
          out = this.lua(a[0], JSON.stringify(keys), JSON.stringify(argv), argsJson => {
            const args = (JSON.parse(argsJson) as (string | number)[]).map(String);
            const cmd = args[0].toLowerCase();
            try {
              return JSON.stringify(tag(this.run(cmd, args.slice(1)), statusCommand(cmd)));
            } catch (e) {
              return JSON.stringify({t: 'err', v: e instanceof Error ? e.message : String(e)});
            }
          });
        } catch (e) {
          throw new ReplyError(e instanceof Error ? e.message : String(e));
        }
        return untag(JSON.parse(out) as Tagged);
      }
      default:
        if (GEO_COMMANDS.has(name)) return this.geo(name, a);
        throw new ReplyError(`ERR unknown command '${name}'`);
    }
  }

  // ---- storage helpers ------------------------------------------------------------------------------

  private sweep(): void {
    const now = CLOCK.now();
    for (const [k, at] of this.expires) {
      if (at <= now) {
        this.expires.delete(k);
        this.data.delete(k);
      }
    }
  }

  private string(key: string): string | null {
    const v = this.data.get(key);
    if (v === undefined) return null;
    if (v.kind !== 'string') throw new ReplyError(WRONGTYPE);
    return v.value;
  }

  private incr(key: string, by: number): number {
    const current = this.string(key);
    const next = (current === null ? 0 : int(current)) + by;
    this.data.set(key, {kind: 'string', value: String(next)});
    return next;
  }

  private hash(key: string, create: true): Map<string, string>;
  private hash(key: string, create: false): Map<string, string> | null;
  private hash(key: string, create: boolean): Map<string, string> | null {
    const v = this.data.get(key);
    if (v === undefined) {
      if (!create) return null;
      const h = new Map<string, string>();
      this.data.set(key, {kind: 'hash', value: h});
      return h;
    }
    if (v.kind !== 'hash') throw new ReplyError(WRONGTYPE);
    return v.value;
  }

  private list(key: string, create: true): string[];
  private list(key: string, create: false): string[] | null;
  private list(key: string, create: boolean): string[] | null {
    const v = this.data.get(key);
    if (v === undefined) {
      if (!create) return null;
      const l: string[] = [];
      this.data.set(key, {kind: 'list', value: l});
      return l;
    }
    if (v.kind !== 'list') throw new ReplyError(WRONGTYPE);
    return v.value;
  }

  private set(key: string, create: true): Set<string>;
  private set(key: string, create: false): Set<string> | null;
  private set(key: string, create: boolean): Set<string> | null {
    const v = this.data.get(key);
    if (v === undefined) {
      if (!create) return null;
      const s = new Set<string>();
      this.data.set(key, {kind: 'set', value: s});
      return s;
    }
    if (v.kind !== 'set') throw new ReplyError(WRONGTYPE);
    return v.value;
  }

  private zset(key: string, create: true): Map<string, number>;
  private zset(key: string, create: false): Map<string, number> | null;
  private zset(key: string, create: boolean): Map<string, number> | null {
    const v = this.data.get(key);
    if (v === undefined) {
      if (!create) return null;
      const z = new Map<string, number>();
      this.data.set(key, {kind: 'zset', value: z});
      return z;
    }
    if (v.kind !== 'zset') throw new ReplyError(WRONGTYPE);
    return v.value;
  }

  private sortedMembers(key: string, reverse: boolean): [string, number][] {
    const z = this.zset(key, false);
    if (z === null) return [];
    const sorted = [...z.entries()].sort((x, y) => x[1] - y[1] || (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));
    return reverse ? sorted.reverse() : sorted;
  }

  private range(length: number, startArg: string, endArg: string): [number, number] {
    let start = int(startArg);
    let end = int(endArg);
    if (start < 0) start = Math.max(0, length + start);
    if (end < 0) end = length + end;
    end = Math.min(end, length - 1);
    return [start, end];
  }

  // ---- geo: members in a sorted set scored by their 52-bit geohash, as Redis stores them ----------------

  private geo(name: string, a: string[]): Reply {
    switch (name) {
      case 'geoadd': {
        const z = this.zset(a[0], true);
        let i = 1;
        let nx = false;
        let xx = false;
        for (; i < a.length; i++) {
          const o = a[i].toUpperCase();
          if (o === 'NX') nx = true;
          else if (o === 'XX') xx = true;
          else if (o === 'CH') continue;
          else break;
        }
        let added = 0;
        for (; i + 2 < a.length; i += 3) {
          const lon = float(a[i]);
          const lat = float(a[i + 1]);
          if (lon < -180 || lon > 180 || lat < -85.05112878 || lat > 85.05112878)
            throw new ReplyError(`ERR invalid longitude,latitude pair ${a[i]},${a[i + 1]}`);
          const member = a[i + 2];
          const has = z.has(member);
          if ((nx && has) || (xx && !has)) continue;
          if (!has) added += 1;
          z.set(member, geohashEncode(lon, lat));
        }
        return added;
      }
      case 'geopos': {
        const z = this.zset(a[0], false);
        return a.slice(1).map(m => {
          const score = z?.get(m);
          if (score === undefined) return null;
          const [lon, lat] = geohashDecode(score);
          return [String(lon), String(lat)];
        });
      }
      case 'geodist': {
        const z = this.zset(a[0], false);
        const s1 = z?.get(a[1]);
        const s2 = z?.get(a[2]);
        if (s1 === undefined || s2 === undefined) return null;
        const unit = unitMeters(a[3] ?? 'm');
        return (haversine(geohashDecode(s1), geohashDecode(s2)) / unit).toFixed(4);
      }
      case 'geosearch':
      case 'georadius':
      case 'georadiusbymember': {
        const z = this.zset(a[0], false) ?? new Map<string, number>();
        let center: [number, number] | null = null;
        let radius: number | null = null;
        let box: [number, number] | null = null;
        let i = 1;
        if (name === 'georadius') {
          center = [float(a[1]), float(a[2])];
          radius = float(a[3]) * unitMeters(a[4]);
          i = 5;
        } else if (name === 'georadiusbymember') {
          const s = z.get(a[1]);
          if (s === undefined) throw new ReplyError('ERR could not decode requested zset member');
          center = geohashDecode(s);
          radius = float(a[2]) * unitMeters(a[3]);
          i = 4;
        }
        let order: 'ASC' | 'DESC' | null = null;
        let count: number | null = null;
        let withCoord = false;
        let withDist = false;
        let withHash = false;
        for (; i < a.length; i++) {
          const o = a[i].toUpperCase();
          if (o === 'FROMLONLAT') center = [float(a[++i]), float(a[++i])];
          else if (o === 'FROMMEMBER') {
            const s = z.get(a[++i]);
            if (s === undefined) throw new ReplyError('ERR could not decode requested zset member');
            center = geohashDecode(s);
          } else if (o === 'BYRADIUS') radius = float(a[++i]) * unitMeters(a[++i]);
          else if (o === 'BYBOX') {
            const w = float(a[++i]);
            const h = float(a[++i]);
            const unit = unitMeters(a[++i]);
            box = [w * unit, h * unit];
          } else if (o === 'ASC' || o === 'DESC') order = o;
          else if (o === 'COUNT') {
            count = int(a[++i]);
            if (a[i + 1]?.toUpperCase() === 'ANY') i += 1;
          } else if (o === 'WITHCOORD') withCoord = true;
          else if (o === 'WITHDIST') withDist = true;
          else if (o === 'WITHHASH') withHash = true;
          else if (o === 'STORE' || o === 'STOREDIST')
            throw new ReplyError('ERR STORE is not supported in this runtime');
          else throw new ReplyError('ERR syntax error');
        }
        if (center === null || (radius === null && box === null))
          throw new ReplyError(
            'ERR exactly one of FROMMEMBER or FROMLONLAT, and one of BYRADIUS or BYBOX, is required',
          );
        const from = center;
        let hits = [...z.entries()]
          .map(([member, score]) => {
            const at = geohashDecode(score);
            return {member, score, at, dist: haversine(from, at)};
          })
          .filter(h => {
            if (radius !== null) return h.dist <= radius;
            const [w, hgt] = box ?? [0, 0];
            const dx = haversine([from[0], h.at[1]], h.at);
            const dy = haversine([h.at[0], from[1]], h.at);
            return dx <= w / 2 && dy <= hgt / 2;
          });
        if (order !== null) hits.sort((x, y) => (order === 'ASC' ? x.dist - y.dist : y.dist - x.dist));
        if (count !== null) hits = hits.slice(0, count);
        const unit =
          radius !== null && name !== 'geosearch'
            ? unitMeters(name === 'georadius' ? a[4] : a[3])
            : unitMeters(searchUnit(a));
        return hits.map(h => {
          if (!withCoord && !withDist && !withHash) return h.member;
          const row: Reply[] = [h.member];
          if (withDist) row.push((h.dist / unit).toFixed(4));
          if (withHash) row.push(h.score);
          if (withCoord) row.push([String(h.at[0]), String(h.at[1])]);
          return row;
        });
      }
      default:
        throw new ReplyError(`ERR unknown command '${name}'`);
    }
  }
}

const GEO_COMMANDS = new Set(['geoadd', 'geopos', 'geodist', 'geosearch', 'georadius', 'georadiusbymember']);

/** The unit given after BYRADIUS/BYBOX in a GEOSEARCH, for WITHDIST. */
const searchUnit = (a: string[]): string => {
  const i = a.findIndex(t => t.toUpperCase() === 'BYRADIUS');
  if (i !== -1) return a[i + 2] ?? 'm';
  const j = a.findIndex(t => t.toUpperCase() === 'BYBOX');
  return j !== -1 ? a[j + 3] ?? 'm' : 'm';
};

const unitMeters = (unit: string): number => {
  switch (unit.toLowerCase()) {
    case 'm':
      return 1;
    case 'km':
      return 1000;
    case 'mi':
      return 1609.34;
    case 'ft':
      return 0.3048;
    default:
      throw new ReplyError('ERR unsupported unit provided. please use M, KM, FT, MI');
  }
};

const EARTH_RADIUS_M = 6372797.560856;

const haversine = ([lon1, lat1]: [number, number], [lon2, lat2]: [number, number]): number => {
  const toRad = (d: number): number => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
};

const LAT_RANGE = 85.05112878;

/** Redis' 52-bit geohash: 26 bits of longitude and latitude each, interleaved (longitude in the even bits). */
const geohashEncode = (lon: number, lat: number): number => {
  const lonBits = Math.min(2 ** 26 - 1, Math.floor(((lon + 180) / 360) * 2 ** 26));
  const latBits = Math.min(2 ** 26 - 1, Math.floor(((lat + LAT_RANGE) / (2 * LAT_RANGE)) * 2 ** 26));
  let hash = 0;
  for (let i = 25; i >= 0; i--) hash = hash * 4 + ((lonBits >> i) & 1) * 2 + ((latBits >> i) & 1);
  return hash;
};

const geohashDecode = (hash: number): [number, number] => {
  let lonBits = 0;
  let latBits = 0;
  let h = hash;
  for (let i = 0; i < 26; i++) {
    const pair = h % 4;
    h = Math.floor(h / 4);
    lonBits += ((pair >> 1) & 1) * 2 ** i;
    latBits += (pair & 1) * 2 ** i;
  }
  const lon = ((lonBits + 0.5) / 2 ** 26) * 360 - 180;
  const lat = ((latBits + 0.5) / 2 ** 26) * (2 * LAT_RANGE) - LAT_RANGE;
  return [Number(lon.toFixed(6)), Number(lat.toFixed(6))];
};

const scoreIn = (score: number, lo: string, hi: string): boolean => {
  const bound = (b: string, isLow: boolean): boolean => {
    if (b === '-inf') return true;
    if (b === '+inf' || b === 'inf') return true;
    const exclusive = b.startsWith('(');
    const n = float(exclusive ? b.slice(1) : b);
    return isLow ? (exclusive ? score > n : score >= n) : exclusive ? score < n : score <= n;
  };
  if (lo === '+inf' || hi === '-inf') return false;
  return bound(lo, true) && bound(hi, false);
};

const globToRegExp = (glob: string): RegExp =>
  new RegExp(
    `^${glob
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.')}$`,
  );

export const SERVER = new RedisServer();

// ---- the ioredis surface -------------------------------------------------------------------------

type Arg =
  | string
  | number
  | Uint8Array
  | boolean
  | null
  | undefined
  | Arg[]
  | {[field: string]: string | number | boolean | null | undefined};

/** ioredis flattens arguments: arrays inline, plain objects become field/value pairs (`hset('h', {a: 1})`); text and Buffers become byte strings. */
const flatten = (args: Arg[]): string[] => {
  const out: string[] = [];
  for (const arg of args) {
    if (arg === undefined || arg === null) continue;
    if (Array.isArray(arg)) out.push(...flatten(arg));
    else if (typeof arg === 'object' && !(arg instanceof Uint8Array))
      for (const [k, v] of Object.entries(arg)) out.push(toByteString(k), toByteString(str(v)));
    else out.push(toByteString(arg));
  }
  return out;
};

/**
 * ioredis's client: every command is a method returning a Promise of the reply, with the same
 * reply shapes (`set` → 'OK' | null, `get` → string | null, `hgetall` → object, `exec` → [err, reply]
 * tuples). Connection options are accepted and ignored — the server is in this process.
 */
export class Redis {
  readonly options: Record<string, unknown>;
  private readonly scripts = new Map<string, {numberOfKeys: number; lua: string}>();
  private readonly subscriptions = new Map<string, () => void>();
  private readonly listeners = new Map<string, ((...args: string[]) => void)[]>();

  constructor(
    portOrOptions?: number | string | Record<string, unknown>,
    host?: string,
    options?: Record<string, unknown>,
  ) {
    this.options =
      typeof portOrOptions === 'object' && portOrOptions !== null
        ? portOrOptions
        : {port: portOrOptions, host, ...options};
    return new Proxy(this, {
      get: (target, prop, receiver) => {
        if (typeof prop === 'string' && !(prop in target)) {
          const custom = target.scripts.get(prop);
          if (custom !== undefined)
            return (...args: Arg[]) => target.call('eval', custom.lua, custom.numberOfKeys, ...args);
          if (KNOWN_COMMANDS.has(wireCommand(prop))) return (...args: Arg[]) => target.call(prop, ...args);
        }
        return Reflect.get(target, prop, receiver);
      },
    });
  }

  /** `redis.call('set', key, value, 'EX', 60)`: any command by name. */
  call(command: string, ...args: Arg[]): Promise<unknown> {
    return new Promise((resolve, reject) => {
      try {
        resolve(shapeReply(command, SERVER.execute([wireCommand(command), ...flatten(args)])));
      } catch (e) {
        reject(e);
      }
    });
  }

  /** ioredis's `defineCommand`: a Lua script callable as `redis.<name>(key…, arg…)`. */
  defineCommand(name: string, definition: {numberOfKeys: number; lua: string}): void {
    this.scripts.set(name, definition);
  }

  pipeline(): Pipeline {
    return new Pipeline(false);
  }

  multi(): Pipeline {
    return new Pipeline(true);
  }

  duplicate(): Redis {
    return new Redis(this.options);
  }

  async quit(): Promise<'OK'> {
    this.disconnect();
    return 'OK';
  }

  disconnect(): void {
    // nothing to close: the server is in this process — but a subscriber's subscriptions end here.
    for (const stop of this.subscriptions.values()) stop();
    this.subscriptions.clear();
  }

  // ---- subscriber mode -------------------------------------------------------------------------------

  /** `await sub.subscribe('ticks:ACME')` → number of channels this connection is subscribed to; messages arrive on `'message'`. */
  async subscribe(...channels: string[]): Promise<number> {
    for (const channel of channels.flat()) {
      if (this.subscriptions.has(`c:${channel}`)) continue;
      this.subscriptions.set(
        `c:${channel}`,
        SERVER.subscribe(toByteString(channel), (ch, message) =>
          this.emit('message', fromByteString(ch), fromByteString(message)),
        ),
      );
    }
    return this.subscriptions.size;
  }

  async unsubscribe(...channels: string[]): Promise<number> {
    const keys =
      channels.length === 0
        ? [...this.subscriptions.keys()].filter(k => k.startsWith('c:'))
        : channels.map(c => `c:${c}`);
    for (const key of keys) {
      this.subscriptions.get(key)?.();
      this.subscriptions.delete(key);
    }
    return this.subscriptions.size;
  }

  /** Pattern subscriptions deliver on `'pmessage'` as `(pattern, channel, message)`. */
  async psubscribe(...patterns: string[]): Promise<number> {
    for (const pattern of patterns.flat()) {
      if (this.subscriptions.has(`p:${pattern}`)) continue;
      this.subscriptions.set(
        `p:${pattern}`,
        SERVER.psubscribe(toByteString(pattern), (p, ch, message) =>
          this.emit('pmessage', fromByteString(p), fromByteString(ch), fromByteString(message)),
        ),
      );
    }
    return this.subscriptions.size;
  }

  async punsubscribe(...patterns: string[]): Promise<number> {
    const keys =
      patterns.length === 0
        ? [...this.subscriptions.keys()].filter(k => k.startsWith('p:'))
        : patterns.map(p => `p:${p}`);
    for (const key of keys) {
      this.subscriptions.get(key)?.();
      this.subscriptions.delete(key);
    }
    return this.subscriptions.size;
  }

  on(event: string, listener: (...args: string[]) => void): this {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    return this;
  }

  once(event: string, listener: (...args: string[]) => void): this {
    const wrapped = (...args: string[]): void => {
      this.off(event, wrapped);
      listener(...args);
    };
    return this.on(event, wrapped);
  }

  off(event: string, listener: (...args: string[]) => void): this {
    this.listeners.set(
      event,
      (this.listeners.get(event) ?? []).filter(l => l !== listener),
    );
    return this;
  }

  removeListener(event: string, listener: (...args: string[]) => void): this {
    return this.off(event, listener);
  }

  removeAllListeners(event?: string): this {
    if (event === undefined) this.listeners.clear();
    else this.listeners.delete(event);
    return this;
  }

  private emit(event: string, ...args: string[]): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener(...args);
  }
}

/**
 * The reply as ioredis hands it over: byte strings decoded as UTF-8 text, or as Buffers for the
 * `…Buffer` variants (`getBuffer`, `hgetallBuffer`), `hgetall` as an object, `exec` as `[error, reply]` tuples.
 */
const shapeReply = (method: string, reply: Reply): unknown => {
  const asBuffer = /buffer$/i.test(method) && method.length > 6;
  const decode = (r: Reply): unknown => {
    if (typeof r === 'string') return asBuffer ? Buffer.from(byteStringToBytes(r)) : fromByteString(r);
    if (Array.isArray(r)) return r.map(decode);
    return r;
  };
  if (wireCommand(method) === 'hgetall' && Array.isArray(reply)) {
    const out: Record<string, unknown> = {};
    for (let i = 0; i + 1 < reply.length; i += 2) out[fromByteString(String(reply[i]))] = decode(reply[i + 1]);
    return out;
  }
  return decode(reply);
};

/** `getBuffer` → `get`: ioredis's Buffer-returning variants run the same command. */
const wireCommand = (method: string): string => {
  const lower = method.toLowerCase();
  return lower.length > 6 && lower.endsWith('buffer') ? lower.slice(0, -6) : lower;
};

export class Pipeline {
  private readonly queue: string[][] = [];

  constructor(private readonly transactional: boolean) {
    return new Proxy(this, {
      get: (target, prop, receiver) => {
        if (typeof prop === 'string' && !(prop in target) && KNOWN_COMMANDS.has(wireCommand(prop)))
          return (...args: Arg[]) => {
            target.queue.push([prop, ...flatten(args)]);
            return receiver;
          };
        return Reflect.get(target, prop, receiver);
      },
    });
  }

  get length(): number {
    return this.queue.length;
  }

  /** `[error, reply]` per command, as ioredis does. A MULTI pipeline runs atomically on the server. */
  async exec(): Promise<[Error | null, unknown][]> {
    const commands = this.queue.splice(0);
    const run = (c: string[]): string[] => [wireCommand(c[0]), ...c.slice(1)];
    const shaped = (r: Reply, i: number): unknown => shapeReply(commands[i][0], r);
    if (this.transactional) {
      return SERVER.executeTransaction(commands.map(run)).map((r, i) =>
        r instanceof ReplyError ? [r, null] : [null, shaped(r, i)],
      );
    }
    return SERVER.executePipeline(commands.map(run)).map((r, i) =>
      r instanceof ReplyError ? [r, null] : [null, shaped(r, i)],
    );
  }
}

const KNOWN_COMMANDS = new Set([
  'ping',
  'echo',
  'flushall',
  'flushdb',
  'dbsize',
  'keys',
  'exists',
  'del',
  'unlink',
  'type',
  'expire',
  'pexpire',
  'persist',
  'ttl',
  'pttl',
  'get',
  'mget',
  'getdel',
  'set',
  'setex',
  'psetex',
  'setnx',
  'mset',
  'getset',
  'incr',
  'decr',
  'incrby',
  'decrby',
  'incrbyfloat',
  'append',
  'strlen',
  'getrange',
  'setrange',
  'hset',
  'hsetnx',
  'hget',
  'hmget',
  'hgetall',
  'hvals',
  'hkeys',
  'hlen',
  'hexists',
  'hdel',
  'hincrby',
  'hincrbyfloat',
  'lpush',
  'rpush',
  'lpop',
  'rpop',
  'llen',
  'lrange',
  'ltrim',
  'lindex',
  'lrem',
  'sadd',
  'srem',
  'smembers',
  'sismember',
  'scard',
  'zadd',
  'zincrby',
  'zscore',
  'zcard',
  'zrem',
  'zrank',
  'zrevrank',
  'zrange',
  'zrevrange',
  'zrangebyscore',
  'zrevrangebyscore',
  'zcount',
  'zremrangebyscore',
  'zremrangebyrank',
  'eval',
  'evalsha',
  'geoadd',
  'geopos',
  'geodist',
  'geosearch',
  'georadius',
  'georadiusbymember',
  'hmset',
  'publish',
  'pubsub',
]);

export default Redis;
