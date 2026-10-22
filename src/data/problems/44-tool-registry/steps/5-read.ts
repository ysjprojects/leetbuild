import type {Step} from '@/lib/types';

export const readStep: Step = {
  id: 'read',
  title: "GET /v1/tools/{name}: resolution against the caller's allowlist",
  concept: 'http',
  file: 'read',
  focus: ['client', 'registry', 'redis'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it authenticates the tenant,
registers the route and returns a tool record from Redis. It runs, and it serves the demo — one
catalog, one trusted caller — while hiding three production flaws. Review it like the platform
owner, fix it, and prove the fix with the checks below.

Implement \`GET /v1/tools/{name}\`, the resolve endpoint an agent calls before it uses a tool:

- The tenant comes from the authenticated \`X-Tenant-Id\` header; a missing tenant is **401**. The
  caller's allowlist comes from that authenticated context too — never from the path, the body or
  the query string.
- The version served is the one the caller is entitled to: the caller's \`X-Catalog-Version\` pin when
  it pinned a catalog, otherwise the active catalog pointer (\`catalog:active\`). The entry is read
  with one \`HGET\` against the version’s hash, \`catalog:version:{version}\` — resolution is a lookup,
  not a scan.
- A tool that is not on the caller's allowlist is **404**, the same answer as a tool that does not
  exist. A 403 would confirm that the tool exists and turn the endpoint into an enumeration oracle.
- The response is the public contract and nothing else: \`name\`, \`version\` (the version served),
  \`side_effect\` (\`read\`, \`write\` or \`irreversible\`) and \`definition\` (the JSON Schema). No
  owner-team endpoint or base URL, no credential reference, no internal schema blob.

**Failure mode the checks target.** The draft serves whatever the active catalog holds, so an agent
that pinned a catalog to keep a reviewed definition is silently flipped onto the newest one
mid-plan. It never consults the allowlist, so any authenticated caller can resolve any tool —
including the irreversible ones it was never granted. And it returns the stored record field by
field, shipping the owner team's internal endpoint and credential reference to every caller. All
three stay invisible in the demo because the demo has one catalog, one caller, and no secret worth
leaking.`,
  sequence: {
    participants: ['Client', 'Tool Registry', 'Redis'],
    messages: [
      {
        from: 'Client',
        to: 'Tool Registry',
        label: 'GET /v1/tools/payments.refund · X-Tenant-Id · X-Catalog-Version',
        kind: 'sync',
      },
      {
        from: 'Tool Registry',
        to: 'Tool Registry',
        label: 'authenticate · allowlist from the caller’s context · outside it → 404, never 403',
        kind: 'sync',
      },
      {
        from: 'Tool Registry',
        to: 'Redis',
        label: 'HGET catalog:{pin or active} payments.refund · one round trip',
        kind: 'sync',
      },
      {from: 'Redis', to: 'Tool Registry', label: 'record / nil → 404', kind: 'reply'},
      {
        from: 'Tool Registry',
        to: 'Client',
        label: '{name, version, side_effect, definition} · no owner endpoint, no credentials',
        kind: 'reply',
      },
    ],
  },
  hints: [
    'Resolve the version before you touch the snapshot: read `X-Catalog-Version` off the request and fall back to the `catalog:active` pointer only when it is absent, then answer the entry with one `HGET catalog:{version} {name}`. The draft reads the pointer unconditionally, so the pin never gets a chance to matter.',
    'Authorize with the caller’s context, not the request: the allowlist arrives with the authenticated caller, so check membership after authentication and answer the same **404** you answer for a missing tool. The draft never looks at it, so every caller can resolve every tool.',
    'Build the reply field by field instead of echoing the stored record: the record carries `owner_endpoint`, `credentials_ref` and `internal_schema` for the platform’s own use, and the public contract calls the served schema `definition`, not `schema`. The draft ships the internal names verbatim.',
  ],
  checks: [
    {
      id: 'route',
      title: 'Handles GET /v1/tools/{name}',
      detail:
        'The resolve route is registered on `GET /v1/tools/{name}` with the tool name taken from the path. The checks below build on this route.',
      match: {
        python: {all: [/@app\.get\(\s*["']\/v1\/tools\/\{name\}["']/, /name: str/]},
        typescript: {all: [/app\.get\(\s*['"]\/v1\/tools\/:name['"]/, /\{name\}\s*=\s*request\.params/]},
        go: {all: [/HandleFunc\(\s*"GET \/v1\/tools\/\{name\}"/, /PathValue\("name"\)/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"tools"\s*\/\s*Segment\s*\)/, /\bget\s*\{/]},
        cpp: {all: [/svr\.Get\(\s*"\/v1\/tools\/:name"/, /path_params\.at\("name"\)/]},
      },
    },
    {
      id: 'pin',
      title: 'Serves the caller’s pinned catalog, not whatever is active',
      detail:
        '`X-Catalog-Version` selects the snapshot (`catalog:version:{version}`); `catalog:active` is the fallback only when the caller pinned nothing, so a pinned agent keeps the definition it reviewed for the whole run. The draft ignores the pin and serves the latest catalog.',
      match: {
        python: {
          all: [/X-Catalog-Version/, /catalog_version\(/, /catalog:version:\{version\}/],
          none: [/latest_catalog/],
        },
        typescript: {
          all: [/catalog-version/, /catalogVersion\(/, /catalog:version:\$\{version\}/],
          none: [/latestCatalog/],
        },
        go: {
          all: [/X-Catalog-Version/, /catalogVersion\(/, /"catalog:version:"\s*\+\s*version/],
          none: [/latestCatalog/],
        },
        scala: {
          all: [/X-Catalog-Version/, /catalogVersion\(/, /s"catalog:version:\$version"/],
          none: [/latestCatalog/],
        },
        cpp: {
          all: [/X-Catalog-Version/, /catalog_version\(/, /"catalog:version:"\s*\+\s*version/],
          none: [/latest_catalog/],
        },
      },
    },
    {
      id: 'allowlist',
      title: 'Answers 404 for a tool outside the caller’s allowlist',
      detail:
        'The allowlist comes from the authenticated caller’s context — never the path, body or query string — and a tool it does not name is **404**, the same answer as a missing tool, so the endpoint cannot be used to enumerate the catalog. The draft serves any authenticated caller any tool.',
      match: {
        python: {all: [/def authenticate\(/, /allowed_tools/, /404/]},
        typescript: {all: [/function authenticate\(/, /allowedTools/, /404/]},
        go: {all: [/func authenticate\(/, /AllowedTools/, /StatusNotFound/]},
        scala: {all: [/def authenticate\(/, /allowedTools/, /NotFound/]},
        cpp: {all: [/authenticate\(/, /allowed_tools/, /404/]},
      },
    },
    {
      id: 'no-internal',
      title: 'No owner endpoint, credential or internal schema in the reply',
      detail:
        'The reply carries the public contract only. The draft returns the stored record field by field, shipping the owner team’s internal endpoint, its credential reference and the internal schema blob to every caller.',
      match: {
        python: {none: [/owner_endpoint/, /credentials_ref/, /internal_schema/]},
        typescript: {none: [/owner_endpoint/, /credentials_ref/, /internal_schema/]},
        go: {none: [/owner_endpoint/, /credentials_ref/, /internal_schema/]},
        scala: {none: [/owner_endpoint/, /credentials_ref/, /internal_schema/]},
        cpp: {none: [/owner_endpoint/, /credentials_ref/, /internal_schema/]},
      },
    },
    {
      id: 'definition',
      title: 'Carries the definition, the side-effect class and the version served',
      detail:
        'The reply maps the stored record onto the public shape: `name`, `version` (the version served from the resolved snapshot), `side_effect` and `definition` (the JSON Schema) — not the stored field’s internal name. The draft returns the schema under `schema`.',
      match: {
        python: {all: [/["']definition["']/, /["']side_effect["']/, /["']version["']/]},
        typescript: {all: [/\bdefinition\b/, /\bside_effect\b/, /\bversion\b/]},
        go: {all: [/json:"definition"/, /json:"side_effect"/, /json:"version"/]},
        scala: {all: [/"definition"/, /"side_effect"/, /"version"/]},
        cpp: {all: [/"definition"/, /"side_effect"/, /"version"/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json

import redis
from fastapi import FastAPI, Header, HTTPException

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)


def latest_catalog() -> str:
    return r.get("catalog:active") or ""


@app.get("/v1/tools/{name}")
def resolve(name: str, tenant: str | None = Header(default=None, alias="X-Tenant-Id")) -> dict:
    # TODO: review this draft before it ships. It resolves against whatever the active catalog
    # holds and ignores the caller's pin, never consults the caller's allowlist, and returns the
    # stored record field by field — owner endpoint, credential reference and internal schema
    # included.
    if tenant is None or tenant == "":
        raise HTTPException(status_code=401, detail="missing X-Tenant-Id")
    latest = latest_catalog()
    raw = r.hget(f"catalog:version:{latest}", name)
    if raw is None:
        raise HTTPException(status_code=404, detail="tool not found")
    record = json.loads(raw)
    return {
        "name": record["name"],
        "version": record["version"],
        "schema": record["schema"],
        "side_effect": record["side_effect"],
        "owner_endpoint": record["owner_endpoint"],
        "credentials_ref": record["credentials_ref"],
        "internal_schema": record["internal_schema"],
    }
`,
      solution: `import json

import redis
from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)

ACTIVE_CATALOG_KEY = "catalog:active"


class CallerContext(BaseModel):
    tenant: str
    allowed_tools: set[str]


def authenticate(tenant: str | None) -> CallerContext:
    if tenant is None or tenant == "":
        raise HTTPException(status_code=401, detail="missing X-Tenant-Id")
    raw = r.get(f"caller:{tenant}")
    if raw is None:
        raise HTTPException(status_code=401, detail="unknown caller")
    profile = json.loads(raw)
    return CallerContext(tenant=tenant, allowed_tools=set(profile["allowed_tools"]))


def catalog_version(pin: str | None) -> str:
    if pin is not None and pin != "":
        return pin
    active = r.get(ACTIVE_CATALOG_KEY)
    if active is None:
        raise HTTPException(status_code=503, detail="no active catalog")
    return active


@app.get("/v1/tools/{name}")
def resolve(
    name: str,
    tenant: str | None = Header(default=None, alias="X-Tenant-Id"),
    pin: str | None = Header(default=None, alias="X-Catalog-Version"),
) -> dict:
    caller = authenticate(tenant)
    if name not in caller.allowed_tools:
        raise HTTPException(status_code=404, detail="tool not found")
    version = catalog_version(pin)
    raw = r.hget(f"catalog:version:{version}", name)
    if raw is None:
        raise HTTPException(status_code=404, detail="tool not found")
    record = json.loads(raw)
    return {
        "name": record["name"],
        "version": record["version"],
        "side_effect": record["side_effect"],
        "definition": record["schema"],
    }
`,
    },
    typescript: {
      starter: `/** GET /v1/tools/:name: a model-generated draft that resolves against the active catalog. */
import Fastify from 'fastify';
import {Redis} from 'ioredis';

export const app = Fastify();
const r = new Redis('redis://redis:6379');

interface ToolRecord {
  name: string;
  version: string;
  schema: unknown;
  side_effect: string;
  owner_endpoint: string;
  credentials_ref: string;
  internal_schema: unknown;
}

async function latestCatalog(): Promise<string> {
  return (await r.get('catalog:active')) ?? '';
}

app.get('/v1/tools/:name', async (request, reply) => {
  const {name} = request.params as {name: string};
  const tenant = request.headers['x-tenant-id'];
  // TODO: review this draft before it ships. It resolves against whatever the active catalog holds
  // and ignores the caller's pin, never consults the caller's allowlist, and returns the stored
  // record field by field — owner endpoint, credential reference and internal schema included.
  if (typeof tenant !== 'string' || tenant === '')
    return reply.code(401).send({error: 'missing X-Tenant-Id'});
  const latest = await latestCatalog();
  const raw = await r.hget(\`catalog:version:\${latest}\`, name);
  if (raw === null) return reply.code(404).send({error: 'tool not found'});
  const record = JSON.parse(raw) as ToolRecord;
  return reply.code(200).send({
    name: record.name,
    version: record.version,
    schema: record.schema,
    side_effect: record.side_effect,
    owner_endpoint: record.owner_endpoint,
    credentials_ref: record.credentials_ref,
    internal_schema: record.internal_schema,
  });
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** GET /v1/tools/:name: resolved against the caller’s pin and allowlist, public fields only. */
import Fastify from 'fastify';
import {Redis} from 'ioredis';

export const app = Fastify();
const r = new Redis('redis://redis:6379');

const ACTIVE_CATALOG_KEY = 'catalog:active';

interface CallerContext {
  tenant: string;
  allowedTools: string[];
}

interface ToolRecord {
  name: string;
  version: string;
  schema: unknown;
  side_effect: string;
}

interface ToolResponse {
  name: string;
  version: string;
  side_effect: string;
  definition: unknown;
}

function httpError(statusCode: number, message: string): Error {
  const error = new Error(message) as Error & {statusCode: number};
  error.statusCode = statusCode;
  return error;
}

async function authenticate(tenant: string | undefined): Promise<CallerContext> {
  if (typeof tenant !== 'string' || tenant === '') throw httpError(401, 'missing X-Tenant-Id');
  const raw = await r.get(\`caller:\${tenant}\`);
  if (raw === null) throw httpError(401, 'unknown caller');
  const profile = JSON.parse(raw) as {allowed_tools: string[]};
  return {tenant, allowedTools: profile.allowed_tools};
}

async function catalogVersion(pin: string | undefined): Promise<string> {
  if (typeof pin === 'string' && pin !== '') return pin;
  const active = await r.get(ACTIVE_CATALOG_KEY);
  if (active === null) throw httpError(503, 'no active catalog');
  return active;
}

app.get('/v1/tools/:name', async (request, reply) => {
  const {name} = request.params as {name: string};
  const caller = await authenticate(request.headers['x-tenant-id'] as string | undefined);
  if (!caller.allowedTools.includes(name)) return reply.code(404).send({error: 'tool not found'});
  const version = await catalogVersion(request.headers['x-catalog-version'] as string | undefined);
  const raw = await r.hget(\`catalog:version:\${version}\`, name);
  if (raw === null) return reply.code(404).send({error: 'tool not found'});
  const record = JSON.parse(raw) as ToolRecord;
  const body: ToolResponse = {
    name: record.name,
    version: record.version,
    side_effect: record.side_effect,
    definition: record.schema,
  };
  return reply.code(200).send(body);
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

	"github.com/redis/go-redis/v9"
)

var rdb *redis.Client

type toolRecord struct {
	Name           string          \`json:"name"\`
	Version        string          \`json:"version"\`
	Schema         json.RawMessage \`json:"schema"\`
	SideEffect     string          \`json:"side_effect"\`
	OwnerEndpoint  string          \`json:"owner_endpoint"\`
	CredentialsRef string          \`json:"credentials_ref"\`
	InternalSchema json.RawMessage \`json:"internal_schema"\`
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func latestCatalog(ctx context.Context) string {
	active, _ := rdb.Get(ctx, "catalog:active").Result()
	return active
}

func resolve(rw http.ResponseWriter, r *http.Request) {
	ctx := context.Background()
	tenant := r.Header.Get("X-Tenant-Id")
	// TODO: review this draft before it ships. It resolves against whatever the active catalog
	// holds and ignores the caller's pin, never consults the caller's allowlist, and returns the
	// stored record field by field — owner endpoint, credential reference and internal schema
	// included.
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-Tenant-Id"})
		return
	}
	name := r.PathValue("name")
	latest := latestCatalog(ctx)
	raw, err := rdb.HGet(ctx, "catalog:version:"+latest, name).Result()
	if err != nil {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "tool not found"})
		return
	}
	var record toolRecord
	if err := json.Unmarshal([]byte(raw), &record); err != nil {
		writeJSON(rw, http.StatusInternalServerError, map[string]string{"error": "corrupt catalog entry"})
		return
	}
	writeJSON(rw, http.StatusOK, map[string]any{
		"name":            record.Name,
		"version":         record.Version,
		"schema":          record.Schema,
		"side_effect":     record.SideEffect,
		"owner_endpoint":  record.OwnerEndpoint,
		"credentials_ref": record.CredentialsRef,
		"internal_schema": record.InternalSchema,
	})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/tools/{name}", resolve)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"

	"github.com/redis/go-redis/v9"
)

const activeCatalogKey = "catalog:active"

var rdb *redis.Client

type callerContext struct {
	Tenant       string
	AllowedTools map[string]struct{}
}

type toolRecord struct {
	Name       string          \`json:"name"\`
	Version    string          \`json:"version"\`
	Schema     json.RawMessage \`json:"schema"\`
	SideEffect string          \`json:"side_effect"\`
}

type toolResponse struct {
	Name       string          \`json:"name"\`
	Version    string          \`json:"version"\`
	SideEffect string          \`json:"side_effect"\`
	Definition json.RawMessage \`json:"definition"\`
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func authenticate(ctx context.Context, tenant string) (callerContext, error) {
	if tenant == "" {
		return callerContext{}, errors.New("missing X-Tenant-Id")
	}
	raw, err := rdb.Get(ctx, "caller:"+tenant).Result()
	if err != nil {
		return callerContext{}, errors.New("unknown caller")
	}
	var profile struct {
		AllowedTools []string \`json:"allowed_tools"\`
	}
	if err := json.Unmarshal([]byte(raw), &profile); err != nil {
		return callerContext{}, err
	}
	allowed := make(map[string]struct{}, len(profile.AllowedTools))
	for _, tool := range profile.AllowedTools {
		allowed[tool] = struct{}{}
	}
	return callerContext{Tenant: tenant, AllowedTools: allowed}, nil
}

func catalogVersion(ctx context.Context, pin string) (string, error) {
	if pin != "" {
		return pin, nil
	}
	active, err := rdb.Get(ctx, activeCatalogKey).Result()
	if err != nil {
		return "", errors.New("no active catalog")
	}
	return active, nil
}

func resolve(rw http.ResponseWriter, r *http.Request) {
	ctx := context.Background()
	caller, err := authenticate(ctx, r.Header.Get("X-Tenant-Id"))
	if err != nil {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": err.Error()})
		return
	}
	name := r.PathValue("name")
	if _, ok := caller.AllowedTools[name]; !ok {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "tool not found"})
		return
	}
	version, err := catalogVersion(ctx, r.Header.Get("X-Catalog-Version"))
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "no active catalog"})
		return
	}
	raw, err := rdb.HGet(ctx, "catalog:version:"+version, name).Result()
	if err != nil {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "tool not found"})
		return
	}
	var record toolRecord
	if err := json.Unmarshal([]byte(raw), &record); err != nil {
		writeJSON(rw, http.StatusInternalServerError, map[string]string{"error": "corrupt catalog entry"})
		return
	}
	writeJSON(rw, http.StatusOK, toolResponse{
		Name:       record.Name,
		Version:    record.Version,
		SideEffect: record.SideEffect,
		Definition: record.Schema,
	})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/tools/{name}", resolve)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
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
import spray.json._

object ToolReadApi {
  implicit val system: ActorSystem = ActorSystem("tool-registry")
  val r = new Jedis("redis", 6379)

  def latestCatalog(): String = Option(r.get("catalog:active")).getOrElse("")

  val route: Route =
    path("v1" / "tools" / Segment) { name =>
      get {
        optionalHeaderValueByName("X-Tenant-Id") { tenantOpt =>
          // TODO: review this draft before it ships. It resolves against whatever the active
          // catalog holds and ignores the caller's pin, never consults the caller's allowlist, and
          // returns the stored record field by field — owner endpoint, credential reference and
          // internal schema included.
          tenantOpt.filter(_.nonEmpty) match {
            case None => complete(StatusCodes.Unauthorized, """{"error":"missing X-Tenant-Id"}""")
            case Some(_) =>
              val latest = latestCatalog()
              Option(r.hget(s"catalog:version:$latest", name)) match {
                case None => complete(StatusCodes.NotFound, """{"error":"tool not found"}""")
                case Some(raw) =>
                  val record = raw.parseJson.asJsObject.fields
                  val body = JsObject(
                    "name" -> record("name"),
                    "version" -> record("version"),
                    "schema" -> record("schema"),
                    "side_effect" -> record("side_effect"),
                    "owner_endpoint" -> record("owner_endpoint"),
                    "credentials_ref" -> record("credentials_ref"),
                    "internal_schema" -> record("internal_schema"),
                  ).compactPrint
                  complete(HttpResponse(StatusCodes.OK, entity = body))
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
      solution: `import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import redis.clients.jedis.Jedis
import spray.json._

object ToolReadApi {
  implicit val system: ActorSystem = ActorSystem("tool-registry")
  val r = new Jedis("redis", 6379)

  val ActiveCatalogKey = "catalog:active"

  final case class CallerContext(tenant: String, allowedTools: Set[String])

  def authenticate(tenant: Option[String]): Option[CallerContext] =
    tenant.filter(_.nonEmpty).flatMap { t =>
      Option(r.get(s"caller:$t")).map { raw =>
        val allowed = raw.parseJson.asJsObject.fields("allowed_tools").convertTo[List[String]].toSet
        CallerContext(t, allowed)
      }
    }

  def catalogVersion(pin: Option[String]): Option[String] =
    pin.filter(_.nonEmpty).orElse(Option(r.get(ActiveCatalogKey)))

  val route: Route =
    path("v1" / "tools" / Segment) { name =>
      get {
        optionalHeaderValueByName("X-Tenant-Id") { tenantOpt =>
          optionalHeaderValueByName("X-Catalog-Version") { pinOpt =>
            authenticate(tenantOpt) match {
              case None => complete(StatusCodes.Unauthorized, """{"error":"missing X-Tenant-Id"}""")
              case Some(caller) if !caller.allowedTools.contains(name) =>
                complete(StatusCodes.NotFound, """{"error":"tool not found"}""")
              case Some(_) =>
                catalogVersion(pinOpt) match {
                  case None => complete(StatusCodes.ServiceUnavailable, """{"error":"no active catalog"}""")
                  case Some(version) =>
                    Option(r.hget(s"catalog:version:$version", name)) match {
                      case None => complete(StatusCodes.NotFound, """{"error":"tool not found"}""")
                      case Some(raw) =>
                        val record = raw.parseJson.asJsObject.fields
                        val served = record("version").convertTo[String]
                        val sideEffect = record("side_effect").convertTo[String]
                        val body = JsObject(
                          "name" -> record("name"),
                          "version" -> JsString(served),
                          "side_effect" -> JsString(sideEffect),
                          "definition" -> record("schema"),
                        ).compactPrint
                        complete(HttpResponse(StatusCodes.OK, entity = body))
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
      starter: `#define CPPHTTPLIB_OPENSSL_SUPPORT
#include <httplib.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <string>

using json = nlohmann::json;

sw::redis::Redis redis("tcp://redis:6379");

std::string latest_catalog() {
  return redis.get("catalog:active").value_or("");
}

int main() {
  httplib::SSLServer svr("cert.pem", "key.pem");

  svr.Get("/v1/tools/:name", [](const httplib::Request& req, httplib::Response& res) {
    const auto tenant = req.get_header_value("X-Tenant-Id");
    // TODO: review this draft before it ships. It resolves against whatever the active catalog
    // holds and ignores the caller's pin, never consults the caller's allowlist, and returns the
    // stored record field by field — owner endpoint, credential reference and internal schema
    // included.
    if (tenant.empty()) {
      res.status = 401;
      res.set_content(R"({"error":"missing X-Tenant-Id"})", "application/json");
      return;
    }
    const auto name = req.path_params.at("name");
    const auto latest = latest_catalog();
    auto raw = redis.hget("catalog:version:" + latest, name);
    if (!raw) {
      res.status = 404;
      res.set_content(R"({"error":"tool not found"})", "application/json");
      return;
    }
    const json record = json::parse(*raw);
    res.status = 200;
    res.set_content(json{
                        {"name", record.at("name")},
                        {"version", record.at("version")},
                        {"schema", record.at("schema")},
                        {"side_effect", record.at("side_effect")},
                        {"owner_endpoint", record.at("owner_endpoint")},
                        {"credentials_ref", record.at("credentials_ref")},
                        {"internal_schema", record.at("internal_schema")},
                    }
                        .dump(),
                    "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#define CPPHTTPLIB_OPENSSL_SUPPORT
#include <httplib.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <optional>
#include <set>
#include <string>

using json = nlohmann::json;

constexpr auto kActiveCatalogKey = "catalog:active";

sw::redis::Redis redis("tcp://redis:6379");

struct CallerContext {
  std::string tenant;
  std::set<std::string> allowed_tools;
};

struct ToolRecord {
  std::string name;
  std::string version;
  std::string side_effect;
  json schema;
};

struct ToolResponse {
  std::string name;
  std::string version;
  std::string side_effect;
  json definition;
};

std::optional<CallerContext> authenticate(const httplib::Request& req) {
  const auto tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) return std::nullopt;
  auto raw = redis.get("caller:" + tenant);
  if (!raw) return std::nullopt;
  const json profile = json::parse(*raw);
  CallerContext caller{tenant, {}};
  for (const auto& tool : profile.at("allowed_tools")) caller.allowed_tools.insert(tool.get<std::string>());
  return caller;
}

std::optional<std::string> catalog_version(const std::string& pin) {
  if (!pin.empty()) return pin;
  auto active = redis.get(kActiveCatalogKey);
  if (!active) return std::nullopt;
  return *active;
}

int main() {
  httplib::SSLServer svr("cert.pem", "key.pem");

  svr.Get("/v1/tools/:name", [](const httplib::Request& req, httplib::Response& res) {
    const auto caller = authenticate(req);
    if (!caller) {
      res.status = 401;
      res.set_content(R"({"error":"missing X-Tenant-Id"})", "application/json");
      return;
    }
    const auto name = req.path_params.at("name");
    if (caller->allowed_tools.count(name) == 0) {
      res.status = 404;
      res.set_content(R"({"error":"tool not found"})", "application/json");
      return;
    }
    const auto pinned = catalog_version(req.get_header_value("X-Catalog-Version"));
    if (!pinned) {
      res.status = 503;
      res.set_content(R"({"error":"no active catalog"})", "application/json");
      return;
    }
    const std::string version = *pinned;
    auto raw = redis.hget("catalog:version:" + version, name);
    if (!raw) {
      res.status = 404;
      res.set_content(R"({"error":"tool not found"})", "application/json");
      return;
    }
    const json record = json::parse(*raw);
    const ToolRecord tool{
        record.at("name").get<std::string>(),
        record.at("version").get<std::string>(),
        record.at("side_effect").get<std::string>(),
        record.at("schema"),
    };
    const ToolResponse body{tool.name, tool.version, tool.side_effect, tool.schema};
    res.status = 200;
    res.set_content(json{
                        {"name", body.name},
                        {"version", body.version},
                        {"side_effect", body.side_effect},
                        {"definition", body.definition},
                    }
                        .dump(),
                    "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  debrief: `The interview question is what the endpoint is allowed to reveal, and under which entitlement. Resolution is two decisions and one lookup: which catalog the caller may see (its pin, with the active pointer only as the fallback) and which tools the caller may see (the allowlist from its authenticated context), then a single HGET on the snapshot that serves both. The allowlist answers 404 rather than 403 for the same reason a missing entry does: a resolver must not confirm that a tool exists to a caller who cannot use it, or it becomes an enumeration oracle for the whole catalog. The response is a contract, not a record dump — the stored entry exists for the platform’s own use and carries the owner team’s internal wiring, while the caller gets the version it was entitled to and the fields it can act on. Real registries go further: signature verification on the pinned catalog, per-tool scopes inside the allowlist, and an audit event for every resolution of an irreversible tool.`,
};
