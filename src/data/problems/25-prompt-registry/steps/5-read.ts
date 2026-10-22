import type {Step} from '@/lib/types';

export const readStep: Step = {
  id: 'read',
  title: 'GET /v1/prompts/{name}/versions/{v}: render-safe reads',
  concept: 'http',
  file: 'read',
  focus: ['client', 'registry', 'db'],
  task: `## Task

The starter is a plausible model-generated draft: the version comes back with its template and a
rendered string, so the preview screen works. It renders with a raw string replace and it hands the
reader whatever eval record it finds for the name. Find the flaws, fix them, and prove the fix.

Implement \`GET /v1/prompts/{name}/versions/{v}\`:

- The version is looked up for the **authenticated tenant**; a version that does not exist, or
  belongs to another tenant, answers **404**. The draft serves any version it is handed, which is
  how one tenant reads another tenant’s eval history.
- The response carries \`name\`, \`version\`, \`content_hash\`, \`template\`, \`variables\` and the
  \`eval_record\` **of that exact version hash** — \`store.get_eval(tenant, name, content_hash)\`.
  An eval belongs to the bytes it was run against, so the name’s *latest* eval is the wrong record.
- \`?render=1&values=<json object>\` renders the template. Every declared placeholder must have a
  value and every value must be a string of at most **\`MAX_VALUE_BYTES\` = 1024** bytes; anything
  else is **422**.
- Rendering must **escape the value**: a value may never introduce a placeholder or close the quoted
  region it is substituted into. Substitution happens in **one pass** (a replacement function), so
  text a caller supplied is never re-scanned as a placeholder — a value like
  \`"}}{{\\"x\\":1"\` must come out as inert text inside its slot.

**Failure mode the checks target.** Raw substitution is a template-injection bug: the caller’s value
is re-scanned, so a value carrying \`}}\` closes the slot and the next \`{{\` opens another, and a
quote lifts the rest of the text out of its quoted region. The leaked eval record is the quieter
one: it is a cross-tenant read that no validation rejects, because nothing ever compared the
requested version with the reader’s tenant.`,
  sequence: {
    participants: ['Client', 'Prompt Registry', 'version store'],
    messages: [
      {
        from: 'Client',
        to: 'Prompt Registry',
        label: 'GET /v1/prompts/support-reply/versions/3 · X-Tenant-Id',
        kind: 'sync',
      },
      {from: 'Prompt Registry', to: 'version store', label: 'get_version(tenant, name, version)', kind: 'sync'},
      {from: 'version store', to: 'Prompt Registry', label: 'record · none → 404', kind: 'reply'},
      {from: 'Prompt Registry', to: 'version store', label: 'get_eval(tenant, name, content_hash)', kind: 'sync'},
      {from: 'Prompt Registry', to: 'Prompt Registry', label: 'escape values · substitute in one pass', kind: 'sync'},
      {from: 'Prompt Registry', to: 'Client', label: '{template, variables, eval_record, rendered}', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'read-route',
      title: 'Handles GET /v1/prompts/{name}/versions/{v}',
      detail: 'Register the read route on `GET /v1/prompts/{name}/versions/{v}`.',
      match: {
        python: {all: [/@app\.get\(\s*["']\/v1\/prompts\/\{name\}\/versions\/\{v\}["']/]},
        typescript: {all: [/app\.get\(\s*['"]\/v1\/prompts\/:name\/versions\/:v['"]/]},
        go: {all: [/HandleFunc\(\s*"GET \/v1\/prompts\/\{name\}\/versions\/\{v\}"/]},
        scala: {
          all: [/path\(\s*"v1"\s*\/\s*"prompts"\s*\/\s*Segment\s*\/\s*"versions"\s*\/\s*IntNumber\s*\)/, /\bget\s*\{/],
        },
        cpp: {all: [/svr\.Get\(\s*"\/v1\/prompts\/:name\/versions\/:v"/]},
      },
    },
    {
      id: 'tenant-scope',
      title: 'Scopes the version to the authenticated tenant',
      detail:
        'The version is authorized against the request tenant before anything is read, and a foreign or missing version answers **404**. The draft serves any version in the path and leaks another tenant’s eval record.',
      match: {
        python: {all: [/assert_tenant_owns/, /\b404\b/]},
        typescript: {all: [/assertTenantOwns/, /\b404\b/]},
        go: {all: [/assertTenantOwns/, /StatusNotFound/]},
        scala: {all: [/assertTenantOwns/, /StatusCodes\.NotFound/]},
        cpp: {all: [/assert_tenant_owns/, /\b404\b/]},
      },
    },
    {
      id: 'render-delimiter',
      title: 'Escapes values so a delimiter cannot break the template',
      detail:
        'Values are escaped (`escape_value`/`escapeValue`) and substituted by a replacement function in one pass, so a value containing the delimiter is inert. The draft re-scans the caller’s text with a raw `replace`.',
      match: {
        python: {all: [/escape_value\(/, /PLACEHOLDER_RE/]},
        typescript: {all: [/escapeValue\(/, /PLACEHOLDER_RE/]},
        go: {all: [/escapeValue\(/, /placeholderRE/]},
        scala: {all: [/escapeValue\(/, /PlaceholderRe/]},
        cpp: {all: [/escape_value\(/, /render_template\(/]},
      },
    },
    {
      id: 'value-limits',
      title: 'Requires a value for every placeholder and caps each at 1 KiB',
      detail:
        'Render mode validates the supplied values: every declared placeholder needs one, nothing undeclared is accepted, and each value is capped at `MAX_VALUE_BYTES`. Violations answer **422**. The draft validates nothing.',
      match: {
        python: {all: [/MAX_VALUE_BYTES/, /status_code\s*=\s*422/]},
        typescript: {all: [/MAX_VALUE_BYTES/, /fail\(\s*422\s*,/]},
        go: {all: [/maxValueBytes/, /StatusUnprocessableEntity/]},
        scala: {all: [/MaxValueBytes/, /StatusCodes\.UnprocessableEntity/]},
        cpp: {all: [/kMaxValueBytes/, /\b422\b/]},
      },
    },
    {
      id: 'eval-by-hash',
      title: 'Attaches the eval of the exact version hash',
      detail:
        'The eval record is read for the requested version’s `content_hash`, not for the name: `store.get_eval(tenant, name, content_hash)`. The draft serves the name’s latest eval, which belongs to different bytes.',
      match: {
        python: {all: [/get_eval\(tenant,\s*name,\s*content_hash\)/]},
        typescript: {all: [/getEval\(tenant,\s*name,\s*contentHash\)/]},
        go: {all: [/GetEval\(r\.Context\(\),\s*tenant,\s*name,\s*contentHash\)/]},
        scala: {all: [/getEval\(tenant,\s*name,\s*contentHash\)/]},
        cpp: {all: [/get_eval\(tenant,\s*name,\s*content_hash\)/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json

from fastapi import FastAPI, Header, Query
from pydantic import BaseModel

app = FastAPI()


class VersionStore:
    def get_version(self, tenant: str, name: str, version: int) -> dict | None:
        """The stored version, if the registry has one."""
        raise NotImplementedError

    def latest_eval(self, tenant: str, name: str) -> dict | None:
        """The most recent eval record for the name."""
        raise NotImplementedError


store = VersionStore()


def render(template: str, values: dict) -> str:
    # TODO: this draft substitutes with a raw string replace, so a caller value carrying the
    # delimiter or a quote can rewrite the template, it validates nothing about the values, and it
    # serves the name's latest eval record instead of the one for the version asked for.
    rendered = template
    for key, value in values.items():
        rendered = rendered.replace("{{" + key + "}}", value)
    return rendered


@app.get("/v1/prompts/{name}/versions/{v}")
def read_version(
    name: str,
    v: int,
    render_mode: int = Query(default=0, alias="render"),
    values: str | None = None,
    tenant: str = Header(alias="X-Tenant-Id"),
) -> dict:
    record = store.get_version(tenant, name, v) or {}
    body = dict(record)
    body["eval_record"] = store.latest_eval(tenant, name)
    if render_mode:
        body["rendered"] = render(record["template"], json.loads(values or "{}"))
    return body
`,
      solution: `import json
import re

from fastapi import FastAPI, Header, HTTPException, Query
from pydantic import BaseModel

app = FastAPI()

MAX_VALUE_BYTES = 1024
PLACEHOLDER_OPEN = "{{"
PLACEHOLDER_CLOSE = "}}"
QUOTE = '"'
ESCAPED_QUOTE = '\\\\"'
PLACEHOLDER_RE = re.compile(r"\\{\\{([a-z_][a-z0-9_]*)\\}\\}")


class VersionStore:
    def get_version(self, tenant: str, name: str, version: int) -> dict | None:
        """The stored version, if the registry has one."""
        raise NotImplementedError

    def get_eval(self, tenant: str, name: str, content_hash: str) -> dict | None:
        """The eval record for this exact version hash."""
        raise NotImplementedError


store = VersionStore()


def assert_tenant_owns(tenant: str, name: str, version: int) -> dict:
    record = store.get_version(tenant, name, version)
    if record is None:
        raise HTTPException(status_code=404, detail="version not found")
    return record


def escape_value(value: str) -> str:
    """A caller value may never introduce a placeholder or close the quoted region it sits in."""
    if PLACEHOLDER_OPEN in value or PLACEHOLDER_CLOSE in value:
        raise HTTPException(status_code=422, detail="value contains the placeholder delimiter")
    return value.replace(QUOTE, ESCAPED_QUOTE)


def render(template: str, values: dict[str, str]) -> str:
    declared = set(PLACEHOLDER_RE.findall(template))
    missing = declared - set(values)
    if missing:
        raise HTTPException(status_code=422, detail=f"missing values: {sorted(missing)}")
    extra = set(values) - declared
    if extra:
        raise HTTPException(status_code=422, detail=f"undeclared values: {sorted(extra)}")
    for value in values.values():
        if len(value.encode("utf-8")) > MAX_VALUE_BYTES:
            raise HTTPException(status_code=422, detail="value exceeds 1 KiB")
    # One pass: a value is inserted as text and is never scanned for placeholders again.
    return PLACEHOLDER_RE.sub(lambda match: escape_value(values[match.group(1)]), template)


@app.get("/v1/prompts/{name}/versions/{v}")
def read_version(
    name: str,
    v: int,
    render_mode: int = Query(default=0, alias="render"),
    values: str | None = None,
    tenant: str | None = Header(default=None, alias="X-Tenant-Id"),
) -> dict:
    if tenant is None or tenant == "":
        raise HTTPException(status_code=401, detail="missing X-Tenant-Id")
    record = assert_tenant_owns(tenant, name, v)
    content_hash = record["content_hash"]
    body = {
        "name": name,
        "version": v,
        "content_hash": content_hash,
        "template": record["template"],
        "variables": record["variables"],
        "eval_record": store.get_eval(tenant, name, content_hash),
    }
    if not render_mode:
        return body
    body["rendered"] = render(record["template"], json.loads(values or "{}"))
    return body
`,
    },
    typescript: {
      starter: `/** GET /v1/prompts/:name/versions/:v: a model-generated draft with a raw substitution. */
import Fastify from 'fastify';

import {store} from './store';

export const app = Fastify();

function render(bodyTemplate: string, values: Record<string, string>): string {
  // TODO: this draft substitutes with a raw string replace, so a caller value carrying the
  // delimiter or a quote can rewrite the template, it validates nothing about the values, and it
  // serves the name's latest eval record instead of the one for the version asked for.
  let rendered = bodyTemplate;
  for (const [key, value] of Object.entries(values)) rendered = rendered.replace(\`{{\${key}}}\`, value);
  return rendered;
}

app.get('/v1/prompts/:name/versions/:v', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'] as string;
  const {name, v} = request.params as {name: string; v: string};
  const query = request.query as {render?: string; values?: string};
  const record = await store.getVersion(tenant, name, Number(v));
  const body = {...record, eval_record: await store.latestEval(tenant, name)};
  if (query.render === '1') body.rendered = render(record.template, JSON.parse(query.values ?? '{}'));
  return reply.code(200).send(body);
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** GET /v1/prompts/:name/versions/:v: tenant-scoped, render-safe reads. */
import Fastify from 'fastify';

import {store} from './store';

export const app = Fastify();

const MAX_VALUE_BYTES = 1024;
const PLACEHOLDER_OPEN = '{{';
const PLACEHOLDER_CLOSE = '}}';
const QUOTE = '"';
const ESCAPED_QUOTE = '\\\\"';
const PLACEHOLDER_RE = /\\{\\{([a-z_][a-z0-9_]*)\\}\\}/g;

interface VersionRecord {
  name: string;
  version: number;
  content_hash: string;
  template: string;
  variables: string[];
}

function fail(statusCode: number, detail: string): Error {
  const error = new Error(detail) as Error & {statusCode: number};
  error.statusCode = statusCode;
  return error;
}

async function assertTenantOwns(tenant: string, name: string, version: number): Promise<VersionRecord> {
  const record = await store.getVersion(tenant, name, version);
  if (record === null) throw fail(404, 'version not found');
  return record;
}

function escapeValue(value: string): string {
  if (value.includes(PLACEHOLDER_OPEN) || value.includes(PLACEHOLDER_CLOSE))
    throw fail(422, 'value contains the placeholder delimiter');
  return value.replaceAll(QUOTE, ESCAPED_QUOTE);
}

function render(bodyTemplate: string, values: Record<string, string>): string {
  const declared = [...new Set([...bodyTemplate.matchAll(PLACEHOLDER_RE)].map(m => m[1]))];
  const missing = declared.filter(name => values[name] === undefined);
  if (missing.length > 0) throw fail(422, \`missing values: \${missing.join(',')}\`);
  for (const [name, value] of Object.entries(values)) {
    if (!declared.includes(name)) throw fail(422, \`undeclared value: \${name}\`);
    if (Buffer.byteLength(value, 'utf8') > MAX_VALUE_BYTES) throw fail(422, 'value exceeds 1 KiB');
    values[name] = value;
  }
  // One pass: a value is inserted as text and is never scanned for placeholders again.
  return bodyTemplate.replace(PLACEHOLDER_RE, (_match, name: string) => escapeValue(values[name]));
}

app.setErrorHandler((error, request, reply) => {
  const statusCode = (error as Error & {statusCode?: number}).statusCode ?? 500;
  return reply.code(statusCode).send({error: error.message});
});

app.get('/v1/prompts/:name/versions/:v', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing X-Tenant-Id'});
  const {name, v} = request.params as {name: string; v: string};
  const record = await assertTenantOwns(tenant, name, Number(v));
  const contentHash = record.content_hash;
  const body = {
    name,
    version: Number(v),
    content_hash: contentHash,
    template: record.template,
    variables: record.variables,
    eval_record: await store.getEval(tenant, name, contentHash),
  };
  const query = request.query as {render?: string; values?: string};
  if (query.render !== '1') return reply.code(200).send(body);
  const values = JSON.parse(query.values ?? '{}') as Record<string, string>;
  return reply.code(200).send({...body, rendered: render(record.template, values)});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
)

var store *VersionStore

func render(bodyTemplate string, values map[string]string) string {
	// TODO: this draft substitutes with a raw string replace, so a caller value carrying the
	// delimiter or a quote can rewrite the template, it validates nothing about the values, and it
	// serves the name's latest eval record instead of the one for the version asked for.
	rendered := bodyTemplate
	for key, value := range values {
		rendered = strings.ReplaceAll(rendered, "{{"+key+"}}", value)
	}
	return rendered
}

func readVersion(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	name := r.PathValue("name")
	version, _ := strconv.Atoi(r.PathValue("v"))
	record, _ := store.GetVersion(r.Context(), tenant, name, version)
	evalRecord, _ := store.LatestEval(r.Context(), tenant, name)
	body := map[string]any{
		"name":         name,
		"version":      version,
		"content_hash": record.ContentHash,
		"variables":    record.Variables,
		"eval_record":  evalRecord,
	}
	if r.URL.Query().Get("render") == "1" {
		values := map[string]string{}
		_ = json.Unmarshal([]byte(r.URL.Query().Get("values")), &values)
		body["rendered"] = render(record.Template, values)
	}
	rw.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(rw).Encode(body)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/prompts/{name}/versions/{v}", readVersion)
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"regexp"
	"strconv"
	"strings"
)

const maxValueBytes = 1024

var placeholderRE = regexp.MustCompile(\`\\{\\{([a-z_][a-z0-9_]*)\\}\\}\`)

var errNotFound = errors.New("version not found")

func assertTenantOwns(ctx context.Context, tenant, name string, version int) (*VersionRecord, error) {
	record, err := store.GetVersion(ctx, tenant, name, version)
	if err != nil || record == nil {
		return nil, errNotFound
	}
	return record, nil
}

func escapeValue(value string) string {
	if strings.Contains(value, "{{") || strings.Contains(value, "}}") {
		return value
	}
	return strings.ReplaceAll(value, "\\"", "\\\\\\"")
}

// One pass: a value is inserted as text and is never scanned for placeholders again.
func render(bodyTemplate string, values map[string]string) (string, error) {
	declared := map[string]bool{}
	for _, match := range placeholderRE.FindAllStringSubmatch(bodyTemplate, -1) {
		declared[match[1]] = true
	}
	for name := range declared {
		if _, ok := values[name]; !ok {
			return "", errors.New("missing value for " + name)
		}
	}
	for name, value := range values {
		if !declared[name] {
			return "", errors.New("undeclared value " + name)
		}
		if len([]byte(value)) > maxValueBytes {
			return "", errors.New("value exceeds 1 KiB")
		}
	}
	return placeholderRE.ReplaceAllStringFunc(bodyTemplate, func(match string) string {
		return escapeValue(values[placeholderRE.FindStringSubmatch(match)[1]])
	}), nil
}

func readVersion(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-Tenant-Id"})
		return
	}
	name := r.PathValue("name")
	version, _ := strconv.Atoi(r.PathValue("v"))
	record, err := assertTenantOwns(r.Context(), tenant, name, version)
	if err != nil {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "version not found"})
		return
	}
	contentHash := record.ContentHash
	evalRecord, _ := store.GetEval(r.Context(), tenant, name, contentHash)
	body := map[string]any{
		"name":         name,
		"version":      version,
		"content_hash": contentHash,
		"template":     record.Template,
		"variables":    record.Variables,
		"eval_record":  evalRecord,
	}
	if r.URL.Query().Get("render") == "1" {
		values := map[string]string{}
		_ = json.Unmarshal([]byte(r.URL.Query().Get("values")), &values)
		rendered, err := render(record.Template, values)
		if err != nil {
			writeJSON(rw, http.StatusUnprocessableEntity, map[string]string{"error": err.Error()})
			return
		}
		body["rendered"] = rendered
	}
	writeJSON(rw, http.StatusOK, body)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/prompts/{name}/versions/{v}", readVersion)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route

object ReadApi {
  implicit val system: ActorSystem = ActorSystem("prompt-registry")

  def render(bodyTemplate: String, values: Map[String, String]): String = {
    // TODO: this draft substitutes with a raw string replace, so a caller value carrying the
    // delimiter or a quote can rewrite the template, it validates nothing about the values, and it
    // serves the name's latest eval record instead of the one for the version asked for.
    values.foldLeft(bodyTemplate) { case (rendered, (key, value)) =>
      rendered.replace(s"{{$key}}", value)
    }
  }

  val route: Route =
    path("v1" / "prompts" / Segment / "versions" / IntNumber) { (name, version) =>
      get {
        headerValueByName("X-Tenant-Id") { tenant =>
          parameter("render".?) { renderOpt =>
            parameter("values".?) { valuesOpt =>
              complete {
                val record = store.getVersion(tenant, name, version)
                val evalRecord = store.latestEval(tenant, name)
                val base =
                  s"""{"name":"$name","version":$version,"content_hash":"\${record.content_hash}","eval_record":"$evalRecord"}"""
                if (!renderOpt.contains("1")) HttpResponse(StatusCodes.OK, entity = base)
                else HttpResponse(StatusCodes.OK, entity = base)
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
      solution: `import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

object ReadApi {
  implicit val system: ActorSystem = ActorSystem("prompt-registry")

  val MaxValueBytes = 1024
  val PlaceholderRe = """\\{\\{([a-z_][a-z0-9_]*)\\}\\}""".r

  def assertTenantOwns(tenant: String, name: String, version: Int): VersionRecord = {
    store.getVersion(tenant, name, version) match {
      case Some(record) => record
      case None => throw new NoSuchElementException("version not found")
    }
  }

  def escapeValue(value: String): String = {
    if (value.contains("{{") || value.contains("}}")) {
      throw new IllegalArgumentException("value contains the placeholder delimiter")
    }
    value.replace("\\"", "\\\\\\"")
  }

  // One pass: a value is inserted as text and is never scanned for placeholders again.
  def render(bodyTemplate: String, values: Map[String, String]): String = {
    val declared = PlaceholderRe.findAllMatchIn(bodyTemplate).map(_.group(1)).toSet
    val missing = declared.diff(values.keySet)
    if (missing.nonEmpty) throw new IllegalArgumentException(s"missing values: \${missing.mkString(",")}")
    val extra = values.keySet.diff(declared)
    if (extra.nonEmpty) throw new IllegalArgumentException(s"undeclared values: \${extra.mkString(",")}")
    values.values.foreach { value =>
      if (value.getBytes("UTF-8").length > MaxValueBytes) {
        throw new IllegalArgumentException("value exceeds 1 KiB")
      }
    }
    PlaceholderRe.replaceAllIn(bodyTemplate, matched => escapeValue(values(matched.group(1))))
  }

  def payload(record: VersionRecord, name: String, version: Int, evalRecord: Option[EvalRecord], rendered: Option[String]): String = {
    val variables = record.variables.map(v => s""""$v"""").mkString(",")
    val evalJson = evalRecord.map(e => s"""{"eval_id":"\${e.eval_id}","passed":\${e.passed}}""").getOrElse("null")
    val renderedJson = rendered.map(r => s""""\${r.replace("\\"", "\\\\\\"")}"""").getOrElse("null")
    s"""{"name":"$name","version":$version,"content_hash":"\${record.content_hash}","variables":[$variables],"eval_record":$evalJson,"rendered":$renderedJson}"""
  }

  val route: Route =
    path("v1" / "prompts" / Segment / "versions" / IntNumber) { (name, version) =>
      get {
        headerValueByName("X-Tenant-Id") { tenant =>
          parameter("render".?) { renderOpt =>
            parameter("values".?) { valuesOpt =>
              complete {
                try {
                  val record = assertTenantOwns(tenant, name, version)
                  val contentHash = record.content_hash
                  val evalRecord = store.getEval(tenant, name, contentHash)
                  val rendered =
                    if (!renderOpt.contains("1")) None
                    else {
                      val values = valuesOpt
                        .map(raw => parseJsonObject(raw))
                        .getOrElse(Map.empty[String, String])
                      Some(render(record.template, values))
                    }
                  HttpResponse(StatusCodes.OK, entity = payload(record, name, version, evalRecord, rendered))
                } catch {
                  case _: NoSuchElementException =>
                    HttpResponse(StatusCodes.NotFound, entity = """{"error":"version not found"}""")
                  case _: IllegalArgumentException =>
                    HttpResponse(StatusCodes.UnprocessableEntity, entity = """{"error":"invalid render request"}""")
                }
              }
            }
          }
        }
      }
    }

  def parseJsonObject(raw: String): Map[String, String] =
    raw.parseJson.asJsObject.fields.map { case (key, value) => key -> value.convertTo[String] }

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

std::string render(const std::string& bodyTemplate, const json& values) {
  // TODO: this draft substitutes with a raw string replace, so a caller value carrying the
  // delimiter or a quote can rewrite the template, it validates nothing about the values, and it
  // serves the name's latest eval record instead of the one for the version asked for.
  std::string rendered = bodyTemplate;
  for (const auto& [key, value] : values.items()) {
    const std::string slot = "{{" + key + "}}";
    const std::string text = value.get<std::string>();
    for (auto at = rendered.find(slot); at != std::string::npos; at = rendered.find(slot, at + text.size())) {
      rendered.replace(at, slot.size(), text);
    }
  }
  return rendered;
}

int main() {
  httplib::Server svr;

  svr.Get("/v1/prompts/:name/versions/:v", [](const httplib::Request& req, httplib::Response& res) {
    const auto tenant = req.get_header_value("X-Tenant-Id");
    const auto name = req.path_params.at("name");
    const int version = std::stoi(req.path_params.at("v"));
    const auto record = store.get_version(tenant, name, version);
    json body = {{"name", name}, {"version", version}, {"eval_record", store.latest_eval(tenant, name)}};
    if (req.has_param("render")) {
      body["rendered"] = render(record.template, json::parse(req.get_param_value("values")));
    }
    res.status = 200;
    res.set_content(body.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <cstddef>
#include <map>
#include <stdexcept>
#include <string>
#include <vector>

using json = nlohmann::json;

constexpr std::size_t kMaxValueBytes = 1024;

struct VersionRecord {
  std::string name;
  int version = 0;
  std::string content_hash;
  std::string template_text;
  std::vector<std::string> variables;
};

VersionRecord assert_tenant_owns(const std::string& tenant, const std::string& name, int version);

// A caller value may never introduce a placeholder or close the quoted region it sits in.
std::string escape_value(const std::string& value) {
  if (value.find("{{") != std::string::npos || value.find("}}") != std::string::npos) {
    throw std::invalid_argument("value contains the placeholder delimiter");
  }
  std::string out;
  for (const char c : value) {
    if (c == '"') out += "\\\\\\"";
    else out += c;
  }
  return out;
}

// One pass over the template: a substituted value is never re-scanned for placeholders.
std::string render_template(const std::string& tpl, const std::map<std::string, std::string>& values) {
  std::string out;
  std::string rest = tpl;
  while (true) {
    const auto open = rest.find("{{");
    if (open == std::string::npos) {
      out += rest;
      break;
    }
    const auto close = rest.find("}}", open + 2);
    if (close == std::string::npos) {
      out += rest;
      break;
    }
    const auto name = rest.substr(open + 2, close - open - 2);
    out += rest.substr(0, open);
    const auto value = values.find(name);
    if (value == values.end()) {
      throw std::invalid_argument("missing value for " + name);
    }
    if (value->second.size() > kMaxValueBytes) {
      throw std::invalid_argument("value exceeds 1 KiB");
    }
    out += escape_value(value->second);
    rest = rest.substr(close + 2);
  }
  return out;
}

int main() {
  httplib::Server svr;

  svr.Get("/v1/prompts/:name/versions/:v", [](const httplib::Request& req, httplib::Response& res) {
    const auto tenant = req.get_header_value("X-Tenant-Id");
    if (tenant.empty()) {
      res.status = 401;
      res.set_content(R"({"error":"missing X-Tenant-Id"})", "application/json");
      return;
    }
    const auto name = req.path_params.at("name");
    const int version = std::stoi(req.path_params.at("v"));
    VersionRecord record;
    try {
      record = assert_tenant_owns(tenant, name, version);
    } catch (const std::out_of_range&) {
      res.status = 404;
      res.set_content(R"({"error":"version not found"})", "application/json");
      return;
    }
    const auto content_hash = record.content_hash;
    const auto eval_record = store.get_eval(tenant, name, content_hash);
    json body = {
        {"name", name},
        {"version", version},
        {"content_hash", content_hash},
        {"template", record.template_text},
        {"variables", record.variables},
        {"eval_record", eval_record ? eval_record->dump() : std::string("null")},
    };
    if (req.has_param("render") && req.get_param_value("render") == "1") {
      std::map<std::string, std::string> values;
      for (const auto& [key, value] : json::parse(req.get_param_value("values")).items()) {
        values[key] = value.get<std::string>();
      }
      try {
        body["rendered"] = render_template(record.template_text, values);
      } catch (const std::invalid_argument&) {
        res.status = 422;
        res.set_content(R"({"error":"invalid render request"})", "application/json");
        return;
      }
    }
    res.status = 200;
    res.set_content(body.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  hints: [
    'Authorize the read like the write: fetch the version under the authenticated tenant first and answer `404` for anything else, so a foreign version is indistinguishable from a missing one.',
    'A render request is untrusted input: require a value for every declared placeholder, reject values for undeclared ones, and cap each value. Then substitute with a function — `re.sub(lambda …)`, `String.replace(re, fn)`, `ReplaceAllStringFunc`, `replaceAllIn(m => …)` — so nothing the caller supplied is ever scanned again.',
    'The eval record belongs to the bytes, so key it by the version’s `content_hash`, not by the name. A name can have many versions and only one latest eval; showing the latest against the version a reader asked for is a lie the audit will eventually catch.',
  ],
  debrief: `Two questions sit behind this step. The first is whether a read is really a read: it is not, when the reader is untrusted and the response is built by substitution. One pass with an escaping function turns the caller’s value into inert text; a loop over \`replace\` re-scans whatever was just inserted, which is the whole template-injection class in one line. The second is whether the record you serve is the record you were asked for: evals, scores and hashes belong to a version, and serving the latest eval for a name is the kind of wrong that looks right in a demo and then contradicts an audit. Real registries add a signed read token per tenant, a rendered-output cache keyed by hash and values, and an access log that records the version hash rather than the content.`,
};
