/**
 * Postgres for both runtimes: a PGlite instance (real Postgres in WASM) with the pgvector extension,
 * opened on first use. The Python side (`leetbuild.db`) and the TypeScript `pg` model call
 * `query`/`exec` and get JSON back; `$n` placeholders and JSON-encoded parameters are what PGlite
 * takes natively. The browser workers fetch PGlite and pgvector from the CDN; `yarn verify` uses
 * the same versions from node_modules (`node.ts`).
 */
import type {PGlite} from '@electric-sql/pglite';

export const PGLITE_VERSION = '0.5.10';
export const PGVECTOR_VERSION = '0.0.11';
export const PGLITE_URL = `https://cdn.jsdelivr.net/npm/@electric-sql/pglite@${PGLITE_VERSION}/dist/index.js`;
export const PGVECTOR_URL = `https://cdn.jsdelivr.net/npm/@electric-sql/pglite-pgvector@${PGVECTOR_VERSION}/dist/index.js`;

/** Open PGlite from the CDN with pgvector loaded (`CREATE EXTENSION vector` then works), for the workers. */
export async function openPgliteFromCdn(): Promise<PGlite> {
  // Runtime imports on purpose: the workers are bundled without these packages and load them next to Pyodide/esbuild.
  const [pglite, pgvector] = await Promise.all([
    import(/* webpackIgnore: true */ PGLITE_URL) as Promise<typeof import('@electric-sql/pglite')>,
    import(/* webpackIgnore: true */ PGVECTOR_URL) as Promise<typeof import('@electric-sql/pglite-pgvector')>,
  ]);
  return new pglite.PGlite({extensions: {vector: pgvector.vector}});
}

export interface DbBridge {
  /** `SELECT`/`INSERT`/…: JSON `{rows, affected}`. */
  query(sql: string, paramsJson: string): Promise<string>;
  /** DDL and multi-statement scripts, no result. */
  exec(sql: string): Promise<void>;
}

export function createDbBridge(open: () => Promise<PGlite>): DbBridge {
  let db: Promise<PGlite> | null = null;
  const ready = (): Promise<PGlite> => {
    if (db === null) db = open();
    return db;
  };
  return {
    async query(sql, paramsJson) {
      const pg = await ready();
      const result = await pg.query<Record<string, unknown>>(sql, JSON.parse(paramsJson) as unknown[]);
      return JSON.stringify({rows: result.rows, affected: result.affectedRows ?? -1});
    },
    async exec(sql) {
      const pg = await ready();
      await pg.exec(sql);
    },
  };
}
