import type {Step} from '@/lib/types';

export const endpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/connectors: register a source without trusting its URLs',
  concept: 'http',
  file: 'api',
  focus: ['client', 'hub', 'db', 'oauth'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it registers the route, parses
the body and returns a connector. It compiles, it serves the demo, and it hides four production
flaws. Review it like the service owner, fix it, and prove the fix with the checks below.

Implement \`POST /v1/connectors\` with body
\`{"source_type": "github", "token_ref": "oauth/acme/github", "base_url": "https://api.github.com"}\`.

- The tenant comes from the authenticated \`X-Tenant-Id\` header; a missing tenant is **401**.
- \`source_type\` is one of \`github\`, \`slack\`, \`stripe\`, \`notion\` (**400** otherwise). The
  allowlist is what keeps a caller from pointing the platform at an arbitrary vendor.
- \`token_ref\` is a non-empty reference to an OAuth token the platform already holds — never the
  token itself — and is at most **512** bytes (**400** otherwise).
- \`base_url\` is optional and, when supplied, **must match the registration the platform already
  holds** for that \`source_type\`: scheme \`https\` and exactly the registered host
  (\`api.github.com\`, \`slack.com\`, \`api.stripe.com\`, \`api.notion.com\`). A URL on another host
  is **403**, and the decision happens **before any request is made** — no probe, no fetch, no
  \`http.Get\`, no \`httplib::Client\` during registration.
- The **token reference never leaves the server**: it is stored on the connector row and never
  appears in the response body or in a log line. The response carries the connector id, source type,
  host and status.
- \`Idempotency-Key\` is required (**400** when missing). A replay with the same \`(tenant, key)\`
  returns the **existing** connector with 200 instead of creating a second one.

**Failure mode the checks target.** Trusting the caller's \`base_url\` turns registration into an
SSRF probe: the draft fetches it "to validate it", so any tenant can make the platform issue an
authenticated request to whatever host it names — the cloud metadata endpoint included. Echoing the
token reference back means it lands in access logs, browser histories and support tickets, where it
outlives the connector. The missing allowlist and the un-keyed registration are the loud ones: an
arbitrary source type and a duplicate connector on every client retry.`,
  sequence: {
    participants: ['Operator', 'Connector Hub', 'connector store', 'registered hosts'],
    messages: [
      {
        from: 'Operator',
        to: 'Connector Hub',
        label: 'POST /v1/connectors · X-Tenant-Id · Idempotency-Key',
        kind: 'sync',
      },
      {
        from: 'Connector Hub',
        to: 'Connector Hub',
        label: 'validate tenant · source allowlist · token_ref',
        kind: 'sync',
      },
      {
        from: 'Connector Hub',
        to: 'registered hosts',
        label: 'registered_host(source_type) · 403 on a foreign host',
        kind: 'sync',
      },
      {from: 'registered hosts', to: 'Connector Hub', label: 'api.github.com / mismatch', kind: 'reply'},
      {from: 'Connector Hub', to: 'connector store', label: 'get(tenant, idem_key)', kind: 'sync'},
      {from: 'connector store', to: 'Connector Hub', label: 'existing connector / none', kind: 'reply'},
      {from: 'Connector Hub', to: 'connector store', label: 'put(tenant, idem_key, connector)', kind: 'async'},
      {
        from: 'Connector Hub',
        to: 'Operator',
        label: '201 {id, source_type, host, status} — no token_ref',
        kind: 'reply',
      },
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Handles POST /v1/connectors',
      detail: 'Register the registration route on `POST /v1/connectors`.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/connectors["']/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/connectors['"]/]},
        go: {all: [/HandleFunc\(\s*"POST \/v1\/connectors"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"connectors"\s*\)/, /\bpost\s*\{/]},
        cpp: {all: [/svr\.Post\(\s*"\/v1\/connectors"/]},
      },
    },
    {
      id: 'source-allowlist',
      title: 'Authenticates the tenant and allowlists the source type',
      detail:
        'The tenant is required — **401** when absent — and `source_type` is checked against the `github`/`slack`/`stripe`/`notion` allowlist. The draft accepts any source type and never requires a tenant.',
      match: {
        python: {all: [/ALLOWED_SOURCES/, /status_code\s*=\s*401/, /status_code\s*=\s*400/]},
        typescript: {all: [/ALLOWED_SOURCES/, /code\(\s*401\s*\)/, /code\(\s*400\s*\)/]},
        go: {all: [/allowedSources/, /StatusUnauthorized/, /StatusBadRequest/]},
        scala: {all: [/AllowedSources/, /StatusCodes\.Unauthorized/, /StatusCodes\.BadRequest/]},
        cpp: {all: [/kAllowedSources/, /\b401\b/, /\b400\b/]},
      },
    },
    {
      id: 'registered-host',
      title: 'Matches the base URL against the registered host, before any fetch',
      detail:
        '`base_url` must be `https` on the host the platform registered for that source type — **403** otherwise — and the check compares strings instead of fetching the URL. The draft probes the caller-supplied URL, which turns registration into an SSRF request from inside your network.',
      match: {
        python: {all: [/REGISTERED_HOSTS/, /status_code\s*=\s*403/], none: [/httpx|requests\.get/]},
        typescript: {all: [/REGISTERED_HOSTS/, /code\(\s*403\s*\)/], none: [/fetch\(|https?\.request\(/]},
        go: {all: [/registeredHosts/, /StatusForbidden/], none: [/http\.Get\(/]},
        scala: {all: [/RegisteredHosts/, /StatusCodes\.Forbidden/], none: [/singleRequest/]},
        cpp: {all: [/kRegisteredHosts/, /\b403\b/], none: [/httplib::Client/]},
      },
    },
    {
      id: 'no-token-leak',
      title: 'Keeps the token reference out of responses and logs',
      detail:
        'The token reference is stored on the connector row and never written to a response body or a log line. The draft echoes it back to the caller and logs it, so every registration ships the reference into sinks that outlive it.',
      match: {
        python: {all: [/token_ref/], none: [/JSONResponse\(\{[^}]*token_ref/, /logger\.\w+\([^)]*token_ref/]},
        typescript: {all: [/token_ref/], none: [/\.send\(\{[^}]*token_ref\s*:/, /log\.\w+\([^)]*token_ref/]},
        go: {all: [/TokenRef/], none: [/writeJSON\([^)]*TokenRef/, /log\.Printf\([^)]*TokenRef/]},
        scala: {
          all: [/token_?[Rr]ef/],
          none: [/complete\([^)]*["']token_?[Rr]ef["']\s*:/, /log\.info\([^)]*token_?[Rr]ef/],
        },
        cpp: {all: [/token_ref/], none: [/\{\s*"token_ref"\s*,/, /cerr[^;]*tokenRef/]},
      },
    },
    {
      id: 'replay-idempotent',
      title: 'Returns the existing connector on a replay',
      detail:
        '`Idempotency-Key` is required and the connector is stored under `(tenant, key)`; a replay returns the connector that already exists instead of creating a second one. The draft ignores the header and inserts unconditionally.',
      match: {
        python: {all: [/Idempotency-Key/, /store\.get\(/, /store\.put\(/]},
        typescript: {all: [/idempotency-key/, /store\.get\(/, /store\.put\(/]},
        go: {all: [/Idempotency-Key/, /store\.Get\(/, /store\.Put\(/]},
        scala: {all: [/Idempotency-Key/, /store\.get\(/, /store\.put\(/]},
        cpp: {all: [/Idempotency-Key/, /store\.get\(/, /store\.put\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import logging
import uuid

import httpx
from fastapi import FastAPI, Header
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()
logger = logging.getLogger("connectord")


class RegisterRequest(BaseModel):
    source_type: str
    token_ref: str
    base_url: str | None = None


class ConnectorStore:
    def get(self, tenant: str, idem_key: str):
        """The connector registered for (tenant, idem_key), if any."""
        raise NotImplementedError

    def put(self, tenant: str, idem_key: str, connector: dict) -> None:
        """Store the connector under (tenant, idem_key)."""
        raise NotImplementedError


store = ConnectorStore()


@app.post("/v1/connectors")
def register(
    body: RegisterRequest,
    tenant: str = Header(alias="X-Tenant-Id"),
    idem_key: str = Header(alias="Idempotency-Key"),
) -> JSONResponse:
    # TODO: this draft accepts any source type, never requires a tenant or an Idempotency-Key,
    # fetches the caller-supplied base_url to "validate" it, and echoes token_ref back. Review all
    # four before this handler ships.
    probe = httpx.get(f"{body.base_url}/user", timeout=2.0)
    logger.info("registered tenant=%s source=%s token=%s", tenant, body.source_type, body.token_ref)
    return JSONResponse(
        {
            "id": str(uuid.uuid4()),
            "source_type": body.source_type,
            "token_ref": body.token_ref,
            "base_url": body.base_url,
            "probe_status": probe.status_code,
        },
        status_code=201,
    )
`,
      solution: `import logging
import uuid
from urllib.parse import urlsplit

from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()
logger = logging.getLogger("connectord")

ALLOWED_SOURCES = {"github", "slack", "stripe", "notion"}
REGISTERED_HOSTS = {
    "github": "api.github.com",
    "slack": "slack.com",
    "stripe": "api.stripe.com",
    "notion": "api.notion.com",
}
MAX_TOKEN_REF_BYTES = 512


class RegisterRequest(BaseModel):
    source_type: str
    token_ref: str
    base_url: str | None = None


class ConnectorStore:
    def get(self, tenant: str, idem_key: str) -> dict | None:
        """The connector registered for (tenant, idem_key), if any."""
        raise NotImplementedError

    def put(self, tenant: str, idem_key: str, connector: dict) -> None:
        """Store the connector under (tenant, idem_key)."""
        raise NotImplementedError


store = ConnectorStore()


def assert_registered_host(source_type: str, base_url: str | None) -> str:
    """The host the platform registered for this source.

    A caller-supplied base_url may only confirm that host — comparing strings is the whole check.
    Fetching the URL to see whether it resolves is the SSRF bug, not the validation.
    """
    expected = REGISTERED_HOSTS[source_type]
    if base_url is None:
        return expected
    parsed = urlsplit(base_url)
    if parsed.scheme != "https" or parsed.hostname != expected:
        raise HTTPException(status_code=403, detail=f"base_url must be https://{expected}")
    return expected


def public_view(connector: dict) -> dict:
    """The connector as the caller sees it: no token reference, ever."""
    return {k: v for k, v in connector.items() if k != "token_ref"}


@app.post("/v1/connectors")
def register(
    body: RegisterRequest,
    tenant: str | None = Header(default=None, alias="X-Tenant-Id"),
    idem_key: str | None = Header(default=None, alias="Idempotency-Key"),
) -> JSONResponse:
    if tenant is None or tenant == "":
        raise HTTPException(status_code=401, detail="missing X-Tenant-Id")
    if idem_key is None or idem_key == "":
        raise HTTPException(status_code=400, detail="Idempotency-Key is required")
    if body.source_type not in ALLOWED_SOURCES:
        raise HTTPException(status_code=400, detail="unknown source_type")
    if body.token_ref == "" or len(body.token_ref.encode("utf-8")) > MAX_TOKEN_REF_BYTES:
        raise HTTPException(status_code=400, detail="token_ref is required (max 512 bytes)")

    host = assert_registered_host(body.source_type, body.base_url)

    existing = store.get(tenant, idem_key)
    if existing is not None:
        return JSONResponse(public_view(existing), status_code=200)

    connector = {
        "id": str(uuid.uuid4()),
        "source_type": body.source_type,
        "host": host,
        "status": "enabled",
        "cursor": None,
    }
    store.put(tenant, idem_key, {**connector, "token_ref": body.token_ref})
    logger.info("registered tenant=%s connector=%s source=%s", tenant, connector["id"], body.source_type)
    return JSONResponse(connector, status_code=201)
`,
    },
    typescript: {
      starter: `/** POST /v1/connectors: a model-generated draft that trusts the caller's URL. */
import {randomUUID} from 'node:crypto';

import Fastify from 'fastify';

export const app = Fastify();

interface RegisterBody {
  source_type: string;
  token_ref: string;
  base_url?: string;
}

app.post('/v1/connectors', async (request, reply) => {
  // TODO: this draft accepts any source type, requires neither a tenant nor an Idempotency-Key,
  // fetches the caller-supplied base_url to "validate" it, and echoes token_ref back. Review all
  // four before this handler ships.
  const tenant = request.headers['x-tenant-id'] as string;
  const body = request.body as RegisterBody;
  const probe = await fetch(\`\${body.base_url}/user\`);
  request.log.info({tenant, source: body.source_type, token_ref: body.token_ref}, 'registered');
  return reply.code(201).send({
    id: randomUUID(),
    source_type: body.source_type,
    token_ref: body.token_ref,
    base_url: body.base_url,
    probe_status: probe.status,
  });
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** POST /v1/connectors: allowlisted, host-pinned, token-safe and idempotent. */
import {randomUUID} from 'node:crypto';

import Fastify from 'fastify';

import {store} from './store';

export const app = Fastify();

const ALLOWED_SOURCES: Record<string, true> = {github: true, slack: true, stripe: true, notion: true};
const REGISTERED_HOSTS: Record<string, string> = {
  github: 'api.github.com',
  slack: 'slack.com',
  stripe: 'api.stripe.com',
  notion: 'api.notion.com',
};
const MAX_TOKEN_REF_BYTES = 512;

interface RegisterBody {
  source_type: string;
  token_ref: string;
  base_url?: string;
}

interface Connector {
  id: string;
  source_type: string;
  host: string;
  status: string;
  cursor: string | null;
  token_ref?: string;
}

/** The registered host for a source; a supplied base_url may only confirm it. No fetch happens here. */
function assertRegisteredHost(sourceType: string, baseUrl?: string): string {
  const expected = REGISTERED_HOSTS[sourceType];
  if (baseUrl === undefined) return expected;
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw Object.assign(new Error(\`base_url must be https://\${expected}\`), {statusCode: 403});
  }
  if (parsed.protocol !== 'https:' || parsed.hostname !== expected)
    throw Object.assign(new Error(\`base_url must be https://\${expected}\`), {statusCode: 403});
  return expected;
}

app.post('/v1/connectors', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing X-Tenant-Id'});
  const idemKey = request.headers['idempotency-key'];
  if (typeof idemKey !== 'string' || idemKey === '')
    return reply.code(400).send({error: 'Idempotency-Key is required'});

  const body = request.body as Partial<RegisterBody> | null;
  if (body === null || typeof body !== 'object' || typeof body.source_type !== 'string')
    return reply.code(400).send({error: 'source_type is required'});
  if (ALLOWED_SOURCES[body.source_type] !== true) return reply.code(400).send({error: 'unknown source_type'});
  if (typeof body.token_ref !== 'string' || body.token_ref === '' || Buffer.byteLength(body.token_ref, 'utf8') > MAX_TOKEN_REF_BYTES)
    return reply.code(400).send({error: 'token_ref is required (max 512 bytes)'});

  let host: string;
  try {
    host = assertRegisteredHost(body.source_type, body.base_url);
  } catch (error) {
    return reply.code(403).send({error: (error as Error).message});
  }

  const existing: Connector | null = await store.get(tenant, idemKey);
  if (existing !== null) {
    const {token_ref: _tokenRef, ...view} = existing;
    return reply.code(200).send(view);
  }

  const connector: Connector = {
    id: randomUUID(),
    source_type: body.source_type,
    host,
    status: 'enabled',
    cursor: null,
  };
  await store.put(tenant, idemKey, {...connector, token_ref: body.token_ref});
  request.log.info({tenant, connector: connector.id, source: body.source_type}, 'registered');
  return reply.code(201).send(connector);
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"log"
	"net/http"

	"github.com/google/uuid"
)

type RegisterRequest struct {
	SourceType string \`json:"source_type"\`
	TokenRef   string \`json:"token_ref"\`
	BaseURL    string \`json:"base_url"\`
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func register(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	var body RegisterRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	// TODO: this draft accepts any source type, requires neither a tenant nor an Idempotency-Key,
	// fetches the caller-supplied base_url to "validate" it, and echoes the token back. Review all
	// four before this handler ships.
	probe, err := http.Get(body.BaseURL + "/user")
	if err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "base_url unreachable"})
		return
	}
	probe.Body.Close()
	log.Printf("registered tenant=%s source=%s token=%s", tenant, body.SourceType, body.TokenRef)
	writeJSON(rw, http.StatusCreated, map[string]any{
		"id":          uuid.NewString(),
		"source_type": body.SourceType,
		"token_ref":   body.TokenRef,
		"base_url":    body.BaseURL,
	})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/connectors", register)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"net/url"

	"github.com/google/uuid"
)

var allowedSources = map[string]bool{"github": true, "slack": true, "stripe": true, "notion": true}

var registeredHosts = map[string]string{
	"github": "api.github.com",
	"slack":  "slack.com",
	"stripe": "api.stripe.com",
	"notion": "api.notion.com",
}

const maxTokenRefBytes = 512

type RegisterRequest struct {
	SourceType string \`json:"source_type"\`
	TokenRef   string \`json:"token_ref"\`
	BaseURL    string \`json:"base_url"\`
}

type ConnectorStore struct{}

func (s *ConnectorStore) Get(ctx context.Context, tenant, idemKey string) (map[string]any, error) {
	return nil, nil
}

func (s *ConnectorStore) Put(ctx context.Context, tenant, idemKey string, connector map[string]any) error {
	return nil
}

var store = &ConnectorStore{}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

// assertRegisteredHost returns the host the platform registered for a source type. A supplied
// base_url may only confirm that host; comparing strings is the whole check, and no request is made.
func assertRegisteredHost(sourceType, baseURL string) (string, bool) {
	expected := registeredHosts[sourceType]
	if baseURL == "" {
		return expected, true
	}
	parsed, err := url.Parse(baseURL)
	if err != nil || parsed.Scheme != "https" || parsed.Hostname() != expected {
		return "", false
	}
	return expected, true
}

func publicView(connector map[string]any) map[string]any {
	view := map[string]any{}
	for key, value := range connector {
		if key != "token_ref" {
			view[key] = value
		}
	}
	return view
}

func register(rw http.ResponseWriter, r *http.Request) {
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
	var body RegisterRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	if !allowedSources[body.SourceType] {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "unknown source_type"})
		return
	}
	if body.TokenRef == "" || len([]byte(body.TokenRef)) > maxTokenRefBytes {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "token_ref is required (max 512 bytes)"})
		return
	}
	host, ok := assertRegisteredHost(body.SourceType, body.BaseURL)
	if !ok {
		writeJSON(rw, http.StatusForbidden, map[string]string{"error": "base_url is not the registered host"})
		return
	}
	existing, err := store.Get(r.Context(), tenant, idemKey)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	if existing != nil {
		writeJSON(rw, http.StatusOK, publicView(existing))
		return
	}
	connector := map[string]any{
		"id":          uuid.NewString(),
		"source_type": body.SourceType,
		"host":        host,
		"status":      "enabled",
	}
	row := map[string]any{}
	for key, value := range connector {
		row[key] = value
	}
	row["token_ref"] = body.TokenRef
	if err := store.Put(r.Context(), tenant, idemKey, row); err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	log.Printf("registered tenant=%s connector=%s source=%s", tenant, connector["id"], body.SourceType)
	writeJSON(rw, http.StatusCreated, connector)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/connectors", register)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
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

final case class RegisterRequest(source_type: String, token_ref: String, base_url: Option[String])

object ConnectorApi {
  implicit val system: ActorSystem = ActorSystem("connector-hub")
  implicit val registerFormat: RootJsonFormat[RegisterRequest] = jsonFormat3(RegisterRequest)

  val route: Route =
    path("v1" / "connectors") {
      post {
        headerValueByName("X-Tenant-Id") { tenant =>
          entity(as[RegisterRequest]) { body =>
            // TODO: this draft accepts any source type, requires neither a tenant nor an
            // Idempotency-Key, fetches the caller-supplied base_url to "validate" it, and echoes
            // tokenRef back. Review all four before this handler ships.
            val probe = Http().singleRequest(HttpRequest(uri = body.base_url.getOrElse("") + "/user"))
            system.log.info(s"registered tenant=$tenant source=\${body.source_type} token=\${body.token_ref}")
            complete(StatusCodes.Created, s"""{"token_ref":"\${body.token_ref}","probe":"$probe"}""")
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
import java.net.URI

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class RegisterRequest(source_type: String, token_ref: String, base_url: Option[String])
final case class Connector(id: String, source_type: String, host: String, status: String, cursor: Option[String])

object ConnectorApi {
  implicit val system: ActorSystem = ActorSystem("connector-hub")
  implicit val registerFormat: RootJsonFormat[RegisterRequest] = jsonFormat3(RegisterRequest)
  implicit val connectorFormat: RootJsonFormat[Connector] = jsonFormat5(Connector)

  val AllowedSources = Set("github", "slack", "stripe", "notion")
  val RegisteredHosts = Map(
    "github" -> "api.github.com",
    "slack" -> "slack.com",
    "stripe" -> "api.stripe.com",
    "notion" -> "api.notion.com"
  )
  val MaxTokenRefBytes = 512

  val store = ConnectorStore.open()

  /** The registered host for a source; a supplied base_url may only confirm it. Nothing is fetched. */
  def assertRegisteredHost(sourceType: String, baseUrl: Option[String]): Either[String, String] = {
    val expected = RegisteredHosts(sourceType)
    baseUrl match {
      case None => Right(expected)
      case Some(raw) =>
        val uri = URI.create(raw)
        if (uri.getScheme == "https" && uri.getHost == expected) Right(expected) else Left(expected)
    }
  }

  def publicView(connector: Connector): String =
    s"""{"id":"\${connector.id}","source_type":"\${connector.source_type}","host":"\${connector.host}","status":"\${connector.status}"}"""

  val route: Route =
    path("v1" / "connectors") {
      post {
        optionalHeaderValueByName("X-Tenant-Id") { tenantOpt =>
          optionalHeaderValueByName("Idempotency-Key") { idemOpt =>
            entity(as[RegisterRequest]) { body =>
              if (!tenantOpt.exists(_.nonEmpty)) {
                complete(StatusCodes.Unauthorized, """{"error":"missing X-Tenant-Id"}""")
              } else if (!idemOpt.exists(_.nonEmpty)) {
                complete(StatusCodes.BadRequest, """{"error":"Idempotency-Key is required"}""")
              } else if (!AllowedSources.contains(body.source_type)) {
                complete(StatusCodes.BadRequest, """{"error":"unknown source_type"}""")
              } else if (body.token_ref.isEmpty || body.token_ref.getBytes("UTF-8").length > MaxTokenRefBytes) {
                complete(StatusCodes.BadRequest, """{"error":"token_ref is required (max 512 bytes)"}""")
              } else {
                assertRegisteredHost(body.source_type, body.base_url) match {
                  case Left(expected) =>
                    complete(StatusCodes.Forbidden, s"""{"error":"base_url must be https://$expected"}""")
                  case Right(host) =>
                    val tenant = tenantOpt.get
                    val idemKey = idemOpt.get
                    store.get(tenant, idemKey) match {
                      case Some(existing) =>
                        complete(StatusCodes.OK, publicView(existing))
                      case None =>
                        val connector =
                          Connector(UUID.randomUUID().toString, body.source_type, host, "enabled", None)
                        store.put(tenant, idemKey, connector, body.token_ref)
                        system.log.info(
                          s"registered tenant=$tenant connector=\${connector.id} source=\${body.source_type}"
                        )
                        complete(StatusCodes.Created, publicView(connector))
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

#include <iostream>
#include <string>

using json = nlohmann::json;

struct RegisterRequest {
  std::string source_type;
  std::string token_ref;
  std::string base_url;
};

std::string uuidString();

int main() {
  httplib::Server svr;

  svr.Post("/v1/connectors", [](const httplib::Request& req, httplib::Response& res) {
    const auto tenant = req.get_header_value("X-Tenant-Id");
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) {
      res.status = 400;
      res.set_content(R"({"error":"invalid json"})", "application/json");
      return;
    }
    // TODO: this draft accepts any source type, requires neither a tenant nor an Idempotency-Key,
    // fetches the caller-supplied base_url to "validate" it, and echoes the token back. Review all
    // four before this handler ships.
    const auto baseUrl = body.value("base_url", std::string());
    const auto tokenRef = body.value("token_ref", std::string());
    httplib::Client probe(baseUrl);
    const auto result = probe.Get("/user");
    std::cerr << "registered tenant=" << tenant << " source=" << body.value("source_type", std::string())
              << " token=" << tokenRef << "\\n";
    res.status = 201;
    res.set_content(
        json{{"id", uuidString()}, {"source_type", body.value("source_type", std::string())}, {"token_ref", tokenRef},
             {"reachable", result != nullptr}}
            .dump(),
        "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <iostream>
#include <map>
#include <set>
#include <string>

using json = nlohmann::json;

const std::set<std::string> kAllowedSources = {"github", "slack", "stripe", "notion"};
const std::map<std::string, std::string> kRegisteredHosts = {
    {"github", "api.github.com"},
    {"slack", "slack.com"},
    {"stripe", "api.stripe.com"},
    {"notion", "api.notion.com"},
};
constexpr std::size_t kMaxTokenRefBytes = 512;

struct ConnectorStore {
  std::optional<json> get(const std::string& tenant, const std::string& idemKey);
  void put(const std::string& tenant, const std::string& idemKey, const json& connector);
};

ConnectorStore store;
std::string uuidString();
std::string hostOf(const std::string& url);

/** The registered host for a source: a supplied base_url only confirms it, and nothing is fetched. */
bool assertRegisteredHost(const std::string& sourceType, const std::string& baseUrl, std::string& host) {
  host = kRegisteredHosts.at(sourceType);
  if (baseUrl.empty()) return true;
  if (baseUrl.rfind("https://", 0) != 0) return false;
  return hostOf(baseUrl) == host;
}

/** The connector as the caller sees it: the token reference stays on the server. */
json publicView(const json& connector) {
  json view = connector;
  view.erase("token_ref");
  return view;
}

int main() {
  httplib::Server svr;

  svr.Post("/v1/connectors", [](const httplib::Request& req, httplib::Response& res) {
    const auto tenant = req.get_header_value("X-Tenant-Id");
    if (tenant.empty()) {
      res.status = 401;
      res.set_content(R"({"error":"missing X-Tenant-Id"})", "application/json");
      return;
    }
    const auto idemKey = req.get_header_value("Idempotency-Key");
    if (idemKey.empty()) {
      res.status = 400;
      res.set_content(R"({"error":"Idempotency-Key is required"})", "application/json");
      return;
    }
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object() || !body.contains("source_type") || !body["source_type"].is_string()) {
      res.status = 400;
      res.set_content(R"({"error":"source_type is required"})", "application/json");
      return;
    }
    const auto sourceType = body["source_type"].get<std::string>();
    if (kAllowedSources.count(sourceType) == 0) {
      res.status = 400;
      res.set_content(R"({"error":"unknown source_type"})", "application/json");
      return;
    }
    const auto tokenRef = body.value("token_ref", std::string());
    if (tokenRef.empty() || tokenRef.size() > kMaxTokenRefBytes) {
      res.status = 400;
      res.set_content(R"({"error":"token_ref is required (max 512 bytes)"})", "application/json");
      return;
    }
    std::string host;
    if (!assertRegisteredHost(sourceType, body.value("base_url", std::string()), host)) {
      res.status = 403;
      res.set_content(R"({"error":"base_url is not the registered host"})", "application/json");
      return;
    }
    const auto existing = store.get(tenant, idemKey);
    if (existing) {
      res.status = 200;
      res.set_content(publicView(*existing).dump(), "application/json");
      return;
    }
    const json connector = {
        {"id", uuidString()},
        {"source_type", sourceType},
        {"host", host},
        {"status", "enabled"},
    };
    json row = connector;
    row["token_ref"] = tokenRef;
    store.put(tenant, idemKey, row);
    std::cerr << "registered tenant=" << tenant << " connector=" << connector["id"] << "\\n";
    res.status = 201;
    res.set_content(connector.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  hints: [
    'Write the guard clauses in cost order: tenant, Idempotency-Key, source allowlist, token_ref shape, then the host check. Every one of them returns before any work, and the host check never needs a socket — `urlsplit(url).hostname` against `REGISTERED_HOSTS[source_type]` is the whole comparison.',
    'The replay lookup is keyed by `(tenant, Idempotency-Key)` and happens before the connector is created; a hit returns the stored connector with 200. Storing the connector — not the request hash — is what lets a replay answer without re-validating or re-creating anything.',
    'The response is a view, not the row: build the connector from ids and status, and filter `token_ref` out of anything you return or log. Log the tenant, the connector id and the source; a token reference in a log line is a credential leak with a retention policy attached.',
  ],
  debrief: `The interviewer is testing whether you can review a generated handler at the trust boundary. The draft reads fine because the demo posts a well-formed body with the vendor's canonical URL from one tenant and never retries. Four separate defects are being checked: authentication and the source allowlist (the caller names a source the platform supports, not an arbitrary one), URL validation that compares against a held registration instead of fetching the caller's URL, token hygiene (a reference that never appears in a response or a log), and idempotency keyed by tenant so a retry cannot create a second connector. The SSRF probe is the one interviewers press on: "validate this URL for me" is a request your service makes with its own network position, so the only safe validation is the one that needs no request at all. Real hubs add per-tenant registrations with operator approval, signed webhook secrets, egress allowlists at the network layer, and a token broker that never hands the raw token to the connector process.`,
};
