import type {Step} from '@/lib/types';

export const endpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/features/definitions: one definition, both paths',
  concept: 'http',
  file: 'api',
  focus: ['client', 'api', 'db'],
  task: `## Task

**Starting point.** The starter accepts \`POST /v1/features/definitions\` with body
\`{"name": "amount_7d", "version": 2, "dtype": "float64", "computation_ref": "window_avg_7d", "freshness_slo": 300}\`,
stores it under \`name:version\` and echoes it back with 200. It serves the demo and hides four flaws.

**Failure mode the checks target.** A definition that can be written over is one training and serving
can disagree about; a dangling \`computation_ref\` and a \`null\` freshness SLO only surface once a
model has been trained on them.

- A definition is keyed by **(name, version)**. Registering an existing pair is **409** and the stored
  record stays untouched. The starter writes over it.
- \`dtype\` is one of \`int64\`, \`float64\`, \`string\`, \`bool\` (**400** otherwise).
- \`computation_ref\` is resolved against the compute registry at registration; a reference that names
  nothing is **422**. The starter accepts any string.
- \`freshness_slo\` (seconds) is **required** and positive (**400** when missing or \`null\`). The
  starter has no such field and stores \`freshness\` as \`null\`.
- The response is the definition **as stored**, including the creation time, with **201**, not a
  restatement of the request body.

## What to keep

The route, the request model and the store are fine. The fix is the key check, the resolution step and
the explicit SLO: validate everything before the write, and never overwrite a stored version.`,
  sequence: {
    participants: ['Client', 'Feature API', 'Definition registry'],
    messages: [
      {
        from: 'Client',
        to: 'Feature API',
        label: 'POST /v1/features/definitions {name, version, dtype, ref, slo}',
        kind: 'sync',
      },
      {from: 'Feature API', to: 'Definition registry', label: 'has(feature:name:version)', kind: 'sync'},
      {from: 'Definition registry', to: 'Feature API', label: 'existing / none', kind: 'reply'},
      {
        from: 'Feature API',
        to: 'Feature API',
        label: '409 existing · 422 dangling ref · 400 without an SLO',
        kind: 'sync',
      },
      {from: 'Feature API', to: 'Definition registry', label: 'put(feature:name:version, definition)', kind: 'async'},
      {
        from: 'Feature API',
        to: 'Client',
        label: '201 {name, version, dtype, computation_ref, freshness_slo}',
        kind: 'reply',
      },
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Handles POST /v1/features/definitions',
      detail: 'Register the definition route on `POST /v1/features/definitions`.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/features\/definitions["']\)/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/features\/definitions['"]/]},
        go: {all: [/HandleFunc\(\s*"POST \/v1\/features\/definitions"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"features"\s*\/\s*"definitions"\s*\)/, /\bpost\s*\{/]},
        cpp: {all: [/svr\.Post\(\s*"\/v1\/features\/definitions"/]},
      },
    },
    {
      id: 'immutable-version',
      title: 'Treats (name, version) as immutable',
      detail:
        'The store key is built from both `name` and `version`, an existing pair answers **409**, and the stored record is never overwritten. The starter keys by name only and mutates the definition in place.',
      match: {
        python: {all: [/status_code\s*=\s*409/, /f"feature:\{body\.name\}:\{body\.version\}"/]},
        typescript: {all: [/code\(\s*409\s*\)/, /feature:\$\{body\.name\}:\$\{body\.version\}/]},
        go: {all: [/StatusConflict/, /"feature:"\s*\+\s*body\.Name/, /strconv\.Itoa\(body\.Version\)/]},
        scala: {all: [/StatusCodes\.Conflict/, /s"feature:\$\{body\.name\}:\$\{body\.version\}"/]},
        cpp: {all: [/\b409\b/, /"feature:"\s*\+\s*body\.value\("name"/]},
      },
    },
    {
      id: 'resolve-ref',
      title: 'Resolves computation_ref or answers 422',
      detail:
        '`computation_ref` is looked up in the compute registry and a reference that does not resolve is **422**. The starter stores any string and lets the training job discover the typo.',
      match: {
        python: {all: [/COMPUTATION_REFS/, /status_code\s*=\s*422/]},
        typescript: {all: [/COMPUTATION_REFS/, /code\(\s*422\s*\)/]},
        go: {all: [/computationRefs/, /StatusUnprocessableEntity/]},
        scala: {all: [/ComputationRefs/, /StatusCodes\.UnprocessableEntity/]},
        cpp: {all: [/kComputationRefs/, /\b422\b/]},
      },
    },
    {
      id: 'freshness-slo',
      title: 'Requires an explicit freshness SLO',
      detail:
        'A missing, `null` or non-positive `freshness_slo` is **400**, and the stored definition carries the explicit value. The starter defaults it to `null`, so no consumer can alert on staleness.',
      match: {
        python: {all: [/freshness_slo/, /status_code\s*=\s*400/]},
        typescript: {all: [/freshness_slo/, /code\(\s*400\s*\)/]},
        go: {all: [/FreshnessSlo/, /StatusBadRequest/]},
        scala: {all: [/freshness_slo/, /StatusCodes\.BadRequest/]},
        cpp: {all: [/freshness_slo/, /\b400\b/]},
      },
    },
    {
      id: 'stored-record',
      title: 'Stores and returns the canonical definition',
      detail:
        'The handler writes the validated definition under the (name, version) key and answers **201** with that stored record. The starter answers 200 with a restatement of the request.',
      match: {
        python: {all: [/status_code\s*=\s*201/, /JSONResponse\(record/]},
        typescript: {all: [/code\(\s*201\s*\)/, /send\(record\)/]},
        go: {all: [/StatusCreated/, /Encode\(record\)/]},
        scala: {all: [/StatusCodes\.Created/, /complete\(StatusCodes\.Created, record\)/]},
        cpp: {all: [/\b201\b/, /set_content\(record\.dump\(\)/]},
      },
    },
  ],
  code: {
    python: {
      starter: `from fastapi import FastAPI
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()

DEFINITIONS: dict[str, dict] = {}


class Definition(BaseModel):
    name: str
    version: int
    dtype: str
    computation_ref: str
    freshness: int | None = None


@app.post("/v1/features/definitions")
def register(body: Definition) -> JSONResponse:
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    record = {**body.model_dump(), "created_at": 0}
    DEFINITIONS[f"{body.name}:{body.version}"] = record
    return JSONResponse(record, status_code=200)
`,
      solution: `import time

from fastapi import FastAPI
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()

DTYPES = ("int64", "float64", "string", "bool")
COMPUTATION_REFS = ("window_avg_7d", "last_value", "count_1h", "sum_24h")
DEFINITIONS: dict[str, dict] = {}


class Definition(BaseModel):
    name: str
    version: int
    dtype: str
    computation_ref: str
    freshness_slo: int | None = None


@app.post("/v1/features/definitions")
def register(body: Definition) -> JSONResponse:
    key = f"feature:{body.name}:{body.version}"
    if key in DEFINITIONS:
        return JSONResponse({"error": "definition exists", "version": body.version}, status_code=409)
    if body.dtype not in DTYPES:
        return JSONResponse({"error": "unsupported dtype"}, status_code=400)
    if body.computation_ref not in COMPUTATION_REFS:
        return JSONResponse({"error": "unknown computation_ref"}, status_code=422)
    if body.freshness_slo is None or body.freshness_slo <= 0:
        return JSONResponse({"error": "freshness_slo is required"}, status_code=400)
    record = {
        "name": body.name,
        "version": body.version,
        "dtype": body.dtype,
        "computation_ref": body.computation_ref,
        "freshness_slo": body.freshness_slo,
        "created_at": int(time.time()),
    }
    DEFINITIONS[key] = record
    return JSONResponse(record, status_code=201)
`,
    },
    typescript: {
      starter: `/** POST /v1/features/definitions: flawed code that overwrites whatever it is given. */
import Fastify from 'fastify';

export const app = Fastify();

const DEFINITIONS = new Map<string, Record<string, unknown>>();

interface Definition {
  name: string;
  version: number;
  dtype: string;
  computation_ref: string;
  freshness?: number | null;
}

app.post('/v1/features/definitions', async (request, reply) => {
  const body = request.body as Definition;
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const record = {...body, created_at: Math.floor(Date.now() / 1000)};
  DEFINITIONS.set(\`\${body.name}:\${body.version}\`, record);
  return reply.code(200).send(record);
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** POST /v1/features/definitions: an immutable, reference-checked definition both paths read. */
import Fastify from 'fastify';

export const app = Fastify();

const DTYPES: Record<string, true> = {int64: true, float64: true, string: true, bool: true};
const COMPUTATION_REFS: Record<string, true> = {
  window_avg_7d: true,
  last_value: true,
  count_1h: true,
  sum_24h: true,
};
const DEFINITIONS = new Map<string, Record<string, unknown>>();

interface Definition {
  name: string;
  version: number;
  dtype: string;
  computation_ref: string;
  freshness_slo?: number | null;
}

app.post('/v1/features/definitions', async (request, reply) => {
  const body = request.body as Definition;
  const key = \`feature:\${body.name}:\${body.version}\`;
  if (DEFINITIONS.has(key)) return reply.code(409).send({error: 'definition exists', version: body.version});
  if (DTYPES[body.dtype] === undefined) return reply.code(400).send({error: 'unsupported dtype'});
  if (COMPUTATION_REFS[body.computation_ref] === undefined)
    return reply.code(422).send({error: 'unknown computation_ref'});
  if (body.freshness_slo == null || body.freshness_slo <= 0)
    return reply.code(400).send({error: 'freshness_slo is required'});
  const record = {
    name: body.name,
    version: body.version,
    dtype: body.dtype,
    computation_ref: body.computation_ref,
    freshness_slo: body.freshness_slo,
    created_at: Math.floor(Date.now() / 1000),
  };
  DEFINITIONS.set(key, record);
  return reply.code(201).send(record);
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"time"
)

var definitions = map[string]map[string]any{}

func registerDefinition(rw http.ResponseWriter, r *http.Request) {
	var body map[string]any
	_ = json.NewDecoder(r.Body).Decode(&body)
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	body["created_at"] = time.Now().Unix()
	definitions[fmt.Sprintf("%v:%v", body["name"], body["version"])] = body
	rw.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(rw).Encode(body)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/features/definitions", registerDefinition)
	_ = http.ListenAndServe(":8443", mux)
}
`,
      solution: `package main

import (
	"encoding/json"
	"net/http"
	"strconv"
	"time"
)

var (
	dtypes          = map[string]bool{"int64": true, "float64": true, "string": true, "bool": true}
	computationRefs = map[string]bool{"window_avg_7d": true, "last_value": true, "count_1h": true, "sum_24h": true}
	definitions     = map[string]map[string]any{}
)

type definition struct {
	Name           string \`json:"name"\`
	Version        int    \`json:"version"\`
	Dtype          string \`json:"dtype"\`
	ComputationRef string \`json:"computation_ref"\`
	FreshnessSlo   *int   \`json:"freshness_slo"\`
}

func registerDefinition(rw http.ResponseWriter, r *http.Request) {
	var body definition
	_ = json.NewDecoder(r.Body).Decode(&body)
	key := "feature:" + body.Name + ":" + strconv.Itoa(body.Version)
	if _, exists := definitions[key]; exists {
		http.Error(rw, \`{"error":"definition exists"}\`, http.StatusConflict)
		return
	}
	if !dtypes[body.Dtype] {
		http.Error(rw, \`{"error":"unsupported dtype"}\`, http.StatusBadRequest)
		return
	}
	if !computationRefs[body.ComputationRef] {
		http.Error(rw, \`{"error":"unknown computation_ref"}\`, http.StatusUnprocessableEntity)
		return
	}
	if body.FreshnessSlo == nil || *body.FreshnessSlo <= 0 {
		http.Error(rw, \`{"error":"freshness_slo is required"}\`, http.StatusBadRequest)
		return
	}
	record := map[string]any{
		"name":            body.Name,
		"version":         body.Version,
		"dtype":           body.Dtype,
		"computation_ref": body.ComputationRef,
		"freshness_slo":   *body.FreshnessSlo,
		"created_at":      time.Now().Unix(),
	}
	definitions[key] = record
	rw.WriteHeader(http.StatusCreated)
	_ = json.NewEncoder(rw).Encode(record)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/features/definitions", registerDefinition)
	_ = http.ListenAndServe(":8443", mux)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model.StatusCodes
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class Definition(
    name: String,
    version: Int,
    dtype: String,
    computation_ref: String,
    freshness: Option[Int])

object DefineApi {
  implicit val system: ActorSystem = ActorSystem("feature-store")
  implicit val definitionFormat: RootJsonFormat[Definition] = jsonFormat5(Definition)

  val definitions = scala.collection.mutable.Map.empty[String, Definition]

  val route: Route =
    path("v1" / "features" / "definitions") {
      post {
        entity(as[Definition]) { body =>
          // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
          definitions(s"\${body.name}:\${body.version}") = body
          complete(StatusCodes.OK, body)
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
import org.apache.pekko.http.scaladsl.model.StatusCodes
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class Definition(
    name: String,
    version: Int,
    dtype: String,
    computation_ref: String,
    freshness_slo: Option[Int])

object DefineApi {
  implicit val system: ActorSystem = ActorSystem("feature-store")
  implicit val definitionFormat: RootJsonFormat[Definition] = jsonFormat5(Definition)

  val Dtypes = Set("int64", "float64", "string", "bool")
  val ComputationRefs = Set("window_avg_7d", "last_value", "count_1h", "sum_24h")
  val definitions = scala.collection.mutable.Map.empty[String, Definition]

  val route: Route =
    path("v1" / "features" / "definitions") {
      post {
        entity(as[Definition]) { body =>
          val key = s"feature:\${body.name}:\${body.version}"
          if (definitions.contains(key)) complete(StatusCodes.Conflict, s"""{"error":"definition exists"}""")
          else if (!Dtypes.contains(body.dtype))
            complete(StatusCodes.BadRequest, s"""{"error":"unsupported dtype"}""")
          else if (!ComputationRefs.contains(body.computation_ref))
            complete(StatusCodes.UnprocessableEntity, s"""{"error":"unknown computation_ref"}""")
          else if (body.freshness_slo.forall(_ <= 0))
            complete(StatusCodes.BadRequest, s"""{"error":"freshness_slo is required"}""")
          else {
            val record = body.copy(freshness_slo = body.freshness_slo)
            definitions(key) = record
            complete(StatusCodes.Created, record)
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
#include <unordered_map>

using json = nlohmann::json;

std::unordered_map<std::string, json> definitions;

int main() {
  httplib::Server svr;

  svr.Post("/v1/features/definitions", [](const httplib::Request& req, httplib::Response& res) {
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) body = json::object();
    // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    definitions[body.value("name", std::string()) + ":" + std::to_string(body.value("version", 0))] = body;
    res.status = 200;
    res.set_content(body.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <chrono>
#include <set>
#include <string>
#include <unordered_map>

using json = nlohmann::json;

const std::set<std::string> kDtypes = {"int64", "float64", "string", "bool"};
const std::set<std::string> kComputationRefs = {"window_avg_7d", "last_value", "count_1h", "sum_24h"};
std::unordered_map<std::string, json> definitions;

int main() {
  httplib::Server svr;

  svr.Post("/v1/features/definitions", [](const httplib::Request& req, httplib::Response& res) {
    const json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) {
      res.status = 400;
      res.set_content(json{{"error", "invalid body"}}.dump(), "application/json");
      return;
    }
    const auto key = "feature:" + body.value("name", std::string()) + ":" + std::to_string(body.value("version", 0LL));
    if (definitions.count(key) > 0) {
      res.status = 409;
      res.set_content(json{{"error", "definition exists"}}.dump(), "application/json");
      return;
    }
    if (kDtypes.count(body.value("dtype", std::string())) == 0) {
      res.status = 400;
      res.set_content(json{{"error", "unsupported dtype"}}.dump(), "application/json");
      return;
    }
    if (kComputationRefs.count(body.value("computation_ref", std::string())) == 0) {
      res.status = 422;
      res.set_content(json{{"error", "unknown computation_ref"}}.dump(), "application/json");
      return;
    }
    if (!body.contains("freshness_slo") || body["freshness_slo"].is_null() ||
        body["freshness_slo"].get<long long>() <= 0) {
      res.status = 400;
      res.set_content(json{{"error", "freshness_slo is required"}}.dump(), "application/json");
      return;
    }
    json record = body;
    record["created_at"] = std::chrono::system_clock::to_time_t(std::chrono::system_clock::now());
    definitions[key] = record;
    res.status = 201;
    res.set_content(record.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  hints: [
    'Register the same name and version twice: the second call answers 200 and the stored definition quietly changes. A typo in computation_ref is accepted, and freshness comes back null.',
    'The handler writes to DEFINITIONS before checking anything: no lookup of the existing key, no registry of known computation refs, and the model declares an optional freshness instead of a required freshness_slo.',
    'Check the key first and answer 409; keep a COMPUTATION_REFS tuple and answer 422 on a miss; require a positive freshness_slo (400 otherwise); build the record explicitly and answer 201 with it.',
  ],
  debrief: `The fix validates everything before the single write because a registry is the shared contract between training and serving: an identifier that can be mutated in place is not a version, it is a rename that silently changes what a model was trained on. The 409 keeps every version addressable and immutable. Resolving \`computation_ref\` at registration moves the failure from a training job an hour later to the request that caused it. The freshness SLO is the one field that lets a consumer decide whether a value is usable; a \`null\` default turns a stale value into an unremarkable one. Production registries also record an owner per feature and a deprecation window, so a version can be retired without breaking the models still pinned to it.`,
};
