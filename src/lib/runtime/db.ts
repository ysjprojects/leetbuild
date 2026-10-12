/**
 * Postgres for the Python runtime: a PGlite instance (real Postgres in WASM) opened on first use.
 * The Python side (`leetbuild.db`) calls `query`/`exec` and gets JSON back; `$n` placeholders and
 * JSON-encoded parameters are what PGlite takes natively.
 */
import type {PGlite} from '@electric-sql/pglite';

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
