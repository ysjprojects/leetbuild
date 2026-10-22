import type {Step} from '@/lib/types';

export const readStep: Step = {
  id: 'read',
  title: 'GET /v1/users/{id}/permissions: an explanation, not a blob',
  concept: 'http',
  file: 'read',
  focus: ['client', 'api', 'redis', 'engine'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it registers the read, merges
every permission the subject holds into one list, caches that list for 600 seconds and answers. It
compiles, it serves the demo, and it hides three production flaws — no provenance, a cache a
revocation cannot invalidate, and no check on who is asking. Review it like the service owner, fix
it, and prove the fix with the checks below.

Implement \`GET /v1/users/{id}/permissions\` and \`POST /v1/permissions/check\`.

- The caller comes from the authenticated \`X-Caller-Id\` header; a missing one is **401**. A caller
  reads only its own permissions: \`X-Caller-Id\` must equal \`{id}\` unless it holds
  \`permissions:read:any\`, the audit permission the policy engine decides on — a denial is **403**,
  and a foreign read never returns another subject's entries.
- The read returns an explanation, never a merged blob: every entry is
  \`{"permission": "team:read", "granted_by": [{"role_id": "team_admin", "scope": "team:eng", "grant_id": "g-17"}]}\`.
  A permission produced by two grants lists both derivations, in a deterministic order.
- \`POST /v1/permissions/check\` takes \`{"subject": "user:ada", "permission": "team:read", "scope": "team:eng"}\`
  and answers the same computation live, so the list and the check agree bit-for-bit: a revoked
  permission is absent from the list and denied by the check in the same pass. A derivation's scope
  covers the asked scope only when it is the same scope, \`org\`, or a broader kind — a grant at
  \`team:eng\` never answers for \`org\`.
- The read is served from the version-stamped cache: the entry's \`grant_version\` is compared with the
  current one and the entry is recomputed from the grant store whenever they differ, so a cached list
  cannot outlive a revocation. A 600-second TTL is not a correctness mechanism.
- Respond \`{"subject": …, "grant_version": …, "permissions": […]}\`, and log the subject, the caller
  and the entry count — never the subject's permission set itself.

**Failure mode the checks target.** A merged permission list is unfalsifiable: it cannot answer *who
granted this?*, which is the question every access review and every incident starts with — so the
derivation has to come out of the same fold that decides the answer, and the read and the live check
have to be one function, because two code paths drift and then the console says *allowed* while the
enforcement point says *denied*. A 600-second cache is a promise that a revoked contractor keeps
access for up to ten minutes; only a version stamp makes a revocation immediate. And a permissions
read is the map of everything a subject can do — without the ownership check, any authenticated
caller enumerates any user's access with one request.`,
  sequence: {
    participants: ['Client', 'Permission Service', 'Redis', 'Policy engine', 'Grant store'],
    messages: [
      {from: 'Client', to: 'Permission Service', label: 'GET /v1/users/{id}/permissions · X-Caller-Id', kind: 'sync'},
      {
        from: 'Permission Service',
        to: 'Permission Service',
        label: 'ownership check: X-Caller-Id == {id}?',
        kind: 'sync',
      },
      {from: 'Permission Service', to: 'Policy engine', label: 'permissions:read:any for a foreign id', kind: 'sync'},
      {from: 'Policy engine', to: 'Permission Service', label: 'deny → 403 · allow → continue', kind: 'reply'},
      {from: 'Permission Service', to: 'Redis', label: 'GET perms:{id} · entry + grant_version', kind: 'sync'},
      {from: 'Redis', to: 'Permission Service', label: 'current entry / stale entry / miss', kind: 'reply'},
      {from: 'Permission Service', to: 'Grant store', label: 'grant_version() · grants({id}) when stale', kind: 'sync'},
      {from: 'Grant store', to: 'Permission Service', label: 'role_id, scope, grant_id, permissions', kind: 'reply'},
      {
        from: 'Permission Service',
        to: 'Permission Service',
        label: 'attach granted_by to each permission',
        kind: 'sync',
      },
      {from: 'Permission Service', to: 'Redis', label: 'SET perms:{id} · stamped with grant_version', kind: 'async'},
      {from: 'Permission Service', to: 'Client', label: '200 {permission, granted_by[]}', kind: 'reply'},
      {from: 'Client', to: 'Permission Service', label: 'POST /v1/permissions/check · same subject', kind: 'sync'},
      {
        from: 'Permission Service',
        to: 'Grant store',
        label: 'effective_permissions({id}) live · no cache',
        kind: 'sync',
      },
      {from: 'Permission Service', to: 'Client', label: 'allowed · identical to the list', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Handles GET /v1/users/{id}/permissions',
      detail: 'Register the effective-permissions read on `GET /v1/users/{id}/permissions`.',
      match: {
        python: {all: [/@app\.get\(\s*["']\/v1\/users\/\{id\}\/permissions["']/]},
        typescript: {all: [/app\.get\(\s*['"]\/v1\/users\/:id\/permissions['"]/]},
        go: {all: [/HandleFunc\(\s*"GET \/v1\/users\/\{id\}\/permissions"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"users"\s*\/\s*Segment\s*\/\s*"permissions"\s*\)/, /\bget\s*\{/]},
        cpp: {all: [/svr\.Get\(\s*R"\(\/v1\/users\/\(\\d\+\)\/permissions\)"/]},
      },
    },
    {
      id: 'provenance',
      title: 'Every permission carries its derivation',
      detail:
        'Each entry names the roles and grants that produce it in `granted_by`, instead of a bare merged set. The draft returns the merged permissions with no provenance at all.',
      match: {
        python: {all: [/granted_by/, /def explain_permissions\(/]},
        typescript: {all: [/granted_by/, /function explainPermissions\(/]},
        go: {all: [/granted_by/, /func explainPermissions\(/]},
        scala: {all: [/granted_by/, /def explainPermissions\(/]},
        cpp: {all: [/granted_by/, /explainPermissions\(/]},
      },
    },
    {
      id: 'live-parity',
      title: 'The list and the live check share one computation',
      detail:
        '`POST /v1/permissions/check` and the read both call the same `effective_permissions` computation, so a revoked permission is absent from the list and denied by the check in the same pass. The draft has no check endpoint at all.',
      match: {
        python: {all: [/effective_permissions\(/, /@app\.post\(\s*["']\/v1\/permissions\/check["']/]},
        typescript: {all: [/effectivePermissions\(/, /app\.post\(\s*['"]\/v1\/permissions\/check['"]/]},
        go: {all: [/effectivePermissions\(/, /"POST \/v1\/permissions\/check"/]},
        scala: {all: [/effectivePermissions\(/, /path\(\s*"v1"\s*\/\s*"permissions"\s*\/\s*"check"\s*\)/]},
        cpp: {all: [/effectivePermissions\(/, /svr\.Post\(\s*"\/v1\/permissions\/check"/]},
      },
    },
    {
      id: 'fresh-cache',
      title: 'Serves only cache entries that match the grant version',
      detail:
        'The read is served from the version-stamped cache and recomputes when the entry’s version differs from the current `grant_version`, so the list cannot outlive a revocation. The draft serves a 600-second cache with no version at all.',
      match: {
        python: {all: [/cache_is_current\(/, /grant_version/]},
        typescript: {all: [/cacheIsCurrent\(/, /grant_version/]},
        go: {all: [/cacheIsCurrent\(/, /grant_version/]},
        scala: {all: [/cacheIsCurrent\(/, /grant_version/]},
        cpp: {all: [/cacheIsCurrent\(/, /grant_version/]},
      },
    },
    {
      id: 'foreign-403',
      title: 'Refuses to read another subject without the audit permission',
      detail:
        'A caller may read only its own permissions unless it holds `permissions:read:any`; a foreign `id` is `403`. The draft answers for any caller, so one subject can enumerate another’s access.',
      match: {
        python: {all: [/permissions:read:any/, /status_code\s*=\s*403/]},
        typescript: {all: [/permissions:read:any/, /code\(\s*403\s*\)/]},
        go: {all: [/permissions:read:any/, /StatusForbidden/]},
        scala: {all: [/permissions:read:any/, /StatusCodes\.Forbidden/]},
        cpp: {all: [/permissions:read:any/, /\b403\b/]},
      },
    },
  ],
  code: {
    python: {
      starter: `"""GET /v1/users/{id}/permissions: a model-generated draft that returns a merged blob."""
import json
import logging

import redis
from fastapi import FastAPI, Header
from fastapi.responses import JSONResponse

app = FastAPI()
logger = logging.getLogger("permz")
r = redis.Redis(host="redis", port=6379, decode_responses=True)

CACHE_TTL_S = 600


class GrantStore:
    def permissions(self, subject: str) -> list[str]:
        """Every permission the subject holds, merged across roles and scopes."""
        raise NotImplementedError


store = GrantStore()


@app.get("/v1/users/{id}/permissions")
def read_permissions(id: str, caller: str = Header(alias="X-Caller-Id")) -> JSONResponse:
    # TODO: this draft returns the merged permission list with no provenance, serves it from a 600 s
    # cache with no version stamp, and never compares X-Caller-Id with {id}. Review all three.
    key = f"perms:{id}"
    cached = r.get(key)
    if cached is not None:
        return JSONResponse({"subject": id, "permissions": json.loads(cached)}, status_code=200)
    permissions = sorted(store.permissions(id))
    r.set(key, json.dumps(permissions), ex=CACHE_TTL_S)
    logger.info("permissions id=%s caller=%s count=%d", id, caller, len(permissions))
    return JSONResponse({"subject": id, "permissions": permissions}, status_code=200)
`,
      solution: `"""GET /v1/users/{id}/permissions: an explanation, and the live check that agrees with it."""
import json
import logging

import redis
from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()
logger = logging.getLogger("permz")
r = redis.Redis(host="redis", port=6379, decode_responses=True)

AUDIT_PERMISSION = "permissions:read:any"
SCOPE_RANK = {"org": 0, "team": 1, "project": 2}


class CheckRequest(BaseModel):
    subject: str
    permission: str
    scope: str


class GrantStore:
    def grants(self, subject: str) -> list[dict]:
        """The subject's grants: grant_id, role_id, scope, permissions."""
        raise NotImplementedError

    def grant_version(self) -> int:
        """The global grant version; every assignment change bumps it."""
        raise NotImplementedError


class PolicyEngine:
    def allow(self, caller: str, permission: str, scope: str) -> bool:
        """Deny when the engine cannot verify: an outage must never widen access."""
        raise NotImplementedError


store = GrantStore()
engine = PolicyEngine()


def scope_covers(held: str, target: str) -> bool:
    if held == target or held == "org":
        return True
    held_kind, target_kind = held.split(":", 1)[0], target.split(":", 1)[0]
    return SCOPE_RANK.get(held_kind, 9) < SCOPE_RANK.get(target_kind, -1)


def effective_permissions(subject: str) -> list[dict]:
    """One entry per permission, carrying the roles and grants that produce it."""
    by_permission: dict[str, list[dict]] = {}
    for grant in store.grants(subject):
        for permission in grant["permissions"]:
            by_permission.setdefault(permission, []).append(
                {"role_id": grant["role_id"], "scope": grant["scope"], "grant_id": grant["grant_id"]}
            )
    return [{"permission": p, "granted_by": by_permission[p]} for p in sorted(by_permission)]


def cache_is_current(entry: dict | None, version: int) -> bool:
    return entry is not None and entry["grant_version"] == version


def explain_permissions(subject: str) -> dict:
    """The version-stamped cache: an entry survives only while its grant_version is current."""
    version = store.grant_version()
    cached = r.get(f"perms:{subject}")
    entry = json.loads(cached) if cached is not None else None
    if not cache_is_current(entry, version):
        entry = {"grant_version": version, "entries": effective_permissions(subject)}
        r.set(f"perms:{subject}", json.dumps(entry))
    return {"subject": subject, "grant_version": version, "permissions": entry["entries"]}


def guard(caller: str | None, subject: str) -> None:
    if not caller:
        raise HTTPException(status_code=401, detail="missing X-Caller-Id")
    if caller != subject and not engine.allow(caller, AUDIT_PERMISSION, "org"):
        raise HTTPException(status_code=403, detail="needs permissions:read:any")


@app.get("/v1/users/{id}/permissions")
def read_permissions(id: str, caller: str | None = Header(default=None, alias="X-Caller-Id")) -> JSONResponse:
    guard(caller, id)
    body = explain_permissions(id)
    logger.info("permissions id=%s caller=%s permissions=%d", id, caller, len(body["permissions"]))
    return JSONResponse(body, status_code=200)


@app.post("/v1/permissions/check")
def check(body: CheckRequest, caller: str | None = Header(default=None, alias="X-Caller-Id")) -> JSONResponse:
    guard(caller, body.subject)
    allowed = any(
        entry["permission"] == body.permission
        and any(scope_covers(d["scope"], body.scope) for d in entry["granted_by"])
        for entry in effective_permissions(body.subject)
    )
    return JSONResponse(
        {"subject": body.subject, "permission": body.permission, "scope": body.scope, "allowed": allowed},
        status_code=200,
    )
`,
    },
    typescript: {
      starter: `/** GET /v1/users/:id/permissions: a model-generated draft that returns a merged blob. */
import Fastify from 'fastify';
import {Redis} from 'ioredis';

export const app = Fastify();
const r = new Redis('redis://redis:6379');

const CACHE_TTL_S = 600;

export interface GrantStore {
  permissions(subject: string): Promise<string[]>;
}

export const store: GrantStore = {
  async permissions() {
    throw new Error('not wired');
  },
};

app.get('/v1/users/:id/permissions', async (request, reply) => {
  // TODO: this draft returns the merged permission list with no provenance, caches it for 600 s
  // with no version stamp, and never compares X-Caller-Id with :id. Review all three.
  const {id} = request.params as {id: string};
  const caller = request.headers['X-Caller-Id'];
  const key = \`perms:\${id}\`;
  const cached = await r.get(key);
  if (cached !== null) return reply.code(200).send({subject: id, permissions: JSON.parse(cached)});
  const permissions = (await store.permissions(id)).sort();
  await r.set(key, JSON.stringify(permissions), 'EX', CACHE_TTL_S);
  request.log.info({id, caller, count: permissions.length}, 'read permissions');
  return reply.code(200).send({subject: id, permissions});
});

void app.listen({port: 8445, host: '0.0.0.0'});
`,
      solution: `/** GET /v1/users/:id/permissions: an explanation, and the live check that agrees with it. */
import Fastify from 'fastify';
import {Redis} from 'ioredis';

export const app = Fastify();
const r = new Redis('redis://redis:6379');

const AUDIT_PERMISSION = 'permissions:read:any';
const SCOPE_RANK: Record<string, number> = {org: 0, team: 1, project: 2};

interface CheckBody {
  subject: string;
  permission: string;
  scope: string;
}

interface Grant {
  grant_id: string;
  role_id: string;
  scope: string;
  permissions: string[];
}

interface Derivation {
  role_id: string;
  scope: string;
  grant_id: string;
}

interface Entry {
  permission: string;
  granted_by: Derivation[];
}

export interface GrantStore {
  grants(subject: string): Promise<Grant[]>;
  grantVersion(): Promise<number>;
}

export interface PolicyEngine {
  allow(caller: string, permission: string, scope: string): Promise<boolean>;
}

export const store: GrantStore = {
  async grants() {
    throw new Error('not wired');
  },
  async grantVersion() {
    throw new Error('not wired');
  },
};

export const engine: PolicyEngine = {
  async allow() {
    throw new Error('not wired');
  },
};

function scopeCovers(held: string, target: string): boolean {
  if (held === target || held === 'org') return true;
  const heldRank = SCOPE_RANK[held.split(':', 1)[0]];
  const targetRank = SCOPE_RANK[target.split(':', 1)[0]];
  return heldRank !== undefined && targetRank !== undefined && heldRank < targetRank;
}

async function effectivePermissions(subject: string): Promise<Entry[]> {
  const byPermission = new Map<string, Derivation[]>();
  for (const grant of await store.grants(subject)) {
    for (const permission of grant.permissions) {
      const derivation = {role_id: grant.role_id, scope: grant.scope, grant_id: grant.grant_id};
      byPermission.set(permission, [...(byPermission.get(permission) ?? []), derivation]);
    }
  }
  return [...byPermission.keys()]
    .sort()
    .map(permission => ({permission, granted_by: byPermission.get(permission) ?? []}));
}

function cacheIsCurrent(entry: {grant_version: number} | null, version: number): boolean {
  return entry !== null && entry.grant_version === version;
}

/** The version-stamped cache: an entry survives only while its grant_version is current. */
async function explainPermissions(subject: string): Promise<Record<string, unknown>> {
  const version = await store.grantVersion();
  const raw = await r.get(\`perms:\${subject}\`);
  const entry = raw === null ? null : (JSON.parse(raw) as {grant_version: number; entries: Entry[]});
  let entries = entry?.entries ?? null;
  if (!cacheIsCurrent(entry, version)) {
    entries = await effectivePermissions(subject);
    await r.set(\`perms:\${subject}\`, JSON.stringify({grant_version: version, entries}));
  }
  return {subject, grant_version: version, permissions: entries};
}

app.get('/v1/users/:id/permissions', async (request, reply) => {
  const {id} = request.params as {id: string};
  const caller = request.headers['X-Caller-Id'];
  if (typeof caller !== 'string' || caller === '') return reply.code(401).send({error: 'missing X-Caller-Id'});
  if (caller !== id && !(await engine.allow(caller, AUDIT_PERMISSION, 'org')))
    return reply.code(403).send({error: 'needs permissions:read:any'});
  const body = await explainPermissions(id);
  request.log.info({id, caller, permissions: (body.permissions as Entry[]).length}, 'permissions read');
  return reply.code(200).send(body);
});

app.post('/v1/permissions/check', async (request, reply) => {
  const body = request.body as Partial<CheckBody> | null;
  if (body === null || typeof body !== 'object' || !body.subject || !body.permission || !body.scope)
    return reply.code(400).send({error: 'subject, permission and scope are required'});
  const caller = request.headers['X-Caller-Id'];
  if (typeof caller !== 'string' || caller === '') return reply.code(401).send({error: 'missing X-Caller-Id'});
  if (caller !== body.subject && !(await engine.allow(caller, AUDIT_PERMISSION, 'org')))
    return reply.code(403).send({error: 'needs permissions:read:any'});
  const entries = await effectivePermissions(body.subject);
  const allowed = entries.some(
    entry =>
      entry.permission === body.permission &&
      entry.granted_by.some(derivation => scopeCovers(derivation.scope, body.scope as string)),
  );
  return reply.code(200).send({subject: body.subject, permission: body.permission, scope: body.scope, allowed});
});

void app.listen({port: 8445, host: '0.0.0.0'});
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"sort"
	"time"

	"github.com/redis/go-redis/v9"
)

const cacheTTL = 600 * time.Second

type GrantStore struct{}

// Permissions is every permission the subject holds, merged across roles and scopes.
func (s *GrantStore) Permissions(ctx context.Context, subject string) ([]string, error) {
	return nil, nil
}

var (
	store = &GrantStore{}
	rdb   = redis.NewClient(&redis.Options{Addr: "redis:6379"})
)

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func readPermissions(rw http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	caller := r.Header.Get("X-Caller-Id")
	// TODO: this draft returns the merged permission list with no provenance, caches it for 600 s
	// with no version stamp, and never compares X-Caller-Id with the {id} in the path.
	key := "perms:" + id
	if cached, err := rdb.Get(r.Context(), key).Bytes(); err == nil {
		var permissions []string
		_ = json.Unmarshal(cached, &permissions)
		writeJSON(rw, http.StatusOK, map[string]any{"subject": id, "permissions": permissions})
		return
	}
	permissions, _ := store.Permissions(r.Context(), id)
	sort.Strings(permissions)
	payload, _ := json.Marshal(permissions)
	rdb.Set(r.Context(), key, payload, cacheTTL)
	log.Printf("permissions id=%s caller=%s count=%d", id, caller, len(permissions))
	writeJSON(rw, http.StatusOK, map[string]any{"subject": id, "permissions": permissions})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/users/{id}/permissions", readPermissions)
	log.Fatal(http.ListenAndServeTLS(":8445", "cert.pem", "key.pem", mux))
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"sort"

	"github.com/redis/go-redis/v9"
)

const auditPermission = "permissions:read:any"

var scopeRank = map[string]int{"org": 0, "team": 1, "project": 2}

type Grant struct {
	GrantID     string   \`json:"grant_id"\`
	RoleID      string   \`json:"role_id"\`
	Scope       string   \`json:"scope"\`
	Permissions []string \`json:"permissions"\`
}

type Derivation struct {
	GrantID string \`json:"grant_id"\`
	RoleID  string \`json:"role_id"\`
	Scope   string \`json:"scope"\`
}

type EffectivePermission struct {
	Permission string       \`json:"permission"\`
	GrantedBy  []Derivation \`json:"granted_by"\`
}

type CacheEntry struct {
	GrantVersion int64                 \`json:"grant_version"\`
	Entries      []EffectivePermission \`json:"entries"\`
}

type CheckRequest struct {
	Subject    string \`json:"subject"\`
	Permission string \`json:"permission"\`
	Scope      string \`json:"scope"\`
}

type GrantStore struct{}

func (s *GrantStore) Grants(ctx context.Context, subject string) ([]Grant, error) { return nil, nil }

// GrantVersion is the global grant version; every assignment change bumps it.
func (s *GrantStore) GrantVersion(ctx context.Context) (int64, error) { return 0, nil }

type PolicyEngine struct{}

// Allow is the engine's decision: a timeout or a rejection is a deny, never an allow.
func (e *PolicyEngine) Allow(ctx context.Context, caller, permission, scope string) (bool, error) {
	return false, nil
}

var (
	store  = &GrantStore{}
	engine = &PolicyEngine{}
	rdb    = redis.NewClient(&redis.Options{Addr: "redis:6379"})
)

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func scopeKind(scope string) string {
	for i, c := range scope {
		if c == ':' {
			return scope[:i]
		}
	}
	return scope
}

func scopeCovers(held, target string) bool {
	if held == target || held == "org" {
		return true
	}
	heldRank, heldOK := scopeRank[scopeKind(held)]
	targetRank, targetOK := scopeRank[scopeKind(target)]
	return heldOK && targetOK && heldRank < targetRank
}

// effectivePermissions is one entry per permission, carrying the roles and grants that produce it.
func effectivePermissions(ctx context.Context, subject string) ([]EffectivePermission, error) {
	grants, err := store.Grants(ctx, subject)
	if err != nil {
		return nil, err
	}
	byPermission := map[string][]Derivation{}
	for _, grant := range grants {
		for _, permission := range grant.Permissions {
			byPermission[permission] = append(byPermission[permission], Derivation{
				GrantID: grant.GrantID, RoleID: grant.RoleID, Scope: grant.Scope,
			})
		}
	}
	permissions := make([]string, 0, len(byPermission))
	for permission := range byPermission {
		permissions = append(permissions, permission)
	}
	sort.Strings(permissions)
	entries := make([]EffectivePermission, 0, len(permissions))
	for _, permission := range permissions {
		entries = append(entries, EffectivePermission{Permission: permission, GrantedBy: byPermission[permission]})
	}
	return entries, nil
}

func cacheIsCurrent(entry CacheEntry, version int64) bool { return entry.GrantVersion == version }

// explain loads the version-stamped cache: an entry survives only while grant_version matches.
func explain(ctx context.Context, subject string) (CacheEntry, error) {
	version, err := store.GrantVersion(ctx)
	if err != nil {
		return CacheEntry{}, err
	}
	key := "perms:" + subject
	if raw, err := rdb.Get(ctx, key).Bytes(); err == nil {
		var entry CacheEntry
		if json.Unmarshal(raw, &entry) == nil && cacheIsCurrent(entry, version) {
			return entry, nil
		}
	}
	entries, err := effectivePermissions(ctx, subject)
	if err != nil {
		return CacheEntry{}, err
	}
	entry := CacheEntry{GrantVersion: version, Entries: entries}
	payload, _ := json.Marshal(entry)
	rdb.Set(ctx, key, payload, 0)
	return entry, nil
}

// guard lets a caller read its own permissions, or another subject with permissions:read:any.
func guard(rw http.ResponseWriter, ctx context.Context, caller, subject string) bool {
	if caller == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-Caller-Id"})
		return false
	}
	if caller != subject {
		allowed, err := engine.Allow(ctx, caller, auditPermission, "org")
		if err != nil || !allowed {
			writeJSON(rw, http.StatusForbidden, map[string]string{"error": "needs permissions:read:any"})
			return false
		}
	}
	return true
}

func explainPermissions(rw http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !guard(rw, r.Context(), r.Header.Get("X-Caller-Id"), id) {
		return
	}
	entry, err := explain(r.Context(), id)
	if err != nil {
		writeJSON(rw, http.StatusBadGateway, map[string]string{"error": "grant store unavailable"})
		return
	}
	log.Printf("permissions id=%s grant_version=%d count=%d", id, entry.GrantVersion, len(entry.Entries))
	writeJSON(rw, http.StatusOK, map[string]any{
		"subject": id, "grant_version": entry.GrantVersion, "permissions": entry.Entries,
	})
}

func checkPermissions(rw http.ResponseWriter, r *http.Request) {
	var body CheckRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Subject == "" || body.Permission == "" || body.Scope == "" {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "subject, permission and scope are required"})
		return
	}
	if !guard(rw, r.Context(), r.Header.Get("X-Caller-Id"), body.Subject) {
		return
	}
	entries, err := effectivePermissions(r.Context(), body.Subject)
	if err != nil {
		writeJSON(rw, http.StatusBadGateway, map[string]string{"error": "grant store unavailable"})
		return
	}
	allowed := false
	for _, entry := range entries {
		if entry.Permission != body.Permission {
			continue
		}
		for _, derivation := range entry.GrantedBy {
			if scopeCovers(derivation.Scope, body.Scope) {
				allowed = true
			}
		}
	}
	writeJSON(rw, http.StatusOK, map[string]any{
		"subject": body.Subject, "permission": body.Permission, "scope": body.Scope, "allowed": allowed,
	})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/users/{id}/permissions", explainPermissions)
	mux.HandleFunc("POST /v1/permissions/check", checkPermissions)
	log.Fatal(http.ListenAndServeTLS(":8445", "cert.pem", "key.pem", mux))
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import redis.clients.jedis.Jedis

object ReadApi {
  implicit val system: ActorSystem = ActorSystem("permz")

  val CacheTtlSeconds = 600
  val jedis = new Jedis("redis", 6379)
  val store = GrantStore.open()

  val route: Route =
    path("v1" / "users" / Segment / "permissions") { id =>
      get {
        optionalHeaderValueByName("X-Caller-Id") { caller =>
          // TODO: this draft returns the merged permission list with no provenance, caches it for
          // 600 s with no version stamp, and never compares X-Caller-Id with the id in the path.
          val key = s"perms:$id"
          Option(jedis.get(key)) match {
            case Some(cached) =>
              complete(StatusCodes.OK, s"""{"subject":"$id","permissions":$cached}""")
            case None =>
              val permissions = store.permissions(id).sorted.map(p => """ + p + """).mkString(",")
              jedis.setex(key, CacheTtlSeconds, "[" + permissions + "]")
              system.log.info(s"permissions id=$id caller=$caller count=\${store.permissions(id).size}")
              complete(StatusCodes.OK, s"""{"subject":"$id","permissions":[$permissions]}""")
          }
        }
      }
    }

  def main(args: Array[String]): Unit = {
    Http().newServerAt("0.0.0.0", 8445).bind(route)
  }
}
`,
      solution: `import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import redis.clients.jedis.Jedis
import spray.json._
import spray.json.DefaultJsonProtocol._

final case class CheckRequest(subject: String, permission: String, scope: String)
final case class Derivation(grant_id: String, role_id: String, scope: String)
final case class Entry(permission: String, granted_by: List[Derivation])

object ReadApi {
  implicit val system: ActorSystem = ActorSystem("permz")
  implicit val requestFormat: RootJsonFormat[CheckRequest] = jsonFormat3(CheckRequest)
  implicit val derivationFormat: RootJsonFormat[Derivation] = jsonFormat3(Derivation)
  implicit val entryFormat: RootJsonFormat[Entry] = jsonFormat2(Entry)

  val AuditPermission = "permissions:read:any"
  val ScopeRank: Map[String, Int] = Map("org" -> 0, "team" -> 1, "project" -> 2)
  val jedis = new Jedis("redis", 6379)
  val store = GrantStore.open()
  val engine = PolicyEngine.open()

  def cacheKey(subject: String): String = s"perms:$subject"

  def scopeCovers(held: String, target: String): Boolean =
    held == target || held == "org" || (
      for {
        heldRank <- ScopeRank.get(held.split(":", 2).head)
        targetRank <- ScopeRank.get(target.split(":", 2).head)
      } yield heldRank < targetRank
    ).getOrElse(false)

  /** One entry per permission, carrying the roles and grants that produce it. */
  def effectivePermissions(subject: String): List[Entry] =
    store
      .grants(subject)
      .flatMap(g => g.permissions.map(p => p -> Derivation(g.grant_id, g.role_id, g.scope)))
      .groupBy(_._1)
      .toList
      .sortBy(_._1)
      .map { case (permission, pairs) => Entry(permission, pairs.map(_._2)) }

  /** The version-stamped cache: an entry survives only while its grant_version is current. */
  def cacheIsCurrent(entry: JsValue, version: Long): Boolean =
    entry.asJsObject.fields.get("grant_version").contains(JsNumber(version))

  def explainPermissions(subject: String): HttpResponse = {
    val version = store.grantVersion()
    system.log.info(s"permissions subject=$subject grant_version=$version")
    val cached = Option(jedis.get(cacheKey(subject))).map(_.parseJson)
    val entries = cached match {
      case Some(entry) if cacheIsCurrent(entry, version) => entry.asJsObject.fields("entries")
      case _ =>
        val fresh = JsArray(effectivePermissions(subject).map(_.toJson))
        jedis.set(cacheKey(subject), JsObject("grant_version" -> JsNumber(version), "entries" -> fresh).compactPrint)
        fresh
    }
    val body = JsObject(
      "subject" -> JsString(subject),
      "grant_version" -> JsNumber(version),
      "permissions" -> entries,
    )
    HttpResponse(
      StatusCodes.OK,
      entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint),
    )
  }

  def guard(caller: String, subject: String): Option[HttpResponse] =
    if (caller.isEmpty) {
      Some(HttpResponse(StatusCodes.Unauthorized, entity = """{"error":"missing X-Caller-Id"}"""))
    } else if (caller != subject && !engine.allow(caller, AuditPermission, "org")) {
      Some(HttpResponse(StatusCodes.Forbidden, entity = """{"error":"needs permissions:read:any"}"""))
    } else {
      None
    }

  val route: Route =
    path("v1" / "users" / Segment / "permissions") { id =>
      get {
        optionalHeaderValueByName("X-Caller-Id") { caller =>
          guard(caller.getOrElse(""), id) match {
            case Some(denied) => complete(denied)
            case None         => complete(explainPermissions(id))
          }
        }
      }
    } ~
      path("v1" / "permissions" / "check") {
        post {
          optionalHeaderValueByName("X-Caller-Id") { caller =>
            entity(as[CheckRequest]) { body =>
              guard(caller.getOrElse(""), body.subject) match {
                case Some(denied) => complete(denied)
                case None =>
                  val allowed = effectivePermissions(body.subject).exists(entry =>
                    entry.permission == body.permission &&
                      entry.granted_by.exists(d => scopeCovers(d.scope, body.scope))
                  )
                  complete(
                    StatusCodes.OK,
                    s"""{"subject":"\${body.subject}","permission":"\${body.permission}","scope":"\${body.scope}","allowed":$allowed}""",
                  )
              }
            }
          }
        }
      }

  def main(args: Array[String]): Unit = {
    Http().newServerAt("0.0.0.0", 8445).bind(route)
  }
}
`,
    },
    cpp: {
      starter: `#include <httplib.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <iostream>
#include <string>
#include <vector>

using json = nlohmann::json;

constexpr int kCacheTtlSeconds = 600;

struct GrantStore {
  std::vector<std::string> permissions(const std::string& subject);
};

GrantStore store;
sw::redis::Redis redis("tcp://redis:6379");

void readPermissions(const httplib::Request& req, httplib::Response& res) {
  // TODO: this draft returns the merged permission list with no provenance, caches it for 600 s
  // with no version stamp, and never compares X-Caller-Id with the id in the path.
  const std::string id = req.matches[1];
  const std::string caller = req.get_header_value("X-Caller-Id");
  const std::string key = "perms:" + id;
  if (auto cached = redis.get(key)) {
    res.status = 200;
    res.set_content(json{{"subject", id}, {"permissions", json::parse(*cached)}}.dump(), "application/json");
    return;
  }
  const auto permissions = store.permissions(id);
  redis.setex(key, kCacheTtlSeconds, json(permissions).dump());
  std::cerr << "permissions id=" << id << " caller=" << caller << "\\n";
  res.status = 200;
  res.set_content(json{{"subject", id}, {"permissions", permissions}}.dump(), "application/json");
}

int main() {
  httplib::Server svr;

  svr.Get(R"(/v1/users/(\\d+)/permissions)", readPermissions);

  svr.listen("0.0.0.0", 8445);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <iostream>
#include <map>
#include <optional>
#include <string>
#include <utility>
#include <vector>

using json = nlohmann::json;

const std::string kAuditPermission = "permissions:read:any";
const std::map<std::string, int> kScopeRank = {{"org", 0}, {"team", 1}, {"project", 2}};

struct Grant {
  std::string grant_id;
  std::string role_id;
  std::string scope;
  std::vector<std::string> permissions;
};

struct GrantStore {
  std::vector<Grant> grants(const std::string& subject);
  long long grantVersion();
};

struct PolicyEngine {
  bool allow(const std::string& caller, const std::string& permission, const std::string& scope);
};

GrantStore store;
PolicyEngine engine;
sw::redis::Redis redis("tcp://redis:6379");

std::string scopeKind(const std::string& scope) {
  const auto colon = scope.find(':');
  return colon == std::string::npos ? scope : scope.substr(0, colon);
}

bool scopeCovers(const std::string& held, const std::string& target) {
  if (held == target || held == "org") return true;
  const auto heldRank = kScopeRank.find(scopeKind(held));
  const auto targetRank = kScopeRank.find(scopeKind(target));
  if (heldRank == kScopeRank.end() || targetRank == kScopeRank.end()) return false;
  return heldRank->second < targetRank->second;
}

// effectivePermissions is one entry per permission, carrying the roles and grants that produce it.
std::vector<json> effectivePermissions(const std::string& subject) {
  std::map<std::string, json> byPermission;
  for (const auto& grant : store.grants(subject)) {
    const json derivation = {{"role_id", grant.role_id}, {"scope", grant.scope}, {"grant_id", grant.grant_id}};
    for (const auto& permission : grant.permissions) {
      if (byPermission.count(permission) == 0) byPermission[permission] = json::array();
      byPermission[permission].push_back(derivation);
    }
  }
  std::vector<json> entries;
  for (const auto& [permission, derivations] : byPermission) {
    entries.push_back(json{{"permission", permission}, {"granted_by", derivations}});
  }
  return entries;
}

// cacheIsCurrent: an entry survives only while its grant_version is the current one.
bool cacheIsCurrent(const std::optional<json>& entry, long long version) {
  return entry.has_value() && entry->value("grant_version", -1LL) == version;
}

std::string explainPermissions(const std::string& subject) {
  const long long version = store.grantVersion();
  std::optional<json> cached;
  if (auto raw = redis.get("perms:" + subject)) cached = json::parse(*raw, nullptr, false);
  json entries;
  if (cacheIsCurrent(cached, version)) {
    entries = (*cached)["entries"];
  } else {
    entries = effectivePermissions(subject);
    redis.set("perms:" + subject, json{{"grant_version", version}, {"entries", entries}}.dump());
  }
  return json{{"subject", subject}, {"grant_version", version}, {"permissions", entries}}.dump();
}

std::optional<std::pair<int, std::string>> guard(const std::string& caller, const std::string& subject) {
  if (caller.empty()) return std::make_pair(401, R"({"error":"missing X-Caller-Id"})");
  if (caller != subject && !engine.allow(caller, kAuditPermission, "org"))
    return std::make_pair(403, R"({"error":"needs permissions:read:any"})");
  return std::nullopt;
}

void readPermissions(const httplib::Request& req, httplib::Response& res) {
  const std::string id = req.matches[1];
  const std::string caller = req.get_header_value("X-Caller-Id");
  if (auto denied = guard(caller, id)) {
    res.status = denied->first;
    res.set_content(denied->second, "application/json");
    return;
  }
  std::cerr << "permissions id=" << id << " caller=" << caller << "\\n";
  res.status = 200;
  res.set_content(explainPermissions(id), "application/json");
}

void checkPermissions(const httplib::Request& req, httplib::Response& res) {
  const json body = json::parse(req.body, nullptr, false);
  if (!body.is_object() || !body.contains("subject") || !body.contains("permission") || !body.contains("scope")) {
    res.status = 400;
    res.set_content(R"({"error":"subject, permission and scope are required"})", "application/json");
    return;
  }
  const auto subject = body["subject"].get<std::string>();
  if (auto denied = guard(req.get_header_value("X-Caller-Id"), subject)) {
    res.status = denied->first;
    res.set_content(denied->second, "application/json");
    return;
  }
  const auto asked = body["permission"].get<std::string>();
  const auto scope = body["scope"].get<std::string>();
  bool allowed = false;
  for (const auto& entry : effectivePermissions(subject)) {
    if (entry["permission"] != asked) continue;
    for (const auto& derivation : entry["granted_by"]) {
      if (scopeCovers(derivation["scope"].get<std::string>(), scope)) allowed = true;
    }
  }
  res.status = 200;
  res.set_content(
      json{{"subject", subject}, {"permission", asked}, {"scope", scope}, {"allowed", allowed}}.dump(),
      "application/json");
}

int main() {
  httplib::Server svr;

  svr.Get(R"(/v1/users/(\\d+)/permissions)", readPermissions);
  svr.Post("/v1/permissions/check", checkPermissions);

  svr.listen("0.0.0.0", 8445);
}
`,
    },
  },
  hints: [
    'Order the guards cheapest first: compare `X-Caller-Id` with the path id before Redis or the grant store is touched, and resolve a foreign id against the audit permission — a rejection there is a pure function of the request, so no subject data is ever loaded for it.',
    "The explanation is a fold, not a set: walk the subject's grants and build `permission → [{role_id, scope, grant_id}]` so a permission produced by two grants lists both. Give `POST /v1/permissions/check` the same function and the same scope-containment comparison, or the list and the live answer drift apart on the same pass.",
    'Stamp the cached entry with `grant_version` and serve it only while `cache_is_current`: a TTL is a deadline a revocation has to outlive, a version comparison is not. Write the fresh entry back with the version that produced it, so a revocation racing the read invalidates the write instead of the reader.',
  ],
  debrief: `The interviewer is testing a read path that looks like a lookup and is really an authorization decision. Three defects are being checked. First, provenance: a merged list is unfalsifiable — when a permission is wrong, nobody can say which role or grant produced it — so the explanation has to come out of the same fold that decides the answer, which is also why the live check must call that fold instead of re-deriving it. Second, freshness: a 600-second TTL is a promise that a revocation can be ten minutes late, so the entry is stamped with \`grant_version\` and a mismatch recomputes; the read must never be able to outlive a revocation. Third, ownership: a permissions read is the map of everything a subject can do, which makes it exactly the endpoint an attacker enumerates — a caller reads its own, unless it holds the audit permission, and a foreign id is 403. Real systems add signed responses, an audit record of every read with the caller's identity, and pagination for subjects with thousands of grants.`,
};
