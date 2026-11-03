import type {Step} from '@/lib/types';

export const stateStep: Step = {
  id: 'state',
  title: 'The live pointer: promote and roll back in one script',
  concept: 'redis',
  file: 'state',
  focus: ['registry', 'redis'],
  task: `## Task

**Starting point.** The starter keeps the live pointer under the keys \`prompts/config\` defines:
\`promote(tenant, name, version, actor)\` reads the old pointer, sets the new one and appends to the
history and audit lists; \`rollback(tenant, name, actor)\` steps the pointer back one version;
\`live_version(tenant, name)\` reads it through a five-minute in-process cache. Both moves answer
\`{from, to}\`. The demo promotes and rolls back. It hides 4 flaws.

**Failure mode the checks target.** A rollback is the change made while something is on fire: it must
land on every reader at once, on a version that has shipped. The starter's moves are separate
commands, so a second operator lands between them and the audit stops describing what happened; its
rollback subtracts one; and its reader keeps the old answer for five minutes.

Requirements:

- \`promote\` and \`rollback\` each run as **one Lua script**.
- \`promote\` of a version with no \`version_key\` changes nothing and returns none (\`None\`, \`null\`,
  \`nil\`, \`nullopt\`).
- \`rollback\` pops the history and makes its new last entry live; with fewer than two entries it
  returns none.
- Every move appends \`action|from|to|actor|at\` to the audit list (\`from\` is 0 before the first
  promotion).
- \`live_version\` reads the pointer on every call.`,
  sequence: {
    participants: ['Operator', 'registryd', 'Redis', 'Reader'],
    messages: [
      {from: 'Operator', to: 'registryd', label: 'promote(tenant, name, 7, actor)', kind: 'sync'},
      {from: 'registryd', to: 'Redis', label: 'EVAL promote · live history audit version · 7 actor now', kind: 'sync'},
      {
        from: 'Redis',
        to: 'Redis',
        label: 'EXISTS version · GET live · SET · RPUSH history · RPUSH audit',
        kind: 'sync',
      },
      {from: 'Redis', to: 'registryd', label: '{ok, 4}', kind: 'reply'},
      {from: 'Operator', to: 'registryd', label: 'rollback(tenant, name, actor)', kind: 'sync'},
      {from: 'registryd', to: 'Redis', label: 'EVAL rollback · RPOP history · LINDEX -1 · SET live', kind: 'sync'},
      {from: 'Reader', to: 'Redis', label: 'GET live, on every read', kind: 'sync'},
    ],
  },
  checks: [
    {
      id: 'atomic-promote',
      title: 'Promotes in one Lua script',
      detail:
        'Another operator promoting between two of this promotion’s commands leaves an audit list whose every entry starts where the previous one ended, and whose last entry is the live version. The starter issues GET, SET and RPUSH separately, and the audit says version 1 moved twice.',
      match: {
        python: {
          all: [
            /register_script\(|\.eval\(|\.evalsha\(/,
            /redis\.call\(\s*['"]SET['"]/,
            /redis\.call\(\s*['"]RPUSH['"]/,
          ],
          none: [/\br\.set\(\s*live_key\(/],
        },
        typescript: {
          all: [/defineCommand\(|\.eval\(|\.evalsha\(/, /redis\.call\(\s*['"]SET['"]/, /redis\.call\(\s*['"]RPUSH['"]/],
          none: [/redis\.set\(\s*liveKey\(/],
        },
        go: {
          all: [
            /redis\.NewScript\(|\.Eval\(|\.EvalSha\(/,
            /redis\.call\(\s*['"]SET['"]/,
            /redis\.call\(\s*['"]RPUSH['"]/,
          ],
          none: [/rdb\.Set\(\s*ctx,\s*config\.LiveKey\(/],
        },
        scala: {
          all: [/jedis\.eval(sha)?\(/, /redis\.call\(\s*['"]SET['"]/, /redis\.call\(\s*['"]RPUSH['"]/],
          none: [/jedis\.set\(\s*Config\.liveKey\(/],
        },
        cpp: {
          all: [/redis\.eval(sha)?[<(]/, /redis\.call\(\s*['"]SET['"]/, /redis\.call\(\s*['"]RPUSH['"]/],
          none: [/redis\.set\(\s*config::live_key\(/],
        },
      },
    },
    {
      id: 'registered-only',
      title: 'Promotes only a registered version',
      detail:
        'Promoting version 9, which was never registered, returns none and leaves the pointer, the history and the audit as they were; once registered it promotes. The starter points every reader at a version the store does not hold.',
      match: {
        python: {all: [/version_key\(|versions\.get\(/]},
        typescript: {all: [/versionKey\(|versions\.get\(/]},
        go: {all: [/config\.VersionKey\(|versions\.Get\(/]},
        scala: {all: [/Config\.versionKey\(|Versions\.get\(/]},
        cpp: {all: [/config::version_key\(|versions::get\(/]},
      },
    },
    {
      id: 'rollback-previous',
      title: 'Rolls back to the version that was live before',
      detail:
        'After promoting 1, 4 and 7, rollback lands on 4, then on 1, then returns none and leaves 1 live, each move audited. The starter subtracts one and puts version 6, which never shipped, live.',
      match: {
        python: {all: [/\b(rpop|lindex|lrange)\b/i], none: [/current\s*-\s*1/]},
        typescript: {all: [/\b(rpop|lindex|lrange)\b/i], none: [/current\s*-\s*1/]},
        go: {all: [/\b(rpop|lindex|lrange)\b/i], none: [/current\s*-\s*1/]},
        scala: {all: [/\b(rpop|lindex|lrange)\b/i], none: [/current\s*-\s*1/]},
        cpp: {all: [/\b(rpop|lindex|lrange)\b/i], none: [/current\s*-\s*1/]},
      },
    },
    {
      id: 'live-uncached',
      title: 'Serves a rollback on the very next read',
      detail:
        'A reader that just saw version 4 sees version 1 on its next read after another replica rolled back. The starter caches the pointer in the process for five minutes.',
      match: {
        python: {none: [/CACHE_TTL_S|_live_cache/]},
        typescript: {none: [/CACHE_TTL_S|liveCache/]},
        go: {none: [/cacheTTL|liveCache/]},
        scala: {none: [/CacheTtlSeconds|liveCache/]},
        cpp: {none: [/kCacheTtl|live_cache/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import time

import redis

from prompts.config import audit_key, history_key, live_key

r = redis.Redis(host="redis", port=6379, decode_responses=True)

CACHE_TTL_S = 300
_live_cache: dict[tuple[str, str], tuple[int | None, float]] = {}


def promote(tenant: str, name: str, version: int, actor: str) -> dict | None:
    """Make version live for the tenant's readers: {"from", "to"}; None when it is not registered."""
    # TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
    previous = int(r.get(live_key(tenant, name)) or 0)
    r.set(live_key(tenant, name), version)
    r.rpush(history_key(tenant, name), version)
    r.rpush(audit_key(tenant, name), f"promote|{previous}|{version}|{actor}|{int(time.time())}")
    return {"from": previous, "to": version}


def rollback(tenant: str, name: str, actor: str) -> dict | None:
    """Put back the version that was live before this one: {"from", "to"}; None when there is none."""
    current = int(r.get(live_key(tenant, name)) or 0)
    target = current - 1
    if target < 1:
        return None
    r.set(live_key(tenant, name), target)
    r.rpush(audit_key(tenant, name), f"rollback|{current}|{target}|{actor}|{int(time.time())}")
    return {"from": current, "to": target}


def live_version(tenant: str, name: str) -> int | None:
    """The version the tenant's readers are served; None before the first promotion."""
    cached = _live_cache.get((tenant, name))
    if cached is not None and cached[1] > time.time():
        return cached[0]
    raw = r.get(live_key(tenant, name))
    version = int(raw) if raw is not None else None
    _live_cache[(tenant, name)] = (version, time.time() + CACHE_TTL_S)
    return version
`,
      solution: `import time

import redis

from prompts.config import audit_key, history_key, live_key, version_key

r = redis.Redis(host="redis", port=6379, decode_responses=True)

# KEYS: live, history, audit, version. ARGV: version, actor, now.
PROMOTE = """
if redis.call('EXISTS', KEYS[4]) == 0 then
  return {'unregistered', ''}
end
local from = redis.call('GET', KEYS[1]) or '0'
if from == ARGV[1] then
  return {'ok', from}
end
redis.call('SET', KEYS[1], ARGV[1])
redis.call('RPUSH', KEYS[2], ARGV[1])
redis.call('RPUSH', KEYS[3], 'promote|' .. from .. '|' .. ARGV[1] .. '|' .. ARGV[2] .. '|' .. ARGV[3])
return {'ok', from}
"""

# KEYS: live, history, audit. ARGV: actor, now.
ROLLBACK = """
if redis.call('LLEN', KEYS[2]) < 2 then
  return {'empty', '', ''}
end
local from = redis.call('RPOP', KEYS[2])
local to = redis.call('LINDEX', KEYS[2], -1)
redis.call('SET', KEYS[1], to)
redis.call('RPUSH', KEYS[3], 'rollback|' .. from .. '|' .. to .. '|' .. ARGV[1] .. '|' .. ARGV[2])
return {'ok', from, to}
"""

promote_script = r.register_script(PROMOTE)
rollback_script = r.register_script(ROLLBACK)


def promote(tenant: str, name: str, version: int, actor: str) -> dict | None:
    """Make version live for the tenant's readers: {"from", "to"}; None when it is not registered."""
    keys = [live_key(tenant, name), history_key(tenant, name), audit_key(tenant, name), version_key(tenant, name, version)]
    status, previous = promote_script(keys=keys, args=[version, actor, int(time.time())])
    if status != "ok":
        return None
    return {"from": int(previous), "to": version}


def rollback(tenant: str, name: str, actor: str) -> dict | None:
    """Put back the version that was live before this one: {"from", "to"}; None when there is none."""
    keys = [live_key(tenant, name), history_key(tenant, name), audit_key(tenant, name)]
    status, previous, target = rollback_script(keys=keys, args=[actor, int(time.time())])
    if status != "ok":
        return None
    return {"from": int(previous), "to": int(target)}


def live_version(tenant: str, name: str) -> int | None:
    """The version the tenant's readers are served; None before the first promotion."""
    raw = r.get(live_key(tenant, name))
    return int(raw) if raw is not None else None
`,
    },
    typescript: {
      starter: `import Redis from 'ioredis';

import {auditKey, historyKey, liveKey} from 'prompts/config';

export const redis = new Redis({host: 'redis', port: 6379});

export const CACHE_TTL_S = 300;
const liveCache = new Map<string, {version: number | null; until: number}>();

/** A move of the live pointer: the version that was live (0 for none) and the one that is. */
export interface Swap {
  from: number;
  to: number;
}

const now = (): number => Math.floor(Date.now() / 1000);

/** Make version live for the tenant's readers; null when it is not registered. */
export async function promote(tenant: string, name: string, version: number, actor: string): Promise<Swap | null> {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  const previous = Number((await redis.get(liveKey(tenant, name))) ?? 0);
  await redis.set(liveKey(tenant, name), String(version));
  await redis.rpush(historyKey(tenant, name), String(version));
  await redis.rpush(auditKey(tenant, name), \`promote|\${previous}|\${version}|\${actor}|\${now()}\`);
  return {from: previous, to: version};
}

/** Put back the version that was live before this one; null when there is none. */
export async function rollback(tenant: string, name: string, actor: string): Promise<Swap | null> {
  const current = Number((await redis.get(liveKey(tenant, name))) ?? 0);
  const target = current - 1;
  if (target < 1) return null;
  await redis.set(liveKey(tenant, name), String(target));
  await redis.rpush(auditKey(tenant, name), \`rollback|\${current}|\${target}|\${actor}|\${now()}\`);
  return {from: current, to: target};
}

/** The version the tenant's readers are served; null before the first promotion. */
export async function liveVersion(tenant: string, name: string): Promise<number | null> {
  const key = liveKey(tenant, name);
  const cached = liveCache.get(key);
  if (cached !== undefined && cached.until > Date.now()) return cached.version;
  const raw = await redis.get(key);
  const version = raw === null ? null : Number(raw);
  liveCache.set(key, {version, until: Date.now() + CACHE_TTL_S * 1000});
  return version;
}
`,
      solution: `import Redis from 'ioredis';

import {auditKey, historyKey, liveKey, versionKey} from 'prompts/config';

export const redis = new Redis({host: 'redis', port: 6379});

// KEYS: live, history, audit, version. ARGV: version, actor, now.
const PROMOTE = \`
if redis.call('EXISTS', KEYS[4]) == 0 then
  return {'unregistered', ''}
end
local from = redis.call('GET', KEYS[1]) or '0'
if from == ARGV[1] then
  return {'ok', from}
end
redis.call('SET', KEYS[1], ARGV[1])
redis.call('RPUSH', KEYS[2], ARGV[1])
redis.call('RPUSH', KEYS[3], 'promote|' .. from .. '|' .. ARGV[1] .. '|' .. ARGV[2] .. '|' .. ARGV[3])
return {'ok', from}
\`;

// KEYS: live, history, audit. ARGV: actor, now.
const ROLLBACK = \`
if redis.call('LLEN', KEYS[2]) < 2 then
  return {'empty', '', ''}
end
local from = redis.call('RPOP', KEYS[2])
local to = redis.call('LINDEX', KEYS[2], -1)
redis.call('SET', KEYS[1], to)
redis.call('RPUSH', KEYS[3], 'rollback|' .. from .. '|' .. to .. '|' .. ARGV[1] .. '|' .. ARGV[2])
return {'ok', from, to}
\`;

/** A move of the live pointer: the version that was live (0 for none) and the one that is. */
export interface Swap {
  from: number;
  to: number;
}

/** Make version live for the tenant's readers; null when it is not registered. */
export async function promote(tenant: string, name: string, version: number, actor: string): Promise<Swap | null> {
  const keys = [liveKey(tenant, name), historyKey(tenant, name), auditKey(tenant, name), versionKey(tenant, name, version)];
  const [status, previous] = (await redis.eval(PROMOTE, keys.length, ...keys, version, actor, Math.floor(Date.now() / 1000))) as string[];
  return status === 'ok' ? {from: Number(previous), to: version} : null;
}

/** Put back the version that was live before this one; null when there is none. */
export async function rollback(tenant: string, name: string, actor: string): Promise<Swap | null> {
  const keys = [liveKey(tenant, name), historyKey(tenant, name), auditKey(tenant, name)];
  const [status, previous, target] = (await redis.eval(ROLLBACK, keys.length, ...keys, actor, Math.floor(Date.now() / 1000))) as string[];
  return status === 'ok' ? {from: Number(previous), to: Number(target)} : null;
}

/** The version the tenant's readers are served; null before the first promotion. */
export async function liveVersion(tenant: string, name: string): Promise<number | null> {
  const raw = await redis.get(liveKey(tenant, name));
  return raw === null ? null : Number(raw);
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"

	"prompts/config" // config.LiveKey, config.HistoryKey, config.AuditKey, config.VersionKey — provided
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const cacheTTL = 300 * time.Second

type cachedLive struct {
	version int
	until   time.Time
}

var liveCache = map[string]cachedLive{}

// Swap is a move of the live pointer: the version that was live (0 for none) and the one that is.
type Swap struct {
	From int
	To   int
}

// promote makes version live for the tenant's readers; nil when it is not registered.
func promote(ctx context.Context, tenant, name string, version int, actor string) (*Swap, error) {
	// TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
	previous, err := rdb.Get(ctx, config.LiveKey(tenant, name)).Int()
	if err != nil && !errors.Is(err, redis.Nil) {
		return nil, err
	}
	if err := rdb.Set(ctx, config.LiveKey(tenant, name), version, 0).Err(); err != nil {
		return nil, err
	}
	if err := rdb.RPush(ctx, config.HistoryKey(tenant, name), version).Err(); err != nil {
		return nil, err
	}
	entry := fmt.Sprintf("promote|%d|%d|%s|%d", previous, version, actor, time.Now().Unix())
	if err := rdb.RPush(ctx, config.AuditKey(tenant, name), entry).Err(); err != nil {
		return nil, err
	}
	return &Swap{From: previous, To: version}, nil
}

// rollback puts back the version that was live before this one; nil when there is none.
func rollback(ctx context.Context, tenant, name, actor string) (*Swap, error) {
	current, err := rdb.Get(ctx, config.LiveKey(tenant, name)).Int()
	if err != nil && !errors.Is(err, redis.Nil) {
		return nil, err
	}
	target := current - 1
	if target < 1 {
		return nil, nil
	}
	if err := rdb.Set(ctx, config.LiveKey(tenant, name), target, 0).Err(); err != nil {
		return nil, err
	}
	entry := fmt.Sprintf("rollback|%d|%d|%s|%d", current, target, actor, time.Now().Unix())
	if err := rdb.RPush(ctx, config.AuditKey(tenant, name), entry).Err(); err != nil {
		return nil, err
	}
	return &Swap{From: current, To: target}, nil
}

// liveVersion is the version the tenant's readers are served; 0 before the first promotion.
func liveVersion(ctx context.Context, tenant, name string) (int, error) {
	key := config.LiveKey(tenant, name)
	if cached, ok := liveCache[key]; ok && cached.until.After(time.Now()) {
		return cached.version, nil
	}
	version, err := rdb.Get(ctx, key).Int()
	if err != nil && !errors.Is(err, redis.Nil) {
		return 0, err
	}
	liveCache[key] = cachedLive{version: version, until: time.Now().Add(cacheTTL)}
	return version, nil
}
`,
      solution: `package main

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"

	"prompts/config" // config.LiveKey, config.HistoryKey, config.AuditKey, config.VersionKey — provided
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// KEYS: live, history, audit, version. ARGV: version, actor, now.
var promoteScript = redis.NewScript(\`
if redis.call('EXISTS', KEYS[4]) == 0 then
  return {'unregistered', ''}
end
local from = redis.call('GET', KEYS[1]) or '0'
if from == ARGV[1] then
  return {'ok', from}
end
redis.call('SET', KEYS[1], ARGV[1])
redis.call('RPUSH', KEYS[2], ARGV[1])
redis.call('RPUSH', KEYS[3], 'promote|' .. from .. '|' .. ARGV[1] .. '|' .. ARGV[2] .. '|' .. ARGV[3])
return {'ok', from}
\`)

// KEYS: live, history, audit. ARGV: actor, now.
var rollbackScript = redis.NewScript(\`
if redis.call('LLEN', KEYS[2]) < 2 then
  return {'empty', '', ''}
end
local from = redis.call('RPOP', KEYS[2])
local to = redis.call('LINDEX', KEYS[2], -1)
redis.call('SET', KEYS[1], to)
redis.call('RPUSH', KEYS[3], 'rollback|' .. from .. '|' .. to .. '|' .. ARGV[1] .. '|' .. ARGV[2])
return {'ok', from, to}
\`)

// Swap is a move of the live pointer: the version that was live (0 for none) and the one that is.
type Swap struct {
	From int
	To   int
}

// promote makes version live for the tenant's readers; nil when it is not registered.
func promote(ctx context.Context, tenant, name string, version int, actor string) (*Swap, error) {
	keys := []string{config.LiveKey(tenant, name), config.HistoryKey(tenant, name), config.AuditKey(tenant, name), config.VersionKey(tenant, name, version)}
	reply, err := promoteScript.Run(ctx, rdb, keys, version, actor, time.Now().Unix()).Slice()
	if err != nil {
		return nil, err
	}
	if fmt.Sprint(reply[0]) != "ok" {
		return nil, nil
	}
	previous, _ := strconv.Atoi(fmt.Sprint(reply[1]))
	return &Swap{From: previous, To: version}, nil
}

// rollback puts back the version that was live before this one; nil when there is none.
func rollback(ctx context.Context, tenant, name, actor string) (*Swap, error) {
	keys := []string{config.LiveKey(tenant, name), config.HistoryKey(tenant, name), config.AuditKey(tenant, name)}
	reply, err := rollbackScript.Run(ctx, rdb, keys, actor, time.Now().Unix()).Slice()
	if err != nil {
		return nil, err
	}
	if fmt.Sprint(reply[0]) != "ok" {
		return nil, nil
	}
	previous, _ := strconv.Atoi(fmt.Sprint(reply[1]))
	target, _ := strconv.Atoi(fmt.Sprint(reply[2]))
	return &Swap{From: previous, To: target}, nil
}

// liveVersion is the version the tenant's readers are served; 0 before the first promotion.
func liveVersion(ctx context.Context, tenant, name string) (int, error) {
	version, err := rdb.Get(ctx, config.LiveKey(tenant, name)).Int()
	if errors.Is(err, redis.Nil) {
		return 0, nil
	}
	return version, err
}
`,
    },
    scala: {
      starter: `import redis.clients.jedis.JedisPooled

import scala.collection.mutable

import prompts.Config

/** A move of the live pointer: the version that was live (0 for none) and the one that is. */
final case class Swap(from: Int, to: Int)

object LivePointer {
  val jedis = new JedisPooled("redis", 6379)

  val CacheTtlSeconds = 300L
  private val liveCache = mutable.Map[String, (Option[Int], Long)]()

  private def now: Long = System.currentTimeMillis() / 1000

  /** Make version live for the tenant's readers; None when it is not registered. */
  def promote(tenant: String, name: String, version: Int, actor: String): Option[Swap] = {
    // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
    val previous = Option(jedis.get(Config.liveKey(tenant, name))).map(_.toInt).getOrElse(0)
    jedis.set(Config.liveKey(tenant, name), version.toString)
    jedis.rpush(Config.historyKey(tenant, name), version.toString)
    jedis.rpush(Config.auditKey(tenant, name), s"promote|$previous|$version|$actor|$now")
    Some(Swap(previous, version))
  }

  /** Put back the version that was live before this one; None when there is none. */
  def rollback(tenant: String, name: String, actor: String): Option[Swap] = {
    val current = Option(jedis.get(Config.liveKey(tenant, name))).map(_.toInt).getOrElse(0)
    val target = current - 1
    if (target < 1) None
    else {
      jedis.set(Config.liveKey(tenant, name), target.toString)
      jedis.rpush(Config.auditKey(tenant, name), s"rollback|$current|$target|$actor|$now")
      Some(Swap(current, target))
    }
  }

  /** The version the tenant's readers are served; None before the first promotion. */
  def liveVersion(tenant: String, name: String): Option[Int] = {
    val key = Config.liveKey(tenant, name)
    liveCache.get(key) match {
      case Some((version, until)) if until > System.currentTimeMillis() => version
      case _ =>
        val version = Option(jedis.get(key)).map(_.toInt)
        liveCache(key) = (version, System.currentTimeMillis() + CacheTtlSeconds * 1000)
        version
    }
  }
}
`,
      solution: `import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

import prompts.Config

/** A move of the live pointer: the version that was live (0 for none) and the one that is. */
final case class Swap(from: Int, to: Int)

object LivePointer {
  val jedis = new JedisPooled("redis", 6379)

  // KEYS: live, history, audit, version. ARGV: version, actor, now.
  val Promote: String =
    """if redis.call('EXISTS', KEYS[4]) == 0 then
      |  return {'unregistered', ''}
      |end
      |local from = redis.call('GET', KEYS[1]) or '0'
      |if from == ARGV[1] then
      |  return {'ok', from}
      |end
      |redis.call('SET', KEYS[1], ARGV[1])
      |redis.call('RPUSH', KEYS[2], ARGV[1])
      |redis.call('RPUSH', KEYS[3], 'promote|' .. from .. '|' .. ARGV[1] .. '|' .. ARGV[2] .. '|' .. ARGV[3])
      |return {'ok', from}
      |""".stripMargin

  // KEYS: live, history, audit. ARGV: actor, now.
  val Rollback: String =
    """if redis.call('LLEN', KEYS[2]) < 2 then
      |  return {'empty', '', ''}
      |end
      |local from = redis.call('RPOP', KEYS[2])
      |local to = redis.call('LINDEX', KEYS[2], -1)
      |redis.call('SET', KEYS[1], to)
      |redis.call('RPUSH', KEYS[3], 'rollback|' .. from .. '|' .. to .. '|' .. ARGV[1] .. '|' .. ARGV[2])
      |return {'ok', from, to}
      |""".stripMargin

  private def now: String = (System.currentTimeMillis() / 1000).toString

  private def run(script: String, keys: List[String], args: List[String]): List[String] =
    jedis.eval(script, keys.asJava, args.asJava).asInstanceOf[java.util.List[AnyRef]].asScala.toList.map(_.toString)

  /** Make version live for the tenant's readers; None when it is not registered. */
  def promote(tenant: String, name: String, version: Int, actor: String): Option[Swap] = {
    val keys = List(Config.liveKey(tenant, name), Config.historyKey(tenant, name), Config.auditKey(tenant, name), Config.versionKey(tenant, name, version))
    run(Promote, keys, List(version.toString, actor, now)) match {
      case "ok" :: previous :: _ => Some(Swap(previous.toInt, version))
      case _ => None
    }
  }

  /** Put back the version that was live before this one; None when there is none. */
  def rollback(tenant: String, name: String, actor: String): Option[Swap] = {
    val keys = List(Config.liveKey(tenant, name), Config.historyKey(tenant, name), Config.auditKey(tenant, name))
    run(Rollback, keys, List(actor, now)) match {
      case "ok" :: previous :: target :: _ => Some(Swap(previous.toInt, target.toInt))
      case _ => None
    }
  }

  /** The version the tenant's readers are served; None before the first promotion. */
  def liveVersion(tenant: String, name: String): Option[Int] = Option(jedis.get(Config.liveKey(tenant, name))).map(_.toInt)
}
`,
    },
    cpp: {
      starter: `#include <sw/redis++/redis++.h>

#include <chrono>
#include <map>
#include <optional>
#include <string>
#include <utility>

#include "prompts/config.h"  // config::live_key, config::history_key, config::audit_key, config::version_key — provided

sw::redis::Redis redis("tcp://redis:6379");

constexpr std::chrono::seconds kCacheTtl{300};
std::map<std::string, std::pair<std::optional<int>, std::chrono::steady_clock::time_point>> live_cache;

// A move of the live pointer: the version that was live (0 for none) and the one that is.
struct Swap {
  int from = 0;
  int to = 0;
};

std::string now_s() {
  return std::to_string(std::chrono::duration_cast<std::chrono::seconds>(std::chrono::system_clock::now().time_since_epoch()).count());
}

// Make version live for the tenant's readers; nullopt when it is not registered.
std::optional<Swap> promote(const std::string& tenant, const std::string& name, int version, const std::string& actor) {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  const auto raw = redis.get(config::live_key(tenant, name));
  const int previous = raw ? std::stoi(*raw) : 0;
  redis.set(config::live_key(tenant, name), std::to_string(version));
  redis.rpush(config::history_key(tenant, name), std::to_string(version));
  redis.rpush(config::audit_key(tenant, name), "promote|" + std::to_string(previous) + "|" + std::to_string(version) + "|" + actor + "|" + now_s());
  return Swap{previous, version};
}

// Put back the version that was live before this one; nullopt when there is none.
std::optional<Swap> rollback(const std::string& tenant, const std::string& name, const std::string& actor) {
  const auto raw = redis.get(config::live_key(tenant, name));
  const int current = raw ? std::stoi(*raw) : 0;
  const int target = current - 1;
  if (target < 1) return std::nullopt;
  redis.set(config::live_key(tenant, name), std::to_string(target));
  redis.rpush(config::audit_key(tenant, name), "rollback|" + std::to_string(current) + "|" + std::to_string(target) + "|" + actor + "|" + now_s());
  return Swap{current, target};
}

// The version the tenant's readers are served; nullopt before the first promotion.
std::optional<int> live_version(const std::string& tenant, const std::string& name) {
  const std::string key = config::live_key(tenant, name);
  const auto cached = live_cache.find(key);
  if (cached != live_cache.end() && cached->second.second > std::chrono::steady_clock::now()) return cached->second.first;
  const auto raw = redis.get(key);
  const std::optional<int> version = raw ? std::optional<int>(std::stoi(*raw)) : std::nullopt;
  live_cache[key] = {version, std::chrono::steady_clock::now() + kCacheTtl};
  return version;
}
`,
      solution: `#include <sw/redis++/redis++.h>

#include <chrono>
#include <optional>
#include <string>
#include <tuple>

#include "prompts/config.h"  // config::live_key, config::history_key, config::audit_key, config::version_key — provided

sw::redis::Redis redis("tcp://redis:6379");

// KEYS: live, history, audit, version. ARGV: version, actor, now.
const std::string kPromote = R"lua(
if redis.call('EXISTS', KEYS[4]) == 0 then
  return {'unregistered', ''}
end
local from = redis.call('GET', KEYS[1]) or '0'
if from == ARGV[1] then
  return {'ok', from}
end
redis.call('SET', KEYS[1], ARGV[1])
redis.call('RPUSH', KEYS[2], ARGV[1])
redis.call('RPUSH', KEYS[3], 'promote|' .. from .. '|' .. ARGV[1] .. '|' .. ARGV[2] .. '|' .. ARGV[3])
return {'ok', from}
)lua";

// KEYS: live, history, audit. ARGV: actor, now.
const std::string kRollback = R"lua(
if redis.call('LLEN', KEYS[2]) < 2 then
  return {'empty', '', ''}
end
local from = redis.call('RPOP', KEYS[2])
local to = redis.call('LINDEX', KEYS[2], -1)
redis.call('SET', KEYS[1], to)
redis.call('RPUSH', KEYS[3], 'rollback|' .. from .. '|' .. to .. '|' .. ARGV[1] .. '|' .. ARGV[2])
return {'ok', from, to}
)lua";

// A move of the live pointer: the version that was live (0 for none) and the one that is.
struct Swap {
  int from = 0;
  int to = 0;
};

std::string now_s() {
  return std::to_string(std::chrono::duration_cast<std::chrono::seconds>(std::chrono::system_clock::now().time_since_epoch()).count());
}

// Make version live for the tenant's readers; nullopt when it is not registered.
std::optional<Swap> promote(const std::string& tenant, const std::string& name, int version, const std::string& actor) {
  const auto [status, previous] = redis.eval<std::string, std::string>(
      kPromote,
      {config::live_key(tenant, name), config::history_key(tenant, name), config::audit_key(tenant, name), config::version_key(tenant, name, version)},
      {std::to_string(version), actor, now_s()});
  if (status != "ok") return std::nullopt;
  return Swap{std::stoi(previous), version};
}

// Put back the version that was live before this one; nullopt when there is none.
std::optional<Swap> rollback(const std::string& tenant, const std::string& name, const std::string& actor) {
  const auto [status, previous, target] = redis.eval<std::string, std::string, std::string>(
      kRollback, {config::live_key(tenant, name), config::history_key(tenant, name), config::audit_key(tenant, name)}, {actor, now_s()});
  if (status != "ok") return std::nullopt;
  return Swap{std::stoi(previous), std::stoi(target)};
}

// The version the tenant's readers are served; nullopt before the first promotion.
std::optional<int> live_version(const std::string& tenant, const std::string& name) {
  const auto raw = redis.get(config::live_key(tenant, name));
  if (!raw) return std::nullopt;
  return std::stoi(*raw);
}
`,
    },
  },
  harness: {
    python: `import json

T, N = "t1", "support-reply"
LIVE = f"prompts:live:{T}:{N}"
HISTORY = f"prompts:history:{T}:{N}"
AUDIT = f"prompts:audit:{T}:{N}"


def _register(ctx, *versions):
    for v in versions:
        record = {"name": N, "version": v, "content_hash": f"h{v}", "template": f"text {v}", "variables": []}
        ctx.redis.set(f"prompts:version:{T}:{N}:{v}", json.dumps(record))


def _audit(ctx):
    return [entry.split("|") for entry in ctx.redis.lrange(AUDIT, 0, -1)]


def check_atomic_promote(ctx):
    m = ctx.load("state")
    _register(ctx, 1, 4, 5)
    assert m.promote(T, N, 1, "alice") is not None, "promoting registered version 1 returned None"

    def other_operator():
        # another operator promotes version 5 with one atomic script, between two of this promotion's commands
        previous = ctx.redis.get(LIVE) or "0"
        ctx.redis.set(LIVE, "5")
        ctx.redis.rpush(HISTORY, "5")
        ctx.redis.rpush(AUDIT, f"promote|{previous}|5|bob|0")

    probe = ctx.redis_after(LIVE, other_operator)
    m.promote(T, N, 4, "alice")
    assert probe.fired, "promote never touched the live pointer"
    entries = _audit(ctx)
    for before, after in zip(entries, entries[1:]):
        assert after[1] == before[2], f"the audit says {before[0]} {before[1]} to {before[2]}, then {after[0]} from {after[1]}: another promotion landed between two of this one's commands, and the audit no longer describes what happened ({ctx.redis.lrange(AUDIT, 0, -1)})"
    live = ctx.redis.get(LIVE)
    assert entries[-1][2] == live, f"the last audit entry moved to {entries[-1][2]} but version {live} is live"
    assert ctx.redis.lindex(HISTORY, -1) == live, f"the history ends at {ctx.redis.lindex(HISTORY, -1)} but version {live} is live: a rollback would restore the wrong version"


def check_registered_only(ctx):
    m = ctx.load("state")
    _register(ctx, 1)
    m.promote(T, N, 1, "alice")
    before = (ctx.redis.get(LIVE), ctx.redis.lrange(HISTORY, 0, -1), ctx.redis.lrange(AUDIT, 0, -1))
    result = m.promote(T, N, 9, "alice")
    assert result is None, f"promoting version 9, which was never registered, returned {result}, expected None"
    after = (ctx.redis.get(LIVE), ctx.redis.lrange(HISTORY, 0, -1), ctx.redis.lrange(AUDIT, 0, -1))
    assert after == before, f"promoting an unregistered version changed the pointer (live, history, audit) from {before} to {after}: every read of the prompt now fails"
    _register(ctx, 9)
    result = m.promote(T, N, 9, "alice")
    assert result == {"from": 1, "to": 9} and ctx.redis.get(LIVE) == "9", f"once registered, version 9 promotes from 1: got {result}, live {ctx.redis.get(LIVE)}"


def check_rollback_previous(ctx):
    m = ctx.load("state")
    _register(ctx, 1, 4, 7)
    for v in (1, 4, 7):
        m.promote(T, N, v, "alice")
    swap = m.rollback(T, N, "oncall")
    assert ctx.redis.get(LIVE) == "4", f"rolling back from 7 put version {ctx.redis.get(LIVE)} live, expected 4, the version live before 7 (6 was never promoted)"
    assert swap == {"from": 7, "to": 4}, f"the rollback must answer from 7 to 4, got {swap}"
    m.rollback(T, N, "oncall")
    assert ctx.redis.get(LIVE) == "1", f"a second rollback must restore 1, the version live before 4, got {ctx.redis.get(LIVE)}"
    third = m.rollback(T, N, "oncall")
    assert third is None and ctx.redis.get(LIVE) == "1", f"with nothing earlier a rollback returns None and leaves 1 live: got {third}, live {ctx.redis.get(LIVE)}"
    tail = [e.split("|")[:4] for e in ctx.redis.lrange(AUDIT, -2, -1)]
    assert tail == [["rollback", "7", "4", "oncall"], ["rollback", "4", "1", "oncall"]], f"each rollback is audited as rollback|from|to|actor: {ctx.redis.lrange(AUDIT, 0, -1)}"


def check_live_uncached(ctx):
    m = ctx.load("state")
    assert m.live_version(T, "never-promoted") is None, "before any promotion live_version is None"
    _register(ctx, 1, 4)
    m.promote(T, N, 1, "alice")
    m.promote(T, N, 4, "alice")
    assert m.live_version(T, N) == 4, f"after promoting 4 the reader must see 4, got {m.live_version(T, N)}"
    # another replica rolls back to 1
    ctx.redis.set(LIVE, "1")
    ctx.redis.rpop(HISTORY)
    ctx.redis.rpush(AUDIT, "rollback|4|1|oncall|0")
    seen = m.live_version(T, N)
    assert seen == 1, f"the next read after a rollback served version {seen}, expected 1: a cached pointer keeps the bad version live for minutes on every replica"
`,
    typescript: `const T = 't1';
const N = 'support-reply';
const LIVE = \`prompts:live:\${T}:\${N}\`;
const HISTORY = \`prompts:history:\${T}:\${N}\`;
const AUDIT = \`prompts:audit:\${T}:\${N}\`;

function register(ctx, ...versions: number[]) {
  for (const v of versions) {
    const record = {name: N, version: v, content_hash: \`h\${v}\`, template: \`text \${v}\`, variables: []};
    ctx.redis.set(\`prompts:version:\${T}:\${N}:\${v}\`, JSON.stringify(record));
  }
}

const audit = (ctx): string[][] => (ctx.redis.lrange(AUDIT, 0, -1) as string[]).map(entry => entry.split('|'));

export async function check_atomic_promote(ctx) {
  const m = ctx.load('state');
  register(ctx, 1, 4, 5);
  assert((await m.promote(T, N, 1, 'alice')) !== null, 'promoting registered version 1 returned null');
  // another operator promotes version 5 with one atomic script, between two of this promotion's commands
  const probe = ctx.redisAfter(LIVE, () => {
    const previous = ctx.redis.get(LIVE) ?? '0';
    ctx.redis.set(LIVE, '5');
    ctx.redis.rpush(HISTORY, '5');
    ctx.redis.rpush(AUDIT, \`promote|\${previous}|5|bob|0\`);
  });
  await m.promote(T, N, 4, 'alice');
  assert(probe.fired, 'promote never touched the live pointer');
  const entries = audit(ctx);
  for (let i = 1; i < entries.length; i++) {
    const [before, after] = [entries[i - 1], entries[i]];
    assert.equal(after[1], before[2], \`the audit says \${before[0]} \${before[1]} to \${before[2]}, then \${after[0]} from \${after[1]}: another promotion landed between two of this one's commands, and the audit no longer describes what happened (\${JSON.stringify(ctx.redis.lrange(AUDIT, 0, -1))})\`);
  }
  const live = ctx.redis.get(LIVE);
  assert.equal(entries[entries.length - 1][2], live, \`the last audit entry moved to \${entries[entries.length - 1][2]} but version \${live} is live\`);
  assert.equal(ctx.redis.lindex(HISTORY, -1), live, \`the history ends at \${ctx.redis.lindex(HISTORY, -1)} but version \${live} is live: a rollback would restore the wrong version\`);
}

export async function check_registered_only(ctx) {
  const m = ctx.load('state');
  register(ctx, 1);
  await m.promote(T, N, 1, 'alice');
  const snapshot = () => JSON.stringify([ctx.redis.get(LIVE), ctx.redis.lrange(HISTORY, 0, -1), ctx.redis.lrange(AUDIT, 0, -1)]);
  const before = snapshot();
  const result = await m.promote(T, N, 9, 'alice');
  assert.equal(result, null, \`promoting version 9, which was never registered, returned \${JSON.stringify(result)}, expected null\`);
  assert.equal(snapshot(), before, \`promoting an unregistered version changed the pointer (live, history, audit) from \${before} to \${snapshot()}: every read of the prompt now fails\`);
  register(ctx, 9);
  const again = await m.promote(T, N, 9, 'alice');
  assert(again?.from === 1 && again?.to === 9 && ctx.redis.get(LIVE) === '9', \`once registered, version 9 promotes from 1: got \${JSON.stringify(again)}, live \${ctx.redis.get(LIVE)}\`);
}

export async function check_rollback_previous(ctx) {
  const m = ctx.load('state');
  register(ctx, 1, 4, 7);
  for (const v of [1, 4, 7]) await m.promote(T, N, v, 'alice');
  const swap = await m.rollback(T, N, 'oncall');
  assert.equal(ctx.redis.get(LIVE), '4', \`rolling back from 7 put version \${ctx.redis.get(LIVE)} live, expected 4, the version live before 7 (6 was never promoted)\`);
  assert(swap?.from === 7 && swap?.to === 4, \`the rollback must answer from 7 to 4, got \${JSON.stringify(swap)}\`);
  await m.rollback(T, N, 'oncall');
  assert.equal(ctx.redis.get(LIVE), '1', \`a second rollback must restore 1, the version live before 4, got \${ctx.redis.get(LIVE)}\`);
  const third = await m.rollback(T, N, 'oncall');
  assert(third === null && ctx.redis.get(LIVE) === '1', \`with nothing earlier a rollback returns null and leaves 1 live: got \${JSON.stringify(third)}, live \${ctx.redis.get(LIVE)}\`);
  const tail = (ctx.redis.lrange(AUDIT, -2, -1) as string[]).map(e => e.split('|').slice(0, 4));
  assert.deepEqual(tail, [['rollback', '7', '4', 'oncall'], ['rollback', '4', '1', 'oncall']], \`each rollback is audited as rollback|from|to|actor: \${JSON.stringify(ctx.redis.lrange(AUDIT, 0, -1))}\`);
}

export async function check_live_uncached(ctx) {
  const m = ctx.load('state');
  assert.equal(await m.liveVersion(T, 'never-promoted'), null, 'before any promotion liveVersion is null');
  register(ctx, 1, 4);
  await m.promote(T, N, 1, 'alice');
  await m.promote(T, N, 4, 'alice');
  assert.equal(await m.liveVersion(T, N), 4, 'after promoting 4 the reader must see 4');
  // another replica rolls back to 1
  ctx.redis.set(LIVE, '1');
  ctx.redis.rpop(HISTORY);
  ctx.redis.rpush(AUDIT, 'rollback|4|1|oncall|0');
  const seen = await m.liveVersion(T, N);
  assert.equal(seen, 1, \`the next read after a rollback served version \${seen}, expected 1: a cached pointer keeps the bad version live for minutes on every replica\`);
}
`,
    go: `package main

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"prompts/config"

	"leetbuild/harness"
)

const (
	stateTenant = "t1"
	stateName   = "support-reply"
)

var (
	stateLive    = config.LiveKey(stateTenant, stateName)
	stateHistory = config.HistoryKey(stateTenant, stateName)
	stateAudit   = config.AuditKey(stateTenant, stateName)
)

func stateRegister(ctx *harness.Ctx, versions ...int) {
	for _, v := range versions {
		record, _ := json.Marshal(map[string]any{"name": stateName, "version": v, "content_hash": fmt.Sprintf("h%d", v), "template": fmt.Sprintf("text %d", v), "variables": []string{}})
		ctx.Redis.Set(config.VersionKey(stateTenant, stateName, v), string(record))
	}
}

func statePromote(ctx *harness.Ctx, version int) *Swap {
	swap, err := promote(context.Background(), stateTenant, stateName, version, "alice")
	ctx.NoError(err, "promote(%d)", version)
	return swap
}

func stateRollback(ctx *harness.Ctx) *Swap {
	swap, err := rollback(context.Background(), stateTenant, stateName, "oncall")
	ctx.NoError(err, "rollback")
	return swap
}

func stateLiveNow(ctx *harness.Ctx) string {
	live, _ := ctx.Redis.Get(stateLive)
	return live
}

func stateAuditEntries(ctx *harness.Ctx) [][]string {
	var out [][]string
	for _, entry := range ctx.Redis.LRange(stateAudit, 0, -1) {
		out = append(out, strings.Split(entry, "|"))
	}
	return out
}

func stateSnapshot(ctx *harness.Ctx) string {
	return fmt.Sprint(stateLiveNow(ctx), ctx.Redis.LRange(stateHistory, 0, -1), ctx.Redis.LRange(stateAudit, 0, -1))
}

func CheckAtomicPromote(ctx *harness.Ctx) {
	stateRegister(ctx, 1, 4, 5)
	ctx.Assert(statePromote(ctx, 1) != nil, "promoting registered version 1 returned nil")
	fired := false
	// another operator promotes version 5 with one atomic script, between two of this promotion's commands
	ctx.Redis.After(stateLive, func() any {
		fired = true
		previous, ok := ctx.Redis.Get(stateLive)
		if !ok {
			previous = "0"
		}
		ctx.Redis.Set(stateLive, "5")
		ctx.Redis.Do("RPUSH", stateHistory, "5")
		ctx.Redis.Do("RPUSH", stateAudit, "promote|"+previous+"|5|bob|0")
		return nil
	})
	statePromote(ctx, 4)
	ctx.Assert(fired, "promote never touched the live pointer")
	entries := stateAuditEntries(ctx)
	for i := 1; i < len(entries); i++ {
		before, after := entries[i-1], entries[i]
		ctx.Assert(after[1] == before[2], "the audit says %s %s to %s, then %s from %s: another promotion landed between two of this one's commands, and the audit no longer describes what happened (%v)", before[0], before[1], before[2], after[0], after[1], ctx.Redis.LRange(stateAudit, 0, -1))
	}
	live := stateLiveNow(ctx)
	ctx.Equal(entries[len(entries)-1][2], live, "the last audit entry's version against the live one")
	history := ctx.Redis.LRange(stateHistory, -1, -1)
	ctx.Assert(len(history) == 1 && history[0] == live, "the history ends at %v but version %s is live: a rollback would restore the wrong version", history, live)
}

func CheckRegisteredOnly(ctx *harness.Ctx) {
	stateRegister(ctx, 1)
	statePromote(ctx, 1)
	before := stateSnapshot(ctx)
	result := statePromote(ctx, 9)
	ctx.Assert(result == nil, "promoting version 9, which was never registered, returned %+v, expected nil", result)
	ctx.Equal(stateSnapshot(ctx), before, "promoting an unregistered version must leave the pointer (live, history, audit) as it was, or every read of the prompt fails")
	stateRegister(ctx, 9)
	result = statePromote(ctx, 9)
	ctx.Assert(result != nil && result.From == 1 && result.To == 9 && stateLiveNow(ctx) == "9", "once registered, version 9 promotes from 1: got %+v, live %s", result, stateLiveNow(ctx))
}

func CheckRollbackPrevious(ctx *harness.Ctx) {
	stateRegister(ctx, 1, 4, 7)
	for _, v := range []int{1, 4, 7} {
		statePromote(ctx, v)
	}
	swap := stateRollback(ctx)
	ctx.Equal(stateLiveNow(ctx), "4", "rolling back from 7 must put 4 live, the version live before 7 (6 was never promoted); the live version")
	ctx.Assert(swap != nil && swap.From == 7 && swap.To == 4, "the rollback must answer from 7 to 4, got %+v", swap)
	stateRollback(ctx)
	ctx.Equal(stateLiveNow(ctx), "1", "a second rollback must restore 1, the version live before 4; the live version")
	third := stateRollback(ctx)
	ctx.Assert(third == nil && stateLiveNow(ctx) == "1", "with nothing earlier a rollback returns nil and leaves 1 live: got %+v, live %s", third, stateLiveNow(ctx))
	tail := ctx.Redis.LRange(stateAudit, -2, -1)
	ctx.Assert(len(tail) == 2 && strings.HasPrefix(tail[0], "rollback|7|4|oncall|") && strings.HasPrefix(tail[1], "rollback|4|1|oncall|"), "each rollback is audited as rollback|from|to|actor: %v", ctx.Redis.LRange(stateAudit, 0, -1))
}

func CheckLiveUncached(ctx *harness.Ctx) {
	none, err := liveVersion(context.Background(), stateTenant, "never-promoted")
	ctx.NoError(err, "liveVersion")
	ctx.Equal(none, 0, "before any promotion liveVersion is 0")
	stateRegister(ctx, 1, 4)
	statePromote(ctx, 1)
	statePromote(ctx, 4)
	seen, err := liveVersion(context.Background(), stateTenant, stateName)
	ctx.NoError(err, "liveVersion")
	ctx.Equal(seen, 4, "after promoting 4 the reader must see 4")
	// another replica rolls back to 1
	ctx.Redis.Set(stateLive, "1")
	ctx.Redis.Do("RPOP", stateHistory)
	ctx.Redis.Do("RPUSH", stateAudit, "rollback|4|1|oncall|0")
	seen, err = liveVersion(context.Background(), stateTenant, stateName)
	ctx.NoError(err, "liveVersion")
	ctx.Equal(seen, 1, "the next read after a rollback: a cached pointer keeps the bad version live for minutes on every replica; the version served")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <sstream>
#include <string>
#include <vector>

namespace {

const std::string kT = "t1";
const std::string kN = "support-reply";
const std::string kLive = "prompts:live:" + kT + ":" + kN;
const std::string kHistory = "prompts:history:" + kT + ":" + kN;
const std::string kAudit = "prompts:audit:" + kT + ":" + kN;

void stateRegister(harness::Ctx& ctx, std::initializer_list<int> versions) {
  for (int v : versions) {
    const nlohmann::json record = {{"name", kN}, {"version", v}, {"content_hash", "h" + std::to_string(v)}, {"template", "text " + std::to_string(v)}, {"variables", nlohmann::json::array()}};
    ctx.Redis.Set("prompts:version:" + kT + ":" + kN + ":" + std::to_string(v), record.dump());
  }
}

std::string liveNow(harness::Ctx& ctx) { return ctx.Redis.Get(kLive).value_or(""); }

std::vector<std::string> split(const std::string& entry) {
  std::vector<std::string> out;
  std::stringstream in(entry);
  std::string part;
  while (std::getline(in, part, '|')) out.push_back(part);
  while (out.size() < 5) out.push_back("");
  return out;
}

std::string snapshot(harness::Ctx& ctx) {
  std::string out = liveNow(ctx) + " [";
  for (const auto& v : ctx.Redis.LRange(kHistory, 0, -1)) out += v + " ";
  out += "] [";
  for (const auto& e : ctx.Redis.LRange(kAudit, 0, -1)) out += e + " ";
  return out + "]";
}

}  // namespace

void CheckAtomicPromote(harness::Ctx& ctx) {
  stateRegister(ctx, {1, 4, 5});
  ctx.Assert(promote(kT, kN, 1, "alice").has_value(), "promoting registered version 1 returned nullopt");
  bool fired = false;
  // another operator promotes version 5 with one atomic script, between two of this promotion's commands
  ctx.Redis.After(kLive, [&] {
    fired = true;
    const std::string previous = ctx.Redis.Get(kLive).value_or("0");
    ctx.Redis.Set(kLive, "5");
    ctx.Redis.Do("RPUSH", kHistory, "5");
    ctx.Redis.Do("RPUSH", kAudit, "promote|" + previous + "|5|bob|0");
  });
  promote(kT, kN, 4, "alice");
  ctx.Assert(fired, "promote never touched the live pointer");
  const auto raw = ctx.Redis.LRange(kAudit, 0, -1);
  for (size_t i = 1; i < raw.size(); i++) {
    const auto before = split(raw[i - 1]);
    const auto after = split(raw[i]);
    ctx.Assert(after[1] == before[2], "the audit says %s %s to %s, then %s from %s: another promotion landed between two of this one's commands, and the audit no longer describes what happened (%v)",
               before[0], before[1], before[2], after[0], after[1], raw);
  }
  const std::string live = liveNow(ctx);
  ctx.Equal(split(raw.back())[2], live, "the last audit entry's version against the live one");
  const auto history = ctx.Redis.LRange(kHistory, -1, -1);
  ctx.Assert(history.size() == 1 && history[0] == live, "the history ends at %v but version %s is live: a rollback would restore the wrong version", history, live);
}

void CheckRegisteredOnly(harness::Ctx& ctx) {
  stateRegister(ctx, {1});
  promote(kT, kN, 1, "alice");
  const std::string before = snapshot(ctx);
  auto result = promote(kT, kN, 9, "alice");
  ctx.Assert(!result.has_value(), "promoting version 9, which was never registered, returned a swap, expected nullopt");
  ctx.Equal(snapshot(ctx), before, "promoting an unregistered version must leave the pointer (live, history, audit) as it was, or every read of the prompt fails");
  stateRegister(ctx, {9});
  result = promote(kT, kN, 9, "alice");
  ctx.Assert(result && result->from == 1 && result->to == 9 && liveNow(ctx) == "9", "once registered, version 9 promotes from 1: live %s", liveNow(ctx));
}

void CheckRollbackPrevious(harness::Ctx& ctx) {
  stateRegister(ctx, {1, 4, 7});
  for (int v : {1, 4, 7}) promote(kT, kN, v, "alice");
  const auto swap = rollback(kT, kN, "oncall");
  ctx.Equal(liveNow(ctx), "4", "rolling back from 7 must put 4 live, the version live before 7 (6 was never promoted); the live version");
  ctx.Assert(swap && swap->from == 7 && swap->to == 4, "the rollback must answer from 7 to 4");
  rollback(kT, kN, "oncall");
  ctx.Equal(liveNow(ctx), "1", "a second rollback must restore 1, the version live before 4; the live version");
  const auto third = rollback(kT, kN, "oncall");
  ctx.Assert(!third && liveNow(ctx) == "1", "with nothing earlier a rollback returns nullopt and leaves 1 live: live %s", liveNow(ctx));
  const auto tail = ctx.Redis.LRange(kAudit, -2, -1);
  ctx.Assert(tail.size() == 2 && tail[0].rfind("rollback|7|4|oncall|", 0) == 0 && tail[1].rfind("rollback|4|1|oncall|", 0) == 0,
             "each rollback is audited as rollback|from|to|actor: %v", ctx.Redis.LRange(kAudit, 0, -1));
}

void CheckLiveUncached(harness::Ctx& ctx) {
  ctx.Assert(!live_version(kT, "never-promoted").has_value(), "before any promotion live_version is nullopt");
  stateRegister(ctx, {1, 4});
  promote(kT, kN, 1, "alice");
  promote(kT, kN, 4, "alice");
  ctx.Equal(live_version(kT, kN).value_or(0), 4, "after promoting 4 the reader must see 4");
  // another replica rolls back to 1
  ctx.Redis.Set(kLive, "1");
  ctx.Redis.Do("RPOP", kHistory);
  ctx.Redis.Do("RPUSH", kAudit, "rollback|4|1|oncall|0");
  ctx.Equal(live_version(kT, kN).value_or(0), 1, "the next read after a rollback: a cached pointer keeps the bad version live for minutes on every replica; the version served");
}
`,
  },
  hints: [
    'Symptom: two operators promote at once and the audit no longer adds up, a typo puts version 9 live and every read fails, a rollback from 7 lands on 6, which never shipped, and replicas serve the old version for minutes.',
    'Mechanism: `promote` is a GET, a SET and two RPUSHes from the client, so another promotion lands between them; nothing checks `version_key`; `rollback` computes `current - 1` instead of reading the history; `live_version` caches a pointer that moves.',
    'Change: one Lua script per move. promote: EXISTS on `version_key`, GET the old pointer, SET, RPUSH history and audit. rollback: RPOP the history, SET the new tail (LINDEX -1), RPUSH the audit. `live_version` is a plain GET.',
  ],
  debrief: `The script is the unit of truth: Redis runs it alone, so the pointer it reads is the pointer it replaces, and the audit entry it writes describes a move that happened. Rollback reads the history because "the version before" is a fact about the past, not arithmetic on version numbers: versions get skipped, abandoned and blocked by the eval gate. The reader drops its cache because the pointer is one GET, while the thing worth caching, the version record, is immutable and can be cached by its number forever. Langfuse treats a label the same way, as one update that moves \`production\` to another version. A fleet that wants to cache the pointer too would push invalidations over pub/sub, which this step leaves out.`,
};
