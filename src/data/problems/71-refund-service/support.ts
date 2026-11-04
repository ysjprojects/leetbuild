/**
 * Hand-written support modules the refund-service steps import but no step builds: the `refunds`
 * package. `refunds.records` is the refund records (payments, refund rows, Idempotency-Key
 * bindings and the outbox, kept in Redis hashes as the course's stand-in for the payments
 * database). `refunds.ledger` is the step 2 ledger as later steps use it (claim, release,
 * refunded_total, rebuild); `refunds.psp` is the step 3 PSP client as later steps use it
 * (refund_via_psp, reconcile). The five languages keep the same keys, so a harness reads one
 * layout whatever the stack.
 */
import {scalaPath} from '../scala-support';

export const supportModules: Record<string, string> = {
  'refunds/__init__.py': '',
  'refunds/records.py': `"""
The refund records (provided): the durable rows, kept in Redis hashes as the course's stand-in for
the payments database. payment:{id} is a payment (payment_id, tenant, paid_minor); refund:{id} a
refund (refund_id, tenant, payment_id, amount_minor, reason_code, status, psp_ref) whose status is
PENDING until the PSP's answer is known, then CONFIRMED or REJECTED; payment:{id}:refunds lists a
payment's refund ids in order; idem:{tenant}:{key} names the refund an Idempotency-Key created;
outbox holds the events the broker did not take, as JSON {topic, key, payload}. A row is a dict
with amount_minor and paid_minor as ints.
"""
import json

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)


def _refund(raw: dict) -> dict | None:
    if not raw:
        return None
    return {
        "refund_id": raw["refund_id"],
        "tenant": raw["tenant"],
        "payment_id": raw["payment_id"],
        "amount_minor": int(raw["amount_minor"]),
        "reason_code": raw["reason_code"],
        "status": raw["status"],
        "psp_ref": raw.get("psp_ref", ""),
    }


def add_payment(payment_id: str, tenant: str, paid_minor: int) -> dict:
    """Record a captured payment of paid_minor owned by tenant."""
    r.hset(f"payment:{payment_id}", mapping={"payment_id": payment_id, "tenant": tenant, "paid_minor": paid_minor})
    return find_payment(payment_id)


def find_payment(payment_id: str) -> dict | None:
    """{payment_id, tenant, paid_minor}, or None."""
    raw = r.hgetall(f"payment:{payment_id}")
    if not raw:
        return None
    return {"payment_id": raw["payment_id"], "tenant": raw["tenant"], "paid_minor": int(raw["paid_minor"])}


def new_refund_id() -> str:
    """A fresh refund id, rf-1, rf-2, …"""
    return f"rf-{r.incr('refund:seq')}"


def insert_refund(refund_id: str, tenant: str, payment_id: str, amount_minor: int, reason_code: str, idem_key: str) -> dict:
    """Write the refund row as PENDING, list it under its payment and, when idem_key is set, bind (tenant, idem_key) to it."""
    r.hset(
        f"refund:{refund_id}",
        mapping={
            "refund_id": refund_id,
            "tenant": tenant,
            "payment_id": payment_id,
            "amount_minor": amount_minor,
            "reason_code": reason_code,
            "status": "PENDING",
            "psp_ref": "",
        },
    )
    r.rpush(f"payment:{payment_id}:refunds", refund_id)
    if idem_key:
        r.set(f"idem:{tenant}:{idem_key}", refund_id)
    return find_refund(refund_id)


def find_refund(refund_id: str) -> dict | None:
    """The refund row, or None."""
    return _refund(r.hgetall(f"refund:{refund_id}"))


def refund_for_key(tenant: str, idem_key: str) -> dict | None:
    """The refund (tenant, idem_key) created, or None."""
    refund_id = r.get(f"idem:{tenant}:{idem_key}")
    return find_refund(refund_id) if refund_id else None


def list_refunds(payment_id: str) -> list[dict]:
    """Every refund row of the payment, oldest first, whatever its status."""
    rows = [find_refund(refund_id) for refund_id in r.lrange(f"payment:{payment_id}:refunds", 0, -1)]
    return [row for row in rows if row is not None]


def mark_confirmed(refund_id: str, psp_ref: str) -> None:
    """The PSP paid the refund out under psp_ref."""
    r.hset(f"refund:{refund_id}", mapping={"status": "CONFIRMED", "psp_ref": psp_ref})


def mark_rejected(refund_id: str) -> None:
    """The PSP refused the refund for good."""
    r.hset(f"refund:{refund_id}", "status", "REJECTED")


def insert_outbox(topic: str, key: str, payload: dict) -> None:
    """Keep an event the broker did not take; the relay republishes it."""
    r.rpush("outbox", json.dumps({"topic": topic, "key": key, "payload": payload}))
`,
  'refunds/ledger.py': `"""
The refund ledger (provided; step 2 builds the same functions): refunded:{payment_id} is a hash
with no TTL holding the payment's reserved total in the field total and one field per refund id with
the amount that refund reserved. claim, release and rebuild are Lua scripts, so a read and its write
are one step on the server.
"""
import redis

from refunds import records

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


def claim(payment_id: str, refund_id: str, amount_minor: int, cap_minor: int) -> tuple[bool, int, int]:
    """Reserve amount_minor for refund_id if the total stays within cap_minor; (accepted, refunded_minor, remaining_minor)."""
    accepted, refunded, remaining = claim_script(keys=[ledger_key(payment_id)], args=[refund_id, amount_minor, cap_minor])
    return accepted == 1, int(refunded), int(remaining)


def release(payment_id: str, refund_id: str) -> int:
    """Give back what refund_id reserved (nothing when it holds nothing); the total left."""
    return int(release_script(keys=[ledger_key(payment_id)], args=[refund_id]))


def refunded_total(payment_id: str) -> int:
    """The total the ledger holds for the payment."""
    return int(r.hget(ledger_key(payment_id), "total") or 0)


def rebuild(payment_id: str) -> int:
    """Rewrite the ledger from the refund records: every refund not REJECTED holds its amount."""
    held = [row for row in records.list_refunds(payment_id) if row["status"] != "REJECTED"]
    args = ["total", sum(row["amount_minor"] for row in held)]
    for row in held:
        args += [row["refund_id"], row["amount_minor"]]
    return int(rebuild_script(keys=[ledger_key(payment_id)], args=args))
`,
  'refunds/psp.py': `"""
The PSP client (provided; step 3 builds the same two functions). refund_via_psp pays a PENDING refund
out: every attempt carries a 5-second deadline and the refund id as its idempotency-key, the codes
that leave the outcome unknown are retried up to three attempts, a refusal marks the refund REJECTED
and releases its reservation, and an outcome still unknown is reconciled. reconcile asks GetRefund
and settles the record when the PSP knows; it answers CONFIRMED, REJECTED or PENDING.
"""
import grpc

import refund_service_pb2
import refund_service_pb2_grpc
from refunds import ledger, records

PSP_DEADLINE_S = 5
MAX_ATTEMPTS = 3
RETRYABLE = (grpc.StatusCode.DEADLINE_EXCEEDED, grpc.StatusCode.UNAVAILABLE)
REFUSALS = (grpc.StatusCode.INVALID_ARGUMENT, grpc.StatusCode.FAILED_PRECONDITION)

psp = refund_service_pb2_grpc.PspStub(grpc.insecure_channel("psp:9000"))


def _reject(refund: dict) -> str:
    records.mark_rejected(refund["refund_id"])
    ledger.release(refund["payment_id"], refund["refund_id"])
    return "REJECTED"


def reconcile(refund_id: str) -> str:
    refund = records.find_refund(refund_id)
    try:
        status = psp.GetRefund(refund_service_pb2.GetRefundRequest(refund_id=refund_id), timeout=PSP_DEADLINE_S)
    except grpc.RpcError:
        return "PENDING"
    if status.status == "SUCCEEDED":
        records.mark_confirmed(refund_id, status.psp_ref)
        return "CONFIRMED"
    if status.status == "FAILED":
        return _reject(refund)
    return "PENDING"


def refund_via_psp(refund_id: str) -> str:
    refund = records.find_refund(refund_id)
    request = refund_service_pb2.RefundRequest(
        refund_id=refund_id, payment_id=refund["payment_id"], amount_minor=refund["amount_minor"], reason_code=refund["reason_code"]
    )
    for _attempt in range(MAX_ATTEMPTS):
        try:
            reply = psp.Refund(request, timeout=PSP_DEADLINE_S, metadata=[("idempotency-key", refund_id)])
        except grpc.RpcError as exc:
            if exc.code() in REFUSALS:
                return _reject(refund)
            if exc.code() in RETRYABLE:
                continue
            break
        records.mark_confirmed(refund_id, reply.psp_ref)
        return "CONFIRMED"
    return reconcile(refund_id)
`,
};

export const supportModulesTs: Record<string, string> = {
  'refunds/records.ts': `/**
 * The refund records (provided): the durable rows, kept in Redis hashes as the course's stand-in
 * for the payments database. payment:{id} is a payment (payment_id, tenant, paid_minor); refund:{id}
 * a refund (refund_id, tenant, payment_id, amount_minor, reason_code, status, psp_ref) whose status
 * is PENDING until the PSP's answer is known, then CONFIRMED or REJECTED; payment:{id}:refunds lists
 * a payment's refund ids in order; idem:{tenant}:{key} names the refund an Idempotency-Key created;
 * outbox holds the events the broker did not take, as JSON {topic, key, payload}.
 */
import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

export interface Payment {
  payment_id: string;
  tenant: string;
  paid_minor: number;
}

export interface Refund {
  refund_id: string;
  tenant: string;
  payment_id: string;
  amount_minor: number;
  reason_code: string;
  status: string;
  psp_ref: string;
}

/** Record a captured payment of paid_minor owned by tenant. */
export async function addPayment(paymentId: string, tenant: string, paidMinor: number): Promise<Payment> {
  await redis.hset(\`payment:\${paymentId}\`, {payment_id: paymentId, tenant, paid_minor: String(paidMinor)});
  return {payment_id: paymentId, tenant, paid_minor: paidMinor};
}

/** The payment, or null. */
export async function findPayment(paymentId: string): Promise<Payment | null> {
  const raw = await redis.hgetall(\`payment:\${paymentId}\`);
  if (Object.keys(raw).length === 0) return null;
  return {payment_id: raw.payment_id, tenant: raw.tenant, paid_minor: Number(raw.paid_minor)};
}

/** A fresh refund id, rf-1, rf-2, … */
export async function newRefundId(): Promise<string> {
  return \`rf-\${await redis.incr('refund:seq')}\`;
}

/** The refund row, or null. */
export async function findRefund(refundId: string): Promise<Refund | null> {
  const raw = await redis.hgetall(\`refund:\${refundId}\`);
  if (Object.keys(raw).length === 0) return null;
  return {
    refund_id: raw.refund_id,
    tenant: raw.tenant,
    payment_id: raw.payment_id,
    amount_minor: Number(raw.amount_minor),
    reason_code: raw.reason_code,
    status: raw.status,
    psp_ref: raw.psp_ref ?? '',
  };
}

/** Write the refund row as PENDING, list it under its payment and, when idemKey is set, bind (tenant, idemKey) to it. */
export async function insertRefund(
  refundId: string,
  tenant: string,
  paymentId: string,
  amountMinor: number,
  reasonCode: string,
  idemKey: string,
): Promise<Refund> {
  await redis.hset(\`refund:\${refundId}\`, {
    refund_id: refundId,
    tenant,
    payment_id: paymentId,
    amount_minor: String(amountMinor),
    reason_code: reasonCode,
    status: 'PENDING',
    psp_ref: '',
  });
  await redis.rpush(\`payment:\${paymentId}:refunds\`, refundId);
  if (idemKey !== '') await redis.set(\`idem:\${tenant}:\${idemKey}\`, refundId);
  return (await findRefund(refundId)) as Refund;
}

/** The refund (tenant, idemKey) created, or null. */
export async function refundForKey(tenant: string, idemKey: string): Promise<Refund | null> {
  const refundId = await redis.get(\`idem:\${tenant}:\${idemKey}\`);
  return refundId === null ? null : findRefund(refundId);
}

/** Every refund row of the payment, oldest first, whatever its status. */
export async function listRefunds(paymentId: string): Promise<Refund[]> {
  const rows: Refund[] = [];
  for (const refundId of await redis.lrange(\`payment:\${paymentId}:refunds\`, 0, -1)) {
    const row = await findRefund(refundId);
    if (row !== null) rows.push(row);
  }
  return rows;
}

/** The PSP paid the refund out under pspRef. */
export async function markConfirmed(refundId: string, pspRef: string): Promise<void> {
  await redis.hset(\`refund:\${refundId}\`, {status: 'CONFIRMED', psp_ref: pspRef});
}

/** The PSP refused the refund for good. */
export async function markRejected(refundId: string): Promise<void> {
  await redis.hset(\`refund:\${refundId}\`, 'status', 'REJECTED');
}

/** Keep an event the broker did not take; the relay republishes it. */
export async function insertOutbox(topic: string, key: string, payload: Record<string, unknown>): Promise<void> {
  await redis.rpush('outbox', JSON.stringify({topic, key, payload}));
}
`,
  'refunds/ledger.ts': `/**
 * The refund ledger (provided; step 2 builds the same functions): refunded:{paymentId} is a hash
 * with no TTL holding the payment's reserved total in the field total and one field per refund id
 * with the amount that refund reserved. claim, release and rebuild are Lua scripts, so a read and
 * its write are one step on the server.
 */
import Redis from 'ioredis';

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

/** Reserve amountMinor for refundId if the total stays within capMinor. */
export async function claim(paymentId: string, refundId: string, amountMinor: number, capMinor: number): Promise<ClaimResult> {
  const [accepted, refunded, remaining] = await redis.claimRefund(ledgerKey(paymentId), refundId, amountMinor, capMinor);
  return {accepted: Number(accepted) === 1, refunded_minor: Number(refunded), remaining_minor: Number(remaining)};
}

/** Give back what refundId reserved (nothing when it holds nothing); the total left. */
export async function release(paymentId: string, refundId: string): Promise<number> {
  return Number(await redis.releaseRefund(ledgerKey(paymentId), refundId));
}

/** The total the ledger holds for the payment. */
export async function refundedTotal(paymentId: string): Promise<number> {
  return Number((await redis.hget(ledgerKey(paymentId), 'total')) ?? 0);
}

/** Rewrite the ledger from the refund records: every refund not REJECTED holds its amount. */
export async function rebuild(paymentId: string): Promise<number> {
  const held = (await listRefunds(paymentId)).filter(row => row.status !== 'REJECTED');
  const fields: (string | number)[] = ['total', held.reduce((sum, row) => sum + row.amount_minor, 0)];
  for (const row of held) fields.push(row.refund_id, row.amount_minor);
  return Number(await redis.rebuildLedger(ledgerKey(paymentId), ...fields));
}
`,
  'refunds/psp.ts': `/**
 * The PSP client (provided; step 3 builds the same two functions). refundViaPsp pays a PENDING
 * refund out: every attempt carries a 5-second deadline and the refund id as its idempotency-key,
 * the codes that leave the outcome unknown are retried up to three attempts, a refusal marks the
 * refund REJECTED and releases its reservation, and an outcome still unknown is reconciled.
 * reconcile asks GetRefund and settles the record when the PSP knows; it answers CONFIRMED,
 * REJECTED or PENDING.
 */
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import {release} from 'refunds/ledger';
import {type Refund, findRefund, markConfirmed, markRejected} from 'refunds/records';

export const PSP_DEADLINE_MS = 5000;
export const MAX_ATTEMPTS = 3;
const RETRYABLE = new Set<number>([grpc.status.DEADLINE_EXCEEDED, grpc.status.UNAVAILABLE]);
const REFUSALS = new Set<number>([grpc.status.INVALID_ARGUMENT, grpc.status.FAILED_PRECONDITION]);

interface RefundRequest {
  refund_id: string;
  payment_id: string;
  amount_minor: number;
  reason_code: string;
}

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('refund_service.proto')) as unknown as {
  refundd: {Psp: grpc.ServiceClientConstructor};
};
const psp = new pkg.refundd.Psp('psp:9000', grpc.credentials.createInsecure()) as grpc.Client & {
  Refund(request: RefundRequest, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<{psp_ref: string; status: string}>;
  GetRefund(request: {refund_id: string}, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<{status: string; psp_ref: string}>;
};

async function reject(refund: Refund): Promise<string> {
  await markRejected(refund.refund_id);
  await release(refund.payment_id, refund.refund_id);
  return 'REJECTED';
}

export async function reconcile(refundId: string): Promise<string> {
  const refund = (await findRefund(refundId)) as Refund;
  let status;
  try {
    status = await psp.GetRefund({refund_id: refundId}, new grpc.Metadata(), {deadline: Date.now() + PSP_DEADLINE_MS});
  } catch {
    return 'PENDING';
  }
  if (status.status === 'SUCCEEDED') {
    await markConfirmed(refundId, status.psp_ref);
    return 'CONFIRMED';
  }
  if (status.status === 'FAILED') return reject(refund);
  return 'PENDING';
}

export async function refundViaPsp(refundId: string): Promise<string> {
  const refund = (await findRefund(refundId)) as Refund;
  const request = {refund_id: refundId, payment_id: refund.payment_id, amount_minor: refund.amount_minor, reason_code: refund.reason_code};
  const metadata = new grpc.Metadata();
  metadata.set('idempotency-key', refundId);
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const reply = await psp.Refund(request, metadata, {deadline: Date.now() + PSP_DEADLINE_MS});
      await markConfirmed(refundId, reply.psp_ref);
      return 'CONFIRMED';
    } catch (e) {
      const {code} = e as grpc.ServiceError;
      if (REFUSALS.has(code)) return reject(refund);
      if (!RETRYABLE.has(code)) break;
    }
  }
  return reconcile(refundId);
}
`,
};

export const supportModulesGo: Record<string, string> = {
  'refunds/records/records.go': `// Package records is the refund records (provided): the durable rows, kept in Redis hashes as the
// course's stand-in for the payments database. payment:{id} is a payment (payment_id, tenant,
// paid_minor); refund:{id} a refund (refund_id, tenant, payment_id, amount_minor, reason_code,
// status, psp_ref) whose status is PENDING until the PSP's answer is known, then CONFIRMED or
// REJECTED; payment:{id}:refunds lists a payment's refund ids in order; idem:{tenant}:{key} names
// the refund an Idempotency-Key created; outbox holds the events the broker did not take, as JSON
// {topic, key, payload}.
package records

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// Payment is a captured payment.
type Payment struct {
	PaymentID string \`json:"payment_id"\`
	Tenant    string \`json:"tenant"\`
	PaidMinor int64  \`json:"paid_minor"\`
}

// Refund is one refund row.
type Refund struct {
	RefundID    string \`json:"refund_id"\`
	Tenant      string \`json:"tenant"\`
	PaymentID   string \`json:"payment_id"\`
	AmountMinor int64  \`json:"amount_minor"\`
	ReasonCode  string \`json:"reason_code"\`
	Status      string \`json:"status"\`
	PspRef      string \`json:"psp_ref"\`
}

// AddPayment records a captured payment of paidMinor owned by tenant.
func AddPayment(ctx context.Context, paymentID, tenant string, paidMinor int64) *Payment {
	rdb.HSet(ctx, "payment:"+paymentID, map[string]any{"payment_id": paymentID, "tenant": tenant, "paid_minor": strconv.FormatInt(paidMinor, 10)})
	return &Payment{PaymentID: paymentID, Tenant: tenant, PaidMinor: paidMinor}
}

// FindPayment is the payment, or nil.
func FindPayment(ctx context.Context, paymentID string) *Payment {
	raw := rdb.HGetAll(ctx, "payment:"+paymentID).Val()
	if len(raw) == 0 {
		return nil
	}
	paid, _ := strconv.ParseInt(raw["paid_minor"], 10, 64)
	return &Payment{PaymentID: raw["payment_id"], Tenant: raw["tenant"], PaidMinor: paid}
}

// NewRefundID is a fresh refund id, rf-1, rf-2, …
func NewRefundID(ctx context.Context) string {
	return fmt.Sprintf("rf-%d", rdb.Incr(ctx, "refund:seq").Val())
}

// FindRefund is the refund row, or nil.
func FindRefund(ctx context.Context, refundID string) *Refund {
	raw := rdb.HGetAll(ctx, "refund:"+refundID).Val()
	if len(raw) == 0 {
		return nil
	}
	amount, _ := strconv.ParseInt(raw["amount_minor"], 10, 64)
	return &Refund{RefundID: raw["refund_id"], Tenant: raw["tenant"], PaymentID: raw["payment_id"], AmountMinor: amount, ReasonCode: raw["reason_code"], Status: raw["status"], PspRef: raw["psp_ref"]}
}

// InsertRefund writes the refund row as PENDING, lists it under its payment and, when idemKey is
// set, binds (tenant, idemKey) to it.
func InsertRefund(ctx context.Context, refundID, tenant, paymentID string, amountMinor int64, reasonCode, idemKey string) *Refund {
	rdb.HSet(ctx, "refund:"+refundID, map[string]any{
		"refund_id": refundID, "tenant": tenant, "payment_id": paymentID, "amount_minor": strconv.FormatInt(amountMinor, 10),
		"reason_code": reasonCode, "status": "PENDING", "psp_ref": "",
	})
	rdb.RPush(ctx, "payment:"+paymentID+":refunds", refundID)
	if idemKey != "" {
		rdb.Set(ctx, "idem:"+tenant+":"+idemKey, refundID, 0)
	}
	return FindRefund(ctx, refundID)
}

// RefundForKey is the refund (tenant, idemKey) created, or nil.
func RefundForKey(ctx context.Context, tenant, idemKey string) *Refund {
	refundID, err := rdb.Get(ctx, "idem:"+tenant+":"+idemKey).Result()
	if err != nil {
		return nil
	}
	return FindRefund(ctx, refundID)
}

// ListRefunds is every refund row of the payment, oldest first, whatever its status.
func ListRefunds(ctx context.Context, paymentID string) []Refund {
	rows := []Refund{}
	for _, refundID := range rdb.LRange(ctx, "payment:"+paymentID+":refunds", 0, -1).Val() {
		if row := FindRefund(ctx, refundID); row != nil {
			rows = append(rows, *row)
		}
	}
	return rows
}

// MarkConfirmed records that the PSP paid the refund out under pspRef.
func MarkConfirmed(ctx context.Context, refundID, pspRef string) {
	rdb.HSet(ctx, "refund:"+refundID, map[string]any{"status": "CONFIRMED", "psp_ref": pspRef})
}

// MarkRejected records that the PSP refused the refund for good.
func MarkRejected(ctx context.Context, refundID string) {
	rdb.HSet(ctx, "refund:"+refundID, "status", "REJECTED")
}

// InsertOutbox keeps an event the broker did not take; the relay republishes it.
func InsertOutbox(ctx context.Context, topic, key string, payload map[string]any) error {
	row, err := json.Marshal(map[string]any{"topic": topic, "key": key, "payload": payload})
	if err != nil {
		return err
	}
	return rdb.RPush(ctx, "outbox", row).Err()
}
`,
  'refunds/ledger/ledger.go': `// Package ledger is the refund ledger (provided; step 2 builds the same functions):
// refunded:{paymentID} is a hash with no TTL holding the payment's reserved total in the field
// total and one field per refund id with the amount that refund reserved. Claim, Release and
// Rebuild are Lua scripts, so a read and its write are one step on the server.
package ledger

import (
	"context"
	"strconv"

	"github.com/redis/go-redis/v9"

	"refunds/records"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// ClaimScript: KEYS[1] ledger; ARGV refund_id, amount_minor, cap_minor → {accepted, refunded_minor, remaining_minor}.
var ClaimScript = redis.NewScript(\`
local cap = tonumber(ARGV[3])
local total = tonumber(redis.call('HGET', KEYS[1], 'total') or '0')
if redis.call('HEXISTS', KEYS[1], ARGV[1]) == 1 then return {1, total, cap - total} end
local amount = tonumber(ARGV[2])
if total + amount > cap then return {0, total, cap - total} end
redis.call('HSET', KEYS[1], ARGV[1], amount)
total = redis.call('HINCRBY', KEYS[1], 'total', amount)
return {1, total, cap - total}
\`)

// ReleaseScript: KEYS[1] ledger; ARGV refund_id → the total left.
var ReleaseScript = redis.NewScript(\`
local held = redis.call('HGET', KEYS[1], ARGV[1])
if not held then return tonumber(redis.call('HGET', KEYS[1], 'total') or '0') end
redis.call('HDEL', KEYS[1], ARGV[1])
return redis.call('HINCRBY', KEYS[1], 'total', -tonumber(held))
\`)

// RebuildScript: KEYS[1] ledger; ARGV field, value, field, value, … → the total written.
var RebuildScript = redis.NewScript(\`
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

// Key is the payment's ledger hash.
func Key(paymentID string) string { return "refunded:" + paymentID }

// Claim reserves amountMinor for refundID if the total stays within capMinor.
func Claim(ctx context.Context, paymentID, refundID string, amountMinor, capMinor int64) (ClaimResult, error) {
	out, err := ClaimScript.Run(ctx, rdb, []string{Key(paymentID)}, refundID, amountMinor, capMinor).Int64Slice()
	if err != nil {
		return ClaimResult{}, err
	}
	return ClaimResult{Accepted: out[0] == 1, RefundedMinor: out[1], RemainingMinor: out[2]}, nil
}

// Release gives back what refundID reserved (nothing when it holds nothing); it returns the total left.
func Release(ctx context.Context, paymentID, refundID string) (int64, error) {
	return ReleaseScript.Run(ctx, rdb, []string{Key(paymentID)}, refundID).Int64()
}

// RefundedTotal is the total the ledger holds for the payment.
func RefundedTotal(ctx context.Context, paymentID string) int64 {
	total, _ := strconv.ParseInt(rdb.HGet(ctx, Key(paymentID), "total").Val(), 10, 64)
	return total
}

// Rebuild rewrites the ledger from the refund records: every refund not REJECTED holds its amount.
func Rebuild(ctx context.Context, paymentID string) (int64, error) {
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
	return RebuildScript.Run(ctx, rdb, []string{Key(paymentID)}, args...).Int64()
}
`,
  'refunds/psp/psp.go': `// Package psp is the PSP client (provided; step 3 builds the same two functions). RefundViaPSP
// pays a PENDING refund out: every attempt carries a 5-second deadline and the refund id as its
// idempotency-key, the codes that leave the outcome unknown are retried up to three attempts, a
// refusal marks the refund REJECTED and releases its reservation, and an outcome still unknown is
// reconciled. Reconcile asks GetRefund and settles the record when the PSP knows; it answers
// CONFIRMED, REJECTED or PENDING.
package psp

import (
	"context"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"

	pb "refunds/gen/refund_service"
	"refunds/ledger"
	"refunds/records"
)

const (
	Deadline    = 5 * time.Second
	MaxAttempts = 3
)

var (
	conn, _ = grpc.NewClient("psp:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
	client  = pb.NewPspClient(conn)
)

func reject(ctx context.Context, refund *records.Refund) (string, error) {
	records.MarkRejected(ctx, refund.RefundID)
	if _, err := ledger.Release(ctx, refund.PaymentID, refund.RefundID); err != nil {
		return "", err
	}
	return "REJECTED", nil
}

// Reconcile asks the PSP what became of the refund and settles the record when it knows.
func Reconcile(ctx context.Context, refundID string) (string, error) {
	refund := records.FindRefund(ctx, refundID)
	callCtx, cancel := context.WithTimeout(ctx, Deadline)
	defer cancel()
	got, err := client.GetRefund(callCtx, &pb.GetRefundRequest{RefundId: refundID})
	if err != nil {
		return "PENDING", nil
	}
	switch got.GetStatus() {
	case "SUCCEEDED":
		records.MarkConfirmed(ctx, refundID, got.GetPspRef())
		return "CONFIRMED", nil
	case "FAILED":
		return reject(ctx, refund)
	}
	return "PENDING", nil
}

// RefundViaPSP pays a PENDING refund out through the PSP.
func RefundViaPSP(ctx context.Context, refundID string) (string, error) {
	refund := records.FindRefund(ctx, refundID)
	request := &pb.RefundRequest{RefundId: refundID, PaymentId: refund.PaymentID, AmountMinor: refund.AmountMinor, ReasonCode: refund.ReasonCode}
	for attempt := 0; attempt < MaxAttempts; attempt++ {
		callCtx, cancel := context.WithTimeout(metadata.AppendToOutgoingContext(ctx, "idempotency-key", refundID), Deadline)
		reply, err := client.Refund(callCtx, request)
		cancel()
		if err == nil {
			records.MarkConfirmed(ctx, refundID, reply.GetPspRef())
			return "CONFIRMED", nil
		}
		code := status.Code(err)
		if code == codes.InvalidArgument || code == codes.FailedPrecondition {
			return reject(ctx, refund)
		}
		if code != codes.DeadlineExceeded && code != codes.Unavailable {
			break
		}
	}
	return Reconcile(ctx, refundID)
}
`,
};

export const supportModulesCpp: Record<string, string> = {
  'refunds/records.h': `// The refund records (provided): the durable rows, kept in Redis hashes as the course's stand-in
// for the payments database. payment:{id} is a payment (payment_id, tenant, paid_minor);
// refund:{id} a refund (refund_id, tenant, payment_id, amount_minor, reason_code, status, psp_ref)
// whose status is PENDING until the PSP's answer is known, then CONFIRMED or REJECTED;
// payment:{id}:refunds lists a payment's refund ids in order; idem:{tenant}:{key} names the refund
// an Idempotency-Key created; outbox holds the events the broker did not take, as JSON
// {topic, key, payload}.
#pragma once

#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <optional>
#include <string>
#include <unordered_map>
#include <vector>

namespace records {

struct Payment {
  std::string payment_id;
  std::string tenant;
  long long paid_minor = 0;
};

struct Refund {
  std::string refund_id;
  std::string tenant;
  std::string payment_id;
  long long amount_minor = 0;
  std::string reason_code;
  std::string status;
  std::string psp_ref;
};

inline sw::redis::Redis& redis() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

// Record a captured payment of paid_minor owned by tenant.
inline Payment addPayment(const std::string& payment_id, const std::string& tenant, long long paid_minor) {
  redis().hset("payment:" + payment_id, {{"payment_id", payment_id}, {"tenant", tenant}, {"paid_minor", std::to_string(paid_minor)}});
  return Payment{payment_id, tenant, paid_minor};
}

// The payment, or none.
inline std::optional<Payment> findPayment(const std::string& payment_id) {
  const std::unordered_map<std::string, std::string> raw = redis().hgetall("payment:" + payment_id);
  if (raw.empty()) return std::nullopt;
  return Payment{raw.at("payment_id"), raw.at("tenant"), std::stoll(raw.at("paid_minor"))};
}

// A fresh refund id, rf-1, rf-2, …
inline std::string newRefundId() { return "rf-" + std::to_string(redis().incr("refund:seq")); }

// The refund row, or none.
inline std::optional<Refund> findRefund(const std::string& refund_id) {
  const std::unordered_map<std::string, std::string> raw = redis().hgetall("refund:" + refund_id);
  if (raw.empty()) return std::nullopt;
  const auto text = [&raw](const char* name) { return raw.count(name) ? raw.at(name) : std::string(); };
  return Refund{text("refund_id"), text("tenant"), text("payment_id"), std::stoll(text("amount_minor")),
                text("reason_code"), text("status"), text("psp_ref")};
}

// Write the refund row as PENDING, list it under its payment and, when idem_key is set, bind
// (tenant, idem_key) to it.
inline Refund insertRefund(const std::string& refund_id, const std::string& tenant, const std::string& payment_id,
                           long long amount_minor, const std::string& reason_code, const std::string& idem_key) {
  redis().hset("refund:" + refund_id, {{"refund_id", refund_id},
                                       {"tenant", tenant},
                                       {"payment_id", payment_id},
                                       {"amount_minor", std::to_string(amount_minor)},
                                       {"reason_code", reason_code},
                                       {"status", "PENDING"},
                                       {"psp_ref", ""}});
  redis().rpush("payment:" + payment_id + ":refunds", refund_id);
  if (!idem_key.empty()) redis().set("idem:" + tenant + ":" + idem_key, refund_id);
  return *findRefund(refund_id);
}

// The refund (tenant, idem_key) created, or none.
inline std::optional<Refund> refundForKey(const std::string& tenant, const std::string& idem_key) {
  const auto refund_id = redis().get("idem:" + tenant + ":" + idem_key);
  if (!refund_id) return std::nullopt;
  return findRefund(*refund_id);
}

// Every refund row of the payment, oldest first, whatever its status.
inline std::vector<Refund> listRefunds(const std::string& payment_id) {
  std::vector<Refund> rows;
  for (const std::string& refund_id : redis().lrange("payment:" + payment_id + ":refunds", 0, -1)) {
    if (auto row = findRefund(refund_id)) rows.push_back(*row);
  }
  return rows;
}

// The PSP paid the refund out under psp_ref.
inline void markConfirmed(const std::string& refund_id, const std::string& psp_ref) {
  redis().hset("refund:" + refund_id, {{"status", "CONFIRMED"}, {"psp_ref", psp_ref}});
}

// The PSP refused the refund for good.
inline void markRejected(const std::string& refund_id) { redis().hset("refund:" + refund_id, "status", "REJECTED"); }

// Keep an event the broker did not take; the relay republishes it.
inline void insertOutbox(const std::string& topic, const std::string& key, const nlohmann::json& payload) {
  redis().rpush("outbox", nlohmann::json{{"topic", topic}, {"key", key}, {"payload", payload}}.dump());
}

}  // namespace records
`,
  'refunds/ledger.h': `// The refund ledger (provided; step 2 builds the same functions): refunded:{payment_id} is a hash
// with no TTL holding the payment's reserved total in the field total and one field per refund id
// with the amount that refund reserved. claim, release and rebuild are Lua scripts, so a read and
// its write are one step on the server.
#pragma once

#include <sw/redis++/redis++.h>

#include <iterator>
#include <string>
#include <vector>

#include "refunds/records.h"

namespace ledger {

// KEYS[1] ledger; ARGV refund_id, amount_minor, cap_minor → {accepted, refunded_minor, remaining_minor}
inline const std::string kClaimLua = R"lua(
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
inline const std::string kReleaseLua = R"lua(
local held = redis.call('HGET', KEYS[1], ARGV[1])
if not held then return tonumber(redis.call('HGET', KEYS[1], 'total') or '0') end
redis.call('HDEL', KEYS[1], ARGV[1])
return redis.call('HINCRBY', KEYS[1], 'total', -tonumber(held))
)lua";

// KEYS[1] ledger; ARGV field, value, field, value, … → the total written
inline const std::string kRebuildLua = R"lua(
redis.call('DEL', KEYS[1])
for i = 1, #ARGV, 2 do redis.call('HSET', KEYS[1], ARGV[i], ARGV[i + 1]) end
return tonumber(redis.call('HGET', KEYS[1], 'total'))
)lua";

struct ClaimResult {
  bool accepted = false;
  long long refunded_minor = 0;
  long long remaining_minor = 0;
};

inline sw::redis::Redis& redis() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

inline std::string ledgerKey(const std::string& payment_id) { return "refunded:" + payment_id; }

// Reserve amount_minor for refund_id if the total stays within cap_minor.
inline ClaimResult claim(const std::string& payment_id, const std::string& refund_id, long long amount_minor, long long cap_minor) {
  std::vector<long long> out;
  redis().eval(kClaimLua, {ledgerKey(payment_id)}, {refund_id, std::to_string(amount_minor), std::to_string(cap_minor)},
               std::back_inserter(out));
  return ClaimResult{out.at(0) == 1, out.at(1), out.at(2)};
}

// Give back what refund_id reserved (nothing when it holds nothing); the total left.
inline long long release(const std::string& payment_id, const std::string& refund_id) {
  return redis().eval<long long>(kReleaseLua, {ledgerKey(payment_id)}, {refund_id});
}

// The total the ledger holds for the payment.
inline long long refundedTotal(const std::string& payment_id) {
  const auto total = redis().hget(ledgerKey(payment_id), "total");
  return total ? std::stoll(*total) : 0;
}

// Rewrite the ledger from the refund records: every refund not REJECTED holds its amount.
inline long long rebuild(const std::string& payment_id) {
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
  return redis().eval<long long>(kRebuildLua, {ledgerKey(payment_id)}, args);
}

}  // namespace ledger
`,
  'refunds/psp.h': `// The PSP client (provided; step 3 builds the same two functions). refundViaPsp pays a PENDING
// refund out: every attempt carries a 5-second deadline and the refund id as its idempotency-key,
// the codes that leave the outcome unknown are retried up to three attempts, a refusal marks the
// refund REJECTED and releases its reservation, and an outcome still unknown is reconciled.
// reconcile asks GetRefund and settles the record when the PSP knows; it answers CONFIRMED,
// REJECTED or PENDING.
#pragma once

#include <grpcpp/grpcpp.h>

#include <chrono>
#include <memory>
#include <string>

#include "refund_service.grpc.pb.h"
#include "refunds/ledger.h"
#include "refunds/records.h"

namespace psp {

constexpr std::chrono::seconds kPspDeadline{5};
constexpr int kMaxAttempts = 3;

inline refundd::Psp::Stub& stub() {
  static std::unique_ptr<refundd::Psp::Stub> s = refundd::Psp::NewStub(grpc::CreateChannel("psp:9000", grpc::InsecureChannelCredentials()));
  return *s;
}

inline std::string reject(const records::Refund& refund) {
  records::markRejected(refund.refund_id);
  ledger::release(refund.payment_id, refund.refund_id);
  return "REJECTED";
}

// Ask the PSP what became of the refund and settle the record when it knows.
inline std::string reconcile(const std::string& refund_id) {
  const records::Refund refund = *records::findRefund(refund_id);
  grpc::ClientContext ctx;
  ctx.set_deadline(std::chrono::system_clock::now() + kPspDeadline);
  refundd::GetRefundRequest request;
  request.set_refund_id(refund_id);
  refundd::RefundStatus got;
  if (!stub().GetRefund(&ctx, request, &got).ok()) return "PENDING";
  if (got.status() == "SUCCEEDED") {
    records::markConfirmed(refund_id, got.psp_ref());
    return "CONFIRMED";
  }
  if (got.status() == "FAILED") return reject(refund);
  return "PENDING";
}

// Pay a PENDING refund out through the PSP.
inline std::string refundViaPsp(const std::string& refund_id) {
  const records::Refund refund = *records::findRefund(refund_id);
  refundd::RefundRequest request;
  request.set_refund_id(refund_id);
  request.set_payment_id(refund.payment_id);
  request.set_amount_minor(refund.amount_minor);
  request.set_reason_code(refund.reason_code);
  for (int attempt = 0; attempt < kMaxAttempts; attempt++) {
    grpc::ClientContext ctx;
    ctx.set_deadline(std::chrono::system_clock::now() + kPspDeadline);
    ctx.AddMetadata("idempotency-key", refund_id);
    refundd::RefundReply reply;
    const grpc::Status status = stub().Refund(&ctx, request, &reply);
    if (status.ok()) {
      records::markConfirmed(refund_id, reply.psp_ref());
      return "CONFIRMED";
    }
    const grpc::StatusCode code = status.error_code();
    if (code == grpc::StatusCode::INVALID_ARGUMENT || code == grpc::StatusCode::FAILED_PRECONDITION) return reject(refund);
    if (code != grpc::StatusCode::DEADLINE_EXCEEDED && code != grpc::StatusCode::UNAVAILABLE) break;
  }
  return reconcile(refund_id);
}

}  // namespace psp
`,
};

export const supportModulesScala: Record<string, string> = {
  [scalaPath('refunds', 'Records')]: `package refunds

import redis.clients.jedis.JedisPooled
import spray.json._

import scala.jdk.CollectionConverters._

/**
 * The refund records (provided): the durable rows, kept in Redis hashes as the course's stand-in for
 * the payments database. payment:{id} is a payment (payment_id, tenant, paid_minor); refund:{id} a
 * refund (refund_id, tenant, payment_id, amount_minor, reason_code, status, psp_ref) whose status is
 * PENDING until the PSP's answer is known, then CONFIRMED or REJECTED; payment:{id}:refunds lists a
 * payment's refund ids in order; idem:{tenant}:{key} names the refund an Idempotency-Key created;
 * outbox holds the events the broker did not take, as JSON {topic, key, payload}.
 */
object Records {
  final case class Payment(paymentId: String, tenant: String, paidMinor: Long)
  final case class Refund(refundId: String, tenant: String, paymentId: String, amountMinor: Long, reasonCode: String, status: String, pspRef: String)

  val jedis = new JedisPooled("redis", 6379)

  /** Record a captured payment of paidMinor owned by tenant. */
  def addPayment(paymentId: String, tenant: String, paidMinor: Long): Payment = {
    jedis.hset(s"payment:$paymentId", Map("payment_id" -> paymentId, "tenant" -> tenant, "paid_minor" -> paidMinor.toString).asJava)
    Payment(paymentId, tenant, paidMinor)
  }

  /** The payment, if it exists. */
  def findPayment(paymentId: String): Option[Payment] = {
    val raw = jedis.hgetAll(s"payment:$paymentId").asScala
    if (raw.isEmpty) None else Some(Payment(raw("payment_id"), raw("tenant"), raw("paid_minor").toLong))
  }

  /** A fresh refund id, rf-1, rf-2, … */
  def newRefundId(): String = s"rf-\${jedis.incr("refund:seq")}"

  /** The refund row, if it exists. */
  def findRefund(refundId: String): Option[Refund] = {
    val raw = jedis.hgetAll(s"refund:$refundId").asScala
    if (raw.isEmpty) None
    else Some(Refund(raw("refund_id"), raw("tenant"), raw("payment_id"), raw("amount_minor").toLong, raw("reason_code"), raw("status"), raw.getOrElse("psp_ref", "")))
  }

  /** Write the refund row as PENDING, list it under its payment and, when idemKey is set, bind (tenant, idemKey) to it. */
  def insertRefund(refundId: String, tenant: String, paymentId: String, amountMinor: Long, reasonCode: String, idemKey: String): Refund = {
    jedis.hset(
      s"refund:$refundId",
      Map("refund_id" -> refundId, "tenant" -> tenant, "payment_id" -> paymentId, "amount_minor" -> amountMinor.toString,
        "reason_code" -> reasonCode, "status" -> "PENDING", "psp_ref" -> "").asJava)
    jedis.rpush(s"payment:$paymentId:refunds", refundId)
    if (idemKey.nonEmpty) jedis.set(s"idem:$tenant:$idemKey", refundId)
    findRefund(refundId).get
  }

  /** The refund (tenant, idemKey) created, if any. */
  def refundForKey(tenant: String, idemKey: String): Option[Refund] =
    Option(jedis.get(s"idem:$tenant:$idemKey")).flatMap(findRefund)

  /** Every refund row of the payment, oldest first, whatever its status. */
  def listRefunds(paymentId: String): Seq[Refund] =
    jedis.lrange(s"payment:$paymentId:refunds", 0, -1).asScala.toSeq.flatMap(findRefund)

  /** The PSP paid the refund out under pspRef. */
  def markConfirmed(refundId: String, pspRef: String): Unit =
    jedis.hset(s"refund:$refundId", Map("status" -> "CONFIRMED", "psp_ref" -> pspRef).asJava)

  /** The PSP refused the refund for good. */
  def markRejected(refundId: String): Unit = jedis.hset(s"refund:$refundId", "status", "REJECTED")

  /** Keep an event the broker did not take; the relay republishes it. */
  def insertOutbox(topic: String, key: String, payload: JsObject): Unit =
    jedis.rpush("outbox", JsObject("topic" -> JsString(topic), "key" -> JsString(key), "payload" -> payload).compactPrint)
}
`,
  [scalaPath('refunds', 'Ledger')]: `package refunds

import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

/**
 * The refund ledger (provided; step 2 builds the same functions): refunded:{paymentId} is a hash with
 * no TTL holding the payment's reserved total in the field total and one field per refund id with
 * the amount that refund reserved. claim, release and rebuild are Lua scripts, so a read and its
 * write are one step on the server.
 */
object Ledger {
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

  /** Reserve amountMinor for refundId if the total stays within capMinor. */
  def claim(paymentId: String, refundId: String, amountMinor: Long, capMinor: Long): ClaimResult = {
    val out = jedis.eval(ClaimLua, List(ledgerKey(paymentId)).asJava, List(refundId, amountMinor.toString, capMinor.toString).asJava)
      .asInstanceOf[java.util.List[java.lang.Long]].asScala.map(_.longValue)
    ClaimResult(out(0) == 1L, out(1), out(2))
  }

  /** Give back what refundId reserved (nothing when it holds nothing); the total left. */
  def release(paymentId: String, refundId: String): Long =
    jedis.eval(ReleaseLua, List(ledgerKey(paymentId)).asJava, List(refundId).asJava).asInstanceOf[java.lang.Long].longValue

  /** The total the ledger holds for the payment. */
  def refundedTotal(paymentId: String): Long = Option(jedis.hget(ledgerKey(paymentId), "total")).map(_.toLong).getOrElse(0L)

  /** Rewrite the ledger from the refund records: every refund not REJECTED holds its amount. */
  def rebuild(paymentId: String): Long = {
    val held = Records.listRefunds(paymentId).filter(_.status != "REJECTED")
    val args = Seq("total", held.map(_.amountMinor).sum.toString) ++ held.flatMap(row => Seq(row.refundId, row.amountMinor.toString))
    jedis.eval(RebuildLua, List(ledgerKey(paymentId)).asJava, args.asJava).asInstanceOf[java.lang.Long].longValue
  }
}
`,
  [scalaPath('refunds', 'Psp')]: `package refunds

import java.util.concurrent.TimeUnit

import io.grpc.stub.MetadataUtils
import io.grpc.{ManagedChannelBuilder, Metadata, Status, StatusRuntimeException}

import refundd.refund_service.{GetRefundRequest, PspGrpc, RefundRequest}

/**
 * The PSP client (provided; step 3 builds the same two functions). refundViaPsp pays a PENDING refund
 * out: every attempt carries a 5-second deadline and the refund id as its idempotency-key, the codes
 * that leave the outcome unknown are retried up to three attempts, a refusal marks the refund
 * REJECTED and releases its reservation, and an outcome still unknown is reconciled. reconcile asks
 * GetRefund and settles the record when the PSP knows; it answers CONFIRMED, REJECTED or PENDING.
 */
object Psp {
  val PspDeadlineS = 5L
  val MaxAttempts = 3
  private val Retryable = Set(Status.Code.DEADLINE_EXCEEDED, Status.Code.UNAVAILABLE)
  private val Refusals = Set(Status.Code.INVALID_ARGUMENT, Status.Code.FAILED_PRECONDITION)
  private val IdempotencyKey = Metadata.Key.of("idempotency-key", Metadata.ASCII_STRING_MARSHALLER)

  private val psp = PspGrpc.blockingStub(ManagedChannelBuilder.forAddress("psp", 9000).usePlaintext().build())

  private def reject(refund: Records.Refund): String = {
    Records.markRejected(refund.refundId)
    Ledger.release(refund.paymentId, refund.refundId)
    "REJECTED"
  }

  def reconcile(refundId: String): String = {
    val refund = Records.findRefund(refundId).get
    try {
      val got = psp.withDeadlineAfter(PspDeadlineS, TimeUnit.SECONDS).getRefund(GetRefundRequest(refundId))
      got.status match {
        case "SUCCEEDED" =>
          Records.markConfirmed(refundId, got.pspRef)
          "CONFIRMED"
        case "FAILED" => reject(refund)
        case _ => "PENDING"
      }
    } catch {
      case _: StatusRuntimeException => "PENDING"
    }
  }

  def refundViaPsp(refundId: String): String = {
    val refund = Records.findRefund(refundId).get
    val request = RefundRequest(refundId, refund.paymentId, refund.amountMinor, refund.reasonCode)
    val headers = new Metadata()
    headers.put(IdempotencyKey, refundId)
    val keyed = psp.withInterceptors(MetadataUtils.newAttachHeadersInterceptor(headers))
    var attempt = 0
    while (attempt < MaxAttempts) {
      try {
        val reply = keyed.withDeadlineAfter(PspDeadlineS, TimeUnit.SECONDS).refund(request)
        Records.markConfirmed(refundId, reply.pspRef)
        return "CONFIRMED"
      } catch {
        case e: StatusRuntimeException if Refusals.contains(e.getStatus.getCode) => return reject(refund)
        case e: StatusRuntimeException if Retryable.contains(e.getStatus.getCode) => attempt += 1
        case _: StatusRuntimeException => attempt = MaxAttempts
      }
    }
    reconcile(refundId)
  }
}
`,
};
