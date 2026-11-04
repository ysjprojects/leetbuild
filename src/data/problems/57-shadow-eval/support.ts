/**
 * Hand-written support modules the shadow-eval steps import but no step builds: `shadow.store`, the
 * shadow runner's store in Redis. Configs and their kill switch, the idempotency records (the
 * platform's namespace production uses and the shadow's own), the outcome counters of shadowed
 * requests, the paired-delta aggregate the comparison consumer keeps, the outbox, and the request
 * fingerprint. The five languages keep the same keys, so a harness reads one layout whatever the stack.
 */
import {scalaPath} from '../scala-support';

export const supportModules: Record<string, string> = {
  'shadow/__init__.py': '',
  'shadow/store.py': `"""
The shadow runner's store (provided), in Redis.

- shadow:config:{config_id}: the config hash (config_id, tenant, candidate_version, share, metrics
  as a comma-joined list); shadow:{config_id}:enabled is its kill switch, "1" or "0".
- {namespace}:{tenant}:{key}: an idempotency record, the config id a request created. IDEMPOTENCY_NS
  is the platform's store, the one production's request path reads and writes; SHADOW_NS is the
  shadow runner's own.
- shadow:{config_id}:stats: what happened to each shadowed request (completed, dropped).
- shadow:{config_id}:pairs: what the comparison consumer aggregates from shadow.sample, the count
  n, the sum and the sum of squares of the paired score deltas, first_at and last_at (unix seconds).
- shadow:outbox: JSON rows {"topic", "key", "payload"} a relay publishes once the broker is back.
"""
import json

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

IDEMPOTENCY_NS = "idem"
SHADOW_NS = "shadow:idem"


def create_config(tenant: str, candidate_version: str, share: int, metrics: list[str]) -> dict:
    """A new config, enabled; returns it."""
    config_id = f"cfg-{r.incr('shadow:config:seq')}"
    r.hset(
        f"shadow:config:{config_id}",
        mapping={"config_id": config_id, "tenant": tenant, "candidate_version": candidate_version, "share": share, "metrics": ",".join(metrics)},
    )
    r.set(f"shadow:{config_id}:enabled", "1")
    return get_config(config_id)


def get_config(config_id: str) -> dict | None:
    """The config {config_id, tenant, candidate_version, share, metrics}, or None."""
    raw = r.hgetall(f"shadow:config:{config_id}")
    if not raw:
        return None
    return {
        "config_id": raw["config_id"],
        "tenant": raw["tenant"],
        "candidate_version": raw["candidate_version"],
        "share": int(raw["share"]),
        "metrics": [m for m in raw["metrics"].split(",") if m],
    }


def set_enabled(config_id: str, on: bool) -> None:
    """Flip the config's kill switch."""
    r.set(f"shadow:{config_id}:enabled", "1" if on else "0")


def recall(namespace: str, tenant: str, key: str) -> str | None:
    """The config id recorded for (tenant, key) in the namespace, or None."""
    return r.get(f"{namespace}:{tenant}:{key}")


def remember(namespace: str, tenant: str, key: str, config_id: str) -> None:
    """Record that (tenant, key) created config_id, in the namespace."""
    r.set(f"{namespace}:{tenant}:{key}", config_id)


def count(config_id: str, outcome: str) -> None:
    """One more shadowed request with this outcome (completed, dropped)."""
    r.hincrby(f"shadow:{config_id}:stats", outcome, 1)


def fingerprint(text: str) -> str:
    """FNV-1a 64 of the UTF-8 text, as 16 hex digits: the same text gives the same fingerprint, the text is not in it."""
    h = 0xCBF29CE484222325
    for byte in text.encode("utf-8"):
        h = ((h ^ byte) * 0x100000001B3) & 0xFFFFFFFFFFFFFFFF
    return f"{h:016x}"


def insert_outbox(topic: str, key: str, payload: dict) -> None:
    """Queue a record for the relay to publish later."""
    r.rpush("shadow:outbox", json.dumps({"topic": topic, "key": key, "payload": payload}))


def record_pair(config_id: str, delta: float, at: int) -> None:
    """The comparison consumer's write: one more paired delta, at unix second at. One consumer owns a config's partition."""
    key = f"shadow:{config_id}:pairs"
    r.hincrby(key, "n", 1)
    r.hincrbyfloat(key, "sum", delta)
    r.hincrbyfloat(key, "sumsq", delta * delta)
    r.hsetnx(key, "first_at", at)
    r.hset(key, "last_at", at)


def pair_stats(config_id: str) -> dict | None:
    """{n, sum, sumsq, first_at, last_at} of the config's paired deltas, or None before the first pair."""
    raw = r.hgetall(f"shadow:{config_id}:pairs")
    if not raw:
        return None
    return {
        "n": int(raw["n"]),
        "sum": float(raw["sum"]),
        "sumsq": float(raw["sumsq"]),
        "first_at": int(raw["first_at"]),
        "last_at": int(raw["last_at"]),
    }
`,
};

export const supportModulesTs: Record<string, string> = {
  'shadow/store.ts': `/**
 * The shadow runner's store (provided), in Redis.
 *
 * - shadow:config:{config_id}: the config hash (config_id, tenant, candidate_version, share, metrics
 *   as a comma-joined list); shadow:{config_id}:enabled is its kill switch, "1" or "0".
 * - {namespace}:{tenant}:{key}: an idempotency record, the config id a request created.
 *   IDEMPOTENCY_NS is the platform's store, the one production's request path reads and writes;
 *   SHADOW_NS is the shadow runner's own.
 * - shadow:{config_id}:stats: what happened to each shadowed request (completed, dropped).
 * - shadow:{config_id}:pairs: what the comparison consumer aggregates from shadow.sample, the count
 *   n, the sum and the sum of squares of the paired score deltas, first_at and last_at (unix seconds).
 * - shadow:outbox: JSON rows {"topic", "key", "payload"} a relay publishes once the broker is back.
 */
import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

export const IDEMPOTENCY_NS = 'idem';
export const SHADOW_NS = 'shadow:idem';

export interface Config {
  config_id: string;
  tenant: string;
  candidate_version: string;
  share: number;
  metrics: string[];
}

/** One shadowed request: the prompt, both versions' answers and their evaluator scores, at unix second at. */
export interface Pair {
  user_id: string;
  prompt: string;
  production_version: string;
  production_text: string;
  production_score: number;
  candidate_version: string;
  candidate_text: string;
  candidate_score: number;
  at: number;
}

export interface PairStats {
  n: number;
  sum: number;
  sumsq: number;
  first_at: number;
  last_at: number;
}

/** A new config, enabled; returns it. */
export async function createConfig(tenant: string, candidateVersion: string, share: number, metrics: string[]): Promise<Config> {
  const configId = \`cfg-\${await redis.incr('shadow:config:seq')}\`;
  await redis.hset(\`shadow:config:\${configId}\`, {
    config_id: configId,
    tenant,
    candidate_version: candidateVersion,
    share: String(share),
    metrics: metrics.join(','),
  });
  await redis.set(\`shadow:\${configId}:enabled\`, '1');
  return (await getConfig(configId)) as Config;
}

/** The config, or null. */
export async function getConfig(configId: string): Promise<Config | null> {
  const raw = await redis.hgetall(\`shadow:config:\${configId}\`);
  if (Object.keys(raw).length === 0) return null;
  return {
    config_id: raw.config_id,
    tenant: raw.tenant,
    candidate_version: raw.candidate_version,
    share: Number(raw.share),
    metrics: raw.metrics.split(',').filter(m => m !== ''),
  };
}

/** Flip the config's kill switch. */
export async function setEnabled(configId: string, on: boolean): Promise<void> {
  await redis.set(\`shadow:\${configId}:enabled\`, on ? '1' : '0');
}

/** The config id recorded for (tenant, key) in the namespace, or null. */
export async function recall(namespace: string, tenant: string, key: string): Promise<string | null> {
  return redis.get(\`\${namespace}:\${tenant}:\${key}\`);
}

/** Record that (tenant, key) created configId, in the namespace. */
export async function remember(namespace: string, tenant: string, key: string, configId: string): Promise<void> {
  await redis.set(\`\${namespace}:\${tenant}:\${key}\`, configId);
}

/** One more shadowed request with this outcome (completed, dropped). */
export async function count(configId: string, outcome: string): Promise<void> {
  await redis.hincrby(\`shadow:\${configId}:stats\`, outcome, 1);
}

/** FNV-1a 64 of the UTF-8 text, as 16 hex digits: the same text gives the same fingerprint, the text is not in it. */
export function fingerprint(text: string): string {
  let h = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(text)) {
    h = ((h ^ BigInt(byte)) * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, '0');
}

/** Queue a record for the relay to publish later. */
export async function insertOutbox(topic: string, key: string, payload: Record<string, unknown>): Promise<void> {
  await redis.rpush('shadow:outbox', JSON.stringify({topic, key, payload}));
}

/** The comparison consumer's write: one more paired delta, at unix second at. One consumer owns a config's partition. */
export async function recordPair(configId: string, delta: number, at: number): Promise<void> {
  const key = \`shadow:\${configId}:pairs\`;
  await redis.hincrby(key, 'n', 1);
  await redis.hincrbyfloat(key, 'sum', delta);
  await redis.hincrbyfloat(key, 'sumsq', delta * delta);
  await redis.hsetnx(key, 'first_at', String(at));
  await redis.hset(key, 'last_at', String(at));
}

/** {n, sum, sumsq, first_at, last_at} of the config's paired deltas, or null before the first pair. */
export async function pairStats(configId: string): Promise<PairStats | null> {
  const raw = await redis.hgetall(\`shadow:\${configId}:pairs\`);
  if (Object.keys(raw).length === 0) return null;
  return {
    n: Number(raw.n),
    sum: Number(raw.sum),
    sumsq: Number(raw.sumsq),
    first_at: Number(raw.first_at),
    last_at: Number(raw.last_at),
  };
}
`,
};

export const supportModulesGo: Record<string, string> = {
  'shadow/store/store.go': `// Package store is the shadow runner's store (provided), in Redis.
//
//   - shadow:config:{config_id}: the config hash (config_id, tenant, candidate_version, share,
//     metrics as a comma-joined list); shadow:{config_id}:enabled is its kill switch, "1" or "0".
//   - {namespace}:{tenant}:{key}: an idempotency record, the config id a request created.
//     IdempotencyNS is the platform's store, the one production's request path reads and writes;
//     ShadowNS is the shadow runner's own.
//   - shadow:{config_id}:stats: what happened to each shadowed request (completed, dropped).
//   - shadow:{config_id}:pairs: what the comparison consumer aggregates from shadow.sample, the
//     count n, the sum and the sum of squares of the paired score deltas, first_at and last_at.
//   - shadow:outbox: JSON rows {"topic", "key", "payload"} a relay publishes once the broker is back.
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

const (
	IdempotencyNS = "idem"
	ShadowNS      = "shadow:idem"
)

// Config is one shadow config.
type Config struct {
	ConfigID         string   \`json:"config_id"\`
	Tenant           string   \`json:"tenant"\`
	CandidateVersion string   \`json:"candidate_version"\`
	Share            int      \`json:"share"\`
	Metrics          []string \`json:"metrics"\`
}

// Pair is one shadowed request: the prompt, both versions' answers and their evaluator scores, at unix second At.
type Pair struct {
	UserID            string
	Prompt            string
	ProductionVersion string
	ProductionText    string
	ProductionScore   float64
	CandidateVersion  string
	CandidateText     string
	CandidateScore    float64
	At                int64
}

// PairStats is the aggregate of a config's paired deltas.
type PairStats struct {
	N       int64
	Sum     float64
	SumSq   float64
	FirstAt int64
	LastAt  int64
}

// CreateConfig makes a new config, enabled, and returns it.
func CreateConfig(ctx context.Context, tenant, candidateVersion string, share int, metrics []string) *Config {
	configID := fmt.Sprintf("cfg-%d", rdb.Incr(ctx, "shadow:config:seq").Val())
	rdb.HSet(ctx, "shadow:config:"+configID, map[string]any{
		"config_id": configID, "tenant": tenant, "candidate_version": candidateVersion,
		"share": strconv.Itoa(share), "metrics": strings.Join(metrics, ","),
	})
	rdb.Set(ctx, "shadow:"+configID+":enabled", "1", 0)
	return GetConfig(ctx, configID)
}

// GetConfig is the config, or nil.
func GetConfig(ctx context.Context, configID string) *Config {
	raw := rdb.HGetAll(ctx, "shadow:config:"+configID).Val()
	if len(raw) == 0 {
		return nil
	}
	share, _ := strconv.Atoi(raw["share"])
	metrics := []string{}
	for _, m := range strings.Split(raw["metrics"], ",") {
		if m != "" {
			metrics = append(metrics, m)
		}
	}
	return &Config{ConfigID: raw["config_id"], Tenant: raw["tenant"], CandidateVersion: raw["candidate_version"], Share: share, Metrics: metrics}
}

// SetEnabled flips the config's kill switch.
func SetEnabled(ctx context.Context, configID string, on bool) {
	value := "0"
	if on {
		value = "1"
	}
	rdb.Set(ctx, "shadow:"+configID+":enabled", value, 0)
}

// Recall is the config id recorded for (tenant, key) in the namespace, or "".
func Recall(ctx context.Context, namespace, tenant, key string) string {
	return rdb.Get(ctx, namespace+":"+tenant+":"+key).Val()
}

// Remember records that (tenant, key) created configID, in the namespace.
func Remember(ctx context.Context, namespace, tenant, key, configID string) {
	rdb.Set(ctx, namespace+":"+tenant+":"+key, configID, 0)
}

// Count adds one shadowed request with this outcome (completed, dropped).
func Count(ctx context.Context, configID, outcome string) {
	rdb.HIncrBy(ctx, "shadow:"+configID+":stats", outcome, 1)
}

// Fingerprint is FNV-1a 64 of the UTF-8 text, as 16 hex digits: the same text gives the same
// fingerprint, the text is not in it.
func Fingerprint(text string) string {
	h := uint64(0xcbf29ce484222325)
	for _, b := range []byte(text) {
		h ^= uint64(b)
		h *= 0x100000001b3
	}
	return fmt.Sprintf("%016x", h)
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
	return rdb.RPush(ctx, "shadow:outbox", row).Err()
}

// RecordPair is the comparison consumer's write: one more paired delta, at unix second at. One
// consumer owns a config's partition.
func RecordPair(ctx context.Context, configID string, delta float64, at int64) {
	key := "shadow:" + configID + ":pairs"
	rdb.HIncrBy(ctx, key, "n", 1)
	rdb.HIncrByFloat(ctx, key, "sum", delta)
	rdb.HIncrByFloat(ctx, key, "sumsq", delta*delta)
	rdb.HSetNX(ctx, key, "first_at", strconv.FormatInt(at, 10))
	rdb.HSet(ctx, key, "last_at", strconv.FormatInt(at, 10))
}

// GetPairStats is the aggregate of the config's paired deltas, or nil before the first pair.
func GetPairStats(ctx context.Context, configID string) *PairStats {
	raw := rdb.HGetAll(ctx, "shadow:"+configID+":pairs").Val()
	if len(raw) == 0 {
		return nil
	}
	n, _ := strconv.ParseInt(raw["n"], 10, 64)
	sum, _ := strconv.ParseFloat(raw["sum"], 64)
	sumsq, _ := strconv.ParseFloat(raw["sumsq"], 64)
	first, _ := strconv.ParseInt(raw["first_at"], 10, 64)
	last, _ := strconv.ParseInt(raw["last_at"], 10, 64)
	return &PairStats{N: n, Sum: sum, SumSq: sumsq, FirstAt: first, LastAt: last}
}
`,
};

export const supportModulesCpp: Record<string, string> = {
  'shadow/store.h': `// The shadow runner's store (provided), in Redis.
//
// - shadow:config:{config_id}: the config hash (config_id, tenant, candidate_version, share, metrics
//   as a comma-joined list); shadow:{config_id}:enabled is its kill switch, "1" or "0".
// - {namespace}:{tenant}:{key}: an idempotency record, the config id a request created.
//   kIdempotencyNs is the platform's store, the one production's request path reads and writes;
//   kShadowNs is the shadow runner's own.
// - shadow:{config_id}:stats: what happened to each shadowed request (completed, dropped).
// - shadow:{config_id}:pairs: what the comparison consumer aggregates from shadow.sample, the count
//   n, the sum and the sum of squares of the paired score deltas, first_at and last_at.
// - shadow:outbox: JSON rows {"topic", "key", "payload"} a relay publishes once the broker is back.
#pragma once

#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <cstdint>
#include <cstdio>
#include <optional>
#include <sstream>
#include <string>
#include <unordered_map>
#include <vector>

namespace store {

inline const std::string kIdempotencyNs = "idem";
inline const std::string kShadowNs = "shadow:idem";

struct Config {
  std::string config_id;
  std::string tenant;
  std::string candidate_version;
  long share = 0;
  std::vector<std::string> metrics;
};

// One shadowed request: the prompt, both versions' answers and their evaluator scores, at unix second at.
struct Pair {
  std::string user_id;
  std::string prompt;
  std::string production_version;
  std::string production_text;
  double production_score = 0;
  std::string candidate_version;
  std::string candidate_text;
  double candidate_score = 0;
  long long at = 0;
};

// The aggregate of a config's paired deltas.
struct PairStats {
  long long n = 0;
  double sum = 0;
  double sumsq = 0;
  long long first_at = 0;
  long long last_at = 0;
};

inline sw::redis::Redis& redis() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

// The config as the API answers it.
inline nlohmann::json toJson(const Config& c) {
  return nlohmann::json{{"config_id", c.config_id}, {"tenant", c.tenant}, {"candidate_version", c.candidate_version},
                        {"share", c.share}, {"metrics", c.metrics}};
}

// The config, or none.
inline std::optional<Config> getConfig(const std::string& config_id) {
  std::unordered_map<std::string, std::string> raw = redis().hgetall("shadow:config:" + config_id);
  if (raw.empty()) return std::nullopt;
  Config c;
  c.config_id = raw["config_id"];
  c.tenant = raw["tenant"];
  c.candidate_version = raw["candidate_version"];
  c.share = raw["share"].empty() ? 0 : std::stol(raw["share"]);
  std::stringstream metrics(raw["metrics"]);
  for (std::string m; std::getline(metrics, m, ',');) {
    if (!m.empty()) c.metrics.push_back(m);
  }
  return c;
}

// A new config, enabled; returns it.
inline Config createConfig(const std::string& tenant, const std::string& candidate_version, long share,
                           const std::vector<std::string>& metrics) {
  const std::string config_id = "cfg-" + std::to_string(redis().incr("shadow:config:seq"));
  std::string joined;
  for (const auto& m : metrics) joined += (joined.empty() ? "" : ",") + m;
  redis().hset("shadow:config:" + config_id, {std::make_pair(std::string("config_id"), config_id),
                                               std::make_pair(std::string("tenant"), tenant),
                                               std::make_pair(std::string("candidate_version"), candidate_version),
                                               std::make_pair(std::string("share"), std::to_string(share)),
                                               std::make_pair(std::string("metrics"), joined)});
  redis().set("shadow:" + config_id + ":enabled", "1");
  return *getConfig(config_id);
}

// Flip the config's kill switch.
inline void setEnabled(const std::string& config_id, bool on) { redis().set("shadow:" + config_id + ":enabled", on ? "1" : "0"); }

// The config id recorded for (tenant, key) in the namespace, or none.
inline std::optional<std::string> recall(const std::string& ns, const std::string& tenant, const std::string& key) {
  const auto value = redis().get(ns + ":" + tenant + ":" + key);
  if (!value) return std::nullopt;
  return *value;
}

// Record that (tenant, key) created config_id, in the namespace.
inline void remember(const std::string& ns, const std::string& tenant, const std::string& key, const std::string& config_id) {
  redis().set(ns + ":" + tenant + ":" + key, config_id);
}

// One more shadowed request with this outcome (completed, dropped).
inline void count(const std::string& config_id, const std::string& outcome) {
  redis().hincrby("shadow:" + config_id + ":stats", outcome, 1);
}

// FNV-1a 64 of the UTF-8 text, as 16 hex digits: the same text gives the same fingerprint, the text is not in it.
inline std::string fingerprint(const std::string& text) {
  uint64_t h = 0xcbf29ce484222325ULL;
  for (unsigned char byte : text) {
    h ^= byte;
    h *= 0x100000001b3ULL;
  }
  char out[17];
  std::snprintf(out, sizeof out, "%016llx", static_cast<unsigned long long>(h));
  return out;
}

// Queue a record for the relay to publish later.
inline void insertOutbox(const std::string& topic, const std::string& key, const nlohmann::json& payload) {
  redis().rpush("shadow:outbox", nlohmann::json{{"topic", topic}, {"key", key}, {"payload", payload}}.dump());
}

// The comparison consumer's write: one more paired delta, at unix second at. One consumer owns a config's partition.
inline void recordPair(const std::string& config_id, double delta, long long at) {
  const std::string key = "shadow:" + config_id + ":pairs";
  redis().hincrby(key, "n", 1);
  redis().hincrbyfloat(key, "sum", delta);
  redis().hincrbyfloat(key, "sumsq", delta * delta);
  redis().hsetnx(key, "first_at", std::to_string(at));
  redis().hset(key, "last_at", std::to_string(at));
}

// The aggregate of the config's paired deltas, or none before the first pair.
inline std::optional<PairStats> pairStats(const std::string& config_id) {
  std::unordered_map<std::string, std::string> raw = redis().hgetall("shadow:" + config_id + ":pairs");
  if (raw.empty()) return std::nullopt;
  PairStats s;
  s.n = std::stoll(raw["n"]);
  s.sum = std::stod(raw["sum"]);
  s.sumsq = std::stod(raw["sumsq"]);
  s.first_at = std::stoll(raw["first_at"]);
  s.last_at = std::stoll(raw["last_at"]);
  return s;
}

}  // namespace store
`,
};

export const supportModulesScala: Record<string, string> = {
  [scalaPath('shadow', 'Store')]: `package shadow

import redis.clients.jedis.JedisPooled
import spray.json._

import scala.jdk.CollectionConverters._

/**
 * The shadow runner's store (provided), in Redis.
 *
 * - shadow:config:{config_id}: the config hash (config_id, tenant, candidate_version, share, metrics
 *   as a comma-joined list); shadow:{config_id}:enabled is its kill switch, "1" or "0".
 * - {namespace}:{tenant}:{key}: an idempotency record, the config id a request created.
 *   IdempotencyNs is the platform's store, the one production's request path reads and writes;
 *   ShadowNs is the shadow runner's own.
 * - shadow:{config_id}:stats: what happened to each shadowed request (completed, dropped).
 * - shadow:{config_id}:pairs: what the comparison consumer aggregates from shadow.sample, the count
 *   n, the sum and the sum of squares of the paired score deltas, first_at and last_at.
 * - shadow:outbox: JSON rows {"topic", "key", "payload"} a relay publishes once the broker is back.
 */
object Store {
  final case class Config(configId: String, tenant: String, candidateVersion: String, share: Int, metrics: Seq[String]) {
    def toJson: JsObject = JsObject(
      "config_id" -> JsString(configId),
      "tenant" -> JsString(tenant),
      "candidate_version" -> JsString(candidateVersion),
      "share" -> JsNumber(share),
      "metrics" -> JsArray(metrics.map(JsString(_)).toVector))
  }

  /** One shadowed request: the prompt, both versions' answers and their evaluator scores, at unix second at. */
  final case class Pair(
      userId: String,
      prompt: String,
      productionVersion: String,
      productionText: String,
      productionScore: Double,
      candidateVersion: String,
      candidateText: String,
      candidateScore: Double,
      at: Long)

  /** The aggregate of a config's paired deltas. */
  final case class PairStats(n: Long, sum: Double, sumsq: Double, firstAt: Long, lastAt: Long)

  val IdempotencyNs = "idem"
  val ShadowNs = "shadow:idem"

  val jedis = new JedisPooled("redis", 6379)

  /** A new config, enabled; returns it. */
  def createConfig(tenant: String, candidateVersion: String, share: Int, metrics: Seq[String]): Config = {
    val configId = s"cfg-\${jedis.incr("shadow:config:seq")}"
    jedis.hset(s"shadow:config:$configId", Map(
      "config_id" -> configId, "tenant" -> tenant, "candidate_version" -> candidateVersion,
      "share" -> share.toString, "metrics" -> metrics.mkString(",")).asJava)
    jedis.set(s"shadow:$configId:enabled", "1")
    getConfig(configId).get
  }

  /** The config, if it exists. */
  def getConfig(configId: String): Option[Config] = {
    val raw = jedis.hgetAll(s"shadow:config:$configId").asScala.toMap
    if (raw.isEmpty) None
    else Some(Config(raw("config_id"), raw("tenant"), raw("candidate_version"), raw("share").toInt, raw("metrics").split(",").filter(_.nonEmpty).toSeq))
  }

  /** Flip the config's kill switch. */
  def setEnabled(configId: String, on: Boolean): Unit = jedis.set(s"shadow:$configId:enabled", if (on) "1" else "0")

  /** The config id recorded for (tenant, key) in the namespace, if any. */
  def recall(namespace: String, tenant: String, key: String): Option[String] = Option(jedis.get(s"$namespace:$tenant:$key"))

  /** Record that (tenant, key) created configId, in the namespace. */
  def remember(namespace: String, tenant: String, key: String, configId: String): Unit = jedis.set(s"$namespace:$tenant:$key", configId)

  /** One more shadowed request with this outcome (completed, dropped). */
  def count(configId: String, outcome: String): Unit = jedis.hincrBy(s"shadow:$configId:stats", outcome, 1L)

  /** FNV-1a 64 of the UTF-8 text, as 16 hex digits: the same text gives the same fingerprint, the text is not in it. */
  def fingerprint(text: String): String = {
    var h = 0xcbf29ce484222325L
    text.getBytes("UTF-8").foreach { b =>
      h ^= (b & 0xff).toLong
      h *= 0x100000001b3L
    }
    f"\${java.lang.Long.toUnsignedString(h, 16)}%16s".replace(' ', '0')
  }

  /** Queue a record for the relay to publish later. */
  def insertOutbox(topic: String, key: String, payload: JsObject): Unit =
    jedis.rpush("shadow:outbox", JsObject("topic" -> JsString(topic), "key" -> JsString(key), "payload" -> payload).compactPrint)

  /** The comparison consumer's write: one more paired delta, at unix second at. One consumer owns a config's partition. */
  def recordPair(configId: String, delta: Double, at: Long): Unit = {
    val key = s"shadow:$configId:pairs"
    jedis.hincrBy(key, "n", 1L)
    jedis.hincrByFloat(key, "sum", delta)
    jedis.hincrByFloat(key, "sumsq", delta * delta)
    jedis.hsetnx(key, "first_at", at.toString)
    jedis.hset(key, "last_at", at.toString)
  }

  /** The aggregate of the config's paired deltas, if any pair arrived. */
  def pairStats(configId: String): Option[PairStats] = {
    val raw = jedis.hgetAll(s"shadow:$configId:pairs").asScala.toMap
    if (raw.isEmpty) None
    else Some(PairStats(raw("n").toLong, raw("sum").toDouble, raw("sumsq").toDouble, raw("first_at").toLong, raw("last_at").toLong))
  }
}
`,
};
