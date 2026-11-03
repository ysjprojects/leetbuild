/**
 * Hand-written support modules the recommendation-ranking steps import but no step builds: the
 * `recs` package. `recs.store` is the service's shared Redis state: the popularity order the ranking
 * client falls back to, the surface configs with their promotion record, and the outbox a relay
 * produces from later. `recs.types` (TypeScript, Go, C++, Scala) holds the shapes the steps pass
 * each other: a scored item, a ranked list, a feature vector. The five languages keep the same keys,
 * so a harness reads one layout whatever the stack.
 */
import {scalaPath} from '../scala-support';

export const supportModules: Record<string, string> = {
  'recs/__init__.py': '',
  'recs/store.py': `"""
The recommendation service's shared Redis state (provided).

popularity:{surface}        sorted set: item id -> engagements on the surface (the fallback order)
surface:{surface}           hash: model_version, fallback_policy (the surface's active config)
surface:{surface}:promoted  set: every model version ever promoted on the surface
outbox                      list of JSON rows {topic, key, payload} that a relay produces later

A scored item is a dict {id, score}; a surface config a dict {model_version, fallback_policy}.
"""
import json

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

POPULARITY_VERSION = "popularity-v1"


def popularity_order(surface: str, candidate_ids: list[str]) -> list[dict]:
    """The candidates most engaged first, as scored items; an id with no engagements scores 0 and keeps its place."""
    scores = dict(r.zrevrange(f"popularity:{surface}", 0, -1, withscores=True))
    items = [{"id": item_id, "score": float(scores.get(item_id, 0.0))} for item_id in candidate_ids]
    return sorted(items, key=lambda item: -item["score"])


def promote(surface: str, model_version: str, fallback_policy: str = "popularity") -> None:
    """Make model_version the surface's active version and record the promotion (a rollback promotes an earlier one again)."""
    r.sadd(f"surface:{surface}:promoted", model_version)
    r.hset(f"surface:{surface}", mapping={"model_version": model_version, "fallback_policy": fallback_policy})


def surface_config(surface: str) -> dict | None:
    """The surface's active config, or None for a surface that does not exist."""
    raw = r.hgetall(f"surface:{surface}")
    if not raw:
        return None
    return {"model_version": raw.get("model_version", ""), "fallback_policy": raw.get("fallback_policy", "")}


def is_promoted(surface: str, model_version: str) -> bool:
    """Whether model_version was ever promoted on the surface."""
    return bool(r.sismember(f"surface:{surface}:promoted", model_version))


def outbox_insert(topic: str, key: str, payload: dict) -> None:
    """Keep a record the broker did not take: the relay produces it later, under the same key."""
    r.rpush("outbox", json.dumps({"topic": topic, "key": key, "payload": payload}))
`,
};

export const supportModulesTs: Record<string, string> = {
  'recs/types.ts': `/** The shapes the recommendation steps pass each other. */

/** One candidate with the score that placed it. */
export interface ScoredItem {
  id: string;
  score: number;
}

/** A ranked list, best first, stamped with the version that ordered it; fallback marks the popularity order. */
export interface Ranked {
  items: ScoredItem[];
  model_version: string;
  fallback: boolean;
}

/** One user's feature vector; stale marks the copy kept for when the feature service is down. */
export interface Features {
  values: number[];
  stale: boolean;
}
`,
  'recs/store.ts': `/**
 * The recommendation service's shared Redis state (provided).
 *
 * popularity:{surface}        sorted set: item id -> engagements on the surface (the fallback order)
 * surface:{surface}           hash: model_version, fallback_policy (the surface's active config)
 * surface:{surface}:promoted  set: every model version ever promoted on the surface
 * outbox                      list of JSON rows {topic, key, payload} that a relay produces later
 */
import Redis from 'ioredis';

import type {ScoredItem} from 'recs/types';

const redis = new Redis({host: 'redis', port: 6379});

export const POPULARITY_VERSION = 'popularity-v1';

export interface SurfaceConfig {
  model_version: string;
  fallback_policy: string;
}

/** The candidates most engaged first, as scored items; an id with no engagements scores 0 and keeps its place. */
export async function popularityOrder(surface: string, candidateIds: string[]): Promise<ScoredItem[]> {
  const flat = await redis.zrevrange(\`popularity:\${surface}\`, 0, -1, 'WITHSCORES');
  const scores = new Map<string, number>();
  for (let i = 0; i < flat.length; i += 2) scores.set(flat[i], Number(flat[i + 1]));
  return candidateIds.map(id => ({id, score: scores.get(id) ?? 0})).sort((a, b) => b.score - a.score);
}

/** Make modelVersion the surface's active version and record the promotion (a rollback promotes an earlier one again). */
export async function promote(surface: string, modelVersion: string, fallbackPolicy = 'popularity'): Promise<void> {
  await redis.sadd(\`surface:\${surface}:promoted\`, modelVersion);
  await redis.hset(\`surface:\${surface}\`, {model_version: modelVersion, fallback_policy: fallbackPolicy});
}

/** The surface's active config, or null for a surface that does not exist. */
export async function surfaceConfig(surface: string): Promise<SurfaceConfig | null> {
  const raw = await redis.hgetall(\`surface:\${surface}\`);
  if (Object.keys(raw).length === 0) return null;
  return {model_version: raw.model_version ?? '', fallback_policy: raw.fallback_policy ?? ''};
}

/** Whether modelVersion was ever promoted on the surface. */
export async function isPromoted(surface: string, modelVersion: string): Promise<boolean> {
  return (await redis.sismember(\`surface:\${surface}:promoted\`, modelVersion)) === 1;
}

/** Keep a record the broker did not take: the relay produces it later, under the same key. */
export async function outboxInsert(topic: string, key: string, payload: Record<string, unknown>): Promise<void> {
  await redis.rpush('outbox', JSON.stringify({topic, key, payload}));
}
`,
};

export const supportModulesGo: Record<string, string> = {
  'recs/types/types.go': `// Package types holds the shapes the recommendation steps pass each other.
package types

// Item is one candidate with the score that placed it.
type Item struct {
	ID    string  \`json:"id"\`
	Score float64 \`json:"score"\`
}

// Ranked is a ranked list, best first, stamped with the version that ordered it; Fallback marks the popularity order.
type Ranked struct {
	Items        []Item \`json:"items"\`
	ModelVersion string \`json:"model_version"\`
	Fallback     bool   \`json:"fallback"\`
}

// Features is one user's feature vector; Stale marks the copy kept for when the feature service is down.
type Features struct {
	Values []float64 \`json:"values"\`
	Stale  bool      \`json:"stale"\`
}
`,
  'recs/store/store.go': `// Package store is the recommendation service's shared Redis state (provided).
//
//	popularity:{surface}        sorted set: item id -> engagements on the surface (the fallback order)
//	surface:{surface}           hash: model_version, fallback_policy (the surface's active config)
//	surface:{surface}:promoted  set: every model version ever promoted on the surface
//	outbox                      list of JSON rows {topic, key, payload} that a relay produces later
package store

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"

	"github.com/redis/go-redis/v9"

	"recs/types"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// PopularityVersion stamps a list ordered by popularity instead of the ranking model.
const PopularityVersion = "popularity-v1"

// Config is a surface's active config.
type Config struct {
	ModelVersion   string \`json:"model_version"\`
	FallbackPolicy string \`json:"fallback_policy"\`
}

// PopularityOrder is the candidates most engaged first; an id with no engagements scores 0 and keeps its place.
func PopularityOrder(ctx context.Context, surface string, candidateIDs []string) []types.Item {
	scores := map[string]float64{}
	ranked, _ := rdb.ZRevRangeWithScores(ctx, "popularity:"+surface, 0, -1).Result()
	for _, z := range ranked {
		scores[fmt.Sprint(z.Member)] = z.Score
	}
	items := make([]types.Item, 0, len(candidateIDs))
	for _, id := range candidateIDs {
		items = append(items, types.Item{ID: id, Score: scores[id]})
	}
	sort.SliceStable(items, func(i, j int) bool { return items[i].Score > items[j].Score })
	return items
}

// Promote makes modelVersion the surface's active version and records the promotion (a rollback promotes an earlier one again).
func Promote(ctx context.Context, surface, modelVersion, fallbackPolicy string) error {
	if err := rdb.SAdd(ctx, "surface:"+surface+":promoted", modelVersion).Err(); err != nil {
		return err
	}
	return rdb.HSet(ctx, "surface:"+surface, "model_version", modelVersion, "fallback_policy", fallbackPolicy).Err()
}

// SurfaceConfig is the surface's active config, or nil for a surface that does not exist.
func SurfaceConfig(ctx context.Context, surface string) (*Config, error) {
	raw, err := rdb.HGetAll(ctx, "surface:"+surface).Result()
	if err != nil || len(raw) == 0 {
		return nil, err
	}
	return &Config{ModelVersion: raw["model_version"], FallbackPolicy: raw["fallback_policy"]}, nil
}

// IsPromoted reports whether modelVersion was ever promoted on the surface.
func IsPromoted(ctx context.Context, surface, modelVersion string) (bool, error) {
	return rdb.SIsMember(ctx, "surface:"+surface+":promoted", modelVersion).Result()
}

// OutboxInsert keeps a record the broker did not take: the relay produces it later, under the same key.
func OutboxInsert(ctx context.Context, topic, key string, payload map[string]any) error {
	row, _ := json.Marshal(map[string]any{"topic": topic, "key": key, "payload": payload})
	return rdb.RPush(ctx, "outbox", string(row)).Err()
}
`,
};

export const supportModulesCpp: Record<string, string> = {
  'recs/types.h': `// The shapes the recommendation steps pass each other.
#pragma once

#include <string>
#include <vector>

namespace recs {

// One candidate with the score that placed it.
struct Item {
  std::string id;
  double score = 0;
};

// A ranked list, best first, stamped with the version that ordered it; fallback marks the popularity order.
struct Ranked {
  std::vector<Item> items;
  std::string model_version;
  bool fallback = false;
};

// One user's feature vector; stale marks the copy kept for when the feature service is down.
struct Features {
  std::vector<double> values;
  bool stale = false;
};

}  // namespace recs
`,
  'recs/store.h': `// The recommendation service's shared Redis state (provided).
//
//   popularity:{surface}        sorted set: item id -> engagements on the surface (the fallback order)
//   surface:{surface}           hash: model_version, fallback_policy (the surface's active config)
//   surface:{surface}:promoted  set: every model version ever promoted on the surface
//   outbox                      list of JSON rows {topic, key, payload} that a relay produces later
#pragma once

#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <algorithm>
#include <iterator>
#include <optional>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

#include "recs/types.h"

namespace store {

inline sw::redis::Redis& redis() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

// Stamps a list ordered by popularity instead of the ranking model.
inline const std::string kPopularityVersion = "popularity-v1";

// A surface's active config.
struct Config {
  std::string model_version;
  std::string fallback_policy;
};

// The candidates most engaged first; an id with no engagements scores 0 and keeps its place.
inline std::vector<recs::Item> popularityOrder(const std::string& surface, const std::vector<std::string>& candidate_ids) {
  std::vector<std::pair<std::string, double>> ranked;
  redis().zrevrange("popularity:" + surface, 0, -1, std::back_inserter(ranked));
  const std::unordered_map<std::string, double> scores(ranked.begin(), ranked.end());
  std::vector<recs::Item> items;
  for (const std::string& id : candidate_ids) {
    const auto it = scores.find(id);
    items.push_back(recs::Item{id, it == scores.end() ? 0.0 : it->second});
  }
  std::stable_sort(items.begin(), items.end(), [](const recs::Item& a, const recs::Item& b) { return a.score > b.score; });
  return items;
}

// Make model_version the surface's active version and record the promotion (a rollback promotes an
// earlier one again).
inline void promote(const std::string& surface, const std::string& model_version, const std::string& fallback_policy = "popularity") {
  redis().sadd("surface:" + surface + ":promoted", model_version);
  redis().hset("surface:" + surface, {{"model_version", model_version}, {"fallback_policy", fallback_policy}});
}

// The surface's active config, or none for a surface that does not exist.
inline std::optional<Config> surfaceConfig(const std::string& surface) {
  const std::unordered_map<std::string, std::string> raw = redis().hgetall("surface:" + surface);
  if (raw.empty()) return std::nullopt;
  const auto text = [&raw](const char* name) { return raw.count(name) ? raw.at(name) : std::string(); };
  return Config{text("model_version"), text("fallback_policy")};
}

// Whether model_version was ever promoted on the surface.
inline bool isPromoted(const std::string& surface, const std::string& model_version) {
  return redis().sismember("surface:" + surface + ":promoted", model_version);
}

// Keep a record the broker did not take: the relay produces it later, under the same key.
inline void outboxInsert(const std::string& topic, const std::string& key, const nlohmann::json& payload) {
  redis().rpush("outbox", nlohmann::json{{"topic", topic}, {"key", key}, {"payload", payload}}.dump());
}

}  // namespace store
`,
};

export const supportModulesScala: Record<string, string> = {
  [scalaPath('recs', 'Types')]: `package recs

/** One candidate with the score that placed it. */
final case class ScoredItem(id: String, score: Double)

/** A ranked list, best first, stamped with the version that ordered it; fallback marks the popularity order. */
final case class Ranked(items: Seq[ScoredItem], modelVersion: String, fallback: Boolean)

/** One user's feature vector; stale marks the copy kept for when the feature service is down. */
final case class Features(values: Seq[Double], stale: Boolean)
`,
  [scalaPath('recs', 'Store')]: `package recs

import redis.clients.jedis.JedisPooled
import spray.json._

import scala.jdk.CollectionConverters._

/**
 * The recommendation service's shared Redis state (provided).
 *
 * popularity:{surface}        sorted set: item id -> engagements on the surface (the fallback order)
 * surface:{surface}           hash: model_version, fallback_policy (the surface's active config)
 * surface:{surface}:promoted  set: every model version ever promoted on the surface
 * outbox                      list of JSON rows {topic, key, payload} that a relay produces later
 */
object Store {
  final case class Config(modelVersion: String, fallbackPolicy: String)

  val PopularityVersion = "popularity-v1"

  val jedis = new JedisPooled("redis", 6379)

  /** The candidates most engaged first; an id with no engagements scores 0 and keeps its place. */
  def popularityOrder(surface: String, candidateIds: Seq[String]): Seq[ScoredItem] = {
    val scores = jedis.zrevrangeWithScores(s"popularity:$surface", 0, -1).asScala.map(t => t.getElement -> t.getScore).toMap
    candidateIds.map(id => ScoredItem(id, scores.getOrElse(id, 0.0))).sortBy(-_.score)
  }

  /** Make modelVersion the surface's active version and record the promotion (a rollback promotes an earlier one again). */
  def promote(surface: String, modelVersion: String, fallbackPolicy: String = "popularity"): Unit = {
    jedis.sadd(s"surface:$surface:promoted", modelVersion)
    jedis.hset(s"surface:$surface", Map("model_version" -> modelVersion, "fallback_policy" -> fallbackPolicy).asJava)
  }

  /** The surface's active config, or None for a surface that does not exist. */
  def surfaceConfig(surface: String): Option[Config] = {
    val raw = jedis.hgetAll(s"surface:$surface").asScala
    if (raw.isEmpty) None else Some(Config(raw.getOrElse("model_version", ""), raw.getOrElse("fallback_policy", "")))
  }

  /** Whether modelVersion was ever promoted on the surface. */
  def isPromoted(surface: String, modelVersion: String): Boolean = jedis.sismember(s"surface:$surface:promoted", modelVersion)

  /** Keep a record the broker did not take: the relay produces it later, under the same key. */
  def outboxInsert(topic: String, key: String, payload: JsObject): Unit =
    jedis.rpush("outbox", JsObject("topic" -> JsString(topic), "key" -> JsString(key), "payload" -> payload).compactPrint)
}
`,
};
