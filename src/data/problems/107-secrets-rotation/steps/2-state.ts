import type {Step} from '@/lib/types';

export const stateStep: Step = {
  id: 'state',
  title: 'Redis active-version pointer with an overlap window',
  concept: 'redis',
  file: 'state',
  focus: ['api', 'redis', 'worker', 'db'],
  task: `## Task

**Starting point.** The starter implements \`activate(name, version_id)\` against Redis: it reads
\`secret:{name}:active\`, writes the new version into it with \`POINTER_TTL_S\`, and returns the
previous version id. \`valid_versions(name)\` reads the pointer. It compiles, the demo rotates
cleanly, and it hides four flaws.

**Failure mode the checks target.** Without an overlap, a fleet mid-deploy fails the moment the
pointer moves: the 11-minute checkout outage the mock describes. A pointer that expires looks like
hygiene but drops the newest material after an idle window. Two round trips let concurrent
rotations lose a previous version. And a retirement that is whatever a TTL did is not a decision.

Three keys per secret:

- \`secret:{name}:active\`: the version a new consumer must use. **No TTL.**
- \`secret:{name}:overlap\`: the previous version while still valid, with
  \`EXPIRE OVERLAP_SECONDS\`; nothing else deletes it.
- \`secret:{name}:revoked\`: a set of revoked version ids.

\`activate(name, version_id)\`:

- The swap is **one atomic Lua \`EVAL\`** (\`SWAP_SCRIPT\`, key count **2**): read the pointer, store
  it under the overlap key and expire that key, set the pointer, return the previous id.
- \`OVERLAP_SECONDS\` is **900**, at least one deploy cycle.
- \`valid_versions(name)\` returns the active version **and**, while the overlap key is alive, the
  previous one.
- \`revoke(name, version_id)\` is explicit: it refuses the active version and otherwise adds the
  version to the revoked set.`,
  sequence: {
    participants: ['Rotation worker', 'Secrets API', 'Redis', 'Fleet consumers'],
    messages: [
      {from: 'Rotation worker', to: 'Secrets API', label: 'activate(name, version_id)', kind: 'sync'},
      {
        from: 'Secrets API',
        to: 'Redis',
        label: 'EVAL swap: GET active · SET overlap + EXPIRE 900 · SET active',
        kind: 'sync',
      },
      {from: 'Redis', to: 'Secrets API', label: 'previous version id', kind: 'reply'},
      {from: 'Fleet consumers', to: 'Secrets API', label: 'GET active · GET overlap', kind: 'sync'},
      {from: 'Secrets API', to: 'Fleet consumers', label: 'both versions valid for one deploy cycle', kind: 'reply'},
      {from: 'Redis', to: 'Redis', label: 'overlap key expires after 900 s — the pointer never does', kind: 'async'},
      {
        from: 'Rotation worker',
        to: 'Secrets API',
        label: 'revoke(name, previous) — explicit, after the overlap',
        kind: 'sync',
      },
    ],
  },
  checks: [
    {
      id: 'activate-pointer',
      title: 'Activation writes the active pointer',
      detail:
        '`activate(name, version_id)` moves `secret:{name}:active` to the new version and returns the previous one; every other check builds on it.',
      match: {
        python: {all: [/def activate\(/, /ACTIVE_KEY/]},
        typescript: {all: [/function activate\(/, /ACTIVE_KEY/]},
        go: {all: [/func activate\(/, /activeKey\(/]},
        scala: {all: [/def activate\(/, /activeKey/]},
        cpp: {all: [/activate\(/, /kActiveKey/]},
      },
    },
    {
      id: 'atomic-swap',
      title: 'Read-and-swap is one atomic EVAL',
      detail:
        'One Lua script (`SWAP_SCRIPT`) reads the pointer and moves it, evaluated with key count 2. The starter does a client-side GET then SET, so two rotations can interleave and one of them is never recorded as overlapping.',
      match: {
        python: {all: [/SWAP_SCRIPT/, /\beval\(/, /GET['"]?,\s*KEYS\[1\]/]},
        typescript: {all: [/SWAP_SCRIPT/, /\beval\(/, /GET['"]?,\s*KEYS\[1\]/]},
        go: {all: [/swapScript/, /\.Run\(/, /GET['"]?,\s*KEYS\[1\]/]},
        scala: {all: [/SwapScript/, /\.eval\(/, /GET['"]?,\s*KEYS\[1\]/]},
        cpp: {all: [/kSwapLua/, /\beval</, /GET['"]?,\s*KEYS\[1\]/]},
      },
    },
    {
      id: 'overlap-window',
      title: 'The previous version stays valid for the overlap',
      detail:
        '`OVERLAP_SECONDS` (900 — at least one deploy cycle) scopes the overlap key, `valid_versions` returns the active version plus the still-overlapping one, and nothing deletes the key early. The starter deletes the overlap the instant the new version activates.',
      match: {
        python: {all: [/OVERLAP_SECONDS/, /OVERLAP_KEY/, /def valid_versions\(/], none: [/\.delete\(/]},
        typescript: {all: [/OVERLAP_SECONDS/, /OVERLAP_KEY/, /function validVersions\(/], none: [/\.del\(/]},
        go: {all: [/overlapSeconds/, /overlapKey/, /func validVersions\(/], none: [/\.Del\(/]},
        scala: {all: [/OverlapSeconds/, /overlapKey/, /def validVersions\(/], none: [/\.del\(/]},
        cpp: {all: [/kOverlapSeconds/, /kOverlapKey/, /validVersions\(/], none: [/\.del\(/]},
      },
    },
    {
      id: 'pointer-permanent',
      title: 'The pointer never expires; only the overlap does',
      detail:
        'In the swap script the pointer (`KEYS[1]`) is written without a TTL and `EXPIRE` is applied to the overlap key (`KEYS[2]`) alone. The starter puts a TTL on the pointer, so an idle window resets it and the newest material becomes unreachable.',
      match: {
        python: {
          all: [/SET['"]?,\s*KEYS\[1\]\s*,\s*ARGV\[2\]\s*\)/, /EXPIRE['"]?,\s*KEYS\[2\]/],
          none: [/EXPIRE['"]?,\s*KEYS\[1\]/],
        },
        typescript: {
          all: [/SET['"]?,\s*KEYS\[1\]\s*,\s*ARGV\[2\]\s*\)/, /EXPIRE['"]?,\s*KEYS\[2\]/],
          none: [/EXPIRE['"]?,\s*KEYS\[1\]/],
        },
        go: {
          all: [/SET['"]?,\s*KEYS\[1\]\s*,\s*ARGV\[2\]\s*\)/, /EXPIRE['"]?,\s*KEYS\[2\]/],
          none: [/EXPIRE['"]?,\s*KEYS\[1\]/],
        },
        scala: {
          all: [/SET['"]?,\s*KEYS\[1\]\s*,\s*ARGV\[2\]\s*\)/, /EXPIRE['"]?,\s*KEYS\[2\]/],
          none: [/EXPIRE['"]?,\s*KEYS\[1\]/],
        },
        cpp: {
          all: [/SET['"]?,\s*KEYS\[1\]\s*,\s*ARGV\[2\]\s*\)/, /EXPIRE['"]?,\s*KEYS\[2\]/],
          none: [/EXPIRE['"]?,\s*KEYS\[1\]/],
        },
      },
    },
    {
      id: 'revoke-explicit',
      title: 'Revocation is an explicit call, not a TTL',
      detail:
        '`revoke(name, version_id)` records the version in `secret:{name}:revoked` (a set) after the overlap, and refuses to revoke the active version. The starter has no revocation path at all, so retiring a version is whatever the TTL happened to do.',
      match: {
        python: {all: [/def revoke\(/, /\bsadd\(/, /REVOKED_KEY/]},
        typescript: {all: [/function revoke\(/, /\bsadd\(/, /REVOKED_KEY/]},
        go: {all: [/func revoke\(/, /\bSAdd\(/, /revokedKey/]},
        scala: {all: [/def revoke\(/, /\bsadd\(/, /revokedKey/]},
        cpp: {all: [/revoke\(/, /\bsadd\(/, /kRevokedKey/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import redis

redis_client = redis.Redis(host="redis", port=6379, decode_responses=True)

ACTIVE_KEY = "secret:{}:active"
OVERLAP_KEY = "secret:{}:overlap"
POINTER_TTL_S = 3600


def activate(name: str, version_id: str) -> str:
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    previous = redis_client.get(ACTIVE_KEY.format(name)) or ""
    redis_client.set(ACTIVE_KEY.format(name), version_id, ex=POINTER_TTL_S)
    redis_client.delete(OVERLAP_KEY.format(name))
    return previous


def valid_versions(name: str) -> list[str]:
    """The versions a consumer may still decrypt with."""
    active = redis_client.get(ACTIVE_KEY.format(name))
    return [active] if active else []
`,
      solution: `import redis

redis_client = redis.Redis(host="redis", port=6379, decode_responses=True)

ACTIVE_KEY = "secret:{}:active"
OVERLAP_KEY = "secret:{}:overlap"
REVOKED_KEY = "secret:{}:revoked"

# At least one deploy cycle: a fleet mid-deploy may still be decrypting with the previous version.
OVERLAP_SECONDS = 900

SWAP_SCRIPT = """
local previous = redis.call('GET', KEYS[1])
if previous then
  redis.call('SET', KEYS[2], previous)
  redis.call('EXPIRE', KEYS[2], ARGV[1])
end
redis.call('SET', KEYS[1], ARGV[2])
return previous or ''
"""


def activate(name: str, version_id: str) -> str:
    """Move the pointer and keep the previous version valid for the overlap window."""
    previous = redis_client.eval(
        SWAP_SCRIPT,
        2,
        ACTIVE_KEY.format(name),
        OVERLAP_KEY.format(name),
        OVERLAP_SECONDS,
        version_id,
    )
    return previous or ""


def valid_versions(name: str) -> list[str]:
    """The versions a consumer may still decrypt with: the active one, plus the overlapping one."""
    versions: list[str] = []
    active = redis_client.get(ACTIVE_KEY.format(name))
    if active:
        versions.append(active)
    previous = redis_client.get(OVERLAP_KEY.format(name))
    if previous and previous not in versions:
        versions.append(previous)
    return versions


def is_revoked(name: str, version_id: str) -> bool:
    return bool(redis_client.sismember(REVOKED_KEY.format(name), version_id))


def revoke(name: str, version_id: str) -> bool:
    """Revocation is explicit and after the overlap; never an incidental effect of a TTL."""
    if version_id == redis_client.get(ACTIVE_KEY.format(name)):
        return False
    redis_client.sadd(REVOKED_KEY.format(name), version_id)
    return True
`,
    },
    typescript: {
      starter: `/** The active-version pointer: the starter. */
import {Redis} from 'ioredis';

const r = new Redis('redis://redis:6379');

const ACTIVE_KEY = (name: string): string => \`secret:\${name}:active\`;
const OVERLAP_KEY = (name: string): string => \`secret:\${name}:overlap\`;
const POINTER_TTL_S = 3600;

export async function activate(name: string, versionId: string): Promise<string> {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const previous = (await r.get(ACTIVE_KEY(name))) ?? '';
  await r.set(ACTIVE_KEY(name), versionId, 'EX', POINTER_TTL_S);
  await r.del(OVERLAP_KEY(name));
  return previous;
}

export async function validVersions(name: string): Promise<string[]> {
  const active = await r.get(ACTIVE_KEY(name));
  return active === null ? [] : [active];
}
`,
      solution: `/** The active-version pointer: one atomic swap, a bounded overlap, a permanent pointer. */
import {Redis} from 'ioredis';

const r = new Redis('redis://redis:6379');

const ACTIVE_KEY = (name: string): string => \`secret:\${name}:active\`;
const OVERLAP_KEY = (name: string): string => \`secret:\${name}:overlap\`;
const REVOKED_KEY = (name: string): string => \`secret:\${name}:revoked\`;

// At least one deploy cycle: a fleet mid-deploy may still be decrypting with the previous version.
const OVERLAP_SECONDS = 900;

const SWAP_SCRIPT = \`
local previous = redis.call('GET', KEYS[1])
if previous then
  redis.call('SET', KEYS[2], previous)
  redis.call('EXPIRE', KEYS[2], ARGV[1])
end
redis.call('SET', KEYS[1], ARGV[2])
return previous or ''
\`;

export async function activate(name: string, versionId: string): Promise<string> {
  const previous = (await r.eval(
    SWAP_SCRIPT,
    2,
    ACTIVE_KEY(name),
    OVERLAP_KEY(name),
    String(OVERLAP_SECONDS),
    versionId,
  )) as string | null;
  return previous ?? '';
}

export async function validVersions(name: string): Promise<string[]> {
  const versions: string[] = [];
  const active = await r.get(ACTIVE_KEY(name));
  if (active !== null) versions.push(active);
  const previous = await r.get(OVERLAP_KEY(name));
  if (previous !== null && !versions.includes(previous)) versions.push(previous);
  return versions;
}

export async function isRevoked(name: string, versionId: string): Promise<boolean> {
  return (await r.sismember(REVOKED_KEY(name), versionId)) === 1;
}

export async function revoke(name: string, versionId: string): Promise<boolean> {
  // Revocation is explicit and after the overlap; never an incidental effect of a TTL.
  if (versionId === (await r.get(ACTIVE_KEY(name)))) return false;
  await r.sadd(REVOKED_KEY(name), versionId);
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

var rdb *redis.Client

const pointerTTL = time.Hour

func activeKey(name string) string  { return "secret:" + name + ":active" }
func overlapKey(name string) string { return "secret:" + name + ":overlap" }

func activate(ctx context.Context, name, versionID string) (string, error) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	previous, _ := rdb.Get(ctx, activeKey(name)).Result()
	if err := rdb.Set(ctx, activeKey(name), versionID, pointerTTL).Err(); err != nil {
		return "", err
	}
	rdb.Del(ctx, overlapKey(name))
	return previous, nil
}

func validVersions(ctx context.Context, name string) ([]string, error) {
	active, err := rdb.Get(ctx, activeKey(name)).Result()
	if err != nil {
		return nil, nil
	}
	return []string{active}, nil
}
`,
      solution: `package main

import (
	"context"

	"github.com/redis/go-redis/v9"
)

var rdb *redis.Client

// At least one deploy cycle: a fleet mid-deploy may still be decrypting with the previous version.
const overlapSeconds = 900

func activeKey(name string) string  { return "secret:" + name + ":active" }
func overlapKey(name string) string { return "secret:" + name + ":overlap" }
func revokedKey(name string) string { return "secret:" + name + ":revoked" }

var swapScript = redis.NewScript(\`
local previous = redis.call('GET', KEYS[1])
if previous then
  redis.call('SET', KEYS[2], previous)
  redis.call('EXPIRE', KEYS[2], ARGV[1])
end
redis.call('SET', KEYS[1], ARGV[2])
return previous or ''
\`)

// activate moves the pointer and keeps the previous version valid for the overlap window.
func activate(ctx context.Context, name, versionID string) (string, error) {
	previous, err := swapScript.Run(ctx, rdb, []string{activeKey(name), overlapKey(name)}, overlapSeconds, versionID).Text()
	if err == redis.Nil {
		return "", nil
	}
	return previous, err
}

// validVersions lists what a consumer may still decrypt with: the active version, plus the overlap.
func validVersions(ctx context.Context, name string) ([]string, error) {
	active, err := rdb.Get(ctx, activeKey(name)).Result()
	if err != nil {
		return nil, nil
	}
	versions := []string{active}
	previous, err := rdb.Get(ctx, overlapKey(name)).Result()
	if err == nil && previous != active {
		versions = append(versions, previous)
	}
	return versions, nil
}

func isRevoked(ctx context.Context, name, versionID string) (bool, error) {
	return rdb.SIsMember(ctx, revokedKey(name), versionID).Result()
}

// revoke is explicit and after the overlap; never an incidental effect of a TTL.
func revoke(ctx context.Context, name, versionID string) (bool, error) {
	active, err := rdb.Get(ctx, activeKey(name)).Result()
	if err == nil && active == versionID {
		return false, nil
	}
	if err := rdb.SAdd(ctx, revokedKey(name), versionID).Err(); err != nil {
		return false, err
	}
	return true, nil
}
`,
    },
    scala: {
      starter: `import redis.clients.jedis.Jedis

object SecretState {
  val jedis = new Jedis("redis", 6379)
  val PointerTtlSeconds = 3600L

  def activeKey(name: String): String = s"secret:$name:active"
  def overlapKey(name: String): String = s"secret:$name:overlap"

  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  def activate(name: String, versionId: String): String = {
    val previous = jedis.get(activeKey(name))
    jedis.setex(activeKey(name), PointerTtlSeconds, versionId)
    jedis.del(overlapKey(name))
    previous
  }

  def validVersions(name: String): List[String] = Option(jedis.get(activeKey(name))).toList
}
`,
      solution: `import redis.clients.jedis.Jedis

object SecretState {
  val jedis = new Jedis("redis", 6379)

  // At least one deploy cycle: a fleet mid-deploy may still be decrypting with the previous version.
  val OverlapSeconds = 900L

  def activeKey(name: String): String = s"secret:$name:active"
  def overlapKey(name: String): String = s"secret:$name:overlap"
  def revokedKey(name: String): String = s"secret:$name:revoked"

  val SwapScript =
    """
      |local previous = redis.call('GET', KEYS[1])
      |if previous then
      |  redis.call('SET', KEYS[2], previous)
      |  redis.call('EXPIRE', KEYS[2], ARGV[1])
      |end
      |redis.call('SET', KEYS[1], ARGV[2])
      |return previous or ''
      |""".stripMargin

  // activate moves the pointer and keeps the previous version valid for the overlap window.
  def activate(name: String, versionId: String): String = {
    val previous = jedis.eval(SwapScript, 2, activeKey(name), overlapKey(name), OverlapSeconds.toString, versionId)
    if (previous == null) "" else previous.asInstanceOf[String]
  }

  def validVersions(name: String): List[String] = {
    val active = Option(jedis.get(activeKey(name)))
    val previous = Option(jedis.get(overlapKey(name)))
    (active ++ previous).distinct
  }

  def isRevoked(name: String, versionId: String): Boolean = jedis.sismember(revokedKey(name), versionId)

  // revoke is explicit and after the overlap; never an incidental effect of a TTL.
  def revoke(name: String, versionId: String): Boolean =
    if (versionId == jedis.get(activeKey(name))) false
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
#include <memory>
#include <string>
#include <vector>

std::unique_ptr<sw::redis::Redis> redis = std::make_unique<sw::redis::Redis>("tcp://redis:6379");

constexpr long long kPointerTtlSeconds = 3600;

std::string kActiveKey(const std::string& name) { return "secret:" + name + ":active"; }
std::string kOverlapKey(const std::string& name) { return "secret:" + name + ":overlap"; }

std::string activate(const std::string& name, const std::string& versionId) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  auto previous = redis->get(kActiveKey(name));
  redis->set(kActiveKey(name), versionId, std::chrono::seconds(kPointerTtlSeconds));
  redis->del(kOverlapKey(name));
  return previous ? *previous : std::string();
}

std::vector<std::string> validVersions(const std::string& name) {
  auto active = redis->get(kActiveKey(name));
  if (!active) return {};
  return {*active};
}
`,
      solution: `#include <sw/redis++/redis++.h>

#include <memory>
#include <string>
#include <vector>

std::unique_ptr<sw::redis::Redis> redis = std::make_unique<sw::redis::Redis>("tcp://redis:6379");

// At least one deploy cycle: a fleet mid-deploy may still be decrypting with the previous version.
constexpr long long kOverlapSeconds = 900;

std::string kActiveKey(const std::string& name) { return "secret:" + name + ":active"; }
std::string kOverlapKey(const std::string& name) { return "secret:" + name + ":overlap"; }
std::string kRevokedKey(const std::string& name) { return "secret:" + name + ":revoked"; }

const char* kSwapLua = R"LUA(
local previous = redis.call('GET', KEYS[1])
if previous then
  redis.call('SET', KEYS[2], previous)
  redis.call('EXPIRE', KEYS[2], ARGV[1])
end
redis.call('SET', KEYS[1], ARGV[2])
return previous or ''
)LUA";

// activate moves the pointer and keeps the previous version valid for the overlap window.
std::string activate(const std::string& name, const std::string& versionId) {
  auto previous = redis->eval<std::string>(
      kSwapLua, {kActiveKey(name), kOverlapKey(name)}, {std::to_string(kOverlapSeconds), versionId});
  return previous ? *previous : std::string();
}

std::vector<std::string> validVersions(const std::string& name) {
  std::vector<std::string> versions;
  auto active = redis->get(kActiveKey(name));
  if (active) versions.push_back(*active);
  auto previous = redis->get(kOverlapKey(name));
  if (previous && *previous != (active ? *active : std::string())) versions.push_back(*previous);
  return versions;
}

bool isRevoked(const std::string& name, const std::string& versionId) {
  return redis->sismember(kRevokedKey(name), versionId);
}

// revoke is explicit and after the overlap; never an incidental effect of a TTL.
bool revoke(const std::string& name, const std::string& versionId) {
  auto active = redis->get(kActiveKey(name));
  if (active && *active == versionId) return false;
  redis->sadd(kRevokedKey(name), versionId);
  return true;
}
`,
    },
  },
  hints: [
    'Symptom: a rotation runs, every pod still holding the old version fails to decrypt at once, and a week of no rotations later a consumer finds no active version at all.',
    'Mechanism: `activate` does GET then SET from the client, sets the pointer with `ex=POINTER_TTL_S`, and deletes the overlap key; `valid_versions` only ever reports the pointer, and nothing records a revocation.',
    'Change: one `SWAP_SCRIPT` via `eval` with key count 2 that writes the overlap key, expires it for `OVERLAP_SECONDS`, and sets the pointer without a TTL; `valid_versions` adds the overlap; `revoke` writes `REVOKED_KEY` with `sadd`.',
  ],
  debrief: `The fix is one Lua script because the swap has three writes that must be seen together: the previous version moves to the overlap key, that key gets its expiry, and the pointer moves. Two client round trips let two rotations interleave and lose a previous version. The overlap length is a product decision rather than a timeout: it must cover the slowest redeploy among registered consumers, hence 900 seconds and not a request deadline. The pointer must not expire, since a TTL there turns an idle week into missing material, while the overlap key is exactly what should expire. Revocation is recorded explicitly so retiring a version is a decision someone made. Production stores add per-consumer leases and read-through caches that re-check the pointer rather than holding a version for the process lifetime.`,
};
