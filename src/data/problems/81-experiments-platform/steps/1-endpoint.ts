import type {Step} from '@/lib/types';

export const endpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/experiments: the approved design, frozen',
  concept: 'http',
  guides: ['request-boundaries', 'idempotent-requests'],
  file: 'api',
  focus: ['client', 'api', 'store'],
  task: `## Task

**Starting point.** The starter serves the design side of the platform on the experiment store
(\`expd.store\`, provided): \`POST /v1/experiments\` takes
\`{name, unit, variants: [{key, weight}], min_sample, salt}\` and answers 201 with the stored
experiment (version 1, \`running\`, the salt defaulting to the id), and \`PATCH /v1/experiments/{id}\`
writes its body through \`store.update\`. It serves the demo and hides three flaws.

**Failure mode the checks target.** An approved design runs as something else: weights of 60 and
50 are quietly rescaled to 55/45, a misspelt unit randomizes users instead of sessions, and a
\`PATCH\` moves the split or the salt of a running experiment, which re-buckets units already counted.

- The split runs exactly as sent: at least 2 variants, distinct non-empty keys, non-negative integer
  weights summing to exactly **100**; anything else is **400**.
- \`unit\` is one of \`UNITS\` (\`user\`, \`session\`, \`account\`); anything else is **400**.
- \`FROZEN_FIELDS\` are \`variants\`, \`unit\`, \`salt\` and \`min_sample\`: a \`PATCH\` naming one is
  **409** with \`{"error": …, "required": "new version"}\` and writes nothing; \`name\` stays editable.`,
  sequence: {
    participants: ['Operator', 'Experiment API', 'experiment store'],
    messages: [
      {
        from: 'Operator',
        to: 'Experiment API',
        label: 'POST /v1/experiments · variants, unit, min_sample',
        kind: 'sync',
      },
      {
        from: 'Experiment API',
        to: 'Experiment API',
        label: '≥ 2 variants · weights sum to 100 · unit ∈ UNITS → else 400',
        kind: 'sync',
      },
      {from: 'Experiment API', to: 'experiment store', label: 'create(design) → version 1, running', kind: 'sync'},
      {from: 'Experiment API', to: 'Operator', label: '201 {id, version, salt, variants, status}', kind: 'reply'},
      {from: 'Operator', to: 'Experiment API', label: 'PATCH /v1/experiments/{id} · {"variants": …}', kind: 'sync'},
      {from: 'Experiment API', to: 'Operator', label: '409 {required: "new version"} · nothing written', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Registers the create and edit routes',
      detail: 'Register `POST /v1/experiments` and `PATCH /v1/experiments/{id}`.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/experiments["']/, /@app\.patch\(\s*["']\/v1\/experiments\/\{/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/experiments['"]/, /app\.patch\(\s*['"]\/v1\/experiments\/:/]},
        go: {all: [/HandleFunc\(\s*"POST \/v1\/experiments"/, /"PATCH \/v1\/experiments\/\{id\}"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"experiments"\s*\)/, /\bpatch\s*\{/]},
        cpp: {all: [/svr\.Post\(\s*"\/v1\/experiments"/, /svr\.Patch\(/]},
      },
    },
    {
      id: 'split',
      title: 'Refuses a split that is not exactly the one sent',
      detail:
        'Fewer than 2 variants, repeated or empty keys, a negative weight or weights that do not sum to exactly 100 answer **400** before anything is stored; nothing divides the weights by their total.',
      match: {
        python: {all: [/!=\s*100\b/, /<\s*2\b/], none: [/\/\s*total\b/]},
        typescript: {all: [/!==?\s*100\b/, /<\s*2\b/], none: [/\/\s*total\b/]},
        go: {all: [/!=\s*100\b/, /<\s*2\b/], none: [/\/\s*float64\(total\)/]},
        scala: {all: [/!=\s*100\b/, /<\s*2\b/], none: [/\/\s*total\b/]},
        cpp: {all: [/!=\s*100\b/, /<\s*2\b/], none: [/\/\s*total\b/]},
      },
    },
    {
      id: 'unit',
      title: 'Refuses an assignment unit outside UNITS',
      detail: 'A `unit` that is not `user`, `session` or `account` answers **400**; nothing falls back to `user`.',
      match: {
        python: {all: [/not in UNITS/], none: [/else\s*["']user["']/]},
        typescript: {all: [/!UNITS\.includes\(/], none: [/:\s*['"]user['"]/]},
        go: {all: [/!units\[/], none: [/\.Unit\s*=\s*"user"/]},
        scala: {all: [/!Units\.contains\(/], none: [/else\s*"user"/]},
        cpp: {all: [/!kUnits\.count\(/], none: [/\.unit\s*=\s*"user"/]},
      },
    },
    {
      id: 'frozen-design',
      title: 'A design change is a new version: 409',
      detail:
        'A `PATCH` whose body names one of `FROZEN_FIELDS` (`variants`, `unit`, `salt`, `min_sample`) answers **409** with `"required": "new version"` and writes nothing; a `name` edit still goes through.',
      match: {
        python: {all: [/FROZEN_FIELDS/, /\b409\b/, /new version/]},
        typescript: {all: [/FROZEN_FIELDS/, /\b409\b/, /new version/]},
        go: {all: [/frozenFields/, /StatusConflict|\b409\b/, /new version/]},
        scala: {all: [/FrozenFields/, /Conflict|\b409\b/, /new version/]},
        cpp: {all: [/kFrozenFields/, /\b409\b/, /new version/]},
      },
    },
  ],
  code: {
    python: {
      starter: `from fastapi import FastAPI, HTTPException, Request
from pydantic import BaseModel

from expd import store  # create, get, update

app = FastAPI()

UNITS = ("user", "session", "account")


class Variant(BaseModel):
    key: str
    weight: int


class ExperimentCreate(BaseModel):
    name: str
    unit: str
    variants: list[Variant]
    min_sample: int = 1000
    salt: str | None = None


@app.post("/v1/experiments", status_code=201)
def create_experiment(body: ExperimentCreate) -> dict:
    # TODO: this starter has three flaws. The task says where to look; the checks say what must change.
    total = sum(v.weight for v in body.variants) or 1
    variants = [{"key": v.key, "weight": round(v.weight * 100 / total)} for v in body.variants]
    unit = body.unit if body.unit in UNITS else "user"
    return store.create({"name": body.name, "unit": unit, "variants": variants, "min_sample": body.min_sample, "salt": body.salt})


@app.patch("/v1/experiments/{experiment_id}")
async def edit_experiment(experiment_id: str, request: Request) -> dict:
    if store.get(experiment_id) is None:
        raise HTTPException(status_code=404, detail="no such experiment")
    return store.update(experiment_id, await request.json())
`,
      solution: `from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from expd import store  # create, get, update

app = FastAPI()

UNITS = ("user", "session", "account")
FROZEN_FIELDS = ("variants", "unit", "salt", "min_sample")


class Variant(BaseModel):
    key: str
    weight: int


class ExperimentCreate(BaseModel):
    name: str
    unit: str
    variants: list[Variant]
    min_sample: int = 1000
    salt: str | None = None


def split_problem(variants: list[Variant]) -> str | None:
    """Why the split cannot run exactly as sent, or None."""
    if len(variants) < 2:
        return "an experiment needs at least 2 variants"
    keys = [v.key for v in variants]
    if "" in keys or len(set(keys)) != len(keys):
        return "variant keys must be distinct and non-empty"
    if any(v.weight < 0 for v in variants):
        return "weights must not be negative"
    total = sum(v.weight for v in variants)
    if total != 100:
        return f"weights sum to {total}, not 100"
    return None


@app.post("/v1/experiments", status_code=201)
def create_experiment(body: ExperimentCreate) -> dict:
    # The design runs as approved or not at all: nothing is rescaled or defaulted.
    problem = split_problem(body.variants)
    if problem is not None:
        raise HTTPException(status_code=400, detail=problem)
    if body.unit not in UNITS:
        raise HTTPException(status_code=400, detail=f"unit must be one of {', '.join(UNITS)}")
    variants = [{"key": v.key, "weight": v.weight} for v in body.variants]
    return store.create({"name": body.name, "unit": body.unit, "variants": variants, "min_sample": body.min_sample, "salt": body.salt})


@app.patch("/v1/experiments/{experiment_id}")
async def edit_experiment(experiment_id: str, request: Request):
    if store.get(experiment_id) is None:
        raise HTTPException(status_code=404, detail="no such experiment")
    fields = await request.json()
    frozen = [name for name in FROZEN_FIELDS if name in fields]
    if frozen:
        return JSONResponse(status_code=409, content={"error": f"{frozen[0]} is frozen while the experiment exists", "required": "new version"})
    return store.update(experiment_id, {"name": fields["name"]} if "name" in fields else {})
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';

import {type Variant, create, get, update} from 'expd/store';

export const app = Fastify();

export const UNITS = ['user', 'session', 'account'];

interface ExperimentBody {
  name: string;
  unit: string;
  variants: Variant[];
  min_sample?: number;
  salt?: string | null;
}

app.post('/v1/experiments', async (request, reply) => {
  // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
  const body = request.body as ExperimentBody;
  const total = body.variants.reduce((sum, v) => sum + v.weight, 0) || 1;
  const variants = body.variants.map(v => ({key: v.key, weight: Math.round((v.weight * 100) / total)}));
  const unit = UNITS.includes(body.unit) ? body.unit : 'user';
  const experiment = await create({name: body.name, unit, variants, min_sample: body.min_sample ?? 1000, salt: body.salt});
  return reply.code(201).send(experiment);
});

app.patch('/v1/experiments/:id', async (request, reply) => {
  const {id} = request.params as {id: string};
  if ((await get(id)) === null) return reply.code(404).send({error: 'no such experiment'});
  return update(id, request.body as Record<string, unknown>);
});
`,
      solution: `import Fastify from 'fastify';

import {type Variant, create, get, update} from 'expd/store';

export const app = Fastify();

export const UNITS = ['user', 'session', 'account'];
export const FROZEN_FIELDS = ['variants', 'unit', 'salt', 'min_sample'];

interface ExperimentBody {
  name: string;
  unit: string;
  variants: Variant[];
  min_sample?: number;
  salt?: string | null;
}

/** Why the split cannot run exactly as sent, or null. */
function splitProblem(variants: Variant[]): string | null {
  if (!Array.isArray(variants) || variants.length < 2) return 'an experiment needs at least 2 variants';
  const keys = variants.map(v => v.key);
  if (keys.some(k => typeof k !== 'string' || k === '') || new Set(keys).size !== keys.length) return 'variant keys must be distinct and non-empty';
  if (variants.some(v => !Number.isInteger(v.weight) || v.weight < 0)) return 'weights must be non-negative integers';
  const sum = variants.reduce((acc, v) => acc + v.weight, 0);
  if (sum !== 100) return \`weights sum to \${sum}, not 100\`;
  return null;
}

app.post('/v1/experiments', async (request, reply) => {
  const body = request.body as ExperimentBody;
  // The design runs as approved or not at all: nothing is rescaled or defaulted.
  const problem = splitProblem(body.variants);
  if (problem !== null) return reply.code(400).send({error: problem});
  if (!UNITS.includes(body.unit)) return reply.code(400).send({error: \`unit must be one of \${UNITS.join(', ')}\`});
  const variants = body.variants.map(v => ({key: v.key, weight: v.weight}));
  const experiment = await create({name: body.name, unit: body.unit, variants, min_sample: body.min_sample ?? 1000, salt: body.salt});
  return reply.code(201).send(experiment);
});

app.patch('/v1/experiments/:id', async (request, reply) => {
  const {id} = request.params as {id: string};
  if ((await get(id)) === null) return reply.code(404).send({error: 'no such experiment'});
  const fields = request.body as Record<string, unknown>;
  const frozen = FROZEN_FIELDS.find(name => name in fields);
  if (frozen !== undefined) return reply.code(409).send({error: \`\${frozen} is frozen while the experiment exists\`, required: 'new version'});
  return update(id, 'name' in fields ? {name: fields.name} : {});
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"math"
	"net/http"

	"expd/store" // store.Create, Get, Update
)

var units = map[string]bool{"user": true, "session": true, "account": true}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func createExperiment(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has three flaws. The task says where to look; the checks say what must change.
	design := store.Design{MinSample: 1000}
	if err := json.NewDecoder(r.Body).Decode(&design); err != nil {
		http.Error(rw, "malformed design", http.StatusBadRequest)
		return
	}
	total := 0
	for _, v := range design.Variants {
		total += v.Weight
	}
	if total == 0 {
		total = 1
	}
	for i := range design.Variants {
		design.Variants[i].Weight = int(math.Round(float64(design.Variants[i].Weight) * 100 / float64(total)))
	}
	if !units[design.Unit] {
		design.Unit = "user"
	}
	writeJSON(rw, http.StatusCreated, store.Create(r.Context(), design))
}

func editExperiment(rw http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if store.Get(r.Context(), id) == nil {
		http.Error(rw, "no such experiment", http.StatusNotFound)
		return
	}
	fields := map[string]any{}
	json.NewDecoder(r.Body).Decode(&fields)
	experiment, err := store.Update(r.Context(), id, fields)
	if err != nil {
		http.Error(rw, err.Error(), http.StatusNotFound)
		return
	}
	writeJSON(rw, http.StatusOK, experiment)
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/experiments", createExperiment)
	mux.HandleFunc("PATCH /v1/experiments/{id}", editExperiment)
}
`,
      solution: `package main

import (
	"encoding/json"
	"fmt"
	"net/http"

	"expd/store" // store.Create, Get, Update
)

var units = map[string]bool{"user": true, "session": true, "account": true}

var frozenFields = []string{"variants", "unit", "salt", "min_sample"}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

// splitProblem says why the split cannot run exactly as sent, or "".
func splitProblem(variants []store.Variant) string {
	if len(variants) < 2 {
		return "an experiment needs at least 2 variants"
	}
	seen := map[string]bool{}
	sum := 0
	for _, v := range variants {
		if v.Key == "" || seen[v.Key] {
			return "variant keys must be distinct and non-empty"
		}
		seen[v.Key] = true
		if v.Weight < 0 {
			return "weights must not be negative"
		}
		sum += v.Weight
	}
	if sum != 100 {
		return fmt.Sprintf("weights sum to %d, not 100", sum)
	}
	return ""
}

func createExperiment(rw http.ResponseWriter, r *http.Request) {
	design := store.Design{MinSample: 1000}
	if err := json.NewDecoder(r.Body).Decode(&design); err != nil {
		http.Error(rw, "malformed design", http.StatusBadRequest)
		return
	}
	// The design runs as approved or not at all: nothing is rescaled or defaulted.
	if problem := splitProblem(design.Variants); problem != "" {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": problem})
		return
	}
	if !units[design.Unit] {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "unit must be one of user, session, account"})
		return
	}
	writeJSON(rw, http.StatusCreated, store.Create(r.Context(), design))
}

func editExperiment(rw http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if store.Get(r.Context(), id) == nil {
		http.Error(rw, "no such experiment", http.StatusNotFound)
		return
	}
	fields := map[string]any{}
	json.NewDecoder(r.Body).Decode(&fields)
	for _, name := range frozenFields {
		if _, ok := fields[name]; ok {
			writeJSON(rw, http.StatusConflict, map[string]string{"error": name + " is frozen while the experiment exists", "required": "new version"})
			return
		}
	}
	editable := map[string]any{}
	if name, ok := fields["name"]; ok {
		editable["name"] = name
	}
	experiment, err := store.Update(r.Context(), id, editable)
	if err != nil {
		http.Error(rw, err.Error(), http.StatusNotFound)
		return
	}
	writeJSON(rw, http.StatusOK, experiment)
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/experiments", createExperiment)
	mux.HandleFunc("PATCH /v1/experiments/{id}", editExperiment)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import expd.Store // Store.create, get, update

object Api {
  val Units: Seq[String] = Seq("user", "session", "account")

  private def json(status: StatusCode, body: JsValue): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  private def text(fields: Map[String, JsValue], name: String): Option[String] = fields.get(name).collect { case JsString(s) => s }
  private def number(fields: Map[String, JsValue], name: String): Option[Int] = fields.get(name).collect { case JsNumber(n) => n.toInt }

  /** The design a request body describes. */
  private def design(body: JsObject): Store.Design = {
    val variants = body.fields.get("variants").collect { case JsArray(items) =>
      items.map(item => Store.Variant(text(item.asJsObject.fields, "key").getOrElse(""), number(item.asJsObject.fields, "weight").getOrElse(0)))
    }
    Store.Design(text(body.fields, "name").getOrElse(""), text(body.fields, "unit").getOrElse(""), variants.getOrElse(Vector.empty),
      number(body.fields, "min_sample").getOrElse(1000), text(body.fields, "salt"))
  }

  val route: Route = concat(
    path("v1" / "experiments") {
      post {
        entity(as[String]) { raw =>
          // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
          val d = design(raw.parseJson.asJsObject)
          val total = math.max(d.variants.map(_.weight).sum, 1)
          val variants = d.variants.map(v => v.copy(weight = math.round(v.weight * 100.0 / total).toInt))
          val unit = if (Units.contains(d.unit)) d.unit else "user"
          complete(json(StatusCodes.Created, Store.toJson(Store.create(d.copy(unit = unit, variants = variants)))))
        }
      }
    },
    path("v1" / "experiments" / Segment) { id =>
      patch {
        entity(as[String]) { raw =>
          Store.get(id) match {
            case None => complete(StatusCodes.NotFound -> "no such experiment")
            case Some(_) => complete(json(StatusCodes.OK, Store.toJson(Store.update(id, raw.parseJson.asJsObject))))
          }
        }
      }
    },
  )
}
`,
      solution: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import expd.Store // Store.create, get, update

object Api {
  val Units: Seq[String] = Seq("user", "session", "account")
  val FrozenFields: Seq[String] = Seq("variants", "unit", "salt", "min_sample")

  private def json(status: StatusCode, body: JsValue): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  private def text(fields: Map[String, JsValue], name: String): Option[String] = fields.get(name).collect { case JsString(s) => s }
  private def number(fields: Map[String, JsValue], name: String): Option[Int] = fields.get(name).collect { case JsNumber(n) => n.toInt }

  /** The design a request body describes. */
  private def design(body: JsObject): Store.Design = {
    val variants = body.fields.get("variants").collect { case JsArray(items) =>
      items.map(item => Store.Variant(text(item.asJsObject.fields, "key").getOrElse(""), number(item.asJsObject.fields, "weight").getOrElse(0)))
    }
    Store.Design(text(body.fields, "name").getOrElse(""), text(body.fields, "unit").getOrElse(""), variants.getOrElse(Vector.empty),
      number(body.fields, "min_sample").getOrElse(1000), text(body.fields, "salt"))
  }

  /** Why the split cannot run exactly as sent. */
  private def splitProblem(variants: Seq[Store.Variant]): Option[String] = {
    val keys = variants.map(_.key)
    if (variants.size < 2) Some("an experiment needs at least 2 variants")
    else if (keys.contains("") || keys.distinct.size != keys.size) Some("variant keys must be distinct and non-empty")
    else if (variants.exists(_.weight < 0)) Some("weights must not be negative")
    else if (variants.map(_.weight).sum != 100) Some(s"weights sum to \${variants.map(_.weight).sum}, not 100")
    else None
  }

  private def error(message: String): JsObject = JsObject("error" -> JsString(message))

  val route: Route = concat(
    path("v1" / "experiments") {
      post {
        entity(as[String]) { raw =>
          val d = design(raw.parseJson.asJsObject)
          // The design runs as approved or not at all: nothing is rescaled or defaulted.
          splitProblem(d.variants) match {
            case Some(problem) => complete(json(StatusCodes.BadRequest, error(problem)))
            case None if !Units.contains(d.unit) => complete(json(StatusCodes.BadRequest, error("unit must be one of user, session, account")))
            case None => complete(json(StatusCodes.Created, Store.toJson(Store.create(d))))
          }
        }
      }
    },
    path("v1" / "experiments" / Segment) { id =>
      patch {
        entity(as[String]) { raw =>
          val fields = raw.parseJson.asJsObject
          Store.get(id) match {
            case None => complete(StatusCodes.NotFound -> "no such experiment")
            case Some(_) =>
              FrozenFields.find(fields.fields.contains) match {
                case Some(frozen) =>
                  complete(json(StatusCodes.Conflict, JsObject("error" -> JsString(s"$frozen is frozen while the experiment exists"), "required" -> JsString("new version"))))
                case None =>
                  complete(json(StatusCodes.OK, Store.toJson(Store.update(id, JsObject(fields.fields.filter(_._1 == "name"))))))
              }
          }
        }
      }
    },
  )
}
`,
    },
    cpp: {
      starter: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <cmath>
#include <set>
#include <string>

#include "expd/store.h"  // store::create, get, update, toJson

using json = nlohmann::json;

const std::set<std::string> kUnits = {"user", "session", "account"};

store::Design design_of(const json& body) {
  store::Design d;
  d.name = body.value("name", "");
  d.unit = body.value("unit", "");
  d.min_sample = body.value("min_sample", 1000L);
  if (body.contains("salt") && body["salt"].is_string()) d.salt = body["salt"];
  for (const auto& v : body.value("variants", json::array())) d.variants.push_back({v.value("key", ""), v.value("weight", 0L)});
  return d;
}

void create_experiment(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
  const json body = json::parse(req.body, nullptr, false);
  if (!body.is_object()) {
    res.status = 400;
    res.set_content("malformed design", "text/plain");
    return;
  }
  store::Design d = design_of(body);
  double total = 0;
  for (const auto& v : d.variants) total += v.weight;
  if (total == 0) total = 1;
  for (auto& v : d.variants) v.weight = std::lround(v.weight * 100.0 / total);
  if (!kUnits.count(d.unit)) d.unit = "user";
  res.status = 201;
  res.set_content(store::toJson(store::create(d)).dump(), "application/json");
}

void edit_experiment(const httplib::Request& req, httplib::Response& res) {
  const std::string id = req.matches[1];
  if (!store::get(id)) {
    res.status = 404;
    res.set_content("no such experiment", "text/plain");
    return;
  }
  res.set_content(store::toJson(store::update(id, json::parse(req.body))).dump(), "application/json");
}

void register_routes(httplib::Server& svr) {
  svr.Post("/v1/experiments", create_experiment);
  svr.Patch(R"(/v1/experiments/([\\w-]+))", edit_experiment);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <set>
#include <string>
#include <vector>

#include "expd/store.h"  // store::create, get, update, toJson

using json = nlohmann::json;

const std::set<std::string> kUnits = {"user", "session", "account"};
const std::vector<std::string> kFrozenFields = {"variants", "unit", "salt", "min_sample"};

store::Design design_of(const json& body) {
  store::Design d;
  d.name = body.value("name", "");
  d.unit = body.value("unit", "");
  d.min_sample = body.value("min_sample", 1000L);
  if (body.contains("salt") && body["salt"].is_string()) d.salt = body["salt"];
  for (const auto& v : body.value("variants", json::array())) d.variants.push_back({v.value("key", ""), v.value("weight", 0L)});
  return d;
}

// Why the split cannot run exactly as sent, or "".
std::string split_problem(const std::vector<store::Variant>& variants) {
  if (variants.size() < 2) return "an experiment needs at least 2 variants";
  std::set<std::string> keys;
  long sum = 0;
  for (const auto& v : variants) {
    if (v.key.empty() || !keys.insert(v.key).second) return "variant keys must be distinct and non-empty";
    if (v.weight < 0) return "weights must not be negative";
    sum += v.weight;
  }
  if (sum != 100) return "weights sum to " + std::to_string(sum) + ", not 100";
  return "";
}

void reply(httplib::Response& res, int status, const json& body) {
  res.status = status;
  res.set_content(body.dump(), "application/json");
}

void create_experiment(const httplib::Request& req, httplib::Response& res) {
  const json body = json::parse(req.body, nullptr, false);
  if (!body.is_object()) return reply(res, 400, {{"error", "malformed design"}});
  const store::Design d = design_of(body);
  // The design runs as approved or not at all: nothing is rescaled or defaulted.
  const std::string problem = split_problem(d.variants);
  if (!problem.empty()) return reply(res, 400, {{"error", problem}});
  if (!kUnits.count(d.unit)) return reply(res, 400, {{"error", "unit must be one of user, session, account"}});
  reply(res, 201, store::toJson(store::create(d)));
}

void edit_experiment(const httplib::Request& req, httplib::Response& res) {
  const std::string id = req.matches[1];
  if (!store::get(id)) return reply(res, 404, {{"error", "no such experiment"}});
  const json fields = json::parse(req.body, nullptr, false);
  if (!fields.is_object()) return reply(res, 400, {{"error", "malformed edit"}});
  for (const std::string& name : kFrozenFields) {
    if (fields.contains(name)) return reply(res, 409, {{"error", name + " is frozen while the experiment exists"}, {"required", "new version"}});
  }
  json editable = json::object();
  if (fields.contains("name")) editable["name"] = fields["name"];
  reply(res, 200, store::toJson(store::update(id, editable)));
}

void register_routes(httplib::Server& svr) {
  svr.Post("/v1/experiments", create_experiment);
  svr.Patch(R"(/v1/experiments/([\\w-]+))", edit_experiment);
}
`,
    },
  },
  harness: {
    python: `from expd import store

SPLIT = [{"key": "control", "weight": 50}, {"key": "treatment", "weight": 50}]


def _design(**overrides):
    return {"name": "checkout-cta", "unit": "user", "variants": SPLIT, "min_sample": 2000, **overrides}


def _api(ctx):
    return ctx.client(ctx.load("api").app)


async def _create(c, **overrides):
    r = await c.post("/v1/experiments", json=_design(**overrides))
    assert r.status_code == 201, f"POST /v1/experiments with a valid 50/50 design answered {r.status_code}: {r.text}"
    return r.json()["id"]


async def check_route(ctx):
    async with _api(ctx) as c:
        r = await c.post("/v1/experiments", json=_design(salt="s-1"))
        assert r.status_code == 201, f"POST /v1/experiments answered {r.status_code}: {r.text}"
        body = r.json()
        assert body.get("version") == 1 and body.get("status") == "running" and body.get("salt") == "s-1", f"a new experiment answers version 1, running, with its salt; got {body}"
        experiment_id = body["id"]
        stored = store.get(experiment_id)
        assert stored is not None and stored["variants"] == SPLIT, f"the store holds {stored}, expected the 50/50 split"
        r = await c.post("/v1/experiments", json=_design())
        assert r.status_code == 201 and r.json().get("salt") == r.json().get("id"), f"without a salt the experiment id is the salt; got {r.text}"
        r = await c.patch(f"/v1/experiments/{experiment_id}", json={"name": "checkout-cta-v1"})
    assert r.status_code == 200, f"PATCH /v1/experiments/{experiment_id} with a new name answered {r.status_code}: {r.text}"
    assert store.get(experiment_id)["name"] == "checkout-cta-v1", f"the rename did not reach the store: {store.get(experiment_id)}"


async def check_split(ctx):
    async with _api(ctx) as c:
        for variants, why in (
            ([{"key": "control", "weight": 60}, {"key": "treatment", "weight": 50}], "weights summing to 110"),
            ([{"key": "control", "weight": 49}, {"key": "treatment", "weight": 50}], "weights summing to 99"),
            ([{"key": "control", "weight": 100}], "a single variant"),
            ([{"key": "control", "weight": 50}, {"key": "control", "weight": 50}], "two variants keyed control"),
            ([{"key": "control", "weight": 120}, {"key": "treatment", "weight": -20}], "a negative weight"),
        ):
            r = await c.post("/v1/experiments", json=_design(variants=variants))
            assert r.status_code == 400, f"a design with {why} answered {r.status_code} {r.text}, expected 400: a split other than the one sent must not run"
        assert ctx.redis.get("exp:seq") is None, f"{ctx.redis.get('exp:seq')} experiment(s) were stored from rejected designs"
        three = [{"key": "control", "weight": 34}, {"key": "a", "weight": 33}, {"key": "b", "weight": 33}]
        r = await c.post("/v1/experiments", json=_design(variants=three))
    assert r.status_code == 201, f"a 34/33/33 design answered {r.status_code}: {r.text}"
    assert store.get(r.json()["id"])["variants"] == three, f"the split must be stored exactly as sent, the store holds {store.get(r.json()['id'])['variants']}"


async def check_unit(ctx):
    async with _api(ctx) as c:
        for unit in ("usr", "visitor"):
            r = await c.post("/v1/experiments", json=_design(unit=unit))
            assert r.status_code == 400, f"a design with unit {unit!r} answered {r.status_code} {r.text}, expected 400: an unknown unit must not fall back to user"
        assert ctx.redis.get("exp:seq") is None, "an experiment was stored from a design with an unknown unit"
        for unit in ("session", "account"):
            experiment_id = await _create(c, unit=unit)
            assert store.get(experiment_id)["unit"] == unit, f"a {unit} experiment was stored as {store.get(experiment_id)['unit']}"


async def check_frozen_design(ctx):
    async with _api(ctx) as c:
        experiment_id = await _create(c, salt="s-1")
        for fields in ({"variants": [{"key": "control", "weight": 90}, {"key": "treatment", "weight": 10}]}, {"salt": "s-2"}, {"unit": "session"}, {"min_sample": 50}):
            r = await c.patch(f"/v1/experiments/{experiment_id}", json=fields)
            assert r.status_code == 409, f"PATCH {fields} on a running experiment answered {r.status_code} {r.text}, expected 409: a design change is a new version"
            assert "new version" in r.text, f"the 409 must say a new version is required, got {r.text}"
        stored = store.get(experiment_id)
        assert stored["variants"] == SPLIT and stored["salt"] == "s-1" and stored["unit"] == "user" and stored["min_sample"] == 2000, f"a refused PATCH changed the design: {stored}"
        r = await c.patch(f"/v1/experiments/{experiment_id}", json={"name": "renamed"})
    assert r.status_code == 200 and store.get(experiment_id)["name"] == "renamed", f"a name-only PATCH answered {r.status_code} {r.text}; the name stays editable"
`,
    typescript: `const SPLIT = [
  {key: 'control', weight: 50},
  {key: 'treatment', weight: 50},
];

const design = (overrides: Record<string, unknown> = {}) => ({name: 'checkout-cta', unit: 'user', variants: SPLIT, min_sample: 2000, ...overrides});

function api(ctx) {
  return {c: ctx.client(ctx.load('api').app), store: ctx.load('/support/expd/store.ts')};
}

async function create(c, overrides: Record<string, unknown> = {}): Promise<string> {
  const r = await c.post('/v1/experiments', {json: design(overrides)});
  assert.equal(r.status, 201, \`POST /v1/experiments with a valid 50/50 design answered \${r.status}: \${r.text}\`);
  return r.json().id;
}

export async function check_route(ctx) {
  const {c, store} = api(ctx);
  let r = await c.post('/v1/experiments', {json: design({salt: 's-1'})});
  assert.equal(r.status, 201, \`POST /v1/experiments answered \${r.status}: \${r.text}\`);
  const body = r.json();
  assert(body.version === 1 && body.status === 'running' && body.salt === 's-1', \`a new experiment answers version 1, running, with its salt; got \${r.text}\`);
  const stored = await store.get(body.id);
  assert.deepStrictEqual(stored?.variants, SPLIT, \`the store holds \${JSON.stringify(stored)}, expected the 50/50 split\`);
  r = await c.post('/v1/experiments', {json: design()});
  assert(r.status === 201 && r.json().salt === r.json().id, \`without a salt the experiment id is the salt; got \${r.text}\`);
  r = await c.patch(\`/v1/experiments/\${body.id}\`, {json: {name: 'checkout-cta-v1'}});
  assert.equal(r.status, 200, \`PATCH /v1/experiments/\${body.id} with a new name answered \${r.status}: \${r.text}\`);
  assert.equal((await store.get(body.id)).name, 'checkout-cta-v1', 'the rename did not reach the store');
}

export async function check_split(ctx) {
  const {c, store} = api(ctx);
  const cases: [unknown[], string][] = [
    [[{key: 'control', weight: 60}, {key: 'treatment', weight: 50}], 'weights summing to 110'],
    [[{key: 'control', weight: 49}, {key: 'treatment', weight: 50}], 'weights summing to 99'],
    [[{key: 'control', weight: 100}], 'a single variant'],
    [[{key: 'control', weight: 50}, {key: 'control', weight: 50}], 'two variants keyed control'],
    [[{key: 'control', weight: 120}, {key: 'treatment', weight: -20}], 'a negative weight'],
  ];
  for (const [variants, why] of cases) {
    const r = await c.post('/v1/experiments', {json: design({variants})});
    assert.equal(r.status, 400, \`a design with \${why} answered \${r.status} \${r.text}, expected 400: a split other than the one sent must not run\`);
  }
  assert.equal(ctx.redis.get('exp:seq'), null, \`\${ctx.redis.get('exp:seq')} experiment(s) were stored from rejected designs\`);
  const three = [{key: 'control', weight: 34}, {key: 'a', weight: 33}, {key: 'b', weight: 33}];
  const r = await c.post('/v1/experiments', {json: design({variants: three})});
  assert.equal(r.status, 201, \`a 34/33/33 design answered \${r.status}: \${r.text}\`);
  assert.deepStrictEqual((await store.get(r.json().id)).variants, three, 'the split must be stored exactly as sent');
}

export async function check_unit(ctx) {
  const {c, store} = api(ctx);
  for (const unit of ['usr', 'visitor']) {
    const r = await c.post('/v1/experiments', {json: design({unit})});
    assert.equal(r.status, 400, \`a design with unit "\${unit}" answered \${r.status} \${r.text}, expected 400: an unknown unit must not fall back to user\`);
  }
  assert.equal(ctx.redis.get('exp:seq'), null, 'an experiment was stored from a design with an unknown unit');
  for (const unit of ['session', 'account']) {
    const id = await create(c, {unit});
    assert.equal((await store.get(id)).unit, unit, \`a \${unit} experiment was stored with another unit\`);
  }
}

export async function check_frozen_design(ctx) {
  const {c, store} = api(ctx);
  const id = await create(c, {salt: 's-1'});
  const edits = [{variants: [{key: 'control', weight: 90}, {key: 'treatment', weight: 10}]}, {salt: 's-2'}, {unit: 'session'}, {min_sample: 50}];
  for (const fields of edits) {
    const r = await c.patch(\`/v1/experiments/\${id}\`, {json: fields});
    assert.equal(r.status, 409, \`PATCH \${JSON.stringify(fields)} on a running experiment answered \${r.status} \${r.text}, expected 409: a design change is a new version\`);
    assert(r.text.includes('new version'), \`the 409 must say a new version is required, got \${r.text}\`);
  }
  const stored = await store.get(id);
  assert(
    JSON.stringify(stored.variants) === JSON.stringify(SPLIT) && stored.salt === 's-1' && stored.unit === 'user' && stored.min_sample === 2000,
    \`a refused PATCH changed the design: \${JSON.stringify(stored)}\`,
  );
  const r = await c.patch(\`/v1/experiments/\${id}\`, {json: {name: 'renamed'}});
  assert(r.status === 200 && (await store.get(id)).name === 'renamed', \`a name-only PATCH answered \${r.status} \${r.text}; the name stays editable\`);
}
`,
    go: `package main

import (
	"context"
	"net/http"
	"strings"

	"expd/store"

	"leetbuild/harness"
)

var split = []map[string]any{{"key": "control", "weight": 50}, {"key": "treatment", "weight": 50}}

func design(overrides map[string]any) map[string]any {
	d := map[string]any{"name": "checkout-cta", "unit": "user", "variants": split, "min_sample": 2000}
	for k, v := range overrides {
		d[k] = v
	}
	return d
}

func api(ctx *harness.Ctx) *harness.HTTP {
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

func created(ctx *harness.Ctx, r *harness.Response) store.Experiment {
	ctx.Equal(r.Status, 201, "POST /v1/experiments with a valid design (%s)", r.Text())
	var e store.Experiment
	r.Decode(&e)
	return e
}

func variantsOf(ctx *harness.Ctx, id string) []store.Variant {
	e := store.Get(context.Background(), id)
	ctx.Assert(e != nil, "experiment %s is not in the store", id)
	return e.Variants
}

var split5050 = []store.Variant{{Key: "control", Weight: 50}, {Key: "treatment", Weight: 50}}

func CheckRoute(ctx *harness.Ctx) {
	c := api(ctx)
	e := created(ctx, c.Post("/v1/experiments", design(map[string]any{"salt": "s-1"})))
	ctx.Assert(e.Version == 1 && e.Status == "running" && e.Salt == "s-1", "a new experiment answers version 1, running, with its salt; got %+v", e)
	ctx.Equal(variantsOf(ctx, e.ID), split5050, "the stored split")
	other := created(ctx, c.Post("/v1/experiments", design(nil)))
	ctx.Equal(other.Salt, other.ID, "without a salt the experiment id is the salt; the salt")
	r := c.Patch("/v1/experiments/"+e.ID, map[string]any{"name": "checkout-cta-v1"})
	ctx.Equal(r.Status, 200, "PATCH /v1/experiments/%s with a new name (%s)", e.ID, r.Text())
	ctx.Equal(store.Get(context.Background(), e.ID).Name, "checkout-cta-v1", "the rename must reach the store; the name")
}

func CheckSplit(ctx *harness.Ctx) {
	c := api(ctx)
	cases := []struct {
		variants []map[string]any
		why      string
	}{
		{[]map[string]any{{"key": "control", "weight": 60}, {"key": "treatment", "weight": 50}}, "weights summing to 110"},
		{[]map[string]any{{"key": "control", "weight": 49}, {"key": "treatment", "weight": 50}}, "weights summing to 99"},
		{[]map[string]any{{"key": "control", "weight": 100}}, "a single variant"},
		{[]map[string]any{{"key": "control", "weight": 50}, {"key": "control", "weight": 50}}, "two variants keyed control"},
		{[]map[string]any{{"key": "control", "weight": 120}, {"key": "treatment", "weight": -20}}, "a negative weight"},
	}
	for _, tc := range cases {
		r := c.Post("/v1/experiments", design(map[string]any{"variants": tc.variants}))
		ctx.Assert(r.Status == 400, "a design with %s answered %d %s, expected 400: a split other than the one sent must not run", tc.why, r.Status, r.Text())
	}
	seq, ok := ctx.Redis.Get("exp:seq")
	ctx.Assert(!ok, "%s experiment(s) were stored from rejected designs", seq)
	three := []map[string]any{{"key": "control", "weight": 34}, {"key": "a", "weight": 33}, {"key": "b", "weight": 33}}
	e := created(ctx, c.Post("/v1/experiments", design(map[string]any{"variants": three})))
	ctx.Equal(variantsOf(ctx, e.ID), []store.Variant{{Key: "control", Weight: 34}, {Key: "a", Weight: 33}, {Key: "b", Weight: 33}}, "the split must be stored exactly as sent; the stored split")
}

func CheckUnit(ctx *harness.Ctx) {
	c := api(ctx)
	for _, unit := range []string{"usr", "visitor"} {
		r := c.Post("/v1/experiments", design(map[string]any{"unit": unit}))
		ctx.Assert(r.Status == 400, "a design with unit %q answered %d %s, expected 400: an unknown unit must not fall back to user", unit, r.Status, r.Text())
	}
	_, ok := ctx.Redis.Get("exp:seq")
	ctx.Assert(!ok, "an experiment was stored from a design with an unknown unit")
	for _, unit := range []string{"session", "account"} {
		e := created(ctx, c.Post("/v1/experiments", design(map[string]any{"unit": unit})))
		ctx.Equal(store.Get(context.Background(), e.ID).Unit, unit, "the stored unit of a %s experiment", unit)
	}
}

func CheckFrozenDesign(ctx *harness.Ctx) {
	c := api(ctx)
	e := created(ctx, c.Post("/v1/experiments", design(map[string]any{"salt": "s-1"})))
	edits := []map[string]any{
		{"variants": []map[string]any{{"key": "control", "weight": 90}, {"key": "treatment", "weight": 10}}},
		{"salt": "s-2"}, {"unit": "session"}, {"min_sample": 50},
	}
	for _, fields := range edits {
		r := c.Patch("/v1/experiments/"+e.ID, fields)
		ctx.Assert(r.Status == 409, "PATCH %v on a running experiment answered %d %s, expected 409: a design change is a new version", fields, r.Status, r.Text())
		ctx.Assert(strings.Contains(r.Text(), "new version"), "the 409 must say a new version is required, got %s", r.Text())
	}
	stored := store.Get(context.Background(), e.ID)
	ctx.Assert(stored.Salt == "s-1" && stored.Unit == "user" && stored.MinSample == 2000, "a refused PATCH changed the design: %+v", stored)
	ctx.Equal(stored.Variants, split5050, "a refused PATCH must leave the split; the stored split")
	r := c.Patch("/v1/experiments/"+e.ID, map[string]any{"name": "renamed"})
	ctx.Assert(r.Status == 200 && store.Get(context.Background(), e.ID).Name == "renamed", "a name-only PATCH answered %d %s; the name stays editable", r.Status, r.Text())
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <string>
#include <vector>

#include "expd/store.h"

namespace {

using json = nlohmann::json;

const json kSplit = json::array({{{"key", "control"}, {"weight", 50}}, {{"key", "treatment"}, {"weight", 50}}});

std::string design(const json& overrides = json::object()) {
  json d = {{"name", "checkout-cta"}, {"unit", "user"}, {"variants", kSplit}, {"min_sample", 2000}};
  d.update(overrides);
  return d.dump();
}

harness::HTTP api(harness::Ctx& ctx) {
  static httplib::Server* svr = nullptr;
  delete svr;
  svr = new httplib::Server;
  register_routes(*svr);
  return ctx.HTTP(*svr);
}

harness::Response post(harness::HTTP& c, const std::string& body) { return c.Post("/v1/experiments", body, "Content-Type", "application/json"); }

harness::Response patch(harness::HTTP& c, const std::string& id, const json& fields) {
  return c.Patch("/v1/experiments/" + id, fields.dump(), "Content-Type", "application/json");
}

json created(harness::Ctx& ctx, const harness::Response& r) {
  ctx.Equal(r.Status, 201, "POST /v1/experiments with a valid design (%s)", r.Text());
  return json::parse(r.Text());
}

json storedSplit(const std::string& id) { return store::toJson(*store::get(id))["variants"]; }

}  // namespace

void CheckRoute(harness::Ctx& ctx) {
  auto c = api(ctx);
  const json e = created(ctx, post(c, design({{"salt", "s-1"}})));
  ctx.Assert(e.value("version", 0) == 1 && e.value("status", "") == "running" && e.value("salt", "") == "s-1", "a new experiment answers version 1, running, with its salt; got %s", e.dump());
  const std::string id = e.value("id", "");
  ctx.Equal(storedSplit(id), kSplit, "the stored split");
  const json other = created(ctx, post(c, design()));
  ctx.Equal(other.value("salt", ""), other.value("id", ""), "without a salt the experiment id is the salt; the salt");
  const auto r = patch(c, id, {{"name", "checkout-cta-v1"}});
  ctx.Equal(r.Status, 200, "PATCH /v1/experiments/%s with a new name (%s)", id, r.Text());
  ctx.Equal(store::get(id)->name, "checkout-cta-v1", "the rename must reach the store; the name");
}

void CheckSplit(harness::Ctx& ctx) {
  auto c = api(ctx);
  const std::vector<std::pair<json, std::string>> cases = {
      {json::array({{{"key", "control"}, {"weight", 60}}, {{"key", "treatment"}, {"weight", 50}}}), "weights summing to 110"},
      {json::array({{{"key", "control"}, {"weight", 49}}, {{"key", "treatment"}, {"weight", 50}}}), "weights summing to 99"},
      {json::array({{{"key", "control"}, {"weight", 100}}}), "a single variant"},
      {json::array({{{"key", "control"}, {"weight", 50}}, {{"key", "control"}, {"weight", 50}}}), "two variants keyed control"},
      {json::array({{{"key", "control"}, {"weight", 120}}, {{"key", "treatment"}, {"weight", -20}}}), "a negative weight"},
  };
  for (const auto& [variants, why] : cases) {
    const auto r = post(c, design({{"variants", variants}}));
    ctx.Assert(r.Status == 400, "a design with %s answered %d %s, expected 400: a split other than the one sent must not run", why, r.Status, r.Text());
  }
  ctx.Assert(!ctx.Redis.Get("exp:seq"), "%s experiment(s) were stored from rejected designs", ctx.Redis.Get("exp:seq").value_or(""));
  const json three = json::array({{{"key", "control"}, {"weight", 34}}, {{"key", "a"}, {"weight", 33}}, {{"key", "b"}, {"weight", 33}}});
  const json e = created(ctx, post(c, design({{"variants", three}})));
  ctx.Equal(storedSplit(e.value("id", "")), three, "the split must be stored exactly as sent; the stored split");
}

void CheckUnit(harness::Ctx& ctx) {
  auto c = api(ctx);
  for (const std::string unit : {"usr", "visitor"}) {
    const auto r = post(c, design({{"unit", unit}}));
    ctx.Assert(r.Status == 400, "a design with unit %q answered %d %s, expected 400: an unknown unit must not fall back to user", unit, r.Status, r.Text());
  }
  ctx.Assert(!ctx.Redis.Get("exp:seq"), "an experiment was stored from a design with an unknown unit");
  for (const std::string unit : {"session", "account"}) {
    const json e = created(ctx, post(c, design({{"unit", unit}})));
    ctx.Equal(store::get(e.value("id", ""))->unit, unit, "the stored unit of a %s experiment", unit);
  }
}

void CheckFrozenDesign(harness::Ctx& ctx) {
  auto c = api(ctx);
  const std::string id = created(ctx, post(c, design({{"salt", "s-1"}}))).value("id", "");
  const std::vector<json> edits = {
      {{"variants", json::array({{{"key", "control"}, {"weight", 90}}, {{"key", "treatment"}, {"weight", 10}}})}},
      {{"salt", "s-2"}},
      {{"unit", "session"}},
      {{"min_sample", 50}},
  };
  for (const json& fields : edits) {
    const auto r = patch(c, id, fields);
    ctx.Assert(r.Status == 409, "PATCH %s on a running experiment answered %d %s, expected 409: a design change is a new version", fields.dump(), r.Status, r.Text());
    ctx.Assert(r.Text().find("new version") != std::string::npos, "the 409 must say a new version is required, got %s", r.Text());
  }
  const auto stored = store::get(id);
  ctx.Assert(stored->salt == "s-1" && stored->unit == "user" && stored->min_sample == 2000, "a refused PATCH changed the design: %s", store::toJson(*stored).dump());
  ctx.Equal(storedSplit(id), kSplit, "a refused PATCH must leave the split; the stored split");
  const auto r = patch(c, id, {{"name", "renamed"}});
  ctx.Assert(r.Status == 200 && store::get(id)->name == "renamed", "a name-only PATCH answered %d %s; the name stays editable", r.Status, r.Text());
}
`,
  },
  hints: [
    'Create an experiment with weights 60 and 50: it answers 201 and runs 55/45. Patch the split of a running experiment: it answers 200, and units start landing in other variants.',
    'The create handler rescales the weights by their total and falls back to `user` for a unit it does not know, so no design is ever refused; the edit handler hands the whole body to `store.update`, which writes any field in place.',
    'Before `store.create`, answer 400 for fewer than 2 variants, repeated or empty keys, a negative weight or a sum other than 100, and for a `unit` outside `UNITS`. In the edit, answer 409 when the body names any of `FROZEN_FIELDS`; otherwise update `name` only.',
  ],
  debrief: `Validation refuses instead of repairing because the design is what the analysis is judged against: a split rescaled on the way in is a different experiment from the one approved, and the sample-ratio check in step 5 would measure against an expectation nobody signed off. Freezing the design fields follows from how assignment works. A unit's variant is a function of the salt and the split, so changing either mid-flight moves units that were already exposed and mixes two experiments into one result; a new version keeps each result attached to one design. Production platforms store each version as its own row with its own exposure stream, keep an audit trail of who started and stopped what, and let a ramp change the traffic allocation without touching the split.`,
};
