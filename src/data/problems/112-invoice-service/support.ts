/**
 * Hand-written support modules the invoice-service steps import but no step builds: the `invoice`
 * package. `invoice.store` is the invoice store (every invoice is a Redis hash, the course's
 * stand-in for the billing database): drafts, finalized invoices, tax figures and holds, recorded
 * finalize results, the outbox of events the broker did not take, and the line digest the events
 * carry. `invoice.sequence` is the finalize claim of step 2 as later steps use it: one Lua script
 * that refuses a non-draft, INCRs the tenant's sequence and writes the number. The five languages
 * keep the same keys, so a harness reads one layout whatever the stack.
 */
import {scalaPath} from '../scala-support';

export const supportModules: Record<string, string> = {
  'invoice/__init__.py': '',
  'invoice/store.py': `"""
The invoice store (provided): every invoice is a Redis hash invoice:{id} with id, tenant_id,
customer_id, currency, jurisdiction, status (draft or finalized), number ("" until finalized),
line_items (a JSON list of {description, quantity, unit_price_cents}), subtotal_cents, tax_cents and
tax_source ("" until a quote is recorded), internal_notes, and hold_reason/hold_attempts (a tax hold,
"" when there is none). Ids come from INCR invoice:ids. invoice:finalize:{tenant}:{key} is the
recorded result of a finalize request; invoice:outbox the list of events the broker did not take.
An invoice is returned as a dict: number and tax_cents are None until set, tax_source None until a
quote is recorded, tax_hold None or {reason, attempts}.
"""
import hashlib
import json

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

OUTBOX_KEY = "invoice:outbox"


def invoice_key(invoice_id: str) -> str:
    return f"invoice:{invoice_id}"


def subtotal(line_items: list[dict]) -> int:
    """The sum of quantity x unit_price_cents, in minor units."""
    return sum(line["quantity"] * line["unit_price_cents"] for line in line_items)


def line_digest(line: dict) -> str:
    """SHA-256 (hex) of "description|quantity|unit_price_cents": proves a line without carrying its text."""
    text = f"{line['description']}|{line['quantity']}|{line['unit_price_cents']}"
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _lines(line_items: list[dict]) -> list[dict]:
    return [
        {"description": str(line["description"]), "quantity": int(line["quantity"]), "unit_price_cents": int(line["unit_price_cents"])}
        for line in line_items
    ]


def _int(value: str | None) -> int | None:
    return None if value in (None, "") else int(value)


def _invoice(raw: dict) -> dict | None:
    if not raw:
        return None
    hold = None
    if raw.get("hold_reason"):
        hold = {"reason": raw["hold_reason"], "attempts": int(raw.get("hold_attempts") or 0)}
    return {
        "id": raw["id"],
        "tenant_id": raw["tenant_id"],
        "customer_id": raw.get("customer_id", ""),
        "currency": raw.get("currency", ""),
        "jurisdiction": raw.get("jurisdiction", ""),
        "status": raw["status"],
        "number": _int(raw.get("number")),
        "line_items": json.loads(raw.get("line_items") or "[]"),
        "subtotal_cents": int(raw.get("subtotal_cents") or 0),
        "tax_cents": _int(raw.get("tax_cents")),
        "tax_source": raw.get("tax_source") or None,
        "internal_notes": raw.get("internal_notes", ""),
        "tax_hold": hold,
    }


def get(invoice_id: str) -> dict | None:
    """The invoice, or None."""
    return _invoice(r.hgetall(invoice_key(invoice_id)))


def create(tenant: str, currency: str, line_items: list[dict], customer_id: str = "", jurisdiction: str = "", internal_notes: str = "") -> dict:
    """A new draft of the tenant's; returns it."""
    invoice_id = f"inv-{r.incr('invoice:ids')}"
    lines = _lines(line_items)
    r.hset(
        invoice_key(invoice_id),
        mapping={
            "id": invoice_id,
            "tenant_id": tenant,
            "customer_id": customer_id,
            "currency": currency,
            "jurisdiction": jurisdiction,
            "status": "draft",
            "number": "",
            "line_items": json.dumps(lines),
            "subtotal_cents": subtotal(lines),
            "tax_cents": "",
            "tax_source": "",
            "internal_notes": internal_notes,
            "hold_reason": "",
            "hold_attempts": "",
        },
    )
    return get(invoice_id)


def replace_lines(invoice_id: str, line_items: list[dict]) -> dict:
    """Rewrites the line items and the subtotal in place, whatever the invoice's status (the bulk importer's writer)."""
    lines = _lines(line_items)
    r.hset(invoice_key(invoice_id), mapping={"line_items": json.dumps(lines), "subtotal_cents": subtotal(lines)})
    return get(invoice_id)


def reopen(invoice_id: str) -> None:
    """Puts the invoice back to draft and clears its number (the support console's undo)."""
    r.hset(invoice_key(invoice_id), mapping={"status": "draft", "number": ""})


def set_tax(invoice_id: str, tax_cents: int, tax_source: str) -> None:
    """Records the quoted tax and where it came from; clears a tax hold."""
    r.hset(invoice_key(invoice_id), mapping={"tax_cents": tax_cents, "tax_source": tax_source, "hold_reason": "", "hold_attempts": ""})


def hold(invoice_id: str, reason: str, attempts: int) -> None:
    """Marks the draft held for tax: why (the last status, e.g. "unavailable") and after how many attempts."""
    r.hset(invoice_key(invoice_id), mapping={"hold_reason": reason, "hold_attempts": attempts})


def finalize_result(tenant: str, key: str) -> dict | None:
    """The result recorded for the finalize request (tenant, Idempotency-Key), if any."""
    raw = r.get(f"invoice:finalize:{tenant}:{key}")
    return json.loads(raw) if raw else None


def record_finalize(tenant: str, key: str, result: dict) -> None:
    """Record what the finalize request (tenant, key) answered, for its replays."""
    r.set(f"invoice:finalize:{tenant}:{key}", json.dumps(result))


def outbox_add(payload: dict) -> None:
    """Keep an event the broker did not take, for the relay to produce again."""
    r.rpush(OUTBOX_KEY, json.dumps(payload))


def outbox() -> list[dict]:
    """The events waiting in the outbox, oldest first."""
    return [json.loads(raw) for raw in r.lrange(OUTBOX_KEY, 0, -1)]
`,
  'invoice/sequence.py': `"""
The finalize claim (provided; step 2 builds the same function): invoice:seq:{tenant} is the
tenant's last issued number. claim_number runs one Lua script that answers 0 when the invoice is no
longer a draft, else INCRs the tenant's sequence and writes status finalized and the number on the
invoice, so two finalizes never share a number and one invoice is never finalized twice.
"""
import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

CLAIM_LUA = """
if redis.call('HGET', KEYS[1], 'status') ~= 'draft' then return 0 end
local n = redis.call('INCR', KEYS[2])
redis.call('HSET', KEYS[1], 'status', 'finalized', 'number', n)
return n
"""
claim = r.register_script(CLAIM_LUA)


def seq_key(tenant: str) -> str:
    return f"invoice:seq:{tenant}"


def claim_number(tenant: str, invoice_id: str) -> int | None:
    """The invoice's number, claimed and written with status finalized; None when it is no longer a draft."""
    n = claim(keys=[f"invoice:{invoice_id}", seq_key(tenant)])
    return int(n) if n else None
`,
};

export const supportModulesTs: Record<string, string> = {
  'invoice/store.ts': `/**
 * The invoice store (provided): every invoice is a Redis hash invoice:{id} with id, tenant_id,
 * customer_id, currency, jurisdiction, status (draft or finalized), number ("" until finalized),
 * line_items (a JSON list of {description, quantity, unit_price_cents}), subtotal_cents, tax_cents
 * and tax_source ("" until a quote is recorded), internal_notes, and hold_reason/hold_attempts (a
 * tax hold, "" when there is none). Ids come from INCR invoice:ids. invoice:finalize:{tenant}:{key}
 * is the recorded result of a finalize request; invoice:outbox the list of events the broker did
 * not take. An Invoice has number, tax_cents and tax_source null until set, tax_hold null or
 * {reason, attempts}.
 */
import {createHash} from 'node:crypto';

import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

export const OUTBOX_KEY = 'invoice:outbox';

export interface Line {
  description: string;
  quantity: number;
  unit_price_cents: number;
}

export interface Invoice {
  id: string;
  tenant_id: string;
  customer_id: string;
  currency: string;
  jurisdiction: string;
  status: string;
  number: number | null;
  line_items: Line[];
  subtotal_cents: number;
  tax_cents: number | null;
  tax_source: string | null;
  internal_notes: string;
  tax_hold: {reason: string; attempts: number} | null;
}

export const invoiceKey = (invoiceId: string): string => \`invoice:\${invoiceId}\`;

/** The sum of quantity x unit_price_cents, in minor units. */
export const subtotal = (lineItems: Line[]): number => lineItems.reduce((sum, line) => sum + line.quantity * line.unit_price_cents, 0);

/** SHA-256 (hex) of "description|quantity|unit_price_cents": proves a line without carrying its text. */
export const lineDigest = (line: Line): string =>
  createHash('sha256').update(\`\${line.description}|\${line.quantity}|\${line.unit_price_cents}\`).digest('hex');

const lines = (lineItems: Line[]): Line[] =>
  lineItems.map(line => ({description: String(line.description), quantity: Number(line.quantity), unit_price_cents: Number(line.unit_price_cents)}));

const int = (value: string | undefined): number | null => (value === undefined || value === '' ? null : Number(value));

function invoice(raw: Record<string, string>): Invoice | null {
  if (Object.keys(raw).length === 0) return null;
  return {
    id: raw.id,
    tenant_id: raw.tenant_id,
    customer_id: raw.customer_id ?? '',
    currency: raw.currency ?? '',
    jurisdiction: raw.jurisdiction ?? '',
    status: raw.status,
    number: int(raw.number),
    line_items: JSON.parse(raw.line_items || '[]') as Line[],
    subtotal_cents: Number(raw.subtotal_cents || 0),
    tax_cents: int(raw.tax_cents),
    tax_source: raw.tax_source ? raw.tax_source : null,
    internal_notes: raw.internal_notes ?? '',
    tax_hold: raw.hold_reason ? {reason: raw.hold_reason, attempts: Number(raw.hold_attempts || 0)} : null,
  };
}

/** The invoice, or null. */
export async function get(invoiceId: string): Promise<Invoice | null> {
  return invoice(await redis.hgetall(invoiceKey(invoiceId)));
}

/** A new draft of the tenant's; returns it. */
export async function create(tenant: string, currency: string, lineItems: Line[], customerId = '', jurisdiction = '', internalNotes = ''): Promise<Invoice> {
  const invoiceId = \`inv-\${await redis.incr('invoice:ids')}\`;
  const items = lines(lineItems);
  await redis.hset(invoiceKey(invoiceId), {
    id: invoiceId,
    tenant_id: tenant,
    customer_id: customerId,
    currency,
    jurisdiction,
    status: 'draft',
    number: '',
    line_items: JSON.stringify(items),
    subtotal_cents: String(subtotal(items)),
    tax_cents: '',
    tax_source: '',
    internal_notes: internalNotes,
    hold_reason: '',
    hold_attempts: '',
  });
  return (await get(invoiceId)) as Invoice;
}

/** Rewrites the line items and the subtotal in place, whatever the invoice's status (the bulk importer's writer). */
export async function replaceLines(invoiceId: string, lineItems: Line[]): Promise<Invoice> {
  const items = lines(lineItems);
  await redis.hset(invoiceKey(invoiceId), {line_items: JSON.stringify(items), subtotal_cents: String(subtotal(items))});
  return (await get(invoiceId)) as Invoice;
}

/** Puts the invoice back to draft and clears its number (the support console's undo). */
export async function reopen(invoiceId: string): Promise<void> {
  await redis.hset(invoiceKey(invoiceId), {status: 'draft', number: ''});
}

/** Records the quoted tax and where it came from; clears a tax hold. */
export async function setTax(invoiceId: string, taxCents: number, taxSource: string): Promise<void> {
  await redis.hset(invoiceKey(invoiceId), {tax_cents: String(taxCents), tax_source: taxSource, hold_reason: '', hold_attempts: ''});
}

/** Marks the draft held for tax: why (the last status, e.g. "unavailable") and after how many attempts. */
export async function hold(invoiceId: string, reason: string, attempts: number): Promise<void> {
  await redis.hset(invoiceKey(invoiceId), {hold_reason: reason, hold_attempts: String(attempts)});
}

/** The result recorded for the finalize request (tenant, Idempotency-Key), if any. */
export async function finalizeResult(tenant: string, key: string): Promise<Record<string, unknown> | null> {
  const raw = await redis.get(\`invoice:finalize:\${tenant}:\${key}\`);
  return raw === null ? null : (JSON.parse(raw) as Record<string, unknown>);
}

/** Record what the finalize request (tenant, key) answered, for its replays. */
export async function recordFinalize(tenant: string, key: string, result: Record<string, unknown>): Promise<void> {
  await redis.set(\`invoice:finalize:\${tenant}:\${key}\`, JSON.stringify(result));
}

/** Keep an event the broker did not take, for the relay to produce again. */
export async function outboxAdd(payload: Record<string, unknown>): Promise<void> {
  await redis.rpush(OUTBOX_KEY, JSON.stringify(payload));
}

/** The events waiting in the outbox, oldest first. */
export async function outbox(): Promise<Record<string, unknown>[]> {
  return (await redis.lrange(OUTBOX_KEY, 0, -1)).map(raw => JSON.parse(raw) as Record<string, unknown>);
}
`,
  'invoice/sequence.ts': `/**
 * The finalize claim (provided; step 2 builds the same function): invoice:seq:{tenant} is the
 * tenant's last issued number. claimNumber runs one Lua script that answers 0 when the invoice is
 * no longer a draft, else INCRs the tenant's sequence and writes status finalized and the number on
 * the invoice, so two finalizes never share a number and one invoice is never finalized twice.
 */
import Redis from 'ioredis';

export const CLAIM_LUA = \`
if redis.call('HGET', KEYS[1], 'status') ~= 'draft' then return 0 end
local n = redis.call('INCR', KEYS[2])
redis.call('HSET', KEYS[1], 'status', 'finalized', 'number', n)
return n
\`;

interface ClaimRedis extends Redis {
  claim(invoiceKey: string, seqKey: string): Promise<number>;
}

const redis = new Redis({host: 'redis', port: 6379}) as ClaimRedis;
redis.defineCommand('claim', {numberOfKeys: 2, lua: CLAIM_LUA});

export const seqKey = (tenant: string): string => \`invoice:seq:\${tenant}\`;

/** The invoice's number, claimed and written with status finalized; null when it is no longer a draft. */
export async function claimNumber(tenant: string, invoiceId: string): Promise<number | null> {
  const n = Number(await redis.claim(\`invoice:\${invoiceId}\`, seqKey(tenant)));
  return n > 0 ? n : null;
}
`,
};

export const supportModulesGo: Record<string, string> = {
  'invoice/store/store.go': `// Package store is the invoice store (provided): every invoice is a Redis hash invoice:{id} with
// id, tenant_id, customer_id, currency, jurisdiction, status (draft or finalized), number ("" until
// finalized), line_items (a JSON list of {description, quantity, unit_price_cents}),
// subtotal_cents, tax_cents and tax_source ("" until a quote is recorded), internal_notes, and
// hold_reason/hold_attempts (a tax hold, "" when there is none). Ids come from INCR invoice:ids.
// invoice:finalize:{tenant}:{key} is the recorded result of a finalize request; invoice:outbox the
// list of events the broker did not take. An Invoice has Number 0 until finalized, TaxSource ""
// until a quote is recorded, HoldReason "" when it is not held.
package store

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strconv"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// OutboxKey lists the events the broker did not take.
const OutboxKey = "invoice:outbox"

// Line is one line item.
type Line struct {
	Description    string \`json:"description"\`
	Quantity       int64  \`json:"quantity"\`
	UnitPriceCents int64  \`json:"unit_price_cents"\`
}

// Invoice is one stored invoice.
type Invoice struct {
	ID            string \`json:"id"\`
	TenantID      string \`json:"tenant_id"\`
	CustomerID    string \`json:"customer_id"\`
	Currency      string \`json:"currency"\`
	Jurisdiction  string \`json:"jurisdiction"\`
	Status        string \`json:"status"\`
	Number        int64  \`json:"number"\`
	LineItems     []Line \`json:"line_items"\`
	SubtotalCents int64  \`json:"subtotal_cents"\`
	TaxCents      int64  \`json:"tax_cents"\`
	TaxSource     string \`json:"tax_source"\`
	InternalNotes string \`json:"internal_notes"\`
	HoldReason    string \`json:"hold_reason"\`
	HoldAttempts  int    \`json:"hold_attempts"\`
}

// InvoiceKey is the hash of one invoice.
func InvoiceKey(invoiceID string) string { return "invoice:" + invoiceID }

// Subtotal is the sum of quantity x unit_price_cents, in minor units.
func Subtotal(lines []Line) int64 {
	var sum int64
	for _, line := range lines {
		sum += line.Quantity * line.UnitPriceCents
	}
	return sum
}

// LineDigest is the SHA-256 (hex) of "description|quantity|unit_price_cents": it proves a line
// without carrying its text.
func LineDigest(line Line) string {
	sum := sha256.Sum256([]byte(fmt.Sprintf("%s|%d|%d", line.Description, line.Quantity, line.UnitPriceCents)))
	return hex.EncodeToString(sum[:])
}

func toInvoice(raw map[string]string) *Invoice {
	if len(raw) == 0 {
		return nil
	}
	number, _ := strconv.ParseInt(raw["number"], 10, 64)
	subtotal, _ := strconv.ParseInt(raw["subtotal_cents"], 10, 64)
	tax, _ := strconv.ParseInt(raw["tax_cents"], 10, 64)
	attempts, _ := strconv.Atoi(raw["hold_attempts"])
	lines := []Line{}
	if raw["line_items"] != "" {
		json.Unmarshal([]byte(raw["line_items"]), &lines)
	}
	return &Invoice{
		ID: raw["id"], TenantID: raw["tenant_id"], CustomerID: raw["customer_id"], Currency: raw["currency"],
		Jurisdiction: raw["jurisdiction"], Status: raw["status"], Number: number, LineItems: lines,
		SubtotalCents: subtotal, TaxCents: tax, TaxSource: raw["tax_source"], InternalNotes: raw["internal_notes"],
		HoldReason: raw["hold_reason"], HoldAttempts: attempts,
	}
}

// Get is the invoice, or nil.
func Get(ctx context.Context, invoiceID string) *Invoice {
	return toInvoice(rdb.HGetAll(ctx, InvoiceKey(invoiceID)).Val())
}

// Create makes a new draft of the tenant's and returns it.
func Create(ctx context.Context, tenant, currency string, lines []Line, customerID, jurisdiction, internalNotes string) *Invoice {
	invoiceID := fmt.Sprintf("inv-%d", rdb.Incr(ctx, "invoice:ids").Val())
	if lines == nil {
		lines = []Line{}
	}
	raw, _ := json.Marshal(lines)
	rdb.HSet(ctx, InvoiceKey(invoiceID), map[string]any{
		"id": invoiceID, "tenant_id": tenant, "customer_id": customerID, "currency": currency,
		"jurisdiction": jurisdiction, "status": "draft", "number": "", "line_items": string(raw),
		"subtotal_cents": strconv.FormatInt(Subtotal(lines), 10), "tax_cents": "", "tax_source": "",
		"internal_notes": internalNotes, "hold_reason": "", "hold_attempts": "",
	})
	return Get(ctx, invoiceID)
}

// ReplaceLines rewrites the line items and the subtotal in place, whatever the invoice's status
// (the bulk importer's writer).
func ReplaceLines(ctx context.Context, invoiceID string, lines []Line) *Invoice {
	if lines == nil {
		lines = []Line{}
	}
	raw, _ := json.Marshal(lines)
	rdb.HSet(ctx, InvoiceKey(invoiceID), map[string]any{"line_items": string(raw), "subtotal_cents": strconv.FormatInt(Subtotal(lines), 10)})
	return Get(ctx, invoiceID)
}

// Reopen puts the invoice back to draft and clears its number (the support console's undo).
func Reopen(ctx context.Context, invoiceID string) {
	rdb.HSet(ctx, InvoiceKey(invoiceID), map[string]any{"status": "draft", "number": ""})
}

// SetTax records the quoted tax and where it came from; it clears a tax hold.
func SetTax(ctx context.Context, invoiceID string, taxCents int64, taxSource string) {
	rdb.HSet(ctx, InvoiceKey(invoiceID), map[string]any{"tax_cents": strconv.FormatInt(taxCents, 10), "tax_source": taxSource, "hold_reason": "", "hold_attempts": ""})
}

// Hold marks the draft held for tax: why (the last status, e.g. "unavailable") and after how many attempts.
func Hold(ctx context.Context, invoiceID, reason string, attempts int) {
	rdb.HSet(ctx, InvoiceKey(invoiceID), map[string]any{"hold_reason": reason, "hold_attempts": strconv.Itoa(attempts)})
}

// FinalizeResult is the result recorded for the finalize request (tenant, Idempotency-Key), if any.
func FinalizeResult(ctx context.Context, tenant, key string) map[string]any {
	raw, err := rdb.Get(ctx, "invoice:finalize:"+tenant+":"+key).Result()
	if err != nil {
		return nil
	}
	var result map[string]any
	json.Unmarshal([]byte(raw), &result)
	return result
}

// RecordFinalize records what the finalize request (tenant, key) answered, for its replays.
func RecordFinalize(ctx context.Context, tenant, key string, result map[string]any) {
	raw, _ := json.Marshal(result)
	rdb.Set(ctx, "invoice:finalize:"+tenant+":"+key, string(raw), 0)
}

// OutboxAdd keeps an event the broker did not take, for the relay to produce again.
func OutboxAdd(ctx context.Context, payload map[string]any) {
	raw, _ := json.Marshal(payload)
	rdb.RPush(ctx, OutboxKey, string(raw))
}

// Outbox is the events waiting in the outbox, oldest first.
func Outbox(ctx context.Context) []map[string]any {
	out := []map[string]any{}
	for _, raw := range rdb.LRange(ctx, OutboxKey, 0, -1).Val() {
		var payload map[string]any
		json.Unmarshal([]byte(raw), &payload)
		out = append(out, payload)
	}
	return out
}
`,
  'invoice/sequence/sequence.go': `// Package sequence is the finalize claim (provided; step 2 builds the same function):
// invoice:seq:{tenant} is the tenant's last issued number. ClaimNumber runs one Lua script that
// answers 0 when the invoice is no longer a draft, else INCRs the tenant's sequence and writes
// status finalized and the number on the invoice, so two finalizes never share a number and one
// invoice is never finalized twice.
package sequence

import (
	"context"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// Claim refuses a non-draft (0), else takes the tenant's next number and finalizes the invoice.
var Claim = redis.NewScript(\`
if redis.call('HGET', KEYS[1], 'status') ~= 'draft' then return 0 end
local n = redis.call('INCR', KEYS[2])
redis.call('HSET', KEYS[1], 'status', 'finalized', 'number', n)
return n
\`)

// SeqKey holds the tenant's last issued number.
func SeqKey(tenant string) string { return "invoice:seq:" + tenant }

// ClaimNumber is the invoice's number, claimed and written with status finalized; 0 when it is no
// longer a draft.
func ClaimNumber(ctx context.Context, tenant, invoiceID string) (int64, error) {
	return Claim.Run(ctx, rdb, []string{"invoice:" + invoiceID, SeqKey(tenant)}).Int64()
}
`,
};

export const supportModulesCpp: Record<string, string> = {
  'invoice/store.h': `// The invoice store (provided): every invoice is a Redis hash invoice:{id} with id, tenant_id,
// customer_id, currency, jurisdiction, status (draft or finalized), number ("" until finalized),
// line_items (a JSON list of {description, quantity, unit_price_cents}), subtotal_cents, tax_cents
// and tax_source ("" until a quote is recorded), internal_notes, and hold_reason/hold_attempts (a
// tax hold, "" when there is none). Ids come from INCR invoice:ids. invoice:finalize:{tenant}:{key}
// is the recorded result of a finalize request; invoice:outbox the list of events the broker did
// not take. An Invoice has number 0 until finalized, tax_source "" until a quote is recorded,
// hold_reason "" when it is not held.
#pragma once

#include <nlohmann/json.hpp>
#include <openssl/sha.h>
#include <sw/redis++/redis++.h>

#include <cstdio>
#include <optional>
#include <string>
#include <unordered_map>
#include <vector>

namespace store {

inline const std::string kOutboxKey = "invoice:outbox";

struct Line {
  std::string description;
  long quantity = 0;
  long unit_price_cents = 0;
};

struct Invoice {
  std::string id;
  std::string tenant_id;
  std::string customer_id;
  std::string currency;
  std::string jurisdiction;
  std::string status;
  long number = 0;
  std::vector<Line> line_items;
  long subtotal_cents = 0;
  long tax_cents = 0;
  std::string tax_source;
  std::string internal_notes;
  std::string hold_reason;
  long hold_attempts = 0;
};

inline sw::redis::Redis& redis() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

inline std::string invoiceKey(const std::string& invoice_id) { return "invoice:" + invoice_id; }

// The sum of quantity x unit_price_cents, in minor units.
inline long subtotal(const std::vector<Line>& lines) {
  long sum = 0;
  for (const Line& line : lines) sum += line.quantity * line.unit_price_cents;
  return sum;
}

// SHA-256 (hex) of "description|quantity|unit_price_cents": proves a line without carrying its text.
inline std::string lineDigest(const Line& line) {
  const std::string text = line.description + "|" + std::to_string(line.quantity) + "|" + std::to_string(line.unit_price_cents);
  unsigned char digest[SHA256_DIGEST_LENGTH];
  SHA256(reinterpret_cast<const unsigned char*>(text.data()), text.size(), digest);
  std::string hex;
  char byte[3];
  for (unsigned char c : digest) {
    std::snprintf(byte, sizeof byte, "%02x", c);
    hex += byte;
  }
  return hex;
}

// A line as JSON, and back.
inline nlohmann::json lineJson(const Line& line) {
  return nlohmann::json{{"description", line.description}, {"quantity", line.quantity}, {"unit_price_cents", line.unit_price_cents}};
}

inline Line lineOf(const nlohmann::json& j) {
  return Line{j.value("description", std::string()), j.value("quantity", 0L), j.value("unit_price_cents", 0L)};
}

inline nlohmann::json linesJson(const std::vector<Line>& lines) {
  nlohmann::json out = nlohmann::json::array();
  for (const Line& line : lines) out.push_back(lineJson(line));
  return out;
}

inline std::optional<Invoice> get(const std::string& invoice_id) {
  const std::unordered_map<std::string, std::string> raw = redis().hgetall(invoiceKey(invoice_id));
  if (raw.empty()) return std::nullopt;
  const auto text = [&raw](const char* name) { return raw.count(name) ? raw.at(name) : std::string(); };
  const auto number = [&text](const char* name) { return text(name).empty() ? 0L : std::stol(text(name)); };
  Invoice invoice;
  invoice.id = text("id");
  invoice.tenant_id = text("tenant_id");
  invoice.customer_id = text("customer_id");
  invoice.currency = text("currency");
  invoice.jurisdiction = text("jurisdiction");
  invoice.status = text("status");
  invoice.number = number("number");
  if (!text("line_items").empty()) {
    for (const auto& j : nlohmann::json::parse(text("line_items"))) invoice.line_items.push_back(lineOf(j));
  }
  invoice.subtotal_cents = number("subtotal_cents");
  invoice.tax_cents = number("tax_cents");
  invoice.tax_source = text("tax_source");
  invoice.internal_notes = text("internal_notes");
  invoice.hold_reason = text("hold_reason");
  invoice.hold_attempts = number("hold_attempts");
  return invoice;
}

// A new draft of the tenant's; returns it.
inline Invoice create(const std::string& tenant, const std::string& currency, const std::vector<Line>& lines,
                      const std::string& customer_id = "", const std::string& jurisdiction = "", const std::string& internal_notes = "") {
  const std::string invoice_id = "inv-" + std::to_string(redis().incr("invoice:ids"));
  redis().hset(invoiceKey(invoice_id), {{"id", invoice_id}, {"tenant_id", tenant}, {"customer_id", customer_id},
                                        {"currency", currency}, {"jurisdiction", jurisdiction}, {"status", "draft"},
                                        {"number", ""}, {"line_items", linesJson(lines).dump()},
                                        {"subtotal_cents", std::to_string(subtotal(lines))}, {"tax_cents", ""},
                                        {"tax_source", ""}, {"internal_notes", internal_notes}, {"hold_reason", ""},
                                        {"hold_attempts", ""}});
  return *store::get(invoice_id);
}

// Rewrites the line items and the subtotal in place, whatever the invoice's status (the bulk
// importer's writer).
inline Invoice replaceLines(const std::string& invoice_id, const std::vector<Line>& lines) {
  redis().hset(invoiceKey(invoice_id), {{"line_items", linesJson(lines).dump()}, {"subtotal_cents", std::to_string(subtotal(lines))}});
  return *store::get(invoice_id);
}

// Puts the invoice back to draft and clears its number (the support console's undo).
inline void reopen(const std::string& invoice_id) { redis().hset(invoiceKey(invoice_id), {{"status", "draft"}, {"number", ""}}); }

// Records the quoted tax and where it came from; clears a tax hold.
inline void setTax(const std::string& invoice_id, long tax_cents, const std::string& tax_source) {
  redis().hset(invoiceKey(invoice_id), {{"tax_cents", std::to_string(tax_cents)}, {"tax_source", tax_source}, {"hold_reason", ""}, {"hold_attempts", ""}});
}

// Marks the draft held for tax: why (the last status, e.g. "unavailable") and after how many attempts.
inline void hold(const std::string& invoice_id, const std::string& reason, long attempts) {
  redis().hset(invoiceKey(invoice_id), {{"hold_reason", reason}, {"hold_attempts", std::to_string(attempts)}});
}

// The result recorded for the finalize request (tenant, Idempotency-Key), if any.
inline std::optional<nlohmann::json> finalizeResult(const std::string& tenant, const std::string& key) {
  const auto raw = redis().get("invoice:finalize:" + tenant + ":" + key);
  if (!raw) return std::nullopt;
  return nlohmann::json::parse(*raw);
}

// Record what the finalize request (tenant, key) answered, for its replays.
inline void recordFinalize(const std::string& tenant, const std::string& key, const nlohmann::json& result) {
  redis().set("invoice:finalize:" + tenant + ":" + key, result.dump());
}

// Keep an event the broker did not take, for the relay to produce again.
inline void outboxAdd(const nlohmann::json& payload) { redis().rpush(kOutboxKey, payload.dump()); }

// The events waiting in the outbox, oldest first.
inline std::vector<nlohmann::json> outbox() {
  std::vector<nlohmann::json> out;
  for (const std::string& raw : redis().lrange(kOutboxKey, 0, -1)) out.push_back(nlohmann::json::parse(raw));
  return out;
}

}  // namespace store
`,
  'invoice/sequence.h': `// The finalize claim (provided; step 2 builds the same function): invoice:seq:{tenant} is the
// tenant's last issued number. claimNumber runs one Lua script that answers 0 when the invoice is
// no longer a draft, else INCRs the tenant's sequence and writes status finalized and the number on
// the invoice, so two finalizes never share a number and one invoice is never finalized twice.
#pragma once

#include <sw/redis++/redis++.h>

#include <string>

namespace sequence {

inline const std::string kClaimLua = R"lua(
if redis.call('HGET', KEYS[1], 'status') ~= 'draft' then return 0 end
local n = redis.call('INCR', KEYS[2])
redis.call('HSET', KEYS[1], 'status', 'finalized', 'number', n)
return n
)lua";

inline sw::redis::Redis& redis() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

inline std::string seqKey(const std::string& tenant) { return "invoice:seq:" + tenant; }

// The invoice's number, claimed and written with status finalized; 0 when it is no longer a draft.
inline long claimNumber(const std::string& tenant, const std::string& invoice_id) {
  return static_cast<long>(redis().eval<long long>(kClaimLua, {"invoice:" + invoice_id, seqKey(tenant)}, {}));
}

}  // namespace sequence
`,
};

export const supportModulesScala: Record<string, string> = {
  [scalaPath('invoice', 'Store')]: `package invoice

import java.nio.charset.StandardCharsets
import java.security.MessageDigest

import redis.clients.jedis.JedisPooled
import spray.json._

import scala.jdk.CollectionConverters._

/**
 * The invoice store (provided): every invoice is a Redis hash invoice:{id} with id, tenant_id,
 * customer_id, currency, jurisdiction, status (draft or finalized), number ("" until finalized),
 * line_items (a JSON list of {description, quantity, unit_price_cents}), subtotal_cents, tax_cents
 * and tax_source ("" until a quote is recorded), internal_notes, and hold_reason/hold_attempts (a
 * tax hold, "" when there is none). Ids come from INCR invoice:ids. invoice:finalize:{tenant}:{key}
 * is the recorded result of a finalize request; invoice:outbox the list of events the broker did
 * not take. An Invoice has number, taxCents and taxSource None until set, taxHold None unless held.
 */
object Store {
  final case class Line(description: String, quantity: Long, unitPriceCents: Long)
  final case class TaxHold(reason: String, attempts: Int)
  final case class Invoice(
      id: String,
      tenantId: String,
      customerId: String,
      currency: String,
      jurisdiction: String,
      status: String,
      number: Option[Long],
      lineItems: Seq[Line],
      subtotalCents: Long,
      taxCents: Option[Long],
      taxSource: Option[String],
      internalNotes: String,
      taxHold: Option[TaxHold])

  val OutboxKey = "invoice:outbox"

  val jedis = new JedisPooled("redis", 6379)

  def invoiceKey(invoiceId: String): String = s"invoice:$invoiceId"

  /** The sum of quantity x unit_price_cents, in minor units. */
  def subtotal(lines: Seq[Line]): Long = lines.map(line => line.quantity * line.unitPriceCents).sum

  /** SHA-256 (hex) of "description|quantity|unit_price_cents": proves a line without carrying its text. */
  def lineDigest(line: Line): String =
    MessageDigest
      .getInstance("SHA-256")
      .digest(s"\${line.description}|\${line.quantity}|\${line.unitPriceCents}".getBytes(StandardCharsets.UTF_8))
      .map(b => f"\${b & 0xff}%02x")
      .mkString

  def lineJson(line: Line): JsObject =
    JsObject("description" -> JsString(line.description), "quantity" -> JsNumber(line.quantity), "unit_price_cents" -> JsNumber(line.unitPriceCents))

  def linesJson(lines: Seq[Line]): JsArray = JsArray(lines.map(lineJson).toVector)

  def lineOf(value: JsValue): Line = {
    val fields = value.asJsObject.fields
    Line(
      fields.get("description").collect { case JsString(s) => s }.getOrElse(""),
      fields.get("quantity").collect { case JsNumber(n) => n.toLong }.getOrElse(0L),
      fields.get("unit_price_cents").collect { case JsNumber(n) => n.toLong }.getOrElse(0L))
  }

  private def invoice(raw: Map[String, String]): Option[Invoice] =
    if (raw.isEmpty) None
    else {
      def text(name: String): String = raw.getOrElse(name, "")
      def long(name: String): Option[Long] = raw.get(name).filter(_.nonEmpty).map(_.toLong)
      val lines = if (text("line_items").isEmpty) Seq.empty else text("line_items").parseJson.asInstanceOf[JsArray].elements.map(lineOf)
      Some(Invoice(
        text("id"), text("tenant_id"), text("customer_id"), text("currency"), text("jurisdiction"), text("status"),
        long("number"), lines, long("subtotal_cents").getOrElse(0L), long("tax_cents"), raw.get("tax_source").filter(_.nonEmpty),
        text("internal_notes"), raw.get("hold_reason").filter(_.nonEmpty).map(reason => TaxHold(reason, long("hold_attempts").getOrElse(0L).toInt))))
    }

  /** The invoice, if it exists. */
  def get(invoiceId: String): Option[Invoice] = invoice(jedis.hgetAll(invoiceKey(invoiceId)).asScala.toMap)

  /** A new draft of the tenant's; returns it. */
  def create(tenant: String, currency: String, lines: Seq[Line], customerId: String = "", jurisdiction: String = "", internalNotes: String = ""): Invoice = {
    val invoiceId = s"inv-\${jedis.incr("invoice:ids")}"
    jedis.hset(invoiceKey(invoiceId), Map(
      "id" -> invoiceId, "tenant_id" -> tenant, "customer_id" -> customerId, "currency" -> currency,
      "jurisdiction" -> jurisdiction, "status" -> "draft", "number" -> "", "line_items" -> linesJson(lines).compactPrint,
      "subtotal_cents" -> subtotal(lines).toString, "tax_cents" -> "", "tax_source" -> "", "internal_notes" -> internalNotes,
      "hold_reason" -> "", "hold_attempts" -> "").asJava)
    get(invoiceId).get
  }

  /** Rewrites the line items and the subtotal in place, whatever the invoice's status (the bulk importer's writer). */
  def replaceLines(invoiceId: String, lines: Seq[Line]): Invoice = {
    jedis.hset(invoiceKey(invoiceId), Map("line_items" -> linesJson(lines).compactPrint, "subtotal_cents" -> subtotal(lines).toString).asJava)
    get(invoiceId).get
  }

  /** Puts the invoice back to draft and clears its number (the support console's undo). */
  def reopen(invoiceId: String): Unit = jedis.hset(invoiceKey(invoiceId), Map("status" -> "draft", "number" -> "").asJava)

  /** Records the quoted tax and where it came from; clears a tax hold. */
  def setTax(invoiceId: String, taxCents: Long, taxSource: String): Unit =
    jedis.hset(invoiceKey(invoiceId), Map("tax_cents" -> taxCents.toString, "tax_source" -> taxSource, "hold_reason" -> "", "hold_attempts" -> "").asJava)

  /** Marks the draft held for tax: why (the last status, e.g. "unavailable") and after how many attempts. */
  def hold(invoiceId: String, reason: String, attempts: Int): Unit =
    jedis.hset(invoiceKey(invoiceId), Map("hold_reason" -> reason, "hold_attempts" -> attempts.toString).asJava)

  /** The result recorded for the finalize request (tenant, Idempotency-Key), if any. */
  def finalizeResult(tenant: String, key: String): Option[JsObject] =
    Option(jedis.get(s"invoice:finalize:$tenant:$key")).map(_.parseJson.asJsObject)

  /** Record what the finalize request (tenant, key) answered, for its replays. */
  def recordFinalize(tenant: String, key: String, result: JsObject): Unit = jedis.set(s"invoice:finalize:$tenant:$key", result.compactPrint)

  /** Keep an event the broker did not take, for the relay to produce again. */
  def outboxAdd(payload: JsObject): Unit = jedis.rpush(OutboxKey, payload.compactPrint)

  /** The events waiting in the outbox, oldest first. */
  def outbox(): Seq[JsObject] = jedis.lrange(OutboxKey, 0, -1).asScala.toSeq.map(_.parseJson.asJsObject)
}
`,
  [scalaPath('invoice', 'Sequence')]: `package invoice

import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

/**
 * The finalize claim (provided; step 2 builds the same function): invoice:seq:{tenant} is the
 * tenant's last issued number. claimNumber runs one Lua script that answers 0 when the invoice is
 * no longer a draft, else INCRs the tenant's sequence and writes status finalized and the number on
 * the invoice, so two finalizes never share a number and one invoice is never finalized twice.
 */
object Sequence {
  val jedis = new JedisPooled("redis", 6379)

  val ClaimLua: String =
    """if redis.call('HGET', KEYS[1], 'status') ~= 'draft' then return 0 end
      |local n = redis.call('INCR', KEYS[2])
      |redis.call('HSET', KEYS[1], 'status', 'finalized', 'number', n)
      |return n
      |""".stripMargin

  def seqKey(tenant: String): String = s"invoice:seq:$tenant"

  /** The invoice's number, claimed and written with status finalized; None when it is no longer a draft. */
  def claimNumber(tenant: String, invoiceId: String): Option[Long] = {
    val n = jedis.eval(ClaimLua, List(s"invoice:$invoiceId", seqKey(tenant)).asJava, List.empty[String].asJava).asInstanceOf[java.lang.Long].longValue
    if (n > 0) Some(n) else None
  }
}
`,
};
