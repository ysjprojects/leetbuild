import type {Step} from '@/lib/types';

export const stateStep: Step = {
  id: 'state',
  title: 'Redis permission cache invalidated by a version bump',
  concept: 'redis',
  file: 'state',
  focus: ['api', 'redis', 'store'],
  task: `## Task

**Starting point.** The starter caches the effective permission set of a \`(subject, scope)\`:
\`effective_permissions(subject, scope)\` serves \`perm:{subject}:{scope}\` (a JSON list, 300 s TTL)
or derives it with \`grants.effective\` and stores it. \`grant_role\` and \`revoke_grant\` delete that
one key, then write the grant (\`grants.add\` / \`grants.revoke\`). It serves the demo and hides three
flaws.

**Failure mode the checks target.** A revoked team admin keeps \`team:write\` at the team's
projects; a read that lands between the delete and the write re-caches the old set; and a read that
was deriving when a revocation committed caches what it derived, for the rest of the TTL.

- \`perm:grant_version\` (\`VERSION_KEY\`) is the invalidation clock. \`grant_role\` and
  \`revoke_grant\` write the grant first, then \`INCR\` it. No key is deleted.
- An entry is a hash \`{permissions, version}\` under \`perm:{subject}:{scope}\` with a **300 s** TTL.
- A read takes the version **before** it derives, serves an entry only while its stamp equals that
  version, and stamps a derived set with the version it took.`,
  sequence: {
    participants: ['Permission Service', 'Redis', 'Grant store'],
    messages: [
      {from: 'Permission Service', to: 'Redis', label: 'GET perm:grant_version → 4', kind: 'sync'},
      {
        from: 'Permission Service',
        to: 'Redis',
        label: 'HGETALL perm:ada:team:eng → {permissions, version: 3}',
        kind: 'sync',
      },
      {from: 'Permission Service', to: 'Grant store', label: 'stamp 3 ≠ 4 → effective(ada, team:eng)', kind: 'sync'},
      {from: 'Permission Service', to: 'Redis', label: 'HSET {permissions, version: 4} · EXPIRE 300', kind: 'sync'},
      {from: 'Permission Service', to: 'Grant store', label: 'revoke_grant: grants.revoke(g-1)', kind: 'sync'},
      {
        from: 'Permission Service',
        to: 'Redis',
        label: 'INCR perm:grant_version → 5: every entry is stale',
        kind: 'sync',
      },
    ],
  },
  checks: [
    {
      id: 'every-scope',
      title: 'A grant change reaches every cached scope',
      detail:
        'A change bumps the shared `perm:grant_version` counter (`INCR`), which outdates every entry at once; deleting the one `perm:{subject}:{scope}` key of the changed grant leaves the entries of the scopes it covers (a team grant at its projects) serving the old set.',
      match: {
        python: {
          all: [/VERSION_KEY\s*=\s*["']perm:grant_version["']/, /\.incr\(\s*VERSION_KEY\s*\)/],
          none: [/\.delete\(\s*cache_key\(/],
        },
        typescript: {
          all: [/VERSION_KEY\s*=\s*['"]perm:grant_version['"]/, /\.incr\(\s*VERSION_KEY\s*\)/],
          none: [/\.del\(\s*cacheKey\(/],
        },
        go: {
          all: [/versionKey\s*=\s*"perm:grant_version"/, /\.Incr\(\s*ctx,\s*versionKey\s*\)/],
          none: [/\.Del\(\s*ctx,\s*cacheKey\(/],
        },
        scala: {
          all: [/VersionKey\s*=\s*"perm:grant_version"/, /\.incr\(\s*VersionKey\s*\)/],
          none: [/\.del\(\s*cacheKey\(/],
        },
        cpp: {
          all: [/kVersionKey\s*=\s*"perm:grant_version"/, /\.incr\(\s*kVersionKey\s*\)/],
          none: [/\.del\(\s*cacheKey\(/],
        },
      },
    },
    {
      id: 'after-commit',
      title: 'Invalidates after the grant store committed the change',
      detail:
        'The grant is written (`add`/`revoke`) before the cache is invalidated; the starter deletes first, so a read landing in between derives the set the change was about to remove and caches it.',
      match: {
        python: {order: [/grants\.add\(/, /\.incr\(\s*VERSION_KEY/, /grants\.revoke\(/, /\.incr\(\s*VERSION_KEY/]},
        typescript: {order: [/\badd\(/, /\.incr\(\s*VERSION_KEY/, /\brevoke\(/, /\.incr\(\s*VERSION_KEY/]},
        go: {
          order: [/grants\.Add\(/, /\.Incr\(\s*ctx,\s*versionKey/, /grants\.Revoke\(/, /\.Incr\(\s*ctx,\s*versionKey/],
        },
        scala: {order: [/Grants\.add\(/, /\.incr\(\s*VersionKey/, /Grants\.revoke\(/, /\.incr\(\s*VersionKey/]},
        cpp: {order: [/grants::add\(/, /\.incr\(\s*kVersionKey/, /grants::revoke\(/, /\.incr\(\s*kVersionKey/]},
      },
    },
    {
      id: 'stamp-before-derive',
      title: 'Stamps an entry with the version read before deriving it',
      detail:
        'The read takes `perm:grant_version` before `effective`, writes the entry with that stamp, and serves an entry only while its stamp is current; a set derived while a change committed then carries an old stamp and is recomputed on the next read.',
      match: {
        python: {order: [/\.get\(\s*VERSION_KEY/, /["']version["']\)?\s*==|==\s*version\b/, /grants\.effective\(/]},
        typescript: {
          order: [/\.get\(\s*VERSION_KEY/, /\.version\s*===\s*version|version\s*===\s*\w+\.version/, /\beffective\(/],
        },
        go: {order: [/\.Get\(\s*ctx,\s*versionKey/, /==\s*version\b/, /grants\.Effective\(/]},
        scala: {order: [/\.get\(\s*VersionKey/, /contains\(\s*version\s*\)|==\s*version\b/, /Grants\.effective\(/]},
        cpp: {order: [/\.get\(\s*kVersionKey/, /==\s*version\b/, /grants::effective\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json

import redis

from permz import grants  # effective, add, revoke, by_id

r = redis.Redis(host="redis", port=6379, decode_responses=True)

CACHE_TTL_S = 300


def cache_key(subject: str, scope: str) -> str:
    return f"perm:{subject}:{scope}"


def effective_permissions(subject: str, scope: str) -> list[str]:
    """The permissions the subject holds at scope, sorted."""
    # TODO: this starter has three flaws. The task says where to look; the checks say what must change.
    raw = r.get(cache_key(subject, scope))
    if raw is not None:
        return json.loads(raw)
    permissions = grants.effective(subject, scope)
    r.set(cache_key(subject, scope), json.dumps(permissions), ex=CACHE_TTL_S)
    return permissions


def grant_role(subject: str, role: str, scope: str, assigner: str) -> dict:
    r.delete(cache_key(subject, scope))
    return grants.add(subject, role, scope, assigner)


def revoke_grant(grant_id: str) -> dict | None:
    grant = grants.by_id(grant_id)
    if grant is None:
        return None
    r.delete(cache_key(grant["subject"], grant["scope"]))
    return grants.revoke(grant_id)
`,
      solution: `import redis

from permz import grants  # effective, add, revoke, by_id

r = redis.Redis(host="redis", port=6379, decode_responses=True)

VERSION_KEY = "perm:grant_version"
CACHE_TTL_S = 300


def cache_key(subject: str, scope: str) -> str:
    return f"perm:{subject}:{scope}"


def effective_permissions(subject: str, scope: str) -> list[str]:
    """The permissions the subject holds at scope, sorted."""
    # The version first: a set derived after it is stamped with it, so a change that commits meanwhile outdates it.
    version = r.get(VERSION_KEY) or "0"
    entry = r.hgetall(cache_key(subject, scope))
    if entry and entry.get("version") == version:
        return entry["permissions"].split(",") if entry["permissions"] else []
    permissions = grants.effective(subject, scope)
    r.hset(cache_key(subject, scope), mapping={"permissions": ",".join(permissions), "version": version})
    r.expire(cache_key(subject, scope), CACHE_TTL_S)
    return permissions


def grant_role(subject: str, role: str, scope: str, assigner: str) -> dict:
    grant = grants.add(subject, role, scope, assigner)
    r.incr(VERSION_KEY)  # after the commit: every entry stamped before it is stale, at every scope
    return grant


def revoke_grant(grant_id: str) -> dict | None:
    grant = grants.revoke(grant_id)
    if grant is not None:
        r.incr(VERSION_KEY)
    return grant
`,
    },
    typescript: {
      starter: `import Redis from 'ioredis';

import {type Grant, add, byId, effective, revoke} from 'permz/grants';

const redis = new Redis({host: 'redis', port: 6379});

export const CACHE_TTL_S = 300;

export const cacheKey = (subject: string, scope: string): string => \`perm:\${subject}:\${scope}\`;

/** The permissions the subject holds at scope, sorted. */
export async function effectivePermissions(subject: string, scope: string): Promise<string[]> {
  // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
  const raw = await redis.get(cacheKey(subject, scope));
  if (raw !== null) return JSON.parse(raw) as string[];
  const permissions = await effective(subject, scope);
  await redis.set(cacheKey(subject, scope), JSON.stringify(permissions), 'EX', CACHE_TTL_S);
  return permissions;
}

export async function grantRole(subject: string, role: string, scope: string, assigner: string): Promise<Grant> {
  await redis.del(cacheKey(subject, scope));
  return add(subject, role, scope, assigner);
}

export async function revokeGrant(grantId: string): Promise<Grant | null> {
  const grant = await byId(grantId);
  if (grant === null) return null;
  await redis.del(cacheKey(grant.subject, grant.scope));
  return revoke(grantId);
}
`,
      solution: `import Redis from 'ioredis';

import {type Grant, add, byId, effective, revoke} from 'permz/grants';

const redis = new Redis({host: 'redis', port: 6379});

export const VERSION_KEY = 'perm:grant_version';
export const CACHE_TTL_S = 300;

export const cacheKey = (subject: string, scope: string): string => \`perm:\${subject}:\${scope}\`;

/** The permissions the subject holds at scope, sorted. */
export async function effectivePermissions(subject: string, scope: string): Promise<string[]> {
  // The version first: a set derived after it is stamped with it, so a change that commits meanwhile outdates it.
  const version = (await redis.get(VERSION_KEY)) ?? '0';
  const entry = await redis.hgetall(cacheKey(subject, scope));
  if (entry.version === version) return entry.permissions === '' ? [] : entry.permissions.split(',');
  const permissions = await effective(subject, scope);
  await redis.hset(cacheKey(subject, scope), {permissions: permissions.join(','), version});
  await redis.expire(cacheKey(subject, scope), CACHE_TTL_S);
  return permissions;
}

export async function grantRole(subject: string, role: string, scope: string, assigner: string): Promise<Grant> {
  const grant = await add(subject, role, scope, assigner);
  await redis.incr(VERSION_KEY); // after the commit: every entry stamped before it is stale, at every scope
  return grant;
}

export async function revokeGrant(grantId: string): Promise<Grant | null> {
  const grant = await revoke(grantId);
  if (grant !== null) await redis.incr(VERSION_KEY);
  return grant;
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"time"

	"github.com/redis/go-redis/v9"

	"permz/grants" // grants.Effective, Add, Revoke, ByID
)

const cacheTTL = 300 * time.Second

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

func cacheKey(subject, scope string) string { return "perm:" + subject + ":" + scope }

// effectivePermissions is the permissions the subject holds at scope, sorted.
func effectivePermissions(ctx context.Context, subject, scope string) []string {
	// TODO: this starter has three flaws. The task says where to look; the checks say what must change.
	if raw, err := rdb.Get(ctx, cacheKey(subject, scope)).Result(); err == nil {
		var cached []string
		json.Unmarshal([]byte(raw), &cached)
		return cached
	}
	permissions := grants.Effective(ctx, subject, scope)
	raw, _ := json.Marshal(permissions)
	rdb.Set(ctx, cacheKey(subject, scope), raw, cacheTTL)
	return permissions
}

func grantRole(ctx context.Context, subject, role, scope, assigner string) grants.Grant {
	rdb.Del(ctx, cacheKey(subject, scope))
	return grants.Add(ctx, subject, role, scope, assigner)
}

func revokeGrant(ctx context.Context, grantID string) *grants.Grant {
	g := grants.ByID(ctx, grantID)
	if g == nil {
		return nil
	}
	rdb.Del(ctx, cacheKey(g.Subject, g.Scope))
	return grants.Revoke(ctx, grantID)
}
`,
      solution: `package main

import (
	"context"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"

	"permz/grants" // grants.Effective, Add, Revoke, ByID
)

const (
	versionKey = "perm:grant_version"
	cacheTTL   = 300 * time.Second
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

func cacheKey(subject, scope string) string { return "perm:" + subject + ":" + scope }

// effectivePermissions is the permissions the subject holds at scope, sorted.
func effectivePermissions(ctx context.Context, subject, scope string) []string {
	// The version first: a set derived after it is stamped with it, so a change that commits meanwhile outdates it.
	version, err := rdb.Get(ctx, versionKey).Result()
	if err != nil {
		version = "0"
	}
	entry := rdb.HGetAll(ctx, cacheKey(subject, scope)).Val()
	if stamp, ok := entry["version"]; ok && stamp == version {
		if entry["permissions"] == "" {
			return []string{}
		}
		return strings.Split(entry["permissions"], ",")
	}
	permissions := grants.Effective(ctx, subject, scope)
	rdb.HSet(ctx, cacheKey(subject, scope), map[string]any{"permissions": strings.Join(permissions, ","), "version": version})
	rdb.Expire(ctx, cacheKey(subject, scope), cacheTTL)
	return permissions
}

func grantRole(ctx context.Context, subject, role, scope, assigner string) grants.Grant {
	g := grants.Add(ctx, subject, role, scope, assigner)
	rdb.Incr(ctx, versionKey) // after the commit: every entry stamped before it is stale, at every scope
	return g
}

func revokeGrant(ctx context.Context, grantID string) *grants.Grant {
	g := grants.Revoke(ctx, grantID)
	if g != nil {
		rdb.Incr(ctx, versionKey)
	}
	return g
}
`,
    },
    scala: {
      starter: `import redis.clients.jedis.JedisPooled
import redis.clients.jedis.params.SetParams
import spray.json._
import spray.json.DefaultJsonProtocol._

import permz.Grants // Grants.effective, add, revoke, byId

object State {
  val CacheTtlS = 300L

  val jedis = new JedisPooled("redis", 6379)

  def cacheKey(subject: String, scope: String): String = s"perm:$subject:$scope"

  /** The permissions the subject holds at scope, sorted. */
  def effectivePermissions(subject: String, scope: String): Seq[String] = {
    // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
    Option(jedis.get(cacheKey(subject, scope))) match {
      case Some(raw) => raw.parseJson.convertTo[Seq[String]]
      case None =>
        val permissions = Grants.effective(subject, scope)
        jedis.set(cacheKey(subject, scope), permissions.toJson.compactPrint, SetParams.setParams().ex(CacheTtlS))
        permissions
    }
  }

  def grantRole(subject: String, role: String, scope: String, assigner: String): Grants.Grant = {
    jedis.del(cacheKey(subject, scope))
    Grants.add(subject, role, scope, assigner)
  }

  def revokeGrant(grantId: String): Option[Grants.Grant] =
    Grants.byId(grantId).flatMap { grant =>
      jedis.del(cacheKey(grant.subject, grant.scope))
      Grants.revoke(grantId)
    }
}
`,
      solution: `import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

import permz.Grants // Grants.effective, add, revoke, byId

object State {
  val VersionKey = "perm:grant_version"
  val CacheTtlS = 300L

  val jedis = new JedisPooled("redis", 6379)

  def cacheKey(subject: String, scope: String): String = s"perm:$subject:$scope"

  /** The permissions the subject holds at scope, sorted. */
  def effectivePermissions(subject: String, scope: String): Seq[String] = {
    // The version first: a set derived after it is stamped with it, so a change that commits meanwhile outdates it.
    val version = Option(jedis.get(VersionKey)).getOrElse("0")
    val entry = jedis.hgetAll(cacheKey(subject, scope)).asScala
    if (entry.get("version").contains(version)) entry.getOrElse("permissions", "").split(",").toSeq.filter(_.nonEmpty)
    else {
      val permissions = Grants.effective(subject, scope)
      jedis.hset(cacheKey(subject, scope), Map("permissions" -> permissions.mkString(","), "version" -> version).asJava)
      jedis.expire(cacheKey(subject, scope), CacheTtlS)
      permissions
    }
  }

  def grantRole(subject: String, role: String, scope: String, assigner: String): Grants.Grant = {
    val grant = Grants.add(subject, role, scope, assigner)
    jedis.incr(VersionKey) // after the commit: every entry stamped before it is stale, at every scope
    grant
  }

  def revokeGrant(grantId: String): Option[Grants.Grant] = {
    val grant = Grants.revoke(grantId)
    if (grant.isDefined) jedis.incr(VersionKey)
    grant
  }
}
`,
    },
    cpp: {
      starter: `#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <chrono>
#include <optional>
#include <string>
#include <vector>

#include "permz/grants.h"  // grants::effective, add, revoke, byId

constexpr long long kCacheTtlS = 300;

sw::redis::Redis redis("tcp://redis:6379");

std::string cacheKey(const std::string& subject, const std::string& scope) { return "perm:" + subject + ":" + scope; }

// The permissions the subject holds at scope, sorted.
std::vector<std::string> effectivePermissions(const std::string& subject, const std::string& scope) {
  // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
  if (const auto raw = redis.get(cacheKey(subject, scope))) return nlohmann::json::parse(*raw).get<std::vector<std::string>>();
  const std::vector<std::string> permissions = grants::effective(subject, scope);
  redis.set(cacheKey(subject, scope), nlohmann::json(permissions).dump(), std::chrono::seconds(kCacheTtlS));
  return permissions;
}

grants::Grant grantRole(const std::string& subject, const std::string& role, const std::string& scope, const std::string& assigner) {
  redis.del(cacheKey(subject, scope));
  return grants::add(subject, role, scope, assigner);
}

std::optional<grants::Grant> revokeGrant(const std::string& grant_id) {
  const auto g = grants::byId(grant_id);
  if (!g) return std::nullopt;
  redis.del(cacheKey(g->subject, g->scope));
  return grants::revoke(grant_id);
}
`,
      solution: `#include <sw/redis++/redis++.h>

#include <optional>
#include <sstream>
#include <string>
#include <unordered_map>
#include <vector>

#include "permz/grants.h"  // grants::effective, add, revoke, byId

const std::string kVersionKey = "perm:grant_version";
constexpr long long kCacheTtlS = 300;

sw::redis::Redis redis("tcp://redis:6379");

std::string cacheKey(const std::string& subject, const std::string& scope) { return "perm:" + subject + ":" + scope; }

// The permissions the subject holds at scope, sorted.
std::vector<std::string> effectivePermissions(const std::string& subject, const std::string& scope) {
  // The version first: a set derived after it is stamped with it, so a change that commits meanwhile outdates it.
  const std::string version = redis.get(kVersionKey).value_or("0");
  const std::unordered_map<std::string, std::string> entry = redis.hgetall(cacheKey(subject, scope));
  if (entry.count("version") && entry.at("version") == version) {
    std::vector<std::string> out;
    std::stringstream joined(entry.count("permissions") ? entry.at("permissions") : "");
    for (std::string p; std::getline(joined, p, ',');) out.push_back(p);
    return out;
  }
  const std::vector<std::string> permissions = grants::effective(subject, scope);
  std::string joined;
  for (const std::string& p : permissions) joined += (joined.empty() ? "" : ",") + p;
  redis.hset(cacheKey(subject, scope), {{"permissions", joined}, {"version", version}});
  redis.expire(cacheKey(subject, scope), kCacheTtlS);
  return permissions;
}

grants::Grant grantRole(const std::string& subject, const std::string& role, const std::string& scope, const std::string& assigner) {
  const grants::Grant g = grants::add(subject, role, scope, assigner);
  redis.incr(kVersionKey);  // after the commit: every entry stamped before it is stale, at every scope
  return g;
}

std::optional<grants::Grant> revokeGrant(const std::string& grant_id) {
  const auto g = grants::revoke(grant_id);
  if (g) redis.incr(kVersionKey);
  return g;
}
`,
    },
  },
  harness: {
    python: `def _revoke_elsewhere(ctx):
    """Another replica revokes g-1 the way the task asks: the grant store commits, then the version moves (and the key goes)."""
    ctx.redis.delete("grant:g-1")
    ctx.redis.srem("grants:ada", "g-1")
    ctx.redis.incr("perm:grant_version")
    ctx.redis.delete("perm:ada:team:eng")


def check_every_scope(ctx):
    m = ctx.load("state")
    grant = m.grant_role("ada", "team_admin", "team:eng", "olu")
    assert "team:write" in m.effective_permissions("ada", "team:eng"), "a team_admin at team:eng must hold team:write there"
    assert "team:write" in m.effective_permissions("ada", "project:eng/api"), "team:eng covers project:eng/api: ada must hold team:write there"
    ttl = ctx.redis.ttl("perm:ada:team:eng")
    assert 0 < ttl <= 300, f"perm:ada:team:eng has a TTL of {ttl} s, expected at most 300"
    m.revoke_grant(grant["grant_id"])
    for scope in ("team:eng", "project:eng/api"):
        seen = m.effective_permissions("ada", scope)
        assert "team:write" not in seen, f"after ada's team_admin grant at team:eng was revoked, a read at {scope} still answers {seen}: the invalidation must reach every cached scope the grant covered"
    m.grant_role("ada", "developer", "team:eng", "olu")
    seen = m.effective_permissions("ada", "project:eng/api")
    assert "code:write" in seen, f"after developer was granted at team:eng, a read at project:eng/api answers {seen}"


def check_after_commit(ctx):
    m = ctx.load("state")
    grant = m.grant_role("ada", "team_admin", "team:eng", "olu")
    assert "team:write" in m.effective_permissions("ada", "team:eng"), "a team_admin at team:eng must hold team:write there"
    # What a read landing at the moment the revocation first touches the cache would find in the grant store.
    seen = []

    def at_invalidation():
        if not seen:
            seen.append(ctx.redis.exists("grant:g-1") == 1)

    ctx.redis_after("perm:ada:team:eng", at_invalidation)
    ctx.redis_after("perm:grant_version", at_invalidation)
    m.revoke_grant(grant["grant_id"])
    assert seen, "revoke_grant touched neither perm:ada:team:eng nor perm:grant_version: nothing invalidates the cached set"
    assert seen[0] is False, "revoke_grant invalidated the cache while g-1 was still in the grant store: a read landing there derives the set the revocation removes and caches it. Write the grant first, then invalidate"
    after = m.effective_permissions("ada", "team:eng")
    assert "team:write" not in after, f"after the revocation ada still holds {after}"


def check_stamp_before_derive(ctx):
    m = ctx.load("state")
    m.grant_role("ada", "team_admin", "team:eng", "olu")
    # A read misses and derives ada's set; another replica revokes g-1 right after the read loaded it.
    probe = ctx.redis_after("grant:g-1", lambda: _revoke_elsewhere(ctx))
    first = m.effective_permissions("ada", "team:eng")
    assert probe.fired, "the read never loaded ada's grant g-1 from the grant store"
    if probe.error is not None:
        raise probe.error
    after = m.effective_permissions("ada", "team:eng")
    assert "team:write" not in after, f"the read that was deriving when the revocation committed cached {first}, and the next read still answers {after}: stamp the entry with the version read before deriving, and serve it only while that version is current"
`,
    typescript: `function revokeElsewhere(ctx): void {
  // Another replica revokes g-1 the way the task asks: the grant store commits, then the version moves (and the key goes).
  ctx.redis.del('grant:g-1');
  ctx.redis.srem('grants:ada', 'g-1');
  ctx.redis.incr('perm:grant_version');
  ctx.redis.del('perm:ada:team:eng');
}

export async function check_every_scope(ctx) {
  const m = ctx.load('state');
  const grant = await m.grantRole('ada', 'team_admin', 'team:eng', 'olu');
  assert((await m.effectivePermissions('ada', 'team:eng')).includes('team:write'), 'a team_admin at team:eng must hold team:write there');
  assert((await m.effectivePermissions('ada', 'project:eng/api')).includes('team:write'), 'team:eng covers project:eng/api: ada must hold team:write there');
  const ttl = ctx.redis.ttl('perm:ada:team:eng');
  assert(ttl > 0 && ttl <= 300, \`perm:ada:team:eng has a TTL of \${ttl} s, expected at most 300\`);
  await m.revokeGrant(grant.grant_id);
  for (const scope of ['team:eng', 'project:eng/api']) {
    const seen = await m.effectivePermissions('ada', scope);
    assert(!seen.includes('team:write'), \`after ada's team_admin grant at team:eng was revoked, a read at \${scope} still answers \${JSON.stringify(seen)}: the invalidation must reach every cached scope the grant covered\`);
  }
  await m.grantRole('ada', 'developer', 'team:eng', 'olu');
  const seen = await m.effectivePermissions('ada', 'project:eng/api');
  assert(seen.includes('code:write'), \`after developer was granted at team:eng, a read at project:eng/api answers \${JSON.stringify(seen)}\`);
}

export async function check_after_commit(ctx) {
  const m = ctx.load('state');
  const grant = await m.grantRole('ada', 'team_admin', 'team:eng', 'olu');
  assert((await m.effectivePermissions('ada', 'team:eng')).includes('team:write'), 'a team_admin at team:eng must hold team:write there');
  // What a read landing at the moment the revocation first touches the cache would find in the grant store.
  const seen: boolean[] = [];
  const atInvalidation = () => {
    if (seen.length === 0) seen.push(ctx.redis.exists('grant:g-1') === 1);
  };
  ctx.redisAfter('perm:ada:team:eng', atInvalidation);
  ctx.redisAfter('perm:grant_version', atInvalidation);
  await m.revokeGrant(grant.grant_id);
  assert(seen.length > 0, 'revokeGrant touched neither perm:ada:team:eng nor perm:grant_version: nothing invalidates the cached set');
  assert.equal(seen[0], false, 'revokeGrant invalidated the cache while g-1 was still in the grant store: a read landing there derives the set the revocation removes and caches it. Write the grant first, then invalidate');
  const after = await m.effectivePermissions('ada', 'team:eng');
  assert(!after.includes('team:write'), \`after the revocation ada still holds \${JSON.stringify(after)}\`);
}

export async function check_stamp_before_derive(ctx) {
  const m = ctx.load('state');
  await m.grantRole('ada', 'team_admin', 'team:eng', 'olu');
  // A read misses and derives ada's set; another replica revokes g-1 right after the read loaded it.
  const probe = ctx.redisAfter('grant:g-1', () => revokeElsewhere(ctx));
  const first = await m.effectivePermissions('ada', 'team:eng');
  assert(probe.fired, "the read never loaded ada's grant g-1 from the grant store");
  if (probe.error !== undefined) throw probe.error;
  const after = await m.effectivePermissions('ada', 'team:eng');
  assert(!after.includes('team:write'), \`the read that was deriving when the revocation committed cached \${JSON.stringify(first)}, and the next read still answers \${JSON.stringify(after)}: stamp the entry with the version read before deriving, and serve it only while that version is current\`);
}
`,
    go: `package main

import (
	"context"
	"slices"

	"leetbuild/harness"
)

var stateBg = context.Background()

// revokeElsewhere is another replica revoking g-1 the way the task asks: the grant store commits, then the version moves (and the key goes).
func revokeElsewhere(ctx *harness.Ctx) {
	ctx.Redis.Do("DEL", "grant:g-1")
	ctx.Redis.Do("SREM", "grants:ada", "g-1")
	ctx.Redis.Do("INCR", "perm:grant_version")
	ctx.Redis.Do("DEL", "perm:ada:team:eng")
}

func CheckEveryScope(ctx *harness.Ctx) {
	g := grantRole(stateBg, "ada", "team_admin", "team:eng", "olu")
	ctx.Assert(slices.Contains(effectivePermissions(stateBg, "ada", "team:eng"), "team:write"), "a team_admin at team:eng must hold team:write there")
	ctx.Assert(slices.Contains(effectivePermissions(stateBg, "ada", "project:eng/api"), "team:write"), "team:eng covers project:eng/api: ada must hold team:write there")
	ttl := ctx.Redis.TTL("perm:ada:team:eng")
	ctx.Assert(ttl > 0 && ttl <= 300, "perm:ada:team:eng has a TTL of %d s, expected at most 300", ttl)
	revokeGrant(stateBg, g.GrantID)
	for _, scope := range []string{"team:eng", "project:eng/api"} {
		seen := effectivePermissions(stateBg, "ada", scope)
		ctx.Assert(!slices.Contains(seen, "team:write"), "after ada's team_admin grant at team:eng was revoked, a read at %s still answers %v: the invalidation must reach every cached scope the grant covered", scope, seen)
	}
	grantRole(stateBg, "ada", "developer", "team:eng", "olu")
	seen := effectivePermissions(stateBg, "ada", "project:eng/api")
	ctx.Assert(slices.Contains(seen, "code:write"), "after developer was granted at team:eng, a read at project:eng/api answers %v", seen)
}

func CheckAfterCommit(ctx *harness.Ctx) {
	g := grantRole(stateBg, "ada", "team_admin", "team:eng", "olu")
	ctx.Assert(slices.Contains(effectivePermissions(stateBg, "ada", "team:eng"), "team:write"), "a team_admin at team:eng must hold team:write there")
	// What a read landing at the moment the revocation first touches the cache would find in the grant store.
	var seen []bool
	atInvalidation := func() any {
		if len(seen) == 0 {
			seen = append(seen, ctx.Redis.Exists("grant:g-1") == 1)
		}
		return nil
	}
	ctx.Redis.After("perm:ada:team:eng", atInvalidation)
	ctx.Redis.After("perm:grant_version", atInvalidation)
	revokeGrant(stateBg, g.GrantID)
	ctx.Assert(len(seen) > 0, "revokeGrant touched neither perm:ada:team:eng nor perm:grant_version: nothing invalidates the cached set")
	ctx.Assert(!seen[0], "revokeGrant invalidated the cache while g-1 was still in the grant store: a read landing there derives the set the revocation removes and caches it. Write the grant first, then invalidate")
	after := effectivePermissions(stateBg, "ada", "team:eng")
	ctx.Assert(!slices.Contains(after, "team:write"), "after the revocation ada still holds %v", after)
}

func CheckStampBeforeDerive(ctx *harness.Ctx) {
	grantRole(stateBg, "ada", "team_admin", "team:eng", "olu")
	// A read misses and derives ada's set; another replica revokes g-1 right after the read loaded it.
	probe := ctx.Redis.After("grant:g-1", func() any {
		revokeElsewhere(ctx)
		return nil
	})
	first := effectivePermissions(stateBg, "ada", "team:eng")
	ctx.Assert(probe.Fired, "the read never loaded ada's grant g-1 from the grant store")
	after := effectivePermissions(stateBg, "ada", "team:eng")
	ctx.Assert(!slices.Contains(after, "team:write"), "the read that was deriving when the revocation committed cached %v, and the next read still answers %v: stamp the entry with the version read before deriving, and serve it only while that version is current", first, after)
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <algorithm>
#include <string>
#include <vector>

#include "permz/grants.h"

namespace {

bool holds(const std::vector<std::string>& permissions, const std::string& p) {
  return std::find(permissions.begin(), permissions.end(), p) != permissions.end();
}

// Another replica revoking g-1 the way the task asks: the grant store commits, then the version moves (and the key goes).
void revokeElsewhere(harness::Ctx& ctx) {
  ctx.Redis.Do("DEL", "grant:g-1");
  ctx.Redis.Do("SREM", "grants:ada", "g-1");
  ctx.Redis.Do("INCR", "perm:grant_version");
  ctx.Redis.Do("DEL", "perm:ada:team:eng");
}

}  // namespace

void CheckEveryScope(harness::Ctx& ctx) {
  const grants::Grant g = grantRole("ada", "team_admin", "team:eng", "olu");
  ctx.Assert(holds(effectivePermissions("ada", "team:eng"), "team:write"), "a team_admin at team:eng must hold team:write there");
  ctx.Assert(holds(effectivePermissions("ada", "project:eng/api"), "team:write"), "team:eng covers project:eng/api: ada must hold team:write there");
  const long long ttl = ctx.Redis.TTL("perm:ada:team:eng");
  ctx.Assert(ttl > 0 && ttl <= 300, "perm:ada:team:eng has a TTL of %d s, expected at most 300", ttl);
  revokeGrant(g.grant_id);
  for (const std::string scope : {"team:eng", "project:eng/api"}) {
    const auto seen = effectivePermissions("ada", scope);
    ctx.Assert(!holds(seen, "team:write"), "after ada's team_admin grant at team:eng was revoked, a read at %s still answers %v: the invalidation must reach every cached scope the grant covered", scope, seen);
  }
  grantRole("ada", "developer", "team:eng", "olu");
  const auto seen = effectivePermissions("ada", "project:eng/api");
  ctx.Assert(holds(seen, "code:write"), "after developer was granted at team:eng, a read at project:eng/api answers %v", seen);
}

void CheckAfterCommit(harness::Ctx& ctx) {
  const grants::Grant g = grantRole("ada", "team_admin", "team:eng", "olu");
  ctx.Assert(holds(effectivePermissions("ada", "team:eng"), "team:write"), "a team_admin at team:eng must hold team:write there");
  // What a read landing at the moment the revocation first touches the cache would find in the grant store.
  std::vector<bool> seen;
  const auto atInvalidation = [&ctx, &seen] {
    if (seen.empty()) seen.push_back(ctx.Redis.Exists("grant:g-1") == 1);
  };
  ctx.Redis.After("perm:ada:team:eng", atInvalidation);
  ctx.Redis.After("perm:grant_version", atInvalidation);
  revokeGrant(g.grant_id);
  ctx.Assert(!seen.empty(), "revokeGrant touched neither perm:ada:team:eng nor perm:grant_version: nothing invalidates the cached set");
  ctx.Assert(!seen[0], "revokeGrant invalidated the cache while g-1 was still in the grant store: a read landing there derives the set the revocation removes and caches it. Write the grant first, then invalidate");
  const auto after = effectivePermissions("ada", "team:eng");
  ctx.Assert(!holds(after, "team:write"), "after the revocation ada still holds %v", after);
}

void CheckStampBeforeDerive(harness::Ctx& ctx) {
  grantRole("ada", "team_admin", "team:eng", "olu");
  // A read misses and derives ada's set; another replica revokes g-1 right after the read loaded it.
  bool fired = false;
  ctx.Redis.After("grant:g-1", [&ctx, &fired] {
    fired = true;
    revokeElsewhere(ctx);
  });
  const auto first = effectivePermissions("ada", "team:eng");
  ctx.Assert(fired, "the read never loaded ada's grant g-1 from the grant store");
  const auto after = effectivePermissions("ada", "team:eng");
  ctx.Assert(!holds(after, "team:write"), "the read that was deriving when the revocation committed cached %v, and the next read still answers %v: stamp the entry with the version read before deriving, and serve it only while that version is current", first, after);
}
`,
  },
  hints: [
    "Revoke a team admin, then read their permissions at one of the team's projects: `team:write` is still there. Revoke again while another request is reading, and the old set comes back with a fresh TTL.",
    'Deleting `perm:{subject}:{scope}` reaches one key, before the grant store changes, and an entry records nothing about when it was derived, so a read that derived the old set can store it after any delete.',
    'Write the grant, then `INCR perm:grant_version`; drop the deletes. In the read, `GET` the version first, serve the hash only when its `version` equals it, else derive and `HSET {permissions, version}` with `EXPIRE 300`.',
  ],
  debrief: `A delete carries no information about time: once the key is gone, any reader can put back whatever it derived, including a set from before the change. A version counter turns "is this entry fresh?" into a comparison every read makes, and one \`INCR\` outdates every scope a grant covered without knowing which keys exist. The order matters twice: the change commits before the bump, so a read after the bump sees the new grants, and the read takes the version before deriving, so a set derived during a change carries the older stamp. Production services also collapse concurrent misses behind a short lock and carry the version in the event stream, so the counter can be rebuilt after a Redis loss.`,
};
