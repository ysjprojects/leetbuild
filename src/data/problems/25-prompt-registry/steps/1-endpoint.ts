import type {Step} from '@/lib/types';

export const endpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/prompts: register an immutable version',
  concept: 'http',
  file: 'api',
  focus: ['client', 'registry', 'db'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it registers the route,
parses the body and answers 201, so the demo shows a version being stored. It overwrites versions in
place, ships undeclared placeholders, and mints a new version on every retry. Review it like the
service owner, fix it, and prove the fix with the checks below.

Implement \`POST /v1/prompts\`, the registration endpoint of the prompt registry. Body:
\`{"name": "support-reply", "version": 3, "template": "Hi {{name}}…", "variables": ["name"],
"parent_version": 2}\`.

- The tenant comes from the authenticated \`X-Tenant-Id\` header; a missing tenant is **401**.
  \`Idempotency-Key\` is required — **400** when absent.
- \`template\` is a non-empty string of at most **32 KiB** (\`1 << 15\` bytes) of UTF-8; a larger
  one is **413**.
- \`variables\` is the **declared** variable allowlist of the version. Every \`{{placeholder}}\`
  found in the template must be declared **and** must exist in the registry’s
  \`ALLOWED_VARIABLES\`; anything else is **422**. Leftover \`{{…}}\` that nobody declared ships to
  the model as literal text, which is how prompt bugs reach production.
- Every version carries a **content hash** (SHA-256 of the template bytes). Identical templates
  must never mint two versions: a registration whose hash already exists for that name returns the
  stored version with **200** and \`created: false\`.
- A version is **immutable**. A second write of the same \`(name, version)\` with a *different*
  template is **409**; the same \`(name, version)\` with the same template is a replay and returns
  the **original** \`content_hash\` with **200**.

**Failure mode the checks target.** The draft's \`put\` overwrites whatever was there, so an edit
silently rewrites history that evals were run against; it never compares the template’s placeholders
with the declared variables, so \`{{name}}\` typos ship verbatim; and it has no key, so a client
retry forks the version history into two versions with the same number.`,
  sequence: {
    participants: ['Client', 'Prompt Registry', 'version store'],
    messages: [
      {from: 'Client', to: 'Prompt Registry', label: 'POST /v1/prompts · X-Tenant-Id · Idempotency-Key', kind: 'sync'},
      {
        from: 'Prompt Registry',
        to: 'Prompt Registry',
        label: 'validate: 32 KiB cap · placeholder allowlist',
        kind: 'sync',
      },
      {from: 'Prompt Registry', to: 'version store', label: 'get_version(tenant, name, version)', kind: 'sync'},
      {from: 'version store', to: 'Prompt Registry', label: 'stored version / none', kind: 'reply'},
      {from: 'Prompt Registry', to: 'version store', label: 'put(version, content_hash)', kind: 'async'},
      {from: 'Prompt Registry', to: 'Client', label: '201 created · 200 replay · 409 immutable', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Handles POST /v1/prompts',
      detail: 'Register the registration route on `POST /v1/prompts`.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/prompts["']/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/prompts['"]/]},
        go: {all: [/HandleFunc\(\s*"POST \/v1\/prompts"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"prompts"\s*\)/, /\bpost\s*\{/]},
        cpp: {all: [/svr\.Post\(\s*"\/v1\/prompts"/]},
      },
    },
    {
      id: 'template-cap',
      title: 'Requires a tenant and caps the template at 32 KiB',
      detail:
        'A missing `X-Tenant-Id` is **401** and a template over `1 << 15` bytes is **413**, checked before anything is stored. The draft authenticates nobody and stores a template of any size.',
      match: {
        python: {all: [/MAX_TEMPLATE_BYTES/, /status_code\s*=\s*413/, /status_code\s*=\s*401/]},
        typescript: {all: [/MAX_TEMPLATE_BYTES/, /code\(\s*413\s*\)/, /code\(\s*401\s*\)/]},
        go: {all: [/maxTemplateBytes/, /StatusRequestEntityTooLarge/, /StatusUnauthorized/]},
        scala: {all: [/MaxTemplateBytes/, /StatusCodes\.RequestEntityTooLarge/, /StatusCodes\.Unauthorized/]},
        cpp: {all: [/kMaxTemplateBytes/, /\b413\b/, /\b401\b/]},
      },
    },
    {
      id: 'immutable',
      title: 'A version is immutable: a different write is 409',
      detail:
        'The stored version is fetched first; a second write of the same `(name, version)` with a different content hash answers **409**, and the same hash is a replay. The draft overwrites the record in place.',
      match: {
        python: {all: [/\b409\b/, /content_hash/, /store\.get_version\(/]},
        typescript: {all: [/\b409\b/, /content_hash/, /store\.getVersion\(/]},
        go: {all: [/StatusConflict/, /content_hash/, /store\.GetVersion\(/]},
        scala: {all: [/StatusCodes\.Conflict/, /content_hash/, /store\.getVersion\(/]},
        cpp: {all: [/\b409\b/, /content_hash/, /store\.get_version\(/]},
      },
    },
    {
      id: 'variable-allowlist',
      title: 'Rejects undeclared placeholders',
      detail:
        'Placeholders are extracted from the template and compared with the declared `variables` and the `ALLOWED_VARIABLES` set; an undeclared or unknown placeholder answers **422**. The draft never reads either.',
      match: {
        python: {all: [/ALLOWED_VARIABLES/, /PLACEHOLDER_RE/, /status_code\s*=\s*422/]},
        typescript: {all: [/ALLOWED_VARIABLES/, /PLACEHOLDER_RE/, /code\(\s*422\s*\)/]},
        go: {all: [/allowedVariables/, /declaredPlaceholders\(/, /StatusUnprocessableEntity/]},
        scala: {all: [/AllowedVariables/, /PlaceholderRe/, /StatusCodes\.UnprocessableEntity/]},
        cpp: {all: [/kAllowedVariables/, /declared_placeholders/, /\b422\b/]},
      },
    },
    {
      id: 'content-hash',
      title: 'Hashes the template so identical content never mints two versions',
      detail:
        'The response carries a SHA-256 `content_hash` and a `created` flag; a registration whose hash already exists returns the stored version. Keyed by `Idempotency-Key`, a replay returns the **original** hash instead of forking the history.',
      match: {
        python: {all: [/hashlib\.sha256/, /content_hash/, /created/, /Idempotency-Key/]},
        typescript: {all: [/createHash\(\s*['"]sha256['"]\s*\)/, /content_hash/, /created/, /idempotency-key/]},
        go: {all: [/sha256\.Sum256/, /content_hash/, /created/, /Idempotency-Key/]},
        scala: {all: [/SHA-256/, /content_hash/, /created/, /Idempotency-Key/]},
        cpp: {all: [/sha256Hex/, /content_hash/, /created/, /Idempotency-Key/]},
      },
    },
  ],
  code: {
    python: {
      starter: `from fastapi import FastAPI, Header
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()


class PromptRequest(BaseModel):
    name: str
    version: int
    template: str
    variables: list[str] = []
    parent_version: int | None = None


class VersionStore:
    def put(self, tenant: str, name: str, version: int, record: dict) -> None:
        """Store the version, overwriting whatever was there."""
        raise NotImplementedError


store = VersionStore()


@app.post("/v1/prompts")
def register(body: PromptRequest, tenant: str = Header(alias="X-Tenant-Id")) -> JSONResponse:
    # TODO: this draft overwrites an existing version in place, ships the template without
    # checking its placeholders against the variable allowlist, and mints a new version on every
    # retry because the registration is not keyed by Idempotency-Key. Review all three.
    store.put(tenant, body.name, body.version, {"name": body.name, "version": body.version})
    return JSONResponse({"name": body.name, "version": body.version, "stored": True}, status_code=201)
`,
      solution: `import hashlib
import re

from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()

MAX_TEMPLATE_BYTES = 1 << 15  # 32 KiB
ALLOWED_VARIABLES = {"name", "tone", "product", "locale", "tenant"}
PLACEHOLDER_RE = re.compile(r"\\{\\{([a-z_][a-z0-9_]*)\\}\\}")


class PromptRequest(BaseModel):
    name: str
    version: int
    template: str
    variables: list[str] = []
    parent_version: int | None = None


class VersionStore:
    def get_version(self, tenant: str, name: str, version: int) -> dict | None:
        """The stored version of (name, version), if the registry already has one."""
        raise NotImplementedError

    def get_by_hash(self, tenant: str, name: str, content_hash: str) -> dict | None:
        """An existing version of name with this content hash, if any."""
        raise NotImplementedError

    def put(self, tenant: str, name: str, version: int, record: dict) -> None:
        """Append the version; an existing (name, version) record is never rewritten."""
        raise NotImplementedError


store = VersionStore()


def content_hash_of(body_template: str) -> str:
    """The template's content hash: identical templates mint the same version."""
    return hashlib.sha256(body_template.encode("utf-8")).hexdigest()


def declared_placeholders(body_template: str) -> set[str]:
    return set(PLACEHOLDER_RE.findall(body_template))


def validate(body: PromptRequest) -> set[str]:
    if body.template == "":
        raise HTTPException(status_code=400, detail="template must be a non-empty string")
    if len(body.template.encode("utf-8")) > MAX_TEMPLATE_BYTES:
        raise HTTPException(status_code=413, detail="template exceeds 32 KiB")
    used = declared_placeholders(body.template)
    undeclared = used - set(body.variables)
    if undeclared:
        raise HTTPException(status_code=422, detail=f"undeclared placeholders: {sorted(undeclared)}")
    unknown = used - ALLOWED_VARIABLES
    if unknown:
        raise HTTPException(status_code=422, detail=f"outside the allowlist: {sorted(unknown)}")
    return used


@app.post("/v1/prompts")
def register(
    body: PromptRequest,
    tenant: str | None = Header(default=None, alias="X-Tenant-Id"),
    idem_key: str | None = Header(default=None, alias="Idempotency-Key"),
) -> JSONResponse:
    if tenant is None or tenant == "":
        raise HTTPException(status_code=401, detail="missing X-Tenant-Id")
    if idem_key is None or idem_key == "":
        raise HTTPException(status_code=400, detail="Idempotency-Key is required")
    used = validate(body)
    digest = content_hash_of(body.template)

    existing = store.get_version(tenant, body.name, body.version)
    if existing is not None:
        if existing["content_hash"] != digest:
            raise HTTPException(status_code=409, detail="a version is immutable")
        return JSONResponse({**existing, "created": False}, status_code=200)

    duplicate = store.get_by_hash(tenant, body.name, digest)
    if duplicate is not None:
        return JSONResponse({**duplicate, "created": False}, status_code=200)

    record = {
        "name": body.name,
        "version": body.version,
        "content_hash": digest,
        "variables": sorted(used),
        "parent_version": body.parent_version,
    }
    store.put(tenant, body.name, body.version, record)
    return JSONResponse({**record, "created": True}, status_code=201)
`,
    },
    typescript: {
      starter: `/** POST /v1/prompts: a model-generated draft that overwrites versions in place. */
import Fastify from 'fastify';

import {store} from './store';

export const app = Fastify();

interface PromptBody {
  name: string;
  version: number;
  template: string;
  variables?: string[];
  parent_version?: number;
}

app.post('/v1/prompts', async (request, reply) => {
  // TODO: this draft overwrites an existing version in place, ships the template without checking
  // its placeholders against the variable allowlist, and mints a new version on every retry
  // because the registration is not keyed by Idempotency-Key. Review all three.
  const tenant = request.headers['x-tenant-id'] as string;
  const body = request.body as PromptBody;
  await store.put(tenant, body.name, body.version, {name: body.name, version: body.version});
  return reply.code(201).send({name: body.name, version: body.version, stored: true});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** POST /v1/prompts: immutable, hash-deduped, allowlist-checked prompt versions. */
import {createHash} from 'node:crypto';

import Fastify from 'fastify';

import {store} from './store';

export const app = Fastify();

const MAX_TEMPLATE_BYTES = 1 << 15; // 32 KiB
const ALLOWED_VARIABLES: Record<string, true> = {
  name: true,
  tone: true,
  product: true,
  locale: true,
  tenant: true,
};
const PLACEHOLDER_RE = /\\{\\{([a-z_][a-z0-9_]*)\\}\\}/g;

interface PromptBody {
  name: string;
  version: number;
  template: string;
  variables?: string[];
  parent_version?: number;
}

interface VersionRecord {
  name: string;
  version: number;
  content_hash: string;
  variables: string[];
  parent_version: number | null;
}

function contentHashOf(bodyTemplate: string): string {
  return createHash('sha256').update(bodyTemplate, 'utf8').digest('hex');
}

function declaredPlaceholders(bodyTemplate: string): string[] {
  return [...new Set([...bodyTemplate.matchAll(PLACEHOLDER_RE)].map(m => m[1]))];
}

app.post('/v1/prompts', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing X-Tenant-Id'});
  const idemKey = request.headers['idempotency-key'];
  if (typeof idemKey !== 'string' || idemKey === '')
    return reply.code(400).send({error: 'Idempotency-Key is required'});

  const body = request.body as PromptBody;
  if (typeof body.template !== 'string' || body.template === '')
    return reply.code(400).send({error: 'template must be a non-empty string'});
  if (Buffer.byteLength(body.template, 'utf8') > MAX_TEMPLATE_BYTES)
    return reply.code(413).send({error: 'template exceeds 32 KiB'});
  const used = declaredPlaceholders(body.template);
  const declared = new Set(body.variables ?? []);
  const undeclared = used.filter(v => !declared.has(v));
  if (undeclared.length > 0) return reply.code(422).send({error: \`undeclared: \${undeclared.join(',')}\`});
  const unknown = used.filter(v => ALLOWED_VARIABLES[v] !== true);
  if (unknown.length > 0) return reply.code(422).send({error: \`outside the allowlist: \${unknown.join(',')}\`});

  const digest = contentHashOf(body.template);
  const existing = await store.getVersion(tenant, body.name, body.version);
  if (existing !== null) {
    if (existing.content_hash !== digest) return reply.code(409).send({error: 'a version is immutable'});
    return reply.code(200).send({...existing, created: false});
  }

  const duplicate = await store.getByHash(tenant, body.name, digest);
  if (duplicate !== null) return reply.code(200).send({...duplicate, created: false});

  const record: VersionRecord = {
    name: body.name,
    version: body.version,
    content_hash: digest,
    variables: used,
    parent_version: body.parent_version ?? null,
  };
  await store.put(tenant, body.name, body.version, record);
  return reply.code(201).send({...record, created: true});
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

type PromptRequest struct {
	Name          string   \`json:"name"\`
	Version       int      \`json:"version"\`
	Template      string   \`json:"template"\`
	Variables     []string \`json:"variables"\`
	ParentVersion *int     \`json:"parent_version"\`
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func register(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	var body PromptRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	// TODO: this draft overwrites an existing version in place, ships the template without
	// checking its placeholders against the variable allowlist, and mints a new version on every
	// retry because the registration is not keyed by Idempotency-Key. Review all three.
	store.Put(r.Context(), tenant, body.Name, body.Version, map[string]any{
		"name": body.Name, "version": body.Version,
	})
	writeJSON(rw, http.StatusCreated, map[string]any{"name": body.Name, "version": body.Version, "stored": true})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/prompts", register)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
      solution: `package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"log"
	"net/http"
	"sort"
	"strings"
)

const maxTemplateBytes = 1 << 15 // 32 KiB

var allowedVariables = map[string]bool{
	"name": true, "tone": true, "product": true, "locale": true, "tenant": true,
}

type PromptRequest struct {
	Name          string   \`json:"name"\`
	Version       int      \`json:"version"\`
	Template      string   \`json:"template"\`
	Variables     []string \`json:"variables"\`
	ParentVersion *int     \`json:"parent_version"\`
}

type VersionStore struct{}

func (s *VersionStore) GetVersion(ctx context.Context, tenant, name string, version int) (map[string]any, error) {
	return nil, nil
}

func (s *VersionStore) GetByHash(ctx context.Context, tenant, name, contentHash string) (map[string]any, error) {
	return nil, nil
}

func (s *VersionStore) Put(ctx context.Context, tenant, name string, version int, record map[string]any) error {
	return nil
}

var store = &VersionStore{}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func contentHashOf(bodyTemplate string) string {
	sum := sha256.Sum256([]byte(bodyTemplate))
	return hex.EncodeToString(sum[:])
}

// declaredPlaceholders returns the {{name}} slots the template actually uses.
func declaredPlaceholders(bodyTemplate string) map[string]bool {
	used := map[string]bool{}
	rest := bodyTemplate
	for {
		open := strings.Index(rest, "{{")
		if open < 0 {
			break
		}
		closeAt := strings.Index(rest[open+2:], "}}")
		if closeAt < 0 {
			break
		}
		name := strings.TrimSpace(rest[open+2 : open+2+closeAt])
		if name != "" {
			used[name] = true
		}
		rest = rest[open+2+closeAt+2:]
	}
	return used
}

func validate(body PromptRequest) ([]string, int, string) {
	if body.Template == "" {
		return nil, http.StatusBadRequest, "template must be a non-empty string"
	}
	if len([]byte(body.Template)) > maxTemplateBytes {
		return nil, http.StatusRequestEntityTooLarge, "template exceeds 32 KiB"
	}
	declared := map[string]bool{}
	for _, name := range body.Variables {
		declared[name] = true
	}
	used := declaredPlaceholders(body.Template)
	variables := make([]string, 0, len(used))
	undeclared := []string{}
	unknown := []string{}
	for name := range used {
		variables = append(variables, name)
		if !declared[name] {
			undeclared = append(undeclared, name)
		}
		if !allowedVariables[name] {
			unknown = append(unknown, name)
		}
	}
	sort.Strings(variables)
	sort.Strings(undeclared)
	sort.Strings(unknown)
	if len(undeclared) > 0 {
		return nil, http.StatusUnprocessableEntity, "undeclared placeholders: " + strings.Join(undeclared, ",")
	}
	if len(unknown) > 0 {
		return nil, http.StatusUnprocessableEntity, "outside the allowlist: " + strings.Join(unknown, ",")
	}
	return variables, http.StatusOK, ""
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
	var body PromptRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	variables, status, detail := validate(body)
	if detail != "" {
		writeJSON(rw, status, map[string]string{"error": detail})
		return
	}
	digest := contentHashOf(body.Template)
	ctx := r.Context()

	existing, err := store.GetVersion(ctx, tenant, body.Name, body.Version)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	if existing != nil {
		if existing["content_hash"] != digest {
			writeJSON(rw, http.StatusConflict, map[string]string{"error": "a version is immutable"})
			return
		}
		existing["created"] = false
		writeJSON(rw, http.StatusOK, existing)
		return
	}

	duplicate, err := store.GetByHash(ctx, tenant, body.Name, digest)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	if duplicate != nil {
		duplicate["created"] = false
		writeJSON(rw, http.StatusOK, duplicate)
		return
	}

	record := map[string]any{
		"name":           body.Name,
		"version":        body.Version,
		"content_hash":   digest,
		"variables":      variables,
		"parent_version": body.ParentVersion,
		"created":        true,
	}
	if err := store.Put(ctx, tenant, body.Name, body.Version, record); err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	writeJSON(rw, http.StatusCreated, record)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/prompts", register)
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

final case class PromptRequest(
    name: String,
    version: Int,
    template: String,
    variables: List[String] = Nil,
    parent_version: Option[Int] = None
)

object PromptApi {
  implicit val system: ActorSystem = ActorSystem("prompt-registry")
  implicit val requestFormat: RootJsonFormat[PromptRequest] = jsonFormat5(PromptRequest)

  val store = VersionStore.open()

  val route: Route =
    path("v1" / "prompts") {
      post {
        headerValueByName("X-Tenant-Id") { tenant =>
          entity(as[PromptRequest]) { body =>
            // TODO: this draft overwrites an existing version in place, ships the template without
            // checking its placeholders against the variable allowlist, and mints a new version on
            // every retry because the registration is not keyed by Idempotency-Key.
            store.put(tenant, body.name, body.version, s"""{"name":"\${body.name}","version":\${body.version}}""")
            complete(StatusCodes.Created, s"""{"name":"\${body.name}","version":\${body.version},"stored":true}""")
          }
        }
      }
    }

  def main(args: Array[String]): Unit = {
    Http().newServerAt("0.0.0.0", 8443).bind(route)
  }
}
`,
      solution: `import java.security.MessageDigest

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class PromptRequest(
    name: String,
    version: Int,
    template: String,
    variables: List[String] = Nil,
    parent_version: Option[Int] = None
)

object PromptApi {
  implicit val system: ActorSystem = ActorSystem("prompt-registry")
  implicit val requestFormat: RootJsonFormat[PromptRequest] = jsonFormat5(PromptRequest)

  val MaxTemplateBytes = 1 << 15 // 32 KiB
  val AllowedVariables = Set("name", "tone", "product", "locale", "tenant")
  val PlaceholderRe = """\\{\\{([a-z_][a-z0-9_]*)\\}\\}""".r

  val store = VersionStore.open()

  def contentHashOf(bodyTemplate: String): String = {
    val digest = MessageDigest.getInstance("SHA-256").digest(bodyTemplate.getBytes("UTF-8"))
    digest.map(byte => f"$byte%02x").mkString
  }

  def declaredPlaceholders(bodyTemplate: String): Set[String] =
    PlaceholderRe.findAllMatchIn(bodyTemplate).map(_.group(1)).toSet

  def validate(body: PromptRequest): Either[(StatusCode, String), Set[String]] = {
    if (body.template.isEmpty) {
      Left((StatusCodes.BadRequest, "template must be a non-empty string"))
    } else if (body.template.getBytes("UTF-8").length > MaxTemplateBytes) {
      Left((StatusCodes.RequestEntityTooLarge, "template exceeds 32 KiB"))
    } else {
      val used = declaredPlaceholders(body.template)
      val undeclared = used.diff(body.variables.toSet)
      val unknown = used.diff(AllowedVariables)
      if (undeclared.nonEmpty) Left((StatusCodes.UnprocessableEntity, s"undeclared: \${undeclared.mkString(",")}"))
      else if (unknown.nonEmpty) Left((StatusCodes.UnprocessableEntity, s"outside the allowlist: \${unknown.mkString(",")}"))
      else Right(used)
    }
  }

  val route: Route =
    path("v1" / "prompts") {
      post {
        optionalHeaderValueByName("X-Tenant-Id") { tenantOpt =>
          optionalHeaderValueByName("Idempotency-Key") { idemOpt =>
            entity(as[PromptRequest]) { body =>
              if (!tenantOpt.exists(_.nonEmpty)) {
                complete(StatusCodes.Unauthorized, """{"error":"missing X-Tenant-Id"}""")
              } else if (!idemOpt.exists(_.nonEmpty)) {
                complete(StatusCodes.BadRequest, """{"error":"Idempotency-Key is required"}""")
              } else {
                val tenant = tenantOpt.get
                validate(body) match {
                  case Left((status, detail)) =>
                    complete(status, s"""{"error":"$detail"}""")
                  case Right(used) =>
                    val digest = contentHashOf(body.template)
                    store.getVersion(tenant, body.name, body.version) match {
                      case Some(existing) if existing.contains(digest) =>
                        complete(StatusCodes.OK, s"""{"name":"\${body.name}","version":\${body.version},"content_hash":"$digest","created":false}""")
                      case Some(_) =>
                        complete(StatusCodes.Conflict, """{"error":"a version is immutable"}""")
                      case None =>
                        store.getByHash(tenant, body.name, digest) match {
                          case Some(duplicate) =>
                            complete(StatusCodes.OK, s"""{"content_hash":"$digest","created":false}""")
                          case None =>
                            store.put(tenant, body.name, body.version, digest)
                            complete(
                              StatusCodes.Created,
                              s"""{"name":"\${body.name}","version":\${body.version},"content_hash":"$digest","variables":\${used.toList.sorted.mkString("[\\"", "\\",\\"", "\\"]")},"created":true}"""
                            )
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

using json = nlohmann::json;

struct VersionStore {
  void put(const std::string& tenant, const std::string& name, int version, const json& record);
};

VersionStore store;

int main() {
  httplib::Server svr;

  svr.Post("/v1/prompts", [](const httplib::Request& req, httplib::Response& res) {
    const auto tenant = req.get_header_value("X-Tenant-Id");
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) {
      res.status = 400;
      res.set_content(R"({"error":"invalid json"})", "application/json");
      return;
    }
    // TODO: this draft overwrites an existing version in place, ships the template without
    // checking its placeholders against the variable allowlist, and mints a new version on every
    // retry because the registration is not keyed by Idempotency-Key. Review all three.
    store.put(tenant, body.value("name", std::string()), body.value("version", 0), body);
    res.status = 201;
    res.set_content(json{{"name", body.value("name", std::string())}, {"version", body.value("version", 0)}, {"stored", true}}.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <set>
#include <string>
#include <vector>

using json = nlohmann::json;

constexpr std::size_t kMaxTemplateBytes = 1 << 15;  // 32 KiB
const std::set<std::string> kAllowedVariables = {"name", "tone", "product", "locale", "tenant"};

struct VersionStore {
  std::optional<json> get_version(const std::string& tenant, const std::string& name, int version);
  std::optional<json> get_by_hash(const std::string& tenant, const std::string& name, const std::string& contentHash);
  void put(const std::string& tenant, const std::string& name, int version, const json& record);
};

VersionStore store;

/// SHA-256 of the template bytes, from the shared crypto helper.
std::string sha256Hex(const std::string& bodyTemplate);

// The {{name}} slots the template actually uses, scanned so a value can never invent one.
std::vector<std::string> declared_placeholders(const std::string& bodyTemplate) {
  std::vector<std::string> used;
  std::string rest = bodyTemplate;
  while (true) {
    const auto open = rest.find("{{");
    if (open == std::string::npos) break;
    const auto close = rest.find("}}", open + 2);
    if (close == std::string::npos) break;
    const auto name = rest.substr(open + 2, close - open - 2);
    if (!name.empty() && std::find(used.begin(), used.end(), name) == used.end()) used.push_back(name);
    rest = rest.substr(close + 2);
  }
  return used;
}

int main() {
  httplib::Server svr;

  svr.Post("/v1/prompts", [](const httplib::Request& req, httplib::Response& res) {
    const auto tenant = req.get_header_value("X-Tenant-Id");
    if (tenant.empty()) {
      res.status = 401;
      res.set_content(R"({"error":"missing X-Tenant-Id"})", "application/json");
      return;
    }
    if (req.get_header_value("Idempotency-Key").empty()) {
      res.status = 400;
      res.set_content(R"({"error":"Idempotency-Key is required"})", "application/json");
      return;
    }
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object() || !body.contains("template") || !body["template"].is_string()) {
      res.status = 400;
      res.set_content(R"({"error":"template must be a non-empty string"})", "application/json");
      return;
    }
    const auto bodyTemplate = body["template"].get<std::string>();
    if (bodyTemplate.empty()) {
      res.status = 400;
      res.set_content(R"({"error":"template must be a non-empty string"})", "application/json");
      return;
    }
    if (bodyTemplate.size() > kMaxTemplateBytes) {
      res.status = 413;
      res.set_content(R"({"error":"template exceeds 32 KiB"})", "application/json");
      return;
    }
    const auto used = declared_placeholders(bodyTemplate);
    std::set<std::string> declared;
    if (body.contains("variables") && body["variables"].is_array()) {
      for (const auto& item : body["variables"]) declared.insert(item.get<std::string>());
    }
    std::vector<std::string> undeclared;
    std::vector<std::string> unknown;
    for (const auto& name : used) {
      if (declared.count(name) == 0) undeclared.push_back(name);
      if (kAllowedVariables.count(name) == 0) unknown.push_back(name);
    }
    if (!undeclared.empty() || !unknown.empty()) {
      res.status = 422;
      res.set_content(R"({"error":"undeclared placeholders"})", "application/json");
      return;
    }
    const auto name = body.value("name", std::string());
    const int version = body.value("version", 0);
    const auto digest = sha256Hex(bodyTemplate);

    const auto existing = store.get_version(tenant, name, version);
    if (existing) {
      if (existing->value("content_hash", std::string()) != digest) {
        res.status = 409;
        res.set_content(R"({"error":"a version is immutable"})", "application/json");
        return;
      }
      res.status = 200;
      res.set_content(json{{"name", name}, {"version", version}, {"content_hash", digest}, {"created", false}}.dump(), "application/json");
      return;
    }
    if (store.get_by_hash(tenant, name, digest)) {
      res.status = 200;
      res.set_content(json{{"content_hash", digest}, {"created", false}}.dump(), "application/json");
      return;
    }
    const json record = {
        {"name", name},
        {"version", version},
        {"content_hash", digest},
        {"variables", used},
        {"created", true},
    };
    store.put(tenant, name, version, record);
    res.status = 201;
    res.set_content(record.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  hints: [
    'Fetch the stored version before you write anything: `store.get_version(tenant, name, version)` first, and only then decide between 200 (same hash), 409 (different hash) and 201 (nothing there). A write-then-inspect order has already destroyed the old record by the time you notice.',
    'Extract the placeholders from the template instead of trusting `variables`: the caller declares what it thinks it uses, the template says what it really uses. Reject both a placeholder the caller never declared and a variable the registry never allowlisted.',
    'The hash is the identity of the content: `sha256(template)`. Two versions with the same hash are the same prompt, and a replay of one registration must return the hash that was stored the first time rather than a freshly computed one under a new version number.',
  ],
  debrief: `The interviewer is testing whether you can defend a registry’s core promise: a version is a name for a piece of content that never changes. Immutability is what makes every later claim possible — an eval record, a rollout percentage and a rollback all refer to a version by number, and they are only meaningful if that number still means the same bytes. The hash is the second half: it is the content identity, so a re-registration of identical text returns the stored version instead of minting a second one, and a client retry cannot fork history. The placeholder allowlist is the quiet defect: undeclared \`{{…}}\` is not a template bug you see in review, it is literal text the model receives in production. Real registries add per-name ownership, a signed manifest per version, and a retention policy that keeps a version readable for as long as any audit references it.`,
};
