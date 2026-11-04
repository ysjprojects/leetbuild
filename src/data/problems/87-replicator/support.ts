/**
 * Hand-written support modules the replicator steps import but no step builds: the `replication`
 * package. `replication.store` is the replications store (each replication a Redis hash, the course's
 * stand-in for the control-plane database) and the outbox. `replication.regions` is what the
 * replicator reads about the two regions: the measured clock skew, a shard's head offset at the
 * source, and per-row digests. `replication.offsets` is the offset store of step 2 as later steps use
 * it: `offset_key`, `advance_offset` (the forward-only compare-and-set) and `resume_offset`. The five
 * languages keep the same keys, so a harness reads one layout whatever the stack.
 */
import {scalaPath} from '../scala-support';

export const supportModules: Record<string, string> = {
  'replication/__init__.py': '',
  'replication/store.py': `"""
The replications store (provided): a replication is the hash replication:{id} with id, owner,
source_region, target_region, shards (comma-separated shard ids) and conflict_policy; replication:seq
numbers them (rep-1, rep-2, ...). The outbox is the list outbox of JSON rows {"topic", "key",
"payload"} a relay publishes once the broker is back. A replication is returned as a dict whose
shards is a list of ints.
"""
import json

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)


def _replication(raw: dict) -> dict | None:
    if not raw:
        return None
    return {
        "id": raw["id"],
        "owner": raw["owner"],
        "source_region": raw["source_region"],
        "target_region": raw["target_region"],
        "shards": [int(shard) for shard in raw["shards"].split(",") if shard != ""],
        "conflict_policy": raw["conflict_policy"],
    }


def get(replication_id: str) -> dict | None:
    """The replication, or None."""
    return _replication(r.hgetall(f"replication:{replication_id}"))


def create(owner: str, source_region: str, target_region: str, shards: list[int], conflict_policy: str) -> dict:
    """Store a new replication and return it."""
    replication_id = f"rep-{r.incr('replication:seq')}"
    r.hset(
        f"replication:{replication_id}",
        mapping={
            "id": replication_id,
            "owner": owner,
            "source_region": source_region,
            "target_region": target_region,
            "shards": ",".join(str(shard) for shard in shards),
            "conflict_policy": conflict_policy,
        },
    )
    return get(replication_id)


def set_policy(replication_id: str, conflict_policy: str) -> dict:
    """Overwrite the replication's conflict policy (the console's writer from before policies were frozen)."""
    r.hset(f"replication:{replication_id}", "conflict_policy", conflict_policy)
    return get(replication_id)


def insert_outbox(topic: str, key: str, payload: dict) -> None:
    """Queue a record the broker did not take, for the relay to publish later."""
    r.rpush("outbox", json.dumps({"topic": topic, "key": key, "payload": payload}))
`,
  'replication/regions.py': `"""
The two regions as the replicator reads them (provided; the course's stand-in for the regions' APIs,
kept in Redis): skew:{source}:{target} is the latest measured clock skew between two regions in
milliseconds (absent: 0), head:{replication}:{shard} the newest change offset the source holds for a
shard, and digest:{region}:{shard} a hash of row key -> row digest for the rows a region holds in a
shard (a row the region lacks has no field).
"""
import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)


def clock_skew_ms(source_region: str, target_region: str) -> int:
    """The measured clock skew between the two regions, in milliseconds."""
    return abs(int(r.get(f"skew:{source_region}:{target_region}") or 0))


def source_head_offset(replication_id: str, shard: int) -> int:
    """The newest change offset the source region holds for the shard."""
    return int(r.get(f"head:{replication_id}:{shard}") or 0)


def sample_keys(region: str, shard: int, count: int) -> list[str]:
    """Up to count row keys the region holds in the shard, in key order."""
    return sorted(r.hkeys(f"digest:{region}:{shard}"))[:count]


def key_digest(region: str, shard: int, key: str) -> str:
    """The digest of one row in one region, "" when the region does not hold the row."""
    return r.hget(f"digest:{region}:{shard}", key) or ""
`,
  'replication/offsets.py': `"""
The offset store (provided; step 2 builds the same three functions): offset:{replication}:{shard}
holds the newest offset the target confirmed for the shard, with no expiry. advance_offset moves it
forward in one Lua compare-and-set, comparing as numbers, and returns the shard's offset afterwards;
resume_offset is where a restarted shard picks up (0 when it never confirmed anything).
"""
import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

ADVANCE_LUA = """
local current = tonumber(redis.call('GET', KEYS[1]) or '0')
local candidate = tonumber(ARGV[1])
if candidate > current then
  redis.call('SET', KEYS[1], ARGV[1])
  return candidate
end
return current
"""
advance = r.register_script(ADVANCE_LUA)


def offset_key(replication_id: str, shard: int) -> str:
    return f"offset:{replication_id}:{shard}"


def advance_offset(replication_id: str, shard: int, offset: int) -> int:
    """Record that the target confirmed the shard up to offset; returns the shard's offset afterwards."""
    return int(advance(keys=[offset_key(replication_id, shard)], args=[offset]))


def resume_offset(replication_id: str, shard: int) -> int:
    """Where a restarted shard resumes: its confirmed offset, 0 when it never confirmed one."""
    raw = r.get(offset_key(replication_id, shard))
    return int(raw) if raw is not None else 0
`,
};

export const supportModulesTs: Record<string, string> = {
  'replication/store.ts': `/**
 * The replications store (provided): a replication is the hash replication:{id} with id, owner,
 * source_region, target_region, shards (comma-separated shard ids) and conflict_policy;
 * replication:seq numbers them (rep-1, rep-2, ...). The outbox is the list outbox of JSON rows
 * {"topic", "key", "payload"} a relay publishes once the broker is back.
 */
import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

export interface Replication {
  id: string;
  owner: string;
  source_region: string;
  target_region: string;
  shards: number[];
  conflict_policy: string;
}

/** The replication, or null. */
export async function get(replicationId: string): Promise<Replication | null> {
  const raw = await redis.hgetall(\`replication:\${replicationId}\`);
  if (Object.keys(raw).length === 0) return null;
  return {
    id: raw.id,
    owner: raw.owner,
    source_region: raw.source_region,
    target_region: raw.target_region,
    shards: raw.shards === '' ? [] : raw.shards.split(',').map(Number),
    conflict_policy: raw.conflict_policy,
  };
}

/** Store a new replication and return it. */
export async function create(
  owner: string,
  sourceRegion: string,
  targetRegion: string,
  shards: number[],
  conflictPolicy: string,
): Promise<Replication> {
  const replicationId = \`rep-\${await redis.incr('replication:seq')}\`;
  await redis.hset(\`replication:\${replicationId}\`, {
    id: replicationId,
    owner,
    source_region: sourceRegion,
    target_region: targetRegion,
    shards: shards.join(','),
    conflict_policy: conflictPolicy,
  });
  return (await get(replicationId)) as Replication;
}

/** Overwrite the replication's conflict policy (the console's writer from before policies were frozen). */
export async function setPolicy(replicationId: string, conflictPolicy: string): Promise<Replication> {
  await redis.hset(\`replication:\${replicationId}\`, 'conflict_policy', conflictPolicy);
  return (await get(replicationId)) as Replication;
}

/** Queue a record the broker did not take, for the relay to publish later. */
export async function insertOutbox(topic: string, key: string, payload: unknown): Promise<void> {
  await redis.rpush('outbox', JSON.stringify({topic, key, payload}));
}
`,
  'replication/regions.ts': `/**
 * The two regions as the replicator reads them (provided; the course's stand-in for the regions'
 * APIs, kept in Redis): skew:{source}:{target} is the latest measured clock skew in milliseconds
 * (absent: 0), head:{replication}:{shard} the newest change offset the source holds for a shard, and
 * digest:{region}:{shard} a hash of row key -> row digest (a row the region lacks has no field).
 */
import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

/** The measured clock skew between the two regions, in milliseconds. */
export async function clockSkewMs(sourceRegion: string, targetRegion: string): Promise<number> {
  return Math.abs(Number((await redis.get(\`skew:\${sourceRegion}:\${targetRegion}\`)) ?? 0));
}

/** The newest change offset the source region holds for the shard. */
export async function sourceHeadOffset(replicationId: string, shard: number): Promise<number> {
  return Number((await redis.get(\`head:\${replicationId}:\${shard}\`)) ?? 0);
}

/** Up to count row keys the region holds in the shard, in key order. */
export async function sampleKeys(region: string, shard: number, count: number): Promise<string[]> {
  return (await redis.hkeys(\`digest:\${region}:\${shard}\`)).sort().slice(0, count);
}

/** The digest of one row in one region, '' when the region does not hold the row. */
export async function keyDigest(region: string, shard: number, key: string): Promise<string> {
  return (await redis.hget(\`digest:\${region}:\${shard}\`, key)) ?? '';
}
`,
  'replication/offsets.ts': `/**
 * The offset store (provided; step 2 builds the same three functions): offset:{replication}:{shard}
 * holds the newest offset the target confirmed for the shard, with no expiry. advanceOffset moves it
 * forward in one Lua compare-and-set, comparing as numbers, and returns the shard's offset afterwards;
 * resumeOffset is where a restarted shard picks up (0 when it never confirmed anything).
 */
import Redis from 'ioredis';

export const ADVANCE_LUA = \`
local current = tonumber(redis.call('GET', KEYS[1]) or '0')
local candidate = tonumber(ARGV[1])
if candidate > current then
  redis.call('SET', KEYS[1], ARGV[1])
  return candidate
end
return current
\`;

interface OffsetRedis extends Redis {
  advance(key: string, offset: number): Promise<number>;
}

const redis = new Redis({host: 'redis', port: 6379}) as OffsetRedis;
redis.defineCommand('advance', {numberOfKeys: 1, lua: ADVANCE_LUA});

export const offsetKey = (replicationId: string, shard: number): string => \`offset:\${replicationId}:\${shard}\`;

/** Record that the target confirmed the shard up to offset; resolves the shard's offset afterwards. */
export async function advanceOffset(replicationId: string, shard: number, offset: number): Promise<number> {
  return Number(await redis.advance(offsetKey(replicationId, shard), offset));
}

/** Where a restarted shard resumes: its confirmed offset, 0 when it never confirmed one. */
export async function resumeOffset(replicationId: string, shard: number): Promise<number> {
  const raw = await redis.get(offsetKey(replicationId, shard));
  return raw === null ? 0 : Number(raw);
}
`,
};

export const supportModulesGo: Record<string, string> = {
  'replication/store/store.go': `// Package store is the replications store (provided): a replication is the hash replication:{id}
// with id, owner, source_region, target_region, shards (comma-separated shard ids) and
// conflict_policy; replication:seq numbers them (rep-1, rep-2, ...). The outbox is the list outbox of
// JSON rows {"topic", "key", "payload"} a relay publishes once the broker is back.
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

// Replication is one replication as the store holds it.
type Replication struct {
	ID             string \`json:"id"\`
	Owner          string \`json:"owner"\`
	SourceRegion   string \`json:"source_region"\`
	TargetRegion   string \`json:"target_region"\`
	Shards         []int  \`json:"shards"\`
	ConflictPolicy string \`json:"conflict_policy"\`
}

// Get is the replication, or nil.
func Get(ctx context.Context, replicationID string) (*Replication, error) {
	raw, err := rdb.HGetAll(ctx, "replication:"+replicationID).Result()
	if err != nil || len(raw) == 0 {
		return nil, err
	}
	shards := []int{}
	for _, s := range strings.Split(raw["shards"], ",") {
		if n, err := strconv.Atoi(s); err == nil {
			shards = append(shards, n)
		}
	}
	return &Replication{
		ID: raw["id"], Owner: raw["owner"], SourceRegion: raw["source_region"], TargetRegion: raw["target_region"],
		Shards: shards, ConflictPolicy: raw["conflict_policy"],
	}, nil
}

// Create stores a new replication and returns it.
func Create(ctx context.Context, owner, sourceRegion, targetRegion string, shards []int, conflictPolicy string) (*Replication, error) {
	seq, err := rdb.Incr(ctx, "replication:seq").Result()
	if err != nil {
		return nil, err
	}
	replicationID := fmt.Sprintf("rep-%d", seq)
	ids := make([]string, len(shards))
	for i, shard := range shards {
		ids[i] = strconv.Itoa(shard)
	}
	err = rdb.HSet(ctx, "replication:"+replicationID, map[string]any{
		"id": replicationID, "owner": owner, "source_region": sourceRegion, "target_region": targetRegion,
		"shards": strings.Join(ids, ","), "conflict_policy": conflictPolicy,
	}).Err()
	if err != nil {
		return nil, err
	}
	return Get(ctx, replicationID)
}

// SetPolicy overwrites the replication's conflict policy (the console's writer from before policies were frozen).
func SetPolicy(ctx context.Context, replicationID, conflictPolicy string) (*Replication, error) {
	if err := rdb.HSet(ctx, "replication:"+replicationID, "conflict_policy", conflictPolicy).Err(); err != nil {
		return nil, err
	}
	return Get(ctx, replicationID)
}

// InsertOutbox queues a record the broker did not take, for the relay to publish later.
func InsertOutbox(ctx context.Context, topic, key string, payload any) error {
	row, err := json.Marshal(map[string]any{"topic": topic, "key": key, "payload": payload})
	if err != nil {
		return err
	}
	return rdb.RPush(ctx, "outbox", row).Err()
}
`,
  'replication/regions/regions.go': `// Package regions is the two regions as the replicator reads them (provided; the course's stand-in
// for the regions' APIs, kept in Redis): skew:{source}:{target} is the latest measured clock skew in
// milliseconds (absent: 0), head:{replication}:{shard} the newest change offset the source holds for a
// shard, and digest:{region}:{shard} a hash of row key -> row digest (a row the region lacks has no
// field).
package regions

import (
	"context"
	"fmt"
	"sort"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// ClockSkewMS is the measured clock skew between the two regions, in milliseconds.
func ClockSkewMS(ctx context.Context, sourceRegion, targetRegion string) int64 {
	skew, _ := rdb.Get(ctx, "skew:"+sourceRegion+":"+targetRegion).Int64()
	if skew < 0 {
		return -skew
	}
	return skew
}

// SourceHeadOffset is the newest change offset the source region holds for the shard.
func SourceHeadOffset(ctx context.Context, replicationID string, shard int) int64 {
	head, _ := rdb.Get(ctx, fmt.Sprintf("head:%s:%d", replicationID, shard)).Int64()
	return head
}

// SampleKeys is up to count row keys the region holds in the shard, in key order.
func SampleKeys(ctx context.Context, region string, shard, count int) []string {
	keys, _ := rdb.HKeys(ctx, fmt.Sprintf("digest:%s:%d", region, shard)).Result()
	sort.Strings(keys)
	if len(keys) > count {
		keys = keys[:count]
	}
	return keys
}

// KeyDigest is the digest of one row in one region, "" when the region does not hold the row.
func KeyDigest(ctx context.Context, region string, shard int, key string) string {
	digest, _ := rdb.HGet(ctx, fmt.Sprintf("digest:%s:%d", region, shard), key).Result()
	return digest
}
`,
  'replication/offsets/offsets.go': `// Package offsets is the offset store (provided; step 2 builds the same three functions):
// offset:{replication}:{shard} holds the newest offset the target confirmed for the shard, with no
// expiry. AdvanceOffset moves it forward in one Lua compare-and-set, comparing as numbers, and returns
// the shard's offset afterwards; ResumeOffset is where a restarted shard picks up (0 when it never
// confirmed anything).
package offsets

import (
	"context"
	"fmt"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

var advance = redis.NewScript(\`
local current = tonumber(redis.call('GET', KEYS[1]) or '0')
local candidate = tonumber(ARGV[1])
if candidate > current then
  redis.call('SET', KEYS[1], ARGV[1])
  return candidate
end
return current
\`)

// OffsetKey is the shard's offset key.
func OffsetKey(replicationID string, shard int) string {
	return fmt.Sprintf("offset:%s:%d", replicationID, shard)
}

// AdvanceOffset records that the target confirmed the shard up to offset; it returns the shard's offset afterwards.
func AdvanceOffset(ctx context.Context, replicationID string, shard int, offset int64) (int64, error) {
	return advance.Run(ctx, rdb, []string{OffsetKey(replicationID, shard)}, offset).Int64()
}

// ResumeOffset is where a restarted shard resumes: its confirmed offset, 0 when it never confirmed one.
func ResumeOffset(ctx context.Context, replicationID string, shard int) (int64, error) {
	offset, err := rdb.Get(ctx, OffsetKey(replicationID, shard)).Int64()
	if err == redis.Nil {
		return 0, nil
	}
	return offset, err
}
`,
};

export const supportModulesCpp: Record<string, string> = {
  'replication/store.h': `// The replications store (provided): a replication is the hash replication:{id} with id, owner,
// source_region, target_region, shards (comma-separated shard ids) and conflict_policy;
// replication:seq numbers them (rep-1, rep-2, ...). The outbox is the list outbox of JSON rows
// {"topic", "key", "payload"} a relay publishes once the broker is back.
#pragma once

#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <iterator>
#include <optional>
#include <sstream>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

namespace store {

// One replication as the store holds it.
struct Replication {
  std::string id;
  std::string owner;
  std::string source_region;
  std::string target_region;
  std::vector<int> shards;
  std::string conflict_policy;
};

inline nlohmann::json toJson(const Replication& r) {
  return nlohmann::json{{"id", r.id},         {"owner", r.owner}, {"source_region", r.source_region}, {"target_region", r.target_region},
                        {"shards", r.shards}, {"conflict_policy", r.conflict_policy}};
}

inline sw::redis::Redis& client() {
  static sw::redis::Redis redis("tcp://redis:6379");
  return redis;
}

// The replication, if the store has it.
inline std::optional<Replication> get(const std::string& replication_id) {
  std::unordered_map<std::string, std::string> raw;
  client().hgetall("replication:" + replication_id, std::inserter(raw, raw.begin()));
  if (raw.empty()) return std::nullopt;
  Replication r{raw["id"], raw["owner"], raw["source_region"], raw["target_region"], {}, raw["conflict_policy"]};
  std::stringstream ids(raw["shards"]);
  for (std::string shard; std::getline(ids, shard, ',');) {
    if (!shard.empty()) r.shards.push_back(std::stoi(shard));
  }
  return r;
}

// Store a new replication and return it.
inline Replication create(const std::string& owner, const std::string& source_region, const std::string& target_region,
                          const std::vector<int>& shards, const std::string& conflict_policy) {
  const std::string replication_id = "rep-" + std::to_string(client().incr("replication:seq"));
  std::string ids;
  for (const int shard : shards) ids += (ids.empty() ? "" : ",") + std::to_string(shard);
  client().hset("replication:" + replication_id, {std::pair<std::string, std::string>{"id", replication_id},
                                                  {"owner", owner},
                                                  {"source_region", source_region},
                                                  {"target_region", target_region},
                                                  {"shards", ids},
                                                  {"conflict_policy", conflict_policy}});
  return *store::get(replication_id);
}

// Overwrite the replication's conflict policy (the console's writer from before policies were frozen).
inline Replication setPolicy(const std::string& replication_id, const std::string& conflict_policy) {
  client().hset("replication:" + replication_id, "conflict_policy", conflict_policy);
  return *store::get(replication_id);
}

// Queue a record the broker did not take, for the relay to publish later.
inline void insertOutbox(const std::string& topic, const std::string& key, const nlohmann::json& payload) {
  client().rpush("outbox", nlohmann::json{{"topic", topic}, {"key", key}, {"payload", payload}}.dump());
}

}  // namespace store
`,
  'replication/regions.h': `// The two regions as the replicator reads them (provided; the course's stand-in for the regions'
// APIs, kept in Redis): skew:{source}:{target} is the latest measured clock skew in milliseconds
// (absent: 0), head:{replication}:{shard} the newest change offset the source holds for a shard, and
// digest:{region}:{shard} a hash of row key -> row digest (a row the region lacks has no field).
#pragma once

#include <sw/redis++/redis++.h>

#include <algorithm>
#include <cstdlib>
#include <iterator>
#include <string>
#include <vector>

namespace regions {

inline sw::redis::Redis& client() {
  static sw::redis::Redis redis("tcp://redis:6379");
  return redis;
}

inline std::string digestKey(const std::string& region, int shard) { return "digest:" + region + ":" + std::to_string(shard); }

// The measured clock skew between the two regions, in milliseconds.
inline long long clockSkewMs(const std::string& source_region, const std::string& target_region) {
  const auto raw = client().get("skew:" + source_region + ":" + target_region);
  return raw ? std::llabs(std::stoll(*raw)) : 0;
}

// The newest change offset the source region holds for the shard.
inline long long sourceHeadOffset(const std::string& replication_id, int shard) {
  const auto raw = client().get("head:" + replication_id + ":" + std::to_string(shard));
  return raw ? std::stoll(*raw) : 0;
}

// Up to limit row keys the region holds in the shard, in key order.
inline std::vector<std::string> sampleKeys(const std::string& region, int shard, std::size_t limit) {
  std::vector<std::string> keys;
  client().hkeys(digestKey(region, shard), std::back_inserter(keys));
  std::sort(keys.begin(), keys.end());
  if (keys.size() > limit) keys.resize(limit);
  return keys;
}

// The digest of one row in one region, "" when the region does not hold the row.
inline std::string keyDigest(const std::string& region, int shard, const std::string& key) {
  return client().hget(digestKey(region, shard), key).value_or("");
}

}  // namespace regions
`,
  'replication/offsets.h': `// The offset store (provided; step 2 builds the same three functions): offset:{replication}:{shard}
// holds the newest offset the target confirmed for the shard, with no expiry. advanceOffset moves it
// forward in one Lua compare-and-set, comparing as numbers, and returns the shard's offset afterwards;
// resumeOffset is where a restarted shard picks up (0 when it never confirmed anything).
#pragma once

#include <sw/redis++/redis++.h>

#include <string>

namespace offsets {

inline sw::redis::Redis& client() {
  static sw::redis::Redis redis("tcp://redis:6379");
  return redis;
}

inline const std::string kAdvanceLua = R"lua(
local current = tonumber(redis.call('GET', KEYS[1]) or '0')
local candidate = tonumber(ARGV[1])
if candidate > current then
  redis.call('SET', KEYS[1], ARGV[1])
  return candidate
end
return current
)lua";

inline std::string offsetKey(const std::string& replication_id, int shard) {
  return "offset:" + replication_id + ":" + std::to_string(shard);
}

// Record that the target confirmed the shard up to offset; returns the shard's offset afterwards.
inline long long advanceOffset(const std::string& replication_id, int shard, long long offset) {
  return client().eval<long long>(kAdvanceLua, {offsetKey(replication_id, shard)}, {std::to_string(offset)});
}

// Where a restarted shard resumes: its confirmed offset, 0 when it never confirmed one.
inline long long resumeOffset(const std::string& replication_id, int shard) {
  const auto raw = client().get(offsetKey(replication_id, shard));
  return raw ? std::stoll(*raw) : 0;
}

}  // namespace offsets
`,
};

export const supportModulesScala: Record<string, string> = {
  [scalaPath('replication', 'Store')]: `package replication

import scala.jdk.CollectionConverters._

import redis.clients.jedis.JedisPooled
import spray.json._

/** One replication as the store holds it. */
final case class Replication(
    id: String,
    owner: String,
    sourceRegion: String,
    targetRegion: String,
    shards: Seq[Int],
    conflictPolicy: String
) {
  def toJson: JsObject = JsObject(
    "id" -> JsString(id),
    "owner" -> JsString(owner),
    "source_region" -> JsString(sourceRegion),
    "target_region" -> JsString(targetRegion),
    "shards" -> JsArray(shards.map(JsNumber(_)).toVector),
    "conflict_policy" -> JsString(conflictPolicy)
  )
}

/**
 * The replications store (provided): a replication is the hash replication:{id} with id, owner,
 * source_region, target_region, shards (comma-separated shard ids) and conflict_policy;
 * replication:seq numbers them (rep-1, rep-2, ...). The outbox is the list outbox of JSON rows
 * {"topic", "key", "payload"} a relay publishes once the broker is back.
 */
object Store {
  val jedis = new JedisPooled("redis", 6379)

  /** The replication, if the store has it. */
  def get(replicationId: String): Option[Replication] = {
    val raw = jedis.hgetAll(s"replication:$replicationId").asScala
    if (raw.isEmpty) None
    else
      Some(
        Replication(
          raw.getOrElse("id", ""),
          raw.getOrElse("owner", ""),
          raw.getOrElse("source_region", ""),
          raw.getOrElse("target_region", ""),
          raw.getOrElse("shards", "").split(",").toSeq.filter(_.nonEmpty).map(_.toInt),
          raw.getOrElse("conflict_policy", "")
        )
      )
  }

  /** Store a new replication and return it. */
  def create(owner: String, sourceRegion: String, targetRegion: String, shards: Seq[Int], conflictPolicy: String): Replication = {
    val replicationId = s"rep-\${jedis.incr("replication:seq")}"
    val fields = Map(
      "id" -> replicationId,
      "owner" -> owner,
      "source_region" -> sourceRegion,
      "target_region" -> targetRegion,
      "shards" -> shards.mkString(","),
      "conflict_policy" -> conflictPolicy
    )
    jedis.hset(s"replication:$replicationId", fields.asJava)
    get(replicationId).get
  }

  /** Overwrite the replication's conflict policy (the console's writer from before policies were frozen). */
  def setPolicy(replicationId: String, conflictPolicy: String): Replication = {
    jedis.hset(s"replication:$replicationId", "conflict_policy", conflictPolicy)
    get(replicationId).get
  }

  /** Queue a record the broker did not take, for the relay to publish later. */
  def insertOutbox(topic: String, key: String, payload: JsValue): Unit =
    jedis.rpush("outbox", JsObject("topic" -> JsString(topic), "key" -> JsString(key), "payload" -> payload).compactPrint)
}
`,
  [scalaPath('replication', 'Regions')]: `package replication

import scala.jdk.CollectionConverters._

import redis.clients.jedis.JedisPooled

/**
 * The two regions as the replicator reads them (provided; the course's stand-in for the regions'
 * APIs, kept in Redis): skew:{source}:{target} is the latest measured clock skew in milliseconds
 * (absent: 0), head:{replication}:{shard} the newest change offset the source holds for a shard, and
 * digest:{region}:{shard} a hash of row key -> row digest (a row the region lacks has no field).
 */
object Regions {
  val jedis = new JedisPooled("redis", 6379)

  /** The measured clock skew between the two regions, in milliseconds. */
  def clockSkewMs(sourceRegion: String, targetRegion: String): Long =
    Option(jedis.get(s"skew:$sourceRegion:$targetRegion")).map(_.toLong.abs).getOrElse(0L)

  /** The newest change offset the source region holds for the shard. */
  def sourceHeadOffset(replicationId: String, shard: Int): Long =
    Option(jedis.get(s"head:$replicationId:$shard")).map(_.toLong).getOrElse(0L)

  /** Up to count row keys the region holds in the shard, in key order. */
  def sampleKeys(region: String, shard: Int, count: Int): Seq[String] =
    jedis.hkeys(s"digest:$region:$shard").asScala.toSeq.sorted.take(count)

  /** The digest of one row in one region, "" when the region does not hold the row. */
  def keyDigest(region: String, shard: Int, key: String): String =
    Option(jedis.hget(s"digest:$region:$shard", key)).getOrElse("")
}
`,
  [scalaPath('replication', 'Offsets')]: `package replication

import scala.jdk.CollectionConverters._

import redis.clients.jedis.JedisPooled

/**
 * The offset store (provided; step 2 builds the same three functions): offset:{replication}:{shard}
 * holds the newest offset the target confirmed for the shard, with no expiry. advanceOffset moves it
 * forward in one Lua compare-and-set, comparing as numbers, and returns the shard's offset afterwards;
 * resumeOffset is where a restarted shard picks up (0 when it never confirmed anything).
 */
object Offsets {
  val jedis = new JedisPooled("redis", 6379)

  val AdvanceLua: String =
    """local current = tonumber(redis.call('GET', KEYS[1]) or '0')
      |local candidate = tonumber(ARGV[1])
      |if candidate > current then
      |  redis.call('SET', KEYS[1], ARGV[1])
      |  return candidate
      |end
      |return current
      |""".stripMargin

  def offsetKey(replicationId: String, shard: Int): String = s"offset:$replicationId:$shard"

  /** Record that the target confirmed the shard up to offset; returns the shard's offset afterwards. */
  def advanceOffset(replicationId: String, shard: Int, offset: Long): Long =
    jedis.eval(AdvanceLua, List(offsetKey(replicationId, shard)).asJava, List(offset.toString).asJava).asInstanceOf[java.lang.Long]

  /** Where a restarted shard resumes: its confirmed offset, 0 when it never confirmed one. */
  def resumeOffset(replicationId: String, shard: Int): Long =
    Option(jedis.get(offsetKey(replicationId, shard))).map(_.toLong).getOrElse(0L)
}
`,
};
