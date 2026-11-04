/**
 * Hand-written support modules the feature-store steps import but no step builds: the `features`
 * package. `features.registry` is the registry database (Redis is the course's stand-in for it):
 * definitions, the compute registry, the partition log. `features.online` is the online store of
 * step 2 as later steps use it (`write_value`, `read_value`, and the scanned `Row`).
 * `features.stats` keeps the running sums a stats read summarizes and the pinned baseline;
 * `features.outbox` is the relay's table. The five languages keep the same keys, so a harness reads
 * one layout whatever the stack.
 */
import {scalaPath} from '../scala-support';

export const supportModules: Record<string, string> = {
  'features/__init__.py': '',
  'features/registry.py': `"""
The registry (provided): definition:{name}:{version} holds one feature definition as a JSON
document (name, version, dtype, computation_ref, freshness_slo, created_at); compute:refs is the
set of computations the compute registry knows; partitions:{name}:{version} maps each committed
partition of a backfill to the rows it wrote.
"""
import json

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)


def definition_key(name: str, version: int) -> str:
    return f"definition:{name}:{version}"


def get_definition(name: str, version: int) -> dict | None:
    """The stored definition of (name, version), or None."""
    raw = r.get(definition_key(name, version))
    return json.loads(raw) if raw else None


def create_definition(definition: dict) -> bool:
    """Store the definition only if (name, version) has none yet, in one SET NX; whether it was stored."""
    return bool(r.set(definition_key(definition["name"], definition["version"]), json.dumps(definition), nx=True))


def put_definition(definition: dict) -> None:
    """The bulk loader's writer: stores the definition over whatever (name, version) holds."""
    r.set(definition_key(definition["name"], definition["version"]), json.dumps(definition))


def computation_exists(ref: str) -> bool:
    """Whether the compute registry knows the computation ref."""
    return bool(r.sismember("compute:refs", ref))


def register_computation(ref: str) -> None:
    r.sadd("compute:refs", ref)


def commit_partition(name: str, version: int, partition: str, rows: int) -> None:
    """Record the partition as committed with the rows it wrote."""
    r.hset(f"partitions:{name}:{version}", partition, rows)


def committed_partitions(name: str, version: int) -> dict[str, int]:
    return {partition: int(rows) for partition, rows in r.hgetall(f"partitions:{name}:{version}").items()}
`,
  'features/online.py': `"""
The online store (provided; step 2 builds the same two functions): feature:{name}:{version}:{entity}
is a hash with value and event_ts (epoch seconds). write_value stores a value only if it is newer
than the stored one, in one Lua script that also sets the key to expire when the value goes stale
(event_ts + the definition's freshness_slo); it reports whether it stored. read_value answers the
value, its event_ts and its age in seconds, or None. A scanned row is a dict: entity, value (None
for a null), event_ts.
"""
import time

import redis

from features import registry

r = redis.Redis(host="redis", port=6379, decode_responses=True)

WRITE_LUA = """
local stored = redis.call('HGET', KEYS[1], 'event_ts')
if stored and tonumber(stored) >= tonumber(ARGV[2]) then return 0 end
redis.call('HSET', KEYS[1], 'value', ARGV[1], 'event_ts', ARGV[2])
redis.call('EXPIREAT', KEYS[1], ARGV[3])
return 1
"""
write = r.register_script(WRITE_LUA)


def value_key(name: str, version: int, entity: str) -> str:
    return f"feature:{name}:{version}:{entity}"


def write_value(name: str, version: int, entity: str, value: float, event_ts: int) -> bool:
    """Store the entity's value unless a value at least as new is stored; whether it stored."""
    definition = registry.get_definition(name, version)
    if definition is None:
        raise KeyError(f"no definition {name} v{version}")
    expire_at = event_ts + definition["freshness_slo"]
    return write(keys=[value_key(name, version, entity)], args=[value, event_ts, expire_at]) == 1


def read_value(name: str, version: int, entity: str) -> dict | None:
    """The entity's value with its event_ts and age_s, or None."""
    raw = r.hgetall(value_key(name, version, entity))
    if not raw:
        return None
    event_ts = int(raw["event_ts"])
    return {"value": float(raw["value"]), "event_ts": event_ts, "age_s": int(time.time()) - event_ts}
`,
  'features/stats.py': `"""
Feature stats (provided): stats:{name}:{version} is a hash of running sums over every scanned row:
count (rows, nulls included), nulls, sum and sumsq (of the non-null values), newest_ts (the newest
event_ts) and updated_at (when a row was last observed). baseline:{name} holds the version an
operator pinned as the baseline.
"""
import time

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)


def stats_key(name: str, version: int) -> str:
    return f"stats:{name}:{version}"


def observe(name: str, version: int, value: float | None, event_ts: int) -> None:
    """Add one scanned row (value None for a null) to the version's sums."""
    key = stats_key(name, version)
    r.hincrby(key, "count", 1)
    if value is None:
        r.hincrby(key, "nulls", 1)
    else:
        r.hincrbyfloat(key, "sum", value)
        r.hincrbyfloat(key, "sumsq", value * value)
    newest = r.hget(key, "newest_ts")
    if newest is None or int(newest) < event_ts:
        r.hset(key, "newest_ts", event_ts)
    r.hset(key, "updated_at", int(time.time()))


def read(name: str, version: int) -> dict | None:
    """The version's sums (count, nulls, sum, sumsq, newest_ts, updated_at), or None."""
    raw = r.hgetall(stats_key(name, version))
    if not raw:
        return None
    return {
        "count": int(raw.get("count", 0)),
        "nulls": int(raw.get("nulls", 0)),
        "sum": float(raw.get("sum", 0)),
        "sumsq": float(raw.get("sumsq", 0)),
        "newest_ts": int(raw.get("newest_ts", 0)),
        "updated_at": int(raw.get("updated_at", 0)),
    }


def pin_baseline(name: str, version: int) -> None:
    r.set(f"baseline:{name}", version)


def baseline_of(name: str) -> int | None:
    """The version pinned as the feature's baseline, or None."""
    version = r.get(f"baseline:{name}")
    return int(version) if version else None
`,
  'features/outbox.py': `"""
The outbox (provided): the Redis list outbox holds one JSON row per event the broker did not take
({topic, key, payload}); a relay produces them later.
"""
import json

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)


def insert(topic: str, key: str, payload: dict) -> None:
    r.rpush("outbox", json.dumps({"topic": topic, "key": key, "payload": payload}))
`,
};

export const supportModulesTs: Record<string, string> = {
  'features/registry.ts': `/**
 * The registry (provided): definition:{name}:{version} holds one feature definition as a JSON
 * document (name, version, dtype, computation_ref, freshness_slo, created_at); compute:refs is the
 * set of computations the compute registry knows; partitions:{name}:{version} maps each committed
 * partition of a backfill to the rows it wrote.
 */
import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

export interface Definition {
  name: string;
  version: number;
  dtype: string;
  computation_ref: string;
  freshness_slo: number;
  created_at: number;
}

export const definitionKey = (name: string, version: number): string => \`definition:\${name}:\${version}\`;

/** The stored definition of (name, version), or null. */
export async function getDefinition(name: string, version: number): Promise<Definition | null> {
  const raw = await redis.get(definitionKey(name, version));
  return raw === null ? null : (JSON.parse(raw) as Definition);
}

/** Store the definition only if (name, version) has none yet, in one SET NX; whether it was stored. */
export async function createDefinition(definition: Definition): Promise<boolean> {
  return (await redis.set(definitionKey(definition.name, definition.version), JSON.stringify(definition), 'NX')) === 'OK';
}

/** The bulk loader's writer: stores the definition over whatever (name, version) holds. */
export async function putDefinition(definition: Definition): Promise<void> {
  await redis.set(definitionKey(definition.name, definition.version), JSON.stringify(definition));
}

/** Whether the compute registry knows the computation ref. */
export async function computationExists(ref: string): Promise<boolean> {
  return (await redis.sismember('compute:refs', ref)) === 1;
}

export async function registerComputation(ref: string): Promise<void> {
  await redis.sadd('compute:refs', ref);
}

/** Record the partition as committed with the rows it wrote. */
export async function commitPartition(name: string, version: number, partition: string, rows: number): Promise<void> {
  await redis.hset(\`partitions:\${name}:\${version}\`, partition, String(rows));
}

export async function committedPartitions(name: string, version: number): Promise<Record<string, number>> {
  const raw = await redis.hgetall(\`partitions:\${name}:\${version}\`);
  return Object.fromEntries(Object.entries(raw).map(([partition, rows]) => [partition, Number(rows)]));
}
`,
  'features/online.ts': `/**
 * The online store (provided; step 2 builds the same two functions): feature:{name}:{version}:{entity}
 * is a hash with value and event_ts (epoch seconds). writeValue stores a value only if it is newer
 * than the stored one, in one Lua script that also sets the key to expire when the value goes stale
 * (event_ts + the definition's freshness_slo); it reports whether it stored. readValue answers the
 * value, its event_ts and its age in seconds, or null. A scanned Row has a null value for a null.
 */
import Redis from 'ioredis';

import {getDefinition} from 'features/registry';

export const WRITE_LUA = \`
local stored = redis.call('HGET', KEYS[1], 'event_ts')
if stored and tonumber(stored) >= tonumber(ARGV[2]) then return 0 end
redis.call('HSET', KEYS[1], 'value', ARGV[1], 'event_ts', ARGV[2])
redis.call('EXPIREAT', KEYS[1], ARGV[3])
return 1
\`;

export interface Row {
  entity: string;
  value: number | null;
  event_ts: number;
}

export interface Value {
  value: number;
  event_ts: number;
  age_s: number;
}

interface OnlineRedis extends Redis {
  writeFeatureValue(key: string, value: string, eventTs: string, expireAt: string): Promise<number>;
}

const redis = new Redis({host: 'redis', port: 6379}) as OnlineRedis;
redis.defineCommand('writeFeatureValue', {numberOfKeys: 1, lua: WRITE_LUA});

export const valueKey = (name: string, version: number, entity: string): string => \`feature:\${name}:\${version}:\${entity}\`;

/** Store the entity's value unless a value at least as new is stored; whether it stored. */
export async function writeValue(name: string, version: number, entity: string, value: number, eventTs: number): Promise<boolean> {
  const definition = await getDefinition(name, version);
  if (definition === null) throw new Error(\`no definition \${name} v\${version}\`);
  const expireAt = eventTs + definition.freshness_slo;
  return (await redis.writeFeatureValue(valueKey(name, version, entity), String(value), String(eventTs), String(expireAt))) === 1;
}

/** The entity's value with its event_ts and age_s, or null. */
export async function readValue(name: string, version: number, entity: string): Promise<Value | null> {
  const raw = await redis.hgetall(valueKey(name, version, entity));
  if (raw.event_ts === undefined) return null;
  const eventTs = Number(raw.event_ts);
  return {value: Number(raw.value), event_ts: eventTs, age_s: Math.floor(Date.now() / 1000) - eventTs};
}
`,
  'features/stats.ts': `/**
 * Feature stats (provided): stats:{name}:{version} is a hash of running sums over every scanned row:
 * count (rows, nulls included), nulls, sum and sumsq (of the non-null values), newest_ts (the
 * newest event_ts) and updated_at (when a row was last observed). baseline:{name} holds the version
 * an operator pinned as the baseline.
 */
import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

export interface Sums {
  count: number;
  nulls: number;
  sum: number;
  sumsq: number;
  newest_ts: number;
  updated_at: number;
}

export const statsKey = (name: string, version: number): string => \`stats:\${name}:\${version}\`;

/** Add one scanned row (value null for a null) to the version's sums. */
export async function observe(name: string, version: number, value: number | null, eventTs: number): Promise<void> {
  const key = statsKey(name, version);
  await redis.hincrby(key, 'count', 1);
  if (value === null) {
    await redis.hincrby(key, 'nulls', 1);
  } else {
    await redis.hincrbyfloat(key, 'sum', value);
    await redis.hincrbyfloat(key, 'sumsq', value * value);
  }
  const newest = await redis.hget(key, 'newest_ts');
  if (newest === null || Number(newest) < eventTs) await redis.hset(key, 'newest_ts', String(eventTs));
  await redis.hset(key, 'updated_at', String(Math.floor(Date.now() / 1000)));
}

/** The version's sums (count, nulls, sum, sumsq, newest_ts, updated_at), or null. */
export async function read(name: string, version: number): Promise<Sums | null> {
  const raw = await redis.hgetall(statsKey(name, version));
  if (Object.keys(raw).length === 0) return null;
  const num = (field: string): number => Number(raw[field] ?? 0);
  return {
    count: num('count'),
    nulls: num('nulls'),
    sum: num('sum'),
    sumsq: num('sumsq'),
    newest_ts: num('newest_ts'),
    updated_at: num('updated_at'),
  };
}

export async function pinBaseline(name: string, version: number): Promise<void> {
  await redis.set(\`baseline:\${name}\`, String(version));
}

/** The version pinned as the feature's baseline, or null. */
export async function baselineOf(name: string): Promise<number | null> {
  const version = await redis.get(\`baseline:\${name}\`);
  return version ? Number(version) : null;
}
`,
  'features/outbox.ts': `/**
 * The outbox (provided): the Redis list outbox holds one JSON row per event the broker did not take
 * ({topic, key, payload}); a relay produces them later.
 */
import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

export async function insert(topic: string, key: string, payload: Record<string, unknown>): Promise<void> {
  await redis.rpush('outbox', JSON.stringify({topic, key, payload}));
}
`,
};

export const supportModulesGo: Record<string, string> = {
  'features/registry/registry.go': `// Package registry is the registry (provided): definition:{name}:{version} holds one feature
// definition as a JSON document (name, version, dtype, computation_ref, freshness_slo,
// created_at); compute:refs is the set of computations the compute registry knows;
// partitions:{name}:{version} maps each committed partition of a backfill to the rows it wrote.
package registry

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// Definition is one immutable feature definition.
type Definition struct {
	Name           string \`json:"name"\`
	Version        int    \`json:"version"\`
	Dtype          string \`json:"dtype"\`
	ComputationRef string \`json:"computation_ref"\`
	FreshnessSLO   int64  \`json:"freshness_slo"\`
	CreatedAt      int64  \`json:"created_at"\`
}

// DefinitionKey is where the definition of (name, version) is stored.
func DefinitionKey(name string, version int) string {
	return fmt.Sprintf("definition:%s:%d", name, version)
}

// GetDefinition is the stored definition of (name, version), or nil.
func GetDefinition(ctx context.Context, name string, version int) (*Definition, error) {
	raw, err := rdb.Get(ctx, DefinitionKey(name, version)).Result()
	if err == redis.Nil {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var d Definition
	return &d, json.Unmarshal([]byte(raw), &d)
}

// CreateDefinition stores the definition only if (name, version) has none yet, in one SET NX; it
// reports whether it was stored.
func CreateDefinition(ctx context.Context, d Definition) (bool, error) {
	raw, _ := json.Marshal(d)
	return rdb.SetNX(ctx, DefinitionKey(d.Name, d.Version), raw, 0).Result()
}

// PutDefinition is the bulk loader's writer: it stores the definition over whatever (name,
// version) holds.
func PutDefinition(ctx context.Context, d Definition) error {
	raw, _ := json.Marshal(d)
	return rdb.Set(ctx, DefinitionKey(d.Name, d.Version), raw, 0).Err()
}

// ComputationExists reports whether the compute registry knows the computation ref.
func ComputationExists(ctx context.Context, ref string) (bool, error) {
	return rdb.SIsMember(ctx, "compute:refs", ref).Result()
}

// RegisterComputation adds a computation ref to the compute registry.
func RegisterComputation(ctx context.Context, ref string) error {
	return rdb.SAdd(ctx, "compute:refs", ref).Err()
}

// CommitPartition records the partition as committed with the rows it wrote.
func CommitPartition(ctx context.Context, name string, version int, partition string, rows int) error {
	return rdb.HSet(ctx, fmt.Sprintf("partitions:%s:%d", name, version), partition, rows).Err()
}

// CommittedPartitions maps each committed partition of (name, version) to its rows.
func CommittedPartitions(ctx context.Context, name string, version int) map[string]int {
	out := map[string]int{}
	for partition, rows := range rdb.HGetAll(ctx, fmt.Sprintf("partitions:%s:%d", name, version)).Val() {
		n, _ := strconv.Atoi(rows)
		out[partition] = n
	}
	return out
}
`,
  'features/online/online.go': `// Package online is the online store (provided; step 2 builds the same two functions):
// feature:{name}:{version}:{entity} is a hash with value and event_ts (epoch seconds). WriteValue
// stores a value only if it is newer than the stored one, in one Lua script that also sets the key
// to expire when the value goes stale (event_ts + the definition's freshness_slo); it reports
// whether it stored. ReadValue answers the value, its event_ts and its age in seconds, or nil. A
// scanned Row has a nil Value for a null.
package online

import (
	"context"
	"fmt"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"

	"features/registry"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// Write stores ARGV[1] at ARGV[2] unless the stored event_ts is at least as new, and expires the key at ARGV[3].
var Write = redis.NewScript(\`
local stored = redis.call('HGET', KEYS[1], 'event_ts')
if stored and tonumber(stored) >= tonumber(ARGV[2]) then return 0 end
redis.call('HSET', KEYS[1], 'value', ARGV[1], 'event_ts', ARGV[2])
redis.call('EXPIREAT', KEYS[1], ARGV[3])
return 1
\`)

// Row is one value as the offline store scanned it; Value is nil for a null.
type Row struct {
	Entity  string   \`json:"entity"\`
	Value   *float64 \`json:"value"\`
	EventTs int64    \`json:"event_ts"\`
}

// Value is an entity's stored value with its event time and age.
type Value struct {
	Value   float64 \`json:"value"\`
	EventTs int64   \`json:"event_ts"\`
	AgeS    int64   \`json:"age_s"\`
}

// ValueKey is the hash of one entity's value of a feature version.
func ValueKey(name string, version int, entity string) string {
	return fmt.Sprintf("feature:%s:%d:%s", name, version, entity)
}

// WriteValue stores the entity's value unless a value at least as new is stored; it reports whether it stored.
func WriteValue(ctx context.Context, name string, version int, entity string, value float64, eventTs int64) (bool, error) {
	definition, err := registry.GetDefinition(ctx, name, version)
	if err != nil {
		return false, err
	}
	if definition == nil {
		return false, fmt.Errorf("no definition %s v%d", name, version)
	}
	expireAt := eventTs + definition.FreshnessSLO
	stored, err := Write.Run(ctx, rdb, []string{ValueKey(name, version, entity)}, strconv.FormatFloat(value, 'g', -1, 64), eventTs, expireAt).Int64()
	return stored == 1, err
}

// ReadValue is the entity's value with its event_ts and age_s, or nil.
func ReadValue(ctx context.Context, name string, version int, entity string) (*Value, error) {
	raw, err := rdb.HGetAll(ctx, ValueKey(name, version, entity)).Result()
	if err != nil || raw["event_ts"] == "" {
		return nil, err
	}
	value, _ := strconv.ParseFloat(raw["value"], 64)
	eventTs, _ := strconv.ParseInt(raw["event_ts"], 10, 64)
	return &Value{Value: value, EventTs: eventTs, AgeS: time.Now().Unix() - eventTs}, nil
}
`,
  'features/stats/stats.go': `// Package stats is feature stats (provided): stats:{name}:{version} is a hash of running sums over
// every scanned row: count (rows, nulls included), nulls, sum and sumsq (of the non-null values),
// newest_ts (the newest event_ts) and updated_at (when a row was last observed). baseline:{name}
// holds the version an operator pinned as the baseline.
package stats

import (
	"context"
	"fmt"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// Sums are a version's running sums.
type Sums struct {
	Count     int64   \`json:"count"\`
	Nulls     int64   \`json:"nulls"\`
	Sum       float64 \`json:"sum"\`
	SumSq     float64 \`json:"sumsq"\`
	NewestTs  int64   \`json:"newest_ts"\`
	UpdatedAt int64   \`json:"updated_at"\`
}

// StatsKey is the hash of a version's sums.
func StatsKey(name string, version int) string {
	return fmt.Sprintf("stats:%s:%d", name, version)
}

// Observe adds one scanned row (value nil for a null) to the version's sums.
func Observe(ctx context.Context, name string, version int, value *float64, eventTs int64) error {
	key := StatsKey(name, version)
	rdb.HIncrBy(ctx, key, "count", 1)
	if value == nil {
		rdb.HIncrBy(ctx, key, "nulls", 1)
	} else {
		rdb.HIncrByFloat(ctx, key, "sum", *value)
		rdb.HIncrByFloat(ctx, key, "sumsq", *value**value)
	}
	newest, err := rdb.HGet(ctx, key, "newest_ts").Int64()
	if err == redis.Nil || (err == nil && newest < eventTs) {
		rdb.HSet(ctx, key, "newest_ts", eventTs)
	}
	return rdb.HSet(ctx, key, "updated_at", time.Now().Unix()).Err()
}

// Read is the version's sums, or nil.
func Read(ctx context.Context, name string, version int) (*Sums, error) {
	raw, err := rdb.HGetAll(ctx, StatsKey(name, version)).Result()
	if err != nil || len(raw) == 0 {
		return nil, err
	}
	integer := func(field string) int64 {
		n, _ := strconv.ParseInt(raw[field], 10, 64)
		return n
	}
	float := func(field string) float64 {
		f, _ := strconv.ParseFloat(raw[field], 64)
		return f
	}
	return &Sums{Count: integer("count"), Nulls: integer("nulls"), Sum: float("sum"), SumSq: float("sumsq"), NewestTs: integer("newest_ts"), UpdatedAt: integer("updated_at")}, nil
}

// PinBaseline pins version as the feature's baseline.
func PinBaseline(ctx context.Context, name string, version int) error {
	return rdb.Set(ctx, "baseline:"+name, version, 0).Err()
}

// BaselineOf is the version pinned as the feature's baseline, or 0.
func BaselineOf(ctx context.Context, name string) int {
	version, _ := rdb.Get(ctx, "baseline:"+name).Int()
	return version
}
`,
  'features/outbox/outbox.go': `// Package outbox is the outbox (provided): the Redis list outbox holds one JSON row per event the
// broker did not take ({topic, key, payload}); a relay produces them later.
package outbox

import (
	"context"
	"encoding/json"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// Insert adds one event the broker did not take.
func Insert(ctx context.Context, topic, key string, payload map[string]any) error {
	raw, _ := json.Marshal(map[string]any{"topic": topic, "key": key, "payload": payload})
	return rdb.RPush(ctx, "outbox", raw).Err()
}
`,
};

export const supportModulesCpp: Record<string, string> = {
  'features/registry.h': `// The registry (provided): definition:{name}:{version} holds one feature definition as a JSON
// document (name, version, dtype, computation_ref, freshness_slo, created_at); compute:refs is the
// set of computations the compute registry knows; partitions:{name}:{version} maps each committed
// partition of a backfill to the rows it wrote.
#pragma once

#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <chrono>
#include <map>
#include <optional>
#include <string>
#include <unordered_map>

namespace registry {

struct Definition {
  std::string name;
  long version = 0;
  std::string dtype;
  std::string computation_ref;
  long long freshness_slo = 0;
  long long created_at = 0;
};

inline sw::redis::Redis& redis() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

inline std::string definitionKey(const std::string& name, long version) {
  return "definition:" + name + ":" + std::to_string(version);
}

inline nlohmann::json toJson(const Definition& d) {
  return nlohmann::json{{"name", d.name},
                        {"version", d.version},
                        {"dtype", d.dtype},
                        {"computation_ref", d.computation_ref},
                        {"freshness_slo", d.freshness_slo},
                        {"created_at", d.created_at}};
}

inline Definition fromJson(const nlohmann::json& j) {
  return Definition{j.value("name", ""), j.value("version", 0L), j.value("dtype", ""), j.value("computation_ref", ""),
                    j.value("freshness_slo", 0LL), j.value("created_at", 0LL)};
}

// The stored definition of (name, version), or none.
inline std::optional<Definition> getDefinition(const std::string& name, long version) {
  const auto raw = redis().get(definitionKey(name, version));
  if (!raw) return std::nullopt;
  return fromJson(nlohmann::json::parse(*raw));
}

// Store the definition only if (name, version) has none yet, in one SET NX; whether it was stored.
inline bool createDefinition(const Definition& d) {
  return redis().set(definitionKey(d.name, d.version), toJson(d).dump(), std::chrono::milliseconds(0), sw::redis::UpdateType::NOT_EXIST);
}

// The bulk loader's writer: stores the definition over whatever (name, version) holds.
inline void putDefinition(const Definition& d) { redis().set(definitionKey(d.name, d.version), toJson(d).dump()); }

// Whether the compute registry knows the computation ref.
inline bool computationExists(const std::string& ref) { return redis().sismember("compute:refs", ref); }

inline void registerComputation(const std::string& ref) { redis().sadd("compute:refs", ref); }

// Record the partition as committed with the rows it wrote.
inline void commitPartition(const std::string& name, long version, const std::string& partition, long rows) {
  redis().hset("partitions:" + name + ":" + std::to_string(version), partition, std::to_string(rows));
}

inline std::map<std::string, long> committedPartitions(const std::string& name, long version) {
  const std::unordered_map<std::string, std::string> raw = redis().hgetall("partitions:" + name + ":" + std::to_string(version));
  std::map<std::string, long> out;
  for (const auto& [partition, rows] : raw) out[partition] = std::stol(rows);
  return out;
}

}  // namespace registry
`,
  'features/online.h': `// The online store (provided; step 2 builds the same two functions): feature:{name}:{version}:{entity}
// is a hash with value and event_ts (epoch seconds). writeValue stores a value only if it is newer
// than the stored one, in one Lua script that also sets the key to expire when the value goes stale
// (event_ts + the definition's freshness_slo); it reports whether it stored. readValue answers the
// value, its event_ts and its age in seconds, or none. A scanned Row has no value for a null.
#pragma once

#include <sw/redis++/redis++.h>

#include <chrono>
#include <optional>
#include <sstream>
#include <stdexcept>
#include <string>
#include <unordered_map>

#include "features/registry.h"

namespace online {

// One value as the offline store scanned it; value is empty for a null.
struct Row {
  std::string entity;
  std::optional<double> value;
  long long event_ts = 0;
};

// An entity's stored value with its event time and age.
struct Value {
  double value = 0;
  long long event_ts = 0;
  long long age_s = 0;
};

inline const std::string kWriteLua = R"lua(
local stored = redis.call('HGET', KEYS[1], 'event_ts')
if stored and tonumber(stored) >= tonumber(ARGV[2]) then return 0 end
redis.call('HSET', KEYS[1], 'value', ARGV[1], 'event_ts', ARGV[2])
redis.call('EXPIREAT', KEYS[1], ARGV[3])
return 1
)lua";

inline sw::redis::Redis& redis() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

inline std::string valueKey(const std::string& name, long version, const std::string& entity) {
  return "feature:" + name + ":" + std::to_string(version) + ":" + entity;
}

inline long long nowSeconds() {
  return std::chrono::duration_cast<std::chrono::seconds>(std::chrono::system_clock::now().time_since_epoch()).count();
}

// Store the entity's value unless a value at least as new is stored; whether it stored.
inline bool writeValue(const std::string& name, long version, const std::string& entity, double value, long long event_ts) {
  const auto definition = registry::getDefinition(name, version);
  if (!definition) throw std::out_of_range("no definition " + name + " v" + std::to_string(version));
  std::ostringstream text;
  text << value;
  const long long expire_at = event_ts + definition->freshness_slo;
  return redis().eval<long long>(kWriteLua, {valueKey(name, version, entity)}, {text.str(), std::to_string(event_ts), std::to_string(expire_at)}) == 1;
}

// The entity's value with its event_ts and age_s, or none.
inline std::optional<Value> readValue(const std::string& name, long version, const std::string& entity) {
  const std::unordered_map<std::string, std::string> raw = redis().hgetall(valueKey(name, version, entity));
  if (!raw.count("event_ts")) return std::nullopt;
  const long long event_ts = std::stoll(raw.at("event_ts"));
  return Value{std::stod(raw.at("value")), event_ts, nowSeconds() - event_ts};
}

}  // namespace online
`,
  'features/stats.h': `// Feature stats (provided): stats:{name}:{version} is a hash of running sums over every scanned row:
// count (rows, nulls included), nulls, sum and sumsq (of the non-null values), newest_ts (the newest
// event_ts) and updated_at (when a row was last observed). baseline:{name} holds the version an
// operator pinned as the baseline.
#pragma once

#include <sw/redis++/redis++.h>

#include <chrono>
#include <optional>
#include <string>
#include <unordered_map>

namespace stats {

// A version's running sums.
struct Sums {
  long long count = 0;
  long long nulls = 0;
  double sum = 0;
  double sumsq = 0;
  long long newest_ts = 0;
  long long updated_at = 0;
};

inline sw::redis::Redis& redis() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

inline std::string statsKey(const std::string& name, long version) { return "stats:" + name + ":" + std::to_string(version); }

// Add one scanned row (no value for a null) to the version's sums.
inline void observe(const std::string& name, long version, std::optional<double> value, long long event_ts) {
  const std::string key = statsKey(name, version);
  redis().hincrby(key, "count", 1);
  if (!value) {
    redis().hincrby(key, "nulls", 1);
  } else {
    redis().hincrbyfloat(key, "sum", *value);
    redis().hincrbyfloat(key, "sumsq", *value * *value);
  }
  const auto newest = redis().hget(key, "newest_ts");
  if (!newest || std::stoll(*newest) < event_ts) redis().hset(key, "newest_ts", std::to_string(event_ts));
  const long long now = std::chrono::duration_cast<std::chrono::seconds>(std::chrono::system_clock::now().time_since_epoch()).count();
  redis().hset(key, "updated_at", std::to_string(now));
}

// The version's sums, or none.
inline std::optional<Sums> read(const std::string& name, long version) {
  const std::unordered_map<std::string, std::string> raw = redis().hgetall(statsKey(name, version));
  if (raw.empty()) return std::nullopt;
  const auto text = [&raw](const char* field) { return raw.count(field) ? raw.at(field) : std::string("0"); };
  return Sums{std::stoll(text("count")), std::stoll(text("nulls")), std::stod(text("sum")), std::stod(text("sumsq")),
              std::stoll(text("newest_ts")), std::stoll(text("updated_at"))};
}

inline void pinBaseline(const std::string& name, long version) { redis().set("baseline:" + name, std::to_string(version)); }

// The version pinned as the feature's baseline, or 0.
inline long baselineOf(const std::string& name) {
  const auto version = redis().get("baseline:" + name);
  return version ? std::stol(*version) : 0;
}

}  // namespace stats
`,
  'features/outbox.h': `// The outbox (provided): the Redis list outbox holds one JSON row per event the broker did not take
// ({topic, key, payload}); a relay produces them later.
#pragma once

#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <string>

namespace outbox {

inline sw::redis::Redis& redis() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

inline void insert(const std::string& topic, const std::string& key, const nlohmann::json& payload) {
  redis().rpush("outbox", nlohmann::json{{"topic", topic}, {"key", key}, {"payload", payload}}.dump());
}

}  // namespace outbox
`,
};

export const supportModulesScala: Record<string, string> = {
  [scalaPath('features', 'Registry')]: `package features

import redis.clients.jedis.JedisPooled
import redis.clients.jedis.params.SetParams
import spray.json._
import spray.json.DefaultJsonProtocol._

import scala.jdk.CollectionConverters._

/**
 * The registry (provided): definition:{name}:{version} holds one feature definition as a JSON
 * document (name, version, dtype, computation_ref, freshness_slo, created_at); compute:refs is the
 * set of computations the compute registry knows; partitions:{name}:{version} maps each committed
 * partition of a backfill to the rows it wrote.
 */
object Registry {
  final case class Definition(name: String, version: Long, dtype: String, computationRef: String, freshnessSlo: Long, createdAt: Long) {
    def toJson: JsObject = JsObject(
      "name" -> JsString(name), "version" -> JsNumber(version), "dtype" -> JsString(dtype),
      "computation_ref" -> JsString(computationRef), "freshness_slo" -> JsNumber(freshnessSlo), "created_at" -> JsNumber(createdAt))
  }

  val jedis = new JedisPooled("redis", 6379)

  def definitionKey(name: String, version: Long): String = s"definition:$name:$version"

  private def fromJson(raw: String): Definition = {
    val f = raw.parseJson.asJsObject.fields
    Definition(f("name").convertTo[String], f("version").convertTo[Long], f("dtype").convertTo[String],
      f("computation_ref").convertTo[String], f("freshness_slo").convertTo[Long], f("created_at").convertTo[Long])
  }

  /** The stored definition of (name, version), if any. */
  def getDefinition(name: String, version: Long): Option[Definition] = Option(jedis.get(definitionKey(name, version))).map(fromJson)

  /** Store the definition only if (name, version) has none yet, in one SET NX; whether it was stored. */
  def createDefinition(d: Definition): Boolean =
    jedis.set(definitionKey(d.name, d.version), d.toJson.compactPrint, SetParams.setParams().nx()) != null

  /** The bulk loader's writer: stores the definition over whatever (name, version) holds. */
  def putDefinition(d: Definition): Unit = jedis.set(definitionKey(d.name, d.version), d.toJson.compactPrint)

  /** Whether the compute registry knows the computation ref. */
  def computationExists(ref: String): Boolean = jedis.sismember("compute:refs", ref)

  def registerComputation(ref: String): Unit = jedis.sadd("compute:refs", ref)

  /** Record the partition as committed with the rows it wrote. */
  def commitPartition(name: String, version: Long, partition: String, rows: Long): Unit =
    jedis.hset(s"partitions:$name:$version", partition, rows.toString)

  def committedPartitions(name: String, version: Long): Map[String, Long] =
    jedis.hgetAll(s"partitions:$name:$version").asScala.toMap.map { case (partition, rows) => partition -> rows.toLong }
}
`,
  [scalaPath('features', 'Online')]: `package features

import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

/**
 * The online store (provided; step 2 builds the same two functions): feature:{name}:{version}:{entity}
 * is a hash with value and event_ts (epoch seconds). writeValue stores a value only if it is newer
 * than the stored one, in one Lua script that also sets the key to expire when the value goes stale
 * (event_ts + the definition's freshness_slo); it reports whether it stored. readValue answers the
 * value, its event_ts and its age in seconds. A scanned Row has None for a null.
 */
object Online {
  final case class Row(entity: String, value: Option[Double], eventTs: Long)
  final case class Value(value: Double, eventTs: Long, ageS: Long)

  val jedis = new JedisPooled("redis", 6379)

  val WriteLua: String =
    """local stored = redis.call('HGET', KEYS[1], 'event_ts')
      |if stored and tonumber(stored) >= tonumber(ARGV[2]) then return 0 end
      |redis.call('HSET', KEYS[1], 'value', ARGV[1], 'event_ts', ARGV[2])
      |redis.call('EXPIREAT', KEYS[1], ARGV[3])
      |return 1
      |""".stripMargin

  def valueKey(name: String, version: Long, entity: String): String = s"feature:$name:$version:$entity"

  /** Store the entity's value unless a value at least as new is stored; whether it stored. */
  def writeValue(name: String, version: Long, entity: String, value: Double, eventTs: Long): Boolean = {
    val definition = Registry.getDefinition(name, version).getOrElse(throw new NoSuchElementException(s"no definition $name v$version"))
    val args = List(value.toString, eventTs.toString, (eventTs + definition.freshnessSlo).toString).asJava
    jedis.eval(WriteLua, List(valueKey(name, version, entity)).asJava, args).asInstanceOf[java.lang.Long] == 1L
  }

  /** The entity's value with its event_ts and age_s, if any. */
  def readValue(name: String, version: Long, entity: String): Option[Value] = {
    val raw = jedis.hgetAll(valueKey(name, version, entity)).asScala
    raw.get("event_ts").map { ts =>
      Value(raw("value").toDouble, ts.toLong, System.currentTimeMillis() / 1000 - ts.toLong)
    }
  }
}
`,
  [scalaPath('features', 'Stats')]: `package features

import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

/**
 * Feature stats (provided): stats:{name}:{version} is a hash of running sums over every scanned row:
 * count (rows, nulls included), nulls, sum and sumsq (of the non-null values), newest_ts (the
 * newest event_ts) and updated_at (when a row was last observed). baseline:{name} holds the version
 * an operator pinned as the baseline.
 */
object Stats {
  final case class Sums(count: Long, nulls: Long, sum: Double, sumsq: Double, newestTs: Long, updatedAt: Long)

  val jedis = new JedisPooled("redis", 6379)

  def statsKey(name: String, version: Long): String = s"stats:$name:$version"

  /** Add one scanned row (None for a null) to the version's sums. */
  def observe(name: String, version: Long, value: Option[Double], eventTs: Long): Unit = {
    val key = statsKey(name, version)
    jedis.hincrBy(key, "count", 1)
    value match {
      case None => jedis.hincrBy(key, "nulls", 1)
      case Some(v) =>
        jedis.hincrByFloat(key, "sum", v)
        jedis.hincrByFloat(key, "sumsq", v * v)
    }
    if (Option(jedis.hget(key, "newest_ts")).forall(_.toLong < eventTs)) jedis.hset(key, "newest_ts", eventTs.toString)
    jedis.hset(key, "updated_at", (System.currentTimeMillis() / 1000).toString)
  }

  /** The version's sums, if any row was observed. */
  def read(name: String, version: Long): Option[Sums] = {
    val raw = jedis.hgetAll(statsKey(name, version)).asScala.toMap
    if (raw.isEmpty) None
    else {
      def field(name: String): String = raw.getOrElse(name, "0")
      Some(Sums(field("count").toLong, field("nulls").toLong, field("sum").toDouble, field("sumsq").toDouble, field("newest_ts").toLong, field("updated_at").toLong))
    }
  }

  def pinBaseline(name: String, version: Long): Unit = jedis.set(s"baseline:$name", version.toString)

  /** The version pinned as the feature's baseline, if any. */
  def baselineOf(name: String): Option[Long] = Option(jedis.get(s"baseline:$name")).map(_.toLong)
}
`,
  [scalaPath('features', 'Outbox')]: `package features

import redis.clients.jedis.JedisPooled
import spray.json._

/**
 * The outbox (provided): the Redis list outbox holds one JSON row per event the broker did not take
 * ({topic, key, payload}); a relay produces them later.
 */
object Outbox {
  val jedis = new JedisPooled("redis", 6379)

  def insert(topic: String, key: String, payload: JsObject): Unit =
    jedis.rpush("outbox", JsObject("topic" -> JsString(topic), "key" -> JsString(key), "payload" -> payload).compactPrint)
}
`,
};
