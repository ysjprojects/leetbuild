import type {Step} from '@/lib/types';

export const stateStep: Step = {
  id: 'state',
  title: 'Redis pointer cache with atomic promotion',
  concept: 'redis',
  file: 'state',
  focus: ['registry', 'redis', 'db'],
  task: `## Task

The starter is a plausible model-generated draft: a promotion moves the pointer, the demo reader
picks it up, and the audit list grows. It swaps in pieces, caches for an hour, and keeps no
revision. Find the three flaws, fix them, and prove the fix.

Implement the registry’s version state in Redis:

- The **global pointer** \`pointer:{name}\` holds the version every unpinned tenant reads, and
  \`pin:{tenant}:{name}\` holds a tenant’s own version. A reader resolves the **pin first** and the
  pointer second, falling back to \`DEFAULT_VERSION\`.
- \`promote(name, version, actor)\` and \`rollback(name, version, actor)\` go through the **same
  atomic Lua \`EVAL\`**: it reads the previous pointer, writes the new one, appends the audit entry
  (\`audit:{name}\`) and bumps \`revision:{name}\` — all in one script, so no reader can ever observe
  a pointer whose promotion was never audited, and a promotion can never half-apply.
- The reader’s cache key carries the **revision** (\`pointer_cache:{tenant}:{name}:{revision}\`) with
  a short \`CACHE_TTL_S\`. Keyed by the revision, a promotion or a rollback changes the key, so the
  next read misses the stale entry instead of serving the old version for the whole TTL.
- A promotion followed immediately by a rollback must leave **every** reader on the rolled-back
  version, for pinned and unpinned tenants alike.

**Failure mode the checks target.** Writing the pointer and the pins as two commands means a
promotion racing a rollback leaves half the fleet on each version — the exact incident in the
scenario. Caching the resolved pointer for an hour turns a rollback into a slow, invisible change.
And an audit row written from the client after the swap is a second fact that can be lost while the
first one is already live.`,
  sequence: {
    participants: ['Prompt Registry', 'Redis', 'Reader'],
    messages: [
      {from: 'Prompt Registry', to: 'Redis', label: 'EVAL swap · pointer · audit · revision', kind: 'sync'},
      {from: 'Redis', to: 'Prompt Registry', label: 'previous version', kind: 'reply'},
      {from: 'Reader', to: 'Redis', label: 'GET pin:{tenant}:{name}', kind: 'sync'},
      {from: 'Reader', to: 'Redis', label: 'GET pointer:{name} when unpinned', kind: 'sync'},
      {from: 'Reader', to: 'Redis', label: 'SET pointer_cache:{tenant}:{name}:{revision} EX 5', kind: 'sync'},
      {from: 'Redis', to: 'Reader', label: 'the version to serve', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'atomic-swap',
      title: 'Promotes with one atomic Lua script',
      detail:
        'The pointer is read and written inside one `EVAL`/`NewScript` call that returns the previous version, so two racing promotions cannot interleave. The draft sets the pointer and the pins as separate commands.',
      match: {
        python: {all: [/PROMOTE_LUA/, /\.eval\(/, /GET/, /SET/]},
        typescript: {all: [/PROMOTE_LUA/, /\.eval\(/, /GET/, /SET/]},
        go: {all: [/promoteScript/, /\.Run\(/, /GET/, /SET/]},
        scala: {all: [/PromoteLua/, /\.eval\(/, /GET/, /SET/]},
        cpp: {all: [/kPromoteLua/, /\.eval</, /GET/, /SET/]},
      },
    },
    {
      id: 'audit-in-script',
      title: 'Writes the audit row and bumps the revision in the same script',
      detail:
        'The audit entry (`audit:{name}`) and the revision bump happen inside the same script as the swap: `RPUSH` and `INCR` are Lua calls, not a second client round trip. The draft pushes the audit row after the pointer is already live.',
      match: {
        python: {all: [/RPUSH/, /INCR/, /audit:/]},
        typescript: {all: [/RPUSH/, /INCR/, /audit:/]},
        go: {all: [/RPUSH/, /INCR/, /audit:/]},
        scala: {all: [/RPUSH/, /INCR/, /audit:/]},
        cpp: {all: [/RPUSH/, /INCR/, /audit:/]},
      },
    },
    {
      id: 'pin-first',
      title: 'Reads the tenant pin before the global pointer',
      detail:
        'A reader looks up `pin:{tenant}:{name}` first and only falls back to `pointer:{name}`, so a pinned tenant keeps its version while the global pointer moves. The draft reads the global pointer for everyone.',
      match: {
        python: {all: [/pin:/, /pointer:/], order: [/r\.get\(pin_key\(/, /r\.get\(pointer_key\(/]},
        typescript: {all: [/pin:/, /pointer:/], order: [/r\.get\(pinKey\(/, /r\.get\(pointerKey\(/]},
        go: {all: [/pin:/, /pointer:/], order: [/rdb\.Get\(ctx,\s*pinKey\(/, /rdb\.Get\(ctx,\s*pointerKey\(/]},
        scala: {all: [/pin:/, /pointer:/], order: [/jedis\.get\(pinKey\(/, /jedis\.get\(pointerKey\(/]},
        cpp: {all: [/pin:/, /pointer:/], order: [/redis\.get\(pin_key\(/, /redis\.get\(pointer_key\(/]},
      },
    },
    {
      id: 'revision-cache',
      title: 'Cache key carries the revision, with a short TTL',
      detail:
        'The read cache is `pointer_cache:{tenant}:{name}:{revision}` and expires in `CACHE_TTL_S` seconds: the key changes the moment the revision does, so a rollback is visible on the next read. The draft caches by name for an hour.',
      match: {
        python: {all: [/revision:/, /cache_key\(/], none: [/3600/]},
        typescript: {all: [/revision:/, /cacheKey\(/], none: [/3600/]},
        go: {all: [/revision:/, /cacheKey\(/], none: [/3600/]},
        scala: {all: [/revision:/, /cacheKey\(/], none: [/3600/]},
        cpp: {all: [/revision:/, /cache_key\(/], none: [/3600/]},
      },
    },
    {
      id: 'rollback-path',
      title: 'Rolls back through the same atomic path',
      detail:
        '`rollback` exists beside `promote` and reuses the same script with the actor recorded, so a rollback is as atomic and as auditable as a promotion. The draft has no rollback at all — an operator edits the pointer by hand.',
      match: {
        python: {all: [/def rollback\(/, /actor/, /PROMOTE_LUA/]},
        typescript: {all: [/function rollback\(/, /actor/, /PROMOTE_LUA/]},
        go: {all: [/func rollback\(/, /actor/, /promoteScript/]},
        scala: {all: [/def rollback\(/, /actor/, /PromoteLua/]},
        cpp: {all: [/rollback\(/, /actor/, /kPromoteLua/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import time

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

DEFAULT_VERSION = 1
CACHE_TTL_S = 3600  # cache the resolved pointer for an hour


def set_pointer(name: str, version: int, tenant: str = "", actor: str = "") -> None:
    # TODO: the pointer and the tenant pins go out as separate commands, the audit row is a second
    # round trip after the swap, and readers cache the resolved pointer for an hour. Make the
    # promotion and its audit row one atomic operation, keep a revision, and add rollback.
    r.set(f"pointer:{name}", version)
    if tenant:
        r.set(f"pin:{tenant}:{name}", version)
    r.rpush(f"audit:{name}", f"{time.time()}:{actor}:{version}")


def active_version(tenant: str, name: str) -> int:
    cached = r.get(f"pointer_cache:{tenant}:{name}")
    if cached is not None:
        return int(cached)
    value = int(r.get(f"pointer:{name}") or DEFAULT_VERSION)
    r.set(f"pointer_cache:{tenant}:{name}", value, ex=CACHE_TTL_S)
    return value
`,
      solution: `import time

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

DEFAULT_VERSION = 1
CACHE_TTL_S = 5

# One round trip carries the whole promotion: the pointer moves, the audit entry is appended and
# the revision is bumped, so no reader can see a pointer that was never audited.
PROMOTE_LUA = """
local previous = redis.call('GET', KEYS[1])
redis.call('SET', KEYS[1], ARGV[1])
redis.call('RPUSH', KEYS[2], ARGV[2])
redis.call('INCR', KEYS[3])
return previous or ''
"""


def pointer_key(name: str) -> str:
    return f"pointer:{name}"


def pin_key(tenant: str, name: str) -> str:
    return f"pin:{tenant}:{name}"


def audit_key(name: str) -> str:
    return f"audit:{name}"


def revision_key(name: str) -> str:
    return f"revision:{name}"


def cache_key(tenant: str, name: str, revision: str) -> str:
    return f"pointer_cache:{tenant}:{name}:{revision}"


def swap(name: str, version: int, actor: str, action: str) -> str:
    entry = f"{time.time()}:{action}:{actor}:{version}"
    previous = r.eval(
        PROMOTE_LUA, 3, pointer_key(name), audit_key(name), revision_key(name), str(version), entry
    )
    return str(previous)


def promote(name: str, version: int, actor: str) -> str:
    return swap(name, version, actor, "promote")


def rollback(name: str, version: int, actor: str) -> str:
    return swap(name, version, actor, "rollback")


def active_version(tenant: str, name: str) -> int:
    revision = r.get(revision_key(name)) or "0"
    cached = r.get(cache_key(tenant, name, revision))
    if cached is not None:
        return int(cached)
    pinned = r.get(pin_key(tenant, name))
    pointer = r.get(pointer_key(name))
    version = int(pinned or pointer or DEFAULT_VERSION)
    r.set(cache_key(tenant, name, revision), version, ex=CACHE_TTL_S)
    return version
`,
    },
    typescript: {
      starter: `/** Version state: a model-generated draft that swaps in pieces and caches for an hour. */
import {Redis} from 'ioredis';

const r = new Redis('redis://redis:6379');

const DEFAULT_VERSION = 1;
const CACHE_TTL_S = 3600; // cache the resolved pointer for an hour

export async function setPointer(
  name: string,
  version: number,
  tenant?: string,
  actor?: string,
): Promise<void> {
  // TODO: the pointer and the tenant pins go out as separate commands, the audit row is a second
  // round trip after the swap, and readers cache the resolved pointer for an hour. Make the
  // promotion and its audit row one atomic operation, keep a revision, and add rollback.
  await r.set(\`pointer:\${name}\`, String(version));
  if (tenant !== undefined) await r.set(\`pin:\${tenant}:\${name}\`, String(version));
  await r.rpush(\`audit:\${name}\`, \`\${Date.now()}:\${actor ?? ''}:\${version}\`);
}

export async function activeVersion(tenant: string, name: string): Promise<number> {
  const cached = await r.get(\`pointer_cache:\${tenant}:\${name}\`);
  if (cached !== null) return Number(cached);
  const value = Number((await r.get(\`pointer:\${name}\`)) ?? DEFAULT_VERSION);
  await r.set(\`pointer_cache:\${tenant}:\${name}\`, String(value), 'EX', CACHE_TTL_S);
  return value;
}
`,
      solution: `/** Version state: one atomic swap, a revision, and a read cache that follows the revision. */
import {Redis} from 'ioredis';

const r = new Redis('redis://redis:6379');

const DEFAULT_VERSION = 1;
const CACHE_TTL_S = 5;

// One round trip carries the whole promotion: the pointer moves, the audit entry is appended and
// the revision is bumped, so no reader can see a pointer that was never audited.
const PROMOTE_LUA = \`
local previous = redis.call('GET', KEYS[1])
redis.call('SET', KEYS[1], ARGV[1])
redis.call('RPUSH', KEYS[2], ARGV[2])
redis.call('INCR', KEYS[3])
return previous or ''
\`;

const pointerKey = (name: string): string => \`pointer:\${name}\`;
const pinKey = (tenant: string, name: string): string => \`pin:\${tenant}:\${name}\`;
const auditKey = (name: string): string => \`audit:\${name}\`;
const revisionKey = (name: string): string => \`revision:\${name}\`;
const cacheKey = (tenant: string, name: string, revision: string): string =>
  \`pointer_cache:\${tenant}:\${name}:\${revision}\`;

async function swap(name: string, version: number, actor: string, action: string): Promise<string> {
  const previous = (await r.eval(
    PROMOTE_LUA,
    3,
    pointerKey(name),
    auditKey(name),
    revisionKey(name),
    String(version),
    \`\${Date.now()}:\${action}:\${actor}:\${version}\`,
  )) as string;
  return previous ?? '';
}

export async function promote(name: string, version: number, actor: string): Promise<string> {
  return swap(name, version, actor, 'promote');
}

export async function rollback(name: string, version: number, actor: string): Promise<string> {
  return swap(name, version, actor, 'rollback');
}

export async function activeVersion(tenant: string, name: string): Promise<number> {
  const revision = (await r.get(revisionKey(name))) ?? '0';
  const cached = await r.get(cacheKey(tenant, name, revision));
  if (cached !== null) return Number(cached);
  const pinned = await r.get(pinKey(tenant, name));
  const pointer = await r.get(pointerKey(name));
  const version = Number(pinned ?? pointer ?? DEFAULT_VERSION);
  await r.set(cacheKey(tenant, name, revision), String(version), 'EX', CACHE_TTL_S);
  return version;
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"fmt"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"
)

const (
	defaultVersion = 1
	cacheTTLS      = 3600 // cache the resolved pointer for an hour
)

var rdb *redis.Client

// TODO: the pointer and the tenant pins go out as separate commands, the audit row is a second
// round trip after the swap, and readers cache the resolved pointer for an hour. Make the
// promotion and its audit row one atomic operation, keep a revision, and add rollback.
func setPointer(ctx context.Context, name string, version int, tenant, actor string) {
	rdb.Set(ctx, fmt.Sprintf("pointer:%s", name), version, 0)
	if tenant != "" {
		rdb.Set(ctx, fmt.Sprintf("pin:%s:%s", tenant, name), version, 0)
	}
	rdb.RPush(ctx, fmt.Sprintf("audit:%s", name), fmt.Sprintf("%d:%s:%d", time.Now().Unix(), actor, version))
}

func activeVersion(ctx context.Context, tenant, name string) int {
	cached, err := rdb.Get(ctx, fmt.Sprintf("pointer_cache:%s:%s", tenant, name)).Result()
	if err == nil {
		value, _ := strconv.Atoi(cached)
		return value
	}
	raw, _ := rdb.Get(ctx, fmt.Sprintf("pointer:%s", name)).Result()
	value, _ := strconv.Atoi(raw)
	if value == 0 {
		value = defaultVersion
	}
	rdb.Set(ctx, fmt.Sprintf("pointer_cache:%s:%s", tenant, name), value, cacheTTLS*time.Second)
	return value
}
`,
      solution: `package main

import (
	"context"
	"fmt"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"
)

const (
	defaultVersion = 1
	cacheTTLS      = 5
)

var rdb *redis.Client

// One round trip carries the whole promotion: the pointer moves, the audit entry is appended and
// the revision is bumped, so no reader can see a pointer that was never audited.
var promoteScript = redis.NewScript(\`
local previous = redis.call('GET', KEYS[1])
redis.call('SET', KEYS[1], ARGV[1])
redis.call('RPUSH', KEYS[2], ARGV[2])
redis.call('INCR', KEYS[3])
return previous or ''
\`)

func pointerKey(name string) string {
	return "pointer:" + name
}

func pinKey(tenant, name string) string {
	return "pin:" + tenant + ":" + name
}

func auditKey(name string) string {
	return "audit:" + name
}

func revisionKey(name string) string {
	return "revision:" + name
}

func cacheKey(tenant, name, revision string) string {
	return "pointer_cache:" + tenant + ":" + name + ":" + revision
}

func swap(ctx context.Context, name string, version int, actor, action string) (string, error) {
	entry := fmt.Sprintf("%d:%s:%s:%d", time.Now().Unix(), action, actor, version)
	previous, err := promoteScript.Run(
		ctx,
		rdb,
		[]string{pointerKey(name), auditKey(name), revisionKey(name)},
		version,
		entry,
	).Result()
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("%v", previous), nil
}

func promote(ctx context.Context, name string, version int, actor string) (string, error) {
	return swap(ctx, name, version, actor, "promote")
}

func rollback(ctx context.Context, name string, version int, actor string) (string, error) {
	return swap(ctx, name, version, actor, "rollback")
}

func activeVersion(ctx context.Context, tenant, name string) int {
	revision, _ := rdb.Get(ctx, revisionKey(name)).Result()
	if revision == "" {
		revision = "0"
	}
	if cached, err := rdb.Get(ctx, cacheKey(tenant, name, revision)).Result(); err == nil {
		value, _ := strconv.Atoi(cached)
		return value
	}
	pinned, _ := rdb.Get(ctx, pinKey(tenant, name)).Result()
	pointer, _ := rdb.Get(ctx, pointerKey(name)).Result()
	raw := pinned
	if raw == "" {
		raw = pointer
	}
	value, _ := strconv.Atoi(raw)
	if value == 0 {
		value = defaultVersion
	}
	rdb.Set(ctx, cacheKey(tenant, name, revision), value, cacheTTLS*time.Second)
	return value
}
`,
    },
    scala: {
      starter: `import redis.clients.jedis.Jedis

object PointerState {
  val DefaultVersion = 1
  val CacheTtlS = 3600 // cache the resolved pointer for an hour
  val jedis = new Jedis("redis", 6379)

  // TODO: the pointer and the tenant pins go out as separate commands, the audit row is a second
  // round trip after the swap, and readers cache the resolved pointer for an hour. Make the
  // promotion and its audit row one atomic operation, keep a revision, and add rollback.
  def setPointer(name: String, version: Int, tenant: String = "", actor: String = ""): Unit = {
    jedis.set(s"pointer:$name", version.toString)
    if (tenant.nonEmpty) jedis.set(s"pin:$tenant:$name", version.toString)
    jedis.rpush(s"audit:$name", s"\${System.currentTimeMillis()}:$actor:$version")
  }

  def activeVersion(tenant: String, name: String): Int = {
    Option(jedis.get(s"pointer_cache:$tenant:$name")) match {
      case Some(cached) => cached.toInt
      case None =>
        val value = Option(jedis.get(s"pointer:$name")).map(_.toInt).getOrElse(DefaultVersion)
        jedis.set(s"pointer_cache:$tenant:$name", value.toString)
        jedis.expire(s"pointer_cache:$tenant:$name", CacheTtlS.toLong)
        value
    }
  }
}
`,
      solution: `import redis.clients.jedis.Jedis

object PointerState {
  val DefaultVersion = 1
  val CacheTtlS = 5

  val jedis = new Jedis("redis", 6379)

  // One round trip carries the whole promotion: the pointer moves, the audit entry is appended and
  // the revision is bumped, so no reader can see a pointer that was never audited.
  val PromoteLua =
    """
      |local previous = redis.call('GET', KEYS[1])
      |redis.call('SET', KEYS[1], ARGV[1])
      |redis.call('RPUSH', KEYS[2], ARGV[2])
      |redis.call('INCR', KEYS[3])
      |return previous or ''
      |""".stripMargin

  def pointerKey(name: String): String = s"pointer:$name"

  def pinKey(tenant: String, name: String): String = s"pin:$tenant:$name"

  def auditKey(name: String): String = s"audit:$name"

  def revisionKey(name: String): String = s"revision:$name"

  def cacheKey(tenant: String, name: String, revision: String): String =
    s"pointer_cache:$tenant:$name:$revision"

  def swap(name: String, version: Int, actor: String, action: String): String = {
    val entry = s"\${System.currentTimeMillis()}:$action:$actor:$version"
    val result = jedis.eval(
      PromoteLua,
      3,
      pointerKey(name),
      auditKey(name),
      revisionKey(name),
      version.toString,
      entry
    )
    Option(result).map(_.toString).getOrElse("")
  }

  def promote(name: String, version: Int, actor: String): String = swap(name, version, actor, "promote")

  def rollback(name: String, version: Int, actor: String): String = swap(name, version, actor, "rollback")

  def activeVersion(tenant: String, name: String): Int = {
    val revision = Option(jedis.get(revisionKey(name))).getOrElse("0")
    Option(jedis.get(cacheKey(tenant, name, revision))) match {
      case Some(cached) => cached.toInt
      case None =>
        val pinned = Option(jedis.get(pinKey(tenant, name)))
        val pointer = Option(jedis.get(pointerKey(name)))
        val version = pinned.orElse(pointer).map(_.toInt).getOrElse(DefaultVersion)
        jedis.set(cacheKey(tenant, name, revision), version.toString)
        jedis.expire(cacheKey(tenant, name, revision), CacheTtlS.toLong)
        version
    }
  }
}
`,
    },
    cpp: {
      starter: `#include <sw/redis++/redis++.h>

#include <chrono>
#include <string>

constexpr int kDefaultVersion = 1;
constexpr long long kCacheTtlS = 3600;  // cache the resolved pointer for an hour

// TODO: the pointer and the tenant pins go out as separate commands, the audit row is a second
// round trip after the swap, and readers cache the resolved pointer for an hour. Make the promotion
// and its audit row one atomic operation, keep a revision, and add rollback.
void set_pointer(sw::redis::Redis& redis, const std::string& name, int version, const std::string& tenant, const std::string& actor) {
  redis.set("pointer:" + name, std::to_string(version));
  if (!tenant.empty()) redis.set("pin:" + tenant + ":" + name, std::to_string(version));
  redis.rpush("audit:" + name, std::to_string(std::chrono::system_clock::now().time_since_epoch().count()) + ":" + actor + ":" + std::to_string(version));
}

int active_version(sw::redis::Redis& redis, const std::string& tenant, const std::string& name) {
  const auto cache_key = "pointer_cache:" + tenant + ":" + name;
  if (auto cached = redis.get(cache_key)) return std::stoi(*cached);
  auto raw = redis.get("pointer:" + name);
  const int value = raw ? std::stoi(*raw) : kDefaultVersion;
  redis.set(cache_key, std::to_string(value), std::chrono::seconds(kCacheTtlS));
  return value;
}
`,
      solution: `#include <sw/redis++/redis++.h>

#include <chrono>
#include <string>
#include <vector>

constexpr int kDefaultVersion = 1;
constexpr long long kCacheTtlS = 5;

// One round trip carries the whole promotion: the pointer moves, the audit entry is appended and
// the revision is bumped, so no reader can see a pointer that was never audited.
const char* kPromoteLua = R"LUA(
local previous = redis.call('GET', KEYS[1])
redis.call('SET', KEYS[1], ARGV[1])
redis.call('RPUSH', KEYS[2], ARGV[2])
redis.call('INCR', KEYS[3])
return previous or ''
)LUA";

std::string pointer_key(const std::string& name) { return "pointer:" + name; }

std::string pin_key(const std::string& tenant, const std::string& name) {
  return "pin:" + tenant + ":" + name;
}

std::string audit_key(const std::string& name) { return "audit:" + name; }

std::string revision_key(const std::string& name) { return "revision:" + name; }

std::string cache_key(const std::string& tenant, const std::string& name, const std::string& revision) {
  return "pointer_cache:" + tenant + ":" + name + ":" + revision;
}

std::string swap(sw::redis::Redis& redis, const std::string& name, int version, const std::string& actor, const std::string& action) {
  const auto entry = std::to_string(std::chrono::duration_cast<std::chrono::seconds>(
                                        std::chrono::system_clock::now().time_since_epoch())
                                        .count()) +
                     ":" + action + ":" + actor + ":" + std::to_string(version);
  const auto previous = redis.eval<std::string>(
      kPromoteLua,
      {pointer_key(name), audit_key(name), revision_key(name)},
      {std::to_string(version), entry});
  return previous ? *previous : "";
}

std::string promote(sw::redis::Redis& redis, const std::string& name, int version, const std::string& actor) {
  return swap(redis, name, version, actor, "promote");
}

std::string rollback(sw::redis::Redis& redis, const std::string& name, int version, const std::string& actor) {
  return swap(redis, name, version, actor, "rollback");
}

int active_version(sw::redis::Redis& redis, const std::string& tenant, const std::string& name) {
  auto revision = redis.get(revision_key(name));
  const auto revision_value = revision ? *revision : std::string("0");
  if (auto cached = redis.get(cache_key(tenant, name, revision_value))) return std::stoi(*cached);
  auto pinned = redis.get(pin_key(tenant, name));
  auto pointer = redis.get(pointer_key(name));
  const int value = pinned ? std::stoi(*pinned) : (pointer ? std::stoi(*pointer) : kDefaultVersion);
  redis.set(cache_key(tenant, name, revision_value), std::to_string(value), std::chrono::seconds(kCacheTtlS));
  return value;
}
`,
    },
  },
  hints: [
    'Everything a promotion changes must be inside the script: `redis.call("SET", KEYS[1], ARGV[1])`, the `RPUSH` audit entry and the `INCR` revision. A script is atomic, a sequence of commands is not — and the sequence is exactly what a racing rollback splits in half.',
    'Give readers a revision to key on. Bumping `revision:{name}` in the same script means the next read builds a different `pointer_cache:{tenant}:{name}:{revision}`, so the stale entry is simply unreachable instead of being served until it expires.',
    'A short `CACHE_TTL_S` is not the fix by itself — the revision is. The TTL only bounds how long an orphaned key lives; the revision is what makes a rollback visible on the very next read for pinned and unpinned tenants alike.',
  ],
  debrief: `The interview question is what "the fleet is on one version" means when reads are cached and writes are concurrent. Two separate writes can be split by a race, and the split is invisible until someone compares two readers. One script removes the interleaving; a revision removes the staleness, because the cache key itself changes on every swap; and the audit row inside the same script removes the window where a live pointer has no history. Note the shape of the answer: nothing here is about Redis performance, it is about making a multi-step state change a single fact. Real registries add per-tenant pin writes under a lease, a monotonic revision per name for cache validation, and a reconciliation job that compares the Redis pointer with the durable record and repairs drift.`,
};
