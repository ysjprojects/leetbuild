/**
 * HTTP for the TypeScript runtime, shaped like Fastify: `const app = Fastify(); app.get('/x/:id',
 * async (request, reply) => …)`, `reply.code(201).header(…).send(…)`, returned values serialised as
 * JSON, thrown errors with a `statusCode` answered with it, hooks (`onRequest`, `preHandler`,
 * `onSend`, `onResponse`, `onError`), encapsulated `register(plugin, {prefix})`, decorators,
 * content-type parsers (`addContentTypeParser('application/octet-stream', {parseAs: 'buffer'}, …)`,
 * the body arriving as the exact bytes sent), pino's logger for `Fastify({logger: true})` (JSON lines
 * on stdout, `request.log` a child carrying `reqId`, the automatic request lines), route `schema`
 * validation of params, body, querystring and headers with Fastify's default Ajv options (`schema.ts`;
 * a 400 `FST_ERR_VALIDATION`, or `request.validationError` with `attachValidation`) and
 * `app.inject(…)` — Fastify's own in-process request, which is also how the harness's `ctx.client`
 * drives the app. No sockets: `listen()` resolves with an address and nothing else happens.
 */
import {type Bytes, Buffer} from './buffer';
import {CLOCK} from './clock';
import {os, PROCESS} from './node';
import {type Validate, compileSchema, isObject} from './schema';

export const STATUS_TEXT: Record<number, string> = {
  200: 'OK',
  201: 'Created',
  202: 'Accepted',
  204: 'No Content',
  301: 'Moved Permanently',
  302: 'Found',
  303: 'See Other',
  304: 'Not Modified',
  307: 'Temporary Redirect',
  308: 'Permanent Redirect',
  400: 'Bad Request',
  401: 'Unauthorized',
  402: 'Payment Required',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  406: 'Not Acceptable',
  408: 'Request Timeout',
  409: 'Conflict',
  410: 'Gone',
  412: 'Precondition Failed',
  413: 'Payload Too Large',
  415: 'Unsupported Media Type',
  422: 'Unprocessable Entity',
  423: 'Locked',
  425: 'Too Early',
  428: 'Precondition Required',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  501: 'Not Implemented',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  504: 'Gateway Timeout',
  507: 'Insufficient Storage',
};

export type Headers = Record<string, string>;

export interface InjectOptions {
  method?: string;
  url: string;
  headers?: Record<string, string | number | string[] | undefined>;
  payload?: unknown;
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
  remoteAddress?: string;
}

export interface InjectResponse {
  json<T = unknown>(): T;
  statusCode: number;
  statusMessage: string;
  headers: Headers;
  body: string;
  payload: string;
  rawPayload: Uint8Array;
}

export class HttpError extends Error {
  statusCode: number;
  constructor(statusCode: number, message?: string) {
    super(message ?? STATUS_TEXT[statusCode] ?? `HTTP ${statusCode}`);
    this.name = 'FastifyError';
    this.statusCode = statusCode;
  }
}

/** Fastify's `httpErrors`-style factories: `throw app.httpErrors.notFound('no such link')`. */
export const httpErrors = {
  badRequest: (m?: string): HttpError => new HttpError(400, m),
  unauthorized: (m?: string): HttpError => new HttpError(401, m),
  paymentRequired: (m?: string): HttpError => new HttpError(402, m),
  forbidden: (m?: string): HttpError => new HttpError(403, m),
  notFound: (m?: string): HttpError => new HttpError(404, m),
  methodNotAllowed: (m?: string): HttpError => new HttpError(405, m),
  conflict: (m?: string): HttpError => new HttpError(409, m),
  gone: (m?: string): HttpError => new HttpError(410, m),
  preconditionFailed: (m?: string): HttpError => new HttpError(412, m),
  payloadTooLarge: (m?: string): HttpError => new HttpError(413, m),
  unsupportedMediaType: (m?: string): HttpError => new HttpError(415, m),
  unprocessableEntity: (m?: string): HttpError => new HttpError(422, m),
  tooManyRequests: (m?: string): HttpError => new HttpError(429, m),
  internalServerError: (m?: string): HttpError => new HttpError(500, m),
  notImplemented: (m?: string): HttpError => new HttpError(501, m),
  badGateway: (m?: string): HttpError => new HttpError(502, m),
  serviceUnavailable: (m?: string): HttpError => new HttpError(503, m),
  gatewayTimeout: (m?: string): HttpError => new HttpError(504, m),
  createError: (statusCode: number, message?: string): HttpError => new HttpError(statusCode, message),
};

const noop = (): void => undefined;

export interface Logger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  debug: (...args: unknown[]) => void;
  trace: (...args: unknown[]) => void;
  fatal: (...args: unknown[]) => void;
  child: (bindings?: Record<string, unknown>) => Logger;
  level: string;
}

/** pino's shape, silent: Fastify's logger is off by default. */
export const silentLogger: Logger = {
  info: noop,
  warn: noop,
  error: noop,
  debug: noop,
  trace: noop,
  fatal: noop,
  child: (): Logger => silentLogger,
  level: 'silent',
};

const LEVELS: Record<string, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
  silent: Infinity,
};

/** pino's `err` serializer: type, message, stack, then the error's own fields (`code`, `statusCode`). */
const serializeError = (error: Error): Record<string, unknown> => {
  const serialized: Record<string, unknown> = {
    type: error.constructor.name,
    message: error.message,
    stack: error.stack,
  };
  return Object.assign(serialized, error);
};

/** pino's printf: `%s %d %i %f %j %o %O %%`; arguments past the placeholders are dropped, as pino drops them. */
const formatMessage = (format: string, args: unknown[]): string => {
  let next = 0;
  return format.replace(/%[sdifjoO%]/g, token => {
    if (token === '%%') return '%';
    if (next >= args.length) return token;
    const value = args[next++];
    if (token === '%d' || token === '%f') return String(Number(value));
    if (token === '%i') return String(Math.floor(Number(value)));
    if (token === '%s' && (typeof value !== 'object' || value === null)) return String(value);
    return JSON.stringify(value) ?? String(value);
  });
};

/**
 * pino as Fastify configures it for `logger: true` (or `{level}`): one JSON line per call on stdout —
 * level, time on the virtual clock, pid, hostname, the child bindings, the merging object, `msg`.
 */
class PinoLogger implements Logger {
  level: string;

  constructor(level: string, private readonly bindings: Record<string, unknown>) {
    this.level = level;
  }

  trace(...args: unknown[]): void {
    this.write(10, args);
  }
  debug(...args: unknown[]): void {
    this.write(20, args);
  }
  info(...args: unknown[]): void {
    this.write(30, args);
  }
  warn(...args: unknown[]): void {
    this.write(40, args);
  }
  error(...args: unknown[]): void {
    this.write(50, args);
  }
  fatal(...args: unknown[]): void {
    this.write(60, args);
  }

  child(bindings: Record<string, unknown> = {}): Logger {
    return new PinoLogger(this.level, {...this.bindings, ...bindings});
  }

  private write(level: number, args: unknown[]): void {
    if (level < (LEVELS[this.level] ?? LEVELS.info)) return;
    const [first, ...rest] = args;
    let merging: Record<string, unknown> = {};
    let message: unknown[] = args;
    if (first instanceof Error) {
      merging = {err: serializeError(first)};
      message = rest.length > 0 ? rest : [first.message];
    } else if (typeof first === 'object' && first !== null) {
      merging = {...first};
      if (merging.err instanceof Error) merging.err = serializeError(merging.err);
      message = rest;
    }
    const [format, ...params] = message;
    const msg = format === undefined ? undefined : typeof format === 'string' ? formatMessage(format, params) : format;
    // `console.log` looked up at each call: the runtime's stdout while a check runs, or a harness's capture.
    console.log(
      JSON.stringify({
        level,
        time: CLOCK.now(),
        pid: PROCESS.pid,
        hostname: os.hostname(),
        ...this.bindings,
        ...merging,
        ...(msg === undefined ? {} : {msg}),
      }),
    );
  }
}

/** Fastify answers a thrown error with its `statusCode` (or `status`) when it carries one. */
const statusOf = (error: Error): number | null => {
  const candidate: unknown = 'statusCode' in error ? error.statusCode : 'status' in error ? error.status : null;
  return typeof candidate === 'number' && candidate >= 400 && candidate <= 599 ? candidate : null;
};

/** Fastify's default error reply: `{statusCode, code, error, message}`, `code` only when the error carries one (`FST_ERR_VALIDATION`). */
const errorPayload = (statusCode: number, error: Error): Record<string, unknown> => {
  const code: unknown = 'code' in error ? error.code : undefined;
  return {
    statusCode,
    ...(code === undefined || code === null ? {} : {code: String(code)}),
    error: STATUS_TEXT[statusCode] ?? 'Error',
    message: error.message,
  };
};

export interface FastifyRequest<P = Record<string, string>, Q = Record<string, string | string[]>, B = unknown> {
  [decorated: string]: unknown;
  id: string;
  method: string;
  url: string;
  /** The route pattern that matched (`/links/:code`). */
  routeOptions: {url: string; method: string};
  params: P;
  query: Q;
  body: B;
  headers: Headers;
  raw: {method: string; url: string; headers: Headers};
  ip: string;
  hostname: string;
  protocol: string;
  log: Logger;
  /** With the route's `attachValidation: true`, the schema validation's error (the handler runs anyway). */
  validationError?: Error;
}

/** Fastify's `req` log serializer; light-my-request's socket has no remote port, so `remotePort` is left out. */
const serializeRequest = (request: FastifyRequest): Record<string, string> => ({
  method: request.method,
  url: request.url,
  hostname: request.hostname,
  remoteAddress: request.ip,
});

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export class FastifyReply {
  [decorated: string]: unknown;
  statusCode = 200;
  sent = false;
  readonly request: FastifyRequest;
  readonly log: Logger;
  /** @internal resolves once `send()` has been called. */
  readonly done: Promise<void>;
  private readonly responseHeaders = new Map<string, string>();
  private payload: unknown = undefined;
  private explicitType = false;
  private hijacked = false;
  private resolveSent!: () => void;

  constructor(request: FastifyRequest) {
    this.request = request;
    this.log = request.log;
    this.done = new Promise<void>(resolve => (this.resolveSent = resolve));
  }

  code(statusCode: number): this {
    this.statusCode = statusCode;
    return this;
  }

  status(statusCode: number): this {
    return this.code(statusCode);
  }

  header(key: string, value: string | number | string[]): this {
    this.responseHeaders.set(key.toLowerCase(), Array.isArray(value) ? value.join(', ') : String(value));
    if (key.toLowerCase() === 'content-type') this.explicitType = true;
    return this;
  }

  headers(values: Record<string, string | number | string[]>): this {
    for (const [k, v] of Object.entries(values)) this.header(k, v);
    return this;
  }

  getHeader(key: string): string | undefined {
    return this.responseHeaders.get(key.toLowerCase());
  }

  getHeaders(): Headers {
    return Object.fromEntries(this.responseHeaders);
  }

  hasHeader(key: string): boolean {
    return this.responseHeaders.has(key.toLowerCase());
  }

  removeHeader(key: string): this {
    this.responseHeaders.delete(key.toLowerCase());
    return this;
  }

  type(contentType: string): this {
    return this.header('content-type', contentType);
  }

  /** `reply.redirect(url, 302)` (Fastify 5) or `reply.redirect(302, url)` (Fastify 4). */
  redirect(a: string | number, b?: string | number): this {
    const url = typeof a === 'string' ? a : String(b);
    const code = typeof a === 'number' ? a : typeof b === 'number' ? b : 302;
    this.header('location', url);
    this.code(code);
    return this.send();
  }

  send(payload?: unknown): this {
    if (this.sent) return this;
    this.sent = true;
    this.payload = payload;
    this.resolveSent();
    return this;
  }

  hijack(): this {
    this.hijacked = true;
    return this;
  }

  callNotFound(): void {
    this.code(404).send({
      message: `Route ${this.request.method}:${this.request.url} not found`,
      error: 'Not Found',
      statusCode: 404,
    });
  }

  /** @internal */
  _payload(): unknown {
    return this.payload;
  }

  /** @internal */
  _typeExplicit(): boolean {
    return this.explicitType;
  }

  /** @internal */
  _hijacked(): boolean {
    return this.hijacked;
  }
}

export type RouteHandler = (request: FastifyRequest, reply: FastifyReply) => unknown;
type HookDone = (error?: Error) => void;
export type Hook = (request: FastifyRequest, reply: FastifyReply, doneOrPayload?: unknown, done?: HookDone) => unknown;
export type ErrorHandler = (
  error: Error & {statusCode?: number; status?: number},
  request: FastifyRequest,
  reply: FastifyReply,
) => unknown;

export type ContentTypeParserDone = (error: Error | null, body?: unknown) => void;
/** `(request, body, done)`, or async `(request, body) => value`; `body` is text or a Buffer per `parseAs`. */
export type ContentTypeParser = (request: FastifyRequest, body: string | Bytes, done: ContentTypeParserDone) => unknown;
export interface ContentTypeParserOptions {
  parseAs?: 'string' | 'buffer';
  bodyLimit?: number;
}

interface Parser {
  /** A lower-cased media type (`'*'` is the catch-all) or a RegExp tested against the media type. */
  type: string | RegExp;
  parseAs: 'string' | 'buffer';
  bodyLimit: number | undefined;
  fn: ContentTypeParser;
  /** Fastify's own JSON and text parsers, which one registration may replace without removing them first. */
  builtin: boolean;
}

const jsonParser: ContentTypeParser = (_request, body) => {
  if (body === '') throw new HttpError(400, "Body cannot be empty when content-type is set to 'application/json'");
  try {
    return JSON.parse(body as string) as unknown;
  } catch {
    throw new HttpError(400, `Unexpected token in JSON at position 0`);
  }
};
const textParser: ContentTypeParser = (_request, body) => body;

const sameType = (a: string | RegExp, b: string | RegExp): boolean =>
  typeof a === 'string' ? a === b : b instanceof RegExp && a.toString() === b.toString();

/** Fastify's FST_ERR_CTP_* errors: an Error with a `code`. */
const ctpError = (code: string, message: string, statusCode = 500): HttpError =>
  Object.assign(new HttpError(statusCode, message), {code});

export interface RouteOptions {
  method: string | string[];
  url: string;
  handler: RouteHandler;
  onRequest?: Hook | Hook[];
  preValidation?: Hook | Hook[];
  preHandler?: Hook | Hook[];
  schema?: unknown;
  /** Fastify's `attachValidation`: a request failing the schema reaches the handler with `request.validationError`. */
  attachValidation?: boolean;
  config?: unknown;
  /** Bytes this route accepts, overriding the server's and the parser's limit. */
  bodyLimit?: number;
}

/** A route's compiled schema, one validator per request part (null: the part is not validated). */
interface RouteValidators {
  params: Validate | null;
  body: Validate | null;
  querystring: Validate | null;
  headers: Validate | null;
}

/** Route `schema` properties Fastify (and @fastify/swagger) read as documentation: they validate nothing there either. */
const SCHEMA_DOCS = new Set([
  'summary',
  'description',
  'tags',
  'operationId',
  'hide',
  'security',
  'consumes',
  'produces',
  'deprecated',
  'externalDocs',
]);

/**
 * Fastify's route schema, compiled at registration as Fastify does: `query` is `querystring`, a part
 * without `type` or `properties` is the shorthand for an object's properties, header names are
 * lower-cased, and a body schema on GET or HEAD is refused. What this runtime cannot enforce (a
 * `response` serializer, a keyword `schema.ts` does not model) is refused here too, never ignored.
 */
const compileRouteSchema = (method: string, url: string, schema: unknown): RouteValidators | null => {
  if (schema === undefined || schema === null) return null;
  if (!isObject(schema)) throw new Error(`${method}:${url}: the route's schema must be an object`);
  const parts: Record<string, unknown> = {...schema};
  if (parts.query !== undefined) {
    if (parts.querystring !== undefined)
      throw Object.assign(new Error(`Schema with 'querystring' already present!`), {code: 'FST_ERR_SCH_DUPLICATE'});
    parts.querystring = parts.query;
    delete parts.query;
  }
  for (const key of Object.keys(parts)) {
    if (key === 'response')
      throw new Error(
        `${method}:${url}: schema.response (Fastify's reply serializer, which drops undeclared fields) is not modelled by this runtime: remove it and shape the reply in the handler`,
      );
    if (!['params', 'body', 'querystring', 'headers'].includes(key) && !SCHEMA_DOCS.has(key))
      throw new Error(
        `${method}:${url}: schema.${key} is not a part Fastify validates (params, body, querystring, headers)`,
      );
  }
  if ((method === 'GET' || method === 'HEAD') && parts.body)
    throw Object.assign(new Error(`Body validation schema for ${method}:${url} route is not supported!`), {
      code: 'FST_ERR_ROUTE_BODY_VALIDATION_SCHEMA_NOT_SUPPORTED',
      statusCode: 500,
    });
  const compile = (part: 'params' | 'body' | 'querystring' | 'headers'): Validate | null => {
    let partSchema = parts[part];
    if (!partSchema) return null;
    if (isObject(partSchema)) {
      if (part === 'body' && partSchema.content !== undefined)
        throw new Error(
          `${method}:${url}: schema.body.content (a schema per content type) is not modelled by this runtime`,
        );
      if (partSchema.type === undefined && partSchema.properties === undefined)
        partSchema = {type: 'object', properties: partSchema};
      if (part === 'headers' && isObject(partSchema)) {
        const headers: Record<string, unknown> = {...partSchema};
        if (Array.isArray(headers.required)) headers.required = headers.required.map(h => String(h).toLowerCase());
        if (isObject(headers.properties))
          headers.properties = Object.fromEntries(
            Object.entries(headers.properties).map(([k, v]) => [k.toLowerCase(), v]),
          );
        partSchema = headers;
      }
    }
    return compileSchema(partSchema, `${method}:${url} schema.${part}`);
  };
  return {
    params: compile('params'),
    body: compile('body'),
    querystring: compile('querystring'),
    headers: compile('headers'),
  };
};

/**
 * Fastify's validation step (after preValidation): params, body, querystring, headers, in that
 * order; the first failure as Fastify's error — `body/duration_s must be <= 14400`, status 400, code
 * FST_ERR_VALIDATION, the Ajv error on `validation` — or null.
 */
const validateRequest = (validators: RouteValidators, request: FastifyRequest): Error | null => {
  const parts: [Validate | null, unknown, string][] = [
    [validators.params, request.params, 'params'],
    [validators.body, request.body, 'body'],
    [validators.querystring, request.query, 'querystring'],
    [validators.headers, request.headers, 'headers'],
  ];
  for (const [validate, value, dataVar] of parts) {
    const failed = validate?.(value === undefined ? null : value) ?? null;
    if (failed !== null)
      return Object.assign(new Error(`${dataVar}${failed.instancePath} ${failed.message}`), {
        statusCode: 400,
        code: 'FST_ERR_VALIDATION',
        validation: [failed],
        validationContext: dataVar,
      });
  }
  return null;
};

interface Route {
  method: string;
  pattern: string;
  segments: string[];
  handler: RouteHandler;
  bodyLimit: number | undefined;
  hooks: Hooks;
  owner: FastifyInstance;
  validators: RouteValidators | null;
  attachValidation: boolean;
}

interface Hooks {
  onRequest: Hook[];
  preValidation: Hook[];
  preHandler: Hook[];
  preSerialization: Hook[];
  onSend: Hook[];
  onResponse: Hook[];
  onError: Hook[];
}

const emptyHooks = (): Hooks => ({
  onRequest: [],
  preValidation: [],
  preHandler: [],
  preSerialization: [],
  onSend: [],
  onResponse: [],
  onError: [],
});

const asArray = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

export type Plugin = (
  instance: FastifyInstance,
  options: Record<string, unknown>,
  done: (error?: Error) => void,
) => unknown;

export interface FastifyOptions {
  [key: string]: unknown;
  logger?: boolean | object;
  trustProxy?: boolean | string | number;
  ignoreTrailingSlash?: boolean;
  caseSensitive?: boolean;
  /** Bytes a request body may have; Fastify's default is 1 MiB (1048576). */
  bodyLimit?: number;
}

let requestCounter = 0;

/** Lets `app.foo = …` decorators and `this` typing coexist. */
export interface FastifyInstance {
  [decorated: string]: unknown;
}

export class FastifyInstance {
  readonly initialConfig: FastifyOptions;
  readonly log: Logger;
  readonly httpErrors = httpErrors;
  readonly server = {
    address: (): {address: string; port: number; family: string} => ({
      address: '127.0.0.1',
      port: 8080,
      family: 'IPv4',
    }),
  };
  private readonly routes: Route[];
  private readonly hooks: Hooks;
  private readonly prefix: string;
  private readonly parent: FastifyInstance | null;
  private errorHandler: ErrorHandler | null = null;
  private notFoundHandler: RouteHandler | null = null;
  private readonly requestDecorations: Record<string, unknown>;
  private readonly replyDecorations: Record<string, unknown>;
  private readonly plugins: Promise<void>[] = [];
  private readonly parsers: Parser[];
  private lastParams: Record<string, string> = {};

  constructor(options: FastifyOptions = {}, parent: FastifyInstance | null = null, prefix = '') {
    this.initialConfig = options;
    this.parent = parent;
    this.prefix = prefix;
    this.routes = parent === null ? [] : parent.routes;
    this.hooks =
      parent === null
        ? emptyHooks()
        : (Object.fromEntries(Object.entries(parent.hooks).map(([k, v]) => [k, [...v]])) as unknown as Hooks);
    this.requestDecorations = parent === null ? {} : {...parent.requestDecorations};
    this.replyDecorations = parent === null ? {} : {...parent.replyDecorations};
    this.errorHandler = parent?.errorHandler ?? null;
    this.notFoundHandler = parent?.notFoundHandler ?? null;
    const logger = options.logger;
    this.log =
      parent?.log ??
      (logger === true || (typeof logger === 'object' && logger !== null)
        ? new PinoLogger(
            typeof logger === 'object' && 'level' in logger && typeof logger.level === 'string' ? logger.level : 'info',
            {},
          )
        : silentLogger);
    this.parsers =
      parent === null
        ? [
            {type: 'application/json', parseAs: 'string', bodyLimit: undefined, fn: jsonParser, builtin: true},
            {type: 'text/plain', parseAs: 'string', bodyLimit: undefined, fn: textParser, builtin: true},
          ]
        : [...parent.parsers];
  }

  // ---- routes ------------------------------------------------------------------------------------

  route(options: RouteOptions): this {
    const hooks = emptyHooks();
    hooks.onRequest = asArray(options.onRequest);
    hooks.preValidation = asArray(options.preValidation);
    hooks.preHandler = asArray(options.preHandler);
    for (const method of asArray(options.method)) {
      const pattern = joinPath(this.prefix, options.url);
      const upper = method.toUpperCase();
      this.routes.push({
        method: upper,
        pattern,
        segments: pattern.split('/').filter(s => s !== ''),
        handler: options.handler,
        bodyLimit: options.bodyLimit,
        hooks,
        owner: this,
        validators: compileRouteSchema(upper, pattern, options.schema),
        attachValidation: options.attachValidation === true,
      });
    }
    return this;
  }

  get(url: string, a: Partial<RouteOptions> | RouteHandler, b?: RouteHandler): this {
    return this.shorthand('GET', url, a, b);
  }
  post(url: string, a: Partial<RouteOptions> | RouteHandler, b?: RouteHandler): this {
    return this.shorthand('POST', url, a, b);
  }
  put(url: string, a: Partial<RouteOptions> | RouteHandler, b?: RouteHandler): this {
    return this.shorthand('PUT', url, a, b);
  }
  patch(url: string, a: Partial<RouteOptions> | RouteHandler, b?: RouteHandler): this {
    return this.shorthand('PATCH', url, a, b);
  }
  delete(url: string, a: Partial<RouteOptions> | RouteHandler, b?: RouteHandler): this {
    return this.shorthand('DELETE', url, a, b);
  }
  head(url: string, a: Partial<RouteOptions> | RouteHandler, b?: RouteHandler): this {
    return this.shorthand('HEAD', url, a, b);
  }
  options(url: string, a: Partial<RouteOptions> | RouteHandler, b?: RouteHandler): this {
    return this.shorthand('OPTIONS', url, a, b);
  }
  all(url: string, a: Partial<RouteOptions> | RouteHandler, b?: RouteHandler): this {
    const handler = typeof a === 'function' ? a : b;
    if (handler === undefined) throw new Error(`app.all('${url}') needs a handler`);
    return this.route({
      ...(typeof a === 'function' ? {} : a),
      method: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'],
      url,
      handler,
    });
  }

  hasRoute(options: {method: string; url: string}): boolean {
    const pattern = joinPath(this.prefix, options.url);
    return this.routes.some(r => r.method === options.method.toUpperCase() && r.pattern === pattern);
  }

  // ---- hooks, handlers, decorators ---------------------------------------------------------------

  addHook(name: keyof Hooks, hook: Hook): this {
    if (!(name in this.hooks)) throw new Error(`unknown hook '${name}'`);
    this.hooks[name].push(hook);
    return this;
  }

  setErrorHandler(handler: ErrorHandler): this {
    this.errorHandler = handler;
    return this;
  }

  setNotFoundHandler(handler: RouteHandler): this {
    this.notFoundHandler = handler;
    return this;
  }

  decorate(name: string, value: unknown): this {
    this[name] = value;
    if (this.parent !== null) this.parent.decorate(name, value);
    return this;
  }

  decorateRequest(name: string, value: unknown): this {
    this.requestDecorations[name] = value;
    return this;
  }

  decorateReply(name: string, value: unknown): this {
    this.replyDecorations[name] = value;
    return this;
  }

  hasDecorator(name: string): boolean {
    return name in this;
  }

  /**
   * `addContentTypeParser(type | types[] | RegExp, [{parseAs, bodyLimit}], parser)`. Without `parseAs`
   * Fastify hands the parser the raw request stream; with no stream here it gets the whole body as a
   * Buffer, as `parseAs: 'buffer'` would.
   */
  addContentTypeParser(
    contentType: string | string[] | RegExp,
    a: ContentTypeParserOptions | ContentTypeParser,
    b?: ContentTypeParser,
  ): this {
    const fn = typeof a === 'function' ? a : b;
    const options = typeof a === 'function' ? {} : a;
    if (fn === undefined)
      throw ctpError('FST_ERR_CTP_INVALID_HANDLER', 'The content type handler param must be a function');
    for (const raw of Array.isArray(contentType) ? contentType : [contentType]) {
      if (typeof raw === 'string' && raw.trim() === '')
        throw ctpError('FST_ERR_CTP_EMPTY_TYPE', 'The content type cannot be an empty string');
      const type = typeof raw === 'string' ? raw.trim().toLowerCase() : raw;
      const existing = this.parsers.findIndex(p => sameType(p.type, type));
      if (existing >= 0 && !this.parsers[existing].builtin)
        throw ctpError('FST_ERR_CTP_ALREADY_PRESENT', `Content type parser '${String(type)}' already present.`);
      if (existing >= 0) this.parsers.splice(existing, 1);
      this.parsers.push({
        type,
        parseAs: options.parseAs ?? 'buffer',
        bodyLimit: options.bodyLimit,
        fn,
        builtin: false,
      });
    }
    return this;
  }

  hasContentTypeParser(contentType: string | RegExp): boolean {
    const type = typeof contentType === 'string' ? contentType.trim().toLowerCase() : contentType;
    return this.parsers.some(p => sameType(p.type, type));
  }

  removeContentTypeParser(contentType: string | RegExp | (string | RegExp)[]): this {
    for (const raw of Array.isArray(contentType) ? contentType : [contentType]) {
      const type = typeof raw === 'string' ? raw.trim().toLowerCase() : raw;
      const at = this.parsers.findIndex(p => sameType(p.type, type));
      if (at >= 0) this.parsers.splice(at, 1);
    }
    return this;
  }

  removeAllContentTypeParser(): this {
    this.parsers.length = 0;
    return this;
  }

  /** `register(plugin, {prefix})`: the plugin's routes and hooks are encapsulated, as in Fastify. */
  register(plugin: Plugin | {default: Plugin}, options: Record<string, unknown> = {}): this {
    const fn = typeof plugin === 'function' ? plugin : plugin.default;
    const prefix = typeof options.prefix === 'string' ? options.prefix : '';
    const child = new FastifyInstance(this.initialConfig, this, joinPath(this.prefix, prefix));
    this.plugins.push(
      new Promise<void>((resolve, reject) => {
        let settled = false;
        const done = (error?: Error): void => {
          if (settled) return;
          settled = true;
          error ? reject(error) : resolve();
        };
        try {
          const out = fn(child, options, done);
          if (out instanceof Promise) out.then(() => done(), done);
          else if (fn.length < 3) done();
        } catch (e) {
          done(e instanceof Error ? e : new Error(String(e)));
        }
      }),
    );
    return this;
  }

  async ready(): Promise<this> {
    await Promise.all(this.plugins);
    if (this.parent !== null) await this.parent.ready();
    return this;
  }

  async after(): Promise<void> {
    await this.ready();
  }

  /** No sockets in this runtime: resolves with an address once the plugins are loaded. */
  async listen(
    options: {port?: number; host?: string} | number = {},
    callback?: (error: Error | null, address: string) => void,
  ): Promise<string> {
    await this.ready();
    const port = typeof options === 'number' ? options : options.port ?? 8080;
    const address = `http://127.0.0.1:${port}`;
    callback?.(null, address);
    return address;
  }

  async close(): Promise<void> {
    // nothing listens on a socket, so there is nothing to close
  }

  // ---- the request path -----------------------------------------------------------------------------

  /** Fastify's in-process request: no socket, the whole pipeline. */
  async inject(options: InjectOptions | string): Promise<InjectResponse> {
    await this.ready();
    const opts = typeof options === 'string' ? {url: options} : options;
    const method = (opts.method ?? 'GET').toUpperCase();
    const parsed = new URL(opts.url, 'http://localhost');
    if (opts.query !== undefined)
      for (const [k, v] of Object.entries(opts.query)) if (v !== undefined) parsed.searchParams.append(k, String(v));
    const headers: Headers = {};
    for (const [k, v] of Object.entries(opts.headers ?? {}))
      if (v !== undefined) headers[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : String(v);
    const rawPayload = opts.payload ?? opts.body;
    let bodyBytes: Uint8Array | undefined;
    if (rawPayload !== undefined && rawPayload !== null) {
      if (typeof rawPayload === 'string') bodyBytes = encoder.encode(rawPayload);
      else if (rawPayload instanceof Uint8Array) bodyBytes = rawPayload;
      else {
        bodyBytes = encoder.encode(JSON.stringify(rawPayload));
        headers['content-type'] ??= 'application/json';
      }
      headers['content-length'] ??= String(bodyBytes.length);
    }
    headers.host ??= 'localhost:80';
    headers['user-agent'] ??= 'lightMyRequest';
    const request = this.buildRequest(method, parsed, headers, opts.remoteAddress);
    const started = CLOCK.now();
    if (this.initialConfig.disableRequestLogging !== true)
      request.log.info({req: serializeRequest(request)}, 'incoming request');
    const reply = new FastifyReply(request);
    Object.assign(reply, this.replyDecorations);
    const route = this.match(method, parsed.pathname);
    if (route !== null) request.routeOptions = {url: route.pattern, method: route.method};
    await this.dispatch(route, request, reply, bodyBytes);
    return this.finish(reply, route?.owner ?? this, request, started);
  }

  private shorthand(method: string, url: string, a: Partial<RouteOptions> | RouteHandler, b?: RouteHandler): this {
    const handler = typeof a === 'function' ? a : b;
    if (handler === undefined) throw new Error(`app.${method.toLowerCase()}('${url}') needs a handler`);
    const options = typeof a === 'function' ? {} : a;
    return this.route({...options, method, url, handler});
  }

  private buildRequest(method: string, url: URL, headers: Headers, remoteAddress: string | undefined): FastifyRequest {
    const query: Record<string, string | string[]> = {};
    for (const [k, v] of url.searchParams) {
      const current = query[k];
      query[k] = current === undefined ? v : Array.isArray(current) ? [...current, v] : [current, v];
    }
    const forwarded = headers['x-forwarded-for'];
    const trustProxy =
      this.initialConfig.trustProxy === true ||
      typeof this.initialConfig.trustProxy === 'string' ||
      typeof this.initialConfig.trustProxy === 'number';
    const ip = trustProxy && forwarded !== undefined ? forwarded.split(',')[0].trim() : remoteAddress ?? '127.0.0.1';
    requestCounter += 1;
    const id = `req-${requestCounter}`;
    const request: FastifyRequest = {
      ...this.requestDecorations,
      id,
      method,
      url: url.pathname + url.search,
      routeOptions: {url: url.pathname, method},
      params: {},
      query,
      body: undefined,
      headers,
      raw: {method, url: url.pathname + url.search, headers},
      ip,
      hostname: headers.host ?? 'localhost',
      protocol: 'http',
      log: this.log.child({reqId: id}),
    };
    return request;
  }

  private match(method: string, pathname: string): Route | null {
    const path = this.initialConfig.ignoreTrailingSlash && pathname.length > 1 ? pathname.replace(/\/$/, '') : pathname;
    const segments = path.split('/').filter(s => s !== '');
    let best: {route: Route; params: Record<string, string>; score: number} | null = null;
    for (const route of this.routes) {
      if (route.method !== method && !(method === 'HEAD' && route.method === 'GET')) continue;
      const params = matchSegments(route.segments, segments);
      if (params === null) continue;
      const score =
        route.segments.filter(s => !s.startsWith(':') && s !== '*').length * 2 +
        route.segments.filter(s => s.startsWith(':')).length;
      if (best === null || score > best.score) best = {route, params, score};
    }
    if (best === null) return null;
    this.lastParams = best.params;
    return best.route;
  }

  private async dispatch(
    route: Route | null,
    request: FastifyRequest,
    reply: FastifyReply,
    bodyBytes: Uint8Array | undefined,
  ): Promise<void> {
    const owner = route?.owner ?? this;
    try {
      if (route === null) {
        const allowed = this.routes.some(
          r =>
            r.segments.length > 0 &&
            matchSegments(
              r.segments,
              request.url
                .split('?')[0]
                .split('/')
                .filter(s => s !== ''),
            ) !== null,
        );
        if (owner.notFoundHandler === null) request.log.info(`Route ${request.method}:${request.url} not found`);
        if (owner.notFoundHandler !== null) await this.runHandler(owner.notFoundHandler, request, reply);
        else if (allowed && !this.routes.some(r => r.pattern === '*'))
          reply.code(404).send({
            message: `Route ${request.method}:${request.url.split('?')[0]} not found`,
            error: 'Not Found',
            statusCode: 404,
          });
        else
          reply.code(404).send({
            message: `Route ${request.method}:${request.url.split('?')[0]} not found`,
            error: 'Not Found',
            statusCode: 404,
          });
        return;
      }
      request.params = {...this.lastParams};
      if (await this.runHooks([...owner.hooks.onRequest, ...route.hooks.onRequest], request, reply)) return;
      const serverLimit = this.initialConfig.bodyLimit ?? 1048576;
      request.body = await parseBody(request, bodyBytes, owner.parsers, serverLimit, route.bodyLimit);
      if (await this.runHooks([...owner.hooks.preValidation, ...route.hooks.preValidation], request, reply)) return;
      const invalid = route.validators === null ? null : validateRequest(route.validators, request);
      if (invalid !== null) {
        if (!route.attachValidation) throw invalid;
        request.validationError = invalid;
      }
      if (await this.runHooks([...owner.hooks.preHandler, ...route.hooks.preHandler], request, reply)) return;
      await this.runHandler(route.handler, request, reply);
    } catch (e) {
      await this.handleError(e, request, reply, owner);
    }
  }

  private async runHandler(handler: RouteHandler, request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const out = await handler(request, reply);
    if (reply.sent || reply._hijacked()) return;
    if (out === reply) return;
    if (out !== undefined) reply.send(out);
    else if (handler.length >= 2) {
      // A callback-style handler sends later; wait for it (bounded by the run's own timeout).
      await reply.done;
    } else reply.send();
  }

  /** Runs hooks in order; true when one of them sent the reply. */
  private async runHooks(hooks: Hook[], request: FastifyRequest, reply: FastifyReply): Promise<boolean> {
    for (const hook of hooks) {
      await runHook(hook, request, reply);
      if (reply.sent) return true;
    }
    return false;
  }

  private async handleError(
    e: unknown,
    request: FastifyRequest,
    reply: FastifyReply,
    owner: FastifyInstance,
  ): Promise<void> {
    const error = e instanceof Error ? e : new Error(String(e));
    const statusCode = statusOf(error) ?? (reply.statusCode >= 400 ? reply.statusCode : 500);
    reply.code(statusCode);
    for (const hook of owner.hooks.onError) {
      try {
        await runHook(hook, request, reply, error);
      } catch {
        // onError hooks cannot change the outcome
      }
    }
    if (owner.errorHandler !== null && !reply.sent) {
      try {
        const out = await owner.errorHandler(error, request, reply);
        if (!reply.sent && out !== undefined && out !== reply) reply.send(out);
        if (!reply.sent) reply.send();
        return;
      } catch (inner) {
        const again = inner instanceof Error ? inner : new Error(String(inner));
        const code = statusOf(again) ?? 500;
        reply.code(code).send(errorPayload(code, again));
        return;
      }
    }
    // Fastify's default error handler logs what it answers: 5xx at error, 4xx at info.
    if (!reply.sent && statusCode >= 500)
      reply.log.error({req: serializeRequest(request), res: {statusCode}, err: error}, error.message);
    else if (!reply.sent) reply.log.info({res: {statusCode}, err: error}, error.message);
    if (!reply.sent) reply.send(errorPayload(statusCode, error));
  }

  private async finish(
    reply: FastifyReply,
    owner: FastifyInstance,
    request: FastifyRequest,
    started: number,
  ): Promise<InjectResponse> {
    let payload = reply._payload();
    if (payload instanceof Error) {
      const error = payload as Error & {statusCode?: number};
      const statusCode = error.statusCode ?? (reply.statusCode >= 400 ? reply.statusCode : 500);
      reply.code(statusCode);
      payload = errorPayload(statusCode, error);
    }
    for (const hook of owner.hooks.preSerialization) {
      const out = await runHook(hook, request, reply, payload);
      if (out !== undefined) payload = out;
    }
    let body: Uint8Array;
    if (payload === undefined || payload === null) body = new Uint8Array();
    else if (payload instanceof Uint8Array) {
      body = payload;
      if (!reply._typeExplicit()) reply.type('application/octet-stream');
    } else if (typeof payload === 'string') {
      body = encoder.encode(payload);
      if (!reply._typeExplicit()) reply.type('text/plain; charset=utf-8');
    } else {
      body = encoder.encode(JSON.stringify(payload));
      if (!reply._typeExplicit()) reply.type('application/json; charset=utf-8');
    }
    for (const hook of owner.hooks.onSend) {
      const out = await runHook(hook, request, reply, decoder.decode(body));
      if (typeof out === 'string') body = encoder.encode(out);
      else if (out instanceof Uint8Array) body = out;
    }
    if (reply.statusCode === 204 || reply.statusCode === 304 || request.method === 'HEAD') body = new Uint8Array();
    if (!reply.hasHeader('content-length')) reply.header('content-length', String(body.length));
    if (body.length === 0 && !reply._typeExplicit()) reply.removeHeader('content-type');
    reply.header('date', new Date(Date.now()).toUTCString());
    if (this.initialConfig.disableRequestLogging !== true)
      reply.log.info({res: {statusCode: reply.statusCode}, responseTime: CLOCK.now() - started}, 'request completed');
    reply.header('connection', 'keep-alive');
    for (const hook of owner.hooks.onResponse) await runHook(hook, request, reply);
    const text = decoder.decode(body);
    return {
      statusCode: reply.statusCode,
      statusMessage: STATUS_TEXT[reply.statusCode] ?? '',
      headers: reply.getHeaders(),
      body: text,
      payload: text,
      rawPayload: body,
      json: <T>(): T => JSON.parse(text) as T,
    };
  }
}

/** `(request, reply, done)` hooks finish through `done`; async hooks when they resolve. */
const runHook = (hook: Hook, request: FastifyRequest, reply: FastifyReply, payload?: unknown): Promise<unknown> =>
  new Promise((resolve, reject) => {
    const expectsDone = payload === undefined ? hook.length >= 3 : hook.length >= 4;
    const done: HookDone = error => (error ? reject(error) : resolve(undefined));
    try {
      const out =
        payload === undefined
          ? hook(request, reply, expectsDone ? done : undefined)
          : hook(request, reply, payload, expectsDone ? done : undefined);
      if (out instanceof Promise) out.then(resolve, reject);
      else if (!expectsDone) resolve(out);
    } catch (e) {
      reject(e);
    }
  });

const joinPath = (prefix: string, url: string): string => {
  const joined = `${prefix.replace(/\/$/, '')}/${url.replace(/^\//, '')}`;
  return joined.length > 1 ? joined.replace(/\/$/, '') : joined;
};

/** `:name` segments bind params, `*` swallows the rest; null when the path does not fit the route. */
const matchSegments = (route: string[], path: string[]): Record<string, string> | null => {
  const params: Record<string, string> = {};
  for (let i = 0; i < route.length; i++) {
    const r = route[i];
    if (r === '*') {
      params['*'] = path.slice(i).join('/');
      return params;
    }
    if (i >= path.length) return null;
    if (r.startsWith(':')) params[r.slice(1)] = decodeURIComponent(path[i]);
    else if (r !== path[i]) return null;
  }
  return route.length === path.length ? params : null;
};

/**
 * Picks the parser as Fastify does — the exact media type, then RegExp parsers in registration
 * order, then the `'*'` catch-all — and lets `+json` types and a body without a content type fall
 * back to the JSON and text parsers. No parser: 415. A parser's error answers with its statusCode, 400 by default.
 * A body over the limit answers 413 before any parser runs: the route's `bodyLimit` when it sets one,
 * else the parser's, else the server's (`limit`), as Fastify resolves them.
 */
const parseBody = async (
  request: FastifyRequest,
  bytes: Uint8Array | undefined,
  parsers: Parser[],
  limit: number,
  routeLimit: number | undefined,
): Promise<unknown> => {
  if (bytes === undefined || request.method === 'GET' || request.method === 'HEAD') return undefined;
  const type = (request.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  const parser =
    parsers.find(p => p.type === type) ??
    parsers.find(p => p.type instanceof RegExp && p.type.test(type)) ??
    parsers.find(p => p.type === '*') ??
    (type.endsWith('+json') ? parsers.find(p => p.type === 'application/json') : undefined) ??
    (type === '' ? parsers.find(p => p.type === 'text/plain') : undefined);
  if (parser === undefined) throw ctpError('FST_ERR_CTP_INVALID_MEDIA_TYPE', `Unsupported Media Type: ${type}`, 415);
  if (bytes.length > (routeLimit ?? parser.bodyLimit ?? limit))
    throw ctpError('FST_ERR_CTP_BODY_TOO_LARGE', 'Request body is too large', 413);
  const body = parser.parseAs === 'string' ? decoder.decode(bytes) : Buffer.from(bytes);
  try {
    return await new Promise<unknown>((resolve, reject) => {
      const out = parser.fn(request, body, (error, value) => (error ? reject(error) : resolve(value)));
      if (out instanceof Promise) out.then(resolve, reject);
      else if (parser.fn.length < 3) resolve(out);
    });
  } catch (e) {
    const error = e instanceof Error ? e : new Error(String(e));
    if (statusOf(error) === null) Object.assign(error, {statusCode: 400});
    throw error;
  }
};

/** `import Fastify from 'fastify'; const app = Fastify({…})`. */
export function fastify(options: FastifyOptions = {}): FastifyInstance {
  return new FastifyInstance(options);
}

export default fastify;
