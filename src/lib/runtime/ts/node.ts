/**
 * The slice of Node's standard library the courses' TypeScript reaches for, available to learner
 * code and harnesses as `node:crypto`, `node:assert`, `node:events`, `node:util` (and without the
 * prefix): synchronous hashes (sha256, sha1, md5 — WebCrypto's are async), `randomUUID`/`randomBytes`,
 * `assert` with the usual methods, a small `EventEmitter`, `promisify` and `inspect`.
 */

// ---- crypto ----------------------------------------------------------------------------------------

const encoder = new TextEncoder();

const toBytes = (data: string | Uint8Array): Uint8Array => (typeof data === 'string' ? encoder.encode(data) : data);

const rotr = (x: number, n: number): number => (x >>> n) | (x << (32 - n));
const rotl = (x: number, n: number): number => (x << n) | (x >>> (32 - n));

/** Pads a message as MD5/SHA-1/SHA-256 do (64-byte blocks, 64-bit length), big- or little-endian length. */
const pad = (message: Uint8Array, littleEndian: boolean): DataView => {
  const bitLength = message.length * 8;
  const total = Math.ceil((message.length + 9) / 64) * 64;
  const buffer = new Uint8Array(total);
  buffer.set(message);
  buffer[message.length] = 0x80;
  const view = new DataView(buffer.buffer);
  if (littleEndian) {
    view.setUint32(total - 8, bitLength >>> 0, true);
    view.setUint32(total - 4, Math.floor(bitLength / 0x100000000), true);
  } else {
    view.setUint32(total - 8, Math.floor(bitLength / 0x100000000), false);
    view.setUint32(total - 4, bitLength >>> 0, false);
  }
  return view;
};

const K256 = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98,
  0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8,
  0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819,
  0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
  0xc67178f2,
]);

const sha256 = (message: Uint8Array): Uint8Array => {
  const view = pad(message, false);
  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const w = new Uint32Array(64);
  for (let offset = 0; offset < view.byteLength; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4, false);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + K256[i] + w[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    h[0] += a;
    h[1] += b;
    h[2] += c;
    h[3] += d;
    h[4] += e;
    h[5] += f;
    h[6] += g;
    h[7] += hh;
  }
  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  h.forEach((v, i) => outView.setUint32(i * 4, v, false));
  return out;
};

export const sha1 = (message: Uint8Array): Uint8Array => {
  const view = pad(message, false);
  const h = new Uint32Array([0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0]);
  const w = new Uint32Array(80);
  for (let offset = 0; offset < view.byteLength; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4, false);
    for (let i = 16; i < 80; i++) w[i] = rotl(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
    let [a, b, c, d, e] = h;
    for (let i = 0; i < 80; i++) {
      const [f, k] =
        i < 20
          ? [(b & c) | (~b & d), 0x5a827999]
          : i < 40
          ? [b ^ c ^ d, 0x6ed9eba1]
          : i < 60
          ? [(b & c) | (b & d) | (c & d), 0x8f1bbcdc]
          : [b ^ c ^ d, 0xca62c1d6];
      const t = (rotl(a, 5) + f + e + k + w[i]) >>> 0;
      e = d;
      d = c;
      c = rotl(b, 30);
      b = a;
      a = t;
    }
    h[0] += a;
    h[1] += b;
    h[2] += c;
    h[3] += d;
    h[4] += e;
  }
  const out = new Uint8Array(20);
  const outView = new DataView(out.buffer);
  h.forEach((v, i) => outView.setUint32(i * 4, v, false));
  return out;
};

const MD5_S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 4,
  11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];
const MD5_K = new Uint32Array(Array.from({length: 64}, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000)));

const md5 = (message: Uint8Array): Uint8Array => {
  const view = pad(message, true);
  const h = new Uint32Array([0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476]);
  const m = new Uint32Array(16);
  for (let offset = 0; offset < view.byteLength; offset += 64) {
    for (let i = 0; i < 16; i++) m[i] = view.getUint32(offset + i * 4, true);
    let [a, b, c, d] = h;
    for (let i = 0; i < 64; i++) {
      let f: number;
      let g: number;
      if (i < 16) {
        f = (b & c) | (~b & d);
        g = i;
      } else if (i < 32) {
        f = (d & b) | (~d & c);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        f = b ^ c ^ d;
        g = (3 * i + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = (7 * i) % 16;
      }
      const t = d;
      d = c;
      c = b;
      b = (b + rotl((a + f + MD5_K[i] + m[g]) >>> 0, MD5_S[i])) >>> 0;
      a = t;
    }
    h[0] += a;
    h[1] += b;
    h[2] += c;
    h[3] += d;
  }
  const out = new Uint8Array(16);
  const outView = new DataView(out.buffer);
  h.forEach((v, i) => outView.setUint32(i * 4, v, true));
  return out;
};

const DIGESTS: Record<string, (m: Uint8Array) => Uint8Array> = {sha256, sha1, md5};

const encode = (bytes: Uint8Array, encoding?: string): string | Uint8Array => {
  if (encoding === undefined || encoding === 'buffer') return bytes;
  if (encoding === 'hex') return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
  if (encoding === 'base64') return btoa(String.fromCharCode(...bytes));
  if (encoding === 'base64url')
    return btoa(String.fromCharCode(...bytes))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
  throw new Error(`unsupported digest encoding '${encoding}'`);
};

export class Hash {
  private readonly chunks: Uint8Array[] = [];
  constructor(private readonly algorithm: string) {
    if (!(algorithm.toLowerCase().replace('-', '') in DIGESTS))
      throw new Error(`Digest method not supported: ${algorithm}`);
  }
  update(data: string | Uint8Array): this {
    this.chunks.push(toBytes(data));
    return this;
  }
  digest(encoding?: string): string | Uint8Array {
    const total = this.chunks.reduce((n, c) => n + c.length, 0);
    const message = new Uint8Array(total);
    let offset = 0;
    for (const c of this.chunks) {
      message.set(c, offset);
      offset += c.length;
    }
    return encode(DIGESTS[this.algorithm.toLowerCase().replace('-', '')](message), encoding);
  }
}

const hmac = (algorithm: string, key: string | Uint8Array, message: Uint8Array): Uint8Array => {
  const digest = DIGESTS[algorithm.toLowerCase().replace('-', '')];
  let k = toBytes(key);
  if (k.length > 64) k = digest(k);
  const block = new Uint8Array(64);
  block.set(k);
  const inner = new Uint8Array(64 + message.length);
  const outer = new Uint8Array(64 + (algorithm.includes('256') ? 32 : algorithm.includes('1') ? 20 : 16));
  for (let i = 0; i < 64; i++) {
    inner[i] = block[i] ^ 0x36;
    outer[i] = block[i] ^ 0x5c;
  }
  inner.set(message, 64);
  outer.set(digest(inner), 64);
  return digest(outer);
};

export class Hmac {
  private readonly chunks: Uint8Array[] = [];
  constructor(private readonly algorithm: string, private readonly key: string | Uint8Array) {}
  update(data: string | Uint8Array): this {
    this.chunks.push(toBytes(data));
    return this;
  }
  digest(encoding?: string): string | Uint8Array {
    const message = new Uint8Array(this.chunks.reduce((n, c) => n + c.length, 0));
    let offset = 0;
    for (const c of this.chunks) {
      message.set(c, offset);
      offset += c.length;
    }
    return encode(hmac(this.algorithm, this.key, message), encoding);
  }
}

export const randomBytes = (size: number): Uint8Array => globalThis.crypto.getRandomValues(new Uint8Array(size));

export const randomUUID = (): string => globalThis.crypto.randomUUID();

export const randomInt = (a: number, b?: number): number => {
  const [min, max] = b === undefined ? [0, a] : [a, b];
  return min + Math.floor(Math.random() * (max - min));
};

export const timingSafeEqual = (a: Uint8Array, b: Uint8Array): boolean => {
  if (a.length !== b.length) throw new RangeError('Input buffers must have the same byte length');
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
};

export const crypto = {
  createHash: (algorithm: string): Hash => new Hash(algorithm),
  createHmac: (algorithm: string, key: string | Uint8Array): Hmac => new Hmac(algorithm, key),
  randomBytes,
  randomUUID,
  randomInt,
  timingSafeEqual,
  webcrypto: globalThis.crypto,
  getRandomValues: (array: Uint8Array): Uint8Array => globalThis.crypto.getRandomValues(array),
};

// ---- assert ----------------------------------------------------------------------------------------

export class AssertionError extends Error {
  actual: unknown;
  expected: unknown;
  operator: string;
  constructor(options: {message?: string; actual?: unknown; expected?: unknown; operator?: string}) {
    super(options.message ?? 'Assertion failed');
    this.name = 'AssertionError';
    this.actual = options.actual;
    this.expected = options.expected;
    this.operator = options.operator ?? '';
  }
}

export const inspect = (value: unknown): string => {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'bigint') return `${value}n`;
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  if (value instanceof Map) return `Map(${value.size}) ${inspect([...value.entries()])}`;
  if (value instanceof Set) return `Set(${value.size}) ${inspect([...value])}`;
  if (value instanceof Uint8Array)
    return `<Buffer ${[...value.slice(0, 32)].map(b => b.toString(16).padStart(2, '0')).join(' ')}${
      value.length > 32 ? ' …' : ''
    }>`;
  if (typeof value === 'function') return `[Function: ${value.name || 'anonymous'}]`;
  if (value === undefined) return 'undefined';
  try {
    return (
      JSON.stringify(value, (_, v: unknown) =>
        typeof v === 'bigint' ? `${v}n` : v instanceof Uint8Array ? `<Buffer ${v.length}>` : v,
      ) ?? String(value)
    );
  } catch {
    return String(value);
  }
};

const deepEqual = (a: unknown, b: unknown, strict: boolean): boolean => {
  if (strict ? Object.is(a, b) : a == b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return !strict && a == b;
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (a instanceof Uint8Array && b instanceof Uint8Array) return a.length === b.length && a.every((v, i) => v === b[i]);
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (a instanceof Map && b instanceof Map)
    return a.size === b.size && [...a].every(([k, v]) => b.has(k) && deepEqual(v, b.get(k), strict));
  if (a instanceof Set && b instanceof Set) return a.size === b.size && [...a].every(v => b.has(v));
  if (strict && Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false;
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  if (ka.length !== kb.length) return false;
  return ka.every(
    k => k in (b as object) && deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], strict),
  );
};

type AssertFn = {
  (value: unknown, message?: string | Error): asserts value;
  ok(value: unknown, message?: string | Error): asserts value;
  equal(actual: unknown, expected: unknown, message?: string | Error): void;
  notEqual(actual: unknown, expected: unknown, message?: string | Error): void;
  strictEqual(actual: unknown, expected: unknown, message?: string | Error): void;
  notStrictEqual(actual: unknown, expected: unknown, message?: string | Error): void;
  deepEqual(actual: unknown, expected: unknown, message?: string | Error): void;
  deepStrictEqual(actual: unknown, expected: unknown, message?: string | Error): void;
  notDeepStrictEqual(actual: unknown, expected: unknown, message?: string | Error): void;
  match(value: string, re: RegExp, message?: string | Error): void;
  doesNotMatch(value: string, re: RegExp, message?: string | Error): void;
  fail(message?: string | Error): never;
  throws(fn: () => unknown, expected?: unknown, message?: string): void;
  doesNotThrow(fn: () => unknown, message?: string): void;
  rejects(promise: Promise<unknown> | (() => Promise<unknown>), expected?: unknown, message?: string): Promise<void>;
  doesNotReject(promise: Promise<unknown> | (() => Promise<unknown>), message?: string): Promise<void>;
  AssertionError: typeof AssertionError;
  strict: AssertFn;
};

const fail = (
  message: string | Error | undefined,
  fallback: string,
  actual?: unknown,
  expected?: unknown,
  operator?: string,
): never => {
  if (message instanceof Error) throw message;
  throw new AssertionError({message: message ?? fallback, actual, expected, operator});
};

const matches = (error: unknown, expected: unknown): boolean => {
  if (expected === undefined) return true;
  if (expected instanceof RegExp) return expected.test(error instanceof Error ? error.message : String(error));
  if (typeof expected === 'function') {
    if (expected.prototype !== undefined && error instanceof (expected as new () => unknown)) return true;
    if (expected === Error || expected.prototype instanceof Error) return false;
    return Boolean((expected as (e: unknown) => unknown)(error));
  }
  if (typeof expected === 'object' && expected !== null)
    return Object.entries(expected).every(([k, v]) => {
      const actual = (error as Record<string, unknown>)[k];
      return v instanceof RegExp ? v.test(String(actual)) : deepEqual(actual, v, true);
    });
  return true;
};

const describeExpected = (expected: unknown): string =>
  expected instanceof RegExp
    ? `matching ${expected}`
    : typeof expected === 'function'
    ? `of type ${expected.name}`
    : typeof expected === 'object' && expected !== null
    ? `matching ${inspect(expected)}`
    : '';

const assertFn = ((value: unknown, message?: string | Error): void => {
  if (!value) fail(message, 'The expression evaluated to a falsy value', value, true, '==');
}) as AssertFn;

assertFn.ok = assertFn;
assertFn.equal = (actual, expected, message) => {
  if (actual != expected) fail(message, `${inspect(actual)} == ${inspect(expected)}`, actual, expected, '==');
};
assertFn.notEqual = (actual, expected, message) => {
  if (actual == expected) fail(message, `${inspect(actual)} != ${inspect(expected)}`, actual, expected, '!=');
};
assertFn.strictEqual = (actual, expected, message) => {
  if (!Object.is(actual, expected))
    fail(
      message,
      `Expected values to be strictly equal:\n\n${inspect(actual)} !== ${inspect(expected)}`,
      actual,
      expected,
      'strictEqual',
    );
};
assertFn.notStrictEqual = (actual, expected, message) => {
  if (Object.is(actual, expected))
    fail(
      message,
      `Expected "actual" to be strictly unequal to: ${inspect(expected)}`,
      actual,
      expected,
      'notStrictEqual',
    );
};
assertFn.deepEqual = (actual, expected, message) => {
  if (!deepEqual(actual, expected, false))
    fail(
      message,
      `Expected values to be loosely deep-equal:\n\n${inspect(actual)}\n\nshould loosely deep-equal\n\n${inspect(
        expected,
      )}`,
      actual,
      expected,
      'deepEqual',
    );
};
assertFn.deepStrictEqual = (actual, expected, message) => {
  if (!deepEqual(actual, expected, true))
    fail(
      message,
      `Expected values to be strictly deep-equal:\n\n${inspect(actual)}\n\nshould equal\n\n${inspect(expected)}`,
      actual,
      expected,
      'deepStrictEqual',
    );
};
assertFn.notDeepStrictEqual = (actual, expected, message) => {
  if (deepEqual(actual, expected, true))
    fail(
      message,
      `Expected "actual" not to be strictly deep-equal to: ${inspect(expected)}`,
      actual,
      expected,
      'notDeepStrictEqual',
    );
};
assertFn.match = (value, re, message) => {
  if (typeof value !== 'string' || !re.test(value))
    fail(
      message,
      `The input did not match the regular expression ${re}. Input:\n\n${inspect(value)}`,
      value,
      re,
      'match',
    );
};
assertFn.doesNotMatch = (value, re, message) => {
  if (typeof value === 'string' && re.test(value))
    fail(
      message,
      `The input was expected to not match the regular expression ${re}. Input:\n\n${inspect(value)}`,
      value,
      re,
      'doesNotMatch',
    );
};
assertFn.fail = message => fail(message, 'Failed', undefined, undefined, 'fail');
assertFn.throws = (fn, expected, message) => {
  let threw = false;
  try {
    fn();
  } catch (e) {
    threw = true;
    if (!matches(e, expected)) throw e;
  }
  if (!threw)
    fail(
      typeof expected === 'string' ? expected : message,
      `Missing expected exception${describeExpected(expected) ? ` ${describeExpected(expected)}` : ''}.`,
      undefined,
      expected,
      'throws',
    );
};
assertFn.doesNotThrow = (fn, message) => {
  try {
    fn();
  } catch (e) {
    fail(
      message,
      `Got unwanted exception.\nActual message: "${e instanceof Error ? e.message : String(e)}"`,
      e,
      undefined,
      'doesNotThrow',
    );
  }
};
assertFn.rejects = async (promise, expected, message) => {
  let rejected = false;
  try {
    await (typeof promise === 'function' ? promise() : promise);
  } catch (e) {
    rejected = true;
    if (!matches(e, expected)) throw e;
  }
  if (!rejected)
    fail(
      typeof expected === 'string' ? expected : message,
      `Missing expected rejection${describeExpected(expected) ? ` ${describeExpected(expected)}` : ''}.`,
      undefined,
      expected,
      'rejects',
    );
};
assertFn.doesNotReject = async (promise, message) => {
  try {
    await (typeof promise === 'function' ? promise() : promise);
  } catch (e) {
    fail(
      message,
      `Got unwanted rejection.\nActual message: "${e instanceof Error ? e.message : String(e)}"`,
      e,
      undefined,
      'doesNotReject',
    );
  }
};
assertFn.AssertionError = AssertionError;
assertFn.strict = assertFn;

export const assert = assertFn;

// ---- events ----------------------------------------------------------------------------------------

type Listener = (...args: unknown[]) => void;

export class EventEmitter {
  private listeners = new Map<string | symbol, Listener[]>();
  on(event: string | symbol, listener: Listener): this {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    return this;
  }
  addListener(event: string | symbol, listener: Listener): this {
    return this.on(event, listener);
  }
  once(event: string | symbol, listener: Listener): this {
    const wrapped: Listener = (...args) => {
      this.off(event, wrapped);
      listener(...args);
    };
    return this.on(event, wrapped);
  }
  off(event: string | symbol, listener: Listener): this {
    this.listeners.set(
      event,
      (this.listeners.get(event) ?? []).filter(l => l !== listener),
    );
    return this;
  }
  removeListener(event: string | symbol, listener: Listener): this {
    return this.off(event, listener);
  }
  removeAllListeners(event?: string | symbol): this {
    if (event === undefined) this.listeners.clear();
    else this.listeners.delete(event);
    return this;
  }
  emit(event: string | symbol, ...args: unknown[]): boolean {
    const ls = this.listeners.get(event) ?? [];
    if (ls.length === 0 && event === 'error')
      throw args[0] instanceof Error ? args[0] : new Error(`Unhandled error. (${inspect(args[0])})`);
    for (const l of [...ls]) l(...args);
    return ls.length > 0;
  }
  listenerCount(event: string | symbol): number {
    return (this.listeners.get(event) ?? []).length;
  }
  eventNames(): (string | symbol)[] {
    return [...this.listeners.keys()];
  }
  setMaxListeners(): this {
    return this;
  }
}

/** `once(emitter, 'event')` → resolves with the arguments of the next emission. */
export const once = (emitter: {once: (event: string, fn: Listener) => unknown}, event: string): Promise<unknown[]> =>
  new Promise(resolve => emitter.once(event, (...args) => resolve(args)));

// ---- util ------------------------------------------------------------------------------------------

export const promisify =
  <T>(fn: (...args: unknown[]) => void) =>
  (...args: unknown[]): Promise<T> =>
    new Promise((resolve, reject) =>
      fn(...args, (error: unknown, value: T) => (error ? reject(error) : resolve(value))),
    );

export const format = (template: unknown, ...rest: unknown[]): string => {
  if (typeof template !== 'string')
    return [template, ...rest].map(v => (typeof v === 'string' ? v : inspect(v))).join(' ');
  let i = 0;
  const out = template.replace(/%[sdifjoO%]/g, token => {
    if (token === '%%') return '%';
    if (i >= rest.length) return token;
    const v = rest[i++];
    if (token === '%s') return typeof v === 'string' ? v : inspect(v);
    if (token === '%d' || token === '%i') return String(Math.trunc(Number(v)));
    if (token === '%f') return String(Number(v));
    return inspect(v);
  });
  return [out, ...rest.slice(i).map(v => (typeof v === 'string' ? v : inspect(v)))].join(' ');
};

export const util = {promisify, inspect, format, types: {isPromise: (v: unknown): boolean => v instanceof Promise}};

/** `node:os`: one fixed host identity per runtime, as a container would have (`chat-server-a`). */
export const os = {
  hostname: (): string => 'app-7f3c9d',
  platform: (): string => 'linux',
  arch: (): string => 'x64',
  cpus: (): {model: string; speed: number}[] => [{model: 'virtual', speed: 2400}],
  totalmem: (): number => 4 * 1024 ** 3,
  freemem: (): number => 2 * 1024 ** 3,
  EOL: '\n',
  tmpdir: (): string => '/tmp',
  homedir: (): string => '/home/app',
};

/** `setTimeout` from `node:timers/promises`: the runtime's virtual clock drives it like any timer. */
export const timersPromises = {
  setTimeout: <T>(ms: number, value?: T): Promise<T | undefined> =>
    new Promise(resolve => setTimeout(() => resolve(value), ms)),
  setImmediate: <T>(value?: T): Promise<T | undefined> => new Promise(resolve => setTimeout(() => resolve(value), 0)),
};

/**
 * `process` as the learner's modules see it — the runtime's own, never the host's: signal handlers
 * (`process.on('SIGTERM', …)`), `exit(code)` (recorded, not performed: `exitCode`/`exited` tell the
 * harness; the harness sends signals with `ctx.process.emit('SIGTERM')`), `env`, `nextTick`,
 * `hrtime` on the virtual clock. Reset before every check.
 */
export class RuntimeProcess extends EventEmitter {
  env: Record<string, string | undefined> = {NODE_ENV: 'production'};
  argv: string[] = ['node', 'server.js'];
  exitCode: number | undefined = undefined;
  /** The code `exit()` was called with, or null while the process is running. */
  exited: number | null = null;
  readonly pid = 4242;
  readonly platform = 'linux';
  readonly arch = 'x64';
  readonly version = 'v22.0.0';
  readonly versions = {node: '22.0.0'};
  private readonly startedAt = Date.now();

  reset(): void {
    this.removeAllListeners();
    this.env = {NODE_ENV: 'production'};
    this.exitCode = undefined;
    this.exited = null;
  }

  /** Records the exit and runs `'exit'` listeners; the module keeps running (there is no process to end). */
  exit(code?: number): void {
    const final = code ?? this.exitCode ?? 0;
    if (this.exited === null) {
      this.exited = final;
      this.exitCode = final;
      super.emit('exit', final);
    }
  }

  /** `process.kill(process.pid, 'SIGTERM')` delivers the signal to this process. */
  kill(_pid: number, signal: string | number = 'SIGTERM'): boolean {
    return this.emit(typeof signal === 'number' ? `SIG${signal}` : signal);
  }

  nextTick(fn: (...args: unknown[]) => void, ...args: unknown[]): void {
    queueMicrotask(() => fn(...args));
  }

  cwd(): string {
    return '/work';
  }

  uptime(): number {
    return (Date.now() - this.startedAt) / 1000;
  }

  hrtime(previous?: [number, number]): [number, number] {
    const ms = Date.now();
    const now: [number, number] = [Math.floor(ms / 1000), (ms % 1000) * 1e6];
    if (previous === undefined) return now;
    let s = now[0] - previous[0];
    let ns = now[1] - previous[1];
    if (ns < 0) {
      s -= 1;
      ns += 1e9;
    }
    return [s, ns];
  }

  memoryUsage(): {rss: number; heapTotal: number; heapUsed: number; external: number} {
    return {rss: 96 * 1024 ** 2, heapTotal: 48 * 1024 ** 2, heapUsed: 32 * 1024 ** 2, external: 2 * 1024 ** 2};
  }
}

Object.defineProperty(RuntimeProcess.prototype.hrtime, 'bigint', {
  value: (): bigint => BigInt(Date.now()) * 1000000n,
});

export const PROCESS = new RuntimeProcess();
