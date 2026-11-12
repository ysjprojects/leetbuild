import type {Step} from '@/lib/types';

export const endpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/features/definitions: one immutable definition per version',
  concept: 'http',
  guides: ['request-boundaries', 'idempotent-requests'],
  file: 'api',
  focus: ['client', 'api', 'db'],
  task: `## Task

**Starting point.** The starter serves \`POST /v1/features/definitions\` on the registry
(\`features.registry\`, provided) with body
\`{"name": "amount_7d", "version": 2, "dtype": "float64", "computation_ref": "window_avg_7d", "freshness_slo": 300}\`:
it checks \`dtype\` against \`DTYPES\`, stamps \`created_at\`, stores the body with
\`registry.put_definition\` and answers 201 with the stored definition. It serves the demo and hides
three flaws.

**Failure mode the checks target.** A second registration of \`amount_7d\` version 2 rewrites the
definition a model was trained on; a definition whose computation does not exist is accepted and
fails an hour later in the training job; a definition without a freshness SLO is stored without
one, so no reader can tell a stale value from a fresh one.

- A definition is immutable per **(name, version)**: store it with \`registry.create_definition\`
  (one \`SET NX\`) and answer **409** when the pair exists, also when another registration lands
  between a check and the write.
- \`computation_ref\` must resolve (\`registry.computation_exists\`): one that names nothing is **422**
  and nothing is stored.
- \`freshness_slo\` (seconds) is required and positive: missing, \`null\` or ≤ 0 is **400**.`,
  sequence: {
    participants: ['Client', 'Feature API', 'Registry'],
    messages: [
      {from: 'Client', to: 'Feature API', label: 'POST /v1/features/definitions · amount_7d v2', kind: 'sync'},
      {from: 'Feature API', to: 'Feature API', label: 'dtype in DTYPES · freshness_slo > 0 → else 400', kind: 'sync'},
      {from: 'Feature API', to: 'Registry', label: 'computation_exists(window_avg_7d) → else 422', kind: 'sync'},
      {from: 'Feature API', to: 'Registry', label: 'create_definition · SET NX definition:amount_7d:2', kind: 'sync'},
      {from: 'Registry', to: 'Feature API', label: 'stored · or exists → 409', kind: 'reply'},
      {from: 'Feature API', to: 'Client', label: '201 the definition as stored', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Registers a definition and answers it as stored',
      detail:
        '`POST /v1/features/definitions` answers **201** with the stored definition, `created_at` included, and a `dtype` outside `DTYPES` is **400**.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/features\/definitions["']/, /DTYPES/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/features\/definitions['"]/, /DTYPES/]},
        go: {all: [/HandleFunc\(\s*"POST \/v1\/features\/definitions"/, /dtypes\[/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"features"\s*\/\s*"definitions"\s*\)/, /Dtypes\.contains/]},
        cpp: {all: [/svr\.Post\(\s*"\/v1\/features\/definitions"/, /kDtypes/]},
      },
    },
    {
      id: 'immutable-version',
      title: 'A registered (name, version) is never written over',
      detail:
        'The definition is stored with `create_definition`/`createDefinition` (one `SET NX`) and an existing pair answers **409**, the stored definition untouched, also when a rival registration lands between a check and the write. The starter writes with `put_definition`, a plain `SET`.',
      match: {
        python: {all: [/registry\.create_definition\(/, /\b409\b/], none: [/put_definition\(/]},
        typescript: {all: [/createDefinition\(/, /\b409\b/], none: [/putDefinition\(/]},
        go: {all: [/registry\.CreateDefinition\(/, /StatusConflict|\b409\b/], none: [/PutDefinition\(/]},
        scala: {all: [/Registry\.createDefinition\(/, /Conflict|\b409\b/], none: [/putDefinition\(/]},
        cpp: {all: [/registry::createDefinition\(/, /\b409\b/], none: [/putDefinition\(/]},
      },
    },
    {
      id: 'computation-ref',
      title: 'A computation_ref that resolves to nothing is 422',
      detail:
        '`computation_ref` is looked up in the compute registry (`computation_exists`/`computationExists`) before the write; one it does not know answers **422** and nothing is stored. The starter stores any string.',
      match: {
        python: {
          all: [/registry\.computation_exists\(/, /\b422\b/],
          order: [/registry\.computation_exists\(/, /registry\.create_definition\(/],
        },
        typescript: {all: [/computationExists\(/, /\b422\b/], order: [/computationExists\(/, /createDefinition\(/]},
        go: {
          all: [/registry\.ComputationExists\(/, /StatusUnprocessableEntity|\b422\b/],
          order: [/registry\.ComputationExists\(/, /registry\.CreateDefinition\(/],
        },
        scala: {
          all: [/Registry\.computationExists\(/, /UnprocessableEntity|\b422\b/],
          order: [/Registry\.computationExists\(/, /Registry\.createDefinition\(/],
        },
        cpp: {
          all: [/registry::computationExists\(/, /\b422\b/],
          order: [/registry::computationExists\(/, /registry::createDefinition\(/],
        },
      },
    },
    {
      id: 'freshness-slo',
      title: 'freshness_slo is required and positive',
      detail:
        'A body whose `freshness_slo` is missing, `null`, zero or negative answers **400** and nothing is stored. The starter treats the field as optional and stores the definition without one.',
      match: {
        python: {
          all: [
            /freshness_slo\s+is\s+None|freshness_slo\s*==\s*None|not\s+[\w.]*freshness_slo/,
            /freshness_slo\s*<=\s*0|freshness_slo\s*<\s*1/,
          ],
        },
        typescript: {
          all: [
            /typeof\s+\w+\s*!==\s*['"]number['"]|freshness_slo\s*===?\s*(?:null|undefined)/,
            /(?:slo|freshness_slo)\s*<=\s*0|(?:slo|freshness_slo)\s*<\s*1/,
          ],
        },
        go: {all: [/FreshnessSLO\s*==\s*nil/, /FreshnessSLO\s*<=\s*0|FreshnessSLO\s*<\s*1/]},
        scala: {all: [/"freshness_slo"\)\.filter\(\s*_\s*>\s*0\s*\)|freshnessSlo\s*<=\s*0/]},
        cpp: {all: [/slo\.is_number(?:_integer)?\(\)/, /slo\.get<long long>\(\)\s*<=\s*0/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import time

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

from features import registry  # get_definition, create_definition, put_definition, computation_exists

app = FastAPI()

DTYPES = ("int64", "float64", "string", "bool")


class DefinitionBody(BaseModel):
    name: str
    version: int
    dtype: str
    computation_ref: str
    freshness_slo: int | None = None


@app.post("/v1/features/definitions", status_code=201)
def register_definition(body: DefinitionBody) -> dict:
    # TODO: this starter has three flaws. The task says where to look; the checks say what must change.
    if body.dtype not in DTYPES:
        raise HTTPException(status_code=400, detail=f"dtype must be one of {', '.join(DTYPES)}")
    definition = {**body.model_dump(), "created_at": int(time.time())}
    registry.put_definition(definition)
    return definition
`,
      solution: `import time

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

from features import registry  # get_definition, create_definition, put_definition, computation_exists

app = FastAPI()

DTYPES = ("int64", "float64", "string", "bool")


class DefinitionBody(BaseModel):
    name: str
    version: int
    dtype: str
    computation_ref: str
    freshness_slo: int | None = None


@app.post("/v1/features/definitions", status_code=201)
def register_definition(body: DefinitionBody) -> dict:
    if body.dtype not in DTYPES:
        raise HTTPException(status_code=400, detail=f"dtype must be one of {', '.join(DTYPES)}")
    if body.freshness_slo is None or body.freshness_slo <= 0:
        raise HTTPException(status_code=400, detail="freshness_slo (seconds) is required and must be positive")
    if not registry.computation_exists(body.computation_ref):
        raise HTTPException(status_code=422, detail=f"computation_ref {body.computation_ref!r} names no computation")
    definition = {**body.model_dump(), "created_at": int(time.time())}
    # One SET NX: the existence check and the write cannot be split by another registration.
    if not registry.create_definition(definition):
        raise HTTPException(status_code=409, detail=f"{body.name} v{body.version} is already registered")
    return definition
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';

import {type Definition, putDefinition} from 'features/registry'; // also getDefinition, createDefinition, computationExists

export const app = Fastify();

export const DTYPES = ['int64', 'float64', 'string', 'bool'];

interface DefinitionBody {
  name: string;
  version: number;
  dtype: string;
  computation_ref: string;
  freshness_slo?: number | null;
}

app.post('/v1/features/definitions', async (request, reply) => {
  // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
  const body = request.body as DefinitionBody;
  if (!DTYPES.includes(body.dtype)) return reply.code(400).send({error: \`dtype must be one of \${DTYPES.join(', ')}\`});
  const definition = {...body, freshness_slo: body.freshness_slo ?? null, created_at: Math.floor(Date.now() / 1000)} as Definition;
  await putDefinition(definition);
  return reply.code(201).send(definition);
});
`,
      solution: `import Fastify from 'fastify';

import {type Definition, computationExists, createDefinition} from 'features/registry'; // also getDefinition, putDefinition

export const app = Fastify();

export const DTYPES = ['int64', 'float64', 'string', 'bool'];

interface DefinitionBody {
  name: string;
  version: number;
  dtype: string;
  computation_ref: string;
  freshness_slo?: number | null;
}

app.post('/v1/features/definitions', async (request, reply) => {
  const body = request.body as DefinitionBody;
  if (!DTYPES.includes(body.dtype)) return reply.code(400).send({error: \`dtype must be one of \${DTYPES.join(', ')}\`});
  const slo = body.freshness_slo;
  if (typeof slo !== 'number' || slo <= 0) return reply.code(400).send({error: 'freshness_slo (seconds) is required and must be positive'});
  if (!(await computationExists(body.computation_ref))) {
    return reply.code(422).send({error: \`computation_ref \${body.computation_ref} names no computation\`});
  }
  const definition: Definition = {
    name: body.name,
    version: body.version,
    dtype: body.dtype,
    computation_ref: body.computation_ref,
    freshness_slo: slo,
    created_at: Math.floor(Date.now() / 1000),
  };
  // One SET NX: the existence check and the write cannot be split by another registration.
  if (!(await createDefinition(definition))) return reply.code(409).send({error: \`\${body.name} v\${body.version} is already registered\`});
  return reply.code(201).send(definition);
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"net/http"
	"time"

	"features/registry" // registry.GetDefinition, CreateDefinition, PutDefinition, ComputationExists
)

var dtypes = map[string]bool{"int64": true, "float64": true, "string": true, "bool": true}

type definitionBody struct {
	Name           string \`json:"name"\`
	Version        int    \`json:"version"\`
	Dtype          string \`json:"dtype"\`
	ComputationRef string \`json:"computation_ref"\`
	FreshnessSLO   *int64 \`json:"freshness_slo"\`
}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func registerDefinition(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has three flaws. The task says where to look; the checks say what must change.
	var body definitionBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(rw, "malformed body", http.StatusBadRequest)
		return
	}
	if !dtypes[body.Dtype] {
		http.Error(rw, "dtype must be one of int64, float64, string, bool", http.StatusBadRequest)
		return
	}
	slo := int64(0)
	if body.FreshnessSLO != nil {
		slo = *body.FreshnessSLO
	}
	d := registry.Definition{Name: body.Name, Version: body.Version, Dtype: body.Dtype, ComputationRef: body.ComputationRef, FreshnessSLO: slo, CreatedAt: time.Now().Unix()}
	if err := registry.PutDefinition(r.Context(), d); err != nil {
		http.Error(rw, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(rw, http.StatusCreated, d)
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/features/definitions", registerDefinition)
}
`,
      solution: `package main

import (
	"encoding/json"
	"net/http"
	"time"

	"features/registry" // registry.GetDefinition, CreateDefinition, PutDefinition, ComputationExists
)

var dtypes = map[string]bool{"int64": true, "float64": true, "string": true, "bool": true}

type definitionBody struct {
	Name           string \`json:"name"\`
	Version        int    \`json:"version"\`
	Dtype          string \`json:"dtype"\`
	ComputationRef string \`json:"computation_ref"\`
	FreshnessSLO   *int64 \`json:"freshness_slo"\`
}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func registerDefinition(rw http.ResponseWriter, r *http.Request) {
	var body definitionBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(rw, "malformed body", http.StatusBadRequest)
		return
	}
	if !dtypes[body.Dtype] {
		http.Error(rw, "dtype must be one of int64, float64, string, bool", http.StatusBadRequest)
		return
	}
	if body.FreshnessSLO == nil || *body.FreshnessSLO <= 0 {
		http.Error(rw, "freshness_slo (seconds) is required and must be positive", http.StatusBadRequest)
		return
	}
	known, err := registry.ComputationExists(r.Context(), body.ComputationRef)
	if err != nil {
		http.Error(rw, err.Error(), http.StatusInternalServerError)
		return
	}
	if !known {
		http.Error(rw, "computation_ref "+body.ComputationRef+" names no computation", http.StatusUnprocessableEntity)
		return
	}
	d := registry.Definition{Name: body.Name, Version: body.Version, Dtype: body.Dtype, ComputationRef: body.ComputationRef, FreshnessSLO: *body.FreshnessSLO, CreatedAt: time.Now().Unix()}
	// One SET NX: the existence check and the write cannot be split by another registration.
	stored, err := registry.CreateDefinition(r.Context(), d)
	if err != nil {
		http.Error(rw, err.Error(), http.StatusInternalServerError)
		return
	}
	if !stored {
		http.Error(rw, body.Name+" is already registered at this version", http.StatusConflict)
		return
	}
	writeJSON(rw, http.StatusCreated, d)
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/features/definitions", registerDefinition)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import features.Registry // Registry.getDefinition, createDefinition, putDefinition, computationExists

object Api {
  val Dtypes: Set[String] = Set("int64", "float64", "string", "bool")

  private def json(status: StatusCode, body: JsObject): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  private def text(fields: Map[String, JsValue], name: String): String = fields.get(name).collect { case JsString(s) => s }.getOrElse("")
  private def number(fields: Map[String, JsValue], name: String): Option[Long] = fields.get(name).collect { case JsNumber(n) => n.toLong }

  val route: Route = path("v1" / "features" / "definitions") {
    post {
      entity(as[String]) { raw =>
        // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
        val fields = raw.parseJson.asJsObject.fields
        if (!Dtypes.contains(text(fields, "dtype"))) complete(StatusCodes.BadRequest -> "dtype must be one of int64, float64, string, bool")
        else {
          val d = Registry.Definition(text(fields, "name"), number(fields, "version").getOrElse(0L), text(fields, "dtype"),
            text(fields, "computation_ref"), number(fields, "freshness_slo").getOrElse(0L), System.currentTimeMillis() / 1000)
          Registry.putDefinition(d)
          complete(json(StatusCodes.Created, d.toJson))
        }
      }
    }
  }
}
`,
      solution: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import features.Registry // Registry.getDefinition, createDefinition, putDefinition, computationExists

object Api {
  val Dtypes: Set[String] = Set("int64", "float64", "string", "bool")

  private def json(status: StatusCode, body: JsObject): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  private def text(fields: Map[String, JsValue], name: String): String = fields.get(name).collect { case JsString(s) => s }.getOrElse("")
  private def number(fields: Map[String, JsValue], name: String): Option[Long] = fields.get(name).collect { case JsNumber(n) => n.toLong }

  val route: Route = path("v1" / "features" / "definitions") {
    post {
      entity(as[String]) { raw =>
        val fields = raw.parseJson.asJsObject.fields
        val ref = text(fields, "computation_ref")
        if (!Dtypes.contains(text(fields, "dtype"))) complete(StatusCodes.BadRequest -> "dtype must be one of int64, float64, string, bool")
        else
          number(fields, "freshness_slo").filter(_ > 0) match {
            case None => complete(StatusCodes.BadRequest -> "freshness_slo (seconds) is required and must be positive")
            case Some(_) if !Registry.computationExists(ref) => complete(StatusCodes.UnprocessableEntity -> s"computation_ref $ref names no computation")
            case Some(slo) =>
              val d = Registry.Definition(text(fields, "name"), number(fields, "version").getOrElse(0L), text(fields, "dtype"), ref, slo,
                System.currentTimeMillis() / 1000)
              // One SET NX: the existence check and the write cannot be split by another registration.
              if (Registry.createDefinition(d)) complete(json(StatusCodes.Created, d.toJson))
              else complete(StatusCodes.Conflict -> s"\${d.name} v\${d.version} is already registered")
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

#include <chrono>
#include <set>
#include <string>

#include "features/registry.h"  // registry::getDefinition, createDefinition, putDefinition, computationExists

using json = nlohmann::json;

const std::set<std::string> kDtypes = {"int64", "float64", "string", "bool"};

long long now_seconds() {
  return std::chrono::duration_cast<std::chrono::seconds>(std::chrono::system_clock::now().time_since_epoch()).count();
}

void reply(httplib::Response& res, int status, const std::string& message) {
  res.status = status;
  res.set_content(message, "text/plain");
}

void register_definition(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
  const json body = json::parse(req.body, nullptr, false);
  if (!body.is_object() || !kDtypes.count(body.value("dtype", ""))) return reply(res, 400, "dtype must be one of int64, float64, string, bool");
  const json slo = body.value("freshness_slo", json());
  const registry::Definition d{body.value("name", ""), body.value("version", 0L), body.value("dtype", ""), body.value("computation_ref", ""),
                               slo.is_number() ? slo.get<long long>() : 0, now_seconds()};
  registry::putDefinition(d);
  res.status = 201;
  res.set_content(registry::toJson(d).dump(), "application/json");
}

void register_routes(httplib::Server& svr) { svr.Post("/v1/features/definitions", register_definition); }
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <chrono>
#include <set>
#include <string>

#include "features/registry.h"  // registry::getDefinition, createDefinition, putDefinition, computationExists

using json = nlohmann::json;

const std::set<std::string> kDtypes = {"int64", "float64", "string", "bool"};

long long now_seconds() {
  return std::chrono::duration_cast<std::chrono::seconds>(std::chrono::system_clock::now().time_since_epoch()).count();
}

void reply(httplib::Response& res, int status, const std::string& message) {
  res.status = status;
  res.set_content(message, "text/plain");
}

void register_definition(const httplib::Request& req, httplib::Response& res) {
  const json body = json::parse(req.body, nullptr, false);
  if (!body.is_object() || !kDtypes.count(body.value("dtype", ""))) return reply(res, 400, "dtype must be one of int64, float64, string, bool");
  const json slo = body.value("freshness_slo", json());
  if (!slo.is_number_integer() || slo.get<long long>() <= 0) return reply(res, 400, "freshness_slo (seconds) is required and must be positive");
  const std::string ref = body.value("computation_ref", "");
  if (!registry::computationExists(ref)) return reply(res, 422, "computation_ref " + ref + " names no computation");
  const registry::Definition d{body.value("name", ""), body.value("version", 0L), body.value("dtype", ""), ref, slo.get<long long>(), now_seconds()};
  // One SET NX: the existence check and the write cannot be split by another registration.
  if (!registry::createDefinition(d)) return reply(res, 409, d.name + " v" + std::to_string(d.version) + " is already registered");
  res.status = 201;
  res.set_content(registry::toJson(d).dump(), "application/json");
}

void register_routes(httplib::Server& svr) { svr.Post("/v1/features/definitions", register_definition); }
`,
    },
  },
  harness: {
    python: `import time

from features import registry

BODY = {"name": "amount_7d", "version": 2, "dtype": "float64", "computation_ref": "window_avg_7d", "freshness_slo": 300}


def _api(ctx):
    registry.register_computation("window_avg_7d")
    registry.register_computation("window_sum_1d")
    m = ctx.load("api")
    return ctx.client(m.app)


async def _register(c, body=None, **changes):
    return await c.post("/v1/features/definitions", json={**(BODY if body is None else body), **changes})


async def check_route(ctx):
    async with _api(ctx) as c:
        r = await _register(c)
        assert r.status_code == 201, f"POST /v1/features/definitions answered {r.status_code}: {r.text}"
        body = r.json()
        stored = registry.get_definition("amount_7d", 2)
        assert stored is not None, "after a 201 the registry holds no definition:amount_7d:2"
        assert body == stored, f"the response {body} must be the definition as stored: {stored}"
        assert all(body.get(k) == v for k, v in BODY.items()), f"the stored definition {body} lost a field of the request {BODY}"
        assert abs(body.get("created_at", 0) - time.time()) <= 5, f"created_at is {body.get('created_at')!r}, expected the registration time in epoch seconds"
        bad = await _register(c, name="amount_30d", dtype="float32")
    assert bad.status_code == 400, f"a dtype outside DTYPES answered {bad.status_code}, expected 400"
    assert registry.get_definition("amount_30d", 2) is None, "a definition with an unknown dtype was stored"


async def check_immutable_version(ctx):
    async with _api(ctx) as c:
        first = await _register(c)
        assert first.status_code == 201, f"the first registration of amount_7d v2 answered {first.status_code}: {first.text}"
        again = await _register(c, dtype="int64", computation_ref="window_sum_1d")
        assert again.status_code == 409, f"a second registration of amount_7d v2 answered {again.status_code}, expected 409: a version is immutable"
        stored = registry.get_definition("amount_7d", 2)
        assert stored == first.json(), f"the second registration rewrote amount_7d v2: the registry holds {stored}, the first registration was {first.json()}"
        # A rival registration of v3 lands right after this one first touches the key.
        rival = {**BODY, "version": 3, "dtype": "int64", "created_at": int(time.time())}
        probe = ctx.redis_after("definition:amount_7d:3", lambda: registry.create_definition(rival))
        r = await _register(c, version=3)
    assert probe.fired, "the registration of amount_7d v3 never touched definition:amount_7d:3"
    if probe.error is not None:
        raise probe.error
    stored = registry.get_definition("amount_7d", 3)
    if probe.result:
        assert r.status_code == 409 and stored == rival, f"a rival registration of amount_7d v3 landed between the check and the write; the endpoint answered {r.status_code} and the registry holds {stored}, expected 409 with the rival kept. Store with one SET NX"
    else:
        assert r.status_code == 201 and stored == r.json(), f"the registration won the race but answered {r.status_code}; the registry holds {stored}"


async def check_computation_ref(ctx):
    async with _api(ctx) as c:
        r = await _register(c, computation_ref="window_avg_7days")
        assert r.status_code == 422, f"a computation_ref the compute registry does not know answered {r.status_code}, expected 422"
        assert registry.get_definition("amount_7d", 2) is None, f"a definition with a dangling computation_ref was stored: {registry.get_definition('amount_7d', 2)}"
        r = await _register(c)
    assert r.status_code == 201, f"with a computation_ref that resolves the registration answered {r.status_code}: {r.text}"


async def check_freshness_slo(ctx):
    without = {k: v for k, v in BODY.items() if k != "freshness_slo"}
    async with _api(ctx) as c:
        for version, body, what in ((10, without, "missing"), (11, {**BODY, "freshness_slo": None}, "null"), (12, {**BODY, "freshness_slo": 0}, "0"), (13, {**BODY, "freshness_slo": -5}, "-5")):
            r = await _register(c, body, version=version)
            assert r.status_code == 400, f"a freshness_slo that is {what} answered {r.status_code}, expected 400"
            assert registry.get_definition("amount_7d", version) is None, f"a definition whose freshness_slo is {what} was stored: {registry.get_definition('amount_7d', version)}"
        r = await _register(c, version=14)
    assert r.status_code == 201 and r.json().get("freshness_slo") == 300, f"a definition with freshness_slo 300 answered {r.status_code} {r.text}"
`,
    typescript: `const BODY = {name: 'amount_7d', version: 2, dtype: 'float64', computation_ref: 'window_avg_7d', freshness_slo: 300};

async function api(ctx) {
  const registry = ctx.load('/support/features/registry.ts');
  await registry.registerComputation('window_avg_7d');
  await registry.registerComputation('window_sum_1d');
  const m = ctx.load('api');
  return {c: ctx.client(m.app), registry};
}

const register = (c, body: Record<string, unknown>) => c.post('/v1/features/definitions', {json: body});

export async function check_route(ctx) {
  const {c, registry} = await api(ctx);
  const r = await register(c, BODY);
  assert.equal(r.status, 201, \`POST /v1/features/definitions answered \${r.status}: \${r.text}\`);
  const body = r.json();
  const stored = await registry.getDefinition('amount_7d', 2);
  assert(stored !== null, 'after a 201 the registry holds no definition:amount_7d:2');
  assert.deepStrictEqual(body, stored, \`the response \${r.text} must be the definition as stored: \${JSON.stringify(stored)}\`);
  for (const [k, v] of Object.entries(BODY)) assert.equal(body[k], v, \`the stored definition \${r.text} lost the field \${k} of the request\`);
  assert(Math.abs(body.created_at - Date.now() / 1000) <= 5, \`created_at is \${body.created_at}, expected the registration time in epoch seconds\`);
  const bad = await register(c, {...BODY, name: 'amount_30d', dtype: 'float32'});
  assert.equal(bad.status, 400, \`a dtype outside DTYPES answered \${bad.status}, expected 400\`);
  assert.equal(await registry.getDefinition('amount_30d', 2), null, 'a definition with an unknown dtype was stored');
}

export async function check_immutable_version(ctx) {
  const {c, registry} = await api(ctx);
  const first = await register(c, BODY);
  assert.equal(first.status, 201, \`the first registration of amount_7d v2 answered \${first.status}: \${first.text}\`);
  const again = await register(c, {...BODY, dtype: 'int64', computation_ref: 'window_sum_1d'});
  assert.equal(again.status, 409, \`a second registration of amount_7d v2 answered \${again.status}, expected 409: a version is immutable\`);
  const stored = await registry.getDefinition('amount_7d', 2);
  assert.deepStrictEqual(stored, first.json(), \`the second registration rewrote amount_7d v2: the registry holds \${JSON.stringify(stored)}\`);
  // A rival registration of v3 lands right after this one first touches the key.
  const rival = {...BODY, version: 3, dtype: 'int64', created_at: Math.floor(Date.now() / 1000)};
  const probe = ctx.redisAfter('definition:amount_7d:3', () => ctx.redis.set('definition:amount_7d:3', JSON.stringify(rival), 'NX') === 'OK');
  const r = await register(c, {...BODY, version: 3});
  assert(probe.fired, 'the registration of amount_7d v3 never touched definition:amount_7d:3');
  if (probe.error !== undefined) throw probe.error;
  const won = await probe.result;
  const now = await registry.getDefinition('amount_7d', 3);
  if (won) {
    assert(r.status === 409 && JSON.stringify(now) === JSON.stringify(rival), \`a rival registration of amount_7d v3 landed between the check and the write; the endpoint answered \${r.status} and the registry holds \${JSON.stringify(now)}, expected 409 with the rival kept. Store with one SET NX\`);
  } else {
    assert(r.status === 201, \`the registration won the race but answered \${r.status}\`);
    assert.deepStrictEqual(now, r.json(), 'the registry must hold the definition the endpoint answered');
  }
}

export async function check_computation_ref(ctx) {
  const {c, registry} = await api(ctx);
  let r = await register(c, {...BODY, computation_ref: 'window_avg_7days'});
  assert.equal(r.status, 422, \`a computation_ref the compute registry does not know answered \${r.status}, expected 422\`);
  assert.equal(await registry.getDefinition('amount_7d', 2), null, 'a definition with a dangling computation_ref was stored');
  r = await register(c, BODY);
  assert.equal(r.status, 201, \`with a computation_ref that resolves the registration answered \${r.status}: \${r.text}\`);
}

export async function check_freshness_slo(ctx) {
  const {c, registry} = await api(ctx);
  const {freshness_slo: _slo, ...without} = BODY;
  const cases: [number, Record<string, unknown>, string][] = [
    [10, without, 'missing'],
    [11, {...BODY, freshness_slo: null}, 'null'],
    [12, {...BODY, freshness_slo: 0}, '0'],
    [13, {...BODY, freshness_slo: -5}, '-5'],
  ];
  for (const [version, body, what] of cases) {
    const r = await register(c, {...body, version});
    assert.equal(r.status, 400, \`a freshness_slo that is \${what} answered \${r.status}, expected 400\`);
    assert.equal(await registry.getDefinition('amount_7d', version), null, \`a definition whose freshness_slo is \${what} was stored\`);
  }
  const r = await register(c, {...BODY, version: 14});
  assert(r.status === 201 && r.json().freshness_slo === 300, \`a definition with freshness_slo 300 answered \${r.status} \${r.text}\`);
}
`,
    go: `package main

import (
	"context"
	"encoding/json"
	"net/http"
	"time"

	"features/registry"

	"leetbuild/harness"
)

var bg = context.Background()

func body(changes map[string]any) map[string]any {
	out := map[string]any{"name": "amount_7d", "version": 2, "dtype": "float64", "computation_ref": "window_avg_7d", "freshness_slo": 300}
	for k, v := range changes {
		if v == "-" {
			delete(out, k)
		} else {
			out[k] = v
		}
	}
	return out
}

func api(ctx *harness.Ctx) *harness.HTTP {
	registry.RegisterComputation(bg, "window_avg_7d")
	registry.RegisterComputation(bg, "window_sum_1d")
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

func stored(ctx *harness.Ctx, version int) *registry.Definition {
	d, err := registry.GetDefinition(bg, "amount_7d", version)
	ctx.NoError(err, "GetDefinition(amount_7d, %d)", version)
	return d
}

func answered(ctx *harness.Ctx, r *harness.Response) registry.Definition {
	var d registry.Definition
	ctx.NoError(json.Unmarshal(r.Body, &d), "the response must be the definition as JSON, got %s", r.Text())
	return d
}

func CheckRoute(ctx *harness.Ctx) {
	c := api(ctx)
	r := c.Post("/v1/features/definitions", body(nil))
	ctx.Equal(r.Status, 201, "POST /v1/features/definitions (%s)", r.Text())
	d := stored(ctx, 2)
	ctx.Assert(d != nil, "after a 201 the registry holds no definition:amount_7d:2")
	ctx.Equal(answered(ctx, r), *d, "the response must be the definition as stored")
	ctx.Assert(d.Dtype == "float64" && d.ComputationRef == "window_avg_7d" && d.FreshnessSLO == 300, "the stored definition %+v lost a field of the request", *d)
	age := time.Now().Unix() - d.CreatedAt
	ctx.Assert(age >= -5 && age <= 5, "created_at is %d, expected the registration time in epoch seconds", d.CreatedAt)
	bad := c.Post("/v1/features/definitions", body(map[string]any{"name": "amount_30d", "dtype": "float32"}))
	ctx.Equal(bad.Status, 400, "a dtype outside dtypes")
	missing, _ := registry.GetDefinition(bg, "amount_30d", 2)
	ctx.Assert(missing == nil, "a definition with an unknown dtype was stored")
}

func CheckImmutableVersion(ctx *harness.Ctx) {
	c := api(ctx)
	first := c.Post("/v1/features/definitions", body(nil))
	ctx.Equal(first.Status, 201, "the first registration of amount_7d v2 (%s)", first.Text())
	again := c.Post("/v1/features/definitions", body(map[string]any{"dtype": "int64", "computation_ref": "window_sum_1d"}))
	ctx.Equal(again.Status, 409, "a second registration of amount_7d v2 (a version is immutable)")
	ctx.Equal(*stored(ctx, 2), answered(ctx, first), "the second registration must not rewrite amount_7d v2; the registry holds")
	// A rival registration of v3 lands right after this one first touches the key.
	rival := registry.Definition{Name: "amount_7d", Version: 3, Dtype: "int64", ComputationRef: "window_avg_7d", FreshnessSLO: 300, CreatedAt: time.Now().Unix()}
	probe := ctx.Redis.After("definition:amount_7d:3", func() any {
		won, err := registry.CreateDefinition(bg, rival)
		ctx.NoError(err, "the rival registration failed")
		return won
	})
	r := c.Post("/v1/features/definitions", body(map[string]any{"version": 3}))
	ctx.Assert(probe.Fired, "the registration of amount_7d v3 never touched definition:amount_7d:3")
	ctx.Assert(probe.Err == nil, "the rival registration failed: %v", probe.Err)
	now := stored(ctx, 3)
	if probe.Result == true {
		ctx.Assert(r.Status == 409 && now != nil && *now == rival, "a rival registration of amount_7d v3 landed between the check and the write; the endpoint answered %d and the registry holds %+v, expected 409 with the rival kept. Store with one SET NX", r.Status, now)
	} else {
		ctx.Equal(r.Status, 201, "the registration won the race")
		ctx.Equal(*now, answered(ctx, r), "the registry must hold the definition the endpoint answered")
	}
}

func CheckComputationRef(ctx *harness.Ctx) {
	c := api(ctx)
	r := c.Post("/v1/features/definitions", body(map[string]any{"computation_ref": "window_avg_7days"}))
	ctx.Equal(r.Status, 422, "a computation_ref the compute registry does not know")
	ctx.Assert(stored(ctx, 2) == nil, "a definition with a dangling computation_ref was stored: %+v", stored(ctx, 2))
	r = c.Post("/v1/features/definitions", body(nil))
	ctx.Equal(r.Status, 201, "with a computation_ref that resolves, the registration (%s)", r.Text())
}

func CheckFreshnessSlo(ctx *harness.Ctx) {
	c := api(ctx)
	cases := []struct {
		version int
		slo     any
		what    string
	}{{10, "-", "missing"}, {11, nil, "null"}, {12, 0, "0"}, {13, -5, "-5"}}
	for _, tc := range cases {
		r := c.Post("/v1/features/definitions", body(map[string]any{"version": tc.version, "freshness_slo": tc.slo}))
		ctx.Equal(r.Status, 400, "a freshness_slo that is %s", tc.what)
		ctx.Assert(stored(ctx, tc.version) == nil, "a definition whose freshness_slo is %s was stored: %+v", tc.what, stored(ctx, tc.version))
	}
	r := c.Post("/v1/features/definitions", body(map[string]any{"version": 14}))
	ctx.Assert(r.Status == 201 && answered(ctx, r).FreshnessSLO == 300, "a definition with freshness_slo 300 answered %d %s", r.Status, r.Text())
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <chrono>
#include <memory>
#include <optional>
#include <string>

#include "features/registry.h"

using json = nlohmann::json;

namespace {

const json kBody = {{"name", "amount_7d"}, {"version", 2}, {"dtype", "float64"}, {"computation_ref", "window_avg_7d"}, {"freshness_slo", 300}};

harness::HTTP api(harness::Ctx& ctx) {
  registry::registerComputation("window_avg_7d");
  registry::registerComputation("window_sum_1d");
  static httplib::Server* svr = nullptr;
  delete svr;
  svr = new httplib::Server;
  register_routes(*svr);
  return ctx.HTTP(*svr);
}

json with(json body, const json& changes) {
  for (const auto& [k, v] : changes.items()) body[k] = v;
  return body;
}

harness::Response post(harness::HTTP& c, const json& body) {
  return c.Post("/v1/features/definitions", body.dump(), "Content-Type", "application/json");
}

std::optional<json> stored(long version) {
  const auto d = registry::getDefinition("amount_7d", version);
  if (!d) return std::nullopt;
  return registry::toJson(*d);
}

json parsed(const harness::Response& r) { return json::parse(r.Text(), nullptr, false); }

long long nowSeconds() {
  return std::chrono::duration_cast<std::chrono::seconds>(std::chrono::system_clock::now().time_since_epoch()).count();
}

}  // namespace

void CheckRoute(harness::Ctx& ctx) {
  auto c = api(ctx);
  const auto r = post(c, kBody);
  ctx.Equal(r.Status, 201, "POST /v1/features/definitions (%s)", r.Text());
  const auto d = stored(2);
  ctx.Assert(d.has_value(), "after a 201 the registry holds no definition:amount_7d:2");
  ctx.Equal(parsed(r), *d, "the response must be the definition as stored");
  for (const auto& [k, v] : kBody.items()) ctx.Equal((*d)[k], v, "the stored definition lost the field %s of the request", k);
  const long long age = nowSeconds() - d->value("created_at", 0LL);
  ctx.Assert(age >= -5 && age <= 5, "created_at is %s, expected the registration time in epoch seconds", (*d)["created_at"].dump());
  const auto bad = post(c, with(kBody, {{"name", "amount_30d"}, {"dtype", "float32"}}));
  ctx.Equal(bad.Status, 400, "a dtype outside kDtypes");
  ctx.Assert(!registry::getDefinition("amount_30d", 2), "a definition with an unknown dtype was stored");
}

void CheckImmutableVersion(harness::Ctx& ctx) {
  auto c = api(ctx);
  const auto first = post(c, kBody);
  ctx.Equal(first.Status, 201, "the first registration of amount_7d v2 (%s)", first.Text());
  const auto again = post(c, with(kBody, {{"dtype", "int64"}, {"computation_ref", "window_sum_1d"}}));
  ctx.Equal(again.Status, 409, "a second registration of amount_7d v2 (a version is immutable)");
  ctx.Equal(stored(2).value_or(json()), parsed(first), "the second registration must not rewrite amount_7d v2; the registry holds");
  // A rival registration of v3 lands right after this one first touches the key.
  const registry::Definition rival{"amount_7d", 3, "int64", "window_avg_7d", 300, nowSeconds()};
  auto fired = std::make_shared<bool>(false);
  auto won = std::make_shared<bool>(false);
  ctx.Redis.After("definition:amount_7d:3", [fired, won, rival] {
    *fired = true;
    *won = registry::createDefinition(rival);
  });
  const auto r = post(c, with(kBody, {{"version", 3}}));
  ctx.Assert(*fired, "the registration of amount_7d v3 never touched definition:amount_7d:3");
  const json now = stored(3).value_or(json());
  if (*won) {
    ctx.Assert(r.Status == 409 && now == registry::toJson(rival),
               "a rival registration of amount_7d v3 landed between the check and the write; the endpoint answered %d and the registry holds %s, expected 409 with the rival kept. Store with one SET NX",
               r.Status, now.dump());
  } else {
    ctx.Equal(r.Status, 201, "the registration won the race");
    ctx.Equal(now, parsed(r), "the registry must hold the definition the endpoint answered");
  }
}

void CheckComputationRef(harness::Ctx& ctx) {
  auto c = api(ctx);
  auto r = post(c, with(kBody, {{"computation_ref", "window_avg_7days"}}));
  ctx.Equal(r.Status, 422, "a computation_ref the compute registry does not know");
  ctx.Assert(!stored(2), "a definition with a dangling computation_ref was stored: %s", stored(2).value_or(json()).dump());
  r = post(c, kBody);
  ctx.Equal(r.Status, 201, "with a computation_ref that resolves, the registration (%s)", r.Text());
}

void CheckFreshnessSlo(harness::Ctx& ctx) {
  auto c = api(ctx);
  json without = kBody;
  without.erase("freshness_slo");
  const std::vector<std::pair<json, std::string>> cases = {
      {with(without, {{"version", 10}}), "missing"},
      {with(kBody, {{"version", 11}, {"freshness_slo", nullptr}}), "null"},
      {with(kBody, {{"version", 12}, {"freshness_slo", 0}}), "0"},
      {with(kBody, {{"version", 13}, {"freshness_slo", -5}}), "-5"},
  };
  for (const auto& [body, what] : cases) {
    const auto r = post(c, body);
    ctx.Equal(r.Status, 400, "a freshness_slo that is %s", what);
    ctx.Assert(!stored(body["version"].get<long>()), "a definition whose freshness_slo is %s was stored", what);
  }
  const auto r = post(c, with(kBody, {{"version", 14}}));
  ctx.Assert(r.Status == 201 && parsed(r).value("freshness_slo", 0) == 300, "a definition with freshness_slo 300 answered %d %s", r.Status, r.Text());
}
`,
  },
  hints: [
    'Register amount_7d version 2 twice with different dtypes: the second answers 201 and the registry now holds it. A typo in computation_ref and a body without freshness_slo are stored too.',
    'The handler stores with put_definition, a plain SET over whatever the key holds, and never asks the compute registry or looks at freshness_slo. A GET before the write still loses to a registration landing between the two.',
    'Answer 400 when freshness_slo is missing, null or ≤ 0; 422 unless `registry.computation_exists(ref)`; then store with `registry.create_definition` (SET NX) and answer 409 when it returns false.',
  ],
  debrief: `The write is the check: \`SET NX\` makes the existence test and the store one command, so a registration landing between a read and a write cannot replace the first one, and the 409 keeps every version exactly as it was when a model was trained on it. Resolving the computation at registration moves the failure from a training job an hour later to the request that caused it. The SLO is required because it is the one field that lets a reader decide whether a value is still usable; without it every stale value looks fresh. Feature registries also record an owner per feature and deprecate a version rather than delete it, so the models pinned to it keep resolving.`,
};
