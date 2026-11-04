/**
 * Hand-written support modules the warehouse-loader steps import but no step builds: the `loader`
 * package. `loader.store` is the loads store (the course's stand-in for the loads database, in
 * Redis): loads, the source catalog, Idempotency-Key records, rejected rows and freshness marks.
 * `loader.progress` is step 2's partition progress as later steps use it (`commit_partition`,
 * `is_complete`). `loader.outbox` keeps the events the broker refused for the relay. The five
 * languages keep the same keys, so a harness reads one layout whatever the stack.
 */
import {scalaPath} from '../scala-support';

export const supportModules: Record<string, string> = {
  'loader/__init__.py': '',
  'loader/store.py': `"""
The loads store (provided). load:{id} is a hash with load_id, tenant, dataset, version, target,
mode, transform, sql, partitions, rows_planned, rows_read and status; load:seq numbers the loads
(ld-1, ld-2, ...). source:{dataset}:{version} is the source catalog: partition id -> row count.
loadkey:{tenant}:{key} is a hash (fingerprint, load_id): the load an Idempotency-Key started.
load:{id}:rejects is a list of JSON rows {partition_id, reason, rows}. freshness:{name} is a hash
(committed_at, load_id): the newest commit into a table (name = target), or the newest commit any
tenant's load made out of a source dataset (name = dataset).
"""
import json

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)


def _load(raw: dict) -> dict | None:
    if not raw:
        return None
    return {**raw, "partitions": int(raw["partitions"]), "rows_planned": int(raw["rows_planned"]), "rows_read": int(raw["rows_read"])}


def create_load(tenant: str, manifest: dict) -> dict:
    """A queued load of the manifest (dataset, version, target, mode, transform, sql); partitions and rows_planned come from the source catalog."""
    source = r.hgetall(f"source:{manifest['dataset']}:{manifest['version']}")
    load_id = f"ld-{r.incr('load:seq')}"
    r.hset(
        f"load:{load_id}",
        mapping={
            "load_id": load_id,
            "tenant": tenant,
            **{name: manifest[name] for name in ("dataset", "version", "target", "mode", "transform", "sql")},
            "partitions": len(source),
            "rows_planned": sum(int(rows) for rows in source.values()),
            "rows_read": 0,
            "status": "queued",
        },
    )
    return get_load(tenant, load_id)


def get_load(tenant: str, load_id: str) -> dict | None:
    """The load, or None when there is none or it belongs to another tenant."""
    load = _load(r.hgetall(f"load:{load_id}"))
    return load if load is not None and load["tenant"] == tenant else None


def find_key(tenant: str, key: str) -> dict | None:
    """What the Idempotency-Key (tenant, key) started: {"fingerprint", "load_id"}, or None."""
    return r.hgetall(f"loadkey:{tenant}:{key}") or None


def remember_key(tenant: str, key: str, fingerprint: str, load_id: str) -> None:
    """Record that (tenant, key) started load_id for the manifest with this fingerprint."""
    r.hset(f"loadkey:{tenant}:{key}", mapping={"fingerprint": fingerprint, "load_id": load_id})


def rejections(load_id: str) -> list[dict]:
    """The load's rejected rows, one {"partition_id", "reason", "rows"} per rejected batch."""
    return [json.loads(row) for row in r.lrange(f"load:{load_id}:rejects", 0, -1)]


def _freshness(name: str) -> dict | None:
    raw = r.hgetall(f"freshness:{name}")
    return {"committed_at": float(raw["committed_at"]), "load_id": raw["load_id"]} if raw else None


def table_freshness(target: str) -> dict | None:
    """The newest commit into the table: {"committed_at", "load_id"}, or None."""
    return _freshness(target)


def source_freshness(dataset: str) -> dict | None:
    """The newest commit any tenant's load made out of the source dataset: {"committed_at", "load_id"}, or None."""
    return _freshness(dataset)
`,
  'loader/progress.py': `"""
Partition progress (provided; step 2 builds the same two functions). load:{id}:partitions is the
set of committed partitions, load:{id}:complete the completion flag; both expire after
LOAD_TTL_S. commit_partition adds the partition and decides the completion in one Lua script: it
answers True only to the call that completed the load.
"""
import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

LOAD_TTL_S = 7 * 24 * 3600

COMMIT_LUA = """
redis.call('SADD', KEYS[1], ARGV[1])
redis.call('EXPIRE', KEYS[1], ARGV[3])
if redis.call('SCARD', KEYS[1]) < tonumber(ARGV[2]) then return 0 end
if redis.call('EXISTS', KEYS[2]) == 1 then return 0 end
redis.call('SET', KEYS[2], '1', 'EX', ARGV[3])
return 1
"""
commit = r.register_script(COMMIT_LUA)


def commit_partition(load_id: str, partition_id: str, total_partitions: int) -> bool:
    """Record a committed partition; True only for the commit that completed the load."""
    keys = [f"load:{load_id}:partitions", f"load:{load_id}:complete"]
    return commit(keys=keys, args=[partition_id, total_partitions, LOAD_TTL_S]) == 1


def is_complete(load_id: str) -> bool:
    """Whether every partition of the load committed."""
    return r.exists(f"load:{load_id}:complete") == 1
`,
  'loader/outbox.py': `"""
The outbox (provided): events the broker refused, for the relay to republish once it recovers.
loader:outbox is a list of JSON rows {topic, key, value}, value the event exactly as produced.
"""
import json

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)


def put(topic: str, key: str, value: str) -> None:
    """Keep a refused event for the relay."""
    r.rpush("loader:outbox", json.dumps({"topic": topic, "key": key, "value": value}))
`,
};

export const supportModulesTs: Record<string, string> = {
  'loader/store.ts': `/**
 * The loads store (provided). load:{id} is a hash with load_id, tenant, dataset, version, target,
 * mode, transform, sql, partitions, rows_planned, rows_read and status; load:seq numbers the loads
 * (ld-1, ld-2, ...). source:{dataset}:{version} is the source catalog: partition id -> row count.
 * loadkey:{tenant}:{key} is a hash (fingerprint, load_id): the load an Idempotency-Key started.
 * load:{id}:rejects is a list of JSON rows {partition_id, reason, rows}. freshness:{name} is a hash
 * (committed_at, load_id): the newest commit into a table (name = target), or the newest commit any
 * tenant's load made out of a source dataset (name = dataset).
 */
import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

export interface Manifest {
  dataset: string;
  version: string;
  target: string;
  mode: string;
  transform: string;
  sql: string;
}

export interface Load extends Manifest {
  load_id: string;
  tenant: string;
  partitions: number;
  rows_planned: number;
  rows_read: number;
  status: string;
}

export interface KeyRecord {
  fingerprint: string;
  load_id: string;
}

export interface Rejection {
  partition_id: string;
  reason: string;
  rows: number;
}

export interface Freshness {
  committed_at: number;
  load_id: string;
}

function load(raw: Record<string, string>): Load | null {
  if (Object.keys(raw).length === 0) return null;
  return {
    load_id: raw.load_id,
    tenant: raw.tenant,
    dataset: raw.dataset,
    version: raw.version,
    target: raw.target,
    mode: raw.mode,
    transform: raw.transform,
    sql: raw.sql,
    partitions: Number(raw.partitions),
    rows_planned: Number(raw.rows_planned),
    rows_read: Number(raw.rows_read),
    status: raw.status,
  };
}

/** A queued load of the manifest; partitions and rows_planned come from the source catalog. */
export async function createLoad(tenant: string, manifest: Manifest): Promise<Load> {
  const source = await redis.hgetall(\`source:\${manifest.dataset}:\${manifest.version}\`);
  const loadId = \`ld-\${await redis.incr('load:seq')}\`;
  const rowsPlanned = Object.values(source).reduce((sum, rows) => sum + Number(rows), 0);
  await redis.hset(\`load:\${loadId}\`, {
    load_id: loadId,
    tenant,
    dataset: manifest.dataset,
    version: manifest.version,
    target: manifest.target,
    mode: manifest.mode,
    transform: manifest.transform,
    sql: manifest.sql,
    partitions: String(Object.keys(source).length),
    rows_planned: String(rowsPlanned),
    rows_read: '0',
    status: 'queued',
  });
  return (await getLoad(tenant, loadId)) as Load;
}

/** The load, or null when there is none or it belongs to another tenant. */
export async function getLoad(tenant: string, loadId: string): Promise<Load | null> {
  const found = load(await redis.hgetall(\`load:\${loadId}\`));
  return found !== null && found.tenant === tenant ? found : null;
}

/** What the Idempotency-Key (tenant, key) started, or null. */
export async function findKey(tenant: string, key: string): Promise<KeyRecord | null> {
  const raw = await redis.hgetall(\`loadkey:\${tenant}:\${key}\`);
  return Object.keys(raw).length === 0 ? null : {fingerprint: raw.fingerprint, load_id: raw.load_id};
}

/** Record that (tenant, key) started loadId for the manifest with this fingerprint. */
export async function rememberKey(tenant: string, key: string, fingerprint: string, loadId: string): Promise<void> {
  await redis.hset(\`loadkey:\${tenant}:\${key}\`, {fingerprint, load_id: loadId});
}

/** The load's rejected rows, one per rejected batch. */
export async function rejections(loadId: string): Promise<Rejection[]> {
  return (await redis.lrange(\`load:\${loadId}:rejects\`, 0, -1)).map(row => JSON.parse(row) as Rejection);
}

async function freshness(name: string): Promise<Freshness | null> {
  const raw = await redis.hgetall(\`freshness:\${name}\`);
  return Object.keys(raw).length === 0 ? null : {committed_at: Number(raw.committed_at), load_id: raw.load_id};
}

/** The newest commit into the table, or null. */
export const tableFreshness = (target: string): Promise<Freshness | null> => freshness(target);

/** The newest commit any tenant's load made out of the source dataset, or null. */
export const sourceFreshness = (dataset: string): Promise<Freshness | null> => freshness(dataset);
`,
  'loader/progress.ts': `/**
 * Partition progress (provided; step 2 builds the same two functions). load:{id}:partitions is the
 * set of committed partitions, load:{id}:complete the completion flag; both expire after
 * LOAD_TTL_S. commitPartition adds the partition and decides the completion in one Lua script: it
 * answers true only to the call that completed the load.
 */
import Redis from 'ioredis';

export const LOAD_TTL_S = 7 * 24 * 3600;

export const COMMIT_LUA = \`
redis.call('SADD', KEYS[1], ARGV[1])
redis.call('EXPIRE', KEYS[1], ARGV[3])
if redis.call('SCARD', KEYS[1]) < tonumber(ARGV[2]) then return 0 end
if redis.call('EXISTS', KEYS[2]) == 1 then return 0 end
redis.call('SET', KEYS[2], '1', 'EX', ARGV[3])
return 1
\`;

interface ProgressRedis extends Redis {
  commitPartition(parts: string, complete: string, partitionId: string, total: number, ttl: number): Promise<number>;
}

const redis = new Redis({host: 'redis', port: 6379}) as ProgressRedis;
redis.defineCommand('commitPartition', {numberOfKeys: 2, lua: COMMIT_LUA});

/** Record a committed partition; true only for the commit that completed the load. */
export async function commitPartition(loadId: string, partitionId: string, totalPartitions: number): Promise<boolean> {
  return (await redis.commitPartition(\`load:\${loadId}:partitions\`, \`load:\${loadId}:complete\`, partitionId, totalPartitions, LOAD_TTL_S)) === 1;
}

/** Whether every partition of the load committed. */
export async function isComplete(loadId: string): Promise<boolean> {
  return (await redis.exists(\`load:\${loadId}:complete\`)) === 1;
}
`,
  'loader/outbox.ts': `/**
 * The outbox (provided): events the broker refused, for the relay to republish once it recovers.
 * loader:outbox is a list of JSON rows {topic, key, value}, value the event exactly as produced.
 */
import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

/** Keep a refused event for the relay. */
export async function put(topic: string, key: string, value: string): Promise<void> {
  await redis.rpush('loader:outbox', JSON.stringify({topic, key, value}));
}
`,
};

export const supportModulesGo: Record<string, string> = {
  'loader/store/store.go': `// Package store is the loads store (provided). load:{id} is a hash with load_id, tenant, dataset,
// version, target, mode, transform, sql, partitions, rows_planned, rows_read and status; load:seq
// numbers the loads (ld-1, ld-2, ...). source:{dataset}:{version} is the source catalog: partition
// id -> row count. loadkey:{tenant}:{key} is a hash (fingerprint, load_id): the load an
// Idempotency-Key started. load:{id}:rejects is a list of JSON rows {partition_id, reason, rows}.
// freshness:{name} is a hash (committed_at, load_id): the newest commit into a table (name =
// target), or the newest commit any tenant's load made out of a source dataset (name = dataset).
package store

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// Manifest is what a load loads: the source version, the target table, the mode and the transform
// with the SQL it compiles to.
type Manifest struct {
	Dataset   string
	Version   string
	Target    string
	Mode      string
	Transform string
	SQL       string
}

// Load is one load of a manifest.
type Load struct {
	LoadID      string \`json:"load_id"\`
	Tenant      string \`json:"tenant"\`
	Dataset     string \`json:"dataset"\`
	Version     string \`json:"version"\`
	Target      string \`json:"target"\`
	Mode        string \`json:"mode"\`
	Transform   string \`json:"transform"\`
	SQL         string \`json:"sql"\`
	Partitions  int    \`json:"partitions"\`
	RowsPlanned int64  \`json:"rows_planned"\`
	RowsRead    int64  \`json:"rows_read"\`
	Status      string \`json:"status"\`
}

// KeyRecord is what an Idempotency-Key started.
type KeyRecord struct {
	Fingerprint string
	LoadID      string
}

// Rejection is one rejected batch of a load.
type Rejection struct {
	PartitionID string \`json:"partition_id"\`
	Reason      string \`json:"reason"\`
	Rows        int64  \`json:"rows"\`
}

// Freshness is the newest commit into a table or out of a source dataset.
type Freshness struct {
	CommittedAt float64 \`json:"committed_at"\`
	LoadID      string  \`json:"load_id"\`
}

func load(raw map[string]string) *Load {
	if len(raw) == 0 {
		return nil
	}
	partitions, _ := strconv.Atoi(raw["partitions"])
	planned, _ := strconv.ParseInt(raw["rows_planned"], 10, 64)
	read, _ := strconv.ParseInt(raw["rows_read"], 10, 64)
	return &Load{LoadID: raw["load_id"], Tenant: raw["tenant"], Dataset: raw["dataset"], Version: raw["version"], Target: raw["target"],
		Mode: raw["mode"], Transform: raw["transform"], SQL: raw["sql"], Partitions: partitions, RowsPlanned: planned, RowsRead: read, Status: raw["status"]}
}

// CreateLoad makes a queued load of the manifest; partitions and rows_planned come from the source catalog.
func CreateLoad(ctx context.Context, tenant string, m Manifest) *Load {
	source := rdb.HGetAll(ctx, "source:"+m.Dataset+":"+m.Version).Val()
	var planned int64
	for _, rows := range source {
		n, _ := strconv.ParseInt(rows, 10, 64)
		planned += n
	}
	loadID := fmt.Sprintf("ld-%d", rdb.Incr(ctx, "load:seq").Val())
	rdb.HSet(ctx, "load:"+loadID, map[string]any{
		"load_id": loadID, "tenant": tenant, "dataset": m.Dataset, "version": m.Version, "target": m.Target, "mode": m.Mode,
		"transform": m.Transform, "sql": m.SQL, "partitions": strconv.Itoa(len(source)), "rows_planned": strconv.FormatInt(planned, 10),
		"rows_read": "0", "status": "queued",
	})
	return GetLoad(ctx, tenant, loadID)
}

// GetLoad is the load, or nil when there is none or it belongs to another tenant.
func GetLoad(ctx context.Context, tenant, loadID string) *Load {
	found := load(rdb.HGetAll(ctx, "load:"+loadID).Val())
	if found == nil || found.Tenant != tenant {
		return nil
	}
	return found
}

// FindKey is what the Idempotency-Key (tenant, key) started, or nil.
func FindKey(ctx context.Context, tenant, key string) *KeyRecord {
	raw := rdb.HGetAll(ctx, "loadkey:"+tenant+":"+key).Val()
	if len(raw) == 0 {
		return nil
	}
	return &KeyRecord{Fingerprint: raw["fingerprint"], LoadID: raw["load_id"]}
}

// RememberKey records that (tenant, key) started loadID for the manifest with this fingerprint.
func RememberKey(ctx context.Context, tenant, key, fingerprint, loadID string) {
	rdb.HSet(ctx, "loadkey:"+tenant+":"+key, map[string]any{"fingerprint": fingerprint, "load_id": loadID})
}

// Rejections are the load's rejected rows, one per rejected batch.
func Rejections(ctx context.Context, loadID string) []Rejection {
	out := []Rejection{}
	for _, row := range rdb.LRange(ctx, "load:"+loadID+":rejects", 0, -1).Val() {
		var r Rejection
		json.Unmarshal([]byte(row), &r)
		out = append(out, r)
	}
	return out
}

func freshness(ctx context.Context, name string) *Freshness {
	raw := rdb.HGetAll(ctx, "freshness:"+name).Val()
	if len(raw) == 0 {
		return nil
	}
	at, _ := strconv.ParseFloat(raw["committed_at"], 64)
	return &Freshness{CommittedAt: at, LoadID: raw["load_id"]}
}

// TableFreshness is the newest commit into the table, or nil.
func TableFreshness(ctx context.Context, target string) *Freshness { return freshness(ctx, target) }

// SourceFreshness is the newest commit any tenant's load made out of the source dataset, or nil.
func SourceFreshness(ctx context.Context, dataset string) *Freshness { return freshness(ctx, dataset) }
`,
  'loader/progress/progress.go': `// Package progress is partition progress (provided; step 2 builds the same two functions).
// load:{id}:partitions is the set of committed partitions, load:{id}:complete the completion flag;
// both expire after LoadTTLSeconds. CommitPartition adds the partition and decides the completion
// in one Lua script: it answers true only to the call that completed the load.
package progress

import (
	"context"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// LoadTTLSeconds is how long a load's progress keys live.
const LoadTTLSeconds = 7 * 24 * 3600

var commit = redis.NewScript(\`
redis.call('SADD', KEYS[1], ARGV[1])
redis.call('EXPIRE', KEYS[1], ARGV[3])
if redis.call('SCARD', KEYS[1]) < tonumber(ARGV[2]) then return 0 end
if redis.call('EXISTS', KEYS[2]) == 1 then return 0 end
redis.call('SET', KEYS[2], '1', 'EX', ARGV[3])
return 1
\`)

// CommitPartition records a committed partition; true only for the commit that completed the load.
func CommitPartition(ctx context.Context, loadID, partitionID string, totalPartitions int) (bool, error) {
	keys := []string{"load:" + loadID + ":partitions", "load:" + loadID + ":complete"}
	done, err := commit.Run(ctx, rdb, keys, partitionID, totalPartitions, LoadTTLSeconds).Int64()
	return done == 1, err
}

// IsComplete reports whether every partition of the load committed.
func IsComplete(ctx context.Context, loadID string) (bool, error) {
	n, err := rdb.Exists(ctx, "load:"+loadID+":complete").Result()
	return n == 1, err
}
`,
  'loader/outbox/outbox.go': `// Package outbox keeps the events the broker refused (provided), for the relay to republish once it
// recovers. loader:outbox is a list of JSON rows {topic, key, value}, value the event exactly as
// produced.
package outbox

import (
	"context"
	"encoding/json"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// Put keeps a refused event for the relay.
func Put(ctx context.Context, topic, key, value string) error {
	row, _ := json.Marshal(map[string]string{"topic": topic, "key": key, "value": value})
	return rdb.RPush(ctx, "loader:outbox", string(row)).Err()
}
`,
};

export const supportModulesCpp: Record<string, string> = {
  'loader/store.h': `// The loads store (provided). load:{id} is a hash with load_id, tenant, dataset, version, target,
// mode, transform, sql, partitions, rows_planned, rows_read and status; load:seq numbers the loads
// (ld-1, ld-2, ...). source:{dataset}:{version} is the source catalog: partition id -> row count.
// loadkey:{tenant}:{key} is a hash (fingerprint, load_id): the load an Idempotency-Key started.
// load:{id}:rejects is a list of JSON rows {partition_id, reason, rows}. freshness:{name} is a hash
// (committed_at, load_id): the newest commit into a table (name = target), or the newest commit any
// tenant's load made out of a source dataset (name = dataset).
#pragma once

#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <optional>
#include <string>
#include <unordered_map>
#include <vector>

namespace store {

// What a load loads: the source version, the target table, the mode and the transform with the
// SQL it compiles to.
struct Manifest {
  std::string dataset;
  std::string version;
  std::string target;
  std::string mode;
  std::string transform;
  std::string sql;
};

// One load of a manifest.
struct Load {
  std::string load_id;
  std::string tenant;
  std::string dataset;
  std::string version;
  std::string target;
  std::string mode;
  std::string transform;
  std::string sql;
  long partitions = 0;
  long rows_planned = 0;
  long rows_read = 0;
  std::string status;
};

// What an Idempotency-Key started.
struct KeyRecord {
  std::string fingerprint;
  std::string load_id;
};

// One rejected batch of a load.
struct Rejection {
  std::string partition_id;
  std::string reason;
  long rows = 0;
};

// The newest commit into a table or out of a source dataset.
struct Freshness {
  double committed_at = 0;
  std::string load_id;
};

inline sw::redis::Redis& redis() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

inline std::optional<Load> loadOf(const std::unordered_map<std::string, std::string>& raw) {
  if (raw.empty()) return std::nullopt;
  const auto text = [&raw](const char* name) { return raw.count(name) ? raw.at(name) : std::string(); };
  const auto number = [&text](const char* name) { return text(name).empty() ? 0L : std::stol(text(name)); };
  return Load{text("load_id"), text("tenant"), text("dataset"), text("version"), text("target"), text("mode"), text("transform"),
              text("sql"), number("partitions"), number("rows_planned"), number("rows_read"), text("status")};
}

// The load, or none when there is none or it belongs to another tenant.
inline std::optional<Load> getLoad(const std::string& tenant, const std::string& load_id) {
  auto found = loadOf(redis().hgetall("load:" + load_id));
  if (!found || found->tenant != tenant) return std::nullopt;
  return found;
}

// A queued load of the manifest; partitions and rows_planned come from the source catalog.
inline Load createLoad(const std::string& tenant, const Manifest& m) {
  const std::unordered_map<std::string, std::string> source = redis().hgetall("source:" + m.dataset + ":" + m.version);
  long planned = 0;
  for (const auto& [partition, rows] : source) planned += std::stol(rows);
  const std::string load_id = "ld-" + std::to_string(redis().incr("load:seq"));
  const std::unordered_map<std::string, std::string> fields = {
      {"load_id", load_id}, {"tenant", tenant}, {"dataset", m.dataset}, {"version", m.version}, {"target", m.target},
      {"mode", m.mode}, {"transform", m.transform}, {"sql", m.sql}, {"partitions", std::to_string(source.size())},
      {"rows_planned", std::to_string(planned)}, {"rows_read", "0"}, {"status", "queued"}};
  redis().hset("load:" + load_id, fields.begin(), fields.end());
  return *getLoad(tenant, load_id);
}

// What the Idempotency-Key (tenant, key) started, or none.
inline std::optional<KeyRecord> findKey(const std::string& tenant, const std::string& key) {
  const std::unordered_map<std::string, std::string> raw = redis().hgetall("loadkey:" + tenant + ":" + key);
  if (raw.empty()) return std::nullopt;
  return KeyRecord{raw.at("fingerprint"), raw.at("load_id")};
}

// Record that (tenant, key) started load_id for the manifest with this fingerprint.
inline void rememberKey(const std::string& tenant, const std::string& key, const std::string& fingerprint, const std::string& load_id) {
  redis().hset("loadkey:" + tenant + ":" + key, {std::make_pair(std::string("fingerprint"), fingerprint), std::make_pair(std::string("load_id"), load_id)});
}

// The load's rejected rows, one per rejected batch.
inline std::vector<Rejection> rejections(const std::string& load_id) {
  std::vector<Rejection> out;
  for (const std::string& row : redis().lrange("load:" + load_id + ":rejects", 0, -1)) {
    const nlohmann::json j = nlohmann::json::parse(row);
    out.push_back(Rejection{j.value("partition_id", ""), j.value("reason", ""), j.value("rows", 0L)});
  }
  return out;
}

inline std::optional<Freshness> freshnessOf(const std::string& name) {
  const std::unordered_map<std::string, std::string> raw = redis().hgetall("freshness:" + name);
  if (raw.empty()) return std::nullopt;
  return Freshness{std::stod(raw.at("committed_at")), raw.at("load_id")};
}

// The newest commit into the table, or none.
inline std::optional<Freshness> tableFreshness(const std::string& target) { return freshnessOf(target); }

// The newest commit any tenant's load made out of the source dataset, or none.
inline std::optional<Freshness> sourceFreshness(const std::string& dataset) { return freshnessOf(dataset); }

}  // namespace store
`,
  'loader/progress.h': `// Partition progress (provided; step 2 builds the same two functions). load:{id}:partitions is the
// set of committed partitions, load:{id}:complete the completion flag; both expire after
// kLoadTtlSeconds. commitPartition adds the partition and decides the completion in one Lua
// script: it answers true only to the call that completed the load.
#pragma once

#include <sw/redis++/redis++.h>

#include <string>

namespace progress {

constexpr long kLoadTtlSeconds = 7 * 24 * 3600;

inline const std::string kCommitLua = R"lua(
redis.call('SADD', KEYS[1], ARGV[1])
redis.call('EXPIRE', KEYS[1], ARGV[3])
if redis.call('SCARD', KEYS[1]) < tonumber(ARGV[2]) then return 0 end
if redis.call('EXISTS', KEYS[2]) == 1 then return 0 end
redis.call('SET', KEYS[2], '1', 'EX', ARGV[3])
return 1
)lua";

inline sw::redis::Redis& redis() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

// Record a committed partition; true only for the commit that completed the load.
inline bool commitPartition(const std::string& load_id, const std::string& partition_id, long total_partitions) {
  return redis().eval<long long>(kCommitLua, {"load:" + load_id + ":partitions", "load:" + load_id + ":complete"},
                                 {partition_id, std::to_string(total_partitions), std::to_string(kLoadTtlSeconds)}) == 1;
}

// Whether every partition of the load committed.
inline bool isComplete(const std::string& load_id) { return redis().exists("load:" + load_id + ":complete") == 1; }

}  // namespace progress
`,
  'loader/outbox.h': `// The outbox (provided): events the broker refused, for the relay to republish once it recovers.
// loader:outbox is a list of JSON rows {topic, key, value}, value the event exactly as produced.
#pragma once

#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <string>

namespace outbox {

inline sw::redis::Redis& redis() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

// Keep a refused event for the relay.
inline void put(const std::string& topic, const std::string& key, const std::string& value) {
  redis().rpush("loader:outbox", nlohmann::json{{"topic", topic}, {"key", key}, {"value", value}}.dump());
}

}  // namespace outbox
`,
};

export const supportModulesScala: Record<string, string> = {
  [scalaPath('loader', 'Store')]: `package loader

import redis.clients.jedis.JedisPooled
import spray.json._

import scala.jdk.CollectionConverters._

/**
 * The loads store (provided). load:{id} is a hash with load_id, tenant, dataset, version, target,
 * mode, transform, sql, partitions, rows_planned, rows_read and status; load:seq numbers the loads
 * (ld-1, ld-2, ...). source:{dataset}:{version} is the source catalog: partition id -> row count.
 * loadkey:{tenant}:{key} is a hash (fingerprint, load_id): the load an Idempotency-Key started.
 * load:{id}:rejects is a list of JSON rows {partition_id, reason, rows}. freshness:{name} is a hash
 * (committed_at, load_id): the newest commit into a table (name = target), or the newest commit any
 * tenant's load made out of a source dataset (name = dataset).
 */
object Store {
  final case class Manifest(dataset: String, version: String, target: String, mode: String, transform: String, sql: String)
  final case class Load(
      loadId: String,
      tenant: String,
      dataset: String,
      version: String,
      target: String,
      mode: String,
      transform: String,
      sql: String,
      partitions: Int,
      rowsPlanned: Long,
      rowsRead: Long,
      status: String
  )
  final case class KeyRecord(fingerprint: String, loadId: String)
  final case class Rejection(partitionId: String, reason: String, rows: Long)
  final case class Freshness(committedAt: Double, loadId: String)

  val jedis = new JedisPooled("redis", 6379)

  private def load(raw: Map[String, String]): Option[Load] =
    if (raw.isEmpty) None
    else
      Some(Load(raw("load_id"), raw("tenant"), raw("dataset"), raw("version"), raw("target"), raw("mode"), raw("transform"), raw("sql"),
        raw("partitions").toInt, raw("rows_planned").toLong, raw("rows_read").toLong, raw("status")))

  /** A queued load of the manifest; partitions and rows_planned come from the source catalog. */
  def createLoad(tenant: String, m: Manifest): Load = {
    val source = jedis.hgetAll(s"source:\${m.dataset}:\${m.version}").asScala.toMap
    val loadId = s"ld-\${jedis.incr("load:seq")}"
    jedis.hset(
      s"load:$loadId",
      Map(
        "load_id" -> loadId, "tenant" -> tenant, "dataset" -> m.dataset, "version" -> m.version, "target" -> m.target, "mode" -> m.mode,
        "transform" -> m.transform, "sql" -> m.sql, "partitions" -> source.size.toString, "rows_planned" -> source.values.map(_.toLong).sum.toString,
        "rows_read" -> "0", "status" -> "queued"
      ).asJava
    )
    getLoad(tenant, loadId).get
  }

  /** The load, or None when there is none or it belongs to another tenant. */
  def getLoad(tenant: String, loadId: String): Option[Load] =
    load(jedis.hgetAll(s"load:$loadId").asScala.toMap).filter(_.tenant == tenant)

  /** What the Idempotency-Key (tenant, key) started, if anything. */
  def findKey(tenant: String, key: String): Option[KeyRecord] = {
    val raw = jedis.hgetAll(s"loadkey:$tenant:$key").asScala
    if (raw.isEmpty) None else Some(KeyRecord(raw("fingerprint"), raw("load_id")))
  }

  /** Record that (tenant, key) started loadId for the manifest with this fingerprint. */
  def rememberKey(tenant: String, key: String, fingerprint: String, loadId: String): Unit =
    jedis.hset(s"loadkey:$tenant:$key", Map("fingerprint" -> fingerprint, "load_id" -> loadId).asJava)

  /** The load's rejected rows, one per rejected batch. */
  def rejections(loadId: String): Seq[Rejection] =
    jedis.lrange(s"load:$loadId:rejects", 0, -1).asScala.toSeq.map { row =>
      val fields = row.parseJson.asJsObject.fields
      Rejection(fields("partition_id").asInstanceOf[JsString].value, fields("reason").asInstanceOf[JsString].value, fields("rows").asInstanceOf[JsNumber].value.toLong)
    }

  private def freshness(name: String): Option[Freshness] = {
    val raw = jedis.hgetAll(s"freshness:$name").asScala
    if (raw.isEmpty) None else Some(Freshness(raw("committed_at").toDouble, raw("load_id")))
  }

  /** The newest commit into the table, if any. */
  def tableFreshness(target: String): Option[Freshness] = freshness(target)

  /** The newest commit any tenant's load made out of the source dataset, if any. */
  def sourceFreshness(dataset: String): Option[Freshness] = freshness(dataset)
}
`,
  [scalaPath('loader', 'Progress')]: `package loader

import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

/**
 * Partition progress (provided; step 2 builds the same two functions). load:{id}:partitions is the
 * set of committed partitions, load:{id}:complete the completion flag; both expire after
 * LoadTtlSeconds. commitPartition adds the partition and decides the completion in one Lua script:
 * it answers true only to the call that completed the load.
 */
object Progress {
  val LoadTtlSeconds: Long = 7L * 24 * 3600

  val CommitLua: String =
    """redis.call('SADD', KEYS[1], ARGV[1])
      |redis.call('EXPIRE', KEYS[1], ARGV[3])
      |if redis.call('SCARD', KEYS[1]) < tonumber(ARGV[2]) then return 0 end
      |if redis.call('EXISTS', KEYS[2]) == 1 then return 0 end
      |redis.call('SET', KEYS[2], '1', 'EX', ARGV[3])
      |return 1
      |""".stripMargin

  val jedis = new JedisPooled("redis", 6379)

  /** Record a committed partition; true only for the commit that completed the load. */
  def commitPartition(loadId: String, partitionId: String, totalPartitions: Int): Boolean = {
    val keys = List(s"load:$loadId:partitions", s"load:$loadId:complete").asJava
    val args = List(partitionId, totalPartitions.toString, LoadTtlSeconds.toString).asJava
    jedis.eval(CommitLua, keys, args).asInstanceOf[java.lang.Long] == 1L
  }

  /** Whether every partition of the load committed. */
  def isComplete(loadId: String): Boolean = jedis.exists(s"load:$loadId:complete")
}
`,
  [scalaPath('loader', 'Outbox')]: `package loader

import redis.clients.jedis.JedisPooled
import spray.json._

/**
 * The outbox (provided): events the broker refused, for the relay to republish once it recovers.
 * loader:outbox is a list of JSON rows {topic, key, value}, value the event exactly as produced.
 */
object Outbox {
  val jedis = new JedisPooled("redis", 6379)

  /** Keep a refused event for the relay. */
  def put(topic: String, key: String, value: String): Unit =
    jedis.rpush("loader:outbox", JsObject("topic" -> JsString(topic), "key" -> JsString(key), "value" -> JsString(value)).compactPrint)
}
`,
};
