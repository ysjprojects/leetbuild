import type {Step} from '@/lib/types';

export const adjacencyCacheStep: Step = {
  id: 'state',
  title: 'Redis adjacency cache with invalidation that cannot race',
  concept: 'redis',
  file: 'state',
  focus: ['api', 'redis', 'db'],
  task: `## Task

**Starting point.** The starter is the adjacency cache behind the API: \`read_neighbors\` reads
\`neighbors:{entity}\` from Redis, returns a hit as is, fills a miss from the graph store with no
expiry, and \`apply_edge\` adds the edge and then deletes both endpoints' keys. It compiles, the demo
is fast, and it hides five flaws.

**Failure mode the checks target.** A reader that loaded the old list just before the write refills
the key after the delete, so the stale neighbour list survives until the next restart. Two tenants
that share an entity id read each other's list. A hot entity's entry is pinned in memory forever,
and nothing in a cached entry says which state of the graph it was built from.

- A neighbour list is cached per \`(tenant, entity)\` under \`adj_key(tenant, entity)\` (the \`adj:\`
  prefix).
- Every cached entry carries the **version** it was built from and a **5-minute TTL** (\`TTL_S = 300\`,
  \`EX 300\`). A miss is loaded from the graph store and refilled with that TTL.
- An edge change bumps a version counter (\`bump_version\`, an \`INCR\` on \`version_key(tenant)\`)
  instead of deleting entries. The reader compares the stamped version with the counter and refills
  on a mismatch, so a stale entry is unreachable rather than removed.
- The reader takes the version before it loads the neighbours; the write path bumps the version in
  the same operation that applies the edge, so a raced read is either made unreachable by the bump
  or sees the new version and reloads. Invalidation is \`bump_version\`, not a delete.`,
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
        'Build the cache key with `adj_key(tenant, entity)` over an `adj:` prefix; two tenants never share a key. The starter keys by entity alone.',
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
        'An edge change calls `bump_version` → `INCR` on `version_key(tenant)`. The starter has no counter at all, so nothing distinguishes a stale entry from a fresh one.',
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
        'No `delete`/`del` of the adjacency key anywhere: invalidation is the version bump, so a concurrent read cannot refill a deleted key with a pre-change list. The starter deletes after the write.',
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
        'A refilled entry gets `TTL_S = 300` / `EX 300`. The starter writes with no expiry, so a hot entity is pinned in memory forever.',
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
        '`read_neighbors` reads the current version first, compares it with the version stamped on the cached entry, and refills only on a mismatch or miss. The starter returns whatever is cached, stale or not.',
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
    # TODO: this starter has five flaws. The task says where to look; the checks say what must change.
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
      starter: `/** Adjacency cache: flawed code that deletes after the write. */
import {Redis} from 'ioredis';

import {graph} from './graph';

const cache = new Redis(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379');

export async function readNeighbors(tenant: string, entity: string): Promise<string[]> {
  // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
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
	// TODO: this starter has five flaws. The task says where to look; the checks say what must change.
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
    // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
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
  // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
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
    "After an edge is added, some callers keep seeing the old neighbour list for hours, and one tenant occasionally sees another tenant's neighbours for the same entity id.",
    '`apply_edge` deletes the key after the write, so a reader that loaded the old list a moment earlier refills it after the delete; `neighbors:{entity}` has no tenant and `cache.set` has no TTL.',
    'Key by `adj_key(tenant, entity)`, store `{"version", "neighbors"}` with `ex=TTL_S`; in `apply_edge` call `bump_version` (`INCR version_key(tenant)`) instead of `delete`; in `read_neighbors` read the version first and refill on mismatch.',
  ],
  debrief: `Delete-after-write is a race no reordering fixes: any window in which the key is absent lets a reader refill it from a graph read that predates the change, and the delete that follows passes without effect. A version counter turns invalidation into a comparison. Entries carry the version they were built from, the writer only increments, and a reader that finds a mismatch refills, so there is no window in which a delete and a refill cancel out. The tenant in the key is the isolation boundary, and the TTL bounds memory for entities nobody reads any more. Production systems apply the edge and the increment in one Redis script so a crash between them cannot leave a bumped counter without the edge, and they watch the refill rate so version churn that defeats the cache is visible.`,
};
