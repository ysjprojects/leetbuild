import type {Step} from '@/lib/types';

export const readStep: Step = {
  id: 'read',
  title: 'GET /v1/secrets/{name}/versions: metadata, health and acceptance',
  concept: 'http',
  file: 'read',
  focus: ['ops', 'api', 'vault'],
  task: `## Task

**Starting point.** The starter serves \`GET /v1/secrets/{name}/versions\` for the ops console: 401
without \`X-Operator-Id\`, 404 for an unknown secret, then the vault's versions newest first (up to
\`limit\`) with ids, fingerprint, times and a \`health\`; the owner also gets each version's consumer
acceptance, and the material when asking \`include_material=true\`. It serves the console and hides
four flaws.

**Failure mode the checks target.** The read side of a vault becomes a way out: any authenticated
caller lists every secret's versions, a flag returns plaintext into proxy logs, the console calls
an hourly secret healthy for a month, and the engineer on call, who is rarely the owner, cannot see
which consumer blocks a retirement.

- \`X-Scopes\` (space or comma separated) without **\`secrets\`**: **403**.
- The query is checked against \`ALLOWED_QUERY\` (\`limit\` only): anything else is **400**; \`limit\`
  is 1 to \`MAX_LIMIT\` (200), default 50, **400** otherwise.
- Every entry is \`version_view(...)\`: \`version_id\`, \`fingerprint\`, \`rotation_seconds\`,
  \`created_at\`, \`rotate_at\`, \`activated_at\`, \`retired_at\`, \`health\` and
  \`acceptance: {verified, pending}\`, for every caller holding the scope.
- \`health_of\` is \`retired\` once retired, \`overdue\` from the version's own \`rotate_at\`, else \`ok\`.`,
  sequence: {
    participants: ['Ops console', 'secretd', 'secretd.vault'],
    messages: [
      {
        from: 'Ops console',
        to: 'secretd',
        label: 'GET /v1/secrets/{name}/versions?limit=20 · X-Scopes: secrets',
        kind: 'sync',
      },
      {from: 'secretd', to: 'secretd', label: 'scope → 403 · ALLOWED_QUERY → 400', kind: 'sync'},
      {from: 'secretd', to: 'secretd.vault', label: 'versions · consumers · accepted(version)', kind: 'sync'},
      {from: 'secretd.vault', to: 'secretd', label: 'records (material stays here)', kind: 'reply'},
      {from: 'secretd', to: 'Ops console', label: '200 {name, versions: [version_view]}', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'read-route',
      title: 'Registers GET /v1/secrets/{name}/versions',
      detail:
        'The read answers the versions newest first (up to `limit`) for a caller with the scope, **401** without `X-Operator-Id` and **404** for an unknown secret.',
      match: {
        python: {all: [/@app\.get\(\s*["']\/v1\/secrets\/\{name\}\/versions["']/, /\b401\b/, /\b404\b/]},
        typescript: {all: [/app\.get\(\s*['"]\/v1\/secrets\/:name\/versions['"]/, /\b401\b/, /\b404\b/]},
        go: {all: [/HandleFunc\(\s*"GET \/v1\/secrets\/\{name\}\/versions"/, /StatusUnauthorized/, /StatusNotFound/]},
        scala: {all: [/"secrets"\s*\/\s*Segment\s*\/\s*"versions"/, /Unauthorized/, /NotFound/]},
        cpp: {all: [/svr\.Get\(\s*R"\(\/v1\/secrets\//, /\b401\b/, /\b404\b/]},
      },
    },
    {
      id: 'scope-required',
      title: 'The secrets scope is required',
      detail:
        'The caller must hold the `secrets` scope in `X-Scopes` (**403** otherwise): version ids, fingerprints and rotation windows map a whole secret inventory, and the starter checks no scope at all.',
      match: {
        python: {all: [/x-scopes/i, /\b403\b/]},
        typescript: {all: [/x-scopes/i, /code\(\s*403\s*\)/]},
        go: {all: [/X-Scopes/i, /StatusForbidden/]},
        scala: {all: [/X-Scopes/i, /Forbidden/]},
        cpp: {all: [/X-Scopes/i, /\b403\b/]},
      },
    },
    {
      id: 'closed-query',
      title: 'No parameter can surface material',
      detail:
        "The query is validated against `ALLOWED_QUERY` and `limit` against `MAX_LIMIT` (**400** otherwise), and no entry reads the version's material; the starter honours `include_material` for the owner.",
      match: {
        python: {all: [/ALLOWED_QUERY/, /MAX_LIMIT\s*=\s*200\b/], none: [/include_material/, /\[["']material["']\]/]},
        typescript: {all: [/ALLOWED_QUERY/, /MAX_LIMIT\s*=\s*200\b/], none: [/include_material/, /\.material\b/]},
        go: {all: [/allowedQuery/, /maxLimit\s*=\s*200\b/], none: [/include_material/, /\.Material\b/]},
        scala: {all: [/AllowedQuery/, /MaxLimit\s*=\s*200\b/], none: [/include_material/, /\.material\b/]},
        cpp: {all: [/kAllowedQuery/, /kMaxLimit\s*=\s*200\b/], none: [/include_material/, /\.material\b/]},
      },
    },
    {
      id: 'health-interval',
      title: "Health follows the version's own interval",
      detail:
        "`health_of`/`healthOf` compares the clock with the version's `rotate_at`; the starter measures every version against the 30-day default, so an hourly secret looks healthy for a month.",
      match: {
        python: {
          all: [/def health_of\(/, /now\s*>=\s*version\[["']rotate_at["']\]/],
          none: [/DEFAULT_ROTATION_SECONDS/],
        },
        typescript: {all: [/function healthOf\(/, /now\s*>=\s*version\.rotate_at/], none: [/DEFAULT_ROTATION_SECONDS/]},
        go: {all: [/func healthOf\(/, /now\s*>=\s*version\.RotateAt/], none: [/defaultRotationSeconds/]},
        scala: {all: [/def healthOf\(/, /now\s*>=\s*version\.rotateAt/], none: [/DefaultRotationSeconds/]},
        cpp: {all: [/healthOf\(/, /now\s*>=\s*version\.rotate_at/], none: [/kDefaultRotationSeconds/]},
      },
    },
    {
      id: 'acceptance-visible',
      title: 'Consumer acceptance is visible to every operator with the scope',
      detail:
        'Every entry comes from `version_view`/`versionView` and carries `acceptance` (verified and pending consumers) whoever asks; the starter shows it to the owner alone.',
      match: {
        python: {all: [/def version_view\(/, /["']acceptance["']/], none: [/operator\s*==\s*owner/]},
        typescript: {all: [/function versionView\(/, /acceptance/], none: [/operator\s*===\s*owner/]},
        go: {all: [/func versionView\(/, /"acceptance"/], none: [/operator\s*==\s*owner/]},
        scala: {all: [/def versionView\(/, /"acceptance"/], none: [/operator\s*==\s*owner/]},
        cpp: {all: [/versionView\(/, /"acceptance"/], none: [/operator_id\s*==\s*owner/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import time

from fastapi import FastAPI, HTTPException, Request

from secretd import vault  # owner_of, versions, consumers, accepted

app = FastAPI()

DEFAULT_ROTATION_SECONDS = 2_592_000  # the console's 30-day policy


def health_of(version: dict, now: int) -> str:
    if version["retired_at"] is not None:
        return "retired"
    return "overdue" if now >= version["created_at"] + DEFAULT_ROTATION_SECONDS else "ok"


def acceptance(name: str, version: dict, consumers: list[str]) -> dict:
    verified = vault.accepted(name, version["version_id"])
    return {"verified": verified, "pending": [c for c in consumers if c not in verified]}


@app.get("/v1/secrets/{name}/versions")
def list_versions(name: str, request: Request) -> dict:
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    operator = request.headers.get("x-operator-id", "")
    if not operator:
        raise HTTPException(status_code=401, detail="X-Operator-Id is required")
    owner = vault.owner_of(name)
    if owner is None:
        raise HTTPException(status_code=404, detail="no such secret")
    limit = int(request.query_params.get("limit", "50"))
    include_material = request.query_params.get("include_material") == "true" and operator == owner
    now = int(time.time())
    consumers = vault.consumers(name)
    entries = []
    for version in list(reversed(vault.versions(name)))[:limit]:
        entry = {
            field: version[field]
            for field in ("version_id", "fingerprint", "rotation_seconds", "created_at", "rotate_at", "activated_at", "retired_at")
        }
        entry["health"] = health_of(version, now)
        if include_material:
            entry["material"] = version["material"]
        if operator == owner:
            entry["acceptance"] = acceptance(name, version, consumers)
        entries.append(entry)
    return {"name": name, "versions": entries}
`,
      solution: `import time

from fastapi import FastAPI, HTTPException, Request

from secretd import vault  # owner_of, versions, consumers, accepted

app = FastAPI()

ALLOWED_QUERY = {"limit"}
DEFAULT_LIMIT = 50
MAX_LIMIT = 200
VIEW_FIELDS = ("version_id", "fingerprint", "rotation_seconds", "created_at", "rotate_at", "activated_at", "retired_at")


def health_of(version: dict, now: int) -> str:
    """Against the version's own interval: retired once retired, overdue from rotate_at, ok before."""
    if version["retired_at"] is not None:
        return "retired"
    return "overdue" if now >= version["rotate_at"] else "ok"


def acceptance(name: str, version: dict, consumers: list[str]) -> dict:
    verified = vault.accepted(name, version["version_id"])
    return {"verified": verified, "pending": [c for c in consumers if c not in verified]}


def version_view(name: str, version: dict, consumers: list[str], now: int) -> dict:
    """The one shape a version leaves the service in: metadata, health and acceptance."""
    view = {field: version[field] for field in VIEW_FIELDS}
    view["health"] = health_of(version, now)
    view["acceptance"] = acceptance(name, version, consumers)
    return view


@app.get("/v1/secrets/{name}/versions")
def list_versions(name: str, request: Request) -> dict:
    operator = request.headers.get("x-operator-id", "")
    if not operator:
        raise HTTPException(status_code=401, detail="X-Operator-Id is required")
    if "secrets" not in request.headers.get("x-scopes", "").replace(",", " ").split():
        raise HTTPException(status_code=403, detail="the secrets scope is required")
    unknown = sorted(set(request.query_params) - ALLOWED_QUERY)
    if unknown:
        raise HTTPException(status_code=400, detail=f"unknown query parameter: {', '.join(unknown)}")
    raw_limit = request.query_params.get("limit", str(DEFAULT_LIMIT))
    if not raw_limit.isdigit() or not 1 <= int(raw_limit) <= MAX_LIMIT:
        raise HTTPException(status_code=400, detail=f"limit is 1..{MAX_LIMIT}")
    if vault.owner_of(name) is None:
        raise HTTPException(status_code=404, detail="no such secret")
    now = int(time.time())
    consumers = vault.consumers(name)
    versions = list(reversed(vault.versions(name)))[: int(raw_limit)]
    return {"name": name, "versions": [version_view(name, version, consumers, now) for version in versions]}
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';

import * as vault from 'secretd/vault';

export const app = Fastify();

export const DEFAULT_ROTATION_SECONDS = 2_592_000; // the console's 30-day policy

export function healthOf(version: vault.Version, now: number): string {
  if (version.retired_at !== null) return 'retired';
  return now >= version.created_at + DEFAULT_ROTATION_SECONDS ? 'overdue' : 'ok';
}

async function acceptance(name: string, version: vault.Version, consumers: string[]) {
  const verified = await vault.accepted(name, version.version_id);
  return {verified, pending: consumers.filter(c => !verified.includes(c))};
}

app.get('/v1/secrets/:name/versions', async (request, reply) => {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const {name} = request.params as {name: string};
  const query = request.query as Record<string, string>;
  const operator = request.headers['x-operator-id'];
  if (typeof operator !== 'string' || operator === '') return reply.code(401).send({error: 'X-Operator-Id is required'});
  const owner = await vault.ownerOf(name);
  if (owner === null) return reply.code(404).send({error: 'no such secret'});
  const limit = Number(query.limit ?? 50);
  const includeMaterial = query.include_material === 'true' && operator === owner;
  const now = Math.floor(Date.now() / 1000);
  const consumers = await vault.consumers(name);
  const entries: Record<string, unknown>[] = [];
  for (const version of (await vault.versions(name)).reverse().slice(0, limit)) {
    const {version_id, fingerprint, rotation_seconds, created_at, rotate_at, activated_at, retired_at} = version;
    const entry: Record<string, unknown> = {version_id, fingerprint, rotation_seconds, created_at, rotate_at, activated_at, retired_at, health: healthOf(version, now)};
    if (includeMaterial) entry.material = version.material;
    if (operator === owner) entry.acceptance = await acceptance(name, version, consumers);
    entries.push(entry);
  }
  return {name, versions: entries};
});
`,
      solution: `import Fastify from 'fastify';

import * as vault from 'secretd/vault';

export const app = Fastify();

export const ALLOWED_QUERY = ['limit'];
export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;

/** Against the version's own interval: retired once retired, overdue from rotate_at, ok before. */
export function healthOf(version: vault.Version, now: number): string {
  if (version.retired_at !== null) return 'retired';
  return now >= version.rotate_at ? 'overdue' : 'ok';
}

async function acceptance(name: string, version: vault.Version, consumers: string[]) {
  const verified = await vault.accepted(name, version.version_id);
  return {verified, pending: consumers.filter(c => !verified.includes(c))};
}

/** The one shape a version leaves the service in: metadata, health and acceptance. */
export async function versionView(name: string, version: vault.Version, consumers: string[], now: number) {
  const {version_id, fingerprint, rotation_seconds, created_at, rotate_at, activated_at, retired_at} = version;
  return {
    version_id,
    fingerprint,
    rotation_seconds,
    created_at,
    rotate_at,
    activated_at,
    retired_at,
    health: healthOf(version, now),
    acceptance: await acceptance(name, version, consumers),
  };
}

app.get('/v1/secrets/:name/versions', async (request, reply) => {
  const {name} = request.params as {name: string};
  const query = request.query as Record<string, string>;
  const operator = request.headers['x-operator-id'];
  if (typeof operator !== 'string' || operator === '') return reply.code(401).send({error: 'X-Operator-Id is required'});
  const scopes = String(request.headers['x-scopes'] ?? '').split(/[\\s,]+/);
  if (!scopes.includes('secrets')) return reply.code(403).send({error: 'the secrets scope is required'});
  const unknown = Object.keys(query).filter(key => !ALLOWED_QUERY.includes(key));
  if (unknown.length > 0) return reply.code(400).send({error: \`unknown query parameter: \${unknown.join(', ')}\`});
  const limit = Number(query.limit ?? DEFAULT_LIMIT);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) return reply.code(400).send({error: \`limit is 1..\${MAX_LIMIT}\`});
  if ((await vault.ownerOf(name)) === null) return reply.code(404).send({error: 'no such secret'});
  const now = Math.floor(Date.now() / 1000);
  const consumers = await vault.consumers(name);
  const versions = (await vault.versions(name)).reverse().slice(0, limit);
  const views: Record<string, unknown>[] = [];
  for (const version of versions) views.push(await versionView(name, version, consumers, now));
  return {name, versions: views};
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"net/http"
	"strconv"
	"time"

	"secretd/vault" // vault.OwnerOf, Versions, Consumers, Accepted
)

const defaultRotationSeconds = 2_592_000 // the console's 30-day policy

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func healthOf(version vault.Version, now int64) string {
	if version.RetiredAt != 0 {
		return "retired"
	}
	if now >= version.CreatedAt+defaultRotationSeconds {
		return "overdue"
	}
	return "ok"
}

func unsetAsNull(t int64) any {
	if t == 0 {
		return nil
	}
	return t
}

func acceptance(r *http.Request, name string, version vault.Version, consumers []string) map[string]any {
	verified := vault.Accepted(r.Context(), name, version.VersionID)
	pending := []string{}
	for _, c := range consumers {
		found := false
		for _, v := range verified {
			found = found || v == c
		}
		if !found {
			pending = append(pending, c)
		}
	}
	return map[string]any{"verified": verified, "pending": pending}
}

func listVersions(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	name := r.PathValue("name")
	operator := r.Header.Get("X-Operator-Id")
	if operator == "" {
		http.Error(rw, "X-Operator-Id is required", http.StatusUnauthorized)
		return
	}
	owner := vault.OwnerOf(r.Context(), name)
	if owner == "" {
		http.Error(rw, "no such secret", http.StatusNotFound)
		return
	}
	query := r.URL.Query()
	limit := 50
	if raw := query.Get("limit"); raw != "" {
		limit, _ = strconv.Atoi(raw)
	}
	includeMaterial := query.Get("include_material") == "true" && operator == owner
	now := time.Now().Unix()
	consumers := vault.Consumers(r.Context(), name)
	versions := vault.Versions(r.Context(), name)
	entries := []map[string]any{}
	for i := len(versions) - 1; i >= 0 && len(entries) < limit; i-- {
		version := versions[i]
		entry := map[string]any{
			"version_id": version.VersionID, "fingerprint": version.Fingerprint, "rotation_seconds": version.RotationSeconds,
			"created_at": version.CreatedAt, "rotate_at": version.RotateAt, "activated_at": unsetAsNull(version.ActivatedAt),
			"retired_at": unsetAsNull(version.RetiredAt), "health": healthOf(version, now),
		}
		if includeMaterial {
			entry["material"] = version.Material
		}
		if operator == owner {
			entry["acceptance"] = acceptance(r, name, version, consumers)
		}
		entries = append(entries, entry)
	}
	writeJSON(rw, http.StatusOK, map[string]any{"name": name, "versions": entries})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/secrets/{name}/versions", listVersions)
}
`,
      solution: `package main

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"time"

	"secretd/vault" // vault.OwnerOf, Versions, Consumers, Accepted
)

const (
	defaultLimit = 50
	maxLimit     = 200
)

var allowedQuery = map[string]bool{"limit": true}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

// healthOf is against the version's own interval: retired once retired, overdue from rotate_at, ok before.
func healthOf(version vault.Version, now int64) string {
	if version.RetiredAt != 0 {
		return "retired"
	}
	if now >= version.RotateAt {
		return "overdue"
	}
	return "ok"
}

func unsetAsNull(t int64) any {
	if t == 0 {
		return nil
	}
	return t
}

func acceptance(r *http.Request, name string, version vault.Version, consumers []string) map[string]any {
	verified := vault.Accepted(r.Context(), name, version.VersionID)
	pending := []string{}
	for _, c := range consumers {
		found := false
		for _, v := range verified {
			found = found || v == c
		}
		if !found {
			pending = append(pending, c)
		}
	}
	return map[string]any{"verified": verified, "pending": pending}
}

// versionView is the one shape a version leaves the service in: metadata, health and acceptance.
func versionView(r *http.Request, name string, version vault.Version, consumers []string, now int64) map[string]any {
	return map[string]any{
		"version_id": version.VersionID, "fingerprint": version.Fingerprint, "rotation_seconds": version.RotationSeconds,
		"created_at": version.CreatedAt, "rotate_at": version.RotateAt, "activated_at": unsetAsNull(version.ActivatedAt),
		"retired_at": unsetAsNull(version.RetiredAt), "health": healthOf(version, now),
		"acceptance": acceptance(r, name, version, consumers),
	}
}

func hasScope(header, scope string) bool {
	for _, s := range strings.FieldsFunc(header, func(c rune) bool { return c == ' ' || c == ',' }) {
		if s == scope {
			return true
		}
	}
	return false
}

func listVersions(rw http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	if r.Header.Get("X-Operator-Id") == "" {
		http.Error(rw, "X-Operator-Id is required", http.StatusUnauthorized)
		return
	}
	if !hasScope(r.Header.Get("X-Scopes"), "secrets") {
		http.Error(rw, "the secrets scope is required", http.StatusForbidden)
		return
	}
	query := r.URL.Query()
	for key := range query {
		if !allowedQuery[key] {
			http.Error(rw, "unknown query parameter: "+key, http.StatusBadRequest)
			return
		}
	}
	limit := defaultLimit
	if raw := query.Get("limit"); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil || n < 1 || n > maxLimit {
			http.Error(rw, "limit is 1..200", http.StatusBadRequest)
			return
		}
		limit = n
	}
	if vault.OwnerOf(r.Context(), name) == "" {
		http.Error(rw, "no such secret", http.StatusNotFound)
		return
	}
	now := time.Now().Unix()
	consumers := vault.Consumers(r.Context(), name)
	versions := vault.Versions(r.Context(), name)
	views := []map[string]any{}
	for i := len(versions) - 1; i >= 0 && len(views) < limit; i-- {
		views = append(views, versionView(r, name, versions[i], consumers, now))
	}
	writeJSON(rw, http.StatusOK, map[string]any{"name": name, "versions": views})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/secrets/{name}/versions", listVersions)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._
import spray.json.DefaultJsonProtocol._

import secretd.Vault // Vault.ownerOf, versions, consumers, accepted

object Read {
  val DefaultRotationSeconds = 2592000L // the console's 30-day policy

  def healthOf(version: Vault.Version, now: Long): String =
    if (version.retiredAt.isDefined) "retired"
    else if (now >= version.createdAt + DefaultRotationSeconds) "overdue"
    else "ok"

  private def time(t: Option[Long]): JsValue = t.map(JsNumber(_)).getOrElse(JsNull)

  private def acceptance(name: String, version: Vault.Version, consumers: Seq[String]): JsObject = {
    val verified = Vault.accepted(name, version.versionId)
    JsObject("verified" -> verified.toJson, "pending" -> consumers.filterNot(verified.contains).toJson)
  }

  val route: Route = path("v1" / "secrets" / Segment / "versions") { name =>
    get {
      optionalHeaderValueByName("X-Operator-Id") {
        case None | Some("") => complete(StatusCodes.Unauthorized -> "X-Operator-Id is required")
        case Some(operator) =>
          parameterMap { query =>
            // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
            Vault.ownerOf(name) match {
              case None => complete(StatusCodes.NotFound -> "no such secret")
              case Some(owner) =>
                val limit = query.get("limit").map(_.toInt).getOrElse(50)
                val includeMaterial = query.get("include_material").contains("true") && operator == owner
                val now = System.currentTimeMillis() / 1000
                val consumers = Vault.consumers(name)
                val entries = Vault.versions(name).reverse.take(limit).map { version =>
                  val base = Map[String, JsValue](
                    "version_id" -> JsString(version.versionId),
                    "fingerprint" -> JsString(version.fingerprint),
                    "rotation_seconds" -> JsNumber(version.rotationSeconds),
                    "created_at" -> JsNumber(version.createdAt),
                    "rotate_at" -> JsNumber(version.rotateAt),
                    "activated_at" -> time(version.activatedAt),
                    "retired_at" -> time(version.retiredAt),
                    "health" -> JsString(healthOf(version, now)))
                  val withMaterial = if (includeMaterial) base + ("material" -> JsString(version.material)) else base
                  JsObject(if (operator == owner) withMaterial + ("acceptance" -> acceptance(name, version, consumers)) else withMaterial)
                }
                val body = JsObject("name" -> JsString(name), "versions" -> JsArray(entries.toVector))
                complete(HttpResponse(StatusCodes.OK, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint)))
            }
          }
      }
    }
  }
}
`,
      solution: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._
import spray.json.DefaultJsonProtocol._

import secretd.Vault // Vault.ownerOf, versions, consumers, accepted

object Read {
  val AllowedQuery: Set[String] = Set("limit")
  val DefaultLimit = 50
  val MaxLimit = 200

  /** Against the version's own interval: retired once retired, overdue from rotate_at, ok before. */
  def healthOf(version: Vault.Version, now: Long): String =
    if (version.retiredAt.isDefined) "retired"
    else if (now >= version.rotateAt) "overdue"
    else "ok"

  private def time(t: Option[Long]): JsValue = t.map(JsNumber(_)).getOrElse(JsNull)

  private def acceptance(name: String, version: Vault.Version, consumers: Seq[String]): JsObject = {
    val verified = Vault.accepted(name, version.versionId)
    JsObject("verified" -> verified.toJson, "pending" -> consumers.filterNot(verified.contains).toJson)
  }

  /** The one shape a version leaves the service in: metadata, health and acceptance. */
  def versionView(name: String, version: Vault.Version, consumers: Seq[String], now: Long): JsObject = JsObject(
    "version_id" -> JsString(version.versionId),
    "fingerprint" -> JsString(version.fingerprint),
    "rotation_seconds" -> JsNumber(version.rotationSeconds),
    "created_at" -> JsNumber(version.createdAt),
    "rotate_at" -> JsNumber(version.rotateAt),
    "activated_at" -> time(version.activatedAt),
    "retired_at" -> time(version.retiredAt),
    "health" -> JsString(healthOf(version, now)),
    "acceptance" -> acceptance(name, version, consumers))

  val route: Route = path("v1" / "secrets" / Segment / "versions") { name =>
    get {
      optionalHeaderValueByName("X-Operator-Id") {
        case None | Some("") => complete(StatusCodes.Unauthorized -> "X-Operator-Id is required")
        case Some(_) =>
          optionalHeaderValueByName("X-Scopes") { scopes =>
            parameterMap { query =>
              val limit = query.get("limit").map(raw => raw.toIntOption.getOrElse(0)).getOrElse(DefaultLimit)
              if (!scopes.getOrElse("").split("[\\\\s,]+").contains("secrets")) complete(StatusCodes.Forbidden -> "the secrets scope is required")
              else if (!query.keySet.subsetOf(AllowedQuery)) complete(StatusCodes.BadRequest -> "unknown query parameter")
              else if (limit < 1 || limit > MaxLimit) complete(StatusCodes.BadRequest -> s"limit is 1..$MaxLimit")
              else if (Vault.ownerOf(name).isEmpty) complete(StatusCodes.NotFound -> "no such secret")
              else {
                val now = System.currentTimeMillis() / 1000
                val consumers = Vault.consumers(name)
                val views = Vault.versions(name).reverse.take(limit).map(versionView(name, _, consumers, now))
                val body = JsObject("name" -> JsString(name), "versions" -> JsArray(views.toVector))
                complete(HttpResponse(StatusCodes.OK, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint)))
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

#include <algorithm>
#include <string>
#include <vector>

#include "secretd/vault.h"  // vault::ownerOf, versions, consumers, accepted, nowSeconds

using json = nlohmann::json;

constexpr long long kDefaultRotationSeconds = 2592000;  // the console's 30-day policy

std::string healthOf(const vault::Version& version, long long now) {
  if (version.retired_at != 0) return "retired";
  return now >= version.created_at + kDefaultRotationSeconds ? "overdue" : "ok";
}

json unsetAsNull(long long t) { return t ? json(t) : json(nullptr); }

json acceptance(const std::string& name, const vault::Version& version, const std::vector<std::string>& consumers) {
  const std::vector<std::string> verified = vault::accepted(name, version.version_id);
  std::vector<std::string> pending;
  for (const auto& c : consumers) {
    if (std::find(verified.begin(), verified.end(), c) == verified.end()) pending.push_back(c);
  }
  return json{{"verified", verified}, {"pending", pending}};
}

void list_versions(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const std::string name = req.matches[1];
  const std::string operator_id = req.get_header_value("X-Operator-Id");
  if (operator_id.empty()) {
    res.status = 401;
    res.set_content("X-Operator-Id is required", "text/plain");
    return;
  }
  const std::string owner = vault::ownerOf(name);
  if (owner.empty()) {
    res.status = 404;
    res.set_content("no such secret", "text/plain");
    return;
  }
  const size_t limit = req.has_param("limit") ? std::stoul(req.get_param_value("limit")) : 50;
  const bool include_material = req.get_param_value("include_material") == "true" && operator_id == owner;
  const long long now = vault::nowSeconds();
  const std::vector<std::string> consumers = vault::consumers(name);
  std::vector<vault::Version> versions = vault::versions(name);
  std::reverse(versions.begin(), versions.end());
  json entries = json::array();
  for (const vault::Version& version : versions) {
    if (entries.size() >= limit) break;
    json entry = {{"version_id", version.version_id},      {"fingerprint", version.fingerprint},
                  {"rotation_seconds", version.rotation_seconds}, {"created_at", version.created_at},
                  {"rotate_at", version.rotate_at},          {"activated_at", unsetAsNull(version.activated_at)},
                  {"retired_at", unsetAsNull(version.retired_at)}, {"health", healthOf(version, now)}};
    if (include_material) entry["material"] = version.material;
    if (operator_id == owner) entry["acceptance"] = acceptance(name, version, consumers);
    entries.push_back(entry);
  }
  res.set_content(json{{"name", name}, {"versions", entries}}.dump(), "application/json");
}

void register_routes(httplib::Server& svr) { svr.Get(R"(/v1/secrets/([\\w-]+)/versions)", list_versions); }
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <algorithm>
#include <set>
#include <sstream>
#include <string>
#include <vector>

#include "secretd/vault.h"  // vault::ownerOf, versions, consumers, accepted, nowSeconds

using json = nlohmann::json;

const std::set<std::string> kAllowedQuery = {"limit"};
constexpr long long kDefaultLimit = 50;
constexpr long long kMaxLimit = 200;

// Against the version's own interval: retired once retired, overdue from rotate_at, ok before.
std::string healthOf(const vault::Version& version, long long now) {
  if (version.retired_at != 0) return "retired";
  return now >= version.rotate_at ? "overdue" : "ok";
}

json unsetAsNull(long long t) { return t ? json(t) : json(nullptr); }

json acceptance(const std::string& name, const vault::Version& version, const std::vector<std::string>& consumers) {
  const std::vector<std::string> verified = vault::accepted(name, version.version_id);
  std::vector<std::string> pending;
  for (const auto& c : consumers) {
    if (std::find(verified.begin(), verified.end(), c) == verified.end()) pending.push_back(c);
  }
  return json{{"verified", verified}, {"pending", pending}};
}

// The one shape a version leaves the service in: metadata, health and acceptance.
json versionView(const std::string& name, const vault::Version& version, const std::vector<std::string>& consumers, long long now) {
  return json{{"version_id", version.version_id},
              {"fingerprint", version.fingerprint},
              {"rotation_seconds", version.rotation_seconds},
              {"created_at", version.created_at},
              {"rotate_at", version.rotate_at},
              {"activated_at", unsetAsNull(version.activated_at)},
              {"retired_at", unsetAsNull(version.retired_at)},
              {"health", healthOf(version, now)},
              {"acceptance", acceptance(name, version, consumers)}};
}

bool hasScope(std::string header, const std::string& scope) {
  std::replace(header.begin(), header.end(), ',', ' ');
  std::istringstream words(header);
  for (std::string word; words >> word;) {
    if (word == scope) return true;
  }
  return false;
}

void list_versions(const httplib::Request& req, httplib::Response& res) {
  const std::string name = req.matches[1];
  const auto refuse = [&res](int status, const std::string& why) {
    res.status = status;
    res.set_content(why, "text/plain");
  };
  if (req.get_header_value("X-Operator-Id").empty()) return refuse(401, "X-Operator-Id is required");
  if (!hasScope(req.get_header_value("X-Scopes"), "secrets")) return refuse(403, "the secrets scope is required");
  for (const auto& [key, value] : req.params) {
    if (kAllowedQuery.count(key) == 0) return refuse(400, "unknown query parameter: " + key);
  }
  long long limit = kDefaultLimit;
  if (req.has_param("limit")) {
    const std::string raw = req.get_param_value("limit");
    limit = !raw.empty() && std::all_of(raw.begin(), raw.end(), ::isdigit) && raw.size() < 6 ? std::stoll(raw) : 0;
    if (limit < 1 || limit > kMaxLimit) return refuse(400, "limit is 1..200");
  }
  if (vault::ownerOf(name).empty()) return refuse(404, "no such secret");
  const long long now = vault::nowSeconds();
  const std::vector<std::string> consumers = vault::consumers(name);
  std::vector<vault::Version> versions = vault::versions(name);
  std::reverse(versions.begin(), versions.end());
  json views = json::array();
  for (const vault::Version& version : versions) {
    if (static_cast<long long>(views.size()) >= limit) break;
    views.push_back(versionView(name, version, consumers, now));
  }
  res.set_content(json{{"name", name}, {"versions", views}}.dump(), "application/json");
}

void register_routes(httplib::Server& svr) { svr.Get(R"(/v1/secrets/([\\w-]+)/versions)", list_versions); }
`,
    },
  },
  harness: {
    python: `from secretd import vault

NAME = "payments-db"
MATERIAL = "pg-password-CANARY-41d7"
OWNER = {"X-Operator-Id": "op-ana", "X-Scopes": "secrets"}
ON_CALL = {"X-Operator-Id": "op-ben", "X-Scopes": "secrets,deploy"}
PATH = f"/v1/secrets/{NAME}/versions"


def _seed():
    """v1 rotates hourly, v2 every 30 days; three consumers, two of which verified v2."""
    vault.create_version(NAME, MATERIAL, 3600, "op-ana")
    vault.create_version(NAME, MATERIAL + "-2", 2_592_000, "op-ana")
    vault.record_activation(NAME, "v1")
    vault.record_activation(NAME, "v2")
    for consumer_id in ("billing", "checkout", "ledger"):
        vault.register_consumer(NAME, consumer_id)
    vault.record_acceptance(NAME, "v2", "billing")
    vault.record_acceptance(NAME, "v2", "checkout")


def _read(ctx):
    _seed()
    return ctx.client(ctx.load("read").app)


def _ok(r, what):
    assert r.status_code == 200, f"{what} answered {r.status_code}: {r.text}"
    return r.json()


def _by_id(body):
    return {v.get("version_id"): v for v in body.get("versions", [])}


async def check_read_route(ctx):
    async with _read(ctx) as c:
        body = _ok(await c.get(PATH, headers=OWNER), f"GET {PATH}")
        assert [v.get("version_id") for v in body.get("versions", [])] == ["v2", "v1"], f"the versions must come newest first, got {body}"
        assert body["versions"][0].get("fingerprint") == vault.fingerprint(MATERIAL + "-2"), f"each entry carries the version's fingerprint, got {body['versions'][0]}"
        one = _ok(await c.get(PATH, params={"limit": "1"}, headers=OWNER), f"GET {PATH}?limit=1")
        assert [v.get("version_id") for v in one.get("versions", [])] == ["v2"], f"limit=1 must answer the newest version only, got {one}"
        anonymous = await c.get(PATH)
        assert anonymous.status_code == 401, f"a read without X-Operator-Id answered {anonymous.status_code}, expected 401"
        unknown = await c.get("/v1/secrets/nope/versions", headers=OWNER)
    assert unknown.status_code == 404, f"a read of an unknown secret answered {unknown.status_code}, expected 404"


async def check_scope_required(ctx):
    async with _read(ctx) as c:
        for headers in ({"X-Operator-Id": "op-eve"}, {"X-Operator-Id": "op-eve", "X-Scopes": "deploy metrics"}):
            r = await c.get(PATH, headers=headers)
            assert r.status_code == 403, f"a read with scopes {headers.get('X-Scopes')!r} answered {r.status_code}: without the secrets scope it must be 403"
            assert "fingerprint" not in r.text, f"a refused read still listed the versions: {r.text}"
        _ok(await c.get(PATH, headers=ON_CALL), "a read with X-Scopes: secrets,deploy")


async def check_closed_query(ctx):
    async with _read(ctx) as c:
        r = await c.get(PATH, params={"include_material": "true"}, headers=OWNER)
        assert MATERIAL not in r.text, f"include_material=true returned the material to the owner: {r.text}. No parameter may widen the read"
        assert r.status_code == 400, f"an unknown query parameter (include_material) answered {r.status_code}, expected 400"
        for limit in ("0", "201", "ten"):
            r = await c.get(PATH, params={"limit": limit}, headers=OWNER)
            assert r.status_code == 400, f"limit={limit} answered {r.status_code}, expected 400 (limit is 1..200)"
        body = _ok(await c.get(PATH, params={"limit": "200"}, headers=OWNER), f"GET {PATH}?limit=200")
    assert all("material" not in v for v in body["versions"]), f"an entry carries material: {body}"


async def check_health_interval(ctx):
    async with _read(ctx) as c:
        fresh = _by_id(_ok(await c.get(PATH, headers=OWNER), f"GET {PATH}"))
        assert fresh["v1"].get("health") == "ok" and fresh["v2"].get("health") == "ok", f"right after the creates both versions are ok, got {fresh}"
        ctx.clock.advance(3601)
        later = _by_id(_ok(await c.get(PATH, headers=OWNER), f"GET {PATH} an hour later"))
    assert later["v1"].get("health") == "overdue", f"v1 rotates every 3600 s and was created over an hour ago, yet its health is {later['v1'].get('health')!r}: health follows the version's own rotate_at"
    assert later["v2"].get("health") == "ok", f"v2 rotates every 30 days and is an hour old, yet its health is {later['v2'].get('health')!r}"


async def check_acceptance_visible(ctx):
    async with _read(ctx) as c:
        body = _ok(await c.get(PATH, headers=ON_CALL), f"GET {PATH} as op-ben (not the owner)")
    v2 = _by_id(body)["v2"]
    assert v2.get("acceptance") == {"verified": ["billing", "checkout"], "pending": ["ledger"]}, f"the on-call engineer (op-ben, holding the secrets scope) must see v2's acceptance {{verified: [billing, checkout], pending: [ledger]}}, got {v2.get('acceptance')!r}"
`,
    typescript: `const NAME = 'payments-db';
const MATERIAL = 'pg-password-CANARY-41d7';
const OWNER = {'X-Operator-Id': 'op-ana', 'X-Scopes': 'secrets'};
const ON_CALL = {'X-Operator-Id': 'op-ben', 'X-Scopes': 'secrets,deploy'};
const PATH = \`/v1/secrets/\${NAME}/versions\`;

/** v1 rotates hourly, v2 every 30 days; three consumers, two of which verified v2. */
async function read(ctx) {
  const vault = ctx.load('/support/secretd/vault.ts');
  await vault.createVersion(NAME, MATERIAL, 3600, 'op-ana');
  await vault.createVersion(NAME, \`\${MATERIAL}-2\`, 2_592_000, 'op-ana');
  await vault.recordActivation(NAME, 'v1');
  await vault.recordActivation(NAME, 'v2');
  for (const id of ['billing', 'checkout', 'ledger']) await vault.registerConsumer(NAME, id);
  await vault.recordAcceptance(NAME, 'v2', 'billing');
  await vault.recordAcceptance(NAME, 'v2', 'checkout');
  return {c: ctx.client(ctx.load('read').app), vault};
}

function ok(r, what: string) {
  assert.equal(r.status, 200, \`\${what} answered \${r.status}: \${r.text}\`);
  return r.json();
}

const byId = body => Object.fromEntries((body.versions ?? []).map(v => [v.version_id, v]));

export async function check_read_route(ctx) {
  const {c, vault} = await read(ctx);
  const body = ok(await c.get(PATH, {headers: OWNER}), \`GET \${PATH}\`);
  assert.deepStrictEqual((body.versions ?? []).map(v => v.version_id), ['v2', 'v1'], \`the versions must come newest first, got \${JSON.stringify(body)}\`);
  assert.equal(body.versions[0].fingerprint, vault.fingerprint(\`\${MATERIAL}-2\`), "each entry carries the version's fingerprint");
  const one = ok(await c.get(\`\${PATH}?limit=1\`, {headers: OWNER}), \`GET \${PATH}?limit=1\`);
  assert.deepStrictEqual((one.versions ?? []).map(v => v.version_id), ['v2'], 'limit=1 must answer the newest version only');
  const anonymous = await c.get(PATH);
  assert.equal(anonymous.status, 401, \`a read without X-Operator-Id answered \${anonymous.status}, expected 401\`);
  const unknown = await c.get('/v1/secrets/nope/versions', {headers: OWNER});
  assert.equal(unknown.status, 404, \`a read of an unknown secret answered \${unknown.status}, expected 404\`);
}

export async function check_scope_required(ctx) {
  const {c} = await read(ctx);
  for (const headers of [{'X-Operator-Id': 'op-eve'}, {'X-Operator-Id': 'op-eve', 'X-Scopes': 'deploy metrics'}]) {
    const r = await c.get(PATH, {headers});
    assert.equal(r.status, 403, \`a read with scopes \${JSON.stringify(headers['X-Scopes'] ?? null)} answered \${r.status}: without the secrets scope it must be 403\`);
    assert(!r.text.includes('fingerprint'), \`a refused read still listed the versions: \${r.text}\`);
  }
  ok(await c.get(PATH, {headers: ON_CALL}), 'a read with X-Scopes: secrets,deploy');
}

export async function check_closed_query(ctx) {
  const {c} = await read(ctx);
  let r = await c.get(\`\${PATH}?include_material=true\`, {headers: OWNER});
  assert(!r.text.includes(MATERIAL), \`include_material=true returned the material to the owner: \${r.text}. No parameter may widen the read\`);
  assert.equal(r.status, 400, \`an unknown query parameter (include_material) answered \${r.status}, expected 400\`);
  for (const limit of ['0', '201', 'ten']) {
    r = await c.get(\`\${PATH}?limit=\${limit}\`, {headers: OWNER});
    assert.equal(r.status, 400, \`limit=\${limit} answered \${r.status}, expected 400 (limit is 1..200)\`);
  }
  const body = ok(await c.get(\`\${PATH}?limit=200\`, {headers: OWNER}), \`GET \${PATH}?limit=200\`);
  assert(body.versions.every(v => !('material' in v)), \`an entry carries material: \${JSON.stringify(body)}\`);
}

export async function check_health_interval(ctx) {
  const {c} = await read(ctx);
  const fresh = byId(ok(await c.get(PATH, {headers: OWNER}), \`GET \${PATH}\`));
  assert(fresh.v1?.health === 'ok' && fresh.v2?.health === 'ok', \`right after the creates both versions are ok, got \${JSON.stringify(fresh)}\`);
  ctx.clock.advance(3601);
  const later = byId(ok(await c.get(PATH, {headers: OWNER}), \`GET \${PATH} an hour later\`));
  assert.equal(later.v1.health, 'overdue', \`v1 rotates every 3600 s and was created over an hour ago, yet its health is \${JSON.stringify(later.v1.health)}: health follows the version's own rotate_at\`);
  assert.equal(later.v2.health, 'ok', \`v2 rotates every 30 days and is an hour old, yet its health is \${JSON.stringify(later.v2.health)}\`);
}

export async function check_acceptance_visible(ctx) {
  const {c} = await read(ctx);
  const v2 = byId(ok(await c.get(PATH, {headers: ON_CALL}), \`GET \${PATH} as op-ben (not the owner)\`)).v2;
  assert.deepStrictEqual(
    v2.acceptance,
    {verified: ['billing', 'checkout'], pending: ['ledger']},
    \`the on-call engineer (op-ben, holding the secrets scope) must see v2's acceptance {verified: [billing, checkout], pending: [ledger]}, got \${JSON.stringify(v2.acceptance)}\`,
  );
}
`,
    go: `package main

import (
	"context"
	"net/http"
	"strings"

	"secretd/vault"

	"leetbuild/harness"
)

const (
	readName     = "payments-db"
	readMaterial = "pg-password-CANARY-41d7"
	readPath     = "/v1/secrets/payments-db/versions"
)

var readBg = context.Background()

// readClient seeds v1 (hourly) and v2 (30 days), three consumers, two of which verified v2.
func readClient(ctx *harness.Ctx) *harness.HTTP {
	vault.CreateVersion(readBg, readName, readMaterial, 3600, "op-ana")
	vault.CreateVersion(readBg, readName, readMaterial+"-2", 2592000, "op-ana")
	vault.RecordActivation(readBg, readName, "v1")
	vault.RecordActivation(readBg, readName, "v2")
	for _, id := range []string{"billing", "checkout", "ledger"} {
		vault.RegisterConsumer(readBg, readName, id)
	}
	vault.RecordAcceptance(readBg, readName, "v2", "billing")
	vault.RecordAcceptance(readBg, readName, "v2", "checkout")
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

func readOK(ctx *harness.Ctx, r *harness.Response, what string) []map[string]any {
	ctx.Equal(r.Status, 200, "%s (%s)", what, r.Text())
	var body struct {
		Versions []map[string]any \`json:"versions"\`
	}
	r.Decode(&body)
	return body.Versions
}

func readIDs(versions []map[string]any) []string {
	ids := []string{}
	for _, v := range versions {
		id, _ := v["version_id"].(string)
		ids = append(ids, id)
	}
	return ids
}

func readByID(versions []map[string]any) map[string]map[string]any {
	out := map[string]map[string]any{}
	for _, v := range versions {
		id, _ := v["version_id"].(string)
		out[id] = v
	}
	return out
}

func CheckReadRoute(ctx *harness.Ctx) {
	c := readClient(ctx)
	versions := readOK(ctx, c.Get(readPath, "X-Operator-Id", "op-ana", "X-Scopes", "secrets"), "GET "+readPath)
	ctx.Equal(readIDs(versions), []string{"v2", "v1"}, "the versions must come newest first")
	ctx.Equal(versions[0]["fingerprint"], vault.Fingerprint(readMaterial+"-2"), "each entry carries the version's fingerprint")
	one := readOK(ctx, c.Get(readPath+"?limit=1", "X-Operator-Id", "op-ana", "X-Scopes", "secrets"), "GET "+readPath+"?limit=1")
	ctx.Equal(readIDs(one), []string{"v2"}, "limit=1 must answer the newest version only")
	ctx.Equal(c.Get(readPath).Status, 401, "a read without X-Operator-Id")
	ctx.Equal(c.Get("/v1/secrets/nope/versions", "X-Operator-Id", "op-ana", "X-Scopes", "secrets").Status, 404, "a read of an unknown secret")
}

func CheckScopeRequired(ctx *harness.Ctx) {
	c := readClient(ctx)
	for _, scopes := range []string{"", "deploy metrics"} {
		r := c.Get(readPath, "X-Operator-Id", "op-eve", "X-Scopes", scopes)
		ctx.Equal(r.Status, 403, "a read with scopes %q (without the secrets scope it must be 403)", scopes)
		ctx.Assert(!strings.Contains(r.Text(), "fingerprint"), "a refused read still listed the versions: %s", r.Text())
	}
	readOK(ctx, c.Get(readPath, "X-Operator-Id", "op-ben", "X-Scopes", "secrets,deploy"), "a read with X-Scopes: secrets,deploy")
}

func CheckClosedQuery(ctx *harness.Ctx) {
	c := readClient(ctx)
	r := c.Get(readPath+"?include_material=true", "X-Operator-Id", "op-ana", "X-Scopes", "secrets")
	ctx.Assert(!strings.Contains(r.Text(), readMaterial), "include_material=true returned the material to the owner: %s. No parameter may widen the read", r.Text())
	ctx.Equal(r.Status, 400, "an unknown query parameter (include_material)")
	for _, limit := range []string{"0", "201", "ten"} {
		ctx.Equal(c.Get(readPath+"?limit="+limit, "X-Operator-Id", "op-ana", "X-Scopes", "secrets").Status, 400, "limit=%s (limit is 1..200)", limit)
	}
	for _, v := range readOK(ctx, c.Get(readPath+"?limit=200", "X-Operator-Id", "op-ana", "X-Scopes", "secrets"), "GET "+readPath+"?limit=200") {
		_, has := v["material"]
		ctx.Assert(!has, "an entry carries material: %v", v)
	}
}

func CheckHealthInterval(ctx *harness.Ctx) {
	c := readClient(ctx)
	fresh := readByID(readOK(ctx, c.Get(readPath, "X-Operator-Id", "op-ana", "X-Scopes", "secrets"), "GET "+readPath))
	ctx.Assert(fresh["v1"]["health"] == "ok" && fresh["v2"]["health"] == "ok", "right after the creates both versions are ok, got %v", fresh)
	ctx.Clock.Advance(3601)
	later := readByID(readOK(ctx, c.Get(readPath, "X-Operator-Id", "op-ana", "X-Scopes", "secrets"), "GET "+readPath+" an hour later"))
	ctx.Equal(later["v1"]["health"], "overdue", "v1 rotates every 3600 s and was created over an hour ago: health follows the version's own rotate_at; its health")
	ctx.Equal(later["v2"]["health"], "ok", "v2 rotates every 30 days and is an hour old; its health")
}

func CheckAcceptanceVisible(ctx *harness.Ctx) {
	c := readClient(ctx)
	v2 := readByID(readOK(ctx, c.Get(readPath, "X-Operator-Id", "op-ben", "X-Scopes", "secrets,deploy"), "GET "+readPath+" as op-ben (not the owner)"))["v2"]
	ctx.Equal(v2["acceptance"], map[string]any{"verified": []any{"billing", "checkout"}, "pending": []any{"ledger"}}, "the on-call engineer (op-ben, holding the secrets scope) must see v2's acceptance")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <map>
#include <string>
#include <vector>

#include "secretd/vault.h"

using json = nlohmann::json;

namespace {

const std::string kName = "payments-db";
const std::string kMaterial = "pg-password-CANARY-41d7";
const std::string kPath = "/v1/secrets/payments-db/versions";

// Seeds v1 (hourly) and v2 (30 days), three consumers, two of which verified v2.
harness::HTTP read(harness::Ctx& ctx) {
  vault::createVersion(kName, kMaterial, 3600, "op-ana");
  vault::createVersion(kName, kMaterial + "-2", 2592000, "op-ana");
  vault::recordActivation(kName, "v1");
  vault::recordActivation(kName, "v2");
  for (const std::string id : {"billing", "checkout", "ledger"}) vault::registerConsumer(kName, id);
  vault::recordAcceptance(kName, "v2", "billing");
  vault::recordAcceptance(kName, "v2", "checkout");
  static httplib::Server* svr = nullptr;
  delete svr;
  svr = new httplib::Server;
  register_routes(*svr);
  return ctx.HTTP(*svr);
}

harness::Response asOwner(harness::HTTP& c, const std::string& path) { return c.Get(path, "X-Operator-Id", "op-ana", "X-Scopes", "secrets"); }

json ok(harness::Ctx& ctx, const harness::Response& r, const std::string& what) {
  ctx.Equal(r.Status, 200, "%s (%s)", what, r.Text());
  return json::parse(r.Text()).value("versions", json::array());
}

std::vector<std::string> ids(const json& versions) {
  std::vector<std::string> out;
  for (const auto& v : versions) out.push_back(v.value("version_id", ""));
  return out;
}

std::map<std::string, json> byId(const json& versions) {
  std::map<std::string, json> out;
  for (const auto& v : versions) out[v.value("version_id", "")] = v;
  return out;
}

}  // namespace

void CheckReadRoute(harness::Ctx& ctx) {
  auto c = read(ctx);
  const json versions = ok(ctx, asOwner(c, kPath), "GET " + kPath);
  ctx.Equal(ids(versions), {"v2", "v1"}, "the versions must come newest first");
  ctx.Equal(versions[0].value("fingerprint", ""), vault::fingerprint(kMaterial + "-2"), "each entry carries the version's fingerprint");
  ctx.Equal(ids(ok(ctx, asOwner(c, kPath + "?limit=1"), "GET " + kPath + "?limit=1")), {"v2"}, "limit=1 must answer the newest version only");
  ctx.Equal(c.Get(kPath).Status, 401, "a read without X-Operator-Id");
  ctx.Equal(asOwner(c, "/v1/secrets/nope/versions").Status, 404, "a read of an unknown secret");
}

void CheckScopeRequired(harness::Ctx& ctx) {
  auto c = read(ctx);
  for (const std::string scopes : {"", "deploy metrics"}) {
    const auto r = c.Get(kPath, "X-Operator-Id", "op-eve", "X-Scopes", scopes);
    ctx.Equal(r.Status, 403, "a read with scopes %q (without the secrets scope it must be 403)", scopes);
    ctx.Assert(r.Text().find("fingerprint") == std::string::npos, "a refused read still listed the versions: %s", r.Text());
  }
  ok(ctx, c.Get(kPath, "X-Operator-Id", "op-ben", "X-Scopes", "secrets,deploy"), "a read with X-Scopes: secrets,deploy");
}

void CheckClosedQuery(harness::Ctx& ctx) {
  auto c = read(ctx);
  const auto r = asOwner(c, kPath + "?include_material=true");
  ctx.Assert(r.Text().find(kMaterial) == std::string::npos, "include_material=true returned the material to the owner: %s. No parameter may widen the read", r.Text());
  ctx.Equal(r.Status, 400, "an unknown query parameter (include_material)");
  for (const std::string limit : {"0", "201", "ten"}) {
    ctx.Equal(asOwner(c, kPath + "?limit=" + limit).Status, 400, "limit=%s (limit is 1..200)", limit);
  }
  for (const auto& v : ok(ctx, asOwner(c, kPath + "?limit=200"), "GET " + kPath + "?limit=200")) {
    ctx.Assert(!v.contains("material"), "an entry carries material: %s", v.dump());
  }
}

void CheckHealthInterval(harness::Ctx& ctx) {
  auto c = read(ctx);
  auto fresh = byId(ok(ctx, asOwner(c, kPath), "GET " + kPath));
  ctx.Assert(fresh["v1"].value("health", "") == "ok" && fresh["v2"].value("health", "") == "ok", "right after the creates both versions are ok");
  ctx.Clock.Advance(3601);
  auto later = byId(ok(ctx, asOwner(c, kPath), "GET " + kPath + " an hour later"));
  ctx.Equal(later["v1"].value("health", ""), "overdue", "v1 rotates every 3600 s and was created over an hour ago: health follows the version's own rotate_at; its health");
  ctx.Equal(later["v2"].value("health", ""), "ok", "v2 rotates every 30 days and is an hour old; its health");
}

void CheckAcceptanceVisible(harness::Ctx& ctx) {
  auto c = read(ctx);
  auto v2 = byId(ok(ctx, c.Get(kPath, "X-Operator-Id", "op-ben", "X-Scopes", "secrets,deploy"), "GET " + kPath + " as op-ben (not the owner)"))["v2"];
  const json expected = {{"verified", {"billing", "checkout"}}, {"pending", {"ledger"}}};
  ctx.Equal(v2.value("acceptance", json()), expected, "the on-call engineer (op-ben, holding the secrets scope) must see v2's acceptance");
}
`,
  },
  hints: [
    'Read the versions with no scope at all: it works. Ask as the owner with `include_material=true`: the material comes back. An hourly secret two hours old still says ok, and an operator who is not the owner sees no acceptance.',
    'Nothing reads `X-Scopes`; the query is read by name, so any flag the code knows is honoured; health adds the 30-day default to created_at; acceptance is behind `operator == owner`.',
    'Answer 403 without `secrets` in `X-Scopes`, 400 for any key outside `ALLOWED_QUERY` or a limit outside 1..200, compare the clock with `rotate_at` in `health_of`, and build every entry with `version_view`, acceptance included.',
  ],
  debrief: `The read side of a vault is closed by construction rather than by role. An allowlist means a new flag cannot widen the response without a change to that list in review, and one projection means the material appears only if someone edits that function. The scope check is the smallest diff and the largest exposure: ids, fingerprints and windows are enough to map a whole inventory. Health is a derived state, so it must derive from the version's own interval, or the console hides exactly the secrets with the strictest policies. Acceptance is shown to every operator with the scope because whoever unblocks a retirement is on call, not the owner. Production vaults also log every read of the lifecycle, paginate with an opaque cursor, and rate-limit the listing per principal.`,
};
