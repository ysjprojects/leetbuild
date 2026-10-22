import type {Step} from '@/lib/types';

export const endpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/evals/runs: start a validated run',
  concept: 'http',
  file: 'api',
  focus: ['client', 'harness', 'db'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it registers the route, reads
the body and answers \`202\` with a fresh run id. It compiles, it serves the demo, and it starts
scoring a dataset this service has never seen, with whatever budget the caller felt like. Review it
like the service owner, fix it, and prove the fix with the checks below.

Implement \`POST /v1/evals/runs\` with body
\`{"dataset_id": "…", "model_version": "…", "sample_budget": 500}\`.

- The tenant comes from the authenticated \`X-Tenant-Id\` header; a missing tenant is **401**.
- \`model_version\` is a required non-empty string (**400** otherwise). A run without a version
  cannot be compared with the previous release, which is the only thing the numbers are for.
- \`sample_budget\` is a required integer from **1** to **5000**; a missing budget or anything above
  5000 is **400**. The draft caps nothing, so one request can queue an unbounded eval.
- \`dataset_id\` must name a dataset the service owns: look it up in the dataset registry before
  anything is queued and answer **404** for an unknown id. Scoring against a dataset that does not
  exist produces a green report with no samples behind it.
- \`Idempotency-Key\` is required (**400** when missing) and the created run is stored under
  \`(tenant, key)\`. A replay with the same key returns the **stored run** — same \`run_id\`, same
  status, \`200\` — instead of queueing a competing run.
- Validate everything **before** the run is enqueued: a rejected request must leave no run behind.
- Log the decision with tenant, run id and dataset — never the sample or prompt data.

**Failure mode the checks target.** The draft trusts the caller for the dataset id, so a typo
produces an eval that measures nothing; it caps no budget, so a typo'd budget can queue a million
judge calls; and it ignores \`Idempotency-Key\`, so the CI retry that every client does starts a
second run against the same dataset and the release gate later reads two half-populated records.`,
  sequence: {
    participants: ['Client', 'Eval Harness', 'dataset registry', 'run store'],
    messages: [
      {from: 'Client', to: 'Eval Harness', label: 'POST /v1/evals/runs · X-Tenant-Id · Idempotency-Key', kind: 'sync'},
      {
        from: 'Eval Harness',
        to: 'Eval Harness',
        label: 'validate tenant · model_version · sample_budget',
        kind: 'sync',
      },
      {from: 'Eval Harness', to: 'dataset registry', label: 'exists(dataset_id)', kind: 'sync'},
      {from: 'dataset registry', to: 'Eval Harness', label: 'true / unknown → 404', kind: 'reply'},
      {from: 'Eval Harness', to: 'run store', label: 'get(tenant, idem_key)', kind: 'sync'},
      {from: 'run store', to: 'Eval Harness', label: 'stored run / none', kind: 'reply'},
      {from: 'Eval Harness', to: 'run store', label: 'put(tenant, idem_key, run)', kind: 'async'},
      {from: 'Eval Harness', to: 'Client', label: '202 {run_id, dataset_id, sample_budget, status}', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Handles POST /v1/evals/runs',
      detail: 'Register the run-start route on `POST /v1/evals/runs`.',
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
      title: 'Rejects a dataset the service does not own',
      detail:
        'The dataset id is looked up in the registry and an unknown one answers **404** before anything is queued. The draft never consults the registry, so a typo starts a run against a dataset that does not exist.',
      match: {
        python: {all: [/datasets\.exists\(/, /status_code\s*=\s*404/]},
        typescript: {all: [/datasets\.exists\(/, /code\(\s*404\s*\)/]},
        go: {all: [/datasets\.Exists\(/, /StatusNotFound/]},
        scala: {all: [/datasets\.exists\(/, /StatusCodes\.NotFound/]},
        cpp: {all: [/datasets\.exists\(/, /\b404\b/]},
      },
    },
    {
      id: 'budget-cap',
      title: 'Requires a sample budget inside 1..5000',
      detail:
        '`sample_budget` is required and bounded by `MAX_SAMPLES = 5000`; a missing or oversized budget is **400**. The draft caps nothing, so one request can queue an unbounded number of judge calls.',
      match: {
        python: {all: [/MAX_SAMPLES\s*=\s*5000/, /sample_budget/, /status_code\s*=\s*400/]},
        typescript: {all: [/MAX_SAMPLES\s*=\s*5000/, /sample_budget/, /code\(\s*400\s*\)/]},
        go: {all: [/maxSamples\s*=\s*5000/, /SampleBudget/, /StatusBadRequest/]},
        scala: {all: [/MaxSamples\s*=\s*5000/, /sample_budget/, /StatusCodes\.BadRequest/]},
        cpp: {all: [/kMaxSamples\s*=\s*5000/, /sample_budget/, /\b400\b/]},
      },
    },
    {
      id: 'idempotency-key',
      title: 'Replays return the stored run keyed by (tenant, Idempotency-Key)',
      detail:
        '`Idempotency-Key` is required and the run is stored under `(tenant, key)`; a replay returns the stored run instead of queueing a second one. The draft ignores the header, so the retry every client does starts a competing run.',
      match: {
        python: {all: [/Idempotency-Key/, /store\.get\(/, /store\.put\(/]},
        typescript: {all: [/Idempotency-Key/, /store\.get\(/, /store\.put\(/]},
        go: {all: [/Idempotency-Key/, /store\.Get\(/, /store\.Put\(/]},
        scala: {all: [/Idempotency-Key/, /store\.get\(/, /store\.put\(/]},
        cpp: {all: [/Idempotency-Key/, /store\.get\(/, /store\.put\(/]},
      },
    },
    {
      id: 'tenant-required',
      title: 'Requires the authenticated tenant',
      detail:
        'A missing `X-Tenant-Id` is **401** and the run is keyed by that tenant, so one team cannot read or start another team’s eval. The draft reads the header as an optional label and never rejects its absence.',
      match: {
        python: {all: [/X-Tenant-Id/, /status_code\s*=\s*401/]},
        typescript: {all: [/X-Tenant-Id/, /code\(\s*401\s*\)/]},
        go: {all: [/X-Tenant-Id/, /StatusUnauthorized/]},
        scala: {all: [/X-Tenant-Id/, /StatusCodes\.Unauthorized/]},
        cpp: {all: [/X-Tenant-Id/, /\b401\b/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import uuid

from fastapi import FastAPI, Header
from pydantic import BaseModel

app = FastAPI()


class RunRequest(BaseModel):
    dataset_id: str
    model_version: str
    sample_budget: int = 0


def enqueue(run_id: str, dataset_id: str, model_version: str) -> None:
    """Queue the run for the workers; a rejected request must never reach this."""
    raise NotImplementedError


@app.post("/v1/evals/runs")
def start_run(body: RunRequest, tenant: str = Header(alias="X-Tenant-Id")) -> dict:
    # TODO: this draft accepts whatever dataset id the caller sends, caps nothing, queues before it
    # validates, and ignores Idempotency-Key, so a retry starts a second competing run.
    run_id = str(uuid.uuid4())
    enqueue(run_id, body.dataset_id, body.model_version)
    return {"run_id": run_id, "status": "queued", "sample_budget": body.sample_budget}
`,
      solution: `import logging
import uuid

from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()
logger = logging.getLogger("evals")

MAX_SAMPLES = 5000


class RunRequest(BaseModel):
    dataset_id: str
    model_version: str
    sample_budget: int | None = None


class DatasetRegistry:
    def exists(self, dataset_id: str) -> bool:
        """Whether this service may score the dataset."""
        raise NotImplementedError


class RunStore:
    def get(self, tenant: str, idem_key: str) -> dict | None:
        """The run stored under (tenant, idem_key), if any."""
        raise NotImplementedError

    def put(self, tenant: str, idem_key: str, run: dict) -> None:
        """Store the run under (tenant, idem_key)."""
        raise NotImplementedError


datasets = DatasetRegistry()
store = RunStore()


def check_dataset(dataset_id: str) -> None:
    if not datasets.exists(dataset_id):
        raise HTTPException(status_code=404, detail="unknown dataset")


@app.post("/v1/evals/runs")
def start_run(
    body: RunRequest,
    tenant: str | None = Header(default=None, alias="X-Tenant-Id"),
    idem_key: str | None = Header(default=None, alias="Idempotency-Key"),
) -> JSONResponse:
    if tenant is None or tenant == "":
        raise HTTPException(status_code=401, detail="missing X-Tenant-Id")
    if idem_key is None or idem_key == "":
        raise HTTPException(status_code=400, detail="Idempotency-Key is required")
    if body.model_version == "":
        raise HTTPException(status_code=400, detail="model_version is required")
    if body.sample_budget is None or not 1 <= body.sample_budget <= MAX_SAMPLES:
        raise HTTPException(status_code=400, detail="sample_budget must be 1..5000")
    check_dataset(body.dataset_id)

    stored = store.get(tenant, idem_key)
    if stored is not None:
        return JSONResponse(stored, status_code=200)

    run = {
        "run_id": str(uuid.uuid4()),
        "dataset_id": body.dataset_id,
        "model_version": body.model_version,
        "sample_budget": body.sample_budget,
        "status": "queued",
    }
    store.put(tenant, idem_key, run)
    logger.info("run started tenant=%s run_id=%s dataset=%s", tenant, run["run_id"], body.dataset_id)
    return JSONResponse(run, status_code=202)
`,
    },
    typescript: {
      starter: `/** POST /v1/evals/runs: a model-generated draft that queues whatever the caller sends. */
import {randomUUID} from 'node:crypto';

import Fastify from 'fastify';

export const app = Fastify();

interface RunBody {
  dataset_id: string;
  model_version: string;
  sample_budget?: number;
}

async function enqueue(runId: string, datasetId: string, modelVersion: string): Promise<void> {
  void runId;
  void datasetId;
  void modelVersion;
}

app.post('/v1/evals/runs', async (request, reply) => {
  // TODO: this draft accepts whatever dataset id the caller sends, caps nothing, queues before it
  // validates, and ignores Idempotency-Key, so a retry starts a second competing run.
  const tenant = request.headers['x-tenant-id'] as string;
  const body = request.body as RunBody;
  const runId = randomUUID();
  await enqueue(runId, body.dataset_id, body.model_version);
  return reply.code(202).send({run_id: runId, status: 'queued', sample_budget: body.sample_budget});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** POST /v1/evals/runs: one validated, idempotent run per (tenant, key). */
import {randomUUID} from 'node:crypto';

import Fastify from 'fastify';

import {datasets, store} from './store';

export const app = Fastify();

const MAX_SAMPLES = 5000;

interface RunBody {
  dataset_id?: string;
  model_version?: string;
  sample_budget?: number;
}

interface Run {
  run_id: string;
  dataset_id: string;
  model_version: string;
  sample_budget: number;
  status: string;
}

app.post('/v1/evals/runs', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing X-Tenant-Id'});
  const idemKey = request.headers['idempotency-key'];
  if (typeof idemKey !== 'string' || idemKey === '')
    return reply.code(400).send({error: 'Idempotency-Key is required'});

  const body = request.body as Partial<RunBody> | null;
  if (body === null || typeof body !== 'object' || typeof body.model_version !== 'string' || body.model_version === '')
    return reply.code(400).send({error: 'model_version is required'});
  const budget = body.sample_budget;
  if (!Number.isInteger(budget) || (budget ?? 0) < 1 || (budget ?? 0) > MAX_SAMPLES)
    return reply.code(400).send({error: 'sample_budget must be 1..5000'});
  const datasetId = body.dataset_id;
  if (typeof datasetId !== 'string' || !(await datasets.exists(datasetId)))
    return reply.code(404).send({error: 'unknown dataset'});

  const stored: Run | null = await store.get(tenant, idemKey);
  if (stored !== null) return reply.code(200).send(stored);

  const run: Run = {
    run_id: randomUUID(),
    dataset_id: datasetId,
    model_version: body.model_version,
    sample_budget: budget as number,
    status: 'queued',
  };
  await store.put(tenant, idemKey, run);
  request.log.info({tenant, run_id: run.run_id, dataset: datasetId}, 'run started');
  return reply.code(202).send(run);
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

	"github.com/google/uuid"
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

func enqueue(runID, datasetID, modelVersion string) {}

func startRun(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	var body RunRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	// TODO: this draft accepts whatever dataset id the caller sends, caps nothing, queues before it
	// validates, and ignores Idempotency-Key, so a retry starts a second competing run.
	runID := uuid.NewString()
	enqueue(runID, body.DatasetID, body.ModelVersion)
	writeJSON(rw, http.StatusAccepted, map[string]any{
		"run_id":        runID,
		"status":        "queued",
		"sample_budget": body.SampleBudget,
	})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/evals/runs", startRun)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"

	"github.com/google/uuid"
)

const maxSamples = 5000

type RunRequest struct {
	DatasetID    string \`json:"dataset_id"\`
	ModelVersion string \`json:"model_version"\`
	SampleBudget int    \`json:"sample_budget"\`
}

type DatasetRegistry struct{}

func (d *DatasetRegistry) Exists(ctx context.Context, datasetID string) bool {
	return false
}

type RunStore struct{}

func (s *RunStore) Get(ctx context.Context, tenant, idemKey string) (map[string]any, error) {
	return nil, nil
}

func (s *RunStore) Put(ctx context.Context, tenant, idemKey string, run map[string]any) error {
	return nil
}

var (
	datasets = &DatasetRegistry{}
	store    = &RunStore{}
)

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
	if !datasets.Exists(r.Context(), body.DatasetID) {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "unknown dataset"})
		return
	}
	stored, err := store.Get(r.Context(), tenant, idemKey)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	if stored != nil {
		writeJSON(rw, http.StatusOK, stored)
		return
	}
	run := map[string]any{
		"run_id":        uuid.NewString(),
		"dataset_id":    body.DatasetID,
		"model_version": body.ModelVersion,
		"sample_budget": body.SampleBudget,
		"status":        "queued",
	}
	if err := store.Put(r.Context(), tenant, idemKey, run); err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	log.Printf("run started tenant=%s run_id=%s dataset=%s", tenant, run["run_id"], body.DatasetID)
	writeJSON(rw, http.StatusAccepted, run)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/evals/runs", startRun)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
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

final case class RunRequest(dataset_id: String, model_version: String, sample_budget: Int)

object EvalApi {
  implicit val system: ActorSystem = ActorSystem("eval-harness")
  implicit val runFormat: RootJsonFormat[RunRequest] = jsonFormat3(RunRequest)

  def enqueue(runId: String, datasetId: String, modelVersion: String): Unit = ()

  val route: Route =
    path("v1" / "evals" / "runs") {
      post {
        headerValueByName("X-Tenant-Id") { _ =>
          entity(as[RunRequest]) { body =>
            // TODO: this draft accepts whatever dataset id the caller sends, caps nothing, queues
            // before it validates, and ignores Idempotency-Key, so a retry starts a second run.
            val runId = UUID.randomUUID().toString
            enqueue(runId, body.dataset_id, body.model_version)
            complete(StatusCodes.Accepted, s"""{"run_id":"$runId","sample_budget":\${body.sample_budget}}""")
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

final case class RunRequest(dataset_id: String, model_version: String, sample_budget: Int)
final case class Run(run_id: String, dataset_id: String, model_version: String, sample_budget: Int, status: String)

object DatasetRegistry {
  def exists(datasetId: String): Boolean = false
}

object RunStore {
  def get(tenant: String, idemKey: String): Option[String] = None
  def put(tenant: String, idemKey: String, run: String): Unit = ()
}

object EvalApi {
  implicit val system: ActorSystem = ActorSystem("eval-harness")
  implicit val runFormat: RootJsonFormat[RunRequest] = jsonFormat3(RunRequest)
  implicit val storedFormat: RootJsonFormat[Run] = jsonFormat5(Run)

  val MaxSamples = 5000

  val datasets = DatasetRegistry
  val store = RunStore

  val route: Route =
    path("v1" / "evals" / "runs") {
      post {
        optionalHeaderValueByName("X-Tenant-Id") { tenantOpt =>
          optionalHeaderValueByName("Idempotency-Key") { idemOpt =>
            entity(as[RunRequest]) { body =>
              if (!tenantOpt.exists(_.nonEmpty)) {
                complete(StatusCodes.Unauthorized, """{"error":"missing X-Tenant-Id"}""")
              } else if (!idemOpt.exists(_.nonEmpty)) {
                complete(StatusCodes.BadRequest, """{"error":"Idempotency-Key is required"}""")
              } else if (body.model_version.isEmpty) {
                complete(StatusCodes.BadRequest, """{"error":"model_version is required"}""")
              } else if (body.sample_budget < 1 || body.sample_budget > MaxSamples) {
                complete(StatusCodes.BadRequest, """{"error":"sample_budget must be 1..5000"}""")
              } else if (!datasets.exists(body.dataset_id)) {
                complete(StatusCodes.NotFound, """{"error":"unknown dataset"}""")
              } else {
                val tenant = tenantOpt.get
                val idemKey = idemOpt.get
                store.get(tenant, idemKey) match {
                  case Some(stored) =>
                    complete(StatusCodes.OK, stored)
                  case None =>
                    val run = Run(UUID.randomUUID().toString, body.dataset_id, body.model_version, body.sample_budget, "queued")
                    store.put(tenant, idemKey, run.toJson.compactPrint)
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

using json = nlohmann::json;

struct RunRequest {
  std::string dataset_id;
  std::string model_version;
  int sample_budget = 0;
};

void enqueue(const std::string& runId, const std::string& datasetId, const std::string& modelVersion) {}

std::string uuidString();

int main() {
  httplib::Server svr;

  svr.Post("/v1/evals/runs", [](const httplib::Request& req, httplib::Response& res) {
    const auto tenant = req.get_header_value("X-Tenant-Id");
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) {
      res.status = 400;
      res.set_content(R"({"error":"invalid json"})", "application/json");
      return;
    }
    // TODO: this draft accepts whatever dataset id the caller sends, caps nothing, queues before it
    // validates, and ignores Idempotency-Key, so a retry starts a second competing run.
    const auto runId = uuidString();
    enqueue(runId, body.value("dataset_id", std::string()), body.value("model_version", std::string()));
    std::cerr << "run started tenant=" << tenant << " run_id=" << runId << "\\n";
    res.status = 202;
    res.set_content(
        json{{"run_id", runId},
             {"status", "queued"},
             {"sample_budget", body.value("sample_budget", 0)},
             {"model_version", body.value("model_version", std::string())}}
            .dump(),
        "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <iostream>
#include <optional>
#include <string>

using json = nlohmann::json;

constexpr int kMaxSamples = 5000;

struct DatasetRegistry {
  bool exists(const std::string& datasetId);
};

struct RunStore {
  std::optional<json> get(const std::string& tenant, const std::string& idemKey);
  void put(const std::string& tenant, const std::string& idemKey, const json& run);
};

DatasetRegistry datasets;
RunStore store;
std::string uuidString();

int main() {
  httplib::Server svr;

  svr.Post("/v1/evals/runs", [](const httplib::Request& req, httplib::Response& res) {
    const auto tenant = req.get_header_value("X-Tenant-Id");
    if (tenant.empty()) {
      res.status = 401;
      res.set_content(R"({"error":"missing X-Tenant-Id"})", "application/json");
      return;
    }
    const auto idemKey = req.get_header_value("Idempotency-Key");
    if (idemKey.empty()) {
      res.status = 400;
      res.set_content(R"({"error":"Idempotency-Key is required"})", "application/json");
      return;
    }
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object() || !body.contains("dataset_id") || !body.contains("model_version")) {
      res.status = 400;
      res.set_content(R"({"error":"invalid run"})", "application/json");
      return;
    }
    const auto datasetId = body["dataset_id"].get<std::string>();
    const auto modelVersion = body["model_version"].get<std::string>();
    if (modelVersion.empty()) {
      res.status = 400;
      res.set_content(R"({"error":"model_version is required"})", "application/json");
      return;
    }
    const int budget = body.value("sample_budget", 0);
    if (budget < 1 || budget > kMaxSamples) {
      res.status = 400;
      res.set_content(R"({"error":"sample_budget must be 1..5000"})", "application/json");
      return;
    }
    if (!datasets.exists(datasetId)) {
      res.status = 404;
      res.set_content(R"({"error":"unknown dataset"})", "application/json");
      return;
    }
    const auto stored = store.get(tenant, idemKey);
    if (stored) {
      res.status = 200;
      res.set_content(stored->dump(), "application/json");
      return;
    }
    const json run = {
        {"run_id", uuidString()},
        {"dataset_id", datasetId},
        {"model_version", modelVersion},
        {"sample_budget", budget},
        {"status", "queued"},
    };
    store.put(tenant, idemKey, run);
    std::cerr << "run started tenant=" << tenant << " run_id=" << run["run_id"] << "\\n";
    res.status = 202;
    res.set_content(run.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  hints: [
    'Write the guard clauses first, in cost order: tenant, Idempotency-Key, model_version, sample_budget range, and only then the dataset lookup. Each one returns before the run is queued, so a rejected request can never leave a half-started eval behind.',
    'The registry lookup is the check that keeps the numbers honest: `datasets.exists(dataset_id)` before `store.put`. Without it, a typo in the CI job starts a run that scores nothing and reports `pending` forever — or worse, a green report over zero samples.',
    'The idempotency lookup is keyed by `(tenant, key)` and happens before the new run is written; a hit returns the stored run with `200`. Storing the run object — not just a request hash — is what lets the replay answer with the same `run_id` the first call returned.',
  ],
  debrief: `The interviewer is testing whether you can review a generated handler at the trust boundary, where a wrong acceptance is expensive rather than slow. The draft reads fine because the demo posts a known dataset, a sane budget and never retries. Four defects are being checked: authentication (the tenant is never optional), existence (a dataset id is a claim until the registry confirms it), caps (cheap rejections before expensive work), and idempotency keyed by tenant so the retry loop every CI client runs cannot start a competing run. Real harnesses add per-tenant dataset grants, a run state machine (\`queued\` → \`running\` → \`passed\`/\`failed\`), and a hashed request fingerprint so two different bodies under one key are rejected instead of silently replaying the first.`,
};
