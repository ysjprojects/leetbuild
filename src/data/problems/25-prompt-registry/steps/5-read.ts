import type {Step} from '@/lib/types';

export const readStep: Step = {
  id: 'read',
  title: 'Reads and renders: the eval of these bytes, values as text',
  concept: 'http',
  file: 'read',
  focus: ['client', 'registry', 'redis'],
  task: `## Task

**Starting point.** The starter serves \`GET /v1/prompts/{name}/versions/{v}\`, answering the stored
version (\`name\`, \`version\`, \`content_hash\`, \`template\`, \`variables\`) with an \`eval_record\` from
\`evals.latest\`, and \`POST /v1/prompts/{name}/versions/{v}/render\` with body \`{"values": {...}}\`,
answering \`{name, version, content_hash, rendered}\` after replacing each declared placeholder in turn.
Both answer 401 without \`X-Tenant-Id\`. The preview screen works. It hides 4 flaws.

**Failure mode the checks target.** Replacing one variable after another is template injection: a
value containing \`{{tone}}\` becomes a placeholder for the next replacement, so a caller writes into
slots the author owns. The eval record is the subtle one: a reader sees the verdict on whichever
version was judged last, other bytes entirely. And a missing version answers 200 with an empty record
that a client caches as a prompt.

Requirements:

- A version the tenant does not have is **404** on both routes.
- \`eval_record\` is the verdict on this version's own content hash (\`evals.get\`), \`null\` when it was
  never judged.
- Render in **one pass** over the template (\`PLACEHOLDER\` with a replacement function): a value is
  inserted as text and not scanned again.
- \`values\` holds exactly the declared variables, each a string of at most **1024 bytes**
  (\`MAX_VALUE_BYTES\`); **422** otherwise.`,
  sequence: {
    participants: ['Client', 'registryd', 'Redis'],
    messages: [
      {
        from: 'Client',
        to: 'registryd',
        label: 'POST /v1/prompts/support-reply/versions/3/render {values}',
        kind: 'sync',
      },
      {from: 'registryd', to: 'Redis', label: 'versions.get(tenant, name, 3)', kind: 'sync'},
      {from: 'Redis', to: 'registryd', label: 'record · none → 404', kind: 'reply'},
      {from: 'registryd', to: 'registryd', label: 'values = variables · strings ≤ 1 KiB · else 422', kind: 'sync'},
      {from: 'registryd', to: 'registryd', label: 'one pass: PLACEHOLDER → values[key]', kind: 'sync'},
      {from: 'registryd', to: 'Client', label: '{content_hash, rendered}', kind: 'reply'},
      {from: 'Client', to: 'registryd', label: 'GET /v1/prompts/support-reply/versions/3', kind: 'sync'},
      {from: 'registryd', to: 'Redis', label: 'evals.get(tenant, name, content_hash)', kind: 'sync'},
    ],
  },
  checks: [
    {
      id: 'read-route',
      title: 'Serves the version and renders it',
      detail:
        'GET answers name, version, content_hash, template, variables and an eval_record field; render with every value answers the filled template; both are 401 without X-Tenant-Id.',
      match: {
        python: {all: [/@app\.get\(\s*["']\/v1\/prompts\/\{name\}\/versions\/\{v\}["']/]},
        typescript: {all: [/app\.get\(\s*['"]\/v1\/prompts\/:name\/versions\/:v['"]/]},
        go: {all: [/HandleFunc\(\s*"GET \/v1\/prompts\/\{name\}\/versions\/\{v\}"/]},
        scala: {all: [/"v1"\s*\/\s*"prompts"\s*\/\s*Segment\s*\/\s*"versions"\s*\/\s*IntNumber/, /\bget\s*\{/]},
        cpp: {all: [/svr\.Get\(\s*R"\(\/v1\/prompts\//]},
      },
    },
    {
      id: 'missing-404',
      title: 'A version the tenant does not have is 404',
      detail:
        'A version never registered, another tenant’s version, and a render of a missing version all answer 404 with no template in the body. The starter answers 200 with an empty record.',
      match: {
        python: {all: [/status_code\s*=\s*404/]},
        typescript: {all: [/code\(\s*404\s*\)/]},
        go: {all: [/StatusNotFound/]},
        scala: {all: [/StatusCodes\.NotFound/]},
        cpp: {all: [/\b404\b/]},
      },
    },
    {
      id: 'eval-by-hash',
      title: 'Attaches the eval of exactly these bytes',
      detail:
        'Version 3 carries its own passing verdict even after version 4 was judged later and failed; version 5, never judged, carries null. The starter attaches the name’s latest verdict.',
      match: {
        python: {all: [/evals\.get\(/], none: [/evals\.latest\(/]},
        typescript: {all: [/evals\.get\(/], none: [/evals\.latest\(/]},
        go: {all: [/evals\.Get\(/], none: [/evals\.Latest\(/]},
        scala: {all: [/Evals\.get\(/], none: [/Evals\.latest\(/]},
        cpp: {all: [/evals::get\(/], none: [/evals::latest\(/]},
      },
    },
    {
      id: 'render-one-pass',
      title: 'Renders in one pass, values as text',
      detail:
        'customer_name = "{{tone}}" with tone = "rude" renders "Hi {{tone}}, answer in a rude tone.": the value lands as text and is not scanned again. The starter replaces variable after variable and fills the injected slot.',
      match: {
        python: {all: [/PLACEHOLDER\.sub\(|re\.sub\(\s*PLACEHOLDER/], none: [/\.replace\(\s*["']\{\{/]},
        typescript: {all: [/\.replace\(\s*PLACEHOLDER\s*,/], none: [/replaceAll\(\s*['"]\{\{/]},
        go: {all: [/config\.Placeholder\.ReplaceAllStringFunc\(/], none: [/strings\.Replace(All)?\(/]},
        scala: {all: [/Config\.Placeholder\.replaceAllIn\(/], none: [/\.replace\(\s*"\{\{/]},
        cpp: {all: [/sregex_iterator\([\s\S]{0,120}?config::kPlaceholder/], none: [/rendered\.replace\(/]},
      },
    },
    {
      id: 'value-limits',
      title: 'Values are exactly the declared variables, strings of at most 1 KiB',
      detail:
        'A missing value, a value for an undeclared placeholder, a value that is not a string, or one of 1025 bytes is 422; 1024 bytes renders. The starter renders a missing value as nothing and ignores the rest.',
      match: {
        python: {all: [/MAX_VALUE_BYTES/, /status_code\s*=\s*422/]},
        typescript: {all: [/MAX_VALUE_BYTES/, /code\(\s*422\s*\)/]},
        go: {all: [/maxValueBytes/, /StatusUnprocessableEntity/]},
        scala: {all: [/MaxValueBytes/, /StatusCodes\.UnprocessableEntity/]},
        cpp: {all: [/kMaxValueBytes/, /\b422\b/]},
      },
    },
  ],
  code: {
    python: {
      starter: `from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel

from prompts.evals import evals
from prompts.versions import versions

app = FastAPI()


class RenderRequest(BaseModel):
    values: dict = {}


@app.get("/v1/prompts/{name}/versions/{v}")
def read_version(name: str, v: int, tenant: str | None = Header(default=None, alias="X-Tenant-Id")) -> dict:
    # TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
    if tenant is None or tenant == "":
        raise HTTPException(status_code=401, detail="missing X-Tenant-Id")
    record = versions.get(tenant, name, v) or {}
    return {**record, "eval_record": evals.latest(tenant, name)}


@app.post("/v1/prompts/{name}/versions/{v}/render")
def render_version(name: str, v: int, body: RenderRequest, tenant: str | None = Header(default=None, alias="X-Tenant-Id")) -> dict:
    if tenant is None or tenant == "":
        raise HTTPException(status_code=401, detail="missing X-Tenant-Id")
    record = versions.get(tenant, name, v) or {}
    rendered = record.get("template", "")
    for variable in record.get("variables", []):
        rendered = rendered.replace("{{" + variable + "}}", str(body.values.get(variable, "")))
    return {"name": name, "version": v, "content_hash": record.get("content_hash", ""), "rendered": rendered}
`,
      solution: `from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel

from prompts.config import PLACEHOLDER
from prompts.evals import evals
from prompts.versions import versions

app = FastAPI()

MAX_VALUE_BYTES = 1024


class RenderRequest(BaseModel):
    values: dict = {}


def tenant_version(tenant: str | None, name: str, v: int) -> tuple[str, dict]:
    if tenant is None or tenant == "":
        raise HTTPException(status_code=401, detail="missing X-Tenant-Id")
    record = versions.get(tenant, name, v)
    if record is None:
        raise HTTPException(status_code=404, detail=f"{name} v{v} not found")
    return tenant, record


@app.get("/v1/prompts/{name}/versions/{v}")
def read_version(name: str, v: int, tenant: str | None = Header(default=None, alias="X-Tenant-Id")) -> dict:
    tenant, record = tenant_version(tenant, name, v)
    return {**record, "eval_record": evals.get(tenant, name, record["content_hash"])}


@app.post("/v1/prompts/{name}/versions/{v}/render")
def render_version(name: str, v: int, body: RenderRequest, tenant: str | None = Header(default=None, alias="X-Tenant-Id")) -> dict:
    tenant, record = tenant_version(tenant, name, v)
    values = body.values
    if set(values) != set(record["variables"]):
        raise HTTPException(status_code=422, detail=f"values must be exactly {record['variables']}")
    for key, value in values.items():
        if not isinstance(value, str) or len(value.encode("utf-8")) > MAX_VALUE_BYTES:
            raise HTTPException(status_code=422, detail=f"{key} must be a string of at most {MAX_VALUE_BYTES} bytes")
    # One pass: a value is inserted as text and never scanned for placeholders again.
    rendered = PLACEHOLDER.sub(lambda match: values[match.group(1)], record["template"])
    return {"name": name, "version": v, "content_hash": record["content_hash"], "rendered": rendered}
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';

import {evals} from 'prompts/evals';
import {versions} from 'prompts/versions';

export const app = Fastify();

interface RenderBody {
  values?: Record<string, unknown>;
}

app.get('/v1/prompts/:name/versions/:v', async (request, reply) => {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing X-Tenant-Id'});
  const {name, v} = request.params as {name: string; v: string};
  const record = await versions.get(tenant, name, Number(v));
  return reply.code(200).send({...record, eval_record: await evals.latest(tenant, name)});
});

app.post('/v1/prompts/:name/versions/:v/render', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing X-Tenant-Id'});
  const {name, v} = request.params as {name: string; v: string};
  const record = await versions.get(tenant, name, Number(v));
  const values = (request.body as RenderBody).values ?? {};
  let rendered = record?.template ?? '';
  for (const variable of record?.variables ?? []) rendered = rendered.replaceAll('{{' + variable + '}}', String(values[variable] ?? ''));
  return reply.code(200).send({name, version: Number(v), content_hash: record?.content_hash ?? '', rendered});
});
`,
      solution: `import Fastify from 'fastify';

import {PLACEHOLDER} from 'prompts/config';
import {evals} from 'prompts/evals';
import {versions} from 'prompts/versions';

export const app = Fastify();

export const MAX_VALUE_BYTES = 1024;

interface RenderBody {
  values?: Record<string, unknown>;
}

app.get('/v1/prompts/:name/versions/:v', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing X-Tenant-Id'});
  const {name, v} = request.params as {name: string; v: string};
  const record = await versions.get(tenant, name, Number(v));
  if (record === null) return reply.code(404).send({error: \`\${name} v\${v} not found\`});
  return reply.code(200).send({...record, eval_record: await evals.get(tenant, name, record.content_hash)});
});

app.post('/v1/prompts/:name/versions/:v/render', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing X-Tenant-Id'});
  const {name, v} = request.params as {name: string; v: string};
  const record = await versions.get(tenant, name, Number(v));
  if (record === null) return reply.code(404).send({error: \`\${name} v\${v} not found\`});
  const values = ((request.body ?? {}) as RenderBody).values ?? {};
  const exact = Object.keys(values).length === record.variables.length && record.variables.every(key => Object.hasOwn(values, key));
  if (!exact) return reply.code(422).send({error: \`values must be exactly \${record.variables.join(', ')}\`});
  for (const [key, value] of Object.entries(values)) {
    if (typeof value !== 'string' || new TextEncoder().encode(value).length > MAX_VALUE_BYTES)
      return reply.code(422).send({error: \`\${key} must be a string of at most \${MAX_VALUE_BYTES} bytes\`});
  }
  // One pass: a value is inserted as text and never scanned for placeholders again.
  const rendered = record.template.replace(PLACEHOLDER, (_match, key: string) => values[key] as string);
  return reply.code(200).send({name, version: record.version, content_hash: record.content_hash, rendered});
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"log"
	"net/http"
	"strconv"
	"strings"

	"prompts/evals"    // evals.Get/Latest(ctx, tenant, name, …) — provided
	"prompts/versions" // versions.Get(ctx, tenant, name, version) — provided
)

// VersionRead is the read's answer: the version and the eval record attached to it.
type VersionRead struct {
	Name        string        \`json:"name"\`
	Version     int           \`json:"version"\`
	ContentHash string        \`json:"content_hash"\`
	Template    string        \`json:"template"\`
	Variables   []string      \`json:"variables"\`
	EvalRecord  *evals.Record \`json:"eval_record"\`
}

type RenderRequest struct {
	Values map[string]any \`json:"values"\`
}

type Rendered struct {
	Name        string \`json:"name"\`
	Version     int    \`json:"version"\`
	ContentHash string \`json:"content_hash"\`
	Rendered    string \`json:"rendered"\`
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

// lookup authenticates the tenant and reads the version in the path.
func lookup(rw http.ResponseWriter, r *http.Request) (string, *versions.Version, bool) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-Tenant-Id"})
		return "", nil, false
	}
	v, _ := strconv.Atoi(r.PathValue("v"))
	record, err := versions.Get(r.Context(), tenant, r.PathValue("name"), v)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return "", nil, false
	}
	if record == nil {
		record = &versions.Version{Name: r.PathValue("name"), Version: v}
	}
	return tenant, record, true
}

func readVersion(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
	tenant, record, ok := lookup(rw, r)
	if !ok {
		return
	}
	latest, err := evals.Latest(r.Context(), tenant, record.Name)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	writeJSON(rw, http.StatusOK, VersionRead{record.Name, record.Version, record.ContentHash, record.Template, record.Variables, latest})
}

func renderVersion(rw http.ResponseWriter, r *http.Request) {
	_, record, ok := lookup(rw, r)
	if !ok {
		return
	}
	var body RenderRequest
	json.NewDecoder(r.Body).Decode(&body)
	rendered := record.Template
	for _, variable := range record.Variables {
		value, _ := body.Values[variable].(string)
		rendered = strings.ReplaceAll(rendered, "{{"+variable+"}}", value)
	}
	writeJSON(rw, http.StatusOK, Rendered{record.Name, record.Version, record.ContentHash, rendered})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/prompts/{name}/versions/{v}", readVersion)
	mux.HandleFunc("POST /v1/prompts/{name}/versions/{v}/render", renderVersion)
}

func main() {
	mux := http.NewServeMux()
	register(mux)
	log.Fatal(http.ListenAndServe(":8443", mux))
}
`,
      solution: `package main

import (
	"encoding/json"
	"log"
	"net/http"
	"strconv"

	"prompts/config"   // config.Placeholder — provided
	"prompts/evals"    // evals.Get/Latest(ctx, tenant, name, …) — provided
	"prompts/versions" // versions.Get(ctx, tenant, name, version) — provided
)

const maxValueBytes = 1024

// VersionRead is the read's answer: the version and the eval record attached to it.
type VersionRead struct {
	Name        string        \`json:"name"\`
	Version     int           \`json:"version"\`
	ContentHash string        \`json:"content_hash"\`
	Template    string        \`json:"template"\`
	Variables   []string      \`json:"variables"\`
	EvalRecord  *evals.Record \`json:"eval_record"\`
}

type RenderRequest struct {
	Values map[string]any \`json:"values"\`
}

type Rendered struct {
	Name        string \`json:"name"\`
	Version     int    \`json:"version"\`
	ContentHash string \`json:"content_hash"\`
	Rendered    string \`json:"rendered"\`
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

// lookup authenticates the tenant and reads the version in the path: 404 when the tenant has none.
func lookup(rw http.ResponseWriter, r *http.Request) (string, *versions.Version, bool) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-Tenant-Id"})
		return "", nil, false
	}
	v, err := strconv.Atoi(r.PathValue("v"))
	if err != nil {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "version not found"})
		return "", nil, false
	}
	record, err := versions.Get(r.Context(), tenant, r.PathValue("name"), v)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return "", nil, false
	}
	if record == nil {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "version not found"})
		return "", nil, false
	}
	return tenant, record, true
}

func readVersion(rw http.ResponseWriter, r *http.Request) {
	tenant, record, ok := lookup(rw, r)
	if !ok {
		return
	}
	verdict, err := evals.Get(r.Context(), tenant, record.Name, record.ContentHash)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	writeJSON(rw, http.StatusOK, VersionRead{record.Name, record.Version, record.ContentHash, record.Template, record.Variables, verdict})
}

func renderVersion(rw http.ResponseWriter, r *http.Request) {
	_, record, ok := lookup(rw, r)
	if !ok {
		return
	}
	var body RenderRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || len(body.Values) != len(record.Variables) {
		writeJSON(rw, http.StatusUnprocessableEntity, map[string]string{"error": "values must be exactly the declared variables"})
		return
	}
	values := make(map[string]string, len(record.Variables))
	for _, variable := range record.Variables {
		value, isString := body.Values[variable].(string)
		if !isString || len(value) > maxValueBytes {
			writeJSON(rw, http.StatusUnprocessableEntity, map[string]string{"error": variable + " must be a string of at most 1024 bytes"})
			return
		}
		values[variable] = value
	}
	// One pass: a value is inserted as text and never scanned for placeholders again.
	rendered := config.Placeholder.ReplaceAllStringFunc(record.Template, func(placeholder string) string {
		return values[config.Placeholder.FindStringSubmatch(placeholder)[1]]
	})
	writeJSON(rw, http.StatusOK, Rendered{record.Name, record.Version, record.ContentHash, rendered})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/prompts/{name}/versions/{v}", readVersion)
	mux.HandleFunc("POST /v1/prompts/{name}/versions/{v}/render", renderVersion)
}

func main() {
	mux := http.NewServeMux()
	register(mux)
	log.Fatal(http.ListenAndServe(":8443", mux))
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
import spray.json.{JsString, JsValue, RootJsonFormat}

import prompts.{EvalRecord, Evals, Versions}

/** The read's answer: the version and the eval record attached to it. */
final case class VersionRead(name: String, version: Int, content_hash: String, template: String, variables: List[String], eval_record: Option[EvalRecord])
final case class RenderRequest(values: Option[Map[String, JsValue]])
final case class Rendered(name: String, version: Int, content_hash: String, rendered: String)

object PromptReads {
  implicit val system: ActorSystem = ActorSystem("prompt-registry")
  implicit val evalFormat: RootJsonFormat[EvalRecord] = jsonFormat5(EvalRecord)
  implicit val readFormat: RootJsonFormat[VersionRead] = jsonFormat6(VersionRead)
  implicit val renderFormat: RootJsonFormat[RenderRequest] = jsonFormat1(RenderRequest)
  implicit val renderedFormat: RootJsonFormat[Rendered] = jsonFormat4(Rendered)

  val route: Route =
    pathPrefix("v1" / "prompts" / Segment / "versions" / IntNumber) { (name, v) =>
      optionalHeaderValueByName("X-Tenant-Id") {
        case None | Some("") => complete(StatusCodes.Unauthorized, """{"error":"missing X-Tenant-Id"}""")
        case Some(tenant) =>
          // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
          val record = Versions.get(tenant, name, v)
          concat(
            pathEndOrSingleSlash {
              get {
                complete(
                  VersionRead(
                    name,
                    v,
                    record.map(_.content_hash).getOrElse(""),
                    record.map(_.template).getOrElse(""),
                    record.map(_.variables).getOrElse(Nil),
                    Evals.latest(tenant, name)
                  )
                )
              }
            },
            path("render") {
              post {
                entity(as[RenderRequest]) { body =>
                  val values = body.values.getOrElse(Map.empty)
                  var rendered = record.map(_.template).getOrElse("")
                  for (variable <- record.map(_.variables).getOrElse(Nil)) {
                    val value = values.get(variable).collect { case JsString(s) => s }.getOrElse("")
                    rendered = rendered.replace("{{" + variable + "}}", value)
                  }
                  complete(Rendered(name, v, record.map(_.content_hash).getOrElse(""), rendered))
                }
              }
            }
          )
      }
    }

  def main(args: Array[String]): Unit = {
    Http().newServerAt("0.0.0.0", 8443).bind(route)
  }
}
`,
      solution: `import scala.util.matching.Regex

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json.DefaultJsonProtocol._
import spray.json.{JsString, JsValue, RootJsonFormat}

import prompts.{Config, EvalRecord, Evals, Versions}

/** The read's answer: the version and the eval record attached to it. */
final case class VersionRead(name: String, version: Int, content_hash: String, template: String, variables: List[String], eval_record: Option[EvalRecord])
final case class RenderRequest(values: Option[Map[String, JsValue]])
final case class Rendered(name: String, version: Int, content_hash: String, rendered: String)

object PromptReads {
  implicit val system: ActorSystem = ActorSystem("prompt-registry")
  implicit val evalFormat: RootJsonFormat[EvalRecord] = jsonFormat5(EvalRecord)
  implicit val readFormat: RootJsonFormat[VersionRead] = jsonFormat6(VersionRead)
  implicit val renderFormat: RootJsonFormat[RenderRequest] = jsonFormat1(RenderRequest)
  implicit val renderedFormat: RootJsonFormat[Rendered] = jsonFormat4(Rendered)

  val MaxValueBytes = 1024

  val route: Route =
    pathPrefix("v1" / "prompts" / Segment / "versions" / IntNumber) { (name, v) =>
      optionalHeaderValueByName("X-Tenant-Id") {
        case None | Some("") => complete(StatusCodes.Unauthorized, """{"error":"missing X-Tenant-Id"}""")
        case Some(tenant) =>
          Versions.get(tenant, name, v) match {
            case None => complete(StatusCodes.NotFound, s"""{"error":"$name v$v not found"}""")
            case Some(record) =>
              concat(
                pathEndOrSingleSlash {
                  get {
                    val verdict = Evals.get(tenant, name, record.content_hash)
                    complete(VersionRead(record.name, record.version, record.content_hash, record.template, record.variables, verdict))
                  }
                },
                path("render") {
                  post {
                    entity(as[RenderRequest]) { body =>
                      val raw = body.values.getOrElse(Map.empty)
                      val values = raw.collect { case (key, JsString(value)) => key -> value }
                      val valid = raw.keySet == record.variables.toSet && values.size == raw.size &&
                        values.values.forall(_.getBytes("UTF-8").length <= MaxValueBytes)
                      if (!valid) {
                        complete(StatusCodes.UnprocessableEntity, """{"error":"values must be exactly the declared variables, strings of at most 1024 bytes"}""")
                      } else {
                        // One pass: a value is inserted as text and never scanned for placeholders again.
                        val rendered = Config.Placeholder.replaceAllIn(record.template, m => Regex.quoteReplacement(values(m.group(1))))
                        complete(Rendered(record.name, record.version, record.content_hash, rendered))
                      }
                    }
                  }
                }
              )
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
#include <vector>

#include "prompts/evals.h"     // evals::get/latest(tenant, name, …) — provided
#include "prompts/versions.h"  // versions::get(tenant, name, version) — provided

using json = nlohmann::json;

void reject(httplib::Response& res, int status, const std::string& error) {
  res.status = status;
  res.set_content(json({{"error", error}}).dump(), "application/json");
}

void read_version(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) return reject(res, 401, "missing X-Tenant-Id");
  const std::string name = req.matches[1].str();
  json body = versions::get(tenant, name, std::stoi(req.matches[2].str())).value_or(json::object());
  const auto latest = evals::latest(tenant, name);
  body["eval_record"] = latest ? *latest : json();
  res.status = 200;
  res.set_content(body.dump(), "application/json");
}

void render_version(const httplib::Request& req, httplib::Response& res) {
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) return reject(res, 401, "missing X-Tenant-Id");
  const std::string name = req.matches[1].str();
  const int v = std::stoi(req.matches[2].str());
  const json record = versions::get(tenant, name, v).value_or(json::object());
  const json body = json::parse(req.body, nullptr, false);
  const json values = body.is_object() && body.contains("values") ? body["values"] : json::object();
  std::string rendered = record.value("template", "");
  for (const auto& variable : record.value("variables", std::vector<std::string>{})) {
    const std::string token = "{{" + variable + "}}";
    const std::string value = values.contains(variable) && values[variable].is_string() ? values[variable].get<std::string>() : "";
    for (size_t at = rendered.find(token); at != std::string::npos; at = rendered.find(token, at + value.size())) rendered.replace(at, token.size(), value);
  }
  res.status = 200;
  res.set_content(json({{"name", name}, {"version", v}, {"content_hash", record.value("content_hash", "")}, {"rendered", rendered}}).dump(), "application/json");
}

void register_routes(httplib::Server& svr) {
  svr.Get(R"(/v1/prompts/([^/]+)/versions/(\\d+))", read_version);
  svr.Post(R"(/v1/prompts/([^/]+)/versions/(\\d+)/render)", render_version);
}

int main() {
  httplib::Server svr;
  register_routes(svr);
  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <optional>
#include <regex>
#include <string>

#include "prompts/config.h"    // config::kPlaceholder — provided
#include "prompts/evals.h"     // evals::get/latest(tenant, name, …) — provided
#include "prompts/versions.h"  // versions::get(tenant, name, version) — provided

using json = nlohmann::json;

constexpr size_t kMaxValueBytes = 1024;

void reject(httplib::Response& res, int status, const std::string& error) {
  res.status = status;
  res.set_content(json({{"error", error}}).dump(), "application/json");
}

// The tenant's version in the path: 401 without a tenant, 404 when the tenant has none.
std::optional<std::pair<std::string, json>> tenant_version(const httplib::Request& req, httplib::Response& res) {
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) {
    reject(res, 401, "missing X-Tenant-Id");
    return std::nullopt;
  }
  const auto record = versions::get(tenant, req.matches[1].str(), std::stoi(req.matches[2].str()));
  if (!record) {
    reject(res, 404, "version not found");
    return std::nullopt;
  }
  return std::make_pair(tenant, *record);
}

void read_version(const httplib::Request& req, httplib::Response& res) {
  const auto found = tenant_version(req, res);
  if (!found) return;
  const auto& [tenant, record] = *found;
  json body = record;
  const auto verdict = evals::get(tenant, record["name"].get<std::string>(), record["content_hash"].get<std::string>());
  body["eval_record"] = verdict ? *verdict : json();
  res.status = 200;
  res.set_content(body.dump(), "application/json");
}

void render_version(const httplib::Request& req, httplib::Response& res) {
  const auto found = tenant_version(req, res);
  if (!found) return;
  const json& record = found->second;
  const json body = json::parse(req.body, nullptr, false);
  const json values = body.is_object() && body.contains("values") && body["values"].is_object() ? body["values"] : json::object();
  const auto variables = record["variables"].get<std::vector<std::string>>();
  if (values.size() != variables.size()) return reject(res, 422, "values must be exactly the declared variables");
  for (const auto& variable : variables) {
    if (!values.contains(variable) || !values[variable].is_string() || values[variable].get<std::string>().size() > kMaxValueBytes)
      return reject(res, 422, variable + " must be a string of at most 1024 bytes");
  }
  // One pass: a value is inserted as text and never scanned for placeholders again.
  const std::string text = record["template"].get<std::string>();
  std::string rendered;
  auto last = text.cbegin();
  for (auto it = std::sregex_iterator(text.begin(), text.end(), config::kPlaceholder); it != std::sregex_iterator(); ++it) {
    rendered.append(last, text.cbegin() + it->position());
    rendered += values[(*it)[1].str()].get<std::string>();
    last = text.cbegin() + it->position() + it->length();
  }
  rendered.append(last, text.cend());
  res.status = 200;
  res.set_content(json({{"name", record["name"]}, {"version", record["version"]}, {"content_hash", record["content_hash"]}, {"rendered", rendered}}).dump(),
                  "application/json");
}

void register_routes(httplib::Server& svr) {
  svr.Get(R"(/v1/prompts/([^/]+)/versions/(\\d+))", read_version);
  svr.Post(R"(/v1/prompts/([^/]+)/versions/(\\d+)/render)", render_version);
}

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

T, N = "t1", "support-reply"
TEMPLATE = "Hi {{customer_name}}, answer in a {{tone}} tone."
INJECTED = "{" + "{tone}" + "}"


def _sha(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _register(ctx, version, template=TEMPLATE):
    record = {"name": N, "version": version, "content_hash": _sha(template), "template": template, "variables": ["customer_name", "tone"]}
    ctx.redis.set(f"prompts:version:{T}:{N}:{version}", json.dumps(record))
    return record


def _judge(ctx, record, passed):
    verdict = {"eval_id": "ev-" + record["content_hash"][:12], "passed": passed, "score": 0.93 if passed else 0.41, "content_hash": record["content_hash"], "version": record["version"]}
    ctx.redis.set(f"prompts:eval:{T}:{N}:{record['content_hash']}", json.dumps(verdict))
    ctx.redis.set(f"prompts:eval_latest:{T}:{N}", record["content_hash"])
    return verdict


def _api(ctx):
    return ctx.client(ctx.load("read").app)


async def _get(c, version, tenant=T):
    return await c.get(f"/v1/prompts/{N}/versions/{version}", headers={"X-Tenant-Id": tenant})


async def _render(c, version, values, tenant=T):
    return await c.post(f"/v1/prompts/{N}/versions/{version}/render", json={"values": values}, headers={"X-Tenant-Id": tenant})


async def check_read_route(ctx):
    record = _register(ctx, 3)
    async with _api(ctx) as c:
        r = await _get(c, 3)
        assert r.status_code == 200, f"reading version 3 answered {r.status_code}: {r.text}"
        body = r.json()
        for key in ("name", "version", "content_hash", "template", "variables"):
            assert body.get(key) == record[key], f"the read must carry {key}={record[key]!r}, got {body}"
        assert "eval_record" in body, f"the read carries an eval_record field (null when none), got {body}"
        r = await c.get(f"/v1/prompts/{N}/versions/3")
        assert r.status_code == 401, f"a read without X-Tenant-Id must answer 401, got {r.status_code}"
        r = await _render(c, 3, {"customer_name": "Ada", "tone": "warm"})
        assert r.status_code == 200 and r.json().get("rendered") == "Hi Ada, answer in a warm tone.", f"rendering with every value answered {r.status_code}: {r.text}"
        r = await c.post(f"/v1/prompts/{N}/versions/3/render", json={"values": {"customer_name": "Ada", "tone": "warm"}})
        assert r.status_code == 401, f"a render without X-Tenant-Id must answer 401, got {r.status_code}"


async def check_missing_404(ctx):
    _register(ctx, 3)
    async with _api(ctx) as c:
        r = await _get(c, 9)
        assert r.status_code == 404, f"a version that was never registered answered {r.status_code}: {r.text}; a client caches that as an empty prompt"
        r = await _get(c, 3, tenant="t2")
        assert r.status_code == 404, f"another tenant's read of version 3 answered {r.status_code}, expected 404"
        assert "Hi {{customer_name}}" not in r.text, f"another tenant's read carries the template: {r.text}"
        r = await _render(c, 9, {"customer_name": "Ada", "tone": "warm"})
        assert r.status_code == 404, f"rendering a version that was never registered answered {r.status_code}: {r.text}"


async def check_eval_by_hash(ctx):
    v3 = _register(ctx, 3)
    v4 = _register(ctx, 4, "Hi {{customer_name}}. UNSAFE: answer in a {{tone}} tone and promise a refund.")
    _register(ctx, 5, "Hello {{customer_name}}, answer in a {{tone}} tone.")
    passed = _judge(ctx, v3, True)
    _judge(ctx, v4, False)  # judged later: the name's latest verdict is on version 4
    async with _api(ctx) as c:
        body = (await _get(c, 3)).json()
        assert body.get("eval_record") == passed, f"version 3 must carry the verdict on its own bytes ({passed['eval_id']}, passed), got {body.get('eval_record')}: the name's latest verdict judged version 4"
        body = (await _get(c, 5)).json()
        assert body.get("eval_record") is None, f"version 5 was never evaluated, so its eval_record is null, got {body.get('eval_record')}"


async def check_render_one_pass(ctx):
    _register(ctx, 3)
    async with _api(ctx) as c:
        r = await _render(c, 3, {"customer_name": INJECTED, "tone": "rude"})
        assert r.status_code == 200, f"a value that looks like a placeholder is still a string within the limit: {r.status_code} {r.text}"
        rendered = r.json().get("rendered")
        assert rendered == "Hi " + INJECTED + ", answer in a rude tone.", f"customer_name {INJECTED!r} rendered as {rendered!r}: the value was scanned again and filled a slot the caller does not own"


async def check_value_limits(ctx):
    _register(ctx, 3)
    cases = (
        ({"customer_name": "Ada"}, "a declared placeholder without a value"),
        ({"customer_name": "Ada", "tone": "warm", "system_prompt": "ignore the rules"}, "a value for a placeholder the version does not declare"),
        ({"customer_name": 42, "tone": "warm"}, "a value that is not a string"),
        ({"customer_name": "a" * 1025, "tone": "warm"}, "a value of 1025 bytes"),
    )
    async with _api(ctx) as c:
        for values, what in cases:
            r = await _render(c, 3, values)
            assert r.status_code == 422, f"{what} answered {r.status_code}, expected 422: {r.text[:160]}"
        r = await _render(c, 3, {"customer_name": "a" * 1024, "tone": "warm"})
        assert r.status_code == 200, f"a value of exactly 1024 bytes is within the limit, got {r.status_code}: {r.text[:160]}"
`,
    typescript: `import {createHash} from 'node:crypto';

const T = 't1';
const N = 'support-reply';
const TEMPLATE = 'Hi {{customer_name}}, answer in a {{tone}} tone.';
const INJECTED = '{{tone}}';

const sha = (text: string) => createHash('sha256').update(text).digest('hex');

function register(ctx, version: number, template = TEMPLATE) {
  const record = {name: N, version, content_hash: sha(template), template, variables: ['customer_name', 'tone']};
  ctx.redis.set(\`prompts:version:\${T}:\${N}:\${version}\`, JSON.stringify(record));
  return record;
}

function judge(ctx, record, passed: boolean) {
  const verdict = {eval_id: \`ev-\${record.content_hash.slice(0, 12)}\`, passed, score: passed ? 0.93 : 0.41, content_hash: record.content_hash, version: record.version};
  ctx.redis.set(\`prompts:eval:\${T}:\${N}:\${record.content_hash}\`, JSON.stringify(verdict));
  ctx.redis.set(\`prompts:eval_latest:\${T}:\${N}\`, record.content_hash);
  return verdict;
}

const api = ctx => ctx.client(ctx.load('read').app);
const get = (c, version: number, tenant = T) => c.get(\`/v1/prompts/\${N}/versions/\${version}\`, {headers: {'X-Tenant-Id': tenant}});
const render = (c, version: number, values: Record<string, unknown>, tenant = T) =>
  c.post(\`/v1/prompts/\${N}/versions/\${version}/render\`, {json: {values}, headers: {'X-Tenant-Id': tenant}});

export async function check_read_route(ctx) {
  const record = register(ctx, 3);
  const c = api(ctx);
  let r = await get(c, 3);
  assert.equal(r.status, 200, \`reading version 3 answered \${r.status}: \${r.text}\`);
  const body = r.json();
  for (const key of ['name', 'version', 'content_hash', 'template', 'variables']) assert.deepEqual(body[key], record[key], \`the read must carry \${key}=\${JSON.stringify(record[key])}, got \${r.text}\`);
  assert('eval_record' in body, \`the read carries an eval_record field (null when none), got \${r.text}\`);
  r = await c.get(\`/v1/prompts/\${N}/versions/3\`);
  assert.equal(r.status, 401, \`a read without X-Tenant-Id must answer 401, got \${r.status}\`);
  r = await render(c, 3, {customer_name: 'Ada', tone: 'warm'});
  assert(r.status === 200 && r.json().rendered === 'Hi Ada, answer in a warm tone.', \`rendering with every value answered \${r.status}: \${r.text}\`);
  r = await c.post(\`/v1/prompts/\${N}/versions/3/render\`, {json: {values: {customer_name: 'Ada', tone: 'warm'}}});
  assert.equal(r.status, 401, \`a render without X-Tenant-Id must answer 401, got \${r.status}\`);
}

export async function check_missing_404(ctx) {
  register(ctx, 3);
  const c = api(ctx);
  let r = await get(c, 9);
  assert.equal(r.status, 404, \`a version that was never registered answered \${r.status}: \${r.text}; a client caches that as an empty prompt\`);
  r = await get(c, 3, 't2');
  assert.equal(r.status, 404, \`another tenant's read of version 3 answered \${r.status}, expected 404\`);
  assert(!r.text.includes('Hi {{customer_name}}'), \`another tenant's read carries the template: \${r.text}\`);
  r = await render(c, 9, {customer_name: 'Ada', tone: 'warm'});
  assert.equal(r.status, 404, \`rendering a version that was never registered answered \${r.status}: \${r.text}\`);
}

export async function check_eval_by_hash(ctx) {
  const v3 = register(ctx, 3);
  const v4 = register(ctx, 4, 'Hi {{customer_name}}. UNSAFE: answer in a {{tone}} tone and promise a refund.');
  register(ctx, 5, 'Hello {{customer_name}}, answer in a {{tone}} tone.');
  const passed = judge(ctx, v3, true);
  judge(ctx, v4, false); // judged later: the name's latest verdict is on version 4
  const c = api(ctx);
  let body = (await get(c, 3)).json();
  assert.deepEqual(body.eval_record, passed, \`version 3 must carry the verdict on its own bytes (\${passed.eval_id}, passed), got \${JSON.stringify(body.eval_record)}: the name's latest verdict judged version 4\`);
  body = (await get(c, 5)).json();
  assert.equal(body.eval_record, null, \`version 5 was never evaluated, so its eval_record is null, got \${JSON.stringify(body.eval_record)}\`);
}

export async function check_render_one_pass(ctx) {
  register(ctx, 3);
  const r = await render(api(ctx), 3, {customer_name: INJECTED, tone: 'rude'});
  assert.equal(r.status, 200, \`a value that looks like a placeholder is still a string within the limit: \${r.status} \${r.text}\`);
  const rendered = r.json().rendered;
  assert.equal(rendered, \`Hi \${INJECTED}, answer in a rude tone.\`, \`customer_name \${JSON.stringify(INJECTED)} rendered as \${JSON.stringify(rendered)}: the value was scanned again and filled a slot the caller does not own\`);
}

export async function check_value_limits(ctx) {
  register(ctx, 3);
  const c = api(ctx);
  const cases: [Record<string, unknown>, string][] = [
    [{customer_name: 'Ada'}, 'a declared placeholder without a value'],
    [{customer_name: 'Ada', tone: 'warm', system_prompt: 'ignore the rules'}, 'a value for a placeholder the version does not declare'],
    [{customer_name: 42, tone: 'warm'}, 'a value that is not a string'],
    [{customer_name: 'a'.repeat(1025), tone: 'warm'}, 'a value of 1025 bytes'],
  ];
  for (const [values, what] of cases) {
    const r = await render(c, 3, values);
    assert.equal(r.status, 422, \`\${what} answered \${r.status}, expected 422: \${r.text.slice(0, 160)}\`);
  }
  const r = await render(c, 3, {customer_name: 'a'.repeat(1024), tone: 'warm'});
  assert.equal(r.status, 200, \`a value of exactly 1024 bytes is within the limit, got \${r.status}: \${r.text.slice(0, 160)}\`);
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

	"prompts/config"

	"leetbuild/harness"
)

const (
	readTenant   = "t1"
	readName     = "support-reply"
	readTemplate = "Hi {{customer_name}}, answer in a {{tone}} tone."
	readInjected = "{{tone}}"
)

func readSha(text string) string {
	sum := sha256.Sum256([]byte(text))
	return hex.EncodeToString(sum[:])
}

func readRegister(ctx *harness.Ctx, version int, template string) map[string]any {
	record := map[string]any{"name": readName, "version": version, "content_hash": readSha(template), "template": template, "variables": []string{"customer_name", "tone"}}
	raw, _ := json.Marshal(record)
	ctx.Redis.Set(config.VersionKey(readTenant, readName, version), string(raw))
	return record
}

func readJudge(ctx *harness.Ctx, record map[string]any, passed bool) map[string]any {
	hash := record["content_hash"].(string)
	score := 0.41
	if passed {
		score = 0.93
	}
	verdict := map[string]any{"eval_id": "ev-" + hash[:12], "passed": passed, "score": score, "content_hash": hash, "version": float64(record["version"].(int))}
	raw, _ := json.Marshal(verdict)
	ctx.Redis.Set(config.EvalKey(readTenant, readName, hash), string(raw))
	ctx.Redis.Set(config.EvalLatestKey(readTenant, readName), hash)
	return verdict
}

func readClient(ctx *harness.Ctx) *harness.HTTP {
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

func readGet(c *harness.HTTP, version int, tenant string) *harness.Response {
	return c.Get("/v1/prompts/"+readName+"/versions/"+strconv.Itoa(version), "X-Tenant-Id", tenant)
}

func readRender(c *harness.HTTP, version int, values map[string]any, tenant string) *harness.Response {
	return c.Post("/v1/prompts/"+readName+"/versions/"+strconv.Itoa(version)+"/render", map[string]any{"values": values}, "X-Tenant-Id", tenant)
}

func readBody(ctx *harness.Ctx, r *harness.Response) map[string]any {
	body, ok := r.JSON().(map[string]any)
	ctx.Assert(ok, "the body must be a JSON object: %s", r.Text())
	return body
}

func CheckReadRoute(ctx *harness.Ctx) {
	readRegister(ctx, 3, readTemplate)
	c := readClient(ctx)
	r := readGet(c, 3, readTenant)
	ctx.Equal(r.Status, 200, "reading version 3 (%s)", r.Text())
	body := readBody(ctx, r)
	ctx.Equal(body["name"], readName, "the read's name")
	ctx.Equal(body["version"], float64(3), "the read's version")
	ctx.Equal(body["content_hash"], readSha(readTemplate), "the read's content_hash")
	ctx.Equal(body["template"], readTemplate, "the read's template")
	ctx.Equal(body["variables"], []any{"customer_name", "tone"}, "the read's variables")
	_, has := body["eval_record"]
	ctx.Assert(has, "the read carries an eval_record field (null when none), got %s", r.Text())
	ctx.Equal(c.Get("/v1/prompts/"+readName+"/versions/3").Status, 401, "a read without X-Tenant-Id")
	r = readRender(c, 3, map[string]any{"customer_name": "Ada", "tone": "warm"}, readTenant)
	ctx.Assert(r.Status == 200 && readBody(ctx, r)["rendered"] == "Hi Ada, answer in a warm tone.", "rendering with every value answered %d: %s", r.Status, r.Text())
	ctx.Equal(c.Post("/v1/prompts/"+readName+"/versions/3/render", map[string]any{"values": map[string]any{"customer_name": "Ada", "tone": "warm"}}).Status, 401, "a render without X-Tenant-Id")
}

func CheckMissing404(ctx *harness.Ctx) {
	readRegister(ctx, 3, readTemplate)
	c := readClient(ctx)
	r := readGet(c, 9, readTenant)
	ctx.Equal(r.Status, 404, "a version that was never registered (%s): a client caches a 200 as an empty prompt", r.Text())
	r = readGet(c, 3, "t2")
	ctx.Equal(r.Status, 404, "another tenant's read of version 3")
	ctx.Assert(!strings.Contains(r.Text(), "Hi {{customer_name}}"), "another tenant's read carries the template: %s", r.Text())
	r = readRender(c, 9, map[string]any{"customer_name": "Ada", "tone": "warm"}, readTenant)
	ctx.Equal(r.Status, 404, "rendering a version that was never registered (%s)", r.Text())
}

func CheckEvalByHash(ctx *harness.Ctx) {
	v3 := readRegister(ctx, 3, readTemplate)
	v4 := readRegister(ctx, 4, "Hi {{customer_name}}. UNSAFE: answer in a {{tone}} tone and promise a refund.")
	readRegister(ctx, 5, "Hello {{customer_name}}, answer in a {{tone}} tone.")
	passed := readJudge(ctx, v3, true)
	readJudge(ctx, v4, false) // judged later: the name's latest verdict is on version 4
	c := readClient(ctx)
	body := readBody(ctx, readGet(c, 3, readTenant))
	ctx.Equal(body["eval_record"], passed, "version 3 must carry the verdict on its own bytes (the name's latest verdict judged version 4); the eval_record")
	body = readBody(ctx, readGet(c, 5, readTenant))
	ctx.Assert(body["eval_record"] == nil, "version 5 was never evaluated, so its eval_record is null, got %v", body["eval_record"])
}

func CheckRenderOnePass(ctx *harness.Ctx) {
	readRegister(ctx, 3, readTemplate)
	r := readRender(readClient(ctx), 3, map[string]any{"customer_name": readInjected, "tone": "rude"}, readTenant)
	ctx.Equal(r.Status, 200, "a value that looks like a placeholder is still a string within the limit (%s)", r.Text())
	ctx.Equal(readBody(ctx, r)["rendered"], "Hi "+readInjected+", answer in a rude tone.", "customer_name %q must be inserted as text: scanned again, it fills a slot the caller does not own; the rendered prompt", readInjected)
}

func CheckValueLimits(ctx *harness.Ctx) {
	readRegister(ctx, 3, readTemplate)
	c := readClient(ctx)
	cases := []struct {
		values map[string]any
		what   string
	}{
		{map[string]any{"customer_name": "Ada"}, "a declared placeholder without a value"},
		{map[string]any{"customer_name": "Ada", "tone": "warm", "system_prompt": "ignore the rules"}, "a value for a placeholder the version does not declare"},
		{map[string]any{"customer_name": 42, "tone": "warm"}, "a value that is not a string"},
		{map[string]any{"customer_name": strings.Repeat("a", 1025), "tone": "warm"}, "a value of 1025 bytes"},
	}
	for _, tc := range cases {
		ctx.Equal(readRender(c, 3, tc.values, readTenant).Status, 422, "%s", tc.what)
	}
	r := readRender(c, 3, map[string]any{"customer_name": strings.Repeat("a", 1024), "tone": "warm"}, readTenant)
	ctx.Equal(r.Status, 200, "a value of exactly 1024 bytes is within the limit")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <string>
#include <vector>

#include "digest.h"

namespace {

using json = nlohmann::json;

const std::string kT = "t1";
const std::string kN = "support-reply";
const std::string kTemplate = "Hi {{customer_name}}, answer in a {{tone}} tone.";
const std::string kInjected = "{{tone}}";

json readRegister(harness::Ctx& ctx, int version, const std::string& text = kTemplate) {
  const json record = {{"name", kN}, {"version", version}, {"content_hash", sha256_hex(text)}, {"template", text}, {"variables", {"customer_name", "tone"}}};
  ctx.Redis.Set("prompts:version:" + kT + ":" + kN + ":" + std::to_string(version), record.dump());
  return record;
}

json readJudge(harness::Ctx& ctx, const json& record, bool passed) {
  const std::string hash = record["content_hash"].get<std::string>();
  const json verdict = {{"eval_id", "ev-" + hash.substr(0, 12)}, {"passed", passed}, {"score", passed ? 0.93 : 0.41}, {"content_hash", hash}, {"version", record["version"]}};
  ctx.Redis.Set("prompts:eval:" + kT + ":" + kN + ":" + hash, verdict.dump());
  ctx.Redis.Set("prompts:eval_latest:" + kT + ":" + kN, hash);
  return verdict;
}

struct Api {
  httplib::Server svr;
  harness::HTTP http;
  explicit Api(harness::Ctx& ctx) : http(ctx.HTTP(svr)) { register_routes(svr); }

  harness::Response get(int version, const std::string& tenant = kT) {
    return http.Get("/v1/prompts/" + kN + "/versions/" + std::to_string(version), "X-Tenant-Id", tenant);
  }
  harness::Response render(int version, const json& values, const std::string& tenant = kT) {
    return http.Post("/v1/prompts/" + kN + "/versions/" + std::to_string(version) + "/render", json({{"values", values}}).dump(), "X-Tenant-Id", tenant);
  }
};

json bodyOf(harness::Ctx& ctx, const harness::Response& r) {
  const json body = json::parse(r.Text(), nullptr, false);
  ctx.Assert(body.is_object(), "the body must be a JSON object: %s", r.Text());
  return body;
}

}  // namespace

void CheckReadRoute(harness::Ctx& ctx) {
  const json record = readRegister(ctx, 3);
  Api api(ctx);
  auto r = api.get(3);
  ctx.Equal(r.Status, 200, "reading version 3 (%s)", r.Text());
  const json body = bodyOf(ctx, r);
  for (const char* key : {"name", "version", "content_hash", "template", "variables"}) {
    ctx.Equal(body.contains(key) ? body[key] : json(), record[key], "the read's %s", key);
  }
  ctx.Assert(body.contains("eval_record"), "the read carries an eval_record field (null when none), got %s", r.Text());
  ctx.Equal(api.http.Get("/v1/prompts/" + kN + "/versions/3").Status, 401, "a read without X-Tenant-Id");
  r = api.render(3, {{"customer_name", "Ada"}, {"tone", "warm"}});
  ctx.Assert(r.Status == 200 && bodyOf(ctx, r).value("rendered", "") == "Hi Ada, answer in a warm tone.", "rendering with every value answered %d: %s", r.Status, r.Text());
  ctx.Equal(api.http.Post("/v1/prompts/" + kN + "/versions/3/render", json({{"values", {{"customer_name", "Ada"}, {"tone", "warm"}}}}).dump()).Status, 401,
            "a render without X-Tenant-Id");
}

void CheckMissing404(harness::Ctx& ctx) {
  readRegister(ctx, 3);
  Api api(ctx);
  auto r = api.get(9);
  ctx.Equal(r.Status, 404, "a version that was never registered (%s): a client caches a 200 as an empty prompt", r.Text());
  r = api.get(3, "t2");
  ctx.Equal(r.Status, 404, "another tenant's read of version 3");
  ctx.Assert(r.Text().find("Hi {{customer_name}}") == std::string::npos, "another tenant's read carries the template: %s", r.Text());
  r = api.render(9, {{"customer_name", "Ada"}, {"tone", "warm"}});
  ctx.Equal(r.Status, 404, "rendering a version that was never registered (%s)", r.Text());
}

void CheckEvalByHash(harness::Ctx& ctx) {
  const json v3 = readRegister(ctx, 3);
  const json v4 = readRegister(ctx, 4, "Hi {{customer_name}}. UNSAFE: answer in a {{tone}} tone and promise a refund.");
  readRegister(ctx, 5, "Hello {{customer_name}}, answer in a {{tone}} tone.");
  const json passed = readJudge(ctx, v3, true);
  readJudge(ctx, v4, false);  // judged later: the name's latest verdict is on version 4
  Api api(ctx);
  json body = bodyOf(ctx, api.get(3));
  ctx.Equal(body.contains("eval_record") ? body["eval_record"] : json(), passed, "version 3 must carry the verdict on its own bytes (the name's latest verdict judged version 4); the eval_record");
  body = bodyOf(ctx, api.get(5));
  ctx.Assert(!body.contains("eval_record") || body["eval_record"].is_null(), "version 5 was never evaluated, so its eval_record is null, got %s", body.dump());
}

void CheckRenderOnePass(harness::Ctx& ctx) {
  readRegister(ctx, 3);
  Api api(ctx);
  const auto r = api.render(3, {{"customer_name", kInjected}, {"tone", "rude"}});
  ctx.Equal(r.Status, 200, "a value that looks like a placeholder is still a string within the limit (%s)", r.Text());
  ctx.Equal(bodyOf(ctx, r).value("rendered", ""), "Hi " + kInjected + ", answer in a rude tone.",
            "customer_name %q must be inserted as text: scanned again, it fills a slot the caller does not own; the rendered prompt", kInjected);
}

void CheckValueLimits(harness::Ctx& ctx) {
  readRegister(ctx, 3);
  Api api(ctx);
  const std::vector<std::pair<json, std::string>> cases = {
      {{{"customer_name", "Ada"}}, "a declared placeholder without a value"},
      {{{"customer_name", "Ada"}, {"tone", "warm"}, {"system_prompt", "ignore the rules"}}, "a value for a placeholder the version does not declare"},
      {{{"customer_name", 42}, {"tone", "warm"}}, "a value that is not a string"},
      {{{"customer_name", std::string(1025, 'a')}, {"tone", "warm"}}, "a value of 1025 bytes"},
  };
  for (const auto& [values, what] : cases) ctx.Equal(api.render(3, values).Status, 422, "%s", what);
  ctx.Equal(api.render(3, {{"customer_name", std::string(1024, 'a')}, {"tone", "warm"}}).Status, 200, "a value of exactly 1024 bytes is within the limit");
}
`,
  },
  hints: [
    'Symptom: a customer whose name is `{{tone}}` turns the reply rude, the preview shows a red eval on a version that passed, a missing value renders as a blank, and a typo in the version number answers 200 with nothing in it.',
    'Mechanism: the render loop runs `replace` once per variable, so text inserted for `customer_name` is scanned for `{{tone}}`; the eval comes from `evals.latest`, which follows the name; values are read with a default; a version `versions.get` cannot find still answers 200.',
    'Change: 404 when `versions.get` finds nothing; `evals.get(tenant, name, record["content_hash"])`; 422 unless the value keys equal `variables` and each is a string within `MAX_VALUE_BYTES`; render with `PLACEHOLDER.sub(lambda m: values[m.group(1)], template)`.',
  ],
  debrief: `A template is code its author wrote and a value is data a caller supplied; one pass over the template keeps that line, because the regex engine walks the template once and inserted text is already behind the cursor. A second pass is how string-built SQL went wrong, and a prompt has no prepared statements, so the registry draws the line itself. Attaching the verdict by content hash makes the eval evidence about these bytes rather than about the name. The 404 matters to caches downstream: an empty 200 is a prompt as far as a client can tell. One pass cannot stop a value from carrying instructions the model then follows; that takes delimiters, input classifiers and output checks on the model side, which this step leaves out.`,
};
