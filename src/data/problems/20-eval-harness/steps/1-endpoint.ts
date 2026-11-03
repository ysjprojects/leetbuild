import type {Step} from '@/lib/types';

export const endpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/evals/runs: a run with a tenant, a golden set and a key',
  concept: 'http',
  file: 'api',
  focus: ['client', 'api', 'redis'],
  task: `## Task

**Starting point.** The starter serves \`POST /v1/evals/runs\` with body \`{"dataset_id", "model_version",
"sample_budget"}\`: it answers 400 for an empty \`model_version\`, takes the tenant from \`X-Tenant-Id\`
(or \`"default"\`), builds a run with a fresh id, stores it through the provided run store under
\`(tenant, run_id)\` and answers 202. It serves the demo and hides 4 flaws.

**Failure mode the checks target.** A typo in the dataset id starts a run that measures nothing; a
defaulted or unbounded budget queues judge calls nobody chose; a request without a tenant lands in a
bucket every team shares; and the retry every CI client makes starts a second run, so the release gate
later reads two half-filled records for one model version.

Requirements:

- A missing \`X-Tenant-Id\` is **401**.
- \`Idempotency-Key\` is required (**400**). The run is stored under \`(tenant, key)\` with \`store.put\`; a
  replay answers **200** with the stored run (\`store.get\`) instead of starting another.
- \`sample_budget\` is required, an integer from 1 to 5000 (\`MAX_SAMPLES\`); otherwise **400**.
- \`dataset_id\` must be a golden set in the provided registry (\`datasets.exists\`); otherwise **404**.
- Every rejection happens before \`store.put\`. A new run answers **202** with \`{run_id, status:
  "queued", dataset_id, model_version, sample_budget}\`.`,
  sequence: {
    participants: ['Client', 'evald', 'dataset registry', 'run store'],
    messages: [
      {from: 'Client', to: 'evald', label: 'POST /v1/evals/runs · X-Tenant-Id · Idempotency-Key', kind: 'sync'},
      {from: 'evald', to: 'evald', label: 'tenant · key · model_version · budget 1..5000', kind: 'sync'},
      {from: 'evald', to: 'dataset registry', label: 'exists(dataset_id)', kind: 'sync'},
      {from: 'dataset registry', to: 'evald', label: 'true / unknown → 404', kind: 'reply'},
      {from: 'evald', to: 'run store', label: 'get(tenant, key)', kind: 'sync'},
      {from: 'run store', to: 'evald', label: 'stored run → 200 / none', kind: 'reply'},
      {from: 'evald', to: 'run store', label: 'put(tenant, key, run)', kind: 'sync'},
      {from: 'evald', to: 'Client', label: '202 {run_id, status, dataset_id, …}', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Handles POST /v1/evals/runs',
      detail:
        'A valid start answers 202 with the run (run_id, status queued, dataset_id, model_version, sample_budget), and the run store holds it with its tenant.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/evals\/runs["']/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/evals\/runs['"]/]},
        go: {all: [/HandleFunc\(\s*"POST \/v1\/evals\/runs"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"evals"\s*\/\s*"runs"\s*\)/, /\bpost\s*\{/]},
        cpp: {all: [/svr\.Post\(\s*"\/v1\/evals\/runs"/]},
      },
    },
    {
      id: 'dataset-404',
      title: 'Answers 404 for a golden set the registry does not know',
      detail:
        'The dataset id is looked up with datasets.exists and an unknown one answers 404 with no run stored. The starter stores a run for any dataset id, a typo included.',
      match: {
        python: {all: [/datasets\.exists\(/, /(status_code\s*=\s*|HTTPException\(\s*)404/]},
        typescript: {all: [/datasets\.exists\(/, /\.(code|status)\(\s*404\s*\)/]},
        go: {all: [/datasets\.Exists\(/, /StatusNotFound|\b404\b/]},
        scala: {all: [/Datasets\.exists\(/, /StatusCodes\.NotFound/]},
        cpp: {all: [/datasets::exists\(/, /\b404\b/]},
      },
    },
    {
      id: 'budget-cap',
      title: 'Requires a sample budget of 1..5000',
      detail:
        'A missing budget, 0, a negative one or one above MAX_SAMPLES answers 400 and stores nothing; 1 and 5000 are accepted. The starter defaults a missing budget to 500 and accepts any number.',
      match: {
        python: {
          all: [/MAX_SAMPLES/, /(status_code\s*=\s*|HTTPException\(\s*)400/],
          none: [/sample_budget\s*:\s*int\s*=\s*\d/],
        },
        typescript: {all: [/MAX_SAMPLES/, /\.(code|status)\(\s*400\s*\)/], none: [/\?\?\s*500/]},
        go: {all: [/maxSamples/, /StatusBadRequest|\b400\b/], none: [/SampleBudget\s*=\s*500/]},
        scala: {all: [/MaxSamples/, /StatusCodes\.BadRequest/], none: [/getOrElse\(\s*500\s*\)/]},
        cpp: {all: [/kMaxSamples/, /\b400\b/], none: [/"sample_budget"\s*,\s*500/]},
      },
    },
    {
      id: 'idempotency-key',
      title: 'Keys runs by (tenant, Idempotency-Key)',
      detail:
        'Idempotency-Key is required (400 without it); a replay of the same (tenant, key) answers 200 with the same run_id and stores nothing new; another tenant with the same key gets its own run. The starter stores each run under its own fresh id.',
      match: {
        python: {all: [/Idempotency-Key/, /store\.get\(\s*tenant\s*,/, /store\.put\(\s*tenant\s*,\s*idem/]},
        typescript: {all: [/idempotency-key/i, /store\.get\(\s*tenant\s*,/, /store\.put\(\s*tenant\s*,\s*idem/]},
        go: {all: [/Idempotency-Key/, /runs\.Get\(/, /runs\.Put\(\s*[\w.()]+,\s*tenant\s*,\s*idem/]},
        scala: {all: [/Idempotency-Key/, /Runs\.get\(\s*tenant\s*,/, /Runs\.put\(\s*tenant\s*,\s*idem/]},
        cpp: {all: [/Idempotency-Key/, /runs::get\(\s*tenant\s*,/, /runs::put\(\s*tenant\s*,\s*idem/]},
      },
    },
    {
      id: 'tenant-required',
      title: 'Answers 401 without a tenant',
      detail:
        'A start without X-Tenant-Id, or with an empty one, answers 401 and leaves nothing in Redis; with a tenant the stored row carries it. The starter files such runs under the tenant "default".',
      match: {
        python: {all: [/(status_code\s*=\s*|HTTPException\(\s*)401/], none: [/["']default["']/]},
        typescript: {all: [/\.(code|status)\(\s*401\s*\)/], none: [/['"]default['"]/]},
        go: {all: [/StatusUnauthorized|\b401\b/], none: [/"default"/]},
        scala: {all: [/StatusCodes\.Unauthorized/], none: [/"default"/]},
        cpp: {all: [/\b401\b/], none: [/"default"/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import logging
import uuid

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from evals.runs import store

app = FastAPI()
logger = logging.getLogger("evald")


class RunRequest(BaseModel):
    dataset_id: str
    model_version: str
    sample_budget: int = 500


@app.post("/v1/evals/runs")
def start_run(body: RunRequest, request: Request) -> JSONResponse:
    # TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
    tenant = request.headers.get("X-Tenant-Id") or "default"
    if body.model_version == "":
        raise HTTPException(status_code=400, detail="model_version is required")
    run = {
        "run_id": str(uuid.uuid4()),
        "status": "queued",
        "dataset_id": body.dataset_id,
        "model_version": body.model_version,
        "sample_budget": body.sample_budget,
    }
    store.put(tenant, run["run_id"], run)
    logger.info("eval run=%s tenant=%s dataset=%s budget=%d", run["run_id"], tenant, body.dataset_id, body.sample_budget)
    return JSONResponse(run, status_code=202)
`,
      solution: `import logging
import uuid

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from evals.datasets import datasets
from evals.runs import store

app = FastAPI()
logger = logging.getLogger("evald")

MAX_SAMPLES = 5000


class RunRequest(BaseModel):
    dataset_id: str
    model_version: str
    sample_budget: int | None = None


@app.post("/v1/evals/runs")
def start_run(body: RunRequest, request: Request) -> JSONResponse:
    tenant = request.headers.get("X-Tenant-Id", "")
    if tenant == "":
        raise HTTPException(status_code=401, detail="missing X-Tenant-Id")
    idem_key = request.headers.get("Idempotency-Key", "")
    if idem_key == "":
        raise HTTPException(status_code=400, detail="Idempotency-Key is required")
    if body.model_version == "":
        raise HTTPException(status_code=400, detail="model_version is required")
    if body.sample_budget is None or not 1 <= body.sample_budget <= MAX_SAMPLES:
        raise HTTPException(status_code=400, detail=f"sample_budget must be 1..{MAX_SAMPLES}")
    if not datasets.exists(body.dataset_id):
        raise HTTPException(status_code=404, detail="unknown dataset")

    stored = store.get(tenant, idem_key)
    if stored is not None:
        return JSONResponse(stored, status_code=200)

    run = {
        "run_id": str(uuid.uuid4()),
        "status": "queued",
        "dataset_id": body.dataset_id,
        "model_version": body.model_version,
        "sample_budget": body.sample_budget,
    }
    store.put(tenant, idem_key, run)
    logger.info("eval run=%s tenant=%s dataset=%s budget=%d", run["run_id"], tenant, body.dataset_id, body.sample_budget)
    return JSONResponse(run, status_code=202)
`,
    },
    typescript: {
      starter: `import {randomUUID} from 'node:crypto';

import Fastify from 'fastify';

import {type Run, store} from 'evals/runs';

export const app = Fastify();

interface RunBody {
  dataset_id: string;
  model_version: string;
  sample_budget?: number;
}

app.post('/v1/evals/runs', async (request, reply) => {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  const header = request.headers['x-tenant-id'];
  const tenant = typeof header === 'string' && header !== '' ? header : 'default';
  const body = request.body as RunBody;
  if (typeof body.model_version !== 'string' || body.model_version === '')
    return reply.code(400).send({error: 'model_version is required'});
  const run: Run = {
    run_id: randomUUID(),
    status: 'queued',
    dataset_id: body.dataset_id,
    model_version: body.model_version,
    sample_budget: body.sample_budget ?? 500,
  };
  await store.put(tenant, run.run_id, run);
  request.log.info({tenant, run_id: run.run_id, dataset_id: run.dataset_id}, 'eval run queued');
  return reply.code(202).send(run);
});
`,
      solution: `import {randomUUID} from 'node:crypto';

import Fastify from 'fastify';

import {datasets} from 'evals/datasets';
import {type Run, store} from 'evals/runs';

export const app = Fastify();

export const MAX_SAMPLES = 5000;

interface RunBody {
  dataset_id: string;
  model_version: string;
  sample_budget?: number;
}

app.post('/v1/evals/runs', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing X-Tenant-Id'});
  const idemKey = request.headers['idempotency-key'];
  if (typeof idemKey !== 'string' || idemKey === '') return reply.code(400).send({error: 'Idempotency-Key is required'});
  const body = (request.body ?? {}) as Partial<RunBody>;
  if (typeof body.model_version !== 'string' || body.model_version === '')
    return reply.code(400).send({error: 'model_version is required'});
  const budget = body.sample_budget;
  if (typeof budget !== 'number' || !Number.isInteger(budget) || budget < 1 || budget > MAX_SAMPLES)
    return reply.code(400).send({error: \`sample_budget must be 1..\${MAX_SAMPLES}\`});
  if (typeof body.dataset_id !== 'string' || !datasets.exists(body.dataset_id))
    return reply.code(404).send({error: 'unknown dataset'});

  const stored = await store.get(tenant, idemKey);
  if (stored !== null) return reply.code(200).send(stored);

  const run: Run = {
    run_id: randomUUID(),
    status: 'queued',
    dataset_id: body.dataset_id,
    model_version: body.model_version,
    sample_budget: budget,
  };
  await store.put(tenant, idemKey, run);
  request.log.info({tenant, run_id: run.run_id, dataset_id: run.dataset_id}, 'eval run queued');
  return reply.code(202).send(run);
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"log"
	"net/http"

	"github.com/google/uuid"

	"evals/runs" // runs.Run, runs.Get(ctx, tenant, idemKey), runs.Put(ctx, tenant, idemKey, run) — provided
)

type RunRequest struct {
	DatasetID    string \`json:"dataset_id"\`
	ModelVersion string \`json:"model_version"\`
	SampleBudget int    \`json:"sample_budget"\`
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func startRun(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		tenant = "default"
	}
	var body RunRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	if body.ModelVersion == "" {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "model_version is required"})
		return
	}
	if body.SampleBudget == 0 {
		body.SampleBudget = 500
	}
	run := runs.Run{
		RunID:        uuid.NewString(),
		Status:       "queued",
		DatasetID:    body.DatasetID,
		ModelVersion: body.ModelVersion,
		SampleBudget: body.SampleBudget,
	}
	if err := runs.Put(r.Context(), tenant, run.RunID, run); err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	log.Printf("eval run=%s tenant=%s dataset=%s budget=%d", run.RunID, tenant, run.DatasetID, run.SampleBudget)
	writeJSON(rw, http.StatusAccepted, run)
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/evals/runs", startRun)
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

	"github.com/google/uuid"

	"evals/datasets" // datasets.Exists(datasetID) — provided
	"evals/runs"     // runs.Run, runs.Get(ctx, tenant, idemKey), runs.Put(ctx, tenant, idemKey, run) — provided
)

const maxSamples = 5000

type RunRequest struct {
	DatasetID    string \`json:"dataset_id"\`
	ModelVersion string \`json:"model_version"\`
	SampleBudget int    \`json:"sample_budget"\`
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func startRun(rw http.ResponseWriter, r *http.Request) {
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
	var body RunRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	if body.ModelVersion == "" {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "model_version is required"})
		return
	}
	if body.SampleBudget < 1 || body.SampleBudget > maxSamples {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "sample_budget must be 1..5000"})
		return
	}
	if !datasets.Exists(body.DatasetID) {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "unknown dataset"})
		return
	}

	stored, err := runs.Get(r.Context(), tenant, idemKey)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	if stored != nil {
		writeJSON(rw, http.StatusOK, stored)
		return
	}

	run := runs.Run{
		RunID:        uuid.NewString(),
		Status:       "queued",
		DatasetID:    body.DatasetID,
		ModelVersion: body.ModelVersion,
		SampleBudget: body.SampleBudget,
	}
	if err := runs.Put(r.Context(), tenant, idemKey, run); err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	log.Printf("eval run=%s tenant=%s dataset=%s budget=%d", run.RunID, tenant, run.DatasetID, run.SampleBudget)
	writeJSON(rw, http.StatusAccepted, run)
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/evals/runs", startRun)
}

func main() {
	mux := http.NewServeMux()
	register(mux)
	log.Fatal(http.ListenAndServe(":8443", mux))
}
`,
    },
    scala: {
      starter: `import java.util.UUID

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

import evals.{Run, Runs}

final case class RunRequest(dataset_id: String, model_version: String, sample_budget: Option[Int])

object EvalApi {
  implicit val system: ActorSystem = ActorSystem("eval-harness")
  implicit val requestFormat: RootJsonFormat[RunRequest] = jsonFormat3(RunRequest)
  implicit val runFormat: RootJsonFormat[Run] = jsonFormat5(Run)

  val route: Route =
    path("v1" / "evals" / "runs") {
      post {
        optionalHeaderValueByName("X-Tenant-Id") { tenantOpt =>
          entity(as[RunRequest]) { body =>
            // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
            val tenant = tenantOpt.filter(_.nonEmpty).getOrElse("default")
            if (body.model_version.isEmpty) {
              complete(StatusCodes.BadRequest, """{"error":"model_version is required"}""")
            } else {
              val run = Run(UUID.randomUUID().toString, "queued", body.dataset_id, body.model_version, body.sample_budget.getOrElse(500))
              Runs.put(tenant, run.run_id, run)
              system.log.info(s"eval run=\${run.run_id} tenant=$tenant dataset=\${run.dataset_id} budget=\${run.sample_budget}")
              complete(StatusCodes.Accepted, run)
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
      solution: `import java.util.UUID

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

import evals.{Datasets, Run, Runs}

final case class RunRequest(dataset_id: String, model_version: String, sample_budget: Option[Int])

object EvalApi {
  implicit val system: ActorSystem = ActorSystem("eval-harness")
  implicit val requestFormat: RootJsonFormat[RunRequest] = jsonFormat3(RunRequest)
  implicit val runFormat: RootJsonFormat[Run] = jsonFormat5(Run)

  val MaxSamples = 5000

  val route: Route =
    path("v1" / "evals" / "runs") {
      post {
        optionalHeaderValueByName("X-Tenant-Id") { tenantOpt =>
          optionalHeaderValueByName("Idempotency-Key") { idemOpt =>
            entity(as[RunRequest]) { body =>
              val budget = body.sample_budget.getOrElse(0)
              if (!tenantOpt.exists(_.nonEmpty)) {
                complete(StatusCodes.Unauthorized, """{"error":"missing X-Tenant-Id"}""")
              } else if (!idemOpt.exists(_.nonEmpty)) {
                complete(StatusCodes.BadRequest, """{"error":"Idempotency-Key is required"}""")
              } else if (body.model_version.isEmpty) {
                complete(StatusCodes.BadRequest, """{"error":"model_version is required"}""")
              } else if (budget < 1 || budget > MaxSamples) {
                complete(StatusCodes.BadRequest, """{"error":"sample_budget must be 1..5000"}""")
              } else if (!Datasets.exists(body.dataset_id)) {
                complete(StatusCodes.NotFound, """{"error":"unknown dataset"}""")
              } else {
                val tenant = tenantOpt.get
                val idemKey = idemOpt.get
                Runs.get(tenant, idemKey) match {
                  case Some(stored) =>
                    complete(StatusCodes.OK, stored.run)
                  case None =>
                    val run = Run(UUID.randomUUID().toString, "queued", body.dataset_id, body.model_version, budget)
                    Runs.put(tenant, idemKey, run)
                    system.log.info(s"eval run=\${run.run_id} tenant=$tenant dataset=\${run.dataset_id} budget=$budget")
                    complete(StatusCodes.Accepted, run)
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

#include "evals/runs.h"  // runs::get(tenant, idem_key), runs::put(tenant, idem_key, run) — provided
#include "ids.h"         // new_uuid() — provided

using json = nlohmann::json;

void start_run(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) tenant = "default";
  const json body = json::parse(req.body, nullptr, false);
  if (!body.is_object() || body.value("model_version", std::string()).empty()) {
    res.status = 400;
    res.set_content(R"({"error":"model_version is required"})", "application/json");
    return;
  }
  const json run = {
      {"run_id", new_uuid()},
      {"status", "queued"},
      {"dataset_id", body.value("dataset_id", std::string())},
      {"model_version", body.value("model_version", std::string())},
      {"sample_budget", body.value("sample_budget", 500)},
  };
  runs::put(tenant, run["run_id"].get<std::string>(), run);
  std::cerr << "eval run=" << run["run_id"] << " tenant=" << tenant << " dataset=" << run["dataset_id"] << "\\n";
  res.status = 202;
  res.set_content(run.dump(), "application/json");
}

void register_routes(httplib::Server& svr) { svr.Post("/v1/evals/runs", start_run); }

int main() {
  httplib::Server svr;
  register_routes(svr);
  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <iostream>
#include <string>

#include "evals/datasets.h"  // datasets::exists(dataset_id) — provided
#include "evals/runs.h"      // runs::get(tenant, idem_key), runs::put(tenant, idem_key, run) — provided
#include "ids.h"             // new_uuid() — provided

using json = nlohmann::json;

constexpr int kMaxSamples = 5000;

void reject(httplib::Response& res, int status, const std::string& error) {
  res.status = status;
  res.set_content(json({{"error", error}}).dump(), "application/json");
}

void start_run(const httplib::Request& req, httplib::Response& res) {
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) return reject(res, 401, "missing X-Tenant-Id");
  const std::string idem_key = req.get_header_value("Idempotency-Key");
  if (idem_key.empty()) return reject(res, 400, "Idempotency-Key is required");
  const json body = json::parse(req.body, nullptr, false);
  if (!body.is_object() || !body.contains("model_version") || !body["model_version"].is_string() ||
      body["model_version"].get<std::string>().empty())
    return reject(res, 400, "model_version is required");
  if (!body.contains("sample_budget") || !body["sample_budget"].is_number_integer()) return reject(res, 400, "sample_budget must be 1..5000");
  const int budget = body["sample_budget"].get<int>();
  if (budget < 1 || budget > kMaxSamples) return reject(res, 400, "sample_budget must be 1..5000");
  const std::string dataset_id = body.value("dataset_id", std::string());
  if (!datasets::exists(dataset_id)) return reject(res, 404, "unknown dataset");

  if (const auto stored = runs::get(tenant, idem_key)) {
    res.status = 200;
    res.set_content(stored->dump(), "application/json");
    return;
  }
  const json run = {
      {"run_id", new_uuid()},
      {"status", "queued"},
      {"dataset_id", dataset_id},
      {"model_version", body["model_version"]},
      {"sample_budget", budget},
  };
  runs::put(tenant, idem_key, run);
  std::cerr << "eval run=" << run["run_id"] << " tenant=" << tenant << " dataset=" << dataset_id << "\\n";
  res.status = 202;
  res.set_content(run.dump(), "application/json");
}

void register_routes(httplib::Server& svr) { svr.Post("/v1/evals/runs", start_run); }

int main() {
  httplib::Server svr;
  register_routes(svr);
  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  harness: {
    python: `import json

GOOD = {"dataset_id": "gs-support-v3", "model_version": "support-bot-2026-10", "sample_budget": 500}
FIELDS = ("run_id", "status", "dataset_id", "model_version", "sample_budget")


def _api(ctx):
    return ctx.client(ctx.load("api").app)


async def _post(c, body, key="k-1", tenant="t1"):
    headers = {}
    if tenant is not None:
        headers["X-Tenant-Id"] = tenant
    if key is not None:
        headers["Idempotency-Key"] = key
    return await c.post("/v1/evals/runs", json=body, headers=headers)


def _runs(ctx):
    return sorted(ctx.redis.keys("evals:run:*"))


async def check_route(ctx):
    async with _api(ctx) as c:
        r = await _post(c, GOOD)
        assert r.status_code == 202, f"a valid start answered {r.status_code}: {r.text}"
        run = r.json()
        for key in FIELDS:
            assert key in run, f"the 202 body lacks {key!r}: {run}"
        assert run["status"] == "queued" and run["dataset_id"] == GOOD["dataset_id"] and run["model_version"] == GOOD["model_version"] and run["sample_budget"] == 500, f"the run echoes the request with status queued: {run}"
        row = ctx.redis.get(f"evals:run:{run['run_id']}")
        assert row is not None, f"the run {run['run_id']} must be in the run store (evals:run:{{id}}), keys {sorted(ctx.redis.keys('evals:*'))}"
        assert json.loads(row).get("tenant") == "t1", f"the stored row must carry the tenant t1: {row}"


async def check_dataset_404(ctx):
    async with _api(ctx) as c:
        r = await _post(c, {**GOOD, "dataset_id": "gs-suport-v3"}, key="k-typo")
        assert r.status_code == 404, f"a dataset id the registry does not know (gs-suport-v3) answered {r.status_code}, expected 404: the run would score against a golden set that does not exist"
        assert _runs(ctx) == [], f"a start for an unknown dataset must store no run, found {_runs(ctx)}"
        r = await _post(c, {**GOOD, "dataset_id": "gs-billing-v2"}, key="k-ok")
        assert r.status_code == 202, f"gs-billing-v2 is in the registry, got {r.status_code}: {r.text}"


async def check_budget_cap(ctx):
    async with _api(ctx) as c:
        for budget in (0, -5, 5001, 1_000_000):
            r = await _post(c, {**GOOD, "sample_budget": budget}, key=f"k-{budget}")
            assert r.status_code == 400, f"sample_budget={budget} answered {r.status_code}, expected 400 (the budget is 1..5000 judge calls)"
        missing = {k: v for k, v in GOOD.items() if k != "sample_budget"}
        r = await _post(c, missing, key="k-missing")
        assert r.status_code == 400, f"a start without sample_budget answered {r.status_code}, expected 400: a default budget is one the caller never chose"
        assert _runs(ctx) == [], f"refused budgets must store no run, found {_runs(ctx)}"
        for budget in (1, 5000):
            r = await _post(c, {**GOOD, "sample_budget": budget}, key=f"k-{budget}")
            assert r.status_code == 202, f"sample_budget={budget} is within 1..5000 inclusive, got {r.status_code}: {r.text}"


async def check_idempotency_key(ctx):
    async with _api(ctx) as c:
        r = await _post(c, GOOD, key=None)
        assert r.status_code == 400, f"a start without Idempotency-Key answered {r.status_code}, expected 400"
        first = await _post(c, GOOD, key="k-7")
        assert first.status_code == 202, f"the first start answered {first.status_code}: {first.text}"
        replay = await _post(c, GOOD, key="k-7")
        assert replay.status_code == 200, f"a replay of the same (tenant, Idempotency-Key) answered {replay.status_code}, expected 200 with the stored run: the CI client retried, it must not get a second run"
        assert replay.json()["run_id"] == first.json()["run_id"], f"the replay must resume the same run: got {replay.json()['run_id']}, the first start made {first.json()['run_id']}"
        assert len(_runs(ctx)) == 1, f"one key, one run: the store holds {len(_runs(ctx))} runs after a start and its replay"
        other = await _post(c, GOOD, key="k-7", tenant="t2")
        assert other.status_code == 202 and other.json()["run_id"] != first.json()["run_id"], "another tenant reusing the key gets its own run (keys are per tenant)"


async def check_tenant_required(ctx):
    async with _api(ctx) as c:
        for tenant in (None, ""):
            r = await _post(c, GOOD, key="k-anon", tenant=tenant)
            assert r.status_code == 401, f"a start with {'no X-Tenant-Id' if tenant is None else 'an empty X-Tenant-Id'} answered {r.status_code}, expected 401: a run without a tenant lands where every team can read it"
        assert ctx.redis.keys("evals:*") == [], f"a refused start must leave nothing in Redis, found {sorted(ctx.redis.keys('evals:*'))}"
        r = await _post(c, GOOD, key="k-9", tenant="t9")
        assert r.status_code == 202, f"a start with a tenant answered {r.status_code}: {r.text}"
        row = json.loads(ctx.redis.get(f"evals:run:{r.json()['run_id']}") or "{}")
        assert row.get("tenant") == "t9", f"the stored row must carry the caller's tenant t9: {row}"
`,
    typescript: `const GOOD = {dataset_id: 'gs-support-v3', model_version: 'support-bot-2026-10', sample_budget: 500};
const FIELDS = ['run_id', 'status', 'dataset_id', 'model_version', 'sample_budget'];

function api(ctx) {
  return ctx.client(ctx.load('api').app);
}

async function post(c, body, {key = 'k-1' as string | null, tenant = 't1' as string | null} = {}) {
  const headers: Record<string, string> = {};
  if (tenant !== null) headers['X-Tenant-Id'] = tenant;
  if (key !== null) headers['Idempotency-Key'] = key;
  return c.post('/v1/evals/runs', {body, headers});
}

const runKeys = ctx => ctx.redis.keys('evals:run:*').sort();

export async function check_route(ctx) {
  const c = api(ctx);
  const r = await post(c, GOOD);
  assert.equal(r.status, 202, \`a valid start answered \${r.status}: \${r.text}\`);
  const run = r.json();
  for (const key of FIELDS) assert(key in run, \`the 202 body lacks \${key}: \${r.text}\`);
  assert(run.status === 'queued' && run.dataset_id === GOOD.dataset_id && run.model_version === GOOD.model_version && run.sample_budget === 500, \`the run echoes the request with status queued: \${r.text}\`);
  const row = ctx.redis.get(\`evals:run:\${run.run_id}\`);
  assert(row !== null, \`the run \${run.run_id} must be in the run store (evals:run:{id}), keys \${JSON.stringify(ctx.redis.keys('evals:*').sort())}\`);
  assert.equal(JSON.parse(row).tenant, 't1', \`the stored row must carry the tenant t1: \${row}\`);
}

export async function check_dataset_404(ctx) {
  const c = api(ctx);
  let r = await post(c, {...GOOD, dataset_id: 'gs-suport-v3'}, {key: 'k-typo'});
  assert.equal(r.status, 404, \`a dataset id the registry does not know (gs-suport-v3) answered \${r.status}, expected 404: the run would score against a golden set that does not exist\`);
  assert.deepEqual(runKeys(ctx), [], \`a start for an unknown dataset must store no run, found \${JSON.stringify(runKeys(ctx))}\`);
  r = await post(c, {...GOOD, dataset_id: 'gs-billing-v2'}, {key: 'k-ok'});
  assert.equal(r.status, 202, \`gs-billing-v2 is in the registry, got \${r.status}: \${r.text}\`);
}

export async function check_budget_cap(ctx) {
  const c = api(ctx);
  for (const budget of [0, -5, 5001, 1_000_000]) {
    const r = await post(c, {...GOOD, sample_budget: budget}, {key: \`k-\${budget}\`});
    assert.equal(r.status, 400, \`sample_budget=\${budget} answered \${r.status}, expected 400 (the budget is 1..5000 judge calls)\`);
  }
  const {sample_budget: _, ...missing} = GOOD;
  const r = await post(c, missing, {key: 'k-missing'});
  assert.equal(r.status, 400, \`a start without sample_budget answered \${r.status}, expected 400: a default budget is one the caller never chose\`);
  assert.deepEqual(runKeys(ctx), [], \`refused budgets must store no run, found \${JSON.stringify(runKeys(ctx))}\`);
  for (const budget of [1, 5000]) {
    const ok = await post(c, {...GOOD, sample_budget: budget}, {key: \`k-\${budget}\`});
    assert.equal(ok.status, 202, \`sample_budget=\${budget} is within 1..5000 inclusive, got \${ok.status}: \${ok.text}\`);
  }
}

export async function check_idempotency_key(ctx) {
  const c = api(ctx);
  const noKey = await post(c, GOOD, {key: null});
  assert.equal(noKey.status, 400, \`a start without Idempotency-Key answered \${noKey.status}, expected 400\`);
  const first = await post(c, GOOD, {key: 'k-7'});
  assert.equal(first.status, 202, \`the first start answered \${first.status}: \${first.text}\`);
  const replay = await post(c, GOOD, {key: 'k-7'});
  assert.equal(replay.status, 200, \`a replay of the same (tenant, Idempotency-Key) answered \${replay.status}, expected 200 with the stored run: the CI client retried, it must not get a second run\`);
  assert.equal(replay.json().run_id, first.json().run_id, \`the replay must resume the same run: got \${replay.json().run_id}, the first start made \${first.json().run_id}\`);
  assert.equal(runKeys(ctx).length, 1, \`one key, one run: the store holds \${runKeys(ctx).length} runs after a start and its replay\`);
  const other = await post(c, GOOD, {key: 'k-7', tenant: 't2'});
  assert(other.status === 202 && other.json().run_id !== first.json().run_id, 'another tenant reusing the key gets its own run (keys are per tenant)');
}

export async function check_tenant_required(ctx) {
  const c = api(ctx);
  for (const tenant of [null, '']) {
    const r = await post(c, GOOD, {key: 'k-anon', tenant});
    assert.equal(r.status, 401, \`a start with X-Tenant-Id \${JSON.stringify(tenant)} answered \${r.status}, expected 401: a run without a tenant lands where every team can read it\`);
  }
  assert.deepEqual(ctx.redis.keys('evals:*'), [], \`a refused start must leave nothing in Redis, found \${JSON.stringify(ctx.redis.keys('evals:*'))}\`);
  const r = await post(c, GOOD, {key: 'k-9', tenant: 't9'});
  assert.equal(r.status, 202, \`a start with a tenant answered \${r.status}: \${r.text}\`);
  const row = JSON.parse(ctx.redis.get(\`evals:run:\${r.json().run_id}\`) ?? '{}');
  assert.equal(row.tenant, 't9', \`the stored row must carry the caller's tenant t9: \${JSON.stringify(row)}\`);
}
`,
    go: `package main

import (
	"encoding/json"
	"net/http"

	"leetbuild/harness"
)

var apiGood = map[string]any{"dataset_id": "gs-support-v3", "model_version": "support-bot-2026-10", "sample_budget": 500}

func apiClient(ctx *harness.Ctx) *harness.HTTP {
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

func apiWith(overrides map[string]any, drop ...string) map[string]any {
	out := map[string]any{}
	for k, v := range apiGood {
		out[k] = v
	}
	for k, v := range overrides {
		out[k] = v
	}
	for _, k := range drop {
		delete(out, k)
	}
	return out
}

func apiPost(c *harness.HTTP, body map[string]any, key, tenant string) *harness.Response {
	return c.Post("/v1/evals/runs", body, "X-Tenant-Id", tenant, "Idempotency-Key", key)
}

func apiRun(ctx *harness.Ctx, r *harness.Response) map[string]any {
	run, ok := r.JSON().(map[string]any)
	ctx.Assert(ok, "the body must be a JSON object: %s", r.Text())
	return run
}

func apiRow(ctx *harness.Ctx, runID any) map[string]any {
	id, _ := runID.(string)
	raw, ok := ctx.Redis.Get("evals:run:" + id)
	ctx.Assert(ok, "the run %s must be in the run store (evals:run:{id}), keys %v", id, ctx.Redis.Keys("evals:*"))
	var row map[string]any
	ctx.NoError(json.Unmarshal([]byte(raw), &row), "the stored row must be JSON")
	return row
}

func CheckRoute(ctx *harness.Ctx) {
	c := apiClient(ctx)
	r := apiPost(c, apiGood, "k-1", "t1")
	ctx.Equal(r.Status, 202, "a valid start (%s)", r.Text())
	run := apiRun(ctx, r)
	for _, key := range []string{"run_id", "status", "dataset_id", "model_version", "sample_budget"} {
		_, ok := run[key]
		ctx.Assert(ok, "the 202 body lacks %s: %s", key, r.Text())
	}
	ctx.Assert(run["status"] == "queued" && run["dataset_id"] == "gs-support-v3" && run["model_version"] == "support-bot-2026-10" && run["sample_budget"] == float64(500), "the run echoes the request with status queued: %s", r.Text())
	ctx.Equal(apiRow(ctx, run["run_id"])["tenant"], "t1", "the stored row's tenant")
}

func CheckDataset404(ctx *harness.Ctx) {
	c := apiClient(ctx)
	r := apiPost(c, apiWith(map[string]any{"dataset_id": "gs-suport-v3"}), "k-typo", "t1")
	ctx.Equal(r.Status, 404, "a dataset id the registry does not know (gs-suport-v3): the run would score against a golden set that does not exist")
	ctx.Equal(len(ctx.Redis.Keys("evals:run:*")), 0, "a start for an unknown dataset must store no run; runs stored")
	r = apiPost(c, apiWith(map[string]any{"dataset_id": "gs-billing-v2"}), "k-ok", "t1")
	ctx.Equal(r.Status, 202, "gs-billing-v2 is in the registry (%s)", r.Text())
}

func CheckBudgetCap(ctx *harness.Ctx) {
	c := apiClient(ctx)
	for _, budget := range []int{0, -5, 5001, 1_000_000} {
		r := apiPost(c, apiWith(map[string]any{"sample_budget": budget}), "k-budget", "t1")
		ctx.Equal(r.Status, 400, "sample_budget=%d (the budget is 1..5000 judge calls)", budget)
	}
	r := apiPost(c, apiWith(nil, "sample_budget"), "k-missing", "t1")
	ctx.Equal(r.Status, 400, "a start without sample_budget: a default budget is one the caller never chose")
	ctx.Equal(len(ctx.Redis.Keys("evals:run:*")), 0, "refused budgets must store no run; runs stored")
	for _, budget := range []int{1, 5000} {
		r := apiPost(c, apiWith(map[string]any{"sample_budget": budget}), "k-"+harness.Show(budget), "t1")
		ctx.Equal(r.Status, 202, "sample_budget=%d is within 1..5000 inclusive (%s)", budget, r.Text())
	}
}

func CheckIdempotencyKey(ctx *harness.Ctx) {
	c := apiClient(ctx)
	noKey := c.Post("/v1/evals/runs", apiGood, "X-Tenant-Id", "t1")
	ctx.Equal(noKey.Status, 400, "a start without Idempotency-Key")
	first := apiPost(c, apiGood, "k-7", "t1")
	ctx.Equal(first.Status, 202, "the first start (%s)", first.Text())
	replay := apiPost(c, apiGood, "k-7", "t1")
	ctx.Equal(replay.Status, 200, "a replay of the same (tenant, Idempotency-Key) must answer the stored run (the CI client retried; it must not get a second run)")
	ctx.Equal(apiRun(ctx, replay)["run_id"], apiRun(ctx, first)["run_id"], "the replay must resume the same run")
	ctx.Equal(len(ctx.Redis.Keys("evals:run:*")), 1, "one key, one run: runs stored after a start and its replay")
	other := apiPost(c, apiGood, "k-7", "t2")
	ctx.Assert(other.Status == 202 && apiRun(ctx, other)["run_id"] != apiRun(ctx, first)["run_id"], "another tenant reusing the key gets its own run (keys are per tenant)")
}

func CheckTenantRequired(ctx *harness.Ctx) {
	c := apiClient(ctx)
	r := c.Post("/v1/evals/runs", apiGood, "Idempotency-Key", "k-anon")
	ctx.Equal(r.Status, 401, "a start without X-Tenant-Id: a run without a tenant lands where every team can read it")
	r = apiPost(c, apiGood, "k-anon", "")
	ctx.Equal(r.Status, 401, "a start with an empty X-Tenant-Id")
	ctx.Equal(len(ctx.Redis.Keys("evals:*")), 0, "a refused start must leave nothing in Redis (%v); keys", ctx.Redis.Keys("evals:*"))
	r = apiPost(c, apiGood, "k-9", "t9")
	ctx.Equal(r.Status, 202, "a start with a tenant (%s)", r.Text())
	ctx.Equal(apiRow(ctx, apiRun(ctx, r)["run_id"])["tenant"], "t9", "the stored row must carry the caller's tenant")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <string>

namespace {

using json = nlohmann::json;

const json kGood = {{"dataset_id", "gs-support-v3"}, {"model_version", "support-bot-2026-10"}, {"sample_budget", 500}};

struct Api {
  httplib::Server svr;
  harness::HTTP http;
  explicit Api(harness::Ctx& ctx) : http(ctx.HTTP(svr)) { register_routes(svr); }

  harness::Response post(const json& body, const std::string& key = "k-1", const std::string& tenant = "t1") {
    return http.Post("/v1/evals/runs", body.dump(), "X-Tenant-Id", tenant, "Idempotency-Key", key);
  }
};

json with(json body, const std::string& field, const json& value) {
  body[field] = value;
  return body;
}

json runOf(harness::Ctx& ctx, const harness::Response& r) {
  const json run = json::parse(r.Text(), nullptr, false);
  ctx.Assert(run.is_object(), "the body must be a JSON object: %s", r.Text());
  return run;
}

json rowOf(harness::Ctx& ctx, const json& run) {
  const std::string id = run.contains("run_id") && run["run_id"].is_string() ? run["run_id"].get<std::string>() : "";
  const auto raw = ctx.Redis.Get("evals:run:" + id);
  ctx.Assert(raw.has_value(), "the run %s must be in the run store (evals:run:{id}), keys %v", id, ctx.Redis.Keys("evals:*"));
  return json::parse(*raw, nullptr, false);
}

}  // namespace

void CheckRoute(harness::Ctx& ctx) {
  Api api(ctx);
  const auto r = api.post(kGood);
  ctx.Equal(r.Status, 202, "a valid start (%s)", r.Text());
  const json run = runOf(ctx, r);
  for (const char* key : {"run_id", "status", "dataset_id", "model_version", "sample_budget"}) ctx.Assert(run.contains(key), "the 202 body lacks %s: %s", key, r.Text());
  ctx.Assert(run["status"] == "queued" && run["dataset_id"] == "gs-support-v3" && run["model_version"] == "support-bot-2026-10" && run["sample_budget"] == 500,
             "the run echoes the request with status queued: %s", r.Text());
  ctx.Equal(rowOf(ctx, run).value("tenant", ""), "t1", "the stored row's tenant");
}

void CheckDataset404(harness::Ctx& ctx) {
  Api api(ctx);
  auto r = api.post(with(kGood, "dataset_id", "gs-suport-v3"), "k-typo");
  ctx.Equal(r.Status, 404, "a dataset id the registry does not know (gs-suport-v3): the run would score against a golden set that does not exist");
  ctx.Equal(ctx.Redis.Keys("evals:run:*").size(), 0, "a start for an unknown dataset must store no run; runs stored");
  r = api.post(with(kGood, "dataset_id", "gs-billing-v2"), "k-ok");
  ctx.Equal(r.Status, 202, "gs-billing-v2 is in the registry (%s)", r.Text());
}

void CheckBudgetCap(harness::Ctx& ctx) {
  Api api(ctx);
  for (int budget : {0, -5, 5001, 1000000}) {
    const auto r = api.post(with(kGood, "sample_budget", budget), "k-budget");
    ctx.Equal(r.Status, 400, "sample_budget=%d (the budget is 1..5000 judge calls)", budget);
  }
  json missing = kGood;
  missing.erase("sample_budget");
  const auto r = api.post(missing, "k-missing");
  ctx.Equal(r.Status, 400, "a start without sample_budget: a default budget is one the caller never chose");
  ctx.Equal(ctx.Redis.Keys("evals:run:*").size(), 0, "refused budgets must store no run; runs stored");
  for (int budget : {1, 5000}) {
    const auto ok = api.post(with(kGood, "sample_budget", budget), "k-" + std::to_string(budget));
    ctx.Equal(ok.Status, 202, "sample_budget=%d is within 1..5000 inclusive (%s)", budget, ok.Text());
  }
}

void CheckIdempotencyKey(harness::Ctx& ctx) {
  Api api(ctx);
  const auto noKey = api.http.Post("/v1/evals/runs", kGood.dump(), "X-Tenant-Id", "t1");
  ctx.Equal(noKey.Status, 400, "a start without Idempotency-Key");
  const auto first = api.post(kGood, "k-7");
  ctx.Equal(first.Status, 202, "the first start (%s)", first.Text());
  const auto replay = api.post(kGood, "k-7");
  ctx.Equal(replay.Status, 200, "a replay of the same (tenant, Idempotency-Key) must answer the stored run (the CI client retried; it must not get a second run)");
  ctx.Equal(runOf(ctx, replay)["run_id"], runOf(ctx, first)["run_id"], "the replay must resume the same run");
  ctx.Equal(ctx.Redis.Keys("evals:run:*").size(), 1, "one key, one run: runs stored after a start and its replay");
  const auto other = api.post(kGood, "k-7", "t2");
  ctx.Assert(other.Status == 202 && runOf(ctx, other)["run_id"] != runOf(ctx, first)["run_id"], "another tenant reusing the key gets its own run (keys are per tenant)");
}

void CheckTenantRequired(harness::Ctx& ctx) {
  Api api(ctx);
  auto r = api.http.Post("/v1/evals/runs", kGood.dump(), "Idempotency-Key", "k-anon");
  ctx.Equal(r.Status, 401, "a start without X-Tenant-Id: a run without a tenant lands where every team can read it");
  r = api.post(kGood, "k-anon", "");
  ctx.Equal(r.Status, 401, "a start with an empty X-Tenant-Id");
  ctx.Equal(ctx.Redis.Keys("evals:*").size(), 0, "a refused start must leave nothing in Redis (%v); keys", ctx.Redis.Keys("evals:*"));
  r = api.post(kGood, "k-9", "t9");
  ctx.Equal(r.Status, 202, "a start with a tenant (%s)", r.Text());
  ctx.Equal(rowOf(ctx, runOf(ctx, r)).value("tenant", ""), "t9", "the stored row must carry the caller's tenant");
}
`,
  },
  hints: [
    'Symptom: a CI job that retried a slow start shows two runs for one model version, a run against `gs-suport-v3` is accepted, and a request without a tenant header still gets a 202.',
    'Mechanism: each run is stored under a fresh id, so a replay of the same key finds nothing; a missing tenant or budget is filled in instead of refused; and the registry is not asked whether the golden set exists.',
    'Change: guards in order (tenant 401, `Idempotency-Key` 400, `model_version` 400, budget 1..`MAX_SAMPLES` 400, `datasets.exists` 404), then `store.get(tenant, key)` answers 200 on a hit; `store.put(tenant, key, run)` runs last.',
  ],
  debrief: `The fix is a trust boundary. The caller names a golden set and a budget; the server checks the set against its registry, bounds the budget, and refuses instead of guessing when the tenant or the key is missing, because a default is a decision nobody made. Keying the run by \`(tenant, Idempotency-Key)\` turns a client retry into a resume, and the key is per tenant because clients pick keys and collide. Validating before the write leaves a rejected request nothing to unwind. Production eval services also pin the golden set's version into the run, so two runs over a relabeled set are never compared, and cap concurrent runs per tenant so one sweep cannot starve the judge.`,
};
