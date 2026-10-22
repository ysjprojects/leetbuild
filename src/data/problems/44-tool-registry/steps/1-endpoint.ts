import type {Step} from '@/lib/types';

export const endpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/tools: registration is a change with an owner',
  concept: 'http',
  file: 'api',
  focus: ['client', 'registry', 'db', 'reviewer'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it registers the route, reads
the tenant, unpacks the body and stores the definition under whatever version the caller sent. It
compiles, it serves the demo, and it hides three production flaws. Review it like the platform
owner, fix it, and prove the fix with the checks below.

Implement \`POST /v1/tools\` with body
\`{"name": "payments.charge", "schema": {…}, "side_effect": "irreversible", "owner": "payments"}\`.

- The tenant comes from the authenticated \`X-Tenant-Id\` header; a missing tenant is **401**.
- Registration is a privileged change: the caller's \`X-Roles\` claim must include
  \`platform-reviewer\`; anything else is **403**. A service account that merely authenticates is
  not allowed to mint a tool.
- \`name\` is a lowercase dotted identifier (\`^[a-z][a-z0-9_.-]{1,63}$\`, **400** otherwise).
- \`side_effect\` is one of \`read\`, \`write\`, \`irreversible\` (**400** otherwise). The class is
  what callers and reviewers reason about, so an unknown class may never be stored.
- \`schema\` is validated as JSON Schema *before* anything is written: \`type\` must be \`object\`,
  every entry of \`properties\` needs a \`type\`, and every name in \`required\` must be declared in
  \`properties\`. An invalid schema is **422** with the failing JSON pointer, e.g.
  \`{"errors": [{"pointer": "/properties/amount/type", "message": "…"}]}\`.
- The version is **minted server-side** from the definition's content (a digest of
  \`(name, schema, side_effect, owner)\`, truncated to 16 hex characters). The caller never supplies
  a version. Re-registering a version that already exists is **409** — versions are immutable, so a
  changed definition is a new version, never a silent overwrite.
- A registration that is stored answers **201** with \`{name, version, side_effect, owner}\` and
  writes the audit row (actor, action, version). Log the registration with name, version and actor —
  never the schema.

**Failure mode the checks target.** The draft trusts three things it must not. It treats an
authenticated caller as an entitled one, so any service account can mint a tool and then resolve it;
it accepts any JSON object as a schema, so the failure surfaces much later, in the agent that cannot
build arguments for the tool; and it takes the version from the request body, so a later registration
of the same tool and version quietly replaces the definition an agent is running against.`,
  sequence: {
    participants: ['Agent runtime', 'Tool Registry', 'Reviewer claim', 'tools · versions'],
    messages: [
      {from: 'Agent runtime', to: 'Tool Registry', label: 'POST /v1/tools · X-Tenant-Id · X-Roles', kind: 'sync'},
      {from: 'Tool Registry', to: 'Reviewer claim', label: 'claim must include platform-reviewer', kind: 'sync'},
      {from: 'Tool Registry', to: 'Tool Registry', label: 'validate name · side_effect · JSON Schema', kind: 'sync'},
      {from: 'Tool Registry', to: 'tools · versions', label: 'get(name, version)', kind: 'sync'},
      {from: 'tools · versions', to: 'Tool Registry', label: 'existing row / none', kind: 'reply'},
      {from: 'Tool Registry', to: 'tools · versions', label: 'insert immutable version · audit row', kind: 'async'},
      {from: 'Tool Registry', to: 'Agent runtime', label: '201 {name, version, side_effect}', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Handles POST /v1/tools',
      detail: 'Register the registration route on `POST /v1/tools`.',
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
        'The role claim is checked against `platform-reviewer` and anything else is **403**, before any lookup or write. The draft authenticates the caller and stops there, so every service account can mint tools.',
      match: {
        python: {all: [/PLATFORM_REVIEWER_ROLE/, /status_code\s*=\s*403/]},
        typescript: {all: [/PLATFORM_REVIEWER_ROLE/, /code\(\s*403\s*\)/]},
        go: {all: [/platformReviewerRole/, /StatusForbidden/]},
        scala: {all: [/PlatformReviewerRole/, /StatusCodes\.Forbidden/]},
        cpp: {all: [/kPlatformReviewerRole/, /\b403\b/]},
      },
    },
    {
      id: 'side-effect',
      title: 'Requires a declared side-effect class',
      detail:
        '`side_effect` is checked against the closed set `read` / `write` / `irreversible` and an unknown class is **400**. The draft stores whatever string arrives, so a tool can be registered with a class nobody can reason about.',
      match: {
        python: {all: [/SIDE_EFFECT_CLASSES/, /status_code\s*=\s*400/]},
        typescript: {all: [/SIDE_EFFECT_CLASSES/, /code\(\s*400\s*\)/]},
        go: {all: [/sideEffectClasses/, /StatusBadRequest/]},
        scala: {all: [/SideEffectClasses/, /StatusCodes\.BadRequest/]},
        cpp: {all: [/kSideEffectClasses/, /\b400\b/]},
      },
    },
    {
      id: 'schema',
      title: 'Validates the schema and names the failing pointer',
      detail:
        'The schema is validated before the write and an invalid one is **422** carrying the failing JSON pointer (`pointer`). The draft accepts any object as a schema, so the breakage lands in the agent that cannot build arguments.',
      match: {
        python: {all: [/validate_schema\(/, /status_code\s*=\s*422/, /pointer/]},
        typescript: {all: [/validateSchema\(/, /code\(\s*422\s*\)/, /pointer/]},
        go: {all: [/validateSchema\(/, /StatusUnprocessableEntity/, /pointer/]},
        scala: {all: [/validateSchema\(/, /StatusCodes\.UnprocessableEntity/, /pointer/]},
        cpp: {all: [/validateSchema\(/, /\b422\b/, /pointer/]},
      },
    },
    {
      id: 'version',
      title: 'Mints an immutable version and refuses to overwrite it',
      detail:
        'The version is derived from the definition content (`mintVersion` over a digest) and an existing version answers **409**. The draft takes the version from the request and upserts, so a re-registration silently replaces the definition agents are calling.',
      match: {
        python: {all: [/def mint_version\(/, /hashlib\.sha256/, /status_code\s*=\s*409/]},
        typescript: {all: [/function mintVersion\(/, /createHash\(\s*['"]sha256['"]/, /code\(\s*409\s*\)/]},
        go: {all: [/func mintVersion\(/, /sha256\.Sum256/, /StatusConflict/]},
        scala: {all: [/def mintVersion\(/, /MessageDigest\.getInstance\(\s*"SHA-256"/, /StatusCodes\.Conflict/]},
        cpp: {all: [/mintVersion\(/, /sha256/, /\b409\b/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import logging

from fastapi import Body, FastAPI, Header
from fastapi.responses import JSONResponse

app = FastAPI()
logger = logging.getLogger("toolsd")


class ToolStore:
    def put(self, name: str, version: str, row: dict) -> None:
        """Upsert the tool definition under (name, version)."""
        raise NotImplementedError


store = ToolStore()


@app.post("/v1/tools", status_code=201)
def register(
    body: dict = Body(...),
    tenant: str | None = Header(default=None, alias="X-Tenant-Id"),
) -> JSONResponse:
    # TODO: this draft treats any authenticated caller as entitled to register, accepts whatever
    # JSON object arrives as the schema, and takes the version from the request body so a later
    # registration overwrites the same version. Review all three.
    logger.info("register tool=%s schema=%s", body["name"], body["schema"])
    row = {"name": body["name"], "version": body["version"], "side_effect": body["side_effect"]}
    store.put(body["name"], body["version"], row)
    return JSONResponse({"name": row["name"], "version": row["version"], "tenant": tenant}, status_code=201)
`,
      solution: `import hashlib
import json
import logging
import re

from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field

app = FastAPI()
logger = logging.getLogger("toolsd")

PLATFORM_REVIEWER_ROLE = "platform-reviewer"
SIDE_EFFECT_CLASSES = {"read", "write", "irreversible"}
NAME_PATTERN = re.compile(r"^[a-z][a-z0-9_.-]{1,63}$")
VERSION_CHARS = 16


class ToolStore:
    def get(self, name: str, version: str) -> dict | None:
        """The definition stored under (name, version), if any."""
        raise NotImplementedError

    def insert(self, name: str, version: str, row: dict) -> None:
        """Insert an immutable definition; never overwrite an existing one."""
        raise NotImplementedError

    def audit(self, row: dict) -> None:
        """Append the registration to the audit trail."""
        raise NotImplementedError


store = ToolStore()


class Registration(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    name: str
    definition_schema: dict = Field(alias="schema")
    side_effect: str
    owner: str


def require_reviewer(roles: str | None) -> None:
    granted = {role.strip() for role in (roles or "").split(",") if role.strip()}
    if PLATFORM_REVIEWER_ROLE not in granted:
        raise HTTPException(status_code=403, detail="platform reviewer role required")


def validate_schema(schema: dict) -> list[dict]:
    """The failing pointers of a schema that is not valid JSON Schema."""
    errors: list[dict] = []
    if not isinstance(schema, dict) or schema.get("type") != "object":
        errors.append({"pointer": "/type", "message": "schema type must be object"})
    properties = schema.get("properties", {}) if isinstance(schema, dict) else {}
    if not isinstance(properties, dict):
        errors.append({"pointer": "/properties", "message": "properties must be an object"})
        properties = {}
    for prop_name, prop in properties.items():
        if not isinstance(prop, dict) or "type" not in prop:
            errors.append(
                {"pointer": f"/properties/{prop_name}/type", "message": "property needs a JSON Schema type"}
            )
    for required in schema.get("required", []) if isinstance(schema, dict) else []:
        if required not in properties:
            errors.append(
                {"pointer": f"/required/{required}", "message": "required property is not declared in properties"}
            )
    return errors


def mint_version(name: str, schema: dict, side_effect: str, owner: str) -> str:
    """The immutable version of a definition: a digest of its content, never a caller's label."""
    canonical = json.dumps(
        {"name": name, "schema": schema, "side_effect": side_effect, "owner": owner},
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:VERSION_CHARS]


@app.post("/v1/tools", status_code=201)
def register(
    body: Registration,
    tenant: str | None = Header(default=None, alias="X-Tenant-Id"),
    roles: str | None = Header(default=None, alias="X-Roles"),
) -> JSONResponse:
    if tenant is None or tenant == "":
        raise HTTPException(status_code=401, detail="missing X-Tenant-Id")
    require_reviewer(roles)
    if NAME_PATTERN.match(body.name) is None:
        raise HTTPException(status_code=400, detail="name must be a lowercase dotted identifier")
    if body.side_effect not in SIDE_EFFECT_CLASSES:
        raise HTTPException(status_code=400, detail="side_effect must be read, write or irreversible")
    errors = validate_schema(body.definition_schema)
    if errors:
        return JSONResponse({"errors": errors}, status_code=422)

    version = mint_version(body.name, body.definition_schema, body.side_effect, body.owner)
    if store.get(body.name, version) is not None:
        raise HTTPException(status_code=409, detail="version already registered")
    row = {
        "name": body.name,
        "version": version,
        "side_effect": body.side_effect,
        "owner": body.owner,
    }
    store.insert(body.name, version, row)
    store.audit({"actor": tenant, "action": "register", "name": body.name, "version": version})
    logger.info("registered tool=%s version=%s actor=%s", body.name, version, tenant)
    return JSONResponse(row, status_code=201)
`,
    },
    typescript: {
      starter: `/** POST /v1/tools: a model-generated draft that believes the caller. */
import Fastify from 'fastify';

import {store} from './store';

export const app = Fastify();

interface RegistrationBody {
  name: string;
  version: string;
  schema: Record<string, unknown>;
  side_effect: string;
  owner: string;
}

app.post('/v1/tools', async (request, reply) => {
  // TODO: this draft treats any authenticated caller as entitled to register, accepts whatever
  // JSON object arrives as the schema, and takes the version from the request body so a later
  // registration overwrites the same version. Review all three.
  const tenant = request.headers['x-tenant-id'] as string;
  const body = request.body as RegistrationBody;
  request.log.info({name: body.name, schema: body.schema}, 'register');
  const row = {name: body.name, version: body.version, side_effect: body.side_effect, owner: body.owner};
  await store.put(body.name, body.version, row);
  return reply.code(201).send({name: row.name, version: row.version, tenant});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** POST /v1/tools: registration is a privileged, immutable change with an owner. */
import {createHash} from 'node:crypto';

import Fastify from 'fastify';

import {store} from './store';

export const app = Fastify();

const PLATFORM_REVIEWER_ROLE = 'platform-reviewer';
const SIDE_EFFECT_CLASSES: Record<string, true> = {read: true, write: true, irreversible: true};
const NAME_PATTERN = /^[a-z][a-z0-9_.-]{1,63}$/;
const VERSION_CHARS = 16;

interface RegistrationBody {
  name: string;
  schema: Record<string, unknown>;
  side_effect: string;
  owner: string;
}

interface SchemaError {
  pointer: string;
  message: string;
}

function hasReviewerRole(roles: string | undefined): boolean {
  return (roles ?? '')
    .split(',')
    .map(role => role.trim())
    .some(role => role === PLATFORM_REVIEWER_ROLE);
}

function validateSchema(schema: unknown): SchemaError[] {
  const errors: SchemaError[] = [];
  if (typeof schema !== 'object' || schema === null || (schema as {type?: unknown}).type !== 'object')
    errors.push({pointer: '/type', message: 'schema type must be object'});
  const properties = (schema as {properties?: Record<string, {type?: unknown}>}).properties ?? {};
  for (const [propName, prop] of Object.entries(properties)) {
    if (typeof prop !== 'object' || prop === null || prop.type === undefined)
      errors.push({pointer: \`/properties/\${propName}/type\`, message: 'property needs a JSON Schema type'});
  }
  const required = (schema as {required?: string[]}).required ?? [];
  for (const name of required)
    if (!(name in properties))
      errors.push({pointer: \`/required/\${name}\`, message: 'required property is not declared in properties'});
  return errors;
}

function mintVersion(name: string, schema: unknown, sideEffect: string, owner: string): string {
  const canonical = stableStringify({name, schema, side_effect: sideEffect, owner});
  return createHash('sha256').update(canonical).digest('hex').slice(0, VERSION_CHARS);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return \`[\${value.map(stableStringify).join(',')}]\`;
  if (typeof value === 'object' && value !== null)
    return \`{\${Object.keys(value)
      .sort()
      .map(key => \`\${JSON.stringify(key)}:\${stableStringify((value as Record<string, unknown>)[key])}\`)
      .join(',')}}\`;
  return JSON.stringify(value);
}

app.post('/v1/tools', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing X-Tenant-Id'});
  if (!hasReviewerRole(request.headers['x-roles'] as string | undefined))
    return reply.code(403).send({error: 'platform reviewer role required'});

  const body = request.body as Partial<RegistrationBody> | null;
  if (body === null || typeof body !== 'object' || typeof body.name !== 'string' || typeof body.side_effect !== 'string')
    return reply.code(400).send({error: 'name, schema, side_effect and owner are required'});
  if (!NAME_PATTERN.test(body.name)) return reply.code(400).send({error: 'invalid tool name'});
  if (SIDE_EFFECT_CLASSES[body.side_effect] !== true)
    return reply.code(400).send({error: 'side_effect must be read, write or irreversible'});
  const owner = body.owner ?? '';
  const errors = validateSchema(body.schema);
  if (errors.length > 0) return reply.code(422).send({errors});

  const version = mintVersion(body.name, body.schema, body.side_effect, owner);
  const existing = await store.get(body.name, version);
  if (existing !== null) return reply.code(409).send({error: 'version already registered'});
  const row = {name: body.name, version, side_effect: body.side_effect, owner};
  await store.insert(body.name, version, row);
  await store.audit({actor: tenant, action: 'register', name: body.name, version});
  request.log.info({name: body.name, version, actor: tenant}, 'registered');
  return reply.code(201).send(row);
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

type ToolRegistration struct {
	Name       string         \`json:"name"\`
	Version    string         \`json:"version"\`
	Schema     map[string]any \`json:"schema"\`
	SideEffect string         \`json:"side_effect"\`
	Owner      string         \`json:"owner"\`
}

type ToolStore struct{}

func (s *ToolStore) Put(name, version string, row map[string]any) error { return nil }

var store = &ToolStore{}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func register(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	var body ToolRegistration
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	// TODO: this draft treats any authenticated caller as entitled to register, accepts whatever
	// JSON object arrives as the schema, and takes the version from the request body so a later
	// registration overwrites the same version. Review all three.
	log.Printf("register tool=%s schema=%v", body.Name, body.Schema)
	row := map[string]any{
		"name":        body.Name,
		"version":     body.Version,
		"side_effect": body.SideEffect,
	}
	store.Put(body.Name, body.Version, row)
	writeJSON(rw, http.StatusCreated, map[string]any{"name": body.Name, "version": body.Version, "tenant": tenant})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/tools", register)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
      solution: `package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"regexp"
	"sort"
	"strings"
)

const (
	platformReviewerRole = "platform-reviewer"
	versionChars         = 16
)

var (
	sideEffectClasses = map[string]bool{"read": true, "write": true, "irreversible": true}
	namePattern       = regexp.MustCompile(\`^[a-z][a-z0-9_.-]{1,63}$\`)
)

type ToolRegistration struct {
	Name       string         \`json:"name"\`
	Schema     map[string]any \`json:"schema"\`
	SideEffect string         \`json:"side_effect"\`
	Owner      string         \`json:"owner"\`
}

type SchemaError struct {
	Pointer string \`json:"pointer"\`
	Message string \`json:"message"\`
}

type ToolStore struct{}

func (s *ToolStore) Get(name, version string) (map[string]any, error) { return nil, nil }

func (s *ToolStore) Insert(name, version string, row map[string]any) error { return nil }

func (s *ToolStore) Audit(row map[string]any) error { return nil }

var store = &ToolStore{}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func hasReviewerRole(roles string) bool {
	for _, role := range strings.Split(roles, ",") {
		if strings.TrimSpace(role) == platformReviewerRole {
			return true
		}
	}
	return false
}

func validateSchema(schema map[string]any) []SchemaError {
	errors := []SchemaError{}
	if schema["type"] != "object" {
		errors = append(errors, SchemaError{Pointer: "/type", Message: "schema type must be object"})
	}
	properties, _ := schema["properties"].(map[string]any)
	for name, raw := range properties {
		prop, ok := raw.(map[string]any)
		if !ok {
			errors = append(errors, SchemaError{Pointer: fmt.Sprintf("/properties/%s", name), Message: "property must be an object"})
			continue
		}
		if _, ok := prop["type"]; !ok {
			errors = append(errors, SchemaError{
				Pointer: fmt.Sprintf("/properties/%s/type", name),
				Message: "property needs a JSON Schema type",
			})
		}
	}
	if required, ok := schema["required"].([]any); ok {
		for _, raw := range required {
			name, _ := raw.(string)
			if _, ok := properties[name]; !ok {
				errors = append(errors, SchemaError{
					Pointer: fmt.Sprintf("/required/%s", name),
					Message: "required property is not declared in properties",
				})
			}
		}
	}
	sort.Slice(errors, func(i, j int) bool { return errors[i].Pointer < errors[j].Pointer })
	return errors
}

func mintVersion(name string, schema map[string]any, sideEffect, owner string) string {
	canonical, _ := json.Marshal(map[string]any{
		"name":        name,
		"schema":      schema,
		"side_effect": sideEffect,
		"owner":       owner,
	})
	sum := sha256.Sum256(canonical)
	return hex.EncodeToString(sum[:])[:versionChars]
}

func register(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-Tenant-Id"})
		return
	}
	if !hasReviewerRole(r.Header.Get("X-Roles")) {
		writeJSON(rw, http.StatusForbidden, map[string]string{"error": "platform reviewer role required"})
		return
	}
	var body ToolRegistration
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	if !namePattern.MatchString(body.Name) {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "name must be a lowercase dotted identifier"})
		return
	}
	if !sideEffectClasses[body.SideEffect] {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "side_effect must be read, write or irreversible"})
		return
	}
	if errors := validateSchema(body.Schema); len(errors) > 0 {
		writeJSON(rw, http.StatusUnprocessableEntity, map[string]any{"errors": errors})
		return
	}
	version := mintVersion(body.Name, body.Schema, body.SideEffect, body.Owner)
	if existing, err := store.Get(body.Name, version); err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	} else if existing != nil {
		writeJSON(rw, http.StatusConflict, map[string]string{"error": "version already registered"})
		return
	}
	row := map[string]any{
		"name":        body.Name,
		"version":     version,
		"side_effect": body.SideEffect,
		"owner":       body.Owner,
	}
	if err := store.Insert(body.Name, version, row); err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	store.Audit(map[string]any{"actor": tenant, "action": "register", "name": body.Name, "version": version})
	log.Printf("registered tool=%s version=%s actor=%s", body.Name, version, tenant)
	writeJSON(rw, http.StatusCreated, row)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/tools", register)
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
import spray.json._

object ToolApi {
  implicit val system: ActorSystem = ActorSystem("tool-registry")

  val store = ToolStore.open()

  val route: Route =
    path("v1" / "tools") {
      post {
        headerValueByName("X-Tenant-Id") { tenant =>
          entity(as[String]) { raw =>
            // TODO: this draft treats any authenticated caller as entitled to register, accepts
            // whatever JSON object arrives as the schema, and takes the version from the request
            // body so a later registration overwrites the same version. Review all three.
            val fields = raw.parseJson.asJsObject.fields
            val name = fields("name").convertTo[String]
            val version = fields("version").convertTo[String]
            system.log.info(s"register tool=$name schema=\${fields.get("schema")}")
            store.put(name, version, raw)
            complete(StatusCodes.Created, s"""{"name":"$name","version":"$version","tenant":"$tenant"}""")
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
import spray.json._

final case class SchemaError(pointer: String, message: String)

object ToolApi {
  implicit val system: ActorSystem = ActorSystem("tool-registry")

  val PlatformReviewerRole = "platform-reviewer"
  val SideEffectClasses = Set("read", "write", "irreversible")
  val NamePattern = "^[a-z][a-z0-9_.-]{1,63}$".r
  val VersionChars = 16

  val store = ToolStore.open()

  def hasReviewerRole(roles: String): Boolean =
    roles.split(",").map(_.trim).contains(PlatformReviewerRole)

  def validateSchema(schema: JsObject): List[SchemaError] = {
    val errors = List.newBuilder[SchemaError]
    val fields = schema.fields
    if (!fields.get("type").contains(JsString("object"))) {
      errors += SchemaError("/type", "schema type must be object")
    }
    val properties = fields.get("properties") match {
      case Some(JsObject(props)) => props
      case _                     => Map.empty[String, JsValue]
    }
    properties.foreach {
      case (name, JsObject(prop)) =>
        if (!prop.contains("type"))
          errors += SchemaError(s"/properties/$name/type", "property needs a JSON Schema type")
      case (name, _) =>
        errors += SchemaError(s"/properties/$name/type", "property must be an object with a type")
    }
    fields.get("required") match {
      case Some(JsArray(names)) =>
        names.foreach {
          case JsString(name) if !properties.contains(name) =>
            errors += SchemaError(s"/required/$name", "required property is not declared in properties")
          case _ => ()
        }
      case _ => ()
    }
    errors.result()
  }

  def mintVersion(name: String, schema: JsObject, sideEffect: String, owner: String): String = {
    val canonical = JsObject(
      "name" -> JsString(name),
      "schema" -> schema,
      "side_effect" -> JsString(sideEffect),
      "owner" -> JsString(owner)
    ).compactPrint
    val digest = MessageDigest.getInstance("SHA-256").digest(canonical.getBytes("UTF-8"))
    digest.map("%02x".format(_)).mkString.take(VersionChars)
  }

  val route: Route =
    path("v1" / "tools") {
      post {
        optionalHeaderValueByName("X-Tenant-Id") { tenantOpt =>
          optionalHeaderValueByName("X-Roles") { rolesOpt =>
            entity(as[String]) { raw =>
              val payload = raw.parseJson.asJsObject.fields
              val name = payload.get("name").collect { case JsString(v) => v }
              val schema = payload.get("schema").collect { case obj: JsObject => obj }
              val sideEffect = payload.get("side_effect").collect { case JsString(v) => v }
              val owner = payload.get("owner").collect { case JsString(v) => v }.getOrElse("")
              if (!tenantOpt.exists(_.nonEmpty)) {
                complete(StatusCodes.Unauthorized, """{"error":"missing X-Tenant-Id"}""")
              } else if (!rolesOpt.exists(hasReviewerRole)) {
                complete(StatusCodes.Forbidden, """{"error":"platform reviewer role required"}""")
              } else if (!name.exists(NamePattern.matches)) {
                complete(StatusCodes.BadRequest, """{"error":"name must be a lowercase dotted identifier"}""")
              } else if (!sideEffect.exists(SideEffectClasses.contains)) {
                complete(StatusCodes.BadRequest, """{"error":"side_effect must be read, write or irreversible"}""")
              } else
                schema match {
                  case None =>
                    complete(
                      StatusCodes.UnprocessableEntity,
                      """{"errors":[{"pointer":"/","message":"schema must be a JSON Schema object"}]}"""
                    )
                  case Some(candidate) if validateSchema(candidate).nonEmpty =>
                    val errors = validateSchema(candidate)
                      .map(e => s"""{"pointer":"\${e.pointer}","message":"\${e.message}"}""")
                      .mkString("[", ",", "]")
                    complete(StatusCodes.UnprocessableEntity, s"""{"errors":$errors}""")
                  case Some(candidate) =>
                    val tenant = tenantOpt.get
                    val toolName = name.get
                    val version = mintVersion(toolName, candidate, sideEffect.get, owner)
                    store.get(toolName, version) match {
                      case Some(_) =>
                        complete(StatusCodes.Conflict, """{"error":"version already registered"}""")
                      case None =>
                        store.insert(toolName, version, candidate.compactPrint)
                        store.audit(tenant, "register", toolName, version)
                        system.log.info(s"registered tool=$toolName version=$version actor=$tenant")
                        complete(
                          StatusCodes.Created,
                          s"""{"name":"$toolName","version":"$version","side_effect":"\${sideEffect.get}","owner":"$owner"}"""
                        )
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

struct ToolStore {
  void put(const std::string& name, const std::string& version, const json& row);
};

ToolStore store;

int main() {
  httplib::Server svr;

  svr.Post("/v1/tools", [](const httplib::Request& req, httplib::Response& res) {
    const auto tenant = req.get_header_value("X-Tenant-Id");
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object() || !body.contains("name")) {
      res.status = 400;
      res.set_content(R"({"error":"invalid json"})", "application/json");
      return;
    }
    // TODO: this draft treats any authenticated caller as entitled to register, accepts whatever
    // JSON object arrives as the schema, and takes the version from the request body so a later
    // registration overwrites the same version. Review all three.
    std::cerr << "register tool=" << body["name"] << " schema=" << body.value("schema", json()) << "\\n";
    const auto name = body["name"].get<std::string>();
    const auto version = body.value("version", std::string());
    store.put(name, version, json{{"name", name}, {"version", version}, {"side_effect", body.value("side_effect", std::string())}});
    res.status = 201;
    res.set_content(json{{"name", name}, {"version", version}, {"tenant", tenant}}.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <iostream>
#include <optional>
#include <regex>
#include <set>
#include <string>

using json = nlohmann::json;

const std::string kPlatformReviewerRole = "platform-reviewer";
const std::set<std::string> kSideEffectClasses = {"read", "write", "irreversible"};
const std::regex kNamePattern("^[a-z][a-z0-9_.-]{1,63}$");
constexpr std::size_t kVersionChars = 16;

struct ToolStore {
  std::optional<json> get(const std::string& name, const std::string& version);
  void insert(const std::string& name, const std::string& version, const json& row);
  void audit(const json& row);
};

ToolStore store;
std::string sha256Hex(const std::string& input);

bool hasReviewerRole(const std::string& roles) {
  std::stringstream stream(roles);
  std::string role;
  while (std::getline(stream, role, ',')) {
    while (!role.empty() && role.front() == ' ') role.erase(role.begin());
    while (!role.empty() && role.back() == ' ') role.pop_back();
    if (role == kPlatformReviewerRole) return true;
  }
  return false;
}

json validateSchema(const json& schema) {
  json errors = json::array();
  if (!schema.is_object() || schema.value("type", std::string()) != "object") {
    errors.push_back({{"pointer", "/type"}, {"message", "schema type must be object"}});
  }
  json properties = json::object();
  if (schema.is_object() && schema.contains("properties") && schema["properties"].is_object()) {
    properties = schema["properties"];
  }
  for (auto it = properties.begin(); it != properties.end(); ++it) {
    if (!it.value().is_object() || !it.value().contains("type")) {
      errors.push_back(
          {{"pointer", "/properties/" + it.key() + "/type"}, {"message", "property needs a JSON Schema type"}});
    }
  }
  if (schema.is_object() && schema.contains("required") && schema["required"].is_array()) {
    for (const auto& name : schema["required"]) {
      if (!name.is_string() || !properties.contains(name.get<std::string>())) {
        errors.push_back({{"pointer", "/required/" + name.dump()},
                          {"message", "required property is not declared in properties"}});
      }
    }
  }
  return errors;
}

std::string mintVersion(const std::string& name, const json& schema, const std::string& sideEffect,
                        const std::string& owner) {
  const json canonical = {
      {"name", name}, {"schema", schema}, {"side_effect", sideEffect}, {"owner", owner}};
  return sha256Hex(canonical.dump()).substr(0, kVersionChars);
}

int main() {
  httplib::Server svr;

  svr.Post("/v1/tools", [](const httplib::Request& req, httplib::Response& res) {
    const auto tenant = req.get_header_value("X-Tenant-Id");
    if (tenant.empty()) {
      res.status = 401;
      res.set_content(R"({"error":"missing X-Tenant-Id"})", "application/json");
      return;
    }
    if (!hasReviewerRole(req.get_header_value("X-Roles"))) {
      res.status = 403;
      res.set_content(R"({"error":"platform reviewer role required"})", "application/json");
      return;
    }
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object() || !body.contains("name") || !body["name"].is_string() ||
        !body.contains("schema") || !body.contains("side_effect")) {
      res.status = 400;
      res.set_content(R"({"error":"name, schema, side_effect and owner are required"})", "application/json");
      return;
    }
    const auto name = body["name"].get<std::string>();
    if (!std::regex_match(name, kNamePattern)) {
      res.status = 400;
      res.set_content(R"({"error":"name must be a lowercase dotted identifier"})", "application/json");
      return;
    }
    const auto sideEffect = body["side_effect"].get<std::string>();
    if (kSideEffectClasses.count(sideEffect) == 0) {
      res.status = 400;
      res.set_content(R"({"error":"side_effect must be read, write or irreversible"})", "application/json");
      return;
    }
    const json errors = validateSchema(body["schema"]);
    if (!errors.empty()) {
      res.status = 422;
      res.set_content(json{{"errors", errors}}.dump(), "application/json");
      return;
    }
    const auto owner = body.value("owner", std::string());
    const auto version = mintVersion(name, body["schema"], sideEffect, owner);
    if (store.get(name, version).has_value()) {
      res.status = 409;
      res.set_content(R"({"error":"version already registered"})", "application/json");
      return;
    }
    const json row = {{"name", name}, {"version", version}, {"side_effect", sideEffect}, {"owner", owner}};
    store.insert(name, version, row);
    store.audit(json{{"actor", tenant}, {"action", "register"}, {"name", name}, {"version", version}});
    std::cerr << "registered tool=" << name << " version=" << version << " actor=" << tenant << "\\n";
    res.status = 201;
    res.set_content(row.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  hints: [
    'Order the guards by cost and by trust: tenant (401), role (403), name and side_effect shape (400), schema validation (422), then the store. Every rejection happens before a write, and the role check happens before the body is even parsed.',
    'The version is a function of the definition, not an input: hash `(name, schema, side_effect, owner)` canonically (sorted keys) and take a short prefix. That makes re-registration of the same content idempotent-by-conflict (409) and makes a changed definition a different version instead of a silent overwrite.',
    'A JSON Schema check that only says "invalid" is not reviewable. Return the JSON pointer of the first bad node — `/type`, `/properties/amount/type`, `/required/currency` — because the tool author, not the registrar, has to fix it.',
  ],
  debrief: `The interviewer is testing whether you can review a generated handler at the boundary where a *change* is introduced. The draft reads fine because the demo registers one tool from an admin token. Three defects are being checked: entitlement (authenticating is not authorising — the platform reviewer role is a separate claim), validation with a location (a schema that is not JSON Schema must never be stored, and the rejection has to name the failing pointer), and immutability (a version is content-addressed, so a re-registration is a 409 rather than an overwrite that changes what running agents call). The habit to name out loud is that the registry is a release process, not a CRUD table: privileged write, validated artefact, immutable version, audited actor. Real registries add schema diff review, deprecation windows, and signed provenance of the definition itself.`,
};
