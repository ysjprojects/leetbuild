/**
 * Hand-written support modules the permission-service steps import but no step builds: the `permz`
 * package. `catalog` is the role catalog (roles, the scope kinds each may be granted at, the
 * permissions each confers) and scope containment; `grants` is the grant store and its outbox, in
 * Redis (the course's stand-in for the permissions database); `cache` is step 2's version-stamped
 * effective-permission cache as later steps use it. The five languages keep the same keys and the
 * same Lua, so a harness reads one layout whatever the stack.
 */
import {scalaPath} from '../scala-support';

export const supportModules: Record<string, string> = {
  'permz/__init__.py': '',
  'permz/catalog.py': `"""
The role catalog (provided): the only source of valid roles, the scope kinds each may be granted
at, and the permissions each confers. Scopes are "org", "team:{team}" and "project:{team}/{project}".
covers(held, target) says whether a grant at held reaches target: the same scope, "org" over every
scope, a team over its own projects.
"""

ROLES = {
    "org_admin": {
        "scope_kinds": ["org"],
        "permissions": ["code:write", "org:read", "org:write", "permissions:read_any", "roles:assign", "team:read", "team:write"],
    },
    "team_admin": {"scope_kinds": ["team"], "permissions": ["roles:assign", "team:read", "team:write"]},
    "developer": {"scope_kinds": ["team", "project"], "permissions": ["code:write", "team:read"]},
    "viewer": {"scope_kinds": ["team", "project"], "permissions": ["team:read"]},
}


def scope_kind(scope: str) -> str:
    """"org", "team" or "project"; "" for a scope the catalog does not define (such as "*")."""
    if scope == "org":
        return "org"
    kind, _, rest = scope.partition(":")
    if kind == "team" and rest != "" and "/" not in rest:
        return "team"
    parts = rest.split("/")
    if kind == "project" and len(parts) == 2 and parts[0] != "" and parts[1] != "":
        return "project"
    return ""


def covers(held: str, target: str) -> bool:
    """Whether a grant at held reaches target."""
    if scope_kind(held) == "" or scope_kind(target) == "":
        return False
    if held == target or held == "org":
        return True
    return scope_kind(held) == "team" and target.startswith("project:" + held[len("team:"):] + "/")


def permissions_of(role: str) -> list[str]:
    """The permissions role confers, sorted; [] for a role the catalog does not define."""
    return list(ROLES[role]["permissions"]) if role in ROLES else []
`,
  'permz/grants.py': `"""
The grant store (provided), in Redis: grant:{id} is one grant (grant_id, subject, role, scope,
assigner), grants:{subject} the ids a subject holds, assignment:{assigner}:{key} the recorded answer
to an assignment request. add and revoke write a grant and nothing else.

The outbox lives beside it. commit_grant and commit_revoke are the full write path: the grant
change, the bump of perm:grant_version and an outbox row (outbox:{n}: id, type "granted" or
"revoked", grant_id, subject, role, scope, grant_version) appended to outbox:pending, in one Lua
script, which is this store's transaction. pending lists the rows not yet published, oldest first;
mark_sent takes one off the list.
"""
import json

import redis

from permz import catalog

r = redis.Redis(host="redis", port=6379, decode_responses=True)

VERSION_KEY = "perm:grant_version"

COMMIT_LUA = """
local version = redis.call('INCR', KEYS[3])
if ARGV[1] == 'granted' then
  redis.call('HSET', KEYS[1], 'grant_id', ARGV[2], 'subject', ARGV[3], 'role', ARGV[4], 'scope', ARGV[5], 'assigner', ARGV[6])
  redis.call('SADD', KEYS[2], ARGV[2])
else
  redis.call('DEL', KEYS[1])
  redis.call('SREM', KEYS[2], ARGV[2])
end
local n = redis.call('INCR', 'outbox:seq')
redis.call('HSET', 'outbox:' .. n, 'id', n, 'type', ARGV[1], 'grant_id', ARGV[2], 'subject', ARGV[3], 'role', ARGV[4], 'scope', ARGV[5], 'grant_version', version)
redis.call('RPUSH', 'outbox:pending', n)
return n
"""
commit = r.register_script(COMMIT_LUA)

FIELDS = ("grant_id", "subject", "role", "scope", "assigner")


def by_id(grant_id: str) -> dict | None:
    """The grant, or None."""
    raw = r.hgetall(f"grant:{grant_id}")
    return {name: raw.get(name, "") for name in FIELDS} if raw else None


def grants_of(subject: str) -> list[dict]:
    """Every grant the subject holds, oldest first."""
    ids = sorted(r.smembers(f"grants:{subject}"), key=lambda grant_id: int(grant_id[2:]))
    return [grant for grant in (by_id(grant_id) for grant_id in ids) if grant is not None]


def effective(subject: str, scope: str) -> list[str]:
    """The permissions the subject holds at scope: those of every grant whose scope covers it, sorted."""
    held = set()
    for grant in grants_of(subject):
        if catalog.covers(grant["scope"], scope):
            held.update(catalog.permissions_of(grant["role"]))
    return sorted(held)


def add(subject: str, role: str, scope: str, assigner: str) -> dict:
    """Write a new grant; returns it."""
    grant_id = f"g-{r.incr('grant:seq')}"
    r.hset(f"grant:{grant_id}", mapping={"grant_id": grant_id, "subject": subject, "role": role, "scope": scope, "assigner": assigner})
    r.sadd(f"grants:{subject}", grant_id)
    return by_id(grant_id)


def revoke(grant_id: str) -> dict | None:
    """Delete the grant; returns it, or None when there is none."""
    grant = by_id(grant_id)
    if grant is None:
        return None
    r.delete(f"grant:{grant_id}")
    r.srem(f"grants:{grant['subject']}", grant_id)
    return grant


def assignment(assigner: str, key: str) -> dict | None:
    """The answer recorded for the assignment request (assigner, Idempotency-Key), if any."""
    raw = r.get(f"assignment:{assigner}:{key}")
    return json.loads(raw) if raw else None


def record_assignment(assigner: str, key: str, result: dict) -> None:
    """Record what the assignment request (assigner, key) answered, for its replays."""
    r.set(f"assignment:{assigner}:{key}", json.dumps(result))


def outbox_row(row_id: str) -> dict | None:
    raw = r.hgetall(f"outbox:{row_id}")
    if not raw:
        return None
    return {**raw, "grant_version": int(raw["grant_version"])}


def _commit(kind: str, grant: dict) -> dict:
    keys = [f"grant:{grant['grant_id']}", f"grants:{grant['subject']}", VERSION_KEY]
    args = [kind, grant["grant_id"], grant["subject"], grant["role"], grant["scope"], grant["assigner"]]
    return outbox_row(str(commit(keys=keys, args=args)))


def commit_grant(subject: str, role: str, scope: str, assigner: str) -> dict:
    """Write a new grant, bump perm:grant_version and append its "granted" outbox row, atomically; returns the row."""
    grant_id = f"g-{r.incr('grant:seq')}"
    return _commit("granted", {"grant_id": grant_id, "subject": subject, "role": role, "scope": scope, "assigner": assigner})


def commit_revoke(grant_id: str) -> dict | None:
    """Delete the grant, bump perm:grant_version and append its "revoked" outbox row, atomically; returns the row."""
    grant = by_id(grant_id)
    return None if grant is None else _commit("revoked", grant)


def pending() -> list[dict]:
    """The outbox rows not yet published, oldest first."""
    rows = (outbox_row(row_id) for row_id in r.lrange("outbox:pending", 0, -1))
    return [row for row in rows if row is not None]


def mark_sent(row_id: str) -> None:
    """The row is on the topic: take it off outbox:pending."""
    r.lrem("outbox:pending", 1, row_id)
`,
  'permz/cache.py': `"""
The effective-permission cache (provided; step 2 builds the same three functions).
perm:{subject}:{scope} is a hash (permissions comma-joined, version) with a 300 s TTL;
perm:grant_version is the invalidation clock. A read takes the version first and serves the entry
only while its stamp equals it, else derives the set from the grant store and stamps it with the
version it read. grant_role and revoke_grant write the grant, then bump the version.
"""
import redis

from permz import grants

r = redis.Redis(host="redis", port=6379, decode_responses=True)

VERSION_KEY = "perm:grant_version"
CACHE_TTL_S = 300


def cache_key(subject: str, scope: str) -> str:
    return f"perm:{subject}:{scope}"


def effective_permissions(subject: str, scope: str) -> list[str]:
    """The permissions the subject holds at scope, sorted."""
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
    r.incr(VERSION_KEY)
    return grant


def revoke_grant(grant_id: str) -> dict | None:
    grant = grants.revoke(grant_id)
    if grant is not None:
        r.incr(VERSION_KEY)
    return grant
`,
};

export const supportModulesTs: Record<string, string> = {
  'permz/catalog.ts': `/**
 * The role catalog (provided): the only source of valid roles, the scope kinds each may be granted
 * at, and the permissions each confers. Scopes are "org", "team:{team}" and
 * "project:{team}/{project}". covers(held, target) says whether a grant at held reaches target: the
 * same scope, "org" over every scope, a team over its own projects.
 */

export interface Role {
  scope_kinds: string[];
  permissions: string[];
}

export const ROLES: Record<string, Role> = {
  org_admin: {
    scope_kinds: ['org'],
    permissions: ['code:write', 'org:read', 'org:write', 'permissions:read_any', 'roles:assign', 'team:read', 'team:write'],
  },
  team_admin: {scope_kinds: ['team'], permissions: ['roles:assign', 'team:read', 'team:write']},
  developer: {scope_kinds: ['team', 'project'], permissions: ['code:write', 'team:read']},
  viewer: {scope_kinds: ['team', 'project'], permissions: ['team:read']},
};

/** "org", "team" or "project"; "" for a scope the catalog does not define (such as "*"). */
export function scopeKind(scope: string): string {
  if (scope === 'org') return 'org';
  const colon = scope.indexOf(':');
  const kind = colon < 0 ? scope : scope.slice(0, colon);
  const rest = colon < 0 ? '' : scope.slice(colon + 1);
  if (kind === 'team' && rest !== '' && !rest.includes('/')) return 'team';
  const parts = rest.split('/');
  if (kind === 'project' && parts.length === 2 && parts[0] !== '' && parts[1] !== '') return 'project';
  return '';
}

/** Whether a grant at held reaches target. */
export function covers(held: string, target: string): boolean {
  if (scopeKind(held) === '' || scopeKind(target) === '') return false;
  if (held === target || held === 'org') return true;
  return scopeKind(held) === 'team' && target.startsWith(\`project:\${held.slice('team:'.length)}/\`);
}

/** The permissions role confers, sorted; [] for a role the catalog does not define. */
export function permissionsOf(role: string): string[] {
  return Object.hasOwn(ROLES, role) ? [...ROLES[role].permissions] : [];
}
`,
  'permz/grants.ts': `/**
 * The grant store (provided), in Redis: grant:{id} is one grant (grant_id, subject, role, scope,
 * assigner), grants:{subject} the ids a subject holds, assignment:{assigner}:{key} the recorded
 * answer to an assignment request. add and revoke write a grant and nothing else.
 *
 * The outbox lives beside it. commitGrant and commitRevoke are the full write path: the grant
 * change, the bump of perm:grant_version and an outbox row (outbox:{n}: id, type "granted" or
 * "revoked", grant_id, subject, role, scope, grant_version) appended to outbox:pending, in one Lua
 * script, which is this store's transaction. pending lists the rows not yet published, oldest
 * first; markSent takes one off the list.
 */
import Redis from 'ioredis';

import {covers, permissionsOf} from 'permz/catalog';

export const VERSION_KEY = 'perm:grant_version';

export const COMMIT_LUA = \`
local version = redis.call('INCR', KEYS[3])
if ARGV[1] == 'granted' then
  redis.call('HSET', KEYS[1], 'grant_id', ARGV[2], 'subject', ARGV[3], 'role', ARGV[4], 'scope', ARGV[5], 'assigner', ARGV[6])
  redis.call('SADD', KEYS[2], ARGV[2])
else
  redis.call('DEL', KEYS[1])
  redis.call('SREM', KEYS[2], ARGV[2])
end
local n = redis.call('INCR', 'outbox:seq')
redis.call('HSET', 'outbox:' .. n, 'id', n, 'type', ARGV[1], 'grant_id', ARGV[2], 'subject', ARGV[3], 'role', ARGV[4], 'scope', ARGV[5], 'grant_version', version)
redis.call('RPUSH', 'outbox:pending', n)
return n
\`;

interface CommitRedis extends Redis {
  commitChange(grantKey: string, subjectKey: string, versionKey: string, ...args: string[]): Promise<number>;
}

const redis = new Redis({host: 'redis', port: 6379}) as CommitRedis;
redis.defineCommand('commitChange', {numberOfKeys: 3, lua: COMMIT_LUA});

export interface Grant {
  grant_id: string;
  subject: string;
  role: string;
  scope: string;
  assigner: string;
}

export interface OutboxRow {
  id: string;
  type: string;
  grant_id: string;
  subject: string;
  role: string;
  scope: string;
  grant_version: number;
}

/** The grant, or null. */
export async function byId(grantId: string): Promise<Grant | null> {
  const raw = await redis.hgetall(\`grant:\${grantId}\`);
  if (Object.keys(raw).length === 0) return null;
  return {grant_id: raw.grant_id, subject: raw.subject, role: raw.role, scope: raw.scope, assigner: raw.assigner ?? ''};
}

/** Every grant the subject holds, oldest first. */
export async function grantsOf(subject: string): Promise<Grant[]> {
  const ids = (await redis.smembers(\`grants:\${subject}\`)).sort((a, b) => Number(a.slice(2)) - Number(b.slice(2)));
  const out: Grant[] = [];
  for (const id of ids) {
    const grant = await byId(id);
    if (grant !== null) out.push(grant);
  }
  return out;
}

/** The permissions the subject holds at scope: those of every grant whose scope covers it, sorted. */
export async function effective(subject: string, scope: string): Promise<string[]> {
  const held = new Set<string>();
  for (const grant of await grantsOf(subject)) {
    if (covers(grant.scope, scope)) for (const permission of permissionsOf(grant.role)) held.add(permission);
  }
  return [...held].sort();
}

/** Write a new grant; returns it. */
export async function add(subject: string, role: string, scope: string, assigner: string): Promise<Grant> {
  const grantId = \`g-\${await redis.incr('grant:seq')}\`;
  await redis.hset(\`grant:\${grantId}\`, {grant_id: grantId, subject, role, scope, assigner});
  await redis.sadd(\`grants:\${subject}\`, grantId);
  return {grant_id: grantId, subject, role, scope, assigner};
}

/** Delete the grant; returns it, or null when there is none. */
export async function revoke(grantId: string): Promise<Grant | null> {
  const grant = await byId(grantId);
  if (grant === null) return null;
  await redis.del(\`grant:\${grantId}\`);
  await redis.srem(\`grants:\${grant.subject}\`, grantId);
  return grant;
}

/** The answer recorded for the assignment request (assigner, Idempotency-Key), if any. */
export async function assignment(assigner: string, key: string): Promise<Grant | null> {
  const raw = await redis.get(\`assignment:\${assigner}:\${key}\`);
  return raw === null ? null : (JSON.parse(raw) as Grant);
}

/** Record what the assignment request (assigner, key) answered, for its replays. */
export async function recordAssignment(assigner: string, key: string, result: Grant): Promise<void> {
  await redis.set(\`assignment:\${assigner}:\${key}\`, JSON.stringify(result));
}

export async function outboxRow(rowId: string): Promise<OutboxRow | null> {
  const raw = await redis.hgetall(\`outbox:\${rowId}\`);
  if (Object.keys(raw).length === 0) return null;
  return {
    id: raw.id,
    type: raw.type,
    grant_id: raw.grant_id,
    subject: raw.subject,
    role: raw.role,
    scope: raw.scope,
    grant_version: Number(raw.grant_version),
  };
}

async function commit(kind: string, grant: Grant): Promise<OutboxRow> {
  const n = await redis.commitChange(
    \`grant:\${grant.grant_id}\`,
    \`grants:\${grant.subject}\`,
    VERSION_KEY,
    kind,
    grant.grant_id,
    grant.subject,
    grant.role,
    grant.scope,
    grant.assigner,
  );
  return (await outboxRow(String(n))) as OutboxRow;
}

/** Write a new grant, bump perm:grant_version and append its "granted" outbox row, atomically; returns the row. */
export async function commitGrant(subject: string, role: string, scope: string, assigner: string): Promise<OutboxRow> {
  const grantId = \`g-\${await redis.incr('grant:seq')}\`;
  return commit('granted', {grant_id: grantId, subject, role, scope, assigner});
}

/** Delete the grant, bump perm:grant_version and append its "revoked" outbox row, atomically; returns the row. */
export async function commitRevoke(grantId: string): Promise<OutboxRow | null> {
  const grant = await byId(grantId);
  return grant === null ? null : commit('revoked', grant);
}

/** The outbox rows not yet published, oldest first. */
export async function pending(): Promise<OutboxRow[]> {
  const out: OutboxRow[] = [];
  for (const id of await redis.lrange('outbox:pending', 0, -1)) {
    const row = await outboxRow(id);
    if (row !== null) out.push(row);
  }
  return out;
}

/** The row is on the topic: take it off outbox:pending. */
export async function markSent(rowId: string): Promise<void> {
  await redis.lrem('outbox:pending', 1, rowId);
}
`,
  'permz/cache.ts': `/**
 * The effective-permission cache (provided; step 2 builds the same three functions).
 * perm:{subject}:{scope} is a hash (permissions comma-joined, version) with a 300 s TTL;
 * perm:grant_version is the invalidation clock. A read takes the version first and serves the entry
 * only while its stamp equals it, else derives the set from the grant store and stamps it with the
 * version it read. grantRole and revokeGrant write the grant, then bump the version.
 */
import Redis from 'ioredis';

import {type Grant, add, effective, revoke} from 'permz/grants';

const redis = new Redis({host: 'redis', port: 6379});

export const VERSION_KEY = 'perm:grant_version';
export const CACHE_TTL_S = 300;

export const cacheKey = (subject: string, scope: string): string => \`perm:\${subject}:\${scope}\`;

/** The permissions the subject holds at scope, sorted. */
export async function effectivePermissions(subject: string, scope: string): Promise<string[]> {
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
  await redis.incr(VERSION_KEY);
  return grant;
}

export async function revokeGrant(grantId: string): Promise<Grant | null> {
  const grant = await revoke(grantId);
  if (grant !== null) await redis.incr(VERSION_KEY);
  return grant;
}
`,
};

export const supportModulesGo: Record<string, string> = {
  'permz/catalog/catalog.go': `// Package catalog is the role catalog (provided): the only source of valid roles, the scope kinds
// each may be granted at, and the permissions each confers. Scopes are "org", "team:{team}" and
// "project:{team}/{project}". Covers(held, target) says whether a grant at held reaches target: the
// same scope, "org" over every scope, a team over its own projects.
package catalog

import "strings"

// Role is one catalog entry.
type Role struct {
	ScopeKinds  []string
	Permissions []string
}

// Roles is the catalog.
var Roles = map[string]Role{
	"org_admin":  {ScopeKinds: []string{"org"}, Permissions: []string{"code:write", "org:read", "org:write", "permissions:read_any", "roles:assign", "team:read", "team:write"}},
	"team_admin": {ScopeKinds: []string{"team"}, Permissions: []string{"roles:assign", "team:read", "team:write"}},
	"developer":  {ScopeKinds: []string{"team", "project"}, Permissions: []string{"code:write", "team:read"}},
	"viewer":     {ScopeKinds: []string{"team", "project"}, Permissions: []string{"team:read"}},
}

// ScopeKind is "org", "team" or "project"; "" for a scope the catalog does not define (such as "*").
func ScopeKind(scope string) string {
	if scope == "org" {
		return "org"
	}
	kind, rest, _ := strings.Cut(scope, ":")
	if kind == "team" && rest != "" && !strings.Contains(rest, "/") {
		return "team"
	}
	parts := strings.Split(rest, "/")
	if kind == "project" && len(parts) == 2 && parts[0] != "" && parts[1] != "" {
		return "project"
	}
	return ""
}

// Covers reports whether a grant at held reaches target.
func Covers(held, target string) bool {
	if ScopeKind(held) == "" || ScopeKind(target) == "" {
		return false
	}
	if held == target || held == "org" {
		return true
	}
	return ScopeKind(held) == "team" && strings.HasPrefix(target, "project:"+strings.TrimPrefix(held, "team:")+"/")
}

// PermissionsOf is the permissions role confers, sorted; nil for a role the catalog does not define.
func PermissionsOf(role string) []string {
	return append([]string(nil), Roles[role].Permissions...)
}
`,
  'permz/grants/grants.go': `// Package grants is the grant store (provided), in Redis: grant:{id} is one grant (grant_id,
// subject, role, scope, assigner), grants:{subject} the ids a subject holds,
// assignment:{assigner}:{key} the recorded answer to an assignment request. Add and Revoke write a
// grant and nothing else.
//
// The outbox lives beside it. CommitGrant and CommitRevoke are the full write path: the grant
// change, the bump of perm:grant_version and an outbox row (outbox:{n}: id, type "granted" or
// "revoked", grant_id, subject, role, scope, grant_version) appended to outbox:pending, in one Lua
// script, which is this store's transaction. Pending lists the rows not yet published, oldest
// first; MarkSent takes one off the list.
package grants

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strconv"

	"github.com/redis/go-redis/v9"

	"permz/catalog"
)

// VersionKey is the grant version counter.
const VersionKey = "perm:grant_version"

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

var commit = redis.NewScript(\`
local version = redis.call('INCR', KEYS[3])
if ARGV[1] == 'granted' then
  redis.call('HSET', KEYS[1], 'grant_id', ARGV[2], 'subject', ARGV[3], 'role', ARGV[4], 'scope', ARGV[5], 'assigner', ARGV[6])
  redis.call('SADD', KEYS[2], ARGV[2])
else
  redis.call('DEL', KEYS[1])
  redis.call('SREM', KEYS[2], ARGV[2])
end
local n = redis.call('INCR', 'outbox:seq')
redis.call('HSET', 'outbox:' .. n, 'id', n, 'type', ARGV[1], 'grant_id', ARGV[2], 'subject', ARGV[3], 'role', ARGV[4], 'scope', ARGV[5], 'grant_version', version)
redis.call('RPUSH', 'outbox:pending', n)
return n
\`)

// Grant is one grant.
type Grant struct {
	GrantID  string \`json:"grant_id"\`
	Subject  string \`json:"subject"\`
	Role     string \`json:"role"\`
	Scope    string \`json:"scope"\`
	Assigner string \`json:"assigner"\`
}

// OutboxRow is one outbox row: the event a committed change owes the topic.
type OutboxRow struct {
	ID           string \`json:"id"\`
	Type         string \`json:"type"\`
	GrantID      string \`json:"grant_id"\`
	Subject      string \`json:"subject"\`
	Role         string \`json:"role"\`
	Scope        string \`json:"scope"\`
	GrantVersion int64  \`json:"grant_version"\`
}

// ByID is the grant, or nil.
func ByID(ctx context.Context, grantID string) *Grant {
	raw := rdb.HGetAll(ctx, "grant:"+grantID).Val()
	if len(raw) == 0 {
		return nil
	}
	return &Grant{GrantID: raw["grant_id"], Subject: raw["subject"], Role: raw["role"], Scope: raw["scope"], Assigner: raw["assigner"]}
}

// GrantsOf is every grant the subject holds, oldest first.
func GrantsOf(ctx context.Context, subject string) []Grant {
	ids := rdb.SMembers(ctx, "grants:"+subject).Val()
	number := func(id string) int {
		n, _ := strconv.Atoi(id[2:])
		return n
	}
	sort.Slice(ids, func(i, j int) bool { return number(ids[i]) < number(ids[j]) })
	var out []Grant
	for _, id := range ids {
		if g := ByID(ctx, id); g != nil {
			out = append(out, *g)
		}
	}
	return out
}

// Effective is the permissions the subject holds at scope: those of every grant whose scope covers it, sorted.
func Effective(ctx context.Context, subject, scope string) []string {
	held := map[string]bool{}
	for _, g := range GrantsOf(ctx, subject) {
		if catalog.Covers(g.Scope, scope) {
			for _, p := range catalog.PermissionsOf(g.Role) {
				held[p] = true
			}
		}
	}
	out := []string{}
	for p := range held {
		out = append(out, p)
	}
	sort.Strings(out)
	return out
}

// Add writes a new grant and returns it.
func Add(ctx context.Context, subject, role, scope, assigner string) Grant {
	g := Grant{GrantID: fmt.Sprintf("g-%d", rdb.Incr(ctx, "grant:seq").Val()), Subject: subject, Role: role, Scope: scope, Assigner: assigner}
	rdb.HSet(ctx, "grant:"+g.GrantID, map[string]any{"grant_id": g.GrantID, "subject": subject, "role": role, "scope": scope, "assigner": assigner})
	rdb.SAdd(ctx, "grants:"+subject, g.GrantID)
	return g
}

// Revoke deletes the grant and returns it, or nil when there is none.
func Revoke(ctx context.Context, grantID string) *Grant {
	g := ByID(ctx, grantID)
	if g == nil {
		return nil
	}
	rdb.Del(ctx, "grant:"+grantID)
	rdb.SRem(ctx, "grants:"+g.Subject, grantID)
	return g
}

// Assignment is the answer recorded for the assignment request (assigner, Idempotency-Key), or nil.
func Assignment(ctx context.Context, assigner, key string) *Grant {
	raw, err := rdb.Get(ctx, "assignment:"+assigner+":"+key).Result()
	if err != nil {
		return nil
	}
	var g Grant
	if json.Unmarshal([]byte(raw), &g) != nil {
		return nil
	}
	return &g
}

// RecordAssignment records what the assignment request (assigner, key) answered, for its replays.
func RecordAssignment(ctx context.Context, assigner, key string, result Grant) {
	raw, _ := json.Marshal(result)
	rdb.Set(ctx, "assignment:"+assigner+":"+key, raw, 0)
}

// Row is the outbox row, or nil.
func Row(ctx context.Context, rowID string) *OutboxRow {
	raw := rdb.HGetAll(ctx, "outbox:"+rowID).Val()
	if len(raw) == 0 {
		return nil
	}
	version, _ := strconv.ParseInt(raw["grant_version"], 10, 64)
	return &OutboxRow{ID: raw["id"], Type: raw["type"], GrantID: raw["grant_id"], Subject: raw["subject"], Role: raw["role"], Scope: raw["scope"], GrantVersion: version}
}

func commitChange(ctx context.Context, kind string, g Grant) (*OutboxRow, error) {
	keys := []string{"grant:" + g.GrantID, "grants:" + g.Subject, VersionKey}
	n, err := commit.Run(ctx, rdb, keys, kind, g.GrantID, g.Subject, g.Role, g.Scope, g.Assigner).Int64()
	if err != nil {
		return nil, err
	}
	return Row(ctx, strconv.FormatInt(n, 10)), nil
}

// CommitGrant writes a new grant, bumps perm:grant_version and appends its "granted" outbox row, atomically; it returns the row.
func CommitGrant(ctx context.Context, subject, role, scope, assigner string) (*OutboxRow, error) {
	g := Grant{GrantID: fmt.Sprintf("g-%d", rdb.Incr(ctx, "grant:seq").Val()), Subject: subject, Role: role, Scope: scope, Assigner: assigner}
	return commitChange(ctx, "granted", g)
}

// CommitRevoke deletes the grant, bumps perm:grant_version and appends its "revoked" outbox row, atomically; it returns the row (nil when there is no such grant).
func CommitRevoke(ctx context.Context, grantID string) (*OutboxRow, error) {
	g := ByID(ctx, grantID)
	if g == nil {
		return nil, nil
	}
	return commitChange(ctx, "revoked", *g)
}

// Pending is the outbox rows not yet published, oldest first.
func Pending(ctx context.Context) []OutboxRow {
	var out []OutboxRow
	for _, id := range rdb.LRange(ctx, "outbox:pending", 0, -1).Val() {
		if row := Row(ctx, id); row != nil {
			out = append(out, *row)
		}
	}
	return out
}

// MarkSent takes a row that is on the topic off outbox:pending.
func MarkSent(ctx context.Context, rowID string) {
	rdb.LRem(ctx, "outbox:pending", 1, rowID)
}
`,
  'permz/cache/cache.go': `// Package cache is the effective-permission cache (provided; step 2 builds the same three
// functions). perm:{subject}:{scope} is a hash (permissions comma-joined, version) with a 300 s
// TTL; perm:grant_version is the invalidation clock. A read takes the version first and serves the
// entry only while its stamp equals it, else derives the set from the grant store and stamps it
// with the version it read. GrantRole and RevokeGrant write the grant, then bump the version.
package cache

import (
	"context"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"

	"permz/grants"
)

const (
	versionKey = "perm:grant_version"
	cacheTTL   = 300 * time.Second
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// CacheKey is the entry of (subject, scope).
func CacheKey(subject, scope string) string { return "perm:" + subject + ":" + scope }

// EffectivePermissions is the permissions the subject holds at scope, sorted.
func EffectivePermissions(ctx context.Context, subject, scope string) []string {
	version, err := rdb.Get(ctx, versionKey).Result()
	if err != nil {
		version = "0"
	}
	entry := rdb.HGetAll(ctx, CacheKey(subject, scope)).Val()
	if stamp, ok := entry["version"]; ok && stamp == version {
		if entry["permissions"] == "" {
			return []string{}
		}
		return strings.Split(entry["permissions"], ",")
	}
	permissions := grants.Effective(ctx, subject, scope)
	rdb.HSet(ctx, CacheKey(subject, scope), map[string]any{"permissions": strings.Join(permissions, ","), "version": version})
	rdb.Expire(ctx, CacheKey(subject, scope), cacheTTL)
	return permissions
}

// GrantRole writes the grant, then bumps the version.
func GrantRole(ctx context.Context, subject, role, scope, assigner string) grants.Grant {
	g := grants.Add(ctx, subject, role, scope, assigner)
	rdb.Incr(ctx, versionKey)
	return g
}

// RevokeGrant deletes the grant, then bumps the version; nil when there is no such grant.
func RevokeGrant(ctx context.Context, grantID string) *grants.Grant {
	g := grants.Revoke(ctx, grantID)
	if g != nil {
		rdb.Incr(ctx, versionKey)
	}
	return g
}
`,
};

export const supportModulesCpp: Record<string, string> = {
  'permz/catalog.h': `// The role catalog (provided): the only source of valid roles, the scope kinds each may be granted
// at, and the permissions each confers. Scopes are "org", "team:{team}" and
// "project:{team}/{project}". covers(held, target) says whether a grant at held reaches target: the
// same scope, "org" over every scope, a team over its own projects.
#pragma once

#include <map>
#include <string>
#include <vector>

namespace catalog {

struct Role {
  std::vector<std::string> scope_kinds;
  std::vector<std::string> permissions;
};

inline const std::map<std::string, Role> kRoles = {
    {"org_admin", {{"org"}, {"code:write", "org:read", "org:write", "permissions:read_any", "roles:assign", "team:read", "team:write"}}},
    {"team_admin", {{"team"}, {"roles:assign", "team:read", "team:write"}}},
    {"developer", {{"team", "project"}, {"code:write", "team:read"}}},
    {"viewer", {{"team", "project"}, {"team:read"}}},
};

// "org", "team" or "project"; "" for a scope the catalog does not define (such as "*").
inline std::string scopeKind(const std::string& scope) {
  if (scope == "org") return "org";
  const size_t colon = scope.find(':');
  if (colon == std::string::npos) return "";
  const std::string kind = scope.substr(0, colon);
  const std::string rest = scope.substr(colon + 1);
  const size_t slash = rest.find('/');
  if (kind == "team" && !rest.empty() && slash == std::string::npos) return "team";
  if (kind == "project" && slash != std::string::npos && slash > 0 && slash + 1 < rest.size() &&
      rest.find('/', slash + 1) == std::string::npos) {
    return "project";
  }
  return "";
}

// Whether a grant at held reaches target.
inline bool covers(const std::string& held, const std::string& target) {
  if (scopeKind(held).empty() || scopeKind(target).empty()) return false;
  if (held == target || held == "org") return true;
  const std::string prefix = "project:" + held.substr(std::string("team:").size()) + "/";
  return scopeKind(held) == "team" && target.compare(0, prefix.size(), prefix) == 0;
}

// The permissions role confers, sorted; empty for a role the catalog does not define.
inline std::vector<std::string> permissionsOf(const std::string& role) {
  const auto it = kRoles.find(role);
  return it == kRoles.end() ? std::vector<std::string>{} : it->second.permissions;
}

}  // namespace catalog
`,
  'permz/grants.h': `// The grant store (provided), in Redis: grant:{id} is one grant (grant_id, subject, role, scope,
// assigner), grants:{subject} the ids a subject holds, assignment:{assigner}:{key} the recorded
// answer to an assignment request. add and revoke write a grant and nothing else.
//
// The outbox lives beside it. commitGrant and commitRevoke are the full write path: the grant
// change, the bump of perm:grant_version and an outbox row (outbox:{n}: id, type "granted" or
// "revoked", grant_id, subject, role, scope, grant_version) appended to outbox:pending, in one Lua
// script, which is this store's transaction. pending lists the rows not yet published, oldest
// first; markSent takes one off the list.
#pragma once

#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <algorithm>
#include <optional>
#include <set>
#include <string>
#include <unordered_map>
#include <vector>

#include "permz/catalog.h"

namespace grants {

inline const std::string kVersionKey = "perm:grant_version";

inline const std::string kCommitLua = R"lua(
local version = redis.call('INCR', KEYS[3])
if ARGV[1] == 'granted' then
  redis.call('HSET', KEYS[1], 'grant_id', ARGV[2], 'subject', ARGV[3], 'role', ARGV[4], 'scope', ARGV[5], 'assigner', ARGV[6])
  redis.call('SADD', KEYS[2], ARGV[2])
else
  redis.call('DEL', KEYS[1])
  redis.call('SREM', KEYS[2], ARGV[2])
end
local n = redis.call('INCR', 'outbox:seq')
redis.call('HSET', 'outbox:' .. n, 'id', n, 'type', ARGV[1], 'grant_id', ARGV[2], 'subject', ARGV[3], 'role', ARGV[4], 'scope', ARGV[5], 'grant_version', version)
redis.call('RPUSH', 'outbox:pending', n)
return n
)lua";

struct Grant {
  std::string grant_id;
  std::string subject;
  std::string role;
  std::string scope;
  std::string assigner;
};

// One outbox row: the event a committed change owes the topic.
struct OutboxRow {
  std::string id;
  std::string type;
  std::string grant_id;
  std::string subject;
  std::string role;
  std::string scope;
  long long grant_version = 0;
};

inline nlohmann::json toJson(const Grant& g) {
  return nlohmann::json{{"grant_id", g.grant_id}, {"subject", g.subject}, {"role", g.role}, {"scope", g.scope}, {"assigner", g.assigner}};
}

inline sw::redis::Redis& redis() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

// The grant, or none.
inline std::optional<Grant> byId(const std::string& grant_id) {
  const std::unordered_map<std::string, std::string> raw = redis().hgetall("grant:" + grant_id);
  if (raw.empty()) return std::nullopt;
  const auto text = [&raw](const char* name) { return raw.count(name) ? raw.at(name) : std::string(); };
  return Grant{text("grant_id"), text("subject"), text("role"), text("scope"), text("assigner")};
}

// Every grant the subject holds, oldest first.
inline std::vector<Grant> grantsOf(const std::string& subject) {
  std::vector<std::string> ids = redis().smembers("grants:" + subject);
  std::sort(ids.begin(), ids.end(), [](const std::string& a, const std::string& b) { return std::stol(a.substr(2)) < std::stol(b.substr(2)); });
  std::vector<Grant> out;
  for (const std::string& id : ids) {
    if (const auto g = byId(id)) out.push_back(*g);
  }
  return out;
}

// The permissions the subject holds at scope: those of every grant whose scope covers it, sorted.
inline std::vector<std::string> effective(const std::string& subject, const std::string& scope) {
  std::set<std::string> held;
  for (const Grant& g : grantsOf(subject)) {
    if (!catalog::covers(g.scope, scope)) continue;
    for (const std::string& p : catalog::permissionsOf(g.role)) held.insert(p);
  }
  return std::vector<std::string>(held.begin(), held.end());
}

// Write a new grant; returns it.
inline Grant add(const std::string& subject, const std::string& role, const std::string& scope, const std::string& assigner) {
  const Grant g{"g-" + std::to_string(redis().incr("grant:seq")), subject, role, scope, assigner};
  redis().hset("grant:" + g.grant_id, {{"grant_id", g.grant_id}, {"subject", subject}, {"role", role}, {"scope", scope}, {"assigner", assigner}});
  redis().sadd("grants:" + subject, g.grant_id);
  return g;
}

// Delete the grant; returns it, or none when there is none.
inline std::optional<Grant> revoke(const std::string& grant_id) {
  const auto g = byId(grant_id);
  if (!g) return std::nullopt;
  redis().del("grant:" + grant_id);
  redis().srem("grants:" + g->subject, grant_id);
  return g;
}

// The answer recorded for the assignment request (assigner, Idempotency-Key), if any.
inline std::optional<Grant> assignment(const std::string& assigner, const std::string& key) {
  const auto raw = redis().get("assignment:" + assigner + ":" + key);
  if (!raw) return std::nullopt;
  const nlohmann::json j = nlohmann::json::parse(*raw);
  return Grant{j.value("grant_id", ""), j.value("subject", ""), j.value("role", ""), j.value("scope", ""), j.value("assigner", "")};
}

// Record what the assignment request (assigner, key) answered, for its replays.
inline void recordAssignment(const std::string& assigner, const std::string& key, const Grant& result) {
  redis().set("assignment:" + assigner + ":" + key, toJson(result).dump());
}

// The outbox row, or none.
inline std::optional<OutboxRow> outboxRow(const std::string& row_id) {
  const std::unordered_map<std::string, std::string> raw = redis().hgetall("outbox:" + row_id);
  if (raw.empty()) return std::nullopt;
  const auto text = [&raw](const char* name) { return raw.count(name) ? raw.at(name) : std::string(); };
  return OutboxRow{text("id"), text("type"), text("grant_id"), text("subject"), text("role"), text("scope"), std::stoll(text("grant_version"))};
}

inline OutboxRow commitChange(const std::string& kind, const Grant& g) {
  const long long n = redis().eval<long long>(kCommitLua, {"grant:" + g.grant_id, "grants:" + g.subject, kVersionKey},
                                              {kind, g.grant_id, g.subject, g.role, g.scope, g.assigner});
  return *outboxRow(std::to_string(n));
}

// Write a new grant, bump perm:grant_version and append its "granted" outbox row, atomically; returns the row.
inline OutboxRow commitGrant(const std::string& subject, const std::string& role, const std::string& scope, const std::string& assigner) {
  return commitChange("granted", Grant{"g-" + std::to_string(redis().incr("grant:seq")), subject, role, scope, assigner});
}

// Delete the grant, bump perm:grant_version and append its "revoked" outbox row, atomically; returns the row.
inline std::optional<OutboxRow> commitRevoke(const std::string& grant_id) {
  const auto g = byId(grant_id);
  if (!g) return std::nullopt;
  return commitChange("revoked", *g);
}

// The outbox rows not yet published, oldest first.
inline std::vector<OutboxRow> pending() {
  std::vector<OutboxRow> out;
  for (const std::string& id : redis().lrange("outbox:pending", 0, -1)) {
    if (const auto row = outboxRow(id)) out.push_back(*row);
  }
  return out;
}

// The row is on the topic: take it off outbox:pending.
inline void markSent(const std::string& row_id) { redis().lrem("outbox:pending", 1, row_id); }

}  // namespace grants
`,
  'permz/cache.h': `// The effective-permission cache (provided; step 2 builds the same three functions).
// perm:{subject}:{scope} is a hash (permissions comma-joined, version) with a 300 s TTL;
// perm:grant_version is the invalidation clock. A read takes the version first and serves the
// entry only while its stamp equals it, else derives the set from the grant store and stamps it
// with the version it read. grantRole and revokeGrant write the grant, then bump the version.
#pragma once

#include <sw/redis++/redis++.h>

#include <optional>
#include <sstream>
#include <string>
#include <unordered_map>
#include <vector>

#include "permz/grants.h"

namespace cache {

inline const std::string kVersionKey = "perm:grant_version";
constexpr long long kCacheTtlS = 300;

inline sw::redis::Redis& redis() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

inline std::string cacheKey(const std::string& subject, const std::string& scope) { return "perm:" + subject + ":" + scope; }

// The permissions the subject holds at scope, sorted.
inline std::vector<std::string> effectivePermissions(const std::string& subject, const std::string& scope) {
  const std::string version = redis().get(kVersionKey).value_or("0");
  const std::unordered_map<std::string, std::string> entry = redis().hgetall(cacheKey(subject, scope));
  if (entry.count("version") && entry.at("version") == version) {
    std::vector<std::string> out;
    std::stringstream joined(entry.count("permissions") ? entry.at("permissions") : "");
    for (std::string p; std::getline(joined, p, ',');) out.push_back(p);
    return out;
  }
  const std::vector<std::string> permissions = grants::effective(subject, scope);
  std::string joined;
  for (const std::string& p : permissions) joined += (joined.empty() ? "" : ",") + p;
  redis().hset(cacheKey(subject, scope), {{"permissions", joined}, {"version", version}});
  redis().expire(cacheKey(subject, scope), kCacheTtlS);
  return permissions;
}

inline grants::Grant grantRole(const std::string& subject, const std::string& role, const std::string& scope, const std::string& assigner) {
  const grants::Grant g = grants::add(subject, role, scope, assigner);
  redis().incr(kVersionKey);
  return g;
}

inline std::optional<grants::Grant> revokeGrant(const std::string& grant_id) {
  const auto g = grants::revoke(grant_id);
  if (g) redis().incr(kVersionKey);
  return g;
}

}  // namespace cache
`,
};

export const supportModulesScala: Record<string, string> = {
  [scalaPath('permz', 'Catalog')]: `package permz

/**
 * The role catalog (provided): the only source of valid roles, the scope kinds each may be granted
 * at, and the permissions each confers. Scopes are "org", "team:{team}" and
 * "project:{team}/{project}". covers(held, target) says whether a grant at held reaches target: the
 * same scope, "org" over every scope, a team over its own projects.
 */
object Catalog {
  final case class Role(scopeKinds: Seq[String], permissions: Seq[String])

  val Roles: Map[String, Role] = Map(
    "org_admin" -> Role(Seq("org"), Seq("code:write", "org:read", "org:write", "permissions:read_any", "roles:assign", "team:read", "team:write")),
    "team_admin" -> Role(Seq("team"), Seq("roles:assign", "team:read", "team:write")),
    "developer" -> Role(Seq("team", "project"), Seq("code:write", "team:read")),
    "viewer" -> Role(Seq("team", "project"), Seq("team:read"))
  )

  /** "org", "team" or "project"; "" for a scope the catalog does not define (such as "*"). */
  def scopeKind(scope: String): String =
    if (scope == "org") "org"
    else
      scope.split(":", 2) match {
        case Array("team", rest) if rest.nonEmpty && !rest.contains("/") => "team"
        case Array("project", rest) if rest.split("/", -1).length == 2 && rest.split("/", -1).forall(_.nonEmpty) => "project"
        case _ => ""
      }

  /** Whether a grant at held reaches target. */
  def covers(held: String, target: String): Boolean =
    if (scopeKind(held).isEmpty || scopeKind(target).isEmpty) false
    else if (held == target || held == "org") true
    else scopeKind(held) == "team" && target.startsWith(s"project:\${held.stripPrefix("team:")}/")

  /** The permissions role confers, sorted; empty for a role the catalog does not define. */
  def permissionsOf(role: String): Seq[String] = Roles.get(role).map(_.permissions).getOrElse(Seq.empty)
}
`,
  [scalaPath('permz', 'Grants')]: `package permz

import redis.clients.jedis.JedisPooled
import spray.json._

import scala.jdk.CollectionConverters._

/**
 * The grant store (provided), in Redis: grant:{id} is one grant (grant_id, subject, role, scope,
 * assigner), grants:{subject} the ids a subject holds, assignment:{assigner}:{key} the recorded
 * answer to an assignment request. add and revoke write a grant and nothing else.
 *
 * The outbox lives beside it. commitGrant and commitRevoke are the full write path: the grant
 * change, the bump of perm:grant_version and an outbox row (outbox:{n}: id, type "granted" or
 * "revoked", grant_id, subject, role, scope, grant_version) appended to outbox:pending, in one Lua
 * script, which is this store's transaction. pending lists the rows not yet published, oldest
 * first; markSent takes one off the list.
 */
object Grants {
  final case class Grant(grantId: String, subject: String, role: String, scope: String, assigner: String) {
    def toJson: JsObject = JsObject(
      "grant_id" -> JsString(grantId), "subject" -> JsString(subject), "role" -> JsString(role),
      "scope" -> JsString(scope), "assigner" -> JsString(assigner))
  }

  final case class OutboxRow(id: String, kind: String, grantId: String, subject: String, role: String, scope: String, grantVersion: Long)

  val VersionKey = "perm:grant_version"

  val jedis = new JedisPooled("redis", 6379)

  val CommitLua: String =
    """local version = redis.call('INCR', KEYS[3])
      |if ARGV[1] == 'granted' then
      |  redis.call('HSET', KEYS[1], 'grant_id', ARGV[2], 'subject', ARGV[3], 'role', ARGV[4], 'scope', ARGV[5], 'assigner', ARGV[6])
      |  redis.call('SADD', KEYS[2], ARGV[2])
      |else
      |  redis.call('DEL', KEYS[1])
      |  redis.call('SREM', KEYS[2], ARGV[2])
      |end
      |local n = redis.call('INCR', 'outbox:seq')
      |redis.call('HSET', 'outbox:' .. n, 'id', n, 'type', ARGV[1], 'grant_id', ARGV[2], 'subject', ARGV[3], 'role', ARGV[4], 'scope', ARGV[5], 'grant_version', version)
      |redis.call('RPUSH', 'outbox:pending', n)
      |return n
      |""".stripMargin

  /** The grant, if it exists. */
  def byId(grantId: String): Option[Grant] = {
    val raw = jedis.hgetAll(s"grant:$grantId").asScala
    if (raw.isEmpty) None
    else Some(Grant(raw("grant_id"), raw("subject"), raw("role"), raw("scope"), raw.getOrElse("assigner", "")))
  }

  /** Every grant the subject holds, oldest first. */
  def grantsOf(subject: String): Seq[Grant] =
    jedis.smembers(s"grants:$subject").asScala.toSeq.sortBy(_.drop(2).toLong).flatMap(byId)

  /** The permissions the subject holds at scope: those of every grant whose scope covers it, sorted. */
  def effective(subject: String, scope: String): Seq[String] =
    grantsOf(subject).filter(g => Catalog.covers(g.scope, scope)).flatMap(g => Catalog.permissionsOf(g.role)).distinct.sorted

  /** Write a new grant; returns it. */
  def add(subject: String, role: String, scope: String, assigner: String): Grant = {
    val grant = Grant(s"g-\${jedis.incr("grant:seq")}", subject, role, scope, assigner)
    jedis.hset(s"grant:\${grant.grantId}", Map("grant_id" -> grant.grantId, "subject" -> subject, "role" -> role, "scope" -> scope, "assigner" -> assigner).asJava)
    jedis.sadd(s"grants:$subject", grant.grantId)
    grant
  }

  /** Delete the grant; returns it, or None when there is none. */
  def revoke(grantId: String): Option[Grant] = byId(grantId).map { grant =>
    jedis.del(s"grant:$grantId")
    jedis.srem(s"grants:\${grant.subject}", grantId)
    grant
  }

  /** The answer recorded for the assignment request (assigner, Idempotency-Key), if any. */
  def assignment(assigner: String, key: String): Option[Grant] =
    Option(jedis.get(s"assignment:$assigner:$key")).map(_.parseJson.asJsObject.fields).map { f =>
      def text(name: String): String = f.get(name).collect { case JsString(s) => s }.getOrElse("")
      Grant(text("grant_id"), text("subject"), text("role"), text("scope"), text("assigner"))
    }

  /** Record what the assignment request (assigner, key) answered, for its replays. */
  def recordAssignment(assigner: String, key: String, result: Grant): Unit =
    jedis.set(s"assignment:$assigner:$key", result.toJson.compactPrint)

  /** The outbox row, if it exists. */
  def outboxRow(rowId: String): Option[OutboxRow] = {
    val raw = jedis.hgetAll(s"outbox:$rowId").asScala
    if (raw.isEmpty) None
    else Some(OutboxRow(raw("id"), raw("type"), raw("grant_id"), raw("subject"), raw("role"), raw("scope"), raw("grant_version").toLong))
  }

  private def commit(kind: String, grant: Grant): OutboxRow = {
    val keys = List(s"grant:\${grant.grantId}", s"grants:\${grant.subject}", VersionKey).asJava
    val args = List(kind, grant.grantId, grant.subject, grant.role, grant.scope, grant.assigner).asJava
    val n = jedis.eval(CommitLua, keys, args).asInstanceOf[java.lang.Long]
    outboxRow(n.toString).get
  }

  /** Write a new grant, bump perm:grant_version and append its "granted" outbox row, atomically; returns the row. */
  def commitGrant(subject: String, role: String, scope: String, assigner: String): OutboxRow =
    commit("granted", Grant(s"g-\${jedis.incr("grant:seq")}", subject, role, scope, assigner))

  /** Delete the grant, bump perm:grant_version and append its "revoked" outbox row, atomically; returns the row. */
  def commitRevoke(grantId: String): Option[OutboxRow] = byId(grantId).map(commit("revoked", _))

  /** The outbox rows not yet published, oldest first. */
  def pending(): Seq[OutboxRow] = jedis.lrange("outbox:pending", 0, -1).asScala.toSeq.flatMap(outboxRow)

  /** The row is on the topic: take it off outbox:pending. */
  def markSent(rowId: String): Unit = jedis.lrem("outbox:pending", 1, rowId)
}
`,
  [scalaPath('permz', 'Cache')]: `package permz

import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

/**
 * The effective-permission cache (provided; step 2 builds the same three functions).
 * perm:{subject}:{scope} is a hash (permissions comma-joined, version) with a 300 s TTL;
 * perm:grant_version is the invalidation clock. A read takes the version first and serves the entry
 * only while its stamp equals it, else derives the set from the grant store and stamps it with the
 * version it read. grantRole and revokeGrant write the grant, then bump the version.
 */
object Cache {
  val VersionKey = "perm:grant_version"
  val CacheTtlS = 300L

  val jedis = new JedisPooled("redis", 6379)

  def cacheKey(subject: String, scope: String): String = s"perm:$subject:$scope"

  /** The permissions the subject holds at scope, sorted. */
  def effectivePermissions(subject: String, scope: String): Seq[String] = {
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
    jedis.incr(VersionKey)
    grant
  }

  def revokeGrant(grantId: String): Option[Grants.Grant] = {
    val grant = Grants.revoke(grantId)
    if (grant.isDefined) jedis.incr(VersionKey)
    grant
  }
}
`,
};
