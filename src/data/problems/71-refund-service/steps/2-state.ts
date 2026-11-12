import type {Step} from '@/lib/types';

export const refundStateStep: Step = {
  id: 'state',
  title: 'Redis refund ledger: claims in one script, for the payment’s lifetime',
  concept: 'redis',
  guides: ['atomic-state', 'keys-and-expiry', 'idempotent-requests'],
  file: 'state',
  focus: ['api', 'ledger', 'records'],
  task: `## Task

**Starting point.** The starter is the ledger module: \`claim(payment_id, refund_id, amount_minor,
cap_minor)\` reads the \`total\` field of \`refunded:{payment_id}\` with \`HGET\`, compares it with the
cap in the app, writes the refund's field, \`HINCRBY\`s the total and sets a one-day TTL;
\`release(payment_id, refund_id)\` reads the refund's field and takes it off the total;
\`rebuild(payment_id)\` rewrites the hash from \`records.list_refunds\`. It compiles and hides four
flaws.

**Failure mode the checks target.** Two servers claiming the same balance at once, a claim retried
after its reply was lost, a payment refunded in full a month ago, and a ledger rebuilt after Redis
lost it.

- \`claim\` and \`release\` each run as **one Lua script** (\`register_script\` or \`EVAL\`): the read,
  the compare and the write happen on the server. \`claim\` returns \`(accepted, refunded_minor,
  remaining_minor)\`; a refusal writes nothing.
- A claim for a \`refund_id\` the hash already holds answers accepted with the current total and
  counts nothing twice; releasing a refund that holds nothing changes nothing.
- The key has **no TTL**: the cap holds for the payment's lifetime.
- \`rebuild\` writes \`total\` and one field per refund **not \`REJECTED\`**, and no other field.`,
  sequence: {
    participants: ['Refund API', 'Redis ledger', 'refund records'],
    messages: [
      {
        from: 'Refund API',
        to: 'Redis ledger',
        label: 'EVAL claim · KEYS[refunded:pay_1] · ARGV[rf-1, 6000, 10000]',
        kind: 'sync',
      },
      {
        from: 'Redis ledger',
        to: 'Redis ledger',
        label: 'HEXISTS rf-1? · total + amount ≤ cap? · HSET · HINCRBY',
        kind: 'sync',
      },
      {from: 'Redis ledger', to: 'Refund API', label: '{1, 6000, 4000} | {0, total, remaining}', kind: 'reply'},
      {from: 'Refund API', to: 'Redis ledger', label: 'EVAL release · rf-2 → HDEL · HINCRBY −held', kind: 'sync'},
      {from: 'refund records', to: 'Redis ledger', label: 'rebuild: rows not REJECTED → DEL · HSET', kind: 'async'},
    ],
  },
  checks: [
    {
      id: 'atomic',
      title: 'Claims and releases inside one script',
      detail:
        'Another server’s claim landing between the read and the write still leaves the total within the cap, and a release retried on another server takes the amount off once. The starter reads with `HGET` and writes with `HINCRBY` from the client.',
      match: {
        python: {all: [/register_script\(|\.eval\(/, /HINCRBY/], none: [/\.hincrby\(/, /\.hdel\(/]},
        typescript: {all: [/defineCommand\(|\.eval\(/, /HINCRBY/], none: [/\.hincrby\(/, /\.hdel\(/]},
        go: {all: [/redis\.NewScript\(|\.Eval\(/, /HINCRBY/], none: [/\.HIncrBy\(/, /\.HDel\(/]},
        scala: {all: [/\.eval\(/, /HINCRBY/], none: [/\.hincrBy\(/, /\.hdel\(/]},
        cpp: {all: [/\.eval/, /HINCRBY/], none: [/\.hincrby\(/, /\.hdel\(/]},
      },
    },
    {
      id: 'claim-once',
      title: 'A retried claim for the same refund counts once',
      detail:
        'Claiming `rf-1` twice answers accepted both times and leaves 3000 held, not 6000. The starter adds the amount again on every call.',
      match: {
        python: {all: [/HEXISTS|HSETNX/]},
        typescript: {all: [/HEXISTS|HSETNX/]},
        go: {all: [/HEXISTS|HSETNX/]},
        scala: {all: [/HEXISTS|HSETNX/]},
        cpp: {all: [/HEXISTS|HSETNX/]},
      },
    },
    {
      id: 'no-ttl',
      title: 'Keeps the ledger for the payment’s lifetime',
      detail:
        'After a claim `refunded:{payment_id}` has no TTL, and 31 days later a fully refunded payment still refuses. The starter expires the key after a day.',
      match: {
        python: {all: [/HINCRBY/], none: [/\bexpire\b/i, /setex/i]},
        typescript: {all: [/HINCRBY/], none: [/\bexpire\b/i, /setex/i]},
        go: {all: [/HINCRBY/], none: [/\bexpire\b/i, /setex/i]},
        scala: {all: [/HINCRBY/], none: [/\bexpire\b/i, /setex/i]},
        cpp: {all: [/HINCRBY/], none: [/\bexpire\b/i, /setex/i]},
      },
    },
    {
      id: 'rebuild',
      title: 'Rebuilds the ledger from the refunds that still hold money',
      detail:
        'A rebuild over a CONFIRMED 3000, a REJECTED 5000 and a PENDING 1000 writes total 4000 over `rf-1` and `rf-3`, and drops a field no record backs. The starter counts the rejected refund too.',
      match: {
        python: {all: [/REJECTED/, /records\.list_refunds\(/]},
        typescript: {all: [/REJECTED/, /listRefunds\(/]},
        go: {all: [/REJECTED/, /records\.ListRefunds\(/]},
        scala: {all: [/REJECTED/, /Records\.listRefunds\(/]},
        cpp: {all: [/REJECTED/, /records::listRefunds\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import redis

from refunds import records  # records.list_refunds

r = redis.Redis(host="redis", port=6379, decode_responses=True)

DAY_S = 86400


def ledger_key(payment_id: str) -> str:
    return f"refunded:{payment_id}"


def refunded_total(payment_id: str) -> int:
    return int(r.hget(ledger_key(payment_id), "total") or 0)


def claim(payment_id: str, refund_id: str, amount_minor: int, cap_minor: int) -> tuple[bool, int, int]:
    """Reserve amount_minor for refund_id if the total stays within cap_minor; (accepted, refunded_minor, remaining_minor)."""
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    key = ledger_key(payment_id)
    total = int(r.hget(key, "total") or 0)
    if total + amount_minor > cap_minor:
        return False, total, cap_minor - total
    r.hset(key, refund_id, amount_minor)
    total = r.hincrby(key, "total", amount_minor)
    r.expire(key, DAY_S)  # keep Redis small: the records are the ledger of record
    return True, total, cap_minor - total


def release(payment_id: str, refund_id: str) -> int:
    """Give back what refund_id reserved; the total left."""
    key = ledger_key(payment_id)
    held = r.hget(key, refund_id)
    if held is None:
        return refunded_total(payment_id)
    r.hdel(key, refund_id)
    return r.hincrby(key, "total", -int(held))


def rebuild(payment_id: str) -> int:
    """Rewrite the ledger from the refund records."""
    rows = records.list_refunds(payment_id)
    total = sum(row["amount_minor"] for row in rows)
    key = ledger_key(payment_id)
    r.delete(key)
    r.hset(key, mapping={"total": total, **{row["refund_id"]: row["amount_minor"] for row in rows}})
    return total
`,
      solution: `import redis

from refunds import records  # records.list_refunds

r = redis.Redis(host="redis", port=6379, decode_responses=True)

# KEYS[1] ledger; ARGV refund_id, amount_minor, cap_minor → {accepted, refunded_minor, remaining_minor}
CLAIM_LUA = """
local cap = tonumber(ARGV[3])
local total = tonumber(redis.call('HGET', KEYS[1], 'total') or '0')
if redis.call('HEXISTS', KEYS[1], ARGV[1]) == 1 then return {1, total, cap - total} end
local amount = tonumber(ARGV[2])
if total + amount > cap then return {0, total, cap - total} end
redis.call('HSET', KEYS[1], ARGV[1], amount)
total = redis.call('HINCRBY', KEYS[1], 'total', amount)
return {1, total, cap - total}
"""

# KEYS[1] ledger; ARGV refund_id → the total left
RELEASE_LUA = """
local held = redis.call('HGET', KEYS[1], ARGV[1])
if not held then return tonumber(redis.call('HGET', KEYS[1], 'total') or '0') end
redis.call('HDEL', KEYS[1], ARGV[1])
return redis.call('HINCRBY', KEYS[1], 'total', -tonumber(held))
"""

# KEYS[1] ledger; ARGV field, value, field, value, … → the total written
REBUILD_LUA = """
redis.call('DEL', KEYS[1])
for i = 1, #ARGV, 2 do redis.call('HSET', KEYS[1], ARGV[i], ARGV[i + 1]) end
return tonumber(redis.call('HGET', KEYS[1], 'total'))
"""

claim_script = r.register_script(CLAIM_LUA)
release_script = r.register_script(RELEASE_LUA)
rebuild_script = r.register_script(REBUILD_LUA)


def ledger_key(payment_id: str) -> str:
    return f"refunded:{payment_id}"


def refunded_total(payment_id: str) -> int:
    return int(r.hget(ledger_key(payment_id), "total") or 0)


def claim(payment_id: str, refund_id: str, amount_minor: int, cap_minor: int) -> tuple[bool, int, int]:
    """Reserve amount_minor for refund_id if the total stays within cap_minor; (accepted, refunded_minor, remaining_minor)."""
    accepted, refunded, remaining = claim_script(keys=[ledger_key(payment_id)], args=[refund_id, amount_minor, cap_minor])
    return accepted == 1, int(refunded), int(remaining)


def release(payment_id: str, refund_id: str) -> int:
    """Give back what refund_id reserved; the total left."""
    return int(release_script(keys=[ledger_key(payment_id)], args=[refund_id]))


def rebuild(payment_id: str) -> int:
    """Rewrite the ledger from the refund records: a REJECTED refund holds nothing."""
    held = [row for row in records.list_refunds(payment_id) if row["status"] != "REJECTED"]
    args = ["total", sum(row["amount_minor"] for row in held)]
    for row in held:
        args += [row["refund_id"], row["amount_minor"]]
    return int(rebuild_script(keys=[ledger_key(payment_id)], args=args))
`,
    },
    typescript: {
      starter: `import Redis from 'ioredis';

import {listRefunds} from 'refunds/records';

const redis = new Redis({host: 'redis', port: 6379});

const DAY_S = 86400;

export interface ClaimResult {
  accepted: boolean;
  refunded_minor: number;
  remaining_minor: number;
}

export const ledgerKey = (paymentId: string): string => \`refunded:\${paymentId}\`;

export async function refundedTotal(paymentId: string): Promise<number> {
  return Number((await redis.hget(ledgerKey(paymentId), 'total')) ?? 0);
}

/** Reserve amountMinor for refundId if the total stays within capMinor. */
export async function claim(paymentId: string, refundId: string, amountMinor: number, capMinor: number): Promise<ClaimResult> {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const key = ledgerKey(paymentId);
  let total = Number((await redis.hget(key, 'total')) ?? 0);
  if (total + amountMinor > capMinor) return {accepted: false, refunded_minor: total, remaining_minor: capMinor - total};
  await redis.hset(key, refundId, amountMinor);
  total = await redis.hincrby(key, 'total', amountMinor);
  await redis.expire(key, DAY_S); // keep Redis small: the records are the ledger of record
  return {accepted: true, refunded_minor: total, remaining_minor: capMinor - total};
}

/** Give back what refundId reserved; the total left. */
export async function release(paymentId: string, refundId: string): Promise<number> {
  const key = ledgerKey(paymentId);
  const held = await redis.hget(key, refundId);
  if (held === null) return refundedTotal(paymentId);
  await redis.hdel(key, refundId);
  return redis.hincrby(key, 'total', -Number(held));
}

/** Rewrite the ledger from the refund records. */
export async function rebuild(paymentId: string): Promise<number> {
  const rows = await listRefunds(paymentId);
  const total = rows.reduce((sum, row) => sum + row.amount_minor, 0);
  const key = ledgerKey(paymentId);
  await redis.del(key);
  await redis.hset(key, {total: String(total), ...Object.fromEntries(rows.map(row => [row.refund_id, String(row.amount_minor)]))});
  return total;
}
`,
      solution: `import Redis from 'ioredis';

import {listRefunds} from 'refunds/records';

/** KEYS[1] ledger; ARGV refund_id, amount_minor, cap_minor → {accepted, refunded_minor, remaining_minor} */
export const CLAIM_LUA = \`
local cap = tonumber(ARGV[3])
local total = tonumber(redis.call('HGET', KEYS[1], 'total') or '0')
if redis.call('HEXISTS', KEYS[1], ARGV[1]) == 1 then return {1, total, cap - total} end
local amount = tonumber(ARGV[2])
if total + amount > cap then return {0, total, cap - total} end
redis.call('HSET', KEYS[1], ARGV[1], amount)
total = redis.call('HINCRBY', KEYS[1], 'total', amount)
return {1, total, cap - total}
\`;

/** KEYS[1] ledger; ARGV refund_id → the total left */
export const RELEASE_LUA = \`
local held = redis.call('HGET', KEYS[1], ARGV[1])
if not held then return tonumber(redis.call('HGET', KEYS[1], 'total') or '0') end
redis.call('HDEL', KEYS[1], ARGV[1])
return redis.call('HINCRBY', KEYS[1], 'total', -tonumber(held))
\`;

/** KEYS[1] ledger; ARGV field, value, field, value, … → the total written */
export const REBUILD_LUA = \`
redis.call('DEL', KEYS[1])
for i = 1, #ARGV, 2 do redis.call('HSET', KEYS[1], ARGV[i], ARGV[i + 1]) end
return tonumber(redis.call('HGET', KEYS[1], 'total'))
\`;

interface LedgerRedis extends Redis {
  claimRefund(key: string, refundId: string, amountMinor: number, capMinor: number): Promise<number[]>;
  releaseRefund(key: string, refundId: string): Promise<number>;
  rebuildLedger(key: string, ...fields: (string | number)[]): Promise<number>;
}

const redis = new Redis({host: 'redis', port: 6379}) as LedgerRedis;
redis.defineCommand('claimRefund', {numberOfKeys: 1, lua: CLAIM_LUA});
redis.defineCommand('releaseRefund', {numberOfKeys: 1, lua: RELEASE_LUA});
redis.defineCommand('rebuildLedger', {numberOfKeys: 1, lua: REBUILD_LUA});

export interface ClaimResult {
  accepted: boolean;
  refunded_minor: number;
  remaining_minor: number;
}

export const ledgerKey = (paymentId: string): string => \`refunded:\${paymentId}\`;

export async function refundedTotal(paymentId: string): Promise<number> {
  return Number((await redis.hget(ledgerKey(paymentId), 'total')) ?? 0);
}

/** Reserve amountMinor for refundId if the total stays within capMinor. */
export async function claim(paymentId: string, refundId: string, amountMinor: number, capMinor: number): Promise<ClaimResult> {
  const [accepted, refunded, remaining] = await redis.claimRefund(ledgerKey(paymentId), refundId, amountMinor, capMinor);
  return {accepted: Number(accepted) === 1, refunded_minor: Number(refunded), remaining_minor: Number(remaining)};
}

/** Give back what refundId reserved; the total left. */
export async function release(paymentId: string, refundId: string): Promise<number> {
  return Number(await redis.releaseRefund(ledgerKey(paymentId), refundId));
}

/** Rewrite the ledger from the refund records: a REJECTED refund holds nothing. */
export async function rebuild(paymentId: string): Promise<number> {
  const held = (await listRefunds(paymentId)).filter(row => row.status !== 'REJECTED');
  const fields: (string | number)[] = ['total', held.reduce((sum, row) => sum + row.amount_minor, 0)];
  for (const row of held) fields.push(row.refund_id, row.amount_minor);
  return Number(await redis.rebuildLedger(ledgerKey(paymentId), ...fields));
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

	"refunds/records" // records.ListRefunds
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const day = 24 * time.Hour

// ClaimResult is what a claim answered.
type ClaimResult struct {
	Accepted       bool
	RefundedMinor  int64
	RemainingMinor int64
}

func ledgerKey(paymentID string) string { return "refunded:" + paymentID }

func refundedTotal(ctx context.Context, paymentID string) int64 {
	total, _ := strconv.ParseInt(rdb.HGet(ctx, ledgerKey(paymentID), "total").Val(), 10, 64)
	return total
}

// claim reserves amountMinor for refundID if the total stays within capMinor.
func claim(ctx context.Context, paymentID, refundID string, amountMinor, capMinor int64) (ClaimResult, error) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	key := ledgerKey(paymentID)
	total := refundedTotal(ctx, paymentID)
	if total+amountMinor > capMinor {
		return ClaimResult{Accepted: false, RefundedMinor: total, RemainingMinor: capMinor - total}, nil
	}
	rdb.HSet(ctx, key, refundID, amountMinor)
	total, err := rdb.HIncrBy(ctx, key, "total", amountMinor).Result()
	if err != nil {
		return ClaimResult{}, err
	}
	rdb.Expire(ctx, key, day) // keep Redis small: the records are the ledger of record
	return ClaimResult{Accepted: true, RefundedMinor: total, RemainingMinor: capMinor - total}, nil
}

// release gives back what refundID reserved and returns the total left.
func release(ctx context.Context, paymentID, refundID string) (int64, error) {
	key := ledgerKey(paymentID)
	held, err := rdb.HGet(ctx, key, refundID).Int64()
	if err == redis.Nil {
		return refundedTotal(ctx, paymentID), nil
	}
	if err != nil {
		return 0, err
	}
	rdb.HDel(ctx, key, refundID)
	return rdb.HIncrBy(ctx, key, "total", -held).Result()
}

// rebuild rewrites the ledger from the refund records.
func rebuild(ctx context.Context, paymentID string) (int64, error) {
	var total int64
	fields := map[string]any{}
	for _, row := range records.ListRefunds(ctx, paymentID) {
		total += row.AmountMinor
		fields[row.RefundID] = row.AmountMinor
	}
	fields["total"] = total
	key := ledgerKey(paymentID)
	rdb.Del(ctx, key)
	return total, rdb.HSet(ctx, key, fields).Err()
}
`,
      solution: `package main

import (
	"context"
	"strconv"

	"github.com/redis/go-redis/v9"

	"refunds/records" // records.ListRefunds
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// claimScript: KEYS[1] ledger; ARGV refund_id, amount_minor, cap_minor → {accepted, refunded_minor, remaining_minor}.
var claimScript = redis.NewScript(\`
local cap = tonumber(ARGV[3])
local total = tonumber(redis.call('HGET', KEYS[1], 'total') or '0')
if redis.call('HEXISTS', KEYS[1], ARGV[1]) == 1 then return {1, total, cap - total} end
local amount = tonumber(ARGV[2])
if total + amount > cap then return {0, total, cap - total} end
redis.call('HSET', KEYS[1], ARGV[1], amount)
total = redis.call('HINCRBY', KEYS[1], 'total', amount)
return {1, total, cap - total}
\`)

// releaseScript: KEYS[1] ledger; ARGV refund_id → the total left.
var releaseScript = redis.NewScript(\`
local held = redis.call('HGET', KEYS[1], ARGV[1])
if not held then return tonumber(redis.call('HGET', KEYS[1], 'total') or '0') end
redis.call('HDEL', KEYS[1], ARGV[1])
return redis.call('HINCRBY', KEYS[1], 'total', -tonumber(held))
\`)

// rebuildScript: KEYS[1] ledger; ARGV field, value, field, value, … → the total written.
var rebuildScript = redis.NewScript(\`
redis.call('DEL', KEYS[1])
for i = 1, #ARGV, 2 do redis.call('HSET', KEYS[1], ARGV[i], ARGV[i + 1]) end
return tonumber(redis.call('HGET', KEYS[1], 'total'))
\`)

// ClaimResult is what a claim answered.
type ClaimResult struct {
	Accepted       bool
	RefundedMinor  int64
	RemainingMinor int64
}

func ledgerKey(paymentID string) string { return "refunded:" + paymentID }

func refundedTotal(ctx context.Context, paymentID string) int64 {
	total, _ := strconv.ParseInt(rdb.HGet(ctx, ledgerKey(paymentID), "total").Val(), 10, 64)
	return total
}

// claim reserves amountMinor for refundID if the total stays within capMinor.
func claim(ctx context.Context, paymentID, refundID string, amountMinor, capMinor int64) (ClaimResult, error) {
	out, err := claimScript.Run(ctx, rdb, []string{ledgerKey(paymentID)}, refundID, amountMinor, capMinor).Int64Slice()
	if err != nil {
		return ClaimResult{}, err
	}
	return ClaimResult{Accepted: out[0] == 1, RefundedMinor: out[1], RemainingMinor: out[2]}, nil
}

// release gives back what refundID reserved and returns the total left.
func release(ctx context.Context, paymentID, refundID string) (int64, error) {
	return releaseScript.Run(ctx, rdb, []string{ledgerKey(paymentID)}, refundID).Int64()
}

// rebuild rewrites the ledger from the refund records: a REJECTED refund holds nothing.
func rebuild(ctx context.Context, paymentID string) (int64, error) {
	var total int64
	fields := []any{}
	for _, row := range records.ListRefunds(ctx, paymentID) {
		if row.Status == "REJECTED" {
			continue
		}
		total += row.AmountMinor
		fields = append(fields, row.RefundID, row.AmountMinor)
	}
	args := append([]any{"total", total}, fields...)
	return rebuildScript.Run(ctx, rdb, []string{ledgerKey(paymentID)}, args...).Int64()
}
`,
    },
    scala: {
      starter: `import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

import refunds.Records // Records.listRefunds

object State {
  final case class ClaimResult(accepted: Boolean, refundedMinor: Long, remainingMinor: Long)

  val jedis = new JedisPooled("redis", 6379)
  val DayS = 86400L

  def ledgerKey(paymentId: String): String = s"refunded:$paymentId"

  def refundedTotal(paymentId: String): Long = Option(jedis.hget(ledgerKey(paymentId), "total")).map(_.toLong).getOrElse(0L)

  /** Reserve amountMinor for refundId if the total stays within capMinor. */
  def claim(paymentId: String, refundId: String, amountMinor: Long, capMinor: Long): ClaimResult = {
    // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    val key = ledgerKey(paymentId)
    val total = refundedTotal(paymentId)
    if (total + amountMinor > capMinor) ClaimResult(accepted = false, total, capMinor - total)
    else {
      jedis.hset(key, refundId, amountMinor.toString)
      val after = jedis.hincrBy(key, "total", amountMinor)
      jedis.expire(key, DayS) // keep Redis small: the records are the ledger of record
      ClaimResult(accepted = true, after, capMinor - after)
    }
  }

  /** Give back what refundId reserved; the total left. */
  def release(paymentId: String, refundId: String): Long = {
    val key = ledgerKey(paymentId)
    Option(jedis.hget(key, refundId)) match {
      case None => refundedTotal(paymentId)
      case Some(held) =>
        jedis.hdel(key, refundId)
        jedis.hincrBy(key, "total", -held.toLong)
    }
  }

  /** Rewrite the ledger from the refund records. */
  def rebuild(paymentId: String): Long = {
    val rows = Records.listRefunds(paymentId)
    val total = rows.map(_.amountMinor).sum
    val key = ledgerKey(paymentId)
    jedis.del(key)
    jedis.hset(key, (Map("total" -> total.toString) ++ rows.map(row => row.refundId -> row.amountMinor.toString)).asJava)
    total
  }
}
`,
      solution: `import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

import refunds.Records // Records.listRefunds

object State {
  final case class ClaimResult(accepted: Boolean, refundedMinor: Long, remainingMinor: Long)

  val jedis = new JedisPooled("redis", 6379)

  /** KEYS[1] ledger; ARGV refund_id, amount_minor, cap_minor → {accepted, refunded_minor, remaining_minor} */
  val ClaimLua: String =
    """local cap = tonumber(ARGV[3])
      |local total = tonumber(redis.call('HGET', KEYS[1], 'total') or '0')
      |if redis.call('HEXISTS', KEYS[1], ARGV[1]) == 1 then return {1, total, cap - total} end
      |local amount = tonumber(ARGV[2])
      |if total + amount > cap then return {0, total, cap - total} end
      |redis.call('HSET', KEYS[1], ARGV[1], amount)
      |total = redis.call('HINCRBY', KEYS[1], 'total', amount)
      |return {1, total, cap - total}
      |""".stripMargin

  /** KEYS[1] ledger; ARGV refund_id → the total left */
  val ReleaseLua: String =
    """local held = redis.call('HGET', KEYS[1], ARGV[1])
      |if not held then return tonumber(redis.call('HGET', KEYS[1], 'total') or '0') end
      |redis.call('HDEL', KEYS[1], ARGV[1])
      |return redis.call('HINCRBY', KEYS[1], 'total', -tonumber(held))
      |""".stripMargin

  /** KEYS[1] ledger; ARGV field, value, field, value, … → the total written */
  val RebuildLua: String =
    """redis.call('DEL', KEYS[1])
      |for i = 1, #ARGV, 2 do redis.call('HSET', KEYS[1], ARGV[i], ARGV[i + 1]) end
      |return tonumber(redis.call('HGET', KEYS[1], 'total'))
      |""".stripMargin

  def ledgerKey(paymentId: String): String = s"refunded:$paymentId"

  def refundedTotal(paymentId: String): Long = Option(jedis.hget(ledgerKey(paymentId), "total")).map(_.toLong).getOrElse(0L)

  /** Reserve amountMinor for refundId if the total stays within capMinor. */
  def claim(paymentId: String, refundId: String, amountMinor: Long, capMinor: Long): ClaimResult = {
    val out = jedis.eval(ClaimLua, List(ledgerKey(paymentId)).asJava, List(refundId, amountMinor.toString, capMinor.toString).asJava)
      .asInstanceOf[java.util.List[java.lang.Long]].asScala.map(_.longValue)
    ClaimResult(out(0) == 1L, out(1), out(2))
  }

  /** Give back what refundId reserved; the total left. */
  def release(paymentId: String, refundId: String): Long =
    jedis.eval(ReleaseLua, List(ledgerKey(paymentId)).asJava, List(refundId).asJava).asInstanceOf[java.lang.Long].longValue

  /** Rewrite the ledger from the refund records: a REJECTED refund holds nothing. */
  def rebuild(paymentId: String): Long = {
    val held = Records.listRefunds(paymentId).filter(_.status != "REJECTED")
    val args = Seq("total", held.map(_.amountMinor).sum.toString) ++ held.flatMap(row => Seq(row.refundId, row.amountMinor.toString))
    jedis.eval(RebuildLua, List(ledgerKey(paymentId)).asJava, args.asJava).asInstanceOf[java.lang.Long].longValue
  }
}
`,
    },
    cpp: {
      starter: `#include <sw/redis++/redis++.h>

#include <map>
#include <string>

#include "refunds/records.h"  // records::listRefunds

sw::redis::Redis rdb("tcp://redis:6379");

constexpr long long kDayS = 86400;

struct ClaimResult {
  bool accepted = false;
  long long refunded_minor = 0;
  long long remaining_minor = 0;
};

std::string ledgerKey(const std::string& payment_id) { return "refunded:" + payment_id; }

long long refundedTotal(const std::string& payment_id) {
  const auto total = rdb.hget(ledgerKey(payment_id), "total");
  return total ? std::stoll(*total) : 0;
}

// Reserve amount_minor for refund_id if the total stays within cap_minor.
ClaimResult claim(const std::string& payment_id, const std::string& refund_id, long long amount_minor, long long cap_minor) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const std::string key = ledgerKey(payment_id);
  long long total = refundedTotal(payment_id);
  if (total + amount_minor > cap_minor) return ClaimResult{false, total, cap_minor - total};
  rdb.hset(key, refund_id, std::to_string(amount_minor));
  total = rdb.hincrby(key, "total", amount_minor);
  rdb.expire(key, kDayS);  // keep Redis small: the records are the ledger of record
  return ClaimResult{true, total, cap_minor - total};
}

// Give back what refund_id reserved; the total left.
long long release(const std::string& payment_id, const std::string& refund_id) {
  const std::string key = ledgerKey(payment_id);
  const auto held = rdb.hget(key, refund_id);
  if (!held) return refundedTotal(payment_id);
  rdb.hdel(key, refund_id);
  return rdb.hincrby(key, "total", -std::stoll(*held));
}

// Rewrite the ledger from the refund records.
long long rebuild(const std::string& payment_id) {
  long long total = 0;
  std::map<std::string, std::string> fields;
  for (const records::Refund& row : records::listRefunds(payment_id)) {
    total += row.amount_minor;
    fields[row.refund_id] = std::to_string(row.amount_minor);
  }
  fields["total"] = std::to_string(total);
  const std::string key = ledgerKey(payment_id);
  rdb.del(key);
  rdb.hset(key, fields.begin(), fields.end());
  return total;
}
`,
      solution: `#include <sw/redis++/redis++.h>

#include <iterator>
#include <string>
#include <vector>

#include "refunds/records.h"  // records::listRefunds

sw::redis::Redis rdb("tcp://redis:6379");

// KEYS[1] ledger; ARGV refund_id, amount_minor, cap_minor → {accepted, refunded_minor, remaining_minor}
const std::string kClaimLua = R"lua(
local cap = tonumber(ARGV[3])
local total = tonumber(redis.call('HGET', KEYS[1], 'total') or '0')
if redis.call('HEXISTS', KEYS[1], ARGV[1]) == 1 then return {1, total, cap - total} end
local amount = tonumber(ARGV[2])
if total + amount > cap then return {0, total, cap - total} end
redis.call('HSET', KEYS[1], ARGV[1], amount)
total = redis.call('HINCRBY', KEYS[1], 'total', amount)
return {1, total, cap - total}
)lua";

// KEYS[1] ledger; ARGV refund_id → the total left
const std::string kReleaseLua = R"lua(
local held = redis.call('HGET', KEYS[1], ARGV[1])
if not held then return tonumber(redis.call('HGET', KEYS[1], 'total') or '0') end
redis.call('HDEL', KEYS[1], ARGV[1])
return redis.call('HINCRBY', KEYS[1], 'total', -tonumber(held))
)lua";

// KEYS[1] ledger; ARGV field, value, field, value, … → the total written
const std::string kRebuildLua = R"lua(
redis.call('DEL', KEYS[1])
for i = 1, #ARGV, 2 do redis.call('HSET', KEYS[1], ARGV[i], ARGV[i + 1]) end
return tonumber(redis.call('HGET', KEYS[1], 'total'))
)lua";

struct ClaimResult {
  bool accepted = false;
  long long refunded_minor = 0;
  long long remaining_minor = 0;
};

std::string ledgerKey(const std::string& payment_id) { return "refunded:" + payment_id; }

long long refundedTotal(const std::string& payment_id) {
  const auto total = rdb.hget(ledgerKey(payment_id), "total");
  return total ? std::stoll(*total) : 0;
}

// Reserve amount_minor for refund_id if the total stays within cap_minor.
ClaimResult claim(const std::string& payment_id, const std::string& refund_id, long long amount_minor, long long cap_minor) {
  std::vector<long long> out;
  rdb.eval(kClaimLua, {ledgerKey(payment_id)}, {refund_id, std::to_string(amount_minor), std::to_string(cap_minor)},
           std::back_inserter(out));
  return ClaimResult{out.at(0) == 1, out.at(1), out.at(2)};
}

// Give back what refund_id reserved; the total left.
long long release(const std::string& payment_id, const std::string& refund_id) {
  return rdb.eval<long long>(kReleaseLua, {ledgerKey(payment_id)}, {refund_id});
}

// Rewrite the ledger from the refund records: a REJECTED refund holds nothing.
long long rebuild(const std::string& payment_id) {
  long long total = 0;
  std::vector<std::string> fields;
  for (const records::Refund& row : records::listRefunds(payment_id)) {
    if (row.status == "REJECTED") continue;
    total += row.amount_minor;
    fields.push_back(row.refund_id);
    fields.push_back(std::to_string(row.amount_minor));
  }
  std::vector<std::string> args = {"total", std::to_string(total)};
  args.insert(args.end(), fields.begin(), fields.end());
  return rdb.eval<long long>(kRebuildLua, {ledgerKey(payment_id)}, args);
}
`,
    },
  },
  harness: {
    python: `from refunds import records

KEY = "refunded:pay_1"


def _held(ctx):
    fields = ctx.redis.hgetall(KEY)
    total = int(fields.pop("total", 0))
    return total, {name: int(value) for name, value in fields.items()}


def _other_claim(ctx, refund_id, amount, cap):
    """Another server's claim as the contract's script makes it: it cannot interleave with itself."""
    total = int(ctx.redis.hget(KEY, "total") or 0)
    if ctx.redis.hexists(KEY, refund_id) or total + amount > cap:
        return False
    ctx.redis.hset(KEY, refund_id, amount)
    ctx.redis.hincrby(KEY, "total", amount)
    return True


def _other_release(ctx, refund_id):
    held = ctx.redis.hget(KEY, refund_id)
    if held is not None:
        ctx.redis.hdel(KEY, refund_id)
        ctx.redis.hincrby(KEY, "total", -int(held))


def check_atomic(ctx):
    m = ctx.load("state")
    got = tuple(m.claim("pay_1", "rf-1", 6000, 10000))
    assert got == (True, 6000, 4000), f"claiming 6000 of 10000 answered {got}, expected (True, 6000, 4000)"
    got = tuple(m.claim("pay_1", "rf-2", 5000, 10000))
    assert got == (False, 6000, 4000), f"claiming 5000 more answered {got}, expected (False, 6000, 4000)"
    ctx.redis.delete(KEY)
    probe = ctx.redis_after(KEY, lambda: _other_claim(ctx, "rf-9", 6000, 10000))
    m.claim("pay_1", "rf-1", 6000, 10000)
    assert probe.fired, "claim sent no command touching refunded:pay_1"
    total, held = _held(ctx)
    assert total <= 10000 and total == sum(held.values()), f"another server claimed 6000 between claim's read and its write: refunded:pay_1 holds total {total} over {held} on a 10000 payment. Read, compare and add inside one script"
    ctx.redis.delete(KEY)
    ctx.redis.hset(KEY, mapping={"total": 7000, "rf-1": 3000, "rf-2": 4000})
    probe = ctx.redis_after(KEY, lambda: _other_release(ctx, "rf-2"))
    m.release("pay_1", "rf-2")
    total, held = _held(ctx)
    assert total == 3000 and held == {"rf-1": 3000}, f"a release of rf-2 retried on another server landed inside release: refunded:pay_1 holds total {total} over {held}, expected 3000 over rf-1. Release inside one script"


def check_claim_once(ctx):
    m = ctx.load("state")
    m.claim("pay_1", "rf-1", 3000, 10000)
    again = tuple(m.claim("pay_1", "rf-1", 3000, 10000))
    total, held = _held(ctx)
    assert again == (True, 3000, 7000) and total == 3000, f"a claim retried for rf-1 answered {again} and left total {total} over {held}, expected (True, 3000, 7000): the refund already holds its amount"
    got = tuple(m.claim("pay_1", "rf-2", 7000, 10000))
    assert got == (True, 10000, 0), f"with rf-1 counted once, 7000 more fits exactly; the claim answered {got}"
    m.release("pay_1", "rf-2")
    left = m.release("pay_1", "rf-2")
    assert left == 3000 and _held(ctx)[0] == 3000, f"releasing rf-2 twice left {_held(ctx)[0]}, expected 3000"


def check_no_ttl(ctx):
    m = ctx.load("state")
    m.claim("pay_1", "rf-1", 10000, 10000)
    ttl = ctx.redis.ttl(KEY)
    assert ttl == -1, f"refunded:pay_1 has a TTL of {ttl} s: a cap that expires lets a fully refunded payment refund again"
    ctx.clock.advance(31 * 86400)
    accepted, _, _ = m.claim("pay_1", "rf-2", 1000, 10000)
    assert not accepted, "31 days after a full refund the payment accepted 1000 more"


def check_rebuild(ctx):
    records.add_payment("pay_1", "t1", 10000)
    for refund_id, amount in (("rf-1", 3000), ("rf-2", 5000), ("rf-3", 1000)):
        records.insert_refund(refund_id, "t1", "pay_1", amount, "damaged", "")
    records.mark_confirmed("rf-1", "re_1")
    records.mark_rejected("rf-2")
    ctx.redis.hset(KEY, mapping={"total": 9999, "rf-stale": 9999})
    m = ctx.load("state")
    written = m.rebuild("pay_1")
    total, held = _held(ctx)
    assert held == {"rf-1": 3000, "rf-3": 1000} and total == 4000, f"rebuild wrote total {total} over {held}, expected 4000 over rf-1 and rf-3: a REJECTED refund holds nothing and a field no record backs goes"
    assert written == 4000, f"rebuild returned {written}, expected the total it wrote (4000)"
    accepted, _, remaining = m.claim("pay_1", "rf-4", 6000, 10000)
    assert accepted and remaining == 0, "after the rebuild 6000 more must fit a 10000 payment holding 4000"
`,
    typescript: `const KEY = 'refunded:pay_1';

function held(ctx): [number, Record<string, number>] {
  const fields = ctx.redis.hgetall(KEY) as Record<string, string>;
  const out: Record<string, number> = {};
  for (const [name, value] of Object.entries(fields)) if (name !== 'total') out[name] = Number(value);
  return [Number(fields.total ?? 0), out];
}

const sum = (fields: Record<string, number>): number => Object.values(fields).reduce((a, b) => a + b, 0);

/** Another server's claim as the contract's script makes it: it cannot interleave with itself. */
function otherClaim(ctx, refundId: string, amount: number, cap: number): boolean {
  const total = Number(ctx.redis.hget(KEY, 'total') ?? 0);
  if (Number(ctx.redis.hexists(KEY, refundId)) === 1 || total + amount > cap) return false;
  ctx.redis.hset(KEY, refundId, amount);
  ctx.redis.hincrby(KEY, 'total', amount);
  return true;
}

function otherRelease(ctx, refundId: string): void {
  const amount = ctx.redis.hget(KEY, refundId);
  if (amount === null) return;
  ctx.redis.hdel(KEY, refundId);
  ctx.redis.hincrby(KEY, 'total', -Number(amount));
}

const triple = r => [r.accepted, r.refunded_minor, r.remaining_minor];

export async function check_atomic(ctx) {
  const m = ctx.load('state');
  let got = triple(await m.claim('pay_1', 'rf-1', 6000, 10000));
  assert.deepEqual(got, [true, 6000, 4000], \`claiming 6000 of 10000 answered \${JSON.stringify(got)}, expected accepted, 6000, 4000\`);
  got = triple(await m.claim('pay_1', 'rf-2', 5000, 10000));
  assert.deepEqual(got, [false, 6000, 4000], \`claiming 5000 more answered \${JSON.stringify(got)}, expected refused, 6000, 4000\`);
  ctx.redis.del(KEY);
  let probe = ctx.redisAfter(KEY, () => otherClaim(ctx, 'rf-9', 6000, 10000));
  await m.claim('pay_1', 'rf-1', 6000, 10000);
  assert(probe.fired, 'claim sent no command touching refunded:pay_1');
  let [total, fields] = held(ctx);
  assert(total <= 10000 && total === sum(fields), \`another server claimed 6000 between claim's read and its write: refunded:pay_1 holds total \${total} over \${JSON.stringify(fields)} on a 10000 payment. Read, compare and add inside one script\`);
  ctx.redis.del(KEY);
  ctx.redis.hset(KEY, 'total', 7000, 'rf-1', 3000, 'rf-2', 4000);
  probe = ctx.redisAfter(KEY, () => otherRelease(ctx, 'rf-2'));
  await m.release('pay_1', 'rf-2');
  [total, fields] = held(ctx);
  assert(total === 3000 && JSON.stringify(fields) === JSON.stringify({'rf-1': 3000}), \`a release of rf-2 retried on another server landed inside release: refunded:pay_1 holds total \${total} over \${JSON.stringify(fields)}, expected 3000 over rf-1. Release inside one script\`);
}

export async function check_claim_once(ctx) {
  const m = ctx.load('state');
  await m.claim('pay_1', 'rf-1', 3000, 10000);
  const again = triple(await m.claim('pay_1', 'rf-1', 3000, 10000));
  const [total, fields] = held(ctx);
  assert(JSON.stringify(again) === JSON.stringify([true, 3000, 7000]) && total === 3000, \`a claim retried for rf-1 answered \${JSON.stringify(again)} and left total \${total} over \${JSON.stringify(fields)}, expected accepted, 3000, 7000: the refund already holds its amount\`);
  const got = triple(await m.claim('pay_1', 'rf-2', 7000, 10000));
  assert.deepEqual(got, [true, 10000, 0], \`with rf-1 counted once, 7000 more fits exactly; the claim answered \${JSON.stringify(got)}\`);
  await m.release('pay_1', 'rf-2');
  const left = await m.release('pay_1', 'rf-2');
  assert(Number(left) === 3000 && held(ctx)[0] === 3000, \`releasing rf-2 twice left \${held(ctx)[0]}, expected 3000\`);
}

export async function check_no_ttl(ctx) {
  const m = ctx.load('state');
  await m.claim('pay_1', 'rf-1', 10000, 10000);
  const ttl = ctx.redis.ttl(KEY);
  assert.equal(ttl, -1, \`refunded:pay_1 has a TTL of \${ttl} s: a cap that expires lets a fully refunded payment refund again\`);
  ctx.clock.advance(31 * 86400);
  const got = await m.claim('pay_1', 'rf-2', 1000, 10000);
  assert.equal(got.accepted, false, '31 days after a full refund the payment accepted 1000 more');
}

export async function check_rebuild(ctx) {
  const records = ctx.load('/support/refunds/records.ts');
  await records.addPayment('pay_1', 't1', 10000);
  for (const [refundId, amount] of [['rf-1', 3000], ['rf-2', 5000], ['rf-3', 1000]] as [string, number][]) {
    await records.insertRefund(refundId, 't1', 'pay_1', amount, 'damaged', '');
  }
  await records.markConfirmed('rf-1', 're_1');
  await records.markRejected('rf-2');
  ctx.redis.hset(KEY, 'total', 9999, 'rf-stale', 9999);
  const m = ctx.load('state');
  const written = await m.rebuild('pay_1');
  const [total, fields] = held(ctx);
  assert(total === 4000 && JSON.stringify(Object.keys(fields).sort()) === JSON.stringify(['rf-1', 'rf-3']) && fields['rf-1'] === 3000 && fields['rf-3'] === 1000, \`rebuild wrote total \${total} over \${JSON.stringify(fields)}, expected 4000 over rf-1 and rf-3: a REJECTED refund holds nothing and a field no record backs goes\`);
  assert.equal(Number(written), 4000, \`rebuild returned \${written}, expected the total it wrote (4000)\`);
  const got = await m.claim('pay_1', 'rf-4', 6000, 10000);
  assert(got.accepted && got.remaining_minor === 0, 'after the rebuild 6000 more must fit a 10000 payment holding 4000');
}
`,
    go: `package main

import (
	"context"
	"strconv"

	"refunds/records"

	"leetbuild/harness"
)

const stateKey = "refunded:pay_1"

var stateBg = context.Background()

func stateHeld(ctx *harness.Ctx) (int64, map[string]int64) {
	fields := map[string]int64{}
	var total int64
	for name, value := range ctx.Redis.HGetAll(stateKey) {
		n, _ := strconv.ParseInt(value, 10, 64)
		if name == "total" {
			total = n
		} else {
			fields[name] = n
		}
	}
	return total, fields
}

func stateSum(fields map[string]int64) int64 {
	var s int64
	for _, v := range fields {
		s += v
	}
	return s
}

// stateOtherClaim is another server's claim as the contract's script makes it: it cannot interleave with itself.
func stateOtherClaim(ctx *harness.Ctx, refundID string, amount, limit int64) bool {
	raw, _ := ctx.Redis.HGet(stateKey, "total")
	total, _ := strconv.ParseInt(raw, 10, 64)
	if _, exists := ctx.Redis.HGet(stateKey, refundID); exists || total+amount > limit {
		return false
	}
	ctx.Redis.Do("HSET", stateKey, refundID, amount)
	ctx.Redis.Do("HINCRBY", stateKey, "total", amount)
	return true
}

func stateOtherRelease(ctx *harness.Ctx, refundID string) {
	raw, exists := ctx.Redis.HGet(stateKey, refundID)
	if !exists {
		return
	}
	amount, _ := strconv.ParseInt(raw, 10, 64)
	ctx.Redis.Do("HDEL", stateKey, refundID)
	ctx.Redis.Do("HINCRBY", stateKey, "total", -amount)
}

func stateClaim(ctx *harness.Ctx, refundID string, amount int64) ClaimResult {
	got, err := claim(stateBg, "pay_1", refundID, amount, 10000)
	ctx.NoError(err, "claim(pay_1, %s, %d, 10000)", refundID, amount)
	return got
}

func CheckAtomic(ctx *harness.Ctx) {
	ctx.Equal(stateClaim(ctx, "rf-1", 6000), ClaimResult{Accepted: true, RefundedMinor: 6000, RemainingMinor: 4000}, "claiming 6000 of 10000")
	ctx.Equal(stateClaim(ctx, "rf-2", 5000), ClaimResult{Accepted: false, RefundedMinor: 6000, RemainingMinor: 4000}, "claiming 5000 more")
	ctx.Redis.Del(stateKey)
	probe := ctx.Redis.After(stateKey, func() any { return stateOtherClaim(ctx, "rf-9", 6000, 10000) })
	stateClaim(ctx, "rf-1", 6000)
	ctx.Assert(probe.Fired, "claim sent no command touching refunded:pay_1")
	total, fields := stateHeld(ctx)
	ctx.Assert(total <= 10000 && total == stateSum(fields), "another server claimed 6000 between claim's read and its write: refunded:pay_1 holds total %d over %v on a 10000 payment. Read, compare and add inside one script", total, fields)
	ctx.Redis.Del(stateKey)
	ctx.Redis.Do("HSET", stateKey, "total", 7000, "rf-1", 3000, "rf-2", 4000)
	ctx.Redis.After(stateKey, func() any { stateOtherRelease(ctx, "rf-2"); return nil })
	_, err := release(stateBg, "pay_1", "rf-2")
	ctx.NoError(err, "release(pay_1, rf-2)")
	total, fields = stateHeld(ctx)
	ctx.Assert(total == 3000 && len(fields) == 1 && fields["rf-1"] == 3000, "a release of rf-2 retried on another server landed inside release: refunded:pay_1 holds total %d over %v, expected 3000 over rf-1. Release inside one script", total, fields)
}

func CheckClaimOnce(ctx *harness.Ctx) {
	stateClaim(ctx, "rf-1", 3000)
	again := stateClaim(ctx, "rf-1", 3000)
	total, fields := stateHeld(ctx)
	ctx.Assert(again.Accepted && again.RefundedMinor == 3000 && again.RemainingMinor == 7000 && total == 3000, "a claim retried for rf-1 answered %+v and left total %d over %v, expected accepted, 3000, 7000: the refund already holds its amount", again, total, fields)
	ctx.Equal(stateClaim(ctx, "rf-2", 7000), ClaimResult{Accepted: true, RefundedMinor: 10000, RemainingMinor: 0}, "with rf-1 counted once, 7000 more fits exactly; the claim")
	release(stateBg, "pay_1", "rf-2")
	left, err := release(stateBg, "pay_1", "rf-2")
	ctx.NoError(err, "release(pay_1, rf-2)")
	ctx.Equal(left, 3000, "releasing rf-2 twice must take it off once; the total left")
}

func CheckNoTtl(ctx *harness.Ctx) {
	stateClaim(ctx, "rf-1", 10000)
	ttl := ctx.Redis.TTL(stateKey)
	ctx.Equal(ttl, -1, "refunded:pay_1 must have no TTL (a cap that expires lets a fully refunded payment refund again); the TTL")
	ctx.Clock.Advance(31 * 86400)
	ctx.Equal(stateClaim(ctx, "rf-2", 1000).Accepted, false, "31 days after a full refund the payment must refuse 1000 more; accepted")
}

func CheckRebuild(ctx *harness.Ctx) {
	records.AddPayment(stateBg, "pay_1", "t1", 10000)
	records.InsertRefund(stateBg, "rf-1", "t1", "pay_1", 3000, "damaged", "")
	records.InsertRefund(stateBg, "rf-2", "t1", "pay_1", 5000, "damaged", "")
	records.InsertRefund(stateBg, "rf-3", "t1", "pay_1", 1000, "damaged", "")
	records.MarkConfirmed(stateBg, "rf-1", "re_1")
	records.MarkRejected(stateBg, "rf-2")
	ctx.Redis.Do("HSET", stateKey, "total", 9999, "rf-stale", 9999)
	written, err := rebuild(stateBg, "pay_1")
	ctx.NoError(err, "rebuild(pay_1)")
	total, fields := stateHeld(ctx)
	ctx.Assert(total == 4000 && len(fields) == 2 && fields["rf-1"] == 3000 && fields["rf-3"] == 1000, "rebuild wrote total %d over %v, expected 4000 over rf-1 and rf-3: a REJECTED refund holds nothing and a field no record backs goes", total, fields)
	ctx.Equal(written, 4000, "rebuild's result (the total it wrote)")
	got := stateClaim(ctx, "rf-4", 6000)
	ctx.Assert(got.Accepted && got.RemainingMinor == 0, "after the rebuild 6000 more must fit a 10000 payment holding 4000; the claim answered %+v", got)
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <map>
#include <string>

#include "refunds/records.h"

namespace {

const std::string kStateKey = "refunded:pay_1";

std::pair<long long, std::map<std::string, long long>> stateHeld(harness::Ctx& ctx) {
  long long total = 0;
  std::map<std::string, long long> fields;
  for (const auto& [name, value] : ctx.Redis.HGetAll(kStateKey)) {
    if (name == "total") total = std::stoll(value);
    else fields[name] = std::stoll(value);
  }
  return {total, fields};
}

long long stateSum(const std::map<std::string, long long>& fields) {
  long long s = 0;
  for (const auto& [name, value] : fields) s += value;
  return s;
}

std::string stateText(const std::map<std::string, long long>& fields) {
  std::string out;
  for (const auto& [name, value] : fields) out += (out.empty() ? "" : ", ") + name + "=" + std::to_string(value);
  return "{" + out + "}";
}

// Another server's claim as the contract's script makes it: it cannot interleave with itself.
void stateOtherClaim(harness::Ctx& ctx, const std::string& refund_id, long long amount, long long limit) {
  const auto raw = ctx.Redis.HGet(kStateKey, "total");
  const long long total = raw ? std::stoll(*raw) : 0;
  if (ctx.Redis.HGet(kStateKey, refund_id) || total + amount > limit) return;
  ctx.Redis.Do("HSET", kStateKey, refund_id, amount);
  ctx.Redis.Do("HINCRBY", kStateKey, "total", amount);
}

void stateOtherRelease(harness::Ctx& ctx, const std::string& refund_id) {
  const auto amount = ctx.Redis.HGet(kStateKey, refund_id);
  if (!amount) return;
  ctx.Redis.Do("HDEL", kStateKey, refund_id);
  ctx.Redis.Do("HINCRBY", kStateKey, "total", -std::stoll(*amount));
}

bool sameClaim(const ClaimResult& got, bool accepted, long long refunded, long long remaining) {
  return got.accepted == accepted && got.refunded_minor == refunded && got.remaining_minor == remaining;
}

}  // namespace

void CheckAtomic(harness::Ctx& ctx) {
  ClaimResult got = claim("pay_1", "rf-1", 6000, 10000);
  ctx.Assert(sameClaim(got, true, 6000, 4000), "claiming 6000 of 10000 answered (%t, %d, %d), expected (true, 6000, 4000)", got.accepted, got.refunded_minor, got.remaining_minor);
  got = claim("pay_1", "rf-2", 5000, 10000);
  ctx.Assert(sameClaim(got, false, 6000, 4000), "claiming 5000 more answered (%t, %d, %d), expected (false, 6000, 4000)", got.accepted, got.refunded_minor, got.remaining_minor);
  ctx.Redis.Do("DEL", kStateKey);
  bool fired = false;
  ctx.Redis.After(kStateKey, [&] {
    fired = true;
    stateOtherClaim(ctx, "rf-9", 6000, 10000);
  });
  claim("pay_1", "rf-1", 6000, 10000);
  ctx.Assert(fired, "claim sent no command touching refunded:pay_1");
  auto [total, fields] = stateHeld(ctx);
  ctx.Assert(total <= 10000 && total == stateSum(fields),
             "another server claimed 6000 between claim's read and its write: refunded:pay_1 holds total %d over %s on a 10000 payment. Read, compare and add inside one script",
             total, stateText(fields));
  ctx.Redis.Do("DEL", kStateKey);
  ctx.Redis.Do("HSET", kStateKey, "total", 7000, "rf-1", 3000, "rf-2", 4000);
  ctx.Redis.After(kStateKey, [&] { stateOtherRelease(ctx, "rf-2"); });
  release("pay_1", "rf-2");
  const auto [after, left] = stateHeld(ctx);
  ctx.Assert(after == 3000 && left.size() == 1 && left.count("rf-1"),
             "a release of rf-2 retried on another server landed inside release: refunded:pay_1 holds total %d over %s, expected 3000 over rf-1. Release inside one script",
             after, stateText(left));
}

void CheckClaimOnce(harness::Ctx& ctx) {
  claim("pay_1", "rf-1", 3000, 10000);
  const ClaimResult again = claim("pay_1", "rf-1", 3000, 10000);
  const auto [total, fields] = stateHeld(ctx);
  ctx.Assert(sameClaim(again, true, 3000, 7000) && total == 3000,
             "a claim retried for rf-1 answered (%t, %d, %d) and left total %d over %s, expected (true, 3000, 7000): the refund already holds its amount",
             again.accepted, again.refunded_minor, again.remaining_minor, total, stateText(fields));
  const ClaimResult got = claim("pay_1", "rf-2", 7000, 10000);
  ctx.Assert(sameClaim(got, true, 10000, 0), "with rf-1 counted once, 7000 more fits exactly; the claim answered (%t, %d, %d)", got.accepted, got.refunded_minor, got.remaining_minor);
  release("pay_1", "rf-2");
  ctx.Equal(release("pay_1", "rf-2"), 3000, "releasing rf-2 twice must take it off once; the total left");
}

void CheckNoTtl(harness::Ctx& ctx) {
  claim("pay_1", "rf-1", 10000, 10000);
  ctx.Equal(ctx.Redis.TTL(kStateKey), -1, "refunded:pay_1 must have no TTL (a cap that expires lets a fully refunded payment refund again); the TTL");
  ctx.Clock.Advance(31 * 86400);
  ctx.Equal(claim("pay_1", "rf-2", 1000, 10000).accepted, false, "31 days after a full refund the payment must refuse 1000 more; accepted");
}

void CheckRebuild(harness::Ctx& ctx) {
  records::addPayment("pay_1", "t1", 10000);
  records::insertRefund("rf-1", "t1", "pay_1", 3000, "damaged", "");
  records::insertRefund("rf-2", "t1", "pay_1", 5000, "damaged", "");
  records::insertRefund("rf-3", "t1", "pay_1", 1000, "damaged", "");
  records::markConfirmed("rf-1", "re_1");
  records::markRejected("rf-2");
  ctx.Redis.Do("HSET", kStateKey, "total", 9999, "rf-stale", 9999);
  const long long written = rebuild("pay_1");
  const auto [total, fields] = stateHeld(ctx);
  ctx.Assert(total == 4000 && fields.size() == 2 && fields.count("rf-1") && fields.at("rf-1") == 3000 && fields.count("rf-3"),
             "rebuild wrote total %d over %s, expected 4000 over rf-1 and rf-3: a REJECTED refund holds nothing and a field no record backs goes",
             total, stateText(fields));
  ctx.Equal(written, 4000, "rebuild's result (the total it wrote)");
  const ClaimResult got = claim("pay_1", "rf-4", 6000, 10000);
  ctx.Assert(got.accepted && got.remaining_minor == 0, "after the rebuild 6000 more must fit a 10000 payment holding 4000");
}
`,
  },
  hints: [
    'Under load a 10000 payment ends up holding 12000 of refunds; a claim retried after a timeout counts its amount twice; a payment refunded in full last month takes a fresh refund today.',
    'HGET then HINCRBY are two round trips, so another server can claim between them; nothing asks whether the refund already holds its amount; the one-day TTL deletes a lifetime cap; rebuild sums rejected rows too.',
    'Move claim and release into Lua (`HEXISTS` the refund field, compare `total + amount` with the cap, `HSET` and `HINCRBY` only when it fits), drop the TTL, and skip `REJECTED` rows in rebuild.',
  ],
  debrief: `One script per operation is the whole fix: Redis runs a script without interleaving another client, so the read, the compare and the write become one step, and keeping a field per refund is what makes a retried claim or release harmless. The total and the fields live in one hash, so they cannot disagree. The key has no TTL because the cap belongs to the payment, not to a cache window; the records stay the ledger of record, and rebuild exists for the day Redis loses the hash. A production ledger fences rebuild against claims in flight for the payment (a claim reserved but not yet written as a row would vanish), and keeps a version so a stale rebuild cannot overwrite a newer total.`,
};
