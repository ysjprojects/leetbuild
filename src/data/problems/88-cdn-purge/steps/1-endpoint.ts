import type {Step} from '@/lib/types';

export const endpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/purges: a purge with a blast radius',
  concept: 'http',
  file: 'api',
  focus: ['client', 'purge', 'records'],
  task: `## Task

**Starting point.** The starter serves \`POST /v1/purges\` with body \`{"domain", "paths", "reason"}\`
on the purge records (\`purge.records\`, provided): it reads the tenant from \`X-Tenant-Id\` (**401**
when missing), creates the purge with \`records.create\` (every path pending, queued for the
provider client) and answers \`202 {purge_id, status: "accepted", domain, paths}\`. It serves the
demo and hides four flaws.

**Failure mode the checks target.** Any tenant can purge any customer's domain; one body carries
ten thousand paths or a path without its leading slash; a normal token sends \`/*\` and every edge
misses at once against the origin; a deploy script that retries after a timeout queues the same
purge twice.

- \`domain\` must be the tenant's (\`records.owns_domain\`); another tenant's domain is **403**.
- \`paths\` holds 1 to \`MAX_PATHS\` = 500 entries, each starting with \`/\`, else **400**; duplicates
  collapse, first occurrence kept, before the record is created.
- A path containing \`*\` needs the scope \`purge:wildcard\` (\`WILDCARD_SCOPE\`), and \`/*\` needs
  \`purge:domain\` (\`DOMAIN_SCOPE\`). Scopes arrive comma-separated in \`X-Purge-Scope\`; without the
  scope the request is **403**.
- \`Idempotency-Key\` is required (**400**). Look up \`records.purge_for_key(tenant, key)\` before
  creating and answer the recorded purge on a replay; \`records.remember_key\` after creating.

:::widget idempotency {}`,
  sequence: {
    participants: ['Deploy script', 'Purge API', 'purge records'],
    messages: [
      {from: 'Deploy script', to: 'Purge API', label: 'POST /v1/purges · X-Tenant-Id · Idempotency-Key', kind: 'sync'},
      {from: 'Purge API', to: 'purge records', label: 'owns_domain(tenant, domain)', kind: 'sync'},
      {from: 'Purge API', to: 'Purge API', label: '1..500 paths · leading / · dedupe · X-Purge-Scope', kind: 'sync'},
      {from: 'Purge API', to: 'purge records', label: 'purge_for_key(tenant, key) → recorded / none', kind: 'sync'},
      {from: 'Purge API', to: 'purge records', label: 'create(tenant, domain, paths) · remember_key', kind: 'sync'},
      {from: 'Purge API', to: 'Deploy script', label: '202 {purge_id, status: "accepted"}', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Accepts a purge with 202 and records it',
      detail:
        'A purge of the tenant’s own domain answers **202** with `status: "accepted"` and the purge id, and the record holds the paths, queued for the provider client.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/purges["']/, /records\.create\(/, /status_code=202/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/purges['"]/, /\bcreate\(/, /code\(202\)/]},
        go: {all: [/HandleFunc\(\s*"POST \/v1\/purges"/, /records\.Create\(/, /StatusAccepted/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"purges"\s*\)/, /Records\.create\(/, /StatusCodes\.Accepted/]},
        cpp: {all: [/svr\.Post\(\s*"\/v1\/purges"/, /records::create\(/, /\b202\b/]},
      },
    },
    {
      id: 'domain-ownership',
      title: 'Purges only a domain the tenant owns',
      detail:
        'The domain is checked against the tenant’s (`owns_domain`/`ownsDomain`) before the purge is created; another tenant’s domain is **403** and nothing is queued. The starter queues a purge of any domain for any tenant.',
      match: {
        python: {all: [/status_code=403/], order: [/records\.owns_domain\(/, /records\.create\(/]},
        typescript: {all: [/code\(403\)/], order: [/\bownsDomain\(/, /\bcreate\(/]},
        go: {all: [/StatusForbidden/], order: [/records\.OwnsDomain\(/, /records\.Create\(/]},
        scala: {all: [/StatusCodes\.Forbidden/], order: [/Records\.ownsDomain\(/, /Records\.create\(/]},
        cpp: {all: [/\b403\b/], order: [/records::ownsDomain\(/, /records::create\(/]},
      },
    },
    {
      id: 'path-cap',
      title: 'Bounds a purge to 500 well-formed, deduplicated paths',
      detail:
        'An empty list, more than 500 paths (`MAX_PATHS`) or a path without a leading `/` is **400** and nothing is queued; repeated paths collapse to their first occurrence. The starter queues whatever list it is handed.',
      match: {
        python: {all: [/MAX_PATHS\s*=\s*500/, /startswith\(\s*["']\/["']\s*\)/]},
        typescript: {all: [/MAX_PATHS\s*=\s*500/, /startsWith\(\s*['"]\/['"]\s*\)/]},
        go: {all: [/maxPaths\s*=\s*500/, /strings\.HasPrefix\([^)]*"\/"\s*\)/]},
        scala: {all: [/MaxPaths\s*=\s*500/, /startsWith\(\s*"\/"\s*\)/]},
        cpp: {
          all: [/kMaxPaths\s*=\s*500/, /starts_with\(\s*"\/"\s*\)|rfind\(\s*"\/"\s*,\s*0\s*\)|\[0\]\s*[!=]=\s*'\/'/],
        },
      },
    },
    {
      id: 'blast-radius',
      title: 'Gates wildcards behind purge:wildcard and /* behind purge:domain',
      detail:
        'A pattern with `*` needs `purge:wildcard` in `X-Purge-Scope`, the whole-domain `/*` needs `purge:domain`, and a request without the scope is **403** before anything is queued. The starter queues `/*` from any token.',
      match: {
        python: {
          all: [
            /WILDCARD_SCOPE\s*=\s*["']purge:wildcard["']/,
            /DOMAIN_SCOPE\s*=\s*["']purge:domain["']/,
            /x-purge-scope/i,
          ],
        },
        typescript: {
          all: [
            /WILDCARD_SCOPE\s*=\s*['"]purge:wildcard['"]/,
            /DOMAIN_SCOPE\s*=\s*['"]purge:domain['"]/,
            /x-purge-scope/i,
          ],
        },
        go: {all: [/wildcardScope\s*=\s*"purge:wildcard"/, /domainScope\s*=\s*"purge:domain"/, /X-Purge-Scope/i]},
        scala: {all: [/WildcardScope\s*=\s*"purge:wildcard"/, /DomainScope\s*=\s*"purge:domain"/, /X-Purge-Scope/i]},
        cpp: {all: [/kWildcardScope\s*=\s*"purge:wildcard"/, /kDomainScope\s*=\s*"purge:domain"/, /X-Purge-Scope/i]},
      },
    },
    {
      id: 'idempotent-replay',
      title: 'A replayed Idempotency-Key answers the original purge',
      detail:
        '`Idempotency-Key` is required (**400**), the purge recorded for `(tenant, key)` is looked up before a purge is created and answered on a replay, and a new purge remembers its key. The starter queues every retry as a new purge.',
      match: {
        python: {
          all: [/idempotency-key/i, /records\.remember_key\(/, /status_code=400/],
          order: [/records\.purge_for_key\(/, /records\.create\(/],
        },
        typescript: {
          all: [/idempotency-key/i, /\brememberKey\(/, /code\(400\)/],
          order: [/\bpurgeForKey\(/, /\bcreate\(/],
        },
        go: {
          all: [/Idempotency-Key/i, /records\.RememberKey\(/, /StatusBadRequest/],
          order: [/records\.PurgeForKey\(/, /records\.Create\(/],
        },
        scala: {
          all: [/Idempotency-Key/i, /Records\.rememberKey\(/, /StatusCodes\.BadRequest/],
          order: [/Records\.purgeForKey\(/, /Records\.create\(/],
        },
        cpp: {
          all: [/Idempotency-Key/i, /records::rememberKey\(/, /\b400\b/],
          order: [/records::purgeForKey\(/, /records::create\(/],
        },
      },
    },
  ],
  code: {
    python: {
      starter: `from fastapi import FastAPI, HTTPException, Request
from pydantic import BaseModel

from purge import records  # owns_domain, create, get, purge_for_key, remember_key

app = FastAPI()


class PurgeRequest(BaseModel):
    domain: str
    paths: list[str]
    reason: str = ""


def accepted(purge: dict) -> dict:
    return {"purge_id": purge["purge_id"], "status": "accepted", "domain": purge["domain"], "paths": purge["paths"]}


@app.post("/v1/purges", status_code=202)
def create_purge(body: PurgeRequest, request: Request) -> dict:
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    tenant = request.headers.get("x-tenant-id", "")
    if not tenant:
        raise HTTPException(status_code=401, detail="X-Tenant-Id is required")
    purge = records.create(tenant, body.domain, body.paths)
    return accepted(purge)
`,
      solution: `from fastapi import FastAPI, HTTPException, Request
from pydantic import BaseModel

from purge import records  # owns_domain, create, get, purge_for_key, remember_key

app = FastAPI()

MAX_PATHS = 500
WILDCARD_SCOPE = "purge:wildcard"
DOMAIN_SCOPE = "purge:domain"


class PurgeRequest(BaseModel):
    domain: str
    paths: list[str]
    reason: str = ""


def accepted(purge: dict) -> dict:
    return {"purge_id": purge["purge_id"], "status": "accepted", "domain": purge["domain"], "paths": purge["paths"]}


def required_scope(paths: list[str]) -> str | None:
    """The scope the request's patterns need: the whole domain, a wildcard, or none for literal paths."""
    if "/*" in paths:
        return DOMAIN_SCOPE
    if any("*" in path for path in paths):
        return WILDCARD_SCOPE
    return None


@app.post("/v1/purges", status_code=202)
def create_purge(body: PurgeRequest, request: Request) -> dict:
    tenant = request.headers.get("x-tenant-id", "")
    if not tenant:
        raise HTTPException(status_code=401, detail="X-Tenant-Id is required")
    key = request.headers.get("idempotency-key", "")
    if not key:
        raise HTTPException(status_code=400, detail="Idempotency-Key is required")
    if not records.owns_domain(tenant, body.domain):
        raise HTTPException(status_code=403, detail=f"{body.domain} is not one of your domains")
    if not 1 <= len(body.paths) <= MAX_PATHS:
        raise HTTPException(status_code=400, detail=f"a purge carries 1 to {MAX_PATHS} paths")
    if any(not path.startswith("/") for path in body.paths):
        raise HTTPException(status_code=400, detail="every path starts with /")
    paths = list(dict.fromkeys(body.paths))  # duplicates collapse, first occurrence kept
    scope = required_scope(paths)
    granted = {s.strip() for s in request.headers.get("x-purge-scope", "").split(",")}
    if scope is not None and scope not in granted:
        raise HTTPException(status_code=403, detail=f"these patterns need the {scope} scope")
    recorded = records.purge_for_key(tenant, key)
    if recorded is not None:
        return accepted(records.get(recorded))  # a replay answers the purge the first attempt created
    purge = records.create(tenant, body.domain, paths)
    records.remember_key(tenant, key, purge["purge_id"])
    return accepted(purge)
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';

import {type Purge, create, get, ownsDomain, purgeForKey, rememberKey} from 'purge/records';

export const app = Fastify();

interface PurgeRequest {
  domain: string;
  paths: string[];
  reason?: string;
}

const accepted = (purge: Purge) => ({purge_id: purge.purge_id, status: 'accepted', domain: purge.domain, paths: purge.paths});

app.post('/v1/purges', async (request, reply) => {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'X-Tenant-Id is required'});
  const body = request.body as PurgeRequest;
  const purge = await create(tenant, body.domain, body.paths);
  return reply.code(202).send(accepted(purge));
});
`,
      solution: `import Fastify from 'fastify';

import {type Purge, create, get, ownsDomain, purgeForKey, rememberKey} from 'purge/records';

export const app = Fastify();

export const MAX_PATHS = 500;
export const WILDCARD_SCOPE = 'purge:wildcard';
export const DOMAIN_SCOPE = 'purge:domain';

interface PurgeRequest {
  domain: string;
  paths: string[];
  reason?: string;
}

const accepted = (purge: Purge) => ({purge_id: purge.purge_id, status: 'accepted', domain: purge.domain, paths: purge.paths});

/** The scope the request's patterns need: the whole domain, a wildcard, or none for literal paths. */
function requiredScope(paths: string[]): string | null {
  if (paths.includes('/*')) return DOMAIN_SCOPE;
  if (paths.some(path => path.includes('*'))) return WILDCARD_SCOPE;
  return null;
}

app.post('/v1/purges', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'X-Tenant-Id is required'});
  const key = request.headers['idempotency-key'];
  if (typeof key !== 'string' || key === '') return reply.code(400).send({error: 'Idempotency-Key is required'});
  const body = request.body as PurgeRequest;
  if (!(await ownsDomain(tenant, body.domain))) return reply.code(403).send({error: \`\${body.domain} is not one of your domains\`});
  if (!Array.isArray(body.paths) || body.paths.length < 1 || body.paths.length > MAX_PATHS) {
    return reply.code(400).send({error: \`a purge carries 1 to \${MAX_PATHS} paths\`});
  }
  if (body.paths.some(path => !path.startsWith('/'))) return reply.code(400).send({error: 'every path starts with /'});
  const paths = [...new Set(body.paths)]; // duplicates collapse, first occurrence kept
  const scope = requiredScope(paths);
  const granted = String(request.headers['x-purge-scope'] ?? '').split(',').map(s => s.trim());
  if (scope !== null && !granted.includes(scope)) return reply.code(403).send({error: \`these patterns need the \${scope} scope\`});
  const recorded = await purgeForKey(tenant, key);
  if (recorded !== null) return reply.code(202).send(accepted((await get(recorded)) as Purge)); // a replay answers the first purge
  const purge = await create(tenant, body.domain, paths);
  await rememberKey(tenant, key, purge.purge_id);
  return reply.code(202).send(accepted(purge));
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"net/http"

	"purge/records" // records.OwnsDomain, Create, Get, PurgeForKey, RememberKey
)

type purgeRequest struct {
	Domain string   \`json:"domain"\`
	Paths  []string \`json:"paths"\`
	Reason string   \`json:"reason"\`
}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func accepted(p *records.Purge) map[string]any {
	return map[string]any{"purge_id": p.PurgeID, "status": "accepted", "domain": p.Domain, "paths": p.Paths}
}

func createPurge(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		http.Error(rw, "X-Tenant-Id is required", http.StatusUnauthorized)
		return
	}
	var body purgeRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(rw, "the body is not JSON", http.StatusBadRequest)
		return
	}
	purge := records.Create(r.Context(), tenant, body.Domain, body.Paths)
	writeJSON(rw, http.StatusAccepted, accepted(purge))
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/purges", createPurge)
}
`,
      solution: `package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"slices"
	"strings"

	"purge/records" // records.OwnsDomain, Create, Get, PurgeForKey, RememberKey
)

const (
	maxPaths      = 500
	wildcardScope = "purge:wildcard"
	domainScope   = "purge:domain"
)

type purgeRequest struct {
	Domain string   \`json:"domain"\`
	Paths  []string \`json:"paths"\`
	Reason string   \`json:"reason"\`
}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func accepted(p *records.Purge) map[string]any {
	return map[string]any{"purge_id": p.PurgeID, "status": "accepted", "domain": p.Domain, "paths": p.Paths}
}

// requiredScope is the scope the request's patterns need: the whole domain, a wildcard, or "" for literal paths.
func requiredScope(paths []string) string {
	if slices.Contains(paths, "/*") {
		return domainScope
	}
	for _, path := range paths {
		if strings.Contains(path, "*") {
			return wildcardScope
		}
	}
	return ""
}

func createPurge(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		http.Error(rw, "X-Tenant-Id is required", http.StatusUnauthorized)
		return
	}
	key := r.Header.Get("Idempotency-Key")
	if key == "" {
		http.Error(rw, "Idempotency-Key is required", http.StatusBadRequest)
		return
	}
	var body purgeRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(rw, "the body is not JSON", http.StatusBadRequest)
		return
	}
	if !records.OwnsDomain(r.Context(), tenant, body.Domain) {
		http.Error(rw, body.Domain+" is not one of your domains", http.StatusForbidden)
		return
	}
	if len(body.Paths) < 1 || len(body.Paths) > maxPaths {
		http.Error(rw, fmt.Sprintf("a purge carries 1 to %d paths", maxPaths), http.StatusBadRequest)
		return
	}
	var paths []string
	seen := map[string]bool{}
	for _, path := range body.Paths {
		if !strings.HasPrefix(path, "/") {
			http.Error(rw, "every path starts with /", http.StatusBadRequest)
			return
		}
		if !seen[path] { // duplicates collapse, first occurrence kept
			seen[path] = true
			paths = append(paths, path)
		}
	}
	if scope := requiredScope(paths); scope != "" {
		granted := strings.Split(r.Header.Get("X-Purge-Scope"), ",")
		for i := range granted {
			granted[i] = strings.TrimSpace(granted[i])
		}
		if !slices.Contains(granted, scope) {
			http.Error(rw, "these patterns need the "+scope+" scope", http.StatusForbidden)
			return
		}
	}
	if recorded := records.PurgeForKey(r.Context(), tenant, key); recorded != "" {
		writeJSON(rw, http.StatusAccepted, accepted(records.Get(r.Context(), recorded))) // a replay answers the first purge
		return
	}
	purge := records.Create(r.Context(), tenant, body.Domain, paths)
	records.RememberKey(r.Context(), tenant, key, purge.PurgeID)
	writeJSON(rw, http.StatusAccepted, accepted(purge))
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/purges", createPurge)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import purge.Records // Records.ownsDomain, create, get, purgeForKey, rememberKey

object Api {
  private def json(status: StatusCode, body: JsObject): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  private def error(status: StatusCode, message: String): HttpResponse = json(status, JsObject("error" -> JsString(message)))

  private def accepted(p: Records.Purge): JsObject = JsObject(
    "purge_id" -> JsString(p.purgeId),
    "status" -> JsString("accepted"),
    "domain" -> JsString(p.domain),
    "paths" -> JsArray(p.paths.map(JsString(_)).toVector)
  )

  def createPurge(tenant: String, raw: String): HttpResponse = {
    // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    if (tenant.isEmpty) return error(StatusCodes.Unauthorized, "X-Tenant-Id is required")
    val body = raw.parseJson.asJsObject
    val domain = body.fields.get("domain").collect { case JsString(s) => s }.getOrElse("")
    val paths = body.fields.get("paths").collect { case JsArray(items) => items.collect { case JsString(s) => s } }.getOrElse(Vector.empty)
    json(StatusCodes.Accepted, accepted(Records.create(tenant, domain, paths)))
  }

  val route: Route = path("v1" / "purges") {
    post {
      optionalHeaderValueByName("X-Tenant-Id") { tenant =>
        entity(as[String]) { raw => complete(createPurge(tenant.getOrElse(""), raw)) }
      }
    }
  }
}
`,
      solution: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import purge.Records // Records.ownsDomain, create, get, purgeForKey, rememberKey

object Api {
  val MaxPaths = 500
  val WildcardScope = "purge:wildcard"
  val DomainScope = "purge:domain"

  private def json(status: StatusCode, body: JsObject): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  private def error(status: StatusCode, message: String): HttpResponse = json(status, JsObject("error" -> JsString(message)))

  private def accepted(p: Records.Purge): JsObject = JsObject(
    "purge_id" -> JsString(p.purgeId),
    "status" -> JsString("accepted"),
    "domain" -> JsString(p.domain),
    "paths" -> JsArray(p.paths.map(JsString(_)).toVector)
  )

  /** The scope the request's patterns need: the whole domain, a wildcard, or none for literal paths. */
  def requiredScope(paths: Seq[String]): Option[String] =
    if (paths.contains("/*")) Some(DomainScope)
    else if (paths.exists(_.contains("*"))) Some(WildcardScope)
    else None

  def createPurge(tenant: String, key: String, scopes: String, raw: String): HttpResponse = {
    if (tenant.isEmpty) return error(StatusCodes.Unauthorized, "X-Tenant-Id is required")
    if (key.isEmpty) return error(StatusCodes.BadRequest, "Idempotency-Key is required")
    val body = raw.parseJson.asJsObject
    val domain = body.fields.get("domain").collect { case JsString(s) => s }.getOrElse("")
    val requested = body.fields.get("paths").collect { case JsArray(items) => items.collect { case JsString(s) => s } }.getOrElse(Vector.empty)
    if (!Records.ownsDomain(tenant, domain)) return error(StatusCodes.Forbidden, s"$domain is not one of your domains")
    if (requested.isEmpty || requested.size > MaxPaths) return error(StatusCodes.BadRequest, s"a purge carries 1 to $MaxPaths paths")
    if (requested.exists(path => !path.startsWith("/"))) return error(StatusCodes.BadRequest, "every path starts with /")
    val paths = requested.distinct // duplicates collapse, first occurrence kept
    val granted = scopes.split(",").map(_.trim).toSet
    requiredScope(paths).filterNot(granted.contains) match {
      case Some(scope) => error(StatusCodes.Forbidden, s"these patterns need the $scope scope")
      case None =>
        Records.purgeForKey(tenant, key).flatMap(Records.get) match {
          case Some(recorded) => json(StatusCodes.Accepted, accepted(recorded)) // a replay answers the first purge
          case None =>
            val created = Records.create(tenant, domain, paths)
            Records.rememberKey(tenant, key, created.purgeId)
            json(StatusCodes.Accepted, accepted(created))
        }
    }
  }

  val route: Route = path("v1" / "purges") {
    post {
      (optionalHeaderValueByName("X-Tenant-Id") & optionalHeaderValueByName("Idempotency-Key") & optionalHeaderValueByName("X-Purge-Scope")) {
        (tenant, key, scopes) =>
          entity(as[String]) { raw => complete(createPurge(tenant.getOrElse(""), key.getOrElse(""), scopes.getOrElse(""), raw)) }
      }
    }
  }
}
`,
    },
    cpp: {
      starter: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <string>
#include <vector>

#include "purge/records.h"  // records::ownsDomain, create, get, purgeForKey, rememberKey

using json = nlohmann::json;

json accepted(const records::Purge& purge) {
  return json{{"purge_id", purge.purge_id}, {"status", "accepted"}, {"domain", purge.domain}, {"paths", purge.paths}};
}

void reply(httplib::Response& res, int status, const json& body) {
  res.status = status;
  res.set_content(body.dump(), "application/json");
}

void create_purge(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) return reply(res, 401, json{{"error", "X-Tenant-Id is required"}});
  const json body = json::parse(req.body, nullptr, false);
  if (!body.is_object() || !body.contains("paths") || !body["paths"].is_array()) {
    return reply(res, 400, json{{"error", "the body needs a domain and a paths list"}});
  }
  const auto paths = body["paths"].get<std::vector<std::string>>();
  reply(res, 202, accepted(records::create(tenant, body.value("domain", ""), paths)));
}

void register_routes(httplib::Server& svr) { svr.Post("/v1/purges", create_purge); }
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <algorithm>
#include <set>
#include <sstream>
#include <string>
#include <vector>

#include "purge/records.h"  // records::ownsDomain, create, get, purgeForKey, rememberKey

using json = nlohmann::json;

constexpr size_t kMaxPaths = 500;
const std::string kWildcardScope = "purge:wildcard";
const std::string kDomainScope = "purge:domain";

json accepted(const records::Purge& purge) {
  return json{{"purge_id", purge.purge_id}, {"status", "accepted"}, {"domain", purge.domain}, {"paths", purge.paths}};
}

void reply(httplib::Response& res, int status, const json& body) {
  res.status = status;
  res.set_content(body.dump(), "application/json");
}

// The scope the request's patterns need: the whole domain, a wildcard, or "" for literal paths.
std::string requiredScope(const std::vector<std::string>& paths) {
  if (std::find(paths.begin(), paths.end(), "/*") != paths.end()) return kDomainScope;
  for (const auto& path : paths) {
    if (path.find('*') != std::string::npos) return kWildcardScope;
  }
  return "";
}

std::set<std::string> grantedScopes(const std::string& header) {
  std::set<std::string> out;
  std::stringstream in(header);
  std::string scope;
  while (std::getline(in, scope, ',')) {
    scope.erase(0, scope.find_first_not_of(' '));
    scope.erase(scope.find_last_not_of(' ') + 1);
    out.insert(scope);
  }
  return out;
}

void create_purge(const httplib::Request& req, httplib::Response& res) {
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) return reply(res, 401, json{{"error", "X-Tenant-Id is required"}});
  const std::string key = req.get_header_value("Idempotency-Key");
  if (key.empty()) return reply(res, 400, json{{"error", "Idempotency-Key is required"}});
  const json body = json::parse(req.body, nullptr, false);
  if (!body.is_object() || !body.contains("paths") || !body["paths"].is_array()) {
    return reply(res, 400, json{{"error", "the body needs a domain and a paths list"}});
  }
  const std::string domain = body.value("domain", "");
  if (!records::ownsDomain(tenant, domain)) return reply(res, 403, json{{"error", domain + " is not one of your domains"}});
  const auto requested = body["paths"].get<std::vector<std::string>>();
  if (requested.empty() || requested.size() > kMaxPaths) return reply(res, 400, json{{"error", "a purge carries 1 to 500 paths"}});
  std::vector<std::string> paths;
  std::set<std::string> seen;
  for (const auto& path : requested) {
    if (!path.starts_with("/")) return reply(res, 400, json{{"error", "every path starts with /"}});
    if (seen.insert(path).second) paths.push_back(path);  // duplicates collapse, first occurrence kept
  }
  const std::string scope = requiredScope(paths);
  if (!scope.empty() && !grantedScopes(req.get_header_value("X-Purge-Scope")).count(scope)) {
    return reply(res, 403, json{{"error", "these patterns need the " + scope + " scope"}});
  }
  if (const auto recorded = records::purgeForKey(tenant, key)) {
    return reply(res, 202, accepted(*records::get(*recorded)));  // a replay answers the first purge
  }
  const records::Purge purge = records::create(tenant, domain, paths);
  records::rememberKey(tenant, key, purge.purge_id);
  reply(res, 202, accepted(purge));
}

void register_routes(httplib::Server& svr) { svr.Post("/v1/purges", create_purge); }
`,
    },
  },
  harness: {
    python: `from purge import records

DOMAIN = "shop.example.com"


def _api(ctx):
    records.add_domain("t1", DOMAIN)
    records.add_domain("t2", "rival.example.com")
    return ctx.client(ctx.load("api").app)


def _headers(tenant="t1", key="k-1", scope=None):
    headers = {"X-Tenant-Id": tenant, "Idempotency-Key": key}
    if scope is not None:
        headers["X-Purge-Scope"] = scope
    return headers


async def _purge(c, paths, key="k-1", tenant="t1", domain=DOMAIN, scope=None):
    return await c.post("/v1/purges", json={"domain": domain, "paths": paths, "reason": "deploy 412"}, headers=_headers(tenant, key, scope))


async def check_route(ctx):
    async with _api(ctx) as c:
        r = await _purge(c, ["/pricing", "/img/logo.png"])
    assert r.status_code == 202, f"POST /v1/purges answered {r.status_code}: {r.text}"
    body = r.json()
    assert body.get("status") == "accepted" and body.get("domain") == DOMAIN, f"the 202 must say accepted for {DOMAIN}, got {body}"
    purge = records.get(body.get("purge_id", ""))
    assert purge is not None, f"the 202 names purge {body.get('purge_id')!r} but no record exists"
    assert purge["paths"] == ["/pricing", "/img/logo.png"], f"the record holds paths {purge['paths']}"
    assert records.queued() == [purge["purge_id"]], f"the purge must be queued for the provider client once, the queue holds {records.queued()}"


async def check_domain_ownership(ctx):
    async with _api(ctx) as c:
        anonymous = await c.post("/v1/purges", json={"domain": DOMAIN, "paths": ["/pricing"]}, headers={"Idempotency-Key": "k-0"})
        foreign = await _purge(c, ["/pricing"], domain="rival.example.com")
    assert anonymous.status_code == 401, f"a purge without X-Tenant-Id answered {anonymous.status_code}, expected 401"
    assert foreign.status_code == 403, f"tenant t1 purging rival.example.com (owned by t2) answered {foreign.status_code}, expected 403: any tenant can purge any customer's domain"
    assert records.queued() == [], f"a purge of another tenant's domain was queued: {records.queued()}"


async def check_path_cap(ctx):
    async with _api(ctx) as c:
        flood = await _purge(c, [f"/p/{i}" for i in range(501)], key="k-1")
        empty = await _purge(c, [], key="k-2")
        bare = await _purge(c, ["pricing"], key="k-3")
        assert (flood.status_code, empty.status_code, bare.status_code) == (400, 400, 400), f"501 paths, no paths and a path without a leading / answered {flood.status_code}, {empty.status_code}, {bare.status_code}, expected 400 each"
        assert records.queued() == [], f"a rejected purge was queued: {len(records.queued())} purges in the queue"
        repeated = await _purge(c, ["/a", "/b", "/a"], key="k-4")
        full = await _purge(c, [f"/p/{i}" for i in range(500)], key="k-5")
    assert repeated.status_code == 202, f"a purge of /a, /b, /a answered {repeated.status_code}: {repeated.text}"
    paths = records.get(repeated.json()["purge_id"])["paths"]
    assert paths == ["/a", "/b"], f"a purge of /a, /b, /a recorded {paths}: duplicates collapse to their first occurrence"
    assert full.status_code == 202, f"exactly 500 paths answered {full.status_code}, expected 202"


async def check_blast_radius(ctx):
    async with _api(ctx) as c:
        plain = await _purge(c, ["/img/*"], key="k-1")
        weak = await _purge(c, ["/*"], key="k-2", scope="purge:wildcard")
        assert plain.status_code == 403, f"/img/* without X-Purge-Scope answered {plain.status_code}, expected 403: a normal token fans a wildcard out to every edge"
        assert weak.status_code == 403, f"/* with only purge:wildcard answered {weak.status_code}, expected 403: the whole domain needs purge:domain"
        assert records.queued() == [], f"a wildcard without its scope was queued: {records.queued()}"
        scoped = await _purge(c, ["/img/*"], key="k-3", scope="purge:read, purge:wildcard")
        domain = await _purge(c, ["/*"], key="k-4", scope="purge:domain")
    assert scoped.status_code == 202, f"/img/* with purge:wildcard answered {scoped.status_code}: {scoped.text}"
    assert domain.status_code == 202, f"/* with purge:domain answered {domain.status_code}: {domain.text}"


async def check_idempotent_replay(ctx):
    records.add_domain("t2", "rival.example.com")
    async with _api(ctx) as c:
        first = await _purge(c, ["/pricing"], key="k-1")
        replay = await _purge(c, ["/pricing"], key="k-1")
        assert first.status_code == 202 and replay.status_code == 202, f"the purge and its replay answered {first.status_code}, {replay.status_code}"
        assert replay.json().get("purge_id") == first.json().get("purge_id"), f"the replay of Idempotency-Key k-1 created purge {replay.json().get('purge_id')}, the first attempt {first.json().get('purge_id')}: a retry after a timeout must answer the original purge"
        assert len(records.queued()) == 1, f"one purge and its replay queued {len(records.queued())} purges for the provider"
        other = await _purge(c, ["/pricing"], key="k-1", tenant="t2", domain="rival.example.com")
        assert other.status_code == 202 and other.json().get("purge_id") != first.json().get("purge_id"), f"tenant t2's key k-1 answered t1's purge: keys belong to a tenant ({other.text})"
        missing = await c.post("/v1/purges", json={"domain": DOMAIN, "paths": ["/pricing"]}, headers={"X-Tenant-Id": "t1"})
    assert missing.status_code == 400, f"a purge without Idempotency-Key answered {missing.status_code}, expected 400"
`,
    typescript: `const DOMAIN = 'shop.example.com';

async function api(ctx) {
  const records = ctx.load('/support/purge/records.ts');
  await records.addDomain('t1', DOMAIN);
  await records.addDomain('t2', 'rival.example.com');
  return {c: ctx.client(ctx.load('api').app), records};
}

function purge(c, paths: string[], key = 'k-1', opts: {tenant?: string; domain?: string; scope?: string} = {}) {
  const headers: Record<string, string> = {'X-Tenant-Id': opts.tenant ?? 't1', 'Idempotency-Key': key};
  if (opts.scope !== undefined) headers['X-Purge-Scope'] = opts.scope;
  return c.post('/v1/purges', {json: {domain: opts.domain ?? DOMAIN, paths, reason: 'deploy 412'}, headers});
}

export async function check_route(ctx) {
  const {c, records} = await api(ctx);
  const r = await purge(c, ['/pricing', '/img/logo.png']);
  assert.equal(r.status, 202, \`POST /v1/purges answered \${r.status}: \${r.text}\`);
  const body = r.json();
  assert(body.status === 'accepted' && body.domain === DOMAIN, \`the 202 must say accepted for \${DOMAIN}, got \${r.text}\`);
  const stored = await records.get(body.purge_id ?? '');
  assert(stored !== null, \`the 202 names purge \${body.purge_id} but no record exists\`);
  assert.deepEqual(stored.paths, ['/pricing', '/img/logo.png'], \`the record holds paths \${JSON.stringify(stored.paths)}\`);
  assert.deepEqual(await records.queued(), [stored.purge_id], 'the purge must be queued for the provider client once');
}

export async function check_domain_ownership(ctx) {
  const {c, records} = await api(ctx);
  const anonymous = await c.post('/v1/purges', {json: {domain: DOMAIN, paths: ['/pricing']}, headers: {'Idempotency-Key': 'k-0'}});
  const foreign = await purge(c, ['/pricing'], 'k-1', {domain: 'rival.example.com'});
  assert.equal(anonymous.status, 401, \`a purge without X-Tenant-Id answered \${anonymous.status}, expected 401\`);
  assert.equal(foreign.status, 403, \`tenant t1 purging rival.example.com (owned by t2) answered \${foreign.status}, expected 403: any tenant can purge any customer's domain\`);
  assert.deepEqual(await records.queued(), [], 'a purge of another tenant\\'s domain was queued');
}

export async function check_path_cap(ctx) {
  const {c, records} = await api(ctx);
  const flood = await purge(c, Array.from({length: 501}, (_, i) => \`/p/\${i}\`), 'k-1');
  const empty = await purge(c, [], 'k-2');
  const bare = await purge(c, ['pricing'], 'k-3');
  assert.deepEqual([flood.status, empty.status, bare.status], [400, 400, 400], \`501 paths, no paths and a path without a leading / answered \${flood.status}, \${empty.status}, \${bare.status}, expected 400 each\`);
  assert.deepEqual(await records.queued(), [], 'a rejected purge was queued');
  const repeated = await purge(c, ['/a', '/b', '/a'], 'k-4');
  const full = await purge(c, Array.from({length: 500}, (_, i) => \`/p/\${i}\`), 'k-5');
  assert.equal(repeated.status, 202, \`a purge of /a, /b, /a answered \${repeated.status}: \${repeated.text}\`);
  const paths = (await records.get(repeated.json().purge_id)).paths;
  assert.deepEqual(paths, ['/a', '/b'], \`a purge of /a, /b, /a recorded \${JSON.stringify(paths)}: duplicates collapse to their first occurrence\`);
  assert.equal(full.status, 202, \`exactly 500 paths answered \${full.status}, expected 202\`);
}

export async function check_blast_radius(ctx) {
  const {c, records} = await api(ctx);
  const plain = await purge(c, ['/img/*'], 'k-1');
  const weak = await purge(c, ['/*'], 'k-2', {scope: 'purge:wildcard'});
  assert.equal(plain.status, 403, \`/img/* without X-Purge-Scope answered \${plain.status}, expected 403: a normal token fans a wildcard out to every edge\`);
  assert.equal(weak.status, 403, \`/* with only purge:wildcard answered \${weak.status}, expected 403: the whole domain needs purge:domain\`);
  assert.deepEqual(await records.queued(), [], 'a wildcard without its scope was queued');
  const scoped = await purge(c, ['/img/*'], 'k-3', {scope: 'purge:read, purge:wildcard'});
  const domain = await purge(c, ['/*'], 'k-4', {scope: 'purge:domain'});
  assert.equal(scoped.status, 202, \`/img/* with purge:wildcard answered \${scoped.status}: \${scoped.text}\`);
  assert.equal(domain.status, 202, \`/* with purge:domain answered \${domain.status}: \${domain.text}\`);
}

export async function check_idempotent_replay(ctx) {
  const {c, records} = await api(ctx);
  const first = await purge(c, ['/pricing'], 'k-1');
  const replay = await purge(c, ['/pricing'], 'k-1');
  assert(first.status === 202 && replay.status === 202, \`the purge and its replay answered \${first.status}, \${replay.status}\`);
  assert.equal(replay.json().purge_id, first.json().purge_id, \`the replay of Idempotency-Key k-1 created purge \${replay.json().purge_id}, the first attempt \${first.json().purge_id}: a retry after a timeout must answer the original purge\`);
  assert.equal((await records.queued()).length, 1, 'one purge and its replay must queue one purge for the provider');
  const other = await purge(c, ['/pricing'], 'k-1', {tenant: 't2', domain: 'rival.example.com'});
  assert(other.status === 202 && other.json().purge_id !== first.json().purge_id, \`tenant t2's key k-1 answered t1's purge: keys belong to a tenant (\${other.text})\`);
  const missing = await c.post('/v1/purges', {json: {domain: DOMAIN, paths: ['/pricing']}, headers: {'X-Tenant-Id': 't1'}});
  assert.equal(missing.status, 400, \`a purge without Idempotency-Key answered \${missing.status}, expected 400\`);
}
`,
    go: `package main

import (
	"context"
	"fmt"
	"net/http"

	"purge/records"

	"leetbuild/harness"
)

const apiDomain = "shop.example.com"

var apiBg = context.Background()

func api(ctx *harness.Ctx) *harness.HTTP {
	records.AddDomain(apiBg, "t1", apiDomain)
	records.AddDomain(apiBg, "t2", "rival.example.com")
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

func purgeReq(c *harness.HTTP, paths []string, key, tenant, domain, scope string) *harness.Response {
	headers := []string{"X-Tenant-Id", tenant, "Idempotency-Key", key}
	if scope != "" {
		headers = append(headers, "X-Purge-Scope", scope)
	}
	return c.Post("/v1/purges", map[string]any{"domain": domain, "paths": paths, "reason": "deploy 412"}, headers...)
}

func numbered(n int) []string {
	out := make([]string, n)
	for i := range out {
		out[i] = fmt.Sprintf("/p/%d", i)
	}
	return out
}

type acceptedBody struct {
	PurgeID string \`json:"purge_id"\`
	Status  string \`json:"status"\`
	Domain  string \`json:"domain"\`
}

func decodeAccepted(r *harness.Response) acceptedBody {
	var body acceptedBody
	if r.Status == 202 {
		r.Decode(&body)
	}
	return body
}

func CheckRoute(ctx *harness.Ctx) {
	c := api(ctx)
	r := purgeReq(c, []string{"/pricing", "/img/logo.png"}, "k-1", "t1", apiDomain, "")
	ctx.Equal(r.Status, 202, "POST /v1/purges (%s)", r.Text())
	body := decodeAccepted(r)
	ctx.Assert(body.Status == "accepted" && body.Domain == apiDomain, "the 202 must say accepted for %s, got %s", apiDomain, r.Text())
	stored := records.Get(apiBg, body.PurgeID)
	ctx.Assert(stored != nil, "the 202 names purge %q but no record exists", body.PurgeID)
	ctx.Equal(stored.Paths, []string{"/pricing", "/img/logo.png"}, "the record's paths")
	ctx.Equal(records.Queued(apiBg), []string{stored.PurgeID}, "the purge must be queued for the provider client once; the queue")
}

func CheckDomainOwnership(ctx *harness.Ctx) {
	c := api(ctx)
	anonymous := c.Post("/v1/purges", map[string]any{"domain": apiDomain, "paths": []string{"/pricing"}}, "Idempotency-Key", "k-0")
	foreign := purgeReq(c, []string{"/pricing"}, "k-1", "t1", "rival.example.com", "")
	ctx.Equal(anonymous.Status, 401, "a purge without X-Tenant-Id")
	ctx.Equal(foreign.Status, 403, "tenant t1 purging rival.example.com (owned by t2): any tenant can purge any customer's domain")
	ctx.Equal(len(records.Queued(apiBg)), 0, "a purge of another tenant's domain must not be queued; the queued purges")
}

func CheckPathCap(ctx *harness.Ctx) {
	c := api(ctx)
	flood := purgeReq(c, numbered(501), "k-1", "t1", apiDomain, "")
	empty := purgeReq(c, []string{}, "k-2", "t1", apiDomain, "")
	bare := purgeReq(c, []string{"pricing"}, "k-3", "t1", apiDomain, "")
	ctx.Equal([]int{flood.Status, empty.Status, bare.Status}, []int{400, 400, 400}, "501 paths, no paths and a path without a leading / must each be 400; the statuses")
	ctx.Equal(len(records.Queued(apiBg)), 0, "a rejected purge must not be queued; the queued purges")
	repeated := purgeReq(c, []string{"/a", "/b", "/a"}, "k-4", "t1", apiDomain, "")
	full := purgeReq(c, numbered(500), "k-5", "t1", apiDomain, "")
	ctx.Equal(repeated.Status, 202, "a purge of /a, /b, /a (%s)", repeated.Text())
	stored := records.Get(apiBg, decodeAccepted(repeated).PurgeID)
	ctx.Assert(stored != nil, "the purge of /a, /b, /a has no record")
	ctx.Equal(stored.Paths, []string{"/a", "/b"}, "a purge of /a, /b, /a: duplicates collapse to their first occurrence; the recorded paths")
	ctx.Equal(full.Status, 202, "exactly 500 paths")
}

func CheckBlastRadius(ctx *harness.Ctx) {
	c := api(ctx)
	plain := purgeReq(c, []string{"/img/*"}, "k-1", "t1", apiDomain, "")
	weak := purgeReq(c, []string{"/*"}, "k-2", "t1", apiDomain, "purge:wildcard")
	ctx.Equal(plain.Status, 403, "/img/* without X-Purge-Scope: a normal token fans a wildcard out to every edge")
	ctx.Equal(weak.Status, 403, "/* with only purge:wildcard: the whole domain needs purge:domain")
	ctx.Equal(len(records.Queued(apiBg)), 0, "a wildcard without its scope must not be queued; the queued purges")
	scoped := purgeReq(c, []string{"/img/*"}, "k-3", "t1", apiDomain, "purge:read, purge:wildcard")
	domain := purgeReq(c, []string{"/*"}, "k-4", "t1", apiDomain, "purge:domain")
	ctx.Equal(scoped.Status, 202, "/img/* with purge:wildcard (%s)", scoped.Text())
	ctx.Equal(domain.Status, 202, "/* with purge:domain (%s)", domain.Text())
}

func CheckIdempotentReplay(ctx *harness.Ctx) {
	c := api(ctx)
	first := purgeReq(c, []string{"/pricing"}, "k-1", "t1", apiDomain, "")
	replay := purgeReq(c, []string{"/pricing"}, "k-1", "t1", apiDomain, "")
	ctx.Assert(first.Status == 202 && replay.Status == 202, "the purge and its replay answered %d, %d", first.Status, replay.Status)
	ctx.Equal(decodeAccepted(replay).PurgeID, decodeAccepted(first).PurgeID, "the replay of Idempotency-Key k-1 must answer the original purge, not create one; the purge id")
	ctx.Equal(len(records.Queued(apiBg)), 1, "one purge and its replay must queue one purge for the provider; the queued purges")
	other := purgeReq(c, []string{"/pricing"}, "k-1", "t2", "rival.example.com", "")
	ctx.Assert(other.Status == 202 && decodeAccepted(other).PurgeID != decodeAccepted(first).PurgeID, "tenant t2's key k-1 answered t1's purge: keys belong to a tenant (%s)", other.Text())
	missing := c.Post("/v1/purges", map[string]any{"domain": apiDomain, "paths": []string{"/pricing"}}, "X-Tenant-Id", "t1")
	ctx.Equal(missing.Status, 400, "a purge without Idempotency-Key")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <string>
#include <vector>

#include "purge/records.h"

namespace {

const std::string kApiDomain = "shop.example.com";

harness::HTTP api(harness::Ctx& ctx) {
  records::addDomain("t1", kApiDomain);
  records::addDomain("t2", "rival.example.com");
  static httplib::Server* svr = nullptr;
  delete svr;
  svr = new httplib::Server;
  register_routes(*svr);
  return ctx.HTTP(*svr);
}

harness::Response purgeReq(harness::HTTP& c, const std::vector<std::string>& paths, const std::string& key, const std::string& tenant = "t1",
                           const std::string& domain = kApiDomain, const std::string& scope = "") {
  const std::string body = nlohmann::json{{"domain", domain}, {"paths", paths}, {"reason", "deploy 412"}}.dump();
  if (scope.empty()) return c.Post("/v1/purges", body, "Content-Type", "application/json", "X-Tenant-Id", tenant, "Idempotency-Key", key);
  return c.Post("/v1/purges", body, "Content-Type", "application/json", "X-Tenant-Id", tenant, "Idempotency-Key", key, "X-Purge-Scope", scope);
}

std::vector<std::string> numbered(int n) {
  std::vector<std::string> out;
  for (int i = 0; i < n; i++) out.push_back("/p/" + std::to_string(i));
  return out;
}

std::string field(const harness::Response& r, const std::string& name) {
  const auto body = nlohmann::json::parse(r.Text(), nullptr, false);
  return body.is_object() && body.contains(name) && body[name].is_string() ? body[name].get<std::string>() : "";
}

}  // namespace

void CheckRoute(harness::Ctx& ctx) {
  auto c = api(ctx);
  const auto r = purgeReq(c, {"/pricing", "/img/logo.png"}, "k-1");
  ctx.Equal(r.Status, 202, "POST /v1/purges (%s)", r.Text());
  ctx.Assert(field(r, "status") == "accepted" && field(r, "domain") == kApiDomain, "the 202 must say accepted for %s, got %s", kApiDomain, r.Text());
  const auto stored = records::get(field(r, "purge_id"));
  ctx.Assert(stored.has_value(), "the 202 names purge %q but no record exists", field(r, "purge_id"));
  ctx.Equal(stored->paths, std::vector<std::string>{"/pricing", "/img/logo.png"}, "the record's paths");
  ctx.Equal(records::queued(), std::vector<std::string>{stored->purge_id}, "the purge must be queued for the provider client once; the queue");
}

void CheckDomainOwnership(harness::Ctx& ctx) {
  auto c = api(ctx);
  const auto anonymous = c.Post("/v1/purges", R"({"domain": "shop.example.com", "paths": ["/pricing"]})", "Content-Type", "application/json", "Idempotency-Key", "k-0");
  const auto foreign = purgeReq(c, {"/pricing"}, "k-1", "t1", "rival.example.com");
  ctx.Equal(anonymous.Status, 401, "a purge without X-Tenant-Id");
  ctx.Equal(foreign.Status, 403, "tenant t1 purging rival.example.com (owned by t2): any tenant can purge any customer's domain");
  ctx.Equal(records::queued().size(), 0, "a purge of another tenant's domain must not be queued; the queued purges");
}

void CheckPathCap(harness::Ctx& ctx) {
  auto c = api(ctx);
  const auto flood = purgeReq(c, numbered(501), "k-1");
  const auto empty = purgeReq(c, {}, "k-2");
  const auto bare = purgeReq(c, {"pricing"}, "k-3");
  ctx.Equal(std::vector<int>{flood.Status, empty.Status, bare.Status}, std::vector<int>{400, 400, 400},
            "501 paths, no paths and a path without a leading / must each be 400; the statuses");
  ctx.Equal(records::queued().size(), 0, "a rejected purge must not be queued; the queued purges");
  const auto repeated = purgeReq(c, {"/a", "/b", "/a"}, "k-4");
  const auto full = purgeReq(c, numbered(500), "k-5");
  ctx.Equal(repeated.Status, 202, "a purge of /a, /b, /a (%s)", repeated.Text());
  const auto stored = records::get(field(repeated, "purge_id"));
  ctx.Assert(stored.has_value(), "the purge of /a, /b, /a has no record");
  ctx.Equal(stored->paths, std::vector<std::string>{"/a", "/b"}, "a purge of /a, /b, /a: duplicates collapse to their first occurrence; the recorded paths");
  ctx.Equal(full.Status, 202, "exactly 500 paths");
}

void CheckBlastRadius(harness::Ctx& ctx) {
  auto c = api(ctx);
  const auto plain = purgeReq(c, {"/img/*"}, "k-1");
  const auto weak = purgeReq(c, {"/*"}, "k-2", "t1", kApiDomain, "purge:wildcard");
  ctx.Equal(plain.Status, 403, "/img/* without X-Purge-Scope: a normal token fans a wildcard out to every edge");
  ctx.Equal(weak.Status, 403, "/* with only purge:wildcard: the whole domain needs purge:domain");
  ctx.Equal(records::queued().size(), 0, "a wildcard without its scope must not be queued; the queued purges");
  const auto scoped = purgeReq(c, {"/img/*"}, "k-3", "t1", kApiDomain, "purge:read, purge:wildcard");
  const auto domain = purgeReq(c, {"/*"}, "k-4", "t1", kApiDomain, "purge:domain");
  ctx.Equal(scoped.Status, 202, "/img/* with purge:wildcard (%s)", scoped.Text());
  ctx.Equal(domain.Status, 202, "/* with purge:domain (%s)", domain.Text());
}

void CheckIdempotentReplay(harness::Ctx& ctx) {
  auto c = api(ctx);
  const auto first = purgeReq(c, {"/pricing"}, "k-1");
  const auto replay = purgeReq(c, {"/pricing"}, "k-1");
  ctx.Assert(first.Status == 202 && replay.Status == 202, "the purge and its replay answered %d, %d", first.Status, replay.Status);
  ctx.Equal(field(replay, "purge_id"), field(first, "purge_id"), "the replay of Idempotency-Key k-1 must answer the original purge, not create one; the purge id");
  ctx.Equal(records::queued().size(), 1, "one purge and its replay must queue one purge for the provider; the queued purges");
  const auto other = purgeReq(c, {"/pricing"}, "k-1", "t2", "rival.example.com");
  ctx.Assert(other.Status == 202 && field(other, "purge_id") != field(first, "purge_id"), "tenant t2's key k-1 answered t1's purge: keys belong to a tenant (%s)", other.Text());
  const auto missing = c.Post("/v1/purges", R"({"domain": "shop.example.com", "paths": ["/pricing"]})", "Content-Type", "application/json", "X-Tenant-Id", "t1");
  ctx.Equal(missing.Status, 400, "a purge without Idempotency-Key");
}
`,
  },
  hints: [
    'A tenant purges a competitor’s domain and gets a 202; a deploy script that retries after a timeout leaves two purges in the queue; a normal token’s `/*` is accepted.',
    'The handler goes straight from the tenant header to `records.create`: nothing asks who owns the domain, how many paths arrived, which scope the patterns need, or whether this key already created a purge.',
    'Before `create`: 400 without `Idempotency-Key`, 403 unless `owns_domain`, 400 outside 1..`MAX_PATHS` or without a leading `/`, dedupe, 403 without the scope `required_scope` names, answer `purge_for_key` when set; `remember_key` after.',
  ],
  debrief: `Every guard sits in front of \`records.create\` because creating the record is the point of no return: once a purge is queued, the provider client will send it. The checks run cheapest first, and the replay lookup comes after validation, so an invalid request can never be answered from a key. Keys are scoped by tenant, which keeps one customer's key from naming another's purge. The scope split mirrors CDN providers, whose purge-all is a separate permission from purging a URL. What this step leaves out: a replay with a different body under the same key should be refused rather than answered, and the key record should be written atomically with the purge (\`SET NX\`), so two concurrent first attempts cannot both create one.`,
};
