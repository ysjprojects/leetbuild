import type {Step} from '@/lib/types';

// ---- 4. The journal writer: insert or skip ------------------------------------------------------
export const exactlyOnceLedgerStep: Step = {
  id: 'exactly-once-ledger',
  title: 'Write each event into the journal once',
  concept: 'kafka',
  file: 'ledger_writer',
  focus: ['ingest', 'db', 'redis'],
  task: `## Task

The consumer commits after it writes, so a crash in between — or a rebalance, or a producer that
published the same event twice — **redelivers** events. The journal, not the consumer, is where that
is made harmless. \`db\` is provided (\`async with db.transaction() as cur:\` begins, runs your block
and commits, or rolls back when it raises) and so are the tables:

\`\`\`sql
transactions (id text primary key, event_id text unique, description text, settles text, posted_at bigint)
entries      (transaction_id text, account text, currency text, amount bigint, posted_at bigint)
\`\`\`

Implement \`write_transaction(entries, description, event_id=None, posted_at=None, settles=None)\`,
returning the new transaction id — or \`None\` when the event was already in the journal:

- Generate a UUID for the transaction. \`posted_at\` is the **event's own time** when given (the
  consumer passes \`occurred_at\`), and now in milliseconds when not (the API path).
- Inside **one** transaction, insert the \`transactions\` row with
  \`ON CONFLICT (event_id) DO NOTHING\`. If **no row** was inserted the event is a redelivery: return
  \`None\` without touching \`entries\`. Otherwise insert every entry with the same \`posted_at\`.
- API-originated transactions have no event id; a \`NULL\` never conflicts, so they are always written —
  their idempotency lives in step 2.
- After the commit — never inside it — call \`track(transaction_id, posted_at, entries, settles)\`
  (step 5) and \`invalidate(account, currency)\` (step 6) for every entry. A duplicate calls neither.

:::widget delivery-semantics {}

> Out-of-order delivery is fine precisely because rows carry the event's time, not the arrival time: a
> balance "as of Tuesday" is the sum of entries posted up to Tuesday, whenever they reached the journal.
> Stripe's post makes the same point — creation and release events may arrive in any order and from
> different producers, and the flow still clears.`,
  sequence: {
    participants: ['ledger-ingest', 'Postgres', 'clearing', 'balance cache'],
    messages: [
      {from: 'ledger-ingest', to: 'Postgres', label: 'BEGIN', kind: 'sync'},
      {
        from: 'ledger-ingest',
        to: 'Postgres',
        label: 'INSERT transactions (evt_01) ON CONFLICT (event_id) DO NOTHING → 1 row',
        kind: 'sync',
      },
      {from: 'ledger-ingest', to: 'Postgres', label: 'INSERT entries ×2 (posted_at = occurred_at)', kind: 'sync'},
      {from: 'ledger-ingest', to: 'Postgres', label: 'COMMIT', kind: 'sync'},
      {from: 'ledger-ingest', to: 'clearing', label: 'track(tx_7f3a, occurred_at, entries)', kind: 'async'},
      {
        from: 'ledger-ingest',
        to: 'balance cache',
        label: 'invalidate(cash:acquirer, EUR) · invalidate(clearing:payments, EUR)',
        kind: 'async',
      },
      {
        from: 'ledger-ingest',
        to: 'Postgres',
        label: 'INSERT transactions (evt_01) … DO NOTHING → 0 rows (redelivery)',
        kind: 'sync',
      },
      {from: 'Postgres', to: 'ledger-ingest', label: 'None: nothing else happens', kind: 'reply'},
    ],
  },
  hints: [
    'The row count of the first INSERT is the whole decision: `cur.rowcount` (`RowsAffected`, `executeUpdate`, `affected_rows`) is 0 when the conflict clause swallowed the insert. Return right there, still inside the block — an empty transaction commits harmlessly.',
    'One `posted_at` value, computed once before the block, goes into the transaction row and every entry row; the event time is the only thing that makes a balance "as of" a date reproducible.',
    'Hooks go after the `async with` block, not inside: inside, a rollback would leave Redis describing a transaction the journal never got, and a slow Redis would hold the database transaction open.',
  ],
  checks: [
    {
      id: 'unique-event-id',
      title: 'A redelivered event is recognised by its id',
      detail:
        'Insert the `transactions` row with `ON CONFLICT (event_id) DO NOTHING` (or a pre-check on `event_id`); a second write of the same event id returns `None` and leaves one row.',
      match: {
        python: {
          all: [
            /INSERT INTO transactions/,
            /ON CONFLICT \(event_id\) DO NOTHING|SELECT[^\n]*FROM transactions WHERE event_id/,
          ],
        },
        typescript: {
          all: [
            /INSERT INTO transactions/,
            /ON CONFLICT \(event_id\) DO NOTHING|SELECT[^\n]*FROM transactions WHERE event_id/,
          ],
        },
        go: {
          all: [
            /INSERT INTO transactions/,
            /ON CONFLICT \(event_id\) DO NOTHING|SELECT[^\n]*FROM transactions WHERE event_id/,
          ],
        },
        scala: {
          all: [
            /INSERT INTO transactions/,
            /ON CONFLICT \(event_id\) DO NOTHING|SELECT[^\n]*FROM transactions WHERE event_id/,
          ],
        },
        cpp: {
          all: [
            /INSERT INTO transactions/,
            /ON CONFLICT \(event_id\) DO NOTHING|SELECT[^\n]*FROM transactions WHERE event_id/,
          ],
        },
      },
    },
    {
      id: 'no-double-entries',
      title: 'A duplicate writes no entries',
      detail:
        'When the first insert affected no row, return before the entries loop: the journal keeps exactly one set of entries per event however many times it is delivered.',
      match: {
        python: {
          order: [
            /rowcount\s*==\s*0|SELECT[^\n]*FROM transactions WHERE event_id/,
            /return None/,
            /INSERT INTO entries/,
          ],
        },
        typescript: {
          order: [
            /rowCount\s*===?\s*0|SELECT[^\n]*FROM transactions WHERE event_id/,
            /return null/,
            /INSERT INTO entries/,
          ],
        },
        go: {order: [/RowsAffected\(\)/, /==\s*0/, /INSERT INTO entries/]},
        scala: {order: [/executeUpdate\(\)\s*==\s*0/, /INSERT INTO entries/]},
        cpp: {order: [/affected_rows\(\)\s*==\s*0/, /INSERT INTO entries/]},
      },
    },
    {
      id: 'event-time',
      title: "Rows carry the event's own time",
      detail:
        '`posted_at` is the given event time for both the transaction and its entries, and now in milliseconds only when none is given; a late event lands on the date it happened.',
      match: {
        python: {all: [/if posted_at is None/, /now_ms\(\)/, /INSERT INTO entries[^\n]*posted_at/]},
        typescript: {
          all: [
            /postedAt\s*\?\?\s*nowMs\(\)|postedAt\s*===?\s*null/,
            /nowMs\(\)/,
            /INSERT INTO entries[^\n]*posted_at/,
          ],
        },
        go: {all: [/postedAt\s*==\s*0/, /nowMs\(\)/, /INSERT INTO entries[^\n]*posted_at/]},
        scala: {all: [/postedAt\s*==\s*0/, /nowMs\(\)/, /INSERT INTO entries[^\n]*posted_at/]},
        cpp: {all: [/posted_at\s*==\s*0/, /now_ms\(\)/, /INSERT INTO entries[^\n]*posted_at/]},
      },
    },
    {
      id: 'atomic',
      title: 'The transaction row and its entries commit or roll back together',
      detail:
        'Both inserts run inside the one `db.transaction` block; an entry that fails a constraint must take the transaction row down with it.',
      match: {
        python: {
          all: [
            /with db\.transaction\(\) as cur:(?:(?!\n {4}\S)[\s\S])*?INSERT INTO transactions/,
            /with db\.transaction\(\) as cur:(?:(?!\n {4}\S)[\s\S])*?INSERT INTO entries/,
          ],
        },
        typescript: {
          all: [
            /query\(\s*['"]BEGIN['"]\s*\)[\s\S]*?INSERT INTO transactions[\s\S]*?INSERT INTO entries[\s\S]*?query\(\s*['"]COMMIT['"]\s*\)/,
          ],
        },
        go: {
          all: [
            /db\.Transaction\(\s*ctx\s*,\s*func\(tx \*sql\.Tx\) error \{(?:(?!\n\t\}\))[\s\S])*?INSERT INTO transactions/,
            /db\.Transaction\(\s*ctx\s*,\s*func\(tx \*sql\.Tx\) error \{(?:(?!\n\t\}\))[\s\S])*?INSERT INTO entries/,
          ],
        },
        scala: {
          all: [
            /Db\.transaction \{ conn =>(?:(?!\n {4}\})[\s\S])*?INSERT INTO transactions/,
            /Db\.transaction \{ conn =>(?:(?!\n {4}\})[\s\S])*?INSERT INTO entries/,
          ],
        },
        cpp: {
          all: [
            /db::transaction\(\[&\]\(pqxx::work& tx\) \{(?:(?!\n {2}\}\))[\s\S])*?INSERT INTO transactions/,
            /db::transaction\(\[&\]\(pqxx::work& tx\) \{(?:(?!\n {2}\}\))[\s\S])*?INSERT INTO entries/,
          ],
        },
      },
    },
    {
      id: 'after-commit-hooks',
      title: 'Tracks clearing and invalidates balances after the commit, never for a duplicate',
      detail:
        'Once the block committed, `track(transaction_id, posted_at, entries, settles)` runs once and `invalidate(account, currency)` once per entry; a skipped duplicate triggers neither.',
      match: {
        python: {order: [/async with db\.transaction\(\)/, /(?<!import )\btrack\(/, /(?<!import )\binvalidate\(/]},
        typescript: {order: [/query\(\s*['"]COMMIT['"]\s*\)/, /(?<!\{)\btrack\(/, /(?<!\{)\binvalidate\(/]},
        go: {order: [/db\.Transaction\(/, /(?<!func )\btrack\(/, /(?<!func )\binvalidate\(/]},
        scala: {order: [/Db\.transaction \{/, /(?<!def )\btrack\(/, /(?<!def )\binvalidate\(/]},
        cpp: {order: [/db::transaction\(/, /(?<!void )\btrack\(/, /(?<!void )\binvalidate\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import time
import uuid

from balance_service import invalidate  # built in step 6: DEL bal:{account}:{currency}
from clearing_tracker import track  # built in step 5: ZADD / ZREM on clearing:open
from ledger.db import db  # async with db.transaction() as cur: begins, runs the block, commits (rolls back on exception)


def now_ms() -> int:
    return int(time.time() * 1000)


async def write_transaction(
    entries: list[dict], description: str, event_id: str | None = None, posted_at: int | None = None, settles: str | None = None
) -> str | None:
    """Record one transaction and its entries; returns its id, or None when the event was already recorded."""
    transaction_id = str(uuid.uuid4())
    # TODO: posted_at defaults to now_ms() — the API path; the consumer passes the event's occurred_at
    # TODO: one db.transaction(): INSERT INTO transactions … ON CONFLICT (event_id) DO NOTHING; rowcount 0 → return None
    # TODO: INSERT INTO entries (transaction_id, account, currency, amount, posted_at) for every entry
    # TODO: after the block: track(transaction_id, posted_at, entries, settles) and invalidate(account, currency) per entry
    raise NotImplementedError
`,
      solution: `import time
import uuid

from balance_service import invalidate  # built in step 6: DEL bal:{account}:{currency}
from clearing_tracker import track  # built in step 5: ZADD / ZREM on clearing:open
from ledger.db import db  # async with db.transaction() as cur: begins, runs the block, commits (rolls back on exception)


def now_ms() -> int:
    return int(time.time() * 1000)


async def write_transaction(
    entries: list[dict], description: str, event_id: str | None = None, posted_at: int | None = None, settles: str | None = None
) -> str | None:
    """Record one transaction and its entries; returns its id, or None when the event was already recorded."""
    transaction_id = str(uuid.uuid4())
    if posted_at is None:
        posted_at = now_ms()
    async with db.transaction() as cur:
        await cur.execute(
            "INSERT INTO transactions (id, event_id, description, settles, posted_at) VALUES (%s, %s, %s, %s, %s)"
            " ON CONFLICT (event_id) DO NOTHING",
            (transaction_id, event_id, description, settles, posted_at),
        )
        if cur.rowcount == 0:
            return None  # this event is already in the journal: a redelivery
        for entry in entries:
            await cur.execute(
                "INSERT INTO entries (transaction_id, account, currency, amount, posted_at) VALUES (%s, %s, %s, %s, %s)",
                (transaction_id, entry["account"], entry["currency"], entry["amount"], posted_at),
            )
    track(transaction_id, posted_at, entries, settles)
    for entry in entries:
        invalidate(entry["account"], entry["currency"])
    return transaction_id
`,
    },
    typescript: {
      starter: `import {randomUUID} from 'node:crypto';

import {pool} from 'ledger/db'; // pool.connect() → client: BEGIN, your statements, COMMIT (ROLLBACK on failure), release()

import {invalidate} from './balance_service'; // built in step 6: DEL bal:{account}:{currency}
import {track} from './clearing_tracker'; // built in step 5: ZADD / ZREM on clearing:open

export interface Entry {
  account: string;
  currency: string;
  amount: number;
}

export interface WriteOptions {
  /** The event this transaction records; null on the API path — a NULL never conflicts. */
  eventId?: string | null;
  /** The event's own time in ms; now when omitted (the API path). */
  postedAt?: number | null;
  /** The transaction this one settles (step 5). */
  settles?: string | null;
}

const nowMs = (): number => Date.now();

/** Record one transaction and its entries; returns its id, or null when the event was already recorded. */
export async function writeTransaction(
  entries: Entry[],
  description: string,
  options: WriteOptions = {},
): Promise<string | null> {
  const transactionId = randomUUID();
  const {eventId = null, settles = null} = options;
  // TODO: postedAt defaults to nowMs() — the API path; the consumer passes the event's occurred_at
  // TODO: one transaction on a pool client: INSERT INTO transactions … ON CONFLICT (event_id) DO NOTHING; rowCount 0 → return null
  // TODO: INSERT INTO entries (transaction_id, account, currency, amount, posted_at) for every entry
  // TODO: after the COMMIT: track(transactionId, postedAt, entries, settles) and invalidate(account, currency) per entry
  throw new Error('not implemented');
}
`,
      solution: `import {randomUUID} from 'node:crypto';

import {pool} from 'ledger/db'; // pool.connect() → client: BEGIN, your statements, COMMIT (ROLLBACK on failure), release()

import {invalidate} from './balance_service'; // built in step 6: DEL bal:{account}:{currency}
import {track} from './clearing_tracker'; // built in step 5: ZADD / ZREM on clearing:open

export interface Entry {
  account: string;
  currency: string;
  amount: number;
}

export interface WriteOptions {
  /** The event this transaction records; null on the API path — a NULL never conflicts. */
  eventId?: string | null;
  /** The event's own time in ms; now when omitted (the API path). */
  postedAt?: number | null;
  /** The transaction this one settles (step 5). */
  settles?: string | null;
}

const nowMs = (): number => Date.now();

/** Record one transaction and its entries; returns its id, or null when the event was already recorded. */
export async function writeTransaction(
  entries: Entry[],
  description: string,
  options: WriteOptions = {},
): Promise<string | null> {
  const transactionId = randomUUID();
  const {eventId = null, settles = null} = options;
  const postedAt = options.postedAt ?? nowMs();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const inserted = await client.query(
      'INSERT INTO transactions (id, event_id, description, settles, posted_at) VALUES ($1, $2, $3, $4, $5)' +
        ' ON CONFLICT (event_id) DO NOTHING',
      [transactionId, eventId, description, settles, postedAt],
    );
    if (inserted.rowCount === 0) {
      await client.query('COMMIT');
      return null; // this event is already in the journal: a redelivery
    }
    for (const entry of entries) {
      await client.query(
        'INSERT INTO entries (transaction_id, account, currency, amount, posted_at) VALUES ($1, $2, $3, $4, $5)',
        [transactionId, entry.account, entry.currency, entry.amount, postedAt],
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  await track(transactionId, postedAt, entries, settles);
  for (const entry of entries) await invalidate(entry.account, entry.currency);
  return transactionId;
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"database/sql"
	"errors"
	"time"

	"github.com/google/uuid"

	"ledger/db" // db.Transaction(ctx, func(tx *sql.Tx) error) begins, runs, commits (rolls back on error)
)

type Entry struct {
	Account  string \`json:"account"\`
	Currency string \`json:"currency"\`
	Amount   int64  \`json:"amount"\`
}

// Built in step 5 (clearing_tracker.go) and step 6 (balance_service.go).
func track(ctx context.Context, transactionID string, postedAt int64, entries []Entry, settles *string) { panic("not implemented") }
func invalidate(ctx context.Context, account, currency string)                                        { panic("not implemented") }

func nowMs() int64 { return time.Now().UnixMilli() }

// writeTransaction records one transaction and its entries; returns its id, or "" when the event was already recorded.
func writeTransaction(ctx context.Context, entries []Entry, description string, eventID *string, postedAt int64, settles *string) (string, error) {
	transactionID := uuid.NewString()
	// TODO: postedAt 0 → nowMs() — the API path; the consumer passes the event's OccurredAt
	// TODO: one db.Transaction: INSERT INTO transactions … ON CONFLICT (event_id) DO NOTHING; RowsAffected 0 → duplicate, return "", nil
	// TODO: INSERT INTO entries (transaction_id, account, currency, amount, posted_at) for every entry
	// TODO: after the transaction: track(ctx, transactionID, postedAt, entries, settles) and invalidate(ctx, account, currency) per entry
	_ = transactionID
	return "", errors.New("not implemented")
}
`,
      solution: `package main

import (
	"context"
	"database/sql"
	"time"

	"github.com/google/uuid"

	"ledger/db" // db.Transaction(ctx, func(tx *sql.Tx) error) begins, runs, commits (rolls back on error)
)

type Entry struct {
	Account  string \`json:"account"\`
	Currency string \`json:"currency"\`
	Amount   int64  \`json:"amount"\`
}

// Built in step 5 (clearing_tracker.go) and step 6 (balance_service.go).
func track(ctx context.Context, transactionID string, postedAt int64, entries []Entry, settles *string) { panic("not implemented") }
func invalidate(ctx context.Context, account, currency string)                                        { panic("not implemented") }

func nowMs() int64 { return time.Now().UnixMilli() }

// writeTransaction records one transaction and its entries; returns its id, or "" when the event was already recorded.
func writeTransaction(ctx context.Context, entries []Entry, description string, eventID *string, postedAt int64, settles *string) (string, error) {
	transactionID := uuid.NewString()
	if postedAt == 0 {
		postedAt = nowMs()
	}
	duplicate := false
	err := db.Transaction(ctx, func(tx *sql.Tx) error {
		res, err := tx.ExecContext(ctx,
			"INSERT INTO transactions (id, event_id, description, settles, posted_at) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (event_id) DO NOTHING",
			transactionID, eventID, description, settles, postedAt)
		if err != nil {
			return err
		}
		if n, _ := res.RowsAffected(); n == 0 {
			duplicate = true // this event is already in the journal: a redelivery
			return nil
		}
		for _, e := range entries {
			if _, err := tx.ExecContext(ctx,
				"INSERT INTO entries (transaction_id, account, currency, amount, posted_at) VALUES ($1, $2, $3, $4, $5)",
				transactionID, e.Account, e.Currency, e.Amount, postedAt); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return "", err
	}
	if duplicate {
		return "", nil
	}
	track(ctx, transactionID, postedAt, entries, settles)
	for _, e := range entries {
		invalidate(ctx, e.Account, e.Currency)
	}
	return transactionID, nil
}
`,
    },
    scala: {
      starter: `import java.util.UUID

import ledger.Db // Db.transaction { conn => ... } begins, runs the block, commits (rolls back on exception)

final case class Entry(account: String, currency: String, amount: Long)

object LedgerWriter {
  /** Built in step 5 (ClearingTracker) and step 6 (BalanceService). */
  def track(transactionId: String, postedAt: Long, entries: Seq[Entry], settles: Option[String]): Unit = ???
  def invalidate(account: String, currency: String): Unit = ???

  def nowMs(): Long = System.currentTimeMillis()

  /** Records one transaction and its entries; returns its id, or None when the event was already recorded. */
  def writeTransaction(entries: Seq[Entry], description: String, eventId: Option[String], postedAt: Long, settles: Option[String]): Option[String] = {
    val transactionId = UUID.randomUUID().toString
    // TODO: postedAt 0 → nowMs() — the API path; the consumer passes the event's occurredAt
    // TODO: one Db.transaction: INSERT INTO transactions … ON CONFLICT (event_id) DO NOTHING; executeUpdate 0 → duplicate
    // TODO: INSERT INTO entries (transaction_id, account, currency, amount, posted_at) for every entry
    // TODO: after the block: track(transactionId, postedAt, entries, settles) and invalidate(account, currency) per entry
    ???
  }
}
`,
      solution: `import java.util.UUID

import ledger.Db // Db.transaction { conn => ... } begins, runs the block, commits (rolls back on exception)

final case class Entry(account: String, currency: String, amount: Long)

object LedgerWriter {
  /** Built in step 5 (ClearingTracker) and step 6 (BalanceService). */
  def track(transactionId: String, postedAt: Long, entries: Seq[Entry], settles: Option[String]): Unit = ???
  def invalidate(account: String, currency: String): Unit = ???

  def nowMs(): Long = System.currentTimeMillis()

  /** Records one transaction and its entries; returns its id, or None when the event was already recorded. */
  def writeTransaction(entries: Seq[Entry], description: String, eventId: Option[String], postedAt: Long, settles: Option[String]): Option[String] = {
    val transactionId = UUID.randomUUID().toString
    val at = if (postedAt == 0) nowMs() else postedAt
    val inserted = Db.transaction { conn =>
      val tx = conn.prepareStatement(
        "INSERT INTO transactions (id, event_id, description, settles, posted_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (event_id) DO NOTHING")
      tx.setString(1, transactionId); tx.setString(2, eventId.orNull); tx.setString(3, description)
      tx.setString(4, settles.orNull); tx.setLong(5, at)
      if (tx.executeUpdate() == 0) false // this event is already in the journal: a redelivery
      else {
        val row = conn.prepareStatement(
          "INSERT INTO entries (transaction_id, account, currency, amount, posted_at) VALUES (?, ?, ?, ?, ?)")
        entries.foreach { e =>
          row.setString(1, transactionId); row.setString(2, e.account); row.setString(3, e.currency)
          row.setLong(4, e.amount); row.setLong(5, at)
          row.addBatch()
        }
        row.executeBatch()
        true
      }
    }
    if (!inserted) None
    else {
      track(transactionId, at, entries, settles)
      entries.foreach(e => invalidate(e.account, e.currency))
      Some(transactionId)
    }
  }
}
`,
    },
    cpp: {
      starter: `#include <pqxx/pqxx>

#include <chrono>
#include <cstdint>
#include <optional>
#include <stdexcept>
#include <string>
#include <vector>

#include "db.h"   // db::transaction(fn): begins, runs fn(pqxx::work&), commits (rolls back on throw)
#include "ids.h"  // std::string new_uuid();

struct Entry {
  std::string account;
  std::string currency;
  int64_t amount;
};

// Built in step 5 (clearing_tracker.cpp) and step 6 (balance_service.cpp).
void track(const std::string& transaction_id, int64_t posted_at, const std::vector<Entry>& entries, std::optional<std::string> settles);
void invalidate(const std::string& account, const std::string& currency);

int64_t now_ms() {
  return std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count();
}

// Records one transaction and its entries; returns its id, or nullopt when the event was already recorded.
std::optional<std::string> write_transaction(const std::vector<Entry>& entries, const std::string& description,
                                             std::optional<std::string> event_id, int64_t posted_at,
                                             std::optional<std::string> settles) {
  const std::string transaction_id = new_uuid();
  // TODO: posted_at 0 → now_ms() — the API path; the consumer passes the event's occurred_at
  // TODO: one db::transaction: INSERT INTO transactions … ON CONFLICT (event_id) DO NOTHING; affected_rows 0 → duplicate
  // TODO: INSERT INTO entries (transaction_id, account, currency, amount, posted_at) for every entry
  // TODO: after the transaction: track(transaction_id, posted_at, entries, settles) and invalidate(account, currency) per entry
  throw std::logic_error("not implemented");
}
`,
      solution: `#include <pqxx/pqxx>

#include <chrono>
#include <cstdint>
#include <optional>
#include <stdexcept>
#include <string>
#include <vector>

#include "db.h"   // db::transaction(fn): begins, runs fn(pqxx::work&), commits (rolls back on throw)
#include "ids.h"  // std::string new_uuid();

struct Entry {
  std::string account;
  std::string currency;
  int64_t amount;
};

// Built in step 5 (clearing_tracker.cpp) and step 6 (balance_service.cpp).
void track(const std::string& transaction_id, int64_t posted_at, const std::vector<Entry>& entries, std::optional<std::string> settles);
void invalidate(const std::string& account, const std::string& currency);

int64_t now_ms() {
  return std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count();
}

// Records one transaction and its entries; returns its id, or nullopt when the event was already recorded.
std::optional<std::string> write_transaction(const std::vector<Entry>& entries, const std::string& description,
                                             std::optional<std::string> event_id, int64_t posted_at,
                                             std::optional<std::string> settles) {
  const std::string transaction_id = new_uuid();
  if (posted_at == 0) posted_at = now_ms();
  bool duplicate = false;
  db::transaction([&](pqxx::work& tx) {
    const auto res = tx.exec_params(
        "INSERT INTO transactions (id, event_id, description, settles, posted_at) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (event_id) DO NOTHING",
        transaction_id, event_id, description, settles, posted_at);
    if (res.affected_rows() == 0) {
      duplicate = true;  // this event is already in the journal: a redelivery
      return;
    }
    for (const auto& e : entries)
      tx.exec_params("INSERT INTO entries (transaction_id, account, currency, amount, posted_at) VALUES ($1, $2, $3, $4, $5)",
                     transaction_id, e.account, e.currency, e.amount, posted_at);
  });
  if (duplicate) return std::nullopt;
  track(transaction_id, posted_at, entries, settles);
  for (const auto& e : entries) invalidate(e.account, e.currency);
  return transaction_id;
}
`,
    },
  },
  harness: {
    python: `import json
import time
import uuid

import grpc

import ledger_pb2
import ledger_pb2_grpc

SCHEMA = """
CREATE TABLE transactions (
    id text PRIMARY KEY,
    event_id text UNIQUE,
    description text NOT NULL,
    settles text,
    posted_at bigint NOT NULL
);
CREATE TABLE entries (
    transaction_id text NOT NULL,
    account text NOT NULL,
    currency text NOT NULL,
    amount bigint NOT NULL CHECK (amount <> 0),
    posted_at bigint NOT NULL
);
"""

T0 = 1700000000000
ENTRIES = [
    {"account": "cash:acquirer", "currency": "EUR", "amount": 4999},
    {"account": "clearing:payments", "currency": "EUR", "amount": -4999},
]
PAYOUT = [
    {"account": "clearing:payments", "currency": "EUR", "amount": 4999},
    {"account": "cash:bank", "currency": "EUR", "amount": -4999},
]


async def _writer(ctx):
    """The learner's writer on an empty ledger; its track (step 5) and invalidate (step 6) are the real ones."""
    await ctx.db.reset(SCHEMA)
    return ctx.load("ledger_writer")


def _balances(ctx):
    """The real balance service (step 6) — the reader whose cache the writer must invalidate — and a stub on it."""
    import balance_service

    ctx.grpc.serve(ledger_pb2_grpc.add_LedgerServiceServicer_to_server, balance_service.LedgerService())
    return ledger_pb2_grpc.LedgerServiceStub(grpc.aio.insecure_channel("ledger:9100"))


async def _balance(stub, account, currency="EUR"):
    return (await stub.GetBalance(ledger_pb2.BalanceRequest(account=account, currency=currency), timeout=2.0)).amount


async def _rows(ctx, table):
    order = "posted_at, account, amount" if table == "entries" else "posted_at, id"
    return await ctx.db.execute(f"SELECT * FROM {table} ORDER BY {order}")


def _open(ctx):
    return {member: int(score) for member, score in ctx.redis.zrange("clearing:open", 0, -1, withscores=True)}


async def check_unique_event_id(ctx):
    m = await _writer(ctx)
    first = await m.write_transaction(ENTRIES, "payment.captured", event_id="evt_01", posted_at=T0)
    assert isinstance(first, str) and first, f"the first write must return the new transaction id, got {first!r}"
    try:
        uuid.UUID(first)
    except ValueError:
        raise AssertionError(f"the transaction id must be a UUID, got {first!r}")
    again = await m.write_transaction(ENTRIES, "payment.captured", event_id="evt_01", posted_at=T0)
    assert again is None, f"a second write of evt_01 must return None (already recorded), got {again!r}"
    rows = await _rows(ctx, "transactions")
    assert len(rows) == 1, f"two writes of one event must leave one transactions row, found {len(rows)}"
    assert rows[0]["id"] == first and rows[0]["event_id"] == "evt_01", f"the row must be the first write's, got {rows[0]}"
    api_1 = await m.write_transaction(ENTRIES, "manual adjustment")
    api_2 = await m.write_transaction(ENTRIES, "manual adjustment")
    assert api_1 and api_2 and api_1 != api_2, "API-originated transactions have no event id and never conflict: both must be written"
    assert len(await _rows(ctx, "transactions")) == 3


async def check_no_double_entries(ctx):
    m = await _writer(ctx)
    await m.write_transaction(ENTRIES, "payment.captured", event_id="evt_01", posted_at=T0)
    await m.write_transaction(ENTRIES, "payment.captured", event_id="evt_01", posted_at=T0)
    await m.write_transaction(ENTRIES, "payment.captured", event_id="evt_01", posted_at=T0)
    entries = await _rows(ctx, "entries")
    assert len(entries) == 2, f"three deliveries of one event must leave exactly two entries, found {len(entries)}: the duplicate must return before the entries loop"
    # End to end: the real step 3 consumer meets evt_02 twice (a producer retry: a second record with a new offset).
    for event_id in ("evt_02", "evt_03", "evt_02"):
        event = {"event_id": event_id, "type": "payout.sent", "amount": 120000, "currency": "USD", "occurred_at": T0 + 10}
        ctx.kafka.seed("money-events", key=event_id, value=json.dumps(event))
    consumer = ctx.load("event_consumer")
    await ctx.drain_async(consumer.run())
    transactions = await _rows(ctx, "transactions")
    entries = await _rows(ctx, "entries")
    assert sorted(t["event_id"] for t in transactions) == ["evt_01", "evt_02", "evt_03"], f"expected evt_01, evt_02, evt_03 once each, got {[t['event_id'] for t in transactions]}"
    assert len(entries) == 6, f"three events must leave six entries however often they are delivered, found {len(entries)}"
    balance = sum(e["amount"] for e in entries)
    assert balance == 0, f"the journal must balance: entries sum to {balance}"
    assert ctx.kafka.lag("ledger", "money-events") == 0, "the redelivered record must still be committed: it was handled (skipped)"


async def check_event_time(ctx):
    m = await _writer(ctx)
    yesterday = int(time.time() * 1000) - 86400000
    late = await m.write_transaction(ENTRIES, "payment.captured", event_id="evt_late", posted_at=yesterday)
    now_id = await m.write_transaction(ENTRIES, "manual adjustment")
    transactions = {t["id"]: t for t in await _rows(ctx, "transactions")}
    assert transactions[late]["posted_at"] == yesterday, f"a late event's transaction must carry its own occurred_at {yesterday}, got {transactions[late]['posted_at']}"
    entries = await _rows(ctx, "entries")
    late_entries = [e for e in entries if e["transaction_id"] == late]
    assert len(late_entries) == 2 and all(e["posted_at"] == yesterday for e in late_entries), f"the late event's entries must carry its occurred_at too, got {[e['posted_at'] for e in late_entries]}"
    now = int(time.time() * 1000)
    at = transactions[now_id]["posted_at"]
    assert abs(at - now) < 5000, f"a write without posted_at is the API path: posted now ({now}), got {at}"
    assert all(e["posted_at"] == at for e in entries if e["transaction_id"] == now_id), "the entries must carry the same posted_at as their transaction"


async def check_atomic(ctx):
    m = await _writer(ctx)
    first = await m.write_transaction(ENTRIES, "payment.captured", event_id="evt_01", posted_at=T0)
    assert ctx.db.events == ["BEGIN", "COMMIT"], f"the transaction row and its entries must be written in one database transaction; the database saw {ctx.db.events}"
    stub = _balances(ctx)
    assert await _balance(stub, "cash:acquirer") == 4999  # now cached by the balance service
    assert ctx.redis.exists("bal:cash:acquirer:EUR"), "the balance service must have cached cash:acquirer EUR"
    # The second entry violates entries.amount <> 0: the transaction row must roll back with it.
    broken = [{"account": "cash:acquirer", "currency": "EUR", "amount": 4999}, {"account": "clearing:payments", "currency": "EUR", "amount": 0}]
    try:
        await m.write_transaction(broken, "payment.captured", event_id="evt_02", posted_at=T0 + 1)
        raise AssertionError("a failed entry insert must propagate (the transaction rolls back), not be swallowed")
    except AssertionError:
        raise
    except Exception:
        pass
    assert ctx.db.events[-1] == "ROLLBACK", f"the failed write must roll back, the database saw {ctx.db.events}"
    transactions = await _rows(ctx, "transactions")
    assert [t["event_id"] for t in transactions] == ["evt_01"], f"evt_02's entry failed but its transactions row was committed: the two inserts are not in one transaction ({[t['event_id'] for t in transactions]})"
    assert len(await _rows(ctx, "entries")) == 2, "no entry of the failed transaction may survive"
    assert _open(ctx) == {first: T0}, f"only evt_01 is in the journal, so only it may be open in clearing; clearing:open holds {_open(ctx)} — a rolled-back transaction must not be tracked"
    assert ctx.redis.exists("bal:cash:acquirer:EUR"), "the rolled-back write changed no balance, yet the cached cash:acquirer EUR balance was dropped: the hooks must run only after a commit"


async def check_after_commit_hooks(ctx):
    m = await _writer(ctx)
    await m.write_transaction(ENTRIES, "payment.captured", event_id="evt_00", posted_at=T0 - 1000)
    stub = _balances(ctx)
    assert await _balance(stub, "cash:acquirer") == 4999
    assert await _balance(stub, "clearing:payments") == -4999
    before = len(ctx.db.events)
    # Snapshots of what the database had been through at the moment each Redis side effect happened.
    tracked = ctx.redis_after("clearing:open", lambda: list(ctx.db.events[before:]))
    dropped = ctx.redis_after("bal:clearing:payments:EUR", lambda: list(ctx.db.events[before:]))
    tx = await m.write_transaction(ENTRIES, "payment.captured", event_id="evt_01", posted_at=T0)
    assert tracked.fired, "the written transaction touches clearing:payments but clearing:open was never updated: call track after the commit"
    assert tracked.result == ["BEGIN", "COMMIT"], f"clearing:open was updated when the database had seen only {tracked.result}: track must run after the commit"
    assert dropped.fired and not ctx.redis.exists("bal:clearing:payments:EUR"), "the cached clearing:payments EUR balance survived the write: invalidate(account, currency) for every entry"
    assert dropped.result == ["BEGIN", "COMMIT"], f"the cached balance was dropped when the database had seen only {dropped.result}: invalidate must run after the commit"
    assert not ctx.redis.exists("bal:cash:acquirer:EUR"), "the cached cash:acquirer EUR balance survived the write: invalidate every entry's account"
    assert await _balance(stub, "cash:acquirer") == 9998, "right after the write the balance service must answer the new cash:acquirer balance 9998"
    opened = _open(ctx)
    assert opened.get(tx) == T0, f"the transaction must be open in clearing:open at its posted_at {T0}, clearing:open holds {opened}"
    payout = await m.write_transaction(PAYOUT, "payout.sent", event_id="evt_02", posted_at=T0 + 5000, settles=tx)
    opened = _open(ctx)
    assert tx not in opened and payout not in opened, f"the payout settles {tx}: track must get settles, close that item and open none, clearing:open holds {opened}"
    # A redelivery of evt_01 is skipped: nothing changed, so nothing may be tracked or invalidated.
    assert await _balance(stub, "cash:acquirer") == 9998
    open_before = _open(ctx)
    again = await m.write_transaction(ENTRIES, "payment.captured", event_id="evt_01", posted_at=T0)
    assert again is None, f"the duplicate must return None, got {again!r}"
    assert _open(ctx) == open_before, f"a skipped duplicate must not be tracked: clearing:open went from {open_before} to {_open(ctx)}"
    assert ctx.redis.exists("bal:cash:acquirer:EUR"), "a skipped duplicate changed no balance, yet the cached cash:acquirer EUR balance was dropped"
`,
    typescript: `import * as grpc from '@grpc/grpc-js';

const SCHEMA = \`
CREATE TABLE transactions (
    id text PRIMARY KEY,
    event_id text UNIQUE,
    description text NOT NULL,
    settles text,
    posted_at bigint NOT NULL
);
CREATE TABLE entries (
    transaction_id text NOT NULL,
    account text NOT NULL,
    currency text NOT NULL,
    amount bigint NOT NULL CHECK (amount <> 0),
    posted_at bigint NOT NULL
);
\`;

const T0 = 1700000000000;
const ENTRIES = [
  {account: 'cash:acquirer', currency: 'EUR', amount: 4999},
  {account: 'clearing:payments', currency: 'EUR', amount: -4999},
];
const PAYOUT = [
  {account: 'clearing:payments', currency: 'EUR', amount: 4999},
  {account: 'cash:bank', currency: 'EUR', amount: -4999},
];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The learner's writer on an empty ledger; its track (step 5) and invalidate (step 6) are the real ones. */
async function writer(ctx) {
  await ctx.db.reset(SCHEMA);
  return ctx.load('ledger_writer');
}

/** The real balance service (step 6) — the reader whose cache the writer must invalidate — and a client on it. */
function balances(ctx) {
  const service = ctx.load('balance_service');
  service.serve();
  const pkg = ctx.proto('ledger.proto');
  return new pkg.ledger.LedgerService('ledger:9100', grpc.credentials.createInsecure());
}

async function balance(client, account: string, currency = 'EUR'): Promise<number> {
  const reply = await client.GetBalance({account, currency, as_of: 0}, {deadline: Date.now() + 2000});
  return Number(reply.amount);
}

async function rows(ctx, table: string) {
  const order = table === 'entries' ? 'posted_at, account, amount' : 'posted_at, id';
  return ctx.db.execute(\`SELECT * FROM \${table} ORDER BY \${order}\`);
}

function open(ctx): Record<string, number> {
  const flat = ctx.redis.zrange('clearing:open', 0, -1, 'WITHSCORES');
  const out: Record<string, number> = {};
  for (let i = 0; i + 1 < flat.length; i += 2) out[flat[i]] = Number(flat[i + 1]);
  return out;
}

export async function check_unique_event_id(ctx) {
  const m = await writer(ctx);
  const first = await m.writeTransaction(ENTRIES, 'payment.captured', {eventId: 'evt_01', postedAt: T0});
  assert(typeof first === 'string' && first, \`the first write must return the new transaction id, got \${JSON.stringify(first)}\`);
  assert(UUID_RE.test(first), \`the transaction id must be a UUID, got \${JSON.stringify(first)}\`);
  const again = await m.writeTransaction(ENTRIES, 'payment.captured', {eventId: 'evt_01', postedAt: T0});
  assert.equal(again, null, \`a second write of evt_01 must return null (already recorded), got \${JSON.stringify(again)}\`);
  const transactions = await rows(ctx, 'transactions');
  assert.equal(transactions.length, 1, \`two writes of one event must leave one transactions row, found \${transactions.length}\`);
  assert(transactions[0].id === first && transactions[0].event_id === 'evt_01', \`the row must be the first write's, got \${JSON.stringify(transactions[0])}\`);
  const api1 = await m.writeTransaction(ENTRIES, 'manual adjustment');
  const api2 = await m.writeTransaction(ENTRIES, 'manual adjustment');
  assert(api1 && api2 && api1 !== api2, 'API-originated transactions have no event id and never conflict: both must be written');
  assert.equal((await rows(ctx, 'transactions')).length, 3);
}

export async function check_no_double_entries(ctx) {
  const m = await writer(ctx);
  await m.writeTransaction(ENTRIES, 'payment.captured', {eventId: 'evt_01', postedAt: T0});
  await m.writeTransaction(ENTRIES, 'payment.captured', {eventId: 'evt_01', postedAt: T0});
  await m.writeTransaction(ENTRIES, 'payment.captured', {eventId: 'evt_01', postedAt: T0});
  let entries = await rows(ctx, 'entries');
  assert.equal(entries.length, 2, \`three deliveries of one event must leave exactly two entries, found \${entries.length}: the duplicate must return before the entries loop\`);
  // End to end: the real step 3 consumer meets evt_02 twice (a producer retry: a second record with a new offset).
  for (const eventId of ['evt_02', 'evt_03', 'evt_02']) {
    const event = {event_id: eventId, type: 'payout.sent', amount: 120000, currency: 'USD', occurred_at: T0 + 10};
    ctx.kafka.seed('money-events', {key: eventId, value: JSON.stringify(event)});
  }
  const consumer = ctx.load('event_consumer');
  await ctx.drain(consumer.run());
  const transactions = await rows(ctx, 'transactions');
  entries = await rows(ctx, 'entries');
  const eventIds = transactions.map(t => t.event_id).sort();
  assert.deepEqual(eventIds, ['evt_01', 'evt_02', 'evt_03'], \`expected evt_01, evt_02, evt_03 once each, got \${JSON.stringify(transactions.map(t => t.event_id))}\`);
  assert.equal(entries.length, 6, \`three events must leave six entries however often they are delivered, found \${entries.length}\`);
  const total = entries.reduce((sum, e) => sum + Number(e.amount), 0);
  assert.equal(total, 0, \`the journal must balance: entries sum to \${total}\`);
  assert.equal(ctx.kafka.lag('ledger', 'money-events'), 0, 'the redelivered record must still be committed: it was handled (skipped)');
}

export async function check_event_time(ctx) {
  const m = await writer(ctx);
  const yesterday = Date.now() - 86400000;
  const late = await m.writeTransaction(ENTRIES, 'payment.captured', {eventId: 'evt_late', postedAt: yesterday});
  const nowId = await m.writeTransaction(ENTRIES, 'manual adjustment');
  const transactions = Object.fromEntries((await rows(ctx, 'transactions')).map(t => [t.id, t]));
  assert.equal(Number(transactions[late].posted_at), yesterday, \`a late event's transaction must carry its own occurred_at \${yesterday}, got \${transactions[late].posted_at}\`);
  const entries = await rows(ctx, 'entries');
  const lateEntries = entries.filter(e => e.transaction_id === late);
  assert(lateEntries.length === 2 && lateEntries.every(e => Number(e.posted_at) === yesterday), \`the late event's entries must carry its occurred_at too, got \${JSON.stringify(lateEntries.map(e => e.posted_at))}\`);
  const now = Date.now();
  const at = Number(transactions[nowId].posted_at);
  assert(Math.abs(at - now) < 5000, \`a write without postedAt is the API path: posted now (\${now}), got \${at}\`);
  assert(entries.filter(e => e.transaction_id === nowId).every(e => Number(e.posted_at) === at), 'the entries must carry the same posted_at as their transaction');
}

export async function check_atomic(ctx) {
  const m = await writer(ctx);
  const first = await m.writeTransaction(ENTRIES, 'payment.captured', {eventId: 'evt_01', postedAt: T0});
  assert.deepEqual(ctx.db.events, ['BEGIN', 'COMMIT'], \`the transaction row and its entries must be written in one database transaction; the database saw \${JSON.stringify(ctx.db.events)}\`);
  const client = balances(ctx);
  assert.equal(await balance(client, 'cash:acquirer'), 4999); // now cached by the balance service
  assert(ctx.redis.exists('bal:cash:acquirer:EUR'), 'the balance service must have cached cash:acquirer EUR');
  // The second entry violates entries.amount <> 0: the transaction row must roll back with it.
  const broken = [
    {account: 'cash:acquirer', currency: 'EUR', amount: 4999},
    {account: 'clearing:payments', currency: 'EUR', amount: 0},
  ];
  await assert.rejects(
    m.writeTransaction(broken, 'payment.captured', {eventId: 'evt_02', postedAt: T0 + 1}),
    () => true,
    'a failed entry insert must propagate (the transaction rolls back), not be swallowed',
  );
  assert.equal(ctx.db.events[ctx.db.events.length - 1], 'ROLLBACK', \`the failed write must roll back, the database saw \${JSON.stringify(ctx.db.events)}\`);
  const transactions = await rows(ctx, 'transactions');
  assert.deepEqual(transactions.map(t => t.event_id), ['evt_01'], \`evt_02's entry failed but its transactions row was committed: the two inserts are not in one transaction (\${JSON.stringify(transactions.map(t => t.event_id))})\`);
  assert.equal((await rows(ctx, 'entries')).length, 2, 'no entry of the failed transaction may survive');
  assert.deepEqual(open(ctx), {[first]: T0}, \`only evt_01 is in the journal, so only it may be open in clearing; clearing:open holds \${JSON.stringify(open(ctx))} — a rolled-back transaction must not be tracked\`);
  assert(ctx.redis.exists('bal:cash:acquirer:EUR'), 'the rolled-back write changed no balance, yet the cached cash:acquirer EUR balance was dropped: the hooks must run only after a commit');
}

export async function check_after_commit_hooks(ctx) {
  const m = await writer(ctx);
  await m.writeTransaction(ENTRIES, 'payment.captured', {eventId: 'evt_00', postedAt: T0 - 1000});
  const client = balances(ctx);
  assert.equal(await balance(client, 'cash:acquirer'), 4999);
  assert.equal(await balance(client, 'clearing:payments'), -4999);
  const before = ctx.db.events.length;
  // Snapshots of what the database had been through at the moment each Redis side effect happened.
  let tracked: string[] | null = null;
  let dropped: string[] | null = null;
  ctx.redisAfter('clearing:open', () => {
    tracked = ctx.db.events.slice(before);
  });
  ctx.redisAfter('bal:clearing:payments:EUR', () => {
    dropped = ctx.db.events.slice(before);
  });
  const tx = await m.writeTransaction(ENTRIES, 'payment.captured', {eventId: 'evt_01', postedAt: T0});
  assert(tracked !== null, 'the written transaction touches clearing:payments but clearing:open was never updated: call track after the commit');
  assert.deepEqual(tracked, ['BEGIN', 'COMMIT'], \`clearing:open was updated when the database had seen only \${JSON.stringify(tracked)}: track must run after the commit\`);
  assert(dropped !== null && !ctx.redis.exists('bal:clearing:payments:EUR'), 'the cached clearing:payments EUR balance survived the write: invalidate(account, currency) for every entry');
  assert.deepEqual(dropped, ['BEGIN', 'COMMIT'], \`the cached balance was dropped when the database had seen only \${JSON.stringify(dropped)}: invalidate must run after the commit\`);
  assert(!ctx.redis.exists('bal:cash:acquirer:EUR'), "the cached cash:acquirer EUR balance survived the write: invalidate every entry's account");
  assert.equal(await balance(client, 'cash:acquirer'), 9998, 'right after the write the balance service must answer the new cash:acquirer balance 9998');
  let opened = open(ctx);
  assert.equal(opened[tx], T0, \`the transaction must be open in clearing:open at its posted_at \${T0}, clearing:open holds \${JSON.stringify(opened)}\`);
  const payout = await m.writeTransaction(PAYOUT, 'payout.sent', {eventId: 'evt_02', postedAt: T0 + 5000, settles: tx});
  opened = open(ctx);
  assert(!(tx in opened) && !(payout in opened), \`the payout settles \${tx}: track must get settles, close that item and open none, clearing:open holds \${JSON.stringify(opened)}\`);
  // A redelivery of evt_01 is skipped: nothing changed, so nothing may be tracked or invalidated.
  assert.equal(await balance(client, 'cash:acquirer'), 9998);
  const openBefore = open(ctx);
  const again = await m.writeTransaction(ENTRIES, 'payment.captured', {eventId: 'evt_01', postedAt: T0});
  assert.equal(again, null, \`the duplicate must return null, got \${JSON.stringify(again)}\`);
  assert.deepEqual(open(ctx), openBefore, \`a skipped duplicate must not be tracked: clearing:open went from \${JSON.stringify(openBefore)} to \${JSON.stringify(open(ctx))}\`);
  assert(ctx.redis.exists('bal:cash:acquirer:EUR'), 'a skipped duplicate changed no balance, yet the cached cash:acquirer EUR balance was dropped');
}
`,
  },
  debrief: `The unique index on \`event_id\` is the only exactly-once mechanism that survives everything: the consumer may crash after writing and before committing, two consumers may briefly own the same partition during a rebalance, a producer may publish twice — and the journal still holds one row per event, because the database refuses the second. Reading the affected row count turns that refusal into a decision instead of an error. The hooks run after the commit because Redis is not part of the transaction: a tracked clearing item for a rolled-back transaction would be a phantom the sweeper could never settle. Stripe's post describes Ledger as immutable — nothing is updated or deleted, corrections are new transactions — and the shape here is the same: the only write is an insert, and the only conflict resolution is "already there".`,
};
