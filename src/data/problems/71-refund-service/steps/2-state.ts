import type {Step} from '@/lib/types';

export const refundStateStep: Step = {
  id: 'state',
  title: 'Redis refund ledger with a lifetime cap',
  concept: 'redis',
  file: 'state',
  focus: ['api', 'ledger', 'records'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft of the ledger module: a payment
with room gets its refund recorded and the total comes back, so the demo passes. It hides a race, a
lifetime bug and the wrong key. Find them, fix them, and prove the fix.

Implement the Redis refund ledger that every refund goes through:

- The refunded total for a payment lives under **one key per payment**,
  \`refunded:{payment_id}\`, as the hash field \`refunded\`. Keying by tenant mixes payments that
  happen to share an amount, so one payment's refunds consume another's cap.
- The ledger has **no TTL**. The cap is for the **lifetime** of the payment: an expiring key would
  let a partial refunded payment accept a fresh full refund once the key is gone.
- The claim is **one atomic Lua \`EVAL\`**: read the field, compare \`refunded + amount\` against the
  payment's total, refuse when it does not fit and add only when it does. One round trip means two
  concurrent partial refunds cannot both pass the same remaining balance.
- The claim is capped at the **payment total**, passed in as the cap — not at a client-supplied
  number and not against a value read in the handler. Return
  \`(accepted, refunded_minor, remaining_minor)\` so the endpoint can answer **422** with the
  remaining balance.
- The ledger must be **rebuildable from the durable refund records**:
  \`rebuild_ledger(payment_id)\` recomputes the total with \`records.sum_refunds(payment_id)\` and
  rewrites the key. A crash between the PSP's success and the refund row is repairable only because
  the records, not the cache, are the source of truth.

**Failure mode the checks target.** The draft reads the total with \`GET\`, compares it in the
handler and adds with \`INCRBY\`: two concurrent partial refunds both observe the same remaining
balance and both pass, so a ¥100 payment can refund ¥200. It also keys the ledger under the tenant,
mixes payments that share a total, sets a 24-hour expiry on a lifetime cap, and has no rebuild path
at all.`,
  sequence: {
    participants: ['Refund API', 'Redis ledger', 'refund records'],
    messages: [
      {from: 'Refund API', to: 'Redis ledger', label: 'EVAL check-and-add · KEYS[refunded:pay_8d1]', kind: 'sync'},
      {from: 'Refund API', to: 'Redis ledger', label: 'ARGV[amount_minor, cap_minor = paid_minor]', kind: 'sync'},
      {
        from: 'Redis ledger',
        to: 'Redis ledger',
        label: 'HGET refunded · refuse if refunded + amount > cap',
        kind: 'sync',
      },
      {
        from: 'Redis ledger',
        to: 'Refund API',
        label: '{0, refunded, remaining} | {1, refunded + amount, remaining}',
        kind: 'reply',
      },
      {from: 'Refund API', to: 'refund records', label: 'insert the refund row (durable)', kind: 'async'},
      {
        from: 'refund records',
        to: 'Redis ledger',
        label: 'rebuildLedger: sumRefunds → HSET refunded:{payment}',
        kind: 'async',
      },
    ],
  },
  hints: [
    'Put `HGET`, the comparison and `HINCRBY` inside one script and run it with a single `EVAL`. A `GET` followed by a separate `INCRBY` leaves a window between the two commands, and concurrency finds that window precisely when the refund matters. Pass the payment total in as an argument — the script itself must decide.',
    'The key names the payment, not the tenant: `refunded:{payment_id}`. Two payments of the same amount are different liabilities, and a tenant-wide key lets the second payment inherit the first one’s refunded total.',
    'No `EXPIRE` belongs on this key. The cap is per payment for its lifetime; a TTL turns "fully refunded" back into "refundable" when it lapses. Keep the durable refund rows authoritative and let `rebuild_ledger` recompute the total from `sum_refunds` after a crash — the cache is repairable because the records are the truth.',
  ],
  checks: [
    {
      id: 'atomic',
      title: 'Claims with one atomic Lua script',
      detail:
        'The refunded total is read, compared and incremented inside one `EVAL`/`NewScript` call. A client-side read followed by a separate increment races: two concurrent partial refunds both observe balance that only one of them can spend.',
      match: {
        python: {all: [/REFUND_LUA/, /\.eval\(/, /HGET/, /HINCRBY/]},
        typescript: {all: [/REFUND_LUA/, /\.eval\(/, /HGET/, /HINCRBY/]},
        go: {all: [/(refundScript|NewScript)/, /\.Run\(/, /HGET/, /HINCRBY/]},
        scala: {all: [/RefundLua/, /\.eval\(/, /HGET/, /HINCRBY/]},
        cpp: {all: [/kRefundLua/, /\.eval</, /HGET/, /HINCRBY/]},
      },
    },
    {
      id: 'per-payment-key',
      title: 'Keeps one ledger per payment',
      detail:
        'The key is `refunded:{payment_id}` built from the payment id, never from the tenant. Under a tenant key, two payments that share an amount consume each other’s cap.',
      match: {
        python: {all: [/refunded:\{payment_id\}/, /payment_id/]},
        typescript: {all: [/refunded:\$\{paymentId\}/, /paymentId/]},
        go: {all: [/"refunded:%s",\s*paymentID/, /SumRefunds\(/]},
        scala: {all: [/refunded:\$paymentId/, /paymentId/]},
        cpp: {all: [/"refunded:"\s*\+\s*payment_id/, /payment_id/]},
      },
    },
    {
      id: 'lifetime-no-ttl',
      title: 'Lifetime cap: the ledger never expires',
      detail:
        'The ledger is a lifetime total with no `EXPIRE`, no `.expire(...)` and no `SETEX`: an expiring key turns a fully refunded payment back into a refundable one. The draft expires the key after a day.',
      match: {
        python: {all: [/HINCRBY/], none: [/\bEXPIRE\b/, /\.expire\(/, /SETEX/]},
        typescript: {all: [/HINCRBY/], none: [/\bEXPIRE\b/, /\.expire\(/, /setex/]},
        go: {all: [/HINCRBY/], none: [/\bEXPIRE\b/, /\.Expire\(/, /SetEX/]},
        scala: {all: [/HINCRBY/], none: [/\bEXPIRE\b/, /\.expire\(/, /setex/]},
        cpp: {all: [/HINCRBY/], none: [/\bEXPIRE\b/, /\.expire\(/, /setex/]},
      },
    },
    {
      id: 'cap-in-script',
      title: 'Refuses above the payment total inside the script',
      detail:
        'The payment total is passed into the script as the cap and the script returns the refusal itself (`return {0, …}`) when `refunded + amount` does not fit. The draft compares a cached read in the handler and then increments unconditionally.',
      match: {
        python: {all: [/cap_minor/, /return \{0/]},
        typescript: {all: [/capMinor/, /return \{0/]},
        go: {all: [/capMinor/, /return \{0/]},
        scala: {all: [/capMinor/, /return \{0/]},
        cpp: {all: [/cap_minor/, /return \{0/]},
      },
    },
    {
      id: 'rebuildable',
      title: 'Rebuilds the ledger from the durable refund records',
      detail:
        '`rebuild_ledger` (or `rebuildLedger`) sums the durable refund rows with `sum_refunds` and rewrites the ledger key, so the cache can be repaired after a crash between PSP success and the record write. The draft has no rebuild path.',
      match: {
        python: {all: [/rebuild_ledger/, /sum_refunds/]},
        typescript: {all: [/rebuildLedger/, /sumRefunds/]},
        go: {all: [/rebuildLedger/, /SumRefunds/]},
        scala: {all: [/rebuildLedger/, /sumRefunds/]},
        cpp: {all: [/rebuild_ledger/, /sumRefunds\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)


class RecordStore:
    def sum_refunds(self, payment_id: str) -> int:
        """The refunded total from the durable refund rows."""
        raise NotImplementedError


records = RecordStore()


def ledger_key(tenant: str) -> str:
    return f"refunded:{tenant}"


def refunded_total(tenant: str) -> int:
    current = r.get(ledger_key(tenant))
    return int(current) if current is not None else 0


def check_and_add_refund(tenant: str, amount_minor: int, paid_minor: int) -> tuple[bool, int, int]:
    # TODO: this draft reads the total with GET and adds with INCRBY, so two concurrent partial
    # refunds both pass the same remaining balance; it keys the ledger under the tenant instead of
    # the payment, expires a lifetime cap after a day, and has no rebuild path from the records.
    refunded = refunded_total(tenant)
    if refunded + amount_minor > paid_minor:
        return False, refunded, paid_minor - refunded
    r.incrby(ledger_key(tenant), amount_minor)
    r.expire(ledger_key(tenant), 86_400)
    total = refunded_total(tenant)
    return True, total, paid_minor - total
`,
      solution: `import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

LEDGER_FIELD = "refunded"

# One round trip: the read, the cap check and the add cannot be interleaved by another refund.
# No EXPIRE on purpose — the cap belongs to the payment for its whole lifetime.
REFUND_LUA = """
local refunded = tonumber(redis.call('HGET', KEYS[1], 'refunded')) or 0
local amount = tonumber(ARGV[1])
local cap = tonumber(ARGV[2])
if refunded + amount > cap then
  return {0, refunded, cap - refunded}
end
redis.call('HINCRBY', KEYS[1], 'refunded', amount)
return {1, refunded + amount, cap - refunded - amount}
"""


class RecordStore:
    def sum_refunds(self, payment_id: str) -> int:
        """The refunded total from the durable refund rows."""
        raise NotImplementedError


records = RecordStore()


def ledger_key(payment_id: str) -> str:
    return f"refunded:{payment_id}"


def check_and_add_refund(payment_id: str, amount_minor: int, cap_minor: int) -> tuple[bool, int, int]:
    accepted, refunded_total, remaining_minor = r.eval(
        REFUND_LUA, 1, ledger_key(payment_id), amount_minor, cap_minor
    )
    return bool(accepted), int(refunded_total), int(remaining_minor)


def refunded_total(payment_id: str) -> int:
    current = r.hget(ledger_key(payment_id), LEDGER_FIELD)
    return int(current) if current is not None else 0


def rebuild_ledger(payment_id: str) -> int:
    """Recompute the ledger from the durable records after a crash in the middle of a refund."""
    total = records.sum_refunds(payment_id)
    r.hset(ledger_key(payment_id), LEDGER_FIELD, total)
    return total
`,
    },
    typescript: {
      starter: `/** The refund ledger: a model-generated draft that reads, checks and then adds. */
import {Redis} from 'ioredis';

export const r = new Redis('redis://redis:6379');

export const LEDGER_FIELD = 'refunded';

export interface RefundClaim {
  accepted: boolean;
  refunded_minor: number;
  remaining_minor: number;
}

export const records = {
  async sumRefunds(paymentId: string): Promise<number> {
    throw new Error('not implemented');
  },
};

export function ledgerKey(tenant: string): string {
  return \`refunded:\${tenant}\`;
}

export async function refundedTotal(tenant: string): Promise<number> {
  const current = await r.get(ledgerKey(tenant));
  return current === null ? 0 : Number(current);
}

export async function checkAndAddRefund(tenant: string, amountMinor: number, paidMinor: number): Promise<RefundClaim> {
  // TODO: this draft reads the total with GET and adds with INCRBY, so two concurrent partial
  // refunds both pass the same remaining balance; it keys the ledger under the tenant instead of
  // the payment, expires a lifetime cap after a day, and has no rebuild path from the records.
  const refunded = await refundedTotal(tenant);
  if (refunded + amountMinor > paidMinor) {
    return {accepted: false, refunded_minor: refunded, remaining_minor: paidMinor - refunded};
  }
  await r.incrby(ledgerKey(tenant), amountMinor);
  await r.expire(ledgerKey(tenant), 86_400);
  const total = await refundedTotal(tenant);
  return {accepted: true, refunded_minor: total, remaining_minor: paidMinor - total};
}
`,
      solution: `/** The refund ledger: one atomic check-and-add per payment, capped for the payment's lifetime. */
import {Redis} from 'ioredis';

export const r = new Redis('redis://redis:6379');

export const LEDGER_FIELD = 'refunded';

export const REFUND_LUA = \`
local refunded = tonumber(redis.call('HGET', KEYS[1], 'refunded')) or 0
local amount = tonumber(ARGV[1])
local cap = tonumber(ARGV[2])
if refunded + amount > cap then
  return {0, refunded, cap - refunded}
end
redis.call('HINCRBY', KEYS[1], 'refunded', amount)
return {1, refunded + amount, cap - refunded - amount}
\`;

export interface RefundClaim {
  accepted: boolean;
  refunded_minor: number;
  remaining_minor: number;
}

export const records = {
  async sumRefunds(paymentId: string): Promise<number> {
    throw new Error('not implemented');
  },
};

export function ledgerKey(paymentId: string): string {
  return \`refunded:\${paymentId}\`;
}

export async function checkAndAddRefund(paymentId: string, amountMinor: number, capMinor: number): Promise<RefundClaim> {
  const result = (await r.eval(
    REFUND_LUA,
    1,
    ledgerKey(paymentId),
    String(amountMinor),
    String(capMinor),
  )) as [number, number, number];
  return {accepted: result[0] === 1, refunded_minor: result[1], remaining_minor: result[2]};
}

export async function refundedTotal(paymentId: string): Promise<number> {
  const current = await r.hget(ledgerKey(paymentId), LEDGER_FIELD);
  return current === null ? 0 : Number(current);
}

export async function rebuildLedger(paymentId: string): Promise<number> {
  const total = await records.sumRefunds(paymentId);
  await r.hset(ledgerKey(paymentId), LEDGER_FIELD, String(total));
  return total;
}

export const ledger = {checkAndAddRefund, refundedTotal, rebuildLedger};
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"fmt"

	"github.com/redis/go-redis/v9"
)

var rdb *redis.Client

type RecordStore struct{}

func (s *RecordStore) SumRefunds(ctx context.Context, paymentID string) (int64, error) {
	return 0, nil
}

var records = &RecordStore{}

func ledgerKey(tenant string) string {
	return fmt.Sprintf("refunded:%s", tenant)
}

func refundedTotal(ctx context.Context, tenant string) int64 {
	current, err := rdb.Get(ctx, ledgerKey(tenant)).Int64()
	if err != nil {
		return 0
	}
	return current
}

// TODO: this draft reads the total with GET and adds with INCRBY, so two concurrent partial refunds
// both pass the same remaining balance; it keys the ledger under the tenant instead of the payment,
// expires a lifetime cap after a day, and has no rebuild path from the records.
func checkAndAddRefund(ctx context.Context, tenant string, amountMinor, paidMinor int64) (bool, int64, int64) {
	refunded := refundedTotal(ctx, tenant)
	if refunded+amountMinor > paidMinor {
		return false, refunded, paidMinor - refunded
	}
	rdb.IncrBy(ctx, ledgerKey(tenant), amountMinor)
	rdb.Expire(ctx, ledgerKey(tenant), 24*time.Hour)
	total := refundedTotal(ctx, tenant)
	return true, total, paidMinor - total
}
`,
      solution: `package main

import (
	"context"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
)

var rdb *redis.Client

const ledgerField = "refunded"

// One round trip: the read, the cap check and the add cannot be interleaved by another refund. No
// EXPIRE on purpose — the cap belongs to the payment for its whole lifetime.
var refundScript = redis.NewScript(\`
local refunded = tonumber(redis.call('HGET', KEYS[1], 'refunded')) or 0
local amount = tonumber(ARGV[1])
local cap = tonumber(ARGV[2])
if refunded + amount > cap then
  return {0, refunded, cap - refunded}
end
redis.call('HINCRBY', KEYS[1], 'refunded', amount)
return {1, refunded + amount, cap - refunded - amount}
\`)

type RecordStore struct{}

func (s *RecordStore) SumRefunds(ctx context.Context, paymentID string) (int64, error) {
	return 0, nil
}

var records = &RecordStore{}

func ledgerKey(paymentID string) string {
	return fmt.Sprintf("refunded:%s", paymentID)
}

func checkAndAddRefund(ctx context.Context, paymentID string, amountMinor, capMinor int64) (bool, int64, int64) {
	values, err := refundScript.Run(
		ctx,
		rdb,
		[]string{ledgerKey(paymentID)},
		amountMinor,
		capMinor,
	).Int64Slice()
	if err != nil {
		panic(err)
	}
	return values[0] == 1, values[1], values[2]
}

func refundedTotal(ctx context.Context, paymentID string) int64 {
	current, err := rdb.HGet(ctx, ledgerKey(paymentID), ledgerField).Int64()
	if err != nil {
		return 0
	}
	return current
}

func rebuildLedger(ctx context.Context, paymentID string) (int64, error) {
	total, err := records.SumRefunds(ctx, paymentID)
	if err != nil {
		return 0, err
	}
	rdb.HSet(ctx, ledgerKey(paymentID), ledgerField, total)
	return total, nil
}
`,
    },
    scala: {
      starter: `import redis.clients.jedis.Jedis

object State {
  val jedis = new Jedis("redis", 6379)

  object records {
    def sumRefunds(paymentId: String): Long = 0L
  }

  def ledgerKey(tenant: String): String = s"refunded:$tenant"

  def refundedTotal(tenant: String): Long = Option(jedis.get(ledgerKey(tenant))).map(_.toLong).getOrElse(0L)

  // TODO: this draft reads the total with GET and adds with INCRBY, so two concurrent partial
  // refunds both pass the same remaining balance; it keys the ledger under the tenant instead of
  // the payment, expires a lifetime cap after a day, and has no rebuild path from the records.
  def checkAndAddRefund(tenant: String, amountMinor: Long, paidMinor: Long): (Boolean, Long, Long) = {
    val refunded = refundedTotal(tenant)
    if (refunded + amountMinor > paidMinor) {
      (false, refunded, paidMinor - refunded)
    } else {
      jedis.incrBy(ledgerKey(tenant), amountMinor)
      jedis.expire(ledgerKey(tenant), 86400L)
      val total = refundedTotal(tenant)
      (true, total, paidMinor - total)
    }
  }
}
`,
      solution: `import redis.clients.jedis.Jedis

object State {
  val LedgerField = "refunded"

  // One round trip: the read, the cap check and the add cannot be interleaved by another refund.
  // No EXPIRE on purpose — the cap belongs to the payment for its whole lifetime.
  val RefundLua =
    """
      |local refunded = tonumber(redis.call('HGET', KEYS[1], 'refunded')) or 0
      |local amount = tonumber(ARGV[1])
      |local cap = tonumber(ARGV[2])
      |if refunded + amount > cap then
      |  return {0, refunded, cap - refunded}
      |end
      |redis.call('HINCRBY', KEYS[1], 'refunded', amount)
      |return {1, refunded + amount, cap - refunded - amount}
      |""".stripMargin

  val jedis = new Jedis("redis", 6379)

  object records {
    def sumRefunds(paymentId: String): Long = 0L
  }

  def ledgerKey(paymentId: String): String = s"refunded:$paymentId"

  def checkAndAddRefund(paymentId: String, amountMinor: Long, capMinor: Long): (Boolean, Long, Long) = {
    val result = jedis
      .eval(RefundLua, 1, ledgerKey(paymentId), amountMinor.toString, capMinor.toString)
      .asInstanceOf[java.util.List[Long]]
    (result.get(0) == 1L, result.get(1), result.get(2))
  }

  def refundedTotal(paymentId: String): Long =
    Option(jedis.hget(ledgerKey(paymentId), LedgerField)).map(_.toLong).getOrElse(0L)

  def rebuildLedger(paymentId: String): Long = {
    val total = records.sumRefunds(paymentId)
    jedis.hset(ledgerKey(paymentId), LedgerField, total.toString)
    total
  }
}
`,
    },
    cpp: {
      starter: `#include <sw/redis++/redis++.h>

#include <chrono>
#include <string>
#include <tuple>

struct RecordStore {
  long long sumRefunds(const std::string& paymentId);
};

RecordStore records;

std::string ledgerKey(const std::string& tenant) {
  return "refunded:" + tenant;
}

long long refundedTotal(sw::redis::Redis& redis, const std::string& tenant) {
  auto current = redis.get(ledgerKey(tenant));
  return current ? std::stoll(*current) : 0;
}

// TODO: this draft reads the total with GET and adds with INCRBY, so two concurrent partial refunds
// both pass the same remaining balance; it keys the ledger under the tenant instead of the payment,
// expires a lifetime cap after a day, and has no rebuild path from the records.
std::tuple<bool, long long, long long> checkAndAddRefund(
    sw::redis::Redis& redis,
    const std::string& tenant,
    long long amountMinor,
    long long paidMinor) {
  const auto refunded = refundedTotal(redis, tenant);
  if (refunded + amountMinor > paidMinor) {
    return {false, refunded, paidMinor - refunded};
  }
  redis.incrby(ledgerKey(tenant), amountMinor);
  redis.expire(ledgerKey(tenant), std::chrono::seconds(86400));
  const auto total = refundedTotal(redis, tenant);
  return {true, total, paidMinor - total};
}
`,
      solution: `#include <sw/redis++/redis++.h>

#include <string>
#include <tuple>
#include <vector>

const char* kLedgerField = "refunded";

// One round trip: the read, the cap check and the add cannot be interleaved by another refund. No
// EXPIRE on purpose — the cap belongs to the payment for its whole lifetime.
const char* kRefundLua = R"LUA(
local refunded = tonumber(redis.call('HGET', KEYS[1], 'refunded')) or 0
local amount = tonumber(ARGV[1])
local cap = tonumber(ARGV[2])
if refunded + amount > cap then
  return {0, refunded, cap - refunded}
end
redis.call('HINCRBY', KEYS[1], 'refunded', amount)
return {1, refunded + amount, cap - refunded - amount}
)LUA";

struct RecordStore {
  long long sumRefunds(const std::string& paymentId);
};

RecordStore records;

std::string ledgerKey(const std::string& payment_id) {
  return "refunded:" + payment_id;
}

std::tuple<bool, long long, long long> check_and_add_refund(
    sw::redis::Redis& redis,
    const std::string& payment_id,
    long long amount_minor,
    long long cap_minor) {
  const auto result = redis.eval<std::vector<long long>>(
      kRefundLua,
      {ledgerKey(payment_id)},
      {amount_minor, cap_minor});
  return {result[0] == 1, result[1], result[2]};
}

long long refunded_total(sw::redis::Redis& redis, const std::string& payment_id) {
  auto current = redis.hget(ledgerKey(payment_id), kLedgerField);
  return current ? std::stoll(*current) : 0;
}

long long rebuild_ledger(sw::redis::Redis& redis, const std::string& payment_id) {
  const auto total = records.sumRefunds(payment_id);
  redis.hset(ledgerKey(payment_id), kLedgerField, std::to_string(total));
  return total;
}
`,
    },
  },
  debrief: `The interview question behind this step is atomicity under concurrency, plus what a cache is allowed to remember. A read-then-increment cap passes every serial test and fails exactly when the product is under load, which is when the cap matters; one Lua script makes read, check and add a single step, so two concurrent partial refunds cannot both spend the same balance. The key is part of the model: an amount cap is a liability of a _payment_, so \`refunded:{payment_id}\` is the only key that cannot mix two liabilities, and a tenant key is subtly wrong in exactly the case where two payments share an amount. The missing TTL is the third: a lifetime cap on a key that expires is a cap that can be erased by waiting. The rebuild path is the fourth, and it is the one that survives an incident review: because the durable refund rows carry the truth, a crash between the PSP's success and the row write can be repaired by recomputing the ledger instead of writing it off. Real ledgers add an append-only refund log, a reconciliation job that flags drift, and a lock by payment when a refund needs more than one write.`,
};
