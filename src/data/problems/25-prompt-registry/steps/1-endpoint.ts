import type {Step} from '@/lib/types';

export const endpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/prompts: register a version once',
  concept: 'http',
  guides: ['request-boundaries', 'idempotent-requests'],
  file: 'api',
  focus: ['client', 'registry', 'redis'],
  task: `## Task

**Starting point.** The starter serves \`POST /v1/prompts\` with body \`{"name", "version", "template",
"variables"}\`: it answers 401 without \`X-Tenant-Id\`, hashes the template with SHA-256, stores the
version through the provided \`versions.put\` and answers 201 with \`{name, version, content_hash,
variables, created: true}\`. It serves the demo and hides 4 flaws.

**Failure mode the checks target.** A version number is only useful while it names the same bytes:
every eval record and rollback in this course points at one. \`versions.put\` is set-if-absent and
returns false when the version exists, but the starter answers 201 either way, so a client that
rewrote version 3 believes text the registry never stored. It also mints a second version for bytes
the registry already holds and accepts placeholders no caller may fill.

Requirements:

- \`template\` is at most **32 KiB** of UTF-8 (\`MAX_TEMPLATE_BYTES\`); larger is **413**.
- The template's placeholders (\`PLACEHOLDER\` in \`prompts/config\`) are exactly the declared
  \`variables\`, all in \`ALLOWED_VARIABLES\` (\`customer_name\`, \`product\`, \`tone\`, \`locale\`,
  \`question\`); **422** otherwise.
- Bytes registered under another version of the name (\`versions.by_hash\`) answer **200** with that
  version and \`created: false\`.
- When \`versions.put\` returns false, the same bytes are a replay (**200**, \`created: false\`),
  other bytes are **409**.
- Every rejection happens before \`versions.put\`.`,
  sequence: {
    participants: ['Client', 'registryd', 'version store'],
    messages: [
      {from: 'Client', to: 'registryd', label: 'POST /v1/prompts · X-Tenant-Id', kind: 'sync'},
      {from: 'registryd', to: 'registryd', label: '32 KiB cap · placeholders = variables ⊆ allowlist', kind: 'sync'},
      {from: 'registryd', to: 'version store', label: 'by_hash(tenant, name, sha256)', kind: 'sync'},
      {from: 'version store', to: 'registryd', label: 'none', kind: 'reply'},
      {from: 'registryd', to: 'version store', label: 'put(tenant, record) · set if absent', kind: 'sync'},
      {from: 'version store', to: 'registryd', label: 'true · false when the version exists', kind: 'reply'},
      {from: 'registryd', to: 'Client', label: '201 created · 200 replay · 409 other bytes', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Handles POST /v1/prompts',
      detail:
        'A valid registration answers 201 with name, version, the SHA-256 content_hash, the sorted variables and created true, the version is in the store, and a request without X-Tenant-Id is 401.',
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
      title: 'Caps the template at 32 KiB of UTF-8',
      detail:
        'A template of 32 769 bytes, or of 16 385 two-byte characters, is 413 and stores nothing; exactly 32 KiB is accepted. The starter stores a template of any size.',
      match: {
        python: {all: [/MAX_TEMPLATE_BYTES/, /status_code\s*=\s*413/]},
        typescript: {all: [/MAX_TEMPLATE_BYTES/, /code\(\s*413\s*\)/]},
        go: {all: [/maxTemplateBytes/, /StatusRequestEntityTooLarge/]},
        scala: {all: [/MaxTemplateBytes/, /StatusCodes\.(PayloadTooLarge|RequestEntityTooLarge)/]},
        cpp: {all: [/kMaxTemplateBytes/, /\b413\b/]},
      },
    },
    {
      id: 'placeholder-allowlist',
      title: 'Placeholders match the declared variables and the allowlist',
      detail:
        'A placeholder outside ALLOWED_VARIABLES, one the variables do not declare, or a declared variable the template never uses is 422 with nothing stored. The starter stores whatever variables the body lists.',
      match: {
        python: {all: [/ALLOWED_VARIABLES/, /PLACEHOLDER/, /status_code\s*=\s*422/]},
        typescript: {all: [/ALLOWED_VARIABLES/, /PLACEHOLDER/, /code\(\s*422\s*\)/]},
        go: {all: [/allowedVariables/, /config\.Placeholder/, /StatusUnprocessableEntity/]},
        scala: {all: [/AllowedVariables/, /Config\.Placeholder/, /StatusCodes\.UnprocessableEntity/]},
        cpp: {all: [/kAllowedVariables/, /config::kPlaceholder/, /\b422\b/]},
      },
    },
    {
      id: 'immutable',
      title: 'A registered version is immutable: other bytes are 409',
      detail:
        'Version 3 written again with other bytes is 409 and the store keeps the first template; the same bytes again are 200 with created false and the original hash. The starter answers 201 whatever versions.put returned.',
      match: {
        python: {all: [/status_code\s*=\s*409/, /(if\s+not\s+|=\s*)versions\.put\(|versions\.get\(/]},
        typescript: {
          all: [/code\(\s*409\s*\)/, /(if\s*\(\s*!?\s*(await\s+)?|=\s*(await\s+)?)versions\.put\(|versions\.get\(/],
        },
        go: {all: [/StatusConflict/, /[A-Za-z]\w*,\s*err\s*:?=\s*versions\.Put\(|versions\.Get\(/]},
        scala: {all: [/StatusCodes\.Conflict/, /(if\s*\(\s*!?\s*|=\s*)Versions\.put\(|Versions\.get\(/]},
        cpp: {all: [/\b409\b/, /(if\s*\(\s*!?\s*|=\s*)versions::put\(|versions::get\(/]},
      },
    },
    {
      id: 'content-dedupe',
      title: 'The same bytes resolve to the version that holds them',
      detail:
        'The template of version 3 registered as version 4 answers 200 with version 3 and created false, and no version 4 is stored; another tenant gets its own version. The starter stores a second version of the same bytes.',
      match: {
        python: {order: [/versions\.by_hash\(/, /versions\.put\(/]},
        typescript: {order: [/versions\.byHash\(/, /versions\.put\(/]},
        go: {order: [/versions\.ByHash\(/, /versions\.Put\(/]},
        scala: {order: [/Versions\.byHash\(/, /Versions\.put\(/]},
        cpp: {order: [/versions::by_hash\(/, /versions::put\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import hashlib
import logging

from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from prompts.versions import versions

app = FastAPI()
logger = logging.getLogger("prompts")


class PromptRequest(BaseModel):
    name: str
    version: int
    template: str
    variables: list[str] = []


@app.post("/v1/prompts")
def register(body: PromptRequest, tenant: str | None = Header(default=None, alias="X-Tenant-Id")) -> JSONResponse:
    # TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
    if tenant is None or tenant == "":
        raise HTTPException(status_code=401, detail="missing X-Tenant-Id")
    record = {
        "name": body.name,
        "version": body.version,
        "content_hash": hashlib.sha256(body.template.encode("utf-8")).hexdigest(),
        "template": body.template,
        "variables": sorted(body.variables),
    }
    versions.put(tenant, record)
    logger.info("prompt registered tenant=%s name=%s version=%d", tenant, body.name, body.version)
    answer = {key: record[key] for key in ("name", "version", "content_hash", "variables")}
    return JSONResponse({**answer, "created": True}, status_code=201)
`,
      solution: `import hashlib
import logging

from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from prompts.config import PLACEHOLDER
from prompts.versions import versions

app = FastAPI()
logger = logging.getLogger("prompts")

MAX_TEMPLATE_BYTES = 32 * 1024
ALLOWED_VARIABLES = {"customer_name", "product", "tone", "locale", "question"}


class PromptRequest(BaseModel):
    name: str
    version: int
    template: str
    variables: list[str] = []


def answer(record: dict, created: bool, status: int) -> JSONResponse:
    body = {key: record[key] for key in ("name", "version", "content_hash", "variables")}
    return JSONResponse({**body, "created": created}, status_code=status)


@app.post("/v1/prompts")
def register(body: PromptRequest, tenant: str | None = Header(default=None, alias="X-Tenant-Id")) -> JSONResponse:
    if tenant is None or tenant == "":
        raise HTTPException(status_code=401, detail="missing X-Tenant-Id")
    if len(body.template.encode("utf-8")) > MAX_TEMPLATE_BYTES:
        raise HTTPException(status_code=413, detail=f"template exceeds {MAX_TEMPLATE_BYTES} bytes")
    declared = set(body.variables)
    if set(PLACEHOLDER.findall(body.template)) != declared or not declared <= ALLOWED_VARIABLES:
        raise HTTPException(status_code=422, detail="placeholders must be exactly the declared variables, all allowed")

    content_hash = hashlib.sha256(body.template.encode("utf-8")).hexdigest()
    same = versions.by_hash(tenant, body.name, content_hash)
    if same is not None and same["version"] != body.version:
        return answer(same, False, 200)  # these bytes are registered already: no second version

    record = {
        "name": body.name,
        "version": body.version,
        "content_hash": content_hash,
        "template": body.template,
        "variables": sorted(declared),
    }
    if versions.put(tenant, record):
        logger.info("prompt registered tenant=%s name=%s version=%d", tenant, body.name, body.version)
        return answer(record, True, 201)
    existing = versions.get(tenant, body.name, body.version)
    if existing is None or existing["content_hash"] != content_hash:
        raise HTTPException(status_code=409, detail=f"version {body.version} of {body.name} holds other bytes")
    return answer(existing, False, 200)
`,
    },
    typescript: {
      starter: `import {createHash} from 'node:crypto';

import Fastify from 'fastify';

import {type PromptVersion, versions} from 'prompts/versions';

export const app = Fastify();

interface PromptBody {
  name: string;
  version: number;
  template: string;
  variables?: string[];
}

app.post('/v1/prompts', async (request, reply) => {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing X-Tenant-Id'});
  const body = request.body as PromptBody;
  const record: PromptVersion = {
    name: body.name,
    version: body.version,
    content_hash: createHash('sha256').update(body.template).digest('hex'),
    template: body.template,
    variables: [...(body.variables ?? [])].sort(),
  };
  await versions.put(tenant, record);
  request.log.info({tenant, name: record.name, version: record.version}, 'prompt registered');
  const {name, version, content_hash, variables} = record;
  return reply.code(201).send({name, version, content_hash, variables, created: true});
});
`,
      solution: `import {createHash} from 'node:crypto';

import Fastify from 'fastify';

import {PLACEHOLDER} from 'prompts/config';
import {type PromptVersion, versions} from 'prompts/versions';

export const app = Fastify();

export const MAX_TEMPLATE_BYTES = 32 * 1024;
export const ALLOWED_VARIABLES: Record<string, true> = {customer_name: true, product: true, tone: true, locale: true, question: true};

interface PromptBody {
  name: string;
  version: number;
  template: string;
  variables?: string[];
}

const answer = ({name, version, content_hash, variables}: PromptVersion, created: boolean) => ({
  name,
  version,
  content_hash,
  variables,
  created,
});

app.post('/v1/prompts', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing X-Tenant-Id'});
  const body = request.body as PromptBody;
  if (new TextEncoder().encode(body.template).length > MAX_TEMPLATE_BYTES)
    return reply.code(413).send({error: \`template exceeds \${MAX_TEMPLATE_BYTES} bytes\`});
  const declared = new Set(body.variables ?? []);
  const placeholders = new Set([...body.template.matchAll(PLACEHOLDER)].map(m => m[1]));
  const exact = placeholders.size === declared.size && [...declared].every(v => placeholders.has(v) && ALLOWED_VARIABLES[v] === true);
  if (!exact) return reply.code(422).send({error: 'placeholders must be exactly the declared variables, all allowed'});

  const contentHash = createHash('sha256').update(body.template).digest('hex');
  const same = await versions.byHash(tenant, body.name, contentHash);
  // These bytes are registered already: no second version.
  if (same !== null && same.version !== body.version) return reply.code(200).send(answer(same, false));

  const record: PromptVersion = {
    name: body.name,
    version: body.version,
    content_hash: contentHash,
    template: body.template,
    variables: [...declared].sort(),
  };
  if (await versions.put(tenant, record)) {
    request.log.info({tenant, name: record.name, version: record.version}, 'prompt registered');
    return reply.code(201).send(answer(record, true));
  }
  const existing = await versions.get(tenant, body.name, body.version);
  if (existing === null || existing.content_hash !== contentHash)
    return reply.code(409).send({error: \`version \${body.version} of \${body.name} holds other bytes\`});
  return reply.code(200).send(answer(existing, false));
});
`,
    },
    go: {
      starter: `package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"log"
	"net/http"
	"sort"

	"prompts/versions" // versions.Version, versions.Get/ByHash/Put(ctx, tenant, …) — provided
)

type PromptRequest struct {
	Name      string   \`json:"name"\`
	Version   int      \`json:"version"\`
	Template  string   \`json:"template"\`
	Variables []string \`json:"variables"\`
}

// Registration is the answer: the version without its template.
type Registration struct {
	Name        string   \`json:"name"\`
	Version     int      \`json:"version"\`
	ContentHash string   \`json:"content_hash"\`
	Variables   []string \`json:"variables"\`
	Created     bool     \`json:"created"\`
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func registerPrompt(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-Tenant-Id"})
		return
	}
	var body PromptRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	sum := sha256.Sum256([]byte(body.Template))
	variables := append([]string{}, body.Variables...)
	sort.Strings(variables)
	v := versions.Version{Name: body.Name, Version: body.Version, ContentHash: hex.EncodeToString(sum[:]), Template: body.Template, Variables: variables}
	if _, err := versions.Put(r.Context(), tenant, v); err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	log.Printf("prompt registered tenant=%s name=%s version=%d", tenant, v.Name, v.Version)
	writeJSON(rw, http.StatusCreated, Registration{v.Name, v.Version, v.ContentHash, v.Variables, true})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/prompts", registerPrompt)
}

func main() {
	mux := http.NewServeMux()
	register(mux)
	log.Fatal(http.ListenAndServe(":8443", mux))
}
`,
      solution: `package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"log"
	"net/http"
	"sort"

	"prompts/config"   // config.Placeholder — provided
	"prompts/versions" // versions.Version, versions.Get/ByHash/Put(ctx, tenant, …) — provided
)

const maxTemplateBytes = 32 * 1024

var allowedVariables = map[string]bool{"customer_name": true, "product": true, "tone": true, "locale": true, "question": true}

type PromptRequest struct {
	Name      string   \`json:"name"\`
	Version   int      \`json:"version"\`
	Template  string   \`json:"template"\`
	Variables []string \`json:"variables"\`
}

// Registration is the answer: the version without its template.
type Registration struct {
	Name        string   \`json:"name"\`
	Version     int      \`json:"version"\`
	ContentHash string   \`json:"content_hash"\`
	Variables   []string \`json:"variables"\`
	Created     bool     \`json:"created"\`
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

// declaredVariables is the sorted set of declared variables when they are exactly the template's
// placeholders and all allowed; ok is false otherwise.
func declaredVariables(template string, declared []string) (variables []string, ok bool) {
	used := map[string]bool{}
	for _, m := range config.Placeholder.FindAllStringSubmatch(template, -1) {
		used[m[1]] = true
	}
	seen := map[string]bool{}
	for _, name := range declared {
		if !used[name] || !allowedVariables[name] {
			return nil, false
		}
		if !seen[name] {
			seen[name] = true
			variables = append(variables, name)
		}
	}
	sort.Strings(variables)
	return append([]string{}, variables...), len(seen) == len(used)
}

func registerPrompt(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-Tenant-Id"})
		return
	}
	var body PromptRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	if len(body.Template) > maxTemplateBytes {
		writeJSON(rw, http.StatusRequestEntityTooLarge, map[string]string{"error": "template exceeds 32 KiB"})
		return
	}
	variables, ok := declaredVariables(body.Template, body.Variables)
	if !ok {
		writeJSON(rw, http.StatusUnprocessableEntity, map[string]string{"error": "placeholders must be exactly the declared variables, all allowed"})
		return
	}

	sum := sha256.Sum256([]byte(body.Template))
	contentHash := hex.EncodeToString(sum[:])
	same, err := versions.ByHash(r.Context(), tenant, body.Name, contentHash)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	if same != nil && same.Version != body.Version {
		// These bytes are registered already: no second version.
		writeJSON(rw, http.StatusOK, Registration{same.Name, same.Version, same.ContentHash, same.Variables, false})
		return
	}

	v := versions.Version{Name: body.Name, Version: body.Version, ContentHash: contentHash, Template: body.Template, Variables: variables}
	created, err := versions.Put(r.Context(), tenant, v)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	if created {
		log.Printf("prompt registered tenant=%s name=%s version=%d", tenant, v.Name, v.Version)
		writeJSON(rw, http.StatusCreated, Registration{v.Name, v.Version, v.ContentHash, v.Variables, true})
		return
	}
	existing, err := versions.Get(r.Context(), tenant, body.Name, body.Version)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	if existing == nil || existing.ContentHash != contentHash {
		writeJSON(rw, http.StatusConflict, map[string]string{"error": "this version holds other bytes"})
		return
	}
	writeJSON(rw, http.StatusOK, Registration{existing.Name, existing.Version, existing.ContentHash, existing.Variables, false})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/prompts", registerPrompt)
}

func main() {
	mux := http.NewServeMux()
	register(mux)
	log.Fatal(http.ListenAndServe(":8443", mux))
}
`,
    },
    scala: {
      starter: `import java.security.MessageDigest

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

import prompts.{PromptVersion, Versions}

final case class PromptRequest(name: String, version: Int, template: String, variables: Option[List[String]])

/** The answer: the version without its template. */
final case class Registration(name: String, version: Int, content_hash: String, variables: List[String], created: Boolean)

object PromptApi {
  implicit val system: ActorSystem = ActorSystem("prompt-registry")
  implicit val requestFormat: RootJsonFormat[PromptRequest] = jsonFormat4(PromptRequest)
  implicit val registrationFormat: RootJsonFormat[Registration] = jsonFormat5(Registration)

  private def sha256Hex(text: String): String =
    MessageDigest.getInstance("SHA-256").digest(text.getBytes("UTF-8")).map("%02x".format(_)).mkString

  val route: Route =
    path("v1" / "prompts") {
      post {
        optionalHeaderValueByName("X-Tenant-Id") { tenantOpt =>
          entity(as[PromptRequest]) { body =>
            // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
            if (!tenantOpt.exists(_.nonEmpty)) {
              complete(StatusCodes.Unauthorized, """{"error":"missing X-Tenant-Id"}""")
            } else {
              val tenant = tenantOpt.get
              val record =
                PromptVersion(body.name, body.version, sha256Hex(body.template), body.template, body.variables.getOrElse(Nil).sorted)
              Versions.put(tenant, record)
              system.log.info(s"prompt registered tenant=$tenant name=\${record.name} version=\${record.version}")
              complete(StatusCodes.Created, Registration(record.name, record.version, record.content_hash, record.variables, created = true))
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
      solution: `import java.security.MessageDigest

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

import prompts.{Config, PromptVersion, Versions}

final case class PromptRequest(name: String, version: Int, template: String, variables: Option[List[String]])

/** The answer: the version without its template. */
final case class Registration(name: String, version: Int, content_hash: String, variables: List[String], created: Boolean)

object PromptApi {
  implicit val system: ActorSystem = ActorSystem("prompt-registry")
  implicit val requestFormat: RootJsonFormat[PromptRequest] = jsonFormat4(PromptRequest)
  implicit val registrationFormat: RootJsonFormat[Registration] = jsonFormat5(Registration)

  val MaxTemplateBytes: Int = 32 * 1024
  val AllowedVariables = Set("customer_name", "product", "tone", "locale", "question")

  private def sha256Hex(text: String): String =
    MessageDigest.getInstance("SHA-256").digest(text.getBytes("UTF-8")).map("%02x".format(_)).mkString

  private def answer(v: PromptVersion, created: Boolean): Registration =
    Registration(v.name, v.version, v.content_hash, v.variables, created)

  val route: Route =
    path("v1" / "prompts") {
      post {
        optionalHeaderValueByName("X-Tenant-Id") { tenantOpt =>
          entity(as[PromptRequest]) { body =>
            val declared = body.variables.getOrElse(Nil).toSet
            val placeholders = Config.Placeholder.findAllMatchIn(body.template).map(_.group(1)).toSet
            if (!tenantOpt.exists(_.nonEmpty)) {
              complete(StatusCodes.Unauthorized, """{"error":"missing X-Tenant-Id"}""")
            } else if (body.template.getBytes("UTF-8").length > MaxTemplateBytes) {
              complete(StatusCodes.PayloadTooLarge, """{"error":"template exceeds 32 KiB"}""")
            } else if (placeholders != declared || !declared.subsetOf(AllowedVariables)) {
              complete(StatusCodes.UnprocessableEntity, """{"error":"placeholders must be exactly the declared variables, all allowed"}""")
            } else {
              val tenant = tenantOpt.get
              val contentHash = sha256Hex(body.template)
              // These bytes registered under another version answer that version: no second one.
              Versions.byHash(tenant, body.name, contentHash).filter(_.version != body.version) match {
                case Some(same) => complete(StatusCodes.OK, answer(same, created = false))
                case None =>
                  val record = PromptVersion(body.name, body.version, contentHash, body.template, declared.toList.sorted)
                  if (Versions.put(tenant, record)) {
                    system.log.info(s"prompt registered tenant=$tenant name=\${record.name} version=\${record.version}")
                    complete(StatusCodes.Created, answer(record, created = true))
                  } else {
                    Versions.get(tenant, body.name, body.version) match {
                      case Some(existing) if existing.content_hash == contentHash => complete(StatusCodes.OK, answer(existing, created = false))
                      case _ => complete(StatusCodes.Conflict, """{"error":"this version holds other bytes"}""")
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

#include <algorithm>
#include <iostream>
#include <string>
#include <vector>

#include "digest.h"            // sha256_hex(bytes) — provided
#include "prompts/versions.h"  // versions::get/by_hash/put(tenant, …) — provided

using json = nlohmann::json;

void reject(httplib::Response& res, int status, const std::string& error) {
  res.status = status;
  res.set_content(json({{"error", error}}).dump(), "application/json");
}

// The answer: the version without its template.
json registration(const json& record, bool created) {
  return {{"name", record["name"]},
          {"version", record["version"]},
          {"content_hash", record["content_hash"]},
          {"variables", record["variables"]},
          {"created", created}};
}

void register_prompt(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) return reject(res, 401, "missing X-Tenant-Id");
  const json body = json::parse(req.body, nullptr, false);
  if (!body.is_object() || !body.contains("name") || !body["name"].is_string() || !body.contains("version") ||
      !body["version"].is_number_integer() || !body.contains("template") || !body["template"].is_string())
    return reject(res, 400, "name, version and template are required");
  const std::string template_text = body["template"].get<std::string>();
  std::vector<std::string> variables = body.value("variables", std::vector<std::string>{});
  std::sort(variables.begin(), variables.end());
  const json record = {{"name", body["name"]},
                       {"version", body["version"]},
                       {"content_hash", sha256_hex(template_text)},
                       {"template", template_text},
                       {"variables", variables}};
  versions::put(tenant, record);
  std::cerr << "prompt registered tenant=" << tenant << " name=" << record["name"] << " version=" << record["version"] << "\\n";
  res.status = 201;
  res.set_content(registration(record, true).dump(), "application/json");
}

void register_routes(httplib::Server& svr) { svr.Post("/v1/prompts", register_prompt); }

int main() {
  httplib::Server svr;
  register_routes(svr);
  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <algorithm>
#include <iostream>
#include <iterator>
#include <regex>
#include <set>
#include <string>
#include <vector>

#include "digest.h"            // sha256_hex(bytes) — provided
#include "prompts/config.h"    // config::kPlaceholder — provided
#include "prompts/versions.h"  // versions::get/by_hash/put(tenant, …) — provided

using json = nlohmann::json;

constexpr size_t kMaxTemplateBytes = 32 * 1024;
const std::set<std::string> kAllowedVariables = {"customer_name", "product", "tone", "locale", "question"};

void reject(httplib::Response& res, int status, const std::string& error) {
  res.status = status;
  res.set_content(json({{"error", error}}).dump(), "application/json");
}

// The answer: the version without its template.
json registration(const json& record, bool created) {
  return {{"name", record["name"]},
          {"version", record["version"]},
          {"content_hash", record["content_hash"]},
          {"variables", record["variables"]},
          {"created", created}};
}

void answer(httplib::Response& res, int status, const json& record, bool created) {
  res.status = status;
  res.set_content(registration(record, created).dump(), "application/json");
}

std::set<std::string> placeholders_of(const std::string& text) {
  std::set<std::string> out;
  for (auto it = std::sregex_iterator(text.begin(), text.end(), config::kPlaceholder); it != std::sregex_iterator(); ++it)
    out.insert((*it)[1].str());
  return out;
}

void register_prompt(const httplib::Request& req, httplib::Response& res) {
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) return reject(res, 401, "missing X-Tenant-Id");
  const json body = json::parse(req.body, nullptr, false);
  if (!body.is_object() || !body.contains("name") || !body["name"].is_string() || !body.contains("version") ||
      !body["version"].is_number_integer() || !body.contains("template") || !body["template"].is_string())
    return reject(res, 400, "name, version and template are required");
  const std::string name = body["name"].get<std::string>();
  const int version = body["version"].get<int>();
  const std::string template_text = body["template"].get<std::string>();
  if (template_text.size() > kMaxTemplateBytes) return reject(res, 413, "template exceeds 32 KiB");
  const auto listed = body.value("variables", std::vector<std::string>{});
  const std::set<std::string> declared(listed.begin(), listed.end());
  const bool allowed = std::all_of(declared.begin(), declared.end(), [](const std::string& v) { return kAllowedVariables.count(v) > 0; });
  if (placeholders_of(template_text) != declared || !allowed)
    return reject(res, 422, "placeholders must be exactly the declared variables, all allowed");

  const std::string content_hash = sha256_hex(template_text);
  // These bytes registered under another version answer that version: no second one.
  if (const auto same = versions::by_hash(tenant, name, content_hash); same && (*same)["version"].get<int>() != version)
    return answer(res, 200, *same, false);

  const json record = {{"name", name},
                       {"version", version},
                       {"content_hash", content_hash},
                       {"template", template_text},
                       {"variables", std::vector<std::string>(declared.begin(), declared.end())}};
  if (versions::put(tenant, record)) {
    std::cerr << "prompt registered tenant=" << tenant << " name=" << name << " version=" << version << "\\n";
    return answer(res, 201, record, true);
  }
  const auto existing = versions::get(tenant, name, version);
  if (!existing || (*existing)["content_hash"].get<std::string>() != content_hash)
    return reject(res, 409, "this version holds other bytes");
  answer(res, 200, *existing, false);
}

void register_routes(httplib::Server& svr) { svr.Post("/v1/prompts", register_prompt); }

int main() {
  httplib::Server svr;
  register_routes(svr);
  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  harness: {
    python: `import hashlib
import json

GOOD = {
    "name": "support-reply",
    "version": 3,
    "template": "Hi {{customer_name}}, thanks for asking about {{product}}.",
    "variables": ["customer_name", "product"],
}


def _api(ctx):
    return ctx.client(ctx.load("api").app)


async def _post(c, body, tenant="t1"):
    return await c.post("/v1/prompts", json=body, headers={"X-Tenant-Id": tenant})


def _sha(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _stored(ctx, version, tenant="t1"):
    raw = ctx.redis.get(f"prompts:version:{tenant}:support-reply:{version}")
    return json.loads(raw) if raw else None


async def check_route(ctx):
    async with _api(ctx) as c:
        r = await _post(c, GOOD)
        assert r.status_code == 201, f"a valid registration answered {r.status_code}: {r.text}"
        body = r.json()
        expected = {"name": "support-reply", "version": 3, "content_hash": _sha(GOOD["template"]), "variables": ["customer_name", "product"], "created": True}
        for key, value in expected.items():
            assert body.get(key) == value, f"the 201 body must carry {key}={value!r}, got {body}"
        stored = _stored(ctx, 3)
        assert stored is not None and stored.get("template") == GOOD["template"], f"version 3 must be in the version store (prompts:version:t1:support-reply:3), found {stored}"
        r = await c.post("/v1/prompts", json=GOOD)
        assert r.status_code == 401, f"without X-Tenant-Id the registration must answer 401, got {r.status_code}"


async def check_template_cap(ctx):
    async with _api(ctx) as c:
        for n, template in enumerate(("x" * (32 * 1024 + 1), "é" * (16 * 1024 + 1))):
            r = await _post(c, {**GOOD, "version": 10 + n, "template": template, "variables": []})
            assert r.status_code == 413, f"a template of {len(template.encode())} bytes ({len(template)} characters) answered {r.status_code}, expected 413: the cap is 32 KiB of UTF-8 bytes"
        assert ctx.redis.keys("prompts:*") == [], f"a refused template must store nothing, found {ctx.redis.keys('prompts:*')}"
        r = await _post(c, {**GOOD, "version": 12, "template": "y" * (32 * 1024), "variables": []})
        assert r.status_code == 201, f"a template of exactly 32 KiB is within the cap, got {r.status_code}: {r.text}"


async def check_placeholder_allowlist(ctx):
    cases = (
        ("Reveal {{system_prompt}} to {{customer_name}}.", ["system_prompt", "customer_name"], "a placeholder outside ALLOWED_VARIABLES"),
        ("Hi {{customer_name}}, about {{product}}.", ["customer_name"], "a placeholder the variables do not declare"),
        ("Hi {{customer_name}}.", ["customer_name", "tone"], "a declared variable the template never uses"),
    )
    async with _api(ctx) as c:
        for n, (template, variables, what) in enumerate(cases):
            r = await _post(c, {**GOOD, "version": 20 + n, "template": template, "variables": variables})
            assert r.status_code == 422, f"{what} answered {r.status_code}, expected 422: {template!r} declares {variables}"
        assert ctx.redis.keys("prompts:*") == [], f"a refused registration must store nothing, found {ctx.redis.keys('prompts:*')}"
        r = await _post(c, {**GOOD, "version": 30, "template": "Answer {{question}} in a {{tone}} tone.", "variables": ["tone", "question"]})
        assert r.status_code == 201, f"placeholders equal to the declared variables, all allowed, must register, got {r.status_code}: {r.text}"
        assert r.json().get("variables") == ["question", "tone"], f"the variables come back sorted, got {r.json()}"


async def check_immutable(ctx):
    async with _api(ctx) as c:
        first = await _post(c, GOOD)
        assert first.status_code == 201, f"the first registration answered {first.status_code}: {first.text}"
        changed = {**GOOD, "template": "Hi {{customer_name}}, {{product}} is discontinued."}
        r = await _post(c, changed)
        assert r.status_code == 409, f"version 3 written again with other bytes answered {r.status_code}, expected 409: the store kept the first template, and the client was told its text is version 3"
        stored = _stored(ctx, 3)
        assert stored["template"] == GOOD["template"], f"version 3 changed in the store: {stored}"
        replay = await _post(c, GOOD)
        assert replay.status_code == 200, f"a replay of version 3 with the same bytes answered {replay.status_code}, expected 200 (a client retrying after a timeout)"
        body = replay.json()
        assert body.get("created") is False and body.get("content_hash") == first.json()["content_hash"], f"a replay answers the stored version with created false, got {body}"


async def check_content_dedupe(ctx):
    async with _api(ctx) as c:
        first = await _post(c, GOOD)
        assert first.status_code == 201, f"the first registration answered {first.status_code}: {first.text}"
        r = await _post(c, {**GOOD, "version": 4})
        assert r.status_code == 200, f"the bytes of version 3 registered as version 4 answered {r.status_code}, expected 200 with version 3: one template, one version"
        body = r.json()
        assert body.get("version") == 3 and body.get("created") is False, f"the answer must be the existing version 3 with created false, got {body}"
        assert _stored(ctx, 4) is None, "version 4 was stored with the bytes of version 3: two numbers now name one template, and a rollback from 4 to 3 changes nothing"
        other = await _post(c, {**GOOD, "version": 4}, tenant="t2")
        assert other.status_code == 201 and other.json().get("version") == 4, f"another tenant registering the same bytes gets its own version (the store is per tenant), got {other.status_code}: {other.text}"
`,
    typescript: `import {createHash} from 'node:crypto';

const GOOD = {
  name: 'support-reply',
  version: 3,
  template: 'Hi {{customer_name}}, thanks for asking about {{product}}.',
  variables: ['customer_name', 'product'],
};

const api = ctx => ctx.client(ctx.load('api').app);
const post = (c, body, tenant = 't1') => c.post('/v1/prompts', {json: body, headers: {'X-Tenant-Id': tenant}});
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const stored = (ctx, version: number, tenant = 't1') => {
  const raw = ctx.redis.get(\`prompts:version:\${tenant}:support-reply:\${version}\`);
  return raw === null ? null : JSON.parse(raw);
};

export async function check_route(ctx) {
  const c = api(ctx);
  const r = await post(c, GOOD);
  assert.equal(r.status, 201, \`a valid registration answered \${r.status}: \${r.text}\`);
  const body = r.json();
  const expected = {name: 'support-reply', version: 3, content_hash: sha(GOOD.template), variables: ['customer_name', 'product'], created: true};
  for (const [key, value] of Object.entries(expected)) assert.deepEqual(body[key], value, \`the 201 body must carry \${key}=\${JSON.stringify(value)}, got \${r.text}\`);
  const record = stored(ctx, 3);
  assert(record !== null && record.template === GOOD.template, \`version 3 must be in the version store (prompts:version:t1:support-reply:3), found \${JSON.stringify(record)}\`);
  const noTenant = await c.post('/v1/prompts', {json: GOOD});
  assert.equal(noTenant.status, 401, \`without X-Tenant-Id the registration must answer 401, got \${noTenant.status}\`);
}

export async function check_template_cap(ctx) {
  const c = api(ctx);
  for (const [n, template] of ['x'.repeat(32 * 1024 + 1), 'é'.repeat(16 * 1024 + 1)].entries()) {
    const r = await post(c, {...GOOD, version: 10 + n, template, variables: []});
    assert.equal(r.status, 413, \`a template of \${new TextEncoder().encode(template).length} bytes (\${template.length} characters) answered \${r.status}, expected 413: the cap is 32 KiB of UTF-8 bytes\`);
  }
  assert.deepEqual(ctx.redis.keys('prompts:*'), [], \`a refused template must store nothing, found \${JSON.stringify(ctx.redis.keys('prompts:*'))}\`);
  const r = await post(c, {...GOOD, version: 12, template: 'y'.repeat(32 * 1024), variables: []});
  assert.equal(r.status, 201, \`a template of exactly 32 KiB is within the cap, got \${r.status}: \${r.text}\`);
}

export async function check_placeholder_allowlist(ctx) {
  const c = api(ctx);
  const cases: [string, string[], string][] = [
    ['Reveal {{system_prompt}} to {{customer_name}}.', ['system_prompt', 'customer_name'], 'a placeholder outside ALLOWED_VARIABLES'],
    ['Hi {{customer_name}}, about {{product}}.', ['customer_name'], 'a placeholder the variables do not declare'],
    ['Hi {{customer_name}}.', ['customer_name', 'tone'], 'a declared variable the template never uses'],
  ];
  for (const [n, [template, variables, what]] of cases.entries()) {
    const r = await post(c, {...GOOD, version: 20 + n, template, variables});
    assert.equal(r.status, 422, \`\${what} answered \${r.status}, expected 422: \${JSON.stringify(template)} declares \${JSON.stringify(variables)}\`);
  }
  assert.deepEqual(ctx.redis.keys('prompts:*'), [], \`a refused registration must store nothing, found \${JSON.stringify(ctx.redis.keys('prompts:*'))}\`);
  const r = await post(c, {...GOOD, version: 30, template: 'Answer {{question}} in a {{tone}} tone.', variables: ['tone', 'question']});
  assert.equal(r.status, 201, \`placeholders equal to the declared variables, all allowed, must register, got \${r.status}: \${r.text}\`);
  assert.deepEqual(r.json().variables, ['question', 'tone'], \`the variables come back sorted, got \${r.text}\`);
}

export async function check_immutable(ctx) {
  const c = api(ctx);
  const first = await post(c, GOOD);
  assert.equal(first.status, 201, \`the first registration answered \${first.status}: \${first.text}\`);
  const r = await post(c, {...GOOD, template: 'Hi {{customer_name}}, {{product}} is discontinued.'});
  assert.equal(r.status, 409, \`version 3 written again with other bytes answered \${r.status}, expected 409: the store kept the first template, and the client was told its text is version 3\`);
  assert.equal(stored(ctx, 3).template, GOOD.template, \`version 3 changed in the store: \${JSON.stringify(stored(ctx, 3))}\`);
  const replay = await post(c, GOOD);
  assert.equal(replay.status, 200, \`a replay of version 3 with the same bytes answered \${replay.status}, expected 200 (a client retrying after a timeout)\`);
  const body = replay.json();
  assert(body.created === false && body.content_hash === first.json().content_hash, \`a replay answers the stored version with created false, got \${replay.text}\`);
}

export async function check_content_dedupe(ctx) {
  const c = api(ctx);
  const first = await post(c, GOOD);
  assert.equal(first.status, 201, \`the first registration answered \${first.status}: \${first.text}\`);
  const r = await post(c, {...GOOD, version: 4});
  assert.equal(r.status, 200, \`the bytes of version 3 registered as version 4 answered \${r.status}, expected 200 with version 3: one template, one version\`);
  const body = r.json();
  assert(body.version === 3 && body.created === false, \`the answer must be the existing version 3 with created false, got \${r.text}\`);
  assert.equal(stored(ctx, 4), null, 'version 4 was stored with the bytes of version 3: two numbers now name one template, and a rollback from 4 to 3 changes nothing');
  const other = await post(c, {...GOOD, version: 4}, 't2');
  assert(other.status === 201 && other.json().version === 4, \`another tenant registering the same bytes gets its own version (the store is per tenant), got \${other.status}: \${other.text}\`);
}
`,
    go: `package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"

	"leetbuild/harness"
)

var apiGood = map[string]any{
	"name":      "support-reply",
	"version":   3,
	"template":  "Hi {{customer_name}}, thanks for asking about {{product}}.",
	"variables": []string{"customer_name", "product"},
}

func apiClient(ctx *harness.Ctx) *harness.HTTP {
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

func apiWith(overrides map[string]any) map[string]any {
	out := map[string]any{}
	for k, v := range apiGood {
		out[k] = v
	}
	for k, v := range overrides {
		out[k] = v
	}
	return out
}

func apiPost(c *harness.HTTP, body map[string]any, tenant string) *harness.Response {
	return c.Post("/v1/prompts", body, "X-Tenant-Id", tenant)
}

func apiBody(ctx *harness.Ctx, r *harness.Response) map[string]any {
	body, ok := r.JSON().(map[string]any)
	ctx.Assert(ok, "the body must be a JSON object: %s", r.Text())
	return body
}

func apiSha(text string) string {
	sum := sha256.Sum256([]byte(text))
	return hex.EncodeToString(sum[:])
}

func apiStored(ctx *harness.Ctx, tenant string, version int) map[string]any {
	raw, ok := ctx.Redis.Get("prompts:version:" + tenant + ":support-reply:" + strconv.Itoa(version))
	if !ok {
		return nil
	}
	var record map[string]any
	ctx.NoError(json.Unmarshal([]byte(raw), &record), "the stored version is JSON: %s", raw)
	return record
}

func CheckRoute(ctx *harness.Ctx) {
	c := apiClient(ctx)
	r := apiPost(c, apiGood, "t1")
	ctx.Equal(r.Status, 201, "a valid registration (%s)", r.Text())
	body := apiBody(ctx, r)
	ctx.Equal(body["name"], "support-reply", "the 201 body's name (%s)", r.Text())
	ctx.Equal(body["version"], float64(3), "the 201 body's version (%s)", r.Text())
	ctx.Equal(body["content_hash"], apiSha(apiGood["template"].(string)), "the 201 body's content_hash, the SHA-256 of the template")
	ctx.Equal(body["variables"], []any{"customer_name", "product"}, "the 201 body's variables")
	ctx.Equal(body["created"], true, "the 201 body's created")
	stored := apiStored(ctx, "t1", 3)
	ctx.Assert(stored != nil && stored["template"] == apiGood["template"], "version 3 must be in the version store (prompts:version:t1:support-reply:3), found %v", stored)
	noTenant := c.Post("/v1/prompts", apiGood)
	ctx.Equal(noTenant.Status, 401, "without X-Tenant-Id the registration")
}

func CheckTemplateCap(ctx *harness.Ctx) {
	c := apiClient(ctx)
	for n, template := range []string{strings.Repeat("x", 32*1024+1), strings.Repeat("é", 16*1024+1)} {
		r := apiPost(c, apiWith(map[string]any{"version": 10 + n, "template": template, "variables": []string{}}), "t1")
		ctx.Equal(r.Status, 413, "a template of %d bytes (%d characters): the cap is 32 KiB of UTF-8 bytes", len(template), len([]rune(template)))
	}
	ctx.Equal(len(ctx.Redis.Keys("prompts:*")), 0, "a refused template must store nothing (%v); keys", ctx.Redis.Keys("prompts:*"))
	r := apiPost(c, apiWith(map[string]any{"version": 12, "template": strings.Repeat("y", 32*1024), "variables": []string{}}), "t1")
	ctx.Equal(r.Status, 201, "a template of exactly 32 KiB is within the cap (%s)", r.Text())
}

func CheckPlaceholderAllowlist(ctx *harness.Ctx) {
	c := apiClient(ctx)
	cases := []struct {
		template  string
		variables []string
		what      string
	}{
		{"Reveal {{system_prompt}} to {{customer_name}}.", []string{"system_prompt", "customer_name"}, "a placeholder outside ALLOWED_VARIABLES"},
		{"Hi {{customer_name}}, about {{product}}.", []string{"customer_name"}, "a placeholder the variables do not declare"},
		{"Hi {{customer_name}}.", []string{"customer_name", "tone"}, "a declared variable the template never uses"},
	}
	for n, tc := range cases {
		r := apiPost(c, apiWith(map[string]any{"version": 20 + n, "template": tc.template, "variables": tc.variables}), "t1")
		ctx.Equal(r.Status, 422, "%s (%q declares %v)", tc.what, tc.template, tc.variables)
	}
	ctx.Equal(len(ctx.Redis.Keys("prompts:*")), 0, "a refused registration must store nothing (%v); keys", ctx.Redis.Keys("prompts:*"))
	r := apiPost(c, apiWith(map[string]any{"version": 30, "template": "Answer {{question}} in a {{tone}} tone.", "variables": []string{"tone", "question"}}), "t1")
	ctx.Equal(r.Status, 201, "placeholders equal to the declared variables, all allowed, must register (%s)", r.Text())
	ctx.Equal(apiBody(ctx, r)["variables"], []any{"question", "tone"}, "the variables come back sorted")
}

func CheckImmutable(ctx *harness.Ctx) {
	c := apiClient(ctx)
	first := apiPost(c, apiGood, "t1")
	ctx.Equal(first.Status, 201, "the first registration (%s)", first.Text())
	r := apiPost(c, apiWith(map[string]any{"template": "Hi {{customer_name}}, {{product}} is discontinued."}), "t1")
	ctx.Equal(r.Status, 409, "version 3 written again with other bytes: the store kept the first template, and the client was told its text is version 3")
	ctx.Equal(apiStored(ctx, "t1", 3)["template"], apiGood["template"], "version 3 in the store")
	replay := apiPost(c, apiGood, "t1")
	ctx.Equal(replay.Status, 200, "a replay of version 3 with the same bytes (a client retrying after a timeout)")
	body := apiBody(ctx, replay)
	ctx.Assert(body["created"] == false && body["content_hash"] == apiBody(ctx, first)["content_hash"], "a replay answers the stored version with created false, got %s", replay.Text())
}

func CheckContentDedupe(ctx *harness.Ctx) {
	c := apiClient(ctx)
	first := apiPost(c, apiGood, "t1")
	ctx.Equal(first.Status, 201, "the first registration (%s)", first.Text())
	r := apiPost(c, apiWith(map[string]any{"version": 4}), "t1")
	ctx.Equal(r.Status, 200, "the bytes of version 3 registered as version 4 must answer version 3: one template, one version")
	body := apiBody(ctx, r)
	ctx.Assert(body["version"] == float64(3) && body["created"] == false, "the answer must be the existing version 3 with created false, got %s", r.Text())
	ctx.Assert(apiStored(ctx, "t1", 4) == nil, "version 4 was stored with the bytes of version 3: two numbers now name one template, and a rollback from 4 to 3 changes nothing")
	other := apiPost(c, apiWith(map[string]any{"version": 4}), "t2")
	ctx.Assert(other.Status == 201 && apiBody(ctx, other)["version"] == float64(4), "another tenant registering the same bytes gets its own version (the store is per tenant), got %d: %s", other.Status, other.Text())
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <optional>
#include <string>
#include <vector>

#include "digest.h"

namespace {

using json = nlohmann::json;

const json kGood = {{"name", "support-reply"},
                    {"version", 3},
                    {"template", "Hi {{customer_name}}, thanks for asking about {{product}}."},
                    {"variables", {"customer_name", "product"}}};

struct Api {
  httplib::Server svr;
  harness::HTTP http;
  explicit Api(harness::Ctx& ctx) : http(ctx.HTTP(svr)) { register_routes(svr); }

  harness::Response post(const json& body, const std::string& tenant = "t1") {
    return http.Post("/v1/prompts", body.dump(), "X-Tenant-Id", tenant);
  }
};

json with(json body, const json& overrides) {
  for (const auto& [key, value] : overrides.items()) body[key] = value;
  return body;
}

json bodyOf(harness::Ctx& ctx, const harness::Response& r) {
  const json body = json::parse(r.Text(), nullptr, false);
  ctx.Assert(body.is_object(), "the body must be a JSON object: %s", r.Text());
  return body;
}

std::optional<json> stored(harness::Ctx& ctx, const std::string& tenant, int version) {
  const auto raw = ctx.Redis.Get("prompts:version:" + tenant + ":support-reply:" + std::to_string(version));
  if (!raw) return std::nullopt;
  return json::parse(*raw, nullptr, false);
}

}  // namespace

void CheckRoute(harness::Ctx& ctx) {
  Api api(ctx);
  const auto r = api.post(kGood);
  ctx.Equal(r.Status, 201, "a valid registration (%s)", r.Text());
  const json body = bodyOf(ctx, r);
  ctx.Equal(body.value("name", ""), "support-reply", "the 201 body's name (%s)", r.Text());
  ctx.Equal(body.value("version", 0), 3, "the 201 body's version (%s)", r.Text());
  ctx.Equal(body.value("content_hash", ""), sha256_hex(kGood["template"].get<std::string>()), "the 201 body's content_hash, the SHA-256 of the template");
  ctx.Equal(body.contains("variables") ? body["variables"] : json(), json({"customer_name", "product"}), "the 201 body's variables");
  ctx.Equal(body.value("created", false), true, "the 201 body's created");
  const auto record = stored(ctx, "t1", 3);
  ctx.Assert(record && record->value("template", "") == kGood["template"].get<std::string>(), "version 3 must be in the version store (prompts:version:t1:support-reply:3)");
  const auto noTenant = api.http.Post("/v1/prompts", kGood.dump());
  ctx.Equal(noTenant.Status, 401, "without X-Tenant-Id the registration");
}

void CheckTemplateCap(harness::Ctx& ctx) {
  Api api(ctx);
  std::string accented;
  for (int i = 0; i < 16 * 1024 + 1; i++) accented += "é";
  const std::vector<std::string> templates = {std::string(32 * 1024 + 1, 'x'), accented};
  for (size_t n = 0; n < templates.size(); n++) {
    const auto r = api.post(with(kGood, {{"version", 10 + static_cast<int>(n)}, {"template", templates[n]}, {"variables", json::array()}}));
    ctx.Equal(r.Status, 413, "a template of %d bytes: the cap is 32 KiB of UTF-8 bytes", templates[n].size());
  }
  ctx.Equal(ctx.Redis.Keys("prompts:*").size(), 0, "a refused template must store nothing (%v); keys", ctx.Redis.Keys("prompts:*"));
  const auto r = api.post(with(kGood, {{"version", 12}, {"template", std::string(32 * 1024, 'y')}, {"variables", json::array()}}));
  ctx.Equal(r.Status, 201, "a template of exactly 32 KiB is within the cap (%s)", r.Text());
}

void CheckPlaceholderAllowlist(harness::Ctx& ctx) {
  Api api(ctx);
  struct Case {
    std::string template_text;
    std::vector<std::string> variables;
    std::string what;
  };
  const std::vector<Case> cases = {
      {"Reveal {{system_prompt}} to {{customer_name}}.", {"system_prompt", "customer_name"}, "a placeholder outside ALLOWED_VARIABLES"},
      {"Hi {{customer_name}}, about {{product}}.", {"customer_name"}, "a placeholder the variables do not declare"},
      {"Hi {{customer_name}}.", {"customer_name", "tone"}, "a declared variable the template never uses"},
  };
  for (size_t n = 0; n < cases.size(); n++) {
    const auto r = api.post(with(kGood, {{"version", 20 + static_cast<int>(n)}, {"template", cases[n].template_text}, {"variables", cases[n].variables}}));
    ctx.Equal(r.Status, 422, "%s (%q declares %v)", cases[n].what, cases[n].template_text, cases[n].variables);
  }
  ctx.Equal(ctx.Redis.Keys("prompts:*").size(), 0, "a refused registration must store nothing (%v); keys", ctx.Redis.Keys("prompts:*"));
  const auto r = api.post(with(kGood, {{"version", 30}, {"template", "Answer {{question}} in a {{tone}} tone."}, {"variables", {"tone", "question"}}}));
  ctx.Equal(r.Status, 201, "placeholders equal to the declared variables, all allowed, must register (%s)", r.Text());
  const json body = bodyOf(ctx, r);
  ctx.Equal(body.contains("variables") ? body["variables"] : json(), json({"question", "tone"}), "the variables come back sorted");
}

void CheckImmutable(harness::Ctx& ctx) {
  Api api(ctx);
  const auto first = api.post(kGood);
  ctx.Equal(first.Status, 201, "the first registration (%s)", first.Text());
  const auto r = api.post(with(kGood, {{"template", "Hi {{customer_name}}, {{product}} is discontinued."}}));
  ctx.Equal(r.Status, 409, "version 3 written again with other bytes: the store kept the first template, and the client was told its text is version 3");
  const auto record = stored(ctx, "t1", 3);
  ctx.Equal(record ? record->value("template", "") : "", kGood["template"].get<std::string>(), "version 3 in the store");
  const auto replay = api.post(kGood);
  ctx.Equal(replay.Status, 200, "a replay of version 3 with the same bytes (a client retrying after a timeout)");
  const json body = bodyOf(ctx, replay);
  ctx.Assert(body.value("created", true) == false && body.value("content_hash", "") == bodyOf(ctx, first).value("content_hash", "-"),
             "a replay answers the stored version with created false, got %s", replay.Text());
}

void CheckContentDedupe(harness::Ctx& ctx) {
  Api api(ctx);
  const auto first = api.post(kGood);
  ctx.Equal(first.Status, 201, "the first registration (%s)", first.Text());
  const auto r = api.post(with(kGood, {{"version", 4}}));
  ctx.Equal(r.Status, 200, "the bytes of version 3 registered as version 4 must answer version 3: one template, one version");
  const json body = bodyOf(ctx, r);
  ctx.Assert(body.value("version", 0) == 3 && body.value("created", true) == false, "the answer must be the existing version 3 with created false, got %s", r.Text());
  ctx.Assert(!stored(ctx, "t1", 4), "version 4 was stored with the bytes of version 3: two numbers now name one template, and a rollback from 4 to 3 changes nothing");
  const auto other = api.post(with(kGood, {{"version", 4}}), "t2");
  ctx.Assert(other.Status == 201 && bodyOf(ctx, other).value("version", 0) == 4,
             "another tenant registering the same bytes gets its own version (the store is per tenant), got %d: %s", other.Status, other.Text());
}
`,
  },
  hints: [
    'Symptom: a client that rewrote version 3 was told 201 and caches text the registry never stored, the same template shows up as versions 3 and 4, and a 40 KB template with a `{{system_prompt}}` slot is accepted.',
    'Mechanism: `versions.put` is set-if-absent and returns false for an existing version, but the handler answers 201 without reading it; nothing looks the bytes up by hash, measures them in bytes, or compares the placeholders with `variables`.',
    'Change: guards first (413 over `MAX_TEMPLATE_BYTES` UTF-8 bytes; 422 unless the `PLACEHOLDER` matches equal `variables`, all in `ALLOWED_VARIABLES`), then `versions.by_hash` (200 for another version), then `versions.put`; on false, 200 for the same hash, 409 otherwise.',
  ],
  debrief: `Immutability is enforced where the write lands: \`put\` is set-if-absent, so the handler reads its answer instead of looking first and hoping nothing lands in between, and a lost race becomes a 409 or a replay rather than a silent overwrite. The content hash is the version's identity for everything downstream (the eval gate keys its verdict by it, the read attaches the eval of exactly those bytes), which is why identical bytes resolve to the version that already holds them. The allowlist protects the read path: a slot no caller may fill is either dead text the model receives or a place someone fills with what they should not. A production registry also decides who may register under a name, an authorization question this step leaves to the gateway.`,
};
