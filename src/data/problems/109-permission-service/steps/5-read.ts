import type {Step} from '@/lib/types';

export const readStep: Step = {
  id: 'read',
  title: 'GET /v1/users/{id}/permissions: an explanation, not a blob',
  concept: 'http',
  guides: ['honest-reads', 'request-boundaries'],
  file: 'read',
  focus: ['client', 'api', 'redis', 'store'],
  task: `## Task

**Starting point.** The starter serves \`GET /v1/users/{id}/permissions?scope=team:eng\` (scope
defaults to \`org\`) with the \`X-Caller-Id\` header (401 when missing). It answers
\`{"subject", "scope", "permissions": ["team:read", …]}\`: the permissions of every grant whose
scope equals the asked one, merged, cached under \`perm:explain:{id}:{scope}\` for 600 s. It serves
the demo and hides four flaws.

**Failure mode the checks target.** Any caller lists anyone's access; nobody can say which grant a
permission comes from; a team grant does not show at the team's projects; and a revoked permission
stays listed for ten minutes.

- A caller other than \`{id}\` needs \`permissions:read_any\` at \`org\`
  (\`cache.effective_permissions(caller, "org")\`), otherwise **403**.
- Each entry is \`{"permission": "team:read", "granted_by": [{"grant_id", "role", "scope"}]}\`,
  sorted by permission, with every grant that confers it, oldest first.
- A grant counts when \`catalog.covers(grant_scope, scope)\`.
- The body carries \`grant_version\`; a cached body is served only while it equals the current
  \`perm:grant_version\`, read before deriving.`,
  sequence: {
    participants: ['Client', 'Permission Service', 'Redis', 'Grant store'],
    messages: [
      {
        from: 'Client',
        to: 'Permission Service',
        label: 'GET /v1/users/ada/permissions?scope=project:eng/api · X-Caller-Id',
        kind: 'sync',
      },
      {
        from: 'Permission Service',
        to: 'Redis',
        label: 'caller ≠ id → effective_permissions(caller, org) ∋ permissions:read_any?',
        kind: 'sync',
      },
      {from: 'Permission Service', to: 'Redis', label: 'GET perm:grant_version · GET perm:explain:ada:…', kind: 'sync'},
      {
        from: 'Permission Service',
        to: 'Grant store',
        label: 'stale → grants_of(ada) · covers(grant scope, scope)',
        kind: 'sync',
      },
      {
        from: 'Permission Service',
        to: 'Redis',
        label: 'SET perm:explain:… {grant_version, permissions} EX 600',
        kind: 'sync',
      },
      {
        from: 'Permission Service',
        to: 'Client',
        label: '200 [{permission, granted_by: [{grant_id, role, scope}]}] · 403',
        kind: 'reply',
      },
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Registers GET /v1/users/{id}/permissions',
      detail:
        'Register `GET /v1/users/{id}/permissions`; a subject reading its own permissions gets 200, a request without `X-Caller-Id` 401.',
      match: {
        python: {all: [/@app\.get\(\s*["']\/v1\/users\/\{\w+\}\/permissions["']/]},
        typescript: {all: [/app\.get\(\s*['"]\/v1\/users\/:\w+\/permissions['"]/]},
        go: {all: [/HandleFunc\(\s*"GET \/v1\/users\/\{\w+\}\/permissions"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"users"\s*\/\s*Segment\s*\/\s*"permissions"\s*\)/, /\bget\s*\{/]},
        cpp: {all: [/svr\.Get\([^\n]*\/v1\/users\/[^\n]*\/permissions/]},
      },
    },
    {
      id: 'foreign-403',
      title: "Refuses another subject's permissions without permissions:read_any",
      detail:
        "A caller reading someone else must hold `permissions:read_any` at `org`, asked through the cache (`effective_permissions` of the caller); otherwise **403**. The starter answers any caller, so one user can enumerate everyone's access.",
      match: {
        python: {all: [/permissions:read_any/, /cache\.effective_permissions\(\s*caller/, /\b403\b/]},
        typescript: {all: [/permissions:read_any/, /effectivePermissions\(\s*caller/, /\b403\b/]},
        go: {all: [/permissions:read_any/, /cache\.EffectivePermissions\([^\n]*caller/, /StatusForbidden|\b403\b/]},
        scala: {all: [/permissions:read_any/, /Cache\.effectivePermissions\(\s*caller/, /Forbidden|\b403\b/]},
        cpp: {all: [/permissions:read_any/, /cache::effectivePermissions\(\s*caller/, /\b403\b/]},
      },
    },
    {
      id: 'provenance',
      title: 'Every permission names the grants it comes from',
      detail:
        'Each entry carries `granted_by`, the grants (`grant_id`, `role`, `scope`) that confer the permission; the starter merges every permission into one list, so nobody can say which grant to revoke.',
      match: {
        python: {all: [/granted_by/, /["']grant_id["']/]},
        typescript: {all: [/granted_by/, /grant_id/]},
        go: {all: [/granted_by/, /grant_id/]},
        scala: {all: [/granted_by/, /grant_id/]},
        cpp: {all: [/granted_by/, /grant_id/]},
      },
    },
    {
      id: 'covering-scopes',
      title: 'Counts every grant whose scope covers the asked one',
      detail:
        "A grant counts when `covers(grant scope, asked scope)`: `org` everywhere, a team at its projects. The starter compares scope strings, so a team grant is missing at the team's projects and an org grant everywhere below it.",
      match: {
        python: {all: [/catalog\.covers\(/], none: [/\[["']scope["']\]\s*==\s*scope/]},
        typescript: {all: [/\bcovers\(/], none: [/\.scope\s*===\s*scope/]},
        go: {all: [/catalog\.Covers\(/], none: [/\.Scope\s*==\s*scope/]},
        scala: {all: [/Catalog\.covers\(/], none: [/\.scope\s*==\s*scope/]},
        cpp: {all: [/catalog::covers\(/], none: [/\.scope\s*==\s*scope/]},
      },
    },
    {
      id: 'fresh-cache',
      title: 'Serves a cached body only at the current grant version',
      detail:
        'The body is stamped with `grant_version`, read before deriving, and a cached body is served only while it equals `perm:grant_version`; the starter serves its copy for 600 s whatever changed.',
      match: {
        python: {all: [/\.get\(\s*VERSION_KEY/, /grant_version/]},
        typescript: {all: [/\.get\(\s*VERSION_KEY/, /grant_version/]},
        go: {all: [/\.Get\(\s*\w+(\.Context\(\))?,\s*versionKey/, /grant_version/]},
        scala: {all: [/\.get\(\s*VersionKey/, /grant_version/]},
        cpp: {all: [/\.get\(\s*kVersionKey/, /grant_version/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json

import redis
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from permz import cache  # effective_permissions
from permz import catalog  # covers, permissions_of
from permz import grants  # grants_of

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)

EXPLAIN_TTL_S = 600


def explain_key(subject: str, scope: str) -> str:
    return f"perm:explain:{subject}:{scope}"


@app.get("/v1/users/{subject}/permissions")
def read_permissions(subject: str, request: Request):
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    caller = request.headers.get("x-caller-id", "")
    if not caller:
        return JSONResponse({"error": "X-Caller-Id is required"}, status_code=401)
    scope = request.query_params.get("scope", "org")
    raw = r.get(explain_key(subject, scope))
    if raw is not None:
        return json.loads(raw)
    permissions = sorted({p for grant in grants.grants_of(subject) if grant["scope"] == scope for p in catalog.permissions_of(grant["role"])})
    body = {"subject": subject, "scope": scope, "permissions": permissions}
    r.set(explain_key(subject, scope), json.dumps(body), ex=EXPLAIN_TTL_S)
    return body
`,
      solution: `import json

import redis
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from permz import cache  # effective_permissions
from permz import catalog  # covers, permissions_of
from permz import grants  # grants_of

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)

VERSION_KEY = "perm:grant_version"
EXPLAIN_TTL_S = 600


def explain_key(subject: str, scope: str) -> str:
    return f"perm:explain:{subject}:{scope}"


def explain(subject: str, scope: str) -> list[dict]:
    """Every permission subject holds at scope, sorted, each with the grants that confer it."""
    granted_by: dict[str, list[dict]] = {}
    for grant in grants.grants_of(subject):
        if not catalog.covers(grant["scope"], scope):
            continue
        for permission in catalog.permissions_of(grant["role"]):
            granted_by.setdefault(permission, []).append({"grant_id": grant["grant_id"], "role": grant["role"], "scope": grant["scope"]})
    return [{"permission": p, "granted_by": granted_by[p]} for p in sorted(granted_by)]


@app.get("/v1/users/{subject}/permissions")
def read_permissions(subject: str, request: Request):
    caller = request.headers.get("x-caller-id", "")
    if not caller:
        return JSONResponse({"error": "X-Caller-Id is required"}, status_code=401)
    if caller != subject and "permissions:read_any" not in cache.effective_permissions(caller, "org"):
        return JSONResponse({"error": "forbidden"}, status_code=403)
    scope = request.query_params.get("scope", "org")
    version = int(r.get(VERSION_KEY) or 0)  # before deriving: a change meanwhile outdates what is derived
    raw = r.get(explain_key(subject, scope))
    if raw is not None and json.loads(raw).get("grant_version") == version:
        return json.loads(raw)
    body = {"subject": subject, "scope": scope, "grant_version": version, "permissions": explain(subject, scope)}
    r.set(explain_key(subject, scope), json.dumps(body), ex=EXPLAIN_TTL_S)
    return body
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';
import Redis from 'ioredis';

import {effectivePermissions} from 'permz/cache';
import {covers, permissionsOf} from 'permz/catalog';
import {grantsOf} from 'permz/grants';

export const app = Fastify();
const redis = new Redis({host: 'redis', port: 6379});

export const EXPLAIN_TTL_S = 600;

const explainKey = (subject: string, scope: string): string => \`perm:explain:\${subject}:\${scope}\`;

app.get('/v1/users/:subject/permissions', async (request, reply) => {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const {subject} = request.params as {subject: string};
  const caller = request.headers['x-caller-id'];
  if (typeof caller !== 'string' || caller === '') return reply.code(401).send({error: 'X-Caller-Id is required'});
  const scope = (request.query as {scope?: string}).scope ?? 'org';
  const raw = await redis.get(explainKey(subject, scope));
  if (raw !== null) return JSON.parse(raw);
  const permissions = new Set<string>();
  for (const grant of await grantsOf(subject)) {
    if (grant.scope === scope) for (const p of permissionsOf(grant.role)) permissions.add(p);
  }
  const body = {subject, scope, permissions: [...permissions].sort()};
  await redis.set(explainKey(subject, scope), JSON.stringify(body), 'EX', EXPLAIN_TTL_S);
  return body;
});
`,
      solution: `import Fastify from 'fastify';
import Redis from 'ioredis';

import {effectivePermissions} from 'permz/cache';
import {covers, permissionsOf} from 'permz/catalog';
import {grantsOf} from 'permz/grants';

export const app = Fastify();
const redis = new Redis({host: 'redis', port: 6379});

export const VERSION_KEY = 'perm:grant_version';
export const EXPLAIN_TTL_S = 600;

interface Derivation {
  grant_id: string;
  role: string;
  scope: string;
}

const explainKey = (subject: string, scope: string): string => \`perm:explain:\${subject}:\${scope}\`;

/** Every permission subject holds at scope, sorted, each with the grants that confer it. */
async function explain(subject: string, scope: string): Promise<{permission: string; granted_by: Derivation[]}[]> {
  const grantedBy = new Map<string, Derivation[]>();
  for (const grant of await grantsOf(subject)) {
    if (!covers(grant.scope, scope)) continue;
    for (const permission of permissionsOf(grant.role)) {
      grantedBy.set(permission, [...(grantedBy.get(permission) ?? []), {grant_id: grant.grant_id, role: grant.role, scope: grant.scope}]);
    }
  }
  return [...grantedBy.keys()].sort().map(permission => ({permission, granted_by: grantedBy.get(permission) ?? []}));
}

app.get('/v1/users/:subject/permissions', async (request, reply) => {
  const {subject} = request.params as {subject: string};
  const caller = request.headers['x-caller-id'];
  if (typeof caller !== 'string' || caller === '') return reply.code(401).send({error: 'X-Caller-Id is required'});
  if (caller !== subject && !(await effectivePermissions(caller, 'org')).includes('permissions:read_any')) {
    return reply.code(403).send({error: 'forbidden'});
  }
  const scope = (request.query as {scope?: string}).scope ?? 'org';
  const version = Number((await redis.get(VERSION_KEY)) ?? '0'); // before deriving: a change meanwhile outdates what is derived
  const raw = await redis.get(explainKey(subject, scope));
  if (raw !== null && JSON.parse(raw).grant_version === version) return JSON.parse(raw);
  const body = {subject, scope, grant_version: version, permissions: await explain(subject, scope)};
  await redis.set(explainKey(subject, scope), JSON.stringify(body), 'EX', EXPLAIN_TTL_S);
  return body;
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"net/http"
	"sort"
	"time"

	"github.com/redis/go-redis/v9"

	"permz/catalog" // catalog.Covers, PermissionsOf
	"permz/grants"  // grants.GrantsOf; the cache is permz/cache (cache.EffectivePermissions)
)

const explainTTL = 600 * time.Second

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

type permissionsBody struct {
	Subject     string   \`json:"subject"\`
	Scope       string   \`json:"scope"\`
	Permissions []string \`json:"permissions"\`
}

func explainKey(subject, scope string) string { return "perm:explain:" + subject + ":" + scope }

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func readPermissions(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	subject := r.PathValue("subject")
	caller := r.Header.Get("X-Caller-Id")
	if caller == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "X-Caller-Id is required"})
		return
	}
	scope := r.URL.Query().Get("scope")
	if scope == "" {
		scope = "org"
	}
	if raw, err := rdb.Get(r.Context(), explainKey(subject, scope)).Result(); err == nil {
		rw.Header().Set("Content-Type", "application/json")
		rw.Write([]byte(raw))
		return
	}
	held := map[string]bool{}
	for _, g := range grants.GrantsOf(r.Context(), subject) {
		if g.Scope == scope {
			for _, p := range catalog.PermissionsOf(g.Role) {
				held[p] = true
			}
		}
	}
	body := permissionsBody{Subject: subject, Scope: scope, Permissions: []string{}}
	for p := range held {
		body.Permissions = append(body.Permissions, p)
	}
	sort.Strings(body.Permissions)
	raw, _ := json.Marshal(body)
	rdb.Set(r.Context(), explainKey(subject, scope), raw, explainTTL)
	writeJSON(rw, http.StatusOK, body)
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/users/{subject}/permissions", readPermissions)
}
`,
      solution: `package main

import (
	"encoding/json"
	"net/http"
	"slices"
	"sort"
	"time"

	"github.com/redis/go-redis/v9"

	"permz/cache"   // cache.EffectivePermissions
	"permz/catalog" // catalog.Covers, PermissionsOf
	"permz/grants"  // grants.GrantsOf
)

const (
	versionKey = "perm:grant_version"
	explainTTL = 600 * time.Second
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

type derivation struct {
	GrantID string \`json:"grant_id"\`
	Role    string \`json:"role"\`
	Scope   string \`json:"scope"\`
}

type entry struct {
	Permission string       \`json:"permission"\`
	GrantedBy  []derivation \`json:"granted_by"\`
}

type permissionsBody struct {
	Subject      string  \`json:"subject"\`
	Scope        string  \`json:"scope"\`
	GrantVersion int64   \`json:"grant_version"\`
	Permissions  []entry \`json:"permissions"\`
}

func explainKey(subject, scope string) string { return "perm:explain:" + subject + ":" + scope }

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

// explain is every permission subject holds at scope, sorted, each with the grants that confer it.
func explain(r *http.Request, subject, scope string) []entry {
	grantedBy := map[string][]derivation{}
	for _, g := range grants.GrantsOf(r.Context(), subject) {
		if !catalog.Covers(g.Scope, scope) {
			continue
		}
		for _, p := range catalog.PermissionsOf(g.Role) {
			grantedBy[p] = append(grantedBy[p], derivation{GrantID: g.GrantID, Role: g.Role, Scope: g.Scope})
		}
	}
	out := []entry{}
	for p, by := range grantedBy {
		out = append(out, entry{Permission: p, GrantedBy: by})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Permission < out[j].Permission })
	return out
}

func readPermissions(rw http.ResponseWriter, r *http.Request) {
	subject := r.PathValue("subject")
	caller := r.Header.Get("X-Caller-Id")
	if caller == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "X-Caller-Id is required"})
		return
	}
	if caller != subject && !slices.Contains(cache.EffectivePermissions(r.Context(), caller, "org"), "permissions:read_any") {
		writeJSON(rw, http.StatusForbidden, map[string]string{"error": "forbidden"})
		return
	}
	scope := r.URL.Query().Get("scope")
	if scope == "" {
		scope = "org"
	}
	version, _ := rdb.Get(r.Context(), versionKey).Int64() // before deriving: a change meanwhile outdates what is derived
	if raw, err := rdb.Get(r.Context(), explainKey(subject, scope)).Result(); err == nil {
		var cached permissionsBody
		if json.Unmarshal([]byte(raw), &cached) == nil && cached.GrantVersion == version {
			writeJSON(rw, http.StatusOK, cached)
			return
		}
	}
	body := permissionsBody{Subject: subject, Scope: scope, GrantVersion: version, Permissions: explain(r, subject, scope)}
	raw, _ := json.Marshal(body)
	rdb.Set(r.Context(), explainKey(subject, scope), raw, explainTTL)
	writeJSON(rw, http.StatusOK, body)
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/users/{subject}/permissions", readPermissions)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import redis.clients.jedis.JedisPooled
import redis.clients.jedis.params.SetParams
import spray.json._

import permz.{Cache, Catalog, Grants} // Cache.effectivePermissions; Catalog.covers, permissionsOf; Grants.grantsOf

object Read {
  val ExplainTtlS = 600L

  val jedis = new JedisPooled("redis", 6379)

  def explainKey(subject: String, scope: String): String = s"perm:explain:$subject:$scope"

  private def json(status: StatusCode, body: String): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body))

  val route: Route = path("v1" / "users" / Segment / "permissions") { subject =>
    get {
      optionalHeaderValueByName("X-Caller-Id") { callerHeader =>
        parameter("scope".optional) { scopeParam =>
          // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
          callerHeader.filter(_.nonEmpty) match {
            case None => complete(json(StatusCodes.Unauthorized, """{"error":"X-Caller-Id is required"}"""))
            case Some(_) =>
              val scope = scopeParam.getOrElse("org")
              Option(jedis.get(explainKey(subject, scope))) match {
                case Some(raw) => complete(json(StatusCodes.OK, raw))
                case None =>
                  val permissions = Grants.grantsOf(subject).filter(_.scope == scope).flatMap(g => Catalog.permissionsOf(g.role)).distinct.sorted
                  val body = JsObject("subject" -> JsString(subject), "scope" -> JsString(scope), "permissions" -> JsArray(permissions.map(JsString(_)).toVector)).compactPrint
                  jedis.set(explainKey(subject, scope), body, SetParams.setParams().ex(ExplainTtlS))
                  complete(json(StatusCodes.OK, body))
              }
          }
        }
      }
    }
  }
}
`,
      solution: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import redis.clients.jedis.JedisPooled
import redis.clients.jedis.params.SetParams
import spray.json._

import permz.{Cache, Catalog, Grants} // Cache.effectivePermissions; Catalog.covers, permissionsOf; Grants.grantsOf

object Read {
  val VersionKey = "perm:grant_version"
  val ExplainTtlS = 600L

  val jedis = new JedisPooled("redis", 6379)

  def explainKey(subject: String, scope: String): String = s"perm:explain:$subject:$scope"

  private def json(status: StatusCode, body: String): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body))

  /** Every permission subject holds at scope, sorted, each with the grants that confer it. */
  def explain(subject: String, scope: String): JsArray = {
    val derivations = for {
      grant <- Grants.grantsOf(subject) if Catalog.covers(grant.scope, scope)
      permission <- Catalog.permissionsOf(grant.role)
    } yield permission -> JsObject("grant_id" -> JsString(grant.grantId), "role" -> JsString(grant.role), "scope" -> JsString(grant.scope))
    val byPermission = derivations.groupBy(_._1)
    JsArray(byPermission.keys.toVector.sorted.map { permission =>
      JsObject("permission" -> JsString(permission), "granted_by" -> JsArray(byPermission(permission).map(_._2).toVector))
    })
  }

  val route: Route = path("v1" / "users" / Segment / "permissions") { subject =>
    get {
      optionalHeaderValueByName("X-Caller-Id") { callerHeader =>
        parameter("scope".optional) { scopeParam =>
          callerHeader.filter(_.nonEmpty) match {
            case None => complete(json(StatusCodes.Unauthorized, """{"error":"X-Caller-Id is required"}"""))
            case Some(caller) if caller != subject && !Cache.effectivePermissions(caller, "org").contains("permissions:read_any") =>
              complete(json(StatusCodes.Forbidden, """{"error":"forbidden"}"""))
            case Some(_) =>
              val scope = scopeParam.getOrElse("org")
              val version = Option(jedis.get(VersionKey)).getOrElse("0").toLong // before deriving: a change meanwhile outdates what is derived
              val cached = Option(jedis.get(explainKey(subject, scope)))
                .filter(raw => raw.parseJson.asJsObject.fields.get("grant_version").contains(JsNumber(version)))
              cached match {
                case Some(raw) => complete(json(StatusCodes.OK, raw))
                case None =>
                  val body = JsObject(
                    "subject" -> JsString(subject), "scope" -> JsString(scope), "grant_version" -> JsNumber(version),
                    "permissions" -> explain(subject, scope)).compactPrint
                  jedis.set(explainKey(subject, scope), body, SetParams.setParams().ex(ExplainTtlS))
                  complete(json(StatusCodes.OK, body))
              }
          }
        }
      }
    }
  }
}
`,
    },
    cpp: {
      starter: `#include <httplib.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <chrono>
#include <set>
#include <string>

#include "permz/catalog.h"  // catalog::covers, permissionsOf
#include "permz/grants.h"   // grants::grantsOf; the cache is permz/cache.h (cache::effectivePermissions)

using json = nlohmann::json;

constexpr long long kExplainTtlS = 600;

sw::redis::Redis redis("tcp://redis:6379");

std::string explainKey(const std::string& subject, const std::string& scope) { return "perm:explain:" + subject + ":" + scope; }

void reply(httplib::Response& res, int status, const std::string& body) {
  res.status = status;
  res.set_content(body, "application/json");
}

void read_permissions(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const std::string subject = req.matches[1];
  const std::string caller = req.get_header_value("X-Caller-Id");
  if (caller.empty()) return reply(res, 401, R"({"error":"X-Caller-Id is required"})");
  const std::string scope = req.has_param("scope") ? req.get_param_value("scope") : "org";
  if (const auto raw = redis.get(explainKey(subject, scope))) return reply(res, 200, *raw);
  std::set<std::string> held;
  for (const grants::Grant& g : grants::grantsOf(subject)) {
    if (g.scope != scope) continue;
    for (const std::string& p : catalog::permissionsOf(g.role)) held.insert(p);
  }
  const std::string body = json{{"subject", subject}, {"scope", scope}, {"permissions", held}}.dump();
  redis.set(explainKey(subject, scope), body, std::chrono::seconds(kExplainTtlS));
  reply(res, 200, body);
}

void register_routes(httplib::Server& svr) { svr.Get(R"(/v1/users/([^/]+)/permissions)", read_permissions); }
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <algorithm>
#include <chrono>
#include <map>
#include <string>
#include <vector>

#include "permz/cache.h"    // cache::effectivePermissions
#include "permz/catalog.h"  // catalog::covers, permissionsOf
#include "permz/grants.h"   // grants::grantsOf

using json = nlohmann::json;

const std::string kVersionKey = "perm:grant_version";
constexpr long long kExplainTtlS = 600;

sw::redis::Redis redis("tcp://redis:6379");

std::string explainKey(const std::string& subject, const std::string& scope) { return "perm:explain:" + subject + ":" + scope; }

void reply(httplib::Response& res, int status, const std::string& body) {
  res.status = status;
  res.set_content(body, "application/json");
}

// Every permission subject holds at scope, sorted, each with the grants that confer it.
json explain(const std::string& subject, const std::string& scope) {
  std::map<std::string, json> granted_by;
  for (const grants::Grant& g : grants::grantsOf(subject)) {
    if (!catalog::covers(g.scope, scope)) continue;
    for (const std::string& p : catalog::permissionsOf(g.role)) {
      granted_by[p].push_back(json{{"grant_id", g.grant_id}, {"role", g.role}, {"scope", g.scope}});
    }
  }
  json out = json::array();
  for (const auto& [permission, by] : granted_by) out.push_back(json{{"permission", permission}, {"granted_by", by}});
  return out;
}

void read_permissions(const httplib::Request& req, httplib::Response& res) {
  const std::string subject = req.matches[1];
  const std::string caller = req.get_header_value("X-Caller-Id");
  if (caller.empty()) return reply(res, 401, R"({"error":"X-Caller-Id is required"})");
  if (caller != subject) {
    const std::vector<std::string> held = cache::effectivePermissions(caller, "org");
    if (std::find(held.begin(), held.end(), "permissions:read_any") == held.end()) return reply(res, 403, R"({"error":"forbidden"})");
  }
  const std::string scope = req.has_param("scope") ? req.get_param_value("scope") : "org";
  const long long version = std::stoll(redis.get(kVersionKey).value_or("0"));  // before deriving: a change meanwhile outdates what is derived
  if (const auto raw = redis.get(explainKey(subject, scope))) {
    const json cached = json::parse(*raw);
    if (cached.value("grant_version", -1LL) == version) return reply(res, 200, *raw);
  }
  const std::string body = json{{"subject", subject}, {"scope", scope}, {"grant_version", version}, {"permissions", explain(subject, scope)}}.dump();
  redis.set(explainKey(subject, scope), body, std::chrono::seconds(kExplainTtlS));
  reply(res, 200, body);
}

void register_routes(httplib::Server& svr) { svr.Get(R"(/v1/users/([^/]+)/permissions)", read_permissions); }
`,
    },
  },
  harness: {
    python: `from permz import cache


def _api(ctx):
    cache.grant_role("olu", "org_admin", "org", "root")  # g-1
    cache.grant_role("ada", "viewer", "team:eng", "olu")  # g-2
    cache.grant_role("ada", "developer", "team:eng", "olu")  # g-3
    cache.grant_role("bob", "viewer", "team:ops", "olu")  # g-4
    return ctx.client(ctx.load("read").app)


async def _read(c, subject, caller, scope):
    return await c.get(f"/v1/users/{subject}/permissions", params={"scope": scope}, headers={"X-Caller-Id": caller})


def _names(body):
    return [e.get("permission") if isinstance(e, dict) else e for e in body.get("permissions", [])]


async def check_route(ctx):
    async with _api(ctx) as c:
        r = await _read(c, "ada", "ada", "team:eng")
        assert r.status_code == 200, f"ada reading her own permissions answered {r.status_code}: {r.text}"
        assert r.json().get("subject") == "ada", f"the body must name the subject, got {r.text}"
        anonymous = await c.get("/v1/users/ada/permissions")
    assert anonymous.status_code == 401, f"a read without X-Caller-Id answered {anonymous.status_code}, expected 401"


async def check_foreign_403(ctx):
    async with _api(ctx) as c:
        r = await _read(c, "ada", "bob", "team:eng")
        assert r.status_code == 403, f"bob (viewer at team:ops) reading ada's permissions answered {r.status_code}, expected 403: only a caller with permissions:read_any may read another subject"
        r = await _read(c, "ada", "olu", "team:eng")
        assert r.status_code == 200, f"olu (org_admin, which confers permissions:read_any) reading ada answered {r.status_code}: {r.text}"
        r = await _read(c, "bob", "bob", "team:ops")
    assert r.status_code == 200, f"bob reading his own permissions answered {r.status_code}: {r.text}"


async def check_provenance(ctx):
    async with _api(ctx) as c:
        r = await _read(c, "ada", "ada", "team:eng")
    assert r.status_code == 200, f"ada reading her own permissions answered {r.status_code}: {r.text}"
    want = [
        {"permission": "code:write", "granted_by": [{"grant_id": "g-3", "role": "developer", "scope": "team:eng"}]},
        {"permission": "team:read", "granted_by": [{"grant_id": "g-2", "role": "viewer", "scope": "team:eng"}, {"grant_id": "g-3", "role": "developer", "scope": "team:eng"}]},
    ]
    got = r.json().get("permissions")
    assert got == want, f"ada's permissions at team:eng are {got}, expected each permission with the grants that confer it (granted_by: grant_id, role, scope), oldest first: {want}"


async def check_covering_scopes(ctx):
    async with _api(ctx) as c:
        cache.grant_role("ada", "viewer", "project:eng/web", "olu")  # g-5, narrower than team:eng
        r = await _read(c, "ada", "ada", "project:eng/api")
        names = _names(r.json())
        assert names == ["code:write", "team:read"], f"ada's permissions at project:eng/api are {names}: her grants at team:eng cover the team's projects, expected code:write and team:read"
        r = await _read(c, "olu", "olu", "team:ops")
        assert "team:write" in _names(r.json()), f"olu's permissions at team:ops are {_names(r.json())}: an org grant covers every team"
        r = await _read(c, "ada", "ada", "team:ops")
        assert _names(r.json()) == [], f"ada's permissions at team:ops are {_names(r.json())}: team:eng does not cover team:ops"
        r = await _read(c, "ada", "ada", "team:eng")
    listed = str(r.json())
    assert "g-5" not in listed, f"ada's read at team:eng lists g-5, a grant at project:eng/web: a project grant does not reach its team ({listed})"


async def check_fresh_cache(ctx):
    async with _api(ctx) as c:
        r = await _read(c, "ada", "ada", "team:eng")
        assert "code:write" in _names(r.json()), f"ada (developer at team:eng) must hold code:write there, got {r.text}"
        cache.revoke_grant("g-3")  # writes the grant store, then bumps perm:grant_version
        r = await _read(c, "ada", "ada", "team:eng")
    names = _names(r.json())
    assert "code:write" not in names, f"after ada's developer grant was revoked her permissions still list {names}: a cached body counts only at the grant version it was derived at"
    assert names == ["team:read"], f"after the revocation ada's permissions at team:eng are {names}, expected team:read"
`,
    typescript: `async function api(ctx) {
  const cache = ctx.load('/support/permz/cache.ts');
  await cache.grantRole('olu', 'org_admin', 'org', 'root'); // g-1
  await cache.grantRole('ada', 'viewer', 'team:eng', 'olu'); // g-2
  await cache.grantRole('ada', 'developer', 'team:eng', 'olu'); // g-3
  await cache.grantRole('bob', 'viewer', 'team:ops', 'olu'); // g-4
  return {c: ctx.client(ctx.load('read').app), cache};
}

const read = (c, subject: string, caller: string, scope: string) =>
  c.get(\`/v1/users/\${subject}/permissions?scope=\${encodeURIComponent(scope)}\`, {headers: {'X-Caller-Id': caller}});

const names = (r): string[] => (r.json().permissions ?? []).map(e => (typeof e === 'string' ? e : e.permission));

export async function check_route(ctx) {
  const {c} = await api(ctx);
  const r = await read(c, 'ada', 'ada', 'team:eng');
  assert.equal(r.status, 200, \`ada reading her own permissions answered \${r.status}: \${r.text}\`);
  assert.equal(r.json().subject, 'ada', \`the body must name the subject, got \${r.text}\`);
  const anonymous = await c.get('/v1/users/ada/permissions');
  assert.equal(anonymous.status, 401, \`a read without X-Caller-Id answered \${anonymous.status}, expected 401\`);
}

export async function check_foreign_403(ctx) {
  const {c} = await api(ctx);
  let r = await read(c, 'ada', 'bob', 'team:eng');
  assert.equal(r.status, 403, \`bob (viewer at team:ops) reading ada's permissions answered \${r.status}, expected 403: only a caller with permissions:read_any may read another subject\`);
  r = await read(c, 'ada', 'olu', 'team:eng');
  assert.equal(r.status, 200, \`olu (org_admin, which confers permissions:read_any) reading ada answered \${r.status}: \${r.text}\`);
  r = await read(c, 'bob', 'bob', 'team:ops');
  assert.equal(r.status, 200, \`bob reading his own permissions answered \${r.status}: \${r.text}\`);
}

export async function check_provenance(ctx) {
  const {c} = await api(ctx);
  const r = await read(c, 'ada', 'ada', 'team:eng');
  assert.equal(r.status, 200, \`ada reading her own permissions answered \${r.status}: \${r.text}\`);
  const want = [
    {permission: 'code:write', granted_by: [{grant_id: 'g-3', role: 'developer', scope: 'team:eng'}]},
    {permission: 'team:read', granted_by: [{grant_id: 'g-2', role: 'viewer', scope: 'team:eng'}, {grant_id: 'g-3', role: 'developer', scope: 'team:eng'}]},
  ];
  const got = r.json().permissions;
  assert.deepStrictEqual(got, want, \`ada's permissions at team:eng are \${JSON.stringify(got)}, expected each permission with the grants that confer it (granted_by: grant_id, role, scope), oldest first\`);
}

export async function check_covering_scopes(ctx) {
  const {c, cache} = await api(ctx);
  await cache.grantRole('ada', 'viewer', 'project:eng/web', 'olu'); // g-5, narrower than team:eng
  let r = await read(c, 'ada', 'ada', 'project:eng/api');
  assert.deepStrictEqual(names(r), ['code:write', 'team:read'], \`ada's permissions at project:eng/api are \${JSON.stringify(names(r))}: her grants at team:eng cover the team's projects, expected code:write and team:read\`);
  r = await read(c, 'olu', 'olu', 'team:ops');
  assert(names(r).includes('team:write'), \`olu's permissions at team:ops are \${JSON.stringify(names(r))}: an org grant covers every team\`);
  r = await read(c, 'ada', 'ada', 'team:ops');
  assert.deepStrictEqual(names(r), [], \`ada's permissions at team:ops are \${JSON.stringify(names(r))}: team:eng does not cover team:ops\`);
  r = await read(c, 'ada', 'ada', 'team:eng');
  assert(!r.text.includes('g-5'), \`ada's read at team:eng lists g-5, a grant at project:eng/web: a project grant does not reach its team (\${r.text})\`);
}

export async function check_fresh_cache(ctx) {
  const {c, cache} = await api(ctx);
  let r = await read(c, 'ada', 'ada', 'team:eng');
  assert(names(r).includes('code:write'), \`ada (developer at team:eng) must hold code:write there, got \${r.text}\`);
  await cache.revokeGrant('g-3'); // writes the grant store, then bumps perm:grant_version
  r = await read(c, 'ada', 'ada', 'team:eng');
  assert(!names(r).includes('code:write'), \`after ada's developer grant was revoked her permissions still list \${JSON.stringify(names(r))}: a cached body counts only at the grant version it was derived at\`);
  assert.deepStrictEqual(names(r), ['team:read'], \`after the revocation ada's permissions at team:eng are \${JSON.stringify(names(r))}, expected team:read\`);
}
`,
    go: `package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"strings"

	"permz/cache"

	"leetbuild/harness"
)

func readAPI(ctx *harness.Ctx) *harness.HTTP {
	bg := context.Background()
	cache.GrantRole(bg, "olu", "org_admin", "org", "root")    // g-1
	cache.GrantRole(bg, "ada", "viewer", "team:eng", "olu")   // g-2
	cache.GrantRole(bg, "ada", "developer", "team:eng", "olu") // g-3
	cache.GrantRole(bg, "bob", "viewer", "team:ops", "olu")   // g-4
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

func readAs(c *harness.HTTP, subject, caller, scope string) *harness.Response {
	return c.Get("/v1/users/"+subject+"/permissions?scope="+url.QueryEscape(scope), "X-Caller-Id", caller)
}

type readBody struct {
	Subject     string            \`json:"subject"\`
	Permissions []json.RawMessage \`json:"permissions"\`
}

// permissionNames lists the permissions of a body whose entries are names or {permission, …} objects.
func permissionNames(r *harness.Response) []string {
	var body readBody
	r.Decode(&body)
	out := []string{}
	for _, raw := range body.Permissions {
		var name string
		if json.Unmarshal(raw, &name) == nil {
			out = append(out, name)
			continue
		}
		var e struct {
			Permission string \`json:"permission"\`
		}
		json.Unmarshal(raw, &e)
		out = append(out, e.Permission)
	}
	return out
}

func has(names []string, p string) bool {
	for _, n := range names {
		if n == p {
			return true
		}
	}
	return false
}

func CheckRoute(ctx *harness.Ctx) {
	c := readAPI(ctx)
	r := readAs(c, "ada", "ada", "team:eng")
	ctx.Equal(r.Status, 200, "ada reading her own permissions (%s)", r.Text())
	var body readBody
	r.Decode(&body)
	ctx.Equal(body.Subject, "ada", "the body must name the subject (%s)", r.Text())
	ctx.Equal(c.Get("/v1/users/ada/permissions").Status, 401, "a read without X-Caller-Id")
}

func CheckForeign403(ctx *harness.Ctx) {
	c := readAPI(ctx)
	ctx.Equal(readAs(c, "ada", "bob", "team:eng").Status, 403, "bob (viewer at team:ops) reading ada's permissions must be refused: only a caller with permissions:read_any may read another subject; the status")
	r := readAs(c, "ada", "olu", "team:eng")
	ctx.Equal(r.Status, 200, "olu (org_admin, which confers permissions:read_any) reading ada (%s)", r.Text())
	r = readAs(c, "bob", "bob", "team:ops")
	ctx.Equal(r.Status, 200, "bob reading his own permissions (%s)", r.Text())
}

func CheckProvenance(ctx *harness.Ctx) {
	c := readAPI(ctx)
	r := readAs(c, "ada", "ada", "team:eng")
	ctx.Equal(r.Status, 200, "ada reading her own permissions (%s)", r.Text())
	var body struct {
		Permissions any \`json:"permissions"\`
	}
	r.Decode(&body)
	want := []any{
		map[string]any{"permission": "code:write", "granted_by": []any{map[string]any{"grant_id": "g-3", "role": "developer", "scope": "team:eng"}}},
		map[string]any{"permission": "team:read", "granted_by": []any{
			map[string]any{"grant_id": "g-2", "role": "viewer", "scope": "team:eng"},
			map[string]any{"grant_id": "g-3", "role": "developer", "scope": "team:eng"},
		}},
	}
	ctx.Equal(body.Permissions, want, "ada's permissions at team:eng must each name the grants that confer them (granted_by: grant_id, role, scope), oldest first")
}

func CheckCoveringScopes(ctx *harness.Ctx) {
	c := readAPI(ctx)
	cache.GrantRole(context.Background(), "ada", "viewer", "project:eng/web", "olu") // g-5, narrower than team:eng
	ctx.Equal(permissionNames(readAs(c, "ada", "ada", "project:eng/api")), []string{"code:write", "team:read"}, "ada's grants at team:eng cover the team's projects; her permissions at project:eng/api")
	names := permissionNames(readAs(c, "olu", "olu", "team:ops"))
	ctx.Assert(has(names, "team:write"), "olu's permissions at team:ops are %v: an org grant covers every team", names)
	ctx.Equal(permissionNames(readAs(c, "ada", "ada", "team:ops")), []string{}, "team:eng does not cover team:ops; ada's permissions there")
	r := readAs(c, "ada", "ada", "team:eng")
	ctx.Assert(!strings.Contains(r.Text(), "g-5"), "ada's read at team:eng lists g-5, a grant at project:eng/web: a project grant does not reach its team (%s)", r.Text())
}

func CheckFreshCache(ctx *harness.Ctx) {
	c := readAPI(ctx)
	r := readAs(c, "ada", "ada", "team:eng")
	ctx.Assert(has(permissionNames(r), "code:write"), "ada (developer at team:eng) must hold code:write there, got %s", r.Text())
	cache.RevokeGrant(context.Background(), "g-3") // writes the grant store, then bumps perm:grant_version
	names := permissionNames(readAs(c, "ada", "ada", "team:eng"))
	ctx.Assert(!has(names, "code:write"), "after ada's developer grant was revoked her permissions still list %v: a cached body counts only at the grant version it was derived at", names)
	ctx.Equal(names, []string{"team:read"}, "after the revocation, ada's permissions at team:eng")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <algorithm>
#include <string>
#include <vector>

#include "permz/cache.h"

namespace {

harness::HTTP readApi(harness::Ctx& ctx) {
  cache::grantRole("olu", "org_admin", "org", "root");     // g-1
  cache::grantRole("ada", "viewer", "team:eng", "olu");    // g-2
  cache::grantRole("ada", "developer", "team:eng", "olu");  // g-3
  cache::grantRole("bob", "viewer", "team:ops", "olu");    // g-4
  static httplib::Server* svr = nullptr;
  delete svr;
  svr = new httplib::Server;
  register_routes(*svr);
  return ctx.HTTP(*svr);
}

harness::Response readAs(harness::HTTP& c, const std::string& subject, const std::string& caller, const std::string& scope) {
  return c.Get("/v1/users/" + subject + "/permissions?scope=" + scope, "X-Caller-Id", caller);
}

nlohmann::json bodyOf(const harness::Response& r) { return nlohmann::json::parse(r.Text(), nullptr, false); }

// The permissions of a body whose entries are names or {permission, …} objects.
std::vector<std::string> permissionNames(const harness::Response& r) {
  const auto body = bodyOf(r);
  std::vector<std::string> out;
  if (!body.is_object() || !body.contains("permissions") || !body["permissions"].is_array()) return out;
  for (const auto& e : body["permissions"]) out.push_back(e.is_string() ? e.get<std::string>() : e.value("permission", ""));
  return out;
}

bool has(const std::vector<std::string>& names, const std::string& p) { return std::find(names.begin(), names.end(), p) != names.end(); }

}  // namespace

void CheckRoute(harness::Ctx& ctx) {
  auto c = readApi(ctx);
  const auto r = readAs(c, "ada", "ada", "team:eng");
  ctx.Equal(r.Status, 200, "ada reading her own permissions (%s)", r.Text());
  const auto body = bodyOf(r);
  ctx.Assert(body.is_object() && body.value("subject", "") == "ada", "the body must name the subject, got %s", r.Text());
  ctx.Equal(c.Get("/v1/users/ada/permissions").Status, 401, "a read without X-Caller-Id");
}

void CheckForeign403(harness::Ctx& ctx) {
  auto c = readApi(ctx);
  ctx.Equal(readAs(c, "ada", "bob", "team:eng").Status, 403, "bob (viewer at team:ops) reading ada's permissions must be refused: only a caller with permissions:read_any may read another subject; the status");
  auto r = readAs(c, "ada", "olu", "team:eng");
  ctx.Equal(r.Status, 200, "olu (org_admin, which confers permissions:read_any) reading ada (%s)", r.Text());
  r = readAs(c, "bob", "bob", "team:ops");
  ctx.Equal(r.Status, 200, "bob reading his own permissions (%s)", r.Text());
}

void CheckProvenance(harness::Ctx& ctx) {
  auto c = readApi(ctx);
  const auto r = readAs(c, "ada", "ada", "team:eng");
  ctx.Equal(r.Status, 200, "ada reading her own permissions (%s)", r.Text());
  const nlohmann::json want = nlohmann::json::parse(R"([
    {"permission": "code:write", "granted_by": [{"grant_id": "g-3", "role": "developer", "scope": "team:eng"}]},
    {"permission": "team:read", "granted_by": [{"grant_id": "g-2", "role": "viewer", "scope": "team:eng"}, {"grant_id": "g-3", "role": "developer", "scope": "team:eng"}]}
  ])");
  const auto body = bodyOf(r);
  const nlohmann::json got = body.is_object() && body.contains("permissions") ? body["permissions"] : nlohmann::json();
  ctx.Assert(got == want, "ada's permissions at team:eng are %s, expected each permission with the grants that confer it (granted_by: grant_id, role, scope), oldest first: %s", got.dump(), want.dump());
}

void CheckCoveringScopes(harness::Ctx& ctx) {
  auto c = readApi(ctx);
  cache::grantRole("ada", "viewer", "project:eng/web", "olu");  // g-5, narrower than team:eng
  ctx.Equal(permissionNames(readAs(c, "ada", "ada", "project:eng/api")), {"code:write", "team:read"}, "ada's grants at team:eng cover the team's projects; her permissions at project:eng/api");
  const auto names = permissionNames(readAs(c, "olu", "olu", "team:ops"));
  ctx.Assert(has(names, "team:write"), "olu's permissions at team:ops are %v: an org grant covers every team", names);
  ctx.Equal(permissionNames(readAs(c, "ada", "ada", "team:ops")), std::vector<std::string>{}, "team:eng does not cover team:ops; ada's permissions there");
  const auto r = readAs(c, "ada", "ada", "team:eng");
  ctx.Assert(r.Text().find("g-5") == std::string::npos, "ada's read at team:eng lists g-5, a grant at project:eng/web: a project grant does not reach its team (%s)", r.Text());
}

void CheckFreshCache(harness::Ctx& ctx) {
  auto c = readApi(ctx);
  const auto r = readAs(c, "ada", "ada", "team:eng");
  ctx.Assert(has(permissionNames(r), "code:write"), "ada (developer at team:eng) must hold code:write there, got %s", r.Text());
  cache::revokeGrant("g-3");  // writes the grant store, then bumps perm:grant_version
  const auto names = permissionNames(readAs(c, "ada", "ada", "team:eng"));
  ctx.Assert(!has(names, "code:write"), "after ada's developer grant was revoked her permissions still list %v: a cached body counts only at the grant version it was derived at", names);
  ctx.Equal(names, {"team:read"}, "after the revocation, ada's permissions at team:eng");
}
`,
  },
  hints: [
    "Ask for someone else's permissions with your own `X-Caller-Id`: they come back. Ask a team developer's permissions at one of the team's projects: the list is empty. Revoke a grant: the list keeps it for ten minutes.",
    'The handler never compares the caller with the subject, keeps only grants whose scope string equals the asked one, merges every permission into one set (losing the grant behind each), and serves its copy until the TTL ends.',
    'Return 403 unless `caller == id` or `cache.effective_permissions(caller, "org")` has `permissions:read_any`; keep grants where `catalog.covers(grant_scope, scope)`; build `{permission, granted_by: [{grant_id, role, scope}]}`; stamp `grant_version` read first and serve a copy only when equal.',
  ],
  debrief: `The read is shaped like an authorization decision because it is one. Provenance comes out of the same fold over grants that decides the answer, so when a permission is wrong someone can name the grant to revoke, and \`covers\` is the same containment rule the write path enforces, so the list and the enforcement point cannot disagree about scopes. The ownership check runs before any data is loaded, since this is the endpoint an attacker would enumerate. Stamping the copy with \`grant_version\` makes a revocation visible on the next read instead of after the TTL. Production systems audit every foreign read with the caller's identity and page the list for subjects with thousands of grants.`,
};
