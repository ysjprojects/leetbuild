import type {Step} from '@/lib/types';

export const endpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/connectors: a registration pinned to the registered host',
  concept: 'http',
  guides: ['request-boundaries', 'idempotent-requests'],
  file: 'api',
  focus: ['client', 'hub', 'db', 'oauth'],
  task: `## Task

**Starting point.** The starter serves \`POST /v1/connectors\` on the connector registry
(\`hub.store\`, provided): it reads \`X-Tenant-Id\`, takes the host from the caller's \`base_url\`
(from \`REGISTERED_HOSTS\` when there is none), creates the row with \`store.create\` and answers that
row with 201. It serves the demo and hides four flaws.

**Failure mode the checks target.** A tenant registers a connector whose \`base_url\` points at the
cloud metadata endpoint, and the sync worker will call it with the customer's token; the token
reference comes back in every answer; a request without a tenant, or for \`source_type: "ftp"\`, is
accepted; and a client that retries after a timeout gets a second connector.

- A missing \`X-Tenant-Id\` is **401**; a \`source_type\` outside \`REGISTERED_HOSTS\` is **400**.
- The host is always \`REGISTERED_HOSTS[source_type]\`. A \`base_url\`, when sent, must be \`https\` on
  exactly that host, compared as strings: anything else is **403** and creates nothing.
- The answer is \`{connector_id, source_type, host, status}\`; the token reference stays in the
  registry.
- \`Idempotency-Key\` is required (**400**). Look \`store.find_by_key(tenant, key)\` up first and answer a
  replay with that connector (**200**); record a new one with \`store.remember_key\`.`,
  sequence: {
    participants: ['Operator', 'connectord', 'connector registry'],
    messages: [
      {from: 'Operator', to: 'connectord', label: 'POST /v1/connectors · X-Tenant-Id · Idempotency-Key', kind: 'sync'},
      {from: 'connectord', to: 'connectord', label: 'tenant → 401 · source → 400 · base_url host → 403', kind: 'sync'},
      {from: 'connectord', to: 'connector registry', label: 'find_by_key(tenant, key)', kind: 'sync'},
      {from: 'connector registry', to: 'connectord', label: 'existing connector → 200', kind: 'reply'},
      {
        from: 'connectord',
        to: 'connector registry',
        label: 'create(…, REGISTERED_HOSTS[source]) · remember_key',
        kind: 'sync',
      },
      {from: 'connectord', to: 'Operator', label: '201 {connector_id, source_type, host, status}', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Registers a connector on POST /v1/connectors',
      detail:
        'Register `POST /v1/connectors`; a registration creates a row in the registry and answers its id, host and status.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/connectors["']/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/connectors['"]/]},
        go: {all: [/HandleFunc\(\s*"POST \/v1\/connectors"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"connectors"\s*\)/, /\bpost\b/]},
        cpp: {all: [/svr\.Post\(\s*"\/v1\/connectors"/]},
      },
    },
    {
      id: 'tenant-and-source',
      title: 'Requires a tenant and a registered source type',
      detail:
        'A registration without `X-Tenant-Id` answers **401** and one whose `source_type` is not a key of `REGISTERED_HOSTS` answers **400**, both before anything is created.',
      match: {
        python: {all: [/status_code\s*=\s*401/, /status_code\s*=\s*400/]},
        typescript: {all: [/code\(\s*401\s*\)/, /code\(\s*400\s*\)/]},
        go: {all: [/StatusUnauthorized/, /StatusBadRequest/]},
        scala: {all: [/Unauthorized/, /BadRequest/]},
        cpp: {all: [/\b401\b/, /\b400\b/]},
      },
    },
    {
      id: 'registered-host',
      title: 'Pins the connector to the registered host',
      detail:
        'The host is the one `REGISTERED_HOSTS` holds for the source type; a `base_url` that is not `https` on exactly that host answers **403**, decided by comparing strings, without creating a row.',
      match: {
        python: {all: [/status_code\s*=\s*403/, /["']https["']/]},
        typescript: {all: [/code\(\s*403\s*\)/, /['"]https:?['"]/]},
        go: {all: [/StatusForbidden/, /"https"/]},
        scala: {all: [/Forbidden/, /"https"/]},
        cpp: {all: [/\b403\b/, /"https"/]},
      },
    },
    {
      id: 'token-redacted',
      title: 'Answers a view without the token reference',
      detail:
        'The answer is built field by field as `{connector_id, source_type, host, status}`; answering the registry row hands the token reference to every caller and every log that records responses.',
      match: {
        python: {
          all: [/["']connector_id["']\s*:\s*\w+\[/],
          none: [/return store\.create\(/, /JSONResponse\(\s*(row|existing)\s*[,)]/],
        },
        typescript: {all: [/connector_id:\s*\w+\.connector_id/], none: [/\.send\(\s*(row|existing)\s*\)/]},
        go: {all: [/ConnectorID:\s*\w+\.ConnectorID/], none: [/writeJSON\([^)\n]*,\s*(row|existing)\)/]},
        scala: {all: [/"connector_id"\s*->/], none: [/"token_ref"\s*->/]},
        cpp: {all: [/\{"connector_id",/], none: [/\{"token_ref",/]},
      },
    },
    {
      id: 'idempotent-register',
      title: 'Answers a replayed registration with the existing connector',
      detail:
        '`Idempotency-Key` is required (**400**); the `(tenant, key)` is looked up with `find_by_key`/`findByKey` before a connector is created, a replay answers that connector with **200**, and a new one is recorded with `remember_key`/`rememberKey`.',
      match: {
        python: {
          all: [/idempotency-key/i, /store\.find_by_key\(/, /store\.remember_key\(/],
          order: [/store\.find_by_key\(/, /store\.create\(/],
        },
        typescript: {all: [/idempotency-key/i, /findByKey\(/, /rememberKey\(/], order: [/findByKey\(/, /\bcreate\(/]},
        go: {
          all: [/Idempotency-Key/i, /store\.FindByKey\(/, /store\.RememberKey\(/],
          order: [/store\.FindByKey\(/, /store\.Create\(/],
        },
        scala: {
          all: [/Idempotency-Key/i, /Store\.findByKey\(/, /Store\.rememberKey\(/],
          order: [/Store\.findByKey\(/, /Store\.create\(/],
        },
        cpp: {
          all: [/Idempotency-Key/i, /store::findByKey\(/, /store::rememberKey\(/],
          order: [/store::findByKey\(/, /store::create\(/],
        },
      },
    },
  ],
  code: {
    python: {
      starter: `from urllib.parse import urlsplit

from fastapi import FastAPI, Request
from pydantic import BaseModel

from hub import store  # get, create, find_by_key, remember_key, disable, DEFAULT_SYNC_INTERVAL_S

app = FastAPI()

# The host the platform registered for each source type.
REGISTERED_HOSTS = {"github": "api.github.com", "slack": "slack.com", "stripe": "api.stripe.com", "notion": "api.notion.com"}


class Registration(BaseModel):
    source_type: str
    token_ref: str
    base_url: str | None = None
    sync_interval_s: int = store.DEFAULT_SYNC_INTERVAL_S


@app.post("/v1/connectors", status_code=201)
def register(body: Registration, request: Request) -> dict:
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    tenant = request.headers.get("x-tenant-id", "")
    host = urlsplit(body.base_url).hostname if body.base_url else REGISTERED_HOSTS.get(body.source_type, "")
    return store.create(tenant, body.source_type, host or "", body.token_ref, body.sync_interval_s)
`,
      solution: `from urllib.parse import urlsplit

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from hub import store  # get, create, find_by_key, remember_key, disable, DEFAULT_SYNC_INTERVAL_S

app = FastAPI()

# The host the platform registered for each source type.
REGISTERED_HOSTS = {"github": "api.github.com", "slack": "slack.com", "stripe": "api.stripe.com", "notion": "api.notion.com"}


class Registration(BaseModel):
    source_type: str
    token_ref: str
    base_url: str | None = None
    sync_interval_s: int = store.DEFAULT_SYNC_INTERVAL_S


def public_view(row: dict) -> dict:
    """What a caller sees of a connector: the token reference stays in the registry."""
    return {"connector_id": row["connector_id"], "source_type": row["source_type"], "host": row["host"], "status": row["status"]}


@app.post("/v1/connectors", status_code=201)
def register(body: Registration, request: Request) -> JSONResponse:
    tenant = request.headers.get("x-tenant-id", "")
    if not tenant:
        raise HTTPException(status_code=401, detail="X-Tenant-Id is required")
    key = request.headers.get("idempotency-key", "")
    if not key:
        raise HTTPException(status_code=400, detail="Idempotency-Key is required")
    host = REGISTERED_HOSTS.get(body.source_type)
    if host is None:
        raise HTTPException(status_code=400, detail=f"unknown source_type {body.source_type!r}")
    if body.base_url is not None:
        url = urlsplit(body.base_url)
        # A comparison with the registration the platform holds; the URL itself is never called.
        if url.scheme != "https" or url.hostname != host:
            raise HTTPException(status_code=403, detail=f"base_url must be https://{host}")
    existing = store.find_by_key(tenant, key)
    if existing is not None:
        return JSONResponse(public_view(existing))  # a replay answers the connector the key created
    row = store.create(tenant, body.source_type, host, body.token_ref, body.sync_interval_s)
    store.remember_key(tenant, key, row["connector_id"])
    return JSONResponse(public_view(row), status_code=201)
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';

import {DEFAULT_SYNC_INTERVAL_S, create, findByKey, rememberKey} from 'hub/store';

export const app = Fastify();

/** The host the platform registered for each source type. */
export const REGISTERED_HOSTS: Record<string, string> = {github: 'api.github.com', slack: 'slack.com', stripe: 'api.stripe.com', notion: 'api.notion.com'};

interface Registration {
  source_type: string;
  token_ref: string;
  base_url?: string | null;
  sync_interval_s?: number;
}

app.post('/v1/connectors', async (request, reply) => {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const body = request.body as Registration;
  const tenant = String(request.headers['x-tenant-id'] ?? '');
  const host = body.base_url ? new URL(body.base_url).hostname : (REGISTERED_HOSTS[body.source_type] ?? '');
  const row = await create(tenant, body.source_type, host, body.token_ref, body.sync_interval_s ?? DEFAULT_SYNC_INTERVAL_S);
  return reply.code(201).send(row);
});
`,
      solution: `import Fastify from 'fastify';

import {type Connector, DEFAULT_SYNC_INTERVAL_S, create, findByKey, rememberKey} from 'hub/store';

export const app = Fastify();

/** The host the platform registered for each source type. */
export const REGISTERED_HOSTS: Record<string, string> = {github: 'api.github.com', slack: 'slack.com', stripe: 'api.stripe.com', notion: 'api.notion.com'};

interface Registration {
  source_type: string;
  token_ref: string;
  base_url?: string | null;
  sync_interval_s?: number;
}

/** What a caller sees of a connector: the token reference stays in the registry. */
const publicView = (row: Connector) => ({connector_id: row.connector_id, source_type: row.source_type, host: row.host, status: row.status});

app.post('/v1/connectors', async (request, reply) => {
  const body = request.body as Registration;
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'X-Tenant-Id is required'});
  const key = request.headers['idempotency-key'];
  if (typeof key !== 'string' || key === '') return reply.code(400).send({error: 'Idempotency-Key is required'});
  const host = REGISTERED_HOSTS[body.source_type];
  if (host === undefined) return reply.code(400).send({error: \`unknown source_type \${body.source_type}\`});
  if (body.base_url !== undefined && body.base_url !== null) {
    // A comparison with the registration the platform holds; the URL itself is never called.
    let url: URL | null = null;
    try {
      url = new URL(body.base_url);
    } catch {
      url = null;
    }
    if (url === null || url.protocol !== 'https:' || url.hostname !== host) return reply.code(403).send({error: \`base_url must be https://\${host}\`});
  }
  const existing = await findByKey(tenant, key);
  if (existing !== null) return reply.code(200).send(publicView(existing)); // a replay answers the connector the key created
  const row = await create(tenant, body.source_type, host, body.token_ref, body.sync_interval_s ?? DEFAULT_SYNC_INTERVAL_S);
  await rememberKey(tenant, key, row.connector_id);
  return reply.code(201).send(publicView(row));
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"net/http"
	"net/url"

	"hub/store" // store.Create, Get, FindByKey, RememberKey, Disable, DefaultSyncIntervalS
)

// registeredHosts is the host the platform registered for each source type.
var registeredHosts = map[string]string{"github": "api.github.com", "slack": "slack.com", "stripe": "api.stripe.com", "notion": "api.notion.com"}

type registration struct {
	SourceType    string \`json:"source_type"\`
	TokenRef      string \`json:"token_ref"\`
	BaseURL       string \`json:"base_url"\`
	SyncIntervalS int    \`json:"sync_interval_s"\`
}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func registerConnector(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	var body registration
	json.NewDecoder(r.Body).Decode(&body)
	if body.SyncIntervalS == 0 {
		body.SyncIntervalS = store.DefaultSyncIntervalS
	}
	host := registeredHosts[body.SourceType]
	if body.BaseURL != "" {
		if u, err := url.Parse(body.BaseURL); err == nil {
			host = u.Hostname()
		}
	}
	row := store.Create(r.Context(), r.Header.Get("X-Tenant-Id"), body.SourceType, host, body.TokenRef, body.SyncIntervalS)
	writeJSON(rw, http.StatusCreated, row)
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/connectors", registerConnector)
}
`,
      solution: `package main

import (
	"encoding/json"
	"net/http"
	"net/url"

	"hub/store" // store.Create, Get, FindByKey, RememberKey, Disable, DefaultSyncIntervalS
)

// registeredHosts is the host the platform registered for each source type.
var registeredHosts = map[string]string{"github": "api.github.com", "slack": "slack.com", "stripe": "api.stripe.com", "notion": "api.notion.com"}

type registration struct {
	SourceType    string \`json:"source_type"\`
	TokenRef      string \`json:"token_ref"\`
	BaseURL       string \`json:"base_url"\`
	SyncIntervalS int    \`json:"sync_interval_s"\`
}

// connectorView is what a caller sees of a connector: the token reference stays in the registry.
type connectorView struct {
	ConnectorID string \`json:"connector_id"\`
	SourceType  string \`json:"source_type"\`
	Host        string \`json:"host"\`
	Status      string \`json:"status"\`
}

func publicView(row *store.Connector) connectorView {
	return connectorView{ConnectorID: row.ConnectorID, SourceType: row.SourceType, Host: row.Host, Status: row.Status}
}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func registerConnector(rw http.ResponseWriter, r *http.Request) {
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
	var body registration
	json.NewDecoder(r.Body).Decode(&body)
	host, known := registeredHosts[body.SourceType]
	if !known {
		http.Error(rw, "unknown source_type "+body.SourceType, http.StatusBadRequest)
		return
	}
	if body.BaseURL != "" {
		// A comparison with the registration the platform holds; the URL itself is never called.
		u, err := url.Parse(body.BaseURL)
		if err != nil || u.Scheme != "https" || u.Hostname() != host {
			http.Error(rw, "base_url must be https://"+host, http.StatusForbidden)
			return
		}
	}
	if existing := store.FindByKey(r.Context(), tenant, key); existing != nil {
		writeJSON(rw, http.StatusOK, publicView(existing)) // a replay answers the connector the key created
		return
	}
	if body.SyncIntervalS == 0 {
		body.SyncIntervalS = store.DefaultSyncIntervalS
	}
	row := store.Create(r.Context(), tenant, body.SourceType, host, body.TokenRef, body.SyncIntervalS)
	store.RememberKey(r.Context(), tenant, key, row.ConnectorID)
	writeJSON(rw, http.StatusCreated, publicView(row))
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/connectors", registerConnector)
}
`,
    },
    scala: {
      starter: `import java.net.URI

import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import hub.Store // Store.create, get, findByKey, rememberKey, disable, DefaultSyncIntervalS

object Api {
  /** The host the platform registered for each source type. */
  val RegisteredHosts: Map[String, String] = Map("github" -> "api.github.com", "slack" -> "slack.com", "stripe" -> "api.stripe.com", "notion" -> "api.notion.com")

  private def json(status: StatusCode, body: JsObject): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  private def rowJson(row: Store.Connector): JsObject = JsObject(
    "connector_id" -> JsString(row.connectorId), "tenant" -> JsString(row.tenant), "source_type" -> JsString(row.sourceType),
    "host" -> JsString(row.host), "token_ref" -> JsString(row.tokenRef), "status" -> JsString(row.status))

  val route: Route = path("v1" / "connectors") {
    post {
      optionalHeaderValueByName("X-Tenant-Id") { tenant =>
        entity(as[String]) { raw =>
          // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
          val body = raw.parseJson.asJsObject.fields
          def text(name: String): Option[String] = body.get(name).collect { case JsString(s) => s }
          val sourceType = text("source_type").getOrElse("")
          val host = text("base_url").map(url => Option(new URI(url).getHost).getOrElse("")).getOrElse(RegisteredHosts.getOrElse(sourceType, ""))
          val interval = body.get("sync_interval_s").collect { case JsNumber(n) => n.toLong }.getOrElse(Store.DefaultSyncIntervalS)
          val row = Store.create(tenant.getOrElse(""), sourceType, host, text("token_ref").getOrElse(""), interval)
          complete(json(StatusCodes.Created, rowJson(row)))
        }
      }
    }
  }
}
`,
      solution: `import java.net.URI

import scala.util.Try

import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import hub.Store // Store.create, get, findByKey, rememberKey, disable, DefaultSyncIntervalS

object Api {
  /** The host the platform registered for each source type. */
  val RegisteredHosts: Map[String, String] = Map("github" -> "api.github.com", "slack" -> "slack.com", "stripe" -> "api.stripe.com", "notion" -> "api.notion.com")

  private def json(status: StatusCode, body: JsObject): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  /** What a caller sees of a connector: the token reference stays in the registry. */
  private def publicView(row: Store.Connector): JsObject = JsObject(
    "connector_id" -> JsString(row.connectorId), "source_type" -> JsString(row.sourceType),
    "host" -> JsString(row.host), "status" -> JsString(row.status))

  /** Whether a base_url is https on exactly the registered host: a comparison, the URL is never called. */
  private def onHost(baseUrl: String, host: String): Boolean =
    Try(new URI(baseUrl)).toOption.exists(uri => uri.getScheme == "https" && uri.getHost == host)

  val route: Route = path("v1" / "connectors") {
    post {
      (optionalHeaderValueByName("X-Tenant-Id") & optionalHeaderValueByName("Idempotency-Key")) { (tenant, key) =>
        entity(as[String]) { raw =>
          val body = raw.parseJson.asJsObject.fields
          def text(name: String): Option[String] = body.get(name).collect { case JsString(s) => s }
          val sourceType = text("source_type").getOrElse("")
          (tenant.filter(_.nonEmpty), key.filter(_.nonEmpty), RegisteredHosts.get(sourceType)) match {
            case (None, _, _) => complete(StatusCodes.Unauthorized -> "X-Tenant-Id is required")
            case (_, None, _) => complete(StatusCodes.BadRequest -> "Idempotency-Key is required")
            case (_, _, None) => complete(StatusCodes.BadRequest -> s"unknown source_type $sourceType")
            case (Some(t), Some(k), Some(host)) =>
              if (text("base_url").exists(url => !onHost(url, host))) complete(StatusCodes.Forbidden -> s"base_url must be https://$host")
              else
                Store.findByKey(t, k) match {
                  case Some(existing) => complete(json(StatusCodes.OK, publicView(existing))) // a replay answers the connector the key created
                  case None =>
                    val interval = body.get("sync_interval_s").collect { case JsNumber(n) => n.toLong }.getOrElse(Store.DefaultSyncIntervalS)
                    val row = Store.create(t, sourceType, host, text("token_ref").getOrElse(""), interval)
                    Store.rememberKey(t, k, row.connectorId)
                    complete(json(StatusCodes.Created, publicView(row)))
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

#include <map>
#include <string>
#include <utility>

#include "hub/store.h"  // store::create, get, findByKey, rememberKey, disable, kDefaultSyncIntervalS

using json = nlohmann::json;

// The host the platform registered for each source type.
const std::map<std::string, std::string> kRegisteredHosts = {
    {"github", "api.github.com"}, {"slack", "slack.com"}, {"stripe", "api.stripe.com"}, {"notion", "api.notion.com"}};

// The scheme and host of a URL ("https", "api.github.com"); both empty without "://".
std::pair<std::string, std::string> splitUrl(const std::string& url) {
  const size_t sep = url.find("://");
  if (sep == std::string::npos) return {"", ""};
  std::string authority = url.substr(sep + 3, url.find_first_of("/?#", sep + 3) - (sep + 3));
  if (const size_t at = authority.rfind('@'); at != std::string::npos) authority = authority.substr(at + 1);
  if (const size_t colon = authority.find(':'); colon != std::string::npos) authority = authority.substr(0, colon);
  return {url.substr(0, sep), authority};
}

json rowJson(const store::Connector& row) {
  return json{{"connector_id", row.connector_id}, {"tenant", row.tenant},       {"source_type", row.source_type},
              {"host", row.host},                 {"token_ref", row.token_ref}, {"status", row.status}};
}

void register_connector(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const json body = json::parse(req.body);
  const std::string source_type = body.value("source_type", "");
  std::string host = kRegisteredHosts.count(source_type) ? kRegisteredHosts.at(source_type) : "";
  const std::string base_url = body.contains("base_url") && body["base_url"].is_string() ? body["base_url"].get<std::string>() : "";
  if (!base_url.empty()) host = splitUrl(base_url).second;
  const store::Connector row = store::create(req.get_header_value("X-Tenant-Id"), source_type, host, body.value("token_ref", ""),
                                             body.value("sync_interval_s", store::kDefaultSyncIntervalS));
  res.status = 201;
  res.set_content(rowJson(row).dump(), "application/json");
}

void register_routes(httplib::Server& svr) { svr.Post("/v1/connectors", register_connector); }
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <map>
#include <string>
#include <utility>

#include "hub/store.h"  // store::create, get, findByKey, rememberKey, disable, kDefaultSyncIntervalS

using json = nlohmann::json;

// The host the platform registered for each source type.
const std::map<std::string, std::string> kRegisteredHosts = {
    {"github", "api.github.com"}, {"slack", "slack.com"}, {"stripe", "api.stripe.com"}, {"notion", "api.notion.com"}};

// The scheme and host of a URL ("https", "api.github.com"); both empty without "://".
std::pair<std::string, std::string> splitUrl(const std::string& url) {
  const size_t sep = url.find("://");
  if (sep == std::string::npos) return {"", ""};
  std::string authority = url.substr(sep + 3, url.find_first_of("/?#", sep + 3) - (sep + 3));
  if (const size_t at = authority.rfind('@'); at != std::string::npos) authority = authority.substr(at + 1);
  if (const size_t colon = authority.find(':'); colon != std::string::npos) authority = authority.substr(0, colon);
  return {url.substr(0, sep), authority};
}

// What a caller sees of a connector: the token reference stays in the registry.
json publicView(const store::Connector& row) {
  return json{{"connector_id", row.connector_id}, {"source_type", row.source_type}, {"host", row.host}, {"status", row.status}};
}

void fail(httplib::Response& res, int status, const std::string& message) {
  res.status = status;
  res.set_content(message, "text/plain");
}

void register_connector(const httplib::Request& req, httplib::Response& res) {
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) return fail(res, 401, "X-Tenant-Id is required");
  const std::string key = req.get_header_value("Idempotency-Key");
  if (key.empty()) return fail(res, 400, "Idempotency-Key is required");
  const json body = json::parse(req.body);
  const std::string source_type = body.value("source_type", "");
  const auto registered = kRegisteredHosts.find(source_type);
  if (registered == kRegisteredHosts.end()) return fail(res, 400, "unknown source_type " + source_type);
  const std::string& host = registered->second;
  if (body.contains("base_url") && body["base_url"].is_string()) {
    // A comparison with the registration the platform holds; the URL itself is never called.
    const auto [scheme, url_host] = splitUrl(body["base_url"].get<std::string>());
    if (scheme != "https" || url_host != host) return fail(res, 403, "base_url must be https://" + host);
  }
  if (const auto existing = store::findByKey(tenant, key)) {
    res.set_content(publicView(*existing).dump(), "application/json");  // a replay answers the connector the key created
    return;
  }
  const store::Connector row =
      store::create(tenant, source_type, host, body.value("token_ref", ""), body.value("sync_interval_s", store::kDefaultSyncIntervalS));
  store::rememberKey(tenant, key, row.connector_id);
  res.status = 201;
  res.set_content(publicView(row).dump(), "application/json");
}

void register_routes(httplib::Server& svr) { svr.Post("/v1/connectors", register_connector); }
`,
    },
  },
  harness: {
    python: `from hub import store

TOKEN = "vault:acme/github#4"
GITHUB = {"source_type": "github", "token_ref": TOKEN, "base_url": "https://api.github.com"}


def _api(ctx):
    return ctx.client(ctx.load("api").app)


def _headers(tenant="acme", key="k-1"):
    headers = {}
    if tenant:
        headers["X-Tenant-Id"] = tenant
    if key:
        headers["Idempotency-Key"] = key
    return headers


def _connectors(ctx):
    return sorted(ctx.redis.keys("connector:c-*"))


async def check_route(ctx):
    async with _api(ctx) as c:
        r = await c.post("/v1/connectors", json=GITHUB, headers=_headers())
    assert r.status_code == 201, f"POST /v1/connectors answered {r.status_code}: {r.text}"
    body = r.json()
    row = store.get(body.get("connector_id", ""))
    assert row is not None, f"the answer {body} names no connector the registry holds"
    assert (row["tenant"], row["source_type"], row["host"]) == ("acme", "github", "api.github.com"), f"the registry holds {row}, expected tenant acme, source github, host api.github.com"
    assert body.get("host") == "api.github.com" and body.get("status") == "enabled", f"the answer must carry the host and the status, got {body}"


async def check_tenant_and_source(ctx):
    async with _api(ctx) as c:
        anon = await c.post("/v1/connectors", json=GITHUB, headers=_headers(tenant=""))
        assert anon.status_code == 401, f"a registration without X-Tenant-Id answered {anon.status_code}, expected 401"
        ftp = await c.post("/v1/connectors", json={"source_type": "ftp", "token_ref": TOKEN}, headers=_headers(key="k-2"))
        assert ftp.status_code == 400, f"a registration for source_type ftp answered {ftp.status_code}, expected 400: only the sources in REGISTERED_HOSTS have a host the platform registered"
    assert _connectors(ctx) == [], f"refused registrations created connectors: {_connectors(ctx)}"


async def check_registered_host(ctx):
    async with _api(ctx) as c:
        for url in ("https://169.254.169.254/latest/meta-data", "https://api.github.com.evil.io", "http://api.github.com", "https://evil.io/?next=https://api.github.com"):
            r = await c.post("/v1/connectors", json={**GITHUB, "base_url": url}, headers=_headers(key=url))
            assert r.status_code == 403, f"base_url {url} answered {r.status_code}, expected 403: the sync worker would call a host the platform never registered for github, with the customer's token"
        assert _connectors(ctx) == [], f"refused registrations created connectors: {[store.get(k.split(':', 1)[1]) for k in _connectors(ctx)]}"
        r = await c.post("/v1/connectors", json={"source_type": "github", "token_ref": TOKEN}, headers=_headers(key="k-none"))
    assert r.status_code == 201 and r.json().get("host") == "api.github.com", f"a registration without base_url must take the registered host, got {r.status_code} {r.text}"


async def check_token_redacted(ctx):
    async with _api(ctx) as c:
        first = await c.post("/v1/connectors", json=GITHUB, headers=_headers())
        assert first.status_code == 201, f"POST /v1/connectors answered {first.status_code}: {first.text}"
        replay = await c.post("/v1/connectors", json=GITHUB, headers=_headers())
    for r in (first, replay):
        assert TOKEN not in r.text, f"the answer carries the token reference: {r.text}. Answer {{connector_id, source_type, host, status}}; the reference stays in the registry"
    row = store.get(first.json()["connector_id"])
    assert row is not None and row["token_ref"] == TOKEN, f"the registry must keep the token reference, it holds {row}"


async def check_idempotent_register(ctx):
    async with _api(ctx) as c:
        first = await c.post("/v1/connectors", json=GITHUB, headers=_headers(key="k-1"))
        assert first.status_code == 201, f"the first registration answered {first.status_code}: {first.text}"
        replay = await c.post("/v1/connectors", json=GITHUB, headers=_headers(key="k-1"))
        assert replay.status_code == 200, f"a replay of Idempotency-Key k-1 answered {replay.status_code}, expected 200 with the connector the first attempt created"
        assert replay.json().get("connector_id") == first.json().get("connector_id"), f"the replay answered {replay.json().get('connector_id')}, the first attempt created {first.json().get('connector_id')}"
        assert len(_connectors(ctx)) == 1, f"two registrations with one key created {len(_connectors(ctx))} connectors"
        other = await c.post("/v1/connectors", json=GITHUB, headers=_headers(tenant="globex", key="k-1"))
        assert other.status_code == 201 and other.json().get("connector_id") != first.json().get("connector_id"), f"the same key from another tenant is another registration, got {other.status_code} {other.text}"
        missing = await c.post("/v1/connectors", json=GITHUB, headers=_headers(key=""))
    assert missing.status_code == 400, f"a registration without Idempotency-Key answered {missing.status_code}, expected 400"
`,
    typescript: `const TOKEN = 'vault:acme/github#4';
const GITHUB = {source_type: 'github', token_ref: TOKEN, base_url: 'https://api.github.com'};

function api(ctx) {
  return {c: ctx.client(ctx.load('api').app), store: ctx.load('/support/hub/store.ts')};
}

function headers(tenant = 'acme', key = 'k-1'): Record<string, string> {
  const out: Record<string, string> = {};
  if (tenant !== '') out['X-Tenant-Id'] = tenant;
  if (key !== '') out['Idempotency-Key'] = key;
  return out;
}

const connectors = (ctx): string[] => ctx.redis.keys('connector:c-*').sort();

export async function check_route(ctx) {
  const {c, store} = api(ctx);
  const r = await c.post('/v1/connectors', {json: GITHUB, headers: headers()});
  assert.equal(r.status, 201, \`POST /v1/connectors answered \${r.status}: \${r.text}\`);
  const body = r.json();
  const row = await store.get(body.connector_id ?? '');
  assert(row !== null, \`the answer \${r.text} names no connector the registry holds\`);
  assert(row.tenant === 'acme' && row.source_type === 'github' && row.host === 'api.github.com', \`the registry holds \${JSON.stringify(row)}, expected tenant acme, source github, host api.github.com\`);
  assert(body.host === 'api.github.com' && body.status === 'enabled', \`the answer must carry the host and the status, got \${r.text}\`);
}

export async function check_tenant_and_source(ctx) {
  const {c} = api(ctx);
  const anon = await c.post('/v1/connectors', {json: GITHUB, headers: headers('')});
  assert.equal(anon.status, 401, \`a registration without X-Tenant-Id answered \${anon.status}, expected 401\`);
  const ftp = await c.post('/v1/connectors', {json: {source_type: 'ftp', token_ref: TOKEN}, headers: headers('acme', 'k-2')});
  assert.equal(ftp.status, 400, \`a registration for source_type ftp answered \${ftp.status}, expected 400: only the sources in REGISTERED_HOSTS have a host the platform registered\`);
  assert.deepStrictEqual(connectors(ctx), [], \`refused registrations created connectors: \${JSON.stringify(connectors(ctx))}\`);
}

export async function check_registered_host(ctx) {
  const {c} = api(ctx);
  for (const url of ['https://169.254.169.254/latest/meta-data', 'https://api.github.com.evil.io', 'http://api.github.com', 'https://evil.io/?next=https://api.github.com']) {
    const r = await c.post('/v1/connectors', {json: {...GITHUB, base_url: url}, headers: headers('acme', url)});
    assert.equal(r.status, 403, \`base_url \${url} answered \${r.status}, expected 403: the sync worker would call a host the platform never registered for github, with the customer's token\`);
  }
  assert.deepStrictEqual(connectors(ctx), [], \`refused registrations created connectors: \${JSON.stringify(connectors(ctx))}\`);
  const r = await c.post('/v1/connectors', {json: {source_type: 'github', token_ref: TOKEN}, headers: headers('acme', 'k-none')});
  assert(r.status === 201 && r.json().host === 'api.github.com', \`a registration without base_url must take the registered host, got \${r.status} \${r.text}\`);
}

export async function check_token_redacted(ctx) {
  const {c, store} = api(ctx);
  const first = await c.post('/v1/connectors', {json: GITHUB, headers: headers()});
  assert.equal(first.status, 201, \`POST /v1/connectors answered \${first.status}: \${first.text}\`);
  const replay = await c.post('/v1/connectors', {json: GITHUB, headers: headers()});
  for (const r of [first, replay]) {
    assert(!r.text.includes(TOKEN), \`the answer carries the token reference: \${r.text}. Answer {connector_id, source_type, host, status}; the reference stays in the registry\`);
  }
  const row = await store.get(first.json().connector_id);
  assert(row !== null && row.token_ref === TOKEN, \`the registry must keep the token reference, it holds \${JSON.stringify(row)}\`);
}

export async function check_idempotent_register(ctx) {
  const {c} = api(ctx);
  const first = await c.post('/v1/connectors', {json: GITHUB, headers: headers('acme', 'k-1')});
  assert.equal(first.status, 201, \`the first registration answered \${first.status}: \${first.text}\`);
  const replay = await c.post('/v1/connectors', {json: GITHUB, headers: headers('acme', 'k-1')});
  assert.equal(replay.status, 200, \`a replay of Idempotency-Key k-1 answered \${replay.status}, expected 200 with the connector the first attempt created\`);
  assert.equal(replay.json().connector_id, first.json().connector_id, \`the replay answered \${replay.json().connector_id}, the first attempt created \${first.json().connector_id}\`);
  assert.equal(connectors(ctx).length, 1, \`two registrations with one key created \${connectors(ctx).length} connectors\`);
  const other = await c.post('/v1/connectors', {json: GITHUB, headers: headers('globex', 'k-1')});
  assert(other.status === 201 && other.json().connector_id !== first.json().connector_id, \`the same key from another tenant is another registration, got \${other.status} \${other.text}\`);
  const missing = await c.post('/v1/connectors', {json: GITHUB, headers: headers('acme', '')});
  assert.equal(missing.status, 400, \`a registration without Idempotency-Key answered \${missing.status}, expected 400\`);
}
`,
    go: `package main

import (
	"context"
	"net/http"
	"strings"

	"hub/store"

	"leetbuild/harness"
)

const token = "vault:acme/github#4"

var github = map[string]any{"source_type": "github", "token_ref": token, "base_url": "https://api.github.com"}

func api(ctx *harness.Ctx) *harness.HTTP {
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

func post(c *harness.HTTP, body map[string]any, tenant, key string) *harness.Response {
	var header []string
	if tenant != "" {
		header = append(header, "X-Tenant-Id", tenant)
	}
	if key != "" {
		header = append(header, "Idempotency-Key", key)
	}
	return c.Post("/v1/connectors", body, header...)
}

func with(base map[string]any, key string, value any) map[string]any {
	out := map[string]any{}
	for k, v := range base {
		out[k] = v
	}
	if value == nil {
		delete(out, key)
	} else {
		out[key] = value
	}
	return out
}

func connectorOf(r *harness.Response) string {
	var body struct {
		ConnectorID string \`json:"connector_id"\`
	}
	r.Decode(&body)
	return body.ConnectorID
}

func CheckRoute(ctx *harness.Ctx) {
	r := post(api(ctx), github, "acme", "k-1")
	ctx.Equal(r.Status, 201, "POST /v1/connectors (%s)", r.Text())
	var body struct {
		ConnectorID string \`json:"connector_id"\`
		Host        string \`json:"host"\`
		Status      string \`json:"status"\`
	}
	r.Decode(&body)
	row := store.Get(context.Background(), body.ConnectorID)
	ctx.Assert(row != nil, "the answer %s names no connector the registry holds", r.Text())
	ctx.Assert(row.Tenant == "acme" && row.SourceType == "github" && row.Host == "api.github.com", "the registry holds %+v, expected tenant acme, source github, host api.github.com", row)
	ctx.Assert(body.Host == "api.github.com" && body.Status == "enabled", "the answer must carry the host and the status, got %s", r.Text())
}

func CheckTenantAndSource(ctx *harness.Ctx) {
	c := api(ctx)
	anon := post(c, github, "", "k-1")
	ctx.Equal(anon.Status, 401, "a registration without X-Tenant-Id")
	ftp := post(c, map[string]any{"source_type": "ftp", "token_ref": token}, "acme", "k-2")
	ctx.Equal(ftp.Status, 400, "a registration for source_type ftp (only the sources in registeredHosts have a host the platform registered)")
	ctx.Equal(len(ctx.Redis.Keys("connector:c-*")), 0, "refused registrations must create nothing; the connectors")
}

func CheckRegisteredHost(ctx *harness.Ctx) {
	c := api(ctx)
	for _, url := range []string{"https://169.254.169.254/latest/meta-data", "https://api.github.com.evil.io", "http://api.github.com", "https://evil.io/?next=https://api.github.com"} {
		r := post(c, with(github, "base_url", url), "acme", url)
		ctx.Equal(r.Status, 403, "base_url %s: the sync worker would call a host the platform never registered for github, with the customer's token; the status", url)
	}
	ctx.Equal(len(ctx.Redis.Keys("connector:c-*")), 0, "refused registrations must create nothing; the connectors")
	r := post(c, with(github, "base_url", nil), "acme", "k-none")
	ctx.Assert(r.Status == 201 && strings.Contains(r.Text(), \`"api.github.com"\`), "a registration without base_url must take the registered host, got %d %s", r.Status, r.Text())
}

func CheckTokenRedacted(ctx *harness.Ctx) {
	c := api(ctx)
	first := post(c, github, "acme", "k-1")
	ctx.Equal(first.Status, 201, "POST /v1/connectors (%s)", first.Text())
	replay := post(c, github, "acme", "k-1")
	for _, r := range []*harness.Response{first, replay} {
		ctx.Assert(!strings.Contains(r.Text(), token), "the answer carries the token reference: %s. Answer {connector_id, source_type, host, status}; the reference stays in the registry", r.Text())
	}
	row := store.Get(context.Background(), connectorOf(first))
	ctx.Assert(row != nil && row.TokenRef == token, "the registry must keep the token reference, it holds %+v", row)
}

func CheckIdempotentRegister(ctx *harness.Ctx) {
	c := api(ctx)
	first := post(c, github, "acme", "k-1")
	ctx.Equal(first.Status, 201, "the first registration (%s)", first.Text())
	replay := post(c, github, "acme", "k-1")
	ctx.Equal(replay.Status, 200, "a replay of Idempotency-Key k-1 must answer the connector the first attempt created")
	ctx.Equal(connectorOf(replay), connectorOf(first), "the connector a replay answers")
	ctx.Equal(len(ctx.Redis.Keys("connector:c-*")), 1, "two registrations with one key; the connectors")
	other := post(c, github, "globex", "k-1")
	ctx.Assert(other.Status == 201 && connectorOf(other) != connectorOf(first), "the same key from another tenant is another registration, got %d %s", other.Status, other.Text())
	missing := post(c, github, "acme", "")
	ctx.Equal(missing.Status, 400, "a registration without Idempotency-Key")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <string>

namespace {

const std::string kToken = "vault:acme/github#4";
const nlohmann::json kGithub = {{"source_type", "github"}, {"token_ref", kToken}, {"base_url", "https://api.github.com"}};

harness::HTTP api(harness::Ctx& ctx) {
  static httplib::Server* svr = nullptr;
  delete svr;
  svr = new httplib::Server;
  register_routes(*svr);
  return ctx.HTTP(*svr);
}

harness::Response post(harness::HTTP& c, const nlohmann::json& body, const std::string& tenant, const std::string& key) {
  const std::string text = body.dump();
  if (tenant.empty()) return c.Post("/v1/connectors", text, "Content-Type", "application/json", "Idempotency-Key", key);
  if (key.empty()) return c.Post("/v1/connectors", text, "Content-Type", "application/json", "X-Tenant-Id", tenant);
  return c.Post("/v1/connectors", text, "Content-Type", "application/json", "X-Tenant-Id", tenant, "Idempotency-Key", key);
}

nlohmann::json bodyOf(const harness::Response& r) {
  try {
    return nlohmann::json::parse(r.Text());
  } catch (const std::exception&) {
    return nlohmann::json::object();
  }
}

std::string connectorOf(const harness::Response& r) {
  const auto body = bodyOf(r);
  return body.is_object() ? body.value("connector_id", "") : "";
}

}  // namespace

void CheckRoute(harness::Ctx& ctx) {
  auto c = api(ctx);
  const auto r = post(c, kGithub, "acme", "k-1");
  ctx.Equal(r.Status, 201, "POST /v1/connectors (%s)", r.Text());
  const auto body = bodyOf(r);
  const auto row = store::get(connectorOf(r));
  ctx.Assert(row.has_value(), "the answer %s names no connector the registry holds", r.Text());
  ctx.Assert(row->tenant == "acme" && row->source_type == "github" && row->host == "api.github.com",
             "the registry holds tenant %q, source %q, host %q, expected acme, github, api.github.com", row->tenant, row->source_type, row->host);
  ctx.Assert(body.value("host", "") == "api.github.com" && body.value("status", "") == "enabled", "the answer must carry the host and the status, got %s", r.Text());
}

void CheckTenantAndSource(harness::Ctx& ctx) {
  auto c = api(ctx);
  const auto anon = post(c, kGithub, "", "k-1");
  ctx.Equal(anon.Status, 401, "a registration without X-Tenant-Id");
  const auto ftp = post(c, {{"source_type", "ftp"}, {"token_ref", kToken}}, "acme", "k-2");
  ctx.Equal(ftp.Status, 400, "a registration for source_type ftp (only the sources in kRegisteredHosts have a host the platform registered)");
  ctx.Equal(ctx.Redis.Keys("connector:c-*").size(), 0, "refused registrations must create nothing; the connectors");
}

void CheckRegisteredHost(harness::Ctx& ctx) {
  auto c = api(ctx);
  for (const std::string url : {"https://169.254.169.254/latest/meta-data", "https://api.github.com.evil.io", "http://api.github.com",
                                "https://evil.io/?next=https://api.github.com"}) {
    nlohmann::json body = kGithub;
    body["base_url"] = url;
    const auto r = post(c, body, "acme", url);
    ctx.Equal(r.Status, 403, "base_url %s: the sync worker would call a host the platform never registered for github, with the customer's token; the status", url);
  }
  ctx.Equal(ctx.Redis.Keys("connector:c-*").size(), 0, "refused registrations must create nothing; the connectors");
  const auto r = post(c, {{"source_type", "github"}, {"token_ref", kToken}}, "acme", "k-none");
  ctx.Assert(r.Status == 201 && bodyOf(r).value("host", "") == "api.github.com", "a registration without base_url must take the registered host, got %d %s", r.Status, r.Text());
}

void CheckTokenRedacted(harness::Ctx& ctx) {
  auto c = api(ctx);
  const auto first = post(c, kGithub, "acme", "k-1");
  ctx.Equal(first.Status, 201, "POST /v1/connectors (%s)", first.Text());
  const auto replay = post(c, kGithub, "acme", "k-1");
  for (const auto* r : {&first, &replay}) {
    ctx.Assert(r->Text().find(kToken) == std::string::npos,
               "the answer carries the token reference: %s. Answer {connector_id, source_type, host, status}; the reference stays in the registry", r->Text());
  }
  const auto row = store::get(connectorOf(first));
  ctx.Assert(row && row->token_ref == kToken, "the registry must keep the token reference, it holds %q", row ? row->token_ref : "");
}

void CheckIdempotentRegister(harness::Ctx& ctx) {
  auto c = api(ctx);
  const auto first = post(c, kGithub, "acme", "k-1");
  ctx.Equal(first.Status, 201, "the first registration (%s)", first.Text());
  const auto replay = post(c, kGithub, "acme", "k-1");
  ctx.Equal(replay.Status, 200, "a replay of Idempotency-Key k-1 must answer the connector the first attempt created");
  ctx.Equal(connectorOf(replay), connectorOf(first), "the connector a replay answers");
  ctx.Equal(ctx.Redis.Keys("connector:c-*").size(), 1, "two registrations with one key; the connectors");
  const auto other = post(c, kGithub, "globex", "k-1");
  ctx.Assert(other.Status == 201 && connectorOf(other) != connectorOf(first), "the same key from another tenant is another registration, got %d %s", other.Status, other.Text());
  const auto missing = post(c, kGithub, "acme", "");
  ctx.Equal(missing.Status, 400, "a registration without Idempotency-Key");
}
`,
  },
  hints: [
    'Register a GitHub connector with `base_url` set to the cloud metadata address: it goes through, and the answer shows the token reference. Retry the same request and a second connector appears.',
    'The starter trusts the caller twice: the host comes from their URL instead of the registration the platform holds, and the answer is the registry row itself. Nothing reads the tenant or the key before `store.create` runs.',
    'Check the tenant (401), the key (400) and `REGISTERED_HOSTS[source_type]` (400) first; compare `base_url` scheme and host with it (403); answer `find_by_key` on a replay; else create with the registered host, `remember_key`, and answer the four public fields.',
  ],
  debrief: `Every guard returns before a row exists, and the host check is a string comparison because the only safe validation of a caller's URL is one that never sends a request to it: the connector calls the host the platform registered, so a hostile \`base_url\` buys nothing. The answer is assembled from four fields rather than copied from the row, which keeps the next column someone adds to the registry from leaking too. The idempotency record maps the tenant's key to the connector, so a retry reads the first outcome. Production hubs enforce the same allowlist again at network egress, so one buggy handler cannot open a path, and resolve token references through a broker that hands the worker a short-lived credential.`,
};
