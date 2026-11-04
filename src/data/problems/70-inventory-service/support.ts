/**
 * Hand-written support modules every inventory-service step imports: the `inventory` package.
 * `inventory.catalog` is the sku catalogue (which tenant sells a sku, when the warehouse sync last
 * wrote its counter). `inventory.stock` is the stock counter and the hold map as later steps use
 * them: `reserve`, `release` and `confirm`, the three Lua transitions step 2 builds. `inventory.store`
 * is the reservation store, the Idempotency-Key index and the outbox. The five languages keep the
 * same keys, so a harness reads one layout whatever the stack.
 */
import {scalaPath} from '../scala-support';

export const supportModules: Record<string, string> = {
  'inventory/__init__.py': '',
  'inventory/catalog.py': `"""
The sku catalogue (provided): sku:{sku} is a hash with the tenant that sells the sku and synced_at,
the epoch second at which the warehouse sync last wrote the sku's stock counter.
"""
import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)


def sku_key(sku: str) -> str:
    return f"sku:{sku}"


def owner(sku: str) -> str | None:
    """The tenant that sells the sku, or None for a sku the catalogue does not know."""
    return r.hget(sku_key(sku), "tenant") or None


def synced_at(sku: str) -> int | None:
    """When the warehouse sync last wrote stock:{sku}, in epoch seconds; None if it never did."""
    value = r.hget(sku_key(sku), "synced_at")
    return int(value) if value else None
`,
  'inventory/stock.py': `"""
The stock counter and the hold map (provided; step 2 builds the same three transitions).
stock:{sku} is the units available to reserve. holds:{sku} maps every reservation holding units of
the sku to its quantity, and hold:{reservation_id} lives for RESERVATION_TTL_S: a reservation whose
hold key expired still sits in holds:{sku} until the next reserve gives its units back.
"""
import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

RESERVATION_TTL_S = 900  # a cart holds its units for 15 minutes

# KEYS: stock:{sku}, holds:{sku}, hold:{reservation_id}. ARGV: quantity, reservation_id, ttl.
RESERVE_LUA = """
local entries = redis.call('HGETALL', KEYS[2])
for i = 1, #entries, 2 do
  if redis.call('EXISTS', 'hold:' .. entries[i]) == 0 then
    redis.call('HDEL', KEYS[2], entries[i])
    redis.call('INCRBY', KEYS[1], entries[i + 1])
  end
end
local quantity = tonumber(ARGV[1])
if tonumber(redis.call('GET', KEYS[1]) or '0') < quantity then return 0 end
redis.call('DECRBY', KEYS[1], quantity)
redis.call('HSET', KEYS[2], ARGV[2], quantity)
redis.call('SET', KEYS[3], quantity, 'EX', ARGV[3])
return 1
"""

# Same KEYS. ARGV: reservation_id. Gives the units back once: only while the hold is in the map.
RELEASE_LUA = """
local quantity = redis.call('HGET', KEYS[2], ARGV[1])
if not quantity then return 0 end
redis.call('HDEL', KEYS[2], ARGV[1])
redis.call('DEL', KEYS[3])
redis.call('INCRBY', KEYS[1], quantity)
return tonumber(quantity)
"""

# Same KEYS. ARGV: reservation_id. The units are sold: the hold leaves the map, the counter stays.
CONFIRM_LUA = """
local quantity = redis.call('HGET', KEYS[2], ARGV[1])
if not quantity then return 0 end
redis.call('HDEL', KEYS[2], ARGV[1])
redis.call('DEL', KEYS[3])
return tonumber(quantity)
"""

reserve_script = r.register_script(RESERVE_LUA)
release_script = r.register_script(RELEASE_LUA)
confirm_script = r.register_script(CONFIRM_LUA)


def stock_key(sku: str) -> str:
    return f"stock:{sku}"


def holds_key(sku: str) -> str:
    return f"holds:{sku}"


def hold_key(reservation_id: str) -> str:
    return f"hold:{reservation_id}"


def _keys(sku: str, reservation_id: str) -> list[str]:
    return [stock_key(sku), holds_key(sku), hold_key(reservation_id)]


def reserve(sku: str, quantity: int, reservation_id: str) -> bool:
    """Hold quantity units for the reservation; False when the sku has fewer available."""
    return reserve_script(keys=_keys(sku, reservation_id), args=[quantity, reservation_id, RESERVATION_TTL_S]) == 1


def release(sku: str, reservation_id: str) -> int:
    """Give the reservation's units back; the units released (0 when it holds none)."""
    return int(release_script(keys=_keys(sku, reservation_id), args=[reservation_id]))


def confirm(sku: str, reservation_id: str) -> int:
    """The warehouse allocated the units: the hold becomes a sale; the units sold."""
    return int(confirm_script(keys=_keys(sku, reservation_id), args=[reservation_id]))
`,
  'inventory/store.py': `"""
The reservation store and the outbox, in Redis: a reservation is the hash reservation:{id}
(reservation_id, tenant, idempotency_key, sku, quantity, status, expires_at; status is reserved,
pending, confirmed or rejected), idem:{tenant}:{key} points a tenant's Idempotency-Key at its
reservation, and the outbox is the list outbox of JSON rows {"topic", "key", "payload"} a relay
publishes later. A reservation is returned as a dict with quantity and expires_at as ints.
"""
import json
import uuid

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)


def new_id() -> str:
    return str(uuid.uuid4())


class ReservationStore:
    def get(self, reservation_id: str) -> dict | None:
        """The reservation, or None."""
        fields = r.hgetall(f"reservation:{reservation_id}")
        if not fields:
            return None
        return {**fields, "quantity": int(fields["quantity"]), "expires_at": int(fields["expires_at"])}

    def get_by_key(self, tenant: str, idempotency_key: str) -> dict | None:
        """The reservation a tenant's Idempotency-Key was first used for, or None."""
        reservation_id = r.get(f"idem:{tenant}:{idempotency_key}")
        return self.get(reservation_id) if reservation_id else None

    def put(self, reservation: dict) -> None:
        """Commit the reservation: write it and index it under its idempotency key."""
        row = {field: str(value) for field, value in reservation.items()}
        pipe = r.pipeline()
        pipe.hset(f"reservation:{row['reservation_id']}", mapping=row)
        pipe.set(f"idem:{row['tenant']}:{row['idempotency_key']}", row["reservation_id"])
        pipe.execute()

    def set_status(self, reservation_id: str, status: str) -> None:
        r.hset(f"reservation:{reservation_id}", "status", status)


class Outbox:
    def insert(self, topic: str, key: str, payload: dict) -> None:
        """Queue a record for the relay to publish later."""
        r.rpush("outbox", json.dumps({"topic": topic, "key": key, "payload": payload}))

    def rows(self) -> list[dict]:
        """Everything queued, oldest first."""
        return [json.loads(row) for row in r.lrange("outbox", 0, -1)]


store = ReservationStore()
outbox = Outbox()
`,
};

export const supportModulesTs: Record<string, string> = {
  'inventory/catalog.ts': `/**
 * The sku catalogue (provided): sku:{sku} is a hash with the tenant that sells the sku and
 * synced_at, the epoch second at which the warehouse sync last wrote the sku's stock counter.
 */
import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

export const skuKey = (sku: string): string => \`sku:\${sku}\`;

/** The tenant that sells the sku, or null for a sku the catalogue does not know. */
export async function owner(sku: string): Promise<string | null> {
  const tenant = await redis.hget(skuKey(sku), 'tenant');
  return tenant ? tenant : null;
}

/** When the warehouse sync last wrote stock:{sku}, in epoch seconds; null if it never did. */
export async function syncedAt(sku: string): Promise<number | null> {
  const value = await redis.hget(skuKey(sku), 'synced_at');
  return value ? Number(value) : null;
}
`,
  'inventory/stock.ts': `/**
 * The stock counter and the hold map (provided; step 2 builds the same three transitions).
 * stock:{sku} is the units available to reserve. holds:{sku} maps every reservation holding units
 * of the sku to its quantity, and hold:{reservation_id} lives for RESERVATION_TTL_S: a reservation
 * whose hold key expired still sits in holds:{sku} until the next reserve gives its units back.
 */
import Redis from 'ioredis';

export const RESERVATION_TTL_S = 900; // a cart holds its units for 15 minutes

// KEYS: stock:{sku}, holds:{sku}, hold:{reservation_id}. ARGV: quantity, reservation_id, ttl.
export const RESERVE_LUA = \`
local entries = redis.call('HGETALL', KEYS[2])
for i = 1, #entries, 2 do
  if redis.call('EXISTS', 'hold:' .. entries[i]) == 0 then
    redis.call('HDEL', KEYS[2], entries[i])
    redis.call('INCRBY', KEYS[1], entries[i + 1])
  end
end
local quantity = tonumber(ARGV[1])
if tonumber(redis.call('GET', KEYS[1]) or '0') < quantity then return 0 end
redis.call('DECRBY', KEYS[1], quantity)
redis.call('HSET', KEYS[2], ARGV[2], quantity)
redis.call('SET', KEYS[3], quantity, 'EX', ARGV[3])
return 1
\`;

// Same KEYS. ARGV: reservation_id. Gives the units back once: only while the hold is in the map.
export const RELEASE_LUA = \`
local quantity = redis.call('HGET', KEYS[2], ARGV[1])
if not quantity then return 0 end
redis.call('HDEL', KEYS[2], ARGV[1])
redis.call('DEL', KEYS[3])
redis.call('INCRBY', KEYS[1], quantity)
return tonumber(quantity)
\`;

// Same KEYS. ARGV: reservation_id. The units are sold: the hold leaves the map, the counter stays.
export const CONFIRM_LUA = \`
local quantity = redis.call('HGET', KEYS[2], ARGV[1])
if not quantity then return 0 end
redis.call('HDEL', KEYS[2], ARGV[1])
redis.call('DEL', KEYS[3])
return tonumber(quantity)
\`;

interface StockRedis extends Redis {
  reserveUnits(stock: string, holds: string, hold: string, quantity: number, reservationId: string, ttl: number): Promise<number>;
  releaseUnits(stock: string, holds: string, hold: string, reservationId: string): Promise<number>;
  confirmUnits(stock: string, holds: string, hold: string, reservationId: string): Promise<number>;
}

const redis = new Redis({host: 'redis', port: 6379}) as StockRedis;
redis.defineCommand('reserveUnits', {numberOfKeys: 3, lua: RESERVE_LUA});
redis.defineCommand('releaseUnits', {numberOfKeys: 3, lua: RELEASE_LUA});
redis.defineCommand('confirmUnits', {numberOfKeys: 3, lua: CONFIRM_LUA});

export const stockKey = (sku: string): string => \`stock:\${sku}\`;
export const holdsKey = (sku: string): string => \`holds:\${sku}\`;
export const holdKey = (reservationId: string): string => \`hold:\${reservationId}\`;

/** Hold quantity units for the reservation; false when the sku has fewer available. */
export async function reserve(sku: string, quantity: number, reservationId: string): Promise<boolean> {
  const held = await redis.reserveUnits(stockKey(sku), holdsKey(sku), holdKey(reservationId), quantity, reservationId, RESERVATION_TTL_S);
  return Number(held) === 1;
}

/** Give the reservation's units back; the units released (0 when it holds none). */
export async function release(sku: string, reservationId: string): Promise<number> {
  return Number(await redis.releaseUnits(stockKey(sku), holdsKey(sku), holdKey(reservationId), reservationId));
}

/** The warehouse allocated the units: the hold becomes a sale; the units sold. */
export async function confirm(sku: string, reservationId: string): Promise<number> {
  return Number(await redis.confirmUnits(stockKey(sku), holdsKey(sku), holdKey(reservationId), reservationId));
}
`,
  'inventory/store.ts': `/**
 * The reservation store and the outbox, in Redis: a reservation is the hash reservation:{id}
 * (status is reserved, pending, confirmed or rejected), idem:{tenant}:{key} points a tenant's
 * Idempotency-Key at its reservation, and the outbox is the list outbox of JSON rows
 * {"topic", "key", "payload"} a relay publishes later.
 */
import {randomUUID} from 'node:crypto';

import Redis from 'ioredis';

export interface Reservation {
  reservation_id: string;
  tenant: string;
  idempotency_key: string;
  sku: string;
  quantity: number;
  status: string;
  /** Epoch seconds. */
  expires_at: number;
}

const redis = new Redis({host: 'redis', port: 6379});

export const newId = (): string => randomUUID();

export const store = {
  /** The reservation, or null. */
  async get(reservationId: string): Promise<Reservation | null> {
    const f = await redis.hgetall(\`reservation:\${reservationId}\`);
    if (Object.keys(f).length === 0) return null;
    return {
      reservation_id: f.reservation_id,
      tenant: f.tenant,
      idempotency_key: f.idempotency_key,
      sku: f.sku,
      quantity: Number(f.quantity),
      status: f.status,
      expires_at: Number(f.expires_at),
    };
  },
  /** The reservation a tenant's Idempotency-Key was first used for, or null. */
  async getByKey(tenant: string, idempotencyKey: string): Promise<Reservation | null> {
    const reservationId = await redis.get(\`idem:\${tenant}:\${idempotencyKey}\`);
    return reservationId === null ? null : store.get(reservationId);
  },
  /** Commit the reservation: write it and index it under its idempotency key. */
  async put(reservation: Reservation): Promise<void> {
    const row: Record<string, string> = {};
    for (const [field, value] of Object.entries(reservation)) row[field] = String(value);
    await redis
      .multi()
      .hset(\`reservation:\${reservation.reservation_id}\`, row)
      .set(\`idem:\${reservation.tenant}:\${reservation.idempotency_key}\`, reservation.reservation_id)
      .exec();
  },
  async setStatus(reservationId: string, status: string): Promise<void> {
    await redis.hset(\`reservation:\${reservationId}\`, 'status', status);
  },
};

export const outbox = {
  /** Queue a record for the relay to publish later. */
  async insert(topic: string, key: string, payload: unknown): Promise<void> {
    await redis.rpush('outbox', JSON.stringify({topic, key, payload}));
  },
  /** Everything queued, oldest first. */
  async rows(): Promise<{topic: string; key: string; payload: unknown}[]> {
    return (await redis.lrange('outbox', 0, -1)).map(row => JSON.parse(row));
  },
};
`,
};

export const supportModulesGo: Record<string, string> = {
  'inventory/catalog/catalog.go': `// Package catalog is the sku catalogue (provided): sku:{sku} is a hash with the tenant that sells
// the sku and synced_at, the epoch second at which the warehouse sync last wrote the sku's stock
// counter.
package catalog

import (
	"context"
	"strconv"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// Key is the catalogue hash of a sku.
func Key(sku string) string { return "sku:" + sku }

// Owner is the tenant that sells the sku, or "" for a sku the catalogue does not know.
func Owner(ctx context.Context, sku string) string {
	return rdb.HGet(ctx, Key(sku), "tenant").Val()
}

// SyncedAt is when the warehouse sync last wrote stock:{sku}, in epoch seconds, and whether it did.
func SyncedAt(ctx context.Context, sku string) (int64, bool) {
	value, err := strconv.ParseInt(rdb.HGet(ctx, Key(sku), "synced_at").Val(), 10, 64)
	return value, err == nil
}
`,
  'inventory/stock/stock.go': `// Package stock is the stock counter and the hold map (provided; step 2 builds the same three
// transitions). stock:{sku} is the units available to reserve. holds:{sku} maps every reservation
// holding units of the sku to its quantity, and hold:{reservation_id} lives for ReservationTTLS: a
// reservation whose hold key expired still sits in holds:{sku} until the next reserve gives its
// units back.
package stock

import (
	"context"

	"github.com/redis/go-redis/v9"
)

// ReservationTTLS is how long a cart holds its units: 15 minutes.
const ReservationTTLS = 900

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// KEYS: stock:{sku}, holds:{sku}, hold:{reservation_id}. ARGV: quantity, reservation_id, ttl.
var reserveScript = redis.NewScript(\`
local entries = redis.call('HGETALL', KEYS[2])
for i = 1, #entries, 2 do
  if redis.call('EXISTS', 'hold:' .. entries[i]) == 0 then
    redis.call('HDEL', KEYS[2], entries[i])
    redis.call('INCRBY', KEYS[1], entries[i + 1])
  end
end
local quantity = tonumber(ARGV[1])
if tonumber(redis.call('GET', KEYS[1]) or '0') < quantity then return 0 end
redis.call('DECRBY', KEYS[1], quantity)
redis.call('HSET', KEYS[2], ARGV[2], quantity)
redis.call('SET', KEYS[3], quantity, 'EX', ARGV[3])
return 1
\`)

// Same KEYS. ARGV: reservation_id. Gives the units back once: only while the hold is in the map.
var releaseScript = redis.NewScript(\`
local quantity = redis.call('HGET', KEYS[2], ARGV[1])
if not quantity then return 0 end
redis.call('HDEL', KEYS[2], ARGV[1])
redis.call('DEL', KEYS[3])
redis.call('INCRBY', KEYS[1], quantity)
return tonumber(quantity)
\`)

// Same KEYS. ARGV: reservation_id. The units are sold: the hold leaves the map, the counter stays.
var confirmScript = redis.NewScript(\`
local quantity = redis.call('HGET', KEYS[2], ARGV[1])
if not quantity then return 0 end
redis.call('HDEL', KEYS[2], ARGV[1])
redis.call('DEL', KEYS[3])
return tonumber(quantity)
\`)

// Key is the units of the sku available to reserve.
func Key(sku string) string { return "stock:" + sku }

// HoldsKey maps the reservations holding units of the sku to their quantities.
func HoldsKey(sku string) string { return "holds:" + sku }

// HoldKey lives while the reservation holds its units.
func HoldKey(reservationID string) string { return "hold:" + reservationID }

func keys(sku, reservationID string) []string {
	return []string{Key(sku), HoldsKey(sku), HoldKey(reservationID)}
}

// Reserve holds quantity units for the reservation; false when the sku has fewer available.
func Reserve(ctx context.Context, sku string, quantity int, reservationID string) (bool, error) {
	held, err := reserveScript.Run(ctx, rdb, keys(sku, reservationID), quantity, reservationID, ReservationTTLS).Int()
	return held == 1, err
}

// Release gives the reservation's units back and returns how many (0 when it holds none).
func Release(ctx context.Context, sku, reservationID string) (int, error) {
	return releaseScript.Run(ctx, rdb, keys(sku, reservationID), reservationID).Int()
}

// Confirm turns the hold into a sale after the warehouse allocated the units; it returns the units sold.
func Confirm(ctx context.Context, sku, reservationID string) (int, error) {
	return confirmScript.Run(ctx, rdb, keys(sku, reservationID), reservationID).Int()
}
`,
  'inventory/store/store.go': `// Package store is the reservation store and the outbox, in Redis: a reservation is the hash
// reservation:{id} (every field a string; status is reserved, pending, confirmed or rejected),
// idem:{tenant}:{key} points a tenant's Idempotency-Key at its reservation, and the outbox is the
// list outbox of JSON rows {"topic", "key", "payload"} a relay publishes later.
package store

import (
	"context"
	"encoding/json"
	"strconv"

	"github.com/google/uuid"
	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// Reservation is one reservation as the store holds it; ExpiresAt is in epoch seconds.
type Reservation struct {
	ReservationID  string \`json:"reservation_id"\`
	Tenant         string \`json:"tenant"\`
	IdempotencyKey string \`json:"idempotency_key"\`
	SKU            string \`json:"sku"\`
	Quantity       int    \`json:"quantity"\`
	Status         string \`json:"status"\`
	ExpiresAt      int64  \`json:"expires_at"\`
}

func NewID() string { return uuid.NewString() }

// Get is the reservation, or nil.
func Get(ctx context.Context, reservationID string) (*Reservation, error) {
	f, err := rdb.HGetAll(ctx, "reservation:"+reservationID).Result()
	if err != nil || len(f) == 0 {
		return nil, err
	}
	quantity, _ := strconv.Atoi(f["quantity"])
	expiresAt, _ := strconv.ParseInt(f["expires_at"], 10, 64)
	return &Reservation{
		ReservationID: f["reservation_id"], Tenant: f["tenant"], IdempotencyKey: f["idempotency_key"],
		SKU: f["sku"], Quantity: quantity, Status: f["status"], ExpiresAt: expiresAt,
	}, nil
}

// GetByKey is the reservation a tenant's Idempotency-Key was first used for, or nil.
func GetByKey(ctx context.Context, tenant, idempotencyKey string) (*Reservation, error) {
	reservationID, err := rdb.Get(ctx, "idem:"+tenant+":"+idempotencyKey).Result()
	if err == redis.Nil {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return Get(ctx, reservationID)
}

// Put commits the reservation: writes it and indexes it under its idempotency key.
func Put(ctx context.Context, r *Reservation) error {
	pipe := rdb.TxPipeline()
	pipe.HSet(ctx, "reservation:"+r.ReservationID, map[string]any{
		"reservation_id": r.ReservationID, "tenant": r.Tenant, "idempotency_key": r.IdempotencyKey, "sku": r.SKU,
		"quantity": strconv.Itoa(r.Quantity), "status": r.Status, "expires_at": strconv.FormatInt(r.ExpiresAt, 10),
	})
	pipe.Set(ctx, "idem:"+r.Tenant+":"+r.IdempotencyKey, r.ReservationID, 0)
	_, err := pipe.Exec(ctx)
	return err
}

// SetStatus records the reservation's status.
func SetStatus(ctx context.Context, reservationID, status string) error {
	return rdb.HSet(ctx, "reservation:"+reservationID, "status", status).Err()
}

// OutboxRow is one row of the outbox.
type OutboxRow struct {
	Topic   string          \`json:"topic"\`
	Key     string          \`json:"key"\`
	Payload json.RawMessage \`json:"payload"\`
}

// InsertOutbox queues a record for the relay to publish later.
func InsertOutbox(ctx context.Context, topic, key string, payload any) error {
	raw, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	row, _ := json.Marshal(OutboxRow{Topic: topic, Key: key, Payload: raw})
	return rdb.RPush(ctx, "outbox", row).Err()
}

// OutboxRows is everything queued, oldest first.
func OutboxRows(ctx context.Context) ([]OutboxRow, error) {
	raw, err := rdb.LRange(ctx, "outbox", 0, -1).Result()
	if err != nil {
		return nil, err
	}
	rows := make([]OutboxRow, 0, len(raw))
	for _, text := range raw {
		var row OutboxRow
		if err := json.Unmarshal([]byte(text), &row); err != nil {
			return nil, err
		}
		rows = append(rows, row)
	}
	return rows, nil
}
`,
};

export const supportModulesCpp: Record<string, string> = {
  'inventory/catalog.h': `// The sku catalogue (provided): sku:{sku} is a hash with the tenant that sells the sku and
// synced_at, the epoch second at which the warehouse sync last wrote the sku's stock counter.
#pragma once

#include <sw/redis++/redis++.h>

#include <optional>
#include <string>

namespace inventory::catalog {

inline sw::redis::Redis& client() {
  static sw::redis::Redis redis("tcp://redis:6379");
  return redis;
}

inline std::string Key(const std::string& sku) { return "sku:" + sku; }

// The tenant that sells the sku, or none for a sku the catalogue does not know.
inline std::optional<std::string> Owner(const std::string& sku) {
  const auto tenant = client().hget(Key(sku), "tenant");
  if (!tenant || tenant->empty()) return std::nullopt;
  return tenant;
}

// When the warehouse sync last wrote stock:{sku}, in epoch seconds; none if it never did.
inline std::optional<long long> SyncedAt(const std::string& sku) {
  const auto value = client().hget(Key(sku), "synced_at");
  if (!value || value->empty()) return std::nullopt;
  return std::stoll(*value);
}

}  // namespace inventory::catalog
`,
  'inventory/stock.h': `// The stock counter and the hold map (provided; step 2 builds the same three transitions).
// stock:{sku} is the units available to reserve. holds:{sku} maps every reservation holding units
// of the sku to its quantity, and hold:{reservation_id} lives for kReservationTtlS: a reservation
// whose hold key expired still sits in holds:{sku} until the next reserve gives its units back.
#pragma once

#include <sw/redis++/redis++.h>

#include <string>
#include <vector>

namespace inventory::stock {

constexpr int kReservationTtlS = 900;  // a cart holds its units for 15 minutes

// KEYS: stock:{sku}, holds:{sku}, hold:{reservation_id}. ARGV: quantity, reservation_id, ttl.
inline const std::string kReserveLua = R"lua(
local entries = redis.call('HGETALL', KEYS[2])
for i = 1, #entries, 2 do
  if redis.call('EXISTS', 'hold:' .. entries[i]) == 0 then
    redis.call('HDEL', KEYS[2], entries[i])
    redis.call('INCRBY', KEYS[1], entries[i + 1])
  end
end
local quantity = tonumber(ARGV[1])
if tonumber(redis.call('GET', KEYS[1]) or '0') < quantity then return 0 end
redis.call('DECRBY', KEYS[1], quantity)
redis.call('HSET', KEYS[2], ARGV[2], quantity)
redis.call('SET', KEYS[3], quantity, 'EX', ARGV[3])
return 1
)lua";

// Same KEYS. ARGV: reservation_id. Gives the units back once: only while the hold is in the map.
inline const std::string kReleaseLua = R"lua(
local quantity = redis.call('HGET', KEYS[2], ARGV[1])
if not quantity then return 0 end
redis.call('HDEL', KEYS[2], ARGV[1])
redis.call('DEL', KEYS[3])
redis.call('INCRBY', KEYS[1], quantity)
return tonumber(quantity)
)lua";

// Same KEYS. ARGV: reservation_id. The units are sold: the hold leaves the map, the counter stays.
inline const std::string kConfirmLua = R"lua(
local quantity = redis.call('HGET', KEYS[2], ARGV[1])
if not quantity then return 0 end
redis.call('HDEL', KEYS[2], ARGV[1])
redis.call('DEL', KEYS[3])
return tonumber(quantity)
)lua";

inline sw::redis::Redis& client() {
  static sw::redis::Redis redis("tcp://redis:6379");
  return redis;
}

inline std::string Key(const std::string& sku) { return "stock:" + sku; }
inline std::string HoldsKey(const std::string& sku) { return "holds:" + sku; }
inline std::string HoldKey(const std::string& reservation_id) { return "hold:" + reservation_id; }

// Hold quantity units for the reservation; false when the sku has fewer available.
inline bool Reserve(const std::string& sku, int quantity, const std::string& reservation_id) {
  const std::vector<std::string> keys = {Key(sku), HoldsKey(sku), HoldKey(reservation_id)};
  const std::vector<std::string> args = {std::to_string(quantity), reservation_id, std::to_string(kReservationTtlS)};
  return client().eval<long long>(kReserveLua, keys, args) == 1;
}

// Give the reservation's units back; the units released (0 when it holds none).
inline long long Release(const std::string& sku, const std::string& reservation_id) {
  const std::vector<std::string> keys = {Key(sku), HoldsKey(sku), HoldKey(reservation_id)};
  const std::vector<std::string> args = {reservation_id};
  return client().eval<long long>(kReleaseLua, keys, args);
}

// The warehouse allocated the units: the hold becomes a sale; the units sold.
inline long long Confirm(const std::string& sku, const std::string& reservation_id) {
  const std::vector<std::string> keys = {Key(sku), HoldsKey(sku), HoldKey(reservation_id)};
  const std::vector<std::string> args = {reservation_id};
  return client().eval<long long>(kConfirmLua, keys, args);
}

}  // namespace inventory::stock
`,
  'inventory/store.h': `// The reservation store and the outbox, in Redis: a reservation is the hash reservation:{id}
// (every field a string; status is reserved, pending, confirmed or rejected), idem:{tenant}:{key}
// points a tenant's Idempotency-Key at its reservation, and the outbox is the list outbox of JSON
// rows {"topic", "key", "payload"} a relay publishes later.
#pragma once

#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>
#include <uuid/uuid.h>

#include <optional>
#include <string>
#include <unordered_map>
#include <vector>

namespace inventory {

// One reservation as the store holds it; expires_at is in epoch seconds.
struct Reservation {
  std::string reservation_id;
  std::string tenant;
  std::string idempotency_key;
  std::string sku;
  int quantity = 0;
  std::string status;
  long long expires_at = 0;
};

inline void to_json(nlohmann::json& j, const Reservation& r) {
  j = nlohmann::json{{"reservation_id", r.reservation_id}, {"tenant", r.tenant}, {"idempotency_key", r.idempotency_key},
                     {"sku", r.sku}, {"quantity", r.quantity}, {"status", r.status}, {"expires_at", r.expires_at}};
}

inline std::string NewId() {
  uuid_t id;
  uuid_generate(id);
  char text[37];
  uuid_unparse_lower(id, text);
  return text;
}

namespace store {

inline sw::redis::Redis& client() {
  static sw::redis::Redis redis("tcp://redis:6379");
  return redis;
}

// The reservation, if the store has it.
inline std::optional<Reservation> Get(const std::string& reservation_id) {
  std::unordered_map<std::string, std::string> f = client().hgetall("reservation:" + reservation_id);
  if (f.empty()) return std::nullopt;
  return Reservation{f["reservation_id"], f["tenant"], f["idempotency_key"], f["sku"],
                     f["quantity"].empty() ? 0 : std::stoi(f["quantity"]), f["status"],
                     f["expires_at"].empty() ? 0 : std::stoll(f["expires_at"])};
}

// The reservation a tenant's Idempotency-Key was first used for, if any.
inline std::optional<Reservation> GetByKey(const std::string& tenant, const std::string& idempotency_key) {
  const auto reservation_id = client().get("idem:" + tenant + ":" + idempotency_key);
  if (!reservation_id) return std::nullopt;
  return Get(*reservation_id);
}

// Commit the reservation: write it and index it under its idempotency key.
inline void Put(const Reservation& r) {
  auto tx = client().transaction();
  tx.hset("reservation:" + r.reservation_id, {std::pair<std::string, std::string>{"reservation_id", r.reservation_id},
                                              {"tenant", r.tenant},
                                              {"idempotency_key", r.idempotency_key},
                                              {"sku", r.sku},
                                              {"quantity", std::to_string(r.quantity)},
                                              {"status", r.status},
                                              {"expires_at", std::to_string(r.expires_at)}})
      .set("idem:" + r.tenant + ":" + r.idempotency_key, r.reservation_id)
      .exec();
}

// Record the reservation's status.
inline void SetStatus(const std::string& reservation_id, const std::string& status) {
  client().hset("reservation:" + reservation_id, "status", status);
}

}  // namespace store

namespace outbox {

// Queue a record for the relay to publish later.
inline void Insert(const std::string& topic, const std::string& key, const nlohmann::json& payload) {
  store::client().rpush("outbox", nlohmann::json{{"topic", topic}, {"key", key}, {"payload", payload}}.dump());
}

// Everything queued, oldest first.
inline std::vector<nlohmann::json> Rows() {
  std::vector<nlohmann::json> rows;
  for (const std::string& row : store::client().lrange("outbox", 0, -1)) rows.push_back(nlohmann::json::parse(row));
  return rows;
}

}  // namespace outbox

}  // namespace inventory
`,
};

export const supportModulesScala: Record<string, string> = {
  [scalaPath('inventory', 'Catalog')]: `package inventory

import redis.clients.jedis.JedisPooled

/**
 * The sku catalogue (provided): sku:{sku} is a hash with the tenant that sells the sku and
 * synced_at, the epoch second at which the warehouse sync last wrote the sku's stock counter.
 */
object Catalog {
  val jedis = new JedisPooled("redis", 6379)

  def key(sku: String): String = s"sku:$sku"

  /** The tenant that sells the sku, or None for a sku the catalogue does not know. */
  def owner(sku: String): Option[String] = Option(jedis.hget(key(sku), "tenant")).filter(_.nonEmpty)

  /** When the warehouse sync last wrote stock:{sku}, in epoch seconds; None if it never did. */
  def syncedAt(sku: String): Option[Long] = Option(jedis.hget(key(sku), "synced_at")).filter(_.nonEmpty).map(_.toLong)
}
`,
  [scalaPath('inventory', 'Stock')]: `package inventory

import scala.jdk.CollectionConverters._

import redis.clients.jedis.JedisPooled

/**
 * The stock counter and the hold map (provided; step 2 builds the same three transitions).
 * stock:{sku} is the units available to reserve. holds:{sku} maps every reservation holding units
 * of the sku to its quantity, and hold:{reservation_id} lives for ReservationTtlS: a reservation
 * whose hold key expired still sits in holds:{sku} until the next reserve gives its units back.
 */
object Stock {
  val ReservationTtlS = 900 // a cart holds its units for 15 minutes

  val jedis = new JedisPooled("redis", 6379)

  /** KEYS: stock:{sku}, holds:{sku}, hold:{reservation_id}. ARGV: quantity, reservation_id, ttl. */
  val ReserveLua: String =
    """
      |local entries = redis.call('HGETALL', KEYS[2])
      |for i = 1, #entries, 2 do
      |  if redis.call('EXISTS', 'hold:' .. entries[i]) == 0 then
      |    redis.call('HDEL', KEYS[2], entries[i])
      |    redis.call('INCRBY', KEYS[1], entries[i + 1])
      |  end
      |end
      |local quantity = tonumber(ARGV[1])
      |if tonumber(redis.call('GET', KEYS[1]) or '0') < quantity then return 0 end
      |redis.call('DECRBY', KEYS[1], quantity)
      |redis.call('HSET', KEYS[2], ARGV[2], quantity)
      |redis.call('SET', KEYS[3], quantity, 'EX', ARGV[3])
      |return 1
      |""".stripMargin

  /** Same KEYS. ARGV: reservation_id. Gives the units back once: only while the hold is in the map. */
  val ReleaseLua: String =
    """
      |local quantity = redis.call('HGET', KEYS[2], ARGV[1])
      |if not quantity then return 0 end
      |redis.call('HDEL', KEYS[2], ARGV[1])
      |redis.call('DEL', KEYS[3])
      |redis.call('INCRBY', KEYS[1], quantity)
      |return tonumber(quantity)
      |""".stripMargin

  /** Same KEYS. ARGV: reservation_id. The units are sold: the hold leaves the map, the counter stays. */
  val ConfirmLua: String =
    """
      |local quantity = redis.call('HGET', KEYS[2], ARGV[1])
      |if not quantity then return 0 end
      |redis.call('HDEL', KEYS[2], ARGV[1])
      |redis.call('DEL', KEYS[3])
      |return tonumber(quantity)
      |""".stripMargin

  def key(sku: String): String = s"stock:$sku"
  def holdsKey(sku: String): String = s"holds:$sku"
  def holdKey(reservationId: String): String = s"hold:$reservationId"

  private def run(script: String, sku: String, reservationId: String, args: Seq[String]): Long =
    jedis.eval(script, List(key(sku), holdsKey(sku), holdKey(reservationId)).asJava, args.asJava).asInstanceOf[java.lang.Long]

  /** Hold quantity units for the reservation; false when the sku has fewer available. */
  def reserve(sku: String, quantity: Int, reservationId: String): Boolean =
    run(ReserveLua, sku, reservationId, Seq(quantity.toString, reservationId, ReservationTtlS.toString)) == 1L

  /** Give the reservation's units back; the units released (0 when it holds none). */
  def release(sku: String, reservationId: String): Long = run(ReleaseLua, sku, reservationId, Seq(reservationId))

  /** The warehouse allocated the units: the hold becomes a sale; the units sold. */
  def confirm(sku: String, reservationId: String): Long = run(ConfirmLua, sku, reservationId, Seq(reservationId))
}
`,
  [scalaPath('inventory', 'Store')]: `package inventory

import java.util.UUID

import scala.jdk.CollectionConverters._

import redis.clients.jedis.JedisPooled
import spray.json._
import spray.json.DefaultJsonProtocol._

/** One reservation as the store holds it; status is reserved, pending, confirmed or rejected; expires_at is in epoch seconds. */
final case class Reservation(
    reservation_id: String,
    tenant: String,
    idempotency_key: String,
    sku: String,
    quantity: Int,
    status: String,
    expires_at: Long
)

object Reservation {
  implicit val format: RootJsonFormat[Reservation] = jsonFormat7(Reservation.apply)
}

/**
 * The reservation store and the outbox, in Redis: a reservation is the hash reservation:{id} (every
 * field a string), idem:{tenant}:{key} points a tenant's Idempotency-Key at its reservation, and the
 * outbox is the list outbox of JSON rows {"topic", "key", "payload"} a relay publishes later.
 */
object Store {
  val jedis = new JedisPooled("redis", 6379)

  def newId(): String = UUID.randomUUID().toString

  /** The reservation, if the store has it. */
  def get(reservationId: String): Option[Reservation] = {
    val f = jedis.hgetAll(s"reservation:$reservationId").asScala
    if (f.isEmpty) None
    else
      Some(
        Reservation(
          f.getOrElse("reservation_id", ""),
          f.getOrElse("tenant", ""),
          f.getOrElse("idempotency_key", ""),
          f.getOrElse("sku", ""),
          f.get("quantity").filter(_.nonEmpty).map(_.toInt).getOrElse(0),
          f.getOrElse("status", ""),
          f.get("expires_at").filter(_.nonEmpty).map(_.toLong).getOrElse(0L)
        )
      )
  }

  /** The reservation a tenant's Idempotency-Key was first used for, if any. */
  def getByKey(tenant: String, idempotencyKey: String): Option[Reservation] =
    Option(jedis.get(s"idem:$tenant:$idempotencyKey")).flatMap(get)

  /** Commit the reservation: write it and index it under its idempotency key. */
  def put(r: Reservation): Unit = {
    val fields = Map(
      "reservation_id" -> r.reservation_id,
      "tenant" -> r.tenant,
      "idempotency_key" -> r.idempotency_key,
      "sku" -> r.sku,
      "quantity" -> r.quantity.toString,
      "status" -> r.status,
      "expires_at" -> r.expires_at.toString
    )
    val tx = jedis.multi()
    tx.hset(s"reservation:\${r.reservation_id}", fields.asJava)
    tx.set(s"idem:\${r.tenant}:\${r.idempotency_key}", r.reservation_id)
    tx.exec()
  }

  /** Record the reservation's status. */
  def setStatus(reservationId: String, status: String): Unit = jedis.hset(s"reservation:$reservationId", "status", status)

  /** Queue a record for the relay to publish later. */
  def insertOutbox(topic: String, key: String, payload: JsValue): Unit =
    jedis.rpush("outbox", JsObject("topic" -> JsString(topic), "key" -> JsString(key), "payload" -> payload).compactPrint)

  /** Everything queued, oldest first. */
  def outboxRows(): Seq[JsValue] = jedis.lrange("outbox", 0, -1).asScala.toSeq.map(_.parseJson)
}
`,
};
