/**
 * Hand-written support modules the cdn-purge steps import but no step builds: `purge.records`, the
 * purge records in Redis. The intake (step 1) creates a record and queues it, the status read
 * (step 5) reads it back, the provider client's outcomes and the propagation confirmations land in
 * it, and the event step (step 4) parks refused events in its outbox. The five languages keep the
 * same keys, so a harness reads one layout whatever the stack.
 */
import {scalaPath} from '../scala-support';

export const supportModules: Record<string, string> = {
  'purge/__init__.py': '',
  'purge/records.py': `"""
The purge records (provided). purge:{id} is a hash (purge_id, tenant, domain, accepted_at in unix
seconds); purge:{id}:paths holds the paths in request order; purge:{id}:outcomes each path's outcome
(pending, accepted, invalid_pattern, failed, propagated); purge:{id}:confirmed the unix second each
path's propagation was confirmed. tenant:{tenant}:domains is the set of domains a tenant owns,
purge:key:{tenant}:{key} the purge an Idempotency-Key created, purge:queue the purges waiting for
the provider client, and purge:outbox the events a relay still has to publish.
"""
import json
import time

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

KEY_TTL_S = 86400


def add_domain(tenant: str, domain: str) -> None:
    """Record that the tenant owns the domain."""
    r.sadd(f"tenant:{tenant}:domains", domain)


def owns_domain(tenant: str, domain: str) -> bool:
    """Whether the domain is one of the tenant's."""
    return bool(r.sismember(f"tenant:{tenant}:domains", domain))


def create(tenant: str, domain: str, paths: list[str]) -> dict:
    """A new purge, accepted now: every path pending, the purge queued for the provider client."""
    purge_id = f"pg-{r.incr('purge:seq')}"
    r.hset(f"purge:{purge_id}", mapping={"purge_id": purge_id, "tenant": tenant, "domain": domain, "accepted_at": int(time.time())})
    if paths:
        r.rpush(f"purge:{purge_id}:paths", *paths)
        r.hset(f"purge:{purge_id}:outcomes", mapping={path: "pending" for path in paths})
    r.rpush("purge:queue", purge_id)
    return get(purge_id)


def get(purge_id: str) -> dict | None:
    """The purge (purge_id, tenant, domain, accepted_at, paths, outcomes, confirmed), or None."""
    raw = r.hgetall(f"purge:{purge_id}")
    if not raw:
        return None
    return {
        "purge_id": raw["purge_id"],
        "tenant": raw["tenant"],
        "domain": raw["domain"],
        "accepted_at": int(raw["accepted_at"]),
        "paths": r.lrange(f"purge:{purge_id}:paths", 0, -1),
        "outcomes": r.hgetall(f"purge:{purge_id}:outcomes"),
        "confirmed": {path: int(at) for path, at in r.hgetall(f"purge:{purge_id}:confirmed").items()},
    }


def purge_for_key(tenant: str, key: str) -> str | None:
    """The id of the purge the tenant's Idempotency-Key created, if any."""
    return r.get(f"purge:key:{tenant}:{key}")


def remember_key(tenant: str, key: str, purge_id: str) -> None:
    """Record which purge the tenant's Idempotency-Key created (kept for a day)."""
    r.set(f"purge:key:{tenant}:{key}", purge_id, ex=KEY_TTL_S)


def queued() -> list[str]:
    """The ids of the purges waiting for the provider client, oldest first."""
    return r.lrange("purge:queue", 0, -1)


def set_outcomes(purge_id: str, outcomes: dict[str, str]) -> None:
    """Record the provider client's outcome for each path."""
    if outcomes:
        r.hset(f"purge:{purge_id}:outcomes", mapping=outcomes)


def confirm(purge_id: str, path: str, at: int) -> None:
    """The provider confirmed the path gone from every edge at unix second at."""
    r.hset(f"purge:{purge_id}:outcomes", path, "propagated")
    r.hset(f"purge:{purge_id}:confirmed", path, at)


def insert_outbox(topic: str, key: str, payload: dict) -> None:
    """Park an event the broker did not take: a relay publishes it later."""
    r.rpush("purge:outbox", json.dumps({"topic": topic, "key": key, "payload": payload}))


def outbox() -> list[dict]:
    """The parked events (topic, key, payload), oldest first."""
    return [json.loads(row) for row in r.lrange("purge:outbox", 0, -1)]
`,
};

export const supportModulesTs: Record<string, string> = {
  'purge/records.ts': `/**
 * The purge records (provided). purge:{id} is a hash (purge_id, tenant, domain, accepted_at in unix
 * seconds); purge:{id}:paths holds the paths in request order; purge:{id}:outcomes each path's
 * outcome (pending, accepted, invalid_pattern, failed, propagated); purge:{id}:confirmed the unix
 * second each path's propagation was confirmed. tenant:{tenant}:domains is the set of domains a
 * tenant owns, purge:key:{tenant}:{key} the purge an Idempotency-Key created, purge:queue the purges
 * waiting for the provider client, and purge:outbox the events a relay still has to publish.
 */
import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

export const KEY_TTL_S = 86400;

export interface Purge {
  purge_id: string;
  tenant: string;
  domain: string;
  accepted_at: number;
  paths: string[];
  outcomes: Record<string, string>;
  confirmed: Record<string, number>;
}

export interface OutboxRow {
  topic: string;
  key: string;
  payload: Record<string, unknown>;
}

/** Record that the tenant owns the domain. */
export async function addDomain(tenant: string, domain: string): Promise<void> {
  await redis.sadd(\`tenant:\${tenant}:domains\`, domain);
}

/** Whether the domain is one of the tenant's. */
export async function ownsDomain(tenant: string, domain: string): Promise<boolean> {
  return (await redis.sismember(\`tenant:\${tenant}:domains\`, domain)) === 1;
}

/** A new purge, accepted now: every path pending, the purge queued for the provider client. */
export async function create(tenant: string, domain: string, paths: string[]): Promise<Purge> {
  const purgeId = \`pg-\${await redis.incr('purge:seq')}\`;
  const acceptedAt = Math.floor(Date.now() / 1000);
  await redis.hset(\`purge:\${purgeId}\`, {purge_id: purgeId, tenant, domain, accepted_at: String(acceptedAt)});
  if (paths.length > 0) {
    await redis.rpush(\`purge:\${purgeId}:paths\`, ...paths);
    await redis.hset(\`purge:\${purgeId}:outcomes\`, Object.fromEntries(paths.map(path => [path, 'pending'])));
  }
  await redis.rpush('purge:queue', purgeId);
  return (await get(purgeId)) as Purge;
}

/** The purge (purge_id, tenant, domain, accepted_at, paths, outcomes, confirmed), or null. */
export async function get(purgeId: string): Promise<Purge | null> {
  const raw = await redis.hgetall(\`purge:\${purgeId}\`);
  if (Object.keys(raw).length === 0) return null;
  const confirmed = await redis.hgetall(\`purge:\${purgeId}:confirmed\`);
  return {
    purge_id: raw.purge_id,
    tenant: raw.tenant,
    domain: raw.domain,
    accepted_at: Number(raw.accepted_at),
    paths: await redis.lrange(\`purge:\${purgeId}:paths\`, 0, -1),
    outcomes: await redis.hgetall(\`purge:\${purgeId}:outcomes\`),
    confirmed: Object.fromEntries(Object.entries(confirmed).map(([path, at]) => [path, Number(at)])),
  };
}

/** The id of the purge the tenant's Idempotency-Key created, if any. */
export async function purgeForKey(tenant: string, key: string): Promise<string | null> {
  return redis.get(\`purge:key:\${tenant}:\${key}\`);
}

/** Record which purge the tenant's Idempotency-Key created (kept for a day). */
export async function rememberKey(tenant: string, key: string, purgeId: string): Promise<void> {
  await redis.set(\`purge:key:\${tenant}:\${key}\`, purgeId, 'EX', KEY_TTL_S);
}

/** The ids of the purges waiting for the provider client, oldest first. */
export async function queued(): Promise<string[]> {
  return redis.lrange('purge:queue', 0, -1);
}

/** Record the provider client's outcome for each path. */
export async function setOutcomes(purgeId: string, outcomes: Record<string, string>): Promise<void> {
  if (Object.keys(outcomes).length > 0) await redis.hset(\`purge:\${purgeId}:outcomes\`, outcomes);
}

/** The provider confirmed the path gone from every edge at unix second at. */
export async function confirm(purgeId: string, path: string, at: number): Promise<void> {
  await redis.hset(\`purge:\${purgeId}:outcomes\`, path, 'propagated');
  await redis.hset(\`purge:\${purgeId}:confirmed\`, path, String(at));
}

/** Park an event the broker did not take: a relay publishes it later. */
export async function insertOutbox(topic: string, key: string, payload: Record<string, unknown>): Promise<void> {
  await redis.rpush('purge:outbox', JSON.stringify({topic, key, payload}));
}

/** The parked events (topic, key, payload), oldest first. */
export async function outbox(): Promise<OutboxRow[]> {
  return (await redis.lrange('purge:outbox', 0, -1)).map(row => JSON.parse(row) as OutboxRow);
}
`,
};

export const supportModulesGo: Record<string, string> = {
  'purge/records/records.go': `// Package records holds the purge records (provided). purge:{id} is a hash (purge_id, tenant,
// domain, accepted_at in unix seconds); purge:{id}:paths holds the paths in request order;
// purge:{id}:outcomes each path's outcome (pending, accepted, invalid_pattern, failed,
// propagated); purge:{id}:confirmed the unix second each path's propagation was confirmed.
// tenant:{tenant}:domains is the set of domains a tenant owns, purge:key:{tenant}:{key} the purge
// an Idempotency-Key created, purge:queue the purges waiting for the provider client, and
// purge:outbox the events a relay still has to publish.
package records

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"
)

// KeyTTL is how long an Idempotency-Key keeps pointing at its purge.
const KeyTTL = 24 * time.Hour

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// Purge is one accepted purge and what became of each of its paths.
type Purge struct {
	PurgeID    string            \`json:"purge_id"\`
	Tenant     string            \`json:"tenant"\`
	Domain     string            \`json:"domain"\`
	AcceptedAt int64             \`json:"accepted_at"\`
	Paths      []string          \`json:"paths"\`
	Outcomes   map[string]string \`json:"outcomes"\`
	Confirmed  map[string]int64  \`json:"confirmed"\`
}

// OutboxRow is an event the broker did not take.
type OutboxRow struct {
	Topic   string         \`json:"topic"\`
	Key     string         \`json:"key"\`
	Payload map[string]any \`json:"payload"\`
}

// AddDomain records that the tenant owns the domain.
func AddDomain(ctx context.Context, tenant, domain string) {
	rdb.SAdd(ctx, "tenant:"+tenant+":domains", domain)
}

// OwnsDomain reports whether the domain is one of the tenant's.
func OwnsDomain(ctx context.Context, tenant, domain string) bool {
	return rdb.SIsMember(ctx, "tenant:"+tenant+":domains", domain).Val()
}

// Create records a new purge, accepted now: every path pending, the purge queued for the provider client.
func Create(ctx context.Context, tenant, domain string, paths []string) *Purge {
	purgeID := fmt.Sprintf("pg-%d", rdb.Incr(ctx, "purge:seq").Val())
	rdb.HSet(ctx, "purge:"+purgeID, map[string]any{"purge_id": purgeID, "tenant": tenant, "domain": domain, "accepted_at": strconv.FormatInt(time.Now().Unix(), 10)})
	if len(paths) > 0 {
		values := make([]any, len(paths))
		outcomes := map[string]any{}
		for i, path := range paths {
			values[i] = path
			outcomes[path] = "pending"
		}
		rdb.RPush(ctx, "purge:"+purgeID+":paths", values...)
		rdb.HSet(ctx, "purge:"+purgeID+":outcomes", outcomes)
	}
	rdb.RPush(ctx, "purge:queue", purgeID)
	return Get(ctx, purgeID)
}

// Get is the purge, or nil.
func Get(ctx context.Context, purgeID string) *Purge {
	raw := rdb.HGetAll(ctx, "purge:"+purgeID).Val()
	if len(raw) == 0 {
		return nil
	}
	acceptedAt, _ := strconv.ParseInt(raw["accepted_at"], 10, 64)
	confirmed := map[string]int64{}
	for path, at := range rdb.HGetAll(ctx, "purge:"+purgeID+":confirmed").Val() {
		confirmed[path], _ = strconv.ParseInt(at, 10, 64)
	}
	return &Purge{
		PurgeID:    raw["purge_id"],
		Tenant:     raw["tenant"],
		Domain:     raw["domain"],
		AcceptedAt: acceptedAt,
		Paths:      rdb.LRange(ctx, "purge:"+purgeID+":paths", 0, -1).Val(),
		Outcomes:   rdb.HGetAll(ctx, "purge:"+purgeID+":outcomes").Val(),
		Confirmed:  confirmed,
	}
}

// PurgeForKey is the id of the purge the tenant's Idempotency-Key created, or "".
func PurgeForKey(ctx context.Context, tenant, key string) string {
	return rdb.Get(ctx, "purge:key:"+tenant+":"+key).Val()
}

// RememberKey records which purge the tenant's Idempotency-Key created (kept for a day).
func RememberKey(ctx context.Context, tenant, key, purgeID string) {
	rdb.Set(ctx, "purge:key:"+tenant+":"+key, purgeID, KeyTTL)
}

// Queued is the ids of the purges waiting for the provider client, oldest first.
func Queued(ctx context.Context) []string {
	return rdb.LRange(ctx, "purge:queue", 0, -1).Val()
}

// SetOutcomes records the provider client's outcome for each path.
func SetOutcomes(ctx context.Context, purgeID string, outcomes map[string]string) {
	if len(outcomes) > 0 {
		rdb.HSet(ctx, "purge:"+purgeID+":outcomes", outcomes)
	}
}

// Confirm records that the provider confirmed the path gone from every edge at unix second at.
func Confirm(ctx context.Context, purgeID, path string, at int64) {
	rdb.HSet(ctx, "purge:"+purgeID+":outcomes", path, "propagated")
	rdb.HSet(ctx, "purge:"+purgeID+":confirmed", path, strconv.FormatInt(at, 10))
}

// InsertOutbox parks an event the broker did not take: a relay publishes it later.
func InsertOutbox(ctx context.Context, topic, key string, payload any) error {
	row, err := json.Marshal(map[string]any{"topic": topic, "key": key, "payload": payload})
	if err != nil {
		return err
	}
	return rdb.RPush(ctx, "purge:outbox", string(row)).Err()
}

// Outbox is the parked events, oldest first.
func Outbox(ctx context.Context) []OutboxRow {
	var rows []OutboxRow
	for _, text := range rdb.LRange(ctx, "purge:outbox", 0, -1).Val() {
		var row OutboxRow
		if json.Unmarshal([]byte(text), &row) == nil {
			rows = append(rows, row)
		}
	}
	return rows
}
`,
};

export const supportModulesCpp: Record<string, string> = {
  'purge/records.h': `// The purge records (provided). purge:{id} is a hash (purge_id, tenant, domain, accepted_at in
// unix seconds); purge:{id}:paths holds the paths in request order; purge:{id}:outcomes each
// path's outcome (pending, accepted, invalid_pattern, failed, propagated); purge:{id}:confirmed
// the unix second each path's propagation was confirmed. tenant:{tenant}:domains is the set of
// domains a tenant owns, purge:key:{tenant}:{key} the purge an Idempotency-Key created,
// purge:queue the purges waiting for the provider client, and purge:outbox the events a relay
// still has to publish.
#pragma once

#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <chrono>
#include <iterator>
#include <map>
#include <optional>
#include <string>
#include <unordered_map>
#include <vector>

namespace records {

constexpr long long kKeyTtlS = 86400;

struct Purge {
  std::string purge_id;
  std::string tenant;
  std::string domain;
  long long accepted_at = 0;
  std::vector<std::string> paths;
  std::map<std::string, std::string> outcomes;
  std::map<std::string, long long> confirmed;
};

inline sw::redis::Redis& redis() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

inline long long unixNow() {
  return std::chrono::duration_cast<std::chrono::seconds>(std::chrono::system_clock::now().time_since_epoch()).count();
}

// Record that the tenant owns the domain.
inline void addDomain(const std::string& tenant, const std::string& domain) { redis().sadd("tenant:" + tenant + ":domains", domain); }

// Whether the domain is one of the tenant's.
inline bool ownsDomain(const std::string& tenant, const std::string& domain) {
  return redis().sismember("tenant:" + tenant + ":domains", domain);
}

// The purge, or none.
inline std::optional<Purge> get(const std::string& purge_id) {
  std::unordered_map<std::string, std::string> raw;
  redis().hgetall("purge:" + purge_id, std::inserter(raw, raw.begin()));
  if (raw.empty()) return std::nullopt;
  Purge purge;
  purge.purge_id = raw["purge_id"];
  purge.tenant = raw["tenant"];
  purge.domain = raw["domain"];
  purge.accepted_at = raw["accepted_at"].empty() ? 0 : std::stoll(raw["accepted_at"]);
  redis().lrange("purge:" + purge_id + ":paths", 0, -1, std::back_inserter(purge.paths));
  redis().hgetall("purge:" + purge_id + ":outcomes", std::inserter(purge.outcomes, purge.outcomes.begin()));
  std::map<std::string, std::string> confirmed;
  redis().hgetall("purge:" + purge_id + ":confirmed", std::inserter(confirmed, confirmed.begin()));
  for (const auto& [path, at] : confirmed) purge.confirmed[path] = std::stoll(at);
  return purge;
}

// A new purge, accepted now: every path pending, the purge queued for the provider client.
inline Purge create(const std::string& tenant, const std::string& domain, const std::vector<std::string>& paths) {
  const std::string purge_id = "pg-" + std::to_string(redis().incr("purge:seq"));
  redis().hset("purge:" + purge_id, {std::make_pair(std::string("purge_id"), purge_id), std::make_pair(std::string("tenant"), tenant),
                                     std::make_pair(std::string("domain"), domain),
                                     std::make_pair(std::string("accepted_at"), std::to_string(unixNow()))});
  if (!paths.empty()) {
    redis().rpush("purge:" + purge_id + ":paths", paths.begin(), paths.end());
    std::map<std::string, std::string> outcomes;
    for (const auto& path : paths) outcomes[path] = "pending";
    redis().hset("purge:" + purge_id + ":outcomes", outcomes.begin(), outcomes.end());
  }
  redis().rpush("purge:queue", purge_id);
  return *get(purge_id);
}

// The id of the purge the tenant's Idempotency-Key created, if any.
inline std::optional<std::string> purgeForKey(const std::string& tenant, const std::string& key) {
  const auto id = redis().get("purge:key:" + tenant + ":" + key);
  if (!id) return std::nullopt;
  return *id;
}

// Record which purge the tenant's Idempotency-Key created (kept for a day).
inline void rememberKey(const std::string& tenant, const std::string& key, const std::string& purge_id) {
  redis().set("purge:key:" + tenant + ":" + key, purge_id, std::chrono::seconds(kKeyTtlS));
}

// The ids of the purges waiting for the provider client, oldest first.
inline std::vector<std::string> queued() {
  std::vector<std::string> ids;
  redis().lrange("purge:queue", 0, -1, std::back_inserter(ids));
  return ids;
}

// Record the provider client's outcome for each path.
inline void setOutcomes(const std::string& purge_id, const std::map<std::string, std::string>& outcomes) {
  if (!outcomes.empty()) redis().hset("purge:" + purge_id + ":outcomes", outcomes.begin(), outcomes.end());
}

// The provider confirmed the path gone from every edge at unix second at.
inline void confirm(const std::string& purge_id, const std::string& path, long long at) {
  redis().hset("purge:" + purge_id + ":outcomes", path, "propagated");
  redis().hset("purge:" + purge_id + ":confirmed", path, std::to_string(at));
}

// Park an event the broker did not take: a relay publishes it later.
inline void insertOutbox(const std::string& topic, const std::string& key, const nlohmann::json& payload) {
  redis().rpush("purge:outbox", nlohmann::json{{"topic", topic}, {"key", key}, {"payload", payload}}.dump());
}

// The parked events (topic, key, payload), oldest first.
inline std::vector<nlohmann::json> outbox() {
  std::vector<std::string> rows;
  redis().lrange("purge:outbox", 0, -1, std::back_inserter(rows));
  std::vector<nlohmann::json> out;
  for (const auto& row : rows) out.push_back(nlohmann::json::parse(row));
  return out;
}

}  // namespace records
`,
};

export const supportModulesScala: Record<string, string> = {
  [scalaPath('purge', 'Records')]: `package purge

import redis.clients.jedis.JedisPooled
import redis.clients.jedis.params.SetParams
import spray.json._

import scala.jdk.CollectionConverters._

/**
 * The purge records (provided). purge:{id} is a hash (purge_id, tenant, domain, accepted_at in unix
 * seconds); purge:{id}:paths holds the paths in request order; purge:{id}:outcomes each path's
 * outcome (pending, accepted, invalid_pattern, failed, propagated); purge:{id}:confirmed the unix
 * second each path's propagation was confirmed. tenant:{tenant}:domains is the set of domains a
 * tenant owns, purge:key:{tenant}:{key} the purge an Idempotency-Key created, purge:queue the purges
 * waiting for the provider client, and purge:outbox the events a relay still has to publish.
 */
object Records {
  final case class Purge(
      purgeId: String,
      tenant: String,
      domain: String,
      acceptedAt: Long,
      paths: Seq[String],
      outcomes: Map[String, String],
      confirmed: Map[String, Long]
  )

  val KeyTtlS = 86400L

  val jedis = new JedisPooled("redis", 6379)

  /** Record that the tenant owns the domain. */
  def addDomain(tenant: String, domain: String): Unit = jedis.sadd(s"tenant:$tenant:domains", domain)

  /** Whether the domain is one of the tenant's. */
  def ownsDomain(tenant: String, domain: String): Boolean = jedis.sismember(s"tenant:$tenant:domains", domain)

  /** A new purge, accepted now: every path pending, the purge queued for the provider client. */
  def create(tenant: String, domain: String, paths: Seq[String]): Purge = {
    val purgeId = s"pg-\${jedis.incr("purge:seq")}"
    val acceptedAt = System.currentTimeMillis() / 1000
    jedis.hset(s"purge:$purgeId", Map("purge_id" -> purgeId, "tenant" -> tenant, "domain" -> domain, "accepted_at" -> acceptedAt.toString).asJava)
    if (paths.nonEmpty) {
      jedis.rpush(s"purge:$purgeId:paths", paths: _*)
      jedis.hset(s"purge:$purgeId:outcomes", paths.map(_ -> "pending").toMap.asJava)
    }
    jedis.rpush("purge:queue", purgeId)
    get(purgeId).get
  }

  /** The purge, if it exists. */
  def get(purgeId: String): Option[Purge] = {
    val raw = jedis.hgetAll(s"purge:$purgeId").asScala.toMap
    if (raw.isEmpty) None
    else
      Some(
        Purge(
          raw("purge_id"),
          raw("tenant"),
          raw("domain"),
          raw("accepted_at").toLong,
          jedis.lrange(s"purge:$purgeId:paths", 0, -1).asScala.toSeq,
          jedis.hgetAll(s"purge:$purgeId:outcomes").asScala.toMap,
          jedis.hgetAll(s"purge:$purgeId:confirmed").asScala.toMap.map { case (path, at) => path -> at.toLong }
        )
      )
  }

  /** The id of the purge the tenant's Idempotency-Key created, if any. */
  def purgeForKey(tenant: String, key: String): Option[String] = Option(jedis.get(s"purge:key:$tenant:$key"))

  /** Record which purge the tenant's Idempotency-Key created (kept for a day). */
  def rememberKey(tenant: String, key: String, purgeId: String): Unit =
    jedis.set(s"purge:key:$tenant:$key", purgeId, SetParams.setParams().ex(KeyTtlS))

  /** The ids of the purges waiting for the provider client, oldest first. */
  def queued(): Seq[String] = jedis.lrange("purge:queue", 0, -1).asScala.toSeq

  /** Record the provider client's outcome for each path. */
  def setOutcomes(purgeId: String, outcomes: Map[String, String]): Unit =
    if (outcomes.nonEmpty) jedis.hset(s"purge:$purgeId:outcomes", outcomes.asJava)

  /** The provider confirmed the path gone from every edge at unix second at. */
  def confirm(purgeId: String, path: String, at: Long): Unit = {
    jedis.hset(s"purge:$purgeId:outcomes", path, "propagated")
    jedis.hset(s"purge:$purgeId:confirmed", path, at.toString)
  }

  /** Park an event the broker did not take: a relay publishes it later. */
  def insertOutbox(topic: String, key: String, payload: JsObject): Unit =
    jedis.rpush("purge:outbox", JsObject("topic" -> JsString(topic), "key" -> JsString(key), "payload" -> payload).compactPrint)

  /** The parked events, oldest first. */
  def outbox(): Seq[JsObject] = jedis.lrange("purge:outbox", 0, -1).asScala.toSeq.map(_.parseJson.asJsObject)
}
`,
};
