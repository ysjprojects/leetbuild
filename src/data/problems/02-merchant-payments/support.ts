/**
 * Hand-written support modules the merchant-payments starters import but no step builds:
 * `payments.db` (the runtime's Postgres handle) and `payments.ledger` (the non-idempotent poster
 * step 5 dedupes in front of).
 */
import {CPP_IDS_H, cppTransactionDbH} from '../cpp-support';
import {scalaPath, scalaTls} from '../scala-support';

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

/**
 * The C++ twins: `db.h` (libpqxx on the runtime's Postgres), `ids.h` (UUIDs), `clock.h` (ISO-8601 time),
 * `ledger.h` (the journal).
 */
export const supportModulesCpp: Record<string, string> = {
  'db.h': cppTransactionDbH('The order database', 'postgresql://app@db:5432/app'),
  'ids.h': CPP_IDS_H,
  'clock.h': `// The time (provided): iso_now() is the current UTC time in ISO 8601 with milliseconds, "2026-01-02T15:04:05.123Z".
#pragma once

#include <chrono>
#include <cstdio>
#include <ctime>
#include <string>

inline std::string iso_now() {
  const auto now = std::chrono::system_clock::now();
  const auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(now.time_since_epoch()).count();
  const std::time_t secs = static_cast<std::time_t>(ms / 1000);
  std::tm utc{};
  gmtime_r(&secs, &utc);
  char buf[32];
  std::snprintf(buf, sizeof buf, "%04d-%02d-%02dT%02d:%02d:%02d.%03dZ", utc.tm_year + 1900, utc.tm_mon + 1, utc.tm_mday,
                utc.tm_hour, utc.tm_min, utc.tm_sec, static_cast<int>(ms % 1000));
  return buf;
}
`,
  'ledger.h': `// The ledger (provided): ledger::post(event) books one payment.captured event as double-entry rows.
//
// NOT idempotent: posting the same event twice books the money twice. ledger::posted is the journal.
#pragma once

#include <nlohmann/json.hpp>

#include <cstdint>
#include <functional>
#include <string>
#include <vector>

namespace ledger {

// One payment.captured event, as the outbox relay publishes it.
struct Event {
  std::string event_id;
  std::string type;
  std::string merchant_id;
  std::string order_id;
  int64_t amount_cents = 0;
  std::string currency;
  std::string captured_at;
};

// The event in a record's JSON value (fields it lacks stay empty).
inline Event parse(const std::string& json) {
  const auto doc = nlohmann::json::parse(json);
  Event e;
  e.event_id = doc.value("event_id", "");
  e.type = doc.value("type", "");
  e.merchant_id = doc.value("merchant_id", "");
  e.order_id = doc.value("order_id", "");
  e.amount_cents = doc.value("amount_cents", int64_t{0});
  e.currency = doc.value("currency", "");
  e.captured_at = doc.value("captured_at", "");
  return e;
}

// The journal: every event post booked, duplicates included.
inline std::vector<Event> posted;

// Book the event; every call appends a journal entry, duplicates included. Throws when it cannot book.
// (A variable, so a test can stand in for a ledger whose database is down.)
inline std::function<void(const Event&)> post = [](const Event& event) { posted.push_back(event); };

}  // namespace ledger
`,
};

/** The Scala twins: `payments.Db` (JDBC on the runtime's Postgres), `payments.Ledger` (the journal), `payments.Tls`. */
export const supportModulesScala: Record<string, string> = {
  ...scalaTls('payments'),
  [scalaPath('payments', 'Db')]: `package payments

import java.sql.{Connection, DriverManager}

/** The order database: Postgres over JDBC. \`transaction\` begins, runs the block, commits (rolls back on exception). */
object Db {
  private val Url = "jdbc:postgresql://db:5432/app?user=app"

  def transaction[A](block: Connection => A): A = {
    val conn = DriverManager.getConnection(Url)
    try {
      conn.setAutoCommit(false)
      try {
        val result = block(conn)
        conn.commit()
        result
      } catch {
        case e: Throwable => conn.rollback(); throw e
      }
    } finally conn.close()
  }
}
`,
  [scalaPath('payments', 'Ledger')]: `package payments

import scala.collection.mutable.ArrayBuffer

/**
 * The ledger: \`post(event)\` books one payment.captured event as double-entry rows.
 * NOT idempotent: posting the same event twice books the money twice. \`posted\` is the journal.
 */
object Ledger {
  /** One payment.captured event, as the outbox relay publishes it. */
  final case class Event(
      eventId: String,
      \`type\`: String,
      merchantId: String,
      orderId: String,
      amountCents: Long,
      currency: String,
      capturedAt: String)

  object Event {
    /** Parses the relay's JSON payload. */
    def fromJson(json: String): Event = {
      val o = ujson.read(json).obj
      Event(
        eventId = o("event_id").str,
        \`type\` = o("type").str,
        merchantId = o("merchant_id").str,
        orderId = o("order_id").str,
        amountCents = o("amount_cents").num.toLong,
        currency = o("currency").str,
        capturedAt = o("captured_at").str)
    }
  }

  /** The journal: every event \`post\` booked, duplicates included. */
  val posted: ArrayBuffer[Event] = ArrayBuffer.empty

  /** Books the event; every call appends a journal entry, duplicates included. */
  def post(event: Event): Unit = synchronized { posted += event }
}
`,
};
