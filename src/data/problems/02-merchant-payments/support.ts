/**
 * Hand-written support modules the merchant-payments starters import but no step builds:
 * `payments.db` (the runtime's Postgres handle) and `payments.ledger` (the non-idempotent poster
 * step 5 dedupes in front of).
 */
export const supportModules: Record<string, string> = {
  'payments/db.py': `"""The order database: \`async with db.transaction() as cur:\` begins, runs the block, commits
(rolls back when the block raises). \`await cur.execute(sql, params)\` with %s placeholders;
\`await cur.fetchall()\` returns dict rows."""
from leetbuild.db import DB as db

__all__ = ["db"]
`,
  'payments/ledger.py': `"""The ledger: post(event) books one payment.captured event as double-entry rows.

NOT idempotent: posting the same event twice books the money twice. \`posted\` is the journal."""

posted: list[dict] = []


def post(event: dict) -> None:
    """Book the event; every call appends a journal entry, duplicates included."""
    posted.append(dict(event))
`,
};

/** The TypeScript twins: `payments/db` (a `pg` pool on the runtime's Postgres) and `payments/ledger` (the journal). */
export const supportModulesTs: Record<string, string> = {
  'payments/db.ts': `/**
 * The order database: a \`pg\` pool. \`pool.query(sql, params)\` with $1…$n placeholders runs one
 * statement with autocommit; \`const client = await pool.connect()\` checks out a connection for a
 * transaction (\`BEGIN\` … \`COMMIT\` / \`ROLLBACK\`, then \`client.release()\`).
 */
import {Pool} from 'pg';

export const pool = new Pool({connectionString: 'postgres://app@db/app'});
`,
  'payments/ledger.ts': `/**
 * The ledger: \`ledger.post(event)\` books one payment.captured event as double-entry rows.
 *
 * NOT idempotent: posting the same event twice books the money twice. \`ledger.posted\` is the journal.
 */
export interface LedgerEvent {
  event_id: string;
  [field: string]: unknown;
}

export const ledger = {
  posted: [] as LedgerEvent[],
  /** Book the event; every call appends a journal entry, duplicates included. */
  post(event: LedgerEvent): void {
    ledger.posted.push({...event});
  },
};
`,
};

/** The Go twins: `payments/db` (`database/sql` on the runtime's Postgres) and `payments/ledger` (the journal). */
export const supportModulesGo: Record<string, string> = {
  'payments/db/db.go': `// Package db is the order database: Postgres through database/sql and lib/pq.
// Transaction(ctx, fn) begins, runs fn with the transaction, and commits; it rolls back and returns
// fn's error when fn fails. Statements use $1…$n placeholders.
package db

import (
	"context"
	"database/sql"

	_ "github.com/lib/pq"
)

var pool = open()

func open() *sql.DB {
	pool, err := sql.Open("postgres", "postgres://app@db:5432/app?sslmode=disable")
	if err != nil {
		panic(err)
	}
	return pool
}

// Transaction begins, runs fn, commits (rolls back on error).
func Transaction(ctx context.Context, fn func(tx *sql.Tx) error) error {
	tx, err := pool.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	if err := fn(tx); err != nil {
		tx.Rollback()
		return err
	}
	return tx.Commit()
}
`,
  'payments/ledger/ledger.go': `// Package ledger books payment.captured events as double-entry rows: Post(ctx, event).
//
// NOT idempotent: posting the same event twice books the money twice. Posted is the journal.
package ledger

import (
	"context"
	"time"
)

// Event is one payment.captured event, as the outbox relay publishes it.
type Event struct {
	EventID     string    \`json:"event_id"\`
	Type        string    \`json:"type"\`
	MerchantID  string    \`json:"merchant_id"\`
	OrderID     string    \`json:"order_id"\`
	AmountCents int64     \`json:"amount_cents"\`
	Currency    string    \`json:"currency"\`
	CapturedAt  time.Time \`json:"captured_at"\`
}

// Posted is the journal: every event Post booked, duplicates included.
var Posted []Event

// Post books the event; every call appends a journal entry, duplicates included. (A variable, so a
// test can stand in for a ledger whose database is down.)
var Post = func(ctx context.Context, event Event) error {
	Posted = append(Posted, event)
	return nil
}
`,
};
