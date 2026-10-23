/**
 * Hand-written support module the ledger steps import but no step builds: `ledger.db`, the
 * runtime's Postgres handle holding the `transactions` and `entries` tables.
 */
export const supportModules: Record<string, string> = {
  'ledger/db.py': `"""The ledger database: \`async with db.transaction() as cur:\` begins, runs the block, commits
(rolls back when the block raises). \`await cur.execute(sql, params)\` with %s placeholders;
\`cur.rowcount\` is the affected-row count; \`await cur.fetchall()\` returns dict rows.

Tables:
    transactions (id text primary key, event_id text unique, description text, settles text, posted_at bigint)
    entries      (transaction_id text, account text, currency text, amount bigint, posted_at bigint)
"""
from leetbuild.db import DB as db

__all__ = ["db"]
`,
};

/** The same handle for TypeScript: `ledger/db`, a pg Pool on the runtime's Postgres. */
export const supportModulesTs: Record<string, string> = {
  'ledger/db.ts': `/**
 * The ledger database: \`await pool.query(sql, [params])\` runs one statement ($1… placeholders) and
 * returns \`{rows, rowCount}\`; \`const client = await pool.connect()\` checks the connection out for a
 * transaction — \`BEGIN\`, your statements, \`COMMIT\` (or \`ROLLBACK\`) on the client, then \`client.release()\`.
 *
 * Tables:
 *     transactions (id text primary key, event_id text unique, description text, settles text, posted_at bigint)
 *     entries      (transaction_id text, account text, currency text, amount bigint, posted_at bigint)
 */
import {Pool} from 'pg';

export const pool = new Pool({connectionString: 'postgres://ledger@db/ledger'});
`,
};

/**
 * The same handle for Go: package `ledger/db`, database/sql with lib/pq on the runtime's Postgres.
 * Step 4 runs its inserts in `db.Transaction`, step 6 reads a balance with `db.QueryRow`.
 */
export const supportModulesGo: Record<string, string> = {
  'ledger/db/db.go': `// Package db is the ledger database: Postgres through database/sql and lib/pq.
//
// Tables:
//
//	transactions (id text primary key, event_id text unique, description text, settles text, posted_at bigint)
//	entries      (transaction_id text, account text, currency text, amount bigint, posted_at bigint)
package db

import (
	"context"
	"database/sql"

	_ "github.com/lib/pq"
)

var pool = open()

func open() *sql.DB {
	pool, err := sql.Open("postgres", "postgres://ledger@db/ledger?sslmode=disable")
	if err != nil {
		panic(err)
	}
	return pool
}

// Transaction begins a transaction, runs fn in it and commits. When fn returns an error (or
// panics) it rolls back instead, and returns that error.
func Transaction(ctx context.Context, fn func(tx *sql.Tx) error) error {
	tx, err := pool.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	committed := false
	defer func() {
		if !committed {
			tx.Rollback()
		}
	}()
	if err := fn(tx); err != nil {
		return err
	}
	committed = true
	return tx.Commit()
}

// QueryRow runs one statement (autocommit) that returns at most one row; Scan reads it.
func QueryRow(ctx context.Context, query string, args ...any) *sql.Row {
	return pool.QueryRowContext(ctx, query, args...)
}
`,
};
