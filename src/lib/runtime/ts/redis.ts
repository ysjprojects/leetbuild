/**
 * Redis for the TypeScript runtime: one in-memory server (strings, hashes, lists, sets, sorted
 * sets, streams with consumer groups, expiry on the virtual clock, MULTI/EXEC, Lua through the
 * host's VM, blocking commands that wait on the virtual clock) behind an ioredis-shaped client —
 * `new Redis(…)`, `redis.set(key, v, 'EX', 60, 'NX')`, `redis.pipeline()…exec()`,
 * `redis.eval(script, numkeys, …)`, `redis.defineCommand`. The learner's clients and the harness
 * share the SERVER, so the harness reads state and lands probes between commands exactly as another
 * worker's request would land.
 */
import {Buffer} from './buffer';
import {CLOCK} from './clock';
import {sha1} from './node';

export type Reply = string | number | null | Reply[];

export class ReplyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReplyError';
  }
}

type Value =
  /** `raw`: written in place (APPEND, SETRANGE, SETBIT, HyperLogLog), which leaves Redis's raw encoding. */
  | {kind: 'string'; value: string; raw?: boolean}
  | {kind: 'hash'; value: Map<string, string>}
  | {kind: 'list'; value: string[]}
  | {kind: 'set'; value: Set<string>}
  | {kind: 'zset'; value: Map<string, number>}
  | {kind: 'stream'; value: Stream};

// ---- streams: entries in radix-tree nodes, consumer groups with their pending entries ----------------

/** A stream ID, `<ms>-<seq>`, as one 128-bit number: ms in the high 64 bits, so ID order is number order. */
type StreamId = bigint;

interface StreamEntry {
  readonly id: StreamId;
  readonly fields: string[];
}

/** A radix-tree node's listpack: its live entries, and the slots it has used (deleted entries keep theirs). */
interface StreamNode {
  entries: StreamEntry[];
  slots: number;
}

/** A pending entry: delivered to `consumer` (null only while XCLAIM FORCE creates it), not yet acknowledged. */
interface StreamNack {
  consumer: StreamConsumer | null;
  /** Last delivery, on the virtual clock (ms). */
  time: number;
  count: number;
}

interface StreamConsumer {
  readonly name: string;
  /** Last attempted interaction (XREADGROUP, XCLAIM, XAUTOCLAIM), and last successful one (-1: none yet). */
  seen: number;
  active: number;
  readonly pel: Map<StreamId, StreamNack>;
}

interface StreamGroup {
  lastId: StreamId;
  /** Logical reads counter; -1 when it is not known (Redis's SCG_INVALID_ENTRIES_READ). */
  entriesRead: number;
  readonly pel: Map<StreamId, StreamNack>;
  readonly consumers: Map<string, StreamConsumer>;
}

interface Stream {
  nodes: StreamNode[];
  length: number;
  lastId: StreamId;
  maxDeletedId: StreamId;
  entriesAdded: number;
  readonly groups: Map<string, StreamGroup>;
}

const U64 = (1n << 64n) - 1n;
const MAX_ID: StreamId = (U64 << 64n) | U64;
/** stream-node-max-entries: a node takes this many entries (deleted ones included) before a new one starts. */
const STREAM_NODE_ENTRIES = 100;

const formatId = (id: StreamId): string => `${id >> 64n}-${id & U64}`;

/** Pending entries in ID order, as Redis's radix tree iterates them. */
const byId = (pel: Map<StreamId, StreamNack>): [StreamId, StreamNack][] =>
  [...pel].sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0));

/** Consumers in name order (byte order), as Redis's radix tree iterates them. */
const byName = (consumers: Map<string, StreamConsumer>): StreamConsumer[] =>
  [...consumers.values()].sort((x, y) => (x.name < y.name ? -1 : 1));

const newStream = (): Stream => ({
  nodes: [],
  length: 0,
  lastId: 0n,
  maxDeletedId: 0n,
  entriesAdded: 0,
  groups: new Map(),
});

const streamEntries = (s: Stream): StreamEntry[] => s.nodes.flatMap(n => n.entries);

/** The first live entry's ID, 0-0 when empty: Redis's `first_id`. */
const firstId = (s: Stream): StreamId => s.nodes[0]?.entries[0]?.id ?? 0n;

const findEntry = (s: Stream, id: StreamId): StreamEntry | undefined => {
  for (const node of s.nodes) {
    const last = node.entries[node.entries.length - 1];
    if (last.id >= id) return node.entries.find(e => e.id === id);
  }
  return undefined;
};

const appendEntry = (s: Stream, id: StreamId, fields: string[]): void => {
  let tail = s.nodes[s.nodes.length - 1];
  if (tail === undefined || tail.slots >= STREAM_NODE_ENTRIES) {
    tail = {entries: [], slots: 0};
    s.nodes.push(tail);
  }
  tail.entries.push({id, fields});
  tail.slots += 1;
  s.length += 1;
  s.entriesAdded += 1;
  s.lastId = id;
};

/** XDEL one entry: a node whose last live entry goes is freed, as Redis frees its listpack. */
const deleteEntry = (s: Stream, id: StreamId): boolean => {
  for (let n = 0; n < s.nodes.length; n++) {
    const node = s.nodes[n];
    const i = node.entries.findIndex(e => e.id === id);
    if (i === -1) continue;
    node.entries.splice(i, 1);
    if (node.entries.length === 0) s.nodes.splice(n, 1);
    s.length -= 1;
    return true;
  }
  return false;
};

/** The trimming options of XADD and XTRIM, as streamParseAddOrTrimArgsOrReply reads them. */
interface TrimArgs {
  strategy: 'none' | 'maxlen' | 'minid';
  approx: boolean;
  maxlen: number;
  minid: StreamId;
  /** Most entries one trim deletes; 0 for no limit. */
  limit: number;
  noMkStream: boolean;
  /** XADD's explicit ID, null for `*`. */
  id: {id: StreamId; seqGiven: boolean} | null;
  /** Index of XADD's ID argument. */
  next: number;
}

/**
 * Trim from the oldest entries, as streamTrim does: whole nodes go while they fit; `~` stops at the
 * first node it cannot drop whole, exact trimming goes on inside it. Returns the entries deleted.
 */
const trimStream = (s: Stream, t: TrimArgs): number => {
  if (t.strategy === 'none') return 0;
  let deleted = 0;
  while (s.nodes.length > 0) {
    if (t.strategy === 'maxlen' && s.length <= t.maxlen) break;
    const node = s.nodes[0];
    const entries = node.entries.length;
    if (t.limit && deleted + entries > t.limit) break;
    const whole = t.strategy === 'maxlen' ? s.length - entries >= t.maxlen : node.entries[entries - 1].id < t.minid;
    if (whole) {
      s.nodes.shift();
      s.length -= entries;
      deleted += entries;
      continue;
    }
    if (t.approx) break;
    while (t.strategy === 'maxlen' ? s.length > t.maxlen : node.entries[0].id < t.minid) {
      node.entries.shift();
      s.length -= 1;
      deleted += 1;
    }
    break;
  }
  return deleted;
};

/** Whether a deleted entry may lie in [start, end]: Redis tracks only the greatest deleted ID. */
const rangeHasTombstones = (s: Stream, start: StreamId, end: StreamId = MAX_ID): boolean =>
  s.length > 0 &&
  s.maxDeletedId !== 0n &&
  firstId(s) <= s.maxDeletedId &&
  start <= s.maxDeletedId &&
  s.maxDeletedId <= end;

/** An ID's logical read counter where it can be known (streamEstimateDistanceFromFirstEverEntry), else -1. */
const estimateEntriesRead = (s: Stream, id: StreamId): number => {
  if (s.entriesAdded === 0) return 0;
  if (s.length === 0 && id <= s.lastId) return s.entriesAdded;
  if (id !== 0n && id < s.maxDeletedId) return -1;
  if (id === s.lastId) return s.entriesAdded;
  if (id > s.lastId) return -1;
  const first = firstId(s);
  if (s.maxDeletedId === 0n || s.maxDeletedId < first) {
    if (id < first) return s.entriesAdded - s.length;
    if (id === first) return s.entriesAdded - s.length + 1;
  }
  return -1;
};

/** A group's lag (entries not yet delivered to it), null where fragmentation hides it (streamReplyWithCGLag). */
const groupLag = (s: Stream, g: StreamGroup): number | null => {
  if (s.entriesAdded === 0 || s.length === 0) return 0;
  const first = firstId(s);
  if (g.lastId < first && s.maxDeletedId < first) return s.length;
  if (g.entriesRead !== -1 && !rangeHasTombstones(s, g.lastId)) return s.entriesAdded - g.entriesRead;
  const read = estimateEntriesRead(s, g.lastId);
  return read === -1 ? null : s.entriesAdded - read;
};

const INVALID_ID = 'ERR Invalid stream ID specified as stream command argument';

/** An unsigned 64-bit decimal, as string2ull reads one; null when it is not. */
const u64 = (s: string): bigint | null => (/^\d{1,20}$/.test(s) && BigInt(s) <= U64 ? BigInt(s) : null);

/**
 * A stream ID argument (streamGenericParseIDOrReply): `<ms>-<seq>`; `<ms>` with the sequence
 * `missingSeq`; `-` and `+` for the least and greatest IDs unless `strict`; `<ms>-*` (seqGiven
 * false) where `seqStar`, for XADD.
 */
const parseStreamId = (
  arg: string,
  missingSeq: bigint,
  strict: boolean,
  seqStar = false,
): {id: StreamId; seqGiven: boolean} => {
  if (arg.length > 127) throw new ReplyError(INVALID_ID);
  if (arg === '-' || arg === '+') {
    if (strict) throw new ReplyError(INVALID_ID);
    return {id: arg === '-' ? 0n : MAX_ID, seqGiven: true};
  }
  const dash = arg.indexOf('-');
  const ms = u64(dash === -1 ? arg : arg.slice(0, dash));
  if (ms === null) throw new ReplyError(INVALID_ID);
  if (dash === -1) return {id: (ms << 64n) | missingSeq, seqGiven: true};
  if (seqStar && arg.slice(dash + 1) === '*') return {id: ms << 64n, seqGiven: false};
  const seq = u64(arg.slice(dash + 1));
  if (seq === null) throw new ReplyError(INVALID_ID);
  return {id: (ms << 64n) | seq, seqGiven: true};
};

/** One end of an XRANGE/XPENDING/XAUTOCLAIM interval: `(` makes it exclusive, which moves it one ID inward. */
const parseInterval = (arg: string, end: boolean): StreamId => {
  const exclusive = arg.length > 1 && arg[0] === '(';
  const {id} = parseStreamId(exclusive ? arg.slice(1) : arg, end ? U64 : 0n, exclusive);
  if (!exclusive) return id;
  if (end ? id === 0n : id === MAX_ID) throw new ReplyError(`ERR invalid ${end ? 'end' : 'start'} ID for the interval`);
  return end ? id - 1n : id + 1n;
};

/** An entry as stream commands reply with it: `[id, [field, value, …]]`. */
const entryReply = (e: StreamEntry): Reply => [formatId(e.id), e.fields];

/** XADD/XTRIM options (streamParseAddOrTrimArgsOrReply), from `a[1]` on. */
const parseAddOrTrim = (a: string[], xadd: boolean): TrimArgs => {
  const t: TrimArgs = {
    strategy: 'none',
    approx: false,
    maxlen: 0,
    minid: 0n,
    limit: 0,
    noMkStream: false,
    id: null,
    next: 0,
  };
  let limitGiven = false;
  let i = 1;
  for (; i < a.length; i++) {
    const more = a.length - 1 - i;
    const opt = a[i].toUpperCase();
    if (xadd && a[i] === '*') break;
    if ((opt === 'MAXLEN' || opt === 'MINID') && more) {
      if (t.strategy !== 'none')
        throw new ReplyError('ERR syntax error, MAXLEN and MINID options at the same time are not compatible');
      t.approx = false;
      if (more >= 2 && a[i + 1] === '~') (t.approx = true), (i += 1);
      else if (more >= 2 && a[i + 1] === '=') i += 1;
      if (opt === 'MAXLEN') {
        t.maxlen = int(a[i + 1]);
        if (t.maxlen < 0) throw new ReplyError('ERR The MAXLEN argument must be >= 0.');
        t.strategy = 'maxlen';
      } else {
        t.minid = parseStreamId(a[i + 1], 0n, true).id;
        t.strategy = 'minid';
      }
      i += 1;
    } else if (opt === 'LIMIT' && more) {
      t.limit = int(a[i + 1]);
      if (t.limit < 0) throw new ReplyError('ERR The LIMIT argument must be >= 0.');
      limitGiven = true;
      i += 1;
    } else if (xadd && opt === 'NOMKSTREAM') t.noMkStream = true;
    else if (xadd) {
      t.id = parseStreamId(a[i], 0n, true, true);
      break;
    } else throw new ReplyError('ERR syntax error');
  }
  if (t.limit && t.strategy === 'none')
    throw new ReplyError('ERR syntax error, LIMIT cannot be used without specifying a trimming strategy');
  if (!xadd && t.strategy === 'none')
    throw new ReplyError('ERR syntax error, XTRIM must be called with a trimming strategy');
  if (limitGiven && !t.approx)
    throw new ReplyError('ERR syntax error, LIMIT cannot be used without the special ~ option');
  // `~` without LIMIT trims at most 100 nodes' worth, as Redis does.
  if (!limitGiven) t.limit = t.approx ? 100 * STREAM_NODE_ENTRIES : 0;
  t.next = i;
  return t;
};

const cloneStream = (s: Stream): Stream => {
  const groups = new Map<string, StreamGroup>();
  for (const [name, g] of s.groups) {
    const consumers = new Map<string, StreamConsumer>();
    for (const [cname, c] of g.consumers)
      consumers.set(cname, {name: cname, seen: c.seen, active: c.active, pel: new Map()});
    const pel = new Map<StreamId, StreamNack>();
    for (const [id, nack] of g.pel) {
      const owner = nack.consumer === null ? null : consumers.get(nack.consumer.name) ?? null;
      const copy = {consumer: owner, time: nack.time, count: nack.count};
      pel.set(id, copy);
      owner?.pel.set(id, copy);
    }
    groups.set(name, {lastId: g.lastId, entriesRead: g.entriesRead, pel, consumers});
  }
  return {
    nodes: s.nodes.map(n => ({entries: [...n.entries], slots: n.slots})),
    length: s.length,
    lastId: s.lastId,
    maxDeletedId: s.maxDeletedId,
    entriesAdded: s.entriesAdded,
    groups,
  };
};

const cloneValue = (v: Value): Value => {
  switch (v.kind) {
    case 'string':
      return {...v};
    case 'hash':
      return {kind: 'hash', value: new Map(v.value)};
    case 'list':
      return {kind: 'list', value: [...v.value]};
    case 'set':
      return {kind: 'set', value: new Set(v.value)};
    case 'zset':
      return {kind: 'zset', value: new Map(v.value)};
    case 'stream':
      return {kind: 'stream', value: cloneStream(v.value)};
  }
};

// ---- the keyspace -------------------------------------------------------------------------------------

/** The keys, stamping each key's last access on lookup as Redis's LRU clock does (OBJECT IDLETIME). */
class Keyspace extends Map<string, Value> {
  private readonly accessed = new Map<string, number>();

  get(key: string): Value | undefined {
    const v = super.get(key);
    if (v !== undefined) this.accessed.set(key, CLOCK.now());
    return v;
  }

  set(key: string, value: Value): this {
    this.accessed.set(key, CLOCK.now());
    return super.set(key, value);
  }

  delete(key: string): boolean {
    this.accessed.delete(key);
    return super.delete(key);
  }

  clear(): void {
    this.accessed.clear();
    super.clear();
  }

  /** The value without stamping an access, as TYPE, OBJECT and WATCH look keys up. */
  peek(key: string): Value | undefined {
    return super.get(key);
  }

  /** Whole seconds since the last access, on the LRU clock's one-second resolution. */
  idleSeconds(key: string): number {
    return Math.floor(CLOCK.now() / 1000) - Math.floor((this.accessed.get(key) ?? CLOCK.now()) / 1000);
  }
}

// ---- blocking -----------------------------------------------------------------------------------------

/** Thrown by a blocking command with nothing to serve a client that may block: the server parks the client. */
class WouldBlock {
  constructor(
    /** The command to run again when a key is ready (XREAD's `$` replaced by the ID it stood for). */
    readonly args: string[],
    readonly keys: string[],
    readonly type: 'list' | 'stream',
    /** Milliseconds, 0 for none. */
    readonly timeout: number,
    /** XREADGROUP: deleting or replacing the key answers it too (with the NOGROUP error). */
    readonly unblockOnNokey: boolean,
  ) {}
}

/** A client blocked on keys: the command to run again, and where its answer goes. */
interface Waiter {
  readonly args: string[];
  readonly keys: string[];
  readonly type: 'list' | 'stream';
  readonly unblockOnNokey: boolean;
  timer: number | null;
  readonly done: (reply: Reply | ReplyError) => void;
}

/** Whether the command waits for data when there is none: B(L|R)POP, BLMOVE, BRPOPLPUSH, and XREAD(GROUP) with BLOCK. */
export function isBlocking(args: string[]): boolean {
  const name = args[0]?.toLowerCase();
  if (name === 'blpop' || name === 'brpop' || name === 'blmove' || name === 'brpoplpush') return true;
  if (name !== 'xread' && name !== 'xreadgroup') return false;
  // The options as xreadCommand reads them, up to STREAMS.
  for (let i = 1; i < args.length; i++) {
    const opt = args[i].toUpperCase();
    const more = args.length - 1 - i;
    if (opt === 'BLOCK' && more) return true;
    if (opt === 'COUNT' && more) i += 1;
    else if (opt === 'GROUP' && more >= 2) i += 2;
    else if (opt !== 'NOACK') return false;
  }
  return false;
}

/** A blocking command's timeout (getTimeoutFromObjectOrReply): seconds as a float, or milliseconds; 0 waits for good. */
const blockTimeout = (arg: string, seconds: boolean): number => {
  let ms: number;
  if (seconds) {
    const value = parseDouble(arg);
    if (value === null) throw new ReplyError('ERR timeout is not a float or out of range');
    if (value * 1000 >= 2 ** 63) throw new ReplyError('ERR timeout is out of range');
    ms = Math.ceil(value * 1000);
  } else {
    if (!/^-?\d+$/.test(arg)) throw new ReplyError('ERR timeout is not an integer or out of range');
    ms = Number(arg);
  }
  if (ms < 0) throw new ReplyError('ERR timeout is negative');
  return ms;
};

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

/** An integer argument; `error` replaces the generic message where the command has its own. */
const int = (v: string, error = NOT_INT): number => {
  if (!/^-?\d+$/.test(v)) throw new ReplyError(error);
  return Number(v);
};

/** A double as Redis's strtod-based parsers read it (`inf` included, NaN not); null when it is not one. */
const parseDouble = (v: string): number | null => {
  if (!/^[+-]?((\d+\.?\d*|\.\d+)(e[+-]?\d+)?|inf(inity)?)$/i.test(v)) return null;
  return /inf/i.test(v) ? (v[0] === '-' ? -Infinity : Infinity) : Number(v);
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
  'lset',
  'pfmerge',
  'xgroup',
]);

/** A script's SHA-1 as Redis names it (lower-case hex of its bytes). */
const scriptSha = (source: string): string =>
  Array.from(sha1(byteStringToBytes(source)), b => b.toString(16).padStart(2, '0')).join('');

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
  private readonly data = new Keyspace();
  private expires = new Map<string, number>();
  private readonly subscribers = new Map<string, Set<Subscriber>>();
  private readonly patternSubscribers = new Map<string, Set<PatternSubscriber>>();
  /** Scripts by SHA-1 (hex): EVAL and SCRIPT LOAD cache them, EVALSHA runs them. */
  private readonly scripts = new Map<string, string>();
  /** Who runs the command: a client that may block, a plain call or transaction (blocking answers as a timeout), or a script. */
  private caller: 'blocking' | 'nonblocking' | 'script' = 'nonblocking';
  /** Clients blocked on each key, in the order they blocked. */
  private readonly waiters = new Map<string, Waiter[]>();
  /** Keys a write made ready for their blocked clients (Redis's ready_keys). */
  private readonly readyKeys = new Set<string>();
  private serving = false;

  flushall(): void {
    this.data.clear();
    this.expires.clear();
  }

  /** A clean server for the next check; clients still blocked are dropped unanswered. */
  reset(): void {
    this.flushall();
    this.probes.length = 0;
    this.trips.length = 0;
    this.subscribers.clear();
    this.patternSubscribers.clear();
    this.scripts.clear();
    for (const queue of this.waiters.values()) for (const w of queue) if (w.timer !== null) CLOCK.clearTimer(w.timer);
    this.waiters.clear();
    this.readyKeys.clear();
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

  /** A stable rendering of the key's value and expiry ('' when absent): WATCH compares it at EXEC. */
  fingerprint(key: string): string {
    this.sweep();
    const v = this.data.peek(key);
    if (v === undefined) return '';
    // A stream's entries and last ID: what XADD, XDEL and XTRIM change (group state does not touch WATCH in Redis).
    const body =
      v.kind === 'string' || v.kind === 'list'
        ? v.value
        : v.kind === 'set'
        ? [...v.value].sort()
        : v.kind === 'stream'
        ? [streamEntries(v.value).map(entryReply), formatId(v.value.lastId)]
        : [...v.value.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    return JSON.stringify([v.kind, body, this.expires.get(key) ?? null]);
  }

  // ---- dispatch ----------------------------------------------------------------------------------

  /**
   * Run one command as the server would, probes included: a probe on a key fires right after the
   * first command touching it, before the caller sees the reply. MULTI/EXEC and EVAL run atomically
   * and are observed as one unit. `record: false` keeps the harness's own reads out of `trips`.
   * A blocking command run here does not block: it answers as a timeout would.
   */
  execute(args: string[], record = true): Reply {
    const name = args[0]?.toLowerCase();
    if (record) this.trips.push([name.toUpperCase()]);
    let result: Reply;
    try {
      result = this.watching(() => this.run(name, args.slice(1)));
    } catch (e) {
      this.serveReady();
      throw e;
    }
    this.fireProbes(args.slice(1));
    this.serveReady();
    return result;
  }

  /**
   * `execute` for a client that may block: BLPOP, BRPOP, BLMOVE, BRPOPLPUSH, and XREAD/XREADGROUP
   * with BLOCK, finding nothing, wait for another client's write (served in the order they blocked)
   * or their timeout on the virtual clock (nil). Error replies reject with ReplyError.
   */
  executeBlocking(args: string[], record = true): Promise<Reply> {
    const {promise, resolve, reject} = Promise.withResolvers<Reply>();
    if (!isBlocking(args)) {
      try {
        resolve(this.execute(args, record));
      } catch (e) {
        reject(e);
      }
      return promise;
    }
    if (record) this.trips.push([args[0].toUpperCase()]);
    this.attempt(args, reply => (reply instanceof ReplyError ? reject(reply) : resolve(reply)));
    return promise;
  }

  /** A MULTI/EXEC block: every queued command runs back to back; probes fire once, afterwards. */
  executeTransaction(commands: string[][]): (Reply | ReplyError)[] {
    this.trips.push(['MULTI', ...commands.map(c => c[0].toUpperCase()), 'EXEC']);
    const replies = this.watching(() =>
      commands.map(c => {
        try {
          return this.run(c[0].toLowerCase(), c.slice(1));
        } catch (e) {
          return e instanceof ReplyError ? e : new ReplyError(String(e));
        }
      }),
    );
    this.fireProbes(commands.flatMap(c => c.slice(1)));
    this.serveReady();
    return replies;
  }

  /** A pipeline: the commands go to the server in one round trip and run back to back, each observed as it runs. */
  executePipeline(commands: string[][]): (Reply | ReplyError)[] {
    this.trips.push(commands.map(c => c[0].toUpperCase()));
    return commands.map(c => this.pipelined(c));
  }

  /** A pipeline whose blocking commands may block: one that waits holds the commands after it, as in Redis. */
  executePipelineBlocking(commands: string[][]): Promise<(Reply | ReplyError)[]> {
    this.trips.push(commands.map(c => c[0].toUpperCase()));
    const {promise, resolve} = Promise.withResolvers<(Reply | ReplyError)[]>();
    const replies: (Reply | ReplyError)[] = [];
    const from = (start: number): void => {
      for (let i = start; i < commands.length; i++) {
        if (!isBlocking(commands[i])) {
          replies.push(this.pipelined(commands[i]));
          continue;
        }
        let parked = false;
        let answered = false;
        this.attempt(commands[i], reply => {
          replies.push(reply);
          // Answered later, by another client's write: the rest runs once that write is done.
          if (parked) queueMicrotask(() => from(i + 1));
          else answered = true;
        });
        if (!answered) {
          parked = true;
          return;
        }
      }
      resolve(replies);
    };
    from(0);
    return promise;
  }

  private pipelined(c: string[]): Reply | ReplyError {
    let reply: Reply | ReplyError;
    try {
      reply = this.watching(() => this.run(c[0].toLowerCase(), c.slice(1)));
    } catch (e) {
      reply = e instanceof ReplyError ? e : new ReplyError(String(e));
    }
    this.fireProbes(c.slice(1));
    this.serveReady();
    return reply;
  }

  // ---- blocked clients: parked per key, served in order when a write readies the key -------------------

  /**
   * Run a blocking command for a client that may block: `done` gets the answer now, or the client
   * parks until a write serves it or its timeout passes. `parked`: the client running it again after a
   * write, which keeps its timeout.
   */
  private attempt(args: string[], done: (reply: Reply | ReplyError) => void, parked?: Waiter): void {
    const caller = this.caller;
    this.caller = 'blocking';
    let reply: Reply | ReplyError;
    try {
      reply = this.watching(() => this.run(args[0].toLowerCase(), args.slice(1)));
    } catch (e) {
      if (e instanceof WouldBlock) {
        const waiter = parked ?? {...e, timer: null, done};
        for (const key of new Set(waiter.keys)) this.waiters.set(key, [...(this.waiters.get(key) ?? []), waiter]);
        if (parked === undefined && e.timeout > 0)
          waiter.timer = CLOCK.setTimeout(() => this.timeOut(waiter), e.timeout);
        return;
      }
      reply = e instanceof ReplyError ? e : new ReplyError(String(e));
    } finally {
      this.caller = caller;
    }
    if (parked?.timer != null) CLOCK.clearTimer(parked.timer);
    this.fireProbes(args.slice(1));
    this.serveReady();
    done(reply);
  }

  /** Take a blocked client off every key it waits on. */
  private unpark(waiter: Waiter): void {
    for (const key of new Set(waiter.keys)) {
      const queue = (this.waiters.get(key) ?? []).filter(w => w !== waiter);
      if (queue.length === 0) this.waiters.delete(key);
      else this.waiters.set(key, queue);
    }
  }

  private timeOut(waiter: Waiter): void {
    if (!this.waiters.get(waiter.keys[0])?.includes(waiter)) return;
    this.unpark(waiter);
    this.fireProbes(waiter.args.slice(1));
    waiter.done(null);
  }

  /** Run `fn` (a command, a transaction, a script) and mark ready the waited-on keys it created, replaced or deleted. */
  private watching<T>(fn: () => T): T {
    if (this.waiters.size === 0) return fn();
    const before = new Map([...this.waiters.keys()].map(k => [k, this.data.peek(k)]));
    try {
      return fn();
    } finally {
      for (const [key, value] of before) if (this.data.peek(key) !== value) this.readyKeys.add(key);
    }
  }

  /** Mark a key ready for the clients blocked on it, as Redis's signalKeyAsReady (XADD, XGROUP DESTROY). */
  private signal(key: string): void {
    if (this.waiters.has(key)) this.readyKeys.add(key);
  }

  /** Serve the clients blocked on ready keys until none is ready (serving a BLMOVE can ready another key). */
  private serveReady(): void {
    if (this.serving) return;
    this.serving = true;
    try {
      while (this.readyKeys.size > 0) {
        const keys = [...this.readyKeys];
        this.readyKeys.clear();
        for (const key of keys) this.serveKey(key);
      }
    } finally {
      this.serving = false;
    }
  }

  /**
   * The clients blocked on `key`, first blocked first, each running its command again
   * (handleClientsBlockedOnKey): one that finds data is answered, one that does not stays blocked.
   */
  private serveKey(key: string): void {
    for (let n = this.waiters.get(key)?.length ?? 0; n > 0; n--) {
      const queue = this.waiters.get(key);
      const waiter = queue?.[0];
      if (queue === undefined || waiter === undefined) return;
      // Rotate first: a client that blocks again goes behind the others, keeping their order.
      queue.push(queue.shift() ?? waiter);
      this.sweep();
      if (this.data.peek(key)?.kind !== waiter.type && !waiter.unblockOnNokey) continue;
      this.unpark(waiter);
      this.attempt(waiter.args, waiter.done, waiter);
    }
  }

  /** A blocking command found nothing: a client that may block parks; anyone else gets the timeout answer, nil. */
  private block(
    args: string[],
    keys: string[],
    type: 'list' | 'stream',
    timeout: number,
    unblockOnNokey = false,
  ): null {
    if (this.caller !== 'blocking') return null;
    throw new WouldBlock(args, keys, type, timeout, unblockOnNokey);
  }

  private fireProbes(args: string[]): void {
    if (this.probes.length === 0) return;
    const touched = new Set(args);
    // A snapshot: a probe armed by a probe's fn waits for the next command touching its key.
    for (const probe of [...this.probes]) {
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
    if (Object.hasOwn(ARITY, name)) {
      const arity = ARITY[name];
      if (arity > 0 ? a.length + 1 !== arity : a.length + 1 < -arity) throw arityError(name);
    }
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
        const v = this.data.peek(a[0]);
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
      case 'touch':
        return a.filter(k => this.data.get(k) !== undefined).length;
      case 'copy': {
        let replace = false;
        for (let i = 2; i < a.length; i++) {
          const opt = a[i].toUpperCase();
          if (opt === 'REPLACE') replace = true;
          else if (opt === 'DB' && i + 1 < a.length) {
            // One database, as a server run with `databases 1`: any other index does not exist.
            if (int(a[++i]) !== 0) throw new ReplyError('ERR DB index is out of range');
          } else throw new ReplyError(SYNTAX);
        }
        if (a[0] === a[1]) throw new ReplyError('ERR source and destination objects are the same');
        const v = this.data.get(a[0]);
        if (v === undefined || (this.data.get(a[1]) !== undefined && !replace)) return 0;
        const at = this.expires.get(a[0]);
        this.data.set(a[1], cloneValue(v));
        if (at === undefined) this.expires.delete(a[1]);
        else this.expires.set(a[1], at);
        return 1;
      }
      case 'object': {
        const sub = subcommand('object', a, {encoding: 3, refcount: 3, idletime: 3, freq: 3, help: 2});
        if (sub === 'help') return help('OBJECT', OBJECT_HELP);
        // OBJECT looks the key up without counting as an access.
        const v = this.data.peek(a[1]);
        if (v === undefined) return null;
        if (sub === 'encoding') return encoding(v);
        // Integers 0 to 9999 are Redis's shared objects (refcount INT_MAX); every other value is its key's alone.
        if (sub === 'refcount')
          return v.kind === 'string' && encoding(v) === 'int' && /^\d{1,4}$/.test(v.value) ? 2147483647 : 1;
        if (sub === 'idletime') return this.data.idleSeconds(a[1]);
        throw new ReplyError(
          'ERR An LFU maxmemory policy is not selected, access frequency not tracked. Please note that when switching between policies at runtime LRU and LFU data will take some time to adjust.',
        );
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
        this.data.set(a[0], {kind: 'string', value: current + a[1], raw: true});
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
        this.data.set(a[0], {kind: 'string', value: next, raw: true});
        return next.length;
      }
      case 'getex': {
        let unit: 'EX' | 'PX' | 'EXAT' | 'PXAT' | 'PERSIST' | null = null;
        let expire = '';
        for (let i = 1; i < a.length; i++) {
          const opt = a[i].toUpperCase();
          // One expiry option, possibly repeated (the last value wins), or PERSIST.
          if (opt === 'PERSIST' && (unit === null || unit === opt)) unit = opt;
          else if (
            (opt === 'EX' || opt === 'PX' || opt === 'EXAT' || opt === 'PXAT') &&
            i + 1 < a.length &&
            (unit === null || unit === opt)
          ) {
            unit = opt;
            expire = a[++i];
          } else throw new ReplyError(SYNTAX);
        }
        const v = this.string(a[0]);
        if (v === null || unit === null) return v;
        if (unit === 'PERSIST') {
          this.expires.delete(a[0]);
          return v;
        }
        let at = int(expire);
        if (at <= 0) throw new ReplyError("ERR invalid expire time in 'getex' command");
        if (unit === 'EX' || unit === 'EXAT') at *= 1000;
        if (unit === 'EX' || unit === 'PX') at += CLOCK.now();
        // An absolute time already past deletes the key.
        if (at <= CLOCK.now()) this.drop(a[0]);
        else this.expires.set(a[0], at);
        return v;
      }
      case 'msetnx': {
        if (a.length % 2 === 1) throw arityError(name);
        for (let i = 0; i < a.length; i += 2) if (this.data.get(a[i]) !== undefined) return 0;
        for (let i = 0; i < a.length; i += 2) this.run('set', [a[i], a[i + 1]]);
        return 1;
      }
      case 'getbit':
      case 'setbit': {
        // Offsets reach 2^32 - 1 (a 512 MB string), past what JavaScript's bit operators take.
        const offset = /^(0|[1-9]\d{0,9})$/.test(a[1]) ? Number(a[1]) : -1;
        if (offset < 0 || offset >= 2 ** 32) throw new ReplyError('ERR bit offset is not an integer or out of range');
        const byte = Math.floor(offset / 8);
        const mask = 0x80 >> offset % 8;
        if (name === 'getbit') return (this.string(a[0]) ?? '').charCodeAt(byte) & mask ? 1 : 0;
        if (a[2] !== '0' && a[2] !== '1') throw new ReplyError('ERR bit is not an integer or out of range');
        const s = (this.string(a[0]) ?? '').padEnd(byte + 1, '\0');
        const old = s.charCodeAt(byte);
        const next = String.fromCharCode(a[2] === '1' ? old | mask : old & ~mask);
        this.data.set(a[0], {kind: 'string', value: s.slice(0, byte) + next + s.slice(byte + 1), raw: true});
        return old & mask ? 1 : 0;
      }
      case 'bitcount': {
        const s = this.string(a[0]);
        if (s === null) return 0;
        let start = 0;
        let end = s.length - 1;
        let bits = false;
        if (a.length === 3 || a.length === 4) {
          start = int(a[1]);
          end = int(a[2]);
          if (start < 0 && end < 0 && start > end) return 0;
          if (a.length === 4) {
            const unit = a[3].toUpperCase();
            if (unit !== 'BIT' && unit !== 'BYTE') throw new ReplyError(SYNTAX);
            bits = unit === 'BIT';
          }
          const total = bits ? s.length * 8 : s.length;
          if (start < 0) start += total;
          if (end < 0) end += total;
          start = Math.max(0, start);
          end = Math.min(Math.max(0, end), total - 1);
        } else if (a.length !== 1) throw new ReplyError(SYNTAX);
        let count = 0;
        for (let i = start; i <= end; i++) {
          if (bits) count += (s.charCodeAt(Math.floor(i / 8)) >> (7 - (i % 8))) & 1;
          else for (let byte = s.charCodeAt(i); byte; byte &= byte - 1) count += 1;
        }
        return count;
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
      case 'hstrlen':
        return this.hash(a[0], false)?.get(a[1])?.length ?? 0;
      case 'hrandfield': {
        if (a.length === 1) {
          const h = this.hash(a[0], false);
          return h === null ? null : h.keys().next().value ?? null;
        }
        const count = randomCount(a, 'WITHVALUES');
        const h = this.hash(a[0], false);
        if (h === null || count === 0) return [];
        return pick([...h.entries()], count).flatMap(([f, v]) => (a.length === 3 ? [f, v] : [f]));
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
      case 'lpushx':
      case 'rpushx': {
        const l = this.list(a[0], false);
        if (l === null) return 0;
        for (const v of a.slice(1)) name === 'lpushx' ? l.unshift(v) : l.push(v);
        return l.length;
      }
      case 'linsert': {
        const where = a[1].toUpperCase();
        if (where !== 'BEFORE' && where !== 'AFTER') throw new ReplyError(SYNTAX);
        const l = this.list(a[0], false);
        if (l === null) return 0;
        const i = l.indexOf(a[2]);
        if (i === -1) return -1;
        l.splice(where === 'BEFORE' ? i : i + 1, 0, a[3]);
        return l.length;
      }
      case 'lset': {
        const l = this.list(a[0], false);
        if (l === null) throw new ReplyError('ERR no such key');
        const i = int(a[1]);
        const at = i < 0 ? l.length + i : i;
        if (at < 0 || at >= l.length) throw new ReplyError('ERR index out of range');
        l[at] = a[2];
        return 'OK';
      }
      case 'lpos': {
        let rank = 1;
        let count = -1;
        let maxlen = 0;
        const positive = (v: string, what: string): number => {
          const n = /^-?\d+$/.test(v) ? Number(v) : -1;
          if (n < 0) throw new ReplyError(`ERR ${what} can't be negative`);
          return n;
        };
        for (let j = 2; j < a.length; j++) {
          const opt = a[j].toUpperCase();
          const more = j + 1 < a.length;
          if (opt === 'RANK' && more) {
            rank = int(a[++j]);
            if (rank === 0)
              throw new ReplyError(
                "ERR RANK can't be zero: use 1 to start from the first match, 2 from the second ... or use negative to start from the end of the list",
              );
          } else if (opt === 'COUNT' && more) count = positive(a[++j], 'COUNT');
          else if (opt === 'MAXLEN' && more) maxlen = positive(a[++j], 'MAXLEN');
          else throw new ReplyError(SYNTAX);
        }
        const l = this.list(a[0], false);
        if (l === null) return count === -1 ? null : [];
        // A negative rank scans from the tail; MAXLEN caps the elements compared.
        const order = rank < 0 ? [...l.keys()].reverse() : [...l.keys()];
        const scanned = maxlen === 0 ? order : order.slice(0, maxlen);
        const matches: number[] = [];
        let seen = 0;
        for (const i of scanned) {
          if (l[i] !== a[1] || ++seen < Math.abs(rank)) continue;
          matches.push(i);
          if (count === -1 || matches.length === count) break;
        }
        return count === -1 ? matches[0] ?? null : matches;
      }
      case 'lmove':
      case 'blmove': {
        const from = listEnd(a[2]);
        const to = listEnd(a[3]);
        if (name === 'blmove') {
          const timeout = blockTimeout(a[4], true);
          if (this.list(a[0], false) === null) return this.block([name, ...a], [a[0]], 'list', timeout);
        }
        return this.lmove(a[0], a[1], from, to);
      }
      case 'rpoplpush':
      case 'brpoplpush': {
        if (name === 'brpoplpush') {
          const timeout = blockTimeout(a[2], true);
          if (this.list(a[0], false) === null) return this.block([name, ...a], [a[0]], 'list', timeout);
        }
        return this.lmove(a[0], a[1], 'RIGHT', 'LEFT');
      }
      case 'blpop':
      case 'brpop': {
        const timeout = blockTimeout(a[a.length - 1], true);
        const keys = a.slice(0, -1);
        // The first key holding a non-empty list answers; a wrong type before it is an error.
        for (const key of keys) {
          const l = this.list(key, false);
          if (l === null || l.length === 0) continue;
          const v = (name === 'blpop' ? l.shift() : l.pop()) ?? '';
          if (l.length === 0) this.drop(key);
          return [key, v];
        }
        return this.block([name, ...a], keys, 'list', timeout);
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
      case 'smismember': {
        const s = this.set(a[0], false);
        return a.slice(1).map(m => (s?.has(m) ? 1 : 0));
      }
      case 'smove': {
        // A missing source answers 0 before the destination's type is looked at.
        const source = this.set(a[0], false);
        if (source === null) return 0;
        const target = this.set(a[1], false);
        if (a[0] === a[1]) return source.has(a[2]) ? 1 : 0;
        if (!source.delete(a[2])) return 0;
        if (source.size === 0) this.drop(a[0]);
        (target ?? this.set(a[1], true)).add(a[2]);
        return 1;
      }
      case 'srandmember': {
        if (a.length > 2) throw new ReplyError(SYNTAX);
        const count = a.length === 2 ? int(a[1]) : null;
        const members = [...(this.set(a[0], false) ?? [])].sort();
        if (count === null) return members[0] ?? null;
        return count === 0 || members.length === 0 ? [] : pick(members, count);
      }
      case 'sinter':
      case 'sinterstore':
      case 'sunion':
      case 'sunionstore':
      case 'sdiff':
      case 'sdiffstore': {
        const store = name.endsWith('store');
        // Every key is type-checked first; a missing one is an empty set.
        const [first, ...rest] = (store ? a.slice(1) : a).map(k => this.set(k, false));
        const op = name.slice(1, store ? -5 : undefined);
        const result = new Set(op === 'union' ? [first, ...rest].flatMap(s => [...(s ?? [])]) : first ?? []);
        if (op === 'inter') for (const m of result) if (!rest.every(s => s?.has(m))) result.delete(m);
        if (op === 'diff') for (const s of rest) for (const m of s ?? []) result.delete(m);
        if (!store) return [...result].sort();
        return this.store(a[0], {kind: 'set', value: result}, result.size);
      }
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
      // Lexicographical ranges: Redis means them for members that share one score, where score order
      // is byte order; with mixed scores its answer is unspecified, and this one keeps score order.
      case 'zrangebylex':
      case 'zrevrangebylex': {
        const rev = name === 'zrevrangebylex';
        const lo = lexBound(rev ? a[2] : a[1]);
        const hi = lexBound(rev ? a[1] : a[2]);
        let out = this.sortedMembers(a[0], rev).filter(([m]) => lexIn(m, lo, hi));
        for (let i = 3; i < a.length; i += 3) {
          if (a[i].toUpperCase() !== 'LIMIT' || i + 2 >= a.length) throw new ReplyError('ERR syntax error');
          const offset = int(a[i + 1]);
          const count = int(a[i + 2]);
          out = offset < 0 ? [] : out.slice(offset, count < 0 ? undefined : offset + count);
        }
        return out.map(([m]) => m);
      }
      case 'zlexcount': {
        const lo = lexBound(a[1]);
        const hi = lexBound(a[2]);
        return this.sortedMembers(a[0], false).filter(([m]) => lexIn(m, lo, hi)).length;
      }
      case 'zremrangebylex': {
        const lo = lexBound(a[1]);
        const hi = lexBound(a[2]);
        const z = this.zset(a[0], false);
        if (z === null) return 0;
        let n = 0;
        for (const m of [...z.keys()]) if (lexIn(m, lo, hi)) z.delete(m), (n += 1);
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
      case 'zpopmin':
      case 'zpopmax': {
        // Lowest (highest) scores first, flat member/score pairs; an empty array when there is none.
        const count = a[1] === undefined ? 1 : int(a[1]);
        const z = this.zset(a[0], false);
        if (z === null || count <= 0) return [];
        const popped = this.sortedMembers(a[0], name === 'zpopmax').slice(0, count);
        for (const [m] of popped) z.delete(m);
        if (z.size === 0) this.data.delete(a[0]);
        return popped.flatMap(([m, s]) => [m, String(s)]);
      }
      case 'zmscore': {
        const z = this.zset(a[0], false);
        return a.slice(1).map(m => {
          const score = z?.get(m);
          return score === undefined ? null : scoreString(score);
        });
      }
      case 'zrandmember': {
        if (a.length === 1) return this.sortedMembers(a[0], false)[0]?.[0] ?? null;
        const count = randomCount(a, 'WITHSCORES');
        const members = this.sortedMembers(a[0], false);
        if (members.length === 0 || count === 0) return [];
        return pick(members, count).flatMap(([m, s]) => (a.length === 3 ? [m, scoreString(s)] : [m]));
      }
      case 'zunionstore':
      case 'zinterstore': {
        const numkeys = int(a[1]);
        if (numkeys < 1) throw new ReplyError(`ERR at least 1 input key is needed for '${name}' command`);
        if (numkeys > a.length - 2) throw new ReplyError(SYNTAX);
        // Sorted sets, and plain sets as members scored 1; a missing key is empty.
        const inputs = a.slice(2, 2 + numkeys).map(k => {
          const v = this.data.get(k);
          if (v === undefined) return new Map<string, number>();
          if (v.kind === 'zset') return v.value;
          if (v.kind === 'set') return new Map([...v.value].map(m => [m, 1]));
          throw new ReplyError(WRONGTYPE);
        });
        const weights = inputs.map(() => 1);
        let aggregate = 'SUM';
        for (let j = 2 + numkeys; j < a.length; ) {
          const opt = a[j].toUpperCase();
          if (opt === 'WEIGHTS' && a.length - j > numkeys) {
            for (let i = 0; i < numkeys; i++) {
              const w = parseDouble(a[j + 1 + i]);
              if (w === null) throw new ReplyError('ERR weight value is not a float');
              weights[i] = w;
            }
            j += numkeys + 1;
          } else if (opt === 'AGGREGATE' && a.length - j >= 2) {
            aggregate = a[j + 1].toUpperCase();
            if (aggregate !== 'SUM' && aggregate !== 'MIN' && aggregate !== 'MAX') throw new ReplyError(SYNTAX);
            j += 2;
          } else throw new ReplyError(SYNTAX);
        }
        // Smallest input first, as Redis iterates them; 0 * inf and inf - inf count as 0.
        const order = inputs.map((_, i) => i).sort((x, y) => inputs[x].size - inputs[y].size);
        const weighted = (i: number, score: number): number =>
          Number.isNaN(weights[i] * score) ? 0 : weights[i] * score;
        const combine = (x: number, y: number): number => {
          if (aggregate === 'MIN') return Math.min(x, y);
          if (aggregate === 'MAX') return Math.max(x, y);
          return Number.isNaN(x + y) ? 0 : x + y;
        };
        const out = new Map<string, number>();
        if (name === 'zunionstore') {
          for (const i of order)
            for (const [m, s] of inputs[i]) {
              const prev = out.get(m);
              out.set(m, prev === undefined ? weighted(i, s) : combine(prev, weighted(i, s)));
            }
        } else {
          const [smallest, ...others] = order;
          for (const [m, s] of inputs[smallest]) {
            if (!others.every(i => inputs[i].has(m))) continue;
            out.set(
              m,
              others.reduce((acc, i) => combine(acc, weighted(i, inputs[i].get(m) ?? 0)), weighted(smallest, s)),
            );
          }
        }
        return this.store(a[0], {kind: 'zset', value: out}, out.size);
      }
      // ---- keyspace: SCAN, RENAME, EXPIREAT ------------------------------------------------------
      case 'scan': {
        // The cursor is a position in the sorted live keys; MATCH filters each batch, as in Redis.
        const all = this.keys('*');
        const start = int(a[0]);
        let count = 10;
        let pattern = '*';
        let type: string | null = null;
        for (let i = 1; i + 1 < a.length; i += 2) {
          const o = a[i].toUpperCase();
          if (o === 'COUNT') count = int(a[i + 1]);
          else if (o === 'MATCH') pattern = a[i + 1];
          else if (o === 'TYPE') type = a[i + 1].toLowerCase();
          else throw new ReplyError('ERR syntax error');
        }
        if (count < 1) throw new ReplyError('ERR syntax error');
        const batch = all.slice(start, start + count);
        const next = start + count >= all.length ? 0 : start + count;
        const re = globToRegExp(pattern);
        return [String(next), batch.filter(k => re.test(k) && (type === null || this.data.get(k)?.kind === type))];
      }
      case 'rename':
      case 'renamenx': {
        const v = this.data.get(a[0]);
        if (v === undefined) throw new ReplyError('ERR no such key');
        if (name === 'renamenx' && a[0] !== a[1] && this.data.has(a[1])) return 0;
        const at = this.expires.get(a[0]);
        this.data.delete(a[0]);
        this.expires.delete(a[0]);
        this.data.set(a[1], v);
        if (at === undefined) this.expires.delete(a[1]);
        else this.expires.set(a[1], at);
        return name === 'renamenx' ? 1 : 'OK';
      }
      case 'expireat':
      case 'pexpireat': {
        // A deadline on the virtual clock (seconds or milliseconds since the epoch); a past one deletes.
        if (!this.data.has(a[0])) return 0;
        const at = int(a[1]) * (name === 'expireat' ? 1000 : 1);
        if (at <= CLOCK.now()) {
          this.data.delete(a[0]);
          this.expires.delete(a[0]);
        } else this.expires.set(a[0], at);
        return 1;
      }
      // ---- SPOP; HyperLogLog ---------------------------------------------------------------------
      case 'spop': {
        // Members leave in sorted order (Redis picks at random; a fixed order keeps checks repeatable).
        const s = this.set(a[0], false);
        const many = a[1] !== undefined;
        const count = many ? int(a[1]) : 1;
        if (s === null) return many ? [] : null;
        const popped = [...s].sort().slice(0, Math.max(0, count));
        for (const m of popped) s.delete(m);
        if (s.size === 0) this.data.delete(a[0]);
        return many ? popped : popped[0] ?? null;
      }
      case 'pfadd':
      case 'pfcount':
      case 'pfmerge': {
        // A HyperLogLog is a string (as in Redis) holding its distinct elements here: counts are exact.
        const read = (key: string): Set<string> | null => {
          const raw = this.string(key);
          if (raw === null) return null;
          if (!raw.startsWith('HYLL')) throw new ReplyError('WRONGTYPE Key is not a valid HyperLogLog string value.');
          return new Set(JSON.parse(raw.slice(4)) as string[]);
        };
        if (name !== 'pfadd') {
          // PFMERGE folds the destination in with the sources and writes it in place (its TTL stays).
          const union = new Set<string>();
          for (const k of a) for (const m of read(k) ?? []) union.add(m);
          if (name === 'pfcount') return union.size;
          this.data.set(a[0], {kind: 'string', value: 'HYLL' + JSON.stringify([...union].sort()), raw: true});
          return 'OK';
        }
        const existing = read(a[0]);
        const hll = existing ?? new Set<string>();
        const before = hll.size;
        for (const m of a.slice(1)) hll.add(m);
        this.data.set(a[0], {kind: 'string', value: 'HYLL' + JSON.stringify([...hll].sort()), raw: true});
        return existing === null || hll.size !== before ? 1 : 0;
      }
      // ---- scripting -----------------------------------------------------------------------------
      case 'eval':
      case 'evalsha': {
        if (this.lua === null) throw new ReplyError('ERR Lua scripting is not available in this runtime');
        // EVAL caches its script under its SHA-1, as Redis does; EVALSHA runs only a cached one.
        let source = a[0];
        if (name === 'evalsha') {
          const cached = this.scripts.get(a[0].toLowerCase());
          if (cached === undefined) throw new ReplyError('NOSCRIPT No matching script. Please use EVAL.');
          source = cached;
        } else this.scripts.set(scriptSha(source), source);
        const numkeys = int(a[1]);
        const keys = a.slice(2, 2 + numkeys);
        const argv = a.slice(2 + numkeys);
        const statusCommand = (cmd: string): boolean => STATUS_REPLIES.has(cmd);
        let out: string;
        // Commands from the script never block (XREAD with BLOCK is an error there, as in Redis).
        const caller = this.caller;
        this.caller = 'script';
        try {
          out = this.lua(source, JSON.stringify(keys), JSON.stringify(argv), argsJson => {
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
        } finally {
          this.caller = caller;
        }
        return untag(JSON.parse(out) as Tagged);
      }
      case 'script': {
        const sub = a[0]?.toLowerCase();
        if (sub === 'load') {
          const sha = scriptSha(a[1]);
          this.scripts.set(sha, a[1]);
          return sha;
        }
        if (sub === 'exists') return a.slice(1).map(sha => (this.scripts.has(sha.toLowerCase()) ? 1 : 0));
        if (sub === 'flush') {
          this.scripts.clear();
          return 'OK';
        }
        throw new ReplyError(`ERR unknown subcommand '${a[0]}'`);
      }
      default:
        if (GEO_COMMANDS.has(name)) return this.geo(name, a);
        if (STREAM_COMMANDS.has(name)) return this.streamCommand(name, a);
        throw new ReplyError(`ERR unknown command '${name}'`);
    }
  }

  // ---- streams ------------------------------------------------------------------------------------------

  private streamCommand(name: string, a: string[]): Reply {
    const now = Math.floor(CLOCK.now());
    switch (name) {
      case 'xadd': {
        const t = parseAddOrTrim(a, true);
        const fields = a.slice(t.next + 1);
        if (fields.length < 2 || fields.length % 2 === 1) throw arityError(name);
        if (t.id?.seqGiven && t.id.id === 0n)
          throw new ReplyError('ERR The ID specified in XADD must be greater than 0-0');
        const existing = this.stream(a[0], false);
        if (existing === null && t.noMkStream) return null;
        const s = existing ?? this.stream(a[0], true);
        if (s.lastId === MAX_ID)
          throw new ReplyError('ERR The stream has exhausted the last possible ID, unable to add more items');
        const tooSmall = new ReplyError(
          'ERR The ID specified in XADD is equal or smaller than the target stream top item',
        );
        let id: StreamId;
        if (t.id === null) {
          // `*`: the clock's milliseconds, or the next sequence when the clock has not passed the last ID.
          const ms = BigInt(now);
          id = ms > s.lastId >> 64n ? ms << 64n : s.lastId + 1n;
        } else if (t.id.seqGiven || t.id.id >> 64n !== s.lastId >> 64n) id = t.id.id;
        else if ((s.lastId & U64) === U64) throw tooSmall;
        else id = s.lastId + 1n;
        if (id <= s.lastId) throw tooSmall;
        appendEntry(s, id, fields);
        trimStream(s, t);
        this.signal(a[0]);
        return formatId(id);
      }
      case 'xlen':
        return this.stream(a[0], false)?.length ?? 0;
      case 'xrange':
      case 'xrevrange': {
        const rev = name === 'xrevrange';
        const start = parseInterval(rev ? a[2] : a[1], false);
        const end = parseInterval(rev ? a[1] : a[2], true);
        let count = -1;
        for (let j = 3; j < a.length; j++) {
          if (a[j].toUpperCase() !== 'COUNT' || j + 1 >= a.length) throw new ReplyError(SYNTAX);
          count = Math.max(0, int(a[++j]));
        }
        const s = this.stream(a[0], false);
        if (s === null) return [];
        if (count === 0) return null;
        const within = streamEntries(s).filter(e => e.id >= start && e.id <= end);
        if (rev) within.reverse();
        return (count > 0 ? within.slice(0, count) : within).map(entryReply);
      }
      case 'xdel': {
        const s = this.stream(a[0], false);
        if (s === null) return 0;
        // Every ID is parsed before any is deleted.
        const ids = a.slice(1).map(arg => parseStreamId(arg, 0n, true).id);
        let deleted = 0;
        for (const id of ids) {
          if (!deleteEntry(s, id)) continue;
          deleted += 1;
          if (id > s.maxDeletedId) s.maxDeletedId = id;
        }
        return deleted;
      }
      case 'xtrim': {
        const t = parseAddOrTrim(a, false);
        const s = this.stream(a[0], false);
        return s === null ? 0 : trimStream(s, t);
      }
      case 'xread':
      case 'xreadgroup':
        return this.xread(name, a, now);
      case 'xack': {
        const g = this.stream(a[0], false)?.groups.get(a[1]);
        if (g === undefined) return 0;
        const ids = a.slice(2).map(arg => parseStreamId(arg, 0n, true).id);
        let acked = 0;
        for (const id of ids) {
          const nack = g.pel.get(id);
          if (nack === undefined) continue;
          g.pel.delete(id);
          nack.consumer?.pel.delete(id);
          acked += 1;
        }
        return acked;
      }
      case 'xpending': {
        if (a.length !== 2 && (a.length < 5 || a.length > 8)) throw new ReplyError(SYNTAX);
        let start = 0n;
        let end = MAX_ID;
        let count = 0;
        let minIdle = 0;
        let consumerName: string | null = null;
        if (a.length >= 5) {
          let at = 2;
          if (a[2].toUpperCase() === 'IDLE') {
            minIdle = int(a[3]);
            if (a.length < 7) throw new ReplyError(SYNTAX);
            at = 4;
          }
          count = Math.max(0, int(a[at + 2]));
          start = parseInterval(a[at], false);
          end = parseInterval(a[at + 1], true);
          consumerName = a[at + 3] ?? null;
        }
        const g = this.stream(a[0], false)?.groups.get(a[1]);
        if (g === undefined) throw new ReplyError(`NOGROUP No such key '${a[0]}' or consumer group '${a[1]}'`);
        if (a.length === 2) {
          if (g.pel.size === 0) return [0, null, null, null];
          const ids = byId(g.pel);
          const owners = byName(g.consumers)
            .filter(c => c.pel.size > 0)
            .map(c => [c.name, String(c.pel.size)]);
          return [g.pel.size, formatId(ids[0][0]), formatId(ids[ids.length - 1][0]), owners];
        }
        const pel = consumerName === null ? g.pel : g.consumers.get(consumerName)?.pel;
        if (pel === undefined) return [];
        const out: Reply[] = [];
        for (const [id, nack] of byId(pel)) {
          if (out.length >= count || id > end) break;
          if (id < start || (minIdle && now - nack.time < minIdle)) continue;
          out.push([formatId(id), nack.consumer?.name ?? '', Math.max(0, now - nack.time), nack.count]);
        }
        return out;
      }
      case 'xclaim': {
        const s = this.stream(a[0], false);
        const g = s?.groups.get(a[1]);
        if (s === null || g === undefined)
          throw new ReplyError(`NOGROUP No such key '${a[0]}' or consumer group '${a[1]}'`);
        const minIdle = Math.max(0, int(a[3], 'ERR Invalid min-idle-time argument for XCLAIM'));
        // IDs up to the first argument that is not one; options follow.
        const ids: StreamId[] = [];
        let j = 4;
        for (; j < a.length; j++) {
          try {
            ids.push(parseStreamId(a[j], 0n, true).id);
          } catch {
            break;
          }
        }
        let force = false;
        let justId = false;
        let retries = -1;
        let delivered = -1;
        let lastId = 0n;
        for (; j < a.length; j++) {
          const opt = a[j].toUpperCase();
          const more = j + 1 < a.length;
          if (opt === 'FORCE') force = true;
          else if (opt === 'JUSTID') justId = true;
          else if (opt === 'IDLE' && more) delivered = now - int(a[++j], 'ERR Invalid IDLE option argument for XCLAIM');
          else if (opt === 'TIME' && more) delivered = int(a[++j], 'ERR Invalid TIME option argument for XCLAIM');
          else if (opt === 'RETRYCOUNT' && more)
            retries = int(a[++j], 'ERR Invalid RETRYCOUNT option argument for XCLAIM');
          else if (opt === 'LASTID' && more) lastId = parseStreamId(a[++j], 0n, true).id;
          else throw new ReplyError(`ERR Unrecognized XCLAIM option '${a[j]}'`);
        }
        if (lastId > g.lastId) g.lastId = lastId;
        // A delivery time in the future or before the epoch is taken as now.
        if (delivered < 0 || delivered > now) delivered = now;
        const consumer = this.consumer(g, a[2], now);
        const out: Reply[] = [];
        for (const id of ids) {
          let nack = g.pel.get(id);
          const entry = findEntry(s, id);
          if (entry === undefined) {
            // Deleted from the stream: its pending entry goes too.
            if (nack !== undefined) {
              g.pel.delete(id);
              nack.consumer?.pel.delete(id);
            }
            continue;
          }
          if (force && nack === undefined) {
            nack = {consumer: null, time: now, count: 1};
            g.pel.set(id, nack);
          }
          if (nack === undefined || (nack.consumer !== null && minIdle && now - nack.time < minIdle)) continue;
          nack.time = delivered;
          if (retries >= 0) nack.count = retries;
          else if (!justId) nack.count += 1;
          if (nack.consumer !== consumer) {
            nack.consumer?.pel.delete(id);
            consumer.pel.set(id, nack);
            nack.consumer = consumer;
          }
          out.push(justId ? formatId(id) : entryReply(entry));
          consumer.active = now;
        }
        return out;
      }
      case 'xautoclaim': {
        const minIdle = Math.max(0, int(a[3], 'ERR Invalid min-idle-time argument for XAUTOCLAIM'));
        const start = parseInterval(a[4], false);
        let count = 100;
        let justId = false;
        for (let j = 5; j < a.length; j++) {
          const opt = a[j].toUpperCase();
          if (opt === 'COUNT' && j + 1 < a.length) {
            count = int(a[++j], 'ERR COUNT must be > 0');
            // At most LONG_MAX / 10, so that 10 × COUNT attempts fit.
            if (count < 1 || count > 2 ** 63 / 10) throw new ReplyError('ERR COUNT must be > 0');
          } else if (opt === 'JUSTID') justId = true;
          else throw new ReplyError(SYNTAX);
        }
        const s = this.stream(a[0], false);
        const g = s?.groups.get(a[1]);
        if (s === null || g === undefined)
          throw new ReplyError(`NOGROUP No such key '${a[0]}' or consumer group '${a[1]}'`);
        const consumer = this.consumer(g, a[2], now);
        // Pending entries from `start` on: at most `count` claimed or dropped, at most 10 × `count` looked at.
        const pending = byId(g.pel).filter(([id]) => id >= start);
        const claimed: Reply[] = [];
        const deleted: Reply[] = [];
        let attempts = count * 10;
        let left = count;
        let next = 0;
        while (attempts-- > 0 && left > 0 && next < pending.length) {
          const [id, nack] = pending[next++];
          const entry = findEntry(s, id);
          if (entry === undefined) {
            g.pel.delete(id);
            nack.consumer?.pel.delete(id);
            deleted.push(formatId(id));
            left -= 1;
            continue;
          }
          if (minIdle && now - nack.time < minIdle) continue;
          if (nack.consumer !== consumer) {
            nack.consumer?.pel.delete(id);
            consumer.pel.set(id, nack);
            nack.consumer = consumer;
          }
          nack.time = now;
          if (!justId) nack.count += 1;
          claimed.push(justId ? formatId(id) : entryReply(entry));
          left -= 1;
          consumer.active = now;
        }
        // The cursor: the next pending entry to look at, 0-0 when the scan reached the end.
        return [formatId(pending[next]?.[0] ?? 0n), claimed, deleted];
      }
      case 'xgroup':
        return this.xgroup(a, now);
      case 'xinfo':
        return this.xinfo(a, now);
      default:
        throw new ReplyError(`ERR unknown command '${name}'`);
    }
  }

  /** XREAD and XREADGROUP (xreadCommand): serve what is there, else block or answer nil. */
  private xread(name: string, a: string[], now: number): Reply {
    const xreadgroup = name === 'xreadgroup';
    let timeout = -1;
    let count = 0;
    let streamsAt = 0;
    let groupName: string | null = null;
    let consumerName = '';
    let noack = false;
    for (let i = 0; i < a.length; i++) {
      const opt = a[i].toUpperCase();
      const more = a.length - 1 - i;
      if (opt === 'BLOCK' && more) {
        if (this.caller === 'script')
          throw new ReplyError(`ERR ${name} command is not allowed with BLOCK option from scripts`);
        timeout = blockTimeout(a[++i], false);
      } else if (opt === 'COUNT' && more) count = Math.max(0, int(a[++i]));
      else if (opt === 'STREAMS' && more) {
        streamsAt = i + 1;
        if ((a.length - streamsAt) % 2 !== 0)
          throw new ReplyError(
            `ERR Unbalanced '${name}' list of streams: for each stream key an ID or '${
              xreadgroup ? '>' : '$'
            }' must be specified.`,
          );
        break;
      } else if (opt === 'GROUP' && more >= 2) {
        if (!xreadgroup)
          throw new ReplyError('ERR The GROUP option is only supported by XREADGROUP. You called XREAD instead.');
        groupName = a[i + 1];
        consumerName = a[i + 2];
        i += 2;
      } else if (opt === 'NOACK') {
        if (!xreadgroup)
          throw new ReplyError('ERR The NOACK option is only supported by XREADGROUP. You called XREAD instead.');
        noack = true;
      } else throw new ReplyError(SYNTAX);
    }
    if (streamsAt === 0) throw new ReplyError(SYNTAX);
    if (xreadgroup && groupName === null) throw new ReplyError('ERR Missing GROUP option for XREADGROUP');
    const n = (a.length - streamsAt) / 2;
    const keys = a.slice(streamsAt, streamsAt + n);
    const idArgs = a.slice(streamsAt + n);
    // Entries after these IDs; MAX_ID stands for `>`, the group's next undelivered entries.
    const after: StreamId[] = [];
    const groups: (StreamGroup | null)[] = [];
    for (let i = 0; i < n; i++) {
      const s = this.stream(keys[i], false);
      const g = groupName === null ? null : s?.groups.get(groupName) ?? null;
      if (groupName !== null && g === null)
        throw new ReplyError(
          `NOGROUP No such key '${keys[i]}' or consumer group '${groupName}' in XREADGROUP with GROUP option`,
        );
      groups.push(g);
      if (idArgs[i] === '$') {
        if (xreadgroup)
          throw new ReplyError(
            'ERR The $ ID is meaningless in the context of XREADGROUP: you want to read the history of this consumer by specifying a proper ID, or use the > ID to get new messages. The $ ID would just return an empty result set.',
          );
        after.push(s?.lastId ?? 0n);
      } else if (idArgs[i] === '>') {
        if (!xreadgroup)
          throw new ReplyError(
            'ERR The > ID can be specified only when calling XREADGROUP using the GROUP <group> <consumer> option.',
          );
        after.push(MAX_ID);
      } else after.push(parseStreamId(idArgs[i], 0n, true).id);
    }
    const out: Reply[] = [];
    for (let i = 0; i < n; i++) {
      const s = this.stream(keys[i], false);
      if (s === null) continue;
      const g = groups[i];
      const last = s.nodes[s.nodes.length - 1]?.entries.at(-1)?.id ?? 0n;
      if (g === null) {
        if (s.length > 0 && last > after[i]) out.push([keys[i], this.readEntries(s, after[i] + 1n, count, null, now)]);
        continue;
      }
      const consumer = this.consumer(g, consumerName, now);
      if (after[i] !== MAX_ID) {
        // An explicit ID reads the consumer's own pending entries after it, its history.
        out.push([keys[i], this.readHistory(s, consumer, after[i] + 1n, count, now)]);
      } else if (s.length > 0 && last > g.lastId) {
        const start = g.lastId === MAX_ID ? 0n : g.lastId + 1n;
        out.push([keys[i], this.readEntries(s, start, count, {group: g, consumer, noack}, now)]);
      }
    }
    if (out.length > 0) return out;
    if (timeout === -1) return null;
    // Blocked, `$` stands for the last ID now: run again, the command serves only what comes after it.
    const args = [
      name,
      ...a.slice(0, streamsAt + n),
      ...idArgs.map((arg, i) => (arg === '$' ? formatId(after[i]) : arg)),
    ];
    return this.block(args, keys, 'stream', timeout, xreadgroup);
  }

  /**
   * Entries from `start` on, at most `count` (0: all). Read through a group (streamReplyWithRange),
   * each advances the group's last-delivered ID and read counter and, without NOACK, enters the
   * consumer's pending list (taken from another consumer if XGROUP SETID moved the group back).
   */
  private readEntries(
    s: Stream,
    start: StreamId,
    count: number,
    read: {group: StreamGroup; consumer: StreamConsumer; noack: boolean} | null,
    now: number,
  ): Reply[] {
    const out: Reply[] = [];
    for (const e of streamEntries(s)) {
      if (e.id < start) continue;
      if (read !== null) {
        const {group: g, consumer} = read;
        if (e.id > g.lastId) {
          if (g.entriesRead !== -1 && g.lastId >= firstId(s) && !rangeHasTombstones(s, g.lastId)) g.entriesRead += 1;
          else if (s.entriesAdded) g.entriesRead = estimateEntriesRead(s, e.id);
          g.lastId = e.id;
        }
        if (!read.noack) {
          const nack = g.pel.get(e.id) ?? {consumer, time: now, count: 1};
          if (nack.consumer !== consumer) nack.consumer?.pel.delete(e.id);
          Object.assign(nack, {consumer, time: now, count: 1});
          g.pel.set(e.id, nack);
          consumer.pel.set(e.id, nack);
          consumer.active = now;
        }
      }
      out.push(entryReply(e));
      if (count && out.length === count) break;
    }
    return out;
  }

  /** A consumer's pending entries from `start` on: each delivered again (an entry since deleted shows as nil). */
  private readHistory(s: Stream, consumer: StreamConsumer, start: StreamId, count: number, now: number): Reply[] {
    const out: Reply[] = [];
    for (const [id, nack] of byId(consumer.pel)) {
      if (id < start) continue;
      if (count && out.length >= count) break;
      const entry = findEntry(s, id);
      if (entry === undefined) {
        out.push([formatId(id), null]);
        continue;
      }
      out.push(entryReply(entry));
      nack.time = now;
      nack.count += 1;
    }
    return out;
  }

  /** The group's consumer by that name, created if new; either way it was just seen. */
  private consumer(g: StreamGroup, name: string, now: number): StreamConsumer {
    const consumer = g.consumers.get(name) ?? {name, seen: now, active: -1, pel: new Map()};
    g.consumers.set(name, consumer);
    consumer.seen = now;
    return consumer;
  }

  private xgroup(a: string[], now: number): Reply {
    const sub = subcommand('xgroup', a, {
      create: -5,
      setid: -5,
      destroy: 4,
      createconsumer: 5,
      delconsumer: 5,
      help: 2,
    });
    if (sub === 'help') return help('XGROUP', XGROUP_HELP);
    let mkstream = false;
    let entriesRead = -1;
    for (let i = 4; i < a.length; ) {
      const opt = a[i].toUpperCase();
      if (sub === 'create' && opt === 'MKSTREAM') {
        mkstream = true;
        i += 1;
      } else if ((sub === 'create' || sub === 'setid') && opt === 'ENTRIESREAD' && i + 1 < a.length) {
        entriesRead = int(a[i + 1]);
        if (entriesRead < -1) throw new ReplyError('ERR value for ENTRIESREAD must be positive or -1');
        i += 2;
      } else throw subcommandSyntax('XGROUP', a[0]);
    }
    const s = this.stream(a[1], false);
    if (s === null && !mkstream)
      throw new ReplyError(
        'ERR The XGROUP subcommand requires the key to exist. Note that for CREATE you may want to use the MKSTREAM option to create an empty stream automatically.',
      );
    const g = s?.groups.get(a[2]);
    if (sub === 'create') {
      if (a.length > 7) throw subcommandSyntax('XGROUP', a[0]);
      const id = a[3] === '$' ? s?.lastId ?? 0n : parseStreamId(a[3], 0n, true).id;
      const target = s ?? this.stream(a[1], true);
      if (target.groups.has(a[2])) throw new ReplyError('BUSYGROUP Consumer Group name already exists');
      target.groups.set(a[2], {lastId: id, entriesRead, pel: new Map(), consumers: new Map()});
      return 'OK';
    }
    if (sub === 'destroy') {
      if (s === null || g === undefined) return 0;
      s.groups.delete(a[2]);
      // Clients blocked in XREADGROUP on this group get their NOGROUP error.
      this.signal(a[1]);
      return 1;
    }
    if (s === null || g === undefined)
      throw new ReplyError(`NOGROUP No such consumer group '${a[2]}' for key name '${a[1]}'`);
    if (sub === 'setid') {
      g.lastId = a[3] === '$' ? s.lastId : parseStreamId(a[3], 0n, false).id;
      g.entriesRead = entriesRead;
      return 'OK';
    }
    if (sub === 'createconsumer') {
      if (g.consumers.has(a[3])) return 0;
      g.consumers.set(a[3], {name: a[3], seen: now, active: -1, pel: new Map()});
      return 1;
    }
    // DELCONSUMER: its pending entries leave the group too; the reply counts them.
    const consumer = g.consumers.get(a[3]);
    if (consumer === undefined) return 0;
    for (const id of consumer.pel.keys()) g.pel.delete(id);
    g.consumers.delete(a[3]);
    return consumer.pel.size;
  }

  private xinfo(a: string[], now: number): Reply {
    const sub = subcommand('xinfo', a, {consumers: 4, groups: 3, stream: -3, help: 2});
    if (sub === 'help') return help('XINFO', XINFO_HELP);
    const s = this.stream(a[1], false);
    if (s === null) throw new ReplyError('ERR no such key');
    const groups = [...s.groups].sort(([x], [y]) => (x < y ? -1 : 1));
    if (sub === 'consumers') {
      const g = s.groups.get(a[2]);
      if (g === undefined) throw new ReplyError(`NOGROUP No such consumer group '${a[2]}' for key name '${a[1]}'`);
      return byName(g.consumers).map(c => [
        'name',
        c.name,
        'pending',
        c.pel.size,
        'idle',
        Math.max(0, now - c.seen),
        'inactive',
        c.active === -1 ? -1 : now - c.active,
      ]);
    }
    const lag = (g: StreamGroup): Reply[] => [
      'entries-read',
      g.entriesRead === -1 ? null : g.entriesRead,
      'lag',
      groupLag(s, g),
    ];
    if (sub === 'groups')
      return groups.map(([name, g]) => [
        'name',
        name,
        'consumers',
        g.consumers.size,
        'pending',
        g.pel.size,
        'last-delivered-id',
        formatId(g.lastId),
        ...lag(g),
      ]);
    // STREAM [FULL [COUNT n]]
    const opts = a.slice(2);
    if (
      (opts.length !== 0 && opts.length !== 1 && opts.length !== 3) ||
      (opts.length > 0 && opts[0].toUpperCase() !== 'FULL') ||
      (opts.length === 3 && opts[1].toUpperCase() !== 'COUNT')
    )
      throw subcommandSyntax('XINFO', a[0]);
    const count = opts.length === 3 ? int(opts[2]) : 10;
    const limit = <T>(items: T[]): T[] =>
      count > 0 ? items.slice(0, count) : count === 0 ? items : items.slice(0, 10);
    const entries = streamEntries(s);
    // The radix tree's node count is approximated as one more than its keys (the listpacks).
    const head: Reply[] = [
      'length',
      s.length,
      'radix-tree-keys',
      s.nodes.length,
      'radix-tree-nodes',
      s.nodes.length + 1,
      'last-generated-id',
      formatId(s.lastId),
      'max-deleted-entry-id',
      formatId(s.maxDeletedId),
      'entries-added',
      s.entriesAdded,
      'recorded-first-entry-id',
      formatId(firstId(s)),
    ];
    if (opts.length === 0)
      return [
        ...head,
        'groups',
        s.groups.size,
        'first-entry',
        entries.length > 0 ? entryReply(entries[0]) : null,
        'last-entry',
        entries.length > 0 ? entryReply(entries[entries.length - 1]) : null,
      ];
    return [
      ...head,
      'entries',
      limit(entries).map(entryReply),
      'groups',
      groups.map(([name, g]) => [
        'name',
        name,
        'last-delivered-id',
        formatId(g.lastId),
        ...lag(g),
        'pel-count',
        g.pel.size,
        'pending',
        limit(byId(g.pel)).map(([id, nack]) => [formatId(id), nack.consumer?.name ?? '', nack.time, nack.count]),
        'consumers',
        byName(g.consumers).map(c => [
          'name',
          c.name,
          'seen-time',
          c.seen,
          'active-time',
          c.active,
          'pel-count',
          c.pel.size,
          'pending',
          limit(byId(c.pel)).map(([id, nack]) => [formatId(id), nack.time, nack.count]),
        ]),
      ]),
    ];
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

  /** Delete a key and its expiry. */
  private drop(key: string): void {
    this.data.delete(key);
    this.expires.delete(key);
  }

  /** A *STORE command's result: written over the destination (its TTL gone), or the destination deleted when empty. */
  private store(key: string, value: Value, size: number): number {
    if (size === 0) {
      this.drop(key);
      return 0;
    }
    this.data.set(key, value);
    this.expires.delete(key);
    return size;
  }

  /** LMOVE: the destination's type is checked before anything moves; a source left empty is deleted. */
  private lmove(src: string, dst: string, from: 'LEFT' | 'RIGHT', to: 'LEFT' | 'RIGHT'): string | null {
    const source = this.list(src, false);
    if (source === null) return null;
    const target = this.list(dst, false);
    const v = (from === 'LEFT' ? source.shift() : source.pop()) ?? '';
    const into = target ?? this.list(dst, true);
    to === 'LEFT' ? into.unshift(v) : into.push(v);
    if (source.length === 0) this.drop(src);
    return v;
  }

  private stream(key: string, create: true): Stream;
  private stream(key: string, create: false): Stream | null;
  private stream(key: string, create: boolean): Stream | null {
    const v = this.data.get(key);
    if (v === undefined) {
      if (!create) return null;
      const s = newStream();
      this.data.set(key, {kind: 'stream', value: s});
      return s;
    }
    if (v.kind !== 'stream') throw new ReplyError(WRONGTYPE);
    return v.value;
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

const STREAM_COMMANDS = new Set([
  'xadd',
  'xlen',
  'xrange',
  'xrevrange',
  'xdel',
  'xtrim',
  'xread',
  'xreadgroup',
  'xack',
  'xpending',
  'xclaim',
  'xautoclaim',
  'xgroup',
  'xinfo',
]);

const SYNTAX = 'ERR syntax error';

/** Arity from Redis 7.2's command table, for the commands checked before they run: exact when positive, a minimum when negative. */
const ARITY: Record<string, number> = {
  xadd: -5,
  xlen: 2,
  xrange: -4,
  xrevrange: -4,
  xdel: -3,
  xtrim: -4,
  xread: -4,
  xreadgroup: -7,
  xack: -4,
  xpending: -3,
  xclaim: -6,
  xautoclaim: -6,
  xgroup: -2,
  xinfo: -2,
  linsert: 5,
  lset: 4,
  lpushx: -3,
  rpushx: -3,
  lmove: 5,
  rpoplpush: 3,
  lpos: -3,
  blpop: -3,
  brpop: -3,
  blmove: 6,
  brpoplpush: 4,
  sinter: -2,
  sunion: -2,
  sdiff: -2,
  sinterstore: -3,
  sunionstore: -3,
  sdiffstore: -3,
  smove: 4,
  srandmember: -2,
  smismember: -3,
  zunionstore: -4,
  zinterstore: -4,
  zrandmember: -2,
  zmscore: -3,
  getex: -2,
  msetnx: -3,
  getbit: 3,
  setbit: 4,
  bitcount: -2,
  pfmerge: -2,
  hstrlen: 3,
  hrandfield: -2,
  touch: -2,
  copy: -3,
  object: -2,
};

const arityError = (command: string): ReplyError =>
  new ReplyError(`ERR wrong number of arguments for '${command}' command`);

/** A container command's subcommand (XGROUP, XINFO, OBJECT), lower-cased, after Redis's lookup and arity errors. */
const subcommand = (container: string, a: string[], arities: Record<string, number>): string => {
  const sub = a[0].toLowerCase();
  if (!Object.hasOwn(arities, sub))
    throw new ReplyError(`ERR unknown subcommand '${a[0]}'. Try ${container.toUpperCase()} HELP.`);
  const arity = arities[sub];
  if (arity > 0 ? a.length + 1 !== arity : a.length + 1 < -arity) throw arityError(`${container}|${sub}`);
  return sub;
};

const subcommandSyntax = (container: string, sub: string): ReplyError =>
  new ReplyError(`ERR unknown subcommand or wrong number of arguments for '${sub}'. Try ${container} HELP.`);

/** A container command's HELP reply (addReplyHelp). */
const help = (container: string, lines: string[]): Reply => [
  `${container} <subcommand> [<arg> [value] [opt] ...]. Subcommands are:`,
  ...lines,
  'HELP',
  '    Print this help.',
];

const XGROUP_HELP = [
  'CREATE <key> <groupname> <id|$> [option]',
  '    Create a new consumer group. Options are:',
  '    * MKSTREAM',
  '      Create the empty stream if it does not exist.',
  '    * ENTRIESREAD entries_read',
  "      Set the group's entries_read counter (internal use).",
  'CREATECONSUMER <key> <groupname> <consumer>',
  '    Create a new consumer in the specified group.',
  'DELCONSUMER <key> <groupname> <consumer>',
  '    Remove the specified consumer.',
  'DESTROY <key> <groupname>',
  '    Remove the specified group.',
  'SETID <key> <groupname> <id|$> [ENTRIESREAD entries_read]',
  '    Set the current group ID and entries_read counter.',
];

const XINFO_HELP = [
  'CONSUMERS <key> <groupname>',
  '    Show consumers of <groupname>.',
  'GROUPS <key>',
  '    Show the stream consumer groups.',
  'STREAM <key> [FULL [COUNT <count>]',
  '    Show information about the stream.',
];

const OBJECT_HELP = [
  'ENCODING <key>',
  '    Return the kind of internal representation used in order to store the value',
  '    associated with a <key>.',
  'FREQ <key>',
  '    Return the access frequency index of the <key>. The returned integer is',
  '    proportional to the logarithm of the recent access frequency of the key.',
  'IDLETIME <key>',
  '    Return the idle time of the <key>, that is the approximated number of',
  '    seconds elapsed since the last access to the key.',
  'REFCOUNT <key>',
  '    Return the number of references of the value associated with the specified',
  '    <key>.',
];

/** A string Redis would store as a 64-bit integer (string2ll: no sign but `-`, no leading zeros). */
const isInt64 = (s: string): boolean =>
  /^(0|-?[1-9]\d{0,18})$/.test(s) && BigInt(s) >= -(2n ** 63n) && BigInt(s) < 2n ** 63n;

/**
 * OBJECT ENCODING, from the value's contents and Redis 7.2's default thresholds. Redis does not
 * convert a value back when it shrinks below them again; this answers from the contents now.
 */
const encoding = (v: Value): string => {
  switch (v.kind) {
    case 'string':
      if (v.raw) return 'raw';
      return isInt64(v.value) ? 'int' : v.value.length <= 44 ? 'embstr' : 'raw';
    case 'list':
      // list-max-listpack-size -2: one listpack of up to 8 KB, about two bytes of overhead per element.
      return v.value.reduce((n, e) => n + e.length + 2, 7) <= 8192 ? 'listpack' : 'quicklist';
    case 'set': {
      const members = [...v.value];
      if (members.length <= 512 && members.every(isInt64)) return 'intset';
      return members.length <= 128 && members.every(m => m.length <= 64) ? 'listpack' : 'hashtable';
    }
    case 'hash':
      return v.value.size <= 128 && [...v.value].every(([f, x]) => f.length <= 64 && x.length <= 64)
        ? 'listpack'
        : 'hashtable';
    case 'zset':
      return v.value.size <= 128 && [...v.value.keys()].every(m => m.length <= 64) ? 'listpack' : 'skiplist';
    case 'stream':
      return 'stream';
  }
};

/** SRANDMEMBER/ZRANDMEMBER/HRANDFIELD's count, and their one optional flag (WITHSCORES, WITHVALUES). */
const randomCount = (a: string[], flag: string): number => {
  const count = int(a[1]);
  if (a.length > 3 || (a.length === 3 && a[2].toUpperCase() !== flag)) throw new ReplyError(SYNTAX);
  // WITHSCORES doubles the reply: Redis takes at most LONG_MAX / 2.
  if (a.length === 3 && Math.abs(count) >= 2 ** 62) throw new ReplyError('ERR value is out of range');
  return count;
};

/**
 * Random members, picked deterministically: the first `count` in order (Redis picks at random; a fixed
 * order keeps checks repeatable), and for a negative count, -count picks that repeat in turn.
 */
const pick = <T>(items: T[], count: number): T[] =>
  count >= 0 ? items.slice(0, count) : Array.from({length: -count}, (_, i) => items[i % items.length]);

const listEnd = (arg: string): 'LEFT' | 'RIGHT' => {
  const end = arg.toUpperCase();
  if (end !== 'LEFT' && end !== 'RIGHT') throw new ReplyError(SYNTAX);
  return end;
};

/** A score as Redis replies with it (d2string): shortest round-trip digits, `inf`, `-inf`, `-0`. */
const scoreString = (score: number): string =>
  score === Infinity ? 'inf' : score === -Infinity ? '-inf' : Object.is(score, -0) ? '-0' : String(score);

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

/** A lexicographical bound as ZRANGEBYLEX reads it: `-` and `+` are the ends, `[m` includes m, `(m` excludes it. */
type LexBound = '-' | '+' | {value: string; inclusive: boolean};

const lexBound = (b: string): LexBound => {
  if (b === '-' || b === '+') return b;
  if (b.startsWith('[') || b.startsWith('(')) return {value: b.slice(1), inclusive: b.startsWith('[')};
  throw new ReplyError('ERR min or max not valid string range item');
};

/** Members compare as byte strings (one char per byte here), as Redis compares them with memcmp. */
const lexIn = (member: string, lo: LexBound, hi: LexBound): boolean => {
  const aboveLow = lo === '-' || (lo !== '+' && (lo.inclusive ? member >= lo.value : member > lo.value));
  const belowHigh = hi === '+' || (hi !== '-' && (hi.inclusive ? member <= hi.value : member < hi.value));
  return aboveLow && belowHigh;
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

export type Arg =
  | string
  | number
  | Uint8Array
  | boolean
  | null
  | undefined
  | Arg[]
  | {[field: string]: string | number | boolean | null | undefined};

/** ioredis flattens arguments: arrays inline, plain objects become field/value pairs (`hset('h', {a: 1})`); text and Buffers become byte strings. */
export const flatten = (args: Arg[]): string[] => {
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

  /** `redis.call('set', key, value, 'EX', 60)`: any command by name. Blocking ones (BLPOP, XREAD BLOCK …) wait. */
  async call(command: string, ...args: Arg[]): Promise<unknown> {
    const wire = [wireCommand(command), ...flatten(args)];
    const reply = isBlocking(wire) ? await SERVER.executeBlocking(wire) : SERVER.execute(wire);
    return shapeReply(command, reply);
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

  /**
   * `[error, reply]` per command, as ioredis does. A MULTI pipeline runs atomically on the server
   * (a blocking command there answers at once); in a plain one, a blocking command that waits holds the rest.
   */
  async exec(): Promise<[Error | null, unknown][]> {
    const commands = this.queue.splice(0);
    const wire = commands.map(c => [wireCommand(c[0]), ...c.slice(1)]);
    const replies = this.transactional
      ? SERVER.executeTransaction(wire)
      : wire.some(isBlocking)
      ? await SERVER.executePipelineBlocking(wire)
      : SERVER.executePipeline(wire);
    return replies.map((r, i) => (r instanceof ReplyError ? [r, null] : [null, shapeReply(commands[i][0], r)]));
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
  'zrangebylex',
  'zrevrangebylex',
  'zlexcount',
  'zremrangebylex',
  'zpopmin',
  'zpopmax',
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
  'script',
  'scan',
  'rename',
  'renamenx',
  'expireat',
  'pexpireat',
  'touch',
  'copy',
  'object',
  'getex',
  'msetnx',
  'getbit',
  'setbit',
  'bitcount',
  'pfadd',
  'pfcount',
  'pfmerge',
  'hstrlen',
  'hrandfield',
  'lpushx',
  'rpushx',
  'linsert',
  'lset',
  'lpos',
  'lmove',
  'rpoplpush',
  'blpop',
  'brpop',
  'blmove',
  'brpoplpush',
  'spop',
  'srandmember',
  'smismember',
  'smove',
  'sinter',
  'sinterstore',
  'sunion',
  'sunionstore',
  'sdiff',
  'sdiffstore',
  'zmscore',
  'zrandmember',
  'zunionstore',
  'zinterstore',
  'xadd',
  'xlen',
  'xrange',
  'xrevrange',
  'xdel',
  'xtrim',
  'xread',
  'xreadgroup',
  'xack',
  'xpending',
  'xclaim',
  'xautoclaim',
  'xgroup',
  'xinfo',
]);

export default Redis;
