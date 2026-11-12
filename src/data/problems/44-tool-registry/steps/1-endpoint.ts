import type {Step} from '@/lib/types';

export const endpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/tools: registration is a change with an owner',
  concept: 'http',
  guides: ['request-boundaries', 'idempotent-requests'],
  file: 'api',
  focus: ['client', 'registry', 'db', 'reviewer'],
  task: `## Task

**Starting point.** The starter serves \`POST /v1/tools\` (body \`{name, version, schema, side_effect,
owner, endpoint, credential_ref}\`) on the tool store (\`toolsd.store\`, provided): it answers 401
without \`X-Tenant-Id\`, stores the body under the caller's \`version\` with \`store.put\` and answers
201 \`{name, version, side_effect, owner}\`. It serves the demo and hides four flaws.

**Failure mode the checks target.** Any authenticated service account can mint a tool; a side-effect
class nobody can reason about and a schema no agent can fill are stored as sent; and a
re-registration under a reused version label replaces the definition agents are running against.

- \`X-Roles\` (comma-separated) must hold \`platform-reviewer\` exactly; anything else is **403**,
  before any write.
- \`name\` matches \`^[a-z][a-z0-9_.-]{1,63}$\` and \`side_effect\` is \`read\`, \`write\` or
  \`irreversible\`; otherwise **400**.
- The schema has \`type: object\`, a \`type\` on every property and every \`required\` name declared.
  An invalid one is **422** with \`{"errors": [{pointer, message}]}\`, one JSON pointer per failure
  (\`/type\`, \`/properties/amount/type\`, \`/required/1\`).
- The version is minted from the content: sha256 of the canonical JSON of \`name\`, \`owner\`,
  \`schema\` and \`side_effect\`, first 16 hex characters; the caller's \`version\` is ignored. Store
  with \`store.insert\`, which refuses an existing version: **409**.`,
  sequence: {
    participants: ['Reviewer', 'toolsd', 'tool store'],
    messages: [
      {from: 'Reviewer', to: 'toolsd', label: 'POST /v1/tools · X-Tenant-Id · X-Roles', kind: 'sync'},
      {from: 'toolsd', to: 'toolsd', label: 'platform-reviewer? → 403', kind: 'sync'},
      {from: 'toolsd', to: 'toolsd', label: 'name · side_effect → 400 · schema → 422 + pointers', kind: 'sync'},
      {from: 'toolsd', to: 'toolsd', label: 'version = sha256(canonical definition)[:16]', kind: 'sync'},
      {from: 'toolsd', to: 'tool store', label: 'insert(name, version, row)', kind: 'sync'},
      {from: 'tool store', to: 'toolsd', label: 'created / exists → 409', kind: 'reply'},
      {from: 'toolsd', to: 'Reviewer', label: '201 {name, version, side_effect, owner}', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Handles POST /v1/tools',
      detail: 'Register the registration route on `POST /v1/tools`; a request without `X-Tenant-Id` is 401.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/tools["']/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/tools['"]/]},
        go: {all: [/HandleFunc\(\s*"POST \/v1\/tools"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"tools"\s*\)/, /\bpost\s*\{/]},
        cpp: {all: [/svr\.Post\(\s*"\/v1\/tools"/]},
      },
    },
    {
      id: 'role',
      title: 'Only the platform reviewer role may register',
      detail:
        '`X-Roles` is split on commas and must contain `platform-reviewer` as one role; anything else is **403** before any write. The starter stops at authentication, so every service account can mint tools.',
      match: {
        python: {all: [/["']platform-reviewer["']/, /x-roles/i, /\b403\b/]},
        typescript: {all: [/['"]platform-reviewer['"]/, /x-roles/i, /\b403\b/]},
        go: {all: [/"platform-reviewer"/, /X-Roles/i, /StatusForbidden|\b403\b/]},
        scala: {all: [/"platform-reviewer"/, /X-Roles/i, /Forbidden/]},
        cpp: {all: [/"platform-reviewer"/, /X-Roles/i, /\b403\b/]},
      },
    },
    {
      id: 'side-effect',
      title: 'Requires a declared side-effect class',
      detail:
        '`side_effect` is checked against the closed set `read` / `write` / `irreversible` (and `name` against its pattern); anything else is **400**. The starter stores whatever string arrives.',
      match: {
        python: {all: [/["']irreversible["']/, /\b400\b/]},
        typescript: {all: [/['"]irreversible['"]/, /\b400\b/]},
        go: {all: [/"irreversible"/, /StatusBadRequest|\b400\b/]},
        scala: {all: [/"irreversible"/, /BadRequest/]},
        cpp: {all: [/"irreversible"/, /\b400\b/]},
      },
    },
    {
      id: 'schema',
      title: 'Validates the schema and names the failing pointer',
      detail:
        'The schema is validated before the write and an invalid one is **422** with the JSON pointer of each failure. The starter stores any object as a schema, so the breakage lands in the agent that cannot build arguments.',
      match: {
        python: {all: [/\b422\b/, /pointer/, /["']required["']/]},
        typescript: {all: [/\b422\b/, /pointer/, /['"]required['"]|\.required\b/]},
        go: {all: [/StatusUnprocessableEntity|\b422\b/, /pointer/i, /"required"/]},
        scala: {all: [/UnprocessableEntity/, /pointer/, /"required"/]},
        cpp: {all: [/\b422\b/, /pointer/, /"required"/]},
      },
    },
    {
      id: 'version',
      title: 'Mints an immutable version and refuses to overwrite it',
      detail:
        "The version is a sha256 digest of the definition, not the caller's label, and it is stored with `insert`, which refuses an existing version (**409**). The starter stores under the caller's label with `put`, so a re-registration replaces what agents are calling.",
      match: {
        python: {
          all: [/hashlib\.sha256\(/, /store\.insert\(/, /\b409\b/],
          none: [/store\.put\(/, /\[["']version["']\]/],
        },
        typescript: {
          all: [/createHash\(\s*['"]sha256['"]/, /\binsert\(/, /\b409\b/],
          none: [/\bput\(/, /body\.version\b/],
        },
        go: {
          all: [/sha256\.Sum256\(/, /store\.Insert\(/, /StatusConflict|\b409\b/],
          none: [/store\.Put\(/, /\.Version\b/],
        },
        scala: {
          all: [/MessageDigest\.getInstance\(\s*"SHA-256"/, /Store\.insert\(/, /Conflict/],
          none: [/Store\.put\(/, /"version"\s*\)/],
        },
        cpp: {
          all: [/SHA256\(/, /store::insert\(/, /\b409\b/],
          none: [/store::put\(/, /value\(\s*"version"/],
        },
      },
    },
  ],
  code: {
    python: {
      starter: `from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse

from toolsd import store  # store.get, store.put, store.insert

app = FastAPI()


@app.post("/v1/tools", status_code=201)
async def register(request: Request) -> JSONResponse:
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    tenant = request.headers.get("x-tenant-id", "")
    if not tenant:
        raise HTTPException(status_code=401, detail="missing X-Tenant-Id")
    body = await request.json()
    row = {field: body.get(field, "") for field in ("side_effect", "owner", "schema", "endpoint", "credential_ref")}
    store.put(body["name"], body["version"], row)
    return JSONResponse(
        {"name": body["name"], "version": body["version"], "side_effect": row["side_effect"], "owner": row["owner"]},
        status_code=201,
    )
`,
      solution: `import hashlib
import json
import re

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse

from toolsd import store  # store.get, store.put, store.insert

app = FastAPI()

PLATFORM_REVIEWER_ROLE = "platform-reviewer"
SIDE_EFFECT_CLASSES = ("read", "write", "irreversible")
NAME_PATTERN = re.compile(r"^[a-z][a-z0-9_.-]{1,63}$")
VERSION_CHARS = 16


def validate_schema(schema) -> list[dict]:
    """The JSON pointer of every place an agent could not build arguments from."""
    if not isinstance(schema, dict) or schema.get("type") != "object":
        return [{"pointer": "/type", "message": "the schema's type must be object"}]
    properties = schema.get("properties", {})
    if not isinstance(properties, dict):
        return [{"pointer": "/properties", "message": "properties must be an object"}]
    errors = [
        {"pointer": f"/properties/{name}/type", "message": "every property needs a type"}
        for name, prop in sorted(properties.items())
        if not isinstance(prop, dict) or "type" not in prop
    ]
    for i, name in enumerate(schema.get("required", [])):
        if name not in properties:
            errors.append({"pointer": f"/required/{i}", "message": f"{name} is required but not declared"})
    return errors


def mint_version(name: str, schema: dict, side_effect: str, owner: str) -> str:
    """The version is the definition's digest: one definition, one version, whatever the caller calls it."""
    canonical = json.dumps(
        {"name": name, "owner": owner, "schema": schema, "side_effect": side_effect}, sort_keys=True, separators=(",", ":")
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:VERSION_CHARS]


@app.post("/v1/tools", status_code=201)
async def register(request: Request) -> JSONResponse:
    tenant = request.headers.get("x-tenant-id", "")
    if not tenant:
        raise HTTPException(status_code=401, detail="missing X-Tenant-Id")
    roles = {role.strip() for role in request.headers.get("x-roles", "").split(",")}
    if PLATFORM_REVIEWER_ROLE not in roles:
        raise HTTPException(status_code=403, detail="registering a tool takes the platform-reviewer role")
    body = await request.json()
    name = body.get("name")
    if not isinstance(name, str) or NAME_PATTERN.match(name) is None:
        raise HTTPException(status_code=400, detail="name must match ^[a-z][a-z0-9_.-]{1,63}$")
    side_effect = body.get("side_effect")
    if side_effect not in SIDE_EFFECT_CLASSES:
        raise HTTPException(status_code=400, detail="side_effect must be read, write or irreversible")
    errors = validate_schema(body.get("schema"))
    if errors:
        return JSONResponse({"errors": errors}, status_code=422)
    owner = str(body.get("owner", ""))
    version = mint_version(name, body["schema"], side_effect, owner)
    row = {
        "side_effect": side_effect,
        "owner": owner,
        "schema": body["schema"],
        "endpoint": str(body.get("endpoint", "")),
        "credential_ref": str(body.get("credential_ref", "")),
    }
    if not store.insert(name, version, row):
        raise HTTPException(status_code=409, detail=f"{name} {version} is already registered")
    return JSONResponse({"name": name, "version": version, "side_effect": side_effect, "owner": owner}, status_code=201)
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';

import {type Row, get, insert, put} from 'toolsd/store';

export const app = Fastify();

interface RegistrationBody extends Row {
  version: string;
}

app.post('/v1/tools', async (request, reply) => {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing X-Tenant-Id'});
  const body = request.body as RegistrationBody;
  await put(body.name, body.version, body);
  return reply.code(201).send({name: body.name, version: body.version, side_effect: body.side_effect, owner: body.owner});
});
`,
      solution: `import {createHash} from 'node:crypto';

import Fastify from 'fastify';

import {type Row, get, insert, put} from 'toolsd/store';

export const app = Fastify();

export const PLATFORM_REVIEWER_ROLE = 'platform-reviewer';
export const SIDE_EFFECT_CLASSES = ['read', 'write', 'irreversible'];
const NAME_PATTERN = /^[a-z][a-z0-9_.-]{1,63}$/;
const VERSION_CHARS = 16;

interface SchemaError {
  pointer: string;
  message: string;
}

/** The JSON pointer of every place an agent could not build arguments from. */
export function validateSchema(schema: unknown): SchemaError[] {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema) || (schema as Record<string, unknown>).type !== 'object') {
    return [{pointer: '/type', message: "the schema's type must be object"}];
  }
  const doc = schema as {properties?: unknown; required?: unknown};
  const properties = doc.properties ?? {};
  if (typeof properties !== 'object' || properties === null || Array.isArray(properties)) {
    return [{pointer: '/properties', message: 'properties must be an object'}];
  }
  const declared = properties as Record<string, unknown>;
  const errors: SchemaError[] = Object.keys(declared)
    .sort()
    .filter(name => {
      const prop = declared[name];
      return prop === null || typeof prop !== 'object' || !('type' in prop);
    })
    .map(name => ({pointer: \`/properties/\${name}/type\`, message: 'every property needs a type'}));
  const required = Array.isArray(doc.required) ? doc.required : [];
  required.forEach((name, i) => {
    if (typeof name !== 'string' || !Object.hasOwn(declared, name)) errors.push({pointer: \`/required/\${i}\`, message: \`\${name} is required but not declared\`});
  });
  return errors;
}

/** JSON with every object's keys sorted, so one definition has one digest. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return \`[\${value.map(canonical).join(',')}]\`;
  if (value !== null && typeof value === 'object') {
    const doc = value as Record<string, unknown>;
    return \`{\${Object.keys(doc)
      .sort()
      .map(key => \`\${JSON.stringify(key)}:\${canonical(doc[key])}\`)
      .join(',')}}\`;
  }
  return JSON.stringify(value);
}

/** The version is the definition's digest: one definition, one version, whatever the caller calls it. */
export function mintVersion(name: string, schema: unknown, sideEffect: string, owner: string): string {
  const digest = createHash('sha256').update(canonical({name, owner, schema, side_effect: sideEffect})).digest('hex');
  return digest.slice(0, VERSION_CHARS);
}

app.post('/v1/tools', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing X-Tenant-Id'});
  const roles = String(request.headers['x-roles'] ?? '')
    .split(',')
    .map(role => role.trim());
  if (!roles.includes(PLATFORM_REVIEWER_ROLE)) return reply.code(403).send({error: 'registering a tool takes the platform-reviewer role'});
  const body = request.body as Partial<Row>;
  if (typeof body.name !== 'string' || !NAME_PATTERN.test(body.name)) return reply.code(400).send({error: 'name must match ^[a-z][a-z0-9_.-]{1,63}$'});
  if (typeof body.side_effect !== 'string' || !SIDE_EFFECT_CLASSES.includes(body.side_effect)) {
    return reply.code(400).send({error: 'side_effect must be read, write or irreversible'});
  }
  const errors = validateSchema(body.schema);
  if (errors.length > 0) return reply.code(422).send({errors});
  const owner = String(body.owner ?? '');
  const version = mintVersion(body.name, body.schema, body.side_effect, owner);
  const row: Row = {
    name: body.name,
    version,
    side_effect: body.side_effect,
    owner,
    schema: body.schema as Record<string, unknown>,
    endpoint: String(body.endpoint ?? ''),
    credential_ref: String(body.credential_ref ?? ''),
  };
  if (!(await insert(body.name, version, row))) return reply.code(409).send({error: \`\${body.name} \${version} is already registered\`});
  return reply.code(201).send({name: body.name, version, side_effect: body.side_effect, owner});
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"net/http"

	"toolsd/store" // store.Get, store.Put, store.Insert
)

type registration struct {
	Name          string \`json:"name"\`
	Version       string \`json:"version"\`
	Schema        any    \`json:"schema"\`
	SideEffect    string \`json:"side_effect"\`
	Owner         string \`json:"owner"\`
	Endpoint      string \`json:"endpoint"\`
	CredentialRef string \`json:"credential_ref"\`
}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func registerTool(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	if r.Header.Get("X-Tenant-Id") == "" {
		http.Error(rw, "missing X-Tenant-Id", http.StatusUnauthorized)
		return
	}
	var body registration
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(rw, err.Error(), http.StatusBadRequest)
		return
	}
	row := store.Row{"side_effect": body.SideEffect, "owner": body.Owner, "schema": body.Schema, "endpoint": body.Endpoint, "credential_ref": body.CredentialRef}
	if err := store.Put(r.Context(), body.Name, body.Version, row); err != nil {
		http.Error(rw, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(rw, http.StatusCreated, map[string]string{"name": body.Name, "version": body.Version, "side_effect": body.SideEffect, "owner": body.Owner})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/tools", registerTool)
}
`,
      solution: `package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"regexp"
	"sort"
	"strings"

	"toolsd/store" // store.Get, store.Put, store.Insert
)

const (
	platformReviewerRole = "platform-reviewer"
	versionChars         = 16
)

var (
	sideEffectClasses = map[string]bool{"read": true, "write": true, "irreversible": true}
	namePattern       = regexp.MustCompile(\`^[a-z][a-z0-9_.-]{1,63}$\`)
)

type registration struct {
	Name          string \`json:"name"\`
	Schema        any    \`json:"schema"\`
	SideEffect    string \`json:"side_effect"\`
	Owner         string \`json:"owner"\`
	Endpoint      string \`json:"endpoint"\`
	CredentialRef string \`json:"credential_ref"\`
}

type schemaError struct {
	Pointer string \`json:"pointer"\`
	Message string \`json:"message"\`
}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

// validateSchema is the JSON pointer of every place an agent could not build arguments from.
func validateSchema(schema any) []schemaError {
	doc, isObject := schema.(map[string]any)
	kind, _ := doc["type"].(string)
	if !isObject || kind != "object" {
		return []schemaError{{Pointer: "/type", Message: "the schema's type must be object"}}
	}
	properties := map[string]any{}
	if raw, present := doc["properties"]; present {
		declared, ok := raw.(map[string]any)
		if !ok {
			return []schemaError{{Pointer: "/properties", Message: "properties must be an object"}}
		}
		properties = declared
	}
	names := make([]string, 0, len(properties))
	for name := range properties {
		names = append(names, name)
	}
	sort.Strings(names)
	var errs []schemaError
	for _, name := range names {
		prop, ok := properties[name].(map[string]any)
		if _, typed := prop["type"]; !ok || !typed {
			errs = append(errs, schemaError{Pointer: "/properties/" + name + "/type", Message: "every property needs a type"})
		}
	}
	required, _ := doc["required"].([]any)
	for i, raw := range required {
		name, _ := raw.(string)
		if _, declared := properties[name]; !declared {
			errs = append(errs, schemaError{Pointer: fmt.Sprintf("/required/%d", i), Message: name + " is required but not declared"})
		}
	}
	return errs
}

// mintVersion is the definition's digest: one definition, one version, whatever the caller calls it.
// json.Marshal sorts map keys, so the encoding is canonical.
func mintVersion(name string, schema any, sideEffect, owner string) string {
	canonical, _ := json.Marshal(map[string]any{"name": name, "owner": owner, "schema": schema, "side_effect": sideEffect})
	sum := sha256.Sum256(canonical)
	return hex.EncodeToString(sum[:])[:versionChars]
}

func hasRole(header, role string) bool {
	for _, granted := range strings.Split(header, ",") {
		if strings.TrimSpace(granted) == role {
			return true
		}
	}
	return false
}

func registerTool(rw http.ResponseWriter, r *http.Request) {
	if r.Header.Get("X-Tenant-Id") == "" {
		http.Error(rw, "missing X-Tenant-Id", http.StatusUnauthorized)
		return
	}
	if !hasRole(r.Header.Get("X-Roles"), platformReviewerRole) {
		http.Error(rw, "registering a tool takes the platform-reviewer role", http.StatusForbidden)
		return
	}
	var body registration
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(rw, err.Error(), http.StatusBadRequest)
		return
	}
	if !namePattern.MatchString(body.Name) {
		http.Error(rw, "name must match ^[a-z][a-z0-9_.-]{1,63}$", http.StatusBadRequest)
		return
	}
	if !sideEffectClasses[body.SideEffect] {
		http.Error(rw, "side_effect must be read, write or irreversible", http.StatusBadRequest)
		return
	}
	if errs := validateSchema(body.Schema); len(errs) > 0 {
		writeJSON(rw, http.StatusUnprocessableEntity, map[string]any{"errors": errs})
		return
	}
	version := mintVersion(body.Name, body.Schema, body.SideEffect, body.Owner)
	row := store.Row{"side_effect": body.SideEffect, "owner": body.Owner, "schema": body.Schema, "endpoint": body.Endpoint, "credential_ref": body.CredentialRef}
	created, err := store.Insert(r.Context(), body.Name, version, row)
	if err != nil {
		http.Error(rw, err.Error(), http.StatusInternalServerError)
		return
	}
	if !created {
		http.Error(rw, body.Name+" "+version+" is already registered", http.StatusConflict)
		return
	}
	writeJSON(rw, http.StatusCreated, map[string]string{"name": body.Name, "version": version, "side_effect": body.SideEffect, "owner": body.Owner})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/tools", registerTool)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import toolsd.Store // Store.get, Store.put, Store.insert

object Api {
  private def text(body: JsObject, field: String): String = body.fields.get(field) match {
    case Some(JsString(s)) => s
    case _                 => ""
  }

  val route: Route =
    path("v1" / "tools") {
      post {
        optionalHeaderValueByName("X-Tenant-Id") { tenant =>
          entity(as[String]) { raw =>
            // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
            if (tenant.forall(_.isEmpty)) complete(StatusCodes.Unauthorized -> "missing X-Tenant-Id")
            else {
              val body = raw.parseJson.asJsObject
              val name = text(body, "name")
              val version = text(body, "version")
              Store.put(name, version, body)
              val answer = JsObject("name" -> JsString(name), "version" -> JsString(version), "side_effect" -> JsString(text(body, "side_effect")), "owner" -> JsString(text(body, "owner")))
              complete(HttpResponse(StatusCodes.Created, entity = HttpEntity(ContentTypes.\`application/json\`, answer.compactPrint)))
            }
          }
        }
      }
    }
}
`,
      solution: `import java.security.MessageDigest

import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import toolsd.Store // Store.get, Store.put, Store.insert

object Api {
  val PlatformReviewerRole = "platform-reviewer"
  val SideEffectClasses: Set[String] = Set("read", "write", "irreversible")
  val NamePattern = "^[a-z][a-z0-9_.-]{1,63}$".r
  val VersionChars = 16

  private def json(status: StatusCode, body: JsValue): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  private def text(body: JsObject, field: String): String = body.fields.get(field) match {
    case Some(JsString(s)) => s
    case _                 => ""
  }

  private def failure(pointer: String, message: String): JsObject =
    JsObject("pointer" -> JsString(pointer), "message" -> JsString(message))

  /** The JSON pointer of every place an agent could not build arguments from. */
  def validateSchema(schema: JsValue): Vector[JsObject] = schema match {
    case JsObject(doc) if doc.get("type").contains(JsString("object")) =>
      doc.getOrElse("properties", JsObject.empty) match {
        case JsObject(properties) =>
          val untyped = properties.toVector.sortBy(_._1).collect {
            case (name, prop) if !(prop match { case JsObject(p) => p.contains("type"); case _ => false }) =>
              failure(s"/properties/$name/type", "every property needs a type")
          }
          val required = doc.get("required") match {
            case Some(JsArray(names)) => names
            case _                    => Vector.empty
          }
          val undeclared = required.zipWithIndex.collect {
            case (name, i) if !(name match { case JsString(n) => properties.contains(n); case _ => false }) =>
              failure(s"/required/$i", s"\${name.compactPrint} is required but not declared")
          }
          untyped ++ undeclared
        case _ => Vector(failure("/properties", "properties must be an object"))
      }
    case _ => Vector(failure("/type", "the schema's type must be object"))
  }

  /** The version is the definition's digest: one definition, one version, whatever the caller calls it. */
  def mintVersion(name: String, schema: JsValue, sideEffect: String, owner: String): String = {
    val canonical = JsObject("name" -> JsString(name), "owner" -> JsString(owner), "schema" -> schema, "side_effect" -> JsString(sideEffect)).compactPrint
    MessageDigest.getInstance("SHA-256").digest(canonical.getBytes("UTF-8")).map("%02x".format(_)).mkString.take(VersionChars)
  }

  val route: Route =
    path("v1" / "tools") {
      post {
        optionalHeaderValueByName("X-Tenant-Id") { tenant =>
          optionalHeaderValueByName("X-Roles") { roles =>
            entity(as[String]) { raw =>
              val granted = roles.getOrElse("").split(",").map(_.trim).toSet
              if (tenant.forall(_.isEmpty)) complete(StatusCodes.Unauthorized -> "missing X-Tenant-Id")
              else if (!granted.contains(PlatformReviewerRole)) complete(StatusCodes.Forbidden -> "registering a tool takes the platform-reviewer role")
              else {
                val body = raw.parseJson.asJsObject
                val name = text(body, "name")
                val sideEffect = text(body, "side_effect")
                val schema = body.fields.getOrElse("schema", JsNull)
                val errors = validateSchema(schema)
                if (NamePattern.findFirstIn(name).isEmpty) complete(StatusCodes.BadRequest -> "name must match ^[a-z][a-z0-9_.-]{1,63}$")
                else if (!SideEffectClasses.contains(sideEffect)) complete(StatusCodes.BadRequest -> "side_effect must be read, write or irreversible")
                else if (errors.nonEmpty) complete(json(StatusCodes.UnprocessableEntity, JsObject("errors" -> JsArray(errors))))
                else {
                  val owner = text(body, "owner")
                  val version = mintVersion(name, schema, sideEffect, owner)
                  val row = JsObject(
                    "side_effect" -> JsString(sideEffect),
                    "owner" -> JsString(owner),
                    "schema" -> schema,
                    "endpoint" -> JsString(text(body, "endpoint")),
                    "credential_ref" -> JsString(text(body, "credential_ref")))
                  if (!Store.insert(name, version, row)) complete(StatusCodes.Conflict -> s"$name $version is already registered")
                  else
                    complete(json(StatusCodes.Created, JsObject("name" -> JsString(name), "version" -> JsString(version), "side_effect" -> JsString(sideEffect), "owner" -> JsString(owner))))
                }
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

#include <string>

#include "toolsd/store.h"  // store::get, store::put, store::insert

using json = nlohmann::json;

void register_tool(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  if (req.get_header_value("X-Tenant-Id").empty()) {
    res.status = 401;
    res.set_content(R"({"error": "missing X-Tenant-Id"})", "application/json");
    return;
  }
  const json body = json::parse(req.body);
  const std::string name = body.value("name", "");
  const std::string version = body.value("version", "");
  store::put(name, version, body);
  res.status = 201;
  res.set_content(json{{"name", name}, {"version", version}, {"side_effect", body.value("side_effect", "")}, {"owner", body.value("owner", "")}}.dump(),
                  "application/json");
}

void register_routes(httplib::Server& svr) { svr.Post("/v1/tools", register_tool); }
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>
#include <openssl/sha.h>

#include <cstdio>
#include <regex>
#include <set>
#include <sstream>
#include <string>

#include "toolsd/store.h"  // store::get, store::put, store::insert

using json = nlohmann::json;

const std::string kPlatformReviewerRole = "platform-reviewer";
const std::set<std::string> kSideEffectClasses = {"read", "write", "irreversible"};
const std::regex kNamePattern("^[a-z][a-z0-9_.-]{1,63}$");
constexpr size_t kVersionChars = 16;

void reply(httplib::Response& res, int status, const json& body) {
  res.status = status;
  res.set_content(body.dump(), "application/json");
}

json failure(const std::string& pointer, const std::string& message) { return json{{"pointer", pointer}, {"message", message}}; }

bool hasRole(const std::string& header, const std::string& role) {
  std::stringstream roles(header);
  std::string granted;
  while (std::getline(roles, granted, ',')) {
    const auto first = granted.find_first_not_of(' ');
    const auto last = granted.find_last_not_of(' ');
    if (first != std::string::npos && granted.substr(first, last - first + 1) == role) return true;
  }
  return false;
}

// The JSON pointer of every place an agent could not build arguments from.
json validateSchema(const json& schema) {
  if (!schema.is_object() || !schema.contains("type") || schema["type"] != "object") {
    return json::array({failure("/type", "the schema's type must be object")});
  }
  const json properties = schema.contains("properties") ? schema["properties"] : json::object();
  if (!properties.is_object()) return json::array({failure("/properties", "properties must be an object")});
  json errors = json::array();
  for (const auto& [name, prop] : properties.items()) {
    if (!prop.is_object() || !prop.contains("type")) errors.push_back(failure("/properties/" + name + "/type", "every property needs a type"));
  }
  const json required = schema.contains("required") && schema["required"].is_array() ? schema["required"] : json::array();
  for (size_t i = 0; i < required.size(); i++) {
    if (!required[i].is_string() || !properties.contains(required[i].get<std::string>())) {
      errors.push_back(failure("/required/" + std::to_string(i), required[i].dump() + " is required but not declared"));
    }
  }
  return errors;
}

// The version is the definition's digest: one definition, one version, whatever the caller calls it.
// nlohmann::json keeps object keys sorted, so dump() is canonical.
std::string mintVersion(const std::string& name, const json& schema, const std::string& side_effect, const std::string& owner) {
  const std::string canonical = json{{"name", name}, {"owner", owner}, {"schema", schema}, {"side_effect", side_effect}}.dump();
  unsigned char digest[SHA256_DIGEST_LENGTH];
  SHA256(reinterpret_cast<const unsigned char*>(canonical.data()), canonical.size(), digest);
  std::string hex;
  char byte[3];
  for (const unsigned char b : digest) {
    std::snprintf(byte, sizeof byte, "%02x", b);
    hex += byte;
  }
  return hex.substr(0, kVersionChars);
}

void register_tool(const httplib::Request& req, httplib::Response& res) {
  if (req.get_header_value("X-Tenant-Id").empty()) return reply(res, 401, {{"error", "missing X-Tenant-Id"}});
  if (!hasRole(req.get_header_value("X-Roles"), kPlatformReviewerRole)) {
    return reply(res, 403, {{"error", "registering a tool takes the platform-reviewer role"}});
  }
  const json body = json::parse(req.body, nullptr, false);
  if (!body.is_object()) return reply(res, 400, {{"error", "the body must be a JSON object"}});
  const std::string name = body.contains("name") && body["name"].is_string() ? body["name"].get<std::string>() : "";
  if (!std::regex_match(name, kNamePattern)) return reply(res, 400, {{"error", "name must match ^[a-z][a-z0-9_.-]{1,63}$"}});
  const std::string side_effect = body.contains("side_effect") && body["side_effect"].is_string() ? body["side_effect"].get<std::string>() : "";
  if (!kSideEffectClasses.count(side_effect)) return reply(res, 400, {{"error", "side_effect must be read, write or irreversible"}});
  const json schema = body.contains("schema") ? body["schema"] : json();
  const json errors = validateSchema(schema);
  if (!errors.empty()) return reply(res, 422, {{"errors", errors}});
  const std::string owner = body.value("owner", "");
  const std::string version = mintVersion(name, schema, side_effect, owner);
  const json row = {{"side_effect", side_effect},
                    {"owner", owner},
                    {"schema", schema},
                    {"endpoint", body.value("endpoint", "")},
                    {"credential_ref", body.value("credential_ref", "")}};
  if (!store::insert(name, version, row)) return reply(res, 409, {{"error", name + " " + version + " is already registered"}});
  reply(res, 201, {{"name", name}, {"version", version}, {"side_effect", side_effect}, {"owner", owner}});
}

void register_routes(httplib::Server& svr) { svr.Post("/v1/tools", register_tool); }
`,
    },
  },
  harness: {
    python: `import re

from toolsd import store

REVIEWER = {"X-Tenant-Id": "acme", "X-Roles": "platform-reviewer"}
SCHEMA = {
    "type": "object",
    "properties": {"amount": {"type": "integer"}, "currency": {"type": "string"}},
    "required": ["amount"],
}


def _tool(**overrides):
    body = {
        "name": "payments.refund",
        "version": "v1",
        "schema": SCHEMA,
        "side_effect": "irreversible",
        "owner": "payments",
        "endpoint": "https://payments.internal/refund",
        "credential_ref": "vault://payments/refund",
    }
    body.update(overrides)
    return body


def _api(ctx):
    return ctx.client(ctx.load("api").app)


def _stored(ctx):
    return sorted(ctx.redis.keys("tool:*"))


async def check_route(ctx):
    async with _api(ctx) as c:
        r = await c.post("/v1/tools", json=_tool(), headers=REVIEWER)
        assert r.status_code == 201, f"POST /v1/tools by a platform reviewer answered {r.status_code}: {r.text}"
        body = r.json()
        assert body.get("name") == "payments.refund" and body.get("side_effect") == "irreversible" and body.get("version"), f"the 201 must carry name, version and side_effect, got {body}"
        row = store.get("payments.refund", body["version"])
        assert row is not None and row["schema"] == SCHEMA, f"tool:payments.refund:{body['version']} holds {row}, expected the registered definition"
        r = await c.post("/v1/tools", json=_tool(name="payments.void"), headers={"X-Roles": "platform-reviewer"})
    assert r.status_code == 401, f"a registration without X-Tenant-Id answered {r.status_code}, expected 401"


async def check_role(ctx):
    async with _api(ctx) as c:
        for roles in (None, "tool-author", "platform-reviewers"):
            headers = {"X-Tenant-Id": "acme"} if roles is None else {"X-Tenant-Id": "acme", "X-Roles": roles}
            r = await c.post("/v1/tools", json=_tool(), headers=headers)
            assert r.status_code == 403, f"a registration with X-Roles {roles!r} answered {r.status_code}, expected 403: an authenticated caller is not an entitled one"
        assert _stored(ctx) == [], f"refused registrations wrote {_stored(ctx)}: the role is checked before any write"
        r = await c.post("/v1/tools", json=_tool(), headers={"X-Tenant-Id": "acme", "X-Roles": "tool-author, platform-reviewer"})
    assert r.status_code == 201, f"a caller holding platform-reviewer among other roles answered {r.status_code}: {r.text}"


async def check_side_effect(ctx):
    async with _api(ctx) as c:
        for value in ("maybe", "READ", ""):
            r = await c.post("/v1/tools", json=_tool(side_effect=value), headers=REVIEWER)
            assert r.status_code == 400, f"side_effect {value!r} answered {r.status_code}, expected 400: the class must be read, write or irreversible"
        r = await c.post("/v1/tools", json=_tool(name="Payments Refund"), headers=REVIEWER)
        assert r.status_code == 400, f"the name 'Payments Refund' answered {r.status_code}, expected 400"
        assert _stored(ctx) == [], f"refused registrations wrote {_stored(ctx)}"
        for i, value in enumerate(("read", "write", "irreversible")):
            r = await c.post("/v1/tools", json=_tool(name=f"payments.tool{i}", side_effect=value), headers=REVIEWER)
            assert r.status_code == 201, f"side_effect {value!r} answered {r.status_code}: {r.text}"


async def check_schema(ctx):
    cases = (
        ({"type": "array"}, "/type"),
        ({"type": "object", "properties": {"amount": {}}}, "/properties/amount/type"),
        ({"type": "object", "properties": {"amount": {"type": "integer"}}, "required": ["amount", "currency"]}, "/required/1"),
    )
    async with _api(ctx) as c:
        for schema, pointer in cases:
            r = await c.post("/v1/tools", json=_tool(schema=schema), headers=REVIEWER)
            assert r.status_code == 422, f"the schema {schema} answered {r.status_code}, expected 422: an agent cannot build arguments from it"
            assert pointer in r.text, f"the 422 for {schema} must name the failing pointer {pointer}, got {r.text}"
        assert _stored(ctx) == [], f"invalid schemas were stored: {_stored(ctx)}"
        r = await c.post("/v1/tools", json=_tool(), headers=REVIEWER)
    assert r.status_code == 201, f"a valid schema answered {r.status_code}: {r.text}"


async def check_version(ctx):
    async with _api(ctx) as c:
        first = await c.post("/v1/tools", json=_tool(version="v1"), headers=REVIEWER)
        assert first.status_code == 201, f"the first registration answered {first.status_code}: {first.text}"
        version = first.json().get("version", "")
        assert version != "v1", "the version is the caller's label v1: a label can be reused for another definition. Mint it from the content"
        assert re.fullmatch(r"[0-9a-f]{16}", version), f"the version {version!r} must be 16 hex characters of a sha256 digest"
        again = await c.post("/v1/tools", json=_tool(version="v2"), headers=REVIEWER)
        assert again.status_code == 409, f"re-registering the same definition answered {again.status_code}, expected 409"
        changed_schema = {**SCHEMA, "properties": {**SCHEMA["properties"], "reason": {"type": "string"}}}
        changed = await c.post("/v1/tools", json=_tool(version="v1", schema=changed_schema), headers=REVIEWER)
        assert changed.status_code == 201, f"a changed definition answered {changed.status_code}: {changed.text}"
        assert changed.json().get("version") != version, "a changed definition got the version of the first one"
    row = store.get("payments.refund", version)
    assert row is not None and row["schema"] == SCHEMA, f"the first version now holds {row}: a stored version must stay immutable"
`,
    typescript: `const REVIEWER = {'X-Tenant-Id': 'acme', 'X-Roles': 'platform-reviewer'};
const SCHEMA = {type: 'object', properties: {amount: {type: 'integer'}, currency: {type: 'string'}}, required: ['amount']};

const tool = (overrides: Record<string, unknown> = {}) => ({
  name: 'payments.refund',
  version: 'v1',
  schema: SCHEMA,
  side_effect: 'irreversible',
  owner: 'payments',
  endpoint: 'https://payments.internal/refund',
  credential_ref: 'vault://payments/refund',
  ...overrides,
});

function api(ctx) {
  return {c: ctx.client(ctx.load('api').app), store: ctx.load('/support/toolsd/store.ts')};
}

const stored = ctx => ctx.redis.keys('tool:*').sort();

export async function check_route(ctx) {
  const {c, store} = api(ctx);
  let r = await c.post('/v1/tools', {json: tool(), headers: REVIEWER});
  assert.equal(r.status, 201, \`POST /v1/tools by a platform reviewer answered \${r.status}: \${r.text}\`);
  const body = r.json();
  assert(body.name === 'payments.refund' && body.side_effect === 'irreversible' && body.version, \`the 201 must carry name, version and side_effect, got \${r.text}\`);
  const row = await store.get('payments.refund', body.version);
  assert(row !== null && JSON.stringify(row.schema) === JSON.stringify(SCHEMA), \`tool:payments.refund:\${body.version} holds \${JSON.stringify(row)}, expected the registered definition\`);
  r = await c.post('/v1/tools', {json: tool({name: 'payments.void'}), headers: {'X-Roles': 'platform-reviewer'}});
  assert.equal(r.status, 401, \`a registration without X-Tenant-Id answered \${r.status}, expected 401\`);
}

export async function check_role(ctx) {
  const {c} = api(ctx);
  for (const roles of [null, 'tool-author', 'platform-reviewers']) {
    const headers = roles === null ? {'X-Tenant-Id': 'acme'} : {'X-Tenant-Id': 'acme', 'X-Roles': roles};
    const r = await c.post('/v1/tools', {json: tool(), headers});
    assert.equal(r.status, 403, \`a registration with X-Roles \${JSON.stringify(roles)} answered \${r.status}, expected 403: an authenticated caller is not an entitled one\`);
  }
  assert.deepStrictEqual(stored(ctx), [], \`refused registrations wrote \${JSON.stringify(stored(ctx))}: the role is checked before any write\`);
  const r = await c.post('/v1/tools', {json: tool(), headers: {'X-Tenant-Id': 'acme', 'X-Roles': 'tool-author, platform-reviewer'}});
  assert.equal(r.status, 201, \`a caller holding platform-reviewer among other roles answered \${r.status}: \${r.text}\`);
}

export async function check_side_effect(ctx) {
  const {c} = api(ctx);
  for (const value of ['maybe', 'READ', '']) {
    const r = await c.post('/v1/tools', {json: tool({side_effect: value}), headers: REVIEWER});
    assert.equal(r.status, 400, \`side_effect \${JSON.stringify(value)} answered \${r.status}, expected 400: the class must be read, write or irreversible\`);
  }
  const bad = await c.post('/v1/tools', {json: tool({name: 'Payments Refund'}), headers: REVIEWER});
  assert.equal(bad.status, 400, \`the name 'Payments Refund' answered \${bad.status}, expected 400\`);
  assert.deepStrictEqual(stored(ctx), [], \`refused registrations wrote \${JSON.stringify(stored(ctx))}\`);
  for (const [i, value] of ['read', 'write', 'irreversible'].entries()) {
    const r = await c.post('/v1/tools', {json: tool({name: \`payments.tool\${i}\`, side_effect: value}), headers: REVIEWER});
    assert.equal(r.status, 201, \`side_effect \${value} answered \${r.status}: \${r.text}\`);
  }
}

export async function check_schema(ctx) {
  const {c} = api(ctx);
  const cases: [Record<string, unknown>, string][] = [
    [{type: 'array'}, '/type'],
    [{type: 'object', properties: {amount: {}}}, '/properties/amount/type'],
    [{type: 'object', properties: {amount: {type: 'integer'}}, required: ['amount', 'currency']}, '/required/1'],
  ];
  for (const [schema, pointer] of cases) {
    const r = await c.post('/v1/tools', {json: tool({schema}), headers: REVIEWER});
    assert.equal(r.status, 422, \`the schema \${JSON.stringify(schema)} answered \${r.status}, expected 422: an agent cannot build arguments from it\`);
    assert(r.text.includes(pointer), \`the 422 for \${JSON.stringify(schema)} must name the failing pointer \${pointer}, got \${r.text}\`);
  }
  assert.deepStrictEqual(stored(ctx), [], \`invalid schemas were stored: \${JSON.stringify(stored(ctx))}\`);
  const r = await c.post('/v1/tools', {json: tool(), headers: REVIEWER});
  assert.equal(r.status, 201, \`a valid schema answered \${r.status}: \${r.text}\`);
}

export async function check_version(ctx) {
  const {c, store} = api(ctx);
  const first = await c.post('/v1/tools', {json: tool({version: 'v1'}), headers: REVIEWER});
  assert.equal(first.status, 201, \`the first registration answered \${first.status}: \${first.text}\`);
  const version = first.json().version ?? '';
  assert.notEqual(version, 'v1', "the version is the caller's label v1: a label can be reused for another definition. Mint it from the content");
  assert(/^[0-9a-f]{16}$/.test(version), \`the version \${JSON.stringify(version)} must be 16 hex characters of a sha256 digest\`);
  const again = await c.post('/v1/tools', {json: tool({version: 'v2'}), headers: REVIEWER});
  assert.equal(again.status, 409, \`re-registering the same definition answered \${again.status}, expected 409\`);
  const changedSchema = {...SCHEMA, properties: {...SCHEMA.properties, reason: {type: 'string'}}};
  const changed = await c.post('/v1/tools', {json: tool({version: 'v1', schema: changedSchema}), headers: REVIEWER});
  assert.equal(changed.status, 201, \`a changed definition answered \${changed.status}: \${changed.text}\`);
  assert.notEqual(changed.json().version, version, 'a changed definition got the version of the first one');
  const row = await store.get('payments.refund', version);
  assert(row !== null && JSON.stringify(row.schema) === JSON.stringify(SCHEMA), \`the first version now holds \${JSON.stringify(row)}: a stored version must stay immutable\`);
}
`,
    go: `package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"regexp"
	"strings"

	"toolsd/store"

	"leetbuild/harness"
)

var reviewer = []string{"X-Tenant-Id", "acme", "X-Roles", "platform-reviewer"}

func schemaDoc() map[string]any {
	return map[string]any{
		"type":       "object",
		"properties": map[string]any{"amount": map[string]any{"type": "integer"}, "currency": map[string]any{"type": "string"}},
		"required":   []any{"amount"},
	}
}

func tool(overrides map[string]any) map[string]any {
	body := map[string]any{
		"name":           "payments.refund",
		"version":        "v1",
		"schema":         schemaDoc(),
		"side_effect":    "irreversible",
		"owner":          "payments",
		"endpoint":       "https://payments.internal/refund",
		"credential_ref": "vault://payments/refund",
	}
	for k, v := range overrides {
		body[k] = v
	}
	return body
}

func api(ctx *harness.Ctx) *harness.HTTP {
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

func versionIn(r *harness.Response) string {
	var body struct {
		Version string \`json:"version"\`
	}
	r.Decode(&body)
	return body.Version
}

func sameJSON(a, b any) bool {
	x, _ := json.Marshal(a)
	y, _ := json.Marshal(b)
	return string(x) == string(y)
}

func CheckRoute(ctx *harness.Ctx) {
	c := api(ctx)
	r := c.Post("/v1/tools", tool(nil), reviewer...)
	ctx.Equal(r.Status, 201, "POST /v1/tools by a platform reviewer (%s)", r.Text())
	version := versionIn(r)
	ctx.Assert(version != "" && strings.Contains(r.Text(), \`"irreversible"\`) && strings.Contains(r.Text(), "payments.refund"), "the 201 must carry name, version and side_effect, got %s", r.Text())
	row, err := store.Get(context.Background(), "payments.refund", version)
	ctx.NoError(err, "store.Get failed")
	ctx.Assert(row != nil && sameJSON(row["schema"], schemaDoc()), "tool:payments.refund:%s holds %v, expected the registered definition", version, row)
	r = c.Post("/v1/tools", tool(map[string]any{"name": "payments.void"}), "X-Roles", "platform-reviewer")
	ctx.Equal(r.Status, 401, "a registration without X-Tenant-Id")
}

func CheckRole(ctx *harness.Ctx) {
	c := api(ctx)
	for _, roles := range []string{"", "tool-author", "platform-reviewers"} {
		headers := []string{"X-Tenant-Id", "acme"}
		if roles != "" {
			headers = append(headers, "X-Roles", roles)
		}
		r := c.Post("/v1/tools", tool(nil), headers...)
		ctx.Equal(r.Status, 403, "a registration with X-Roles %q must be refused (an authenticated caller is not an entitled one)", roles)
	}
	ctx.Assert(len(ctx.Redis.Keys("tool:*")) == 0, "refused registrations wrote %q: the role is checked before any write", ctx.Redis.Keys("tool:*"))
	r := c.Post("/v1/tools", tool(nil), "X-Tenant-Id", "acme", "X-Roles", "tool-author, platform-reviewer")
	ctx.Equal(r.Status, 201, "a caller holding platform-reviewer among other roles (%s)", r.Text())
}

func CheckSideEffect(ctx *harness.Ctx) {
	c := api(ctx)
	for _, value := range []string{"maybe", "READ", ""} {
		r := c.Post("/v1/tools", tool(map[string]any{"side_effect": value}), reviewer...)
		ctx.Equal(r.Status, 400, "side_effect %q must be refused: the class must be read, write or irreversible", value)
	}
	r := c.Post("/v1/tools", tool(map[string]any{"name": "Payments Refund"}), reviewer...)
	ctx.Equal(r.Status, 400, "the name 'Payments Refund'")
	ctx.Assert(len(ctx.Redis.Keys("tool:*")) == 0, "refused registrations wrote %q", ctx.Redis.Keys("tool:*"))
	for i, value := range []string{"read", "write", "irreversible"} {
		r := c.Post("/v1/tools", tool(map[string]any{"name": fmt.Sprintf("payments.tool%d", i), "side_effect": value}), reviewer...)
		ctx.Equal(r.Status, 201, "side_effect %q (%s)", value, r.Text())
	}
}

func CheckSchema(ctx *harness.Ctx) {
	c := api(ctx)
	cases := []struct {
		schema  map[string]any
		pointer string
	}{
		{map[string]any{"type": "array"}, "/type"},
		{map[string]any{"type": "object", "properties": map[string]any{"amount": map[string]any{}}}, "/properties/amount/type"},
		{map[string]any{"type": "object", "properties": map[string]any{"amount": map[string]any{"type": "integer"}}, "required": []any{"amount", "currency"}}, "/required/1"},
	}
	for _, tc := range cases {
		r := c.Post("/v1/tools", tool(map[string]any{"schema": tc.schema}), reviewer...)
		ctx.Equal(r.Status, 422, "the schema %v must be refused: an agent cannot build arguments from it", tc.schema)
		ctx.Assert(strings.Contains(r.Text(), tc.pointer), "the 422 for %v must name the failing pointer %s, got %s", tc.schema, tc.pointer, r.Text())
	}
	ctx.Assert(len(ctx.Redis.Keys("tool:*")) == 0, "invalid schemas were stored: %q", ctx.Redis.Keys("tool:*"))
	r := c.Post("/v1/tools", tool(nil), reviewer...)
	ctx.Equal(r.Status, 201, "a valid schema (%s)", r.Text())
}

func CheckVersion(ctx *harness.Ctx) {
	c := api(ctx)
	first := c.Post("/v1/tools", tool(map[string]any{"version": "v1"}), reviewer...)
	ctx.Equal(first.Status, 201, "the first registration (%s)", first.Text())
	version := versionIn(first)
	ctx.Assert(version != "v1", "the version is the caller's label v1: a label can be reused for another definition. Mint it from the content")
	ctx.Assert(regexp.MustCompile(\`^[0-9a-f]{16}$\`).MatchString(version), "the version %q must be 16 hex characters of a sha256 digest", version)
	again := c.Post("/v1/tools", tool(map[string]any{"version": "v2"}), reviewer...)
	ctx.Equal(again.Status, 409, "re-registering the same definition")
	changedSchema := schemaDoc()
	changedSchema["properties"].(map[string]any)["reason"] = map[string]any{"type": "string"}
	changed := c.Post("/v1/tools", tool(map[string]any{"version": "v1", "schema": changedSchema}), reviewer...)
	ctx.Equal(changed.Status, 201, "a changed definition (%s)", changed.Text())
	ctx.Assert(versionIn(changed) != version, "a changed definition got the version of the first one")
	row, err := store.Get(context.Background(), "payments.refund", version)
	ctx.NoError(err, "store.Get failed")
	ctx.Assert(row != nil && sameJSON(row["schema"], schemaDoc()), "the first version now holds %v: a stored version must stay immutable", row)
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <regex>
#include <string>
#include <vector>

namespace {

const nlohmann::json kSchema = {
    {"type", "object"},
    {"properties", {{"amount", {{"type", "integer"}}}, {"currency", {{"type", "string"}}}}},
    {"required", {"amount"}}};

nlohmann::json tool(const nlohmann::json& overrides = nlohmann::json::object()) {
  nlohmann::json body = {{"name", "payments.refund"},
                         {"version", "v1"},
                         {"schema", kSchema},
                         {"side_effect", "irreversible"},
                         {"owner", "payments"},
                         {"endpoint", "https://payments.internal/refund"},
                         {"credential_ref", "vault://payments/refund"}};
  body.update(overrides);
  return body;
}

harness::HTTP api(harness::Ctx& ctx) {
  static httplib::Server* svr = nullptr;
  delete svr;
  svr = new httplib::Server;
  register_routes(*svr);
  return ctx.HTTP(*svr);
}

harness::Response post(harness::HTTP& c, const nlohmann::json& body) {
  return c.Post("/v1/tools", body.dump(), "Content-Type", "application/json", "X-Tenant-Id", "acme", "X-Roles", "platform-reviewer");
}

std::string versionIn(const harness::Response& r) {
  const auto body = nlohmann::json::parse(r.Text(), nullptr, false);
  return body.is_object() ? body.value("version", "") : "";
}

}  // namespace

void CheckRoute(harness::Ctx& ctx) {
  auto c = api(ctx);
  auto r = post(c, tool());
  ctx.Equal(r.Status, 201, "POST /v1/tools by a platform reviewer (%s)", r.Text());
  const std::string version = versionIn(r);
  ctx.Assert(!version.empty() && r.Text().find("irreversible") != std::string::npos, "the 201 must carry name, version and side_effect, got %s", r.Text());
  const auto row = store::get("payments.refund", version);
  ctx.Assert(row && (*row)["schema"] == kSchema, "tool:payments.refund:%s holds %s, expected the registered definition", version, row ? row->dump() : "nothing");
  r = c.Post("/v1/tools", tool({{"name", "payments.void"}}).dump(), "Content-Type", "application/json", "X-Roles", "platform-reviewer");
  ctx.Equal(r.Status, 401, "a registration without X-Tenant-Id");
}

void CheckRole(harness::Ctx& ctx) {
  auto c = api(ctx);
  auto r = c.Post("/v1/tools", tool().dump(), "Content-Type", "application/json", "X-Tenant-Id", "acme");
  ctx.Equal(r.Status, 403, "a registration without X-Roles must be refused (an authenticated caller is not an entitled one)");
  for (const std::string roles : {"tool-author", "platform-reviewers"}) {
    r = c.Post("/v1/tools", tool().dump(), "Content-Type", "application/json", "X-Tenant-Id", "acme", "X-Roles", roles);
    ctx.Equal(r.Status, 403, "a registration with X-Roles %q must be refused (an authenticated caller is not an entitled one)", roles);
  }
  ctx.Equal(ctx.Redis.Keys("tool:*"), std::vector<std::string>{}, "refused registrations must write nothing: the role is checked before any write; the tool keys");
  r = c.Post("/v1/tools", tool().dump(), "Content-Type", "application/json", "X-Tenant-Id", "acme", "X-Roles", "tool-author, platform-reviewer");
  ctx.Equal(r.Status, 201, "a caller holding platform-reviewer among other roles (%s)", r.Text());
}

void CheckSideEffect(harness::Ctx& ctx) {
  auto c = api(ctx);
  for (const std::string value : {"maybe", "READ", ""}) {
    const auto r = post(c, tool({{"side_effect", value}}));
    ctx.Equal(r.Status, 400, "side_effect %q must be refused: the class must be read, write or irreversible", value);
  }
  ctx.Equal(post(c, tool({{"name", "Payments Refund"}})).Status, 400, "the name 'Payments Refund'");
  ctx.Equal(ctx.Redis.Keys("tool:*"), std::vector<std::string>{}, "refused registrations must write nothing; the tool keys");
  int i = 0;
  for (const std::string value : {"read", "write", "irreversible"}) {
    const auto r = post(c, tool({{"name", "payments.tool" + std::to_string(i++)}, {"side_effect", value}}));
    ctx.Equal(r.Status, 201, "side_effect %q (%s)", value, r.Text());
  }
}

void CheckSchema(harness::Ctx& ctx) {
  auto c = api(ctx);
  const std::vector<std::pair<nlohmann::json, std::string>> cases = {
      {{{"type", "array"}}, "/type"},
      {{{"type", "object"}, {"properties", {{"amount", nlohmann::json::object()}}}}, "/properties/amount/type"},
      {{{"type", "object"}, {"properties", {{"amount", {{"type", "integer"}}}}}, {"required", {"amount", "currency"}}}, "/required/1"},
  };
  for (const auto& [schema, pointer] : cases) {
    const auto r = post(c, tool({{"schema", schema}}));
    ctx.Equal(r.Status, 422, "the schema %s must be refused: an agent cannot build arguments from it", schema.dump());
    ctx.Assert(r.Text().find(pointer) != std::string::npos, "the 422 for %s must name the failing pointer %s, got %s", schema.dump(), pointer, r.Text());
  }
  ctx.Equal(ctx.Redis.Keys("tool:*"), std::vector<std::string>{}, "invalid schemas must not be stored; the tool keys");
  const auto r = post(c, tool());
  ctx.Equal(r.Status, 201, "a valid schema (%s)", r.Text());
}

void CheckVersion(harness::Ctx& ctx) {
  auto c = api(ctx);
  const auto first = post(c, tool({{"version", "v1"}}));
  ctx.Equal(first.Status, 201, "the first registration (%s)", first.Text());
  const std::string version = versionIn(first);
  ctx.Assert(version != "v1", "the version is the caller's label v1: a label can be reused for another definition. Mint it from the content");
  ctx.Assert(std::regex_match(version, std::regex("^[0-9a-f]{16}$")), "the version %q must be 16 hex characters of a sha256 digest", version);
  ctx.Equal(post(c, tool({{"version", "v2"}})).Status, 409, "re-registering the same definition");
  nlohmann::json changed_schema = kSchema;
  changed_schema["properties"]["reason"] = {{"type", "string"}};
  const auto changed = post(c, tool({{"version", "v1"}, {"schema", changed_schema}}));
  ctx.Equal(changed.Status, 201, "a changed definition (%s)", changed.Text());
  ctx.Assert(versionIn(changed) != version, "a changed definition got the version of the first one");
  const auto row = store::get("payments.refund", version);
  ctx.Assert(row && (*row)["schema"] == kSchema, "the first version now holds %s: a stored version must stay immutable", row ? row->dump() : "nothing");
}
`,
  },
  hints: [
    'Register a tool with `X-Roles: tool-author` and a side effect of `maybe`: it answers 201. Register the same name and version label again with another schema: agents now resolve the new definition.',
    'Nothing between the tenant check and `store.put` looks at the role, the class or the schema. The version is whatever string the caller sent, and `put` replaces an existing row.',
    'Split `X-Roles` and 403 without `platform-reviewer`; 400 outside the three classes; 422 with the pointers your schema walk collects; version = sha256 of the canonical definition, first 16 hex; `store.insert` false → 409.',
  ],
  debrief: `A registry entry is something agents act on, so registration is handled like a deploy: one role may do it, the input is checked against the rules the agent will rely on, and the identifier comes from the content so it can only ever name one definition. A content-addressed version also makes a retried registration harmless: the same definition gets the same version and a 409, a changed one gets a new version, and the old one stays resolvable for runs pinned to it. Production registries validate against the full JSON Schema meta-schema, record which reviewer approved each version, and ask for a second approval on tools classed irreversible.`,
};
