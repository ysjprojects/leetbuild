import type {Step} from '@/lib/types';

export const stateStep: Step = {
  id: 'state',
  title: 'Redis active-version pointer with an overlap window',
  concept: 'redis',
  file: 'state',
  focus: ['worker', 'api', 'redis'],
  task: `## Task

**Starting point.** The starter is the pointer every consumer resolves:
\`activate(name, version_id)\` reads \`secret:{name}:active\`, sets it to the new version with
\`POINTER_TTL_S\`, deletes \`secret:{name}:overlap\` and answers the previous version;
\`valid_versions(name)\` reads both keys; \`revoke(name, version_id)\` adds the version to
\`secret:{name}:revoked\`. The demo rotates cleanly, and it hides four flaws.

**Failure mode the checks target.** A fleet halfway through a redeploy still holds the old version
when the pointer moves; two rotations that land together lose a version; a quiet week drops the
pointer; and a revoke can take the active version away from every consumer.

- The swap is **one Lua script** (\`SWAP_LUA\`, keys \`active\` and \`overlap\`): read the pointer, set
  it, keep the previous version under the overlap key with \`EX OVERLAP_SECONDS\` (900, one deploy
  cycle), answer the previous version (\`None\` for the first activation).
- The pointer has **no TTL**; only the overlap key expires.
- \`valid_versions\` answers the active version, then the previous one while its overlap lasts,
  never a revoked one.
- \`revoke\` refuses the active version (\`False\`, nothing recorded) and otherwise records the
  version in the revoked set.`,
  sequence: {
    participants: ['Rotation worker', 'Redis', 'Consumer mid-deploy'],
    messages: [
      {from: 'Rotation worker', to: 'Redis', label: 'EVAL SWAP_LUA active overlap v2 900', kind: 'sync'},
      {from: 'Redis', to: 'Rotation worker', label: 'previous = v1 · overlap = v1 EX 900', kind: 'reply'},
      {from: 'Consumer mid-deploy', to: 'Redis', label: 'valid_versions → [v2, v1]', kind: 'sync'},
      {from: 'Redis', to: 'Consumer mid-deploy', label: 'v1 still decrypts until the overlap ends', kind: 'reply'},
      {from: 'Rotation worker', to: 'Redis', label: 'revoke(v1) · revoke(v2) refused while active', kind: 'sync'},
    ],
  },
  checks: [
    {
      id: 'overlap-window',
      title: 'The previous version stays valid for the overlap',
      detail:
        'The swap keeps the previous version under `secret:{name}:overlap` with `OVERLAP_SECONDS` (900) as its expiry, and nothing deletes the key early; the starter deletes it the moment the new version activates.',
      match: {
        python: {all: [/OVERLAP_SECONDS\s*=\s*900\b/, /KEYS\[2\]/], none: [/\.delete\(/]},
        typescript: {all: [/OVERLAP_SECONDS\s*=\s*900\b/, /KEYS\[2\]/], none: [/\.del\(/]},
        go: {all: [/overlapSeconds\s*=\s*900\b/, /KEYS\[2\]/], none: [/\.Del\(/]},
        scala: {all: [/OverlapSeconds\s*=\s*900L?\b/, /KEYS\[2\]/], none: [/jedis\.del\(/]},
        cpp: {all: [/kOverlapSeconds\s*=\s*900\b/, /KEYS\[2\]/], none: [/redis\.del\(/]},
      },
    },
    {
      id: 'atomic-swap',
      title: 'Read and swap the pointer in one script',
      detail:
        'One Lua script (`register_script`/`eval`, `defineCommand`, `NewScript`) reads the pointer and sets it; the client never writes `secret:{name}:active` itself, which is what lets two activations interleave and lose a version.',
      match: {
        python: {
          all: [/register_script\(|\.eval\(/, /redis\.call\(\s*['"]GET['"],\s*KEYS\[1\]/],
          none: [/\.set\(\s*active_key\(/],
        },
        typescript: {
          all: [/defineCommand\(|\.eval\(/, /redis\.call\(\s*['"]GET['"],\s*KEYS\[1\]/],
          none: [/\.set\(\s*activeKey\(/],
        },
        go: {
          all: [/redis\.NewScript\(|\.Eval\(/, /redis\.call\(\s*['"]GET['"],\s*KEYS\[1\]/],
          none: [/\.Set\([^\n]*activeKey\(/],
        },
        scala: {
          all: [/jedis\.eval(sha)?\(/, /redis\.call\(\s*['"]GET['"],\s*KEYS\[1\]/],
          none: [/jedis\.set(ex)?\(\s*activeKey\(/],
        },
        cpp: {
          all: [/redis\.eval(sha)?[<(]/, /redis\.call\(\s*['"]GET['"],\s*KEYS\[1\]/],
          none: [/redis\.set\(\s*activeKey\(/],
        },
      },
    },
    {
      id: 'pointer-permanent',
      title: 'The pointer has no TTL; only the overlap expires',
      detail:
        'The script sets `KEYS[1]` without an expiry and expires the overlap key alone; a pointer TTL (`POINTER_TTL_S`) turns a quiet week into an outage.',
      match: {
        python: {all: [/redis\.call\(\s*['"]SET['"],\s*KEYS\[1\],\s*ARGV\[1\]\s*\)/], none: [/POINTER_TTL/]},
        typescript: {all: [/redis\.call\(\s*['"]SET['"],\s*KEYS\[1\],\s*ARGV\[1\]\s*\)/], none: [/POINTER_TTL/]},
        go: {all: [/redis\.call\(\s*['"]SET['"],\s*KEYS\[1\],\s*ARGV\[1\]\s*\)/], none: [/pointerTTL/]},
        scala: {all: [/redis\.call\(\s*['"]SET['"],\s*KEYS\[1\],\s*ARGV\[1\]\s*\)/], none: [/PointerTtl/]},
        cpp: {all: [/redis\.call\(\s*['"]SET['"],\s*KEYS\[1\],\s*ARGV\[1\]\s*\)/], none: [/kPointerTtl/]},
      },
    },
    {
      id: 'revoke-explicit',
      title: 'Revoke refuses the active version and ends a revoked one at once',
      detail:
        '`revoke` answers false for the active version and records nothing; `valid_versions`/`validVersions` reads the revoked set and leaves a revoked version out even while its overlap lasts.',
      match: {
        python: {all: [/def revoke\(/, /return False/, /(smembers|sismember)\(\s*revoked_key\(/]},
        typescript: {all: [/function revoke\(/, /return false/, /(smembers|sismember)\(\s*revokedKey\(/]},
        go: {all: [/func revoke\(/, /return false, nil/, /(SMembers|SIsMember)\([^\n]*revokedKey\(/]},
        scala: {all: [/def revoke\(/, /\bfalse\b/, /(smembers|sismember)\(\s*revokedKey\(/]},
        cpp: {all: [/bool revoke\(/, /return false/, /(smembers|sismember)\(\s*revokedKey\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

POINTER_TTL_S = 86_400  # a pointer nobody refreshed for a day is stale


def active_key(name: str) -> str:
    return f"secret:{name}:active"


def overlap_key(name: str) -> str:
    return f"secret:{name}:overlap"


def revoked_key(name: str) -> str:
    return f"secret:{name}:revoked"


def activate(name: str, version_id: str) -> str | None:
    """Make version_id the version new consumers use; answers the previous one (None for the first)."""
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    previous = r.get(active_key(name))
    r.set(active_key(name), version_id, ex=POINTER_TTL_S)
    r.delete(overlap_key(name))  # the previous version retires with the swap
    return previous


def valid_versions(name: str) -> list[str]:
    """The versions a consumer may use right now, the active one first."""
    return [v for v in r.mget(active_key(name), overlap_key(name)) if v]


def revoke(name: str, version_id: str) -> bool:
    """Stop a version working now."""
    r.sadd(revoked_key(name), version_id)
    return True
`,
      solution: `import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

OVERLAP_SECONDS = 900  # one deploy cycle of the slowest consumer

# Read the pointer, move it, and keep the previous version valid for the overlap, in one step.
SWAP_LUA = """
local previous = redis.call('GET', KEYS[1]) or ''
redis.call('SET', KEYS[1], ARGV[1])
if previous ~= '' then redis.call('SET', KEYS[2], previous, 'EX', ARGV[2]) end
return previous
"""
swap = r.register_script(SWAP_LUA)


def active_key(name: str) -> str:
    return f"secret:{name}:active"


def overlap_key(name: str) -> str:
    return f"secret:{name}:overlap"


def revoked_key(name: str) -> str:
    return f"secret:{name}:revoked"


def activate(name: str, version_id: str) -> str | None:
    """Make version_id the version new consumers use; answers the previous one (None for the first)."""
    previous = swap(keys=[active_key(name), overlap_key(name)], args=[version_id, OVERLAP_SECONDS])
    return previous or None


def valid_versions(name: str) -> list[str]:
    """The versions a consumer may use right now, the active one first."""
    revoked = r.smembers(revoked_key(name))
    return [v for v in r.mget(active_key(name), overlap_key(name)) if v and v not in revoked]


def revoke(name: str, version_id: str) -> bool:
    """Stop a version working now; the active version cannot be revoked (activate another first)."""
    if r.get(active_key(name)) == version_id:
        return False
    r.sadd(revoked_key(name), version_id)
    return True
`,
    },
    typescript: {
      starter: `import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

export const POINTER_TTL_S = 86_400; // a pointer nobody refreshed for a day is stale

export const activeKey = (name: string): string => \`secret:\${name}:active\`;
export const overlapKey = (name: string): string => \`secret:\${name}:overlap\`;
export const revokedKey = (name: string): string => \`secret:\${name}:revoked\`;

/** Make versionId the version new consumers use; answers the previous one (null for the first). */
export async function activate(name: string, versionId: string): Promise<string | null> {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const previous = await redis.get(activeKey(name));
  await redis.set(activeKey(name), versionId, 'EX', POINTER_TTL_S);
  await redis.del(overlapKey(name)); // the previous version retires with the swap
  return previous;
}

/** The versions a consumer may use right now, the active one first. */
export async function validVersions(name: string): Promise<string[]> {
  const [active, overlap] = await redis.mget(activeKey(name), overlapKey(name));
  return [active, overlap].filter((v): v is string => v !== null);
}

/** Stop a version working now. */
export async function revoke(name: string, versionId: string): Promise<boolean> {
  await redis.sadd(revokedKey(name), versionId);
  return true;
}
`,
      solution: `import Redis from 'ioredis';

export const OVERLAP_SECONDS = 900; // one deploy cycle of the slowest consumer

// Read the pointer, move it, and keep the previous version valid for the overlap, in one step.
export const SWAP_LUA = \`
local previous = redis.call('GET', KEYS[1]) or ''
redis.call('SET', KEYS[1], ARGV[1])
if previous ~= '' then redis.call('SET', KEYS[2], previous, 'EX', ARGV[2]) end
return previous
\`;

interface SwapRedis extends Redis {
  swapActive(active: string, overlap: string, versionId: string, overlapSeconds: number): Promise<string>;
}

const redis = new Redis({host: 'redis', port: 6379}) as SwapRedis;
redis.defineCommand('swapActive', {numberOfKeys: 2, lua: SWAP_LUA});

export const activeKey = (name: string): string => \`secret:\${name}:active\`;
export const overlapKey = (name: string): string => \`secret:\${name}:overlap\`;
export const revokedKey = (name: string): string => \`secret:\${name}:revoked\`;

/** Make versionId the version new consumers use; answers the previous one (null for the first). */
export async function activate(name: string, versionId: string): Promise<string | null> {
  const previous = await redis.swapActive(activeKey(name), overlapKey(name), versionId, OVERLAP_SECONDS);
  return previous === '' ? null : previous;
}

/** The versions a consumer may use right now, the active one first. */
export async function validVersions(name: string): Promise<string[]> {
  const revoked = new Set(await redis.smembers(revokedKey(name)));
  const [active, overlap] = await redis.mget(activeKey(name), overlapKey(name));
  return [active, overlap].filter((v): v is string => v !== null && !revoked.has(v));
}

/** Stop a version working now; the active version cannot be revoked (activate another first). */
export async function revoke(name: string, versionId: string): Promise<boolean> {
  if ((await redis.get(activeKey(name))) === versionId) return false;
  await redis.sadd(revokedKey(name), versionId);
  return true;
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"time"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const pointerTTL = 24 * time.Hour // a pointer nobody refreshed for a day is stale

func activeKey(name string) string  { return "secret:" + name + ":active" }
func overlapKey(name string) string { return "secret:" + name + ":overlap" }
func revokedKey(name string) string { return "secret:" + name + ":revoked" }

// activate makes versionID the version new consumers use; it answers the previous one ("" for the first).
func activate(ctx context.Context, name, versionID string) (string, error) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	previous, err := rdb.Get(ctx, activeKey(name)).Result()
	if err != nil && err != redis.Nil {
		return "", err
	}
	if err := rdb.Set(ctx, activeKey(name), versionID, pointerTTL).Err(); err != nil {
		return "", err
	}
	rdb.Del(ctx, overlapKey(name)) // the previous version retires with the swap
	return previous, nil
}

// validVersions are the versions a consumer may use right now, the active one first.
func validVersions(ctx context.Context, name string) ([]string, error) {
	pointers, err := rdb.MGet(ctx, activeKey(name), overlapKey(name)).Result()
	if err != nil {
		return nil, err
	}
	out := []string{}
	for _, p := range pointers {
		if v, ok := p.(string); ok && v != "" {
			out = append(out, v)
		}
	}
	return out, nil
}

// revoke stops a version working now.
func revoke(ctx context.Context, name, versionID string) (bool, error) {
	return true, rdb.SAdd(ctx, revokedKey(name), versionID).Err()
}
`,
      solution: `package main

import (
	"context"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const overlapSeconds = 900 // one deploy cycle of the slowest consumer

// swap reads the pointer, moves it, and keeps the previous version valid for the overlap, in one step.
var swap = redis.NewScript(\`
local previous = redis.call('GET', KEYS[1]) or ''
redis.call('SET', KEYS[1], ARGV[1])
if previous ~= '' then redis.call('SET', KEYS[2], previous, 'EX', ARGV[2]) end
return previous
\`)

func activeKey(name string) string  { return "secret:" + name + ":active" }
func overlapKey(name string) string { return "secret:" + name + ":overlap" }
func revokedKey(name string) string { return "secret:" + name + ":revoked" }

// activate makes versionID the version new consumers use; it answers the previous one ("" for the first).
func activate(ctx context.Context, name, versionID string) (string, error) {
	return swap.Run(ctx, rdb, []string{activeKey(name), overlapKey(name)}, versionID, overlapSeconds).Text()
}

// validVersions are the versions a consumer may use right now, the active one first.
func validVersions(ctx context.Context, name string) ([]string, error) {
	revoked, err := rdb.SMembers(ctx, revokedKey(name)).Result()
	if err != nil {
		return nil, err
	}
	isRevoked := map[string]bool{}
	for _, v := range revoked {
		isRevoked[v] = true
	}
	pointers, err := rdb.MGet(ctx, activeKey(name), overlapKey(name)).Result()
	if err != nil {
		return nil, err
	}
	out := []string{}
	for _, p := range pointers {
		if v, ok := p.(string); ok && v != "" && !isRevoked[v] {
			out = append(out, v)
		}
	}
	return out, nil
}

// revoke stops a version working now; the active version cannot be revoked (activate another first).
func revoke(ctx context.Context, name, versionID string) (bool, error) {
	if rdb.Get(ctx, activeKey(name)).Val() == versionID {
		return false, nil
	}
	return true, rdb.SAdd(ctx, revokedKey(name), versionID).Err()
}
`,
    },
    scala: {
      starter: `import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

object State {
  val jedis = new JedisPooled("redis", 6379)

  val PointerTtlSeconds = 86400L // a pointer nobody refreshed for a day is stale

  def activeKey(name: String): String = s"secret:$name:active"
  def overlapKey(name: String): String = s"secret:$name:overlap"
  def revokedKey(name: String): String = s"secret:$name:revoked"

  /** Make versionId the version new consumers use; answers the previous one (None for the first). */
  def activate(name: String, versionId: String): Option[String] = {
    // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    val previous = Option(jedis.get(activeKey(name)))
    jedis.setex(activeKey(name), PointerTtlSeconds, versionId)
    jedis.del(overlapKey(name)) // the previous version retires with the swap
    previous
  }

  /** The versions a consumer may use right now, the active one first. */
  def validVersions(name: String): Seq[String] =
    jedis.mget(activeKey(name), overlapKey(name)).asScala.toSeq.filter(_ != null)

  /** Stop a version working now. */
  def revoke(name: String, versionId: String): Boolean = {
    jedis.sadd(revokedKey(name), versionId)
    true
  }
}
`,
      solution: `import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

object State {
  val jedis = new JedisPooled("redis", 6379)

  val OverlapSeconds = 900L // one deploy cycle of the slowest consumer

  /** Read the pointer, move it, and keep the previous version valid for the overlap, in one step. */
  val SwapLua: String =
    """local previous = redis.call('GET', KEYS[1]) or ''
      |redis.call('SET', KEYS[1], ARGV[1])
      |if previous ~= '' then redis.call('SET', KEYS[2], previous, 'EX', ARGV[2]) end
      |return previous
      |""".stripMargin

  def activeKey(name: String): String = s"secret:$name:active"
  def overlapKey(name: String): String = s"secret:$name:overlap"
  def revokedKey(name: String): String = s"secret:$name:revoked"

  /** Make versionId the version new consumers use; answers the previous one (None for the first). */
  def activate(name: String, versionId: String): Option[String] = {
    val previous = jedis.eval(SwapLua, List(activeKey(name), overlapKey(name)).asJava, List(versionId, OverlapSeconds.toString).asJava)
    Option(previous).map(_.toString).filter(_.nonEmpty)
  }

  /** The versions a consumer may use right now, the active one first. */
  def validVersions(name: String): Seq[String] = {
    val revoked = jedis.smembers(revokedKey(name)).asScala
    jedis.mget(activeKey(name), overlapKey(name)).asScala.toSeq.filter(v => v != null && !revoked.contains(v))
  }

  /** Stop a version working now; the active version cannot be revoked (activate another first). */
  def revoke(name: String, versionId: String): Boolean =
    if (Option(jedis.get(activeKey(name))).contains(versionId)) false
    else {
      jedis.sadd(revokedKey(name), versionId)
      true
    }
}
`,
    },
    cpp: {
      starter: `#include <sw/redis++/redis++.h>

#include <chrono>
#include <string>
#include <vector>

sw::redis::Redis redis("tcp://redis:6379");

constexpr long long kPointerTtlSeconds = 86400;  // a pointer nobody refreshed for a day is stale

std::string activeKey(const std::string& name) { return "secret:" + name + ":active"; }
std::string overlapKey(const std::string& name) { return "secret:" + name + ":overlap"; }
std::string revokedKey(const std::string& name) { return "secret:" + name + ":revoked"; }

// Make version_id the version new consumers use; answers the previous one ("" for the first).
std::string activate(const std::string& name, const std::string& version_id) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const std::string previous = redis.get(activeKey(name)).value_or("");
  redis.set(activeKey(name), version_id, std::chrono::seconds(kPointerTtlSeconds));
  redis.del(overlapKey(name));  // the previous version retires with the swap
  return previous;
}

// The versions a consumer may use right now, the active one first.
std::vector<std::string> validVersions(const std::string& name) {
  std::vector<std::string> out;
  for (const auto& key : {activeKey(name), overlapKey(name)}) {
    const auto v = redis.get(key);
    if (v && !v->empty()) out.push_back(*v);
  }
  return out;
}

// Stop a version working now.
bool revoke(const std::string& name, const std::string& version_id) {
  redis.sadd(revokedKey(name), version_id);
  return true;
}
`,
      solution: `#include <sw/redis++/redis++.h>

#include <iterator>
#include <set>
#include <string>
#include <vector>

sw::redis::Redis redis("tcp://redis:6379");

constexpr long long kOverlapSeconds = 900;  // one deploy cycle of the slowest consumer

// Read the pointer, move it, and keep the previous version valid for the overlap, in one step.
const std::string kSwapLua = R"lua(
local previous = redis.call('GET', KEYS[1]) or ''
redis.call('SET', KEYS[1], ARGV[1])
if previous ~= '' then redis.call('SET', KEYS[2], previous, 'EX', ARGV[2]) end
return previous
)lua";

std::string activeKey(const std::string& name) { return "secret:" + name + ":active"; }
std::string overlapKey(const std::string& name) { return "secret:" + name + ":overlap"; }
std::string revokedKey(const std::string& name) { return "secret:" + name + ":revoked"; }

// Make version_id the version new consumers use; answers the previous one ("" for the first).
std::string activate(const std::string& name, const std::string& version_id) {
  return redis.eval<std::string>(kSwapLua, {activeKey(name), overlapKey(name)}, {version_id, std::to_string(kOverlapSeconds)});
}

// The versions a consumer may use right now, the active one first.
std::vector<std::string> validVersions(const std::string& name) {
  std::set<std::string> revoked;
  redis.smembers(revokedKey(name), std::inserter(revoked, revoked.begin()));
  std::vector<std::string> out;
  for (const auto& key : {activeKey(name), overlapKey(name)}) {
    const auto v = redis.get(key);
    if (v && !v->empty() && revoked.count(*v) == 0) out.push_back(*v);
  }
  return out;
}

// Stop a version working now; the active version cannot be revoked (activate another first).
bool revoke(const std::string& name, const std::string& version_id) {
  if (redis.get(activeKey(name)).value_or("") == version_id) return false;
  redis.sadd(revokedKey(name), version_id);
  return true;
}
`,
    },
  },
  harness: {
    python: `NAME = "payments-db"
ACTIVE = "secret:payments-db:active"
OVERLAP = "secret:payments-db:overlap"
REVOKED = "secret:payments-db:revoked"


def check_overlap_window(ctx):
    m = ctx.load("state")
    assert m.activate(NAME, "v1") is None, "the first activation has no previous version: activate must answer None"
    previous = m.activate(NAME, "v2")
    assert previous == "v1", f"activating v2 over v1 answered {previous!r}, expected v1"
    valid = m.valid_versions(NAME)
    assert valid == ["v2", "v1"], f"right after the swap valid_versions is {valid}: a consumer mid-deploy still holds v1, so v1 stays valid for the overlap (expected ['v2', 'v1'])"
    ttl = ctx.redis.ttl(OVERLAP)
    assert 0 < ttl <= 900, f"{OVERLAP} has TTL {ttl}, expected the 900-second overlap"
    ctx.clock.advance(890)
    assert m.valid_versions(NAME) == ["v2", "v1"], f"890 s after the swap valid_versions is {m.valid_versions(NAME)}: the overlap lasts OVERLAP_SECONDS = 900"
    ctx.clock.advance(20)
    assert m.valid_versions(NAME) == ["v2"], f"past the overlap valid_versions is {m.valid_versions(NAME)}, expected ['v2']"


def check_atomic_swap(ctx):
    m = ctx.load("state")
    m.activate(NAME, "v1")
    # A second rotation (to v3) lands while this one (to v2) is swapping the pointer.
    rival = ctx.redis_after(ACTIVE, lambda: m.activate(NAME, "v3"))
    ours = m.activate(NAME, "v2")
    assert rival.fired, f"nothing touched {ACTIVE}"
    if rival.error is not None:
        raise rival.error
    theirs = rival.result
    assert (ours, theirs) in (("v1", "v2"), ("v3", "v1")), f"two activations racing over v1 answered previous versions {ours!r} (to v2) and {theirs!r} (to v3): one of them read the pointer, the other moved it, and the first overwrote it, so a version vanished from every window. Read and move the pointer in one Lua script"
    expected = ("v3", "v2") if ours == "v1" else ("v2", "v3")
    got = (ctx.redis.get(ACTIVE), ctx.redis.get(OVERLAP))
    assert got == expected, f"after the race active/overlap are {got}, expected {expected}"


def check_pointer_permanent(ctx):
    m = ctx.load("state")
    m.activate(NAME, "v1")
    ttl = ctx.redis.ttl(ACTIVE)
    assert ttl == -1, f"{ACTIVE} has a TTL of {ttl} s: a quiet week would drop the pointer and every consumer with it. The pointer has no TTL"
    ctx.clock.advance(7 * 86_400)
    assert m.valid_versions(NAME) == ["v1"], f"a week without rotations later valid_versions is {m.valid_versions(NAME)}, expected ['v1']"
    m.activate(NAME, "v2")
    assert ctx.redis.ttl(ACTIVE) == -1, f"after the second activation {ACTIVE} has a TTL of {ctx.redis.ttl(ACTIVE)} s, expected none"


def check_revoke_explicit(ctx):
    m = ctx.load("state")
    m.activate(NAME, "v1")
    m.activate(NAME, "v2")
    assert m.revoke(NAME, "v2") is False, "revoking the active version v2 must be refused (False): every consumer would lose the secret. Activate another version first"
    assert ctx.redis.get(ACTIVE) == "v2", f"a refused revoke moved the pointer: {ACTIVE} is {ctx.redis.get(ACTIVE)!r}"
    assert not ctx.redis.sismember(REVOKED, "v2"), "a refused revoke still recorded v2 as revoked"
    assert m.revoke(NAME, "v1") is True, "revoking the previous version v1 must succeed"
    assert ctx.redis.sismember(REVOKED, "v1"), f"{REVOKED} must hold v1 after the revoke"
    valid = m.valid_versions(NAME)
    assert valid == ["v2"], f"after revoking v1 valid_versions is {valid}: a revoked version stops working at once, overlap or not"
`,
    typescript: `const NAME = 'payments-db';
const ACTIVE = 'secret:payments-db:active';
const OVERLAP = 'secret:payments-db:overlap';
const REVOKED = 'secret:payments-db:revoked';

export async function check_overlap_window(ctx) {
  const m = ctx.load('state');
  assert.equal(await m.activate(NAME, 'v1'), null, 'the first activation has no previous version: activate must answer null');
  const previous = await m.activate(NAME, 'v2');
  assert.equal(previous, 'v1', \`activating v2 over v1 answered \${JSON.stringify(previous)}, expected v1\`);
  const valid = await m.validVersions(NAME);
  assert.deepStrictEqual(valid, ['v2', 'v1'], \`right after the swap validVersions is \${JSON.stringify(valid)}: a consumer mid-deploy still holds v1, so v1 stays valid for the overlap\`);
  const ttl = ctx.redis.ttl(OVERLAP);
  assert(ttl > 0 && ttl <= 900, \`\${OVERLAP} has TTL \${ttl}, expected the 900-second overlap\`);
  ctx.clock.advance(890);
  assert.deepStrictEqual(await m.validVersions(NAME), ['v2', 'v1'], '890 s after the swap v1 must still be valid: the overlap lasts OVERLAP_SECONDS = 900');
  ctx.clock.advance(20);
  assert.deepStrictEqual(await m.validVersions(NAME), ['v2'], 'past the overlap only v2 is valid');
}

export async function check_atomic_swap(ctx) {
  const m = ctx.load('state');
  await m.activate(NAME, 'v1');
  // A second rotation (to v3) lands while this one (to v2) is swapping the pointer.
  const rival = ctx.redisAfter(ACTIVE, () => m.activate(NAME, 'v3'));
  const ours = await m.activate(NAME, 'v2');
  assert(rival.fired, \`nothing touched \${ACTIVE}\`);
  if (rival.error !== undefined) throw rival.error;
  const theirs = await rival.result;
  const pair = JSON.stringify([ours, theirs]);
  assert(
    pair === JSON.stringify(['v1', 'v2']) || pair === JSON.stringify(['v3', 'v1']),
    \`two activations racing over v1 answered previous versions \${pair} (to v2, to v3): one of them read the pointer, the other moved it, and the first overwrote it, so a version vanished from every window. Read and move the pointer in one Lua script\`,
  );
  const expected = ours === 'v1' ? ['v3', 'v2'] : ['v2', 'v3'];
  assert.deepStrictEqual([ctx.redis.get(ACTIVE), ctx.redis.get(OVERLAP)], expected, 'after the race, active and overlap');
}

export async function check_pointer_permanent(ctx) {
  const m = ctx.load('state');
  await m.activate(NAME, 'v1');
  const ttl = ctx.redis.ttl(ACTIVE);
  assert.equal(ttl, -1, \`\${ACTIVE} has a TTL of \${ttl} s: a quiet week would drop the pointer and every consumer with it. The pointer has no TTL\`);
  ctx.clock.advance(7 * 86_400);
  assert.deepStrictEqual(await m.validVersions(NAME), ['v1'], 'a week without rotations later v1 must still be the valid version');
  await m.activate(NAME, 'v2');
  assert.equal(ctx.redis.ttl(ACTIVE), -1, \`after the second activation \${ACTIVE} has a TTL of \${ctx.redis.ttl(ACTIVE)} s, expected none\`);
}

export async function check_revoke_explicit(ctx) {
  const m = ctx.load('state');
  await m.activate(NAME, 'v1');
  await m.activate(NAME, 'v2');
  assert.equal(await m.revoke(NAME, 'v2'), false, 'revoking the active version v2 must be refused (false): every consumer would lose the secret. Activate another version first');
  assert.equal(ctx.redis.get(ACTIVE), 'v2', 'a refused revoke moved the pointer');
  assert.equal(ctx.redis.sismember(REVOKED, 'v2'), 0, 'a refused revoke still recorded v2 as revoked');
  assert.equal(await m.revoke(NAME, 'v1'), true, 'revoking the previous version v1 must succeed');
  assert.equal(ctx.redis.sismember(REVOKED, 'v1'), 1, \`\${REVOKED} must hold v1 after the revoke\`);
  const valid = await m.validVersions(NAME);
  assert.deepStrictEqual(valid, ['v2'], \`after revoking v1 validVersions is \${JSON.stringify(valid)}: a revoked version stops working at once, overlap or not\`);
}
`,
    go: `package main

import (
	"context"

	"leetbuild/harness"
)

const (
	stateName    = "payments-db"
	stateActive  = "secret:payments-db:active"
	stateOverlap = "secret:payments-db:overlap"
	stateRevoked = "secret:payments-db:revoked"
)

var stateBg = context.Background()

func stateActivate(ctx *harness.Ctx, versionID string) string {
	previous, err := activate(stateBg, stateName, versionID)
	ctx.NoError(err, "activate(%s, %s) failed", stateName, versionID)
	return previous
}

func stateValid(ctx *harness.Ctx) []string {
	valid, err := validVersions(stateBg, stateName)
	ctx.NoError(err, "validVersions(%s) failed", stateName)
	return valid
}

func CheckOverlapWindow(ctx *harness.Ctx) {
	ctx.Equal(stateActivate(ctx, "v1"), "", "the first activation has no previous version: activate must answer \\"\\"")
	ctx.Equal(stateActivate(ctx, "v2"), "v1", "activating v2 over v1 must answer the previous version")
	ctx.Equal(stateValid(ctx), []string{"v2", "v1"}, "right after the swap a consumer mid-deploy still holds v1, so v1 stays valid for the overlap; validVersions")
	ttl := ctx.Redis.TTL(stateOverlap)
	ctx.Assert(ttl > 0 && ttl <= 900, "%s has TTL %d, expected the 900-second overlap", stateOverlap, ttl)
	ctx.Clock.Advance(890)
	ctx.Equal(stateValid(ctx), []string{"v2", "v1"}, "890 s after the swap (the overlap lasts overlapSeconds = 900); validVersions")
	ctx.Clock.Advance(20)
	ctx.Equal(stateValid(ctx), []string{"v2"}, "past the overlap; validVersions")
}

func CheckAtomicSwap(ctx *harness.Ctx) {
	stateActivate(ctx, "v1")
	// A second rotation (to v3) lands while this one (to v2) is swapping the pointer.
	rival := ctx.Redis.After(stateActive, func() any {
		previous, err := activate(stateBg, stateName, "v3")
		ctx.NoError(err, "the rival activation failed")
		return previous
	})
	ours := stateActivate(ctx, "v2")
	ctx.Assert(rival.Fired, "nothing touched %s", stateActive)
	ctx.Assert(rival.Err == nil, "the rival activation failed: %v", rival.Err)
	theirs, _ := rival.Result.(string)
	ctx.Assert((ours == "v1" && theirs == "v2") || (ours == "v3" && theirs == "v1"),
		"two activations racing over v1 answered previous versions %q (to v2) and %q (to v3): one of them read the pointer, the other moved it, and the first overwrote it, so a version vanished from every window. Read and move the pointer in one Lua script", ours, theirs)
	active, _ := ctx.Redis.Get(stateActive)
	overlap, _ := ctx.Redis.Get(stateOverlap)
	expected := []string{"v2", "v3"}
	if ours == "v1" {
		expected = []string{"v3", "v2"}
	}
	ctx.Equal([]string{active, overlap}, expected, "after the race, active and overlap")
}

func CheckPointerPermanent(ctx *harness.Ctx) {
	stateActivate(ctx, "v1")
	ttl := ctx.Redis.TTL(stateActive)
	ctx.Equal(ttl, -1, "%s has a TTL: a quiet week would drop the pointer and every consumer with it. The pointer has no TTL; its TTL", stateActive)
	ctx.Clock.Advance(7 * 86400)
	ctx.Equal(stateValid(ctx), []string{"v1"}, "a week without rotations later; validVersions")
	stateActivate(ctx, "v2")
	ctx.Equal(ctx.Redis.TTL(stateActive), -1, "after the second activation the pointer must still have no TTL; its TTL")
}

func CheckRevokeExplicit(ctx *harness.Ctx) {
	stateActivate(ctx, "v1")
	stateActivate(ctx, "v2")
	refused, err := revoke(stateBg, stateName, "v2")
	ctx.NoError(err, "revoke(v2) failed")
	ctx.Equal(refused, false, "revoking the active version v2 must be refused: every consumer would lose the secret. Activate another version first; revoke answered")
	active, _ := ctx.Redis.Get(stateActive)
	ctx.Equal(active, "v2", "a refused revoke must leave the pointer; active")
	ctx.Assert(!ctx.Redis.SIsMember(stateRevoked, "v2"), "a refused revoke still recorded v2 as revoked")
	done, err := revoke(stateBg, stateName, "v1")
	ctx.NoError(err, "revoke(v1) failed")
	ctx.Equal(done, true, "revoking the previous version v1 must succeed; revoke answered")
	ctx.Assert(ctx.Redis.SIsMember(stateRevoked, "v1"), "%s must hold v1 after the revoke", stateRevoked)
	ctx.Equal(stateValid(ctx), []string{"v2"}, "after revoking v1 (a revoked version stops working at once, overlap or not); validVersions")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <memory>
#include <optional>
#include <string>
#include <vector>

namespace {

const std::string kName = "payments-db";
const std::string kActive = "secret:payments-db:active";
const std::string kOverlap = "secret:payments-db:overlap";
const std::string kRevoked = "secret:payments-db:revoked";

}  // namespace

void CheckOverlapWindow(harness::Ctx& ctx) {
  ctx.Equal(activate(kName, "v1"), "", "the first activation has no previous version: activate must answer \\"\\"");
  ctx.Equal(activate(kName, "v2"), "v1", "activating v2 over v1 must answer the previous version");
  ctx.Equal(validVersions(kName), {"v2", "v1"}, "right after the swap a consumer mid-deploy still holds v1, so v1 stays valid for the overlap; validVersions");
  const long long ttl = ctx.Redis.TTL(kOverlap);
  ctx.Assert(ttl > 0 && ttl <= 900, "%s has TTL %d, expected the 900-second overlap", kOverlap, ttl);
  ctx.Clock.Advance(890);
  ctx.Equal(validVersions(kName), {"v2", "v1"}, "890 s after the swap (the overlap lasts kOverlapSeconds = 900); validVersions");
  ctx.Clock.Advance(20);
  ctx.Equal(validVersions(kName), {"v2"}, "past the overlap; validVersions");
}

void CheckAtomicSwap(harness::Ctx& ctx) {
  activate(kName, "v1");
  // A second rotation (to v3) lands while this one (to v2) is swapping the pointer.
  auto theirs = std::make_shared<std::optional<std::string>>();
  auto failure = std::make_shared<std::optional<std::string>>();
  ctx.Redis.After(kActive, [theirs, failure] {
    try {
      *theirs = activate(kName, "v3");
    } catch (const std::exception& e) {
      *failure = e.what();
    }
  });
  const std::string ours = activate(kName, "v2");
  ctx.Assert(!failure->has_value(), "the rival activation failed: %s", failure->value_or(""));
  ctx.Assert(theirs->has_value(), "nothing touched %s", kActive);
  const std::string rival = **theirs;
  ctx.Assert((ours == "v1" && rival == "v2") || (ours == "v3" && rival == "v1"),
             "two activations racing over v1 answered previous versions %q (to v2) and %q (to v3): one of them read the pointer, the other moved it, and the first overwrote it, so a version vanished from every window. Read and move the pointer in one Lua script",
             ours, rival);
  const std::vector<std::string> expected = ours == "v1" ? std::vector<std::string>{"v3", "v2"} : std::vector<std::string>{"v2", "v3"};
  ctx.Equal(std::vector<std::string>{ctx.Redis.Get(kActive).value_or(""), ctx.Redis.Get(kOverlap).value_or("")}, expected, "after the race, active and overlap");
}

void CheckPointerPermanent(harness::Ctx& ctx) {
  activate(kName, "v1");
  ctx.Equal(ctx.Redis.TTL(kActive), -1, "%s has a TTL: a quiet week would drop the pointer and every consumer with it. The pointer has no TTL; its TTL", kActive);
  ctx.Clock.Advance(7 * 86400);
  ctx.Equal(validVersions(kName), {"v1"}, "a week without rotations later; validVersions");
  activate(kName, "v2");
  ctx.Equal(ctx.Redis.TTL(kActive), -1, "after the second activation the pointer must still have no TTL; its TTL");
}

void CheckRevokeExplicit(harness::Ctx& ctx) {
  activate(kName, "v1");
  activate(kName, "v2");
  ctx.Equal(revoke(kName, "v2"), false, "revoking the active version v2 must be refused: every consumer would lose the secret. Activate another version first; revoke answered");
  ctx.Equal(ctx.Redis.Get(kActive).value_or(""), "v2", "a refused revoke must leave the pointer; active");
  ctx.Assert(!ctx.Redis.SIsMember(kRevoked, "v2"), "a refused revoke still recorded v2 as revoked");
  ctx.Equal(revoke(kName, "v1"), true, "revoking the previous version v1 must succeed; revoke answered");
  ctx.Assert(ctx.Redis.SIsMember(kRevoked, "v1"), "%s must hold v1 after the revoke", kRevoked);
  ctx.Equal(validVersions(kName), {"v2"}, "after revoking v1 (a revoked version stops working at once, overlap or not); validVersions");
}
`,
  },
  hints: [
    'Rotate v1 to v2 and ask for the valid versions straight away: v1 is gone, so a service still deploying with v1 fails to decrypt. Leave the secret alone for a day and the pointer is gone too.',
    'The swap is a GET, a SET with a TTL and a DEL in three round trips: another rotation can land between them, the TTL ends the pointer, and the DEL ends the overlap. Revoke never looks at the pointer.',
    'One Lua script: `GET KEYS[1]`, `SET KEYS[1] ARGV[1]`, `SET KEYS[2] previous EX 900` when there was one, return it. `valid_versions` skips members of the revoked set; `revoke` returns False for the active version.',
  ],
  debrief: `One script is the fix because the swap is three writes that must be seen together: the previous version moves into the overlap, the overlap gets its expiry, the pointer moves. Split across round trips, two rotations interleave and one version is never recorded anywhere. The overlap length is a property of the fleet rather than of Redis: it has to cover the slowest consumer's redeploy, which is why it is 900 seconds and not a request timeout. The pointer carries no TTL because expiry is the wrong tool for something that must always exist. Production systems also record every pointer move in an audit stream and let revocation push to consumers instead of waiting for their next read.`,
};
