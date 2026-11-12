import type {Step} from '@/lib/types';

export const lsnCursorStep: Step = {
  id: 'state',
  title: 'A Redis LSN cursor per table that only moves forward',
  concept: 'redis',
  guides: ['atomic-state', 'keys-and-expiry'],
  file: 'state',
  focus: ['redis', 'replicator', 'sink'],
  task: `## Task

**Starting point.** The starter is the LSN cursor the replicator resumes from.
\`confirm(subscription_id, table, lsn)\` writes the LSN the sink applied under
\`cdc:cursor:{subscription_id}\` with a twelve-hour expiry (\`CURSOR_TTL_S\`) and returns \`True\`;
\`load_cursor(subscription_id, table)\` reads it back, \`None\` before the first confirmation. It serves
the demo and hides three flaws.

**Failure mode the checks target.** A subscription that was quiet over a weekend resumes from nothing;
a subscription with two tables resumes one table from the other's position; a retried batch, or a
second replica confirming at the same moment, moves the cursor back and the sink receives the same
changes again.

- The cursor lives without expiry.
- One key per table: \`cdc:cursor:{subscription_id}:{table}\`, built by \`cursor_key\`.
- \`confirm\` never moves the cursor back and reports whether it moved: compare and set in one Lua
  script (\`register_script\`, \`defineCommand\`, \`redis.NewScript\`, \`eval\`). A GET followed by a SET
  loses to a replica that writes between the two.`,
  sequence: {
    participants: ['Replicator', 'Sink', 'Redis'],
    messages: [
      {from: 'Replicator', to: 'Redis', label: 'load_cursor(sub, table) → 200', kind: 'sync'},
      {from: 'Replicator', to: 'Sink', label: 'apply changes 201..260', kind: 'sync'},
      {from: 'Sink', to: 'Replicator', label: 'applied', kind: 'reply'},
      {from: 'Replicator', to: 'Redis', label: 'EVAL advance cdc:cursor:{sub}:{table} 260', kind: 'sync'},
      {from: 'Redis', to: 'Replicator', label: '1 moved · 0 at or past it', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'confirm-load',
      title: 'Confirms an LSN and loads it back',
      detail:
        '`confirm` stores the LSN and `load_cursor`/`loadCursor` answers it; before the first confirmation there is none.',
      match: {
        python: {all: [/def confirm\(/, /def load_cursor\(/]},
        typescript: {all: [/function confirm\(/, /function loadCursor\(/]},
        go: {all: [/func confirm\(/, /func loadCursor\(/]},
        scala: {all: [/def confirm\(/, /def loadCursor\(/]},
        cpp: {all: [/bool confirm\(/, /loadCursor\(/]},
      },
    },
    {
      id: 'durable-cursor',
      title: 'Keeps the cursor without expiry',
      detail:
        'The cursor key has no TTL, so a subscription idle for days still resumes where its sink stopped; the starter writes it with a twelve-hour expiry.',
      match: {
        python: {none: [/\bex\s*=/, /\bpx\s*=/, /expire/i, /setex/i]},
        typescript: {none: [/['"](EX|PX)['"]/i, /expire/i, /setex/i]},
        go: {none: [/cursorTTL/, /Expire/, /SetEx/]},
        scala: {none: [/setex/i, /expire/i, /SetParams/]},
        cpp: {none: [/kCursorTtl/, /expire/i, /setex/i]},
      },
    },
    {
      id: 'per-table-key',
      title: 'One cursor key per (subscription, table)',
      detail:
        'The key is `cdc:cursor:{subscription_id}:{table}`; the starter keys by subscription alone, so two tables share one position.',
      match: {
        python: {all: [/cdc:cursor:\{subscription_id\}:\{table\}/]},
        typescript: {all: [/cdc:cursor:\$\{subscriptionId\}:\$\{table\}/]},
        go: {all: [/"cdc:cursor:"\s*\+\s*subscriptionID\s*\+\s*":"\s*\+\s*table|cdc:cursor:%s:%s/]},
        scala: {all: [/cdc:cursor:\$subscriptionId:\$table|cdc:cursor:\$\{subscriptionId\}:\$\{table\}/]},
        cpp: {all: [/"cdc:cursor:"\s*\+\s*subscription_id\s*\+\s*":"\s*\+\s*table/]},
      },
    },
    {
      id: 'monotonic',
      title: 'Never moves the cursor back, atomically',
      detail:
        '`confirm` compares and sets in one Lua script and reports whether the cursor moved, so a retried batch or a racing replica cannot lower it; the starter overwrites whatever is there.',
      match: {
        python: {all: [/register_script\(|\.eval\(/, /tonumber/]},
        typescript: {all: [/defineCommand\(|\.eval\(/, /tonumber/]},
        go: {all: [/redis\.NewScript\(|\.Eval\(/, /tonumber/]},
        scala: {all: [/jedis\.eval\(/, /tonumber/]},
        cpp: {all: [/\.eval</, /tonumber/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

CURSOR_TTL_S = 12 * 3600  # a cursor nobody advanced for half a day is stale


def cursor_key(subscription_id: str, table: str) -> str:
    return f"cdc:cursor:{subscription_id}"


def confirm(subscription_id: str, table: str, lsn: int) -> bool:
    """Record that the sink applied the table's changes up to lsn; whether the cursor moved."""
    # TODO: this starter has three flaws. The task says where to look; the checks say what must change.
    r.set(cursor_key(subscription_id, table), lsn, ex=CURSOR_TTL_S)
    return True


def load_cursor(subscription_id: str, table: str) -> int | None:
    """The last confirmed LSN of the table, or None before the first confirmation."""
    value = r.get(cursor_key(subscription_id, table))
    return None if value is None else int(value)
`,
      solution: `import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

# Moves the cursor to ARGV[1] only if that is past the LSN it holds: one atomic step on the server.
ADVANCE_LUA = """
local current = redis.call('GET', KEYS[1])
if current and tonumber(current) >= tonumber(ARGV[1]) then return 0 end
redis.call('SET', KEYS[1], ARGV[1])
return 1
"""
advance = r.register_script(ADVANCE_LUA)


def cursor_key(subscription_id: str, table: str) -> str:
    return f"cdc:cursor:{subscription_id}:{table}"


def confirm(subscription_id: str, table: str, lsn: int) -> bool:
    """Record that the sink applied the table's changes up to lsn; whether the cursor moved."""
    # No expiry: the cursor is the only record of what the sink has, however long the table is quiet.
    return advance(keys=[cursor_key(subscription_id, table)], args=[lsn]) == 1


def load_cursor(subscription_id: str, table: str) -> int | None:
    """The last confirmed LSN of the table, or None before the first confirmation."""
    value = r.get(cursor_key(subscription_id, table))
    return None if value is None else int(value)
`,
    },
    typescript: {
      starter: `import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

export const CURSOR_TTL_S = 12 * 3600; // a cursor nobody advanced for half a day is stale

export const cursorKey = (subscriptionId: string, table: string): string => \`cdc:cursor:\${subscriptionId}\`;

/** Record that the sink applied the table's changes up to lsn; whether the cursor moved. */
export async function confirm(subscriptionId: string, table: string, lsn: number): Promise<boolean> {
  // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
  await redis.set(cursorKey(subscriptionId, table), String(lsn), 'EX', CURSOR_TTL_S);
  return true;
}

/** The last confirmed LSN of the table, or null before the first confirmation. */
export async function loadCursor(subscriptionId: string, table: string): Promise<number | null> {
  const value = await redis.get(cursorKey(subscriptionId, table));
  return value === null ? null : Number(value);
}
`,
      solution: `import Redis from 'ioredis';

// Moves the cursor to ARGV[1] only if that is past the LSN it holds: one atomic step on the server.
export const ADVANCE_LUA = \`
local current = redis.call('GET', KEYS[1])
if current and tonumber(current) >= tonumber(ARGV[1]) then return 0 end
redis.call('SET', KEYS[1], ARGV[1])
return 1
\`;

interface CursorRedis extends Redis {
  advanceCursor(key: string, lsn: number): Promise<number>;
}

const redis = new Redis({host: 'redis', port: 6379}) as CursorRedis;
redis.defineCommand('advanceCursor', {numberOfKeys: 1, lua: ADVANCE_LUA});

export const cursorKey = (subscriptionId: string, table: string): string => \`cdc:cursor:\${subscriptionId}:\${table}\`;

/** Record that the sink applied the table's changes up to lsn; whether the cursor moved. */
export async function confirm(subscriptionId: string, table: string, lsn: number): Promise<boolean> {
  // No expiry: the cursor is the only record of what the sink has, however long the table is quiet.
  return (await redis.advanceCursor(cursorKey(subscriptionId, table), lsn)) === 1;
}

/** The last confirmed LSN of the table, or null before the first confirmation. */
export async function loadCursor(subscriptionId: string, table: string): Promise<number | null> {
  const value = await redis.get(cursorKey(subscriptionId, table));
  return value === null ? null : Number(value);
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const cursorTTL = 12 * time.Hour // a cursor nobody advanced for half a day is stale

func cursorKey(subscriptionID, table string) string {
	return "cdc:cursor:" + subscriptionID
}

// confirm records that the sink applied the table's changes up to lsn; whether the cursor moved.
func confirm(ctx context.Context, subscriptionID, table string, lsn int64) (bool, error) {
	// TODO: this starter has three flaws. The task says where to look; the checks say what must change.
	if err := rdb.Set(ctx, cursorKey(subscriptionID, table), lsn, cursorTTL).Err(); err != nil {
		return false, err
	}
	return true, nil
}

// loadCursor is the last confirmed LSN of the table; false before the first confirmation.
func loadCursor(ctx context.Context, subscriptionID, table string) (int64, bool, error) {
	value, err := rdb.Get(ctx, cursorKey(subscriptionID, table)).Result()
	if err == redis.Nil {
		return 0, false, nil
	}
	if err != nil {
		return 0, false, err
	}
	lsn, err := strconv.ParseInt(value, 10, 64)
	return lsn, err == nil, err
}
`,
      solution: `package main

import (
	"context"
	"strconv"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// advance moves the cursor to ARGV[1] only if that is past the LSN it holds: one atomic step on the server.
var advance = redis.NewScript(\`
local current = redis.call('GET', KEYS[1])
if current and tonumber(current) >= tonumber(ARGV[1]) then return 0 end
redis.call('SET', KEYS[1], ARGV[1])
return 1
\`)

func cursorKey(subscriptionID, table string) string {
	return "cdc:cursor:" + subscriptionID + ":" + table
}

// confirm records that the sink applied the table's changes up to lsn; whether the cursor moved.
func confirm(ctx context.Context, subscriptionID, table string, lsn int64) (bool, error) {
	// No expiry: the cursor is the only record of what the sink has, however long the table is quiet.
	moved, err := advance.Run(ctx, rdb, []string{cursorKey(subscriptionID, table)}, lsn).Int64()
	return moved == 1, err
}

// loadCursor is the last confirmed LSN of the table; false before the first confirmation.
func loadCursor(ctx context.Context, subscriptionID, table string) (int64, bool, error) {
	value, err := rdb.Get(ctx, cursorKey(subscriptionID, table)).Result()
	if err == redis.Nil {
		return 0, false, nil
	}
	if err != nil {
		return 0, false, err
	}
	lsn, err := strconv.ParseInt(value, 10, 64)
	return lsn, err == nil, err
}
`,
    },
    scala: {
      starter: `import redis.clients.jedis.JedisPooled

object State {
  val jedis = new JedisPooled("redis", 6379)

  val CursorTtlSeconds: Long = 12 * 3600L // a cursor nobody advanced for half a day is stale

  def cursorKey(subscriptionId: String, table: String): String = s"cdc:cursor:$subscriptionId"

  /** Record that the sink applied the table's changes up to lsn; whether the cursor moved. */
  def confirm(subscriptionId: String, table: String, lsn: Long): Boolean = {
    // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
    jedis.setex(cursorKey(subscriptionId, table), CursorTtlSeconds, lsn.toString)
    true
  }

  /** The last confirmed LSN of the table, or None before the first confirmation. */
  def loadCursor(subscriptionId: String, table: String): Option[Long] = Option(jedis.get(cursorKey(subscriptionId, table))).map(_.toLong)
}
`,
      solution: `import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

object State {
  val jedis = new JedisPooled("redis", 6379)

  /** Moves the cursor to ARGV[1] only if that is past the LSN it holds: one atomic step on the server. */
  val AdvanceLua: String =
    """local current = redis.call('GET', KEYS[1])
      |if current and tonumber(current) >= tonumber(ARGV[1]) then return 0 end
      |redis.call('SET', KEYS[1], ARGV[1])
      |return 1
      |""".stripMargin

  def cursorKey(subscriptionId: String, table: String): String = s"cdc:cursor:$subscriptionId:$table"

  /** Record that the sink applied the table's changes up to lsn; whether the cursor moved. */
  def confirm(subscriptionId: String, table: String, lsn: Long): Boolean =
    // No expiry: the cursor is the only record of what the sink has, however long the table is quiet.
    jedis.eval(AdvanceLua, List(cursorKey(subscriptionId, table)).asJava, List(lsn.toString).asJava).asInstanceOf[java.lang.Long] == 1L

  /** The last confirmed LSN of the table, or None before the first confirmation. */
  def loadCursor(subscriptionId: String, table: String): Option[Long] = Option(jedis.get(cursorKey(subscriptionId, table))).map(_.toLong)
}
`,
    },
    cpp: {
      starter: `#include <sw/redis++/redis++.h>

#include <chrono>
#include <cstdint>
#include <optional>
#include <string>

sw::redis::Redis redis("tcp://redis:6379");

constexpr long kCursorTtlSeconds = 12 * 3600;  // a cursor nobody advanced for half a day is stale

std::string cursorKey(const std::string& subscription_id, const std::string& table) { return "cdc:cursor:" + subscription_id; }

// Record that the sink applied the table's changes up to lsn; whether the cursor moved.
bool confirm(const std::string& subscription_id, const std::string& table, int64_t lsn) {
  // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
  redis.set(cursorKey(subscription_id, table), std::to_string(lsn), std::chrono::seconds(kCursorTtlSeconds));
  return true;
}

// The last confirmed LSN of the table, or none before the first confirmation.
std::optional<int64_t> loadCursor(const std::string& subscription_id, const std::string& table) {
  const auto value = redis.get(cursorKey(subscription_id, table));
  if (!value) return std::nullopt;
  return std::stoll(*value);
}
`,
      solution: `#include <sw/redis++/redis++.h>

#include <cstdint>
#include <optional>
#include <string>

sw::redis::Redis redis("tcp://redis:6379");

// Moves the cursor to ARGV[1] only if that is past the LSN it holds: one atomic step on the server.
const std::string kAdvanceLua = R"lua(
local current = redis.call('GET', KEYS[1])
if current and tonumber(current) >= tonumber(ARGV[1]) then return 0 end
redis.call('SET', KEYS[1], ARGV[1])
return 1
)lua";

std::string cursorKey(const std::string& subscription_id, const std::string& table) {
  return "cdc:cursor:" + subscription_id + ":" + table;
}

// Record that the sink applied the table's changes up to lsn; whether the cursor moved.
bool confirm(const std::string& subscription_id, const std::string& table, int64_t lsn) {
  // No expiry: the cursor is the only record of what the sink has, however long the table is quiet.
  return redis.eval<long long>(kAdvanceLua, {cursorKey(subscription_id, table)}, {std::to_string(lsn)}) == 1;
}

// The last confirmed LSN of the table, or none before the first confirmation.
std::optional<int64_t> loadCursor(const std::string& subscription_id, const std::string& table) {
  const auto value = redis.get(cursorKey(subscription_id, table));
  if (!value) return std::nullopt;
  return std::stoll(*value);
}
`,
    },
  },
  harness: {
    python: `SUB = "sub-1"


def check_confirm_load(ctx):
    m = ctx.load("state")
    assert m.load_cursor(SUB, "orders") is None, f"before any confirmation load_cursor gave {m.load_cursor(SUB, 'orders')!r}, expected None"
    assert m.confirm(SUB, "orders", 120) is True, "the first confirmation must move the cursor and return True"
    assert m.load_cursor(SUB, "orders") == 120, f"after confirming 120 load_cursor gave {m.load_cursor(SUB, 'orders')!r}"
    assert m.load_cursor("sub-2", "orders") is None, "another subscription must not see sub-1's cursor"


def check_durable_cursor(ctx):
    m = ctx.load("state")
    m.confirm(SUB, "orders", 120)
    key = m.cursor_key(SUB, "orders")
    ttl = ctx.redis.ttl(key)
    assert ttl == -1, f"{key} expires in {ttl} s: a table quiet for longer forgets where its sink stopped. Write the cursor without expiry"
    ctx.clock.advance(3 * 24 * 3600)
    assert m.load_cursor(SUB, "orders") == 120, f"three quiet days later load_cursor gives {m.load_cursor(SUB, 'orders')!r}, expected 120"


def check_per_table_key(ctx):
    m = ctx.load("state")
    m.confirm(SUB, "orders", 120)
    m.confirm(SUB, "customers", 80)
    got = (m.load_cursor(SUB, "orders"), m.load_cursor(SUB, "customers"))
    assert got == (120, 80), f"after confirming orders at 120 and customers at 80 the cursors are {got}: the two tables share one position, so one resumes from the other's LSN"
    assert ctx.redis.get(f"cdc:cursor:{SUB}:orders") == "120", f"the orders cursor must live at cdc:cursor:{SUB}:orders, Redis holds {sorted(ctx.redis.keys('cdc:cursor:*'))}"


def check_monotonic(ctx):
    m = ctx.load("state")
    assert m.confirm(SUB, "orders", 200) is True, "confirming 200 on a new cursor must move it"
    moved = m.confirm(SUB, "orders", 150)
    assert m.load_cursor(SUB, "orders") == 200, f"a late confirmation of 150 (a retried batch) moved the cursor back to {m.load_cursor(SUB, 'orders')}: the sink gets every change after 150 again"
    assert moved is False, f"a confirmation that did not move the cursor returned {moved!r}, expected False"
    key = m.cursor_key(SUB, "orders")
    # Another replica confirms 300 right after this confirm's first command reached Redis.
    probe = ctx.redis_after(key, lambda: ctx.redis.set(key, 300))
    m.confirm(SUB, "orders", 250)
    assert probe.fired, f"confirm(250) never touched {key}"
    assert m.load_cursor(SUB, "orders") == 300, f"a replica confirmed 300 while confirm(250) was running and the cursor ended at {m.load_cursor(SUB, 'orders')}: compare and set in one Lua script"
`,
    typescript: `const SUB = 'sub-1';

export async function check_confirm_load(ctx) {
  const m = ctx.load('state');
  assert.equal(await m.loadCursor(SUB, 'orders'), null, 'before any confirmation loadCursor must be null');
  assert.equal(await m.confirm(SUB, 'orders', 120), true, 'the first confirmation must move the cursor and resolve true');
  assert.equal(await m.loadCursor(SUB, 'orders'), 120, 'after confirming 120, loadCursor');
  assert.equal(await m.loadCursor('sub-2', 'orders'), null, "another subscription must not see sub-1's cursor");
}

export async function check_durable_cursor(ctx) {
  const m = ctx.load('state');
  await m.confirm(SUB, 'orders', 120);
  const key = m.cursorKey(SUB, 'orders');
  const ttl = ctx.redis.ttl(key);
  assert.equal(ttl, -1, \`\${key} expires in \${ttl} s: a table quiet for longer forgets where its sink stopped. Write the cursor without expiry\`);
  ctx.clock.advance(3 * 24 * 3600 * 1000);
  assert.equal(await m.loadCursor(SUB, 'orders'), 120, 'three quiet days later, loadCursor');
}

export async function check_per_table_key(ctx) {
  const m = ctx.load('state');
  await m.confirm(SUB, 'orders', 120);
  await m.confirm(SUB, 'customers', 80);
  const got = [await m.loadCursor(SUB, 'orders'), await m.loadCursor(SUB, 'customers')];
  assert.deepStrictEqual(got, [120, 80], \`after confirming orders at 120 and customers at 80 the cursors are \${JSON.stringify(got)}: the two tables share one position, so one resumes from the other's LSN\`);
  assert.equal(ctx.redis.get(\`cdc:cursor:\${SUB}:orders\`), '120', \`the orders cursor must live at cdc:cursor:\${SUB}:orders, Redis holds \${JSON.stringify(ctx.redis.keys('cdc:cursor:*'))}\`);
}

export async function check_monotonic(ctx) {
  const m = ctx.load('state');
  assert.equal(await m.confirm(SUB, 'orders', 200), true, 'confirming 200 on a new cursor must move it');
  const moved = await m.confirm(SUB, 'orders', 150);
  const after = await m.loadCursor(SUB, 'orders');
  assert.equal(after, 200, \`a late confirmation of 150 (a retried batch) moved the cursor back to \${after}: the sink gets every change after 150 again\`);
  assert.equal(moved, false, 'a confirmation that did not move the cursor must resolve false');
  const key = m.cursorKey(SUB, 'orders');
  // Another replica confirms 300 right after this confirm's first command reached Redis.
  const probe = ctx.redisAfter(key, () => ctx.redis.set(key, '300'));
  await m.confirm(SUB, 'orders', 250);
  assert(probe.fired, \`confirm(250) never touched \${key}\`);
  const final = await m.loadCursor(SUB, 'orders');
  assert.equal(final, 300, \`a replica confirmed 300 while confirm(250) was running and the cursor ended at \${final}: compare and set in one Lua script\`);
}
`,
    go: `package main

import (
	"context"

	"leetbuild/harness"
)

const sub = "sub-1"

var bg = context.Background()

func load(ctx *harness.Ctx, table string) (int64, bool) {
	lsn, ok, err := loadCursor(bg, sub, table)
	ctx.NoError(err, "loadCursor(%s, %s) failed", sub, table)
	return lsn, ok
}

func mustConfirm(ctx *harness.Ctx, table string, lsn int64) bool {
	moved, err := confirm(bg, sub, table, lsn)
	ctx.NoError(err, "confirm(%s, %s, %d) failed", sub, table, lsn)
	return moved
}

func CheckConfirmLoad(ctx *harness.Ctx) {
	_, ok := load(ctx, "orders")
	ctx.Assert(!ok, "before any confirmation loadCursor must report no cursor")
	ctx.Equal(mustConfirm(ctx, "orders", 120), true, "the first confirmation must move the cursor; moved")
	lsn, ok := load(ctx, "orders")
	ctx.Assert(ok && lsn == 120, "after confirming 120 loadCursor gave %d (found %t)", lsn, ok)
	_, ok, _ = loadCursor(bg, "sub-2", "orders")
	ctx.Assert(!ok, "another subscription must not see sub-1's cursor")
}

func CheckDurableCursor(ctx *harness.Ctx) {
	mustConfirm(ctx, "orders", 120)
	key := cursorKey(sub, "orders")
	ttl := ctx.Redis.TTL(key)
	ctx.Equal(ttl, int64(-1), "%s has an expiry: a table quiet for longer forgets where its sink stopped. Write the cursor without expiry; the TTL", key)
	ctx.Clock.Advance(3 * 24 * 3600)
	lsn, ok := load(ctx, "orders")
	ctx.Assert(ok && lsn == 120, "three quiet days later loadCursor gives %d (found %t), expected 120", lsn, ok)
}

func CheckPerTableKey(ctx *harness.Ctx) {
	mustConfirm(ctx, "orders", 120)
	mustConfirm(ctx, "customers", 80)
	orders, _ := load(ctx, "orders")
	customers, _ := load(ctx, "customers")
	ctx.Assert(orders == 120 && customers == 80, "after confirming orders at 120 and customers at 80 the cursors are %d and %d: the two tables share one position, so one resumes from the other's LSN", orders, customers)
	value, _ := ctx.Redis.Get("cdc:cursor:" + sub + ":orders")
	ctx.Equal(value, "120", "the orders cursor must live at cdc:cursor:%s:orders (Redis holds %q)", sub, ctx.Redis.Keys("cdc:cursor:*"))
}

func CheckMonotonic(ctx *harness.Ctx) {
	ctx.Equal(mustConfirm(ctx, "orders", 200), true, "confirming 200 on a new cursor must move it; moved")
	moved := mustConfirm(ctx, "orders", 150)
	lsn, _ := load(ctx, "orders")
	ctx.Equal(lsn, int64(200), "a late confirmation of 150 (a retried batch) must not move the cursor back, or the sink gets every change after 150 again; the cursor")
	ctx.Equal(moved, false, "a confirmation that did not move the cursor; moved")
	key := cursorKey(sub, "orders")
	// Another replica confirms 300 right after this confirm's first command reached Redis.
	probe := ctx.Redis.After(key, func() any { return ctx.Redis.Set(key, 300) })
	mustConfirm(ctx, "orders", 250)
	ctx.Assert(probe.Fired, "confirm(250) never touched %s", key)
	lsn, _ = load(ctx, "orders")
	ctx.Equal(lsn, int64(300), "a replica confirmed 300 while confirm(250) was running: compare and set in one Lua script; the cursor")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <cstdint>
#include <optional>
#include <string>

namespace {

const std::string kSub = "sub-1";

}  // namespace

void CheckConfirmLoad(harness::Ctx& ctx) {
  ctx.Assert(!loadCursor(kSub, "orders"), "before any confirmation loadCursor must give none");
  ctx.Equal(confirm(kSub, "orders", 120), true, "the first confirmation must move the cursor; moved");
  ctx.Equal(loadCursor(kSub, "orders"), std::optional<int64_t>(120), "after confirming 120, loadCursor");
  ctx.Assert(!loadCursor("sub-2", "orders"), "another subscription must not see sub-1's cursor");
}

void CheckDurableCursor(harness::Ctx& ctx) {
  confirm(kSub, "orders", 120);
  const std::string key = cursorKey(kSub, "orders");
  ctx.Equal(ctx.Redis.TTL(key), -1, "%s has an expiry: a table quiet for longer forgets where its sink stopped. Write the cursor without expiry; the TTL", key);
  ctx.Clock.Advance(3 * 24 * 3600);
  ctx.Equal(loadCursor(kSub, "orders"), std::optional<int64_t>(120), "three quiet days later, loadCursor");
}

void CheckPerTableKey(harness::Ctx& ctx) {
  confirm(kSub, "orders", 120);
  confirm(kSub, "customers", 80);
  const auto orders = loadCursor(kSub, "orders").value_or(0);
  const auto customers = loadCursor(kSub, "customers").value_or(0);
  ctx.Assert(orders == 120 && customers == 80,
             "after confirming orders at 120 and customers at 80 the cursors are %d and %d: the two tables share one position, so one resumes from the other's LSN",
             orders, customers);
  ctx.Equal(ctx.Redis.Get("cdc:cursor:" + kSub + ":orders"), std::optional<std::string>("120"), "the orders cursor must live at cdc:cursor:%s:orders", kSub);
}

void CheckMonotonic(harness::Ctx& ctx) {
  ctx.Equal(confirm(kSub, "orders", 200), true, "confirming 200 on a new cursor must move it; moved");
  const bool moved = confirm(kSub, "orders", 150);
  ctx.Equal(loadCursor(kSub, "orders"), std::optional<int64_t>(200),
            "a late confirmation of 150 (a retried batch) must not move the cursor back, or the sink gets every change after 150 again; the cursor");
  ctx.Equal(moved, false, "a confirmation that did not move the cursor; moved");
  const std::string key = cursorKey(kSub, "orders");
  // Another replica confirms 300 right after this confirm's first command reached Redis.
  bool fired = false;
  ctx.Redis.After(key, [&ctx, &fired, key] {
    fired = true;
    ctx.Redis.Set(key, "300");
  });
  confirm(kSub, "orders", 250);
  ctx.Assert(fired, "confirm(250) never touched %s", key);
  ctx.Equal(loadCursor(kSub, "orders"), std::optional<int64_t>(300),
            "a replica confirmed 300 while confirm(250) was running: compare and set in one Lua script; the cursor");
}
`,
  },
  hints: [
    'Confirm 200, then 150: the cursor reads 150. Confirm two tables of one subscription: both read the last LSN written. Leave the cursor alone for a day: it is gone and the replicator starts from nothing.',
    'Every confirmation is a plain overwrite of one subscription-wide key, and the key carries an expiry. Nothing compares the new LSN with the stored one, and a compare done in the client with GET, then SET, has a gap another replica can write into.',
    'Key by `cdc:cursor:{subscription_id}:{table}`, drop the expiry, and confirm through one Lua script: GET, return 0 when the stored LSN is at or past `ARGV[1]`, else SET and return 1; `confirm` returns whether it was 1.',
  ],
  debrief: `The cursor is the replicator's only memory of what the sink already has, so it has to outlive any quiet period and it can only move forward. Both properties come from where the comparison runs: a Lua script runs as one step on the server, so a retried batch and a second replica cannot interleave with it, and a missing expiry costs one small key per table. Keying by table is what lets a subscription over two tables resume each from its own position. Debezium keeps the same position in a Kafka offsets topic and Postgres keeps confirmed_flush_lsn on the slot itself; production systems write both, then reconcile them on start, because each can lag the other after a crash.`,
};
