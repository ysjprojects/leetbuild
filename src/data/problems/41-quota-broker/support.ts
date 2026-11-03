/**
 * Hand-written support modules the quota-broker steps import but no step builds: the `quota`
 * package. `quota.ledger` is the Redis ledger as the later steps use it (step 2 builds `reserve` and
 * `release` the same way; `consume` is the scheduler's call when a job starts on its reservation),
 * with the team limits, the key names and the reservation ids. `quota.outbox` is the list a relay
 * drains into `quota.event`. The five languages keep the same keys, so a harness reads one layout
 * whatever the stack.
 */
import {scalaPath} from '../scala-support';

export const supportModules: Record<string, string> = {
  'quota/__init__.py': '',
  'quota/ledger.py': `"""
The quota ledger (provided; step 2 builds reserve and release the same way), in Redis:

  quota:limits                         hash: team -> units the team may hold in one window
                                       (DEFAULT_LIMIT when unset)
  quota:{team}:{window}                hash: limit, reserved, consumed (one window's ledger)
  reservation:{team}:{reservation_id}  hash: window, resource_class, amount, source_version

reserve, release and consume are one Lua script each, so a second broker landing between two
commands cannot oversell or refund twice. reserve sets TTL_S on what it writes; release and consume
find the window through the reservation's recorded window.
"""
import uuid

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

LIMITS_KEY = "quota:limits"
DEFAULT_LIMIT = 8
TTL_S = 86400

# KEYS: window hash, reservation; ARGV: amount, limit, ttl, window, resource_class, source_version.
RESERVE_LUA = """
local amount = tonumber(ARGV[1])
local used = tonumber(redis.call('HGET', KEYS[1], 'reserved') or '0') + tonumber(redis.call('HGET', KEYS[1], 'consumed') or '0')
if used + amount > tonumber(ARGV[2]) then return 0 end
redis.call('HSET', KEYS[1], 'limit', ARGV[2])
redis.call('HINCRBY', KEYS[1], 'reserved', amount)
redis.call('HINCRBY', KEYS[1], 'consumed', 0)
redis.call('HSET', KEYS[2], 'window', ARGV[4], 'resource_class', ARGV[5], 'amount', amount, 'source_version', ARGV[6])
redis.call('EXPIRE', KEYS[1], ARGV[3])
redis.call('EXPIRE', KEYS[2], ARGV[3])
return 1
"""

# KEYS: reservation; ARGV: the team's window-key prefix (quota:{team}:). Refunds the recorded window.
RELEASE_LUA = """
local window = redis.call('HGET', KEYS[1], 'window')
if not window then return 0 end
redis.call('HINCRBY', ARGV[1] .. window, 'reserved', -tonumber(redis.call('HGET', KEYS[1], 'amount')))
redis.call('DEL', KEYS[1])
return 1
"""

# KEYS: reservation; ARGV: the team's window-key prefix. Moves the amount from reserved to consumed.
CONSUME_LUA = """
local window = redis.call('HGET', KEYS[1], 'window')
if not window then return 0 end
local amount = tonumber(redis.call('HGET', KEYS[1], 'amount'))
redis.call('HINCRBY', ARGV[1] .. window, 'reserved', -amount)
redis.call('HINCRBY', ARGV[1] .. window, 'consumed', amount)
redis.call('DEL', KEYS[1])
return 1
"""

reserve_script = r.register_script(RESERVE_LUA)
release_script = r.register_script(RELEASE_LUA)
consume_script = r.register_script(CONSUME_LUA)


def window_key(team: str, window: str) -> str:
    return f"quota:{team}:{window}"


def reservation_key(team: str, reservation_id: str) -> str:
    return f"reservation:{team}:{reservation_id}"


def new_reservation_id() -> str:
    return uuid.uuid4().hex[:16]


def limit_of(team: str) -> int:
    """The units the team may hold in one window."""
    raw = r.hget(LIMITS_KEY, team)
    return int(raw) if raw else DEFAULT_LIMIT


def reserve(team: str, window: str, resource_class: str, amount: int, source_version: str = "") -> str | None:
    """Take amount units from the team's window; the reservation id, or None when the window cannot cover it."""
    reservation_id = new_reservation_id()
    taken = reserve_script(
        keys=[window_key(team, window), reservation_key(team, reservation_id)],
        args=[amount, limit_of(team), TTL_S, window, resource_class, source_version],
    )
    return reservation_id if taken == 1 else None


def release(team: str, reservation_id: str) -> bool:
    """Give a reservation's units back to the window it recorded; False when there is no such reservation."""
    return release_script(keys=[reservation_key(team, reservation_id)], args=[f"quota:{team}:"]) == 1


def consume(team: str, reservation_id: str) -> bool:
    """The job started: the reservation's units move from reserved to consumed."""
    return consume_script(keys=[reservation_key(team, reservation_id)], args=[f"quota:{team}:"]) == 1
`,
  'quota/outbox.py': `"""
The outbox (provided): the Redis list outbox:quota of JSON rows {"topic", "key", "payload"} that a
relay produces later, oldest first.
"""
import json

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

OUTBOX_KEY = "outbox:quota"


def insert(topic: str, key: str, payload: dict) -> None:
    """Queue a record the broker did not take, for the relay to produce later."""
    r.rpush(OUTBOX_KEY, json.dumps({"topic": topic, "key": key, "payload": payload}))


def rows() -> list[dict]:
    return [json.loads(row) for row in r.lrange(OUTBOX_KEY, 0, -1)]
`,
};

export const supportModulesTs: Record<string, string> = {
  'quota/ledger.ts': `/**
 * The quota ledger (provided; step 2 builds reserve and release the same way), in Redis:
 *
 *   quota:limits                         hash: team -> units the team may hold in one window (DEFAULT_LIMIT when unset)
 *   quota:{team}:{window}                hash: limit, reserved, consumed (one window's ledger)
 *   reservation:{team}:{reservation_id}  hash: window, resource_class, amount, source_version
 *
 * reserve, release and consume are one Lua script each, so a second broker landing between two
 * commands cannot oversell or refund twice. reserve sets TTL_S on what it writes; release and
 * consume find the window through the reservation's recorded window.
 */
import {randomUUID} from 'node:crypto';

import Redis from 'ioredis';

export const LIMITS_KEY = 'quota:limits';
export const DEFAULT_LIMIT = 8;
export const TTL_S = 86400;

/** KEYS: window hash, reservation; ARGV: amount, limit, ttl, window, resource_class, source_version. */
export const RESERVE_LUA = \`
local amount = tonumber(ARGV[1])
local used = tonumber(redis.call('HGET', KEYS[1], 'reserved') or '0') + tonumber(redis.call('HGET', KEYS[1], 'consumed') or '0')
if used + amount > tonumber(ARGV[2]) then return 0 end
redis.call('HSET', KEYS[1], 'limit', ARGV[2])
redis.call('HINCRBY', KEYS[1], 'reserved', amount)
redis.call('HINCRBY', KEYS[1], 'consumed', 0)
redis.call('HSET', KEYS[2], 'window', ARGV[4], 'resource_class', ARGV[5], 'amount', amount, 'source_version', ARGV[6])
redis.call('EXPIRE', KEYS[1], ARGV[3])
redis.call('EXPIRE', KEYS[2], ARGV[3])
return 1
\`;

/** KEYS: reservation; ARGV: the team's window-key prefix (quota:{team}:). Refunds the recorded window. */
export const RELEASE_LUA = \`
local window = redis.call('HGET', KEYS[1], 'window')
if not window then return 0 end
redis.call('HINCRBY', ARGV[1] .. window, 'reserved', -tonumber(redis.call('HGET', KEYS[1], 'amount')))
redis.call('DEL', KEYS[1])
return 1
\`;

/** KEYS: reservation; ARGV: the team's window-key prefix. Moves the amount from reserved to consumed. */
export const CONSUME_LUA = \`
local window = redis.call('HGET', KEYS[1], 'window')
if not window then return 0 end
local amount = tonumber(redis.call('HGET', KEYS[1], 'amount'))
redis.call('HINCRBY', ARGV[1] .. window, 'reserved', -amount)
redis.call('HINCRBY', ARGV[1] .. window, 'consumed', amount)
redis.call('DEL', KEYS[1])
return 1
\`;

interface LedgerRedis extends Redis {
  reserveUnits(
    windowKey: string,
    reservationKey: string,
    amount: number,
    limit: number,
    ttl: number,
    window: string,
    resourceClass: string,
    sourceVersion: string,
  ): Promise<number>;
  releaseUnits(reservationKey: string, prefix: string): Promise<number>;
  consumeUnits(reservationKey: string, prefix: string): Promise<number>;
}

const redis = new Redis({host: 'redis', port: 6379}) as LedgerRedis;
redis.defineCommand('reserveUnits', {numberOfKeys: 2, lua: RESERVE_LUA});
redis.defineCommand('releaseUnits', {numberOfKeys: 1, lua: RELEASE_LUA});
redis.defineCommand('consumeUnits', {numberOfKeys: 1, lua: CONSUME_LUA});

export const windowKey = (team: string, window: string): string => \`quota:\${team}:\${window}\`;
export const reservationKey = (team: string, reservationId: string): string => \`reservation:\${team}:\${reservationId}\`;
export const newReservationId = (): string => randomUUID().replace(/-/g, '').slice(0, 16);

/** The units the team may hold in one window. */
export async function limitOf(team: string): Promise<number> {
  const raw = await redis.hget(LIMITS_KEY, team);
  return raw ? Number(raw) : DEFAULT_LIMIT;
}

/** Take amount units from the team's window; the reservation id, or null when the window cannot cover it. */
export async function reserve(team: string, window: string, resourceClass: string, amount: number, sourceVersion = ''): Promise<string | null> {
  const reservationId = newReservationId();
  const taken = await redis.reserveUnits(
    windowKey(team, window),
    reservationKey(team, reservationId),
    amount,
    await limitOf(team),
    TTL_S,
    window,
    resourceClass,
    sourceVersion,
  );
  return taken === 1 ? reservationId : null;
}

/** Give a reservation's units back to the window it recorded; false when there is no such reservation. */
export async function release(team: string, reservationId: string): Promise<boolean> {
  return (await redis.releaseUnits(reservationKey(team, reservationId), \`quota:\${team}:\`)) === 1;
}

/** The job started: the reservation's units move from reserved to consumed. */
export async function consume(team: string, reservationId: string): Promise<boolean> {
  return (await redis.consumeUnits(reservationKey(team, reservationId), \`quota:\${team}:\`)) === 1;
}
`,
  'quota/outbox.ts': `/**
 * The outbox (provided): the Redis list outbox:quota of JSON rows {"topic", "key", "payload"} that a
 * relay produces later, oldest first.
 */
import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

export const OUTBOX_KEY = 'outbox:quota';

/** Queue a record the broker did not take, for the relay to produce later. */
export async function insert(topic: string, key: string, payload: unknown): Promise<void> {
  await redis.rpush(OUTBOX_KEY, JSON.stringify({topic, key, payload}));
}

export async function rows(): Promise<{topic: string; key: string; payload: Record<string, unknown>}[]> {
  return (await redis.lrange(OUTBOX_KEY, 0, -1)).map(row => JSON.parse(row));
}
`,
};

export const supportModulesGo: Record<string, string> = {
  'quota/ledger/ledger.go': `// Package ledger is the quota ledger (provided; step 2 builds reserve and release the same way),
// in Redis:
//
//	quota:limits                         hash: team -> units the team may hold in one window (DefaultLimit when unset)
//	quota:{team}:{window}                hash: limit, reserved, consumed (one window's ledger)
//	reservation:{team}:{reservation_id}  hash: window, resource_class, amount, source_version
//
// Reserve, Release and Consume are one Lua script each, so a second broker landing between two
// commands cannot oversell or refund twice. Reserve sets TTL on what it writes; Release and
// Consume find the window through the reservation's recorded window.
package ledger

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"
)

const (
	LimitsKey    = "quota:limits"
	DefaultLimit = 8
	TTL          = 24 * time.Hour
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// ReserveScript: KEYS window hash, reservation; ARGV amount, limit, ttl, window, resource_class, source_version.
var ReserveScript = redis.NewScript(\`
local amount = tonumber(ARGV[1])
local used = tonumber(redis.call('HGET', KEYS[1], 'reserved') or '0') + tonumber(redis.call('HGET', KEYS[1], 'consumed') or '0')
if used + amount > tonumber(ARGV[2]) then return 0 end
redis.call('HSET', KEYS[1], 'limit', ARGV[2])
redis.call('HINCRBY', KEYS[1], 'reserved', amount)
redis.call('HINCRBY', KEYS[1], 'consumed', 0)
redis.call('HSET', KEYS[2], 'window', ARGV[4], 'resource_class', ARGV[5], 'amount', amount, 'source_version', ARGV[6])
redis.call('EXPIRE', KEYS[1], ARGV[3])
redis.call('EXPIRE', KEYS[2], ARGV[3])
return 1
\`)

// ReleaseScript: KEYS reservation; ARGV the team's window-key prefix (quota:{team}:). Refunds the recorded window.
var ReleaseScript = redis.NewScript(\`
local window = redis.call('HGET', KEYS[1], 'window')
if not window then return 0 end
redis.call('HINCRBY', ARGV[1] .. window, 'reserved', -tonumber(redis.call('HGET', KEYS[1], 'amount')))
redis.call('DEL', KEYS[1])
return 1
\`)

// ConsumeScript: KEYS reservation; ARGV the team's window-key prefix. Moves the amount from reserved to consumed.
var ConsumeScript = redis.NewScript(\`
local window = redis.call('HGET', KEYS[1], 'window')
if not window then return 0 end
local amount = tonumber(redis.call('HGET', KEYS[1], 'amount'))
redis.call('HINCRBY', ARGV[1] .. window, 'reserved', -amount)
redis.call('HINCRBY', ARGV[1] .. window, 'consumed', amount)
redis.call('DEL', KEYS[1])
return 1
\`)

// WindowKey is the hash of one team's window.
func WindowKey(team, window string) string { return "quota:" + team + ":" + window }

// ReservationKey is the hash of one reservation.
func ReservationKey(team, reservationID string) string {
	return "reservation:" + team + ":" + reservationID
}

// NewReservationID is a fresh random reservation id.
func NewReservationID() string {
	b := make([]byte, 8)
	rand.Read(b)
	return hex.EncodeToString(b)
}

// LimitOf is the units the team may hold in one window.
func LimitOf(ctx context.Context, team string) int64 {
	raw, err := rdb.HGet(ctx, LimitsKey, team).Result()
	if err != nil || raw == "" {
		return DefaultLimit
	}
	n, _ := strconv.ParseInt(raw, 10, 64)
	return n
}

// Reserve takes amount units from the team's window: the reservation id, or "" when the window cannot cover it.
func Reserve(ctx context.Context, team, window, resourceClass string, amount int64, sourceVersion string) (string, error) {
	reservationID := NewReservationID()
	keys := []string{WindowKey(team, window), ReservationKey(team, reservationID)}
	taken, err := ReserveScript.Run(ctx, rdb, keys, amount, LimitOf(ctx, team), int64(TTL/time.Second), window, resourceClass, sourceVersion).Int64()
	if err != nil || taken != 1 {
		return "", err
	}
	return reservationID, nil
}

// Release gives a reservation's units back to the window it recorded; false when there is no such reservation.
func Release(ctx context.Context, team, reservationID string) (bool, error) {
	n, err := ReleaseScript.Run(ctx, rdb, []string{ReservationKey(team, reservationID)}, "quota:"+team+":").Int64()
	return n == 1, err
}

// Consume records that the job started: the reservation's units move from reserved to consumed.
func Consume(ctx context.Context, team, reservationID string) (bool, error) {
	n, err := ConsumeScript.Run(ctx, rdb, []string{ReservationKey(team, reservationID)}, "quota:"+team+":").Int64()
	return n == 1, err
}
`,
  'quota/outbox/outbox.go': `// Package outbox is the outbox (provided): the Redis list outbox:quota of JSON rows
// {"topic", "key", "payload"} that a relay produces later, oldest first.
package outbox

import (
	"context"
	"encoding/json"

	"github.com/redis/go-redis/v9"
)

const Key = "outbox:quota"

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// Row is one queued record.
type Row struct {
	Topic   string         \`json:"topic"\`
	Key     string         \`json:"key"\`
	Payload map[string]any \`json:"payload"\`
}

// Insert queues a record the broker did not take, for the relay to produce later.
func Insert(ctx context.Context, topic, key string, payload map[string]any) error {
	raw, err := json.Marshal(Row{Topic: topic, Key: key, Payload: payload})
	if err != nil {
		return err
	}
	return rdb.RPush(ctx, Key, raw).Err()
}

// Rows is everything queued, oldest first.
func Rows(ctx context.Context) ([]Row, error) {
	raw, err := rdb.LRange(ctx, Key, 0, -1).Result()
	if err != nil {
		return nil, err
	}
	rows := make([]Row, 0, len(raw))
	for _, text := range raw {
		var row Row
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
  'quota/ledger.h': `// The quota ledger (provided; step 2 builds reserve and release the same way), in Redis:
//
//   quota:limits                         hash: team -> units the team may hold in one window (kDefaultLimit when unset)
//   quota:{team}:{window}                hash: limit, reserved, consumed (one window's ledger)
//   reservation:{team}:{reservation_id}  hash: window, resource_class, amount, source_version
//
// reserve, release and consume are one Lua script each, so a second broker landing between two
// commands cannot oversell or refund twice. reserve sets kTtlSeconds on what it writes; release
// and consume find the window through the reservation's recorded window.
#pragma once

#include <sw/redis++/redis++.h>

#include <optional>
#include <random>
#include <string>

namespace ledger {

inline const std::string kLimitsKey = "quota:limits";
constexpr long long kDefaultLimit = 8;
constexpr long long kTtlSeconds = 86400;

// KEYS: window hash, reservation; ARGV: amount, limit, ttl, window, resource_class, source_version.
inline const std::string kReserveLua = R"lua(
local amount = tonumber(ARGV[1])
local used = tonumber(redis.call('HGET', KEYS[1], 'reserved') or '0') + tonumber(redis.call('HGET', KEYS[1], 'consumed') or '0')
if used + amount > tonumber(ARGV[2]) then return 0 end
redis.call('HSET', KEYS[1], 'limit', ARGV[2])
redis.call('HINCRBY', KEYS[1], 'reserved', amount)
redis.call('HINCRBY', KEYS[1], 'consumed', 0)
redis.call('HSET', KEYS[2], 'window', ARGV[4], 'resource_class', ARGV[5], 'amount', amount, 'source_version', ARGV[6])
redis.call('EXPIRE', KEYS[1], ARGV[3])
redis.call('EXPIRE', KEYS[2], ARGV[3])
return 1
)lua";

// KEYS: reservation; ARGV: the team's window-key prefix (quota:{team}:). Refunds the recorded window.
inline const std::string kReleaseLua = R"lua(
local window = redis.call('HGET', KEYS[1], 'window')
if not window then return 0 end
redis.call('HINCRBY', ARGV[1] .. window, 'reserved', -tonumber(redis.call('HGET', KEYS[1], 'amount')))
redis.call('DEL', KEYS[1])
return 1
)lua";

// KEYS: reservation; ARGV: the team's window-key prefix. Moves the amount from reserved to consumed.
inline const std::string kConsumeLua = R"lua(
local window = redis.call('HGET', KEYS[1], 'window')
if not window then return 0 end
local amount = tonumber(redis.call('HGET', KEYS[1], 'amount'))
redis.call('HINCRBY', ARGV[1] .. window, 'reserved', -amount)
redis.call('HINCRBY', ARGV[1] .. window, 'consumed', amount)
redis.call('DEL', KEYS[1])
return 1
)lua";

inline sw::redis::Redis& redis() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

inline std::string windowKey(const std::string& team, const std::string& window) { return "quota:" + team + ":" + window; }

inline std::string reservationKey(const std::string& team, const std::string& reservation_id) {
  return "reservation:" + team + ":" + reservation_id;
}

inline std::string newReservationId() {
  static std::mt19937_64 rng{std::random_device{}()};
  static const char* hex = "0123456789abcdef";
  std::string id;
  for (int i = 0; i < 16; i++) id += hex[rng() % 16];
  return id;
}

// The units the team may hold in one window.
inline long long limitOf(const std::string& team) {
  const auto raw = redis().hget(kLimitsKey, team);
  return raw && !raw->empty() ? std::stoll(*raw) : kDefaultLimit;
}

// Take amount units from the team's window: the reservation id, or none when the window cannot cover it.
inline std::optional<std::string> reserve(const std::string& team, const std::string& window, const std::string& resource_class,
                                          long long amount, const std::string& source_version = "") {
  const std::string reservation_id = newReservationId();
  const long long taken = redis().eval<long long>(
      kReserveLua, {windowKey(team, window), reservationKey(team, reservation_id)},
      {std::to_string(amount), std::to_string(limitOf(team)), std::to_string(kTtlSeconds), window, resource_class, source_version});
  if (taken != 1) return std::nullopt;
  return reservation_id;
}

// Give a reservation's units back to the window it recorded; false when there is no such reservation.
inline bool release(const std::string& team, const std::string& reservation_id) {
  return redis().eval<long long>(kReleaseLua, {reservationKey(team, reservation_id)}, {"quota:" + team + ":"}) == 1;
}

// The job started: the reservation's units move from reserved to consumed.
inline bool consume(const std::string& team, const std::string& reservation_id) {
  return redis().eval<long long>(kConsumeLua, {reservationKey(team, reservation_id)}, {"quota:" + team + ":"}) == 1;
}

}  // namespace ledger
`,
  'quota/outbox.h': `// The outbox (provided): the Redis list outbox:quota of JSON rows {"topic", "key", "payload"} that a
// relay produces later, oldest first.
#pragma once

#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <string>
#include <vector>

namespace outbox {

inline const std::string kKey = "outbox:quota";

inline sw::redis::Redis& redis() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

// Queue a record the broker did not take, for the relay to produce later.
inline void insert(const std::string& topic, const std::string& key, const nlohmann::json& payload) {
  redis().rpush(kKey, nlohmann::json{{"topic", topic}, {"key", key}, {"payload", payload}}.dump());
}

// Everything queued, oldest first.
inline std::vector<nlohmann::json> rows() {
  std::vector<std::string> raw;
  redis().lrange(kKey, 0, -1, std::back_inserter(raw));
  std::vector<nlohmann::json> out;
  for (const std::string& row : raw) out.push_back(nlohmann::json::parse(row));
  return out;
}

}  // namespace outbox
`,
};

export const supportModulesScala: Record<string, string> = {
  [scalaPath('quota', 'Ledger')]: `package quota

import java.util.UUID

import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

/**
 * The quota ledger (provided; step 2 builds reserve and release the same way), in Redis:
 *
 *   quota:limits                         hash: team -> units the team may hold in one window (DefaultLimit when unset)
 *   quota:{team}:{window}                hash: limit, reserved, consumed (one window's ledger)
 *   reservation:{team}:{reservation_id}  hash: window, resource_class, amount, source_version
 *
 * reserve, release and consume are one Lua script each, so a second broker landing between two
 * commands cannot oversell or refund twice. reserve sets TtlSeconds on what it writes; release and
 * consume find the window through the reservation's recorded window.
 */
object Ledger {
  val jedis = new JedisPooled("redis", 6379)

  val LimitsKey = "quota:limits"
  val DefaultLimit = 8L
  val TtlSeconds = 86400L

  /** KEYS: window hash, reservation; ARGV: amount, limit, ttl, window, resource_class, source_version. */
  val ReserveLua: String =
    """local amount = tonumber(ARGV[1])
      |local used = tonumber(redis.call('HGET', KEYS[1], 'reserved') or '0') + tonumber(redis.call('HGET', KEYS[1], 'consumed') or '0')
      |if used + amount > tonumber(ARGV[2]) then return 0 end
      |redis.call('HSET', KEYS[1], 'limit', ARGV[2])
      |redis.call('HINCRBY', KEYS[1], 'reserved', amount)
      |redis.call('HINCRBY', KEYS[1], 'consumed', 0)
      |redis.call('HSET', KEYS[2], 'window', ARGV[4], 'resource_class', ARGV[5], 'amount', amount, 'source_version', ARGV[6])
      |redis.call('EXPIRE', KEYS[1], ARGV[3])
      |redis.call('EXPIRE', KEYS[2], ARGV[3])
      |return 1
      |""".stripMargin

  /** KEYS: reservation; ARGV: the team's window-key prefix (quota:{team}:). Refunds the recorded window. */
  val ReleaseLua: String =
    """local window = redis.call('HGET', KEYS[1], 'window')
      |if not window then return 0 end
      |redis.call('HINCRBY', ARGV[1] .. window, 'reserved', -tonumber(redis.call('HGET', KEYS[1], 'amount')))
      |redis.call('DEL', KEYS[1])
      |return 1
      |""".stripMargin

  /** KEYS: reservation; ARGV: the team's window-key prefix. Moves the amount from reserved to consumed. */
  val ConsumeLua: String =
    """local window = redis.call('HGET', KEYS[1], 'window')
      |if not window then return 0 end
      |local amount = tonumber(redis.call('HGET', KEYS[1], 'amount'))
      |redis.call('HINCRBY', ARGV[1] .. window, 'reserved', -amount)
      |redis.call('HINCRBY', ARGV[1] .. window, 'consumed', amount)
      |redis.call('DEL', KEYS[1])
      |return 1
      |""".stripMargin

  def windowKey(team: String, window: String): String = s"quota:$team:$window"
  def reservationKey(team: String, reservationId: String): String = s"reservation:$team:$reservationId"
  def newReservationId(): String = UUID.randomUUID().toString.replace("-", "").take(16)

  /** The units the team may hold in one window. */
  def limitOf(team: String): Long = Option(jedis.hget(LimitsKey, team)).filter(_.nonEmpty).map(_.toLong).getOrElse(DefaultLimit)

  /** Take amount units from the team's window; the reservation id, or None when the window cannot cover it. */
  def reserve(team: String, window: String, resourceClass: String, amount: Long, sourceVersion: String = ""): Option[String] = {
    val reservationId = newReservationId()
    val keys = List(windowKey(team, window), reservationKey(team, reservationId)).asJava
    val args = List(amount.toString, limitOf(team).toString, TtlSeconds.toString, window, resourceClass, sourceVersion).asJava
    if (jedis.eval(ReserveLua, keys, args).asInstanceOf[java.lang.Long] == 1L) Some(reservationId) else None
  }

  /** Give a reservation's units back to the window it recorded; false when there is no such reservation. */
  def release(team: String, reservationId: String): Boolean =
    jedis.eval(ReleaseLua, List(reservationKey(team, reservationId)).asJava, List(s"quota:$team:").asJava).asInstanceOf[java.lang.Long] == 1L

  /** The job started: the reservation's units move from reserved to consumed. */
  def consume(team: String, reservationId: String): Boolean =
    jedis.eval(ConsumeLua, List(reservationKey(team, reservationId)).asJava, List(s"quota:$team:").asJava).asInstanceOf[java.lang.Long] == 1L
}
`,
  [scalaPath('quota', 'Outbox')]: `package quota

import redis.clients.jedis.JedisPooled
import spray.json._

import scala.jdk.CollectionConverters._

/** The outbox (provided): the Redis list outbox:quota of JSON rows {"topic", "key", "payload"} that a relay produces later, oldest first. */
object Outbox {
  val jedis = new JedisPooled("redis", 6379)

  val Key = "outbox:quota"

  /** Queue a record the broker did not take, for the relay to produce later. */
  def insert(topic: String, key: String, payload: JsObject): Unit =
    jedis.rpush(Key, JsObject("topic" -> JsString(topic), "key" -> JsString(key), "payload" -> payload).compactPrint)

  /** Everything queued, oldest first. */
  def rows(): Seq[JsValue] = jedis.lrange(Key, 0, -1).asScala.toSeq.map(_.parseJson)
}
`,
};
