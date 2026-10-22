import type {Step} from '@/lib/types';

export const endpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/roles/assignments: you cannot grant what you do not hold',
  concept: 'http',
  file: 'api',
  focus: ['client', 'api', 'catalog', 'store'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it registers the route, parses
the body, writes an assignment and answers \`200\`. It compiles, it serves the demo, and it hides
three production flaws — an escalation hole, an unvalidated scope, and a missing idempotency key.
Review it like the service owner, fix it, and prove the fix with the checks below.

Implement \`POST /v1/roles/assignments\` with body \`{"subject": "user:ada", "role": "team_admin",
"scope": "team:eng"}\` and the authenticated \`X-Assigner-Id\` header.

- The assigner comes from \`X-Assigner-Id\`; a missing or empty one is **401**. \`subject\`, \`role\`
  and \`scope\` are required and non-empty (**400** otherwise).
- **No escalation.** A grant is authorized only when the assigner already holds **every** permission
  the role confers, at a scope that covers the target scope. Compare sets, not role names: "the
  assigner is an admin somewhere" is how a team admin ends up granting \`org_admin\` at \`org\`.
  A grant the assigner cannot back is **403**, and the body names the first missing permission:
  \`{"error": "insufficient_permissions", "missing_permission": "org:write"}\`.
- **Scope containment.** A permission held at a broader scope covers a narrower one (\`org\` covers
  everything, a team scope covers a project inside it); a permission held only at a narrow scope
  never authorizes a broader grant. Held at \`team:eng\`, you cannot grant at \`org\`.
- **The catalog decides scopes.** \`role\` must exist in the role catalog and \`scope\` must be of a
  kind the catalog allows for that role, otherwise **422**. Wildcards are not in the catalog:
  \`scope: "*"\` is **422**, not a super-grant.
- **Idempotency.** \`Idempotency-Key\` is required (**400** when missing). A replay of the same
  \`(Idempotency-Key, subject, role, scope)\` returns the stored assignment with **200** and writes
  nothing; only the first call mutates state.
- Log the assignment id with subject, role, scope and assigner — ids only, never the subject's full
  permission set.

**Failure mode the checks target.** Checking "is this caller an admin?" instead of "does this caller
hold what they are handing out?" turns every delegated admin into a path to organization-wide roles.
Accepting any scope string lets a grant land on \`*\`, a scope no policy was ever written for. And an
un-keyed assignment endpoint re-grants on every client retry, which is exactly how a revocation
audit ends up with duplicate grants nobody can explain.`,
  sequence: {
    participants: ['Client', 'Permission Service', 'Role catalog', 'Grant store'],
    messages: [
      {from: 'Client', to: 'Permission Service', label: 'POST /v1/roles/assignments · X-Assigner-Id', kind: 'sync'},
      {from: 'Permission Service', to: 'Permission Service', label: 'validate ids · Idempotency-Key', kind: 'sync'},
      {from: 'Permission Service', to: 'Role catalog', label: 'role → permissions · scope kinds', kind: 'sync'},
      {from: 'Role catalog', to: 'Permission Service', label: 'catalog entry / none', kind: 'reply'},
      {from: 'Permission Service', to: 'Grant store', label: 'holdings(assigner)', kind: 'sync'},
      {from: 'Grant store', to: 'Permission Service', label: 'scope → permissions', kind: 'reply'},
      {
        from: 'Permission Service',
        to: 'Permission Service',
        label: 'every permission covered by a covering scope?',
        kind: 'sync',
      },
      {from: 'Permission Service', to: 'Grant store', label: 'put(key, assignment)', kind: 'async'},
      {from: 'Permission Service', to: 'Client', label: '200 assignment · 403 missing_permission · 422', kind: 'reply'},
    ],
  },
  hints: [
    'Order the guards cheapest first: assigner, Idempotency-Key, body shape, catalog lookup, then the escalation check — the only one that reads the grant store. Every earlier rejection is a pure function of the request.',
    'Authorize by permission sets, not by role names. `required = ROLE_CATALOG[role].permissions`, `held = store.holdings(assigner)` as `scope → permissions`, and a permission counts only when some holding scope *covers* the target scope. The first uncovered permission is the one you name in the 403.',
    'Scope containment is one comparison: equal scopes cover, `org` covers everything, and otherwise a lower-ranked kind covers a higher-ranked one (`org` < `team` < `project`). A wildcard `*` has a kind the catalog never lists, so it dies at the 422, not at the 403.',
  ],
  checks: [
    {
      id: 'route',
      title: 'Handles POST /v1/roles/assignments',
      detail: 'Register the assignment route on `POST /v1/roles/assignments` with the `X-Assigner-Id` header.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/roles\/assignments["']/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/roles\/assignments['"]/]},
        go: {all: [/HandleFunc\(\s*"POST \/v1\/roles\/assignments"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"roles"\s*\/\s*"assignments"\s*\)/, /\bpost\s*\{/]},
        cpp: {all: [/svr\.Post\(\s*"\/v1\/roles\/assignments"/]},
      },
    },
    {
      id: 'catalog',
      title: 'Validates role and scope against the catalog with 422',
      detail:
        '`role` must exist in the role catalog and `scope` must have a kind the catalog allows for it, else **422**. The draft never opens the catalog, so it accepts `scope: "*"` — a scope no policy defines.',
      match: {
        python: {all: [/ROLE_CATALOG/, /status_code\s*=\s*422/]},
        typescript: {all: [/ROLE_CATALOG/, /code\(\s*422\s*\)/]},
        go: {all: [/roleCatalog/, /StatusUnprocessableEntity/]},
        scala: {all: [/RoleCatalog/, /StatusCodes\.UnprocessableEntity/]},
        cpp: {all: [/kRoleCatalog/, /\b422\b/]},
      },
    },
    {
      id: 'no-escalation',
      title: 'Refuses a grant that exceeds the assigner, naming the permission',
      detail:
        'Every permission the role confers must already be held by the assigner at a covering scope; the first one that is not is **403** and named as `missing_permission` in the body. The draft only checks that the assigner is an admin somewhere, so a team admin can grant `org_admin` at `org`.',
      match: {
        python: {all: [/status_code\s*=\s*403/, /missing_permission/]},
        typescript: {all: [/code\(\s*403\s*\)/, /missing_permission/]},
        go: {all: [/StatusForbidden/, /missing_permission/]},
        scala: {all: [/StatusCodes\.Forbidden/, /missing_permission/]},
        cpp: {all: [/\b403\b/, /missing_permission/]},
      },
    },
    {
      id: 'scope-containment',
      title: 'Compares scopes by containment, not by string equality',
      detail:
        'A holding covers the target scope only when it is the same scope, `org`, or a broader kind; a holding at a narrow scope never authorizes a wider grant. The draft compares nothing. Both a `scope_covers`/`scopeCovers` helper and the rank table must be present.',
      match: {
        python: {all: [/def scope_covers\(/, /SCOPE_RANK/]},
        typescript: {all: [/function scopeCovers\(/, /SCOPE_RANK/]},
        go: {all: [/func scopeCovers\(/, /scopeRank/]},
        scala: {all: [/def scopeCovers\(/, /ScopeRank/]},
        cpp: {all: [/scopeCovers\(/, /kScopeRank/]},
      },
    },
    {
      id: 'idempotent',
      title: 'Replays an assignment instead of granting twice',
      detail:
        '`Idempotency-Key` is required and the assignment is stored under `(key, subject, role, scope)`; a replay returns the stored assignment instead of writing again. The draft ignores the header entirely.',
      match: {
        python: {all: [/Idempotency-Key/, /store\.assignment\(/, /store\.put\(/]},
        typescript: {all: [/Idempotency-Key/, /store\.assignment\(/, /store\.put\(/]},
        go: {all: [/Idempotency-Key/, /store\.Assignment\(/, /store\.Put\(/]},
        scala: {all: [/Idempotency-Key/, /store\.assignment\(/, /store\.put\(/]},
        cpp: {all: [/Idempotency-Key/, /store\.assignment\(/, /store\.put\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `"""POST /v1/roles/assignments: a model-generated draft that trusts any admin to grant anything."""
import logging

from fastapi import FastAPI, Header
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()
logger = logging.getLogger("permissions")


class Assignment(BaseModel):
    subject: str
    role: str
    scope: str


class GrantStore:
    def admin_roles(self, subject: str) -> set[str]:
        """Roles the subject holds at any scope — used here as a rough admin check."""
        raise NotImplementedError

    def put(self, assignment: dict) -> None:
        """Persist the assignment."""
        raise NotImplementedError


store = GrantStore()


@app.post("/v1/roles/assignments")
def assign(body: Assignment, assigner: str = Header(alias="X-Assigner-Id")) -> JSONResponse:
    # TODO: this draft only checks that the assigner is an admin somewhere, never consults the
    # role catalog, accepts any scope string (a wildcard included), and has no Idempotency-Key.
    roles = store.admin_roles(assigner)
    if "org_admin" not in roles and "team_admin" not in roles:
        return JSONResponse({"error": "forbidden"}, status_code=403)
    assignment = {"subject": body.subject, "role": body.role, "scope": body.scope}
    store.put(assignment)
    logger.info("assigned subject=%s role=%s scope=%s", body.subject, body.role, body.scope)
    return JSONResponse(assignment, status_code=200)
`,
      solution: `"""POST /v1/roles/assignments: no escalation, catalog-validated scopes, idempotent replay."""
import logging
import uuid

from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()
logger = logging.getLogger("permissions")

ROLE_CATALOG = {
    "org_admin": {"scope_kinds": {"org"}, "permissions": {"org:read", "org:write", "roles:assign"}},
    "team_admin": {"scope_kinds": {"team", "project"}, "permissions": {"team:read", "team:write", "members:invite"}},
    "viewer": {"scope_kinds": {"team", "project"}, "permissions": {"team:read"}},
}
SCOPE_RANK = {"org": 0, "team": 1, "project": 2}


class Assignment(BaseModel):
    subject: str
    role: str
    scope: str


class GrantStore:
    def holdings(self, subject: str) -> dict[str, set[str]]:
        """scope → the permissions the subject holds there."""
        raise NotImplementedError

    def assignment(self, key: str) -> dict | None:
        """The assignment stored under the idempotency key, if any."""
        raise NotImplementedError

    def put(self, key: str, assignment: dict) -> None:
        """Persist the assignment under the idempotency key."""
        raise NotImplementedError


store = GrantStore()


def scope_kind(scope: str) -> str:
    return scope.split(":", 1)[0]


def scope_covers(held: str, target: str) -> bool:
    """A grant held at \`held\` authorizes an assignment at \`target\`."""
    if held == target or held == "org":
        return True
    held_rank = SCOPE_RANK.get(scope_kind(held))
    target_rank = SCOPE_RANK.get(scope_kind(target))
    if held_rank is None or target_rank is None:
        return False
    return held_rank < target_rank


def missing_permission(assigner: str, role: str, scope: str) -> str | None:
    """The first permission the role confers that the assigner does not hold at a covering scope."""
    held = store.holdings(assigner)
    for permission in sorted(ROLE_CATALOG[role]["permissions"]):
        covered = any(
            permission in permissions and scope_covers(held_scope, scope) for held_scope, permissions in held.items()
        )
        if not covered:
            return permission
    return None


@app.post("/v1/roles/assignments")
def assign(
    body: Assignment,
    assigner: str | None = Header(default=None, alias="X-Assigner-Id"),
    idem_key: str | None = Header(default=None, alias="Idempotency-Key"),
) -> JSONResponse:
    if assigner is None or assigner == "":
        raise HTTPException(status_code=401, detail="missing X-Assigner-Id")
    if idem_key is None or idem_key == "":
        raise HTTPException(status_code=400, detail="Idempotency-Key is required")
    if body.subject == "" or body.role == "" or body.scope == "":
        raise HTTPException(status_code=400, detail="subject, role and scope are required")

    entry = ROLE_CATALOG.get(body.role)
    if entry is None:
        raise HTTPException(status_code=422, detail=f"unknown role {body.role}")
    if scope_kind(body.scope) not in entry["scope_kinds"]:
        raise HTTPException(status_code=422, detail=f"scope {body.scope} is outside the catalog for {body.role}")

    key = f"{idem_key}:{body.role}:{body.subject}:{body.scope}"
    stored = store.assignment(key)
    if stored is not None:
        return JSONResponse(stored, status_code=200)

    missing = missing_permission(assigner, body.role, body.scope)
    if missing is not None:
        raise HTTPException(
            status_code=403,
            detail={"error": "insufficient_permissions", "missing_permission": missing, "scope": body.scope},
        )

    assignment = {
        "id": str(uuid.uuid4()),
        "subject": body.subject,
        "role": body.role,
        "scope": body.scope,
        "assigner": assigner,
    }
    store.put(key, assignment)
    logger.info(
        "assigned id=%s subject=%s role=%s scope=%s assigner=%s",
        assignment["id"],
        body.subject,
        body.role,
        body.scope,
        assigner,
    )
    return JSONResponse(assignment, status_code=200)
`,
    },
    typescript: {
      starter: `/** POST /v1/roles/assignments: a model-generated draft that trusts any admin to grant anything. */
import Fastify from 'fastify';

export const app = Fastify();

interface AssignmentBody {
  subject: string;
  role: string;
  scope: string;
}

export interface GrantStore {
  adminRoles(subject: string): Promise<string[]>;
  put(assignment: Record<string, string>): Promise<void>;
}

export const store: GrantStore = {
  async adminRoles() {
    throw new Error('not wired');
  },
  async put() {
    throw new Error('not wired');
  },
};

app.post('/v1/roles/assignments', async (request, reply) => {
  // TODO: this draft only checks that the assigner is an admin somewhere, never consults the role
  // catalog, accepts any scope string (a wildcard included), and has no Idempotency-Key.
  const assigner = request.headers['x-assigner-id'] as string;
  const body = request.body as AssignmentBody;
  const roles = await store.adminRoles(assigner);
  if (!roles.includes('org_admin') && !roles.includes('team_admin'))
    return reply.code(403).send({error: 'forbidden'});
  const assignment = {subject: body.subject, role: body.role, scope: body.scope};
  await store.put(assignment);
  request.log.info({subject: body.subject, role: body.role, scope: body.scope}, 'assigned');
  return reply.code(200).send(assignment);
});

void app.listen({port: 8444, host: '0.0.0.0'});
`,
      solution: `/** POST /v1/roles/assignments: no escalation, catalog-validated scopes, idempotent replay. */
import {randomUUID} from 'node:crypto';

import Fastify from 'fastify';

export const app = Fastify();

const ROLE_CATALOG: Record<string, {scope_kinds: string[]; permissions: string[]}> = {
  org_admin: {scope_kinds: ['org'], permissions: ['org:read', 'org:write', 'roles:assign']},
  team_admin: {scope_kinds: ['team', 'project'], permissions: ['team:read', 'team:write', 'members:invite']},
  viewer: {scope_kinds: ['team', 'project'], permissions: ['team:read']},
};
const SCOPE_RANK: Record<string, number> = {org: 0, team: 1, project: 2};

interface AssignmentBody {
  subject: string;
  role: string;
  scope: string;
}

interface Holding {
  scope: string;
  permissions: string[];
}

interface Assignment {
  id: string;
  subject: string;
  role: string;
  scope: string;
  assigner: string;
}

export interface GrantStore {
  holdings(subject: string): Promise<Holding[]>;
  assignment(key: string): Promise<Assignment | null>;
  put(key: string, assignment: Assignment): Promise<void>;
}

export const store: GrantStore = {
  async holdings() {
    throw new Error('not wired');
  },
  async assignment() {
    throw new Error('not wired');
  },
  async put() {
    throw new Error('not wired');
  },
};

const scopeKind = (scope: string): string => scope.split(':', 1)[0];

/** A grant held at \`held\` authorizes an assignment at \`target\`: same scope, org, or a broader kind. */
function scopeCovers(held: string, target: string): boolean {
  if (held === target || held === 'org') return true;
  const heldRank = SCOPE_RANK[scopeKind(held)];
  const targetRank = SCOPE_RANK[scopeKind(target)];
  if (heldRank === undefined || targetRank === undefined) return false;
  return heldRank < targetRank;
}

/** The first permission the role confers that the assigner does not hold at a covering scope. */
function missingPermission(held: Holding[], role: string, scope: string): string | null {
  for (const permission of [...ROLE_CATALOG[role].permissions].sort()) {
    const covered = held.some(h => h.permissions.includes(permission) && scopeCovers(h.scope, scope));
    if (!covered) return permission;
  }
  return null;
}

app.post('/v1/roles/assignments', async (request, reply) => {
  const assigner = request.headers['X-Assigner-Id'];
  if (typeof assigner !== 'string' || assigner === '') return reply.code(401).send({error: 'missing X-Assigner-Id'});
  const idemKey = request.headers['Idempotency-Key'];
  if (typeof idemKey !== 'string' || idemKey === '')
    return reply.code(400).send({error: 'Idempotency-Key is required'});

  const body = request.body as Partial<AssignmentBody> | null;
  if (body === null || typeof body !== 'object' || !body.subject || !body.role || !body.scope)
    return reply.code(400).send({error: 'subject, role and scope are required'});

  const entry = ROLE_CATALOG[body.role];
  if (entry === undefined) return reply.code(422).send({error: \`unknown role \${body.role}\`});
  if (!entry.scope_kinds.includes(scopeKind(body.scope)))
    return reply.code(422).send({error: \`scope \${body.scope} is outside the catalog for \${body.role}\`});

  const key = \`\${idemKey}:\${body.role}:\${body.subject}:\${body.scope}\`;
  const stored = await store.assignment(key);
  if (stored !== null) return reply.code(200).send(stored);

  const missing = missingPermission(await store.holdings(assigner), body.role, body.scope);
  if (missing !== null)
    return reply.code(403).send({error: 'insufficient_permissions', missing_permission: missing, scope: body.scope});

  const assignment: Assignment = {
    id: randomUUID(),
    subject: body.subject,
    role: body.role,
    scope: body.scope,
    assigner,
  };
  await store.put(key, assignment);
  request.log.info(
    {id: assignment.id, subject: body.subject, role: body.role, scope: body.scope, assigner},
    'assigned',
  );
  return reply.code(200).send(assignment);
});

void app.listen({port: 8444, host: '0.0.0.0'});
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
)

type AssignmentRequest struct {
	Subject string \`json:"subject"\`
	Role    string \`json:"role"\`
	Scope   string \`json:"scope"\`
}

type GrantStore struct{}

func (s *GrantStore) AdminRoles(ctx context.Context, subject string) ([]string, error) {
	return nil, nil
}

func (s *GrantStore) Put(ctx context.Context, assignment map[string]any) error { return nil }

var store = &GrantStore{}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func assign(rw http.ResponseWriter, r *http.Request) {
	assigner := r.Header.Get("X-Assigner-Id")
	var body AssignmentRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	// TODO: this draft only checks that the assigner is an admin somewhere, never consults the
	// role catalog, accepts any scope string (a wildcard included), and has no Idempotency-Key.
	roles, _ := store.AdminRoles(r.Context(), assigner)
	admin := false
	for _, role := range roles {
		if role == "org_admin" || role == "team_admin" {
			admin = true
		}
	}
	if !admin {
		writeJSON(rw, http.StatusForbidden, map[string]string{"error": "forbidden"})
		return
	}
	assignment := map[string]any{"subject": body.Subject, "role": body.Role, "scope": body.Scope}
	_ = store.Put(r.Context(), assignment)
	log.Printf("assigned subject=%s role=%s scope=%s", body.Subject, body.Role, body.Scope)
	writeJSON(rw, http.StatusOK, assignment)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/roles/assignments", assign)
	log.Fatal(http.ListenAndServeTLS(":8444", "cert.pem", "key.pem", mux))
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"sort"

	"github.com/google/uuid"
)

var roleCatalog = map[string]struct {
	ScopeKinds  []string
	Permissions []string
}{
	"org_admin":  {[]string{"org"}, []string{"org:read", "org:write", "roles:assign"}},
	"team_admin": {[]string{"team", "project"}, []string{"team:read", "team:write", "members:invite"}},
	"viewer":     {[]string{"team", "project"}, []string{"team:read"}},
}

var scopeRank = map[string]int{"org": 0, "team": 1, "project": 2}

type AssignmentRequest struct {
	Subject string \`json:"subject"\`
	Role    string \`json:"role"\`
	Scope   string \`json:"scope"\`
}

type GrantStore struct{}

func (s *GrantStore) Holdings(ctx context.Context, subject string) (map[string][]string, error) {
	return nil, nil
}

func (s *GrantStore) Assignment(ctx context.Context, key string) (map[string]any, error) {
	return nil, nil
}

func (s *GrantStore) Put(ctx context.Context, key string, assignment map[string]any) error { return nil }

var store = &GrantStore{}

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

// scopeCovers reports whether a grant held at held authorizes an assignment at target.
func scopeCovers(held, target string) bool {
	if held == target || held == "org" {
		return true
	}
	heldRank, heldOK := scopeRank[scopeKind(held)]
	targetRank, targetOK := scopeRank[scopeKind(target)]
	if !heldOK || !targetOK {
		return false
	}
	return heldRank < targetRank
}

// missingPermission is the first permission of role the assigner does not hold at a covering scope.
func missingPermission(held map[string][]string, role, scope string) string {
	permissions := append([]string(nil), roleCatalog[role].Permissions...)
	sort.Strings(permissions)
	for _, permission := range permissions {
		covered := false
		for heldScope, heldPermissions := range held {
			if !scopeCovers(heldScope, scope) {
				continue
			}
			for _, p := range heldPermissions {
				if p == permission {
					covered = true
				}
			}
		}
		if !covered {
			return permission
		}
	}
	return ""
}

func assign(rw http.ResponseWriter, r *http.Request) {
	assigner := r.Header.Get("X-Assigner-Id")
	if assigner == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-Assigner-Id"})
		return
	}
	idemKey := r.Header.Get("Idempotency-Key")
	if idemKey == "" {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "Idempotency-Key is required"})
		return
	}
	var body AssignmentRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	if body.Subject == "" || body.Role == "" || body.Scope == "" {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "subject, role and scope are required"})
		return
	}
	entry, ok := roleCatalog[body.Role]
	if !ok {
		writeJSON(rw, http.StatusUnprocessableEntity, map[string]string{"error": "unknown role"})
		return
	}
	allowed := false
	for _, kind := range entry.ScopeKinds {
		if kind == scopeKind(body.Scope) {
			allowed = true
		}
	}
	if !allowed {
		writeJSON(rw, http.StatusUnprocessableEntity, map[string]string{"error": "scope is outside the catalog"})
		return
	}
	key := idemKey + ":" + body.Role + ":" + body.Subject + ":" + body.Scope
	if stored, err := store.Assignment(r.Context(), key); err == nil && stored != nil {
		writeJSON(rw, http.StatusOK, stored)
		return
	}
	held, err := store.Holdings(r.Context(), assigner)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	if missing := missingPermission(held, body.Role, body.Scope); missing != "" {
		writeJSON(rw, http.StatusForbidden, map[string]any{
			"error":              "insufficient_permissions",
			"missing_permission": missing,
			"scope":              body.Scope,
		})
		return
	}
	assignment := map[string]any{
		"id":       uuid.NewString(),
		"subject":  body.Subject,
		"role":     body.Role,
		"scope":    body.Scope,
		"assigner": assigner,
	}
	if err := store.Put(r.Context(), key, assignment); err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	log.Printf("assigned id=%s subject=%s role=%s scope=%s assigner=%s",
		assignment["id"], body.Subject, body.Role, body.Scope, assigner)
	writeJSON(rw, http.StatusOK, assignment)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/roles/assignments", assign)
	log.Fatal(http.ListenAndServeTLS(":8444", "cert.pem", "key.pem", mux))
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class AssignmentRequest(subject: String, role: String, scope: String)

object AssignmentApi {
  implicit val system: ActorSystem = ActorSystem("permission-service")
  implicit val requestFormat: RootJsonFormat[AssignmentRequest] = jsonFormat3(AssignmentRequest)

  val store = GrantStore.open()

  val route: Route =
    path("v1" / "roles" / "assignments") {
      post {
        headerValueByName("X-Assigner-Id") { assigner =>
          entity(as[AssignmentRequest]) { body =>
            // TODO: this draft only checks that the assigner is an admin somewhere, never consults
            // the role catalog, accepts any scope string (a wildcard included), and has no Idempotency-Key.
            val roles = store.adminRoles(assigner)
            if (!roles.contains("org_admin") && !roles.contains("team_admin")) {
              complete(StatusCodes.Forbidden, """{"error":"forbidden"}""")
            } else {
              store.put(body.subject, body.role, body.scope)
              system.log.info(s"assigned subject=\${body.subject} role=\${body.role} scope=\${body.scope}")
              complete(
                StatusCodes.OK,
                s"""{"subject":"\${body.subject}","role":"\${body.role}","scope":"\${body.scope}"}""",
              )
            }
          }
        }
      }
    }

  def main(args: Array[String]): Unit = {
    Http().newServerAt("0.0.0.0", 8444).bind(route)
  }
}
`,
      solution: `import java.util.UUID

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class AssignmentRequest(subject: String, role: String, scope: String)

object AssignmentApi {
  implicit val system: ActorSystem = ActorSystem("permission-service")
  implicit val requestFormat: RootJsonFormat[AssignmentRequest] = jsonFormat3(AssignmentRequest)

  val RoleCatalog: Map[String, (Set[String], Set[String])] = Map(
    "org_admin" -> (Set("org"), Set("org:read", "org:write", "roles:assign")),
    "team_admin" -> (Set("team", "project"), Set("team:read", "team:write", "members:invite")),
    "viewer" -> (Set("team", "project"), Set("team:read")),
  )
  val ScopeRank: Map[String, Int] = Map("org" -> 0, "team" -> 1, "project" -> 2)

  val store = GrantStore.open()

  def scopeKind(scope: String): String = scope.split(":", 2).head

  /** A grant held at \`held\` authorizes an assignment at \`target\`: same scope, org, or a broader kind. */
  def scopeCovers(held: String, target: String): Boolean =
    held == target || held == "org" || (
      for {
        heldRank <- ScopeRank.get(scopeKind(held))
        targetRank <- ScopeRank.get(scopeKind(target))
      } yield heldRank < targetRank
    ).getOrElse(false)

  /** The first permission of \`role\` the assigner does not hold at a covering scope, if any. */
  def missingPermission(held: Map[String, Set[String]], role: String, scope: String): Option[String] =
    RoleCatalog(role)._2.toSeq.sorted.find { permission =>
      !held.exists { case (heldScope, permissions) =>
        permissions.contains(permission) && scopeCovers(heldScope, scope)
      }
    }

  val route: Route =
    path("v1" / "roles" / "assignments") {
      post {
        optionalHeaderValueByName("X-Assigner-Id") { assignerOpt =>
          optionalHeaderValueByName("Idempotency-Key") { idemOpt =>
            entity(as[AssignmentRequest]) { body =>
              if (!assignerOpt.exists(_.nonEmpty)) {
                complete(StatusCodes.Unauthorized, """{"error":"missing X-Assigner-Id"}""")
              } else if (!idemOpt.exists(_.nonEmpty)) {
                complete(StatusCodes.BadRequest, """{"error":"Idempotency-Key is required"}""")
              } else if (body.subject.isEmpty || body.role.isEmpty || body.scope.isEmpty) {
                complete(StatusCodes.BadRequest, """{"error":"subject, role and scope are required"}""")
              } else if (!RoleCatalog.contains(body.role)) {
                complete(StatusCodes.UnprocessableEntity, """{"error":"unknown role"}""")
              } else if (!RoleCatalog(body.role)._1.contains(scopeKind(body.scope))) {
                complete(StatusCodes.UnprocessableEntity, """{"error":"scope is outside the catalog"}""")
              } else {
                val assigner = assignerOpt.get
                val idemKey = idemOpt.get
                val key = s"$idemKey:\${body.role}:\${body.subject}:\${body.scope}"
                store.assignment(key) match {
                  case Some(stored) =>
                    complete(StatusCodes.OK, stored)
                  case None =>
                    missingPermission(store.holdings(assigner), body.role, body.scope) match {
                      case Some(missing) =>
                        complete(
                          StatusCodes.Forbidden,
                          s"""{"error":"insufficient_permissions","missing_permission":"$missing","scope":"\${body.scope}"}""",
                        )
                      case None =>
                        val id = UUID.randomUUID().toString
                        val assignment =
                          s"""{"id":"$id","subject":"\${body.subject}","role":"\${body.role}","scope":"\${body.scope}","assigner":"$assigner"}"""
                        store.put(key, assignment)
                        system.log.info(
                          s"assigned id=$id subject=\${body.subject} role=\${body.role} scope=\${body.scope} assigner=$assigner",
                        )
                        complete(StatusCodes.OK, assignment)
                    }
                }
              }
            }
          }
        }
      }
    }

  def main(args: Array[String]): Unit = {
    Http().newServerAt("0.0.0.0", 8444).bind(route)
  }
}
`,
    },
    cpp: {
      starter: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <iostream>
#include <string>
#include <vector>

using json = nlohmann::json;

struct GrantStore {
  std::vector<std::string> adminRoles(const std::string& assigner);
  void put(const json& assignment);
};

GrantStore store;

int main() {
  httplib::Server svr;

  svr.Post("/v1/roles/assignments", [](const httplib::Request& req, httplib::Response& res) {
    const auto assigner = req.get_header_value("X-Assigner-Id");
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) {
      res.status = 400;
      res.set_content(R"({"error":"invalid json"})", "application/json");
      return;
    }
    // TODO: this draft only checks that the assigner is an admin somewhere, never consults the
    // role catalog, accepts any scope string (a wildcard included), and has no Idempotency-Key.
    bool admin = false;
    for (const auto& role : store.adminRoles(assigner)) {
      if (role == "org_admin" || role == "team_admin") admin = true;
    }
    if (!admin) {
      res.status = 403;
      res.set_content(R"({"error":"forbidden"})", "application/json");
      return;
    }
    const json assignment = {
        {"subject", body.value("subject", std::string())},
        {"role", body.value("role", std::string())},
        {"scope", body.value("scope", std::string())},
    };
    store.put(assignment);
    std::cerr << "assigned subject=" << assignment["subject"] << " role=" << assignment["role"] << "\\n";
    res.status = 200;
    res.set_content(assignment.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8444);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <algorithm>
#include <iostream>
#include <map>
#include <optional>
#include <set>
#include <string>

using json = nlohmann::json;

const std::map<std::string, std::pair<std::set<std::string>, std::set<std::string>>> kRoleCatalog = {
    {"org_admin", {{"org"}, {"org:read", "org:write", "roles:assign"}}},
    {"team_admin", {{"team", "project"}, {"team:read", "team:write", "members:invite"}}},
    {"viewer", {{"team", "project"}, {"team:read"}}},
};
const std::map<std::string, int> kScopeRank = {{"org", 0}, {"team", 1}, {"project", 2}};

struct GrantStore {
  std::map<std::string, std::set<std::string>> holdings(const std::string& assigner);
  std::optional<json> assignment(const std::string& key);
  void put(const std::string& key, const json& assignment);
};

GrantStore store;
std::string uuidString();

std::string scopeKind(const std::string& scope) {
  const auto colon = scope.find(':');
  return colon == std::string::npos ? scope : scope.substr(0, colon);
}

// scopeCovers reports whether a grant held at held authorizes an assignment at target.
bool scopeCovers(const std::string& held, const std::string& target) {
  if (held == target || held == "org") return true;
  const auto heldRank = kScopeRank.find(scopeKind(held));
  const auto targetRank = kScopeRank.find(scopeKind(target));
  if (heldRank == kScopeRank.end() || targetRank == kScopeRank.end()) return false;
  return heldRank->second < targetRank->second;
}

// missing_permission is the first permission of role the assigner does not hold at a covering scope.
std::string missingPermission(const std::map<std::string, std::set<std::string>>& held, const std::string& role,
                              const std::string& scope) {
  std::vector<std::string> permissions(kRoleCatalog.at(role).second.begin(), kRoleCatalog.at(role).second.end());
  std::sort(permissions.begin(), permissions.end());
  for (const auto& permission : permissions) {
    bool covered = false;
    for (const auto& [heldScope, heldPermissions] : held) {
      if (scopeCovers(heldScope, scope) && heldPermissions.count(permission) == 1) covered = true;
    }
    if (!covered) return permission;
  }
  return std::string();
}

int main() {
  httplib::Server svr;

  svr.Post("/v1/roles/assignments", [](const httplib::Request& req, httplib::Response& res) {
    const auto assigner = req.get_header_value("X-Assigner-Id");
    if (assigner.empty()) {
      res.status = 401;
      res.set_content(R"({"error":"missing X-Assigner-Id"})", "application/json");
      return;
    }
    const auto idemKey = req.get_header_value("Idempotency-Key");
    if (idemKey.empty()) {
      res.status = 400;
      res.set_content(R"({"error":"Idempotency-Key is required"})", "application/json");
      return;
    }
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object() || !body.contains("subject") || !body.contains("role") || !body.contains("scope")) {
      res.status = 400;
      res.set_content(R"({"error":"subject, role and scope are required"})", "application/json");
      return;
    }
    const auto role = body["role"].get<std::string>();
    const auto scope = body["scope"].get<std::string>();
    const auto subject = body["subject"].get<std::string>();
    if (subject.empty() || role.empty() || scope.empty()) {
      res.status = 400;
      res.set_content(R"({"error":"subject, role and scope are required"})", "application/json");
      return;
    }
    const auto entry = kRoleCatalog.find(role);
    if (entry == kRoleCatalog.end()) {
      res.status = 422;
      res.set_content(R"({"error":"unknown role"})", "application/json");
      return;
    }
    if (entry->second.first.count(scopeKind(scope)) == 0) {
      res.status = 422;
      res.set_content(R"({"error":"scope is outside the catalog"})", "application/json");
      return;
    }
    const std::string key = idemKey + ":" + role + ":" + subject + ":" + scope;
    if (auto stored = store.assignment(key)) {
      res.status = 200;
      res.set_content(stored->dump(), "application/json");
      return;
    }
    const auto missing = missingPermission(store.holdings(assigner), role, scope);
    if (!missing.empty()) {
      res.status = 403;
      res.set_content(
          json{{"error", "insufficient_permissions"}, {"missing_permission", missing}, {"scope", scope}}.dump(),
          "application/json");
      return;
    }
    const json assignment = {
        {"id", uuidString()},
        {"subject", subject},
        {"role", role},
        {"scope", scope},
        {"assigner", assigner},
    };
    store.put(key, assignment);
    std::cerr << "assigned id=" << assignment["id"] << " subject=" << subject << " role=" << role << "\\n";
    res.status = 200;
    res.set_content(assignment.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8444);
}
`,
    },
  },
  debrief: `The interviewer is testing whether you can review a generated handler at the *delegation* boundary, not just the authentication one. The draft reads fine because the demo has one assigner who is an organization admin and one role that happens to be grantable — so the escalation hole never fires. What is really being checked is that authorization and assignment are the same question: to hand out a permission you must hold it, at a scope that covers the one you are writing to. Three defects follow from that single idea: the set comparison (not an "is admin" flag), scope containment (so a team grant cannot reach \`org\`), and the catalog as the only source of valid scopes (so \`*\` is a 422 instead of a super-grant). Idempotency is the fourth: without a key, every client retry writes another grant, and the audit trail of "who could grant what" stops being readable. Real systems add approval workflows for privileged roles, a separate grant id per assignment, and an append-only audit log of the assigner, the role and the scope.`,
};
