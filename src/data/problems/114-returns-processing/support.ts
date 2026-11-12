/**
 * Hand-written support modules the returns-processing steps import but no step builds: the
 * `returns` package. `returns.store` is the returns store (Redis hashes standing in for the order
 * and returns databases): delivered order lines, return records, the refund processor's records,
 * the outbox, and the UTC calendar days the return window is measured in. `returns.ledger` is the
 * returnable-quantity ledger of step 2 as the other steps use it: `remaining`, `register_return`
 * (one Lua script that checks, decrements and records) and `cancel_return`. The five languages keep
 * the same keys, so a harness reads one layout whatever the stack.
 */
import {scalaPath} from '../scala-support';

export const supportModules: Record<string, string> = {
  'returns/__init__.py': '',
  'returns/store.py': `"""
The returns store (provided): Redis hashes standing in for the order and returns databases.
order_line:{id} is a delivered order line (order_line_id, tenant, sku, ordered_quantity,
unit_price_cents, delivered_at as YYYY-MM-DD, policy_window "standard" or "extended");
return:{id} a return (return_id, tenant, order_line_id, quantity, reason_code, photo_ref, state,
grade, refund_cents, refund_id; an unset field is ""); refund:{id} the refund processor's record
(refund_id, return_id, amount_cents, state "initiated", "confirmed" or "failed"); outbox a list of
JSON rows {topic, key, payload} a relay republishes. line:{id}:returnable belongs to returns.ledger.
Days are UTC calendar days as YYYY-MM-DD, so they compare as strings.
"""
import json
from datetime import date, datetime, timedelta, timezone

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

RETURN_FIELDS = ("return_id", "tenant", "order_line_id", "quantity", "reason_code", "photo_ref", "state", "grade", "refund_cents", "refund_id")


def line_of(order_line_id: str) -> dict | None:
    """The delivered order line, or None; ordered_quantity and unit_price_cents are ints."""
    raw = r.hgetall(f"order_line:{order_line_id}")
    if not raw:
        return None
    return {**raw, "ordered_quantity": int(raw["ordered_quantity"]), "unit_price_cents": int(raw["unit_price_cents"])}


def put_line(line: dict) -> None:
    """What the order service writes when a line is delivered: the line, and its returnable units (the ordered quantity)."""
    r.hset(f"order_line:{line['order_line_id']}", mapping={name: str(value) for name, value in line.items()})
    r.set(f"line:{line['order_line_id']}:returnable", line["ordered_quantity"])


def new_return_id() -> str:
    return f"ret-{r.incr('return:seq')}"


def return_of(return_id: str) -> dict | None:
    """The return, or None; quantity and refund_cents are ints, an unset field is ""."""
    raw = r.hgetall(f"return:{return_id}")
    if not raw:
        return None
    row = {name: raw.get(name, "") for name in RETURN_FIELDS}
    row["quantity"] = int(row["quantity"] or 0)
    row["refund_cents"] = int(row["refund_cents"] or 0)
    return row


def update_return(return_id: str, fields: dict) -> None:
    """Write fields (state, grade, refund_cents, refund_id, …) into the return's record."""
    r.hset(f"return:{return_id}", mapping={name: str(value) for name, value in fields.items()})


def refund_of(refund_id: str) -> dict | None:
    """The refund processor's record of the refund, or None; amount_cents is an int."""
    raw = r.hgetall(f"refund:{refund_id}")
    if not raw:
        return None
    return {"refund_id": raw["refund_id"], "return_id": raw.get("return_id", ""), "amount_cents": int(raw.get("amount_cents") or 0), "state": raw.get("state", "")}


def put_refund(refund: dict) -> None:
    """What the refund processor writes as a refund moves from initiated to confirmed or failed."""
    r.hset(f"refund:{refund['refund_id']}", mapping={name: str(value) for name, value in refund.items()})


def insert_outbox(topic: str, key: str, payload: dict) -> None:
    """A row the relay republishes once the broker takes records again."""
    r.rpush("outbox", json.dumps({"topic": topic, "key": key, "payload": payload}))


def today() -> str:
    """Today, the UTC calendar day."""
    return datetime.now(timezone.utc).date().isoformat()


def add_days(day: str, days: int) -> str:
    """The calendar day days after day (before it when days is negative)."""
    return (date.fromisoformat(day) + timedelta(days=days)).isoformat()
`,
  'returns/ledger.py': `"""
The returnable quantities (provided; step 2 builds the same three functions). line:{id}:returnable
holds the units of an order line still returnable, set to the ordered quantity at delivery.
register_return checks the quantity against it, decrements it and writes the return record
return:{id} (return_id, order_line_id, quantity, state "registered", plus the given fields: tenant,
reason_code, photo_ref) in one Lua script, and reports whether the return was registered.
cancel_return gives a registered return's own quantity back and marks it canceled, once, and
reports the units restored.
"""
import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

REGISTER_LUA = """
local left = tonumber(redis.call('GET', KEYS[1]) or '0')
local quantity = tonumber(ARGV[1])
if quantity > left then return 0 end
redis.call('DECRBY', KEYS[1], quantity)
redis.call('HSET', KEYS[2], 'return_id', ARGV[2], 'order_line_id', ARGV[3], 'quantity', ARGV[1], 'state', 'registered')
for i = 4, #ARGV, 2 do
  redis.call('HSET', KEYS[2], ARGV[i], ARGV[i + 1])
end
return 1
"""

CANCEL_LUA = """
if redis.call('HGET', KEYS[2], 'state') ~= 'registered' then return 0 end
local quantity = tonumber(redis.call('HGET', KEYS[2], 'quantity'))
redis.call('INCRBY', KEYS[1], quantity)
redis.call('HSET', KEYS[2], 'state', 'canceled')
return quantity
"""

register = r.register_script(REGISTER_LUA)
cancel = r.register_script(CANCEL_LUA)


def counter_key(order_line_id: str) -> str:
    return f"line:{order_line_id}:returnable"


def record_key(return_id: str) -> str:
    return f"return:{return_id}"


def remaining(order_line_id: str) -> int:
    """The units of the line still returnable."""
    return int(r.get(counter_key(order_line_id)) or 0)


def register_return(order_line_id: str, return_id: str, quantity: int, fields: dict) -> bool:
    """Take quantity units off the line and record the return, or nothing when fewer remain."""
    args = [quantity, return_id, order_line_id]
    for name, value in fields.items():
        args += [name, value]
    return register(keys=[counter_key(order_line_id), record_key(return_id)], args=args) == 1


def cancel_return(order_line_id: str, return_id: str) -> int:
    """Give the return's own quantity back to the line, once; the units restored."""
    return int(cancel(keys=[counter_key(order_line_id), record_key(return_id)], args=[]))
`,
};

export const supportModulesTs: Record<string, string> = {
  'returns/store.ts': `/**
 * The returns store (provided): Redis hashes standing in for the order and returns databases.
 * order_line:{id} is a delivered order line (order_line_id, tenant, sku, ordered_quantity,
 * unit_price_cents, delivered_at as YYYY-MM-DD, policy_window "standard" or "extended");
 * return:{id} a return (return_id, tenant, order_line_id, quantity, reason_code, photo_ref, state,
 * grade, refund_cents, refund_id; an unset field is ""); refund:{id} the refund processor's record
 * (refund_id, return_id, amount_cents, state "initiated", "confirmed" or "failed"); outbox a list
 * of JSON rows {topic, key, payload} a relay republishes. line:{id}:returnable belongs to
 * returns/ledger. Days are UTC calendar days as YYYY-MM-DD, so they compare as strings.
 */
import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

export interface OrderLine {
  order_line_id: string;
  tenant: string;
  sku: string;
  ordered_quantity: number;
  unit_price_cents: number;
  delivered_at: string;
  policy_window: string;
}

export interface Return {
  return_id: string;
  tenant: string;
  order_line_id: string;
  quantity: number;
  reason_code: string;
  photo_ref: string;
  state: string;
  grade: string;
  refund_cents: number;
  refund_id: string;
}

export interface Refund {
  refund_id: string;
  return_id: string;
  amount_cents: number;
  state: string;
}

const strings = (fields: object): Record<string, string> =>
  Object.fromEntries(Object.entries(fields).map(([name, value]) => [name, String(value)]));

/** The delivered order line, or null. */
export async function lineOf(orderLineId: string): Promise<OrderLine | null> {
  const raw = await redis.hgetall(\`order_line:\${orderLineId}\`);
  if (Object.keys(raw).length === 0) return null;
  return {
    order_line_id: raw.order_line_id,
    tenant: raw.tenant,
    sku: raw.sku,
    ordered_quantity: Number(raw.ordered_quantity),
    unit_price_cents: Number(raw.unit_price_cents),
    delivered_at: raw.delivered_at,
    policy_window: raw.policy_window,
  };
}

/** What the order service writes when a line is delivered: the line, and its returnable units (the ordered quantity). */
export async function putLine(line: OrderLine): Promise<void> {
  await redis.hset(\`order_line:\${line.order_line_id}\`, strings(line));
  await redis.set(\`line:\${line.order_line_id}:returnable\`, String(line.ordered_quantity));
}

export async function newReturnId(): Promise<string> {
  return \`ret-\${await redis.incr('return:seq')}\`;
}

/** The return, or null; an unset field is "" (0 for a number). */
export async function returnOf(returnId: string): Promise<Return | null> {
  const raw = await redis.hgetall(\`return:\${returnId}\`);
  if (Object.keys(raw).length === 0) return null;
  const text = (name: string): string => raw[name] ?? '';
  return {
    return_id: text('return_id'),
    tenant: text('tenant'),
    order_line_id: text('order_line_id'),
    quantity: Number(text('quantity') || 0),
    reason_code: text('reason_code'),
    photo_ref: text('photo_ref'),
    state: text('state'),
    grade: text('grade'),
    refund_cents: Number(text('refund_cents') || 0),
    refund_id: text('refund_id'),
  };
}

/** Write fields (state, grade, refund_cents, refund_id, …) into the return's record. */
export async function updateReturn(returnId: string, fields: Record<string, string | number>): Promise<void> {
  await redis.hset(\`return:\${returnId}\`, strings(fields));
}

/** The refund processor's record of the refund, or null. */
export async function refundOf(refundId: string): Promise<Refund | null> {
  const raw = await redis.hgetall(\`refund:\${refundId}\`);
  if (Object.keys(raw).length === 0) return null;
  return {refund_id: raw.refund_id, return_id: raw.return_id ?? '', amount_cents: Number(raw.amount_cents ?? 0), state: raw.state ?? ''};
}

/** What the refund processor writes as a refund moves from initiated to confirmed or failed. */
export async function putRefund(refund: Refund): Promise<void> {
  await redis.hset(\`refund:\${refund.refund_id}\`, strings(refund));
}

/** A row the relay republishes once the broker takes records again. */
export async function insertOutbox(topic: string, key: string, payload: Record<string, unknown>): Promise<void> {
  await redis.rpush('outbox', JSON.stringify({topic, key, payload}));
}

/** Today, the UTC calendar day. */
export const today = (): string => new Date().toISOString().slice(0, 10);

/** The calendar day days after day (before it when days is negative). */
export const addDays = (day: string, days: number): string =>
  new Date(Date.parse(\`\${day}T00:00:00Z\`) + days * 86_400_000).toISOString().slice(0, 10);
`,
  'returns/ledger.ts': `/**
 * The returnable quantities (provided; step 2 builds the same three functions).
 * line:{id}:returnable holds the units of an order line still returnable, set to the ordered
 * quantity at delivery. registerReturn checks the quantity against it, decrements it and writes the
 * return record return:{id} (return_id, order_line_id, quantity, state "registered", plus the given
 * fields: tenant, reason_code, photo_ref) in one Lua script, and reports whether the return was
 * registered. cancelReturn gives a registered return's own quantity back and marks it canceled,
 * once, and reports the units restored.
 */
import Redis from 'ioredis';

export const REGISTER_LUA = \`
local left = tonumber(redis.call('GET', KEYS[1]) or '0')
local quantity = tonumber(ARGV[1])
if quantity > left then return 0 end
redis.call('DECRBY', KEYS[1], quantity)
redis.call('HSET', KEYS[2], 'return_id', ARGV[2], 'order_line_id', ARGV[3], 'quantity', ARGV[1], 'state', 'registered')
for i = 4, #ARGV, 2 do
  redis.call('HSET', KEYS[2], ARGV[i], ARGV[i + 1])
end
return 1
\`;

export const CANCEL_LUA = \`
if redis.call('HGET', KEYS[2], 'state') ~= 'registered' then return 0 end
local quantity = tonumber(redis.call('HGET', KEYS[2], 'quantity'))
redis.call('INCRBY', KEYS[1], quantity)
redis.call('HSET', KEYS[2], 'state', 'canceled')
return quantity
\`;

interface LedgerRedis extends Redis {
  registerScript(counter: string, record: string, ...args: (string | number)[]): Promise<number>;
  cancelScript(counter: string, record: string): Promise<number>;
}

const redis = new Redis({host: 'redis', port: 6379}) as LedgerRedis;
redis.defineCommand('registerScript', {numberOfKeys: 2, lua: REGISTER_LUA});
redis.defineCommand('cancelScript', {numberOfKeys: 2, lua: CANCEL_LUA});

export const counterKey = (orderLineId: string): string => \`line:\${orderLineId}:returnable\`;
export const recordKey = (returnId: string): string => \`return:\${returnId}\`;

/** The units of the line still returnable. */
export async function remaining(orderLineId: string): Promise<number> {
  return Number((await redis.get(counterKey(orderLineId))) ?? 0);
}

/** Take quantity units off the line and record the return, or nothing when fewer remain. */
export async function registerReturn(orderLineId: string, returnId: string, quantity: number, fields: Record<string, string>): Promise<boolean> {
  const pairs = Object.entries(fields).flat();
  return (await redis.registerScript(counterKey(orderLineId), recordKey(returnId), quantity, returnId, orderLineId, ...pairs)) === 1;
}

/** Give the return's own quantity back to the line, once; the units restored. */
export async function cancelReturn(orderLineId: string, returnId: string): Promise<number> {
  return Number(await redis.cancelScript(counterKey(orderLineId), recordKey(returnId)));
}
`,
};

export const supportModulesGo: Record<string, string> = {
  'returns/store/store.go': `// Package store is the returns store (provided): Redis hashes standing in for the order and
// returns databases. order_line:{id} is a delivered order line (order_line_id, tenant, sku,
// ordered_quantity, unit_price_cents, delivered_at as YYYY-MM-DD, policy_window "standard" or
// "extended"); return:{id} a return (return_id, tenant, order_line_id, quantity, reason_code,
// photo_ref, state, grade, refund_cents, refund_id; an unset field is ""); refund:{id} the refund
// processor's record (refund_id, return_id, amount_cents, state "initiated", "confirmed" or
// "failed"); outbox a list of JSON rows {topic, key, payload} a relay republishes.
// line:{id}:returnable belongs to returns/ledger. Days are UTC calendar days as YYYY-MM-DD, so they
// compare as strings.
package store

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// OrderLine is a delivered order line.
type OrderLine struct {
	OrderLineID     string
	Tenant          string
	SKU             string
	OrderedQuantity int64
	UnitPriceCents  int64
	DeliveredAt     string
	PolicyWindow    string
}

// Return is a return record; an unset field is "" (0 for a number).
type Return struct {
	ReturnID    string
	Tenant      string
	OrderLineID string
	Quantity    int64
	ReasonCode  string
	PhotoRef    string
	State       string
	Grade       string
	RefundCents int64
	RefundID    string
}

// Refund is the refund processor's record of a refund.
type Refund struct {
	RefundID    string
	ReturnID    string
	AmountCents int64
	State       string
}

func number(s string) int64 {
	n, _ := strconv.ParseInt(s, 10, 64)
	return n
}

// LineOf is the delivered order line, or nil.
func LineOf(ctx context.Context, orderLineID string) *OrderLine {
	raw := rdb.HGetAll(ctx, "order_line:"+orderLineID).Val()
	if len(raw) == 0 {
		return nil
	}
	return &OrderLine{
		OrderLineID: raw["order_line_id"], Tenant: raw["tenant"], SKU: raw["sku"],
		OrderedQuantity: number(raw["ordered_quantity"]), UnitPriceCents: number(raw["unit_price_cents"]),
		DeliveredAt: raw["delivered_at"], PolicyWindow: raw["policy_window"],
	}
}

// PutLine is what the order service writes when a line is delivered: the line, and its returnable
// units (the ordered quantity).
func PutLine(ctx context.Context, line OrderLine) {
	rdb.HSet(ctx, "order_line:"+line.OrderLineID, map[string]any{
		"order_line_id": line.OrderLineID, "tenant": line.Tenant, "sku": line.SKU,
		"ordered_quantity": line.OrderedQuantity, "unit_price_cents": line.UnitPriceCents,
		"delivered_at": line.DeliveredAt, "policy_window": line.PolicyWindow,
	})
	rdb.Set(ctx, "line:"+line.OrderLineID+":returnable", line.OrderedQuantity, 0)
}

// NewReturnID mints the next return id.
func NewReturnID(ctx context.Context) string {
	return fmt.Sprintf("ret-%d", rdb.Incr(ctx, "return:seq").Val())
}

// ReturnOf is the return, or nil.
func ReturnOf(ctx context.Context, returnID string) *Return {
	raw := rdb.HGetAll(ctx, "return:"+returnID).Val()
	if len(raw) == 0 {
		return nil
	}
	return &Return{
		ReturnID: raw["return_id"], Tenant: raw["tenant"], OrderLineID: raw["order_line_id"], Quantity: number(raw["quantity"]),
		ReasonCode: raw["reason_code"], PhotoRef: raw["photo_ref"], State: raw["state"], Grade: raw["grade"],
		RefundCents: number(raw["refund_cents"]), RefundID: raw["refund_id"],
	}
}

// UpdateReturn writes fields (state, grade, refund_cents, refund_id, …) into the return's record.
func UpdateReturn(ctx context.Context, returnID string, fields map[string]any) {
	rdb.HSet(ctx, "return:"+returnID, fields)
}

// RefundOf is the refund processor's record of the refund, or nil.
func RefundOf(ctx context.Context, refundID string) *Refund {
	raw := rdb.HGetAll(ctx, "refund:"+refundID).Val()
	if len(raw) == 0 {
		return nil
	}
	return &Refund{RefundID: raw["refund_id"], ReturnID: raw["return_id"], AmountCents: number(raw["amount_cents"]), State: raw["state"]}
}

// PutRefund is what the refund processor writes as a refund moves from initiated to confirmed or failed.
func PutRefund(ctx context.Context, refund Refund) {
	rdb.HSet(ctx, "refund:"+refund.RefundID, map[string]any{
		"refund_id": refund.RefundID, "return_id": refund.ReturnID, "amount_cents": refund.AmountCents, "state": refund.State,
	})
}

// InsertOutbox adds a row the relay republishes once the broker takes records again.
func InsertOutbox(ctx context.Context, topic, key string, payload map[string]any) error {
	row, err := json.Marshal(map[string]any{"topic": topic, "key": key, "payload": payload})
	if err != nil {
		return err
	}
	return rdb.RPush(ctx, "outbox", row).Err()
}

// Today is the UTC calendar day.
func Today() string { return time.Now().UTC().Format("2006-01-02") }

// AddDays is the calendar day days after day (before it when days is negative).
func AddDays(day string, days int) string {
	t, _ := time.Parse("2006-01-02", day)
	return t.AddDate(0, 0, days).Format("2006-01-02")
}
`,
  'returns/ledger/ledger.go': `// Package ledger is the returnable quantities (provided; step 2 builds the same three functions).
// line:{id}:returnable holds the units of an order line still returnable, set to the ordered
// quantity at delivery. RegisterReturn checks the quantity against it, decrements it and writes the
// return record return:{id} (return_id, order_line_id, quantity, state "registered", plus the given
// fields: tenant, reason_code, photo_ref) in one Lua script, and reports whether the return was
// registered. CancelReturn gives a registered return's own quantity back and marks it canceled,
// once, and reports the units restored.
package ledger

import (
	"context"
	"sort"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// Register checks, decrements and records in one script.
var Register = redis.NewScript(\`
local left = tonumber(redis.call('GET', KEYS[1]) or '0')
local quantity = tonumber(ARGV[1])
if quantity > left then return 0 end
redis.call('DECRBY', KEYS[1], quantity)
redis.call('HSET', KEYS[2], 'return_id', ARGV[2], 'order_line_id', ARGV[3], 'quantity', ARGV[1], 'state', 'registered')
for i = 4, #ARGV, 2 do
  redis.call('HSET', KEYS[2], ARGV[i], ARGV[i + 1])
end
return 1
\`)

// Cancel gives a registered return's quantity back and marks it canceled, once.
var Cancel = redis.NewScript(\`
if redis.call('HGET', KEYS[2], 'state') ~= 'registered' then return 0 end
local quantity = tonumber(redis.call('HGET', KEYS[2], 'quantity'))
redis.call('INCRBY', KEYS[1], quantity)
redis.call('HSET', KEYS[2], 'state', 'canceled')
return quantity
\`)

func counterKey(orderLineID string) string { return "line:" + orderLineID + ":returnable" }
func recordKey(returnID string) string     { return "return:" + returnID }

// Remaining is the units of the line still returnable.
func Remaining(ctx context.Context, orderLineID string) (int64, error) {
	n, err := rdb.Get(ctx, counterKey(orderLineID)).Int64()
	if err == redis.Nil {
		return 0, nil
	}
	return n, err
}

// RegisterReturn takes quantity units off the line and records the return, or does nothing when
// fewer remain.
func RegisterReturn(ctx context.Context, orderLineID, returnID string, quantity int64, fields map[string]string) (bool, error) {
	args := []any{quantity, returnID, orderLineID}
	names := make([]string, 0, len(fields))
	for name := range fields {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		args = append(args, name, fields[name])
	}
	n, err := Register.Run(ctx, rdb, []string{counterKey(orderLineID), recordKey(returnID)}, args...).Int64()
	return n == 1, err
}

// CancelReturn gives the return's own quantity back to the line, once; the units restored.
func CancelReturn(ctx context.Context, orderLineID, returnID string) (int64, error) {
	return Cancel.Run(ctx, rdb, []string{counterKey(orderLineID), recordKey(returnID)}).Int64()
}
`,
};

export const supportModulesCpp: Record<string, string> = {
  'returns/store.h': `// The returns store (provided): Redis hashes standing in for the order and returns databases.
// order_line:{id} is a delivered order line (order_line_id, tenant, sku, ordered_quantity,
// unit_price_cents, delivered_at as YYYY-MM-DD, policy_window "standard" or "extended");
// return:{id} a return (return_id, tenant, order_line_id, quantity, reason_code, photo_ref, state,
// grade, refund_cents, refund_id; an unset field is ""); refund:{id} the refund processor's record
// (refund_id, return_id, amount_cents, state "initiated", "confirmed" or "failed"); outbox a list
// of JSON rows {topic, key, payload} a relay republishes. line:{id}:returnable belongs to
// returns/ledger.h. Days are UTC calendar days as YYYY-MM-DD, so they compare as strings.
#pragma once

#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <chrono>
#include <cstdio>
#include <map>
#include <optional>
#include <string>
#include <unordered_map>

namespace store {

struct OrderLine {
  std::string order_line_id;
  std::string tenant;
  std::string sku;
  long long ordered_quantity = 0;
  long long unit_price_cents = 0;
  std::string delivered_at;
  std::string policy_window;
};

struct Return {
  std::string return_id;
  std::string tenant;
  std::string order_line_id;
  long long quantity = 0;
  std::string reason_code;
  std::string photo_ref;
  std::string state;
  std::string grade;
  long long refund_cents = 0;
  std::string refund_id;
};

struct Refund {
  std::string refund_id;
  std::string return_id;
  long long amount_cents = 0;
  std::string state;
};

inline sw::redis::Redis& redis() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

inline std::string field(const std::unordered_map<std::string, std::string>& raw, const char* name) {
  const auto it = raw.find(name);
  return it == raw.end() ? std::string() : it->second;
}

inline long long number(const std::string& text) { return text.empty() ? 0 : std::stoll(text); }

// The delivered order line, or none.
inline std::optional<OrderLine> lineOf(const std::string& order_line_id) {
  const auto raw = redis().hgetall("order_line:" + order_line_id);
  if (raw.empty()) return std::nullopt;
  return OrderLine{field(raw, "order_line_id"), field(raw, "tenant"), field(raw, "sku"), number(field(raw, "ordered_quantity")),
                   number(field(raw, "unit_price_cents")), field(raw, "delivered_at"), field(raw, "policy_window")};
}

// What the order service writes when a line is delivered: the line, and its returnable units (the
// ordered quantity).
inline void putLine(const OrderLine& line) {
  redis().hset("order_line:" + line.order_line_id, {{"order_line_id", line.order_line_id},
                                                    {"tenant", line.tenant},
                                                    {"sku", line.sku},
                                                    {"ordered_quantity", std::to_string(line.ordered_quantity)},
                                                    {"unit_price_cents", std::to_string(line.unit_price_cents)},
                                                    {"delivered_at", line.delivered_at},
                                                    {"policy_window", line.policy_window}});
  redis().set("line:" + line.order_line_id + ":returnable", std::to_string(line.ordered_quantity));
}

inline std::string newReturnId() { return "ret-" + std::to_string(redis().incr("return:seq")); }

// The return, or none; an unset field is "" (0 for a number).
inline std::optional<Return> returnOf(const std::string& return_id) {
  const auto raw = redis().hgetall("return:" + return_id);
  if (raw.empty()) return std::nullopt;
  return Return{field(raw, "return_id"),   field(raw, "tenant"),    field(raw, "order_line_id"),
                number(field(raw, "quantity")), field(raw, "reason_code"), field(raw, "photo_ref"),
                field(raw, "state"),       field(raw, "grade"),     number(field(raw, "refund_cents")),
                field(raw, "refund_id")};
}

// Write fields (state, grade, refund_cents, refund_id, …) into the return's record.
inline void updateReturn(const std::string& return_id, const std::map<std::string, std::string>& fields) {
  redis().hset("return:" + return_id, fields.begin(), fields.end());
}

// The refund processor's record of the refund, or none.
inline std::optional<Refund> refundOf(const std::string& refund_id) {
  const auto raw = redis().hgetall("refund:" + refund_id);
  if (raw.empty()) return std::nullopt;
  return Refund{field(raw, "refund_id"), field(raw, "return_id"), number(field(raw, "amount_cents")), field(raw, "state")};
}

// What the refund processor writes as a refund moves from initiated to confirmed or failed.
inline void putRefund(const Refund& refund) {
  redis().hset("refund:" + refund.refund_id, {{"refund_id", refund.refund_id},
                                              {"return_id", refund.return_id},
                                              {"amount_cents", std::to_string(refund.amount_cents)},
                                              {"state", refund.state}});
}

// A row the relay republishes once the broker takes records again.
inline void insertOutbox(const std::string& topic, const std::string& key, const nlohmann::json& payload) {
  redis().rpush("outbox", nlohmann::json{{"topic", topic}, {"key", key}, {"payload", payload}}.dump());
}

// Days since 1970-01-01 of a civil date, and back (proleptic Gregorian calendar).
inline long long daysFromCivil(long long y, unsigned m, unsigned d) {
  y -= m <= 2;
  const long long era = (y >= 0 ? y : y - 399) / 400;
  const unsigned yoe = static_cast<unsigned>(y - era * 400);
  const unsigned doy = (153 * (m > 2 ? m - 3 : m + 9) + 2) / 5 + d - 1;
  const unsigned doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
  return era * 146097 + static_cast<long long>(doe) - 719468;
}

inline std::string civilFromDays(long long z) {
  z += 719468;
  const long long era = (z >= 0 ? z : z - 146096) / 146097;
  const unsigned doe = static_cast<unsigned>(z - era * 146097);
  const unsigned yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
  const unsigned doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
  const unsigned mp = (5 * doy + 2) / 153;
  const unsigned d = doy - (153 * mp + 2) / 5 + 1;
  const unsigned m = mp < 10 ? mp + 3 : mp - 9;
  const long long y = static_cast<long long>(yoe) + era * 400 + (m <= 2);
  char out[16];
  std::snprintf(out, sizeof out, "%04lld-%02u-%02u", y, m, d);
  return out;
}

// Today, the UTC calendar day.
inline std::string today() {
  const long long secs =
      std::chrono::duration_cast<std::chrono::seconds>(std::chrono::system_clock::now().time_since_epoch()).count();
  return civilFromDays(secs >= 0 ? secs / 86400 : (secs - 86399) / 86400);
}

// The calendar day days after day (before it when days is negative).
inline std::string addDays(const std::string& day, long long days) {
  const long long y = std::stoll(day.substr(0, 4));
  const unsigned m = static_cast<unsigned>(std::stoul(day.substr(5, 2)));
  const unsigned d = static_cast<unsigned>(std::stoul(day.substr(8, 2)));
  return civilFromDays(daysFromCivil(y, m, d) + days);
}

}  // namespace store
`,
  'returns/ledger.h': `// The returnable quantities (provided; step 2 builds the same three functions).
// line:{id}:returnable holds the units of an order line still returnable, set to the ordered
// quantity at delivery. registerReturn checks the quantity against it, decrements it and writes the
// return record return:{id} (return_id, order_line_id, quantity, state "registered", plus the given
// fields: tenant, reason_code, photo_ref) in one Lua script, and reports whether the return was
// registered. cancelReturn gives a registered return's own quantity back and marks it canceled,
// once, and reports the units restored.
#pragma once

#include <sw/redis++/redis++.h>

#include <map>
#include <string>
#include <vector>

namespace ledger {

inline const std::string kRegisterLua = R"lua(
local left = tonumber(redis.call('GET', KEYS[1]) or '0')
local quantity = tonumber(ARGV[1])
if quantity > left then return 0 end
redis.call('DECRBY', KEYS[1], quantity)
redis.call('HSET', KEYS[2], 'return_id', ARGV[2], 'order_line_id', ARGV[3], 'quantity', ARGV[1], 'state', 'registered')
for i = 4, #ARGV, 2 do
  redis.call('HSET', KEYS[2], ARGV[i], ARGV[i + 1])
end
return 1
)lua";

inline const std::string kCancelLua = R"lua(
if redis.call('HGET', KEYS[2], 'state') ~= 'registered' then return 0 end
local quantity = tonumber(redis.call('HGET', KEYS[2], 'quantity'))
redis.call('INCRBY', KEYS[1], quantity)
redis.call('HSET', KEYS[2], 'state', 'canceled')
return quantity
)lua";

inline sw::redis::Redis& redis() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

inline std::string counterKey(const std::string& order_line_id) { return "line:" + order_line_id + ":returnable"; }
inline std::string recordKey(const std::string& return_id) { return "return:" + return_id; }

// The units of the line still returnable.
inline long long remaining(const std::string& order_line_id) {
  const auto value = redis().get(counterKey(order_line_id));
  return value ? std::stoll(*value) : 0;
}

// Take quantity units off the line and record the return, or nothing when fewer remain.
inline bool registerReturn(const std::string& order_line_id, const std::string& return_id, long long quantity,
                           const std::map<std::string, std::string>& fields) {
  const std::vector<std::string> keys = {counterKey(order_line_id), recordKey(return_id)};
  std::vector<std::string> args = {std::to_string(quantity), return_id, order_line_id};
  for (const auto& [name, value] : fields) {
    args.push_back(name);
    args.push_back(value);
  }
  return redis().eval<long long>(kRegisterLua, keys.begin(), keys.end(), args.begin(), args.end()) == 1;
}

// Give the return's own quantity back to the line, once; the units restored.
inline long long cancelReturn(const std::string& order_line_id, const std::string& return_id) {
  return redis().eval<long long>(kCancelLua, {counterKey(order_line_id), recordKey(return_id)}, {});
}

}  // namespace ledger
`,
};

export const supportModulesScala: Record<string, string> = {
  [scalaPath('returns', 'Store')]: `package returns

import java.time.{LocalDate, ZoneOffset}

import redis.clients.jedis.JedisPooled
import spray.json._

import scala.jdk.CollectionConverters._

/**
 * The returns store (provided): Redis hashes standing in for the order and returns databases.
 * order_line:{id} is a delivered order line (order_line_id, tenant, sku, ordered_quantity,
 * unit_price_cents, delivered_at as YYYY-MM-DD, policy_window "standard" or "extended");
 * return:{id} a return (return_id, tenant, order_line_id, quantity, reason_code, photo_ref, state,
 * grade, refund_cents, refund_id; an unset field is ""); refund:{id} the refund processor's record
 * (refund_id, return_id, amount_cents, state "initiated", "confirmed" or "failed"); outbox a list
 * of JSON rows {topic, key, payload} a relay republishes. line:{id}:returnable belongs to
 * returns.Ledger. Days are UTC calendar days as YYYY-MM-DD, so they compare as strings.
 */
object Store {
  final case class OrderLine(orderLineId: String, tenant: String, sku: String, orderedQuantity: Long, unitPriceCents: Long, deliveredAt: String, policyWindow: String)
  final case class Return(returnId: String, tenant: String, orderLineId: String, quantity: Long, reasonCode: String, photoRef: String, state: String, grade: String, refundCents: Long, refundId: String)
  final case class Refund(refundId: String, returnId: String, amountCents: Long, state: String)

  val jedis = new JedisPooled("redis", 6379)

  private def hash(key: String): Map[String, String] = jedis.hgetAll(key).asScala.toMap
  private def number(text: String): Long = if (text.isEmpty) 0L else text.toLong

  /** The delivered order line, if any. */
  def lineOf(orderLineId: String): Option[OrderLine] = {
    val raw = hash(s"order_line:$orderLineId")
    if (raw.isEmpty) None
    else {
      val f = raw.withDefaultValue("")
      Some(OrderLine(f("order_line_id"), f("tenant"), f("sku"), number(f("ordered_quantity")), number(f("unit_price_cents")), f("delivered_at"), f("policy_window")))
    }
  }

  /** What the order service writes when a line is delivered: the line, and its returnable units (the ordered quantity). */
  def putLine(line: OrderLine): Unit = {
    jedis.hset(s"order_line:\${line.orderLineId}", Map(
      "order_line_id" -> line.orderLineId, "tenant" -> line.tenant, "sku" -> line.sku,
      "ordered_quantity" -> line.orderedQuantity.toString, "unit_price_cents" -> line.unitPriceCents.toString,
      "delivered_at" -> line.deliveredAt, "policy_window" -> line.policyWindow).asJava)
    jedis.set(s"line:\${line.orderLineId}:returnable", line.orderedQuantity.toString)
  }

  def newReturnId(): String = s"ret-\${jedis.incr("return:seq")}"

  /** The return, if any; an unset field is "" (0 for a number). */
  def returnOf(returnId: String): Option[Return] = {
    val raw = hash(s"return:$returnId")
    if (raw.isEmpty) None
    else {
      val f = raw.withDefaultValue("")
      Some(Return(f("return_id"), f("tenant"), f("order_line_id"), number(f("quantity")), f("reason_code"), f("photo_ref"), f("state"), f("grade"), number(f("refund_cents")), f("refund_id")))
    }
  }

  /** Write fields (state, grade, refund_cents, refund_id, …) into the return's record. */
  def updateReturn(returnId: String, fields: Map[String, String]): Unit =
    jedis.hset(s"return:$returnId", fields.asJava)

  /** The refund processor's record of the refund, if any. */
  def refundOf(refundId: String): Option[Refund] = {
    val raw = hash(s"refund:$refundId")
    if (raw.isEmpty) None
    else {
      val f = raw.withDefaultValue("")
      Some(Refund(f("refund_id"), f("return_id"), number(f("amount_cents")), f("state")))
    }
  }

  /** What the refund processor writes as a refund moves from initiated to confirmed or failed. */
  def putRefund(refund: Refund): Unit =
    jedis.hset(s"refund:\${refund.refundId}", Map(
      "refund_id" -> refund.refundId, "return_id" -> refund.returnId, "amount_cents" -> refund.amountCents.toString, "state" -> refund.state).asJava)

  /** A row the relay republishes once the broker takes records again. */
  def insertOutbox(topic: String, key: String, payload: JsObject): Unit =
    jedis.rpush("outbox", JsObject("topic" -> JsString(topic), "key" -> JsString(key), "payload" -> payload).compactPrint)

  /** Today, the UTC calendar day. */
  def today(): String = LocalDate.now(ZoneOffset.UTC).toString

  /** The calendar day days after day (before it when days is negative). */
  def addDays(day: String, days: Long): String = LocalDate.parse(day).plusDays(days).toString
}
`,
  [scalaPath('returns', 'Ledger')]: `package returns

import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

/**
 * The returnable quantities (provided; step 2 builds the same three functions).
 * line:{id}:returnable holds the units of an order line still returnable, set to the ordered
 * quantity at delivery. registerReturn checks the quantity against it, decrements it and writes the
 * return record return:{id} (return_id, order_line_id, quantity, state "registered", plus the given
 * fields: tenant, reason_code, photo_ref) in one Lua script, and reports whether the return was
 * registered. cancelReturn gives a registered return's own quantity back and marks it canceled,
 * once, and reports the units restored.
 */
object Ledger {
  val jedis = new JedisPooled("redis", 6379)

  val RegisterLua: String =
    """local left = tonumber(redis.call('GET', KEYS[1]) or '0')
      |local quantity = tonumber(ARGV[1])
      |if quantity > left then return 0 end
      |redis.call('DECRBY', KEYS[1], quantity)
      |redis.call('HSET', KEYS[2], 'return_id', ARGV[2], 'order_line_id', ARGV[3], 'quantity', ARGV[1], 'state', 'registered')
      |for i = 4, #ARGV, 2 do
      |  redis.call('HSET', KEYS[2], ARGV[i], ARGV[i + 1])
      |end
      |return 1
      |""".stripMargin

  val CancelLua: String =
    """if redis.call('HGET', KEYS[2], 'state') ~= 'registered' then return 0 end
      |local quantity = tonumber(redis.call('HGET', KEYS[2], 'quantity'))
      |redis.call('INCRBY', KEYS[1], quantity)
      |redis.call('HSET', KEYS[2], 'state', 'canceled')
      |return quantity
      |""".stripMargin

  def counterKey(orderLineId: String): String = s"line:$orderLineId:returnable"
  def recordKey(returnId: String): String = s"return:$returnId"

  /** The units of the line still returnable. */
  def remaining(orderLineId: String): Long = Option(jedis.get(counterKey(orderLineId))).map(_.toLong).getOrElse(0L)

  /** Take quantity units off the line and record the return, or nothing when fewer remain. */
  def registerReturn(orderLineId: String, returnId: String, quantity: Long, fields: Map[String, String]): Boolean = {
    val args = List(quantity.toString, returnId, orderLineId) ++ fields.toList.flatMap { case (name, value) => List(name, value) }
    jedis.eval(RegisterLua, List(counterKey(orderLineId), recordKey(returnId)).asJava, args.asJava).asInstanceOf[java.lang.Long] == 1L
  }

  /** Give the return's own quantity back to the line, once; the units restored. */
  def cancelReturn(orderLineId: String, returnId: String): Long =
    jedis.eval(CancelLua, List(counterKey(orderLineId), recordKey(returnId)).asJava, List.empty[String].asJava).asInstanceOf[java.lang.Long]
}
`,
};
