import type {Step} from '@/lib/types';

export const adjacencyCacheStep: Step = {
  id: 'state',
  title: 'Redis adjacency cache with invalidation that cannot race',
  concept: 'redis',
  file: 'state',
  focus: ['api', 'redis', 'db'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft of the adjacency cache. It
reads through Redis, fills on a miss, and clears the key when an edge changes. It compiles, the demo
is fast, and it hides three production flaws. Review it like the cache owner, fix it, and prove the
fix with the checks below.

Implement the adjacency layer used by the API:

- A neighbour list is cached per **\`(tenant, entity)\`** under a key built by \`adj_key(tenant, entity)\`
  (the \`adj:\` prefix). Two tenants that happen to share an entity id must never read each other's
  list.
- Every cached entry carries the **version** it was built from and a **5-minute TTL** (\`TTL_S = 300\`,
  \`EX 300\`). A missed entry is loaded from the graph store and refilled with that TTL.
- An edge change **bumps a version counter** (\`bump_version\` → \`INCR\`) instead of deleting cache
  entries. The reader compares the version it stamped with the current counter and refills when they
  differ, so a stale entry is unreachable rather than removed.
- The reader takes the version **before** it loads the neighbours; the write path bumps the version
  **inside** the same operation that applies the edge. Then a read raced against a write either
  stamps the pre-change version and is made unreachable by the bump, or observes the post-change
  version and reloads — never a double-apply, at most one operation's worth of work is visible.
- Invalidation is \`bump_version\`, never a delete of the adjacency key.

**Failure mode the checks target.** The draft deletes the cache entry *after* applying the edge.
Between the read of the graph and the delete, or between the delete and a concurrent reader that
already loaded the old list, a read can refill the key with the pre-change neighbours; the delete
then lands on an entry that no longer describes the state and passes without effect, so the stale
list survives until the TTL. The same draft keys without the tenant, so two tenants collide on one
key, and it writes entries with no TTL, so a hot entity pins memory forever. Bumping a version
counter has none of these races: the entry is never deleted, so there is nothing to refill into a
window, and the counter is the single point of truth about which entry is current.`,
  sequence: {
    participants: ['graph-api', 'Adjacency cache', 'Graph store'],
    messages: [
      {from: 'graph-api', to: 'Adjacency cache', label: 'GET adj:(tenant, entity)', kind: 'sync'},
      {from: 'Adjacency cache', to: 'graph-api', label: 'stamped list / miss', kind: 'reply'},
      {from: 'graph-api', to: 'Graph store', label: 'load neighbours (on miss or stale)', kind: 'sync'},
      {from: 'Graph store', to: 'graph-api', label: 'neighbours', kind: 'reply'},
      {from: 'graph-api', to: 'Adjacency cache', label: 'SET adj:(tenant, entity) · version · EX 300', kind: 'async'},
      {from: 'graph-api', to: 'Graph store', label: 'add_edge(tenant, src, dst)', kind: 'sync'},
      {from: 'graph-api', to: 'Adjacency cache', label: 'INCR adjver:tenant', kind: 'async'},
    ],
  },
  checks: [
    {
      id: 'tenant-key',
      title: 'Keys the adjacency cache by (tenant, entity)',
      detail:
        'Build the cache key with `adj_key(tenant, entity)` over an `adj:` prefix; two tenants never share a key. The draft keys by entity alone.',
      match: {
        python: {all: [/def adj_key\(\s*tenant/, /"adj:/]},
        typescript: {all: [/function adjKey\(\s*tenant/, /'adj:'/]},
        go: {all: [/func adjKey\(\s*tenant/, /"adj:"/]},
        scala: {all: [/def adjKey\(\s*tenant/, /"adj:/]},
        cpp: {all: [/std::string adjKey\(\s*const std::string& tenant/, /"adj:"/]},
      },
    },
    {
      id: 'version-bump',
      title: 'Bumps a version counter instead of touching entries',
      detail:
        'An edge change calls `bump_version` → `INCR` on `version_key(tenant)`. The draft has no counter at all, so nothing distinguishes a stale entry from a fresh one.',
      match: {
        python: {all: [/def bump_version\(/, /\.incr\(/, /version_key\(/]},
        typescript: {all: [/function bumpVersion\(/, /\.incr\(/, /versionKey\(/]},
        go: {all: [/func bumpVersion\(/, /\.Incr\(/, /versionKey\(/]},
        scala: {all: [/def bumpVersion\(/, /\.incr\(/, /versionKey\(/]},
        cpp: {all: [/bumpVersion\(/, /\.incr\(/, /versionKey\(/]},
      },
    },
    {
      id: 'no-delete',
      title: 'Invalidates by version, never by deleting the key',
      detail:
        'No `delete`/`del` of the adjacency key anywhere: invalidation is the version bump, so a concurrent read cannot refill a deleted key with a pre-change list. The draft deletes after the write.',
      match: {
        python: {all: [/bump_version\(/], none: [/\bdelete\(/]},
        typescript: {all: [/bumpVersion\(/], none: [/\.del\(/]},
        go: {all: [/bumpVersion\(/], none: [/\.Del\(/]},
        scala: {all: [/bumpVersion\(/], none: [/\.del\(/]},
        cpp: {all: [/bumpVersion\(/], none: [/\.del\(/]},
      },
    },
    {
      id: 'ttl',
      title: 'Writes entries with a 5-minute TTL',
      detail:
        'A refilled entry gets `TTL_S = 300` / `EX 300`. The draft writes with no expiry, so a hot entity is pinned in memory forever.',
      match: {
        python: {all: [/TTL_S\s*=\s*300/, /ex=TTL_S/]},
        typescript: {all: [/TTL_S\s*=\s*300/, /'EX',\s*TTL_S/]},
        go: {all: [/ttlS\s*=\s*300\s*\*\s*time\.Second/, /\.Set\(/]},
        scala: {all: [/TtlS\s*=\s*300/, /\.setex\(/]},
        cpp: {all: [/kTtlSeconds\s*=\s*300/, /chrono::seconds\(kTtlSeconds\)/]},
      },
    },
    {
      id: 'read-through',
      title: 'Reads through with an explicit version check',
      detail:
        '`read_neighbors` reads the current version first, compares it with the version stamped on the cached entry, and refills only on a mismatch or miss. The draft returns whatever is cached, stale or not.',
      match: {
        python: {all: [/def read_neighbors\(/, /\["version"\]/, /adj_key\(/]},
        typescript: {all: [/function readNeighbors\(/, /\.version/, /adjKey\(/]},
        go: {all: [/func readNeighbors\(/, /\.Version/, /adjKey\(/]},
        scala: {all: [/def readNeighbors\(/, /\.version/, /adjKey\(/]},
        cpp: {all: [/readNeighbors\(/, /"version"/, /adjKey\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json

import redis.asyncio as redis

cache = redis.Redis(decode_responses=True)


class GraphStore:
    async def load_neighbors(self, tenant: str, entity: str) -> list[str]:
        raise NotImplementedError

    async def add_edge(self, tenant: str, src: str, dst: str) -> None:
        raise NotImplementedError


store = GraphStore()


async def read_neighbors(tenant: str, entity: str) -> list[str]:
    # TODO: this draft keys without the tenant, caches without a TTL, and invalidates by deleting
    # the entry after the write — so a concurrent read refills a stale list that no later deletion
    # cleans. Review all three.
    key = f"neighbors:{entity}"
    raw = await cache.get(key)
    if raw is not None:
        return json.loads(raw)
    neighbors = await store.load_neighbors(tenant, entity)
    await cache.set(key, json.dumps(neighbors))
    return neighbors


async def apply_edge(tenant: str, src: str, dst: str) -> None:
    await store.add_edge(tenant, src, dst)
    await cache.delete(f"neighbors:{src}")
    await cache.delete(f"neighbors:{dst}")
`,
      solution: `import json
import logging

import redis.asyncio as redis

cache = redis.Redis(decode_responses=True)
logger = logging.getLogger("graph")

TTL_S = 300  # 5 minutes
ADJ_PREFIX = "adj"


class GraphStore:
    async def load_neighbors(self, tenant: str, entity: str) -> list[str]:
        raise NotImplementedError

    async def add_edge(self, tenant: str, src: str, dst: str) -> None:
        raise NotImplementedError


store = GraphStore()


def adj_key(tenant: str, entity: str) -> str:
    """Key a neighbour list by tenant as well as entity: tenants never collide."""
    return f"adj:{tenant}:{entity}"


def version_key(tenant: str) -> str:
    return f"adjver:{tenant}"


async def current_version(tenant: str) -> int:
    raw = await cache.get(version_key(tenant))
    return int(raw) if raw is not None else 0


async def bump_version(tenant: str) -> int:
    """Make every cached list for this tenant unreachable — without deleting anything."""
    return int(await cache.incr(version_key(tenant)))


async def read_neighbors(tenant: str, entity: str) -> list[str]:
    # Take the version before loading: a bump that lands after this line makes the entry we write
    # unreachable, which is the safe direction.
    version = await current_version(tenant)
    raw = await cache.get(adj_key(tenant, entity))
    if raw is not None:
        cached = json.loads(raw)
        if cached["version"] == version:
            return cached["neighbors"]
    neighbors = await store.load_neighbors(tenant, entity)
    payload = json.dumps({"version": version, "neighbors": neighbors})
    await cache.set(adj_key(tenant, entity), payload, ex=TTL_S)
    return neighbors


async def apply_edge(tenant: str, src: str, dst: str) -> None:
    await store.add_edge(tenant, src, dst)
    version = await bump_version(tenant)
    logger.info("edge tenant=%s src=%s dst=%s version=%d", tenant, src, dst, version)
`,
    },
    typescript: {
      starter: `/** Adjacency cache: a model-generated draft that deletes after the write. */
import {Redis} from 'ioredis';

import {graph} from './graph';

const cache = new Redis(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379');

export async function readNeighbors(tenant: string, entity: string): Promise<string[]> {
  // TODO: this draft keys without the tenant, caches without a TTL, and invalidates by deleting the
  // entry after the write — so a concurrent read refills a stale list that no later deletion cleans.
  const key = 'neighbors:' + entity;
  const raw = await cache.get(key);
  if (raw !== null) return JSON.parse(raw) as string[];
  const neighbors = await graph.loadNeighbors(tenant, entity);
  await cache.set(key, JSON.stringify(neighbors));
  return neighbors;
}

export async function applyEdge(tenant: string, src: string, dst: string): Promise<void> {
  await graph.addEdge(tenant, src, dst);
  await cache.del('neighbors:' + src);
  await cache.del('neighbors:' + dst);
}
`,
      solution: `/** Adjacency cache: tenant-scoped keys, version-and-TTL invalidation that cannot race. */
import {Redis} from 'ioredis';

import {graph} from './graph';

const cache = new Redis(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379');

const TTL_S = 300; // 5 minutes
const ADJ_PREFIX = 'adj';

interface CachedNeighbors {
  version: number;
  neighbors: string[];
}

/** Key a neighbour list by tenant as well as entity: tenants never collide. */
function adjKey(tenant: string, entity: string): string {
  return 'adj:' + tenant + ':' + entity;
}

function versionKey(tenant: string): string {
  return 'adjver:' + tenant;
}

async function currentVersion(tenant: string): Promise<number> {
  const raw = await cache.get(versionKey(tenant));
  return raw === null ? 0 : Number(raw);
}

async function bumpVersion(tenant: string): Promise<number> {
  return cache.incr(versionKey(tenant));
}

export async function readNeighbors(tenant: string, entity: string): Promise<string[]> {
  // Take the version before loading: a bump after this line makes the entry we write unreachable.
  const version = await currentVersion(tenant);
  const raw = await cache.get(adjKey(tenant, entity));
  if (raw !== null) {
    const cached = JSON.parse(raw) as CachedNeighbors;
    if (cached.version === version) return cached.neighbors;
  }
  const neighbors = await graph.loadNeighbors(tenant, entity);
  await cache.set(adjKey(tenant, entity), JSON.stringify({version, neighbors}), 'EX', TTL_S);
  return neighbors;
}

export async function applyEdge(tenant: string, src: string, dst: string): Promise<void> {
  await graph.addEdge(tenant, src, dst);
  const version = await bumpVersion(tenant);
  console.log(JSON.stringify({event: 'edge', tenant, src, dst, version}));
}
`,
    },
    go: {
      starter: `package state

import (
	"context"
	"encoding/json"

	"github.com/redis/go-redis/v9"
)

var ctx = context.Background()

func readNeighbors(cache *redis.Client, tenant, entity string) ([]string, error) {
	// TODO: this draft keys without the tenant, caches without a TTL, and invalidates by deleting
	// the entry after the write — so a concurrent read refills a stale list that no later deletion
	// cleans.
	key := "neighbors:" + entity
	raw, err := cache.Get(ctx, key).Bytes()
	if err == nil {
		var neighbors []string
		_ = json.Unmarshal(raw, &neighbors)
		return neighbors, nil
	}
	neighbors := loadNeighbors(tenant, entity)
	payload, _ := json.Marshal(neighbors)
	cache.Set(ctx, key, payload, 0)
	return neighbors, nil
}

func applyEdge(cache *redis.Client, tenant, src, dst string) error {
	if err := addEdge(tenant, src, dst); err != nil {
		return err
	}
	cache.Del(ctx, "neighbors:"+src)
	cache.Del(ctx, "neighbors:"+dst)
	return nil
}
`,
      solution: `package state

import (
	"context"
	"encoding/json"
	"log"
	"time"

	"github.com/redis/go-redis/v9"
)

var ctx = context.Background()

const ttlS = 300 * time.Second // 5 minutes

// Key a neighbour list by tenant as well as entity: tenants never collide.
func adjKey(tenant, entity string) string { return "adj:" + tenant + ":" + entity }

func versionKey(tenant string) string { return "adjver:" + tenant }

func currentVersion(cache *redis.Client, tenant string) int64 {
	version, err := cache.Get(ctx, versionKey(tenant)).Int64()
	if err != nil {
		return 0
	}
	return version
}

// Make every cached list for this tenant unreachable — without deleting anything.
func bumpVersion(cache *redis.Client, tenant string) int64 {
	version, err := cache.Incr(ctx, versionKey(tenant)).Result()
	if err != nil {
		return 0
	}
	return version
}

type cachedNeighbors struct {
	Version   int64    \`json:"version"\`
	Neighbors []string \`json:"neighbors"\`
}

func readNeighbors(cache *redis.Client, tenant, entity string) ([]string, error) {
	// Take the version before loading: a bump after this line makes the entry we write unreachable.
	version := currentVersion(cache, tenant)
	raw, err := cache.Get(ctx, adjKey(tenant, entity)).Bytes()
	if err == nil {
		var cached cachedNeighbors
		if json.Unmarshal(raw, &cached) == nil && cached.Version == version {
			return cached.Neighbors, nil
		}
	}
	neighbors := loadNeighbors(tenant, entity)
	payload, _ := json.Marshal(cachedNeighbors{Version: version, Neighbors: neighbors})
	cache.Set(ctx, adjKey(tenant, entity), payload, ttlS)
	return neighbors, nil
}

func applyEdge(cache *redis.Client, tenant, src, dst string) error {
	if err := addEdge(tenant, src, dst); err != nil {
		return err
	}
	version := bumpVersion(cache, tenant)
	log.Printf("edge tenant=%s src=%s dst=%s version=%d", tenant, src, dst, version)
	return nil
}
`,
    },
    scala: {
      starter: `import com.typesafe.scalalogging.Logger
import redis.clients.jedis.Jedis
import spray.json.DefaultJsonProtocol._

object AdjacencyCache {
  private val log = Logger("graph")

  def readNeighbors(jedis: Jedis, tenant: String, entity: String): List[String] = {
    // TODO: this draft keys without the tenant, caches without a TTL, and invalidates by deleting
    // the entry after the write — so a concurrent read refills a stale list that no later deletion
    // cleans.
    val key = s"neighbors:$entity"
    Option(jedis.get(key)) match {
      case Some(raw) => raw.parseJson.convertTo[List[String]]
      case None =>
        val neighbors = loadNeighbors(tenant, entity)
        jedis.set(key, neighbors.toJson.compactPrint)
        neighbors
    }
  }

  def applyEdge(jedis: Jedis, tenant: String, src: String, dst: String): Unit = {
    addEdge(tenant, src, dst)
    jedis.del(s"neighbors:$src")
    jedis.del(s"neighbors:$dst")
  }
}
`,
      solution: `import com.typesafe.scalalogging.Logger
import redis.clients.jedis.Jedis
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class CachedNeighbors(version: Long, neighbors: List[String])

object AdjacencyCache {
  private val log = Logger("graph")

  val TtlS = 300 // 5 minutes
  val AdjPrefix = "adj"

  implicit val cachedFormat: RootJsonFormat[CachedNeighbors] = jsonFormat2(CachedNeighbors)

  /** Key a neighbour list by tenant as well as entity: tenants never collide. */
  def adjKey(tenant: String, entity: String): String = s"adj:$tenant:$entity"

  def versionKey(tenant: String): String = s"adjver:$tenant"

  def currentVersion(jedis: Jedis, tenant: String): Long =
    Option(jedis.get(versionKey(tenant))).map(_.toLong).getOrElse(0L)

  /** Make every cached list for this tenant unreachable — without deleting anything. */
  def bumpVersion(jedis: Jedis, tenant: String): Long = jedis.incr(versionKey(tenant))

  def readNeighbors(jedis: Jedis, tenant: String, entity: String): List[String] = {
    // Take the version before loading: a bump after this line makes the entry we write unreachable.
    val version = currentVersion(jedis, tenant)
    val cached = Option(jedis.get(adjKey(tenant, entity))).flatMap { raw =>
      try Some(raw.parseJson.convertTo[CachedNeighbors])
      catch { case _: Throwable => None }
    }
    cached match {
      case Some(entry) if entry.version == version => entry.neighbors
      case _ =>
        val neighbors = loadNeighbors(tenant, entity)
        jedis.setex(adjKey(tenant, entity), TtlS, CachedNeighbors(version, neighbors).toJson.compactPrint)
        neighbors
    }
  }

  def applyEdge(jedis: Jedis, tenant: String, src: String, dst: String): Unit = {
    addEdge(tenant, src, dst)
    val version = bumpVersion(jedis, tenant)
    log.info(s"edge tenant=$tenant src=$src dst=$dst version=$version")
  }
}
`,
    },
    cpp: {
      starter: `#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <iostream>
#include <string>
#include <vector>

using json = nlohmann::json;

std::vector<std::string> loadNeighbors(const std::string& tenant, const std::string& entity);
void addEdge(const std::string& tenant, const std::string& src, const std::string& dst);

std::vector<std::string> readNeighbors(sw::redis::Redis& cache, const std::string& tenant,
                                       const std::string& entity) {
  // TODO: this draft keys without the tenant, caches without a TTL, and invalidates by deleting the
  // entry after the write — so a concurrent read refills a stale list that no later deletion cleans.
  const std::string key = "neighbors:" + entity;
  auto raw = cache.get(key);
  if (raw) return json::parse(*raw).get<std::vector<std::string>>();
  const auto neighbors = loadNeighbors(tenant, entity);
  cache.set(key, json(neighbors).dump());
  return neighbors;
}

void applyEdge(sw::redis::Redis& cache, const std::string& tenant, const std::string& src,
               const std::string& dst) {
  addEdge(tenant, src, dst);
  cache.del("neighbors:" + src);
  cache.del("neighbors:" + dst);
}
`,
      solution: `#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <chrono>
#include <iostream>
#include <string>
#include <vector>

using json = nlohmann::json;

constexpr int kTtlSeconds = 300; // 5 minutes
const std::string kAdjPrefix = "adj";

std::vector<std::string> loadNeighbors(const std::string& tenant, const std::string& entity);
void addEdge(const std::string& tenant, const std::string& src, const std::string& dst);

/** Key a neighbour list by tenant as well as entity: tenants never collide. */
std::string adjKey(const std::string& tenant, const std::string& entity) {
  return "adj:" + tenant + ":" + entity;
}

std::string versionKey(const std::string& tenant) { return "adjver:" + tenant; }

long long currentVersion(sw::redis::Redis& cache, const std::string& tenant) {
  auto raw = cache.get(versionKey(tenant));
  return raw ? std::stoll(*raw) : 0;
}

/** Make every cached list for this tenant unreachable — without deleting anything. */
long long bumpVersion(sw::redis::Redis& cache, const std::string& tenant) {
  return cache.incr(versionKey(tenant));
}

std::vector<std::string> readNeighbors(sw::redis::Redis& cache, const std::string& tenant,
                                       const std::string& entity) {
  // Take the version before loading: a bump after this line makes the entry we write unreachable.
  const long long version = currentVersion(cache, tenant);
  auto raw = cache.get(adjKey(tenant, entity));
  if (raw) {
    json cached = json::parse(*raw, nullptr, false);
    if (cached.is_object() && cached.value("version", -1LL) == version)
      return cached.value("neighbors", std::vector<std::string>{});
  }
  const auto neighbors = loadNeighbors(tenant, entity);
  const json payload = {{"version", version}, {"neighbors", neighbors}};
  cache.set(adjKey(tenant, entity), payload.dump(), std::chrono::seconds(kTtlSeconds));
  return neighbors;
}

void applyEdge(sw::redis::Redis& cache, const std::string& tenant, const std::string& src,
               const std::string& dst) {
  addEdge(tenant, src, dst);
  const long long version = bumpVersion(cache, tenant);
  std::cerr << "edge tenant=" << tenant << " src=" << src << " dst=" << dst << " version=" << version << "\\n";
}
`,
    },
  },
  hints: [
    'Derive the key from `(tenant, entity)` — a shared entity id across tenants must never collide. Tenant-scoping the key is not an optimisation; it is the isolation boundary.',
    'Delete-after-write cannot be made safe by moving the delete earlier: any window where the key is absent lets a reader refill from a graph read that predates the change. Replace the delete with `INCR adjver:tenant` and stamp each cache entry with the version it was built from.',
    'Order matters in the reader: read the counter, then the entry, then refill. If you stamp the entry with a version read *after* loading the neighbours you can label fresh data stale — harmless — but doing it the other way round lets a bump to V+1 coexist with a list built at V, which is the race you were hired to remove.',
  ],
  debrief: `The interviewer is testing whether you can invalidate a cache without a delete. The draft deletes after the write, which is the classic race: the delete can land on an entry a concurrent read just refilled, or on an entry that no longer describes the state, and either way the stale list survives. Version counters turn invalidation into a comparison: entries are written with the version they were built from, the writer only ever increments, and a reader that finds a mismatch refills — no window exists in which a delete and a refill can cancel each other out. Keying by \`(tenant, entity)\` is the second failure: without it two tenants share one list. The TTL bounds memory for entities that stop being read. Real systems add a Redis script to apply the edge and the increment atomically, per-entity locks for the write path, and a metric on the refill rate so a version churn that defeats the cache is visible.`,
};
