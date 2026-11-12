/**
 * Hand-written support modules the shipment-tracking steps import but no step builds: the
 * `shipments` package. `shipments.registry` is the partner registry (the carrier codes the service
 * has contracts with). `shipments.store` is the shipments store over Redis: shipment hashes, the
 * order index, idempotency records, scans, dropped edges, poll health, the poll schedule and the
 * event outbox. `shipments.timeline` is the forward-only status apply of step 2 as later steps use
 * it. The five languages keep the same keys, so a harness reads one layout whatever the stack.
 */
import {scalaPath} from '../scala-support';

export const supportModules: Record<string, string> = {
  'shipments/__init__.py': '',
  'shipments/registry.py': `"""
The partner registry (provided): the carriers the service has contracts with, by carrier code.
lookup answers the partner record, or None for a code no partner has.
"""

PARTNERS = {
    "ups": {"code": "ups", "name": "UPS"},
    "fedex": {"code": "fedex", "name": "FedEx"},
    "dhl": {"code": "dhl", "name": "DHL Express"},
    "usps": {"code": "usps", "name": "USPS"},
}


def lookup(carrier: str) -> dict | None:
    """The partner record for a carrier code, or None when no partner has it."""
    return PARTNERS.get(carrier)
`,
  'shipments/store.py': `"""
The shipments store (provided). shipment:{id} is a hash: shipment_id, tenant_id, order_id, carrier,
service_level, status, replacement_of ("" when none), created_at (epoch seconds), status_at.
order:{tenant}:{order_id} lists the order's shipment ids, oldest first; idem:{tenant}:{key} holds
the shipment a create answered, as JSON. shipment:{id}:scans lists the applied scans as
"at|status|city", shipment:{id}:rejects the dropped edges ("from->to"), shipment:{id}:poll the
carrier poll health (last_ok_at, failures, last_error, last_failed_at). poll:due is the scheduler's
sorted set (shipment id, scored by when to poll next); outbox:shipment.event holds, as JSON, the
events the broker did not take, for the relay to send again.
"""
import json

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

ACTIVE_STATUSES = ("label", "in_transit", "out_for_delivery")
STALE_AFTER_S = 900
FIELDS = ("shipment_id", "tenant_id", "order_id", "carrier", "service_level", "status", "replacement_of", "created_at")


def shipment_key(shipment_id: str) -> str:
    return f"shipment:{shipment_id}"


def order_key(tenant: str, order_id: str) -> str:
    return f"order:{tenant}:{order_id}"


def _shipment(raw: dict) -> dict | None:
    if not raw:
        return None
    shipment = {name: raw.get(name, "") for name in FIELDS}
    shipment["created_at"] = int(shipment["created_at"] or 0)
    return shipment


def new_shipment_id() -> str:
    """A shipment id no shipment has had."""
    return f"shp_{r.incr('shipment:seq')}"


def save(shipment: dict) -> None:
    """Write a new shipment's hash and append it to its order's list."""
    mapping = {name: "" if shipment.get(name) is None else str(shipment[name]) for name in FIELDS}
    r.hset(shipment_key(shipment["shipment_id"]), mapping=mapping)
    r.rpush(order_key(shipment["tenant_id"], shipment["order_id"]), shipment["shipment_id"])


def get_shipment(shipment_id: str) -> dict | None:
    """The shipment, or None."""
    return _shipment(r.hgetall(shipment_key(shipment_id)))


def last_for_order(tenant: str, order_id: str) -> dict | None:
    """The order's most recent shipment, whatever its status."""
    ids = r.lrange(order_key(tenant, order_id), -1, -1)
    return get_shipment(ids[0]) if ids else None


def active_for_order(tenant: str, order_id: str) -> dict | None:
    """The order's live shipment (label, in_transit or out_for_delivery), or None."""
    for shipment_id in reversed(r.lrange(order_key(tenant, order_id), 0, -1)):
        shipment = get_shipment(shipment_id)
        if shipment is not None and shipment["status"] in ACTIVE_STATUSES:
            return shipment
    return None


def get_by_key(tenant: str, key: str) -> dict | None:
    """The shipment the create (tenant, Idempotency-Key) answered, if any."""
    raw = r.get(f"idem:{tenant}:{key}")
    return json.loads(raw) if raw else None


def put_by_key(tenant: str, key: str, shipment: dict) -> None:
    """Record the shipment the create (tenant, Idempotency-Key) answered, for its replays."""
    r.set(f"idem:{tenant}:{key}", json.dumps(shipment))


def set_status(shipment_id: str, status: str, at: int) -> None:
    """The operator override: writes the status as given, whatever the shipment holds now."""
    r.hset(shipment_key(shipment_id), mapping={"status": status, "status_at": at})


def scans(shipment_id: str) -> list[dict]:
    """The applied scans, oldest first: [{"status", "city", "at"}]."""
    out = []
    for entry in r.lrange(f"shipment:{shipment_id}:scans", 0, -1):
        at, status, city = entry.split("|", 2)
        out.append({"status": status, "city": city, "at": int(at)})
    return out


def rejects(shipment_id: str) -> list[str]:
    """The dropped edges ("from->to"), oldest first."""
    return r.lrange(f"shipment:{shipment_id}:rejects", 0, -1)


def mark_poll_ok(shipment_id: str, at: int) -> None:
    """A poll of the carrier answered at at: the feed is fresh."""
    r.hset(f"shipment:{shipment_id}:poll", mapping={"last_ok_at": at, "failures": 0, "last_error": ""})


def mark_poll_failed(shipment_id: str, at: int, error: str) -> None:
    """A poll of the carrier failed at at with error: one more consecutive failure."""
    key = f"shipment:{shipment_id}:poll"
    r.hincrby(key, "failures", 1)
    r.hset(key, mapping={"last_error": error, "last_failed_at": at})


def poll_health(shipment_id: str, now: int) -> dict:
    """{"last_ok_at" (0: never), "failures", "last_error" ("" when none), "stale"}: stale once the
    last good poll (or the creation, before any) is more than STALE_AFTER_S old."""
    raw = r.hgetall(f"shipment:{shipment_id}:poll")
    last_ok_at = int(raw.get("last_ok_at") or 0)
    shipment = get_shipment(shipment_id)
    since = last_ok_at or (shipment["created_at"] if shipment is not None else now)
    return {
        "last_ok_at": last_ok_at,
        "failures": int(raw.get("failures") or 0),
        "last_error": raw.get("last_error", ""),
        "stale": now - since > STALE_AFTER_S,
    }


def schedule_poll(shipment_id: str, at: int) -> None:
    """Have the scheduler poll the shipment at at (epoch seconds)."""
    r.zadd("poll:due", {shipment_id: at})


def park_event(event: dict) -> None:
    """Keep an event the broker did not take, for the relay to send again."""
    r.rpush("outbox:shipment.event", json.dumps(event))
`,
  'shipments/timeline.py': `"""
The forward-only status apply (provided; step 2 builds the same function). One Lua script reads the
status, drops a scan that is not strictly forward or lands on a terminal status (recording the
edge on shipment:{id}:rejects), and otherwise writes the status and appends the scan to
shipment:{id}:scans. apply_scan answers {"applied", "status" (after the scan), "attempted"}.
"""
import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

STATUS_RANK = {"label": 0, "in_transit": 1, "out_for_delivery": 2, "delivered": 3, "returned": 4}
TERMINAL = ("delivered", "returned", "cancelled")

APPLY_LUA = """
local current = redis.call('HGET', KEYS[1], 'status')
if not current then return redis.error_reply('no such shipment') end
local ranks = {label = 0, in_transit = 1, out_for_delivery = 2, delivered = 3, returned = 4}
local terminals = {delivered = true, returned = true, cancelled = true}
if terminals[current] or ranks[ARGV[1]] <= ranks[current] then
  redis.call('RPUSH', KEYS[3], current .. '->' .. ARGV[1])
  return {'0', current, current}
end
redis.call('HSET', KEYS[1], 'status', ARGV[1], 'status_at', ARGV[2])
redis.call('RPUSH', KEYS[2], ARGV[2] .. '|' .. ARGV[1] .. '|' .. ARGV[3])
return {'1', ARGV[1], current}
"""
apply = r.register_script(APPLY_LUA)


def apply_scan(shipment_id: str, status: str, scan_at: int, city: str) -> dict:
    """Apply one carrier scan to the shipment's status, atomically and forward only."""
    if status not in STATUS_RANK:
        raise ValueError(f"unknown status {status!r}")
    key = f"shipment:{shipment_id}"
    applied, now, before = apply(keys=[key, f"{key}:scans", f"{key}:rejects"], args=[status, scan_at, city])
    return {"applied": applied == "1", "status": now, "attempted": f"{before}->{status}"}
`,
};

export const supportModulesTs: Record<string, string> = {
  'shipments/registry.ts': `/**
 * The partner registry (provided): the carriers the service has contracts with, by carrier code.
 * lookup answers the partner record, or null for a code no partner has.
 */
export interface Partner {
  code: string;
  name: string;
}

const PARTNERS: Record<string, Partner> = {
  ups: {code: 'ups', name: 'UPS'},
  fedex: {code: 'fedex', name: 'FedEx'},
  dhl: {code: 'dhl', name: 'DHL Express'},
  usps: {code: 'usps', name: 'USPS'},
};

/** The partner record for a carrier code, or null when no partner has it. */
export function lookup(carrier: string): Partner | null {
  return Object.prototype.hasOwnProperty.call(PARTNERS, carrier) ? PARTNERS[carrier] : null;
}
`,
  'shipments/store.ts': `/**
 * The shipments store (provided). shipment:{id} is a hash: shipment_id, tenant_id, order_id,
 * carrier, service_level, status, replacement_of ("" when none), created_at (epoch seconds),
 * status_at. order:{tenant}:{order_id} lists the order's shipment ids, oldest first;
 * idem:{tenant}:{key} holds the shipment a create answered, as JSON. shipment:{id}:scans lists the
 * applied scans as "at|status|city", shipment:{id}:rejects the dropped edges ("from->to"),
 * shipment:{id}:poll the carrier poll health (last_ok_at, failures, last_error, last_failed_at).
 * poll:due is the scheduler's sorted set (shipment id, scored by when to poll next);
 * outbox:shipment.event holds, as JSON, the events the broker did not take, for the relay.
 */
import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

export const ACTIVE_STATUSES = ['label', 'in_transit', 'out_for_delivery'];
export const STALE_AFTER_S = 900;

export interface Shipment {
  shipment_id: string;
  tenant_id: string;
  order_id: string;
  carrier: string;
  service_level: string;
  status: string;
  replacement_of: string;
  created_at: number;
}

export interface Scan {
  status: string;
  city: string;
  at: number;
}

/** last_ok_at is 0 before any good poll, last_error "" when the last poll succeeded. */
export interface PollHealth {
  last_ok_at: number;
  failures: number;
  last_error: string;
  stale: boolean;
}

const FIELDS = ['shipment_id', 'tenant_id', 'order_id', 'carrier', 'service_level', 'status', 'replacement_of', 'created_at'] as const;

export const shipmentKey = (shipmentId: string): string => \`shipment:\${shipmentId}\`;
export const orderKey = (tenant: string, orderId: string): string => \`order:\${tenant}:\${orderId}\`;

function shipmentOf(raw: Record<string, string>): Shipment | null {
  if (Object.keys(raw).length === 0) return null;
  const text = (name: string): string => raw[name] ?? '';
  return {
    shipment_id: text('shipment_id'),
    tenant_id: text('tenant_id'),
    order_id: text('order_id'),
    carrier: text('carrier'),
    service_level: text('service_level'),
    status: text('status'),
    replacement_of: text('replacement_of'),
    created_at: Number(text('created_at') || 0),
  };
}

/** A shipment id no shipment has had. */
export async function newShipmentId(): Promise<string> {
  return \`shp_\${await redis.incr('shipment:seq')}\`;
}

/** Write a new shipment's hash and append it to its order's list. */
export async function save(shipment: Shipment): Promise<void> {
  const mapping: Record<string, string> = {};
  for (const name of FIELDS) mapping[name] = String(shipment[name] ?? '');
  await redis.hset(shipmentKey(shipment.shipment_id), mapping);
  await redis.rpush(orderKey(shipment.tenant_id, shipment.order_id), shipment.shipment_id);
}

/** The shipment, or null. */
export async function getShipment(shipmentId: string): Promise<Shipment | null> {
  return shipmentOf(await redis.hgetall(shipmentKey(shipmentId)));
}

/** The order's most recent shipment, whatever its status. */
export async function lastForOrder(tenant: string, orderId: string): Promise<Shipment | null> {
  const ids = await redis.lrange(orderKey(tenant, orderId), -1, -1);
  return ids.length > 0 ? getShipment(ids[0]) : null;
}

/** The order's live shipment (label, in_transit or out_for_delivery), or null. */
export async function activeForOrder(tenant: string, orderId: string): Promise<Shipment | null> {
  const ids = await redis.lrange(orderKey(tenant, orderId), 0, -1);
  for (const shipmentId of ids.reverse()) {
    const shipment = await getShipment(shipmentId);
    if (shipment !== null && ACTIVE_STATUSES.includes(shipment.status)) return shipment;
  }
  return null;
}

/** The shipment the create (tenant, Idempotency-Key) answered, if any. */
export async function getByKey(tenant: string, key: string): Promise<Shipment | null> {
  const raw = await redis.get(\`idem:\${tenant}:\${key}\`);
  return raw === null ? null : (JSON.parse(raw) as Shipment);
}

/** Record the shipment the create (tenant, Idempotency-Key) answered, for its replays. */
export async function putByKey(tenant: string, key: string, shipment: Shipment): Promise<void> {
  await redis.set(\`idem:\${tenant}:\${key}\`, JSON.stringify(shipment));
}

/** The operator override: writes the status as given, whatever the shipment holds now. */
export async function setStatus(shipmentId: string, status: string, at: number): Promise<void> {
  await redis.hset(shipmentKey(shipmentId), {status, status_at: String(at)});
}

/** The applied scans, oldest first. */
export async function scans(shipmentId: string): Promise<Scan[]> {
  const entries = await redis.lrange(\`shipment:\${shipmentId}:scans\`, 0, -1);
  return entries.map(entry => {
    const [at, status, ...city] = entry.split('|');
    return {status, city: city.join('|'), at: Number(at)};
  });
}

/** The dropped edges ("from->to"), oldest first. */
export async function rejects(shipmentId: string): Promise<string[]> {
  return redis.lrange(\`shipment:\${shipmentId}:rejects\`, 0, -1);
}

/** A poll of the carrier answered at at: the feed is fresh. */
export async function markPollOk(shipmentId: string, at: number): Promise<void> {
  await redis.hset(\`shipment:\${shipmentId}:poll\`, {last_ok_at: String(at), failures: '0', last_error: ''});
}

/** A poll of the carrier failed at at with error: one more consecutive failure. */
export async function markPollFailed(shipmentId: string, at: number, error: string): Promise<void> {
  const key = \`shipment:\${shipmentId}:poll\`;
  await redis.hincrby(key, 'failures', 1);
  await redis.hset(key, {last_error: error, last_failed_at: String(at)});
}

/** Stale once the last good poll (or the creation, before any) is more than STALE_AFTER_S old. */
export async function pollHealth(shipmentId: string, now: number): Promise<PollHealth> {
  const raw = await redis.hgetall(\`shipment:\${shipmentId}:poll\`);
  const lastOkAt = Number(raw.last_ok_at || 0);
  const shipment = await getShipment(shipmentId);
  const since = lastOkAt || (shipment !== null ? shipment.created_at : now);
  return {last_ok_at: lastOkAt, failures: Number(raw.failures || 0), last_error: raw.last_error ?? '', stale: now - since > STALE_AFTER_S};
}

/** Have the scheduler poll the shipment at at (epoch seconds). */
export async function schedulePoll(shipmentId: string, at: number): Promise<void> {
  await redis.zadd('poll:due', at, shipmentId);
}

/** Keep an event the broker did not take, for the relay to send again. */
export async function parkEvent(event: Record<string, unknown>): Promise<void> {
  await redis.rpush('outbox:shipment.event', JSON.stringify(event));
}
`,
  'shipments/timeline.ts': `/**
 * The forward-only status apply (provided; step 2 builds the same function). One Lua script reads
 * the status, drops a scan that is not strictly forward or lands on a terminal status (recording
 * the edge on shipment:{id}:rejects), and otherwise writes the status and appends the scan to
 * shipment:{id}:scans. applyScan answers {applied, status (after the scan), attempted}.
 */
import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

export const STATUS_RANK: Record<string, number> = {label: 0, in_transit: 1, out_for_delivery: 2, delivered: 3, returned: 4};
export const TERMINAL = ['delivered', 'returned', 'cancelled'];

export const APPLY_LUA = \`
local current = redis.call('HGET', KEYS[1], 'status')
if not current then return redis.error_reply('no such shipment') end
local ranks = {label = 0, in_transit = 1, out_for_delivery = 2, delivered = 3, returned = 4}
local terminals = {delivered = true, returned = true, cancelled = true}
if terminals[current] or ranks[ARGV[1]] <= ranks[current] then
  redis.call('RPUSH', KEYS[3], current .. '->' .. ARGV[1])
  return {'0', current, current}
end
redis.call('HSET', KEYS[1], 'status', ARGV[1], 'status_at', ARGV[2])
redis.call('RPUSH', KEYS[2], ARGV[2] .. '|' .. ARGV[1] .. '|' .. ARGV[3])
return {'1', ARGV[1], current}
\`;

export interface ScanResult {
  applied: boolean;
  status: string;
  attempted: string;
}

/** Apply one carrier scan to the shipment's status, atomically and forward only. */
export async function applyScan(shipmentId: string, status: string, scanAt: number, city: string): Promise<ScanResult> {
  if (!Object.prototype.hasOwnProperty.call(STATUS_RANK, status)) throw new Error(\`unknown status \${status}\`);
  const key = \`shipment:\${shipmentId}\`;
  const [applied, now, before] = (await redis.eval(APPLY_LUA, 3, key, \`\${key}:scans\`, \`\${key}:rejects\`, status, String(scanAt), city)) as string[];
  return {applied: applied === '1', status: now, attempted: \`\${before}->\${status}\`};
}
`,
};

export const supportModulesGo: Record<string, string> = {
  'shipments/registry/registry.go': `// Package registry is the partner registry (provided): the carriers the service has contracts
// with, by carrier code. Lookup answers the partner record, or nil for a code no partner has.
package registry

// Partner is one carrier the service has a contract with.
type Partner struct {
	Code string \`json:"code"\`
	Name string \`json:"name"\`
}

var partners = map[string]Partner{
	"ups":   {Code: "ups", Name: "UPS"},
	"fedex": {Code: "fedex", Name: "FedEx"},
	"dhl":   {Code: "dhl", Name: "DHL Express"},
	"usps":  {Code: "usps", Name: "USPS"},
}

// Lookup is the partner record for a carrier code, or nil when no partner has it.
func Lookup(carrier string) *Partner {
	if p, ok := partners[carrier]; ok {
		return &p
	}
	return nil
}
`,
  'shipments/store/store.go': `// Package store is the shipments store (provided). shipment:{id} is a hash: shipment_id,
// tenant_id, order_id, carrier, service_level, status, replacement_of ("" when none), created_at
// (epoch seconds), status_at. order:{tenant}:{order_id} lists the order's shipment ids, oldest
// first; idem:{tenant}:{key} holds the shipment a create answered, as JSON. shipment:{id}:scans
// lists the applied scans as "at|status|city", shipment:{id}:rejects the dropped edges
// ("from->to"), shipment:{id}:poll the carrier poll health (last_ok_at, failures, last_error,
// last_failed_at). poll:due is the scheduler's sorted set (shipment id, scored by when to poll
// next); outbox:shipment.event holds, as JSON, the events the broker did not take, for the relay.
package store

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// StaleAfterS: a shipment whose last good poll is older than this is stale.
const StaleAfterS = 900

// ActiveStatuses are the statuses of a live shipment.
var ActiveStatuses = []string{"label", "in_transit", "out_for_delivery"}

// Shipment is one shipment of an order.
type Shipment struct {
	ShipmentID    string \`json:"shipment_id"\`
	TenantID      string \`json:"tenant_id"\`
	OrderID       string \`json:"order_id"\`
	Carrier       string \`json:"carrier"\`
	ServiceLevel  string \`json:"service_level"\`
	Status        string \`json:"status"\`
	ReplacementOf string \`json:"replacement_of"\`
	CreatedAt     int64  \`json:"created_at"\`
}

// Scan is one applied carrier scan.
type Scan struct {
	Status string \`json:"status"\`
	City   string \`json:"city"\`
	At     int64  \`json:"at"\`
}

// Health is the carrier feed's health: LastOKAt 0 before any good poll, LastError "" when the last
// poll succeeded.
type Health struct {
	LastOKAt  int64  \`json:"last_ok_at"\`
	Failures  int64  \`json:"failures"\`
	LastError string \`json:"last_error"\`
	Stale     bool   \`json:"stale"\`
}

// ShipmentKey is the shipment's hash.
func ShipmentKey(shipmentID string) string { return "shipment:" + shipmentID }

// OrderKey lists the order's shipment ids.
func OrderKey(tenant, orderID string) string { return "order:" + tenant + ":" + orderID }

// NewShipmentID is a shipment id no shipment has had.
func NewShipmentID(ctx context.Context) string {
	return fmt.Sprintf("shp_%d", rdb.Incr(ctx, "shipment:seq").Val())
}

// Save writes a new shipment's hash and appends it to its order's list.
func Save(ctx context.Context, s Shipment) {
	rdb.HSet(ctx, ShipmentKey(s.ShipmentID), map[string]any{
		"shipment_id": s.ShipmentID, "tenant_id": s.TenantID, "order_id": s.OrderID, "carrier": s.Carrier,
		"service_level": s.ServiceLevel, "status": s.Status, "replacement_of": s.ReplacementOf,
		"created_at": strconv.FormatInt(s.CreatedAt, 10),
	})
	rdb.RPush(ctx, OrderKey(s.TenantID, s.OrderID), s.ShipmentID)
}

// GetShipment is the shipment, or nil.
func GetShipment(ctx context.Context, shipmentID string) *Shipment {
	raw := rdb.HGetAll(ctx, ShipmentKey(shipmentID)).Val()
	if len(raw) == 0 {
		return nil
	}
	created, _ := strconv.ParseInt(raw["created_at"], 10, 64)
	return &Shipment{
		ShipmentID: raw["shipment_id"], TenantID: raw["tenant_id"], OrderID: raw["order_id"], Carrier: raw["carrier"],
		ServiceLevel: raw["service_level"], Status: raw["status"], ReplacementOf: raw["replacement_of"], CreatedAt: created,
	}
}

// LastForOrder is the order's most recent shipment, whatever its status.
func LastForOrder(ctx context.Context, tenant, orderID string) *Shipment {
	ids := rdb.LRange(ctx, OrderKey(tenant, orderID), -1, -1).Val()
	if len(ids) == 0 {
		return nil
	}
	return GetShipment(ctx, ids[0])
}

// ActiveForOrder is the order's live shipment (label, in_transit or out_for_delivery), or nil.
func ActiveForOrder(ctx context.Context, tenant, orderID string) *Shipment {
	ids := rdb.LRange(ctx, OrderKey(tenant, orderID), 0, -1).Val()
	for i := len(ids) - 1; i >= 0; i-- {
		s := GetShipment(ctx, ids[i])
		if s == nil {
			continue
		}
		for _, active := range ActiveStatuses {
			if s.Status == active {
				return s
			}
		}
	}
	return nil
}

// GetByKey is the shipment the create (tenant, Idempotency-Key) answered, if any.
func GetByKey(ctx context.Context, tenant, key string) *Shipment {
	raw, err := rdb.Get(ctx, "idem:"+tenant+":"+key).Result()
	if err != nil {
		return nil
	}
	var s Shipment
	if json.Unmarshal([]byte(raw), &s) != nil {
		return nil
	}
	return &s
}

// PutByKey records the shipment the create (tenant, Idempotency-Key) answered, for its replays.
func PutByKey(ctx context.Context, tenant, key string, s Shipment) {
	raw, _ := json.Marshal(s)
	rdb.Set(ctx, "idem:"+tenant+":"+key, raw, 0)
}

// SetStatus is the operator override: it writes the status as given, whatever the shipment holds now.
func SetStatus(ctx context.Context, shipmentID, status string, at int64) {
	rdb.HSet(ctx, ShipmentKey(shipmentID), map[string]any{"status": status, "status_at": strconv.FormatInt(at, 10)})
}

// Scans are the applied scans, oldest first.
func Scans(ctx context.Context, shipmentID string) []Scan {
	out := []Scan{}
	for _, entry := range rdb.LRange(ctx, "shipment:"+shipmentID+":scans", 0, -1).Val() {
		parts := strings.SplitN(entry, "|", 3)
		if len(parts) != 3 {
			continue
		}
		at, _ := strconv.ParseInt(parts[0], 10, 64)
		out = append(out, Scan{Status: parts[1], City: parts[2], At: at})
	}
	return out
}

// Rejects are the dropped edges ("from->to"), oldest first.
func Rejects(ctx context.Context, shipmentID string) []string {
	out := rdb.LRange(ctx, "shipment:"+shipmentID+":rejects", 0, -1).Val()
	if out == nil {
		return []string{}
	}
	return out
}

// MarkPollOK records a poll of the carrier that answered at at: the feed is fresh.
func MarkPollOK(ctx context.Context, shipmentID string, at int64) {
	rdb.HSet(ctx, "shipment:"+shipmentID+":poll", map[string]any{"last_ok_at": strconv.FormatInt(at, 10), "failures": "0", "last_error": ""})
}

// MarkPollFailed records a poll of the carrier that failed at at with err: one more consecutive failure.
func MarkPollFailed(ctx context.Context, shipmentID string, at int64, errText string) {
	key := "shipment:" + shipmentID + ":poll"
	rdb.HIncrBy(ctx, key, "failures", 1)
	rdb.HSet(ctx, key, map[string]any{"last_error": errText, "last_failed_at": strconv.FormatInt(at, 10)})
}

// PollHealth is the feed's health: stale once the last good poll (or the creation, before any) is
// more than StaleAfterS old.
func PollHealth(ctx context.Context, shipmentID string, now int64) Health {
	raw := rdb.HGetAll(ctx, "shipment:"+shipmentID+":poll").Val()
	lastOK, _ := strconv.ParseInt(raw["last_ok_at"], 10, 64)
	failures, _ := strconv.ParseInt(raw["failures"], 10, 64)
	since := lastOK
	if since == 0 {
		since = now
		if s := GetShipment(ctx, shipmentID); s != nil {
			since = s.CreatedAt
		}
	}
	return Health{LastOKAt: lastOK, Failures: failures, LastError: raw["last_error"], Stale: now-since > StaleAfterS}
}

// SchedulePoll has the scheduler poll the shipment at at (epoch seconds).
func SchedulePoll(ctx context.Context, shipmentID string, at int64) {
	rdb.ZAdd(ctx, "poll:due", redis.Z{Score: float64(at), Member: shipmentID})
}

// ParkEvent keeps an event the broker did not take, for the relay to send again.
func ParkEvent(ctx context.Context, event map[string]any) {
	raw, _ := json.Marshal(event)
	rdb.RPush(ctx, "outbox:shipment.event", string(raw))
}
`,
  'shipments/timeline/timeline.go': `// Package timeline is the forward-only status apply (provided; step 2 builds the same function).
// One Lua script reads the status, drops a scan that is not strictly forward or lands on a terminal
// status (recording the edge on shipment:{id}:rejects), and otherwise writes the status and
// appends the scan to shipment:{id}:scans. ApplyScan answers {Applied, Status (after the scan), Attempted}.
package timeline

import (
	"context"
	"fmt"
	"strconv"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// StatusRank orders the statuses a scan may carry.
var StatusRank = map[string]int{"label": 0, "in_transit": 1, "out_for_delivery": 2, "delivered": 3, "returned": 4}

var applyScript = redis.NewScript(\`
local current = redis.call('HGET', KEYS[1], 'status')
if not current then return redis.error_reply('no such shipment') end
local ranks = {label = 0, in_transit = 1, out_for_delivery = 2, delivered = 3, returned = 4}
local terminals = {delivered = true, returned = true, cancelled = true}
if terminals[current] or ranks[ARGV[1]] <= ranks[current] then
  redis.call('RPUSH', KEYS[3], current .. '->' .. ARGV[1])
  return {'0', current, current}
end
redis.call('HSET', KEYS[1], 'status', ARGV[1], 'status_at', ARGV[2])
redis.call('RPUSH', KEYS[2], ARGV[2] .. '|' .. ARGV[1] .. '|' .. ARGV[3])
return {'1', ARGV[1], current}
\`)

// Result is what one scan did to the shipment.
type Result struct {
	Applied   bool   \`json:"applied"\`
	Status    string \`json:"status"\`
	Attempted string \`json:"attempted"\`
}

// ApplyScan applies one carrier scan to the shipment's status, atomically and forward only.
func ApplyScan(ctx context.Context, shipmentID, status string, scanAt int64, city string) (Result, error) {
	if _, known := StatusRank[status]; !known {
		return Result{}, fmt.Errorf("unknown status %q", status)
	}
	key := "shipment:" + shipmentID
	reply, err := applyScript.Run(ctx, rdb, []string{key, key + ":scans", key + ":rejects"}, status, strconv.FormatInt(scanAt, 10), city).StringSlice()
	if err != nil {
		return Result{}, err
	}
	return Result{Applied: reply[0] == "1", Status: reply[1], Attempted: reply[2] + "->" + status}, nil
}
`,
};

export const supportModulesCpp: Record<string, string> = {
  'shipments/registry.h': `// The partner registry (provided): the carriers the service has contracts with, by carrier code.
// lookup answers the partner record, or none for a code no partner has.
#pragma once

#include <map>
#include <optional>
#include <string>

namespace registry {

struct Partner {
  std::string code;
  std::string name;
};

// The partner record for a carrier code, or none when no partner has it.
inline std::optional<Partner> lookup(const std::string& carrier) {
  static const std::map<std::string, Partner> partners = {
      {"ups", {"ups", "UPS"}}, {"fedex", {"fedex", "FedEx"}}, {"dhl", {"dhl", "DHL Express"}}, {"usps", {"usps", "USPS"}}};
  const auto it = partners.find(carrier);
  if (it == partners.end()) return std::nullopt;
  return it->second;
}

}  // namespace registry
`,
  'shipments/store.h': `// The shipments store (provided). shipment:{id} is a hash: shipment_id, tenant_id, order_id,
// carrier, service_level, status, replacement_of ("" when none), created_at (epoch seconds),
// status_at. order:{tenant}:{order_id} lists the order's shipment ids, oldest first;
// idem:{tenant}:{key} holds the shipment a create answered, as JSON. shipment:{id}:scans lists the
// applied scans as "at|status|city", shipment:{id}:rejects the dropped edges ("from->to"),
// shipment:{id}:poll the carrier poll health (last_ok_at, failures, last_error, last_failed_at).
// poll:due is the scheduler's sorted set (shipment id, scored by when to poll next);
// outbox:shipment.event holds, as JSON, the events the broker did not take, for the relay.
#pragma once

#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <optional>
#include <string>
#include <unordered_map>
#include <vector>

namespace store {

constexpr long kStaleAfterS = 900;
inline const std::vector<std::string> kActiveStatuses = {"label", "in_transit", "out_for_delivery"};

struct Shipment {
  std::string shipment_id;
  std::string tenant_id;
  std::string order_id;
  std::string carrier;
  std::string service_level;
  std::string status;
  std::string replacement_of;
  long created_at = 0;
};

struct Scan {
  std::string status;
  std::string city;
  long at = 0;
};

// last_ok_at is 0 before any good poll, last_error "" when the last poll succeeded.
struct PollHealth {
  long last_ok_at = 0;
  long failures = 0;
  std::string last_error;
  bool stale = false;
};

inline void to_json(nlohmann::json& j, const Shipment& s) {
  j = nlohmann::json{{"shipment_id", s.shipment_id}, {"tenant_id", s.tenant_id}, {"order_id", s.order_id},
                     {"carrier", s.carrier}, {"service_level", s.service_level}, {"status", s.status},
                     {"replacement_of", s.replacement_of}, {"created_at", s.created_at}};
}

inline void from_json(const nlohmann::json& j, Shipment& s) {
  s.shipment_id = j.value("shipment_id", "");
  s.tenant_id = j.value("tenant_id", "");
  s.order_id = j.value("order_id", "");
  s.carrier = j.value("carrier", "");
  s.service_level = j.value("service_level", "");
  s.status = j.value("status", "");
  s.replacement_of = j.value("replacement_of", "");
  s.created_at = j.value("created_at", 0L);
}

inline void to_json(nlohmann::json& j, const Scan& s) { j = nlohmann::json{{"status", s.status}, {"city", s.city}, {"at", s.at}}; }

inline void to_json(nlohmann::json& j, const PollHealth& h) {
  j = nlohmann::json{{"last_ok_at", h.last_ok_at}, {"failures", h.failures}, {"last_error", h.last_error}, {"stale", h.stale}};
}

inline sw::redis::Redis& redis() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

inline std::string shipmentKey(const std::string& shipment_id) { return "shipment:" + shipment_id; }
inline std::string orderKey(const std::string& tenant, const std::string& order_id) { return "order:" + tenant + ":" + order_id; }

// A shipment id no shipment has had.
inline std::string newShipmentId() { return "shp_" + std::to_string(redis().incr("shipment:seq")); }

// Write a new shipment's hash and append it to its order's list.
inline void save(const Shipment& s) {
  redis().hset(shipmentKey(s.shipment_id), {{"shipment_id", s.shipment_id}, {"tenant_id", s.tenant_id}, {"order_id", s.order_id},
                                             {"carrier", s.carrier}, {"service_level", s.service_level}, {"status", s.status},
                                             {"replacement_of", s.replacement_of}, {"created_at", std::to_string(s.created_at)}});
  redis().rpush(orderKey(s.tenant_id, s.order_id), s.shipment_id);
}

// The shipment, or none.
inline std::optional<Shipment> getShipment(const std::string& shipment_id) {
  const std::unordered_map<std::string, std::string> raw = redis().hgetall(shipmentKey(shipment_id));
  if (raw.empty()) return std::nullopt;
  const auto text = [&raw](const char* name) { return raw.count(name) ? raw.at(name) : std::string(); };
  Shipment s;
  s.shipment_id = text("shipment_id");
  s.tenant_id = text("tenant_id");
  s.order_id = text("order_id");
  s.carrier = text("carrier");
  s.service_level = text("service_level");
  s.status = text("status");
  s.replacement_of = text("replacement_of");
  s.created_at = text("created_at").empty() ? 0 : std::stol(text("created_at"));
  return s;
}

// The order's most recent shipment, whatever its status.
inline std::optional<Shipment> lastForOrder(const std::string& tenant, const std::string& order_id) {
  const std::vector<std::string> ids = redis().lrange(orderKey(tenant, order_id), -1, -1);
  if (ids.empty()) return std::nullopt;
  return getShipment(ids.front());
}

// The order's live shipment (label, in_transit or out_for_delivery), or none.
inline std::optional<Shipment> activeForOrder(const std::string& tenant, const std::string& order_id) {
  const std::vector<std::string> ids = redis().lrange(orderKey(tenant, order_id), 0, -1);
  for (auto it = ids.rbegin(); it != ids.rend(); ++it) {
    const auto s = getShipment(*it);
    if (!s) continue;
    for (const std::string& active : kActiveStatuses) {
      if (s->status == active) return s;
    }
  }
  return std::nullopt;
}

// The shipment the create (tenant, Idempotency-Key) answered, if any.
inline std::optional<Shipment> getByKey(const std::string& tenant, const std::string& key) {
  const auto raw = redis().get("idem:" + tenant + ":" + key);
  if (!raw) return std::nullopt;
  return nlohmann::json::parse(*raw).get<Shipment>();
}

// Record the shipment the create (tenant, Idempotency-Key) answered, for its replays.
inline void putByKey(const std::string& tenant, const std::string& key, const Shipment& s) {
  redis().set("idem:" + tenant + ":" + key, nlohmann::json(s).dump());
}

// The operator override: writes the status as given, whatever the shipment holds now.
inline void setStatus(const std::string& shipment_id, const std::string& status, long at) {
  redis().hset(shipmentKey(shipment_id), {{"status", status}, {"status_at", std::to_string(at)}});
}

// The applied scans, oldest first.
inline std::vector<Scan> scans(const std::string& shipment_id) {
  std::vector<Scan> out;
  for (const std::string& entry : redis().lrange("shipment:" + shipment_id + ":scans", 0, -1)) {
    const size_t a = entry.find('|');
    const size_t b = a == std::string::npos ? a : entry.find('|', a + 1);
    if (b == std::string::npos) continue;
    out.push_back(Scan{entry.substr(a + 1, b - a - 1), entry.substr(b + 1), std::stol(entry.substr(0, a))});
  }
  return out;
}

// The dropped edges ("from->to"), oldest first.
inline std::vector<std::string> rejects(const std::string& shipment_id) {
  return redis().lrange("shipment:" + shipment_id + ":rejects", 0, -1);
}

// A poll of the carrier answered at at: the feed is fresh.
inline void markPollOk(const std::string& shipment_id, long at) {
  redis().hset("shipment:" + shipment_id + ":poll", {{"last_ok_at", std::to_string(at)}, {"failures", "0"}, {"last_error", ""}});
}

// A poll of the carrier failed at at with error: one more consecutive failure.
inline void markPollFailed(const std::string& shipment_id, long at, const std::string& error) {
  const std::string key = "shipment:" + shipment_id + ":poll";
  redis().hincrby(key, "failures", 1);
  redis().hset(key, {{"last_error", error}, {"last_failed_at", std::to_string(at)}});
}

// Stale once the last good poll (or the creation, before any) is more than kStaleAfterS old.
inline PollHealth pollHealth(const std::string& shipment_id, long now) {
  const std::unordered_map<std::string, std::string> raw = redis().hgetall("shipment:" + shipment_id + ":poll");
  const auto text = [&raw](const char* name) { return raw.count(name) ? raw.at(name) : std::string(); };
  PollHealth h;
  h.last_ok_at = text("last_ok_at").empty() ? 0 : std::stol(text("last_ok_at"));
  h.failures = text("failures").empty() ? 0 : std::stol(text("failures"));
  h.last_error = text("last_error");
  long since = h.last_ok_at;
  if (since == 0) {
    const auto s = getShipment(shipment_id);
    since = s ? s->created_at : now;
  }
  h.stale = now - since > kStaleAfterS;
  return h;
}

// Have the scheduler poll the shipment at at (epoch seconds).
inline void schedulePoll(const std::string& shipment_id, long at) { redis().zadd("poll:due", shipment_id, static_cast<double>(at)); }

// Keep an event the broker did not take, for the relay to send again.
inline void parkEvent(const nlohmann::json& event) { redis().rpush("outbox:shipment.event", event.dump()); }

}  // namespace store
`,
  'shipments/timeline.h': `// The forward-only status apply (provided; step 2 builds the same function). One Lua script reads
// the status, drops a scan that is not strictly forward or lands on a terminal status (recording
// the edge on shipment:{id}:rejects), and otherwise writes the status and appends the scan to
// shipment:{id}:scans. applyScan answers {applied, status (after the scan), attempted}.
#pragma once

#include <sw/redis++/redis++.h>

#include <iterator>
#include <map>
#include <stdexcept>
#include <string>
#include <vector>

namespace timeline {

inline const std::map<std::string, int> kStatusRank = {
    {"label", 0}, {"in_transit", 1}, {"out_for_delivery", 2}, {"delivered", 3}, {"returned", 4}};

inline const std::string kApplyLua = R"lua(
local current = redis.call('HGET', KEYS[1], 'status')
if not current then return redis.error_reply('no such shipment') end
local ranks = {label = 0, in_transit = 1, out_for_delivery = 2, delivered = 3, returned = 4}
local terminals = {delivered = true, returned = true, cancelled = true}
if terminals[current] or ranks[ARGV[1]] <= ranks[current] then
  redis.call('RPUSH', KEYS[3], current .. '->' .. ARGV[1])
  return {'0', current, current}
end
redis.call('HSET', KEYS[1], 'status', ARGV[1], 'status_at', ARGV[2])
redis.call('RPUSH', KEYS[2], ARGV[2] .. '|' .. ARGV[1] .. '|' .. ARGV[3])
return {'1', ARGV[1], current}
)lua";

struct Result {
  bool applied = false;
  std::string status;
  std::string attempted;
};

inline sw::redis::Redis& redis() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

// Apply one carrier scan to the shipment's status, atomically and forward only.
inline Result applyScan(const std::string& shipment_id, const std::string& status, long scan_at, const std::string& city) {
  if (kStatusRank.count(status) == 0) throw std::invalid_argument("unknown status " + status);
  const std::string key = "shipment:" + shipment_id;
  std::vector<std::string> reply;
  redis().eval(kApplyLua, {key, key + ":scans", key + ":rejects"}, {status, std::to_string(scan_at), city}, std::back_inserter(reply));
  return Result{reply.at(0) == "1", reply.at(1), reply.at(2) + "->" + status};
}

}  // namespace timeline
`,
};

export const supportModulesScala: Record<string, string> = {
  [scalaPath('shipments', 'Registry')]: `package shipments

/** The partner registry (provided): the carriers the service has contracts with, by carrier code. */
object Registry {
  final case class Partner(code: String, name: String)

  private val partners: Map[String, Partner] = Map(
    "ups" -> Partner("ups", "UPS"),
    "fedex" -> Partner("fedex", "FedEx"),
    "dhl" -> Partner("dhl", "DHL Express"),
    "usps" -> Partner("usps", "USPS"))

  /** The partner record for a carrier code, or None when no partner has it. */
  def lookup(carrier: String): Option[Partner] = partners.get(carrier)
}
`,
  [scalaPath('shipments', 'Store')]: `package shipments

import redis.clients.jedis.JedisPooled
import spray.json._

import scala.jdk.CollectionConverters._

/**
 * The shipments store (provided). shipment:{id} is a hash: shipment_id, tenant_id, order_id,
 * carrier, service_level, status, replacement_of ("" when none), created_at (epoch seconds),
 * status_at. order:{tenant}:{order_id} lists the order's shipment ids, oldest first;
 * idem:{tenant}:{key} holds the shipment a create answered, as JSON. shipment:{id}:scans lists the
 * applied scans as "at|status|city", shipment:{id}:rejects the dropped edges ("from->to"),
 * shipment:{id}:poll the carrier poll health (last_ok_at, failures, last_error, last_failed_at).
 * poll:due is the scheduler's sorted set (shipment id, scored by when to poll next);
 * outbox:shipment.event holds, as JSON, the events the broker did not take, for the relay.
 */
object Store {
  final case class Shipment(
      shipmentId: String,
      tenantId: String,
      orderId: String,
      carrier: String,
      serviceLevel: String,
      status: String,
      replacementOf: String,
      createdAt: Long) {
    def toJson: JsObject = JsObject(
      "shipment_id" -> JsString(shipmentId), "tenant_id" -> JsString(tenantId), "order_id" -> JsString(orderId),
      "carrier" -> JsString(carrier), "service_level" -> JsString(serviceLevel), "status" -> JsString(status),
      "replacement_of" -> JsString(replacementOf), "created_at" -> JsNumber(createdAt))
  }

  final case class Scan(status: String, city: String, at: Long) {
    def toJson: JsObject = JsObject("status" -> JsString(status), "city" -> JsString(city), "at" -> JsNumber(at))
  }

  /** lastOkAt is 0 before any good poll, lastError "" when the last poll succeeded. */
  final case class PollHealth(lastOkAt: Long, failures: Long, lastError: String, stale: Boolean) {
    def toJson: JsObject = JsObject(
      "last_ok_at" -> JsNumber(lastOkAt), "failures" -> JsNumber(failures), "last_error" -> JsString(lastError), "stale" -> JsBoolean(stale))
  }

  val ActiveStatuses: Set[String] = Set("label", "in_transit", "out_for_delivery")
  val StaleAfterS = 900L

  val jedis = new JedisPooled("redis", 6379)

  def shipmentKey(shipmentId: String): String = s"shipment:$shipmentId"
  def orderKey(tenant: String, orderId: String): String = s"order:$tenant:$orderId"

  private def shipmentOf(raw: Map[String, String]): Option[Shipment] =
    if (raw.isEmpty) None
    else {
      def text(name: String): String = raw.getOrElse(name, "")
      Some(Shipment(text("shipment_id"), text("tenant_id"), text("order_id"), text("carrier"), text("service_level"), text("status"),
        text("replacement_of"), text("created_at").toLongOption.getOrElse(0L)))
    }

  /** A shipment id no shipment has had. */
  def newShipmentId(): String = s"shp_\${jedis.incr("shipment:seq")}"

  /** Write a new shipment's hash and append it to its order's list. */
  def save(s: Shipment): Unit = {
    jedis.hset(shipmentKey(s.shipmentId), Map(
      "shipment_id" -> s.shipmentId, "tenant_id" -> s.tenantId, "order_id" -> s.orderId, "carrier" -> s.carrier,
      "service_level" -> s.serviceLevel, "status" -> s.status, "replacement_of" -> s.replacementOf,
      "created_at" -> s.createdAt.toString).asJava)
    jedis.rpush(orderKey(s.tenantId, s.orderId), s.shipmentId)
  }

  /** The shipment, or None. */
  def getShipment(shipmentId: String): Option[Shipment] = shipmentOf(jedis.hgetAll(shipmentKey(shipmentId)).asScala.toMap)

  /** The order's most recent shipment, whatever its status. */
  def lastForOrder(tenant: String, orderId: String): Option[Shipment] =
    jedis.lrange(orderKey(tenant, orderId), -1, -1).asScala.headOption.flatMap(getShipment)

  /** The order's live shipment (label, in_transit or out_for_delivery), or None. */
  def activeForOrder(tenant: String, orderId: String): Option[Shipment] =
    jedis.lrange(orderKey(tenant, orderId), 0, -1).asScala.reverseIterator.flatMap(getShipment).find(s => ActiveStatuses(s.status))

  /** The shipment the create (tenant, Idempotency-Key) answered, if any. */
  def getByKey(tenant: String, key: String): Option[Shipment] =
    Option(jedis.get(s"idem:$tenant:$key")).map { raw =>
      val f = raw.parseJson.asJsObject.fields
      def text(name: String): String = f.get(name).collect { case JsString(v) => v }.getOrElse("")
      Shipment(text("shipment_id"), text("tenant_id"), text("order_id"), text("carrier"), text("service_level"), text("status"),
        text("replacement_of"), f.get("created_at").collect { case JsNumber(n) => n.toLong }.getOrElse(0L))
    }

  /** Record the shipment the create (tenant, Idempotency-Key) answered, for its replays. */
  def putByKey(tenant: String, key: String, s: Shipment): Unit = jedis.set(s"idem:$tenant:$key", s.toJson.compactPrint)

  /** The operator override: writes the status as given, whatever the shipment holds now. */
  def setStatus(shipmentId: String, status: String, at: Long): Unit =
    jedis.hset(shipmentKey(shipmentId), Map("status" -> status, "status_at" -> at.toString).asJava)

  /** The applied scans, oldest first. */
  def scans(shipmentId: String): Seq[Scan] =
    jedis.lrange(s"shipment:$shipmentId:scans", 0, -1).asScala.toSeq.flatMap { entry =>
      entry.split("\\\\|", 3) match {
        case Array(at, status, city) => Some(Scan(status, city, at.toLong))
        case _ => None
      }
    }

  /** The dropped edges ("from->to"), oldest first. */
  def rejects(shipmentId: String): Seq[String] = jedis.lrange(s"shipment:$shipmentId:rejects", 0, -1).asScala.toSeq

  /** A poll of the carrier answered at at: the feed is fresh. */
  def markPollOk(shipmentId: String, at: Long): Unit =
    jedis.hset(s"shipment:$shipmentId:poll", Map("last_ok_at" -> at.toString, "failures" -> "0", "last_error" -> "").asJava)

  /** A poll of the carrier failed at at with error: one more consecutive failure. */
  def markPollFailed(shipmentId: String, at: Long, error: String): Unit = {
    val key = s"shipment:$shipmentId:poll"
    jedis.hincrBy(key, "failures", 1)
    jedis.hset(key, Map("last_error" -> error, "last_failed_at" -> at.toString).asJava)
  }

  /** Stale once the last good poll (or the creation, before any) is more than StaleAfterS old. */
  def pollHealth(shipmentId: String, now: Long): PollHealth = {
    val raw = jedis.hgetAll(s"shipment:$shipmentId:poll").asScala.toMap
    val lastOkAt = raw.get("last_ok_at").flatMap(_.toLongOption).getOrElse(0L)
    val since = if (lastOkAt != 0L) lastOkAt else getShipment(shipmentId).map(_.createdAt).getOrElse(now)
    PollHealth(lastOkAt, raw.get("failures").flatMap(_.toLongOption).getOrElse(0L), raw.getOrElse("last_error", ""), now - since > StaleAfterS)
  }

  /** Have the scheduler poll the shipment at at (epoch seconds). */
  def schedulePoll(shipmentId: String, at: Long): Unit = jedis.zadd("poll:due", at.toDouble, shipmentId)

  /** Keep an event the broker did not take, for the relay to send again. */
  def parkEvent(event: JsObject): Unit = jedis.rpush("outbox:shipment.event", event.compactPrint)
}
`,
  [scalaPath('shipments', 'Timeline')]: `package shipments

import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

/**
 * The forward-only status apply (provided; step 2 builds the same function). One Lua script reads
 * the status, drops a scan that is not strictly forward or lands on a terminal status (recording
 * the edge on shipment:{id}:rejects), and otherwise writes the status and appends the scan to
 * shipment:{id}:scans. applyScan answers Result(applied, status after the scan, attempted).
 */
object Timeline {
  final case class Result(applied: Boolean, status: String, attempted: String)

  val StatusRank: Map[String, Int] = Map("label" -> 0, "in_transit" -> 1, "out_for_delivery" -> 2, "delivered" -> 3, "returned" -> 4)

  val ApplyLua: String =
    """local current = redis.call('HGET', KEYS[1], 'status')
      |if not current then return redis.error_reply('no such shipment') end
      |local ranks = {label = 0, in_transit = 1, out_for_delivery = 2, delivered = 3, returned = 4}
      |local terminals = {delivered = true, returned = true, cancelled = true}
      |if terminals[current] or ranks[ARGV[1]] <= ranks[current] then
      |  redis.call('RPUSH', KEYS[3], current .. '->' .. ARGV[1])
      |  return {'0', current, current}
      |end
      |redis.call('HSET', KEYS[1], 'status', ARGV[1], 'status_at', ARGV[2])
      |redis.call('RPUSH', KEYS[2], ARGV[2] .. '|' .. ARGV[1] .. '|' .. ARGV[3])
      |return {'1', ARGV[1], current}
      |""".stripMargin

  val jedis = new JedisPooled("redis", 6379)

  /** Apply one carrier scan to the shipment's status, atomically and forward only. */
  def applyScan(shipmentId: String, status: String, scanAt: Long, city: String): Result = {
    require(StatusRank.contains(status), s"unknown status $status")
    val key = s"shipment:$shipmentId"
    val reply = jedis.eval(ApplyLua, List(key, s"$key:scans", s"$key:rejects").asJava, List(status, scanAt.toString, city).asJava)
      .asInstanceOf[java.util.List[String]].asScala.toVector
    Result(reply(0) == "1", reply(1), s"\${reply(2)}->$status")
  }
}
`,
};
