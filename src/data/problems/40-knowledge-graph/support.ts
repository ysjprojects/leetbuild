/**
 * Hand-written support modules the knowledge-graph steps import but no step builds: the `graph`
 * package. `graph.store` is the graph store (entities, aliases and edges in Redis, the course's
 * stand-in for the graph database), with the idempotency records, the review queue and the outbox.
 * `graph.adjacency` is the versioned adjacency cache of step 2 as later steps use it:
 * `read_neighbors` and `apply_edge`. The five languages keep the same keys, so a harness reads one
 * layout whatever the stack.
 */
import {scalaPath} from '../scala-support';

export const supportModules: Record<string, string> = {
  'graph/__init__.py': '',
  'graph/store.py': `"""
The graph store (provided): entity:{id} is a hash (id, tenant, type, name, version, merged_into),
entity:{id}:aliases the entity's aliases, alias:{tenant}:{alias} the entity that claims an alias in
a tenant, edges:{id} the entity's neighbour ids (an edge is stored on both ends). Entity ids are
global (e-1, e-2, ...); aliases are compared trimmed and lower-cased. idem:{tenant}:{key} records
what an upsert answered (24 h); review:{tenant} is the review queue of pairs nobody may merge yet;
outbox holds the events the broker did not take. Every change to an entity bumps its version; a
merge bumps adj:{id}:version for every entity whose neighbour list it changed, as the adjacency
cache (step 2) expects of every edge change.
"""
import json

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

IDEM_TTL_S = 86400


def normalize(alias: str) -> str:
    return alias.strip().lower()


def get_entity(entity_id: str) -> dict | None:
    """The entity (id, tenant, type, name, aliases, version, merged_into), or None."""
    raw = r.hgetall(f"entity:{entity_id}")
    if not raw:
        return None
    return {
        "id": raw["id"],
        "tenant": raw["tenant"],
        "type": raw["type"],
        "name": raw["name"],
        "aliases": sorted(r.smembers(f"entity:{entity_id}:aliases")),
        "version": int(raw["version"]),
        "merged_into": raw.get("merged_into") or None,
    }


def _claim(tenant: str, entity_id: str, aliases: list[str]) -> None:
    for alias in aliases:
        alias = normalize(alias)
        if alias:
            r.sadd(f"entity:{entity_id}:aliases", alias)
            r.set(f"alias:{tenant}:{alias}", entity_id)


def create_entity(tenant: str, entity_type: str, name: str, aliases: list[str]) -> dict:
    """A new entity of the tenant at version 1, claiming its aliases."""
    entity_id = f"e-{r.incr('entity:seq')}"
    r.hset(
        f"entity:{entity_id}",
        mapping={"id": entity_id, "tenant": tenant, "type": entity_type, "name": name, "version": 1, "merged_into": ""},
    )
    _claim(tenant, entity_id, aliases)
    return get_entity(entity_id)


def find_alias(tenant: str, alias: str) -> dict | None:
    """The entity of the tenant that claims the alias, or None."""
    entity_id = r.get(f"alias:{tenant}:{normalize(alias)}")
    return get_entity(entity_id) if entity_id else None


def add_aliases(entity_id: str, aliases: list[str]) -> dict:
    """Claims more aliases for an existing entity; raises KeyError for an unknown id."""
    entity = get_entity(entity_id)
    if entity is None:
        raise KeyError(entity_id)
    _claim(entity["tenant"], entity_id, aliases)
    r.hincrby(f"entity:{entity_id}", "version", 1)
    return get_entity(entity_id)


def add_edge(left: str, right: str) -> None:
    """Stores the edge on both ends."""
    r.sadd(f"edges:{left}", right)
    r.sadd(f"edges:{right}", left)


def neighbors(entity_id: str) -> list[str]:
    """The entity's neighbour ids, sorted: the graph store's answer, never cached."""
    return sorted(r.smembers(f"edges:{entity_id}"))


def merge(survivor: str, absorbed: str) -> dict:
    """Folds absorbed into survivor: its aliases and edges move, it keeps merged_into as a redirect."""
    target = get_entity(survivor)
    gone = get_entity(absorbed)
    if target is None or gone is None:
        raise KeyError(survivor if target is None else absorbed)
    _claim(target["tenant"], survivor, gone["aliases"])
    changed = [survivor, absorbed]
    for n in neighbors(absorbed):
        r.srem(f"edges:{n}", absorbed)
        if n != survivor:
            r.sadd(f"edges:{n}", survivor)
            r.sadd(f"edges:{survivor}", n)
            changed.append(n)
    r.delete(f"edges:{absorbed}")
    r.hset(f"entity:{absorbed}", "merged_into", survivor)
    r.hincrby(f"entity:{survivor}", "version", 1)
    for entity_id in changed:
        r.incr(f"adj:{entity_id}:version")
    return get_entity(survivor)


def rename(entity_id: str, new_name: str) -> dict:
    """Commits a new name; returns entity_id, old_name, new_name and the new version. KeyError for an unknown id."""
    old_name = r.hget(f"entity:{entity_id}", "name")
    if old_name is None:
        raise KeyError(entity_id)
    r.hset(f"entity:{entity_id}", "name", new_name)
    version = r.hincrby(f"entity:{entity_id}", "version", 1)
    return {"entity_id": entity_id, "old_name": old_name, "new_name": new_name, "version": version}


def idem_result(tenant: str, key: str) -> dict | None:
    """What the upsert (tenant, key) answered: {"status", "body"}, or None."""
    raw = r.get(f"idem:{tenant}:{key}")
    return json.loads(raw) if raw else None


def record_idem(tenant: str, key: str, status: int, body: dict) -> None:
    """Records what the upsert (tenant, key) answered, for its replays."""
    r.set(f"idem:{tenant}:{key}", json.dumps({"status": status, "body": body}), ex=IDEM_TTL_S)


def park(tenant: str, left: str, right: str, reason: str, score: float | None = None) -> None:
    """Puts a pair on the tenant's review queue: an operator decides, nobody merges it meanwhile."""
    r.rpush(f"review:{tenant}", json.dumps({"left": left, "right": right, "reason": reason, "score": score}))


def insert_outbox(topic: str, key: str, payload: dict) -> None:
    """Keeps an event the broker did not take; a relay produces it later."""
    r.rpush("outbox", json.dumps({"topic": topic, "key": key, "payload": payload}))
`,
  'graph/adjacency.py': `"""
The adjacency cache (provided; step 2 builds the same two functions): adj:{id} holds an entity's
neighbour ids as JSON {"version", "neighbors"} for 5 minutes, stamped with the value adj:{id}:version
had before the neighbours were loaded. An edge change bumps the version of both ends instead of
deleting entries, so an entry filled from a list that was already stale can never be served.
"""
import json

import redis

from graph import store

r = redis.Redis(host="redis", port=6379, decode_responses=True)

TTL_S = 300


def adj_key(entity_id: str) -> str:
    return f"adj:{entity_id}"


def version_key(entity_id: str) -> str:
    return f"adj:{entity_id}:version"


def read_neighbors(entity_id: str) -> list[str]:
    """The entity's neighbour ids, sorted, through the cache."""
    version = int(r.get(version_key(entity_id)) or 0)
    raw = r.get(adj_key(entity_id))
    if raw is not None:
        entry = json.loads(raw)
        if entry.get("version") == version:
            return entry["neighbors"]
    found = store.neighbors(entity_id)
    r.set(adj_key(entity_id), json.dumps({"version": version, "neighbors": found}), ex=TTL_S)
    return found


def apply_edge(left: str, right: str) -> None:
    """Stores the edge, then makes every cached list of both ends unreachable."""
    store.add_edge(left, right)
    r.incr(version_key(left))
    r.incr(version_key(right))
`,
};

export const supportModulesTs: Record<string, string> = {
  'graph/store.ts': `/**
 * The graph store (provided): entity:{id} is a hash (id, tenant, type, name, version, merged_into),
 * entity:{id}:aliases the entity's aliases, alias:{tenant}:{alias} the entity that claims an alias
 * in a tenant, edges:{id} the entity's neighbour ids (an edge is stored on both ends). Entity ids
 * are global (e-1, e-2, ...); aliases are compared trimmed and lower-cased. idem:{tenant}:{key}
 * records what an upsert answered (24 h); review:{tenant} is the review queue of pairs nobody may
 * merge yet; outbox holds the events the broker did not take. Every change to an entity bumps its
 * version; a merge bumps adj:{id}:version for every entity whose neighbour list it changed, as the
 * adjacency cache (step 2) expects of every edge change.
 */
import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

export const IDEM_TTL_S = 86400;

export interface Entity {
  id: string;
  tenant: string;
  type: string;
  name: string;
  aliases: string[];
  version: number;
  merged_into: string | null;
}

export interface Renamed {
  entity_id: string;
  old_name: string;
  new_name: string;
  version: number;
}

export interface Recorded {
  status: number;
  body: Record<string, unknown>;
}

export const normalize = (alias: string): string => alias.trim().toLowerCase();

/** The entity, or null. */
export async function getEntity(entityId: string): Promise<Entity | null> {
  const raw = await redis.hgetall(\`entity:\${entityId}\`);
  if (Object.keys(raw).length === 0) return null;
  const aliases = (await redis.smembers(\`entity:\${entityId}:aliases\`)).sort();
  return {
    id: raw.id,
    tenant: raw.tenant,
    type: raw.type,
    name: raw.name,
    aliases,
    version: Number(raw.version),
    merged_into: raw.merged_into ? raw.merged_into : null,
  };
}

async function claim(tenant: string, entityId: string, aliases: string[]): Promise<void> {
  for (const alias of aliases.map(normalize)) {
    if (alias === '') continue;
    await redis.sadd(\`entity:\${entityId}:aliases\`, alias);
    await redis.set(\`alias:\${tenant}:\${alias}\`, entityId);
  }
}

/** A new entity of the tenant at version 1, claiming its aliases. */
export async function createEntity(tenant: string, entityType: string, name: string, aliases: string[]): Promise<Entity> {
  const entityId = \`e-\${await redis.incr('entity:seq')}\`;
  await redis.hset(\`entity:\${entityId}\`, {id: entityId, tenant, type: entityType, name, version: '1', merged_into: ''});
  await claim(tenant, entityId, aliases);
  return (await getEntity(entityId)) as Entity;
}

/** The entity of the tenant that claims the alias, or null. */
export async function findAlias(tenant: string, alias: string): Promise<Entity | null> {
  const entityId = await redis.get(\`alias:\${tenant}:\${normalize(alias)}\`);
  return entityId ? getEntity(entityId) : null;
}

/** Claims more aliases for an existing entity; throws for an unknown id. */
export async function addAliases(entityId: string, aliases: string[]): Promise<Entity> {
  const entity = await getEntity(entityId);
  if (entity === null) throw new Error(\`no entity \${entityId}\`);
  await claim(entity.tenant, entityId, aliases);
  await redis.hincrby(\`entity:\${entityId}\`, 'version', 1);
  return (await getEntity(entityId)) as Entity;
}

/** Stores the edge on both ends. */
export async function addEdge(left: string, right: string): Promise<void> {
  await redis.sadd(\`edges:\${left}\`, right);
  await redis.sadd(\`edges:\${right}\`, left);
}

/** The entity's neighbour ids, sorted: the graph store's answer, never cached. */
export async function neighbors(entityId: string): Promise<string[]> {
  return (await redis.smembers(\`edges:\${entityId}\`)).sort();
}

/** Folds absorbed into survivor: its aliases and edges move, it keeps merged_into as a redirect. */
export async function merge(survivor: string, absorbed: string): Promise<Entity> {
  const target = await getEntity(survivor);
  const gone = await getEntity(absorbed);
  if (target === null || gone === null) throw new Error(\`no entity \${target === null ? survivor : absorbed}\`);
  await claim(target.tenant, survivor, gone.aliases);
  const changed = [survivor, absorbed];
  for (const n of await neighbors(absorbed)) {
    await redis.srem(\`edges:\${n}\`, absorbed);
    if (n === survivor) continue;
    await redis.sadd(\`edges:\${n}\`, survivor);
    await redis.sadd(\`edges:\${survivor}\`, n);
    changed.push(n);
  }
  await redis.del(\`edges:\${absorbed}\`);
  await redis.hset(\`entity:\${absorbed}\`, 'merged_into', survivor);
  await redis.hincrby(\`entity:\${survivor}\`, 'version', 1);
  for (const entityId of changed) await redis.incr(\`adj:\${entityId}:version\`);
  return (await getEntity(survivor)) as Entity;
}

/** Commits a new name; returns entity_id, old_name, new_name and the new version. Throws for an unknown id. */
export async function rename(entityId: string, newName: string): Promise<Renamed> {
  const oldName = await redis.hget(\`entity:\${entityId}\`, 'name');
  if (oldName === null) throw new Error(\`no entity \${entityId}\`);
  await redis.hset(\`entity:\${entityId}\`, 'name', newName);
  const version = await redis.hincrby(\`entity:\${entityId}\`, 'version', 1);
  return {entity_id: entityId, old_name: oldName, new_name: newName, version: Number(version)};
}

/** What the upsert (tenant, key) answered, or null. */
export async function idemResult(tenant: string, key: string): Promise<Recorded | null> {
  const raw = await redis.get(\`idem:\${tenant}:\${key}\`);
  return raw ? (JSON.parse(raw) as Recorded) : null;
}

/** Records what the upsert (tenant, key) answered, for its replays. */
export async function recordIdem(tenant: string, key: string, status: number, body: Record<string, unknown>): Promise<void> {
  await redis.set(\`idem:\${tenant}:\${key}\`, JSON.stringify({status, body}), 'EX', IDEM_TTL_S);
}

/** Puts a pair on the tenant's review queue: an operator decides, nobody merges it meanwhile. */
export async function park(tenant: string, left: string, right: string, reason: string, score: number | null = null): Promise<void> {
  await redis.rpush(\`review:\${tenant}\`, JSON.stringify({left, right, reason, score}));
}

/** Keeps an event the broker did not take; a relay produces it later. */
export async function insertOutbox(topic: string, key: string, payload: Record<string, unknown>): Promise<void> {
  await redis.rpush('outbox', JSON.stringify({topic, key, payload}));
}
`,
  'graph/adjacency.ts': `/**
 * The adjacency cache (provided; step 2 builds the same two functions): adj:{id} holds an entity's
 * neighbour ids as JSON {"version", "neighbors"} for 5 minutes, stamped with the value
 * adj:{id}:version had before the neighbours were loaded. An edge change bumps the version of both
 * ends instead of deleting entries, so an entry filled from a list that was already stale can never
 * be served.
 */
import Redis from 'ioredis';

import {addEdge, neighbors} from './store';

const redis = new Redis({host: 'redis', port: 6379});

export const TTL_S = 300;

export const adjKey = (entityId: string): string => \`adj:\${entityId}\`;
export const versionKey = (entityId: string): string => \`adj:\${entityId}:version\`;

/** The entity's neighbour ids, sorted, through the cache. */
export async function readNeighbors(entityId: string): Promise<string[]> {
  const version = Number((await redis.get(versionKey(entityId))) ?? 0);
  const raw = await redis.get(adjKey(entityId));
  if (raw !== null) {
    const entry = JSON.parse(raw) as {version: number; neighbors: string[]};
    if (entry.version === version) return entry.neighbors;
  }
  const found = await neighbors(entityId);
  await redis.set(adjKey(entityId), JSON.stringify({version, neighbors: found}), 'EX', TTL_S);
  return found;
}

/** Stores the edge, then makes every cached list of both ends unreachable. */
export async function applyEdge(left: string, right: string): Promise<void> {
  await addEdge(left, right);
  await redis.incr(versionKey(left));
  await redis.incr(versionKey(right));
}
`,
};

export const supportModulesGo: Record<string, string> = {
  'graph/store/store.go': `// Package store is the graph store (provided): entity:{id} is a hash (id, tenant, type, name,
// version, merged_into), entity:{id}:aliases the entity's aliases, alias:{tenant}:{alias} the
// entity that claims an alias in a tenant, edges:{id} the entity's neighbour ids (an edge is stored
// on both ends). Entity ids are global (e-1, e-2, ...); aliases are compared trimmed and
// lower-cased. idem:{tenant}:{key} records what an upsert answered (24 h); review:{tenant} is the
// review queue of pairs nobody may merge yet; outbox holds the events the broker did not take.
// Every change to an entity bumps its version; a merge bumps adj:{id}:version for every entity
// whose neighbour list it changed, as the adjacency cache (step 2) expects of every edge change.
package store

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const idemTTL = 24 * time.Hour

// Entity is one node of a tenant's graph.
type Entity struct {
	ID         string   \`json:"id"\`
	Tenant     string   \`json:"tenant"\`
	Type       string   \`json:"type"\`
	Name       string   \`json:"name"\`
	Aliases    []string \`json:"aliases"\`
	Version    int      \`json:"version"\`
	MergedInto string   \`json:"merged_into"\`
}

// Renamed is what a committed rename changed.
type Renamed struct {
	EntityID string \`json:"entity_id"\`
	OldName  string \`json:"old_name"\`
	NewName  string \`json:"new_name"\`
	Version  int    \`json:"version"\`
}

// Recorded is what an upsert answered: its status and its body.
type Recorded struct {
	Status int            \`json:"status"\`
	Body   map[string]any \`json:"body"\`
}

// Normalize is the form aliases are compared in: trimmed, lower-cased.
func Normalize(alias string) string { return strings.ToLower(strings.TrimSpace(alias)) }

// GetEntity is the entity, or nil.
func GetEntity(ctx context.Context, entityID string) *Entity {
	raw := rdb.HGetAll(ctx, "entity:"+entityID).Val()
	if len(raw) == 0 {
		return nil
	}
	aliases := append([]string{}, rdb.SMembers(ctx, "entity:"+entityID+":aliases").Val()...)
	sort.Strings(aliases)
	version, _ := strconv.Atoi(raw["version"])
	return &Entity{ID: raw["id"], Tenant: raw["tenant"], Type: raw["type"], Name: raw["name"], Aliases: aliases, Version: version, MergedInto: raw["merged_into"]}
}

func claim(ctx context.Context, tenant, entityID string, aliases []string) {
	for _, alias := range aliases {
		alias = Normalize(alias)
		if alias == "" {
			continue
		}
		rdb.SAdd(ctx, "entity:"+entityID+":aliases", alias)
		rdb.Set(ctx, "alias:"+tenant+":"+alias, entityID, 0)
	}
}

// CreateEntity makes a new entity of the tenant at version 1, claiming its aliases.
func CreateEntity(ctx context.Context, tenant, entityType, name string, aliases []string) *Entity {
	entityID := fmt.Sprintf("e-%d", rdb.Incr(ctx, "entity:seq").Val())
	rdb.HSet(ctx, "entity:"+entityID, map[string]any{"id": entityID, "tenant": tenant, "type": entityType, "name": name, "version": "1", "merged_into": ""})
	claim(ctx, tenant, entityID, aliases)
	return GetEntity(ctx, entityID)
}

// FindAlias is the entity of the tenant that claims the alias, or nil.
func FindAlias(ctx context.Context, tenant, alias string) *Entity {
	entityID, err := rdb.Get(ctx, "alias:"+tenant+":"+Normalize(alias)).Result()
	if err != nil {
		return nil
	}
	return GetEntity(ctx, entityID)
}

// AddAliases claims more aliases for an existing entity.
func AddAliases(ctx context.Context, entityID string, aliases []string) (*Entity, error) {
	entity := GetEntity(ctx, entityID)
	if entity == nil {
		return nil, fmt.Errorf("no entity %s", entityID)
	}
	claim(ctx, entity.Tenant, entityID, aliases)
	rdb.HIncrBy(ctx, "entity:"+entityID, "version", 1)
	return GetEntity(ctx, entityID), nil
}

// AddEdge stores the edge on both ends.
func AddEdge(ctx context.Context, left, right string) {
	rdb.SAdd(ctx, "edges:"+left, right)
	rdb.SAdd(ctx, "edges:"+right, left)
}

// Neighbors is the entity's neighbour ids, sorted: the graph store's answer, never cached.
func Neighbors(ctx context.Context, entityID string) []string {
	ids := append([]string{}, rdb.SMembers(ctx, "edges:"+entityID).Val()...)
	sort.Strings(ids)
	return ids
}

// Merge folds absorbed into survivor: its aliases and edges move, it keeps merged_into as a redirect.
func Merge(ctx context.Context, survivor, absorbed string) (*Entity, error) {
	target := GetEntity(ctx, survivor)
	gone := GetEntity(ctx, absorbed)
	if target == nil || gone == nil {
		return nil, fmt.Errorf("no entity %s or %s", survivor, absorbed)
	}
	claim(ctx, target.Tenant, survivor, gone.Aliases)
	changed := []string{survivor, absorbed}
	for _, n := range Neighbors(ctx, absorbed) {
		rdb.SRem(ctx, "edges:"+n, absorbed)
		if n == survivor {
			continue
		}
		rdb.SAdd(ctx, "edges:"+n, survivor)
		rdb.SAdd(ctx, "edges:"+survivor, n)
		changed = append(changed, n)
	}
	rdb.Del(ctx, "edges:"+absorbed)
	rdb.HSet(ctx, "entity:"+absorbed, "merged_into", survivor)
	rdb.HIncrBy(ctx, "entity:"+survivor, "version", 1)
	for _, entityID := range changed {
		rdb.Incr(ctx, "adj:"+entityID+":version")
	}
	return GetEntity(ctx, survivor), nil
}

// Rename commits a new name and returns what changed.
func Rename(ctx context.Context, entityID, newName string) (*Renamed, error) {
	oldName, err := rdb.HGet(ctx, "entity:"+entityID, "name").Result()
	if err != nil {
		return nil, fmt.Errorf("no entity %s", entityID)
	}
	rdb.HSet(ctx, "entity:"+entityID, "name", newName)
	version := rdb.HIncrBy(ctx, "entity:"+entityID, "version", 1).Val()
	return &Renamed{EntityID: entityID, OldName: oldName, NewName: newName, Version: int(version)}, nil
}

// IdemResult is what the upsert (tenant, key) answered, or nil.
func IdemResult(ctx context.Context, tenant, key string) *Recorded {
	raw, err := rdb.Get(ctx, "idem:"+tenant+":"+key).Result()
	if err != nil {
		return nil
	}
	recorded := &Recorded{}
	if json.Unmarshal([]byte(raw), recorded) != nil {
		return nil
	}
	return recorded
}

// RecordIdem records what the upsert (tenant, key) answered, for its replays.
func RecordIdem(ctx context.Context, tenant, key string, status int, body map[string]any) {
	raw, _ := json.Marshal(Recorded{Status: status, Body: body})
	rdb.Set(ctx, "idem:"+tenant+":"+key, string(raw), idemTTL)
}

// Park puts a pair on the tenant's review queue (score nil when the pair was not scored): an
// operator decides, nobody merges it meanwhile.
func Park(ctx context.Context, tenant, left, right, reason string, score *float64) {
	raw, _ := json.Marshal(map[string]any{"left": left, "right": right, "reason": reason, "score": score})
	rdb.RPush(ctx, "review:"+tenant, string(raw))
}

// InsertOutbox keeps an event the broker did not take; a relay produces it later.
func InsertOutbox(ctx context.Context, topic, key string, payload map[string]any) {
	raw, _ := json.Marshal(map[string]any{"topic": topic, "key": key, "payload": payload})
	rdb.RPush(ctx, "outbox", string(raw))
}
`,
  'graph/adjacency/adjacency.go': `// Package adjacency is the adjacency cache (provided; step 2 builds the same two functions):
// adj:{id} holds an entity's neighbour ids as JSON {"version", "neighbors"} for 5 minutes, stamped
// with the value adj:{id}:version had before the neighbours were loaded. An edge change bumps the
// version of both ends instead of deleting entries, so an entry filled from a list that was
// already stale can never be served.
package adjacency

import (
	"context"
	"encoding/json"
	"time"

	"github.com/redis/go-redis/v9"

	"graph/store"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// TTL is how long a cached neighbour list lives.
const TTL = 300 * time.Second

type entry struct {
	Version   int64    \`json:"version"\`
	Neighbors []string \`json:"neighbors"\`
}

// AdjKey holds the entity's cached neighbour list.
func AdjKey(entityID string) string { return "adj:" + entityID }

// VersionKey counts the edge changes of the entity.
func VersionKey(entityID string) string { return "adj:" + entityID + ":version" }

// ReadNeighbors is the entity's neighbour ids, sorted, through the cache.
func ReadNeighbors(ctx context.Context, entityID string) ([]string, error) {
	version, err := rdb.Get(ctx, VersionKey(entityID)).Int64()
	if err != nil && err != redis.Nil {
		return nil, err
	}
	if raw, err := rdb.Get(ctx, AdjKey(entityID)).Result(); err == nil {
		cached := entry{}
		if json.Unmarshal([]byte(raw), &cached) == nil && cached.Version == version {
			return cached.Neighbors, nil
		}
	}
	found := store.Neighbors(ctx, entityID)
	raw, _ := json.Marshal(entry{Version: version, Neighbors: found})
	if err := rdb.Set(ctx, AdjKey(entityID), string(raw), TTL).Err(); err != nil {
		return nil, err
	}
	return found, nil
}

// ApplyEdge stores the edge, then makes every cached list of both ends unreachable.
func ApplyEdge(ctx context.Context, left, right string) error {
	store.AddEdge(ctx, left, right)
	if err := rdb.Incr(ctx, VersionKey(left)).Err(); err != nil {
		return err
	}
	return rdb.Incr(ctx, VersionKey(right)).Err()
}
`,
};

export const supportModulesCpp: Record<string, string> = {
  'graph/store.h': `// The graph store (provided): entity:{id} is a hash (id, tenant, type, name, version,
// merged_into), entity:{id}:aliases the entity's aliases, alias:{tenant}:{alias} the entity that
// claims an alias in a tenant, edges:{id} the entity's neighbour ids (an edge is stored on both
// ends). Entity ids are global (e-1, e-2, ...); aliases are compared trimmed and lower-cased.
// idem:{tenant}:{key} records what an upsert answered (24 h); review:{tenant} is the review queue
// of pairs nobody may merge yet; outbox holds the events the broker did not take. Every change to
// an entity bumps its version; a merge bumps adj:{id}:version for every entity whose neighbour
// list it changed, as the adjacency cache (step 2) expects of every edge change.
#pragma once

#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <algorithm>
#include <cctype>
#include <chrono>
#include <optional>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <vector>

namespace store {

struct Entity {
  std::string id;
  std::string tenant;
  std::string type;
  std::string name;
  std::vector<std::string> aliases;
  long version = 0;
  std::string merged_into;
};

struct Renamed {
  std::string entity_id;
  std::string old_name;
  std::string new_name;
  long version = 0;
};

inline sw::redis::Redis& redis() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

// The form aliases are compared in: trimmed, lower-cased.
inline std::string normalize(const std::string& alias) {
  const auto first = alias.find_first_not_of(" \\t\\n");
  if (first == std::string::npos) return "";
  std::string out = alias.substr(first, alias.find_last_not_of(" \\t\\n") - first + 1);
  std::transform(out.begin(), out.end(), out.begin(), [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
  return out;
}

inline std::vector<std::string> sorted(std::vector<std::string> ids) {
  std::sort(ids.begin(), ids.end());
  return ids;
}

// The entity, or none.
inline std::optional<Entity> getEntity(const std::string& entity_id) {
  const std::unordered_map<std::string, std::string> raw = redis().hgetall("entity:" + entity_id);
  if (raw.empty()) return std::nullopt;
  const auto text = [&raw](const char* name) { return raw.count(name) ? raw.at(name) : std::string(); };
  Entity entity;
  entity.id = text("id");
  entity.tenant = text("tenant");
  entity.type = text("type");
  entity.name = text("name");
  entity.aliases = sorted(redis().smembers("entity:" + entity_id + ":aliases"));
  entity.version = text("version").empty() ? 0 : std::stol(text("version"));
  entity.merged_into = text("merged_into");
  return entity;
}

inline void claim(const std::string& tenant, const std::string& entity_id, const std::vector<std::string>& aliases) {
  for (const std::string& raw : aliases) {
    const std::string alias = normalize(raw);
    if (alias.empty()) continue;
    redis().sadd("entity:" + entity_id + ":aliases", alias);
    redis().set("alias:" + tenant + ":" + alias, entity_id);
  }
}

// A new entity of the tenant at version 1, claiming its aliases.
inline Entity createEntity(const std::string& tenant, const std::string& entity_type, const std::string& name,
                           const std::vector<std::string>& aliases) {
  const std::string entity_id = "e-" + std::to_string(redis().incr("entity:seq"));
  redis().hset("entity:" + entity_id, {{"id", entity_id}, {"tenant", tenant}, {"type", entity_type}, {"name", name}, {"version", "1"}, {"merged_into", ""}});
  claim(tenant, entity_id, aliases);
  return *getEntity(entity_id);
}

// The entity of the tenant that claims the alias, or none.
inline std::optional<Entity> findAlias(const std::string& tenant, const std::string& alias) {
  const auto entity_id = redis().get("alias:" + tenant + ":" + normalize(alias));
  if (!entity_id) return std::nullopt;
  return getEntity(*entity_id);
}

// Claims more aliases for an existing entity; throws std::out_of_range for an unknown id.
inline Entity addAliases(const std::string& entity_id, const std::vector<std::string>& aliases) {
  const auto entity = getEntity(entity_id);
  if (!entity) throw std::out_of_range("no entity " + entity_id);
  claim(entity->tenant, entity_id, aliases);
  redis().hincrby("entity:" + entity_id, "version", 1);
  return *getEntity(entity_id);
}

// Stores the edge on both ends.
inline void addEdge(const std::string& left, const std::string& right) {
  redis().sadd("edges:" + left, right);
  redis().sadd("edges:" + right, left);
}

// The entity's neighbour ids, sorted: the graph store's answer, never cached.
inline std::vector<std::string> neighbors(const std::string& entity_id) { return sorted(redis().smembers("edges:" + entity_id)); }

// Folds absorbed into survivor: its aliases and edges move, it keeps merged_into as a redirect.
inline Entity merge(const std::string& survivor, const std::string& absorbed) {
  const auto target = getEntity(survivor);
  const auto gone = getEntity(absorbed);
  if (!target || !gone) throw std::out_of_range("no entity " + (target ? absorbed : survivor));
  claim(target->tenant, survivor, gone->aliases);
  std::vector<std::string> changed = {survivor, absorbed};
  for (const std::string& n : neighbors(absorbed)) {
    redis().srem("edges:" + n, absorbed);
    if (n == survivor) continue;
    redis().sadd("edges:" + n, survivor);
    redis().sadd("edges:" + survivor, n);
    changed.push_back(n);
  }
  redis().del("edges:" + absorbed);
  redis().hset("entity:" + absorbed, "merged_into", survivor);
  redis().hincrby("entity:" + survivor, "version", 1);
  for (const std::string& entity_id : changed) redis().incr("adj:" + entity_id + ":version");
  return *getEntity(survivor);
}

// Commits a new name and returns what changed; throws std::out_of_range for an unknown id.
inline Renamed rename(const std::string& entity_id, const std::string& new_name) {
  const auto old_name = redis().hget("entity:" + entity_id, "name");
  if (!old_name) throw std::out_of_range("no entity " + entity_id);
  redis().hset("entity:" + entity_id, "name", new_name);
  const long long version = redis().hincrby("entity:" + entity_id, "version", 1);
  return Renamed{entity_id, *old_name, new_name, static_cast<long>(version)};
}

// What the upsert (tenant, key) answered: {"status", "body"}, or none.
inline std::optional<nlohmann::json> idemResult(const std::string& tenant, const std::string& key) {
  const auto raw = redis().get("idem:" + tenant + ":" + key);
  if (!raw) return std::nullopt;
  return nlohmann::json::parse(*raw);
}

// Records what the upsert (tenant, key) answered, for its replays.
inline void recordIdem(const std::string& tenant, const std::string& key, int status, const nlohmann::json& body) {
  redis().set("idem:" + tenant + ":" + key, nlohmann::json{{"status", status}, {"body", body}}.dump(), std::chrono::hours(24));
}

// Puts a pair on the tenant's review queue (no score when the pair was not scored): an operator
// decides, nobody merges it meanwhile.
inline void park(const std::string& tenant, const std::string& left, const std::string& right, const std::string& reason,
                 std::optional<double> score = std::nullopt) {
  nlohmann::json row{{"left", left}, {"right", right}, {"reason", reason}, {"score", nullptr}};
  if (score) row["score"] = *score;
  redis().rpush("review:" + tenant, row.dump());
}

// Keeps an event the broker did not take; a relay produces it later.
inline void insertOutbox(const std::string& topic, const std::string& key, const nlohmann::json& payload) {
  redis().rpush("outbox", nlohmann::json{{"topic", topic}, {"key", key}, {"payload", payload}}.dump());
}

}  // namespace store
`,
  'graph/adjacency.h': `// The adjacency cache (provided; step 2 builds the same two functions): adj:{id} holds an entity's
// neighbour ids as JSON {"version", "neighbors"} for 5 minutes, stamped with the value
// adj:{id}:version had before the neighbours were loaded. An edge change bumps the version of both
// ends instead of deleting entries, so an entry filled from a list that was already stale can
// never be served.
#pragma once

#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <chrono>
#include <string>
#include <vector>

#include "graph/store.h"

namespace adjacency {

constexpr std::chrono::seconds kTtl{300};

inline sw::redis::Redis& redis() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

inline std::string adjKey(const std::string& entity_id) { return "adj:" + entity_id; }
inline std::string versionKey(const std::string& entity_id) { return "adj:" + entity_id + ":version"; }

// The entity's neighbour ids, sorted, through the cache.
inline std::vector<std::string> readNeighbors(const std::string& entity_id) {
  const auto counter = redis().get(versionKey(entity_id));
  const long long version = counter ? std::stoll(*counter) : 0;
  const auto raw = redis().get(adjKey(entity_id));
  if (raw) {
    const auto entry = nlohmann::json::parse(*raw, nullptr, false);
    if (entry.is_object() && entry.value("version", -1LL) == version) return entry["neighbors"].get<std::vector<std::string>>();
  }
  const std::vector<std::string> found = store::neighbors(entity_id);
  redis().set(adjKey(entity_id), nlohmann::json{{"version", version}, {"neighbors", found}}.dump(), kTtl);
  return found;
}

// Stores the edge, then makes every cached list of both ends unreachable.
inline void applyEdge(const std::string& left, const std::string& right) {
  store::addEdge(left, right);
  redis().incr(versionKey(left));
  redis().incr(versionKey(right));
}

}  // namespace adjacency
`,
};

export const supportModulesScala: Record<string, string> = {
  [scalaPath('graph', 'Store')]: `package graph

import redis.clients.jedis.JedisPooled
import spray.json._

import scala.jdk.CollectionConverters._

/**
 * The graph store (provided): entity:{id} is a hash (id, tenant, type, name, version, merged_into),
 * entity:{id}:aliases the entity's aliases, alias:{tenant}:{alias} the entity that claims an alias
 * in a tenant, edges:{id} the entity's neighbour ids (an edge is stored on both ends). Entity ids
 * are global (e-1, e-2, ...); aliases are compared trimmed and lower-cased. idem:{tenant}:{key}
 * records what an upsert answered (24 h); review:{tenant} is the review queue of pairs nobody may
 * merge yet; outbox holds the events the broker did not take. Every change to an entity bumps its
 * version; a merge bumps adj:{id}:version for every entity whose neighbour list it changed, as the
 * adjacency cache (step 2) expects of every edge change.
 */
object Store {
  final case class Entity(
      id: String,
      tenant: String,
      entityType: String,
      name: String,
      aliases: List[String],
      version: Long,
      mergedInto: Option[String])

  final case class Renamed(entityId: String, oldName: String, newName: String, version: Long)

  final case class Recorded(status: Int, body: JsObject)

  val IdemTtlSeconds = 86400L

  val jedis = new JedisPooled("redis", 6379)

  def normalize(alias: String): String = alias.trim.toLowerCase

  /** The entity, if it exists. */
  def getEntity(entityId: String): Option[Entity] = {
    val raw = jedis.hgetAll(s"entity:$entityId").asScala.toMap
    if (raw.isEmpty) None
    else
      Some(
        Entity(
          raw("id"),
          raw("tenant"),
          raw("type"),
          raw("name"),
          jedis.smembers(s"entity:$entityId:aliases").asScala.toList.sorted,
          raw("version").toLong,
          raw.get("merged_into").filter(_.nonEmpty)))
  }

  private def claim(tenant: String, entityId: String, aliases: Seq[String]): Unit =
    aliases.map(normalize).filter(_.nonEmpty).foreach { alias =>
      jedis.sadd(s"entity:$entityId:aliases", alias)
      jedis.set(s"alias:$tenant:$alias", entityId)
    }

  /** A new entity of the tenant at version 1, claiming its aliases. */
  def createEntity(tenant: String, entityType: String, name: String, aliases: Seq[String]): Entity = {
    val entityId = s"e-\${jedis.incr("entity:seq")}"
    jedis.hset(
      s"entity:$entityId",
      Map("id" -> entityId, "tenant" -> tenant, "type" -> entityType, "name" -> name, "version" -> "1", "merged_into" -> "").asJava)
    claim(tenant, entityId, aliases)
    getEntity(entityId).get
  }

  /** The entity of the tenant that claims the alias, if any. */
  def findAlias(tenant: String, alias: String): Option[Entity] =
    Option(jedis.get(s"alias:$tenant:\${normalize(alias)}")).flatMap(getEntity)

  /** Claims more aliases for an existing entity. */
  def addAliases(entityId: String, aliases: Seq[String]): Entity = {
    val entity = getEntity(entityId).getOrElse(throw new NoSuchElementException(s"no entity $entityId"))
    claim(entity.tenant, entityId, aliases)
    jedis.hincrBy(s"entity:$entityId", "version", 1L)
    getEntity(entityId).get
  }

  /** Stores the edge on both ends. */
  def addEdge(left: String, right: String): Unit = {
    jedis.sadd(s"edges:$left", right)
    jedis.sadd(s"edges:$right", left)
  }

  /** The entity's neighbour ids, sorted: the graph store's answer, never cached. */
  def neighbors(entityId: String): List[String] = jedis.smembers(s"edges:$entityId").asScala.toList.sorted

  /** Folds absorbed into survivor: its aliases and edges move, it keeps merged_into as a redirect. */
  def merge(survivor: String, absorbed: String): Entity = {
    val target = getEntity(survivor).getOrElse(throw new NoSuchElementException(s"no entity $survivor"))
    val gone = getEntity(absorbed).getOrElse(throw new NoSuchElementException(s"no entity $absorbed"))
    claim(target.tenant, survivor, gone.aliases)
    val moved = neighbors(absorbed)
    moved.foreach { n =>
      jedis.srem(s"edges:$n", absorbed)
      if (n != survivor) {
        jedis.sadd(s"edges:$n", survivor)
        jedis.sadd(s"edges:$survivor", n)
      }
    }
    jedis.del(s"edges:$absorbed")
    jedis.hset(s"entity:$absorbed", "merged_into", survivor)
    jedis.hincrBy(s"entity:$survivor", "version", 1L)
    (List(survivor, absorbed) ++ moved.filter(_ != survivor)).foreach(entityId => jedis.incr(s"adj:$entityId:version"))
    getEntity(survivor).get
  }

  /** Commits a new name and returns what changed. */
  def rename(entityId: String, newName: String): Renamed = {
    val oldName = Option(jedis.hget(s"entity:$entityId", "name")).getOrElse(throw new NoSuchElementException(s"no entity $entityId"))
    jedis.hset(s"entity:$entityId", "name", newName)
    val version = jedis.hincrBy(s"entity:$entityId", "version", 1L)
    Renamed(entityId, oldName, newName, version)
  }

  /** What the upsert (tenant, key) answered, if recorded. */
  def idemResult(tenant: String, key: String): Option[Recorded] =
    Option(jedis.get(s"idem:$tenant:$key")).map { raw =>
      val fields = raw.parseJson.asJsObject.fields
      val status = fields("status") match {
        case JsNumber(n) => n.toInt
        case _           => 200
      }
      Recorded(status, fields("body").asJsObject)
    }

  /** Records what the upsert (tenant, key) answered, for its replays. */
  def recordIdem(tenant: String, key: String, status: Int, body: JsObject): Unit =
    jedis.setex(s"idem:$tenant:$key", IdemTtlSeconds, JsObject("status" -> JsNumber(status), "body" -> body).compactPrint)

  /** Puts a pair on the tenant's review queue: an operator decides, nobody merges it meanwhile. */
  def park(tenant: String, left: String, right: String, reason: String, score: Option[Double] = None): Unit =
    jedis.rpush(
      s"review:$tenant",
      JsObject(
        "left" -> JsString(left),
        "right" -> JsString(right),
        "reason" -> JsString(reason),
        "score" -> score.map(JsNumber(_)).getOrElse(JsNull)).compactPrint)

  /** Keeps an event the broker did not take; a relay produces it later. */
  def insertOutbox(topic: String, key: String, payload: JsObject): Unit =
    jedis.rpush("outbox", JsObject("topic" -> JsString(topic), "key" -> JsString(key), "payload" -> payload).compactPrint)
}
`,
  [scalaPath('graph', 'Adjacency')]: `package graph

import redis.clients.jedis.JedisPooled
import spray.json._

/**
 * The adjacency cache (provided; step 2 builds the same two functions): adj:{id} holds an entity's
 * neighbour ids as JSON {"version", "neighbors"} for 5 minutes, stamped with the value
 * adj:{id}:version had before the neighbours were loaded. An edge change bumps the version of both
 * ends instead of deleting entries, so an entry filled from a list that was already stale can never
 * be served.
 */
object Adjacency {
  val TtlSeconds = 300L

  val jedis = new JedisPooled("redis", 6379)

  def adjKey(entityId: String): String = s"adj:$entityId"
  def versionKey(entityId: String): String = s"adj:$entityId:version"

  /** The entity's neighbour ids, sorted, through the cache. */
  def readNeighbors(entityId: String): List[String] = {
    val version = Option(jedis.get(versionKey(entityId))).map(_.toLong).getOrElse(0L)
    val cached = Option(jedis.get(adjKey(entityId)))
      .map(_.parseJson.asJsObject.fields)
      .filter(_.get("version").contains(JsNumber(version)))
      .map(_.get("neighbors") match {
        case Some(JsArray(items)) => items.collect { case JsString(id) => id }.toList
        case _                    => Nil
      })
    cached.getOrElse {
      val found = Store.neighbors(entityId)
      val entry = JsObject("version" -> JsNumber(version), "neighbors" -> JsArray(found.map(JsString(_)).toVector))
      jedis.setex(adjKey(entityId), TtlSeconds, entry.compactPrint)
      found
    }
  }

  /** Stores the edge, then makes every cached list of both ends unreachable. */
  def applyEdge(left: String, right: String): Unit = {
    Store.addEdge(left, right)
    jedis.incr(versionKey(left))
    jedis.incr(versionKey(right))
  }
}
`,
};
