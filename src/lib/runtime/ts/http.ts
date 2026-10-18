/**
 * HTTP for the TypeScript runtime, shaped like Fastify: `const app = Fastify(); app.get('/x/:id',
 * async (request, reply) => …)`, `reply.code(201).header(…).send(…)`, returned values serialised as
 * JSON, thrown errors with a `statusCode` answered with it, hooks (`onRequest`, `preHandler`,
 * `onSend`, `onResponse`, `onError`), encapsulated `register(plugin, {prefix})`, decorators and
 * `app.inject(…)` — Fastify's own in-process request, which is also how the harness's `ctx.client`
 * drives the app. No sockets: `listen()` resolves with an address and nothing else happens.
 */

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
  child: () => Logger;
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

/** Fastify answers a thrown error with its `statusCode` (or `status`) when it carries one. */
const statusOf = (error: Error): number | null => {
  const candidate: unknown = 'statusCode' in error ? error.statusCode : 'status' in error ? error.status : null;
  return typeof candidate === 'number' && candidate >= 400 && candidate <= 599 ? candidate : null;
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
  log: typeof silentLogger;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export class FastifyReply {
  [decorated: string]: unknown;
  statusCode = 200;
  sent = false;
  readonly request: FastifyRequest;
  readonly log = silentLogger;
  /** @internal resolves once `send()` has been called. */
  readonly done: Promise<void>;
  private readonly responseHeaders = new Map<string, string>();
  private payload: unknown = undefined;
  private explicitType = false;
  private hijacked = false;
  private resolveSent!: () => void;

  constructor(request: FastifyRequest) {
    this.request = request;
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

export interface RouteOptions {
  method: string | string[];
  url: string;
  handler: RouteHandler;
  onRequest?: Hook | Hook[];
  preValidation?: Hook | Hook[];
  preHandler?: Hook | Hook[];
  schema?: unknown;
  config?: unknown;
}

interface Route {
  method: string;
  pattern: string;
  segments: string[];
  handler: RouteHandler;
  hooks: Hooks;
  owner: FastifyInstance;
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
}

let requestCounter = 0;

/** Lets `app.foo = …` decorators and `this` typing coexist. */
export interface FastifyInstance {
  [decorated: string]: unknown;
}

export class FastifyInstance {
  readonly initialConfig: FastifyOptions;
  readonly log = silentLogger;
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
  }

  // ---- routes ------------------------------------------------------------------------------------

  route(options: RouteOptions): this {
    const hooks = emptyHooks();
    hooks.onRequest = asArray(options.onRequest);
    hooks.preValidation = asArray(options.preValidation);
    hooks.preHandler = asArray(options.preHandler);
    for (const method of asArray(options.method)) {
      const pattern = joinPath(this.prefix, options.url);
      this.routes.push({
        method: method.toUpperCase(),
        pattern,
        segments: pattern.split('/').filter(s => s !== ''),
        handler: options.handler,
        hooks,
        owner: this,
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

  addContentTypeParser(): this {
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
    let bodyText: string | undefined;
    if (rawPayload !== undefined && rawPayload !== null) {
      if (typeof rawPayload === 'string') bodyText = rawPayload;
      else if (rawPayload instanceof Uint8Array) bodyText = decoder.decode(rawPayload);
      else {
        bodyText = JSON.stringify(rawPayload);
        headers['content-type'] ??= 'application/json';
      }
      headers['content-length'] ??= String(encoder.encode(bodyText).length);
    }
    headers.host ??= 'localhost:80';
    headers['user-agent'] ??= 'lightMyRequest';
    const request = this.buildRequest(method, parsed, headers, bodyText, opts.remoteAddress);
    const reply = new FastifyReply(request);
    Object.assign(reply, this.replyDecorations);
    const route = this.match(method, parsed.pathname);
    if (route !== null) request.routeOptions = {url: route.pattern, method: route.method};
    await this.dispatch(route, request, reply, bodyText, headers);
    return this.finish(reply, route?.owner ?? this, request);
  }

  private shorthand(method: string, url: string, a: Partial<RouteOptions> | RouteHandler, b?: RouteHandler): this {
    const handler = typeof a === 'function' ? a : b;
    if (handler === undefined) throw new Error(`app.${method.toLowerCase()}('${url}') needs a handler`);
    const options = typeof a === 'function' ? {} : a;
    return this.route({...options, method, url, handler});
  }

  private buildRequest(
    method: string,
    url: URL,
    headers: Headers,
    bodyText: string | undefined,
    remoteAddress: string | undefined,
  ): FastifyRequest {
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
    const request: FastifyRequest = {
      ...this.requestDecorations,
      id: `req-${requestCounter}`,
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
      log: silentLogger,
    };
    void bodyText;
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
    bodyText: string | undefined,
    headers: Headers,
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
      request.body = parseBody(request.method, bodyText, headers);
      if (await this.runHooks([...owner.hooks.preValidation, ...route.hooks.preValidation], request, reply)) return;
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
        reply.code(code).send({statusCode: code, error: STATUS_TEXT[code] ?? 'Error', message: again.message});
        return;
      }
    }
    if (!reply.sent) reply.send({statusCode, error: STATUS_TEXT[statusCode] ?? 'Error', message: error.message});
  }

  private async finish(reply: FastifyReply, owner: FastifyInstance, request: FastifyRequest): Promise<InjectResponse> {
    let payload = reply._payload();
    if (payload instanceof Error) {
      const error = payload as Error & {statusCode?: number};
      const statusCode = error.statusCode ?? (reply.statusCode >= 400 ? reply.statusCode : 500);
      reply.code(statusCode);
      payload = {statusCode, error: STATUS_TEXT[statusCode] ?? 'Error', message: error.message};
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

const parseBody = (method: string, text: string | undefined, headers: Headers): unknown => {
  if (text === undefined || method === 'GET' || method === 'HEAD') return undefined;
  const type = (headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  if (type === 'application/json' || type.endsWith('+json')) {
    if (text === '') throw new HttpError(400, "Body cannot be empty when content-type is set to 'application/json'");
    try {
      return JSON.parse(text);
    } catch {
      throw new HttpError(400, `Unexpected token in JSON at position 0`);
    }
  }
  if (type === 'text/plain' || type === '') return text;
  throw new HttpError(415, `Unsupported Media Type: ${type}`);
};

/** `import Fastify from 'fastify'; const app = Fastify({…})`. */
export function fastify(options: FastifyOptions = {}): FastifyInstance {
  return new FastifyInstance(options);
}

export default fastify;
