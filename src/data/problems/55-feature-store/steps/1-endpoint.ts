import type {Step} from '@/lib/types';

export const endpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/features/definitions: one definition, both paths',
  concept: 'http',
  file: 'api',
  focus: ['client', 'api', 'db'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it parses the body, stores the
definition and returns it. It compiles, it serves the demo, and it hides three production flaws.
Review it like the platform owner, fix it, and prove the fix with the checks below.

Implement \`POST /v1/features/definitions\` with body
\`{"name": "amount_7d", "version": 2, "dtype": "float64", "computation_ref": "window_avg_7d", "freshness_slo": 300}\`.

- A definition is keyed by **(name, version)**. Registering an existing pair is **409**, and the
  stored definition is returned untouched. The draft writes over the record, so a second registration
  silently changes the code both training and serving resolve to.
- \`dtype\` is one of \`int64\`, \`float64\`, \`string\`, \`bool\` (**400** otherwise).
- \`computation_ref\` is a pointer into the platform's compute registry, not free text: it is resolved
  at registration time and a reference that names nothing is **422**. The draft accepts any string, so
  the failure surfaces later, in a training job that has already read half a warehouse.
- \`freshness_slo\` is the number of seconds within which a value must be recomputed. It is **required**
  and must be positive (**400** when missing or \`null\`). The draft defaults it to \`null\`, and nothing
  downstream can alert on a definition that never declared how stale is too stale.
- The response is the definition **as stored** — name, version, dtype, computation_ref, freshness_slo
  and the creation time — returned with **201**, not a restatement of the request body, so both
  training and serving read the same record.

**Failure mode the checks target.** A definition that can be mutated in place is a definition training
and serving can disagree about; a dangling \`computation_ref\` and a \`null\` freshness SLO are failures
that only surface much later, when a model has already been trained on them.

## What to keep

The route, the request model and the store are fine. The fix is the key, the resolution step and the
explicit SLO: validate everything before the write, and never overwrite a stored version.`,
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
        'The store key is built from both `name` and `version`, an existing pair answers **409**, and the stored record is never overwritten. The draft keys by name only and mutates the definition in place.',
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
        '`computation_ref` is looked up in the compute registry and a reference that does not resolve is **422**. The draft stores any string and lets the training job discover the typo.',
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
        'A missing, `null` or non-positive `freshness_slo` is **400**, and the stored definition carries the explicit value. The draft defaults it to `null`, so no consumer can alert on staleness.',
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
        'The handler writes the validated definition under the (name, version) key and answers **201** with that stored record. The draft answers 200 with a restatement of the request.',
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
    # TODO: reject a re-registration of the same (name, version) with 409 instead of overwriting the
    # stored record, resolve computation_ref against the compute registry with 422 when it is
    # dangling, and require an explicit freshness SLO instead of storing freshness=None.
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
      starter: `/** POST /v1/features/definitions: a model-generated draft that overwrites whatever it is given. */
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
  // TODO: reject a re-registration of the same (name, version) with 409 instead of overwriting the
  // stored record, resolve computation_ref against the compute registry with 422 when it is
  // dangling, and require an explicit freshness SLO instead of storing whatever the caller sent.
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
	// TODO: reject a re-registration of the same (name, version) with 409 instead of overwriting the
	// stored record, resolve computation_ref against the compute registry with 422 when it is
	// dangling, and require an explicit freshness SLO instead of storing whatever the caller sent.
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
          // TODO: reject a re-registration of the same (name, version) with 409 instead of
          // overwriting the stored record, resolve computation_ref against the compute registry
          // with 422 when it is dangling, and require an explicit freshness SLO.
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
    // TODO: reject a re-registration of the same (name, version) with 409 instead of overwriting the
    // stored record, resolve computation_ref against the compute registry with 422 when it is
    // dangling, and require an explicit freshness SLO.
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
    'Uniqueness is per (name, version): build the store key from both fields and look it up before you write. A map keyed by name alone is what lets a second registration quietly move the definition both training and serving resolve to, and returning 409 without touching the stored record is the whole point.',
    'A computation reference is a pointer into the platform registry, not free text. Resolve it before storing and answer 422 when it names nothing — failing at registration is cheap; failing after a training job has scanned a warehouse is not.',
    '`freshness_slo` is the contract that makes staleness alertable: an old client may omit it, but it can never be stored as `null`. Validate it, store an explicit value, and answer 201 with the record you actually stored rather than a restatement of the request.',
  ],
  debrief: `The interview question behind this step is what a feature registry is actually for. A definition is the shared contract between training and serving, so an identifier that can be mutated in place is not a version — it is a rename that silently changes what a model was trained on. The 409 keeps every version of a feature addressable and immutable. The dangling \`computation_ref\` is the second failure: a pointer resolved at registration time cannot break a training run that started an hour later. The third is the freshness SLO, the only field that lets a consumer decide whether a value is usable; a \`null\` default turns a stale value into an unremarkable one, and the alert that should have fired never has a threshold to fire on. Real registries add ownership, deprecation windows, a schema history and a diff of the compute function between versions.`,
};
