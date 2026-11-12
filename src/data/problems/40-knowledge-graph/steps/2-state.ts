import type {Step} from '@/lib/types';

export const adjacencyCacheStep: Step = {
  id: 'state',
  title: 'Redis adjacency cache invalidated by a version, not a delete',
  concept: 'redis',
  guides: ['keys-and-expiry'],
  file: 'state',
  focus: ['api', 'redis', 'db'],
  task: `## Task

**Starting point.** The starter is the adjacency cache every graph read goes through:
\`read_neighbors(entity_id)\` returns the JSON list under \`adj:{id}\`, or loads \`store.neighbors\`
on a miss and caches it; \`apply_edge(left, right)\` stores the edge with \`store.add_edge\` and
deletes \`adj:{left}\`. It serves the demo and hides three flaws.

**Failure mode the checks target.** A reader that loaded the old list just before an edge change
writes it back after the delete, and the stale list is served until someone notices; an entry never
expires; and the far end of a new edge keeps its old list.

- A cached entry is \`{"version", "neighbors"}\` under \`adj_key\` (\`adj:{id}\`) with a **5-minute
  TTL** (\`TTL_S = 300\`).
- \`version_key\` (\`adj:{id}:version\`) counts the entity's edge changes. The reader reads it
  **before** loading the neighbours, stamps the entry with it, and reloads when the stamp and the
  counter differ.
- \`apply_edge\` **increments** the version of **both** ends after \`store.add_edge\`, so every list
  cached before the change, or filled from a list loaded before it, is unreachable.`,
  sequence: {
    participants: ['Reader', 'Redis', 'Graph store', 'Writer'],
    messages: [
      {from: 'Reader', to: 'Redis', label: 'GET adj:e-1:version → 0 · GET adj:e-1 → miss', kind: 'sync'},
      {from: 'Reader', to: 'Graph store', label: 'neighbors(e-1) → [e-2]', kind: 'sync'},
      {from: 'Writer', to: 'Graph store', label: 'add_edge(e-1, e-3)', kind: 'sync'},
      {from: 'Writer', to: 'Redis', label: 'INCR adj:e-1:version · INCR adj:e-3:version', kind: 'sync'},
      {from: 'Reader', to: 'Redis', label: 'SET adj:e-1 {version 0, [e-2]} EX 300', kind: 'sync'},
      {from: 'Reader', to: 'Redis', label: 'next read: stamp 0 ≠ counter 1 → reload', kind: 'sync'},
    ],
  },
  checks: [
    {
      id: 'ttl',
      title: 'Caches a neighbour list for at most 5 minutes',
      detail:
        'Every fill of `adj:{id}` carries `EX 300` (`TTL_S`); the starter caches with no expiry, so an entry a missed invalidation left behind is served forever.',
      match: {
        python: {all: [/TTL_S\s*=\s*300\b/, /\.set\([^\n]*adj_key\([^\n]*ex\s*=\s*TTL_S|\.setex\(\s*adj_key\(/]},
        typescript: {all: [/TTL_S\s*=\s*300\b/, /\.set\([^\n]*adjKey\([^\n]*['"]EX['"]\s*,\s*TTL_S/]},
        go: {all: [/ttl\s*=\s*300\s*\*\s*time\.Second/, /\.Set\([^\n]*adjKey\([^\n]*,\s*ttl\)/]},
        scala: {all: [/TtlSeconds\s*=\s*300L?\b/, /setex\(\s*adjKey\([^\n]*TtlSeconds/]},
        cpp: {all: [/kTtl\{300\}/, /\.set\(\s*adjKey\([^\n]*kTtl\)/]},
      },
    },
    {
      id: 'version-stamp',
      title: 'Stamps an entry with the version read before the load',
      detail:
        'The reader reads `version_key`/`versionKey` before `store.neighbors`, stores `{"version", "neighbors"}` and reloads on a mismatch, so a list loaded before a concurrent edge change is never served afterwards.',
      match: {
        python: {
          all: [/def version_key/, /\.get\(\s*version_key\(/, /["']version["']/],
          order: [/\.get\(\s*version_key\(/, /store\.neighbors\(/],
        },
        typescript: {
          all: [/versionKey\s*=|function versionKey/, /\.get\(\s*versionKey\(/, /version/],
          order: [/\.get\(\s*versionKey\(/, /await neighbors\(/],
        },
        go: {
          all: [/func versionKey/, /\.Get\([^\n]*versionKey\(/, /"version"/],
          order: [/\.Get\([^\n]*versionKey\(/, /store\.Neighbors\(/],
        },
        scala: {
          all: [/def versionKey/, /jedis\.get\(\s*versionKey\(/, /"version"/],
          order: [/jedis\.get\(\s*versionKey\(/, /Store\.neighbors\(/],
        },
        cpp: {
          all: [/versionKey\(/, /\.get\(\s*versionKey\(/, /"version"/],
          order: [/\.get\(\s*versionKey\(/, /store::neighbors\(/],
        },
      },
    },
    {
      id: 'both-ends',
      title: 'An edge bumps the version of both ends',
      detail:
        '`apply_edge`/`applyEdge` increments `adj:{left}:version` and `adj:{right}:version`; the starter deletes the left entry only, which races a reader and leaves the right end stale.',
      match: {
        python: {all: [/\.incr\(\s*version_key\(/]},
        typescript: {all: [/\.incr\(\s*versionKey\(/]},
        go: {all: [/\.Incr\([^\n]*versionKey\(/]},
        scala: {all: [/jedis\.incr\(\s*versionKey\(/]},
        cpp: {all: [/\.incr\(\s*versionKey\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json

import redis

from graph import store  # neighbors, add_edge

r = redis.Redis(host="redis", port=6379, decode_responses=True)


def adj_key(entity_id: str) -> str:
    return f"adj:{entity_id}"


def read_neighbors(entity_id: str) -> list[str]:
    """The entity's neighbour ids, sorted, through the cache."""
    # TODO: this starter has three flaws. The task says where to look; the checks say what must change.
    raw = r.get(adj_key(entity_id))
    if raw is not None:
        return json.loads(raw)
    found = store.neighbors(entity_id)
    r.set(adj_key(entity_id), json.dumps(found))
    return found


def apply_edge(left: str, right: str) -> None:
    """Store the edge and invalidate what the cache holds for it."""
    store.add_edge(left, right)
    r.delete(adj_key(left))
`,
      solution: `import json

import redis

from graph import store  # neighbors, add_edge

r = redis.Redis(host="redis", port=6379, decode_responses=True)

TTL_S = 300


def adj_key(entity_id: str) -> str:
    return f"adj:{entity_id}"


def version_key(entity_id: str) -> str:
    return f"adj:{entity_id}:version"


def read_neighbors(entity_id: str) -> list[str]:
    """The entity's neighbour ids, sorted, through the cache."""
    # The version is read before the neighbours: a change that lands after it makes this fill stale on arrival.
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
    """Store the edge, then make every cached list of both ends unreachable."""
    store.add_edge(left, right)
    # A bump, not a delete: a reader that loaded the old list stamps it with the old version.
    r.incr(version_key(left))
    r.incr(version_key(right))
`,
    },
    typescript: {
      starter: `import Redis from 'ioredis';

import {addEdge, neighbors} from 'graph/store';

const redis = new Redis({host: 'redis', port: 6379});

export const adjKey = (entityId: string): string => \`adj:\${entityId}\`;

/** The entity's neighbour ids, sorted, through the cache. */
export async function readNeighbors(entityId: string): Promise<string[]> {
  // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
  const raw = await redis.get(adjKey(entityId));
  if (raw !== null) return JSON.parse(raw) as string[];
  const found = await neighbors(entityId);
  await redis.set(adjKey(entityId), JSON.stringify(found));
  return found;
}

/** Store the edge and invalidate what the cache holds for it. */
export async function applyEdge(left: string, right: string): Promise<void> {
  await addEdge(left, right);
  await redis.del(adjKey(left));
}
`,
      solution: `import Redis from 'ioredis';

import {addEdge, neighbors} from 'graph/store';

const redis = new Redis({host: 'redis', port: 6379});

export const TTL_S = 300;

export const adjKey = (entityId: string): string => \`adj:\${entityId}\`;
export const versionKey = (entityId: string): string => \`adj:\${entityId}:version\`;

/** The entity's neighbour ids, sorted, through the cache. */
export async function readNeighbors(entityId: string): Promise<string[]> {
  // The version is read before the neighbours: a change that lands after it makes this fill stale on arrival.
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

/** Store the edge, then make every cached list of both ends unreachable. */
export async function applyEdge(left: string, right: string): Promise<void> {
  await addEdge(left, right);
  // A bump, not a delete: a reader that loaded the old list stamps it with the old version.
  await redis.incr(versionKey(left));
  await redis.incr(versionKey(right));
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"

	"github.com/redis/go-redis/v9"

	"graph/store" // store.Neighbors, store.AddEdge
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

func adjKey(entityID string) string { return "adj:" + entityID }

// readNeighbors is the entity's neighbour ids, sorted, through the cache.
func readNeighbors(ctx context.Context, entityID string) ([]string, error) {
	// TODO: this starter has three flaws. The task says where to look; the checks say what must change.
	if raw, err := rdb.Get(ctx, adjKey(entityID)).Result(); err == nil {
		cached := []string{}
		if json.Unmarshal([]byte(raw), &cached) == nil {
			return cached, nil
		}
	}
	found := store.Neighbors(ctx, entityID)
	raw, _ := json.Marshal(found)
	if err := rdb.Set(ctx, adjKey(entityID), string(raw), 0).Err(); err != nil {
		return nil, err
	}
	return found, nil
}

// applyEdge stores the edge and invalidates what the cache holds for it.
func applyEdge(ctx context.Context, left, right string) error {
	store.AddEdge(ctx, left, right)
	return rdb.Del(ctx, adjKey(left)).Err()
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"time"

	"github.com/redis/go-redis/v9"

	"graph/store" // store.Neighbors, store.AddEdge
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const ttl = 300 * time.Second

type cachedList struct {
	Version   int64    \`json:"version"\`
	Neighbors []string \`json:"neighbors"\`
}

func adjKey(entityID string) string     { return "adj:" + entityID }
func versionKey(entityID string) string { return "adj:" + entityID + ":version" }

// readNeighbors is the entity's neighbour ids, sorted, through the cache.
func readNeighbors(ctx context.Context, entityID string) ([]string, error) {
	// The version is read before the neighbours: a change that lands after it makes this fill stale on arrival.
	version, err := rdb.Get(ctx, versionKey(entityID)).Int64()
	if err != nil && err != redis.Nil {
		return nil, err
	}
	if raw, err := rdb.Get(ctx, adjKey(entityID)).Result(); err == nil {
		cached := cachedList{}
		if json.Unmarshal([]byte(raw), &cached) == nil && cached.Version == version {
			return cached.Neighbors, nil
		}
	}
	found := store.Neighbors(ctx, entityID)
	raw, _ := json.Marshal(cachedList{Version: version, Neighbors: found})
	if err := rdb.Set(ctx, adjKey(entityID), string(raw), ttl).Err(); err != nil {
		return nil, err
	}
	return found, nil
}

// applyEdge stores the edge, then makes every cached list of both ends unreachable.
func applyEdge(ctx context.Context, left, right string) error {
	store.AddEdge(ctx, left, right)
	// A bump, not a delete: a reader that loaded the old list stamps it with the old version.
	if err := rdb.Incr(ctx, versionKey(left)).Err(); err != nil {
		return err
	}
	return rdb.Incr(ctx, versionKey(right)).Err()
}
`,
    },
    scala: {
      starter: `import redis.clients.jedis.JedisPooled
import spray.json._

import graph.Store // Store.neighbors, Store.addEdge

object State {
  val jedis = new JedisPooled("redis", 6379)

  def adjKey(entityId: String): String = s"adj:$entityId"

  /** The entity's neighbour ids, sorted, through the cache. */
  def readNeighbors(entityId: String): List[String] = {
    // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
    Option(jedis.get(adjKey(entityId))) match {
      case Some(raw) =>
        raw.parseJson match {
          case JsArray(items) => items.collect { case JsString(id) => id }.toList
          case _              => Nil
        }
      case None =>
        val found = Store.neighbors(entityId)
        jedis.set(adjKey(entityId), JsArray(found.map(JsString(_)).toVector).compactPrint)
        found
    }
  }

  /** Store the edge and invalidate what the cache holds for it. */
  def applyEdge(left: String, right: String): Unit = {
    Store.addEdge(left, right)
    jedis.del(adjKey(left))
  }
}
`,
      solution: `import redis.clients.jedis.JedisPooled
import spray.json._

import graph.Store // Store.neighbors, Store.addEdge

object State {
  val TtlSeconds = 300L

  val jedis = new JedisPooled("redis", 6379)

  def adjKey(entityId: String): String = s"adj:$entityId"
  def versionKey(entityId: String): String = s"adj:$entityId:version"

  /** The entity's neighbour ids, sorted, through the cache. */
  def readNeighbors(entityId: String): List[String] = {
    // The version is read before the neighbours: a change that lands after it makes this fill stale on arrival.
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

  /** Store the edge, then make every cached list of both ends unreachable. */
  def applyEdge(left: String, right: String): Unit = {
    Store.addEdge(left, right)
    // A bump, not a delete: a reader that loaded the old list stamps it with the old version.
    jedis.incr(versionKey(left))
    jedis.incr(versionKey(right))
  }
}
`,
    },
    cpp: {
      starter: `#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <string>
#include <vector>

#include "graph/store.h"  // store::neighbors, store::addEdge

using json = nlohmann::json;

sw::redis::Redis redis("tcp://redis:6379");

std::string adjKey(const std::string& entity_id) { return "adj:" + entity_id; }

// The entity's neighbour ids, sorted, through the cache.
std::vector<std::string> readNeighbors(const std::string& entity_id) {
  // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
  const auto raw = redis.get(adjKey(entity_id));
  if (raw) return json::parse(*raw).get<std::vector<std::string>>();
  const std::vector<std::string> found = store::neighbors(entity_id);
  redis.set(adjKey(entity_id), json(found).dump());
  return found;
}

// Store the edge and invalidate what the cache holds for it.
void applyEdge(const std::string& left, const std::string& right) {
  store::addEdge(left, right);
  redis.del(adjKey(left));
}
`,
      solution: `#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <chrono>
#include <string>
#include <vector>

#include "graph/store.h"  // store::neighbors, store::addEdge

using json = nlohmann::json;

sw::redis::Redis redis("tcp://redis:6379");

constexpr std::chrono::seconds kTtl{300};

std::string adjKey(const std::string& entity_id) { return "adj:" + entity_id; }
std::string versionKey(const std::string& entity_id) { return "adj:" + entity_id + ":version"; }

// The entity's neighbour ids, sorted, through the cache.
std::vector<std::string> readNeighbors(const std::string& entity_id) {
  // The version is read before the neighbours: a change that lands after it makes this fill stale on arrival.
  const auto counter = redis.get(versionKey(entity_id));
  const long long version = counter ? std::stoll(*counter) : 0;
  const auto raw = redis.get(adjKey(entity_id));
  if (raw) {
    const json entry = json::parse(*raw, nullptr, false);
    if (entry.is_object() && entry.value("version", -1LL) == version) return entry.at("neighbors").get<std::vector<std::string>>();
  }
  const std::vector<std::string> found = store::neighbors(entity_id);
  redis.set(adjKey(entity_id), json{{"version", version}, {"neighbors", found}}.dump(), kTtl);
  return found;
}

// Store the edge, then make every cached list of both ends unreachable.
void applyEdge(const std::string& left, const std::string& right) {
  store::addEdge(left, right);
  // A bump, not a delete: a reader that loaded the old list stamps it with the old version.
  redis.incr(versionKey(left));
  redis.incr(versionKey(right));
}
`,
    },
  },
  harness: {
    python: `import json


def _edge(ctx, left, right):
    ctx.redis.sadd(f"edges:{left}", right)
    ctx.redis.sadd(f"edges:{right}", left)


def check_ttl(ctx):
    m = ctx.load("state")
    _edge(ctx, "e-1", "e-2")
    assert m.read_neighbors("e-1") == ["e-2"], f"read_neighbors(e-1) gave {m.read_neighbors('e-1')}, expected ['e-2']"
    ttl = ctx.redis.ttl("adj:e-1")
    assert 0 < ttl <= 300, f"adj:e-1 has TTL {ttl}: a cached neighbour list must expire within 5 minutes (EX 300), or an entry a missed invalidation left behind is served forever"


def check_version_stamp(ctx):
    m = ctx.load("state")
    _edge(ctx, "e-1", "e-2")

    def other_worker():
        # Another worker adds e-1 to e-3 while this read is between its load and its fill.
        _edge(ctx, "e-1", "e-3")
        ctx.redis.incr("adj:e-1:version")
        ctx.redis.incr("adj:e-3:version")

    probe = ctx.redis_after("edges:e-1", other_worker)
    first = m.read_neighbors("e-1")
    assert probe.fired, "read_neighbors never loaded edges:e-1 from the graph store on a miss"
    assert first in (["e-2"], ["e-2", "e-3"]), f"read_neighbors(e-1) gave {first}"
    raw = ctx.redis.get("adj:e-1")
    entry = json.loads(raw) if raw else None
    assert isinstance(entry, dict) and "version" in entry, f"adj:e-1 holds {raw!r}: a cached list must carry the version it was built from"
    again = m.read_neighbors("e-1")
    assert again == ["e-2", "e-3"], f"an edge change raced the fill and read_neighbors still serves {again}: the entry was filled from a list that was stale on arrival. Read adj:e-1:version before loading and stamp the entry with it"


def check_both_ends(ctx):
    m = ctx.load("state")
    _edge(ctx, "e-1", "e-2")
    assert m.read_neighbors("e-1") == ["e-2"] and m.read_neighbors("e-3") == [], "the first reads must cache e-1 -> [e-2] and e-3 -> []"
    m.apply_edge("e-1", "e-3")
    assert sorted(ctx.redis.smembers("edges:e-3")) == ["e-1"], "apply_edge must store the edge with store.add_edge"
    left = m.read_neighbors("e-1")
    assert left == ["e-2", "e-3"], f"after apply_edge(e-1, e-3) read_neighbors(e-1) serves {left}"
    right = m.read_neighbors("e-3")
    assert right == ["e-1"], f"after apply_edge(e-1, e-3) read_neighbors(e-3) still serves {right}: an edge changes the neighbour lists of both its ends"
    versions = (ctx.redis.get("adj:e-1:version"), ctx.redis.get("adj:e-3:version"))
    assert versions == ("1", "1"), f"apply_edge must increment adj:e-1:version and adj:e-3:version, they hold {versions}: a delete races a reader's fill, a version bump does not"
`,
    typescript: `function edge(ctx, left: string, right: string): void {
  ctx.redis.sadd(\`edges:\${left}\`, right);
  ctx.redis.sadd(\`edges:\${right}\`, left);
}

export async function check_ttl(ctx) {
  const m = ctx.load('state');
  edge(ctx, 'e-1', 'e-2');
  assert.deepEqual(await m.readNeighbors('e-1'), ['e-2'], 'readNeighbors(e-1) must give [e-2]');
  const ttl = ctx.redis.ttl('adj:e-1');
  assert(0 < ttl && ttl <= 300, \`adj:e-1 has TTL \${ttl}: a cached neighbour list must expire within 5 minutes (EX 300), or an entry a missed invalidation left behind is served forever\`);
}

export async function check_version_stamp(ctx) {
  const m = ctx.load('state');
  edge(ctx, 'e-1', 'e-2');
  // Another worker adds e-1 to e-3 while this read is between its load and its fill.
  const probe = ctx.redisAfter('edges:e-1', () => {
    edge(ctx, 'e-1', 'e-3');
    ctx.redis.incr('adj:e-1:version');
    ctx.redis.incr('adj:e-3:version');
  });
  const first = await m.readNeighbors('e-1');
  assert(probe.fired, 'readNeighbors never loaded edges:e-1 from the graph store on a miss');
  assert(['["e-2"]', '["e-2","e-3"]'].includes(JSON.stringify(first)), \`readNeighbors(e-1) gave \${JSON.stringify(first)}\`);
  const raw = ctx.redis.get('adj:e-1');
  const entry = raw ? JSON.parse(raw) : null;
  assert(entry !== null && typeof entry === 'object' && !Array.isArray(entry) && 'version' in entry, \`adj:e-1 holds \${raw}: a cached list must carry the version it was built from\`);
  const again = await m.readNeighbors('e-1');
  assert.deepEqual(again, ['e-2', 'e-3'], \`an edge change raced the fill and readNeighbors still serves \${JSON.stringify(again)}: the entry was filled from a list that was stale on arrival. Read adj:e-1:version before loading and stamp the entry with it\`);
}

export async function check_both_ends(ctx) {
  const m = ctx.load('state');
  edge(ctx, 'e-1', 'e-2');
  assert.deepEqual(await m.readNeighbors('e-1'), ['e-2'], 'the first read must cache e-1 -> [e-2]');
  assert.deepEqual(await m.readNeighbors('e-3'), [], 'the first read must cache e-3 -> []');
  await m.applyEdge('e-1', 'e-3');
  assert.deepEqual(ctx.redis.smembers('edges:e-3'), ['e-1'], 'applyEdge must store the edge with addEdge');
  const left = await m.readNeighbors('e-1');
  assert.deepEqual(left, ['e-2', 'e-3'], \`after applyEdge(e-1, e-3) readNeighbors(e-1) serves \${JSON.stringify(left)}\`);
  const right = await m.readNeighbors('e-3');
  assert.deepEqual(right, ['e-1'], \`after applyEdge(e-1, e-3) readNeighbors(e-3) still serves \${JSON.stringify(right)}: an edge changes the neighbour lists of both its ends\`);
  const versions = [ctx.redis.get('adj:e-1:version'), ctx.redis.get('adj:e-3:version')];
  assert.deepEqual(versions, ['1', '1'], \`applyEdge must increment adj:e-1:version and adj:e-3:version, they hold \${JSON.stringify(versions)}: a delete races a reader's fill, a version bump does not\`);
}
`,
    go: `package main

import (
	"context"
	"encoding/json"
	"strings"

	"leetbuild/harness"
)

var stateBg = context.Background()

func stateEdge(ctx *harness.Ctx, left, right string) {
	ctx.Redis.Do("SADD", "edges:"+left, right)
	ctx.Redis.Do("SADD", "edges:"+right, left)
}

func stateRead(ctx *harness.Ctx, entityID string) string {
	ids, err := readNeighbors(stateBg, entityID)
	ctx.NoError(err, "readNeighbors(%s) failed", entityID)
	return strings.Join(ids, ",")
}

func CheckTtl(ctx *harness.Ctx) {
	stateEdge(ctx, "e-1", "e-2")
	ctx.Equal(stateRead(ctx, "e-1"), "e-2", "readNeighbors(e-1)")
	ttl := ctx.Redis.TTL("adj:e-1")
	ctx.Assert(0 < ttl && ttl <= 300, "adj:e-1 has TTL %d: a cached neighbour list must expire within 5 minutes (EX 300), or an entry a missed invalidation left behind is served forever", ttl)
}

func CheckVersionStamp(ctx *harness.Ctx) {
	stateEdge(ctx, "e-1", "e-2")
	// Another worker adds e-1 to e-3 while this read is between its load and its fill.
	probe := ctx.Redis.After("edges:e-1", func() any {
		stateEdge(ctx, "e-1", "e-3")
		ctx.Redis.Do("INCR", "adj:e-1:version")
		ctx.Redis.Do("INCR", "adj:e-3:version")
		return nil
	})
	first := stateRead(ctx, "e-1")
	ctx.Assert(probe.Fired, "readNeighbors never loaded edges:e-1 from the graph store on a miss")
	ctx.Assert(first == "e-2" || first == "e-2,e-3", "readNeighbors(e-1) gave %q", first)
	raw, _ := ctx.Redis.Get("adj:e-1")
	entry := map[string]any{}
	ctx.Assert(json.Unmarshal([]byte(raw), &entry) == nil && entry["version"] != nil, "adj:e-1 holds %q: a cached list must carry the version it was built from", raw)
	again := stateRead(ctx, "e-1")
	ctx.Assert(again == "e-2,e-3", "an edge change raced the fill and readNeighbors still serves %q: the entry was filled from a list that was stale on arrival. Read adj:e-1:version before loading and stamp the entry with it", again)
}

func CheckBothEnds(ctx *harness.Ctx) {
	stateEdge(ctx, "e-1", "e-2")
	ctx.Equal(stateRead(ctx, "e-1"), "e-2", "the first read must cache e-1 -> [e-2]")
	ctx.Equal(stateRead(ctx, "e-3"), "", "the first read must cache e-3 -> []")
	ctx.NoError(applyEdge(stateBg, "e-1", "e-3"), "applyEdge(e-1, e-3) failed")
	ctx.Equal(ctx.Redis.SMembers("edges:e-3"), []string{"e-1"}, "applyEdge must store the edge with store.AddEdge; edges:e-3")
	left := stateRead(ctx, "e-1")
	ctx.Assert(left == "e-2,e-3", "after applyEdge(e-1, e-3) readNeighbors(e-1) serves %q", left)
	right := stateRead(ctx, "e-3")
	ctx.Assert(right == "e-1", "after applyEdge(e-1, e-3) readNeighbors(e-3) still serves %q: an edge changes the neighbour lists of both its ends", right)
	v1, _ := ctx.Redis.Get("adj:e-1:version")
	v3, _ := ctx.Redis.Get("adj:e-3:version")
	ctx.Assert(v1 == "1" && v3 == "1", "applyEdge must increment adj:e-1:version and adj:e-3:version, they hold %q and %q: a delete races a reader's fill, a version bump does not", v1, v3)
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <string>
#include <vector>

namespace {

void stateEdge(harness::Ctx& ctx, const std::string& left, const std::string& right) {
  ctx.Redis.Do("SADD", "edges:" + left, right);
  ctx.Redis.Do("SADD", "edges:" + right, left);
}

std::string stateRead(const std::string& entity_id) {
  std::string out;
  for (const auto& id : readNeighbors(entity_id)) out += (out.empty() ? "" : ",") + id;
  return out;
}

}  // namespace

void CheckTtl(harness::Ctx& ctx) {
  stateEdge(ctx, "e-1", "e-2");
  ctx.Equal(stateRead("e-1"), "e-2", "readNeighbors(e-1)");
  const long long ttl = ctx.Redis.TTL("adj:e-1");
  ctx.Assert(0 < ttl && ttl <= 300, "adj:e-1 has TTL %d: a cached neighbour list must expire within 5 minutes (EX 300), or an entry a missed invalidation left behind is served forever", ttl);
}

void CheckVersionStamp(harness::Ctx& ctx) {
  stateEdge(ctx, "e-1", "e-2");
  bool fired = false;
  // Another worker adds e-1 to e-3 while this read is between its load and its fill.
  ctx.Redis.After("edges:e-1", [&] {
    fired = true;
    stateEdge(ctx, "e-1", "e-3");
    ctx.Redis.Do("INCR", "adj:e-1:version");
    ctx.Redis.Do("INCR", "adj:e-3:version");
  });
  const std::string first = stateRead("e-1");
  ctx.Assert(fired, "readNeighbors never loaded edges:e-1 from the graph store on a miss");
  ctx.Assert(first == "e-2" || first == "e-2,e-3", "readNeighbors(e-1) gave %q", first);
  const std::string raw = ctx.Redis.Get("adj:e-1").value_or("");
  const auto entry = nlohmann::json::parse(raw, nullptr, false);
  ctx.Assert(entry.is_object() && entry.contains("version"), "adj:e-1 holds %q: a cached list must carry the version it was built from", raw);
  const std::string again = stateRead("e-1");
  ctx.Assert(again == "e-2,e-3", "an edge change raced the fill and readNeighbors still serves %q: the entry was filled from a list that was stale on arrival. Read adj:e-1:version before loading and stamp the entry with it", again);
}

void CheckBothEnds(harness::Ctx& ctx) {
  stateEdge(ctx, "e-1", "e-2");
  ctx.Equal(stateRead("e-1"), "e-2", "the first read must cache e-1 -> [e-2]");
  ctx.Equal(stateRead("e-3"), "", "the first read must cache e-3 -> []");
  applyEdge("e-1", "e-3");
  ctx.Equal(ctx.Redis.SMembers("edges:e-3"), std::vector<std::string>{"e-1"}, "applyEdge must store the edge with store::addEdge; edges:e-3");
  const std::string left = stateRead("e-1");
  ctx.Assert(left == "e-2,e-3", "after applyEdge(e-1, e-3) readNeighbors(e-1) serves %q", left);
  const std::string right = stateRead("e-3");
  ctx.Assert(right == "e-1", "after applyEdge(e-1, e-3) readNeighbors(e-3) still serves %q: an edge changes the neighbour lists of both its ends", right);
  const std::string v1 = ctx.Redis.Get("adj:e-1:version").value_or("");
  const std::string v3 = ctx.Redis.Get("adj:e-3:version").value_or("");
  ctx.Assert(v1 == "1" && v3 == "1", "applyEdge must increment adj:e-1:version and adj:e-3:version, they hold %q and %q: a delete races a reader's fill, a version bump does not", v1, v3);
}
`,
  },
  hints: [
    'Add an edge while a neighbour read is in flight, then read again: the new neighbour is missing, and it stays missing; the other end of the edge never shows it either.',
    'A delete only removes what is in Redis at that instant. A reader that loaded the list before the delete writes it back afterwards, and nothing in the entry says it is old.',
    'Read `adj:{id}:version` first, store `{"version", "neighbors"}` with `ex=TTL_S`, reload when the stamp differs from the counter; in `apply_edge`, `INCR` the version of both ends instead of deleting.',
  ],
  debrief: `A version counter turns invalidation from an event that has to win a race into a fact every reader checks. The order inside the reader is the whole trick: the version read before the load is the oldest state the loaded list could reflect, so stamping with it can only make an entry look older than it is, never newer. Bumping both ends follows from storing an edge on both ends. The TTL is the backstop for every path that forgets to bump, such as a bulk import writing the store directly. Large graph services keep the counter per entity as here and add a hot-entity limit, so a node with millions of edges is paged from the store rather than cached as one value.`,
};
