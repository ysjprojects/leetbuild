import type {Step} from '@/lib/types';

export const stateStep: Step = {
  id: 'state',
  title: 'Redis published-pointer swap with a single reference',
  concept: 'redis',
  guides: ['atomic-state'],
  file: 'state',
  focus: ['api', 'redis', 'db'],
  task: `## Task

**Starting point.** The starter is the published snapshot store the publish path and the storefront
read share: \`publish_snapshot(product_id, version, snapshot, expected)\` writes the version's
fields into the product's catalog hash and moves the published pointer (and the region's copy of
it), \`read_published(product_id)\` reads the pointer and the hash back. It serves the demo and hides
four flaws.

**Failure mode the checks target.** A storefront read that lands while a publish is writing sees the
new price next to the old title; a publish that lost a race to another publisher still moves the
pointer; and two regions can serve two versions of one product.

- The snapshot is **one value**: write the whole version as one JSON document under
  \`snapshot_key(product_id, version)\` (\`catalog:{id}:v{n}\`), never field by field into a shared hash.
- **One pointer per product**, \`pointer_key(product_id)\` (\`catalog:{id}:published\`): no per-region copy.
- The swap is a **compare-and-set in one Lua script**: move the pointer only if it still holds
  \`expected\` (\`None\` when nothing was published yet) and return whether it moved.
- A read resolves the pointer **once** and loads exactly that snapshot.`,
  sequence: {
    participants: ['Catalog API', 'Redis', 'Storefront read'],
    messages: [
      {from: 'Catalog API', to: 'Redis', label: 'SET catalog:{id}:v42 {whole snapshot}', kind: 'sync'},
      {from: 'Catalog API', to: 'Redis', label: 'EVAL swap catalog:{id}:published 42 expected=41', kind: 'sync'},
      {from: 'Redis', to: 'Catalog API', label: '1 moved · 0 pointer no longer 41', kind: 'reply'},
      {from: 'Storefront read', to: 'Redis', label: 'GET catalog:{id}:published', kind: 'sync'},
      {from: 'Redis', to: 'Storefront read', label: '42', kind: 'reply'},
      {from: 'Storefront read', to: 'Redis', label: 'GET catalog:{id}:v42', kind: 'sync'},
      {from: 'Redis', to: 'Storefront read', label: 'one complete version', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'no-field-swap',
      title: 'Writes the whole snapshot under its own key',
      detail:
        'The version is written as one value under `snapshot_key`/`snapshotKey` (`SET`), not as per-field `HSET`s into a hash every version shares; per-field writes are what tear a product in half for a concurrent reader.',
      match: {
        python: {all: [/def snapshot_key/, /\.set\(\s*snapshot_key\(/], none: [/\bhset\b/i]},
        typescript: {all: [/snapshotKey\s*=|function snapshotKey/, /\.set\(\s*snapshotKey\(/], none: [/\bhset\b/i]},
        go: {all: [/func snapshotKey/, /\.Set\([^\n]*snapshotKey\(/], none: [/\bHSet\(/]},
        scala: {all: [/def snapshotKey/, /\.set\(\s*snapshotKey\(/], none: [/\bhset\b/i]},
        cpp: {all: [/snapshotKey\(/, /\.set\(\s*snapshotKey\(/], none: [/\bhset\b/i]},
      },
    },
    {
      id: 'one-pointer',
      title: 'Keeps one published pointer per product',
      detail:
        'There is exactly one pointer key per product (`pointer_key`/`pointerKey`); a per-region copy that is moved separately lets regions disagree about what is live.',
      match: {
        python: {all: [/def pointer_key/], none: [/[Rr]egion/]},
        typescript: {all: [/pointerKey\s*=|function pointerKey/], none: [/[Rr]egion/]},
        go: {all: [/func pointerKey/], none: [/[Rr]egion/]},
        scala: {all: [/def pointerKey/], none: [/[Rr]egion/]},
        cpp: {all: [/pointerKey\(/], none: [/[Rr]egion/]},
      },
    },
    {
      id: 'single-read',
      title: 'Resolves exactly one version per read',
      detail:
        '`read_published`/`readPublished` reads the pointer once and loads exactly that snapshot; it never reads a shared hash of fields, which can belong to a newer version than the pointer it just read.',
      match: {
        python: {
          all: [/def read_published/, /\.get\(\s*pointer_key\(/, /\.get\(\s*snapshot_key\(/],
          none: [/hgetall/i],
        },
        typescript: {all: [/readPublished\(/, /\.get\(\s*pointerKey\(/, /\.get\(\s*snapshotKey\(/], none: [/hgetall/i]},
        go: {
          all: [/func readPublished\(/, /\.Get\([^\n]*pointerKey\(/, /\.Get\([^\n]*snapshotKey\(/],
          none: [/HGetAll\(/],
        },
        scala: {all: [/def readPublished\(/, /\.get\(\s*pointerKey\(/, /\.get\(\s*snapshotKey\(/], none: [/hgetall/i]},
        cpp: {all: [/readPublished\(/, /\.get\(\s*pointerKey\(/, /\.get\(\s*snapshotKey\(/], none: [/hgetall/i]},
      },
    },
    {
      id: 'cas-swap',
      title: 'Moves the pointer only when it still holds the expected version',
      detail:
        'The swap is one Lua script (`EVAL`/`register_script`/`NewScript`) that compares the pointer with the expected version (`ARGV[2]`) before setting it; a plain `SET` of the pointer lets a publish that lost a race overwrite the winner.',
      match: {
        python: {
          all: [/register_script\(|\.eval\(/, /redis\.call\(\s*['"]GET['"]/, /ARGV\[2\]/],
          none: [/\.set\(\s*pointer_key\(/, /\.set\([^)\n]*:published/],
        },
        typescript: {
          all: [/defineCommand\(|\.eval\(/, /redis\.call\(\s*['"]GET['"]/, /ARGV\[2\]/],
          none: [/\.set\(\s*pointerKey\(/, /\.set\([^)\n]*:published/],
        },
        go: {
          all: [/redis\.NewScript\(|\.Eval\(/, /redis\.call\(\s*['"]GET['"]/, /ARGV\[2\]/],
          none: [/\.Set\([^\n]*pointerKey\(/, /\.Set\([^)\n]*:published/],
        },
        scala: {
          all: [/jedis\.eval(sha)?\(/, /redis\.call\(\s*['"]GET['"]/, /ARGV\[2\]/],
          none: [/\.set\(\s*pointerKey\(/, /\.set\([^)\n]*:published/],
        },
        cpp: {
          all: [/redis\.eval(sha)?[<(]/, /redis\.call\(\s*['"]GET['"]/, /ARGV\[2\]/],
          none: [/\.set\(\s*pointerKey\(/, /\.set\([^)\n]*:published/],
        },
      },
    },
  ],
  code: {
    python: {
      starter: `import json

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

REGION = "eu-west"


def publish_snapshot(product_id: str, version: int, snapshot: dict, expected: int | None) -> bool:
    """Make version the published one; snapshot is the whole version (product_id, version, title, price_cents, tax_class)."""
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    for name, value in snapshot.items():
        r.hset(f"catalog:{product_id}", name, json.dumps(value))
    r.set(f"catalog:{product_id}:published", version)
    r.set(f"catalog:{product_id}:region:{REGION}:published", version)
    return True


def read_published(product_id: str) -> dict | None:
    """The published snapshot, or None when nothing is published."""
    version = r.get(f"catalog:{product_id}:published")
    if version is None:
        return None
    fields = r.hgetall(f"catalog:{product_id}")
    snapshot = {name: json.loads(value) for name, value in fields.items()}
    return {**snapshot, "version": int(version)}
`,
      solution: `import json

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

# Moves the pointer to ARGV[1] only if it still holds ARGV[2] ("" when nothing is published yet).
SWAP_LUA = """
local current = redis.call('GET', KEYS[1]) or ''
if current ~= ARGV[2] then return 0 end
redis.call('SET', KEYS[1], ARGV[1])
return 1
"""
swap = r.register_script(SWAP_LUA)


def snapshot_key(product_id: str, version: int) -> str:
    return f"catalog:{product_id}:v{version}"


def pointer_key(product_id: str) -> str:
    return f"catalog:{product_id}:published"


def publish_snapshot(product_id: str, version: int, snapshot: dict, expected: int | None) -> bool:
    """Make version the published one; snapshot is the whole version (product_id, version, title, price_cents, tax_class)."""
    # The whole version first, under its own key; then one conditional move of the pointer.
    r.set(snapshot_key(product_id, version), json.dumps(snapshot))
    return swap(keys=[pointer_key(product_id)], args=[version, "" if expected is None else expected]) == 1


def read_published(product_id: str) -> dict | None:
    """The published snapshot, or None when nothing is published."""
    version = r.get(pointer_key(product_id))
    if version is None:
        return None
    raw = r.get(snapshot_key(product_id, int(version)))
    return json.loads(raw) if raw else None
`,
    },
    typescript: {
      starter: `import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

export const REGION = 'eu-west';

export type Snapshot = Record<string, unknown>;

/** Make version the published one; snapshot is the whole version (product_id, version, title, price_cents, tax_class). */
export async function publishSnapshot(productId: string, version: number, snapshot: Snapshot, expected: number | null): Promise<boolean> {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  for (const [name, value] of Object.entries(snapshot)) await redis.hset(\`catalog:\${productId}\`, name, JSON.stringify(value));
  await redis.set(\`catalog:\${productId}:published\`, version);
  await redis.set(\`catalog:\${productId}:region:\${REGION}:published\`, version);
  return true;
}

/** The published snapshot, or null when nothing is published. */
export async function readPublished(productId: string): Promise<Snapshot | null> {
  const version = await redis.get(\`catalog:\${productId}:published\`);
  if (version === null) return null;
  const fields = await redis.hgetall(\`catalog:\${productId}\`);
  const snapshot = Object.fromEntries(Object.entries(fields).map(([name, value]) => [name, JSON.parse(value)]));
  return {...snapshot, version: Number(version)};
}
`,
      solution: `import Redis from 'ioredis';

// Moves the pointer to ARGV[1] only if it still holds ARGV[2] ("" when nothing is published yet).
export const SWAP_LUA = \`
local current = redis.call('GET', KEYS[1]) or ''
if current ~= ARGV[2] then return 0 end
redis.call('SET', KEYS[1], ARGV[1])
return 1
\`;

interface SwapRedis extends Redis {
  swapPointer(key: string, version: number, expected: string): Promise<number>;
}

const redis = new Redis({host: 'redis', port: 6379}) as SwapRedis;
redis.defineCommand('swapPointer', {numberOfKeys: 1, lua: SWAP_LUA});

export type Snapshot = Record<string, unknown>;

export const snapshotKey = (productId: string, version: number): string => \`catalog:\${productId}:v\${version}\`;
export const pointerKey = (productId: string): string => \`catalog:\${productId}:published\`;

/** Make version the published one; snapshot is the whole version (product_id, version, title, price_cents, tax_class). */
export async function publishSnapshot(productId: string, version: number, snapshot: Snapshot, expected: number | null): Promise<boolean> {
  // The whole version first, under its own key; then one conditional move of the pointer.
  await redis.set(snapshotKey(productId, version), JSON.stringify(snapshot));
  return (await redis.swapPointer(pointerKey(productId), version, expected === null ? '' : String(expected))) === 1;
}

/** The published snapshot, or null when nothing is published. */
export async function readPublished(productId: string): Promise<Snapshot | null> {
  const version = await redis.get(pointerKey(productId));
  if (version === null) return null;
  const raw = await redis.get(snapshotKey(productId, Number(version)));
  return raw === null ? null : (JSON.parse(raw) as Snapshot);
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const region = "eu-west"

// publishSnapshot makes version the published one; snapshot is the whole version (product_id,
// version, title, price_cents, tax_class). expected is the version the caller saw published (0: none).
func publishSnapshot(ctx context.Context, productID string, version int, snapshot map[string]any, expected int) (bool, error) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	for name, value := range snapshot {
		raw, _ := json.Marshal(value)
		if err := rdb.HSet(ctx, "catalog:"+productID, name, raw).Err(); err != nil {
			return false, err
		}
	}
	if err := rdb.Set(ctx, "catalog:"+productID+":published", version, 0).Err(); err != nil {
		return false, err
	}
	return true, rdb.Set(ctx, fmt.Sprintf("catalog:%s:region:%s:published", productID, region), version, 0).Err()
}

// readPublished is the published snapshot, or nil when nothing is published.
func readPublished(ctx context.Context, productID string) (map[string]any, error) {
	version, err := rdb.Get(ctx, "catalog:"+productID+":published").Result()
	if err != nil {
		if err == redis.Nil {
			return nil, nil
		}
		return nil, err
	}
	fields, err := rdb.HGetAll(ctx, "catalog:"+productID).Result()
	if err != nil {
		return nil, err
	}
	snapshot := map[string]any{}
	for name, raw := range fields {
		var value any
		json.Unmarshal([]byte(raw), &value)
		snapshot[name] = value
	}
	n, _ := strconv.Atoi(version)
	snapshot["version"] = n
	return snapshot, nil
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// swap moves the pointer to ARGV[1] only if it still holds ARGV[2] ("" when nothing is published yet).
var swap = redis.NewScript(\`
local current = redis.call('GET', KEYS[1]) or ''
if current ~= ARGV[2] then return 0 end
redis.call('SET', KEYS[1], ARGV[1])
return 1
\`)

func snapshotKey(productID string, version int) string {
	return fmt.Sprintf("catalog:%s:v%d", productID, version)
}

func pointerKey(productID string) string {
	return "catalog:" + productID + ":published"
}

// publishSnapshot makes version the published one; snapshot is the whole version (product_id,
// version, title, price_cents, tax_class). expected is the version the caller saw published (0: none).
func publishSnapshot(ctx context.Context, productID string, version int, snapshot map[string]any, expected int) (bool, error) {
	// The whole version first, under its own key; then one conditional move of the pointer.
	raw, _ := json.Marshal(snapshot)
	if err := rdb.Set(ctx, snapshotKey(productID, version), raw, 0).Err(); err != nil {
		return false, err
	}
	was := ""
	if expected > 0 {
		was = strconv.Itoa(expected)
	}
	moved, err := swap.Run(ctx, rdb, []string{pointerKey(productID)}, version, was).Int64()
	return moved == 1, err
}

// readPublished is the published snapshot, or nil when nothing is published.
func readPublished(ctx context.Context, productID string) (map[string]any, error) {
	version, err := rdb.Get(ctx, pointerKey(productID)).Result()
	if err == redis.Nil {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	n, _ := strconv.Atoi(version)
	raw, err := rdb.Get(ctx, snapshotKey(productID, n)).Result()
	if err == redis.Nil {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var snapshot map[string]any
	return snapshot, json.Unmarshal([]byte(raw), &snapshot)
}
`,
    },
    scala: {
      starter: `import redis.clients.jedis.JedisPooled
import spray.json._

import scala.jdk.CollectionConverters._

object State {
  val jedis = new JedisPooled("redis", 6379)

  val Region = "eu-west"

  /** Make version the published one; snapshot is the whole version (product_id, version, title, price_cents, tax_class). */
  def publishSnapshot(productId: String, version: Long, snapshot: JsObject, expected: Option[Long]): Boolean = {
    // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    snapshot.fields.foreach { case (name, value) => jedis.hset(s"catalog:$productId", name, value.compactPrint) }
    jedis.set(s"catalog:$productId:published", version.toString)
    jedis.set(s"catalog:$productId:region:$Region:published", version.toString)
    true
  }

  /** The published snapshot, or None when nothing is published. */
  def readPublished(productId: String): Option[JsObject] =
    Option(jedis.get(s"catalog:$productId:published")).map { version =>
      val fields = jedis.hgetAll(s"catalog:$productId").asScala.toMap.map { case (name, raw) => name -> raw.parseJson }
      JsObject(fields + ("version" -> JsNumber(version.toLong)))
    }
}
`,
      solution: `import redis.clients.jedis.JedisPooled
import spray.json._

import scala.jdk.CollectionConverters._

object State {
  val jedis = new JedisPooled("redis", 6379)

  /** Moves the pointer to ARGV[1] only if it still holds ARGV[2] ("" when nothing is published yet). */
  val SwapLua: String =
    """local current = redis.call('GET', KEYS[1]) or ''
      |if current ~= ARGV[2] then return 0 end
      |redis.call('SET', KEYS[1], ARGV[1])
      |return 1
      |""".stripMargin

  def snapshotKey(productId: String, version: Long): String = s"catalog:$productId:v$version"
  def pointerKey(productId: String): String = s"catalog:$productId:published"

  /** Make version the published one; snapshot is the whole version (product_id, version, title, price_cents, tax_class). */
  def publishSnapshot(productId: String, version: Long, snapshot: JsObject, expected: Option[Long]): Boolean = {
    // The whole version first, under its own key; then one conditional move of the pointer.
    jedis.set(snapshotKey(productId, version), snapshot.compactPrint)
    val args = List(version.toString, expected.map(_.toString).getOrElse("")).asJava
    jedis.eval(SwapLua, List(pointerKey(productId)).asJava, args).asInstanceOf[java.lang.Long] == 1L
  }

  /** The published snapshot, or None when nothing is published. */
  def readPublished(productId: String): Option[JsObject] =
    Option(jedis.get(pointerKey(productId)))
      .flatMap(version => Option(jedis.get(snapshotKey(productId, version.toLong))))
      .map(_.parseJson.asJsObject)
}
`,
    },
    cpp: {
      starter: `#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <optional>
#include <string>
#include <unordered_map>

using json = nlohmann::json;

sw::redis::Redis redis("tcp://redis:6379");

const std::string kRegion = "eu-west";

// Make version the published one; snapshot is the whole version (product_id, version, title,
// price_cents, tax_class). expected is the version the caller saw published (0: none).
bool publishSnapshot(const std::string& product_id, long version, const json& snapshot, long expected) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  for (const auto& [name, value] : snapshot.items()) redis.hset("catalog:" + product_id, name, value.dump());
  redis.set("catalog:" + product_id + ":published", std::to_string(version));
  redis.set("catalog:" + product_id + ":region:" + kRegion + ":published", std::to_string(version));
  return true;
}

// The published snapshot, or none when nothing is published.
std::optional<json> readPublished(const std::string& product_id) {
  const auto version = redis.get("catalog:" + product_id + ":published");
  if (!version) return std::nullopt;
  const std::unordered_map<std::string, std::string> fields = redis.hgetall("catalog:" + product_id);
  json snapshot = json::object();
  for (const auto& [name, raw] : fields) snapshot[name] = json::parse(raw);
  snapshot["version"] = std::stol(*version);
  return snapshot;
}
`,
      solution: `#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <optional>
#include <string>

using json = nlohmann::json;

sw::redis::Redis redis("tcp://redis:6379");

// Moves the pointer to ARGV[1] only if it still holds ARGV[2] ("" when nothing is published yet).
const std::string kSwapLua = R"lua(
local current = redis.call('GET', KEYS[1]) or ''
if current ~= ARGV[2] then return 0 end
redis.call('SET', KEYS[1], ARGV[1])
return 1
)lua";

std::string snapshotKey(const std::string& product_id, long version) {
  return "catalog:" + product_id + ":v" + std::to_string(version);
}

std::string pointerKey(const std::string& product_id) { return "catalog:" + product_id + ":published"; }

// Make version the published one; snapshot is the whole version (product_id, version, title,
// price_cents, tax_class). expected is the version the caller saw published (0: none).
bool publishSnapshot(const std::string& product_id, long version, const json& snapshot, long expected) {
  // The whole version first, under its own key; then one conditional move of the pointer.
  redis.set(snapshotKey(product_id, version), snapshot.dump());
  const std::string was = expected > 0 ? std::to_string(expected) : "";
  return redis.eval<long long>(kSwapLua, {pointerKey(product_id)}, {std::to_string(version), was}) == 1;
}

// The published snapshot, or none when nothing is published.
std::optional<json> readPublished(const std::string& product_id) {
  const auto version = redis.get(pointerKey(product_id));
  if (!version) return std::nullopt;
  const auto raw = redis.get(snapshotKey(product_id, std::stol(*version)));
  if (!raw) return std::nullopt;
  return json::parse(*raw);
}
`,
    },
  },
  harness: {
    python: `import json

V1 = {"version": 1, "product_id": "p-1", "title": "Kettle", "price_cents": 3499, "tax_class": "standard"}
V2 = {"version": 2, "product_id": "p-1", "title": "Kettle, 2 L", "price_cents": 3999, "tax_class": "standard"}


def _settled(probe, what):
    assert probe.fired, f"nothing touched {what}"
    if probe.error is not None:
        raise probe.error
    return probe.result


def _whole(seen, when):
    assert seen in (V1, V2), f"a read {when} saw {seen}: a mix of version 1 and version 2. A reader must see one whole version"


def check_no_field_swap(ctx):
    m = ctx.load("state")
    assert m.publish_snapshot("p-1", 1, V1, None) is True, "the first publish (nothing published yet, expected None) must move the pointer"
    assert m.read_published("p-1") == V1, f"after publishing version 1 read_published gives {m.read_published('p-1')}"
    # A storefront read lands while the publish of version 2 is writing: it must see one whole version.
    shared = ctx.redis_after("catalog:p-1", lambda: m.read_published("p-1"))
    versioned = ctx.redis_after("catalog:p-1:v2", lambda: m.read_published("p-1"))
    assert m.publish_snapshot("p-1", 2, V2, 1) is True, "publishing version 2 over version 1 (expected 1) must move the pointer"
    for probe in (shared, versioned):
        if probe.fired:
            _whole(_settled(probe, "the key"), "during the publish")
    assert ctx.redis.type("catalog:p-1") == "none", f"catalog:p-1 is a {ctx.redis.type('catalog:p-1')}: the fields of every version share one hash, so a reader can see two versions in one response. Write the whole version under catalog:p-1:v2"
    raw = ctx.redis.get("catalog:p-1:v2")
    assert raw is not None and json.loads(raw) == V2, f"catalog:p-1:v2 holds {raw!r}, expected the whole version 2 as one JSON document"
    assert m.read_published("p-1") == V2, f"after the second publish read_published gives {m.read_published('p-1')}"


def check_one_pointer(ctx):
    m = ctx.load("state")
    m.publish_snapshot("p-1", 1, V1, None)
    keys = sorted(ctx.redis.keys("catalog:p-1*"))
    assert ctx.redis.get("catalog:p-1:published") == "1", f"catalog:p-1:published is {ctx.redis.get('catalog:p-1:published')!r}, expected the published version 1 (keys: {keys})"
    regional = [k for k in keys if "region" in k]
    assert not regional, f"a second pointer {regional} is moved separately from catalog:p-1:published: regions can disagree about what is live. Keep one pointer per product"
    assert keys == ["catalog:p-1:published", "catalog:p-1:v1"], f"a publish must leave exactly the snapshot and the pointer, Redis holds {keys}"


def check_single_read(ctx):
    m = ctx.load("state")
    m.publish_snapshot("p-1", 1, V1, None)
    # Version 2 is published right after the read resolved the pointer: the read must still answer one whole version.
    rival = ctx.redis_after("catalog:p-1:published", lambda: m.publish_snapshot("p-1", 2, V2, 1))
    seen = m.read_published("p-1")
    assert _settled(rival, "catalog:p-1:published") is True, "the publish of version 2 that landed during the read must move the pointer"
    _whole(seen, "racing a publish")
    assert m.read_published("p-1") == V2, f"after the race read_published gives {m.read_published('p-1')}, expected version 2"


def check_cas_swap(ctx):
    m = ctx.load("state")
    assert m.publish_snapshot("p-1", 1, V1, None) is True, "the first publish must move the pointer"
    assert m.publish_snapshot("p-1", 2, V2, 1) is True, "a publish that expected version 1 while 1 is published must move the pointer"
    v3 = {**V2, "version": 3, "title": "Kettle, 3 L"}
    stale = m.publish_snapshot("p-1", 3, v3, 1)
    assert stale is False, "a publish that expected version 1 while 2 is published lost the race: the pointer must not move and publish_snapshot must report False"
    assert ctx.redis.get("catalog:p-1:published") == "2", f"catalog:p-1:published is {ctx.redis.get('catalog:p-1:published')!r} after a stale publish, expected 2"
    assert m.read_published("p-1") == V2, f"the storefront serves {m.read_published('p-1')} after a stale publish, expected version 2"
    # Another publisher wins the race between this publish's snapshot write and its swap.
    v9 = {**V2, "version": 9, "title": "Kettle, 9 L"}
    rival = ctx.redis_after("catalog:p-1:v4", lambda: m.publish_snapshot("p-1", 9, v9, 2))
    v4 = {**V2, "version": 4, "title": "Kettle, 4 L"}
    lost = m.publish_snapshot("p-1", 4, v4, 2)
    assert _settled(rival, "catalog:p-1:v4") is True, "the rival publish must move the pointer to 9"
    assert lost is False, "the publish that lost the race must report False"
    assert m.read_published("p-1") == v9, f"the storefront serves {m.read_published('p-1')} after the race, expected version 9"
`,
    typescript: `const V1 = {version: 1, product_id: 'p-1', title: 'Kettle', price_cents: 3499, tax_class: 'standard'};
const V2 = {version: 2, product_id: 'p-1', title: 'Kettle, 2 L', price_cents: 3999, tax_class: 'standard'};

async function settled(probe, what: string) {
  assert(probe.fired, \`nothing touched \${what}\`);
  if (probe.error !== undefined) throw probe.error;
  return await probe.result;
}

function whole(seen, when: string): void {
  const text = JSON.stringify(seen);
  assert(text === JSON.stringify(V1) || text === JSON.stringify(V2), \`a read \${when} saw \${text}: a mix of version 1 and version 2. A reader must see one whole version\`);
}

export async function check_no_field_swap(ctx) {
  const m = ctx.load('state');
  assert.equal(await m.publishSnapshot('p-1', 1, V1, null), true, 'the first publish (nothing published yet, expected null) must move the pointer');
  assert.deepStrictEqual(await m.readPublished('p-1'), V1, \`after publishing version 1 readPublished gives \${JSON.stringify(await m.readPublished('p-1'))}\`);
  // A storefront read lands while the publish of version 2 is writing: it must see one whole version.
  const shared = ctx.redisAfter('catalog:p-1', () => m.readPublished('p-1'));
  const versioned = ctx.redisAfter('catalog:p-1:v2', () => m.readPublished('p-1'));
  assert.equal(await m.publishSnapshot('p-1', 2, V2, 1), true, 'publishing version 2 over version 1 (expected 1) must move the pointer');
  for (const probe of [shared, versioned]) if (probe.fired) whole(await settled(probe, 'the key'), 'during the publish');
  assert.equal(ctx.redis.type('catalog:p-1'), 'none', \`catalog:p-1 is a \${ctx.redis.type('catalog:p-1')}: the fields of every version share one hash, so a reader can see two versions in one response. Write the whole version under catalog:p-1:v2\`);
  const raw = ctx.redis.get('catalog:p-1:v2');
  assert(raw !== null && JSON.stringify(JSON.parse(raw)) === JSON.stringify(V2), \`catalog:p-1:v2 holds \${JSON.stringify(raw)}, expected the whole version 2 as one JSON document\`);
  assert.deepStrictEqual(await m.readPublished('p-1'), V2, 'after the second publish readPublished must give version 2');
}

export async function check_one_pointer(ctx) {
  const m = ctx.load('state');
  await m.publishSnapshot('p-1', 1, V1, null);
  const keys = ctx.redis.keys('catalog:p-1*').sort();
  assert.equal(ctx.redis.get('catalog:p-1:published'), '1', \`catalog:p-1:published is \${JSON.stringify(ctx.redis.get('catalog:p-1:published'))}, expected the published version 1 (keys: \${JSON.stringify(keys)})\`);
  const regional = keys.filter(k => k.includes('region'));
  assert.equal(regional.length, 0, \`a second pointer \${JSON.stringify(regional)} is moved separately from catalog:p-1:published: regions can disagree about what is live. Keep one pointer per product\`);
  assert.deepStrictEqual(keys, ['catalog:p-1:published', 'catalog:p-1:v1'], \`a publish must leave exactly the snapshot and the pointer, Redis holds \${JSON.stringify(keys)}\`);
}

export async function check_single_read(ctx) {
  const m = ctx.load('state');
  await m.publishSnapshot('p-1', 1, V1, null);
  // Version 2 is published right after the read resolved the pointer: the read must still answer one whole version.
  const rival = ctx.redisAfter('catalog:p-1:published', () => m.publishSnapshot('p-1', 2, V2, 1));
  const seen = await m.readPublished('p-1');
  assert.equal(await settled(rival, 'catalog:p-1:published'), true, 'the publish of version 2 that landed during the read must move the pointer');
  whole(seen, 'racing a publish');
  assert.deepStrictEqual(await m.readPublished('p-1'), V2, 'after the race readPublished must give version 2');
}

export async function check_cas_swap(ctx) {
  const m = ctx.load('state');
  assert.equal(await m.publishSnapshot('p-1', 1, V1, null), true, 'the first publish must move the pointer');
  assert.equal(await m.publishSnapshot('p-1', 2, V2, 1), true, 'a publish that expected version 1 while 1 is published must move the pointer');
  const v3 = {...V2, version: 3, title: 'Kettle, 3 L'};
  assert.equal(await m.publishSnapshot('p-1', 3, v3, 1), false, 'a publish that expected version 1 while 2 is published lost the race: the pointer must not move and publishSnapshot must report false');
  assert.equal(ctx.redis.get('catalog:p-1:published'), '2', \`catalog:p-1:published is \${JSON.stringify(ctx.redis.get('catalog:p-1:published'))} after a stale publish, expected 2\`);
  assert.deepStrictEqual(await m.readPublished('p-1'), V2, 'the storefront must serve version 2 after a stale publish');
  // Another publisher wins the race between this publish's snapshot write and its swap.
  const v9 = {...V2, version: 9, title: 'Kettle, 9 L'};
  const rival = ctx.redisAfter('catalog:p-1:v4', () => m.publishSnapshot('p-1', 9, v9, 2));
  const v4 = {...V2, version: 4, title: 'Kettle, 4 L'};
  const lost = await m.publishSnapshot('p-1', 4, v4, 2);
  assert.equal(await settled(rival, 'catalog:p-1:v4'), true, 'the rival publish must move the pointer to 9');
  assert.equal(lost, false, 'the publish that lost the race must report false');
  assert.deepStrictEqual(await m.readPublished('p-1'), v9, 'the storefront must serve version 9 after the race');
}
`,
    go: `package main

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"leetbuild/harness"
)

var (
	stateBg = context.Background()
	v1      = map[string]any{"version": 1, "product_id": "p-1", "title": "Kettle", "price_cents": 3499, "tax_class": "standard"}
	v2      = map[string]any{"version": 2, "product_id": "p-1", "title": "Kettle, 2 L", "price_cents": 3999, "tax_class": "standard"}
)

func variant(base map[string]any, version int, title string) map[string]any {
	out := map[string]any{}
	for k, v := range base {
		out[k] = v
	}
	out["version"] = version
	out["title"] = title
	return out
}

// same compares two snapshots as JSON documents (keys sorted, numbers by value).
func same(a, b map[string]any) bool {
	x, _ := json.Marshal(a)
	y, _ := json.Marshal(b)
	return string(x) == string(y)
}

func mustPublish(ctx *harness.Ctx, version int, snapshot map[string]any, expected int) bool {
	moved, err := publishSnapshot(stateBg, "p-1", version, snapshot, expected)
	ctx.NoError(err, "publishSnapshot(p-1, %d, …, %d) failed", version, expected)
	return moved
}

func mustRead(ctx *harness.Ctx) map[string]any {
	snapshot, err := readPublished(stateBg, "p-1")
	ctx.NoError(err, "readPublished(p-1) failed")
	return snapshot
}

func whole(ctx *harness.Ctx, seen map[string]any, when string) {
	ctx.Assert(same(seen, v1) || same(seen, v2), "a read %s saw %v: a mix of version 1 and version 2. A reader must see one whole version", when, seen)
}

func CheckNoFieldSwap(ctx *harness.Ctx) {
	ctx.Equal(mustPublish(ctx, 1, v1, 0), true, "the first publish (nothing published yet, expected 0) must move the pointer; moved")
	ctx.Equal(mustRead(ctx), v1, "after publishing version 1, readPublished")
	// A storefront read lands while the publish of version 2 is writing: it must see one whole version.
	var seen []map[string]any
	for _, key := range []string{"catalog:p-1", "catalog:p-1:v2"} {
		ctx.Redis.After(key, func() any {
			snapshot, _ := readPublished(stateBg, "p-1")
			seen = append(seen, snapshot)
			return nil
		})
	}
	ctx.Equal(mustPublish(ctx, 2, v2, 1), true, "publishing version 2 over version 1 (expected 1) must move the pointer; moved")
	for _, s := range seen {
		whole(ctx, s, "during the publish")
	}
	ctx.Equal(ctx.Redis.Type("catalog:p-1"), "none", "catalog:p-1 exists: the fields of every version share one hash, so a reader can see two versions in one response. Write the whole version under catalog:p-1:v2; its type")
	raw, ok := ctx.Redis.Get("catalog:p-1:v2")
	var stored map[string]any
	ctx.Assert(ok && json.Unmarshal([]byte(raw), &stored) == nil && same(stored, v2), "catalog:p-1:v2 holds %q, expected the whole version 2 as one JSON document", raw)
	ctx.Equal(mustRead(ctx), v2, "after the second publish, readPublished")
}

func CheckOnePointer(ctx *harness.Ctx) {
	mustPublish(ctx, 1, v1, 0)
	keys := ctx.Redis.Keys("catalog:p-1*")
	pointer, _ := ctx.Redis.Get("catalog:p-1:published")
	ctx.Equal(pointer, "1", "catalog:p-1:published must hold the published version 1 (keys: %q)", keys)
	var regional []string
	for _, k := range keys {
		if strings.Contains(k, "region") {
			regional = append(regional, k)
		}
	}
	ctx.Assert(len(regional) == 0, "a second pointer %q is moved separately from catalog:p-1:published: regions can disagree about what is live. Keep one pointer per product", regional)
	ctx.Equal(keys, []string{"catalog:p-1:published", "catalog:p-1:v1"}, "a publish must leave exactly the snapshot and the pointer; Redis holds")
}

func CheckSingleRead(ctx *harness.Ctx) {
	mustPublish(ctx, 1, v1, 0)
	// Version 2 is published right after the read resolved the pointer: the read must still answer one whole version.
	rival := ctx.Redis.After("catalog:p-1:published", func() any {
		moved, err := publishSnapshot(stateBg, "p-1", 2, v2, 1)
		ctx.NoError(err, "the rival publish failed")
		return moved
	})
	seen := mustRead(ctx)
	ctx.Assert(rival.Fired, "nothing touched catalog:p-1:published")
	ctx.Assert(rival.Err == nil, "the rival publish failed: %v", rival.Err)
	ctx.Equal(rival.Result, true, "the publish of version 2 that landed during the read must move the pointer; moved")
	whole(ctx, seen, "racing a publish")
	ctx.Equal(mustRead(ctx), v2, "after the race, readPublished")
}

func CheckCasSwap(ctx *harness.Ctx) {
	ctx.Equal(mustPublish(ctx, 1, v1, 0), true, "the first publish must move the pointer; moved")
	ctx.Equal(mustPublish(ctx, 2, v2, 1), true, "a publish that expected version 1 while 1 is published must move the pointer; moved")
	ctx.Equal(mustPublish(ctx, 3, variant(v2, 3, "Kettle, 3 L"), 1), false, "a publish that expected version 1 while 2 is published lost the race: the pointer must not move; moved")
	pointer, _ := ctx.Redis.Get("catalog:p-1:published")
	ctx.Equal(pointer, "2", "catalog:p-1:published after a stale publish")
	ctx.Equal(mustRead(ctx), v2, "the storefront after a stale publish")
	// Another publisher wins the race between this publish's snapshot write and its swap.
	v9 := variant(v2, 9, "Kettle, 9 L")
	rival := ctx.Redis.After("catalog:p-1:v4", func() any {
		moved, err := publishSnapshot(stateBg, "p-1", 9, v9, 2)
		ctx.NoError(err, "the rival publish failed")
		return moved
	})
	lost := mustPublish(ctx, 4, variant(v2, 4, "Kettle, 4 L"), 2)
	ctx.Assert(rival.Fired, "nothing touched catalog:p-1:v4")
	ctx.Assert(rival.Err == nil, "the rival publish failed: %v", rival.Err)
	ctx.Equal(rival.Result, true, "the rival publish must move the pointer to 9; moved")
	ctx.Equal(lost, false, "the publish that lost the race must report false; moved")
	ctx.Equal(mustRead(ctx), v9, "the storefront after the race")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <memory>
#include <optional>
#include <string>
#include <vector>

using json = nlohmann::json;

namespace {

const json kV1 = {{"version", 1}, {"product_id", "p-1"}, {"title", "Kettle"}, {"price_cents", 3499}, {"tax_class", "standard"}};
const json kV2 = {{"version", 2}, {"product_id", "p-1"}, {"title", "Kettle, 2 L"}, {"price_cents", 3999}, {"tax_class", "standard"}};

json variant(const json& base, long version, const std::string& title) {
  json out = base;
  out["version"] = version;
  out["title"] = title;
  return out;
}

json mustRead(harness::Ctx& ctx) {
  const auto snapshot = readPublished("p-1");
  ctx.Assert(snapshot.has_value(), "readPublished(p-1) gave nothing while a version is published");
  return *snapshot;
}

void whole(harness::Ctx& ctx, const json& seen, const std::string& when) {
  ctx.Assert(seen == kV1 || seen == kV2, "a read %s saw %s: a mix of version 1 and version 2. A reader must see one whole version", when, seen.dump());
}

// A probe's outcome: whether it fired, what the call returned, what it threw.
struct Rival {
  bool fired = false;
  bool moved = false;
  std::optional<json> seen;
  std::optional<std::string> err;
};

std::shared_ptr<Rival> rivalPublish(harness::Ctx& ctx, const std::string& key, long version, json snapshot, long expected) {
  auto out = std::make_shared<Rival>();
  ctx.Redis.After(key, [out, version, snapshot, expected] {
    out->fired = true;
    try {
      out->moved = publishSnapshot("p-1", version, snapshot, expected);
    } catch (const std::exception& e) {
      out->err = e.what();
    }
  });
  return out;
}

std::shared_ptr<Rival> rivalRead(harness::Ctx& ctx, const std::string& key) {
  auto out = std::make_shared<Rival>();
  ctx.Redis.After(key, [out] {
    out->fired = true;
    try {
      out->seen = readPublished("p-1");
    } catch (const std::exception& e) {
      out->err = e.what();
    }
  });
  return out;
}

void settled(harness::Ctx& ctx, const Rival& r, const std::string& what) {
  ctx.Assert(r.fired, "nothing touched %s", what);
  ctx.Assert(!r.err, "the parallel call failed: %s", r.err.value_or(""));
}

}  // namespace

void CheckNoFieldSwap(harness::Ctx& ctx) {
  ctx.Equal(publishSnapshot("p-1", 1, kV1, 0), true, "the first publish (nothing published yet, expected 0) must move the pointer; moved");
  ctx.Equal(mustRead(ctx), kV1, "after publishing version 1, readPublished");
  // A storefront read lands while the publish of version 2 is writing: it must see one whole version.
  const auto shared = rivalRead(ctx, "catalog:p-1");
  const auto versioned = rivalRead(ctx, "catalog:p-1:v2");
  ctx.Equal(publishSnapshot("p-1", 2, kV2, 1), true, "publishing version 2 over version 1 (expected 1) must move the pointer; moved");
  for (const auto& probe : {shared, versioned}) {
    if (!probe->fired) continue;
    settled(ctx, *probe, "the key");
    if (probe->seen) whole(ctx, *probe->seen, "during the publish");
  }
  ctx.Equal(ctx.Redis.Type("catalog:p-1"), "none", "catalog:p-1 exists: the fields of every version share one hash, so a reader can see two versions in one response. Write the whole version under catalog:p-1:v2; its type");
  const auto raw = ctx.Redis.Get("catalog:p-1:v2");
  ctx.Assert(raw && json::parse(*raw) == kV2, "catalog:p-1:v2 holds %q, expected the whole version 2 as one JSON document", raw.value_or(""));
  ctx.Equal(mustRead(ctx), kV2, "after the second publish, readPublished");
}

void CheckOnePointer(harness::Ctx& ctx) {
  publishSnapshot("p-1", 1, kV1, 0);
  const auto keys = ctx.Redis.Keys("catalog:p-1*");
  ctx.Equal(ctx.Redis.Get("catalog:p-1:published"), std::optional<std::string>("1"), "catalog:p-1:published must hold the published version 1 (keys: %q)", keys);
  std::vector<std::string> regional;
  for (const auto& k : keys) {
    if (k.find("region") != std::string::npos) regional.push_back(k);
  }
  ctx.Assert(regional.empty(), "a second pointer %q is moved separately from catalog:p-1:published: regions can disagree about what is live. Keep one pointer per product", regional);
  ctx.Equal(keys, {"catalog:p-1:published", "catalog:p-1:v1"}, "a publish must leave exactly the snapshot and the pointer; Redis holds");
}

void CheckSingleRead(harness::Ctx& ctx) {
  publishSnapshot("p-1", 1, kV1, 0);
  // Version 2 is published right after the read resolved the pointer: the read must still answer one whole version.
  const auto rival = rivalPublish(ctx, "catalog:p-1:published", 2, kV2, 1);
  const json seen = mustRead(ctx);
  settled(ctx, *rival, "catalog:p-1:published");
  ctx.Equal(rival->moved, true, "the publish of version 2 that landed during the read must move the pointer; moved");
  whole(ctx, seen, "racing a publish");
  ctx.Equal(mustRead(ctx), kV2, "after the race, readPublished");
}

void CheckCasSwap(harness::Ctx& ctx) {
  ctx.Equal(publishSnapshot("p-1", 1, kV1, 0), true, "the first publish must move the pointer; moved");
  ctx.Equal(publishSnapshot("p-1", 2, kV2, 1), true, "a publish that expected version 1 while 1 is published must move the pointer; moved");
  ctx.Equal(publishSnapshot("p-1", 3, variant(kV2, 3, "Kettle, 3 L"), 1), false, "a publish that expected version 1 while 2 is published lost the race: the pointer must not move; moved");
  ctx.Equal(ctx.Redis.Get("catalog:p-1:published"), std::optional<std::string>("2"), "catalog:p-1:published after a stale publish");
  ctx.Equal(mustRead(ctx), kV2, "the storefront after a stale publish");
  // Another publisher wins the race between this publish's snapshot write and its swap.
  const json v9 = variant(kV2, 9, "Kettle, 9 L");
  const auto rival = rivalPublish(ctx, "catalog:p-1:v4", 9, v9, 2);
  const bool lost = publishSnapshot("p-1", 4, variant(kV2, 4, "Kettle, 4 L"), 2);
  settled(ctx, *rival, "catalog:p-1:v4");
  ctx.Equal(rival->moved, true, "the rival publish must move the pointer to 9; moved");
  ctx.Equal(lost, false, "the publish that lost the race must report false; moved");
  ctx.Equal(mustRead(ctx), v9, "the storefront after the race");
}
`,
  },
  hints: [
    'Publish a new price while a storefront read is in flight: the response carries the new price with the old title, and a region can serve a version the other has already replaced.',
    'Fields written one HSET at a time into one hash are visible one at a time; a plain SET of the pointer cannot tell whether another publisher moved it first.',
    'SET the whole JSON under `catalog:{id}:v{n}`, then one Lua script: GET the pointer, return 0 unless it equals `ARGV[2]`, else SET it to `ARGV[1]`. Read: GET pointer, GET that snapshot.',
  ],
  debrief: `The snapshot is immutable once written, so the only thing that has to be atomic is the pointer, and a pointer fits in one Lua compare-and-set. Writing the whole version under its own key is what makes a reader's two commands safe: the pointer it read names a document nobody will change. The region pointer went away for the same reason a second copy of any pointer should: two writes are two moments, and a reader can land between them. Production catalogs keep the last few snapshots for rollback, expire the rest, and publish the pointer move as an event so caches and edge nodes invalidate without polling.`,
};
