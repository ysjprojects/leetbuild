/**
 * gRPC without a network for the TypeScript runtime, shaped like `@grpc/grpc-js` with
 * `@grpc/proto-loader`: `loadSync(file)` parses the course's `.proto` (proto3: messages, enums,
 * scalars, repeated, oneof, nested types, four call types) into a package definition,
 * `loadPackageDefinition` turns it into service constructors, `new Server().addService(…)` installs
 * handlers in a REGISTRY, and a client `new pkg.Svc(target, credentials)` routes calls to the
 * instance at that target (or an any-address peer), with deadlines, latency and injected failures
 * on the virtual clock — the same semantics as the Python transport, so a check grades the same
 * property in both runtimes.
 *
 * Messages are plain objects with proto3 defaults filled in, as proto-loader's `defaults: true`
 * yields; a message crosses the "wire" by a serialise/parse round trip against the declared type,
 * so unknown fields are dropped and a wrong message type fails at the boundary.
 */
import {Buffer} from './buffer';
import {CLOCK} from './clock';

// ---- status --------------------------------------------------------------------------------------

export const status = {
  OK: 0,
  CANCELLED: 1,
  UNKNOWN: 2,
  INVALID_ARGUMENT: 3,
  DEADLINE_EXCEEDED: 4,
  NOT_FOUND: 5,
  ALREADY_EXISTS: 6,
  PERMISSION_DENIED: 7,
  RESOURCE_EXHAUSTED: 8,
  FAILED_PRECONDITION: 9,
  ABORTED: 10,
  OUT_OF_RANGE: 11,
  UNIMPLEMENTED: 12,
  INTERNAL: 13,
  UNAVAILABLE: 14,
  DATA_LOSS: 15,
  UNAUTHENTICATED: 16,
} as const;

export type StatusCode = (typeof status)[keyof typeof status];

const STATUS_NAME = Object.fromEntries(Object.entries(status).map(([k, v]) => [v, k])) as Record<number, string>;

export interface ServiceError extends Error {
  code: StatusCode;
  details: string;
  metadata: Metadata;
}

export class StatusError extends Error implements ServiceError {
  code: StatusCode;
  details: string;
  metadata: Metadata;
  constructor(code: StatusCode, details = '', metadata = new Metadata()) {
    super(`${code} ${STATUS_NAME[code] ?? code}: ${details}`);
    this.name = 'Error';
    this.code = code;
    this.details = details;
    this.metadata = metadata;
  }
}

export class Metadata {
  private readonly map = new Map<string, string[]>();
  set(key: string, value: string): void {
    this.map.set(key.toLowerCase(), [value]);
  }
  add(key: string, value: string): void {
    const k = key.toLowerCase();
    this.map.set(k, [...(this.map.get(k) ?? []), value]);
  }
  get(key: string): string[] {
    return this.map.get(key.toLowerCase()) ?? [];
  }
  getMap(): Record<string, string> {
    return Object.fromEntries([...this.map].map(([k, v]) => [k, v[0]]));
  }
  clone(): Metadata {
    const m = new Metadata();
    for (const [k, v] of this.map) m.map.set(k, [...v]);
    return m;
  }
}

export const credentials = {
  createInsecure: (): {kind: 'insecure'} => ({kind: 'insecure'}),
  createSsl: (): {kind: 'ssl'} => ({kind: 'ssl'}),
};

export const ServerCredentials = {
  createInsecure: (): {kind: 'insecure'} => ({kind: 'insecure'}),
  createSsl: (): {kind: 'ssl'} => ({kind: 'ssl'}),
};

// ---- proto3 parser -------------------------------------------------------------------------------

const SCALARS = new Set<string>([
  'double',
  'float',
  'int32',
  'int64',
  'uint32',
  'uint64',
  'sint32',
  'sint64',
  'fixed32',
  'fixed64',
  'sfixed32',
  'sfixed64',
  'bool',
  'string',
  'bytes',
]);
const LONGS = new Set<string>(['int64', 'uint64', 'sint64', 'fixed64', 'sfixed64']);

interface Field {
  name: string;
  type: string;
  repeated: boolean;
  oneof: string | null;
  mapKey?: string;
}

export interface MessageType {
  kind: 'message';
  name: string;
  fields: Field[];
  nested: Map<string, MessageType | EnumType>;
}

export interface EnumType {
  kind: 'enum';
  name: string;
  values: Record<string, number>;
}

export interface MethodDefinition {
  path: string;
  requestStream: boolean;
  responseStream: boolean;
  originalName: string;
  requestType: MessageType;
  responseType: MessageType;
}

export interface ServiceDefinition {
  [method: string]: MethodDefinition;
}

export interface PackageDefinition {
  [fullName: string]: ServiceDefinition | MessageType | EnumType;
}

const tokenize = (source: string): string[] => {
  const stripped = source.replace(/\/\/[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ');
  return stripped.match(/"[^"]*"|'[^']*'|[A-Za-z_][\w.]*|-?\d+(?:\.\d+)?|[{}=;<>,[\]()]/g) ?? [];
};

/** Parse proto3 text into the types it declares, keyed by fully qualified name. */
export function parseProto(source: string): {
  pkg: string;
  types: Map<string, MessageType | EnumType>;
  services: Map<string, Map<string, {input: string; output: string; requestStream: boolean; responseStream: boolean}>>;
} {
  const tokens = tokenize(source);
  let i = 0;
  let pkg = '';
  const types = new Map<string, MessageType | EnumType>();
  const services = new Map<
    string,
    Map<string, {input: string; output: string; requestStream: boolean; responseStream: boolean}>
  >();
  const peek = (): string | undefined => tokens[i];
  const next = (): string => tokens[i++];
  const expect = (t: string): void => {
    const got = next();
    if (got !== t) throw new Error(`proto: expected '${t}', got '${got}'`);
  };
  const skipBlock = (): void => {
    let depth = 0;
    do {
      const t = next();
      if (t === '{') depth += 1;
      else if (t === '}') depth -= 1;
    } while (depth > 0 && i < tokens.length);
  };
  const skipStatement = (): void => {
    while (i < tokens.length && peek() !== ';' && peek() !== '{') i += 1;
    if (peek() === '{') skipBlock();
    else i += 1;
  };
  const parseEnum = (scope: string): EnumType => {
    const name = next();
    const e: EnumType = {kind: 'enum', name, values: {}};
    expect('{');
    while (peek() !== '}') {
      const t = next();
      if (t === 'option' || t === 'reserved') {
        skipStatement();
        continue;
      }
      expect('=');
      e.values[t] = Number(next());
      if (peek() === '[') while (next() !== ']');
      expect(';');
    }
    expect('}');
    types.set(scope ? `${scope}.${name}` : name, e);
    return e;
  };
  const parseMessage = (scope: string): MessageType => {
    const name = next();
    const full = scope ? `${scope}.${name}` : name;
    const m: MessageType = {kind: 'message', name, fields: [], nested: new Map()};
    types.set(full, m);
    expect('{');
    while (peek() !== '}') {
      const t = next();
      if (t === 'message') {
        const n = parseMessage(full);
        m.nested.set(n.name, n);
      } else if (t === 'enum') {
        const n = parseEnum(full);
        m.nested.set(n.name, n);
      } else if (t === 'option' || t === 'reserved' || t === 'extensions') skipStatement();
      else if (t === 'oneof') {
        const oneof = next();
        expect('{');
        while (peek() !== '}') {
          const type = next();
          const fname = next();
          expect('=');
          next();
          if (peek() === '[') while (next() !== ']');
          expect(';');
          m.fields.push({name: fname, type, repeated: false, oneof});
        }
        expect('}');
      } else if (t === 'map') {
        expect('<');
        const key = next();
        expect(',');
        const value = next();
        expect('>');
        const fname = next();
        expect('=');
        next();
        if (peek() === '[') while (next() !== ']');
        expect(';');
        m.fields.push({name: fname, type: value, repeated: true, oneof: null, mapKey: key});
      } else {
        let repeated = false;
        let type = t;
        if (t === 'repeated' || t === 'optional' || t === 'required') {
          repeated = t === 'repeated';
          type = next();
        }
        const fname = next();
        expect('=');
        next();
        if (peek() === '[') while (next() !== ']');
        expect(';');
        m.fields.push({name: fname, type, repeated, oneof: null});
      }
    }
    expect('}');
    return m;
  };
  while (i < tokens.length) {
    const t = next();
    if (t === 'syntax' || t === 'import' || t === 'option') skipStatement();
    else if (t === 'package') {
      pkg = next();
      expect(';');
    } else if (t === 'message') parseMessage(pkg);
    else if (t === 'enum') parseEnum(pkg);
    else if (t === 'service') {
      const name = next();
      const methods = new Map<
        string,
        {input: string; output: string; requestStream: boolean; responseStream: boolean}
      >();
      expect('{');
      while (peek() !== '}') {
        const k = next();
        if (k === 'option') {
          skipStatement();
          continue;
        }
        if (k !== 'rpc') throw new Error(`proto: unexpected '${k}' in service ${name}`);
        const method = next();
        expect('(');
        let requestStream = false;
        if (peek() === 'stream') {
          requestStream = true;
          next();
        }
        const input = next();
        expect(')');
        expect('returns');
        expect('(');
        let responseStream = false;
        if (peek() === 'stream') {
          responseStream = true;
          next();
        }
        const output = next();
        expect(')');
        if (peek() === '{') skipBlock();
        else expect(';');
        methods.set(method, {input, output, requestStream, responseStream});
      }
      expect('}');
      services.set(pkg ? `${pkg}.${name}` : name, methods);
    } else throw new Error(`proto: unexpected '${t}'`);
  }
  return {pkg, types, services};
}

// ---- messages: defaults and the wire round trip --------------------------------------------------

const resolveType = (
  types: Map<string, MessageType | EnumType>,
  name: string,
  scope: string,
): MessageType | EnumType | null => {
  if (SCALARS.has(name)) return null;
  const parts = scope.split('.');
  for (let d = parts.length; d >= 0; d--) {
    const candidate = [...parts.slice(0, d), name].join('.');
    const hit = types.get(candidate);
    if (hit !== undefined) return hit;
  }
  const hit = types.get(name.replace(/^\./, ''));
  if (hit !== undefined) return hit;
  throw new Error(`proto: unknown type ${name} in ${scope}`);
};

const scalarDefault = (type: string): unknown => {
  if (type === 'string') return '';
  if (type === 'bool') return false;
  if (type === 'bytes') return Buffer.alloc(0);
  if (LONGS.has(type)) return '0';
  return 0;
};

/** Coerce a scalar the way proto-loader hands it to JS: 64-bit integers as decimal strings (`longs: String`). */
const coerceScalar = (type: string, value: unknown): unknown => {
  if (value === undefined || value === null) return scalarDefault(type);
  if (type === 'string') return String(value);
  if (type === 'bool') return Boolean(value);
  if (type === 'bytes') return value instanceof Uint8Array ? Buffer.from(value) : Buffer.from(String(value));
  if (LONGS.has(type)) {
    if (typeof value === 'bigint') return value.toString();
    if (typeof value === 'number') return Number.isInteger(value) ? String(value) : String(Math.trunc(value));
    const s = String(value);
    if (!/^-?\d+$/.test(s))
      throw new StatusError(status.INTERNAL, `${type} field holds a non-integer value ${JSON.stringify(value)}`);
    return s;
  }
  const n = Number(value);
  if (Number.isNaN(n))
    throw new StatusError(status.INTERNAL, `${type} field holds a non-number ${JSON.stringify(value)}`);
  return type === 'double' || type === 'float' ? n : Math.trunc(n);
};

/** The wire round trip: keep declared fields, coerce scalars, fill defaults, recurse into messages; drop everything else. */
export function roundtrip(
  types: Map<string, MessageType | EnumType>,
  type: MessageType,
  scope: string,
  value: unknown,
): Record<string, unknown> {
  const input = value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const out: Record<string, unknown> = {};
  const fullScope = scope ? `${scope}.${type.name}` : type.name;
  for (const field of type.fields) {
    const raw = input[field.name];
    const nested = resolveType(types, field.type, fullScope);
    const one = (v: unknown): unknown => {
      if (nested === null) return coerceScalar(field.type, v);
      if (nested.kind === 'enum') {
        if (typeof v === 'string') return v in nested.values ? v : Object.keys(nested.values)[0];
        const name = Object.entries(nested.values).find(([, n]) => n === Number(v ?? 0))?.[0];
        return name ?? Object.keys(nested.values)[0];
      }
      return roundtrip(types, nested, fullScope.split('.').slice(0, -1).join('.'), v);
    };
    if (field.mapKey !== undefined) {
      const map = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
      out[field.name] = Object.fromEntries(Object.entries(map).map(([k, v]) => [k, one(v)]));
    } else if (field.repeated) out[field.name] = Array.isArray(raw) ? raw.map(one) : [];
    else if (field.oneof !== null) {
      if (raw !== undefined && raw !== null) {
        out[field.name] = one(raw);
        out[field.oneof] = field.name;
      }
    } else out[field.name] = one(raw);
  }
  return out;
}

// ---- the registry: peers, instances, faults, calls ----------------------------------------------

export interface Call {
  path: string;
  request: unknown;
  metadata: Metadata;
  /** Seconds until the deadline the caller attached, or null. */
  timeout: number | null;
  target: string | null;
  started: number;
  code: StatusCode | null;
}

type Handler = (call: ServerCall) => void;

interface Installed {
  handler: Handler;
  method: MethodDefinition;
}

export class Registry {
  handlers = new Map<string, Installed>();
  targeted = new Map<string, Installed>();
  latency = new Map<string, number>();
  failures = new Map<string, {code: StatusCode; details: string}[]>();
  calls: Call[] = [];

  reset(): void {
    this.handlers.clear();
    this.targeted.clear();
    this.latency.clear();
    this.failures.clear();
    this.calls = [];
  }

  register(path: string, installed: Installed, target: string | null): void {
    if (target === null) this.handlers.set(path, installed);
    else this.targeted.set(`${target}${path}`, installed);
  }

  /** Take the instance at `target` down: calls to it fail UNAVAILABLE from now on. */
  stop(target: string): void {
    for (const key of [...this.targeted.keys()]) if (key.startsWith(target + '/')) this.targeted.delete(key);
  }

  find(path: string, target: string | null): Installed | null {
    if (target !== null) {
      const hit = this.targeted.get(`${target}${path}`);
      if (hit !== undefined) return hit;
    }
    return this.handlers.get(path) ?? null;
  }

  /** Every call to `method` ('/pkg.Svc/M' or 'M') takes `seconds` of virtual time — everywhere, or at `target`. */
  setLatency(method: string, seconds: number, target: string | null = null): void {
    this.latency.set(`${target ?? ''}|${this.path(method)}`, seconds);
  }

  /** The next `times` calls to `method` (to `target`, when given) fail with `code` before reaching any handler. */
  fail(method: string, code: StatusCode, details = '', times = 1, target: string | null = null): void {
    const key = `${target ?? ''}|${this.path(method)}`;
    this.failures.set(key, [
      ...(this.failures.get(key) ?? []),
      ...Array.from({length: times}, () => ({code, details})),
    ]);
  }

  callsTo(method: string, target: string | null = null): Call[] {
    const suffix = method.startsWith('/') ? method : '/' + method;
    return this.calls.filter(c => c.path.endsWith(suffix) && (target === null || c.target === target));
  }

  lookupLatency(path: string, target: string | null): number {
    const short = '/' + path.split('/').pop();
    for (const t of target === null ? [''] : [target, ''])
      for (const p of [path, short]) {
        const l = this.latency.get(`${t}|${p}`);
        if (l !== undefined) return l;
      }
    return 0;
  }

  popFailure(path: string, target: string | null): {code: StatusCode; details: string} | null {
    const short = '/' + path.split('/').pop();
    for (const t of target === null ? [''] : [target, ''])
      for (const p of [path, short]) {
        const next = this.failures.get(`${t}|${p}`)?.shift();
        if (next !== undefined) return next;
      }
    return null;
  }

  private path(method: string): string {
    if (method.startsWith('/')) return method;
    const known = [...this.handlers.keys(), ...[...this.targeted.keys()].map(k => k.slice(k.indexOf('/')))];
    return known.find(p => p.endsWith('/' + method)) ?? '/' + method;
  }
}

export const REGISTRY = new Registry();

// ---- server side ---------------------------------------------------------------------------------

type Listener = (...args: unknown[]) => void;

class Emitter {
  private listeners = new Map<string, Listener[]>();
  on(event: string, fn: Listener): this {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), fn]);
    return this;
  }
  once(event: string, fn: Listener): this {
    const wrapped: Listener = (...args) => {
      this.off(event, wrapped);
      fn(...args);
    };
    return this.on(event, wrapped);
  }
  off(event: string, fn: Listener): this {
    this.listeners.set(
      event,
      (this.listeners.get(event) ?? []).filter(l => l !== fn),
    );
    return this;
  }
  removeListener(event: string, fn: Listener): this {
    return this.off(event, fn);
  }
  emit(event: string, ...args: unknown[]): boolean {
    const ls = this.listeners.get(event) ?? [];
    for (const l of [...ls]) l(...args);
    return ls.length > 0;
  }
}

/**
 * What a handler receives: `call.request` (unary / server-streaming), `call.write()`/`call.end()`
 * (streaming responses), `call.on('data' | 'end')` (streaming requests), `call.metadata`,
 * `call.getDeadline()`, `call.cancelled` and `call.on('cancelled')`.
 */
export class ServerCall extends Emitter {
  request: unknown;
  metadata: Metadata;
  cancelled = false;
  private readonly deadline: number | null;
  private ended = false;
  constructor(
    request: unknown,
    metadata: Metadata,
    timeout: number | null,
    private readonly sink: {push: (message: unknown) => void; end: (error?: ServiceError) => void},
  ) {
    super();
    this.request = request;
    this.metadata = metadata;
    this.deadline = timeout === null ? null : CLOCK.now() + timeout * 1000;
  }
  getDeadline(): number | typeof Infinity {
    return this.deadline ?? Infinity;
  }
  getPeer(): string {
    return 'ipv4:127.0.0.1:54321';
  }
  sendMetadata(): void {
    // initial metadata is not modelled; calls carry trailing status only
  }
  write(message: unknown): boolean {
    if (this.ended || this.cancelled) return false;
    this.sink.push(message);
    return true;
  }
  end(): void {
    if (this.ended) return;
    this.ended = true;
    this.sink.end();
  }
  /** `call.emit('error', {code, details})` — grpc-js ends a streaming call with that status. */
  fail(error: Partial<ServiceError> & {code?: number; message?: string}): void {
    if (this.ended) return;
    this.ended = true;
    const code = (error.code ?? status.UNKNOWN) as StatusCode;
    this.sink.end(new StatusError(code, error.details ?? error.message ?? ''));
  }
  /** @internal */
  _cancel(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    this.emit('cancelled');
  }
  /** @internal */
  _isEnded(): boolean {
    return this.ended;
  }
}

export type UnaryHandler = (
  call: ServerCall,
  callback: (error: Partial<ServiceError> | null, response?: unknown, trailer?: Metadata) => void,
) => void;
export type StreamHandler = (call: ServerCall) => void;

export class Server {
  private readonly services: {def: ServiceDefinition; impl: Record<string, UnaryHandler | StreamHandler>}[] = [];
  private readonly target: string | null;
  constructor(_options?: Record<string, unknown>, target: string | null = null) {
    this.target = target;
  }
  addService(def: ServiceDefinition, impl: Record<string, UnaryHandler | StreamHandler>): void {
    this.services.push({def, impl});
    for (const [name, method] of Object.entries(def)) {
      const handler = impl[name] ?? impl[method.originalName];
      if (handler === undefined) continue;
      REGISTRY.register(method.path, {handler: handler as Handler, method}, this.target);
    }
  }
  bindAsync(address: string, _creds: unknown, callback: (error: Error | null, port: number) => void): void {
    const port = Number(address.split(':').pop()) || 0;
    queueMicrotask(() => callback(null, port));
  }
  bind(address: string): number {
    return Number(address.split(':').pop()) || 0;
  }
  start(): void {
    // handlers are live from `addService`; nothing listens on a socket
  }
  tryShutdown(callback: (error?: Error) => void): void {
    callback();
  }
  forceShutdown(): void {
    // handlers stay installed for the run: the harness takes instances down with `stop(target)`
  }
}

// ---- client side ---------------------------------------------------------------------------------

interface ClientCallOptions {
  deadline?: number | Date;
}

/** A client-side streaming call: readable (`on('data')`), writable (`write`/`end`), cancellable. */
export class ClientCall extends Emitter {
  readonly ready: Promise<void>;
  private readonly queue: unknown[] = [];
  private closed = false;
  private cancelledFlag = false;
  private readonly waiters: (() => void)[] = [];
  private serverCall: ServerCall | null = null;
  private requestSink: ((message: unknown) => void) | null = null;
  private requestEnd: (() => void) | null = null;
  private resolveReady!: () => void;
  constructor() {
    super();
    this.ready = new Promise<void>(resolve => (this.resolveReady = resolve));
  }
  get cancelled(): boolean {
    return this.cancelledFlag;
  }
  /** @internal */
  _attach(serverCall: ServerCall, requestSink: ((m: unknown) => void) | null, requestEnd: (() => void) | null): void {
    this.serverCall = serverCall;
    this.requestSink = requestSink;
    this.requestEnd = requestEnd;
    this.resolveReady();
  }
  /** @internal: the server pushed a response. */
  _push(message: unknown): void {
    if (this.closed) return;
    this.queue.push(message);
    this.emit('data', message);
    this.wake();
  }
  /** @internal: the server finished. */
  _end(error?: ServiceError): void {
    if (this.closed) return;
    this.closed = true;
    if (error !== undefined) this.emit('error', error);
    this.emit('status', {code: error?.code ?? status.OK, details: error?.details ?? ''});
    this.emit('end');
    this.wake();
  }
  write(message: unknown): boolean {
    void this.ready.then(() => this.requestSink?.(message));
    return true;
  }
  end(): void {
    void this.ready.then(() => this.requestEnd?.());
  }
  cancel(): void {
    if (this.cancelledFlag) return;
    this.cancelledFlag = true;
    this.serverCall?._cancel();
    this._end(new StatusError(status.CANCELLED, 'Cancelled on client'));
  }

  getPeer(): string {
    return 'ipv4:127.0.0.1:54321';
  }
  /** `for await (const message of call)` — the responses, in order. */
  async *[Symbol.asyncIterator](): AsyncGenerator<unknown> {
    let i = 0;
    for (;;) {
      if (i < this.queue.length) {
        yield this.queue[i++];
        continue;
      }
      if (this.closed) return;
      await new Promise<void>(resolve => this.waiters.push(resolve));
    }
  }
  private wake(): void {
    for (const w of this.waiters.splice(0)) w();
  }
}

const deadlineSeconds = (options: ClientCallOptions | undefined): number | null => {
  const d = options?.deadline;
  if (d === undefined) return null;
  const at = d instanceof Date ? d.getTime() : d;
  return Math.max(0, (at - CLOCK.now()) / 1000);
};

/** The handshake every call goes through: record it, inject faults, find the handler, look up its latency. */
function begin(
  path: string,
  request: unknown,
  metadata: Metadata,
  timeout: number | null,
  target: string | null,
): {call: Call; installed: Installed; latency: number} {
  const call: Call = {path, request, metadata, timeout, target, started: CLOCK.now(), code: null};
  REGISTRY.calls.push(call);
  const failure = REGISTRY.popFailure(path, target);
  if (failure !== null) {
    call.code = failure.code;
    throw new StatusError(failure.code, failure.details || STATUS_NAME[failure.code].toLowerCase());
  }
  const installed = REGISTRY.find(path, target);
  if (installed === null) {
    call.code = status.UNAVAILABLE;
    throw new StatusError(
      status.UNAVAILABLE,
      `No connection established${target ? ` to ${target}` : ''}: nothing serves ${path}`,
    );
  }
  return {call, installed, latency: REGISTRY.lookupLatency(path, target)};
}

const translate = (e: unknown): StatusError => {
  if (e instanceof StatusError) return e;
  if (e !== null && typeof e === 'object' && 'code' in e && typeof e.code === 'number') {
    const details =
      'details' in e && typeof e.details === 'string'
        ? e.details
        : 'message' in e && typeof e.message === 'string'
        ? e.message
        : '';
    return new StatusError(e.code as StatusCode, details);
  }
  return new StatusError(status.UNKNOWN, e instanceof Error ? e.message : String(e));
};

/** Run one method on the client's behalf; returns the ClientCall (unary callers get their callback from it). */
function invoke(
  types: Map<string, MessageType | EnumType>,
  pkg: string,
  method: MethodDefinition,
  target: string,
  request: unknown,
  metadata: Metadata,
  options: ClientCallOptions | undefined,
  requestStream: boolean,
): ClientCall {
  const client = new ClientCall();
  const timeout = deadlineSeconds(options);
  const finish = (error?: ServiceError): void => client._end(error);
  let begun: {call: Call; installed: Installed; latency: number};
  try {
    begun = begin(method.path, request, metadata, timeout, target);
  } catch (e) {
    const err = translate(e);
    client._attach(new ServerCall(null, metadata, timeout, {push: () => undefined, end: () => undefined}), null, null);
    queueMicrotask(() => finish(err));
    return client;
  }
  const {call, installed, latency} = begun;
  const wireIn = (m: unknown): unknown => roundtrip(types, method.requestType, pkg, m);
  const wireOut = (m: unknown): unknown => roundtrip(types, method.responseType, pkg, m);
  const serverCall = new ServerCall(requestStream ? undefined : wireIn(request), metadata.clone(), timeout, {
    push: m => client._push(wireOut(m)),
    end: error => {
      call.code = error?.code ?? status.OK;
      finish(error);
    },
  });
  // Request-stream events written before the handler runs (latency, or a quick writer) wait for it.
  let started = false;
  const pendingRequests: (() => void)[] = [];
  const deliver = (fn: () => void): void => {
    if (started) fn();
    else pendingRequests.push(fn);
  };
  const requestSink = requestStream
    ? (m: unknown): void => deliver(() => void serverCall.emit('data', wireIn(m)))
    : null;
  const requestEnd = requestStream ? (): void => deliver(() => void serverCall.emit('end')) : null;
  client._attach(serverCall, requestSink, requestEnd);
  // grpc-js's `call.emit('error', …)` on the server ends the call with that status.
  const originalEmit = serverCall.emit.bind(serverCall);
  serverCall.emit = (event: string, ...args: unknown[]): boolean => {
    if (event === 'error') {
      serverCall.fail(args[0] as Partial<ServiceError>);
      return true;
    }
    return originalEmit(event, ...args);
  };
  const start = (): void => {
    started = true;
    try {
      if (method.responseStream) (installed.handler as StreamHandler)(serverCall);
      else
        (installed.handler as UnaryHandler)(serverCall, (error, response) => {
          if (serverCall._isEnded()) return;
          if (error !== null && error !== undefined) serverCall.fail(error);
          else {
            serverCall.write(response);
            serverCall.end();
          }
        });
    } catch (e) {
      serverCall.fail(translate(e));
    }
    for (const fn of pendingRequests.splice(0)) fn();
  };
  // Latency elapses on the virtual clock while the caller waits: an awaited call pays for it, a
  // fire-and-forget one does not. A deadline shorter than the latency fails without reaching the handler.
  if (timeout !== null && latency > timeout) {
    void CLOCK.sleep(timeout * 1000).then(() => {
      call.code = status.DEADLINE_EXCEEDED;
      serverCall._cancel();
      finish(new StatusError(status.DEADLINE_EXCEEDED, 'Deadline exceeded'));
    });
  } else if (latency > 0) void CLOCK.sleep(latency * 1000).then(start);
  else queueMicrotask(start);
  return client;
}

type UnaryCallback = (error: ServiceError | null, response?: unknown) => void;

/** `loadPackageDefinition`: service constructors keyed by package path (`pkg.shortener.KeyService`). */
export function loadPackageDefinition(definition: PackageDefinition): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  const types =
    (definition as PackageDefinition & {__types?: Map<string, MessageType | EnumType>}).__types ?? new Map();
  for (const [fullName, entry] of Object.entries(definition)) {
    if (fullName === '__types') continue;
    const parts = fullName.split('.');
    let node = root;
    for (const part of parts.slice(0, -1)) {
      node[part] ??= {};
      node = node[part] as Record<string, unknown>;
    }
    const leaf = parts[parts.length - 1];
    if ('kind' in entry) {
      node[leaf] = entry;
      continue;
    }
    const service = entry;
    const pkg = parts.slice(0, -1).join('.');
    class ServiceClient {
      static readonly service = service;
      readonly target: string;
      constructor(target: string, _credentials?: unknown, _options?: Record<string, unknown>) {
        this.target = target;
        for (const [name, method] of Object.entries(service)) {
          const fn = (...args: unknown[]): unknown => {
            // (request?, metadata?, options?, callback?) in grpc-js's overload order.
            const rest = [...args];
            const request = method.requestStream ? undefined : rest.shift();
            const metadata = rest[0] instanceof Metadata ? (rest.shift() as Metadata) : new Metadata();
            const options =
              rest[0] !== undefined && typeof rest[0] === 'object' && typeof rest[0] !== 'function'
                ? (rest.shift() as ClientCallOptions)
                : undefined;
            const callback = typeof rest[0] === 'function' ? (rest.shift() as UnaryCallback) : undefined;
            const call = invoke(types, pkg, method, this.target, request, metadata, options, method.requestStream);
            if (!method.responseStream) {
              let response: unknown;
              call.on('data', m => (response = m));
              call.on('error', e => callback?.(e as ServiceError));
              call.on('end', () => {
                if (!call.cancelled) callback?.(null, response);
              });
              // Unary calls without a callback: a Promise (as `promisify` would give), for `await stub.M(req)`.
              if (callback === undefined)
                return new Promise((resolve, reject) => {
                  call.on('error', reject);
                  call.on('end', () => resolve(response));
                });
            }
            return call;
          };
          Object.defineProperty(this, name, {value: fn, enumerable: false});
          Object.defineProperty(this, method.originalName, {value: fn, enumerable: false});
        }
      }
      close(): void {
        // no connection to close: calls are routed in-process
      }
      getChannel(): {getTarget: () => string} {
        return {getTarget: () => this.target};
      }
      waitForReady(_deadline: unknown, callback: (error?: Error) => void): void {
        callback();
      }
    }
    node[leaf] = ServiceClient;
  }
  return root;
}

// ---- proto-loader --------------------------------------------------------------------------------

/** Proto files the course provides: `loadSync('keys.proto')` resolves against these. */
export const PROTO_FILES = new Map<string, string>();

const lowerFirst = (s: string): string => s.charAt(0).toLowerCase() + s.slice(1);

/** `@grpc/proto-loader`'s `loadSync(file, options)`: a package definition with `__types` for the runtime. */
export function loadSync(file: string | string[], _options?: Record<string, unknown>): PackageDefinition {
  const files = Array.isArray(file) ? file : [file];
  const definition: PackageDefinition & {__types?: Map<string, MessageType | EnumType>} = {};
  const allTypes = new Map<string, MessageType | EnumType>();
  for (const f of files) {
    const name = f.split('/').pop() ?? f;
    const source = PROTO_FILES.get(name) ?? PROTO_FILES.get(f);
    if (source === undefined)
      throw new Error(
        `ENOENT: no such file or directory, open '${f}' (the course provides: ${
          [...PROTO_FILES.keys()].join(', ') || 'none'
        })`,
      );
    const {types, services} = parseProto(source);
    for (const [k, v] of types) allTypes.set(k, v);
    for (const [k, v] of types) definition[k] = v;
    for (const [fullName, methods] of services) {
      const service: ServiceDefinition = {};
      for (const [method, m] of methods) {
        const req = resolveType(types, m.input, fullName);
        const res = resolveType(types, m.output, fullName);
        if (req === null || req.kind !== 'message' || res === null || res.kind !== 'message')
          throw new Error(`proto: ${fullName}.${method} uses a non-message type`);
        service[method] = {
          path: `/${fullName}/${method}`,
          requestStream: m.requestStream,
          responseStream: m.responseStream,
          originalName: lowerFirst(method),
          requestType: req,
          responseType: res,
        };
      }
      definition[fullName] = service;
    }
  }
  Object.defineProperty(definition, '__types', {value: allTypes, enumerable: false});
  return definition;
}

export async function load(file: string | string[], options?: Record<string, unknown>): Promise<PackageDefinition> {
  return loadSync(file, options);
}

/** Install a peer or an instance from the harness: `serve(pkg.shortener.KeyService.service, impl, target?)`. */
export function serve(
  def: ServiceDefinition,
  impl: Record<string, UnaryHandler | StreamHandler>,
  target: string | null = null,
): Server {
  const server = new Server({}, target);
  server.addService(def, impl);
  return server;
}

export const grpc = {status, Metadata, Server, ServerCredentials, credentials, loadPackageDefinition};
export const protoLoader = {loadSync, load};
