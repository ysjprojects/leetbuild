import type {Step} from '@/lib/types';

export const endpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/purges: patterns with a blast radius',
  concept: 'http',
  file: 'api',
  focus: ['client', 'purge', 'tenant'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it registers the route,
reads the body and hands the paths to the provider. It compiles, it purges the demo domain, and
it hides three production flaws. Review it like the service owner, fix it, and prove the fix with
the checks below.

Implement \`POST /v1/purges\` with body \`{"domain": "shop.example.com", "paths": ["/pricing", "/img/*"], "reason": "…"}\`.

- The tenant comes from the authenticated \`X-Tenant-Id\` header; a missing tenant is **401**.
- \`domain\` must be one of the tenant's own domains (\`owns_domain\`) — a domain that belongs to
  another tenant is **403**, never a purge.
- \`paths\` is a non-empty list of at most **500** entries (\`MAX_PATHS\`), each a string starting
  with \`/\`; an empty list, an over-long list or a malformed path is **400**.
- Duplicate entries inside one request are collapsed before anything is sent (\`dedupe_paths\`),
  and the duplicates are reported back so the caller can see what it sent twice.
- **Wildcards are a privilege, not a parameter.** A pattern containing \`*\` needs the elevated
  scope \`purge:wildcard\`; a whole-domain pattern (\`/*\`) needs \`purge:domain\`. Scopes arrive in
  \`X-Purge-Scope\` as a comma-separated list; a wildcard request without the matching scope is
  **403** and the provider is never called. A normal user token purging an entire domain is the
  outage this endpoint exists to prevent.
- \`Idempotency-Key\` is required (**400** when missing). A replay with the same
  \`(tenant, key)\` returns the **original** purge — same \`purge_id\`, same paths — instead of
  submitting the batch to the provider a second time.
- A new purge answers **202** with \`{"purge_id", "status": "accepted", "domain", "paths",
  "wildcard", "duplicates"}\`. Queued is not propagated: this endpoint only promises that the
  purge was accepted and recorded.

:::widget idempotency {}

**Failure mode the checks target.** The draft treats the wildcard as ordinary input, so one
request from a normal token fans a domain-wide purge out to every edge POP and stamps the origin.
It never bounds \`paths\`, so a single body can hold a whole year of URLs. And it re-runs the
whole purge on every retry of the same \`Idempotency-Key\`, doubling provider calls in exactly the
situation — a client retrying after a timeout — where the first batch already went out.`,
  sequence: {
    participants: ['Client', 'Purge API', 'tenant registry', 'CDN provider'],
    messages: [
      {from: 'Client', to: 'Purge API', label: 'POST /v1/purges · X-Tenant-Id · Idempotency-Key', kind: 'sync'},
      {from: 'Purge API', to: 'Purge API', label: 'cap paths · dedupe · check wildcard scope', kind: 'sync'},
      {from: 'Purge API', to: 'tenant registry', label: 'owns(tenant, domain)', kind: 'sync'},
      {from: 'tenant registry', to: 'Purge API', label: 'true / false', kind: 'reply'},
      {from: 'Purge API', to: 'Purge API', label: 'get(tenant, idem_key)', kind: 'sync'},
      {from: 'Purge API', to: 'CDN provider', label: 'SubmitPurge(purge_id, domain, paths)', kind: 'async'},
      {from: 'Purge API', to: 'Purge API', label: 'put(tenant, idem_key, purge)', kind: 'sync'},
      {from: 'Purge API', to: 'Client', label: '202 {purge_id, status: accepted}', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Accepts the batch and answers 202 accepted',
      detail:
        'Register `POST /v1/purges` and answer **202** with `status: "accepted"`, the purge id, the accepted paths and the collapsed duplicates. The draft answers **200** with `status: "queued"`, which tells the caller the purge is done when nothing has reached an edge yet.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/purges["']/, /STATUS_ACCEPTED/, /status_code=202/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/purges['"]/, /STATUS_ACCEPTED/, /code\(202\)/]},
        go: {all: [/HandleFunc\(\s*"POST \/v1\/purges"/, /statusAccepted/, /StatusAccepted/]},
        scala: {
          all: [/path\(\s*"v1"\s*\/\s*"purges"\s*\)/, /\bpost\s*\{/, /StatusAccepted/, /StatusCodes\.Accepted/],
        },
        cpp: {all: [/svr\.Post\(\s*"\/v1\/purges"/, /kStatusAccepted/, /\b202\b/]},
      },
    },
    {
      id: 'tenant-domain',
      title: 'Authenticates the tenant and proves domain ownership',
      detail:
        'A missing `X-Tenant-Id` is **401**; a domain the tenant does not own (`owns_domain`) is **403** before any provider call. The draft trusts both, so any caller can purge any customer’s domain.',
      match: {
        python: {all: [/owns_domain\(/, /status_code=401/, /status_code=403/, /DOMAIN_NOT_OWNED/]},
        typescript: {all: [/domains\.owns\(/, /code\(401\)/, /code\(403\)/, /DOMAIN_NOT_OWNED/]},
        go: {all: [/ownsDomain\(/, /StatusUnauthorized/, /StatusForbidden/, /domainNotOwned/]},
        scala: {all: [/ownsDomain\(/, /StatusCodes\.Unauthorized/, /StatusCodes\.Forbidden/, /DomainNotOwned/]},
        cpp: {all: [/ownsDomain\(/, /\b401\b/, /\b403\b/, /kDomainNotOwned/]},
      },
    },
    {
      id: 'path-cap',
      title: 'Caps the request at 500 paths and dedupes them',
      detail:
        '`paths` is bounded by `MAX_PATHS` = 500, every entry must start with `/`, and duplicates are collapsed by `dedupe_paths` before the provider sees them. The draft forwards whatever array it was handed, so one body can carry an unbounded purge.',
      match: {
        python: {all: [/MAX_PATHS/, /dedupe_paths\(/, /status_code=400/]},
        typescript: {all: [/MAX_PATHS/, /dedupePaths\(/, /code\(400\)/]},
        go: {all: [/maxPaths/, /dedupePaths\(/, /StatusBadRequest/]},
        scala: {all: [/MaxPaths/, /dedupePaths\(/, /StatusCodes\.BadRequest/]},
        cpp: {all: [/kMaxPaths/, /dedupePaths\(/, /\b400\b/]},
      },
    },
    {
      id: 'blast-radius',
      title: 'Gates wildcards behind an elevated scope',
      detail:
        'A pattern with `*` requires `purge:wildcard`, a whole-domain pattern requires `purge:domain`, and a request without the matching scope is **403** (`has_wildcard`, `required_scope`). The draft accepts `/*` from any token, which is the origin stampede.',
      match: {
        python: {all: [/WILDCARD_SCOPE/, /DOMAIN_SCOPE/, /has_wildcard\(/, /status_code=403/]},
        typescript: {all: [/WILDCARD_SCOPE/, /DOMAIN_SCOPE/, /requiredScope\(/, /code\(403\)/]},
        go: {all: [/wildcardScope/, /domainScope/, /hasWildcard\(/, /StatusForbidden/]},
        scala: {all: [/WildcardScope/, /DomainScope/, /hasWildcard\(/, /StatusCodes\.Forbidden/]},
        cpp: {all: [/kWildcardScope/, /kDomainScope/, /hasWildcard\(/, /\b403\b/]},
      },
    },
    {
      id: 'idempotent-replay',
      title: 'Replays an Idempotency-Key without submitting twice',
      detail:
        '`Idempotency-Key` is required, the recorded purge is looked up under `(tenant, key)` **before** the provider submission, and the stored record is returned on a replay. The draft has no lookup, so a retried deploy purge hits the provider twice.',
      match: {
        python: {
          all: [/Idempotency-Key/, /store\.get\(/, /store\.put\(/],
          order: [/store\.get\(/, /providers\.SubmitPurge\(/],
        },
        typescript: {
          all: [/idempotency-key/, /store\.get\(/, /store\.put\(/],
          order: [/store\.get\(/, /providers\.SubmitPurge\(/],
        },
        go: {
          all: [/Idempotency-Key/, /store\.Get\(/, /store\.Put\(/],
          order: [/store\.Get\(/, /provider\.SubmitPurge\(/],
        },
        scala: {
          all: [/Idempotency-Key/, /store\.get\(/, /store\.put\(/],
          order: [/store\.get\(/, /provider\.submitPurge\(/],
        },
        cpp: {
          all: [/Idempotency-Key/, /store\.get\(/, /store\.put\(/],
          order: [/store\.get\(/, /provider\.SubmitPurge\(/],
        },
      },
    },
  ],
  code: {
    python: {
      starter: `import uuid

from fastapi import FastAPI, Header
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()

MAX_PATHS = 500


class PurgeRequest(BaseModel):
    domain: str
    paths: list[str]
    reason: str = ""


class PurgeStore:
    def get(self, tenant: str, idem_key: str) -> dict | None:
        """The purge recorded for (tenant, idem_key), if any."""
        raise NotImplementedError

    def put(self, tenant: str, idem_key: str, purge: dict) -> None:
        """Record the purge under (tenant, idem_key)."""
        raise NotImplementedError


class TenantDomains:
    def owns(self, tenant: str, domain: str) -> bool:
        """Whether \\\`domain\\\` is one of the tenant's domains."""
        raise NotImplementedError


class PurgeProvider:
    def SubmitPurge(self, purge_id: str, domain: str, paths: list[str]) -> None:
        """Hand the batch to the CDN provider."""
        raise NotImplementedError


store = PurgeStore()
domains = TenantDomains()
providers = PurgeProvider()


@app.post("/v1/purges")
def create_purge(body: PurgeRequest, tenant: str = Header(alias="X-Tenant-Id")) -> JSONResponse:
    # TODO: this draft lets any token purge a whole domain with a wildcard, forwards a path list of
    # any size, and re-runs the whole purge when the same Idempotency-Key is replayed. Review all
    # three: gate wildcards behind the elevated scope, cap and dedupe the paths, and answer a
    # replay from the stored purge instead of calling the provider again.
    purge = {
        "purge_id": str(uuid.uuid4()),
        "status": "queued",
        "domain": body.domain,
        "paths": body.paths,
    }
    providers.SubmitPurge(purge["purge_id"], body.domain, body.paths)
    return JSONResponse(purge, status_code=200)
`,
      solution: `import uuid
from collections import Counter

from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()

MAX_PATHS = 500
STATUS_ACCEPTED = "accepted"
WILDCARD_SCOPE = "purge:wildcard"
DOMAIN_SCOPE = "purge:domain"
DOMAIN_NOT_OWNED = "domain is not owned by the tenant"


class PurgeRequest(BaseModel):
    domain: str
    paths: list[str]
    reason: str = ""


class PurgeStore:
    def get(self, tenant: str, idem_key: str) -> dict | None:
        """The purge recorded for (tenant, idem_key), if any."""
        raise NotImplementedError

    def put(self, tenant: str, idem_key: str, purge: dict) -> None:
        """Record the purge under (tenant, idem_key)."""
        raise NotImplementedError


class TenantDomains:
    def owns(self, tenant: str, domain: str) -> bool:
        """Whether \\\`domain\\\` is one of the tenant's domains."""
        raise NotImplementedError


class PurgeProvider:
    def SubmitPurge(self, purge_id: str, domain: str, paths: list[str]) -> None:
        """Hand the batch to the CDN provider."""
        raise NotImplementedError


store = PurgeStore()
domains = TenantDomains()
providers = PurgeProvider()


def owns_domain(tenant: str, domain: str) -> bool:
    return domains.owns(tenant, domain)


def has_wildcard(path: str) -> bool:
    return "*" in path


def is_whole_domain(path: str) -> bool:
    return path.strip() == "/*"


def dedupe_paths(paths: list[str]) -> list[str]:
    """The paths in first-seen order, duplicates collapsed."""
    return list(dict.fromkeys(paths))


def required_scope(paths: list[str]) -> str | None:
    """The elevated scope a wildcard request needs, or None for literal paths."""
    if any(is_whole_domain(path) for path in paths):
        return DOMAIN_SCOPE
    if any(has_wildcard(path) for path in paths):
        return WILDCARD_SCOPE
    return None


def parse_scopes(header: str | None) -> set[str]:
    return {scope.strip() for scope in (header or "").split(",") if scope.strip()}


@app.post("/v1/purges")
def create_purge(
    body: PurgeRequest,
    tenant: str | None = Header(default=None, alias="X-Tenant-Id"),
    idem_key: str | None = Header(default=None, alias="Idempotency-Key"),
    scope_header: str | None = Header(default=None, alias="X-Purge-Scope"),
) -> JSONResponse:
    if tenant is None or tenant == "":
        raise HTTPException(status_code=401, detail="missing X-Tenant-Id")
    if idem_key is None or idem_key == "":
        raise HTTPException(status_code=400, detail="Idempotency-Key is required")

    domain = body.domain.strip()
    if domain == "":
        raise HTTPException(status_code=400, detail="domain is required")
    if not owns_domain(tenant, domain):
        raise HTTPException(status_code=403, detail=DOMAIN_NOT_OWNED)

    if len(body.paths) == 0:
        raise HTTPException(status_code=400, detail="at least one path is required")
    if len(body.paths) > MAX_PATHS:
        raise HTTPException(status_code=400, detail=f"at most {MAX_PATHS} paths per purge")
    if any(not path.startswith("/") for path in body.paths):
        raise HTTPException(status_code=400, detail="every path must start with /")

    paths = dedupe_paths(body.paths)
    duplicates = sorted(path for path, count in Counter(body.paths).items() if count > 1)

    scope = required_scope(paths)
    if scope is not None and scope not in parse_scopes(scope_header):
        raise HTTPException(status_code=403, detail=f"{scope} scope is required for wildcard patterns")

    stored = store.get(tenant, idem_key)
    if stored is not None:
        return JSONResponse(stored, status_code=202)

    purge = {
        "purge_id": str(uuid.uuid4()),
        "status": STATUS_ACCEPTED,
        "domain": domain,
        "paths": paths,
        "wildcard": scope is not None,
        "duplicates": duplicates,
    }
    providers.SubmitPurge(purge["purge_id"], domain, paths)
    store.put(tenant, idem_key, purge)
    return JSONResponse(purge, status_code=202)
`,
    },
    typescript: {
      starter: `/** POST /v1/purges: a model-generated draft that purges whatever the caller sends. */
import {randomUUID} from 'node:crypto';

import Fastify from 'fastify';

export const app = Fastify();

const MAX_PATHS = 500;

interface PurgeBody {
  domain: string;
  paths: string[];
  reason?: string;
}

interface Purge {
  purge_id: string;
  status: string;
  domain: string;
  paths: string[];
}

class PurgeStore {
  async get(tenant: string, idemKey: string): Promise<Purge | null> {
    throw new Error('not implemented');
  }

  async put(tenant: string, idemKey: string, purge: Purge): Promise<void> {
    throw new Error('not implemented');
  }
}

const store = new PurgeStore();

const providers = {
  async SubmitPurge(purgeId: string, domain: string, paths: string[]): Promise<void> {
    throw new Error(\`not implemented: \${domain} \${paths.length} paths for \${purgeId}\`);
  },
};

app.post('/v1/purges', async (request, reply) => {
  // TODO: this draft lets any token purge a whole domain with a wildcard, forwards a path list of
  // any size, and re-runs the whole purge when the same Idempotency-Key is replayed. Review all
  // three: gate wildcards behind the elevated scope, cap and dedupe the paths, and answer a replay
  // from the stored purge instead of calling the provider again.
  const tenant = request.headers['x-tenant-id'] as string;
  const body = request.body as PurgeBody;
  const purge = {purge_id: randomUUID(), status: 'queued', domain: body.domain, paths: body.paths};
  await providers.SubmitPurge(purge.purge_id, body.domain, body.paths);
  return reply.code(200).send({...purge, requested_by: tenant});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** POST /v1/purges: tenants purge only their own domains, inside the blast radius they may ask for. */
import {randomUUID} from 'node:crypto';

import Fastify from 'fastify';

export const app = Fastify();

const MAX_PATHS = 500;
const STATUS_ACCEPTED = 'accepted';
const WILDCARD_SCOPE = 'purge:wildcard';
const DOMAIN_SCOPE = 'purge:domain';
const DOMAIN_NOT_OWNED = 'domain is not owned by the tenant';

interface PurgeBody {
  domain: string;
  paths: string[];
  reason?: string;
}

interface Purge {
  purge_id: string;
  status: string;
  domain: string;
  paths: string[];
  wildcard: boolean;
  duplicates: string[];
}

class PurgeStore {
  async get(tenant: string, idemKey: string): Promise<Purge | null> {
    throw new Error('not implemented');
  }

  async put(tenant: string, idemKey: string, purge: Purge): Promise<void> {
    throw new Error('not implemented');
  }
}

class TenantDomains {
  owns(tenant: string, domain: string): boolean {
    throw new Error(\`not implemented: \${tenant} owns \${domain}?\`);
  }
}

const store = new PurgeStore();
const domains = new TenantDomains();

const providers = {
  async SubmitPurge(purgeId: string, domain: string, paths: string[]): Promise<void> {
    throw new Error(\`not implemented: \${domain} \${paths.length} paths for \${purgeId}\`);
  },
};

/** The paths in first-seen order, duplicates collapsed. */
function dedupePaths(paths: string[]): string[] {
  const unique: string[] = [];
  for (const path of paths) {
    if (!unique.includes(path)) unique.push(path);
  }
  return unique;
}

/** The elevated scope a wildcard request needs, null when every pattern is a literal path. */
function requiredScope(paths: string[]): string | null {
  if (paths.some(path => path.trim() === '/*')) return DOMAIN_SCOPE;
  if (paths.some(path => path.includes('*'))) return WILDCARD_SCOPE;
  return null;
}

const parseScopes = (header: string | undefined): Set<string> =>
  new Set(
    (header ?? '')
      .split(',')
      .map(scope => scope.trim())
      .filter(scope => scope !== ''),
  );

app.post('/v1/purges', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing X-Tenant-Id'});
  const idemKey = request.headers['idempotency-key'];
  if (typeof idemKey !== 'string' || idemKey === '')
    return reply.code(400).send({error: 'Idempotency-Key is required'});

  const body = request.body as Partial<PurgeBody> | null;
  if (body === null || typeof body !== 'object' || typeof body.domain !== 'string' || body.domain.trim() === '')
    return reply.code(400).send({error: 'domain is required'});
  const domain = body.domain.trim();
  if (!domains.owns(tenant, domain)) return reply.code(403).send({error: DOMAIN_NOT_OWNED});

  const requested = Array.isArray(body.paths) ? body.paths : null;
  if (requested === null || requested.length === 0)
    return reply.code(400).send({error: 'at least one path is required'});
  if (requested.length > MAX_PATHS) return reply.code(400).send({error: \`at most \${MAX_PATHS} paths per purge\`});
  if (requested.some(path => typeof path !== 'string' || !path.startsWith('/')))
    return reply.code(400).send({error: 'every path must start with /'});

  const paths = dedupePaths(requested);
  const duplicates = [...new Set(requested.filter((path, index) => requested.indexOf(path) !== index))];

  const scope = requiredScope(paths);
  if (scope !== null && !parseScopes(request.headers['x-purge-scope'] as string | undefined).has(scope))
    return reply.code(403).send({error: \`\${scope} scope is required for wildcard patterns\`});

  const stored = await store.get(tenant, idemKey);
  if (stored !== null) return reply.code(202).send(stored);

  const purge: Purge = {
    purge_id: randomUUID(),
    status: STATUS_ACCEPTED,
    domain,
    paths,
    wildcard: scope !== null,
    duplicates,
  };
  await providers.SubmitPurge(purge.purge_id, domain, paths);
  await store.put(tenant, idemKey, purge);
  return reply.code(202).send(purge);
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"

	"github.com/google/uuid"
)

const maxPaths = 500

type PurgeRequest struct {
	Domain string   \`json:"domain"\`
	Paths  []string \`json:"paths"\`
	Reason string   \`json:"reason"\`
}

type Purge struct {
	PurgeID string   \`json:"purge_id"\`
	Status  string   \`json:"status"\`
	Domain  string   \`json:"domain"\`
	Paths   []string \`json:"paths"\`
}

type PurgeStore struct{}

func (s *PurgeStore) Get(ctx context.Context, tenant, idemKey string) (*Purge, error) { return nil, nil }

func (s *PurgeStore) Put(ctx context.Context, tenant, idemKey string, purge *Purge) error { return nil }

type TenantDomains struct{}

func (d *TenantDomains) Owns(ctx context.Context, tenant, domain string) bool { return false }

type PurgeProvider struct{}

func (p *PurgeProvider) SubmitPurge(ctx context.Context, purgeID, domain string, paths []string) error {
	return nil
}

var (
	store   = &PurgeStore{}
	domains = &TenantDomains{}
	provider = &PurgeProvider{}
)

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func createPurge(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	var body PurgeRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	// TODO: this draft lets any token purge a whole domain with a wildcard, forwards a path list of
	// any size, and re-runs the whole purge when the same Idempotency-Key is replayed. Review all
	// three: gate wildcards behind the elevated scope, cap and dedupe the paths, and answer a replay
	// from the stored purge instead of calling the provider again.
	purge := Purge{PurgeID: uuid.NewString(), Status: "queued", Domain: body.Domain, Paths: body.Paths}
	_ = provider.SubmitPurge(r.Context(), purge.PurgeID, body.Domain, body.Paths)
	_ = tenant
	writeJSON(rw, http.StatusOK, purge)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/purges", createPurge)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"strings"

	"github.com/google/uuid"
)

const (
	maxPaths       = 500
	statusAccepted = "accepted"
	wildcardScope  = "purge:wildcard"
	domainScope    = "purge:domain"
	domainNotOwned = "domain is not owned by the tenant"
)

type PurgeRequest struct {
	Domain string   \`json:"domain"\`
	Paths  []string \`json:"paths"\`
	Reason string   \`json:"reason"\`
}

type Purge struct {
	PurgeID    string   \`json:"purge_id"\`
	Status     string   \`json:"status"\`
	Domain     string   \`json:"domain"\`
	Paths      []string \`json:"paths"\`
	Wildcard   bool     \`json:"wildcard"\`
	Duplicates []string \`json:"duplicates"\`
}

type PurgeStore struct{}

func (s *PurgeStore) Get(ctx context.Context, tenant, idemKey string) (*Purge, error) { return nil, nil }

func (s *PurgeStore) Put(ctx context.Context, tenant, idemKey string, purge *Purge) error { return nil }

type TenantDomains struct{}

func (d *TenantDomains) Owns(ctx context.Context, tenant, domain string) bool { return false }

type PurgeProvider struct{}

func (p *PurgeProvider) SubmitPurge(ctx context.Context, purgeID, domain string, paths []string) error {
	return nil
}

var (
	store    = &PurgeStore{}
	domains  = &TenantDomains{}
	provider = &PurgeProvider{}
)

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func ownsDomain(ctx context.Context, tenant, domain string) bool {
	return domains.Owns(ctx, tenant, domain)
}

func hasWildcard(path string) bool { return strings.Contains(path, "*") }

func isWholeDomain(path string) bool { return strings.TrimSpace(path) == "/*" }

func dedupePaths(paths []string) []string {
	seen := make(map[string]bool, len(paths))
	unique := make([]string, 0, len(paths))
	for _, path := range paths {
		if !seen[path] {
			seen[path] = true
			unique = append(unique, path)
		}
	}
	return unique
}

// requiredScope is the elevated scope a wildcard request needs, empty for literal paths.
func requiredScope(paths []string) string {
	for _, path := range paths {
		if isWholeDomain(path) {
			return domainScope
		}
	}
	for _, path := range paths {
		if hasWildcard(path) {
			return wildcardScope
		}
	}
	return ""
}

func parseScopes(header string) map[string]bool {
	scopes := map[string]bool{}
	for _, scope := range strings.Split(header, ",") {
		if trimmed := strings.TrimSpace(scope); trimmed != "" {
			scopes[trimmed] = true
		}
	}
	return scopes
}

func createPurge(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-Tenant-Id"})
		return
	}
	idemKey := r.Header.Get("Idempotency-Key")
	if idemKey == "" {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "Idempotency-Key is required"})
		return
	}
	var body PurgeRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	domain := strings.TrimSpace(body.Domain)
	if domain == "" {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "domain is required"})
		return
	}
	if !ownsDomain(r.Context(), tenant, domain) {
		writeJSON(rw, http.StatusForbidden, map[string]string{"error": domainNotOwned})
		return
	}
	if len(body.Paths) == 0 {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "at least one path is required"})
		return
	}
	if len(body.Paths) > maxPaths {
		writeJSON(rw, http.StatusBadRequest, map[string]any{"error": "too many paths", "max": maxPaths})
		return
	}
	for _, path := range body.Paths {
		if !strings.HasPrefix(path, "/") {
			writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "every path must start with /"})
			return
		}
	}
	paths := dedupePaths(body.Paths)
	duplicates := []string{}
	seen := map[string]bool{}
	for _, path := range body.Paths {
		if seen[path] {
			duplicates = append(duplicates, path)
		}
		seen[path] = true
	}
	scope := requiredScope(paths)
	if scope != "" && !parseScopes(r.Header.Get("X-Purge-Scope"))[scope] {
		writeJSON(rw, http.StatusForbidden, map[string]string{"error": scope + " scope is required for wildcard patterns"})
		return
	}
	stored, err := store.Get(r.Context(), tenant, idemKey)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	if stored != nil {
		writeJSON(rw, http.StatusAccepted, stored)
		return
	}
	purge := &Purge{
		PurgeID:    uuid.NewString(),
		Status:     statusAccepted,
		Domain:     domain,
		Paths:      paths,
		Wildcard:   scope != "",
		Duplicates: duplicates,
	}
	if err := provider.SubmitPurge(r.Context(), purge.PurgeID, domain, paths); err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "provider unavailable"})
		return
	}
	if err := store.Put(r.Context(), tenant, idemKey, purge); err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	writeJSON(rw, http.StatusAccepted, purge)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/purges", createPurge)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
    },
    scala: {
      starter: `import java.util.UUID

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class PurgeRequest(domain: String, paths: List[String], reason: String = "")
final case class Purge(purge_id: String, status: String, domain: String, paths: List[String])

object PurgeApi {
  implicit val system: ActorSystem = ActorSystem("cdn-purge")
  implicit val purgeRequestFormat: RootJsonFormat[PurgeRequest] = jsonFormat3(PurgeRequest)
  implicit val purgeFormat: RootJsonFormat[Purge] = jsonFormat4(Purge)

  val MaxPaths = 500

  val store = PurgeStore.open()
  val provider = PurgeProvider.connect()

  val route: Route =
    path("v1" / "purges") {
      post {
        optionalHeaderValueByName("X-Tenant-Id") { tenant =>
          entity(as[PurgeRequest]) { body =>
            // TODO: this draft lets any token purge a whole domain with a wildcard, forwards a path
            // list of any size, and re-runs the whole purge when the same Idempotency-Key is
            // replayed. Review all three: gate wildcards behind the elevated scope, cap and dedupe
            // the paths, and answer a replay from the stored purge instead of calling the provider.
            val purge = Purge(UUID.randomUUID().toString, "queued", body.domain, body.paths)
            provider.submitPurge(purge.purge_id, body.domain, body.paths)
            complete(StatusCodes.OK, purge)
          }
        }
      }
    }

  def main(args: Array[String]): Unit = {
    Http().newServerAt("0.0.0.0", 8443).bind(route)
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

final case class PurgeRequest(domain: String, paths: List[String], reason: String = "")
final case class Purge(
    purge_id: String,
    status: String,
    domain: String,
    paths: List[String],
    wildcard: Boolean,
    duplicates: List[String])

object PurgeApi {
  implicit val system: ActorSystem = ActorSystem("cdn-purge")
  implicit val purgeRequestFormat: RootJsonFormat[PurgeRequest] = jsonFormat3(PurgeRequest)
  implicit val purgeFormat: RootJsonFormat[Purge] = jsonFormat6(Purge)

  val MaxPaths = 500
  val StatusAccepted = "accepted"
  val WildcardScope = "purge:wildcard"
  val DomainScope = "purge:domain"
  val DomainNotOwned = "domain is not owned by the tenant"

  val store = PurgeStore.open()
  val provider = PurgeProvider.connect()

  def ownsDomain(tenant: String, domain: String): Boolean = TenantDomains.owns(tenant, domain)

  def hasWildcard(path: String): Boolean = path.contains("*")

  def isWholeDomain(path: String): Boolean = path.trim == "/*"

  def dedupePaths(paths: List[String]): List[String] = paths.distinct

  // requiredScope is the elevated scope a wildcard request needs, None for literal paths.
  def requiredScope(paths: List[String]): Option[String] =
    if (paths.exists(isWholeDomain)) Some(DomainScope)
    else if (paths.exists(hasWildcard)) Some(WildcardScope)
    else None

  def parseScopes(header: String): Set[String] =
    header.split(",").map(_.trim).filter(_.nonEmpty).toSet

  val route: Route =
    path("v1" / "purges") {
      post {
        optionalHeaderValueByName("X-Tenant-Id") { tenantOpt =>
          optionalHeaderValueByName("Idempotency-Key") { idemOpt =>
            optionalHeaderValueByName("X-Purge-Scope") { scopeHeader =>
              entity(as[PurgeRequest]) { body =>
                val domain = body.domain.trim
                val scopes = parseScopes(scopeHeader.getOrElse(""))
                if (!tenantOpt.exists(_.nonEmpty)) {
                  complete(StatusCodes.Unauthorized, """{"error":"missing X-Tenant-Id"}""")
                } else if (!idemOpt.exists(_.nonEmpty)) {
                  complete(StatusCodes.BadRequest, """{"error":"Idempotency-Key is required"}""")
                } else if (domain.isEmpty) {
                  complete(StatusCodes.BadRequest, """{"error":"domain is required"}""")
                } else if (!ownsDomain(tenantOpt.get, domain)) {
                  complete(StatusCodes.Forbidden, s"""{"error":"$DomainNotOwned"}""")
                } else if (body.paths.isEmpty) {
                  complete(StatusCodes.BadRequest, """{"error":"at least one path is required"}""")
                } else if (body.paths.length > MaxPaths) {
                  complete(StatusCodes.BadRequest, s"""{"error":"at most $MaxPaths paths per purge"}""")
                } else if (body.paths.exists(path => !path.startsWith("/"))) {
                  complete(StatusCodes.BadRequest, """{"error":"every path must start with /"}""")
                } else {
                  val tenant = tenantOpt.get
                  val idemKey = idemOpt.get
                  val paths = dedupePaths(body.paths)
                  val duplicates = body.paths.diff(paths).distinct
                  requiredScope(paths) match {
                    case Some(scope) if !scopes.contains(scope) =>
                      complete(StatusCodes.Forbidden, s"""{"error":"$scope scope is required for wildcard patterns"}""")
                    case scope =>
                      store.get(tenant, idemKey) match {
                        case Some(stored) =>
                          complete(StatusCodes.Accepted, stored)
                        case None =>
                          val purge =
                            Purge(UUID.randomUUID().toString, StatusAccepted, domain, paths, scope.isDefined, duplicates)
                          provider.submitPurge(purge.purge_id, domain, paths)
                          store.put(tenant, idemKey, purge)
                          complete(StatusCodes.Accepted, purge)
                      }
                  }
                }
              }
            }
          }
        }
      }
    }

  def main(args: Array[String]): Unit = {
    Http().newServerAt("0.0.0.0", 8443).bind(route)
  }
}
`,
    },
    cpp: {
      starter: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <string>
#include <vector>

using json = nlohmann::json;

constexpr std::size_t kMaxPaths = 500;

struct PurgeStore {
  std::optional<json> get(const std::string& tenant, const std::string& idemKey);
  void put(const std::string& tenant, const std::string& idemKey, const json& purge);
};

struct PurgeProvider {
  void SubmitPurge(const std::string& purgeId, const std::string& domain, const std::vector<std::string>& paths);
};

PurgeStore store;
PurgeProvider provider;

std::string uuidString();

int main() {
  httplib::Server svr;

  svr.Post("/v1/purges", [](const httplib::Request& req, httplib::Response& res) {
    const auto tenant = req.get_header_value("X-Tenant-Id");
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) {
      res.status = 400;
      res.set_content(R"({"error":"invalid json"})", "application/json");
      return;
    }
    // TODO: this draft lets any token purge a whole domain with a wildcard, forwards a path list of
    // any size, and re-runs the whole purge when the same Idempotency-Key is replayed. Review all
    // three: gate wildcards behind the elevated scope, cap and dedupe the paths, and answer a replay
    // from the stored purge instead of calling the provider again.
    const auto domain = body.value("domain", std::string());
    const auto paths = body.value("paths", std::vector<std::string>());
    const json purge = {{"purge_id", uuidString()}, {"status", "queued"}, {"domain", domain}, {"paths", paths}};
    provider.SubmitPurge(purge["purge_id"], domain, paths);
    res.status = 200;
    res.set_content(purge.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <optional>
#include <set>
#include <string>
#include <vector>

using json = nlohmann::json;

constexpr std::size_t kMaxPaths = 500;
const std::string kStatusAccepted = "accepted";
const std::string kWildcardScope = "purge:wildcard";
const std::string kDomainScope = "purge:domain";
const std::string kDomainNotOwned = "domain is not owned by the tenant";

struct PurgeStore {
  std::optional<json> get(const std::string& tenant, const std::string& idemKey);
  void put(const std::string& tenant, const std::string& idemKey, const json& purge);
};

struct PurgeProvider {
  void SubmitPurge(const std::string& purgeId, const std::string& domain, const std::vector<std::string>& paths);
};

struct TenantDomains {
  bool owns(const std::string& tenant, const std::string& domain);
};

PurgeStore store;
PurgeProvider provider;
TenantDomains domains;

std::string uuidString();

bool ownsDomain(const std::string& tenant, const std::string& domain) { return domains.owns(tenant, domain); }

bool hasWildcard(const std::string& path) { return path.find('*') != std::string::npos; }

bool isWholeDomain(const std::string& path) { return path == "/*"; }

std::vector<std::string> dedupePaths(const std::vector<std::string>& paths) {
  std::vector<std::string> unique;
  std::set<std::string> seen;
  for (const auto& path : paths) {
    if (seen.insert(path).second) unique.push_back(path);
  }
  return unique;
}

// requiredScope is the elevated scope a wildcard request needs, empty for literal paths.
std::string requiredScope(const std::vector<std::string>& paths) {
  for (const auto& path : paths) {
    if (isWholeDomain(path)) return kDomainScope;
  }
  for (const auto& path : paths) {
    if (hasWildcard(path)) return kWildcardScope;
  }
  return "";
}

std::set<std::string> parseScopes(const std::string& header) {
  std::set<std::string> scopes;
  std::string current;
  std::string trimmed;
  for (const char c : header + ",") {
    if (c == ',') {
      if (!trimmed.empty()) scopes.insert(trimmed);
      trimmed.clear();
      continue;
    }
    if (c != ' ' && c != '\\t') trimmed.push_back(c);
  }
  return scopes;
}

int main() {
  httplib::Server svr;

  svr.Post("/v1/purges", [](const httplib::Request& req, httplib::Response& res) {
    const auto reject = [&res](int status, const std::string& message) {
      res.status = status;
      res.set_content(json{{"error", message}}.dump(), "application/json");
    };

    const auto tenant = req.get_header_value("X-Tenant-Id");
    if (tenant.empty()) {
      reject(401, "missing X-Tenant-Id");
      return;
    }
    const auto idemKey = req.get_header_value("Idempotency-Key");
    if (idemKey.empty()) {
      reject(400, "Idempotency-Key is required");
      return;
    }
    const json body = json::parse(req.body, nullptr, false);
    if (!body.is_object() || !body.contains("domain") || !body["domain"].is_string()) {
      reject(400, "domain is required");
      return;
    }
    const auto domain = body["domain"].get<std::string>();
    if (domain.empty()) {
      reject(400, "domain is required");
      return;
    }
    if (!ownsDomain(tenant, domain)) {
      reject(403, kDomainNotOwned);
      return;
    }
    if (!body.contains("paths") || !body["paths"].is_array() || body["paths"].empty()) {
      reject(400, "at least one path is required");
      return;
    }
    const auto requested = body["paths"].get<std::vector<std::string>>();
    if (requested.size() > kMaxPaths) {
      reject(400, "at most 500 paths per purge");
      return;
    }
    for (const auto& path : requested) {
      if (path.empty() || path[0] != '/') {
        reject(400, "every path must start with /");
        return;
      }
    }
    const auto paths = dedupePaths(requested);
    std::set<std::string> seen;
    std::set<std::string> duplicateSet;
    for (const auto& path : requested) {
      if (!seen.insert(path).second) duplicateSet.insert(path);
    }
    const std::vector<std::string> duplicates(duplicateSet.begin(), duplicateSet.end());
    const auto scope = requiredScope(paths);
    if (!scope.empty() && parseScopes(req.get_header_value("X-Purge-Scope")).count(scope) == 0) {
      reject(403, scope + " scope is required for wildcard patterns");
      return;
    }
    const auto stored = store.get(tenant, idemKey);
    if (stored) {
      res.status = 202;
      res.set_content(stored->dump(), "application/json");
      return;
    }
    const json purge = {
        {"purge_id", uuidString()},
        {"status", kStatusAccepted},
        {"domain", domain},
        {"paths", paths},
        {"wildcard", !scope.empty()},
        {"duplicates", duplicates},
    };
    provider.SubmitPurge(purge["purge_id"].get<std::string>(), domain, paths);
    store.put(tenant, idemKey, purge);
    res.status = 202;
    res.set_content(purge.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  hints: [
    'Order the guard clauses by cost, and put the expensive one — the provider call — last: tenant (401), Idempotency-Key (400), domain shape (400), ownership (403), path count and shape (400), dedupe, wildcard scope (403), idempotency lookup, then submit.',
    'Wildcards are two privileges, not one: `purge:wildcard` covers patterns inside a domain, `purge:domain` covers `/*`. Parse `X-Purge-Scope` as a comma-separated set, compute the scope the request needs from the paths, and reject with 403 when the caller does not hold it — before anything reaches the provider.',
    'The idempotency lookup must come before the submission, and it must return the *stored* purge so the replayed response carries the original `purge_id`. Storing after the provider call is fine as long as the record is written once and the replay path never submits again.',
  ],
  debrief: `The interviewer is testing whether you can review a generated handler at the trust boundary. The draft reads fine because the demo purges one literal path on the tenant's own domain. Three separate defects are being checked: authorization granularity (which the wildcard check measures — a normal token must not be able to turn one request into a domain-wide origin stampede), input caps and dedupe (cheap rejections that keep one body from carrying a year of URLs, plus collapsing what the caller sent twice), and idempotency keyed by \`(tenant, key)\` so the retry of a deploy purge returns the first purge instead of doubling provider calls. Real control planes add a per-tenant purge budget, a domain allowlist that ops can lock during a launch, and an audit row for every wildcard that was granted — the three things the later steps of this course build.`,
};
