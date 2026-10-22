import type {Step} from '@/lib/types';

export const stateStep: Step = {
  id: 'state',
  title: 'Redis published-pointer swap with a single reference',
  concept: 'redis',
  file: 'state',
  focus: ['api', 'redis', 'db'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: publish a product and the
storefront reads the new fields, so the demo passes. It hides three production flaws that only show
up under concurrency. Review it, fix it, and prove the fix.

Implement the published snapshot store used by both the publish path and the storefront read.

- **The published snapshot is one object.** Publishing writes the **whole** version under its own
  key (\`catalog:{product_id}:v{version}\`) and then swaps the pointer
  (\`catalog:{product_id}:published\`) — a single atomic write. Swapping **per-field values** into a
  shared hash lets a reader observe the new price together with the old title.
- **A reader resolves exactly one pointer per request.** Read the pointer once, then read exactly
  that snapshot. Two reads of the pointer — or a pointer plus a shared hash — can mix two versions
  inside one response.
- **A failed publish leaves the previous pointer untouched.** The swap is a compare-and-set: it only
  moves when the pointer still holds the version the caller expected, so a publish that fails after
  writing its snapshot cannot half-promote itself. The old version stays readable.
- **One pointer per product.** A single published pointer is what makes the swap atomic; keeping a
  global pointer and a per-region pointer updated separately lets regions disagree about what is
  live.

**Failure mode the checks target.** The draft applies the publish field by field into the shared
catalog hash, so a concurrent reader sees a product assembled from two versions; it keeps two
pointers that are updated one after the other, so a region can serve the version the other one has
already replaced; and its pointer write is unconditional, so a publish that fails halfway still
moves what the storefront reads.`,
  sequence: {
    participants: ['Catalog API', 'Redis', 'Storefront read'],
    messages: [
      {from: 'Catalog API', to: 'Redis', label: 'SET catalog:{id}:v42 {whole snapshot}', kind: 'sync'},
      {from: 'Catalog API', to: 'Redis', label: 'EVAL swap catalog:{id}:published expected=41', kind: 'sync'},
      {from: 'Redis', to: 'Catalog API', label: '1 swapped · 0 pointer already moved', kind: 'reply'},
      {from: 'Storefront read', to: 'Redis', label: 'GET catalog:{id}:published', kind: 'sync'},
      {from: 'Redis', to: 'Storefront read', label: '42', kind: 'reply'},
      {from: 'Storefront read', to: 'Redis', label: 'GET catalog:{id}:v42', kind: 'sync'},
      {from: 'Redis', to: 'Storefront read', label: 'one complete version', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'atomic-swap',
      title: 'Swaps the published pointer in one atomic write',
      detail:
        'The pointer is moved by a single server-side write (`EVAL`/`NewScript`/`eval`) that sets the pointer key, and the snapshot is written under its own key first. The draft writes the fields into a shared hash and then moves the pointer, so a reader can observe a half-applied publish.',
      match: {
        python: {all: [/PUBLISH_LUA/, /\.eval\(/, /'SET'|"SET"/]},
        typescript: {all: [/PUBLISH_LUA/, /\.eval\(/, /'SET'|"SET"/]},
        go: {all: [/publishScript/, /\.Run\(/, /'SET'|"SET"/]},
        scala: {all: [/PublishLua/, /\.eval\(/, /SET/]},
        cpp: {all: [/kPublishLua/, /\.eval</, /SET/]},
      },
    },
    {
      id: 'one-pointer',
      title: 'Keeps one published pointer per product',
      detail:
        'There is exactly one pointer key per product; no global pointer plus a per-region one that is updated separately. Two pointers that are swapped one after the other let regions disagree about what is live.',
      match: {
        python: {all: [/PUBLISHED_POINTER/], none: [/[Rr]egion/]},
        typescript: {all: [/PUBLISHED_POINTER/], none: [/[Rr]egion/]},
        go: {all: [/publishedPointer\(/], none: [/[Rr]egion/]},
        scala: {all: [/publishedPointer\(/], none: [/[Rr]egion/]},
        cpp: {all: [/publishedPointer\(/], none: [/[Rr]egion/]},
      },
    },
    {
      id: 'single-read',
      title: 'Resolves exactly one version per read',
      detail:
        'The read path resolves the pointer once (`publishedPointer`/`published_pointer`) and loads exactly that snapshot (`snapshotKey`/`snapshot_key`); it never reads a shared hash of fields. Two independent reads can mix two versions in one response.',
      match: {
        python: {all: [/def read_published/, /published_pointer\(/, /snapshot_key\(/], none: [/HGETALL/]},
        typescript: {all: [/readPublished\(/, /publishedPointer\(/, /snapshotKey\(/], none: [/hgetall\(/]},
        go: {all: [/ReadPublished\(/, /publishedPointer\(/, /snapshotKey\(/], none: [/HGetAll\(/]},
        scala: {all: [/readPublished\(/, /publishedPointer\(/, /snapshotKey\(/], none: [/hgetAll/i]},
        cpp: {all: [/readPublished\(/, /publishedPointer\(/, /snapshotKey\(/], none: [/hgetall/i]},
      },
    },
    {
      id: 'no-field-swap',
      title: 'Writes the whole snapshot, never per-field',
      detail:
        'The version is written as one value under a versioned key (`SET`), not as per-field `HSET`s into a hash shared by every version. Per-field writes are what tear a product in half for a concurrent reader.',
      match: {
        python: {all: [/\.set\(/, /snapshot_key\(/], none: [/\bhset\b/i]},
        typescript: {all: [/\.set\(/, /snapshotKey\(/], none: [/\bhset\b/i]},
        go: {all: [/\.Set\(/, /snapshotKey\(/], none: [/\bHSet\(/]},
        scala: {all: [/\.set\(/, /snapshotKey\(/], none: [/\bhset/i]},
        cpp: {all: [/\.set\(/, /snapshotKey\(/], none: [/\bhset/i]},
      },
    },
    {
      id: 'cas-swap',
      title: 'Only swaps the pointer a publish still expects',
      detail:
        'The swap is conditional on the version the caller expected (`expected` threaded into the script), so a publish that fails after writing its snapshot leaves the previous pointer untouched. The draft sets the pointer unconditionally.',
      match: {
        python: {all: [/PUBLISH_LUA/, /expected/], none: [/\.set\([^)]*pointer/]},
        typescript: {all: [/PUBLISH_LUA/, /expected/], none: [/\.set\([^)]*pointer/]},
        go: {all: [/publishScript/, /expected/], none: [/\.Set\([^)]*pointer/]},
        scala: {all: [/PublishLua/, /expected/], none: [/\.set\([^)]*pointer/]},
        cpp: {all: [/kPublishLua/, /expected/], none: [/\.set\([^)]*pointer/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)


def publish_snapshot(product_id: str, draft: dict) -> int:
    # TODO: this draft swaps per-field values into one shared hash, keeps a global and a per-region
    # pointer updated separately, and swaps the pointer unconditionally, so a failed publish still
    # moves what the storefront reads. Review all three.
    r.hset(f"catalog:{product_id}", mapping=draft["fields"])
    r.set(f"catalog:{product_id}:pointer", draft["version"])
    r.set(f"catalog:{product_id}:region:{draft['region']}:pointer", draft["version"])
    return draft["version"]


def read_published(product_id: str) -> dict:
    version = r.get(f"catalog:{product_id}:pointer")
    fields = r.hgetall(f"catalog:{product_id}")
    return {"version": version, "fields": fields}
`,
      solution: `import json

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

PUBLISHED_POINTER = "catalog:{product_id}:published"

PUBLISH_LUA = """
local current = redis.call('GET', KEYS[1])
if current and current ~= ARGV[1] then
  return 0
end
redis.call('SET', KEYS[1], ARGV[2])
return 1
"""


def snapshot_key(product_id: str, version: int) -> str:
    return f"catalog:{product_id}:v{version}"


def published_pointer(product_id: str) -> str:
    return PUBLISHED_POINTER.format(product_id=product_id)


def publish_snapshot(product_id: str, version: int, snapshot: dict, expected: int | None) -> bool:
    # The whole version goes under its own key first, so no reader can observe a half-applied row.
    r.set(snapshot_key(product_id, version), json.dumps(snapshot))
    # One atomic compare-and-set: the pointer only moves when it still holds the expected version,
    # so a publish that fails here leaves the previous version live.
    swapped = r.eval(PUBLISH_LUA, 1, published_pointer(product_id), str(expected or ""), str(version))
    return bool(swapped)


def read_published(product_id: str) -> dict | None:
    # Exactly one pointer read, then exactly that snapshot: two versions can never be mixed.
    version = r.get(published_pointer(product_id))
    if version is None:
        return None
    payload = r.get(snapshot_key(product_id, int(version)))
    if payload is None:
        return None
    return json.loads(payload)
`,
    },
    typescript: {
      starter: `/** Published snapshot: a model-generated draft that swaps fields one by one. */
import {Redis} from 'ioredis';

const r = new Redis('redis://redis:6379');

interface Draft {
  version: number;
  region: string;
  fields: Record<string, string>;
}

export async function publishSnapshot(productId: string, draft: Draft): Promise<number> {
  // TODO: this draft swaps per-field values into one shared hash, keeps a global and a per-region
  // pointer updated separately, and swaps the pointer unconditionally, so a failed publish still
  // moves what the storefront reads. Review all three.
  await r.hset(\`catalog:\${productId}\`, draft.fields);
  await r.set(\`catalog:\${productId}:pointer\`, String(draft.version));
  await r.set(\`catalog:\${productId}:region:\${draft.region}:pointer\`, String(draft.version));
  return draft.version;
}

export async function readPublished(productId: string): Promise<Record<string, unknown>> {
  const version = await r.get(\`catalog:\${productId}:pointer\`);
  const fields = await r.hgetall(\`catalog:\${productId}\`);
  return {version, fields};
}
`,
      solution: `/** Published snapshot: one whole version per key, one pointer swapped by compare-and-set. */
import {Redis} from 'ioredis';

const r = new Redis('redis://redis:6379');

const PUBLISHED_POINTER = 'catalog:{product_id}:published';

const PUBLISH_LUA = \`
local current = redis.call('GET', KEYS[1])
if current and current ~= ARGV[1] then
  return 0
end
redis.call('SET', KEYS[1], ARGV[2])
return 1
\`;

function snapshotKey(productId: string, version: number): string {
  return \`catalog:\${productId}:v\${version}\`;
}

function publishedPointer(productId: string): string {
  return PUBLISHED_POINTER.replace('{product_id}', productId);
}

export async function publishSnapshot(
  productId: string,
  version: number,
  snapshot: Record<string, unknown>,
  expected: number | null,
): Promise<boolean> {
  await r.set(snapshotKey(productId, version), JSON.stringify(snapshot));
  const swapped = await r.eval(
    PUBLISH_LUA,
    1,
    publishedPointer(productId),
    String(expected ?? ''),
    String(version),
  );
  return swapped === 1;
}

export async function readPublished(productId: string): Promise<Record<string, unknown> | null> {
  const version = await r.get(publishedPointer(productId));
  if (version === null) return null;
  const payload = await r.get(snapshotKey(productId, Number(version)));
  if (payload === null) return null;
  return JSON.parse(payload) as Record<string, unknown>;
}
`,
    },
    go: {
      starter: `package main

import (
	"context"

	"github.com/redis/go-redis/v9"
)

var rdb *redis.Client

func publishSnapshot(ctx context.Context, productID string, draft map[string]any) (int, error) {
	// TODO: this draft swaps per-field values into one shared hash, keeps a global and a per-region
	// pointer updated separately, and swaps the pointer unconditionally, so a failed publish still
	// moves what the storefront reads. Review all three.
	if err := rdb.HSet(ctx, "catalog:"+productID, draft["fields"]).Err(); err != nil {
		return 0, err
	}
	version := draft["version"].(int)
	rdb.Set(ctx, "catalog:"+productID+":pointer", version, 0)
	rdb.Set(ctx, "catalog:"+productID+":region:"+draft["region"].(string)+":pointer", version, 0)
	return version, nil
}

func readPublished(ctx context.Context, productID string) (map[string]any, error) {
	version, _ := rdb.Get(ctx, "catalog:"+productID+":pointer").Int()
	fields, _ := rdb.HGetAll(ctx, "catalog:"+productID).Result()
	return map[string]any{"version": version, "fields": fields}, nil
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/redis/go-redis/v9"
)

var rdb *redis.Client

// One atomic compare-and-set: the pointer only moves when it still holds the expected version.
var publishScript = redis.NewScript(\`
local current = redis.call('GET', KEYS[1])
if current and current ~= ARGV[1] then
  return 0
end
redis.call('SET', KEYS[1], ARGV[2])
return 1
\`)

func snapshotKey(productID string, version int) string {
	return fmt.Sprintf("catalog:%s:v%d", productID, version)
}

func publishedPointer(productID string) string {
	return fmt.Sprintf("catalog:%s:published", productID)
}

func PublishSnapshot(ctx context.Context, productID string, version int, snapshot map[string]any, expected int) (bool, error) {
	payload, err := json.Marshal(snapshot)
	if err != nil {
		return false, err
	}
	// The whole version lands under its own key first, so no reader can observe a half-applied row.
	if err := rdb.Set(ctx, snapshotKey(productID, version), payload, 0).Err(); err != nil {
		return false, err
	}
	swapped, err := publishScript.Run(ctx, rdb, []string{publishedPointer(productID)}, expected, version).Int()
	if err != nil {
		return false, err
	}
	return swapped == 1, nil
}

func ReadPublished(ctx context.Context, productID string) (map[string]any, error) {
	// Exactly one pointer read, then exactly that snapshot: two versions can never be mixed.
	version, err := rdb.Get(ctx, publishedPointer(productID)).Int()
	if err != nil {
		return nil, err
	}
	payload, err := rdb.Get(ctx, snapshotKey(productID, version)).Bytes()
	if err != nil {
		return nil, err
	}
	out := map[string]any{}
	return out, json.Unmarshal(payload, &out)
}
`,
    },
    scala: {
      starter: `import redis.clients.jedis.Jedis

import scala.jdk.CollectionConverters._

object CatalogState {
  val jedis = new Jedis("redis", 6379)

  // TODO: this draft swaps per-field values into one shared hash, keeps a global and a per-region
  // pointer updated separately, and swaps the pointer unconditionally, so a failed publish still
  // moves what the storefront reads. Review all three.
  def publishSnapshot(productId: String, version: Int, region: String, fields: Map[String, String]): Int = {
    fields.foreach { case (field, value) => jedis.hset(s"catalog:$productId", field, value) }
    jedis.set(s"catalog:$productId:pointer", version.toString)
    jedis.set(s"catalog:$productId:region:$region:pointer", version.toString)
    version
  }

  def readPublished(productId: String): Map[String, String] = {
    val version = jedis.get(s"catalog:$productId:pointer")
    val fields = jedis.hgetAll(s"catalog:$productId").asScala.toMap
    fields + ("version" -> version)
  }
}
`,
      solution: `import redis.clients.jedis.Jedis

object CatalogState {
  val jedis = new Jedis("redis", 6379)

  val PublishLua =
    """
      |local current = redis.call('GET', KEYS[1])
      |if current and current ~= ARGV[1] then
      |  return 0
      |end
      |redis.call('SET', KEYS[1], ARGV[2])
      |return 1
      |""".stripMargin

  def snapshotKey(productId: String, version: Int): String = s"catalog:$productId:v$version"

  def publishedPointer(productId: String): String = s"catalog:$productId:published"

  def publishSnapshot(productId: String, version: Int, snapshot: String, expected: Option[Int]): Boolean = {
    // The whole version lands under its own key first: no reader can observe a half-applied row.
    jedis.set(snapshotKey(productId, version), snapshot)
    // The pointer is swapped by one server-side compare-and-set against the expected version.
    val swapped = jedis.eval(
      PublishLua,
      java.util.List.of(publishedPointer(productId)),
      java.util.List.of(expected.map(_.toString).getOrElse(""), version.toString)
    )
    swapped == 1L
  }

  def readPublished(productId: String): Option[String] = {
    // Exactly one pointer read, then exactly that snapshot: two versions can never be mixed.
    Option(jedis.get(publishedPointer(productId))).flatMap { version =>
      Option(jedis.get(snapshotKey(productId, version.toInt)))
    }
  }
}
`,
    },
    cpp: {
      starter: `#include <sw/redis++/redis++.h>

#include <map>
#include <string>

using Redis = sw::redis::Redis;

bool publishSnapshot(Redis& redis, const std::string& productId, int version, const std::string& region,
                     const std::map<std::string, std::string>& fields) {
  // TODO: this draft swaps per-field values into one shared hash, keeps a global and a per-region
  // pointer updated separately, and swaps the pointer unconditionally, so a failed publish still
  // moves what the storefront reads. Review all three.
  redis.hset("catalog:" + productId, fields.begin(), fields.end());
  redis.set("catalog:" + productId + ":pointer", std::to_string(version));
  redis.set("catalog:" + productId + ":region:" + region + ":pointer", std::to_string(version));
  return true;
}

std::map<std::string, std::string> readPublished(Redis& redis, const std::string& productId) {
  auto version = redis.get("catalog:" + productId + ":pointer");
  return redis.hgetall("catalog:" + productId);
}
`,
      solution: `#include <sw/redis++/redis++.h>

#include <optional>
#include <string>

using Redis = sw::redis::Redis;

// One atomic compare-and-set: the pointer only moves when it still holds the expected version.
const std::string kPublishLua =
    "local current = redis.call('GET', KEYS[1])\\n"
    "if current and current ~= ARGV[1] then return 0 end\\n"
    "redis.call('SET', KEYS[1], ARGV[2])\\n"
    "return 1";

std::string snapshotKey(const std::string& productId, int version) {
  return "catalog:" + productId + ":v" + std::to_string(version);
}

std::string publishedPointer(const std::string& productId) {
  return "catalog:" + productId + ":published";
}

bool publishSnapshot(Redis& redis, const std::string& productId, int version, const std::string& snapshot,
                     int expected) {
  // The whole version lands under its own key first: no reader can observe a half-applied row.
  redis.set(snapshotKey(productId, version), snapshot);
  const auto swapped = redis.eval<std::string>(kPublishLua, {publishedPointer(productId)},
                                               {std::to_string(expected), std::to_string(version)});
  return *swapped == "1";
}

std::optional<std::string> readPublished(Redis& redis, const std::string& productId) {
  // Exactly one pointer read, then exactly that snapshot: two versions can never be mixed.
  const auto version = redis.get(publishedPointer(productId));
  if (!version) return std::nullopt;
  return redis.get(snapshotKey(productId, std::stoi(*version)));
}
`,
    },
  },
  hints: [
    'Write the new version under its own key (`catalog:{id}:v{n}`) and let the pointer be the only thing that changes on publish. If the publish writes its fields into the key the readers already read, there is no moment in time at which the product is either fully old or fully new.',
    'A pointer swap that can be lost is a compare-and-set: pass the version you expect (`expected`) into the script and return `0` when the pointer has already moved. That also makes retries and two concurrent publishes safe — the second one loses instead of overwriting.',
    'The reader is the other half of the contract: read the pointer exactly once, then read exactly that version. Two reads — or a pointer plus a shared hash — is how a response ends up with the new price and the old title.',
  ],
  debrief: `This step is about the difference between "the write happened" and "the write was observed atomically". The publish path is a pointer swap, not an edit: the snapshot lands under a versioned key, then one server-side compare-and-set moves the pointer, and readers follow that single reference. Note the two failure modes the checks separate: a torn read (per-field writes into a shared structure) and a lost swap (an unconditional pointer write). The unconditional swap is the one that looks correct in a demo and breaks the moment a publish fails after writing its snapshot, or two publishes race. Real catalogs add a version history row, a retention policy that expires old snapshots well after the longest cache TTL, and a warm-up that loads the new snapshot before the pointer moves.`,
};
