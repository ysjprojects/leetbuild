/**
 * Hand-written support modules the subscription-billing steps import but no step builds: the
 * `billing` package. `billing.dates` is the calendar the service counts in (ISO days in UTC, a
 * period is [period_start, period_end)); `billing.store` is the billing records in Redis hashes, the
 * course's stand-in for the billing database (subscriptions, invoices, credits, the outbox);
 * `billing.processor` is the processor client of step 3 as later steps use it (`charge_invoice`,
 * `lookup_invoice`). The five languages keep the same keys, so a harness reads one layout whatever
 * the stack.
 */
import {scalaPath} from '../scala-support';

export const supportModules: Record<string, string> = {
  'billing/__init__.py': '',
  'billing/dates.py': `"""
Dates as the billing service counts them: ISO-8601 calendar days ("2026-03-17") in UTC. A period
is [period_start, period_end): it starts on period_start and ends before period_end, so its length
is days_between(period_start, period_end). today() reads the clock.
"""
import time
from datetime import date, timedelta


def today() -> str:
    """The current UTC day."""
    return time.strftime("%Y-%m-%d", time.gmtime())


def add_days(day: str, n: int) -> str:
    """The day n days after day (before it when n is negative)."""
    return (date.fromisoformat(day) + timedelta(days=n)).isoformat()


def days_between(start: str, end: str) -> int:
    """The days from start to end: 31 from 2026-01-01 to 2026-02-01."""
    return (date.fromisoformat(end) - date.fromisoformat(start)).days
`,
  'billing/store.py': `"""
The billing records (provided), kept in Redis hashes as the course's stand-in for the billing
database. subscription:{id} is a subscription (subscription_id, tenant, plan, period_start,
period_end); invoice:{id} an invoice (invoice_id, subscription_id, tenant, period_start, period_end,
amount_cents, state: open, charged or failed, reference, reason), listed oldest first under
subscription:{id}:invoices; invoice:{id}:credits the credits granted against an invoice (JSON:
credit_id, amount_cents, reason); outbox the events the broker did not take (JSON: topic, key,
payload). PLANS are the plan prices per period, in cents.
"""
import json

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

PLANS = {"starter": 1900, "scale": 9900}


def plan_price(plan: str) -> int | None:
    """The plan's price per period in cents, or None when the catalogue has no such plan."""
    return PLANS.get(plan)


def put_subscription(subscription_id: str, tenant: str, plan: str, period_start: str, period_end: str) -> dict:
    """Write the subscription row (the demo and the checks seed subscriptions this way)."""
    r.hset(
        f"subscription:{subscription_id}",
        mapping={"subscription_id": subscription_id, "tenant": tenant, "plan": plan, "period_start": period_start, "period_end": period_end},
    )
    return find_subscription(subscription_id)


def find_subscription(subscription_id: str) -> dict | None:
    """The subscription row, or None."""
    return r.hgetall(f"subscription:{subscription_id}") or None


def find_invoice(invoice_id: str) -> dict | None:
    """The invoice row (amount_cents an int), or None."""
    raw = r.hgetall(f"invoice:{invoice_id}")
    return {**raw, "amount_cents": int(raw["amount_cents"])} if raw else None


def open_invoice(subscription_id: str, period_start: str, period_end: str, amount_cents: int) -> dict:
    """A new open invoice of the subscription for [period_start, period_end); returns the row."""
    subscription = find_subscription(subscription_id) or {}
    invoice_id = f"in_{r.incr('invoice:seq')}"
    r.hset(
        f"invoice:{invoice_id}",
        mapping={
            "invoice_id": invoice_id,
            "subscription_id": subscription_id,
            "tenant": subscription.get("tenant", ""),
            "period_start": period_start,
            "period_end": period_end,
            "amount_cents": amount_cents,
            "state": "open",
            "reference": "",
            "reason": "",
        },
    )
    r.rpush(f"subscription:{subscription_id}:invoices", invoice_id)
    return find_invoice(invoice_id)


def invoices_of(subscription_id: str) -> list[dict]:
    """Every invoice of the subscription, oldest first."""
    rows = [find_invoice(invoice_id) for invoice_id in r.lrange(f"subscription:{subscription_id}:invoices", 0, -1)]
    return [row for row in rows if row is not None]


def mark_charged(invoice_id: str, reference: str) -> None:
    """The processor charged the invoice under reference."""
    r.hset(f"invoice:{invoice_id}", mapping={"state": "charged", "reference": reference, "reason": ""})


def mark_failed(invoice_id: str, reason: str) -> None:
    """The charge failed for reason (the issuer's decline code, or why the processor could not be reached)."""
    r.hset(f"invoice:{invoice_id}", mapping={"state": "failed", "reference": "", "reason": reason})


def grant_credit(invoice_id: str, amount_cents: int, reason: str) -> dict:
    """Credit amount_cents against the invoice; returns the credit (credit_id, amount_cents, reason)."""
    credit = {"credit_id": f"cr_{r.incr('credit:seq')}", "amount_cents": amount_cents, "reason": reason}
    r.rpush(f"invoice:{invoice_id}:credits", json.dumps(credit))
    return credit


def credits_of(invoice_id: str) -> list[dict]:
    """The credits granted against the invoice, oldest first."""
    return [json.loads(row) for row in r.lrange(f"invoice:{invoice_id}:credits", 0, -1)]


def insert_outbox(topic: str, key: str, payload: dict) -> None:
    """Keep an event the broker did not take; the relay publishes it later."""
    r.rpush("outbox", json.dumps({"topic": topic, "key": key, "payload": payload}))
`,
  'billing/processor.py': `"""
The processor client (provided; step 3 builds the same two functions). charge_invoice charges an
invoice and answers its outcome, {"state": "charged" or "failed", "reference", "reason"}: every
call carries a 5-second deadline and the invoice id as its idempotency key, a decline is final (its
decline code is the reason), a deadline is reconciled with GetInvoice before any retry, and
UNAVAILABLE is retried, MAX_ATTEMPTS calls in all. lookup_invoice answers what the processor holds
for an invoice ({"invoice_id", "state", "reference", "total_cents"}), None when it holds nothing or
did not answer.
"""
import grpc

import subscription_billing_pb2 as pb
import subscription_billing_pb2_grpc

DEADLINE_S = 5
MAX_ATTEMPTS = 3

processor = subscription_billing_pb2_grpc.ProcessorStub(grpc.insecure_channel("processor:9000"))


def lookup_invoice(invoice_id: str) -> dict | None:
    try:
        found = processor.GetInvoice(pb.GetInvoiceRequest(invoice_id=invoice_id), timeout=DEADLINE_S)
    except grpc.RpcError:
        return None
    return {"invoice_id": found.invoice_id, "state": found.state, "reference": found.reference, "total_cents": found.total_cents}


def charge_invoice(invoice: dict) -> dict:
    request = pb.ChargeRequest(
        invoice_id=invoice["invoice_id"],
        subscription_id=invoice["subscription_id"],
        amount_cents=invoice["amount_cents"],
        idempotency_key=invoice["invoice_id"],
    )
    for _attempt in range(MAX_ATTEMPTS):
        try:
            result = processor.Charge(request, timeout=DEADLINE_S)
        except grpc.RpcError as exc:
            if exc.code() == grpc.StatusCode.DEADLINE_EXCEEDED:
                found = lookup_invoice(invoice["invoice_id"])
                if found is not None and found["state"] == "charged":
                    return {"state": "charged", "reference": found["reference"], "reason": ""}
                continue
            if exc.code() == grpc.StatusCode.UNAVAILABLE:
                continue
            return {"state": "failed", "reference": "", "reason": exc.code().name.lower()}
        if result.status == "declined":
            return {"state": "failed", "reference": "", "reason": result.decline_code}
        return {"state": "charged", "reference": result.reference, "reason": ""}
    return {"state": "failed", "reference": "", "reason": "processor_unavailable"}
`,
};

export const supportModulesTs: Record<string, string> = {
  'billing/dates.ts': `/**
 * Dates as the billing service counts them: ISO-8601 calendar days ("2026-03-17") in UTC. A period
 * is [period_start, period_end): it starts on period_start and ends before period_end, so its length
 * is daysBetween(period_start, period_end). today() reads the clock.
 */
const DAY_MS = 86_400_000;

const epochDay = (day: string): number => {
  const [y, m, d] = day.split('-').map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / DAY_MS);
};

const fromEpochDay = (n: number): string => new Date(n * DAY_MS).toISOString().slice(0, 10);

/** The current UTC day. */
export const today = (): string => fromEpochDay(Math.floor(Date.now() / DAY_MS));

/** The day n days after day (before it when n is negative). */
export const addDays = (day: string, n: number): string => fromEpochDay(epochDay(day) + n);

/** The days from start to end: 31 from 2026-01-01 to 2026-02-01. */
export const daysBetween = (start: string, end: string): number => epochDay(end) - epochDay(start);
`,
  'billing/store.ts': `/**
 * The billing records (provided), kept in Redis hashes as the course's stand-in for the billing
 * database. subscription:{id} is a subscription (subscription_id, tenant, plan, period_start,
 * period_end); invoice:{id} an invoice (invoice_id, subscription_id, tenant, period_start,
 * period_end, amount_cents, state: open, charged or failed, reference, reason), listed oldest first
 * under subscription:{id}:invoices; invoice:{id}:credits the credits granted against an invoice
 * (JSON: credit_id, amount_cents, reason); outbox the events the broker did not take (JSON: topic,
 * key, payload). PLANS are the plan prices per period, in cents. An Outcome is what a charge came
 * to; a ProcessorInvoice what the processor holds for an invoice.
 */
import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

export const PLANS: Record<string, number> = {starter: 1900, scale: 9900};

export interface Subscription {
  subscription_id: string;
  tenant: string;
  plan: string;
  period_start: string;
  period_end: string;
}

export interface Invoice {
  invoice_id: string;
  subscription_id: string;
  tenant: string;
  period_start: string;
  period_end: string;
  amount_cents: number;
  state: string;
  reference: string;
  reason: string;
}

export interface Credit {
  credit_id: string;
  amount_cents: number;
  reason: string;
}

export interface Outcome {
  state: string;
  reference: string;
  reason: string;
}

export interface ProcessorInvoice {
  invoice_id: string;
  state: string;
  reference: string;
  total_cents: number;
}

/** The plan's price per period in cents, or null when the catalogue has no such plan. */
export const planPrice = (plan: string): number | null => (Object.prototype.hasOwnProperty.call(PLANS, plan) ? PLANS[plan] : null);

/** Write the subscription row (the demo and the checks seed subscriptions this way). */
export async function putSubscription(subscriptionId: string, tenant: string, plan: string, periodStart: string, periodEnd: string): Promise<Subscription> {
  await redis.hset(\`subscription:\${subscriptionId}\`, {subscription_id: subscriptionId, tenant, plan, period_start: periodStart, period_end: periodEnd});
  return (await findSubscription(subscriptionId)) as Subscription;
}

/** The subscription row, or null. */
export async function findSubscription(subscriptionId: string): Promise<Subscription | null> {
  const raw = await redis.hgetall(\`subscription:\${subscriptionId}\`);
  return Object.keys(raw).length === 0 ? null : (raw as unknown as Subscription);
}

/** The invoice row, or null. */
export async function findInvoice(invoiceId: string): Promise<Invoice | null> {
  const raw = await redis.hgetall(\`invoice:\${invoiceId}\`);
  if (Object.keys(raw).length === 0) return null;
  return {...(raw as unknown as Invoice), amount_cents: Number(raw.amount_cents)};
}

/** A new open invoice of the subscription for [periodStart, periodEnd); returns the row. */
export async function openInvoice(subscriptionId: string, periodStart: string, periodEnd: string, amountCents: number): Promise<Invoice> {
  const subscription = await findSubscription(subscriptionId);
  const invoiceId = \`in_\${await redis.incr('invoice:seq')}\`;
  await redis.hset(\`invoice:\${invoiceId}\`, {
    invoice_id: invoiceId,
    subscription_id: subscriptionId,
    tenant: subscription?.tenant ?? '',
    period_start: periodStart,
    period_end: periodEnd,
    amount_cents: String(amountCents),
    state: 'open',
    reference: '',
    reason: '',
  });
  await redis.rpush(\`subscription:\${subscriptionId}:invoices\`, invoiceId);
  return (await findInvoice(invoiceId)) as Invoice;
}

/** Every invoice of the subscription, oldest first. */
export async function invoicesOf(subscriptionId: string): Promise<Invoice[]> {
  const rows: Invoice[] = [];
  for (const invoiceId of await redis.lrange(\`subscription:\${subscriptionId}:invoices\`, 0, -1)) {
    const row = await findInvoice(invoiceId);
    if (row !== null) rows.push(row);
  }
  return rows;
}

/** The processor charged the invoice under reference. */
export async function markCharged(invoiceId: string, reference: string): Promise<void> {
  await redis.hset(\`invoice:\${invoiceId}\`, {state: 'charged', reference, reason: ''});
}

/** The charge failed for reason (the issuer's decline code, or why the processor could not be reached). */
export async function markFailed(invoiceId: string, reason: string): Promise<void> {
  await redis.hset(\`invoice:\${invoiceId}\`, {state: 'failed', reference: '', reason});
}

/** Credit amountCents against the invoice; returns the credit. */
export async function grantCredit(invoiceId: string, amountCents: number, reason: string): Promise<Credit> {
  const credit = {credit_id: \`cr_\${await redis.incr('credit:seq')}\`, amount_cents: amountCents, reason};
  await redis.rpush(\`invoice:\${invoiceId}:credits\`, JSON.stringify(credit));
  return credit;
}

/** The credits granted against the invoice, oldest first. */
export async function creditsOf(invoiceId: string): Promise<Credit[]> {
  return (await redis.lrange(\`invoice:\${invoiceId}:credits\`, 0, -1)).map(row => JSON.parse(row) as Credit);
}

/** Keep an event the broker did not take; the relay publishes it later. */
export async function insertOutbox(topic: string, key: string, payload: Record<string, unknown>): Promise<void> {
  await redis.rpush('outbox', JSON.stringify({topic, key, payload}));
}
`,
  'billing/processor.ts': `/**
 * The processor client (provided; step 3 builds the same two functions). chargeInvoice charges an
 * invoice and answers its Outcome: every call carries a 5-second deadline and the invoice id as its
 * idempotency key, a decline is final (its decline code is the reason), a deadline is reconciled
 * with GetInvoice before any retry, and UNAVAILABLE is retried, MAX_ATTEMPTS calls in all.
 * lookupInvoice answers what the processor holds for an invoice, null when it holds nothing or did
 * not answer.
 */
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import type {Invoice, Outcome, ProcessorInvoice} from 'billing/store';

export const DEADLINE_MS = 5000;
export const MAX_ATTEMPTS = 3;

interface ChargeRequest {
  invoice_id: string;
  subscription_id: string;
  amount_cents: number;
  idempotency_key: string;
}

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('subscription_billing.proto')) as unknown as {
  subbilling: {Processor: grpc.ServiceClientConstructor};
};
const processor = new pkg.subbilling.Processor('processor:9000', grpc.credentials.createInsecure()) as grpc.Client & {
  Charge(request: ChargeRequest, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<{status: string; reference: string; decline_code: string}>;
  GetInvoice(request: {invoice_id: string}, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<ProcessorInvoice>;
};

export async function lookupInvoice(invoiceId: string): Promise<ProcessorInvoice | null> {
  try {
    const found = await processor.GetInvoice({invoice_id: invoiceId}, new grpc.Metadata(), {deadline: Date.now() + DEADLINE_MS});
    return {invoice_id: found.invoice_id, state: found.state, reference: found.reference, total_cents: Number(found.total_cents)};
  } catch {
    return null;
  }
}

export async function chargeInvoice(invoice: Invoice): Promise<Outcome> {
  const request = {
    invoice_id: invoice.invoice_id,
    subscription_id: invoice.subscription_id,
    amount_cents: invoice.amount_cents,
    idempotency_key: invoice.invoice_id,
  };
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    let result;
    try {
      result = await processor.Charge(request, new grpc.Metadata(), {deadline: Date.now() + DEADLINE_MS});
    } catch (e) {
      const {code} = e as grpc.ServiceError;
      if (code === grpc.status.DEADLINE_EXCEEDED) {
        const found = await lookupInvoice(invoice.invoice_id);
        if (found !== null && found.state === 'charged') return {state: 'charged', reference: found.reference, reason: ''};
        continue;
      }
      if (code === grpc.status.UNAVAILABLE) continue;
      return {state: 'failed', reference: '', reason: String(grpc.status[code]).toLowerCase()};
    }
    if (result.status === 'declined') return {state: 'failed', reference: '', reason: result.decline_code};
    return {state: 'charged', reference: result.reference, reason: ''};
  }
  return {state: 'failed', reference: '', reason: 'processor_unavailable'};
}
`,
};

export const supportModulesGo: Record<string, string> = {
  'billing/dates/dates.go': `// Package dates is the calendar the billing service counts in: ISO-8601 days ("2026-03-17") in
// UTC. A period is [period_start, period_end): it starts on period_start and ends before
// period_end, so its length is DaysBetween(periodStart, periodEnd). Today reads the clock.
package dates

import "time"

const layout = "2006-01-02"

func parse(day string) time.Time {
	t, _ := time.Parse(layout, day)
	return t
}

// Today is the current UTC day.
func Today() string { return time.Now().UTC().Format(layout) }

// AddDays is the day n days after day (before it when n is negative).
func AddDays(day string, n int) string { return parse(day).AddDate(0, 0, n).Format(layout) }

// DaysBetween is the days from start to end: 31 from 2026-01-01 to 2026-02-01.
func DaysBetween(start, end string) int { return int(parse(end).Sub(parse(start)).Hours() / 24) }
`,
  'billing/store/store.go': `// Package store is the billing records (provided), kept in Redis hashes as the course's stand-in
// for the billing database. subscription:{id} is a subscription (subscription_id, tenant, plan,
// period_start, period_end); invoice:{id} an invoice (invoice_id, subscription_id, tenant,
// period_start, period_end, amount_cents, state: open, charged or failed, reference, reason), listed
// oldest first under subscription:{id}:invoices; invoice:{id}:credits the credits granted against an
// invoice (JSON: credit_id, amount_cents, reason); outbox the events the broker did not take (JSON:
// topic, key, payload). Plans are the plan prices per period, in cents. An Outcome is what a charge
// came to; a ProcessorInvoice what the processor holds for an invoice.
package store

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// Plans are the plan prices per period, in cents.
var Plans = map[string]int64{"starter": 1900, "scale": 9900}

type Subscription struct {
	SubscriptionID string \`json:"subscription_id"\`
	Tenant         string \`json:"tenant"\`
	Plan           string \`json:"plan"\`
	PeriodStart    string \`json:"period_start"\`
	PeriodEnd      string \`json:"period_end"\`
}

type Invoice struct {
	InvoiceID      string \`json:"invoice_id"\`
	SubscriptionID string \`json:"subscription_id"\`
	Tenant         string \`json:"tenant"\`
	PeriodStart    string \`json:"period_start"\`
	PeriodEnd      string \`json:"period_end"\`
	AmountCents    int64  \`json:"amount_cents"\`
	State          string \`json:"state"\`
	Reference      string \`json:"reference"\`
	Reason         string \`json:"reason"\`
}

type Credit struct {
	CreditID    string \`json:"credit_id"\`
	AmountCents int64  \`json:"amount_cents"\`
	Reason      string \`json:"reason"\`
}

// Outcome is what a charge came to: State "charged" (with Reference) or "failed" (with Reason).
type Outcome struct {
	State     string \`json:"state"\`
	Reference string \`json:"reference"\`
	Reason    string \`json:"reason"\`
}

// ProcessorInvoice is what the processor holds for an invoice.
type ProcessorInvoice struct {
	InvoiceID  string \`json:"invoice_id"\`
	State      string \`json:"state"\`
	Reference  string \`json:"reference"\`
	TotalCents int64  \`json:"total_cents"\`
}

// PlanPrice is the plan's price per period in cents; ok is false when the catalogue has no such plan.
func PlanPrice(plan string) (int64, bool) {
	price, ok := Plans[plan]
	return price, ok
}

// PutSubscription writes the subscription row (the demo and the checks seed subscriptions this way).
func PutSubscription(ctx context.Context, subscriptionID, tenant, plan, periodStart, periodEnd string) *Subscription {
	rdb.HSet(ctx, "subscription:"+subscriptionID, map[string]any{"subscription_id": subscriptionID, "tenant": tenant, "plan": plan, "period_start": periodStart, "period_end": periodEnd})
	return FindSubscription(ctx, subscriptionID)
}

// FindSubscription is the subscription row, or nil.
func FindSubscription(ctx context.Context, subscriptionID string) *Subscription {
	raw := rdb.HGetAll(ctx, "subscription:"+subscriptionID).Val()
	if len(raw) == 0 {
		return nil
	}
	return &Subscription{SubscriptionID: raw["subscription_id"], Tenant: raw["tenant"], Plan: raw["plan"], PeriodStart: raw["period_start"], PeriodEnd: raw["period_end"]}
}

// FindInvoice is the invoice row, or nil.
func FindInvoice(ctx context.Context, invoiceID string) *Invoice {
	raw := rdb.HGetAll(ctx, "invoice:"+invoiceID).Val()
	if len(raw) == 0 {
		return nil
	}
	amount, _ := strconv.ParseInt(raw["amount_cents"], 10, 64)
	return &Invoice{
		InvoiceID: raw["invoice_id"], SubscriptionID: raw["subscription_id"], Tenant: raw["tenant"], PeriodStart: raw["period_start"],
		PeriodEnd: raw["period_end"], AmountCents: amount, State: raw["state"], Reference: raw["reference"], Reason: raw["reason"],
	}
}

// OpenInvoice writes a new open invoice of the subscription for [periodStart, periodEnd) and returns it.
func OpenInvoice(ctx context.Context, subscriptionID, periodStart, periodEnd string, amountCents int64) *Invoice {
	tenant := ""
	if s := FindSubscription(ctx, subscriptionID); s != nil {
		tenant = s.Tenant
	}
	invoiceID := fmt.Sprintf("in_%d", rdb.Incr(ctx, "invoice:seq").Val())
	rdb.HSet(ctx, "invoice:"+invoiceID, map[string]any{
		"invoice_id": invoiceID, "subscription_id": subscriptionID, "tenant": tenant, "period_start": periodStart, "period_end": periodEnd,
		"amount_cents": strconv.FormatInt(amountCents, 10), "state": "open", "reference": "", "reason": "",
	})
	rdb.RPush(ctx, "subscription:"+subscriptionID+":invoices", invoiceID)
	return FindInvoice(ctx, invoiceID)
}

// InvoicesOf is every invoice of the subscription, oldest first.
func InvoicesOf(ctx context.Context, subscriptionID string) []Invoice {
	rows := []Invoice{}
	for _, invoiceID := range rdb.LRange(ctx, "subscription:"+subscriptionID+":invoices", 0, -1).Val() {
		if row := FindInvoice(ctx, invoiceID); row != nil {
			rows = append(rows, *row)
		}
	}
	return rows
}

// MarkCharged records that the processor charged the invoice under reference.
func MarkCharged(ctx context.Context, invoiceID, reference string) error {
	return rdb.HSet(ctx, "invoice:"+invoiceID, map[string]any{"state": "charged", "reference": reference, "reason": ""}).Err()
}

// MarkFailed records that the charge failed for reason (the issuer's decline code, or why the processor could not be reached).
func MarkFailed(ctx context.Context, invoiceID, reason string) error {
	return rdb.HSet(ctx, "invoice:"+invoiceID, map[string]any{"state": "failed", "reference": "", "reason": reason}).Err()
}

// GrantCredit credits amountCents against the invoice and returns the credit.
func GrantCredit(ctx context.Context, invoiceID string, amountCents int64, reason string) Credit {
	credit := Credit{CreditID: fmt.Sprintf("cr_%d", rdb.Incr(ctx, "credit:seq").Val()), AmountCents: amountCents, Reason: reason}
	raw, _ := json.Marshal(credit)
	rdb.RPush(ctx, "invoice:"+invoiceID+":credits", raw)
	return credit
}

// CreditsOf is the credits granted against the invoice, oldest first.
func CreditsOf(ctx context.Context, invoiceID string) []Credit {
	credits := []Credit{}
	for _, raw := range rdb.LRange(ctx, "invoice:"+invoiceID+":credits", 0, -1).Val() {
		var credit Credit
		if json.Unmarshal([]byte(raw), &credit) == nil {
			credits = append(credits, credit)
		}
	}
	return credits
}

// InsertOutbox keeps an event the broker did not take; the relay publishes it later.
func InsertOutbox(ctx context.Context, topic, key string, payload map[string]any) error {
	raw, _ := json.Marshal(map[string]any{"topic": topic, "key": key, "payload": payload})
	return rdb.RPush(ctx, "outbox", raw).Err()
}
`,
  'billing/processor/processor.go': `// Package processor is the processor client (provided; step 3 builds the same two functions).
// ChargeInvoice charges an invoice and answers its Outcome: every call carries a 5-second deadline
// and the invoice id as its idempotency key, a decline is final (its decline code is the reason), a
// deadline is reconciled with GetInvoice before any retry, and Unavailable is retried, MaxAttempts
// calls in all. LookupInvoice answers what the processor holds for an invoice, nil when it holds
// nothing or did not answer.
package processor

import (
	"context"
	"strings"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"

	pb "billing/gen/subscription_billing"
	"billing/store"
)

const (
	Deadline    = 5 * time.Second
	MaxAttempts = 3
)

var (
	conn, _ = grpc.NewClient("processor:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
	client  = pb.NewProcessorClient(conn)
)

// LookupInvoice is what the processor holds for the invoice, or nil.
func LookupInvoice(ctx context.Context, invoiceID string) *store.ProcessorInvoice {
	callCtx, cancel := context.WithTimeout(ctx, Deadline)
	defer cancel()
	found, err := client.GetInvoice(callCtx, &pb.GetInvoiceRequest{InvoiceId: invoiceID})
	if err != nil {
		return nil
	}
	return &store.ProcessorInvoice{InvoiceID: found.GetInvoiceId(), State: found.GetState(), Reference: found.GetReference(), TotalCents: found.GetTotalCents()}
}

// ChargeInvoice charges the invoice through the processor and answers what came of it.
func ChargeInvoice(ctx context.Context, invoice *store.Invoice) store.Outcome {
	request := &pb.ChargeRequest{InvoiceId: invoice.InvoiceID, SubscriptionId: invoice.SubscriptionID, AmountCents: invoice.AmountCents, IdempotencyKey: invoice.InvoiceID}
	for attempt := 0; attempt < MaxAttempts; attempt++ {
		callCtx, cancel := context.WithTimeout(ctx, Deadline)
		result, err := client.Charge(callCtx, request)
		cancel()
		if err != nil {
			switch status.Code(err) {
			case codes.DeadlineExceeded:
				if found := LookupInvoice(ctx, invoice.InvoiceID); found != nil && found.State == "charged" {
					return store.Outcome{State: "charged", Reference: found.Reference}
				}
				continue
			case codes.Unavailable:
				continue
			}
			return store.Outcome{State: "failed", Reason: strings.ToLower(status.Code(err).String())}
		}
		if result.GetStatus() == "declined" {
			return store.Outcome{State: "failed", Reason: result.GetDeclineCode()}
		}
		return store.Outcome{State: "charged", Reference: result.GetReference()}
	}
	return store.Outcome{State: "failed", Reason: "processor_unavailable"}
}
`,
};

export const supportModulesCpp: Record<string, string> = {
  'billing/dates.h': `// Dates as the billing service counts them: ISO-8601 calendar days ("2026-03-17") in UTC. A period
// is [period_start, period_end): it starts on period_start and ends before period_end, so its
// length is daysBetween(period_start, period_end). today() reads the clock.
#pragma once

#include <chrono>
#include <cstdio>
#include <string>

namespace dates {

// Days since 1970-01-01 of a civil date (proleptic Gregorian).
inline long epochDay(int y, int m, int d) {
  y -= m <= 2;
  const long era = (y >= 0 ? y : y - 399) / 400;
  const long yoe = y - era * 400;
  const long doy = (153 * (m + (m > 2 ? -3 : 9)) + 2) / 5 + d - 1;
  const long doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
  return era * 146097 + doe - 719468;
}

inline long epochDay(const std::string& day) {
  int y = 0, m = 0, d = 0;
  std::sscanf(day.c_str(), "%d-%d-%d", &y, &m, &d);
  return epochDay(y, m, d);
}

// The ISO day of a count of days since 1970-01-01.
inline std::string fromEpochDay(long z) {
  z += 719468;
  const long era = (z >= 0 ? z : z - 146096) / 146097;
  const long doe = z - era * 146097;
  const long yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
  const long doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
  const long mp = (5 * doy + 2) / 153;
  const long d = doy - (153 * mp + 2) / 5 + 1;
  const long m = mp < 10 ? mp + 3 : mp - 9;
  const long y = yoe + era * 400 + (m <= 2);
  char out[16];
  std::snprintf(out, sizeof out, "%04ld-%02ld-%02ld", y, m, d);
  return out;
}

// The current UTC day.
inline std::string today() {
  const long long seconds = std::chrono::duration_cast<std::chrono::seconds>(std::chrono::system_clock::now().time_since_epoch()).count();
  return fromEpochDay(static_cast<long>(seconds >= 0 ? seconds / 86400 : (seconds - 86399) / 86400));
}

// The day n days after day (before it when n is negative).
inline std::string addDays(const std::string& day, long n) { return fromEpochDay(epochDay(day) + n); }

// The days from start to end: 31 from 2026-01-01 to 2026-02-01.
inline long daysBetween(const std::string& start, const std::string& stop) { return epochDay(stop) - epochDay(start); }

}  // namespace dates
`,
  'billing/store.h': `// The billing records (provided), kept in Redis hashes as the course's stand-in for the billing
// database. subscription:{id} is a subscription (subscription_id, tenant, plan, period_start,
// period_end); invoice:{id} an invoice (invoice_id, subscription_id, tenant, period_start,
// period_end, amount_cents, state: open, charged or failed, reference, reason), listed oldest first
// under subscription:{id}:invoices; invoice:{id}:credits the credits granted against an invoice
// (JSON: credit_id, amount_cents, reason); outbox the events the broker did not take (JSON: topic,
// key, payload). kPlans are the plan prices per period, in cents. An Outcome is what a charge came
// to; a ProcessorInvoice what the processor holds for an invoice.
#pragma once

#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <map>
#include <optional>
#include <string>
#include <unordered_map>
#include <vector>

namespace store {

const std::map<std::string, long long> kPlans = {{"starter", 1900}, {"scale", 9900}};

struct Subscription {
  std::string subscription_id;
  std::string tenant;
  std::string plan;
  std::string period_start;
  std::string period_end;
};

struct Invoice {
  std::string invoice_id;
  std::string subscription_id;
  std::string tenant;
  std::string period_start;
  std::string period_end;
  long long amount_cents = 0;
  std::string state;
  std::string reference;
  std::string reason;
};

struct Credit {
  std::string credit_id;
  long long amount_cents = 0;
  std::string reason;
};

// What a charge came to: state "charged" (with reference) or "failed" (with reason).
struct Outcome {
  std::string state;
  std::string reference;
  std::string reason;
};

// What the processor holds for an invoice.
struct ProcessorInvoice {
  std::string invoice_id;
  std::string state;
  std::string reference;
  long long total_cents = 0;
};

inline sw::redis::Redis& redis() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

// The plan's price per period in cents, or none when the catalogue has no such plan.
inline std::optional<long long> planPrice(const std::string& plan) {
  const auto it = kPlans.find(plan);
  if (it == kPlans.end()) return std::nullopt;
  return it->second;
}

// The subscription row, or none.
inline std::optional<Subscription> findSubscription(const std::string& subscription_id) {
  const std::unordered_map<std::string, std::string> raw = redis().hgetall("subscription:" + subscription_id);
  if (raw.empty()) return std::nullopt;
  const auto text = [&raw](const char* name) { return raw.count(name) ? raw.at(name) : std::string(); };
  return Subscription{text("subscription_id"), text("tenant"), text("plan"), text("period_start"), text("period_end")};
}

// Write the subscription row (the demo and the checks seed subscriptions this way).
inline Subscription putSubscription(const std::string& subscription_id, const std::string& tenant, const std::string& plan,
                                    const std::string& period_start, const std::string& period_end) {
  redis().hset("subscription:" + subscription_id, {{"subscription_id", subscription_id},
                                                   {"tenant", tenant},
                                                   {"plan", plan},
                                                   {"period_start", period_start},
                                                   {"period_end", period_end}});
  return *findSubscription(subscription_id);
}

// The invoice row, or none.
inline std::optional<Invoice> findInvoice(const std::string& invoice_id) {
  const std::unordered_map<std::string, std::string> raw = redis().hgetall("invoice:" + invoice_id);
  if (raw.empty()) return std::nullopt;
  const auto text = [&raw](const char* name) { return raw.count(name) ? raw.at(name) : std::string(); };
  return Invoice{text("invoice_id"), text("subscription_id"), text("tenant"), text("period_start"), text("period_end"),
                 std::stoll(text("amount_cents")), text("state"), text("reference"), text("reason")};
}

// A new open invoice of the subscription for [period_start, period_end); returns the row.
inline Invoice openInvoice(const std::string& subscription_id, const std::string& period_start, const std::string& period_end,
                           long long amount_cents) {
  const auto subscription = findSubscription(subscription_id);
  const std::string invoice_id = "in_" + std::to_string(redis().incr("invoice:seq"));
  redis().hset("invoice:" + invoice_id, {{"invoice_id", invoice_id},
                                         {"subscription_id", subscription_id},
                                         {"tenant", subscription ? subscription->tenant : ""},
                                         {"period_start", period_start},
                                         {"period_end", period_end},
                                         {"amount_cents", std::to_string(amount_cents)},
                                         {"state", "open"},
                                         {"reference", ""},
                                         {"reason", ""}});
  redis().rpush("subscription:" + subscription_id + ":invoices", invoice_id);
  return *findInvoice(invoice_id);
}

// Every invoice of the subscription, oldest first.
inline std::vector<Invoice> invoicesOf(const std::string& subscription_id) {
  std::vector<Invoice> rows;
  for (const std::string& invoice_id : redis().lrange("subscription:" + subscription_id + ":invoices", 0, -1)) {
    if (auto row = findInvoice(invoice_id)) rows.push_back(*row);
  }
  return rows;
}

// The processor charged the invoice under reference.
inline void markCharged(const std::string& invoice_id, const std::string& reference) {
  redis().hset("invoice:" + invoice_id, {{"state", "charged"}, {"reference", reference}, {"reason", ""}});
}

// The charge failed for reason (the issuer's decline code, or why the processor could not be reached).
inline void markFailed(const std::string& invoice_id, const std::string& reason) {
  redis().hset("invoice:" + invoice_id, {{"state", "failed"}, {"reference", ""}, {"reason", reason}});
}

// Credit amount_cents against the invoice; returns the credit.
inline Credit grantCredit(const std::string& invoice_id, long long amount_cents, const std::string& reason) {
  const Credit credit{"cr_" + std::to_string(redis().incr("credit:seq")), amount_cents, reason};
  redis().rpush("invoice:" + invoice_id + ":credits",
                nlohmann::json{{"credit_id", credit.credit_id}, {"amount_cents", credit.amount_cents}, {"reason", credit.reason}}.dump());
  return credit;
}

// The credits granted against the invoice, oldest first.
inline std::vector<Credit> creditsOf(const std::string& invoice_id) {
  std::vector<Credit> credits;
  for (const std::string& raw : redis().lrange("invoice:" + invoice_id + ":credits", 0, -1)) {
    const auto row = nlohmann::json::parse(raw);
    credits.push_back(Credit{row.value("credit_id", ""), row.value("amount_cents", 0LL), row.value("reason", "")});
  }
  return credits;
}

// Keep an event the broker did not take; the relay publishes it later.
inline void insertOutbox(const std::string& topic, const std::string& key, const nlohmann::json& payload) {
  redis().rpush("outbox", nlohmann::json{{"topic", topic}, {"key", key}, {"payload", payload}}.dump());
}

}  // namespace store
`,
  'billing/processor.h': `// The processor client (provided; step 3 builds the same two functions). chargeInvoice charges an
// invoice and answers its Outcome: every call carries a 5-second deadline and the invoice id as its
// idempotency key, a decline is final (its decline code is the reason), a deadline is reconciled
// with GetInvoice before any retry, and UNAVAILABLE is retried, kMaxAttempts calls in all.
// lookupInvoice answers what the processor holds for an invoice, none when it holds nothing or did
// not answer.
#pragma once

#include <grpcpp/grpcpp.h>

#include <chrono>
#include <memory>
#include <optional>
#include <string>

#include "billing/store.h"
#include "subscription_billing.grpc.pb.h"

namespace processor {

constexpr std::chrono::seconds kDeadline{5};
constexpr int kMaxAttempts = 3;

inline subbilling::Processor::Stub& stub() {
  static std::unique_ptr<subbilling::Processor::Stub> s =
      subbilling::Processor::NewStub(grpc::CreateChannel("processor:9000", grpc::InsecureChannelCredentials()));
  return *s;
}

// What the processor holds for the invoice, or none.
inline std::optional<store::ProcessorInvoice> lookupInvoice(const std::string& invoice_id) {
  grpc::ClientContext ctx;
  ctx.set_deadline(std::chrono::system_clock::now() + kDeadline);
  subbilling::GetInvoiceRequest request;
  request.set_invoice_id(invoice_id);
  subbilling::ProcessorInvoice found;
  if (!stub().GetInvoice(&ctx, request, &found).ok()) return std::nullopt;
  return store::ProcessorInvoice{found.invoice_id(), found.state(), found.reference(), found.total_cents()};
}

// Charge the invoice through the processor and answer what came of it.
inline store::Outcome chargeInvoice(const store::Invoice& invoice) {
  subbilling::ChargeRequest request;
  request.set_invoice_id(invoice.invoice_id);
  request.set_subscription_id(invoice.subscription_id);
  request.set_amount_cents(invoice.amount_cents);
  request.set_idempotency_key(invoice.invoice_id);
  for (int attempt = 0; attempt < kMaxAttempts; attempt++) {
    grpc::ClientContext ctx;
    ctx.set_deadline(std::chrono::system_clock::now() + kDeadline);
    subbilling::ChargeResult result;
    const grpc::Status status = stub().Charge(&ctx, request, &result);
    if (status.error_code() == grpc::StatusCode::DEADLINE_EXCEEDED) {
      const auto found = lookupInvoice(invoice.invoice_id);
      if (found && found->state == "charged") return store::Outcome{"charged", found->reference, ""};
      continue;
    }
    if (status.error_code() == grpc::StatusCode::UNAVAILABLE) continue;
    if (!status.ok()) return store::Outcome{"failed", "", "processor_error"};
    if (result.status() == "declined") return store::Outcome{"failed", "", result.decline_code()};
    return store::Outcome{"charged", result.reference(), ""};
  }
  return store::Outcome{"failed", "", "processor_unavailable"};
}

}  // namespace processor
`,
};

export const supportModulesScala: Record<string, string> = {
  [scalaPath('billing', 'Dates')]: `package billing

import java.time.temporal.ChronoUnit
import java.time.{LocalDate, ZoneOffset}

/**
 * Dates as the billing service counts them: ISO-8601 calendar days ("2026-03-17") in UTC. A period
 * is [period_start, period_end): it starts on period_start and ends before period_end, so its length
 * is daysBetween(periodStart, periodEnd). today() reads the clock.
 */
object Dates {
  /** The current UTC day. */
  def today(): String = LocalDate.now(ZoneOffset.UTC).toString

  /** The day n days after day (before it when n is negative). */
  def addDays(day: String, n: Long): String = LocalDate.parse(day).plusDays(n).toString

  /** The days from start to end: 31 from 2026-01-01 to 2026-02-01. */
  def daysBetween(start: String, end: String): Long = ChronoUnit.DAYS.between(LocalDate.parse(start), LocalDate.parse(end))
}
`,
  [scalaPath('billing', 'Store')]: `package billing

import redis.clients.jedis.JedisPooled
import spray.json._

import scala.jdk.CollectionConverters._

/**
 * The billing records (provided), kept in Redis hashes as the course's stand-in for the billing
 * database. subscription:{id} is a subscription (subscription_id, tenant, plan, period_start,
 * period_end); invoice:{id} an invoice (invoice_id, subscription_id, tenant, period_start,
 * period_end, amount_cents, state: open, charged or failed, reference, reason), listed oldest first
 * under subscription:{id}:invoices; invoice:{id}:credits the credits granted against an invoice
 * (JSON: credit_id, amount_cents, reason); outbox the events the broker did not take (JSON: topic,
 * key, payload). Plans are the plan prices per period, in cents. An Outcome is what a charge came
 * to; a ProcessorInvoice what the processor holds for an invoice.
 */
object Store {
  final case class Subscription(subscriptionId: String, tenant: String, plan: String, periodStart: String, periodEnd: String)
  final case class Invoice(invoiceId: String, subscriptionId: String, tenant: String, periodStart: String, periodEnd: String,
                           amountCents: Long, state: String, reference: String, reason: String)
  final case class Credit(creditId: String, amountCents: Long, reason: String)
  final case class Outcome(state: String, reference: String, reason: String)
  final case class ProcessorInvoice(invoiceId: String, state: String, reference: String, totalCents: Long)

  val Plans: Map[String, Long] = Map("starter" -> 1900L, "scale" -> 9900L)

  val jedis = new JedisPooled("redis", 6379)

  /** The plan's price per period in cents, or None when the catalogue has no such plan. */
  def planPrice(plan: String): Option[Long] = Plans.get(plan)

  /** Write the subscription row (the demo and the checks seed subscriptions this way). */
  def putSubscription(subscriptionId: String, tenant: String, plan: String, periodStart: String, periodEnd: String): Subscription = {
    jedis.hset(
      s"subscription:$subscriptionId",
      Map("subscription_id" -> subscriptionId, "tenant" -> tenant, "plan" -> plan, "period_start" -> periodStart, "period_end" -> periodEnd).asJava)
    findSubscription(subscriptionId).get
  }

  /** The subscription row, if it exists. */
  def findSubscription(subscriptionId: String): Option[Subscription] = {
    val raw = jedis.hgetAll(s"subscription:$subscriptionId").asScala
    if (raw.isEmpty) None
    else Some(Subscription(raw("subscription_id"), raw("tenant"), raw("plan"), raw("period_start"), raw("period_end")))
  }

  /** The invoice row, if it exists. */
  def findInvoice(invoiceId: String): Option[Invoice] = {
    val raw = jedis.hgetAll(s"invoice:$invoiceId").asScala
    def text(name: String): String = raw.getOrElse(name, "")
    if (raw.isEmpty) None
    else Some(Invoice(text("invoice_id"), text("subscription_id"), text("tenant"), text("period_start"), text("period_end"),
      text("amount_cents").toLong, text("state"), text("reference"), text("reason")))
  }

  /** A new open invoice of the subscription for [periodStart, periodEnd); returns the row. */
  def openInvoice(subscriptionId: String, periodStart: String, periodEnd: String, amountCents: Long): Invoice = {
    val tenant = findSubscription(subscriptionId).map(_.tenant).getOrElse("")
    val invoiceId = s"in_\${jedis.incr("invoice:seq")}"
    jedis.hset(
      s"invoice:$invoiceId",
      Map("invoice_id" -> invoiceId, "subscription_id" -> subscriptionId, "tenant" -> tenant, "period_start" -> periodStart,
        "period_end" -> periodEnd, "amount_cents" -> amountCents.toString, "state" -> "open", "reference" -> "", "reason" -> "").asJava)
    jedis.rpush(s"subscription:$subscriptionId:invoices", invoiceId)
    findInvoice(invoiceId).get
  }

  /** Every invoice of the subscription, oldest first. */
  def invoicesOf(subscriptionId: String): Seq[Invoice] =
    jedis.lrange(s"subscription:$subscriptionId:invoices", 0, -1).asScala.toSeq.flatMap(findInvoice)

  /** The processor charged the invoice under reference. */
  def markCharged(invoiceId: String, reference: String): Unit =
    jedis.hset(s"invoice:$invoiceId", Map("state" -> "charged", "reference" -> reference, "reason" -> "").asJava)

  /** The charge failed for reason (the issuer's decline code, or why the processor could not be reached). */
  def markFailed(invoiceId: String, reason: String): Unit =
    jedis.hset(s"invoice:$invoiceId", Map("state" -> "failed", "reference" -> "", "reason" -> reason).asJava)

  /** Credit amountCents against the invoice; returns the credit. */
  def grantCredit(invoiceId: String, amountCents: Long, reason: String): Credit = {
    val credit = Credit(s"cr_\${jedis.incr("credit:seq")}", amountCents, reason)
    jedis.rpush(s"invoice:$invoiceId:credits",
      JsObject("credit_id" -> JsString(credit.creditId), "amount_cents" -> JsNumber(amountCents), "reason" -> JsString(reason)).compactPrint)
    credit
  }

  /** The credits granted against the invoice, oldest first. */
  def creditsOf(invoiceId: String): Seq[Credit] =
    jedis.lrange(s"invoice:$invoiceId:credits", 0, -1).asScala.toSeq.map { raw =>
      val row = raw.parseJson.asJsObject.fields
      Credit(row("credit_id").asInstanceOf[JsString].value, row("amount_cents").asInstanceOf[JsNumber].value.toLong, row("reason").asInstanceOf[JsString].value)
    }

  /** Keep an event the broker did not take; the relay publishes it later. */
  def insertOutbox(topic: String, key: String, payload: JsObject): Unit =
    jedis.rpush("outbox", JsObject("topic" -> JsString(topic), "key" -> JsString(key), "payload" -> payload).compactPrint)
}
`,
  [scalaPath('billing', 'Processor')]: `package billing

import java.util.concurrent.TimeUnit

import io.grpc.{ManagedChannelBuilder, Status, StatusRuntimeException}

import subbilling.subscription_billing.{ChargeRequest, GetInvoiceRequest, ProcessorGrpc}

/**
 * The processor client (provided; step 3 builds the same two functions). chargeInvoice charges an
 * invoice and answers its Outcome: every call carries a 5-second deadline and the invoice id as its
 * idempotency key, a decline is final (its decline code is the reason), a deadline is reconciled
 * with GetInvoice before any retry, and UNAVAILABLE is retried, MaxAttempts calls in all.
 * lookupInvoice answers what the processor holds for an invoice, None when it holds nothing or did
 * not answer.
 */
object Processor {
  val DeadlineSeconds = 5L
  val MaxAttempts = 3

  private val stub = ProcessorGrpc.blockingStub(ManagedChannelBuilder.forAddress("processor", 9000).usePlaintext().build())

  def lookupInvoice(invoiceId: String): Option[Store.ProcessorInvoice] =
    try {
      val found = stub.withDeadlineAfter(DeadlineSeconds, TimeUnit.SECONDS).getInvoice(GetInvoiceRequest(invoiceId))
      Some(Store.ProcessorInvoice(found.invoiceId, found.state, found.reference, found.totalCents))
    } catch {
      case _: StatusRuntimeException => None
    }

  def chargeInvoice(invoice: Store.Invoice): Store.Outcome = {
    val request = ChargeRequest(invoice.invoiceId, invoice.subscriptionId, invoice.amountCents, invoice.invoiceId)
    var attempt = 0
    while (attempt < MaxAttempts) {
      attempt += 1
      try {
        val result = stub.withDeadlineAfter(DeadlineSeconds, TimeUnit.SECONDS).charge(request)
        return if (result.status == "declined") Store.Outcome("failed", "", result.declineCode) else Store.Outcome("charged", result.reference, "")
      } catch {
        case e: StatusRuntimeException if e.getStatus.getCode == Status.Code.DEADLINE_EXCEEDED =>
          lookupInvoice(invoice.invoiceId).filter(_.state == "charged") match {
            case Some(found) => return Store.Outcome("charged", found.reference, "")
            case None => ()
          }
        case e: StatusRuntimeException if e.getStatus.getCode == Status.Code.UNAVAILABLE => ()
        case e: StatusRuntimeException => return Store.Outcome("failed", "", e.getStatus.getCode.toString.toLowerCase)
      }
    }
    Store.Outcome("failed", "", "processor_unavailable")
  }
}
`,
};
