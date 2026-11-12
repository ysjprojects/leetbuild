/**
 * Hand-written support modules the dedupe-service steps import but no step builds: the `dedupe`
 * package. `records` is the durable record store (Redis hashes stand in for the database),
 * `exact` the per-tenant exact-key index as step 2 builds it (claim and lookup, plus the
 * cross-tenant lookup a batch job uses), `outbox` the rows a relay publishes later, and `clusters`
 * the candidate pairs and merge history behind a cluster. The five languages keep the same keys, so
 * a harness reads one layout whatever the stack.
 */
import {scalaPath} from '../scala-support';

export const supportModules: Record<string, string> = {
  'dedupe/__init__.py': '',
  'dedupe/records.py': `"""
The durable record store (provided; Redis hashes stand in for the database): a record is the hash
record:{record_id} with record_id, tenant, dataset_id, name, email and keys (a JSON object from key
type to SHA-256 hex digest); records:{tenant} lists a tenant's record ids in creation order.
"""
import json

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)


def create(tenant: str, dataset_id: str, name: str, email: str, keys: dict) -> dict:
    """A new record of the tenant; returns it."""
    record_id = f"r-{r.incr('record:seq')}"
    r.hset(
        f"record:{record_id}",
        mapping={"record_id": record_id, "tenant": tenant, "dataset_id": dataset_id, "name": name, "email": email, "keys": json.dumps(keys, sort_keys=True)},
    )
    r.rpush(f"records:{tenant}", record_id)
    return get(record_id)


def get(record_id: str) -> dict | None:
    """The record, or None."""
    raw = r.hgetall(f"record:{record_id}")
    if not raw:
        return None
    return {**raw, "keys": json.loads(raw["keys"])}


def of_tenant(tenant: str) -> list[dict]:
    """Every record of the tenant, oldest first."""
    return [get(record_id) for record_id in r.lrange(f"records:{tenant}", 0, -1)]
`,
  'dedupe/exact.py': `"""
The exact-key index (provided; step 2 builds claim and lookup): t:{tenant}:exact:{key_type} is a hash
from a key's SHA-256 hex digest to the id of the record that holds it. claim inserts the key in one
Lua script and reports whether the caller's record won it ("winner") or another record already holds
it ("existing", with that record's id); lookup reads it. lookup_global is the cross-tenant lookup the
trust-and-safety batch job uses: it scans every tenant's index and answers the first holder.
"""
import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

CLAIM_LUA = """
if redis.call('HSETNX', KEYS[1], ARGV[1], ARGV[2]) == 1 then return {'winner', ARGV[2]} end
return {'existing', redis.call('HGET', KEYS[1], ARGV[1])}
"""
claim_script = r.register_script(CLAIM_LUA)


def index_key(tenant: str, key_type: str) -> str:
    return f"t:{tenant}:exact:{key_type}"


def claim(tenant: str, key_type: str, value: str, record_id: str) -> dict:
    """Insert the key for record_id unless a record holds it: {"outcome", "record_id"} of the holder."""
    outcome, holder = claim_script(keys=[index_key(tenant, key_type)], args=[value, record_id])
    return {"outcome": outcome, "record_id": holder}


def lookup(tenant: str, key_type: str, value: str) -> str | None:
    """The id of the tenant's record holding the key, or None."""
    return r.hget(index_key(tenant, key_type), value)


def lookup_global(key_type: str, value: str) -> dict | None:
    """The first holder of the key in any tenant's index: {"tenant", "record_id"}, or None."""
    for key in sorted(r.keys(f"t:*:exact:{key_type}")):
        holder = r.hget(key, value)
        if holder is not None:
            return {"tenant": key.split(":")[1], "record_id": holder}
    return None
`,
  'dedupe/outbox.py': `"""
The outbox (provided): the Redis list outbox of JSON rows {"topic", "key", "payload"} that a relay
publishes later, oldest first.
"""
import json

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)


def insert(topic: str, key: str, payload: dict) -> None:
    """Queue a record for the relay to publish later."""
    r.rpush("outbox", json.dumps({"topic": topic, "key": key, "payload": payload}))


def rows() -> list[dict]:
    """Everything queued, oldest first."""
    return [json.loads(row) for row in r.lrange("outbox", 0, -1)]
`,
  'dedupe/clusters.py': `"""
The cluster store (provided): cluster:{cluster_id} is a hash with cluster_id, tenant and seed (the
record the cluster grew from); cluster:{cluster_id}:pairs lists the candidate pairs the matcher
scored, each JSON {"a", "b", "score", "key_type"} (key_type is the exact key that matched, or
"fuzzy"); cluster:{cluster_id}:history lists the merge actions, each JSON {"at", "action", "a", "b",
"by"}, oldest first.
"""
import json

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)


def create(tenant: str, seed: str, pairs: list[dict], history: list[dict]) -> str:
    """Store a cluster of the tenant; returns its id."""
    cluster_id = f"c-{r.incr('cluster:seq')}"
    r.hset(f"cluster:{cluster_id}", mapping={"cluster_id": cluster_id, "tenant": tenant, "seed": seed})
    for pair in pairs:
        r.rpush(f"cluster:{cluster_id}:pairs", json.dumps(pair))
    for entry in history:
        r.rpush(f"cluster:{cluster_id}:history", json.dumps(entry))
    return cluster_id


def load(cluster_id: str) -> dict | None:
    """{"cluster_id", "tenant", "seed", "pairs", "history"}, or None: whichever tenant owns it."""
    raw = r.hgetall(f"cluster:{cluster_id}")
    if not raw:
        return None
    return {
        "cluster_id": raw["cluster_id"],
        "tenant": raw["tenant"],
        "seed": raw["seed"],
        "pairs": [json.loads(p) for p in r.lrange(f"cluster:{cluster_id}:pairs", 0, -1)],
        "history": [json.loads(h) for h in r.lrange(f"cluster:{cluster_id}:history", 0, -1)],
    }
`,
};

export const supportModulesTs: Record<string, string> = {
  'dedupe/records.ts': `/**
 * The durable record store (provided; Redis hashes stand in for the database): a record is the hash
 * record:{record_id} with record_id, tenant, dataset_id, name, email and keys (a JSON object from
 * key type to SHA-256 hex digest); records:{tenant} lists a tenant's record ids in creation order.
 */
import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

export interface Row {
  record_id: string;
  tenant: string;
  dataset_id: string;
  name: string;
  email: string;
  keys: Record<string, string>;
}

/** The record, or null. */
export async function get(recordId: string): Promise<Row | null> {
  const raw = await redis.hgetall(\`record:\${recordId}\`);
  if (Object.keys(raw).length === 0) return null;
  return {
    record_id: raw.record_id,
    tenant: raw.tenant,
    dataset_id: raw.dataset_id,
    name: raw.name,
    email: raw.email,
    keys: JSON.parse(raw.keys) as Record<string, string>,
  };
}

/** A new record of the tenant; returns it. */
export async function create(tenant: string, datasetId: string, name: string, email: string, keys: Record<string, string>): Promise<Row> {
  const recordId = \`r-\${await redis.incr('record:seq')}\`;
  await redis.hset(\`record:\${recordId}\`, {
    record_id: recordId,
    tenant,
    dataset_id: datasetId,
    name,
    email,
    keys: JSON.stringify(Object.fromEntries(Object.entries(keys).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))),
  });
  await redis.rpush(\`records:\${tenant}\`, recordId);
  return (await get(recordId)) as Row;
}

/** Every record of the tenant, oldest first. */
export async function ofTenant(tenant: string): Promise<Row[]> {
  const ids = await redis.lrange(\`records:\${tenant}\`, 0, -1);
  const rows: Row[] = [];
  for (const id of ids) rows.push((await get(id)) as Row);
  return rows;
}
`,
  'dedupe/exact.ts': `/**
 * The exact-key index (provided; step 2 builds claim and lookup): t:{tenant}:exact:{key_type} is a
 * hash from a key's SHA-256 hex digest to the id of the record that holds it. claim inserts the key
 * in one Lua script and reports whether the caller's record won it ("winner") or another record
 * already holds it ("existing", with that record's id); lookup reads it. lookupGlobal is the
 * cross-tenant lookup the trust-and-safety batch job uses: it scans every tenant's index and
 * answers the first holder.
 */
import Redis from 'ioredis';

export const CLAIM_LUA = \`
if redis.call('HSETNX', KEYS[1], ARGV[1], ARGV[2]) == 1 then return {'winner', ARGV[2]} end
return {'existing', redis.call('HGET', KEYS[1], ARGV[1])}
\`;

interface ClaimRedis extends Redis {
  claimKey(key: string, value: string, recordId: string): Promise<[string, string]>;
}

const redis = new Redis({host: 'redis', port: 6379}) as ClaimRedis;
redis.defineCommand('claimKey', {numberOfKeys: 1, lua: CLAIM_LUA});

export interface Claim {
  outcome: string;
  record_id: string;
}

export const indexKey = (tenant: string, keyType: string): string => \`t:\${tenant}:exact:\${keyType}\`;

/** Insert the key for recordId unless a record holds it: the outcome and the holder's id. */
export async function claim(tenant: string, keyType: string, value: string, recordId: string): Promise<Claim> {
  const [outcome, holder] = await redis.claimKey(indexKey(tenant, keyType), value, recordId);
  return {outcome, record_id: holder};
}

/** The id of the tenant's record holding the key, or null. */
export async function lookup(tenant: string, keyType: string, value: string): Promise<string | null> {
  return redis.hget(indexKey(tenant, keyType), value);
}

/** The first holder of the key in any tenant's index, or null. */
export async function lookupGlobal(keyType: string, value: string): Promise<{tenant: string; record_id: string} | null> {
  const keys = (await redis.keys(\`t:*:exact:\${keyType}\`)).sort();
  for (const key of keys) {
    const holder = await redis.hget(key, value);
    if (holder !== null) return {tenant: key.split(':')[1], record_id: holder};
  }
  return null;
}
`,
  'dedupe/outbox.ts': `/**
 * The outbox (provided): the Redis list outbox of JSON rows {"topic", "key", "payload"} that a relay
 * publishes later, oldest first.
 */
import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

/** Queue a record for the relay to publish later. */
export async function insert(topic: string, key: string, payload: unknown): Promise<void> {
  await redis.rpush('outbox', JSON.stringify({topic, key, payload}));
}

/** Everything queued, oldest first. */
export async function rows(): Promise<{topic: string; key: string; payload: unknown}[]> {
  return (await redis.lrange('outbox', 0, -1)).map(row => JSON.parse(row));
}
`,
  'dedupe/clusters.ts': `/**
 * The cluster store (provided): cluster:{cluster_id} is a hash with cluster_id, tenant and seed (the
 * record the cluster grew from); cluster:{cluster_id}:pairs lists the candidate pairs the matcher
 * scored, each JSON {"a", "b", "score", "key_type"} (key_type is the exact key that matched, or
 * "fuzzy"); cluster:{cluster_id}:history lists the merge actions, each JSON {"at", "action", "a",
 * "b", "by"}, oldest first.
 */
import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

export interface Pair {
  a: string;
  b: string;
  score: number;
  key_type: string;
}

export interface HistoryEntry {
  at: string;
  action: string;
  a: string;
  b: string;
  by: string;
}

export interface Cluster {
  cluster_id: string;
  tenant: string;
  seed: string;
  pairs: Pair[];
  history: HistoryEntry[];
}

/** Store a cluster of the tenant; returns its id. */
export async function create(tenant: string, seed: string, pairs: Pair[], history: HistoryEntry[]): Promise<string> {
  const clusterId = \`c-\${await redis.incr('cluster:seq')}\`;
  await redis.hset(\`cluster:\${clusterId}\`, {cluster_id: clusterId, tenant, seed});
  for (const pair of pairs) await redis.rpush(\`cluster:\${clusterId}:pairs\`, JSON.stringify(pair));
  for (const entry of history) await redis.rpush(\`cluster:\${clusterId}:history\`, JSON.stringify(entry));
  return clusterId;
}

/** The cluster, or null: whichever tenant owns it. */
export async function load(clusterId: string): Promise<Cluster | null> {
  const raw = await redis.hgetall(\`cluster:\${clusterId}\`);
  if (Object.keys(raw).length === 0) return null;
  const pairs = (await redis.lrange(\`cluster:\${clusterId}:pairs\`, 0, -1)).map(p => JSON.parse(p) as Pair);
  const history = (await redis.lrange(\`cluster:\${clusterId}:history\`, 0, -1)).map(h => JSON.parse(h) as HistoryEntry);
  return {cluster_id: raw.cluster_id, tenant: raw.tenant, seed: raw.seed, pairs, history};
}
`,
};

export const supportModulesGo: Record<string, string> = {
  'dedupe/records/records.go': `// Package records is the durable record store (provided; Redis hashes stand in for the database): a
// record is the hash record:{record_id} with record_id, tenant, dataset_id, name, email and keys (a
// JSON object from key type to SHA-256 hex digest); records:{tenant} lists a tenant's record ids in
// creation order.
package records

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// Row is one record.
type Row struct {
	RecordID  string            \`json:"record_id"\`
	Tenant    string            \`json:"tenant"\`
	DatasetID string            \`json:"dataset_id"\`
	Name      string            \`json:"name"\`
	Email     string            \`json:"email"\`
	Keys      map[string]string \`json:"keys"\`
}

// Create stores a new record of the tenant and returns it.
func Create(ctx context.Context, tenant, datasetID, name, email string, keys map[string]string) (*Row, error) {
	n, err := rdb.Incr(ctx, "record:seq").Result()
	if err != nil {
		return nil, err
	}
	recordID := fmt.Sprintf("r-%d", n)
	raw, _ := json.Marshal(keys)
	fields := map[string]any{"record_id": recordID, "tenant": tenant, "dataset_id": datasetID, "name": name, "email": email, "keys": string(raw)}
	if err := rdb.HSet(ctx, "record:"+recordID, fields).Err(); err != nil {
		return nil, err
	}
	if err := rdb.RPush(ctx, "records:"+tenant, recordID).Err(); err != nil {
		return nil, err
	}
	return Get(ctx, recordID)
}

// Get is the record, or nil.
func Get(ctx context.Context, recordID string) (*Row, error) {
	raw, err := rdb.HGetAll(ctx, "record:"+recordID).Result()
	if err != nil || len(raw) == 0 {
		return nil, err
	}
	row := &Row{RecordID: raw["record_id"], Tenant: raw["tenant"], DatasetID: raw["dataset_id"], Name: raw["name"], Email: raw["email"]}
	if err := json.Unmarshal([]byte(raw["keys"]), &row.Keys); err != nil {
		return nil, err
	}
	return row, nil
}

// OfTenant is every record of the tenant, oldest first.
func OfTenant(ctx context.Context, tenant string) ([]*Row, error) {
	ids, err := rdb.LRange(ctx, "records:"+tenant, 0, -1).Result()
	if err != nil {
		return nil, err
	}
	rows := make([]*Row, 0, len(ids))
	for _, id := range ids {
		row, err := Get(ctx, id)
		if err != nil {
			return nil, err
		}
		rows = append(rows, row)
	}
	return rows, nil
}
`,
  'dedupe/exact/exact.go': `// Package exact is the exact-key index (provided; step 2 builds claim and lookup):
// t:{tenant}:exact:{key_type} is a hash from a key's SHA-256 hex digest to the id of the record that
// holds it. Claim inserts the key in one Lua script and reports whether the caller's record won it
// ("winner") or another record already holds it ("existing", with that record's id); Lookup reads
// it. LookupGlobal is the cross-tenant lookup the trust-and-safety batch job uses: it scans every
// tenant's index and answers the first holder.
package exact

import (
	"context"
	"sort"
	"strings"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// ClaimScript inserts ARGV[1] → ARGV[2] unless the key is held, and answers {outcome, holder}.
var ClaimScript = redis.NewScript(\`
if redis.call('HSETNX', KEYS[1], ARGV[1], ARGV[2]) == 1 then return {'winner', ARGV[2]} end
return {'existing', redis.call('HGET', KEYS[1], ARGV[1])}
\`)

// Result is what a claim answers: "winner" or "existing", and the id of the record holding the key.
type Result struct {
	Outcome  string \`json:"outcome"\`
	RecordID string \`json:"record_id"\`
}

// Hit is a holder found by LookupGlobal.
type Hit struct {
	Tenant   string \`json:"tenant"\`
	RecordID string \`json:"record_id"\`
}

// IndexKey is the tenant's index of one key type.
func IndexKey(tenant, keyType string) string {
	return "t:" + tenant + ":exact:" + keyType
}

// Claim inserts the key for recordID unless a record holds it.
func Claim(ctx context.Context, tenant, keyType, value, recordID string) (Result, error) {
	got, err := ClaimScript.Run(ctx, rdb, []string{IndexKey(tenant, keyType)}, value, recordID).StringSlice()
	if err != nil {
		return Result{}, err
	}
	return Result{Outcome: got[0], RecordID: got[1]}, nil
}

// Lookup is the id of the tenant's record holding the key, or "".
func Lookup(ctx context.Context, tenant, keyType, value string) (string, error) {
	holder, err := rdb.HGet(ctx, IndexKey(tenant, keyType), value).Result()
	if err == redis.Nil {
		return "", nil
	}
	return holder, err
}

// LookupGlobal is the first holder of the key in any tenant's index, or nil.
func LookupGlobal(ctx context.Context, keyType, value string) (*Hit, error) {
	keys, err := rdb.Keys(ctx, "t:*:exact:"+keyType).Result()
	if err != nil {
		return nil, err
	}
	sort.Strings(keys)
	for _, key := range keys {
		holder, err := rdb.HGet(ctx, key, value).Result()
		if err == redis.Nil {
			continue
		}
		if err != nil {
			return nil, err
		}
		return &Hit{Tenant: strings.Split(key, ":")[1], RecordID: holder}, nil
	}
	return nil, nil
}
`,
  'dedupe/outbox/outbox.go': `// Package outbox is the outbox (provided): the Redis list outbox of JSON rows {"topic", "key",
// "payload"} that a relay publishes later, oldest first.
package outbox

import (
	"context"
	"encoding/json"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// Row is one queued record.
type Row struct {
	Topic   string         \`json:"topic"\`
	Key     string         \`json:"key"\`
	Payload map[string]any \`json:"payload"\`
}

// Insert queues a record for the relay to publish later.
func Insert(ctx context.Context, topic, key string, payload map[string]any) error {
	row, err := json.Marshal(Row{Topic: topic, Key: key, Payload: payload})
	if err != nil {
		return err
	}
	return rdb.RPush(ctx, "outbox", row).Err()
}

// Rows is everything queued, oldest first.
func Rows(ctx context.Context) ([]Row, error) {
	raw, err := rdb.LRange(ctx, "outbox", 0, -1).Result()
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
  'dedupe/clusters/clusters.go': `// Package clusters is the cluster store (provided): cluster:{cluster_id} is a hash with cluster_id,
// tenant and seed (the record the cluster grew from); cluster:{cluster_id}:pairs lists the candidate
// pairs the matcher scored, each JSON {"a", "b", "score", "key_type"} (key_type is the exact key
// that matched, or "fuzzy"); cluster:{cluster_id}:history lists the merge actions, each JSON {"at",
// "action", "a", "b", "by"}, oldest first.
package clusters

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// Pair is a candidate pair the matcher scored.
type Pair struct {
	A       string  \`json:"a"\`
	B       string  \`json:"b"\`
	Score   float64 \`json:"score"\`
	KeyType string  \`json:"key_type"\`
}

// HistoryEntry is one merge action.
type HistoryEntry struct {
	At     string \`json:"at"\`
	Action string \`json:"action"\`
	A      string \`json:"a"\`
	B      string \`json:"b"\`
	By     string \`json:"by"\`
}

// Cluster is a stored cluster, whichever tenant owns it.
type Cluster struct {
	ClusterID string         \`json:"cluster_id"\`
	Tenant    string         \`json:"tenant"\`
	Seed      string         \`json:"seed"\`
	Pairs     []Pair         \`json:"pairs"\`
	History   []HistoryEntry \`json:"history"\`
}

// Create stores a cluster of the tenant and returns its id.
func Create(ctx context.Context, tenant, seed string, pairs []Pair, history []HistoryEntry) (string, error) {
	n, err := rdb.Incr(ctx, "cluster:seq").Result()
	if err != nil {
		return "", err
	}
	clusterID := fmt.Sprintf("c-%d", n)
	if err := rdb.HSet(ctx, "cluster:"+clusterID, map[string]any{"cluster_id": clusterID, "tenant": tenant, "seed": seed}).Err(); err != nil {
		return "", err
	}
	for _, pair := range pairs {
		raw, _ := json.Marshal(pair)
		rdb.RPush(ctx, "cluster:"+clusterID+":pairs", raw)
	}
	for _, entry := range history {
		raw, _ := json.Marshal(entry)
		rdb.RPush(ctx, "cluster:"+clusterID+":history", raw)
	}
	return clusterID, nil
}

// Load is the cluster, or nil.
func Load(ctx context.Context, clusterID string) (*Cluster, error) {
	raw, err := rdb.HGetAll(ctx, "cluster:"+clusterID).Result()
	if err != nil || len(raw) == 0 {
		return nil, err
	}
	c := &Cluster{ClusterID: raw["cluster_id"], Tenant: raw["tenant"], Seed: raw["seed"], Pairs: []Pair{}, History: []HistoryEntry{}}
	for _, text := range rdb.LRange(ctx, "cluster:"+clusterID+":pairs", 0, -1).Val() {
		var pair Pair
		json.Unmarshal([]byte(text), &pair)
		c.Pairs = append(c.Pairs, pair)
	}
	for _, text := range rdb.LRange(ctx, "cluster:"+clusterID+":history", 0, -1).Val() {
		var entry HistoryEntry
		json.Unmarshal([]byte(text), &entry)
		c.History = append(c.History, entry)
	}
	return c, nil
}
`,
};

export const supportModulesCpp: Record<string, string> = {
  'dedupe/records.h': `// The durable record store (provided; Redis hashes stand in for the database): a record is the hash
// record:{record_id} with record_id, tenant, dataset_id, name, email and keys (a JSON object from key
// type to SHA-256 hex digest); records:{tenant} lists a tenant's record ids in creation order.
#pragma once

#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <map>
#include <optional>
#include <string>
#include <unordered_map>
#include <vector>

namespace records {

struct Row {
  std::string record_id;
  std::string tenant;
  std::string dataset_id;
  std::string name;
  std::string email;
  std::map<std::string, std::string> keys;
};

inline sw::redis::Redis& redis() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

// The record, if it exists.
inline std::optional<Row> get(const std::string& record_id) {
  const std::unordered_map<std::string, std::string> raw = redis().hgetall("record:" + record_id);
  if (raw.empty()) return std::nullopt;
  Row row{raw.at("record_id"), raw.at("tenant"), raw.at("dataset_id"), raw.at("name"), raw.at("email"), {}};
  row.keys = nlohmann::json::parse(raw.at("keys")).get<std::map<std::string, std::string>>();
  return row;
}

// A new record of the tenant; returns it.
inline Row create(const std::string& tenant, const std::string& dataset_id, const std::string& name, const std::string& email,
                  const std::map<std::string, std::string>& keys) {
  const std::string record_id = "r-" + std::to_string(redis().incr("record:seq"));
  redis().hset("record:" + record_id, "record_id", record_id, "tenant", tenant, "dataset_id", dataset_id, "name", name, "email", email,
               "keys", nlohmann::json(keys).dump());
  redis().rpush("records:" + tenant, record_id);
  return *get(record_id);
}

// Every record of the tenant, oldest first.
inline std::vector<Row> ofTenant(const std::string& tenant) {
  std::vector<Row> rows;
  for (const std::string& id : redis().lrange("records:" + tenant, 0, -1)) rows.push_back(*get(id));
  return rows;
}

}  // namespace records
`,
  'dedupe/exact.h': `// The exact-key index (provided; step 2 builds claim and lookup): t:{tenant}:exact:{key_type} is a
// hash from a key's SHA-256 hex digest to the id of the record that holds it. claim inserts the key
// in one Lua script and reports whether the caller's record won it ("winner") or another record
// already holds it ("existing", with that record's id); lookup reads it. lookupGlobal is the
// cross-tenant lookup the trust-and-safety batch job uses: it scans every tenant's index and
// answers the first holder.
#pragma once

#include <sw/redis++/redis++.h>

#include <algorithm>
#include <iterator>
#include <optional>
#include <string>
#include <vector>

namespace exact {

struct Result {
  std::string outcome;
  std::string record_id;
};

struct Hit {
  std::string tenant;
  std::string record_id;
};

inline const std::string kClaimLua = R"lua(
if redis.call('HSETNX', KEYS[1], ARGV[1], ARGV[2]) == 1 then return {'winner', ARGV[2]} end
return {'existing', redis.call('HGET', KEYS[1], ARGV[1])}
)lua";

inline sw::redis::Redis& redis() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

inline std::string indexKey(const std::string& tenant, const std::string& key_type) { return "t:" + tenant + ":exact:" + key_type; }

// Insert the key for record_id unless a record holds it: the outcome and the holder's id.
inline Result claim(const std::string& tenant, const std::string& key_type, const std::string& value, const std::string& record_id) {
  std::vector<std::string> got;
  redis().eval(kClaimLua, {indexKey(tenant, key_type)}, {value, record_id}, std::back_inserter(got));
  return Result{got.at(0), got.at(1)};
}

// The id of the tenant's record holding the key, if any.
inline std::optional<std::string> lookup(const std::string& tenant, const std::string& key_type, const std::string& value) {
  const auto holder = redis().hget(indexKey(tenant, key_type), value);
  if (!holder) return std::nullopt;
  return std::string(*holder);
}

// The first holder of the key in any tenant's index, if any.
inline std::optional<Hit> lookupGlobal(const std::string& key_type, const std::string& value) {
  std::vector<std::string> keys;
  redis().keys("t:*:exact:" + key_type, std::back_inserter(keys));
  std::sort(keys.begin(), keys.end());
  for (const std::string& key : keys) {
    const auto holder = redis().hget(key, value);
    if (!holder) continue;
    const std::size_t first = key.find(':');
    const std::size_t second = key.find(':', first + 1);
    return Hit{key.substr(first + 1, second - first - 1), std::string(*holder)};
  }
  return std::nullopt;
}

}  // namespace exact
`,
  'dedupe/outbox.h': `// The outbox (provided): the Redis list outbox of JSON rows {"topic", "key", "payload"} that a relay
// publishes later, oldest first.
#pragma once

#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <string>
#include <vector>

namespace outbox {

inline sw::redis::Redis& redis() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

// Queue a record for the relay to publish later.
inline void insert(const std::string& topic, const std::string& key, const nlohmann::json& payload) {
  redis().rpush("outbox", nlohmann::json{{"topic", topic}, {"key", key}, {"payload", payload}}.dump());
}

// Everything queued, oldest first.
inline std::vector<nlohmann::json> rows() {
  std::vector<nlohmann::json> out;
  for (const std::string& row : redis().lrange("outbox", 0, -1)) out.push_back(nlohmann::json::parse(row));
  return out;
}

}  // namespace outbox
`,
  'dedupe/clusters.h': `// The cluster store (provided): cluster:{cluster_id} is a hash with cluster_id, tenant and seed (the
// record the cluster grew from); cluster:{cluster_id}:pairs lists the candidate pairs the matcher
// scored, each JSON {"a", "b", "score", "key_type"} (key_type is the exact key that matched, or
// "fuzzy"); cluster:{cluster_id}:history lists the merge actions, each JSON {"at", "action", "a",
// "b", "by"}, oldest first.
#pragma once

#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <optional>
#include <string>
#include <unordered_map>
#include <vector>

namespace clusters {

struct Cluster {
  std::string cluster_id;
  std::string tenant;
  std::string seed;
  std::vector<nlohmann::json> pairs;
  std::vector<nlohmann::json> history;
};

inline sw::redis::Redis& redis() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

// Store a cluster of the tenant; returns its id.
inline std::string create(const std::string& tenant, const std::string& seed, const std::vector<nlohmann::json>& pairs,
                          const std::vector<nlohmann::json>& history) {
  const std::string cluster_id = "c-" + std::to_string(redis().incr("cluster:seq"));
  redis().hset("cluster:" + cluster_id, "cluster_id", cluster_id, "tenant", tenant, "seed", seed);
  for (const auto& pair : pairs) redis().rpush("cluster:" + cluster_id + ":pairs", pair.dump());
  for (const auto& entry : history) redis().rpush("cluster:" + cluster_id + ":history", entry.dump());
  return cluster_id;
}

// The cluster, whichever tenant owns it, if it exists.
inline std::optional<Cluster> load(const std::string& cluster_id) {
  const std::unordered_map<std::string, std::string> raw = redis().hgetall("cluster:" + cluster_id);
  if (raw.empty()) return std::nullopt;
  Cluster c{raw.at("cluster_id"), raw.at("tenant"), raw.at("seed"), {}, {}};
  for (const std::string& text : redis().lrange("cluster:" + cluster_id + ":pairs", 0, -1)) c.pairs.push_back(nlohmann::json::parse(text));
  for (const std::string& text : redis().lrange("cluster:" + cluster_id + ":history", 0, -1)) c.history.push_back(nlohmann::json::parse(text));
  return c;
}

}  // namespace clusters
`,
};

export const supportModulesScala: Record<string, string> = {
  [scalaPath('dedupe', 'Records')]: `package dedupe

import redis.clients.jedis.JedisPooled
import spray.json._
import spray.json.DefaultJsonProtocol._

import scala.jdk.CollectionConverters._

/**
 * The durable record store (provided; Redis hashes stand in for the database): a record is the hash
 * record:{record_id} with record_id, tenant, dataset_id, name, email and keys (a JSON object from
 * key type to SHA-256 hex digest); records:{tenant} lists a tenant's record ids in creation order.
 */
object Records {
  final case class Row(recordId: String, tenant: String, datasetId: String, name: String, email: String, keys: Map[String, String])

  val jedis = new JedisPooled("redis", 6379)

  /** The record, if it exists. */
  def get(recordId: String): Option[Row] = {
    val raw = jedis.hgetAll(s"record:$recordId").asScala.toMap
    if (raw.isEmpty) None
    else Some(Row(raw("record_id"), raw("tenant"), raw("dataset_id"), raw("name"), raw("email"), raw("keys").parseJson.convertTo[Map[String, String]]))
  }

  /** A new record of the tenant; returns it. */
  def create(tenant: String, datasetId: String, name: String, email: String, keys: Map[String, String]): Row = {
    val recordId = s"r-\${jedis.incr("record:seq")}"
    val sorted = JsObject(keys.toSeq.sortBy(_._1).map { case (k, v) => k -> JsString(v) }: _*)
    jedis.hset(s"record:$recordId", Map("record_id" -> recordId, "tenant" -> tenant, "dataset_id" -> datasetId, "name" -> name, "email" -> email, "keys" -> sorted.compactPrint).asJava)
    jedis.rpush(s"records:$tenant", recordId)
    get(recordId).get
  }

  /** Every record of the tenant, oldest first. */
  def ofTenant(tenant: String): Seq[Row] = jedis.lrange(s"records:$tenant", 0, -1).asScala.toSeq.flatMap(get)
}
`,
  [scalaPath('dedupe', 'Exact')]: `package dedupe

import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

/**
 * The exact-key index (provided; step 2 builds claim and lookup): t:{tenant}:exact:{key_type} is a
 * hash from a key's SHA-256 hex digest to the id of the record that holds it. claim inserts the key
 * in one Lua script and reports whether the caller's record won it ("winner") or another record
 * already holds it ("existing", with that record's id); lookup reads it. lookupGlobal is the
 * cross-tenant lookup the trust-and-safety batch job uses: it scans every tenant's index and
 * answers the first holder.
 */
object Exact {
  final case class Result(outcome: String, recordId: String)
  final case class Hit(tenant: String, recordId: String)

  val jedis = new JedisPooled("redis", 6379)

  val ClaimLua: String =
    """if redis.call('HSETNX', KEYS[1], ARGV[1], ARGV[2]) == 1 then return {'winner', ARGV[2]} end
      |return {'existing', redis.call('HGET', KEYS[1], ARGV[1])}
      |""".stripMargin

  def indexKey(tenant: String, keyType: String): String = s"t:$tenant:exact:$keyType"

  /** Insert the key for recordId unless a record holds it: the outcome and the holder's id. */
  def claim(tenant: String, keyType: String, value: String, recordId: String): Result = {
    val got = jedis.eval(ClaimLua, List(indexKey(tenant, keyType)).asJava, List(value, recordId).asJava).asInstanceOf[java.util.List[String]]
    Result(got.get(0), got.get(1))
  }

  /** The id of the tenant's record holding the key, if any. */
  def lookup(tenant: String, keyType: String, value: String): Option[String] = Option(jedis.hget(indexKey(tenant, keyType), value))

  /** The first holder of the key in any tenant's index, if any. */
  def lookupGlobal(keyType: String, value: String): Option[Hit] =
    jedis.keys(s"t:*:exact:$keyType").asScala.toSeq.sorted.iterator
      .flatMap(key => Option(jedis.hget(key, value)).map(holder => Hit(key.split(":")(1), holder)))
      .nextOption()
}
`,
  [scalaPath('dedupe', 'Outbox')]: `package dedupe

import redis.clients.jedis.JedisPooled
import spray.json._

import scala.jdk.CollectionConverters._

/**
 * The outbox (provided): the Redis list outbox of JSON rows {"topic", "key", "payload"} that a relay
 * publishes later, oldest first.
 */
object Outbox {
  val jedis = new JedisPooled("redis", 6379)

  /** Queue a record for the relay to publish later. */
  def insert(topic: String, key: String, payload: JsObject): Unit =
    jedis.rpush("outbox", JsObject("topic" -> JsString(topic), "key" -> JsString(key), "payload" -> payload).compactPrint)

  /** Everything queued, oldest first. */
  def rows(): Seq[JsObject] = jedis.lrange("outbox", 0, -1).asScala.toSeq.map(_.parseJson.asJsObject)
}
`,
  [scalaPath('dedupe', 'Clusters')]: `package dedupe

import redis.clients.jedis.JedisPooled
import spray.json._

import scala.jdk.CollectionConverters._

/**
 * The cluster store (provided): cluster:{cluster_id} is a hash with cluster_id, tenant and seed (the
 * record the cluster grew from); cluster:{cluster_id}:pairs lists the candidate pairs the matcher
 * scored, each JSON {"a", "b", "score", "key_type"} (key_type is the exact key that matched, or
 * "fuzzy"); cluster:{cluster_id}:history lists the merge actions, each JSON {"at", "action", "a",
 * "b", "by"}, oldest first.
 */
object Clusters {
  final case class Cluster(clusterId: String, tenant: String, seed: String, pairs: Seq[JsObject], history: Seq[JsObject])

  val jedis = new JedisPooled("redis", 6379)

  /** Store a cluster of the tenant; returns its id. */
  def create(tenant: String, seed: String, pairs: Seq[JsObject], history: Seq[JsObject]): String = {
    val clusterId = s"c-\${jedis.incr("cluster:seq")}"
    jedis.hset(s"cluster:$clusterId", Map("cluster_id" -> clusterId, "tenant" -> tenant, "seed" -> seed).asJava)
    pairs.foreach(pair => jedis.rpush(s"cluster:$clusterId:pairs", pair.compactPrint))
    history.foreach(entry => jedis.rpush(s"cluster:$clusterId:history", entry.compactPrint))
    clusterId
  }

  /** The cluster, whichever tenant owns it, if it exists. */
  def load(clusterId: String): Option[Cluster] = {
    val raw = jedis.hgetAll(s"cluster:$clusterId").asScala.toMap
    if (raw.isEmpty) None
    else {
      def list(suffix: String): Seq[JsObject] = jedis.lrange(s"cluster:$clusterId:$suffix", 0, -1).asScala.toSeq.map(_.parseJson.asJsObject)
      Some(Cluster(raw("cluster_id"), raw("tenant"), raw("seed"), list("pairs"), list("history")))
    }
  }
}
`,
};
