import type {Step} from '@/lib/types';

export const stateStep: Step = {
  id: 'state',
  title: 'Redis stages and the active pointer in one atomic swap',
  concept: 'redis',
  guides: ['atomic-state', 'model-output'],
  file: 'state',
  focus: ['registry', 'redis'],
  task: `## Task

**Starting point.** The starter owns the serving pointers: \`promote(name, version, pool, eval_id)\`
\`HSET\`s \`stage = promoted\` on \`model:{name}:v{n}\`, \`SET\`s \`active:{pool}\` to \`"{name}:{n}"\` and
keeps a copy in a process-local map; \`rollback(name, version, pool)\` sets \`stage = rolled_back\`;
\`resolve_active(pool)\` answers from the map, else from Redis. It serves the demo and hides four
flaws.

**Failure mode the checks target.** A rollback landing between the promote's two writes leaves the
pool on a version marked rolled back; another registryd instance moves the pointer and this one
keeps answering the old version; a rolled-back version keeps its traffic; and it is promoted again on
the eval record it failed with.

- \`resolve_active\` reads \`active:{pool}\` from Redis every time: no process-local copy.
- \`promote\` is **one Lua script** (\`EVAL\`, \`register_script\`): refuse a version that does not
  exist, set \`stage = promoted\` and the pointer together, return whether it moved.
- \`rollback\` is one script too: \`stage = rolled_back\`, and \`DEL active:{pool}\` only if the pointer
  still holds this version.
- A \`rolled_back\` version is promoted again only with an \`eval_id\` different from its stored one,
  which the script records.`,
  sequence: {
    participants: ['registryd', 'Redis', 'Other instance'],
    messages: [
      {from: 'registryd', to: 'Redis', label: 'EVAL promote model:fraud:v3 active:prod "fraud:3" e-3', kind: 'sync'},
      {from: 'Redis', to: 'registryd', label: '1 · stage promoted and pointer moved together', kind: 'reply'},
      {from: 'Other instance', to: 'Redis', label: 'GET active:prod', kind: 'sync'},
      {from: 'Redis', to: 'Other instance', label: 'fraud:3', kind: 'reply'},
      {from: 'registryd', to: 'Redis', label: 'EVAL rollback · stage rolled_back · DEL if still fraud:3', kind: 'sync'},
      {from: 'registryd', to: 'Redis', label: 'EVAL promote … e-3 → 0 · e-3b → 1', kind: 'sync'},
    ],
  },
  checks: [
    {
      id: 'shared-pointer',
      title: 'Every instance resolves the pointer from Redis',
      detail:
        '`resolve_active`/`resolveActive` reads `active:{pool}` from Redis on every call; a process-local map answers the version this instance promoted after another instance moved the pointer.',
      match: {
        python: {all: [/def resolve_active/, /\.get\(\s*pointer_key\(/], none: [/\bactive\[/, /\bactive\.get\(/]},
        typescript: {all: [/function resolveActive/, /redis\.get\(\s*pointerKey\(/], none: [/\bactive\.(get|set)\(/]},
        go: {all: [/func resolveActive/, /\.Get\([^\n]*pointerKey\(/], none: [/\bactive\[/]},
        scala: {
          all: [/def resolveActive/, /jedis\.get\(\s*pointerKey\(/],
          none: [/\bactive\.get\(/, /\bactive\(pool\)/],
        },
        cpp: {all: [/resolveActive\(/, /redis\.get\(\s*pointerKey\(/], none: [/\bactive\[/, /\bactive\.find\(/]},
      },
    },
    {
      id: 'atomic-promote',
      title: 'The stage and the pointer move in one script',
      detail:
        'Promotion is one Lua script (`register_script`/`eval`, `defineCommand`, `NewScript`) that sets the stage and the pointer; separate `HSET` and `SET` round trips let a rollback land between them.',
      match: {
        python: {
          all: [/register_script\(|\.eval\(/, /redis\.call\(\s*['"]SET['"]/],
          none: [/\br\.set\(/, /\br\.hset\(/],
        },
        typescript: {all: [/defineCommand\(|\.eval\(/, /redis\.call\(\s*['"]SET['"]/], none: [/redis\.(hset|set)\(/]},
        go: {all: [/redis\.NewScript\(|\.Eval\(/, /redis\.call\(\s*['"]SET['"]/], none: [/rdb\.(HSet|Set)\(/]},
        scala: {all: [/jedis\.eval(sha)?\(/, /redis\.call\(\s*['"]SET['"]/], none: [/jedis\.(hset|set)\(/]},
        cpp: {all: [/redis\.eval(sha)?[<(]/, /redis\.call\(\s*['"]SET['"]/], none: [/redis\.(hset|set)\(/]},
      },
    },
    {
      id: 'rollback-clears',
      title: 'A rollback clears the pointer that still holds the version',
      detail:
        "The rollback script sets `stage = rolled_back` and deletes `active:{pool}` when it still holds this version (`GET` compared, then `DEL`), so traffic stops and another version's pointer is left alone.",
      match: {
        python: {all: [/redis\.call\(\s*['"]DEL['"]/, /redis\.call\(\s*['"]GET['"]/]},
        typescript: {all: [/redis\.call\(\s*['"]DEL['"]/, /redis\.call\(\s*['"]GET['"]/]},
        go: {all: [/redis\.call\(\s*['"]DEL['"]/, /redis\.call\(\s*['"]GET['"]/]},
        scala: {all: [/redis\.call\(\s*['"]DEL['"]/, /redis\.call\(\s*['"]GET['"]/]},
        cpp: {all: [/redis\.call\(\s*['"]DEL['"]/, /redis\.call\(\s*['"]GET['"]/]},
      },
    },
    {
      id: 'new-eval-gate',
      title: 'A rolled-back version needs a new eval record',
      detail:
        "The promote script reads the stage and, for `rolled_back`, compares the stored `eval_id` with the caller's: the same record is refused, a new one is recorded and promoted.",
      match: {
        python: {all: [/rolled_back/, /['"]HGET['"][^)\n]*eval_id/]},
        typescript: {all: [/rolled_back/, /['"]HGET['"][^)\n]*eval_id/]},
        go: {all: [/rolled_back/, /['"]HGET['"][^)\n]*eval_id/]},
        scala: {all: [/rolled_back/, /['"]HGET['"][^)\n]*eval_id/]},
        cpp: {all: [/rolled_back/, /['"]HGET['"][^)\n]*eval_id/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

# pool → "name:version" this instance promoted: resolve_active answers without a round trip.
active: dict[str, str] = {}


def version_key(name: str, version: int) -> str:
    return f"model:{name}:v{version}"


def pointer_key(pool: str) -> str:
    return f"active:{pool}"


def promote(name: str, version: int, pool: str, eval_id: str) -> bool:
    """Make version the one pool serves; eval_id is the eval record that opened the gate."""
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    ref = f"{name}:{version}"
    r.hset(version_key(name, version), "stage", "promoted")
    r.set(pointer_key(pool), ref)
    active[pool] = ref
    return True


def rollback(name: str, version: int, pool: str) -> bool:
    """Take version out of pool; False when the version does not exist."""
    if not r.exists(version_key(name, version)):
        return False
    r.hset(version_key(name, version), "stage", "rolled_back")
    return True


def resolve_active(pool: str) -> str | None:
    """The "name:version" pool serves, or None."""
    return active.get(pool) or r.get(pointer_key(pool))
`,
      solution: `import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

# KEYS[1] model:{name}:v{n}, KEYS[2] active:{pool}; ARGV[1] "{name}:{n}", ARGV[2] the eval record.
# A rolled-back version serves again only on an eval record it has not failed with.
PROMOTE_LUA = """
local stage = redis.call('HGET', KEYS[1], 'stage')
if not stage then return 0 end
if stage == 'rolled_back' then
  if redis.call('HGET', KEYS[1], 'eval_id') == ARGV[2] then return 0 end
  redis.call('HSET', KEYS[1], 'eval_id', ARGV[2])
end
redis.call('HSET', KEYS[1], 'stage', 'promoted')
redis.call('SET', KEYS[2], ARGV[1])
return 1
"""
# The pointer is cleared only if it still names this version: another version's traffic stays.
ROLLBACK_LUA = """
if not redis.call('HGET', KEYS[1], 'stage') then return 0 end
redis.call('HSET', KEYS[1], 'stage', 'rolled_back')
if redis.call('GET', KEYS[2]) == ARGV[1] then redis.call('DEL', KEYS[2]) end
return 1
"""
promote_script = r.register_script(PROMOTE_LUA)
rollback_script = r.register_script(ROLLBACK_LUA)


def version_key(name: str, version: int) -> str:
    return f"model:{name}:v{version}"


def pointer_key(pool: str) -> str:
    return f"active:{pool}"


def promote(name: str, version: int, pool: str, eval_id: str) -> bool:
    """Make version the one pool serves; eval_id is the eval record that opened the gate."""
    return promote_script(keys=[version_key(name, version), pointer_key(pool)], args=[f"{name}:{version}", eval_id]) == 1


def rollback(name: str, version: int, pool: str) -> bool:
    """Take version out of pool; False when the version does not exist."""
    return rollback_script(keys=[version_key(name, version), pointer_key(pool)], args=[f"{name}:{version}"]) == 1


def resolve_active(pool: str) -> str | None:
    """The "name:version" pool serves, or None."""
    return r.get(pointer_key(pool))
`,
    },
    typescript: {
      starter: `import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

/** pool → "name:version" this instance promoted: resolveActive answers without a round trip. */
const active = new Map<string, string>();

export const versionKey = (name: string, version: number): string => \`model:\${name}:v\${version}\`;
export const pointerKey = (pool: string): string => \`active:\${pool}\`;

/** Make version the one pool serves; evalId is the eval record that opened the gate. */
export async function promote(name: string, version: number, pool: string, evalId: string): Promise<boolean> {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const ref = \`\${name}:\${version}\`;
  await redis.hset(versionKey(name, version), 'stage', 'promoted');
  await redis.set(pointerKey(pool), ref);
  active.set(pool, ref);
  return true;
}

/** Take version out of pool; false when the version does not exist. */
export async function rollback(name: string, version: number, pool: string): Promise<boolean> {
  if ((await redis.exists(versionKey(name, version))) === 0) return false;
  await redis.hset(versionKey(name, version), 'stage', 'rolled_back');
  return true;
}

/** The "name:version" pool serves, or null. */
export async function resolveActive(pool: string): Promise<string | null> {
  return active.get(pool) ?? (await redis.get(pointerKey(pool)));
}
`,
      solution: `import Redis from 'ioredis';

/** KEYS[1] model:{name}:v{n}, KEYS[2] active:{pool}; ARGV[1] "{name}:{n}", ARGV[2] the eval record.
 * A rolled-back version serves again only on an eval record it has not failed with. */
export const PROMOTE_LUA = \`
local stage = redis.call('HGET', KEYS[1], 'stage')
if not stage then return 0 end
if stage == 'rolled_back' then
  if redis.call('HGET', KEYS[1], 'eval_id') == ARGV[2] then return 0 end
  redis.call('HSET', KEYS[1], 'eval_id', ARGV[2])
end
redis.call('HSET', KEYS[1], 'stage', 'promoted')
redis.call('SET', KEYS[2], ARGV[1])
return 1
\`;

/** The pointer is cleared only if it still names this version: another version's traffic stays. */
export const ROLLBACK_LUA = \`
if not redis.call('HGET', KEYS[1], 'stage') then return 0 end
redis.call('HSET', KEYS[1], 'stage', 'rolled_back')
if redis.call('GET', KEYS[2]) == ARGV[1] then redis.call('DEL', KEYS[2]) end
return 1
\`;

interface PointerRedis extends Redis {
  promoteVersion(versionKey: string, pointerKey: string, ref: string, evalId: string): Promise<number>;
  rollbackVersion(versionKey: string, pointerKey: string, ref: string): Promise<number>;
}

const redis = new Redis({host: 'redis', port: 6379}) as PointerRedis;
redis.defineCommand('promoteVersion', {numberOfKeys: 2, lua: PROMOTE_LUA});
redis.defineCommand('rollbackVersion', {numberOfKeys: 2, lua: ROLLBACK_LUA});

export const versionKey = (name: string, version: number): string => \`model:\${name}:v\${version}\`;
export const pointerKey = (pool: string): string => \`active:\${pool}\`;

/** Make version the one pool serves; evalId is the eval record that opened the gate. */
export async function promote(name: string, version: number, pool: string, evalId: string): Promise<boolean> {
  return (await redis.promoteVersion(versionKey(name, version), pointerKey(pool), \`\${name}:\${version}\`, evalId)) === 1;
}

/** Take version out of pool; false when the version does not exist. */
export async function rollback(name: string, version: number, pool: string): Promise<boolean> {
  return (await redis.rollbackVersion(versionKey(name, version), pointerKey(pool), \`\${name}:\${version}\`)) === 1;
}

/** The "name:version" pool serves, or null. */
export async function resolveActive(pool: string): Promise<string | null> {
  return redis.get(pointerKey(pool));
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"fmt"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// active maps pool → "name:version" this instance promoted: resolveActive answers without a round trip.
var active = map[string]string{}

func versionKey(name string, version int) string { return fmt.Sprintf("model:%s:v%d", name, version) }

func pointerKey(pool string) string { return "active:" + pool }

// promote makes version the one pool serves; evalID is the eval record that opened the gate.
func promote(ctx context.Context, name string, version int, pool, evalID string) (bool, error) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	ref := fmt.Sprintf("%s:%d", name, version)
	if err := rdb.HSet(ctx, versionKey(name, version), "stage", "promoted").Err(); err != nil {
		return false, err
	}
	if err := rdb.Set(ctx, pointerKey(pool), ref, 0).Err(); err != nil {
		return false, err
	}
	active[pool] = ref
	return true, nil
}

// rollback takes version out of pool; false when the version does not exist.
func rollback(ctx context.Context, name string, version int, pool string) (bool, error) {
	n, err := rdb.Exists(ctx, versionKey(name, version)).Result()
	if err != nil || n == 0 {
		return false, err
	}
	return true, rdb.HSet(ctx, versionKey(name, version), "stage", "rolled_back").Err()
}

// resolveActive is the "name:version" pool serves, or "".
func resolveActive(ctx context.Context, pool string) (string, error) {
	if ref, ok := active[pool]; ok {
		return ref, nil
	}
	ref, err := rdb.Get(ctx, pointerKey(pool)).Result()
	if err == redis.Nil {
		return "", nil
	}
	return ref, err
}
`,
      solution: `package main

import (
	"context"
	"fmt"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// KEYS[1] model:{name}:v{n}, KEYS[2] active:{pool}; ARGV[1] "{name}:{n}", ARGV[2] the eval record.
// A rolled-back version serves again only on an eval record it has not failed with.
var promoteScript = redis.NewScript(\`
local stage = redis.call('HGET', KEYS[1], 'stage')
if not stage then return 0 end
if stage == 'rolled_back' then
  if redis.call('HGET', KEYS[1], 'eval_id') == ARGV[2] then return 0 end
  redis.call('HSET', KEYS[1], 'eval_id', ARGV[2])
end
redis.call('HSET', KEYS[1], 'stage', 'promoted')
redis.call('SET', KEYS[2], ARGV[1])
return 1
\`)

// The pointer is cleared only if it still names this version: another version's traffic stays.
var rollbackScript = redis.NewScript(\`
if not redis.call('HGET', KEYS[1], 'stage') then return 0 end
redis.call('HSET', KEYS[1], 'stage', 'rolled_back')
if redis.call('GET', KEYS[2]) == ARGV[1] then redis.call('DEL', KEYS[2]) end
return 1
\`)

func versionKey(name string, version int) string { return fmt.Sprintf("model:%s:v%d", name, version) }

func pointerKey(pool string) string { return "active:" + pool }

// promote makes version the one pool serves; evalID is the eval record that opened the gate.
func promote(ctx context.Context, name string, version int, pool, evalID string) (bool, error) {
	ref := fmt.Sprintf("%s:%d", name, version)
	moved, err := promoteScript.Run(ctx, rdb, []string{versionKey(name, version), pointerKey(pool)}, ref, evalID).Int64()
	return moved == 1, err
}

// rollback takes version out of pool; false when the version does not exist.
func rollback(ctx context.Context, name string, version int, pool string) (bool, error) {
	ref := fmt.Sprintf("%s:%d", name, version)
	done, err := rollbackScript.Run(ctx, rdb, []string{versionKey(name, version), pointerKey(pool)}, ref).Int64()
	return done == 1, err
}

// resolveActive is the "name:version" pool serves, or "".
func resolveActive(ctx context.Context, pool string) (string, error) {
	ref, err := rdb.Get(ctx, pointerKey(pool)).Result()
	if err == redis.Nil {
		return "", nil
	}
	return ref, err
}
`,
    },
    scala: {
      starter: `import redis.clients.jedis.JedisPooled

object State {
  val jedis = new JedisPooled("redis", 6379)

  /** pool → "name:version" this instance promoted: resolveActive answers without a round trip. */
  private val active = scala.collection.mutable.Map.empty[String, String]

  def versionKey(name: String, version: Long): String = s"model:$name:v$version"
  def pointerKey(pool: String): String = s"active:$pool"

  /** Make version the one pool serves; evalId is the eval record that opened the gate. */
  def promote(name: String, version: Long, pool: String, evalId: String): Boolean = {
    // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    val ref = s"$name:$version"
    jedis.hset(versionKey(name, version), "stage", "promoted")
    jedis.set(pointerKey(pool), ref)
    active(pool) = ref
    true
  }

  /** Take version out of pool; false when the version does not exist. */
  def rollback(name: String, version: Long, pool: String): Boolean =
    jedis.exists(versionKey(name, version)) && { jedis.hset(versionKey(name, version), "stage", "rolled_back"); true }

  /** The "name:version" pool serves, or None. */
  def resolveActive(pool: String): Option[String] = active.get(pool).orElse(Option(jedis.get(pointerKey(pool))))
}
`,
      solution: `import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

object State {
  val jedis = new JedisPooled("redis", 6379)

  /** KEYS[1] model:{name}:v{n}, KEYS[2] active:{pool}; ARGV[1] "{name}:{n}", ARGV[2] the eval record.
   * A rolled-back version serves again only on an eval record it has not failed with. */
  val PromoteLua: String =
    """local stage = redis.call('HGET', KEYS[1], 'stage')
      |if not stage then return 0 end
      |if stage == 'rolled_back' then
      |  if redis.call('HGET', KEYS[1], 'eval_id') == ARGV[2] then return 0 end
      |  redis.call('HSET', KEYS[1], 'eval_id', ARGV[2])
      |end
      |redis.call('HSET', KEYS[1], 'stage', 'promoted')
      |redis.call('SET', KEYS[2], ARGV[1])
      |return 1
      |""".stripMargin

  /** The pointer is cleared only if it still names this version: another version's traffic stays. */
  val RollbackLua: String =
    """if not redis.call('HGET', KEYS[1], 'stage') then return 0 end
      |redis.call('HSET', KEYS[1], 'stage', 'rolled_back')
      |if redis.call('GET', KEYS[2]) == ARGV[1] then redis.call('DEL', KEYS[2]) end
      |return 1
      |""".stripMargin

  def versionKey(name: String, version: Long): String = s"model:$name:v$version"
  def pointerKey(pool: String): String = s"active:$pool"

  /** Make version the one pool serves; evalId is the eval record that opened the gate. */
  def promote(name: String, version: Long, pool: String, evalId: String): Boolean =
    jedis.eval(PromoteLua, List(versionKey(name, version), pointerKey(pool)).asJava, List(s"$name:$version", evalId).asJava).asInstanceOf[java.lang.Long] == 1L

  /** Take version out of pool; false when the version does not exist. */
  def rollback(name: String, version: Long, pool: String): Boolean =
    jedis.eval(RollbackLua, List(versionKey(name, version), pointerKey(pool)).asJava, List(s"$name:$version").asJava).asInstanceOf[java.lang.Long] == 1L

  /** The "name:version" pool serves, or None. */
  def resolveActive(pool: String): Option[String] = Option(jedis.get(pointerKey(pool)))
}
`,
    },
    cpp: {
      starter: `#include <sw/redis++/redis++.h>

#include <map>
#include <optional>
#include <string>

sw::redis::Redis redis("tcp://redis:6379");

// pool → "name:version" this instance promoted: resolveActive answers without a round trip.
std::map<std::string, std::string> active;

std::string versionKey(const std::string& name, long version) { return "model:" + name + ":v" + std::to_string(version); }
std::string pointerKey(const std::string& pool) { return "active:" + pool; }

// Make version the one pool serves; eval_id is the eval record that opened the gate.
bool promote(const std::string& name, long version, const std::string& pool, const std::string& eval_id) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const std::string ref = name + ":" + std::to_string(version);
  redis.hset(versionKey(name, version), "stage", "promoted");
  redis.set(pointerKey(pool), ref);
  active[pool] = ref;
  return true;
}

// Take version out of pool; false when the version does not exist.
bool rollback(const std::string& name, long version, const std::string& pool) {
  if (!redis.exists(versionKey(name, version))) return false;
  redis.hset(versionKey(name, version), "stage", "rolled_back");
  return true;
}

// The "name:version" pool serves, or none.
std::optional<std::string> resolveActive(const std::string& pool) {
  if (const auto it = active.find(pool); it != active.end()) return it->second;
  const auto ref = redis.get(pointerKey(pool));
  if (!ref) return std::nullopt;
  return *ref;
}
`,
      solution: `#include <sw/redis++/redis++.h>

#include <optional>
#include <string>

sw::redis::Redis redis("tcp://redis:6379");

// KEYS[1] model:{name}:v{n}, KEYS[2] active:{pool}; ARGV[1] "{name}:{n}", ARGV[2] the eval record.
// A rolled-back version serves again only on an eval record it has not failed with.
const std::string kPromoteLua = R"lua(
local stage = redis.call('HGET', KEYS[1], 'stage')
if not stage then return 0 end
if stage == 'rolled_back' then
  if redis.call('HGET', KEYS[1], 'eval_id') == ARGV[2] then return 0 end
  redis.call('HSET', KEYS[1], 'eval_id', ARGV[2])
end
redis.call('HSET', KEYS[1], 'stage', 'promoted')
redis.call('SET', KEYS[2], ARGV[1])
return 1
)lua";

// The pointer is cleared only if it still names this version: another version's traffic stays.
const std::string kRollbackLua = R"lua(
if not redis.call('HGET', KEYS[1], 'stage') then return 0 end
redis.call('HSET', KEYS[1], 'stage', 'rolled_back')
if redis.call('GET', KEYS[2]) == ARGV[1] then redis.call('DEL', KEYS[2]) end
return 1
)lua";

std::string versionKey(const std::string& name, long version) { return "model:" + name + ":v" + std::to_string(version); }
std::string pointerKey(const std::string& pool) { return "active:" + pool; }

// Make version the one pool serves; eval_id is the eval record that opened the gate.
bool promote(const std::string& name, long version, const std::string& pool, const std::string& eval_id) {
  const std::string ref = name + ":" + std::to_string(version);
  return redis.eval<long long>(kPromoteLua, {versionKey(name, version), pointerKey(pool)}, {ref, eval_id}) == 1;
}

// Take version out of pool; false when the version does not exist.
bool rollback(const std::string& name, long version, const std::string& pool) {
  const std::string ref = name + ":" + std::to_string(version);
  return redis.eval<long long>(kRollbackLua, {versionKey(name, version), pointerKey(pool)}, {ref}) == 1;
}

// The "name:version" pool serves, or none.
std::optional<std::string> resolveActive(const std::string& pool) {
  const auto ref = redis.get(pointerKey(pool));
  if (!ref) return std::nullopt;
  return *ref;
}
`,
    },
  },
  harness: {
    python: `def _state(ctx):
    m = ctx.load("state")
    for n in (2, 3):
        ctx.redis.hset(
            f"model:fraud:v{n}",
            mapping={"name": "fraud", "version": n, "artifact_digest": f"sha256:a{n}", "training_run_id": f"r-{n}", "eval_id": f"e-{n}", "stage": "staged"},
        )
    return m


def _stage(ctx, n=3):
    return ctx.redis.hget(f"model:fraud:v{n}", "stage")


def check_shared_pointer(ctx):
    m = _state(ctx)
    assert m.promote("fraud", 3, "prod", "e-3") is True, "promoting staged fraud version 3 must move the pointer"
    assert ctx.redis.get("active:prod") == "fraud:3", f"active:prod holds {ctx.redis.get('active:prod')!r} after the promote, expected fraud:3"
    assert m.resolve_active("prod") == "fraud:3", f"resolve_active('prod') answers {m.resolve_active('prod')!r}, expected fraud:3"
    # Another registryd instance promotes version 2: its script moves the same key.
    ctx.redis.set("active:prod", "fraud:2")
    seen = m.resolve_active("prod")
    assert seen == "fraud:2", f"another instance moved active:prod to fraud:2 and this instance still answers {seen!r}: a process-local copy of the pointer. Read active:{{pool}} from Redis"
    ctx.redis.delete("active:prod")
    seen = m.resolve_active("prod")
    assert seen is None, f"active:prod was cleared and resolve_active still answers {seen!r}"


def check_atomic_promote(ctx):
    m = _state(ctx)
    # An operator's rollback of version 3 lands while the promote is writing.
    rival = ctx.redis_after("model:fraud:v3", lambda: m.rollback("fraud", 3, "prod"))
    m.promote("fraud", 3, "prod", "e-3")
    assert rival.fired, "the promote never touched model:fraud:v3"
    if rival.error is not None:
        raise rival.error
    stage, pointer = _stage(ctx), ctx.redis.get("active:prod")
    if stage == "promoted":
        assert pointer == "fraud:3", f"fraud version 3 is promoted and active:prod holds {pointer!r}"
    else:
        assert pointer != "fraud:3", f"a rollback landed between the promote's writes: fraud version 3 is {stage} and prod still serves it. The stage and the pointer must move in one script"


def check_rollback_clears(ctx):
    m = _state(ctx)
    assert m.promote("fraud", 3, "prod", "e-3") is True, "promoting staged fraud version 3 must move the pointer"
    assert m.rollback("fraud", 2, "prod") is True, "rolling back fraud version 2 (it exists) must answer True"
    assert ctx.redis.get("active:prod") == "fraud:3", f"rolling back version 2, which prod does not serve, left active:prod at {ctx.redis.get('active:prod')!r}: another version's traffic must stay"
    assert m.rollback("fraud", 3, "prod") is True, "rolling back fraud version 3 must answer True"
    assert _stage(ctx) == "rolled_back", f"fraud version 3 is {_stage(ctx)!r} after its rollback"
    pointer = ctx.redis.get("active:prod")
    assert pointer is None, f"active:prod still holds {pointer!r} after version 3 was rolled back: prod keeps serving the version it was taken out of"
    assert m.resolve_active("prod") is None, f"resolve_active('prod') answers {m.resolve_active('prod')!r} after the rollback"
    assert m.rollback("fraud", 9, "prod") is False, "rolling back a version that does not exist must answer False"


def check_new_eval_gate(ctx):
    m = _state(ctx)
    assert m.promote("fraud", 3, "prod", "e-3") is True, "promoting staged fraud version 3 must move the pointer"
    m.rollback("fraud", 3, "prod")
    again = m.promote("fraud", 3, "prod", "e-3")
    assert again is False and ctx.redis.get("active:prod") is None, f"a rolled-back version was promoted again on the eval record it failed with (returned {again!r}, active:prod {ctx.redis.get('active:prod')!r}): it needs a new eval record"
    assert _stage(ctx) == "rolled_back", f"the refused promote left fraud version 3 {_stage(ctx)!r}"
    assert m.promote("fraud", 3, "prod", "e-3b") is True, "with a new eval record the rolled-back version must be promoted"
    assert _stage(ctx) == "promoted" and ctx.redis.hget("model:fraud:v3", "eval_id") == "e-3b", f"after the re-promotion fraud version 3 is {ctx.redis.hgetall('model:fraud:v3')}, expected promoted with eval_id e-3b"
    assert ctx.redis.get("active:prod") == "fraud:3", f"active:prod holds {ctx.redis.get('active:prod')!r} after the re-promotion"
    assert m.promote("fraud", 9, "prod", "e-9") is False, "promoting a version that does not exist must answer False"
    assert ctx.redis.exists("model:fraud:v9") == 0, "promoting a missing version created model:fraud:v9"
    assert ctx.redis.get("active:prod") == "fraud:3", f"promoting a missing version moved active:prod to {ctx.redis.get('active:prod')!r}"
`,
    typescript: `async function state(ctx) {
  const m = ctx.load('state');
  for (const n of [2, 3]) {
    ctx.redis.hset(\`model:fraud:v\${n}\`, 'name', 'fraud', 'version', String(n), 'artifact_digest', \`sha256:a\${n}\`, 'training_run_id', \`r-\${n}\`, 'eval_id', \`e-\${n}\`, 'stage', 'staged');
  }
  return m;
}

const stage = (ctx, n = 3) => ctx.redis.hget(\`model:fraud:v\${n}\`, 'stage');

export async function check_shared_pointer(ctx) {
  const m = await state(ctx);
  assert.equal(await m.promote('fraud', 3, 'prod', 'e-3'), true, 'promoting staged fraud version 3 must move the pointer');
  assert.equal(ctx.redis.get('active:prod'), 'fraud:3', \`active:prod holds \${ctx.redis.get('active:prod')} after the promote, expected fraud:3\`);
  assert.equal(await m.resolveActive('prod'), 'fraud:3', 'resolveActive(prod) must answer fraud:3');
  // Another registryd instance promotes version 2: its script moves the same key.
  ctx.redis.set('active:prod', 'fraud:2');
  let seen = await m.resolveActive('prod');
  assert.equal(seen, 'fraud:2', \`another instance moved active:prod to fraud:2 and this instance still answers \${seen}: a process-local copy of the pointer. Read active:{pool} from Redis\`);
  ctx.redis.del('active:prod');
  seen = await m.resolveActive('prod');
  assert.equal(seen, null, \`active:prod was cleared and resolveActive still answers \${seen}\`);
}

export async function check_atomic_promote(ctx) {
  const m = await state(ctx);
  // An operator's rollback of version 3 lands while the promote is writing.
  const rival = ctx.redisAfter('model:fraud:v3', () => m.rollback('fraud', 3, 'prod'));
  await m.promote('fraud', 3, 'prod', 'e-3');
  assert(rival.fired, 'the promote never touched model:fraud:v3');
  if (rival.error !== undefined) throw rival.error;
  await rival.result;
  const s = stage(ctx);
  const pointer = ctx.redis.get('active:prod');
  if (s === 'promoted') assert.equal(pointer, 'fraud:3', \`fraud version 3 is promoted and active:prod holds \${pointer}\`);
  else assert.notEqual(pointer, 'fraud:3', \`a rollback landed between the promote's writes: fraud version 3 is \${s} and prod still serves it. The stage and the pointer must move in one script\`);
}

export async function check_rollback_clears(ctx) {
  const m = await state(ctx);
  assert.equal(await m.promote('fraud', 3, 'prod', 'e-3'), true, 'promoting staged fraud version 3 must move the pointer');
  assert.equal(await m.rollback('fraud', 2, 'prod'), true, 'rolling back fraud version 2 (it exists) must answer true');
  assert.equal(ctx.redis.get('active:prod'), 'fraud:3', \`rolling back version 2, which prod does not serve, left active:prod at \${ctx.redis.get('active:prod')}: another version's traffic must stay\`);
  assert.equal(await m.rollback('fraud', 3, 'prod'), true, 'rolling back fraud version 3 must answer true');
  assert.equal(stage(ctx), 'rolled_back', \`fraud version 3 is \${stage(ctx)} after its rollback\`);
  const pointer = ctx.redis.get('active:prod');
  assert.equal(pointer, null, \`active:prod still holds \${pointer} after version 3 was rolled back: prod keeps serving the version it was taken out of\`);
  assert.equal(await m.resolveActive('prod'), null, 'resolveActive(prod) must answer null after the rollback');
  assert.equal(await m.rollback('fraud', 9, 'prod'), false, 'rolling back a version that does not exist must answer false');
}

export async function check_new_eval_gate(ctx) {
  const m = await state(ctx);
  assert.equal(await m.promote('fraud', 3, 'prod', 'e-3'), true, 'promoting staged fraud version 3 must move the pointer');
  await m.rollback('fraud', 3, 'prod');
  const again = await m.promote('fraud', 3, 'prod', 'e-3');
  assert(again === false && ctx.redis.get('active:prod') === null, \`a rolled-back version was promoted again on the eval record it failed with (returned \${again}, active:prod \${ctx.redis.get('active:prod')}): it needs a new eval record\`);
  assert.equal(stage(ctx), 'rolled_back', \`the refused promote left fraud version 3 \${stage(ctx)}\`);
  assert.equal(await m.promote('fraud', 3, 'prod', 'e-3b'), true, 'with a new eval record the rolled-back version must be promoted');
  assert(stage(ctx) === 'promoted' && ctx.redis.hget('model:fraud:v3', 'eval_id') === 'e-3b', \`after the re-promotion fraud version 3 is \${stage(ctx)} with eval_id \${ctx.redis.hget('model:fraud:v3', 'eval_id')}, expected promoted with e-3b\`);
  assert.equal(ctx.redis.get('active:prod'), 'fraud:3', 'active:prod must hold fraud:3 after the re-promotion');
  assert.equal(await m.promote('fraud', 9, 'prod', 'e-9'), false, 'promoting a version that does not exist must answer false');
  assert.equal(ctx.redis.exists('model:fraud:v9'), 0, 'promoting a missing version created model:fraud:v9');
  assert.equal(ctx.redis.get('active:prod'), 'fraud:3', 'promoting a missing version must leave active:prod at fraud:3');
}
`,
    go: `package main

import (
	"context"
	"fmt"

	"leetbuild/harness"
)

var stateBg = context.Background()

func seedVersions(ctx *harness.Ctx) {
	for _, n := range []int{2, 3} {
		ctx.Redis.Do("HSET", fmt.Sprintf("model:fraud:v%d", n), "name", "fraud", "version", fmt.Sprint(n), "artifact_digest", fmt.Sprintf("sha256:a%d", n),
			"training_run_id", fmt.Sprintf("r-%d", n), "eval_id", fmt.Sprintf("e-%d", n), "stage", "staged")
	}
}

func stageOf(ctx *harness.Ctx, n int) string {
	s, _ := ctx.Redis.HGet(fmt.Sprintf("model:fraud:v%d", n), "stage")
	return s
}

func pointerOf(ctx *harness.Ctx) string {
	p, _ := ctx.Redis.Get("active:prod")
	return p
}

func mustPromote(ctx *harness.Ctx, version int, evalID string) bool {
	moved, err := promote(stateBg, "fraud", version, "prod", evalID)
	ctx.NoError(err, "promote(fraud, %d, prod, %s) failed", version, evalID)
	return moved
}

func mustRollback(ctx *harness.Ctx, version int) bool {
	done, err := rollback(stateBg, "fraud", version, "prod")
	ctx.NoError(err, "rollback(fraud, %d, prod) failed", version)
	return done
}

func mustResolve(ctx *harness.Ctx) string {
	ref, err := resolveActive(stateBg, "prod")
	ctx.NoError(err, "resolveActive(prod) failed")
	return ref
}

func CheckSharedPointer(ctx *harness.Ctx) {
	seedVersions(ctx)
	ctx.Equal(mustPromote(ctx, 3, "e-3"), true, "promoting staged fraud version 3 must move the pointer; moved")
	ctx.Equal(pointerOf(ctx), "fraud:3", "active:prod after the promote")
	ctx.Equal(mustResolve(ctx), "fraud:3", "resolveActive(prod)")
	// Another registryd instance promotes version 2: its script moves the same key.
	ctx.Redis.Set("active:prod", "fraud:2")
	ctx.Equal(mustResolve(ctx), "fraud:2", "another instance moved active:prod to fraud:2: a process-local copy of the pointer answers the old one. Read active:{pool} from Redis; resolveActive(prod)")
	ctx.Redis.Del("active:prod")
	ctx.Equal(mustResolve(ctx), "", "active:prod was cleared; resolveActive(prod)")
}

func CheckAtomicPromote(ctx *harness.Ctx) {
	seedVersions(ctx)
	// An operator's rollback of version 3 lands while the promote is writing.
	rival := ctx.Redis.After("model:fraud:v3", func() any {
		done, err := rollback(stateBg, "fraud", 3, "prod")
		ctx.NoError(err, "the rival rollback failed")
		return done
	})
	mustPromote(ctx, 3, "e-3")
	ctx.Assert(rival.Fired, "the promote never touched model:fraud:v3")
	ctx.Assert(rival.Err == nil, "the rival rollback failed: %v", rival.Err)
	stage, pointer := stageOf(ctx, 3), pointerOf(ctx)
	if stage == "promoted" {
		ctx.Equal(pointer, "fraud:3", "fraud version 3 is promoted; active:prod")
	} else {
		ctx.Assert(pointer != "fraud:3", "a rollback landed between the promote's writes: fraud version 3 is %s and prod still serves it. The stage and the pointer must move in one script", stage)
	}
}

func CheckRollbackClears(ctx *harness.Ctx) {
	seedVersions(ctx)
	ctx.Equal(mustPromote(ctx, 3, "e-3"), true, "promoting staged fraud version 3 must move the pointer; moved")
	ctx.Equal(mustRollback(ctx, 2), true, "rolling back fraud version 2 (it exists); done")
	ctx.Equal(pointerOf(ctx), "fraud:3", "rolling back version 2, which prod does not serve, must leave another version's traffic; active:prod")
	ctx.Equal(mustRollback(ctx, 3), true, "rolling back fraud version 3; done")
	ctx.Equal(stageOf(ctx, 3), "rolled_back", "the stage of fraud version 3 after its rollback")
	ctx.Equal(ctx.Redis.Exists("active:prod"), 0, "active:prod still holds fraud:3 after version 3 was rolled back: prod keeps serving the version it was taken out of; active:prod exists")
	ctx.Equal(mustResolve(ctx), "", "resolveActive(prod) after the rollback")
	ctx.Equal(mustRollback(ctx, 9), false, "rolling back a version that does not exist; done")
}

func CheckNewEvalGate(ctx *harness.Ctx) {
	seedVersions(ctx)
	ctx.Equal(mustPromote(ctx, 3, "e-3"), true, "promoting staged fraud version 3 must move the pointer; moved")
	mustRollback(ctx, 3)
	again := mustPromote(ctx, 3, "e-3")
	ctx.Assert(!again && ctx.Redis.Exists("active:prod") == 0, "a rolled-back version was promoted again on the eval record it failed with (returned %v, active:prod %q): it needs a new eval record", again, pointerOf(ctx))
	ctx.Equal(stageOf(ctx, 3), "rolled_back", "the refused promote must leave fraud version 3 rolled back; the stage")
	ctx.Equal(mustPromote(ctx, 3, "e-3b"), true, "with a new eval record the rolled-back version must be promoted; moved")
	evalID, _ := ctx.Redis.HGet("model:fraud:v3", "eval_id")
	ctx.Assert(stageOf(ctx, 3) == "promoted" && evalID == "e-3b", "after the re-promotion fraud version 3 is %s with eval_id %s, expected promoted with e-3b", stageOf(ctx, 3), evalID)
	ctx.Equal(pointerOf(ctx), "fraud:3", "active:prod after the re-promotion")
	ctx.Equal(mustPromote(ctx, 9, "e-9"), false, "promoting a version that does not exist; moved")
	ctx.Equal(ctx.Redis.Exists("model:fraud:v9"), 0, "promoting a missing version must not create it; model:fraud:v9 exists")
	ctx.Equal(pointerOf(ctx), "fraud:3", "promoting a missing version must leave active:prod")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <memory>
#include <optional>
#include <string>

namespace {

void seedVersions(harness::Ctx& ctx) {
  for (const int n : {2, 3}) {
    const std::string s = std::to_string(n);
    ctx.Redis.Do("HSET", "model:fraud:v" + s, "name", "fraud", "version", s, "artifact_digest", "sha256:a" + s, "training_run_id", "r-" + s,
                 "eval_id", "e-" + s, "stage", "staged");
  }
}

std::string stageOf(harness::Ctx& ctx, int n) { return ctx.Redis.HGet("model:fraud:v" + std::to_string(n), "stage").value_or(""); }
std::string pointerOf(harness::Ctx& ctx) { return ctx.Redis.Get("active:prod").value_or(""); }

}  // namespace

void CheckSharedPointer(harness::Ctx& ctx) {
  seedVersions(ctx);
  ctx.Equal(promote("fraud", 3, "prod", "e-3"), true, "promoting staged fraud version 3 must move the pointer; moved");
  ctx.Equal(pointerOf(ctx), "fraud:3", "active:prod after the promote");
  ctx.Equal(resolveActive("prod").value_or(""), "fraud:3", "resolveActive(prod)");
  // Another registryd instance promotes version 2: its script moves the same key.
  ctx.Redis.Set("active:prod", "fraud:2");
  ctx.Equal(resolveActive("prod").value_or(""), "fraud:2",
            "another instance moved active:prod to fraud:2: a process-local copy of the pointer answers the old one. Read active:{pool} from Redis; resolveActive(prod)");
  ctx.Redis.Del("active:prod");
  ctx.Assert(!resolveActive("prod"), "active:prod was cleared and resolveActive(prod) still answers %s", resolveActive("prod").value_or(""));
}

void CheckAtomicPromote(harness::Ctx& ctx) {
  seedVersions(ctx);
  // An operator's rollback of version 3 lands while the promote is writing.
  auto fired = std::make_shared<bool>(false);
  auto err = std::make_shared<std::optional<std::string>>();
  ctx.Redis.After("model:fraud:v3", [fired, err] {
    *fired = true;
    try {
      rollback("fraud", 3, "prod");
    } catch (const std::exception& e) {
      *err = e.what();
    }
  });
  promote("fraud", 3, "prod", "e-3");
  ctx.Assert(*fired, "the promote never touched model:fraud:v3");
  ctx.Assert(!err->has_value(), "the rival rollback failed: %s", err->value_or(""));
  const std::string stage = stageOf(ctx, 3);
  const std::string pointer = pointerOf(ctx);
  if (stage == "promoted") {
    ctx.Equal(pointer, "fraud:3", "fraud version 3 is promoted; active:prod");
  } else {
    ctx.Assert(pointer != "fraud:3",
               "a rollback landed between the promote's writes: fraud version 3 is %s and prod still serves it. The stage and the pointer must move in one script", stage);
  }
}

void CheckRollbackClears(harness::Ctx& ctx) {
  seedVersions(ctx);
  ctx.Equal(promote("fraud", 3, "prod", "e-3"), true, "promoting staged fraud version 3 must move the pointer; moved");
  ctx.Equal(rollback("fraud", 2, "prod"), true, "rolling back fraud version 2 (it exists); done");
  ctx.Equal(pointerOf(ctx), "fraud:3", "rolling back version 2, which prod does not serve, must leave another version's traffic; active:prod");
  ctx.Equal(rollback("fraud", 3, "prod"), true, "rolling back fraud version 3; done");
  ctx.Equal(stageOf(ctx, 3), "rolled_back", "the stage of fraud version 3 after its rollback");
  ctx.Equal(ctx.Redis.Exists("active:prod"), 0,
            "active:prod still holds fraud:3 after version 3 was rolled back: prod keeps serving the version it was taken out of; active:prod exists");
  ctx.Assert(!resolveActive("prod"), "resolveActive(prod) answers %s after the rollback", resolveActive("prod").value_or(""));
  ctx.Equal(rollback("fraud", 9, "prod"), false, "rolling back a version that does not exist; done");
}

void CheckNewEvalGate(harness::Ctx& ctx) {
  seedVersions(ctx);
  ctx.Equal(promote("fraud", 3, "prod", "e-3"), true, "promoting staged fraud version 3 must move the pointer; moved");
  rollback("fraud", 3, "prod");
  const bool again = promote("fraud", 3, "prod", "e-3");
  ctx.Assert(!again && ctx.Redis.Exists("active:prod") == 0,
             "a rolled-back version was promoted again on the eval record it failed with (returned %t, active:prod %q): it needs a new eval record", again, pointerOf(ctx));
  ctx.Equal(stageOf(ctx, 3), "rolled_back", "the refused promote must leave fraud version 3 rolled back; the stage");
  ctx.Equal(promote("fraud", 3, "prod", "e-3b"), true, "with a new eval record the rolled-back version must be promoted; moved");
  const std::string eval_id = ctx.Redis.HGet("model:fraud:v3", "eval_id").value_or("");
  ctx.Assert(stageOf(ctx, 3) == "promoted" && eval_id == "e-3b", "after the re-promotion fraud version 3 is %s with eval_id %s, expected promoted with e-3b", stageOf(ctx, 3), eval_id);
  ctx.Equal(pointerOf(ctx), "fraud:3", "active:prod after the re-promotion");
  ctx.Equal(promote("fraud", 9, "prod", "e-9"), false, "promoting a version that does not exist; moved");
  ctx.Equal(ctx.Redis.Exists("model:fraud:v9"), 0, "promoting a missing version must not create it; model:fraud:v9 exists");
  ctx.Equal(pointerOf(ctx), "fraud:3", "promoting a missing version must leave active:prod");
}
`,
  },
  hints: [
    'Promote a version on one registryd instance and roll it back on another: the first keeps answering the old version, and prod still points at the version marked rolled back.',
    'Two round trips are two moments another client can land between, a map in one process is invisible to the others, and nothing in the rollback touches `active:{pool}` or reads the eval record.',
    'Read `active:{pool}` with `GET` every time. One script for promote: `HGET` stage, refuse a missing version and a `rolled_back` one whose `eval_id` equals `ARGV[2]`, then `HSET` stage and `SET` the pointer. Rollback: `HSET` stage, `DEL` the pointer if it equals `ARGV[1]`.',
  ],
  debrief: `The stage and the pointer describe one fact from two sides, so they change in one script or a reader can see them disagree. Keeping the pointer only in Redis costs a round trip per resolve and buys agreement between every instance; a cache would need invalidation, which is the problem the pointer was meant to avoid. Comparing before deleting is what lets a rollback of an idle version leave the serving one alone. Production registries keep the previous pointer value so a rollback can restore the last good version instead of leaving the pool empty, record who moved the pointer and why, and stream pointer changes so serving fleets react without polling.`,
};
