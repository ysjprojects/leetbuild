/**
 * Postgres for the TypeScript runtime: the same PGlite instance (real Postgres in WASM) the Python
 * runtime uses, behind node-postgres' shape — `new Pool()`, `pool.query(sql, params)` → `{rows,
 * rowCount}`, `const client = await pool.connect(); … client.release()`, `BEGIN`/`COMMIT`/`ROLLBACK`
 * as statements. One session: a checked-out client holds the connection, so a transaction is
 * isolated from the other queries exactly as with a pool of size one. The DB object keeps the
 * query log a DBA would read and lands harness probes right after a matching statement.
 */
import type {DbBridge} from '../db';

export class DatabaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DatabaseError';
  }
}

export interface QueryResult<R = Record<string, unknown>> {
  rows: R[];
  rowCount: number;
  command: string;
  fields: {name: string}[];
}

export interface DbProbe {
  pattern: string;
  fn: () => unknown;
  fired: boolean;
  result: unknown;
  error: unknown;
}

/** Parameters as PGlite takes them: arrays stay arrays (`= ANY($1)`), objects become JSON text, dates ISO strings. */
const plain = (value: unknown): unknown => {
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Uint8Array) return `\\x${[...value].map(b => b.toString(16).padStart(2, '0')).join('')}`;
  if (Array.isArray(value)) return value.map(plain);
  if (value !== null && typeof value === 'object') return JSON.stringify(value);
  if (typeof value === 'bigint') return value.toString();
  return value;
};

const strip = (e: unknown): string => {
  const text = e instanceof Error ? e.message : String(e);
  return text.startsWith('Error: ') ? text.slice(7) : text;
};

export class Db {
  bridge: DbBridge | null = null;
  /** BEGIN / COMMIT / ROLLBACK, in order. */
  events: string[] = [];
  statements: string[] = [];
  /** What the server was asked, in order: `[sql, params]` — the query log a DBA would read. */
  queries: [string, unknown[]][] = [];
  /** Statements the learner's clients ran (the harness's `execute` is not one). */
  learnerStatements = 0;
  probes: DbProbe[] = [];
  private lock: Promise<void> = Promise.resolve();

  clear(): void {
    this.events = [];
    this.statements = [];
    this.queries = [];
    this.probes = [];
    this.learnerStatements = 0;
  }

  /** One statement with autocommit, from the harness; rows as objects keyed by column name. */
  async execute<R = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<R[]> {
    const {rows} = await this.run<R>(sql, params, false, false);
    return rows;
  }

  /** Drop everything and apply `schema` (DDL): the harness calls this before a check that needs tables. */
  async reset(schema = ''): Promise<void> {
    this.clear();
    try {
      await this.ready().exec('DROP SCHEMA public CASCADE; CREATE SCHEMA public;' + schema);
    } catch (e) {
      throw new DatabaseError(strip(e));
    }
  }

  /**
   * Run `fn` once, right after the first statement containing `pattern` (case-insensitive) has run
   * on the server — succeeded or failed — before its caller sees the outcome: a slow write (advance
   * the clock while the transaction is open), a snapshot of the world mid-transaction, or another
   * client acting at that instant.
   */
  after(pattern: string, fn: () => unknown): DbProbe {
    const probe: DbProbe = {pattern: pattern.toLowerCase(), fn, fired: false, result: undefined, error: undefined};
    this.probes.push(probe);
    return probe;
  }

  /** Hold the single connection for the duration of `fn` (what a checked-out pool client does). */
  async withConnection<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.lock;
    let release!: () => void;
    this.lock = new Promise<void>(resolve => (release = resolve));
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /** @internal — the statement path every client goes through; `counted: false` is the harness's own statement. */
  async run<R>(sql: string, params: unknown[], held = false, counted = true): Promise<QueryResult<R>> {
    if (!held) return this.withConnection(() => this.run<R>(sql, params, true, counted));
    if (counted) this.learnerStatements += 1;
    this.statements.push(sql);
    this.queries.push([sql, params]);
    const upper = sql.trim().toUpperCase();
    let out: string;
    try {
      if (params.length === 0 && /;\s*\S/.test(sql.trim().replace(/;\s*$/, ''))) {
        // Several statements in one call (node-postgres' simple protocol allows it): no rows come back.
        await this.ready().exec(sql);
        out = JSON.stringify({rows: [], affected: 0});
      } else out = await this.ready().query(sql, JSON.stringify(params.map(plain)));
    } catch (e) {
      this.fire(sql);
      throw new DatabaseError(strip(e));
    }
    if (upper.startsWith('BEGIN') || upper.startsWith('START TRANSACTION')) this.events.push('BEGIN');
    else if (upper.startsWith('COMMIT') || upper.startsWith('END')) this.events.push('COMMIT');
    else if (upper.startsWith('ROLLBACK') || upper.startsWith('ABORT')) this.events.push('ROLLBACK');
    this.fire(sql);
    const data = JSON.parse(out) as {rows: R[]; affected: number};
    const command = upper.split(/\s+/)[0] ?? '';
    return {
      rows: data.rows,
      rowCount: data.affected >= 0 ? data.affected : data.rows.length,
      command,
      fields: data.rows.length > 0 ? Object.keys(data.rows[0] as object).map(name => ({name})) : [],
    };
  }

  private fire(sql: string): void {
    const lower = sql.toLowerCase();
    for (const probe of this.probes) {
      if (probe.fired || !lower.includes(probe.pattern)) continue;
      probe.fired = true;
      try {
        probe.result = probe.fn();
      } catch (e) {
        probe.error = e;
      }
    }
  }

  private ready(): DbBridge {
    if (this.bridge === null) throw new DatabaseError('the database is not available in this runtime');
    return this.bridge;
  }
}

export const DB = new Db();

// ---- node-postgres surface ---------------------------------------------------------------------------

export interface PoolConfig {
  [key: string]: unknown;
  connectionString?: string;
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
  max?: number;
}

type QueryArg = string | {text: string; values?: unknown[]};

const textOf = (q: QueryArg): string => (typeof q === 'string' ? q : q.text);
const valuesOf = (q: QueryArg, values: unknown[] | undefined): unknown[] =>
  typeof q === 'string' ? values ?? [] : q.values ?? values ?? [];

/** A client checked out of the pool: holds the connection until `release()`. */
export class PoolClient {
  /** @internal resolves when the connection is held. */
  readonly connected: Promise<void>;
  private released = false;
  private releaseConnection: (() => void) | null = null;
  private readonly holding: Promise<void>;

  constructor() {
    let acquired!: () => void;
    const acquiredPromise = new Promise<void>(resolve => (acquired = resolve));
    this.holding = DB.withConnection(
      () =>
        new Promise<void>(resolve => {
          this.releaseConnection = resolve;
          acquired();
        }),
    );
    this.connected = acquiredPromise;
  }

  async query<R = Record<string, unknown>>(q: QueryArg, values?: unknown[]): Promise<QueryResult<R>> {
    if (this.released) throw new DatabaseError('Client was released back to the pool: query after release()');
    await this.connected;
    return DB.run<R>(textOf(q), valuesOf(q, values), true);
  }

  release(): void {
    if (this.released) return;
    this.released = true;
    void this.connected.then(() => this.releaseConnection?.());
  }

  /** The `pg` Client API on a checked-out client: `end()` releases it. */
  async end(): Promise<void> {
    this.release();
    await this.holding;
  }
}

export class Pool {
  readonly options: PoolConfig;
  totalCount = 0;
  idleCount = 0;
  waitingCount = 0;

  constructor(config: PoolConfig = {}) {
    this.options = config;
  }

  /** One statement on a pooled connection (autocommit). */
  async query<R = Record<string, unknown>>(q: QueryArg, values?: unknown[]): Promise<QueryResult<R>> {
    return DB.run<R>(textOf(q), valuesOf(q, values));
  }

  /** Check out a client; `BEGIN`…`COMMIT` on it is a transaction. Release it, or the pool is empty. */
  async connect(): Promise<PoolClient> {
    const client = new PoolClient();
    await client.connected;
    return client;
  }

  async end(): Promise<void> {
    // the single connection belongs to the run, not the pool
  }
  on(): this {
    return this;
  }
}

/** `new Client(config)`; `connect()` holds the connection until `end()`. */
export class Client {
  private client: PoolClient | null = null;
  constructor(readonly config: PoolConfig = {}) {}

  async connect(): Promise<void> {
    if (this.client !== null) return;
    this.client = new PoolClient();
    await this.client.connected;
  }

  async query<R = Record<string, unknown>>(q: QueryArg, values?: unknown[]): Promise<QueryResult<R>> {
    if (this.client === null) throw new DatabaseError('Client has not connected: call connect() first');
    return this.client.query<R>(q, values);
  }

  async end(): Promise<void> {
    await this.client?.end();
    this.client = null;
  }

  on(): this {
    return this;
  }
}

export const types = {
  setTypeParser: (): void => undefined,
  builtins: {INT8: 20, NUMERIC: 1700, TIMESTAMPTZ: 1184},
};

export default {Pool, Client, types, DatabaseError};
