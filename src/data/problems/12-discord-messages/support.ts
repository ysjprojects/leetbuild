/**
 * Hand-written support module the discord-messages starters import but no step builds:
 * `messages.db`, the runtime's Postgres handle with the `messages` schema beside it. Snowflakes are
 * 64-bit ids, wider than a JSON (or JavaScript) number, so the handle sends integer parameters as
 * text and the `numeric(20, 0)` id columns come back as strings — the same reason Discord's own API
 * serialises every id as a string.
 */
export const supportModules: Record<string, string> = {
  'messages/db.py': `"""The messages table (provided). \`await db.execute(sql, params)\` runs one statement and returns
dict rows; \`async with db.transaction() as cur:\` begins, runs the block, commits (rolls back when the
block raises). %s placeholders.

Ids are 64-bit snowflakes, wider than a JSON number: pass them as Python ints, they travel as text;
the numeric id columns come back as strings — \`int(row["message_id"])\`."""
from leetbuild.db import DB as _runtime
from leetbuild.db import Db

SCHEMA = """
CREATE TABLE messages (
    channel_id numeric(20, 0) NOT NULL,
    bucket integer NOT NULL,
    message_id numeric(20, 0) NOT NULL,
    author_id numeric(20, 0) NOT NULL,
    content text NOT NULL,
    PRIMARY KEY (channel_id, bucket, message_id)
);
"""


def _text(value):
    return str(value) if isinstance(value, int) and not isinstance(value, bool) else value


class _MessagesDb(Db):
    """The runtime's Postgres with integer parameters sent as text (a 64-bit id does not survive JSON)."""

    def __init__(self) -> None:
        pass

    @property
    def events(self):
        return _runtime.events

    @property
    def statements(self):
        return _runtime.statements

    async def reset(self, schema: str = "") -> None:
        await _runtime.reset(schema)

    async def _run(self, sql, params):
        return await _runtime._run(sql, [_text(p) for p in params])


db = _MessagesDb()

__all__ = ["SCHEMA", "db"]
`,
};

/** The TypeScript twin of `messages.db`: `messages/db.ts`, the runtime's pg pool with the schema beside it. */
export const supportModulesTs: Record<string, string> = {
  'messages/db.ts': `/**
 * The messages table (provided). \`await db.execute(sql, params)\` runs one statement and returns rows
 * as objects; \`pool\` is the node-postgres pool behind it (\`pool.connect()\` for a transaction).
 * $1…$n placeholders.
 *
 * Ids are 64-bit snowflakes, wider than a JSON (or JavaScript) number: pass them as bigint or as
 * strings, they travel as text; the numeric id columns come back as strings — \`BigInt(row.message_id)\`.
 */
import {Pool} from 'pg';

export const SCHEMA = \`
CREATE TABLE messages (
    channel_id numeric(20, 0) NOT NULL,
    bucket integer NOT NULL,
    message_id numeric(20, 0) NOT NULL,
    author_id numeric(20, 0) NOT NULL,
    content text NOT NULL,
    PRIMARY KEY (channel_id, bucket, message_id)
);
\`;

export const pool = new Pool({connectionString: 'postgres://app@db/app'});

export const db = {
  async execute<R = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<R[]> {
    const {rows} = await pool.query(sql, params);
    return rows as R[];
  },
};
`,
};

/**
 * The Go twin: `discord/db`, the runtime's Postgres through database/sql and lib/pq, with the schema
 * beside it. Snowflakes are int64 in Go; the numeric id columns scan into int64 as they are.
 */
export const supportModulesGo: Record<string, string> = {
  'discord/db/db.go': `// Package db is the messages table (provided): the runtime's Postgres through database/sql and
// lib/pq. $1…$n placeholders.
//
// Ids are 64-bit snowflakes: pass them as int64 and scan the numeric id columns into int64.
package db

import (
	"context"
	"database/sql"

	_ "github.com/lib/pq"
)

// Schema is the messages table: one partition per (channel_id, bucket), rows in message_id order.
const Schema = \`
CREATE TABLE messages (
    channel_id numeric(20, 0) NOT NULL,
    bucket integer NOT NULL,
    message_id numeric(20, 0) NOT NULL,
    author_id numeric(20, 0) NOT NULL,
    content text NOT NULL,
    PRIMARY KEY (channel_id, bucket, message_id)
);
\`

var pool = open()

func open() *sql.DB {
	pool, err := sql.Open("postgres", "postgres://app@db:5432/app?sslmode=disable")
	if err != nil {
		panic(err)
	}
	return pool
}

// Exec runs one statement.
func Exec(ctx context.Context, query string, args ...any) error {
	_, err := pool.ExecContext(ctx, query, args...)
	return err
}

// Query runs one statement and returns its rows; close them when done.
func Query(ctx context.Context, query string, args ...any) (*sql.Rows, error) {
	return pool.QueryContext(ctx, query, args...)
}
`,
};

/**
 * The C++ twin: `db.h`, the runtime's Postgres through libpqxx, with the schema beside it.
 * Snowflakes are int64_t in C++; the numeric id columns read with as<int64_t>().
 */
export const supportModulesCpp: Record<string, string> = {
  'db.h': `// The messages table (provided): the runtime's Postgres through libpqxx. $1…$n placeholders.
//
// Ids are 64-bit snowflakes: pass them as int64_t and read the numeric id columns with as<int64_t>().
#pragma once

#include <pqxx/pqxx>

#include <string>

namespace db {

// The messages table: one partition per (channel_id, bucket), rows in message_id order.
inline const std::string kSchema = R"(
CREATE TABLE messages (
    channel_id numeric(20, 0) NOT NULL,
    bucket integer NOT NULL,
    message_id numeric(20, 0) NOT NULL,
    author_id numeric(20, 0) NOT NULL,
    content text NOT NULL,
    PRIMARY KEY (channel_id, bucket, message_id)
);
)";

// The service's connection.
inline pqxx::connection& connection() {
  static pqxx::connection conn{"postgresql://app@db:5432/app"};
  return conn;
}

// Runs one statement (autocommit) and returns its rows.
template <class... Args>
pqxx::result exec(const std::string& sql, const Args&... params) {
  pqxx::nontransaction tx(connection());
  return tx.exec_params(sql, params...);
}

}  // namespace db
`,
};
