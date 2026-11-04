/**
 * Hand-written support modules the reranker steps import but no step builds: the `rerank` package.
 * `config` is the contract every step agrees on (the model's address, the topic, the fingerprint,
 * the stats layout the stats consumer keeps); `model` the deterministic cross-encoder stand-in (step
 * 1 scores with it in process, the checks serve it over gRPC for step 3); `outcome` the record a
 * finished rerank hands to step 4; `outbox` the rows kept for the relay when the broker refuses a
 * produce. The five languages keep the same keys, so a harness reads one layout whatever the stack.
 */
import {CPP_DIGEST_H} from '../cpp-support';
import {scalaPath} from '../scala-support';

export const supportModules: Record<string, string> = {
  'rerank/__init__.py': '',
  'rerank/config.py': `"""Addresses, topics, keys and limits every step of rerankd agrees on."""
import hashlib

# The cross-encoder's gRPC address: a stand-in served by the checks (rerank.model).
MODEL = "reranker:9000"
# One event per finished rerank, keyed by query fingerprint, for the stats consumer.
TOPIC = "rerank.done"


def fingerprint(text: str) -> str:
    """The first 32 hex digits of the SHA-256 of the text's UTF-8 bytes: a query's or a passage's id."""
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:32]


# What the stats consumer keeps per model version (step 5 reads it). VERSIONS_KEY: the set of model
# versions seen. stats_key(v): a hash of requests, hits, misses (score cache lookups), batches,
# unscored_batches (model batches that failed) and fallback_requests (requests answered in
# retrieval order). latency_key(v, "queue" | "model"): a list of samples in whole milliseconds, the
# wait before the model call and the model call itself.
VERSIONS_KEY = "rerank:versions"


def stats_key(model_version: str) -> str:
    return f"rerank:stats:{model_version}"


def latency_key(model_version: str, boundary: str) -> str:
    return f"rerank:latency:{model_version}:{boundary}"


# The fleet totals the first dashboard read, still kept: hits and misses over every version, and the
# request times clients reported (queue, model and network together).
FLEET_HITS_KEY = "rerank:hits"
FLEET_MISSES_KEY = "rerank:misses"
CLIENT_LATENCY_KEY = "rerank:latency:client"
`,
  'rerank/model.py': `"""
The stand-in for the cross-encoder. Step 1 scores with it in process; the checks serve it over gRPC
(Reranker.Score at rerank.config.MODEL) for step 3. Deterministic on purpose: the course grades what
the service does around the model, never the model.

score(query, passage): the share of the query's distinct words (lower-cased, split on whitespace)
that the passage contains, from 0.0 to 1.0; 0.0 for a query with no words.
batch_fault(passages): how the served model answers a batch: "unavailable" when a passage starts
with "brownout:" (a replica that keeps failing), "invalid_argument" when a passage is empty (a
request the model rejects), "" when it scores the batch.
"""
MODEL_VERSION = "xenc-v7"


def _words(text: str) -> set[str]:
    return set(text.lower().split())


def score(query: str, passage: str) -> float:
    terms = _words(query)
    if not terms:
        return 0.0
    return len(terms & _words(passage)) / len(terms)


def batch_fault(passages: list[str]) -> str:
    if any(p.startswith("brownout:") for p in passages):
        return "unavailable"
    if any(p == "" for p in passages):
        return "invalid_argument"
    return ""
`,
  'rerank/outcome.py': `"""The outcome record (provided): what a finished rerank hands to step 4's publisher."""
from dataclasses import dataclass


@dataclass
class RerankOutcome:
    tenant: str
    # The query and the passages are tenant content: the service has them, the topic must not.
    query: str
    passages: list[str]
    # One per passage, in retrieval order; None is a passage the model did not score.
    scores: list[float | None]
    model_version: str
    latency_ms: int
`,
  'rerank/outbox.py': `"""The outbox (provided): events the broker refused, kept for the relay to republish."""
import json

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

OUTBOX_KEY = "rerank:outbox"


def insert(topic: str, key: str, payload: dict) -> None:
    """Durably keep an event the broker refused: one row of topic, key and payload."""
    r.rpush(OUTBOX_KEY, json.dumps({"topic": topic, "key": key, "payload": payload}))


def rows() -> list[dict]:
    """The kept rows, oldest first."""
    return [json.loads(row) for row in r.lrange(OUTBOX_KEY, 0, -1)]
`,
};

export const supportModulesTs: Record<string, string> = {
  'rerank/config.ts': `/** Addresses, topics, keys and limits every step of rerankd agrees on. */
import {createHash} from 'node:crypto';

/** The cross-encoder's gRPC address: a stand-in served by the checks (rerank/model). */
export const MODEL = 'reranker:9000';
/** One event per finished rerank, keyed by query fingerprint, for the stats consumer. */
export const TOPIC = 'rerank.done';

/** The first 32 hex digits of the SHA-256 of the text's UTF-8 bytes: a query's or a passage's id. */
export const fingerprint = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 32);

// What the stats consumer keeps per model version (step 5 reads it). VERSIONS_KEY: the set of model
// versions seen. statsKey(v): a hash of requests, hits, misses (score cache lookups), batches,
// unscored_batches (model batches that failed) and fallback_requests (requests answered in
// retrieval order). latencyKey(v, 'queue' | 'model'): a list of samples in whole milliseconds, the
// wait before the model call and the model call itself.
export const VERSIONS_KEY = 'rerank:versions';
export const statsKey = (modelVersion: string): string => \`rerank:stats:\${modelVersion}\`;
export const latencyKey = (modelVersion: string, boundary: string): string => \`rerank:latency:\${modelVersion}:\${boundary}\`;

// The fleet totals the first dashboard read, still kept: hits and misses over every version, and the
// request times clients reported (queue, model and network together).
export const FLEET_HITS_KEY = 'rerank:hits';
export const FLEET_MISSES_KEY = 'rerank:misses';
export const CLIENT_LATENCY_KEY = 'rerank:latency:client';
`,
  'rerank/model.ts': `/**
 * The stand-in for the cross-encoder. Step 1 scores with it in process; the checks serve it over
 * gRPC (Reranker.Score at rerank/config's MODEL) for step 3. Deterministic on purpose: the course
 * grades what the service does around the model, never the model.
 *
 * score(query, passage): the share of the query's distinct words (lower-cased, split on whitespace)
 * that the passage contains, from 0 to 1; 0 for a query with no words.
 * batchFault(passages): how the served model answers a batch: 'unavailable' when a passage starts
 * with "brownout:" (a replica that keeps failing), 'invalid_argument' when a passage is empty (a
 * request the model rejects), '' when it scores the batch.
 */
export const MODEL_VERSION = 'xenc-v7';

const words = (text: string): Set<string> => new Set(text.toLowerCase().split(/\\s+/).filter(w => w !== ''));

export function score(query: string, passage: string): number {
  const terms = words(query);
  if (terms.size === 0) return 0;
  const seen = words(passage);
  let hits = 0;
  for (const term of terms) if (seen.has(term)) hits += 1;
  return hits / terms.size;
}

export function batchFault(passages: string[]): string {
  if (passages.some(p => p.startsWith('brownout:'))) return 'unavailable';
  if (passages.some(p => p === '')) return 'invalid_argument';
  return '';
}
`,
  'rerank/outcome.ts': `/** The outcome record (provided): what a finished rerank hands to step 4's publisher. */
export interface RerankOutcome {
  tenant: string;
  /** The query and the passages are tenant content: the service has them, the topic must not. */
  query: string;
  passages: string[];
  /** One per passage, in retrieval order; null is a passage the model did not score. */
  scores: (number | null)[];
  model_version: string;
  latency_ms: number;
}
`,
  'rerank/outbox.ts': `/** The outbox (provided): events the broker refused, kept for the relay to republish. */
import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

export const OUTBOX_KEY = 'rerank:outbox';

export interface OutboxRow {
  topic: string;
  key: string;
  payload: Record<string, unknown>;
}

/** Durably keep an event the broker refused: one row of topic, key and payload. */
export async function insert(topic: string, key: string, payload: Record<string, unknown>): Promise<void> {
  await redis.rpush(OUTBOX_KEY, JSON.stringify({topic, key, payload}));
}

/** The kept rows, oldest first. */
export async function rows(): Promise<OutboxRow[]> {
  return (await redis.lrange(OUTBOX_KEY, 0, -1)).map(row => JSON.parse(row) as OutboxRow);
}
`,
};

/** The Go twins: the same \`rerank\` packages, imported as rerank/config, rerank/model, rerank/outcome, rerank/outbox. */
export const supportModulesGo: Record<string, string> = {
  'rerank/config/config.go': `// Package config holds the addresses, topics, keys and limits every step of rerankd agrees on.
package config

import (
	"crypto/sha256"
	"encoding/hex"
)

const (
	// Model is the cross-encoder's gRPC address: a stand-in served by the checks (rerank/model).
	Model = "reranker:9000"
	// Topic carries one event per finished rerank, keyed by query fingerprint, for the stats consumer.
	Topic = "rerank.done"
)

// Fingerprint is the first 32 hex digits of the SHA-256 of the text's UTF-8 bytes: a query's or a passage's id.
func Fingerprint(text string) string {
	sum := sha256.Sum256([]byte(text))
	return hex.EncodeToString(sum[:])[:32]
}

// What the stats consumer keeps per model version (step 5 reads it). VersionsKey: the set of model
// versions seen. StatsKey(v): a hash of requests, hits, misses (score cache lookups), batches,
// unscored_batches (model batches that failed) and fallback_requests (requests answered in
// retrieval order). LatencyKey(v, "queue" | "model"): a list of samples in whole milliseconds, the
// wait before the model call and the model call itself.
const VersionsKey = "rerank:versions"

func StatsKey(modelVersion string) string { return "rerank:stats:" + modelVersion }

func LatencyKey(modelVersion, boundary string) string {
	return "rerank:latency:" + modelVersion + ":" + boundary
}

// The fleet totals the first dashboard read, still kept: hits and misses over every version, and the
// request times clients reported (queue, model and network together).
const (
	FleetHitsKey     = "rerank:hits"
	FleetMissesKey   = "rerank:misses"
	ClientLatencyKey = "rerank:latency:client"
)
`,
  'rerank/model/model.go': `// Package model is the stand-in for the cross-encoder. Step 1 scores with it in process; the checks
// serve it over gRPC (Reranker.Score at config.Model) for step 3. Deterministic on purpose: the
// course grades what the service does around the model, never the model.
//
// Score(query, passage): the share of the query's distinct words (lower-cased, split on
// whitespace) that the passage contains, from 0 to 1; 0 for a query with no words.
// BatchFault(passages): how the served model answers a batch: "unavailable" when a passage starts
// with "brownout:" (a replica that keeps failing), "invalid_argument" when a passage is empty (a
// request the model rejects), "" when it scores the batch.
package model

import "strings"

const Version = "xenc-v7"

func words(text string) map[string]bool {
	set := map[string]bool{}
	for _, w := range strings.Fields(strings.ToLower(text)) {
		set[w] = true
	}
	return set
}

func Score(query, passage string) float64 {
	terms := words(query)
	if len(terms) == 0 {
		return 0
	}
	seen := words(passage)
	hits := 0
	for term := range terms {
		if seen[term] {
			hits++
		}
	}
	return float64(hits) / float64(len(terms))
}

func BatchFault(passages []string) string {
	for _, p := range passages {
		if strings.HasPrefix(p, "brownout:") {
			return "unavailable"
		}
	}
	for _, p := range passages {
		if p == "" {
			return "invalid_argument"
		}
	}
	return ""
}
`,
  'rerank/outcome/outcome.go': `// Package outcome holds the outcome record (provided): what a finished rerank hands to step 4's publisher.
package outcome

// RerankOutcome is one finished rerank. Query and Passages are tenant content: the service has
// them, the topic must not. Scores has one entry per passage, in retrieval order; nil is a passage
// the model did not score.
type RerankOutcome struct {
	Tenant       string
	Query        string
	Passages     []string
	Scores       []*float64
	ModelVersion string
	LatencyMs    int
}
`,
  'rerank/outbox/outbox.go': `// Package outbox keeps the events the broker refused (provided), for the relay to republish.
package outbox

import (
	"context"
	"encoding/json"

	"github.com/redis/go-redis/v9"
)

const Key = "rerank:outbox"

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// Row is one kept event: its topic, key and payload.
type Row struct {
	Topic   string         \`json:"topic"\`
	Key     string         \`json:"key"\`
	Payload map[string]any \`json:"payload"\`
}

// Insert durably keeps an event the broker refused.
func Insert(ctx context.Context, topic, key string, payload map[string]any) error {
	raw, err := json.Marshal(Row{Topic: topic, Key: key, Payload: payload})
	if err != nil {
		return err
	}
	return rdb.RPush(ctx, Key, raw).Err()
}

// Rows are the kept rows, oldest first.
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

/** The C++ twins as headers (rerank/*.h), plus digest.h (SHA-256). */
export const supportModulesCpp: Record<string, string> = {
  'digest.h': CPP_DIGEST_H,
  'rerank/config.h': `// Addresses, topics, keys and limits every step of rerankd agrees on.
#pragma once

#include <string>

#include "digest.h"

namespace config {

// The cross-encoder's gRPC address: a stand-in served by the checks (rerank/model.h).
inline constexpr const char* kModel = "reranker:9000";
// One event per finished rerank, keyed by query fingerprint, for the stats consumer.
inline constexpr const char* kTopic = "rerank.done";

// The first 32 hex digits of the SHA-256 of the text's UTF-8 bytes: a query's or a passage's id.
inline std::string fingerprint(const std::string& text) { return sha256_hex(text).substr(0, 32); }

// What the stats consumer keeps per model version (step 5 reads it). kVersionsKey: the set of model
// versions seen. stats_key(v): a hash of requests, hits, misses (score cache lookups), batches,
// unscored_batches (model batches that failed) and fallback_requests (requests answered in
// retrieval order). latency_key(v, "queue" | "model"): a list of samples in whole milliseconds, the
// wait before the model call and the model call itself.
inline constexpr const char* kVersionsKey = "rerank:versions";
inline std::string stats_key(const std::string& model_version) { return "rerank:stats:" + model_version; }
inline std::string latency_key(const std::string& model_version, const std::string& boundary) {
  return "rerank:latency:" + model_version + ":" + boundary;
}

// The fleet totals the first dashboard read, still kept: hits and misses over every version, and the
// request times clients reported (queue, model and network together).
inline constexpr const char* kFleetHitsKey = "rerank:hits";
inline constexpr const char* kFleetMissesKey = "rerank:misses";
inline constexpr const char* kClientLatencyKey = "rerank:latency:client";

}  // namespace config
`,
  'rerank/model.h': `// The stand-in for the cross-encoder. Step 1 scores with it in process; the checks serve it over
// gRPC (Reranker.Score at config::kModel) for step 3. Deterministic on purpose: the course grades
// what the service does around the model, never the model.
//
// score(query, passage): the share of the query's distinct words (lower-cased, split on
// whitespace) that the passage contains, from 0 to 1; 0 for a query with no words.
// batch_fault(passages): how the served model answers a batch: "unavailable" when a passage starts
// with "brownout:" (a replica that keeps failing), "invalid_argument" when a passage is empty (a
// request the model rejects), "" when it scores the batch.
#pragma once

#include <cctype>
#include <set>
#include <sstream>
#include <string>
#include <vector>

namespace model {

inline constexpr const char* kVersion = "xenc-v7";

inline std::set<std::string> words(const std::string& text) {
  std::set<std::string> out;
  std::istringstream in(text);
  std::string word;
  while (in >> word) {
    for (char& c : word) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
    out.insert(word);
  }
  return out;
}

inline double score(const std::string& query, const std::string& passage) {
  const std::set<std::string> terms = words(query);
  if (terms.empty()) return 0.0;
  const std::set<std::string> seen = words(passage);
  int hits = 0;
  for (const std::string& term : terms) hits += seen.count(term) ? 1 : 0;
  return static_cast<double>(hits) / static_cast<double>(terms.size());
}

inline std::string batch_fault(const std::vector<std::string>& passages) {
  for (const std::string& p : passages) {
    if (p.rfind("brownout:", 0) == 0) return "unavailable";
  }
  for (const std::string& p : passages) {
    if (p.empty()) return "invalid_argument";
  }
  return "";
}

}  // namespace model
`,
  'rerank/outcome.h': `// The outcome record (provided): what a finished rerank hands to step 4's publisher.
#pragma once

#include <optional>
#include <string>
#include <vector>

namespace outcome {

// One finished rerank. query and passages are tenant content: the service has them, the topic must
// not. scores has one entry per passage, in retrieval order; nullopt is a passage the model did not
// score.
struct RerankOutcome {
  std::string tenant;
  std::string query;
  std::vector<std::string> passages;
  std::vector<std::optional<double>> scores;
  std::string model_version;
  long long latency_ms = 0;
};

}  // namespace outcome
`,
  'rerank/outbox.h': `// The outbox (provided): events the broker refused, kept for the relay to republish.
#pragma once

#include <string>
#include <vector>

#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

namespace outbox {

inline constexpr const char* kKey = "rerank:outbox";

inline sw::redis::Redis& redis() {
  static sw::redis::Redis conn("tcp://redis:6379");
  return conn;
}

// Durably keep an event the broker refused: one row of topic, key and payload.
inline void insert(const std::string& topic, const std::string& key, const nlohmann::json& payload) {
  redis().rpush(kKey, nlohmann::json{{"topic", topic}, {"key", key}, {"payload", payload}}.dump());
}

// The kept rows, oldest first.
inline std::vector<nlohmann::json> rows() {
  std::vector<nlohmann::json> out;
  for (const auto& row : redis().lrange(kKey, 0, -1)) out.push_back(nlohmann::json::parse(row));
  return out;
}

}  // namespace outbox
`,
};

/** The Scala twins: the same \`rerank\` objects, compiled with the steps by \`yarn check:scala\`. */
export const supportModulesScala: Record<string, string> = {
  [scalaPath('rerank', 'Config')]: `package rerank

import java.nio.charset.StandardCharsets.UTF_8
import java.security.MessageDigest

/** Addresses, topics, keys and limits every step of rerankd agrees on. */
object Config {
  /** The cross-encoder's gRPC address: a stand-in served by the checks (rerank.Model). */
  val Model = "reranker:9000"
  /** One event per finished rerank, keyed by query fingerprint, for the stats consumer. */
  val Topic = "rerank.done"

  /** The first 32 hex digits of the SHA-256 of the text's UTF-8 bytes: a query's or a passage's id. */
  def fingerprint(text: String): String =
    MessageDigest.getInstance("SHA-256").digest(text.getBytes(UTF_8)).map("%02x".format(_)).mkString.take(32)

  // What the stats consumer keeps per model version (step 5 reads it). VersionsKey: the set of model
  // versions seen. statsKey(v): a hash of requests, hits, misses (score cache lookups), batches,
  // unscored_batches (model batches that failed) and fallback_requests (requests answered in
  // retrieval order). latencyKey(v, "queue" | "model"): a list of samples in whole milliseconds, the
  // wait before the model call and the model call itself.
  val VersionsKey = "rerank:versions"
  def statsKey(modelVersion: String): String = s"rerank:stats:$modelVersion"
  def latencyKey(modelVersion: String, boundary: String): String = s"rerank:latency:$modelVersion:$boundary"

  // The fleet totals the first dashboard read, still kept: hits and misses over every version, and the
  // request times clients reported (queue, model and network together).
  val FleetHitsKey = "rerank:hits"
  val FleetMissesKey = "rerank:misses"
  val ClientLatencyKey = "rerank:latency:client"
}
`,
  [scalaPath('rerank', 'Model')]: `package rerank

/**
 * The stand-in for the cross-encoder. Step 1 scores with it in process; the checks serve it over
 * gRPC (Reranker.Score at Config.Model) for step 3. Deterministic on purpose: the course grades what
 * the service does around the model, never the model.
 *
 * score(query, passage): the share of the query's distinct words (lower-cased, split on whitespace)
 * that the passage contains, from 0 to 1; 0 for a query with no words.
 * batchFault(passages): how the served model answers a batch: "unavailable" when a passage starts
 * with "brownout:" (a replica that keeps failing), "invalid_argument" when a passage is empty (a
 * request the model rejects), "" when it scores the batch.
 */
object Model {
  val Version = "xenc-v7"

  private def words(text: String): Set[String] = text.toLowerCase.split("\\\\s+").filter(_.nonEmpty).toSet

  def score(query: String, passage: String): Double = {
    val terms = words(query)
    if (terms.isEmpty) 0.0 else terms.count(words(passage).contains).toDouble / terms.size
  }

  def batchFault(passages: Seq[String]): String =
    if (passages.exists(_.startsWith("brownout:"))) "unavailable"
    else if (passages.exists(_.isEmpty)) "invalid_argument"
    else ""
}
`,
  [scalaPath('rerank', 'RerankOutcome')]: `package rerank

/**
 * The outcome record (provided): what a finished rerank hands to step 4's publisher. The query and
 * the passages are tenant content: the service has them, the topic must not. scores has one entry per
 * passage, in retrieval order; None is a passage the model did not score.
 */
final case class RerankOutcome(
    tenant: String,
    query: String,
    passages: Seq[String],
    scores: Seq[Option[Double]],
    modelVersion: String,
    latencyMs: Long
)
`,
  [scalaPath('rerank', 'Outbox')]: `package rerank

import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

/** The outbox (provided): events the broker refused, kept for the relay to republish. */
object Outbox {
  val Key = "rerank:outbox"
  private val jedis = new JedisPooled("redis", 6379)

  /** Durably keep an event the broker refused: one row of topic, key and payload. */
  def insert(topic: String, key: String, payload: ujson.Obj): Unit = {
    jedis.rpush(Key, ujson.write(ujson.Obj("topic" -> topic, "key" -> key, "payload" -> payload)))
    ()
  }

  /** The kept rows, oldest first. */
  def rows(): List[ujson.Value] = jedis.lrange(Key, 0, -1).asScala.toList.map(ujson.read(_))
}
`,
};
