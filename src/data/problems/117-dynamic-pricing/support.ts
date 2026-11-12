/**
 * Hand-written support modules the dynamic-pricing steps import but no step builds: the `pricing`
 * package. `pricing.store` is the price store (one Redis hash per sku, the course's stand-in for the
 * pricing database, plus experiment candidates). `pricing.guard` is the per-window headroom guard
 * of step 2 as later steps use it: `reserve` (the Lua reservation) and `window_state`.
 * `pricing.outbox` is the outbox the event step falls back to. The five languages keep the same
 * keys, so a harness reads one layout whatever the stack.
 */
import {scalaPath} from '../scala-support';

export const supportModules: Record<string, string> = {
  'pricing/__init__.py': '',
  'pricing/store.py': `"""
The price store (provided): price:{sku} is a hash holding the sku's published price: sku,
price_cents, previous_price_cents, source (seed, operator, demand-model or last-approved), reason,
updated_at (unix seconds) and stale ("1" while the last approved price is kept because its source
is down). candidate:{sku} holds an experiment's candidate price and the model version that
proposed it. A row is a dict: the integers as int, stale as a bool.
"""
import time

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)


def price_key(sku: str) -> str:
    return f"price:{sku}"


def candidate_key(sku: str) -> str:
    return f"candidate:{sku}"


def _row(raw: dict) -> dict | None:
    if not raw:
        return None
    return {
        "sku": raw["sku"],
        "price_cents": int(raw["price_cents"]),
        "previous_price_cents": int(raw["previous_price_cents"]),
        "source": raw["source"],
        "reason": raw["reason"],
        "updated_at": int(raw["updated_at"]),
        "stale": raw.get("stale") == "1",
    }


def get_sku(sku: str) -> dict | None:
    """The sku's published row, or None when the sku does not exist."""
    return _row(r.hgetall(price_key(sku)))


def publish(sku: str, price_cents: int, reason: str, source: str) -> dict:
    """Commit price_cents as the sku's price (a new sku gets its row): previous_price_cents is the price it replaces, updated_at is now, stale is cleared. Returns the row."""
    current = get_sku(sku)
    r.hset(
        price_key(sku),
        mapping={
            "sku": sku,
            "price_cents": price_cents,
            "previous_price_cents": current["price_cents"] if current else price_cents,
            "source": source,
            "reason": reason,
            "updated_at": int(time.time()),
            "stale": "0",
        },
    )
    return get_sku(sku)


def seed(sku: str, price_cents: int) -> dict:
    """A new sku priced at price_cents (source seed)."""
    return publish(sku, price_cents, "initial price", "seed")


def mark_stale(sku: str) -> dict | None:
    """Keep the sku's last approved price while its source is down: price_cents and updated_at stay, source becomes last-approved, stale is set. Returns the row, or None for an unknown sku."""
    if not r.exists(price_key(sku)):
        return None
    r.hset(price_key(sku), mapping={"source": "last-approved", "stale": "1"})
    return get_sku(sku)


def candidate_of(sku: str) -> dict | None:
    """The experiment's candidate for the sku (sku, price_cents, model_version), or None."""
    raw = r.hgetall(candidate_key(sku))
    if not raw:
        return None
    return {"sku": sku, "price_cents": int(raw["price_cents"]), "model_version": raw["model_version"]}


def set_candidate(sku: str, price_cents: int, model_version: str) -> None:
    """Record the experiment's candidate price for the sku."""
    r.hset(candidate_key(sku), mapping={"price_cents": price_cents, "model_version": model_version})
`,
  'pricing/guard.py': `"""
The window guard (provided; step 2 builds reserve the same way): guard:{sku}:{window} is a hash
whose moved_bp field counts the basis points of price movement the sku has spent in its hour
window (window = unix time // WINDOW_S); the key expires with its window. reserve checks a change
against the MAX_MOVE_BP the window allows and spends it in one Lua script; window_state reads the
window back.
"""
import time

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

WINDOW_S = 3600
MAX_MOVE_BP = 2000

# KEYS[1] the window's hash; ARGV: the change's basis points, the limit, the window's TTL.
# Returns {1 spent | 0 refused, the basis points the window had available before this change}.
RESERVE_LUA = """
local moved = tonumber(redis.call('HGET', KEYS[1], 'moved_bp') or '0')
local available = tonumber(ARGV[2]) - moved
local move = tonumber(ARGV[1])
if move > available then
  return {0, available}
end
redis.call('HINCRBY', KEYS[1], 'moved_bp', move)
if redis.call('TTL', KEYS[1]) < 0 then
  redis.call('EXPIRE', KEYS[1], ARGV[3])
end
return {1, available}
"""
_reserve = r.register_script(RESERVE_LUA)


def window_of(now: float) -> int:
    return int(now) // WINDOW_S


def guard_key(sku: str, window: int) -> str:
    return f"guard:{sku}:{window}"


def move_bp(current_cents: int, target_cents: int) -> int:
    """The change from current_cents to target_cents in basis points of the current price."""
    return abs(target_cents - current_cents) * 10_000 // current_cents


def bound_cents(current_cents: int, target_cents: int, available_bp: int) -> int:
    """The furthest price available_bp allows from current_cents, in the direction of target_cents."""
    delta = current_cents * available_bp // 10_000
    return current_cents + delta if target_cents >= current_cents else current_cents - delta


def reserve(sku: str, current_cents: int, target_cents: int) -> dict:
    """Spend the change's basis points from the sku's window, or refuse it. Returns ok, moved_bp (this change), headroom_bp (left in the window afterwards) and bound_cents (the furthest price the window allowed from current_cents)."""
    move = move_bp(current_cents, target_cents)
    ok, available = _reserve(keys=[guard_key(sku, window_of(time.time()))], args=[move, MAX_MOVE_BP, WINDOW_S])
    return {
        "ok": ok == 1,
        "moved_bp": move,
        "headroom_bp": available - move if ok == 1 else available,
        "bound_cents": bound_cents(current_cents, target_cents, available),
    }


def window_state(sku: str) -> dict:
    """The sku's current window: window, moved_bp (spent so far), limit_bp and headroom_bp."""
    window = window_of(time.time())
    moved = int(r.hget(guard_key(sku, window), "moved_bp") or 0)
    return {"window": window, "moved_bp": moved, "limit_bp": MAX_MOVE_BP, "headroom_bp": MAX_MOVE_BP - moved}
`,
  'pricing/outbox.py': `"""
The outbox (provided): the Redis list outbox holds JSON rows {"topic", "key", "payload"} that a relay
republishes once the broker takes records again.
"""
import json

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

OUTBOX_KEY = "outbox"


def insert(topic: str, key: str, payload: dict) -> None:
    """Keep a record the broker did not take, for the relay."""
    r.rpush(OUTBOX_KEY, json.dumps({"topic": topic, "key": key, "payload": payload}))
`,
};

export const supportModulesTs: Record<string, string> = {
  'pricing/store.ts': `/**
 * The price store (provided): price:{sku} is a hash holding the sku's published price: sku,
 * price_cents, previous_price_cents, source (seed, operator, demand-model or last-approved), reason,
 * updated_at (unix seconds) and stale ("1" while the last approved price is kept because its source
 * is down). candidate:{sku} holds an experiment's candidate price and the model version that
 * proposed it.
 */
import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

export interface Row {
  sku: string;
  price_cents: number;
  previous_price_cents: number;
  source: string;
  reason: string;
  updated_at: number;
  stale: boolean;
}

export interface Candidate {
  sku: string;
  price_cents: number;
  model_version: string;
}

export const priceKey = (sku: string): string => \`price:\${sku}\`;
export const candidateKey = (sku: string): string => \`candidate:\${sku}\`;

function row(raw: Record<string, string>): Row | null {
  if (Object.keys(raw).length === 0) return null;
  return {
    sku: raw.sku,
    price_cents: Number(raw.price_cents),
    previous_price_cents: Number(raw.previous_price_cents),
    source: raw.source,
    reason: raw.reason,
    updated_at: Number(raw.updated_at),
    stale: raw.stale === '1',
  };
}

/** The sku's published row, or null when the sku does not exist. */
export async function getSku(sku: string): Promise<Row | null> {
  return row(await redis.hgetall(priceKey(sku)));
}

/** Commit priceCents as the sku's price (a new sku gets its row): previous_price_cents is the price it replaces, updated_at is now, stale is cleared. */
export async function publish(sku: string, priceCents: number, reason: string, source: string): Promise<Row> {
  const current = await getSku(sku);
  await redis.hset(priceKey(sku), {
    sku,
    price_cents: String(priceCents),
    previous_price_cents: String(current === null ? priceCents : current.price_cents),
    source,
    reason,
    updated_at: String(Math.floor(Date.now() / 1000)),
    stale: '0',
  });
  return (await getSku(sku)) as Row;
}

/** A new sku priced at priceCents (source seed). */
export const seed = (sku: string, priceCents: number): Promise<Row> => publish(sku, priceCents, 'initial price', 'seed');

/** Keep the sku's last approved price while its source is down: price_cents and updated_at stay, source becomes last-approved, stale is set. Null for an unknown sku. */
export async function markStale(sku: string): Promise<Row | null> {
  if ((await redis.exists(priceKey(sku))) === 0) return null;
  await redis.hset(priceKey(sku), {source: 'last-approved', stale: '1'});
  return getSku(sku);
}

/** The experiment's candidate for the sku, or null. */
export async function candidateOf(sku: string): Promise<Candidate | null> {
  const raw = await redis.hgetall(candidateKey(sku));
  if (Object.keys(raw).length === 0) return null;
  return {sku, price_cents: Number(raw.price_cents), model_version: raw.model_version};
}

/** Record the experiment's candidate price for the sku. */
export async function setCandidate(sku: string, priceCents: number, modelVersion: string): Promise<void> {
  await redis.hset(candidateKey(sku), {price_cents: String(priceCents), model_version: modelVersion});
}
`,
  'pricing/guard.ts': `/**
 * The window guard (provided; step 2 builds reserve the same way): guard:{sku}:{window} is a hash
 * whose moved_bp field counts the basis points of price movement the sku has spent in its hour
 * window (window = unix seconds / WINDOW_S, floored); the key expires with its window. reserve
 * checks a change against the MAX_MOVE_BP the window allows and spends it in one Lua script;
 * windowState reads the window back.
 */
import Redis from 'ioredis';

export const WINDOW_S = 3600;
export const MAX_MOVE_BP = 2000;

/**
 * KEYS[1] the window's hash; ARGV: the change's basis points, the limit, the window's TTL. Returns
 * {1 spent | 0 refused, the basis points the window had available before this change}.
 */
export const RESERVE_LUA = \`
local moved = tonumber(redis.call('HGET', KEYS[1], 'moved_bp') or '0')
local available = tonumber(ARGV[2]) - moved
local move = tonumber(ARGV[1])
if move > available then
  return {0, available}
end
redis.call('HINCRBY', KEYS[1], 'moved_bp', move)
if redis.call('TTL', KEYS[1]) < 0 then
  redis.call('EXPIRE', KEYS[1], ARGV[3])
end
return {1, available}
\`;

interface GuardRedis extends Redis {
  reserveHeadroom(key: string, move: number, limit: number, ttl: number): Promise<[number, number]>;
}

const redis = new Redis({host: 'redis', port: 6379}) as GuardRedis;
redis.defineCommand('reserveHeadroom', {numberOfKeys: 1, lua: RESERVE_LUA});

export interface Reservation {
  ok: boolean;
  moved_bp: number;
  headroom_bp: number;
  bound_cents: number;
}

export interface WindowState {
  window: number;
  moved_bp: number;
  limit_bp: number;
  headroom_bp: number;
}

export const windowOf = (nowSeconds: number): number => Math.floor(nowSeconds / WINDOW_S);
export const guardKey = (sku: string, window: number): string => \`guard:\${sku}:\${window}\`;

/** The change from currentCents to targetCents in basis points of the current price. */
export const moveBp = (currentCents: number, targetCents: number): number =>
  Math.floor((Math.abs(targetCents - currentCents) * 10_000) / currentCents);

/** The furthest price availableBp allows from currentCents, in the direction of targetCents. */
export function boundCents(currentCents: number, targetCents: number, availableBp: number): number {
  const delta = Math.floor((currentCents * availableBp) / 10_000);
  return targetCents >= currentCents ? currentCents + delta : currentCents - delta;
}

/** Spend the change's basis points from the sku's window, or refuse it. */
export async function reserve(sku: string, currentCents: number, targetCents: number): Promise<Reservation> {
  const move = moveBp(currentCents, targetCents);
  const [ok, available] = await redis.reserveHeadroom(guardKey(sku, windowOf(Date.now() / 1000)), move, MAX_MOVE_BP, WINDOW_S);
  return {
    ok: ok === 1,
    moved_bp: move,
    headroom_bp: ok === 1 ? available - move : available,
    bound_cents: boundCents(currentCents, targetCents, available),
  };
}

/** The sku's current window: window, moved_bp (spent so far), limit_bp and headroom_bp. */
export async function windowState(sku: string): Promise<WindowState> {
  const window = windowOf(Date.now() / 1000);
  const moved = Number((await redis.hget(guardKey(sku, window), 'moved_bp')) ?? 0);
  return {window, moved_bp: moved, limit_bp: MAX_MOVE_BP, headroom_bp: MAX_MOVE_BP - moved};
}
`,
  'pricing/outbox.ts': `/**
 * The outbox (provided): the Redis list outbox holds JSON rows {"topic", "key", "payload"} that a
 * relay republishes once the broker takes records again.
 */
import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

export const OUTBOX_KEY = 'outbox';

/** Keep a record the broker did not take, for the relay. */
export async function insert(topic: string, key: string, payload: Record<string, unknown>): Promise<void> {
  await redis.rpush(OUTBOX_KEY, JSON.stringify({topic, key, payload}));
}
`,
};

export const supportModulesGo: Record<string, string> = {
  'pricing/store/store.go': `// Package store is the price store (provided): price:{sku} is a hash holding the sku's published
// price: sku, price_cents, previous_price_cents, source (seed, operator, demand-model or
// last-approved), reason, updated_at (unix seconds) and stale ("1" while the last approved price is
// kept because its source is down). candidate:{sku} holds an experiment's candidate price and the
// model version that proposed it.
package store

import (
	"context"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// Row is a sku's published price.
type Row struct {
	SKU                string \`json:"sku"\`
	PriceCents         int64  \`json:"price_cents"\`
	PreviousPriceCents int64  \`json:"previous_price_cents"\`
	Source             string \`json:"source"\`
	Reason             string \`json:"reason"\`
	UpdatedAt          int64  \`json:"updated_at"\`
	Stale              bool   \`json:"stale"\`
}

// Candidate is an experiment's candidate price for a sku.
type Candidate struct {
	SKU          string \`json:"sku"\`
	PriceCents   int64  \`json:"price_cents"\`
	ModelVersion string \`json:"model_version"\`
}

// PriceKey is the hash of a sku's published price.
func PriceKey(sku string) string { return "price:" + sku }

// CandidateKey is the hash of a sku's experiment candidate.
func CandidateKey(sku string) string { return "candidate:" + sku }

func number(raw map[string]string, field string) int64 {
	n, _ := strconv.ParseInt(raw[field], 10, 64)
	return n
}

// GetSKU is the sku's published row, or nil when the sku does not exist.
func GetSKU(ctx context.Context, sku string) *Row {
	raw := rdb.HGetAll(ctx, PriceKey(sku)).Val()
	if len(raw) == 0 {
		return nil
	}
	return &Row{
		SKU: raw["sku"], PriceCents: number(raw, "price_cents"), PreviousPriceCents: number(raw, "previous_price_cents"),
		Source: raw["source"], Reason: raw["reason"], UpdatedAt: number(raw, "updated_at"), Stale: raw["stale"] == "1",
	}
}

// Publish commits priceCents as the sku's price (a new sku gets its row): previous_price_cents is
// the price it replaces, updated_at is now, stale is cleared.
func Publish(ctx context.Context, sku string, priceCents int64, reason, source string) *Row {
	previous := priceCents
	if current := GetSKU(ctx, sku); current != nil {
		previous = current.PriceCents
	}
	rdb.HSet(ctx, PriceKey(sku), map[string]any{
		"sku": sku, "price_cents": priceCents, "previous_price_cents": previous, "source": source,
		"reason": reason, "updated_at": time.Now().Unix(), "stale": "0",
	})
	return GetSKU(ctx, sku)
}

// Seed is a new sku priced at priceCents (source seed).
func Seed(ctx context.Context, sku string, priceCents int64) *Row {
	return Publish(ctx, sku, priceCents, "initial price", "seed")
}

// MarkStale keeps the sku's last approved price while its source is down: price_cents and
// updated_at stay, source becomes last-approved, stale is set. Nil for an unknown sku.
func MarkStale(ctx context.Context, sku string) *Row {
	if rdb.Exists(ctx, PriceKey(sku)).Val() == 0 {
		return nil
	}
	rdb.HSet(ctx, PriceKey(sku), map[string]any{"source": "last-approved", "stale": "1"})
	return GetSKU(ctx, sku)
}

// CandidateOf is the experiment's candidate for the sku, or nil.
func CandidateOf(ctx context.Context, sku string) *Candidate {
	raw := rdb.HGetAll(ctx, CandidateKey(sku)).Val()
	if len(raw) == 0 {
		return nil
	}
	return &Candidate{SKU: sku, PriceCents: number(raw, "price_cents"), ModelVersion: raw["model_version"]}
}

// SetCandidate records the experiment's candidate price for the sku.
func SetCandidate(ctx context.Context, sku string, priceCents int64, modelVersion string) {
	rdb.HSet(ctx, CandidateKey(sku), map[string]any{"price_cents": priceCents, "model_version": modelVersion})
}
`,
  'pricing/guard/guard.go': `// Package guard is the window guard (provided; step 2 builds reserve the same way):
// guard:{sku}:{window} is a hash whose moved_bp field counts the basis points of price movement the
// sku has spent in its hour window (window = unix seconds / WindowS); the key expires with its
// window. Reserve checks a change against the MaxMoveBP the window allows and spends it in one Lua
// script; WindowState reads the window back.
package guard

import (
	"context"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
)

const (
	WindowS   = 3600
	MaxMoveBP = 2000
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// ReserveScript: KEYS[1] the window's hash; ARGV the change's basis points, the limit, the window's
// TTL. Returns {1 spent | 0 refused, the basis points the window had available before this change}.
var ReserveScript = redis.NewScript(\`
local moved = tonumber(redis.call('HGET', KEYS[1], 'moved_bp') or '0')
local available = tonumber(ARGV[2]) - moved
local move = tonumber(ARGV[1])
if move > available then
  return {0, available}
end
redis.call('HINCRBY', KEYS[1], 'moved_bp', move)
if redis.call('TTL', KEYS[1]) < 0 then
  redis.call('EXPIRE', KEYS[1], ARGV[3])
end
return {1, available}
\`)

// Reservation is the outcome of Reserve: MovedBP is this change, HeadroomBP what the window has left
// afterwards, BoundCents the furthest price the window allowed from the current price.
type Reservation struct {
	OK         bool  \`json:"ok"\`
	MovedBP    int64 \`json:"moved_bp"\`
	HeadroomBP int64 \`json:"headroom_bp"\`
	BoundCents int64 \`json:"bound_cents"\`
}

// State is a sku's current window: MovedBP spent so far, LimitBP, HeadroomBP left.
type State struct {
	Window     int64 \`json:"window"\`
	MovedBP    int64 \`json:"moved_bp"\`
	LimitBP    int64 \`json:"limit_bp"\`
	HeadroomBP int64 \`json:"headroom_bp"\`
}

// WindowOf is the hour window of a unix time.
func WindowOf(unix int64) int64 { return unix / WindowS }

// GuardKey is the hash of a sku's window.
func GuardKey(sku string, window int64) string { return fmt.Sprintf("guard:%s:%d", sku, window) }

// MoveBP is the change from currentCents to targetCents in basis points of the current price.
func MoveBP(currentCents, targetCents int64) int64 {
	delta := targetCents - currentCents
	if delta < 0 {
		delta = -delta
	}
	return delta * 10_000 / currentCents
}

// BoundCents is the furthest price availableBP allows from currentCents, in the direction of targetCents.
func BoundCents(currentCents, targetCents, availableBP int64) int64 {
	delta := currentCents * availableBP / 10_000
	if targetCents >= currentCents {
		return currentCents + delta
	}
	return currentCents - delta
}

// Reserve spends the change's basis points from the sku's window, or refuses it.
func Reserve(ctx context.Context, sku string, currentCents, targetCents int64) (Reservation, error) {
	move := MoveBP(currentCents, targetCents)
	out, err := ReserveScript.Run(ctx, rdb, []string{GuardKey(sku, WindowOf(time.Now().Unix()))}, move, MaxMoveBP, WindowS).Int64Slice()
	if err != nil {
		return Reservation{}, err
	}
	ok, available := out[0] == 1, out[1]
	headroom := available
	if ok {
		headroom = available - move
	}
	return Reservation{OK: ok, MovedBP: move, HeadroomBP: headroom, BoundCents: BoundCents(currentCents, targetCents, available)}, nil
}

// WindowState is the sku's current window.
func WindowState(ctx context.Context, sku string) State {
	window := WindowOf(time.Now().Unix())
	moved, _ := rdb.HGet(ctx, GuardKey(sku, window), "moved_bp").Int64()
	return State{Window: window, MovedBP: moved, LimitBP: MaxMoveBP, HeadroomBP: MaxMoveBP - moved}
}
`,
  'pricing/outbox/outbox.go': `// Package outbox is the outbox (provided): the Redis list outbox holds JSON rows {"topic", "key",
// "payload"} that a relay republishes once the broker takes records again.
package outbox

import (
	"context"
	"encoding/json"

	"github.com/redis/go-redis/v9"
)

const Key = "outbox"

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// Insert keeps a record the broker did not take, for the relay.
func Insert(ctx context.Context, topic, key string, payload map[string]any) error {
	row, err := json.Marshal(map[string]any{"topic": topic, "key": key, "payload": payload})
	if err != nil {
		return err
	}
	return rdb.RPush(ctx, Key, row).Err()
}
`,
};

export const supportModulesCpp: Record<string, string> = {
  'pricing/store.h': `// The price store (provided): price:{sku} is a hash holding the sku's published price: sku,
// price_cents, previous_price_cents, source (seed, operator, demand-model or last-approved), reason,
// updated_at (unix seconds) and stale ("1" while the last approved price is kept because its source
// is down). candidate:{sku} holds an experiment's candidate price and the model version that
// proposed it.
#pragma once

#include <sw/redis++/redis++.h>

#include <chrono>
#include <optional>
#include <string>
#include <unordered_map>

namespace store {

struct Row {
  std::string sku;
  long long price_cents = 0;
  long long previous_price_cents = 0;
  std::string source;
  std::string reason;
  long long updated_at = 0;
  bool stale = false;
};

struct Candidate {
  std::string sku;
  long long price_cents = 0;
  std::string model_version;
};

inline sw::redis::Redis& redis() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

inline std::string priceKey(const std::string& sku) { return "price:" + sku; }
inline std::string candidateKey(const std::string& sku) { return "candidate:" + sku; }

inline long long unixNow() {
  return std::chrono::duration_cast<std::chrono::seconds>(std::chrono::system_clock::now().time_since_epoch()).count();
}

// The sku's published row, or none when the sku does not exist.
inline std::optional<Row> getSku(const std::string& sku) {
  const std::unordered_map<std::string, std::string> raw = redis().hgetall(priceKey(sku));
  if (raw.empty()) return std::nullopt;
  const auto text = [&raw](const char* name) { return raw.count(name) ? raw.at(name) : std::string(); };
  const auto number = [&text](const char* name) { return text(name).empty() ? 0LL : std::stoll(text(name)); };
  return Row{text("sku"), number("price_cents"), number("previous_price_cents"), text("source"),
             text("reason"), number("updated_at"), text("stale") == "1"};
}

// Commit price_cents as the sku's price (a new sku gets its row): previous_price_cents is the price
// it replaces, updated_at is now, stale is cleared.
inline Row publish(const std::string& sku, long long price_cents, const std::string& reason, const std::string& source) {
  const auto current = getSku(sku);
  redis().hset(priceKey(sku), {{"sku", sku},
                               {"price_cents", std::to_string(price_cents)},
                               {"previous_price_cents", std::to_string(current ? current->price_cents : price_cents)},
                               {"source", source},
                               {"reason", reason},
                               {"updated_at", std::to_string(unixNow())},
                               {"stale", "0"}});
  return *getSku(sku);
}

// A new sku priced at price_cents (source seed).
inline Row seed(const std::string& sku, long long price_cents) { return publish(sku, price_cents, "initial price", "seed"); }

// Keep the sku's last approved price while its source is down: price_cents and updated_at stay,
// source becomes last-approved, stale is set. None for an unknown sku.
inline std::optional<Row> markStale(const std::string& sku) {
  if (redis().exists(priceKey(sku)) == 0) return std::nullopt;
  redis().hset(priceKey(sku), {{"source", "last-approved"}, {"stale", "1"}});
  return getSku(sku);
}

// The experiment's candidate for the sku, or none.
inline std::optional<Candidate> candidateOf(const std::string& sku) {
  const std::unordered_map<std::string, std::string> raw = redis().hgetall(candidateKey(sku));
  if (raw.empty()) return std::nullopt;
  return Candidate{sku, std::stoll(raw.at("price_cents")), raw.at("model_version")};
}

// Record the experiment's candidate price for the sku.
inline void setCandidate(const std::string& sku, long long price_cents, const std::string& model_version) {
  redis().hset(candidateKey(sku), {{"price_cents", std::to_string(price_cents)}, {"model_version", model_version}});
}

}  // namespace store
`,
  'pricing/guard.h': `// The window guard (provided; step 2 builds reserve the same way): guard:{sku}:{window} is a hash
// whose moved_bp field counts the basis points of price movement the sku has spent in its hour
// window (window = unix seconds / kWindowS); the key expires with its window. reserve checks a
// change against the kMaxMoveBp the window allows and spends it in one Lua script; windowState
// reads the window back.
#pragma once

#include <sw/redis++/redis++.h>

#include <chrono>
#include <iterator>
#include <string>
#include <vector>

namespace guard {

constexpr long long kWindowS = 3600;
constexpr long long kMaxMoveBp = 2000;

// KEYS[1] the window's hash; ARGV the change's basis points, the limit, the window's TTL. Returns
// {1 spent | 0 refused, the basis points the window had available before this change}.
inline const std::string kReserveLua = R"lua(
local moved = tonumber(redis.call('HGET', KEYS[1], 'moved_bp') or '0')
local available = tonumber(ARGV[2]) - moved
local move = tonumber(ARGV[1])
if move > available then
  return {0, available}
end
redis.call('HINCRBY', KEYS[1], 'moved_bp', move)
if redis.call('TTL', KEYS[1]) < 0 then
  redis.call('EXPIRE', KEYS[1], ARGV[3])
end
return {1, available}
)lua";

// The outcome of reserve: moved_bp is this change, headroom_bp what the window has left afterwards,
// bound_cents the furthest price the window allowed from the current price.
struct Reservation {
  bool ok = false;
  long long moved_bp = 0;
  long long headroom_bp = 0;
  long long bound_cents = 0;
};

// A sku's current window: moved_bp spent so far, limit_bp, headroom_bp left.
struct State {
  long long window = 0;
  long long moved_bp = 0;
  long long limit_bp = 0;
  long long headroom_bp = 0;
};

inline sw::redis::Redis& redis() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

inline long long windowOf(long long unix_seconds) { return unix_seconds / kWindowS; }

inline long long currentWindow() {
  return windowOf(std::chrono::duration_cast<std::chrono::seconds>(std::chrono::system_clock::now().time_since_epoch()).count());
}

inline std::string guardKey(const std::string& sku, long long window) { return "guard:" + sku + ":" + std::to_string(window); }

// The change from current_cents to target_cents in basis points of the current price.
inline long long moveBp(long long current_cents, long long target_cents) {
  const long long delta = target_cents > current_cents ? target_cents - current_cents : current_cents - target_cents;
  return delta * 10000 / current_cents;
}

// The furthest price available_bp allows from current_cents, in the direction of target_cents.
inline long long boundCents(long long current_cents, long long target_cents, long long available_bp) {
  const long long delta = current_cents * available_bp / 10000;
  return target_cents >= current_cents ? current_cents + delta : current_cents - delta;
}

// Spend the change's basis points from the sku's window, or refuse it.
inline Reservation reserve(const std::string& sku, long long current_cents, long long target_cents) {
  const long long move = moveBp(current_cents, target_cents);
  std::vector<long long> out;
  redis().eval(kReserveLua, {guardKey(sku, currentWindow())},
               {std::to_string(move), std::to_string(kMaxMoveBp), std::to_string(kWindowS)}, std::back_inserter(out));
  const bool ok = out.at(0) == 1;
  const long long available = out.at(1);
  return Reservation{ok, move, ok ? available - move : available, boundCents(current_cents, target_cents, available)};
}

// The sku's current window.
inline State windowState(const std::string& sku) {
  const long long window = currentWindow();
  const auto moved = redis().hget(guardKey(sku, window), "moved_bp");
  const long long spent = moved ? std::stoll(*moved) : 0;
  return State{window, spent, kMaxMoveBp, kMaxMoveBp - spent};
}

}  // namespace guard
`,
  'pricing/outbox.h': `// The outbox (provided): the Redis list outbox holds JSON rows {"topic", "key", "payload"} that a
// relay republishes once the broker takes records again.
#pragma once

#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <string>

namespace outbox {

inline const std::string kOutboxKey = "outbox";

inline sw::redis::Redis& redis() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

// Keep a record the broker did not take, for the relay.
inline void insert(const std::string& topic, const std::string& key, const nlohmann::json& payload) {
  redis().rpush(kOutboxKey, nlohmann::json{{"topic", topic}, {"key", key}, {"payload", payload}}.dump());
}

}  // namespace outbox
`,
};

export const supportModulesScala: Record<string, string> = {
  [scalaPath('pricing', 'Store')]: `package pricing

import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

/**
 * The price store (provided): price:{sku} is a hash holding the sku's published price: sku,
 * price_cents, previous_price_cents, source (seed, operator, demand-model or last-approved), reason,
 * updated_at (unix seconds) and stale ("1" while the last approved price is kept because its source
 * is down). candidate:{sku} holds an experiment's candidate price and the model version that
 * proposed it.
 */
object Store {
  final case class Row(sku: String, priceCents: Long, previousPriceCents: Long, source: String, reason: String, updatedAt: Long, stale: Boolean)
  final case class Candidate(sku: String, priceCents: Long, modelVersion: String)

  val jedis = new JedisPooled("redis", 6379)

  def priceKey(sku: String): String = s"price:$sku"
  def candidateKey(sku: String): String = s"candidate:$sku"

  /** The sku's published row, or None when the sku does not exist. */
  def getSku(sku: String): Option[Row] = {
    val raw = jedis.hgetAll(priceKey(sku)).asScala.toMap
    if (raw.isEmpty) None
    else Some(Row(raw("sku"), raw("price_cents").toLong, raw("previous_price_cents").toLong, raw("source"), raw("reason"), raw("updated_at").toLong, raw.get("stale").contains("1")))
  }

  /** Commit priceCents as the sku's price (a new sku gets its row): previous_price_cents is the price it replaces, updated_at is now, stale is cleared. */
  def publish(sku: String, priceCents: Long, reason: String, source: String): Row = {
    val previous = getSku(sku).map(_.priceCents).getOrElse(priceCents)
    jedis.hset(priceKey(sku), Map(
      "sku" -> sku, "price_cents" -> priceCents.toString, "previous_price_cents" -> previous.toString, "source" -> source,
      "reason" -> reason, "updated_at" -> (System.currentTimeMillis() / 1000).toString, "stale" -> "0").asJava)
    getSku(sku).get
  }

  /** A new sku priced at priceCents (source seed). */
  def seed(sku: String, priceCents: Long): Row = publish(sku, priceCents, "initial price", "seed")

  /** Keep the sku's last approved price while its source is down: price_cents and updated_at stay, source becomes last-approved, stale is set. */
  def markStale(sku: String): Option[Row] =
    if (!jedis.exists(priceKey(sku))) None
    else {
      jedis.hset(priceKey(sku), Map("source" -> "last-approved", "stale" -> "1").asJava)
      getSku(sku)
    }

  /** The experiment's candidate for the sku, if any. */
  def candidateOf(sku: String): Option[Candidate] = {
    val raw = jedis.hgetAll(candidateKey(sku)).asScala.toMap
    if (raw.isEmpty) None else Some(Candidate(sku, raw("price_cents").toLong, raw("model_version")))
  }

  /** Record the experiment's candidate price for the sku. */
  def setCandidate(sku: String, priceCents: Long, modelVersion: String): Unit =
    jedis.hset(candidateKey(sku), Map("price_cents" -> priceCents.toString, "model_version" -> modelVersion).asJava)
}
`,
  [scalaPath('pricing', 'Guard')]: `package pricing

import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

/**
 * The window guard (provided; step 2 builds reserve the same way): guard:{sku}:{window} is a hash
 * whose moved_bp field counts the basis points of price movement the sku has spent in its hour
 * window (window = unix seconds / WindowS); the key expires with its window. reserve checks a change
 * against the MaxMoveBp the window allows and spends it in one Lua script; windowState reads the
 * window back.
 */
object Guard {
  /** The outcome of reserve: movedBp is this change, headroomBp what the window has left afterwards, boundCents the furthest price the window allowed. */
  final case class Reservation(ok: Boolean, movedBp: Long, headroomBp: Long, boundCents: Long)
  /** A sku's current window: movedBp spent so far, limitBp, headroomBp left. */
  final case class State(window: Long, movedBp: Long, limitBp: Long, headroomBp: Long)

  val WindowS = 3600L
  val MaxMoveBp = 2000L

  val jedis = new JedisPooled("redis", 6379)

  /** KEYS[1] the window's hash; ARGV the change's basis points, the limit, the window's TTL. Returns {1 spent | 0 refused, the basis points available before this change}. */
  val ReserveLua: String =
    """local moved = tonumber(redis.call('HGET', KEYS[1], 'moved_bp') or '0')
      |local available = tonumber(ARGV[2]) - moved
      |local move = tonumber(ARGV[1])
      |if move > available then
      |  return {0, available}
      |end
      |redis.call('HINCRBY', KEYS[1], 'moved_bp', move)
      |if redis.call('TTL', KEYS[1]) < 0 then
      |  redis.call('EXPIRE', KEYS[1], ARGV[3])
      |end
      |return {1, available}
      |""".stripMargin

  def windowOf(unixSeconds: Long): Long = unixSeconds / WindowS
  def guardKey(sku: String, window: Long): String = s"guard:$sku:$window"

  /** The change from currentCents to targetCents in basis points of the current price. */
  def moveBp(currentCents: Long, targetCents: Long): Long = math.abs(targetCents - currentCents) * 10000 / currentCents

  /** The furthest price availableBp allows from currentCents, in the direction of targetCents. */
  def boundCents(currentCents: Long, targetCents: Long, availableBp: Long): Long = {
    val delta = currentCents * availableBp / 10000
    if (targetCents >= currentCents) currentCents + delta else currentCents - delta
  }

  /** Spend the change's basis points from the sku's window, or refuse it. */
  def reserve(sku: String, currentCents: Long, targetCents: Long): Reservation = {
    val move = moveBp(currentCents, targetCents)
    val key = guardKey(sku, windowOf(System.currentTimeMillis() / 1000))
    val out = jedis.eval(ReserveLua, List(key).asJava, List(move.toString, MaxMoveBp.toString, WindowS.toString).asJava)
      .asInstanceOf[java.util.List[java.lang.Long]].asScala.map(_.longValue)
    val ok = out.head == 1L
    val available = out(1)
    Reservation(ok, move, if (ok) available - move else available, boundCents(currentCents, targetCents, available))
  }

  /** The sku's current window. */
  def windowState(sku: String): State = {
    val window = windowOf(System.currentTimeMillis() / 1000)
    val moved = Option(jedis.hget(guardKey(sku, window), "moved_bp")).map(_.toLong).getOrElse(0L)
    State(window, moved, MaxMoveBp, MaxMoveBp - moved)
  }
}
`,
  [scalaPath('pricing', 'Outbox')]: `package pricing

import redis.clients.jedis.JedisPooled
import spray.json._

/**
 * The outbox (provided): the Redis list outbox holds JSON rows {"topic", "key", "payload"} that a
 * relay republishes once the broker takes records again.
 */
object Outbox {
  val OutboxKey = "outbox"

  val jedis = new JedisPooled("redis", 6379)

  /** Keep a record the broker did not take, for the relay. */
  def insert(topic: String, key: String, payload: JsObject): Unit =
    jedis.rpush(OutboxKey, JsObject("topic" -> JsString(topic), "key" -> JsString(key), "payload" -> payload).compactPrint)
}
`,
};
