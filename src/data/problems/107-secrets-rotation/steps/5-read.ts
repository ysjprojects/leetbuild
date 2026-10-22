import type {Step} from '@/lib/types';

export const readStep: Step = {
  id: 'read',
  title: 'GET /v1/secrets/{name}/versions: metadata only, always',
  concept: 'http',
  file: 'read',
  focus: ['ops', 'api', 'db', 'redis'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft of the versions read: it
resolves the name, lists the versions and answers 200. It compiles, it serves the console, and it
hides three production flaws — an \`include_material\` flag that returns plaintext to admin callers,
consumer acceptance that only the secret owner may see, and no scope check at all. Review it like
the service owner, fix it, and prove the fix with the checks below.

Implement \`GET /v1/secrets/{name}/versions\`.

- The caller comes from the authenticated \`X-Operator-Id\` header (**401** when missing) and the
  token's grants come from \`X-Scopes\`; a caller without the **\`secrets\`** scope is **403**. Every
  read of a secret's lifecycle requires that scope — there is no operator-only path.
- The query string is parsed against an **allowlist**: \`limit\`, \`state\`, \`cursor\`. Anything else
  is **400**, so no flag can ever be added later that surfaces more than metadata — in particular
  there is no material flag, under any name, for any role.
- \`limit\` is an integer from **1** to **200** (default **50**) and \`state\` is one of \`pending\`,
  \`active\`, \`retired\`, \`revoked\` — **400** otherwise. The response is
  \`{"name": …, "versions": [...], "next_cursor": …}\`.
- Every version entry is built by one projection — \`version_view\` — carrying \`version_id\`,
  \`fingerprint\`, \`state\`, the activation window (\`activated_at\`, \`retired_at\`),
  \`rotation_seconds\`, the acceptance counts (\`acceptance.verified\` / \`acceptance.pending\`) and
  the per-consumer list (\`consumers\`: id and whether that consumer verified the version).
- Consumer acceptance is **operator-visible**: any caller holding the \`secrets\` scope sees which
  consumers still lag behind, because the engineer retiring a version is rarely the secret's owner.

**Failure mode the checks target.** An \`include_material\` parameter looks harmless — the flag
"only returns material to admins" — but it makes the vault a read path, so every future caller with
an admin role can exfiltrate plaintext through a GET, and it lands in proxy logs and browser caches.
Gating consumer acceptance on ownership hides exactly the data retirement needs: the owner may be on
holiday while a fleet is stuck on the old version. And a lifecycle read with no scope check lets any
authenticated principal enumerate every secret's versions, fingerprints and windows.`,
  sequence: {
    participants: ['Ops console', 'Secrets API', 'secret store', 'Redis'],
    messages: [
      {from: 'Ops console', to: 'Secrets API', label: 'GET /v1/secrets/{name}/versions · X-Scopes', kind: 'sync'},
      {from: 'Secrets API', to: 'Secrets API', label: 'operator · secrets scope · query allowlist', kind: 'sync'},
      {from: 'Secrets API', to: 'secret store', label: 'versions(name, state, limit)', kind: 'sync'},
      {from: 'secret store', to: 'Secrets API', label: 'versions · windows · consumers', kind: 'reply'},
      {from: 'Secrets API', to: 'Redis', label: 'GET secret:{name}:active · :overlap', kind: 'sync'},
      {from: 'Secrets API', to: 'Ops console', label: '200 {versions[{acceptance, consumers}]}', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'read-route',
      title: 'Registers GET /v1/secrets/{name}/versions',
      detail: 'The versions read exists on `GET /v1/secrets/{name}/versions`; every other check builds on it.',
      match: {
        python: {all: [/@app\.get\(\s*["']\/v1\/secrets\/\{name\}\/versions["']/]},
        typescript: {all: [/app\.get\(\s*['"]\/v1\/secrets\/:name\/versions['"]/]},
        go: {all: [/HandleFunc\(\s*"GET \/v1\/secrets\/\{name\}\/versions"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"secrets"\s*\/\s*Segment\s*\/\s*"versions"\s*\)/, /\bget\s*\{/]},
        cpp: {all: [/svr\.Get\(/, /\/v1\/secrets\//]},
      },
    },
    {
      id: 'scope-required',
      title: 'The secrets scope is required to read a lifecycle',
      detail:
        'The caller is authenticated (**401** without `X-Operator-Id`) and the token must grant the `secrets` scope (**403** otherwise). The draft checks no scope, so any authenticated principal can enumerate versions, fingerprints and windows.',
      match: {
        python: {all: [/SECRETS_SCOPE/, /X-Scopes/, /status_code\s*=\s*403/, /status_code\s*=\s*401/]},
        typescript: {all: [/SECRETS_SCOPE/, /x-scopes/, /code\(\s*403\s*\)/, /code\(\s*401\s*\)/]},
        go: {all: [/secretsScope/, /X-Scopes/, /StatusForbidden/, /StatusUnauthorized/]},
        scala: {all: [/SecretsScope/, /X-Scopes/, /StatusCodes\.Forbidden/, /StatusCodes\.Unauthorized/]},
        cpp: {all: [/kSecretsScope/, /X-Scopes/, /\b403\b/, /\b401\b/]},
      },
    },
    {
      id: 'no-material-flag',
      title: 'No parameter can surface material',
      detail:
        'Query parameters are validated against an allowlist (`limit`, `state`, `cursor`) and anything else is **400**, and every entry is built by the `version_view` projection. The draft accepts `include_material` and returns the material to admin callers, turning the vault into a read path.',
      match: {
        python: {all: [/ALLOWED_QUERY/, /def version_view\(/, /status_code\s*=\s*400/], none: [/include_material/]},
        typescript: {
          all: [/ALLOWED_QUERY/, /function versionView\(/, /code\(\s*400\s*\)/],
          none: [/include_material/],
        },
        go: {all: [/allowedQuery/, /func versionView\(/, /StatusBadRequest/], none: [/include_material/]},
        scala: {all: [/AllowedQuery/, /def versionView\(/, /StatusCodes\.BadRequest/], none: [/include_material/]},
        cpp: {all: [/kAllowedQuery/, /versionView\(/, /\b400\b/], none: [/include_material/]},
      },
    },
    {
      id: 'activation-window',
      title: 'Every entry carries its activation window',
      detail:
        'A version entry reports `activated_at`, `retired_at` and `rotation_seconds` beside `version_id` and `fingerprint`, so an operator can see which versions were live when and which are overdue. The draft returns an unprojected record with neither window nor policy.',
      match: {
        python: {all: [/def version_view\(/, /activated_at/, /retired_at/, /rotation_seconds/]},
        typescript: {all: [/function versionView\(/, /activated_at/, /retired_at/, /rotation_seconds/]},
        go: {all: [/func versionView\(/, /activated_at/, /retired_at/, /rotation_seconds/]},
        scala: {all: [/def versionView\(/, /activated_at/, /retired_at/, /rotation_seconds/]},
        cpp: {all: [/versionView\(/, /activated_at/, /retired_at/, /rotation_seconds/]},
      },
    },
    {
      id: 'consumer-acceptance',
      title: 'Consumer acceptance is operator-visible',
      detail:
        'The projection carries `acceptance` counts and the per-consumer `consumers` list for every caller holding the scope — not only for the secret owner. The draft shows lagging consumers to the owner alone, hiding exactly what retirement needs.',
      match: {
        python: {all: [/acceptance/, /consumers/], none: [/operator == owner/]},
        typescript: {all: [/acceptance/, /consumers/], none: [/operator === owner/]},
        go: {all: [/acceptance/, /consumers/], none: [/operator == owner/]},
        scala: {all: [/acceptance/, /consumers/], none: [/operator == owner/]},
        cpp: {all: [/acceptance/, /consumers/], none: [/operatorId == owner/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import logging

from fastapi import FastAPI, Header, Request
from fastapi.responses import JSONResponse

app = FastAPI()
logger = logging.getLogger("secrets")


class VersionStore:
    def list_versions(self, name: str) -> list[dict]:
        raise NotImplementedError

    def read_material(self, name: str, version_id: str) -> str:
        raise NotImplementedError

    def consumers(self, name: str, version_id: str) -> list[dict]:
        raise NotImplementedError

    def owner_of(self, name: str) -> str:
        raise NotImplementedError


store = VersionStore()


@app.get("/v1/secrets/{name}/versions")
def list_versions(
    name: str,
    request: Request,
    operator: str = Header(default="", alias="X-Operator-Id"),
) -> JSONResponse:
    # TODO: this draft accepts an include_material flag, returns the material to admin callers, and
    # shows lagging consumers to the secret owner only. Review all three.
    owner = store.owner_of(name)
    entries = []
    for version in store.list_versions(name):
        entry = dict(version)
        if request.query_params.get("include_material") == "true" and operator == owner:
            entry["material"] = store.read_material(name, version["version_id"])
        if operator == owner:
            entry["consumers"] = store.consumers(name, version["version_id"])
        entries.append(entry)
    logger.info("versions.read operator=%s name=%s count=%d", operator, name, len(entries))
    return JSONResponse({"name": name, "versions": entries, "next_cursor": None}, status_code=200)
`,
      solution: `import logging

from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.responses import JSONResponse

app = FastAPI()
logger = logging.getLogger("secrets")

SECRETS_SCOPE = "secrets"
MAX_PAGE = 200
DEFAULT_PAGE = 50
ALLOWED_QUERY = {"limit", "state", "cursor"}
VERSION_STATES = {"pending", "active", "retired", "revoked"}


class VersionStore:
    def list_versions(self, name: str, state: str | None, limit: int) -> list[dict]:
        raise NotImplementedError

    def consumers(self, name: str, version_id: str) -> list[dict]:
        raise NotImplementedError


store = VersionStore()


def scopes_of(header: str | None) -> set[str]:
    """A space- or comma-separated grant list, as an OAuth access token carries it."""
    return {scope.strip() for scope in (header or "").replace(",", " ").split() if scope.strip()}


def version_view(version: dict, consumers: list[dict]) -> dict:
    """The only shape a version may leave this endpoint in: metadata, never material."""
    verified = [c for c in consumers if c["verified"]]
    return {
        "version_id": version["version_id"],
        "fingerprint": version["fingerprint"],
        "state": version["state"],
        "activated_at": version["activated_at"],
        "retired_at": version["retired_at"],
        "rotation_seconds": version["rotation_seconds"],
        "acceptance": {"verified": len(verified), "pending": len(consumers) - len(verified)},
        "consumers": [{"id": c["id"], "verified": c["verified"]} for c in consumers],
    }


@app.get("/v1/secrets/{name}/versions")
def list_versions(
    name: str,
    request: Request,
    operator: str | None = Header(default=None, alias="X-Operator-Id"),
    scopes: str | None = Header(default=None, alias="X-Scopes"),
) -> JSONResponse:
    if operator is None or operator == "":
        raise HTTPException(status_code=401, detail="missing X-Operator-Id")
    if SECRETS_SCOPE not in scopes_of(scopes):
        raise HTTPException(status_code=403, detail="secrets scope required")
    unknown = [key for key in request.query_params.keys() if key not in ALLOWED_QUERY]
    if unknown:
        raise HTTPException(status_code=400, detail=f"unknown query parameter: {sorted(unknown)[0]}")
    state = request.query_params.get("state")
    if state is not None and state not in VERSION_STATES:
        raise HTTPException(status_code=400, detail="state must be pending|active|retired|revoked")
    raw_limit = request.query_params.get("limit", str(DEFAULT_PAGE))
    if not raw_limit.isdigit() or not 1 <= int(raw_limit) <= MAX_PAGE:
        raise HTTPException(status_code=400, detail="limit must be 1..200")

    versions = store.list_versions(name, state, int(raw_limit))
    views = [version_view(version, store.consumers(name, version["version_id"])) for version in versions]
    logger.info("versions.read operator=%s name=%s state=%s count=%d", operator, name, state, len(views))
    return JSONResponse({"name": name, "versions": views, "next_cursor": None}, status_code=200)
`,
    },
    typescript: {
      starter: `/** GET /v1/secrets/:name/versions: a model-generated draft with a material flag. */
import Fastify from 'fastify';

import {store} from './secret_store';

export const app = Fastify();

app.get('/v1/secrets/:name/versions', async (request, reply) => {
  const operator = request.headers['x-operator-id'];
  const {name} = request.params as {name: string};
  const query = request.query as Record<string, string | undefined>;
  // TODO: this draft accepts an include_material flag, returns the material to admin callers, and
  // shows lagging consumers to the secret owner only. Review all three.
  const owner = await store.ownerOf(name);
  const versions = await store.listVersions(name);
  const entries: Record<string, unknown>[] = [];
  for (const version of versions) {
    const entry: Record<string, unknown> = {...version};
    if (query.include_material === 'true' && operator === owner)
      entry.material = await store.readMaterial(name, version.version_id);
    if (operator === owner) entry.consumers = store.consumers(name, version.version_id);
    entries.push(entry);
  }
  request.log.info({operator, name, count: entries.length}, 'versions.read');
  return reply.code(200).send({name, versions: entries, next_cursor: null});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** GET /v1/secrets/:name/versions: metadata only, for any caller holding the secrets scope. */
import Fastify from 'fastify';

import {store} from './secret_store';

export const app = Fastify();

const SECRETS_SCOPE = 'secrets';
const MAX_PAGE = 200;
const DEFAULT_PAGE = 50;
const ALLOWED_QUERY: Record<string, true> = {limit: true, state: true, cursor: true};
const VERSION_STATES = new Set(['pending', 'active', 'retired', 'revoked']);

interface VersionRow {
  version_id: string;
  fingerprint: string;
  state: string;
  activated_at: number | null;
  retired_at: number | null;
  rotation_seconds: number;
}

interface ConsumerRow {
  id: string;
  verified: boolean;
}

function versionView(version: VersionRow, consumers: ConsumerRow[]): Record<string, unknown> {
  const verified = consumers.filter(c => c.verified).length;
  return {
    version_id: version.version_id,
    fingerprint: version.fingerprint,
    state: version.state,
    activated_at: version.activated_at,
    retired_at: version.retired_at,
    rotation_seconds: version.rotation_seconds,
    acceptance: {verified, pending: consumers.length - verified},
    consumers: consumers.map(c => ({id: c.id, verified: c.verified})),
  };
}

app.get('/v1/secrets/:name/versions', async (request, reply) => {
  const operator = request.headers['x-operator-id'];
  if (typeof operator !== 'string' || operator === '')
    return reply.code(401).send({error: 'missing X-Operator-Id'});
  const scopes = request.headers['x-scopes'];
  const granted = new Set((typeof scopes === 'string' ? scopes : '').split(/[\\s,]+/).filter(Boolean));
  if (!granted.has(SECRETS_SCOPE)) return reply.code(403).send({error: 'secrets scope required'});

  const {name} = request.params as {name: string};
  const query = (request.query ?? {}) as Record<string, string | undefined>;
  const unknown = Object.keys(query).filter(key => ALLOWED_QUERY[key] !== true);
  if (unknown.length > 0) return reply.code(400).send({error: \`unknown query parameter: \${unknown[0]}\`});
  const state = query.state;
  if (state !== undefined && !VERSION_STATES.has(state))
    return reply.code(400).send({error: 'state must be pending|active|retired|revoked'});
  const limit = query.limit === undefined ? DEFAULT_PAGE : Number(query.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE)
    return reply.code(400).send({error: 'limit must be 1..200'});

  const versions = (await store.listVersions(name, state ?? null, limit)) as VersionRow[];
  const views = versions.map(version => versionView(version, store.consumers(name, version.version_id)));
  request.log.info({operator, name, state, count: views.length}, 'versions.read');
  return reply.code(200).send({name, versions: views, next_cursor: null});
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
)

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func listVersions(rw http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	operator := r.Header.Get("X-Operator-Id")
	// TODO: this draft accepts an include_material flag, returns the material to admin callers, and
	// shows lagging consumers to the secret owner only. Review all three.
	owner := store.OwnerOf(r.Context(), name)
	versions, err := store.ListVersions(r.Context(), name)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	entries := make([]map[string]any, 0, len(versions))
	for _, version := range versions {
		entry := map[string]any{"version_id": version.VersionID, "fingerprint": version.Fingerprint}
		if r.URL.Query().Get("include_material") == "true" && operator == owner {
			entry["material"] = store.ReadMaterial(r.Context(), name, version.VersionID)
		}
		if operator == owner {
			entry["consumers"] = store.Consumers(r.Context(), name, version.VersionID)
		}
		entries = append(entries, entry)
	}
	log.Printf("versions.read operator=%s name=%s count=%d", operator, name, len(entries))
	writeJSON(rw, http.StatusOK, map[string]any{"name": name, "versions": entries, "next_cursor": nil})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/secrets/{name}/versions", listVersions)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
      solution: `package main

import (
	"encoding/json"
	"log"
	"net/http"
	"strconv"
	"strings"
)

const (
	secretsScope = "secrets"
	maxPage      = 200
	defaultPage  = 50
)

var allowedQuery = map[string]bool{"limit": true, "state": true, "cursor": true}
var versionStates = map[string]bool{"pending": true, "active": true, "retired": true, "revoked": true}

type VersionRow struct {
	VersionID       string \`json:"version_id"\`
	Fingerprint     string \`json:"fingerprint"\`
	State           string \`json:"state"\`
	ActivatedAt     *int64 \`json:"activated_at"\`
	RetiredAt       *int64 \`json:"retired_at"\`
	RotationSeconds int    \`json:"rotation_seconds"\`
}

type ConsumerRow struct {
	ID       string \`json:"id"\`
	Verified bool   \`json:"verified"\`
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

// scopesOf parses a space- or comma-separated grant list, as an OAuth access token carries it.
func scopesOf(header string) map[string]bool {
	granted := map[string]bool{}
	for _, scope := range strings.FieldsFunc(header, func(r rune) bool { return r == ' ' || r == ',' }) {
		granted[scope] = true
	}
	return granted
}

// versionView is the only shape a version may leave this endpoint in: metadata, never material.
func versionView(version VersionRow, consumers []ConsumerRow) map[string]any {
	verified := 0
	for _, consumer := range consumers {
		if consumer.Verified {
			verified++
		}
	}
	return map[string]any{
		"version_id":       version.VersionID,
		"fingerprint":      version.Fingerprint,
		"state":            version.State,
		"activated_at":     version.ActivatedAt,
		"retired_at":       version.RetiredAt,
		"rotation_seconds": version.RotationSeconds,
		"acceptance":       map[string]int{"verified": verified, "pending": len(consumers) - verified},
		"consumers":        consumers,
	}
}

func listVersions(rw http.ResponseWriter, r *http.Request) {
	operator := r.Header.Get("X-Operator-Id")
	if operator == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-Operator-Id"})
		return
	}
	if !scopesOf(r.Header.Get("X-Scopes"))[secretsScope] {
		writeJSON(rw, http.StatusForbidden, map[string]string{"error": "secrets scope required"})
		return
	}
	name := r.PathValue("name")
	query := r.URL.Query()
	for key := range query {
		if !allowedQuery[key] {
			writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "unknown query parameter: " + key})
			return
		}
	}
	state := query.Get("state")
	if state != "" && !versionStates[state] {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "state must be pending|active|retired|revoked"})
		return
	}
	limit := defaultPage
	if raw := query.Get("limit"); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed < 1 || parsed > maxPage {
			writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "limit must be 1..200"})
			return
		}
		limit = parsed
	}

	versions, err := store.ListVersions(r.Context(), name, state, limit)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	views := make([]map[string]any, 0, len(versions))
	for _, version := range versions {
		views = append(views, versionView(version, store.Consumers(r.Context(), name, version.VersionID)))
	}
	log.Printf("versions.read operator=%s name=%s state=%s count=%d", operator, name, state, len(views))
	writeJSON(rw, http.StatusOK, map[string]any{"name": name, "versions": views, "next_cursor": nil})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/secrets/{name}/versions", listVersions)
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

object SecretReadApi {
  implicit val system: ActorSystem = ActorSystem("secrets-api")

  val store = SecretStore.open()

  val route: Route =
    path("v1" / "secrets" / Segment / "versions") { name =>
      get {
        optionalHeaderValueByName("X-Operator-Id") { operatorOpt =>
          parameterMap { params =>
            // TODO: this draft accepts an include_material flag, returns the material to admin
            // callers, and shows lagging consumers to the secret owner only. Review all three.
            val operator = operatorOpt.getOrElse("")
            val owner = store.ownerOf(name)
            val entries = store.listVersions(name).map { version =>
              var entry = Map("version_id" -> version.versionId, "fingerprint" -> version.fingerprint)
              if (params.get("include_material").contains("true") && operator == owner) {
                entry = entry + ("material" -> store.readMaterial(name, version.versionId))
              }
              if (operator == owner) {
                entry = entry + ("consumers" -> store.consumers(name, version.versionId))
              }
              entry
            }
            system.log.info(s"versions.read operator=$operator name=$name count=\${entries.length}")
            complete(StatusCodes.OK, entries.toString)
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
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json.DefaultJsonProtocol._
import spray.json.JsValue
import spray.json.RootJsonFormat
import spray.json._ 

final case class VersionRow(
    version_id: String,
    fingerprint: String,
    state: String,
    activated_at: Option[Long],
    retired_at: Option[Long],
    rotation_seconds: Int,
)
final case class ConsumerRow(id: String, verified: Boolean)
final case class VersionsPage(name: String, versions: List[JsValue], next_cursor: Option[String])

object SecretReadApi {
  implicit val system: ActorSystem = ActorSystem("secrets-api")
  implicit val pageFormat: RootJsonFormat[VersionsPage] = jsonFormat3(VersionsPage)

  val SecretsScope = "secrets"
  val MaxPage = 200
  val DefaultPage = 50
  val AllowedQuery = Set("limit", "state", "cursor")
  val VersionStates = Set("pending", "active", "retired", "revoked")

  val store = SecretStore.open()

  // A space- or comma-separated grant list, as an OAuth access token carries it.
  def scopesOf(header: Option[String]): Set[String] =
    header.getOrElse("").split("[\\\\s,]+").filter(_.nonEmpty).toSet

  // The only shape a version may leave this endpoint in: metadata, never material.
  def versionView(version: VersionRow, consumers: List[ConsumerRow]): JsValue = {
    val verified = consumers.count(_.verified)
    JsObject(
      "version_id" -> JsString(version.version_id),
      "fingerprint" -> JsString(version.fingerprint),
      "state" -> JsString(version.state),
      "activated_at" -> version.activated_at.map(JsNumber(_)).getOrElse(JsNull),
      "retired_at" -> version.retired_at.map(JsNumber(_)).getOrElse(JsNull),
      "rotation_seconds" -> JsNumber(version.rotation_seconds),
      "acceptance" -> JsObject(
        "verified" -> JsNumber(verified),
        "pending" -> JsNumber(consumers.length - verified),
      ),
      "consumers" -> JsArray(
        consumers.map(c => JsObject("id" -> JsString(c.id), "verified" -> JsBoolean(c.verified))).toVector,
      ),
    )
  }

  val route: Route =
    path("v1" / "secrets" / Segment / "versions") { name =>
      get {
        optionalHeaderValueByName("X-Operator-Id") { operatorOpt =>
          optionalHeaderValueByName("X-Scopes") { scopesOpt =>
            parameterMap { params =>
              if (!operatorOpt.exists(_.nonEmpty)) {
                complete(StatusCodes.Unauthorized, """{"error":"missing X-Operator-Id"}""")
              } else if (!scopesOf(scopesOpt).contains(SecretsScope)) {
                complete(StatusCodes.Forbidden, """{"error":"secrets scope required"}""")
              } else if (params.keys.exists(key => !AllowedQuery.contains(key))) {
                complete(StatusCodes.BadRequest, """{"error":"unknown query parameter"}""")
              } else if (params.get("state").exists(state => !VersionStates.contains(state))) {
                complete(StatusCodes.BadRequest, """{"error":"state must be pending|active|retired|revoked"}""")
              } else {
                val limit = params.get("limit").map(_.toInt).getOrElse(DefaultPage)
                if (limit < 1 || limit > MaxPage) {
                  complete(StatusCodes.BadRequest, """{"error":"limit must be 1..200"}""")
                } else {
                  val operator = operatorOpt.get
                  val state = params.get("state")
                  val views = store.listVersions(name, state, limit).map { version =>
                    versionView(version, store.consumers(name, version.version_id))
                  }
                  system.log.info(
                    s"versions.read operator=$operator name=$name state=\${state.getOrElse("")} count=\${views.length}",
                  )
                  complete(StatusCodes.OK, VersionsPage(name, views, None))
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

struct SecretStore {
  std::string ownerOf(const std::string& name);
  std::vector<json> listVersions(const std::string& name);
  std::string readMaterial(const std::string& name, const std::string& versionId);
  json consumers(const std::string& name, const std::string& versionId);
};

SecretStore store;

int main() {
  httplib::Server svr;

  svr.Get(R"(/v1/secrets/([a-z0-9_-]+)/versions)", [](const httplib::Request& req, httplib::Response& res) {
    const auto name = req.matches[1].str();
    const auto operatorId = req.get_header_value("X-Operator-Id");
    // TODO: this draft accepts an include_material flag, returns the material to admin callers, and
    // shows lagging consumers to the secret owner only. Review all three.
    const auto owner = store.ownerOf(name);
    json entries = json::array();
    for (const auto& version : store.listVersions(name)) {
      json entry = {{"version_id", version["version_id"]}, {"fingerprint", version["fingerprint"]}};
      if (req.has_param("include_material") && req.get_param_value("include_material") == "true" &&
          operatorId == owner) {
        entry["material"] = store.readMaterial(name, version["version_id"]);
      }
      if (operatorId == owner) entry["consumers"] = store.consumers(name, version["version_id"]);
      entries.push_back(entry);
    }
    std::cerr << "versions.read operator=" << operatorId << " name=" << name << " count=" << entries.size() << "\\n";
    res.status = 200;
    res.set_content(json{{"name", name}, {"versions", entries}, {"next_cursor", nullptr}}.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <iostream>
#include <set>
#include <string>
#include <vector>

using json = nlohmann::json;

const std::string kSecretsScope = "secrets";
constexpr int kMaxPage = 200;
constexpr int kDefaultPage = 50;
const std::set<std::string> kAllowedQuery = {"limit", "state", "cursor"};
const std::set<std::string> kVersionStates = {"pending", "active", "retired", "revoked"};

struct VersionRow {
  std::string versionId;
  std::string fingerprint;
  std::string state;
  long activatedAt;
  long retiredAt;
  int rotationSeconds;
};

struct SecretStore {
  std::vector<VersionRow> listVersions(const std::string& name, const std::string& state, int limit);
  json consumers(const std::string& name, const std::string& versionId);
};

SecretStore store;

// A space- or comma-separated grant list, as an OAuth access token carries it.
std::set<std::string> scopesOf(const std::string& header);

// The only shape a version may leave this endpoint in: metadata, never material.
json versionView(const VersionRow& version, const json& consumers) {
  int verified = 0;
  for (const auto& consumer : consumers) {
    if (consumer.value("verified", false)) verified++;
  }
  return {
      {"version_id", version.versionId},
      {"fingerprint", version.fingerprint},
      {"state", version.state},
      {"activated_at", version.activatedAt},
      {"retired_at", version.retiredAt},
      {"rotation_seconds", version.rotationSeconds},
      {"acceptance", {{"verified", verified}, {"pending", static_cast<int>(consumers.size()) - verified}}},
      {"consumers", consumers},
  };
}

int main() {
  httplib::Server svr;

  svr.Get(R"(/v1/secrets/([a-z0-9_-]+)/versions)", [](const httplib::Request& req, httplib::Response& res) {
    const auto operatorId = req.get_header_value("X-Operator-Id");
    if (operatorId.empty()) {
      res.status = 401;
      res.set_content(R"({"error":"missing X-Operator-Id"})", "application/json");
      return;
    }
    if (scopesOf(req.get_header_value("X-Scopes")).count(kSecretsScope) == 0) {
      res.status = 403;
      res.set_content(R"({"error":"secrets scope required"})", "application/json");
      return;
    }
    for (const auto& [key, value] : req.params) {
      if (kAllowedQuery.count(key) == 0) {
        res.status = 400;
        res.set_content(R"({"error":"unknown query parameter"})", "application/json");
        return;
      }
    }
    const auto state = req.get_param_value("state");
    if (!state.empty() && kVersionStates.count(state) == 0) {
      res.status = 400;
      res.set_content(R"({"error":"state must be pending|active|retired|revoked"})", "application/json");
      return;
    }
    int limit = kDefaultPage;
    if (req.has_param("limit")) {
      const auto raw = req.get_param_value("limit");
      limit = std::atoi(raw.c_str());
      if (limit < 1 || limit > kMaxPage) {
        res.status = 400;
        res.set_content(R"({"error":"limit must be 1..200"})", "application/json");
        return;
      }
    }

    const auto name = req.matches[1].str();
    json views = json::array();
    for (const auto& version : store.listVersions(name, state, limit)) {
      views.push_back(versionView(version, store.consumers(name, version.versionId)));
    }
    std::cerr << "versions.read operator=" << operatorId << " name=" << name << " state=" << state
              << " count=" << views.size() << "\\n";
    res.status = 200;
    res.set_content(json{{"name", name}, {"versions", views}, {"next_cursor", nullptr}}.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  hints: [
    'Parse the query string against an allowlist before you touch the store: `for key in query: if key not in ALLOWED_QUERY: 400`. A closed parameter set is what makes "no flag can ever surface material" provable — an unknown parameter is rejected, so nobody can add one later without changing the allowlist in review.',
    'Give the response one projection function (`version_view`) and build every entry through it. Then the material can only appear if someone edits that function, which is the single place a reviewer has to read.',
    'Consumer acceptance is an operational signal, not a private one: the caller retiring the version needs to see which consumers have not verified it, and that caller is usually not the owner. Gate on the `secrets` scope, never on ownership.',
  ],
  debrief: `The interviewer is testing the read side of a secret store, where the temptation is to make one endpoint serve everyone. Three defects are being checked. The \`include_material\` flag is the classic: it is described as an admin convenience, and it converts a vault into a read path whose plaintext lands in proxy logs, browser caches and incident screenshots; the fix is not a stricter role check but a closed parameter set and one projection that cannot carry material. The ownership gate on consumer acceptance is subtler — the data is not sensitive, so it is easy to justify, but it hides exactly the signal retirement depends on, from exactly the people who do the retiring. The missing scope check is the smallest diff and the biggest exposure: version ids, fingerprints and activation windows are enough to map an org's whole secret inventory. Real secret stores add per-secret audit trails, cursor-based pagination that cannot skip a version, and a "who read this" report for every access to a lifecycle.`,
};
