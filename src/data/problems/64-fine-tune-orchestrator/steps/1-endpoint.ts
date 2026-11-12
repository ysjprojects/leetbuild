import type {Step} from '@/lib/types';

export const endpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/finetune/jobs: a recipe the registry can vouch for',
  concept: 'http',
  guides: ['request-boundaries', 'idempotent-requests'],
  file: 'api',
  focus: ['client', 'api', 'registry', 'redis'],
  task: `## Task

**Starting point.** The starter serves \`POST /v1/finetune/jobs\` with body \`{"base_model",
"dataset_version", "hyperparameters", "compute_budget"}\`: it answers 401 without \`X-Team-Id\`, looks the
model and the dataset version up in the provided \`registry\`, checks the hyperparameter names against a
fixed list, caps the budget at \`MAX_COMPUTE_BUDGET\`, stores a \`queued\` job with its \`dataset_sha256\`
and \`recipe.config_hash\` through \`store.put(team, job_id, job)\` and answers 201. It serves the demo and
hides 4 flaws.

**Failure mode the checks target.** A retired dataset version is still in the registry, so "it exists"
lets a job train on an export that was pulled for holding customer e-mail addresses. A fixed
hyperparameter list accepts \`lora_rank\` for a model trained without LoRA: the trainer ignores it and
the config hash promises a recipe that never ran. A budget of zero hours queues a job nobody can pay
for, and a client that retries after a timeout gets a second job.

Requirements:

- The dataset version must exist **and** have status \`registered\`; anything else is **400**.
- Every \`hyperparameters\` key must be in the base model's \`supported\` list; **400** otherwise.
- \`compute_budget\` is an integer from **1** to **10 000** GPU-hours; **400** otherwise.
- \`Idempotency-Key\` is required (**400** without it). The job is stored under \`(team, key)\`
  (\`store.put\`); a replay answers **200** with the stored job (\`store.get\`).`,
  sequence: {
    participants: ['Client', 'Fine-tune API', 'registry', 'job store'],
    messages: [
      {
        from: 'Client',
        to: 'Fine-tune API',
        label: 'POST /v1/finetune/jobs · X-Team-Id · Idempotency-Key',
        kind: 'sync',
      },
      {from: 'Fine-tune API', to: 'registry', label: 'get_base_model · get_dataset', kind: 'sync'},
      {from: 'registry', to: 'Fine-tune API', label: '{supported} · {sha256, status}', kind: 'reply'},
      {from: 'Fine-tune API', to: 'job store', label: 'get(team, key)', kind: 'sync'},
      {from: 'job store', to: 'Fine-tune API', label: 'stored job / none', kind: 'reply'},
      {from: 'Fine-tune API', to: 'job store', label: 'put(team, key, job)', kind: 'sync'},
      {from: 'Fine-tune API', to: 'Client', label: '201 {job_id, dataset_sha256, config_hash, …}', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Handles POST /v1/finetune/jobs',
      detail:
        'A valid submission answers 201 with the queued job (job_id, base_model, dataset_version, the registry\u2019s dataset_sha256, a config_hash, compute_budget) and stores it; without X-Team-Id it answers 401.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/finetune\/jobs["']/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/finetune\/jobs['"]/]},
        go: {all: [/HandleFunc\(\s*"POST \/v1\/finetune\/jobs"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"finetune"\s*\/\s*"jobs"\s*\)/, /\bpost\s*\{/]},
        cpp: {all: [/svr\.Post\(\s*"\/v1\/finetune\/jobs"/]},
      },
    },
    {
      id: 'registered-dataset',
      title: 'Trains only on a registered dataset version',
      detail:
        'A retired version (support-tickets@v2) or a version the registry does not know is 400 and stores nothing; a registered one is accepted with its sha256. The starter checks only that the registry knows the version.',
      match: {
        python: {all: [/["']registered["']/]},
        typescript: {all: [/["']registered["']/]},
        go: {all: [/"registered"/]},
        scala: {all: [/"registered"/]},
        cpp: {all: [/"registered"/]},
      },
    },
    {
      id: 'supported-hyperparameters',
      title: 'Accepts only the hyperparameters the base model supports',
      detail:
        'lora_rank for mistral-7b-v0.3 (a full fine-tune) is 400, and so is a name no model reads; the same block for llama-3.1-8b is accepted. The starter checks every model against one fixed list.',
      match: {
        python: {all: [/\[\s*["']supported["']\s*\]/], none: [/KNOWN_HYPERPARAMETERS/]},
        typescript: {all: [/\.supported\b/], none: [/KNOWN_HYPERPARAMETERS/]},
        go: {all: [/\.Supported\b/], none: [/knownHyperparameters/]},
        scala: {all: [/\.supported\b/], none: [/KnownHyperparameters/]},
        cpp: {all: [/\.supported\b|->supported\b/], none: [/kKnownHyperparameters/]},
      },
    },
    {
      id: 'positive-budget',
      title: 'Bounds compute_budget to 1..10000 GPU-hours',
      detail:
        'A budget of 0 or below is 400 and stores nothing; 1 and 10000 are accepted, 10001 is not. The starter checks only the upper bound.',
      match: {
        python: {all: [/MIN_COMPUTE_BUDGET/]},
        typescript: {all: [/MIN_COMPUTE_BUDGET/]},
        go: {all: [/minComputeBudget/]},
        scala: {all: [/MinComputeBudget/]},
        cpp: {all: [/kMinComputeBudget/]},
      },
    },
    {
      id: 'idempotency-key',
      title: 'Keys submissions by (team, Idempotency-Key)',
      detail:
        'Idempotency-Key is required (400 without it); a replay of the same (team, key) answers 200 with the same job_id and stores no second job, and another team with the same key gets its own job. The starter stores each job under its fresh id, so every retry is a new job.',
      match: {
        python: {all: [/Idempotency-Key/i, /store\.get\(\s*team\s*,/, /store\.put\(\s*team\s*,\s*idem/]},
        typescript: {all: [/idempotency-key/i, /store\.get\(\s*team\s*,/, /store\.put\(\s*team\s*,\s*idem/]},
        go: {
          all: [/Idempotency-Key/, /jobs\.Get\(\s*[\w.()]+,\s*team\s*,/, /jobs\.Put\(\s*[\w.()]+,\s*team\s*,\s*idem/],
        },
        scala: {all: [/Idempotency-Key/, /Jobs\.get\(\s*team\s*,/, /Jobs\.put\(\s*team\s*,\s*idem/]},
        cpp: {all: [/Idempotency-Key/, /jobs::get\(\s*team\s*,/, /jobs::put\(\s*team\s*,\s*idem/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import logging
import uuid
from typing import Dict

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from finetune import registry
from finetune.jobs import store
from finetune.recipe import config_hash

app = FastAPI()
logger = logging.getLogger("finetune.api")

MAX_COMPUTE_BUDGET = 10_000
# The hyperparameters a fine-tune recipe reads.
KNOWN_HYPERPARAMETERS = {"learning_rate", "lora_rank", "lora_alpha", "epochs", "batch_size"}


class JobRequest(BaseModel):
    base_model: str
    dataset_version: str
    hyperparameters: Dict[str, float]
    compute_budget: int


def reject(status: int, error: str) -> JSONResponse:
    return JSONResponse({"error": error}, status_code=status)


@app.post("/v1/finetune/jobs")
def submit_job(body: JobRequest, request: Request) -> JSONResponse:
    # TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
    team = request.headers.get("X-Team-Id", "")
    if team == "":
        return reject(401, "missing X-Team-Id")
    model = registry.get_base_model(body.base_model)
    if model is None:
        return reject(400, "base_model is not in the registry")
    dataset = registry.get_dataset(body.dataset_version)
    if dataset is None:
        return reject(400, "dataset_version is not in the registry")
    unknown = sorted(set(body.hyperparameters) - KNOWN_HYPERPARAMETERS)
    if unknown:
        return reject(400, f"unknown hyperparameters: {unknown}")
    if body.compute_budget > MAX_COMPUTE_BUDGET:
        return reject(400, f"compute_budget is at most {MAX_COMPUTE_BUDGET} GPU-hours")

    job = {
        "job_id": str(uuid.uuid4()),
        "team": team,
        "status": "queued",
        "base_model": model["id"],
        "dataset_version": dataset["id"],
        "dataset_sha256": dataset["sha256"],
        "config_hash": config_hash(model["id"], dataset["sha256"], body.hyperparameters),
        "hyperparameters": body.hyperparameters,
        "compute_budget": body.compute_budget,
        "checkpoint_ids": [],
    }
    store.put(team, job["job_id"], job)
    logger.info("finetune job=%s team=%s base=%s", job["job_id"], team, model["id"])
    return JSONResponse(job, status_code=201)
`,
      solution: `import logging
import uuid
from typing import Dict

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from finetune import registry
from finetune.jobs import store
from finetune.recipe import config_hash

app = FastAPI()
logger = logging.getLogger("finetune.api")

MIN_COMPUTE_BUDGET = 1
MAX_COMPUTE_BUDGET = 10_000


class JobRequest(BaseModel):
    base_model: str
    dataset_version: str
    hyperparameters: Dict[str, float]
    compute_budget: int


def reject(status: int, error: str) -> JSONResponse:
    return JSONResponse({"error": error}, status_code=status)


@app.post("/v1/finetune/jobs")
def submit_job(body: JobRequest, request: Request) -> JSONResponse:
    team = request.headers.get("X-Team-Id", "")
    if team == "":
        return reject(401, "missing X-Team-Id")
    idem_key = request.headers.get("Idempotency-Key", "")
    if idem_key == "":
        return reject(400, "Idempotency-Key is required")
    model = registry.get_base_model(body.base_model)
    if model is None:
        return reject(400, "base_model is not in the registry")
    dataset = registry.get_dataset(body.dataset_version)
    if dataset is None or dataset["status"] != "registered":
        return reject(400, "dataset_version is not a registered dataset version")
    unsupported = sorted(set(body.hyperparameters) - set(model["supported"]))
    if unsupported:
        return reject(400, f"{model['id']} does not support {unsupported}")
    if not MIN_COMPUTE_BUDGET <= body.compute_budget <= MAX_COMPUTE_BUDGET:
        return reject(400, f"compute_budget must be {MIN_COMPUTE_BUDGET}..{MAX_COMPUTE_BUDGET} GPU-hours")

    stored = store.get(team, idem_key)
    if stored is not None:
        return JSONResponse(stored, status_code=200)

    job = {
        "job_id": str(uuid.uuid4()),
        "team": team,
        "status": "queued",
        "base_model": model["id"],
        "dataset_version": dataset["id"],
        "dataset_sha256": dataset["sha256"],
        "config_hash": config_hash(model["id"], dataset["sha256"], body.hyperparameters),
        "hyperparameters": body.hyperparameters,
        "compute_budget": body.compute_budget,
        "checkpoint_ids": [],
    }
    store.put(team, idem_key, job)
    logger.info("finetune job=%s team=%s base=%s", job["job_id"], team, model["id"])
    return JSONResponse(job, status_code=201)
`,
    },
    typescript: {
      starter: `import {randomUUID} from 'node:crypto';

import Fastify from 'fastify';

import {type Job, store} from 'finetune/jobs';
import {configHash} from 'finetune/recipe';
import {registry} from 'finetune/registry';

export const app = Fastify();

export const MAX_COMPUTE_BUDGET = 10_000;
/** The hyperparameters a fine-tune recipe reads. */
export const KNOWN_HYPERPARAMETERS = ['learning_rate', 'lora_rank', 'lora_alpha', 'epochs', 'batch_size'];

interface JobBody {
  base_model: string;
  dataset_version: string;
  hyperparameters: Record<string, number>;
  compute_budget: number;
}

app.post('/v1/finetune/jobs', async (request, reply) => {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  const team = request.headers['x-team-id'];
  if (typeof team !== 'string' || team === '') return reply.code(401).send({error: 'missing X-Team-Id'});
  const body = request.body as JobBody;
  const model = registry.getBaseModel(body.base_model);
  if (model === null) return reply.code(400).send({error: 'base_model is not in the registry'});
  const dataset = registry.getDataset(body.dataset_version);
  if (dataset === null) return reply.code(400).send({error: 'dataset_version is not in the registry'});
  const hyperparameters = body.hyperparameters ?? {};
  const unknown = Object.keys(hyperparameters).filter(name => !KNOWN_HYPERPARAMETERS.includes(name));
  if (unknown.length > 0) return reply.code(400).send({error: \`unknown hyperparameters: \${unknown.join(', ')}\`});
  if (!Number.isInteger(body.compute_budget) || body.compute_budget > MAX_COMPUTE_BUDGET)
    return reply.code(400).send({error: \`compute_budget is an integer of at most \${MAX_COMPUTE_BUDGET} GPU-hours\`});

  const job: Job = {
    job_id: randomUUID(),
    team,
    status: 'queued',
    base_model: model.id,
    dataset_version: dataset.id,
    dataset_sha256: dataset.sha256,
    config_hash: configHash(model.id, dataset.sha256, hyperparameters),
    hyperparameters,
    compute_budget: body.compute_budget,
    checkpoint_ids: [],
  };
  await store.put(team, job.job_id, job);
  request.log.info({team, job_id: job.job_id, base_model: model.id}, 'finetune job queued');
  return reply.code(201).send(job);
});
`,
      solution: `import {randomUUID} from 'node:crypto';

import Fastify from 'fastify';

import {type Job, store} from 'finetune/jobs';
import {configHash} from 'finetune/recipe';
import {registry} from 'finetune/registry';

export const app = Fastify();

export const MIN_COMPUTE_BUDGET = 1;
export const MAX_COMPUTE_BUDGET = 10_000;

interface JobBody {
  base_model: string;
  dataset_version: string;
  hyperparameters: Record<string, number>;
  compute_budget: number;
}

app.post('/v1/finetune/jobs', async (request, reply) => {
  const team = request.headers['x-team-id'];
  if (typeof team !== 'string' || team === '') return reply.code(401).send({error: 'missing X-Team-Id'});
  const idemKey = request.headers['idempotency-key'];
  if (typeof idemKey !== 'string' || idemKey === '') return reply.code(400).send({error: 'Idempotency-Key is required'});
  const body = request.body as JobBody;
  const model = registry.getBaseModel(body.base_model);
  if (model === null) return reply.code(400).send({error: 'base_model is not in the registry'});
  const dataset = registry.getDataset(body.dataset_version);
  if (dataset === null || dataset.status !== 'registered')
    return reply.code(400).send({error: 'dataset_version is not a registered dataset version'});
  const hyperparameters = body.hyperparameters ?? {};
  const unsupported = Object.keys(hyperparameters).filter(name => !model.supported.includes(name));
  if (unsupported.length > 0) return reply.code(400).send({error: \`\${model.id} does not support \${unsupported.join(', ')}\`});
  const budget = body.compute_budget;
  if (!Number.isInteger(budget) || budget < MIN_COMPUTE_BUDGET || budget > MAX_COMPUTE_BUDGET)
    return reply.code(400).send({error: \`compute_budget must be \${MIN_COMPUTE_BUDGET}..\${MAX_COMPUTE_BUDGET} GPU-hours\`});

  const stored = await store.get(team, idemKey);
  if (stored !== null) return reply.code(200).send(stored);

  const job: Job = {
    job_id: randomUUID(),
    team,
    status: 'queued',
    base_model: model.id,
    dataset_version: dataset.id,
    dataset_sha256: dataset.sha256,
    config_hash: configHash(model.id, dataset.sha256, hyperparameters),
    hyperparameters,
    compute_budget: budget,
    checkpoint_ids: [],
  };
  await store.put(team, idemKey, job);
  request.log.info({team, job_id: job.job_id, base_model: model.id}, 'finetune job queued');
  return reply.code(201).send(job);
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

	"finetune/jobs"     // jobs.Job, jobs.Get(ctx, team, key), jobs.Put(ctx, team, key, job) — provided
	"finetune/recipe"   // recipe.ConfigHash(baseModel, datasetSHA256, hyperparameters) — provided
	"finetune/registry" // registry.GetBaseModel(name), registry.GetDataset(version) — provided
)

const maxComputeBudget = 10_000

// knownHyperparameters are the hyperparameters a fine-tune recipe reads.
var knownHyperparameters = map[string]bool{"learning_rate": true, "lora_rank": true, "lora_alpha": true, "epochs": true, "batch_size": true}

type JobRequest struct {
	BaseModel       string             \`json:"base_model"\`
	DatasetVersion  string             \`json:"dataset_version"\`
	Hyperparameters map[string]float64 \`json:"hyperparameters"\`
	ComputeBudget   int                \`json:"compute_budget"\`
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func reject(rw http.ResponseWriter, status int, message string) {
	writeJSON(rw, status, map[string]string{"error": message})
}

func submitJob(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
	team := r.Header.Get("X-Team-Id")
	if team == "" {
		reject(rw, http.StatusUnauthorized, "missing X-Team-Id")
		return
	}
	var body JobRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		reject(rw, http.StatusBadRequest, "invalid json")
		return
	}
	model, ok := registry.GetBaseModel(body.BaseModel)
	if !ok {
		reject(rw, http.StatusBadRequest, "base_model is not in the registry")
		return
	}
	dataset, ok := registry.GetDataset(body.DatasetVersion)
	if !ok {
		reject(rw, http.StatusBadRequest, "dataset_version is not in the registry")
		return
	}
	for name := range body.Hyperparameters {
		if !knownHyperparameters[name] {
			reject(rw, http.StatusBadRequest, "unknown hyperparameter: "+name)
			return
		}
	}
	if body.ComputeBudget > maxComputeBudget {
		reject(rw, http.StatusBadRequest, "compute_budget is at most 10000 GPU-hours")
		return
	}

	job := jobs.Job{
		JobID:           uuid.NewString(),
		Team:            team,
		Status:          "queued",
		BaseModel:       model.ID,
		DatasetVersion:  dataset.ID,
		DatasetSHA256:   dataset.SHA256,
		ConfigHash:      recipe.ConfigHash(model.ID, dataset.SHA256, body.Hyperparameters),
		Hyperparameters: body.Hyperparameters,
		ComputeBudget:   body.ComputeBudget,
		CheckpointIDs:   []string{},
	}
	if err := jobs.Put(r.Context(), team, job.JobID, job); err != nil {
		reject(rw, http.StatusServiceUnavailable, "TRY_AGAIN")
		return
	}
	log.Printf("finetune job=%s team=%s base=%s", job.JobID, team, model.ID)
	writeJSON(rw, http.StatusCreated, job)
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/finetune/jobs", submitJob)
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

	"finetune/jobs"     // jobs.Job, jobs.Get(ctx, team, key), jobs.Put(ctx, team, key, job) — provided
	"finetune/recipe"   // recipe.ConfigHash(baseModel, datasetSHA256, hyperparameters) — provided
	"finetune/registry" // registry.GetBaseModel(name), registry.GetDataset(version) — provided
)

const (
	minComputeBudget = 1
	maxComputeBudget = 10_000
)

type JobRequest struct {
	BaseModel       string             \`json:"base_model"\`
	DatasetVersion  string             \`json:"dataset_version"\`
	Hyperparameters map[string]float64 \`json:"hyperparameters"\`
	ComputeBudget   int                \`json:"compute_budget"\`
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func reject(rw http.ResponseWriter, status int, message string) {
	writeJSON(rw, status, map[string]string{"error": message})
}

func submitJob(rw http.ResponseWriter, r *http.Request) {
	team := r.Header.Get("X-Team-Id")
	if team == "" {
		reject(rw, http.StatusUnauthorized, "missing X-Team-Id")
		return
	}
	idemKey := r.Header.Get("Idempotency-Key")
	if idemKey == "" {
		reject(rw, http.StatusBadRequest, "Idempotency-Key is required")
		return
	}
	var body JobRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		reject(rw, http.StatusBadRequest, "invalid json")
		return
	}
	model, ok := registry.GetBaseModel(body.BaseModel)
	if !ok {
		reject(rw, http.StatusBadRequest, "base_model is not in the registry")
		return
	}
	dataset, ok := registry.GetDataset(body.DatasetVersion)
	if !ok || dataset.Status != "registered" {
		reject(rw, http.StatusBadRequest, "dataset_version is not a registered dataset version")
		return
	}
	supported := map[string]bool{}
	for _, name := range model.Supported {
		supported[name] = true
	}
	for name := range body.Hyperparameters {
		if !supported[name] {
			reject(rw, http.StatusBadRequest, model.ID+" does not support "+name)
			return
		}
	}
	if body.ComputeBudget < minComputeBudget || body.ComputeBudget > maxComputeBudget {
		reject(rw, http.StatusBadRequest, "compute_budget must be 1..10000 GPU-hours")
		return
	}

	stored, err := jobs.Get(r.Context(), team, idemKey)
	if err != nil {
		reject(rw, http.StatusServiceUnavailable, "TRY_AGAIN")
		return
	}
	if stored != nil {
		writeJSON(rw, http.StatusOK, stored)
		return
	}

	job := jobs.Job{
		JobID:           uuid.NewString(),
		Team:            team,
		Status:          "queued",
		BaseModel:       model.ID,
		DatasetVersion:  dataset.ID,
		DatasetSHA256:   dataset.SHA256,
		ConfigHash:      recipe.ConfigHash(model.ID, dataset.SHA256, body.Hyperparameters),
		Hyperparameters: body.Hyperparameters,
		ComputeBudget:   body.ComputeBudget,
		CheckpointIDs:   []string{},
	}
	if err := jobs.Put(r.Context(), team, idemKey, job); err != nil {
		reject(rw, http.StatusServiceUnavailable, "TRY_AGAIN")
		return
	}
	log.Printf("finetune job=%s team=%s base=%s", job.JobID, team, model.ID)
	writeJSON(rw, http.StatusCreated, job)
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/finetune/jobs", submitJob)
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

import finetune.{Job, Jobs, Recipe, Registry}

final case class JobRequest(base_model: String, dataset_version: String, hyperparameters: Map[String, Double], compute_budget: Int)

object FinetuneApi {
  implicit val system: ActorSystem = ActorSystem("finetune-api")
  implicit val requestFormat: RootJsonFormat[JobRequest] = jsonFormat4(JobRequest)
  implicit val jobFormat: RootJsonFormat[Job] = jsonFormat10(Job)

  val MaxComputeBudget = 10000
  /** The hyperparameters a fine-tune recipe reads. */
  val KnownHyperparameters = Set("learning_rate", "lora_rank", "lora_alpha", "epochs", "batch_size")

  private def reject(error: String): Route =
    complete(StatusCodes.BadRequest, ujson.write(ujson.Obj("error" -> error)))

  val route: Route =
    path("v1" / "finetune" / "jobs") {
      post {
        optionalHeaderValueByName("X-Team-Id") { teamOpt =>
          entity(as[JobRequest]) { body =>
            // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
            val model = Registry.getBaseModel(body.base_model)
            val dataset = Registry.getDataset(body.dataset_version)
            if (!teamOpt.exists(_.nonEmpty)) complete(StatusCodes.Unauthorized, """{"error":"missing X-Team-Id"}""")
            else if (model.isEmpty) reject("base_model is not in the registry")
            else if (dataset.isEmpty) reject("dataset_version is not in the registry")
            else if (!body.hyperparameters.keySet.subsetOf(KnownHyperparameters)) reject("unknown hyperparameters")
            else if (body.compute_budget > MaxComputeBudget) reject("compute_budget is at most 10000 GPU-hours")
            else {
              val team = teamOpt.get
              val job = Job(
                UUID.randomUUID().toString,
                team,
                "queued",
                model.get.id,
                dataset.get.id,
                dataset.get.sha256,
                Recipe.configHash(model.get.id, dataset.get.sha256, body.hyperparameters),
                body.hyperparameters,
                body.compute_budget,
                Nil
              )
              Jobs.put(team, job.job_id, job)
              system.log.info(s"finetune job=\${job.job_id} team=$team base=\${job.base_model}")
              complete(StatusCodes.Created, job)
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

import finetune.{Job, Jobs, Recipe, Registry}

final case class JobRequest(base_model: String, dataset_version: String, hyperparameters: Map[String, Double], compute_budget: Int)

object FinetuneApi {
  implicit val system: ActorSystem = ActorSystem("finetune-api")
  implicit val requestFormat: RootJsonFormat[JobRequest] = jsonFormat4(JobRequest)
  implicit val jobFormat: RootJsonFormat[Job] = jsonFormat10(Job)

  val MinComputeBudget = 1
  val MaxComputeBudget = 10000

  private def reject(error: String): Route =
    complete(StatusCodes.BadRequest, ujson.write(ujson.Obj("error" -> error)))

  val route: Route =
    path("v1" / "finetune" / "jobs") {
      post {
        optionalHeaderValueByName("X-Team-Id") { teamOpt =>
          optionalHeaderValueByName("Idempotency-Key") { idemOpt =>
            entity(as[JobRequest]) { body =>
              val model = Registry.getBaseModel(body.base_model)
              val dataset = Registry.getDataset(body.dataset_version).filter(_.status == "registered")
              if (!teamOpt.exists(_.nonEmpty)) complete(StatusCodes.Unauthorized, """{"error":"missing X-Team-Id"}""")
              else if (!idemOpt.exists(_.nonEmpty)) reject("Idempotency-Key is required")
              else if (model.isEmpty) reject("base_model is not in the registry")
              else if (dataset.isEmpty) reject("dataset_version is not a registered dataset version")
              else if (!body.hyperparameters.keySet.subsetOf(model.get.supported)) reject(s"\${model.get.id} does not support every hyperparameter")
              else if (body.compute_budget < MinComputeBudget || body.compute_budget > MaxComputeBudget)
                reject("compute_budget must be 1..10000 GPU-hours")
              else {
                val team = teamOpt.get
                val idemKey = idemOpt.get
                Jobs.get(team, idemKey) match {
                  case Some(stored) => complete(StatusCodes.OK, stored)
                  case None =>
                    val job = Job(
                      UUID.randomUUID().toString,
                      team,
                      "queued",
                      model.get.id,
                      dataset.get.id,
                      dataset.get.sha256,
                      Recipe.configHash(model.get.id, dataset.get.sha256, body.hyperparameters),
                      body.hyperparameters,
                      body.compute_budget,
                      Nil
                    )
                    Jobs.put(team, idemKey, job)
                    system.log.info(s"finetune job=\${job.job_id} team=$team base=\${job.base_model}")
                    complete(StatusCodes.Created, job)
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
#include <set>
#include <string>

#include "finetune/jobs.h"      // jobs::get(team, key), jobs::put(team, key, job) — provided
#include "finetune/recipe.h"    // recipe::config_hash(base_model, dataset_sha256, hyperparameters) — provided
#include "finetune/registry.h"  // registry::get_base_model(name), registry::get_dataset(version) — provided
#include "ids.h"                // new_uuid() — provided

using json = nlohmann::json;

constexpr long long kMaxComputeBudget = 10000;
// The hyperparameters a fine-tune recipe reads.
const std::set<std::string> kKnownHyperparameters = {"learning_rate", "lora_rank", "lora_alpha", "epochs", "batch_size"};

void reject(httplib::Response& res, int status, const std::string& error) {
  res.status = status;
  res.set_content(json({{"error", error}}).dump(), "application/json");
}

void submit_job(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  const std::string team = req.get_header_value("X-Team-Id");
  if (team.empty()) return reject(res, 401, "missing X-Team-Id");
  const json body = json::parse(req.body, nullptr, false);
  if (!body.is_object()) return reject(res, 400, "invalid json");
  const auto model = registry::get_base_model(body.value("base_model", std::string()));
  if (!model) return reject(res, 400, "base_model is not in the registry");
  const auto dataset = registry::get_dataset(body.value("dataset_version", std::string()));
  if (!dataset) return reject(res, 400, "dataset_version is not in the registry");
  const json hyperparameters = body.value("hyperparameters", json::object());
  for (const auto& [name, value] : hyperparameters.items()) {
    if (kKnownHyperparameters.find(name) == kKnownHyperparameters.end()) return reject(res, 400, "unknown hyperparameter: " + name);
  }
  if (!body.contains("compute_budget") || !body["compute_budget"].is_number_integer()) return reject(res, 400, "compute_budget is an integer");
  const long long compute_budget = body["compute_budget"].get<long long>();
  if (compute_budget > kMaxComputeBudget) return reject(res, 400, "compute_budget is at most 10000 GPU-hours");

  const json job = {
      {"job_id", new_uuid()},
      {"team", team},
      {"status", "queued"},
      {"base_model", model->id},
      {"dataset_version", dataset->id},
      {"dataset_sha256", dataset->sha256},
      {"config_hash", recipe::config_hash(model->id, dataset->sha256, hyperparameters)},
      {"hyperparameters", hyperparameters},
      {"compute_budget", compute_budget},
      {"checkpoint_ids", json::array()},
  };
  jobs::put(team, job["job_id"].get<std::string>(), job);
  std::cerr << "finetune job=" << job["job_id"] << " team=" << team << " base=" << model->id << "\\n";
  res.status = 201;
  res.set_content(job.dump(), "application/json");
}

void register_routes(httplib::Server& svr) { svr.Post("/v1/finetune/jobs", submit_job); }

int main() {
  httplib::Server svr;
  register_routes(svr);
  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <algorithm>
#include <iostream>
#include <string>

#include "finetune/jobs.h"      // jobs::get(team, key), jobs::put(team, key, job) — provided
#include "finetune/recipe.h"    // recipe::config_hash(base_model, dataset_sha256, hyperparameters) — provided
#include "finetune/registry.h"  // registry::get_base_model(name), registry::get_dataset(version) — provided
#include "ids.h"                // new_uuid() — provided

using json = nlohmann::json;

constexpr long long kMinComputeBudget = 1;
constexpr long long kMaxComputeBudget = 10000;

void reject(httplib::Response& res, int status, const std::string& error) {
  res.status = status;
  res.set_content(json({{"error", error}}).dump(), "application/json");
}

void submit_job(const httplib::Request& req, httplib::Response& res) {
  const std::string team = req.get_header_value("X-Team-Id");
  if (team.empty()) return reject(res, 401, "missing X-Team-Id");
  const std::string idem_key = req.get_header_value("Idempotency-Key");
  if (idem_key.empty()) return reject(res, 400, "Idempotency-Key is required");
  const json body = json::parse(req.body, nullptr, false);
  if (!body.is_object()) return reject(res, 400, "invalid json");
  const auto model = registry::get_base_model(body.value("base_model", std::string()));
  if (!model) return reject(res, 400, "base_model is not in the registry");
  const auto dataset = registry::get_dataset(body.value("dataset_version", std::string()));
  if (!dataset || dataset->status != "registered") return reject(res, 400, "dataset_version is not a registered dataset version");
  const json hyperparameters = body.value("hyperparameters", json::object());
  for (const auto& [name, value] : hyperparameters.items()) {
    if (std::find(model->supported.begin(), model->supported.end(), name) == model->supported.end())
      return reject(res, 400, model->id + " does not support " + name);
  }
  if (!body.contains("compute_budget") || !body["compute_budget"].is_number_integer()) return reject(res, 400, "compute_budget is an integer");
  const long long compute_budget = body["compute_budget"].get<long long>();
  if (compute_budget < kMinComputeBudget || compute_budget > kMaxComputeBudget)
    return reject(res, 400, "compute_budget must be 1..10000 GPU-hours");

  if (const auto stored = jobs::get(team, idem_key)) {
    res.status = 200;
    res.set_content(stored->dump(), "application/json");
    return;
  }
  const json job = {
      {"job_id", new_uuid()},
      {"team", team},
      {"status", "queued"},
      {"base_model", model->id},
      {"dataset_version", dataset->id},
      {"dataset_sha256", dataset->sha256},
      {"config_hash", recipe::config_hash(model->id, dataset->sha256, hyperparameters)},
      {"hyperparameters", hyperparameters},
      {"compute_budget", compute_budget},
      {"checkpoint_ids", json::array()},
  };
  jobs::put(team, idem_key, job);
  std::cerr << "finetune job=" << job["job_id"] << " team=" << team << " base=" << model->id << "\\n";
  res.status = 201;
  res.set_content(job.dump(), "application/json");
}

void register_routes(httplib::Server& svr) { svr.Post("/v1/finetune/jobs", submit_job); }

int main() {
  httplib::Server svr;
  register_routes(svr);
  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  harness: {
    python: `import re

V3_SHA = "b108b116b5f56ba4df62e748a011bf05de20e7c8756e0c18471ff5d04ca29031"
LEGAL_SHA = "06e8599cc710041a091e9b7278ce26cf29e740a60cd3bbe8544805004264cabc"
GOOD = {
    "base_model": "llama-3.1-8b",
    "dataset_version": "support-tickets@v3",
    "hyperparameters": {"learning_rate": 0.0002, "lora_rank": 16, "epochs": 3},
    "compute_budget": 400,
}


def _api(ctx):
    return ctx.client(ctx.load("api").app)


async def _post(c, body, key="k-1", team="ml-search", with_key=True):
    headers = {"X-Team-Id": team}
    if with_key:
        headers["Idempotency-Key"] = key
    return await c.post("/v1/finetune/jobs", json=body, headers=headers)


def _jobs(ctx):
    return sorted(ctx.redis.keys("ft:job:*"))


async def check_route(ctx):
    async with _api(ctx) as c:
        r = await _post(c, GOOD)
        assert r.status_code == 201, f"a valid submission answered {r.status_code}: {r.text}"
        job = r.json()
        for key in ("job_id", "status", "base_model", "dataset_version", "dataset_sha256", "config_hash", "hyperparameters", "compute_budget"):
            assert key in job, f"the 201 body lacks {key!r}: {job}"
        assert job["status"] == "queued" and job["base_model"] == "llama-3.1-8b" and job["dataset_version"] == "support-tickets@v3" and job["compute_budget"] == 400, f"the job echoes the request with status queued: {job}"
        assert job["dataset_sha256"] == V3_SHA, f"dataset_sha256 must be the registry's hash of support-tickets@v3, got {job['dataset_sha256']!r}"
        assert re.fullmatch(r"[0-9a-f]{64}", job["config_hash"] or ""), f"config_hash must be recipe.config_hash's SHA-256 hex, got {job['config_hash']!r}"
        assert ctx.redis.hget(f"ft:job:{job['job_id']}", "team") == "ml-search", f"the job must be in the job store (ft:job:{{id}}) with its team: keys {_jobs(ctx)}"
        r = await c.post("/v1/finetune/jobs", json=GOOD, headers={"Idempotency-Key": "k-2"})
        assert r.status_code == 401, f"without X-Team-Id the submission must answer 401, got {r.status_code}"


async def check_registered_dataset(ctx):
    async with _api(ctx) as c:
        r = await _post(c, {**GOOD, "dataset_version": "support-tickets@v2"}, key="k-retired")
        assert r.status_code == 400, f"support-tickets@v2 is retired (it held customer e-mail addresses) and the submission answered {r.status_code}: a job must train only on a registered version"
        r = await _post(c, {**GOOD, "dataset_version": "s3://exports/tickets-final.jsonl"}, key="k-path")
        assert r.status_code == 400, f"a path the registry does not know answered {r.status_code}, expected 400"
        assert _jobs(ctx) == [], f"a refused dataset must store no job, found {_jobs(ctx)}"
        r = await _post(c, {**GOOD, "dataset_version": "legal-qa@v1"}, key="k-legal")
        assert r.status_code == 201, f"legal-qa@v1 is registered, got {r.status_code}: {r.text}"
        assert r.json()["dataset_sha256"] == LEGAL_SHA, f"the job carries the registry's sha256 of legal-qa@v1, got {r.json()['dataset_sha256']!r}"


async def check_supported_hyperparameters(ctx):
    async with _api(ctx) as c:
        mistral = {**GOOD, "base_model": "mistral-7b-v0.3"}
        r = await _post(c, mistral, key="k-mistral-lora")
        assert r.status_code == 400, f"mistral-7b-v0.3 is a full fine-tune and does not read lora_rank, yet the submission answered {r.status_code}: the trainer would ignore it and the config hash would describe a recipe that never ran"
        r = await _post(c, {**GOOD, "hyperparameters": {"learning_rate": 0.0002, "warmup_ratio": 0.1}}, key="k-warmup")
        assert r.status_code == 400, f"warmup_ratio is supported by no base model, got {r.status_code}"
        assert _jobs(ctx) == [], f"refused hyperparameters must store no job, found {_jobs(ctx)}"
        r = await _post(c, {**mistral, "hyperparameters": {"learning_rate": 0.00001, "epochs": 2}}, key="k-mistral")
        assert r.status_code == 201, f"learning_rate and epochs are in mistral-7b-v0.3's supported list, got {r.status_code}: {r.text}"
        r = await _post(c, GOOD, key="k-llama")
        assert r.status_code == 201, f"lora_rank is in llama-3.1-8b's supported list, got {r.status_code}: {r.text}"


async def check_positive_budget(ctx):
    async with _api(ctx) as c:
        for budget in (0, -5, 10_001):
            r = await _post(c, {**GOOD, "compute_budget": budget}, key=f"k-{budget}")
            assert r.status_code == 400, f"compute_budget={budget} answered {r.status_code}, expected 400 (1..10000 GPU-hours)"
        assert _jobs(ctx) == [], f"refused budgets must store no job, found {_jobs(ctx)}"
        for budget in (1, 10_000):
            r = await _post(c, {**GOOD, "compute_budget": budget}, key=f"k-{budget}")
            assert r.status_code == 201, f"compute_budget={budget} is within 1..10000, got {r.status_code}: {r.text}"


async def check_idempotency_key(ctx):
    async with _api(ctx) as c:
        r = await _post(c, GOOD, with_key=False)
        assert r.status_code == 400, f"a submission without Idempotency-Key answered {r.status_code}, expected 400"
        first = await _post(c, GOOD, key="k-7")
        assert first.status_code == 201, f"the first submission answered {first.status_code}: {first.text}"
        replay = await _post(c, GOOD, key="k-7")
        assert replay.status_code == 200, f"a replay of the same (team, Idempotency-Key) answered {replay.status_code}, expected 200 with the stored job: the client timed out and retried, it must not get a second job"
        assert replay.json()["job_id"] == first.json()["job_id"], f"the replay must answer the same job: got {replay.json()['job_id']}, the first made {first.json()['job_id']}"
        assert len(_jobs(ctx)) == 1, f"one key, one job: the store holds {len(_jobs(ctx))} jobs after a submission and its replay"
        other = await _post(c, GOOD, key="k-7", team="ml-legal")
        assert other.status_code == 201 and other.json()["job_id"] != first.json()["job_id"], "another team reusing the key gets its own job (keys are per team)"
`,
    typescript: `const V3_SHA = 'b108b116b5f56ba4df62e748a011bf05de20e7c8756e0c18471ff5d04ca29031';
const LEGAL_SHA = '06e8599cc710041a091e9b7278ce26cf29e740a60cd3bbe8544805004264cabc';
const GOOD = {
  base_model: 'llama-3.1-8b',
  dataset_version: 'support-tickets@v3',
  hyperparameters: {learning_rate: 0.0002, lora_rank: 16, epochs: 3},
  compute_budget: 400,
};

const api = ctx => ctx.client(ctx.load('api').app);

async function post(c, body, {key = 'k-1', team = 'ml-search', withKey = true} = {}) {
  const headers: Record<string, string> = {'X-Team-Id': team};
  if (withKey) headers['Idempotency-Key'] = key;
  return c.post('/v1/finetune/jobs', {body, headers});
}

const jobKeys = ctx => ctx.redis.keys('ft:job:*').sort();

export async function check_route(ctx) {
  const c = api(ctx);
  const r = await post(c, GOOD);
  assert.equal(r.status, 201, \`a valid submission answered \${r.status}: \${r.text}\`);
  const job = r.json();
  for (const key of ['job_id', 'status', 'base_model', 'dataset_version', 'dataset_sha256', 'config_hash', 'hyperparameters', 'compute_budget'])
    assert(key in job, \`the 201 body lacks \${key}: \${r.text}\`);
  assert(job.status === 'queued' && job.base_model === 'llama-3.1-8b' && job.dataset_version === 'support-tickets@v3' && job.compute_budget === 400, \`the job echoes the request with status queued: \${r.text}\`);
  assert.equal(job.dataset_sha256, V3_SHA, \`dataset_sha256 must be the registry's hash of support-tickets@v3, got \${job.dataset_sha256}\`);
  assert(/^[0-9a-f]{64}$/.test(job.config_hash ?? ''), \`config_hash must be configHash's SHA-256 hex, got \${job.config_hash}\`);
  assert.equal(ctx.redis.hget(\`ft:job:\${job.job_id}\`, 'team'), 'ml-search', \`the job must be in the job store (ft:job:{id}) with its team: keys \${JSON.stringify(jobKeys(ctx))}\`);
  const noTeam = await c.post('/v1/finetune/jobs', {body: GOOD, headers: {'Idempotency-Key': 'k-2'}});
  assert.equal(noTeam.status, 401, \`without X-Team-Id the submission must answer 401, got \${noTeam.status}\`);
}

export async function check_registered_dataset(ctx) {
  const c = api(ctx);
  let r = await post(c, {...GOOD, dataset_version: 'support-tickets@v2'}, {key: 'k-retired'});
  assert.equal(r.status, 400, \`support-tickets@v2 is retired (it held customer e-mail addresses) and the submission answered \${r.status}: a job must train only on a registered version\`);
  r = await post(c, {...GOOD, dataset_version: 's3://exports/tickets-final.jsonl'}, {key: 'k-path'});
  assert.equal(r.status, 400, \`a path the registry does not know answered \${r.status}, expected 400\`);
  assert.deepEqual(jobKeys(ctx), [], \`a refused dataset must store no job, found \${JSON.stringify(jobKeys(ctx))}\`);
  r = await post(c, {...GOOD, dataset_version: 'legal-qa@v1'}, {key: 'k-legal'});
  assert.equal(r.status, 201, \`legal-qa@v1 is registered, got \${r.status}: \${r.text}\`);
  assert.equal(r.json().dataset_sha256, LEGAL_SHA, \`the job carries the registry's sha256 of legal-qa@v1, got \${r.json().dataset_sha256}\`);
}

export async function check_supported_hyperparameters(ctx) {
  const c = api(ctx);
  const mistral = {...GOOD, base_model: 'mistral-7b-v0.3'};
  let r = await post(c, mistral, {key: 'k-mistral-lora'});
  assert.equal(r.status, 400, \`mistral-7b-v0.3 is a full fine-tune and does not read lora_rank, yet the submission answered \${r.status}: the trainer would ignore it and the config hash would describe a recipe that never ran\`);
  r = await post(c, {...GOOD, hyperparameters: {learning_rate: 0.0002, warmup_ratio: 0.1}}, {key: 'k-warmup'});
  assert.equal(r.status, 400, \`warmup_ratio is supported by no base model, got \${r.status}\`);
  assert.deepEqual(jobKeys(ctx), [], \`refused hyperparameters must store no job, found \${JSON.stringify(jobKeys(ctx))}\`);
  r = await post(c, {...mistral, hyperparameters: {learning_rate: 0.00001, epochs: 2}}, {key: 'k-mistral'});
  assert.equal(r.status, 201, \`learning_rate and epochs are in mistral-7b-v0.3's supported list, got \${r.status}: \${r.text}\`);
  r = await post(c, GOOD, {key: 'k-llama'});
  assert.equal(r.status, 201, \`lora_rank is in llama-3.1-8b's supported list, got \${r.status}: \${r.text}\`);
}

export async function check_positive_budget(ctx) {
  const c = api(ctx);
  for (const budget of [0, -5, 10_001]) {
    const r = await post(c, {...GOOD, compute_budget: budget}, {key: \`k-\${budget}\`});
    assert.equal(r.status, 400, \`compute_budget=\${budget} answered \${r.status}, expected 400 (1..10000 GPU-hours)\`);
  }
  assert.deepEqual(jobKeys(ctx), [], \`refused budgets must store no job, found \${JSON.stringify(jobKeys(ctx))}\`);
  for (const budget of [1, 10_000]) {
    const r = await post(c, {...GOOD, compute_budget: budget}, {key: \`k-\${budget}\`});
    assert.equal(r.status, 201, \`compute_budget=\${budget} is within 1..10000, got \${r.status}: \${r.text}\`);
  }
}

export async function check_idempotency_key(ctx) {
  const c = api(ctx);
  const noKey = await post(c, GOOD, {withKey: false});
  assert.equal(noKey.status, 400, \`a submission without Idempotency-Key answered \${noKey.status}, expected 400\`);
  const first = await post(c, GOOD, {key: 'k-7'});
  assert.equal(first.status, 201, \`the first submission answered \${first.status}: \${first.text}\`);
  const replay = await post(c, GOOD, {key: 'k-7'});
  assert.equal(replay.status, 200, \`a replay of the same (team, Idempotency-Key) answered \${replay.status}, expected 200 with the stored job: the client timed out and retried, it must not get a second job\`);
  assert.equal(replay.json().job_id, first.json().job_id, \`the replay must answer the same job: got \${replay.json().job_id}, the first made \${first.json().job_id}\`);
  assert.equal(jobKeys(ctx).length, 1, \`one key, one job: the store holds \${jobKeys(ctx).length} jobs after a submission and its replay\`);
  const other = await post(c, GOOD, {key: 'k-7', team: 'ml-legal'});
  assert(other.status === 201 && other.json().job_id !== first.json().job_id, 'another team reusing the key gets its own job (keys are per team)');
}
`,
    go: `package main

import (
	"net/http"
	"regexp"

	"leetbuild/harness"
)

const (
	apiV3SHA    = "b108b116b5f56ba4df62e748a011bf05de20e7c8756e0c18471ff5d04ca29031"
	apiLegalSHA = "06e8599cc710041a091e9b7278ce26cf29e740a60cd3bbe8544805004264cabc"
)

func apiGood() map[string]any {
	return map[string]any{
		"base_model":      "llama-3.1-8b",
		"dataset_version": "support-tickets@v3",
		"hyperparameters": map[string]any{"learning_rate": 0.0002, "lora_rank": 16, "epochs": 3},
		"compute_budget":  400,
	}
}

func apiWith(field string, value any) map[string]any {
	body := apiGood()
	body[field] = value
	return body
}

func apiClient(ctx *harness.Ctx) *harness.HTTP {
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

func apiPost(c *harness.HTTP, body map[string]any, key, team string) *harness.Response {
	return c.Post("/v1/finetune/jobs", body, "X-Team-Id", team, "Idempotency-Key", key)
}

func apiJob(ctx *harness.Ctx, r *harness.Response) map[string]any {
	job, ok := r.JSON().(map[string]any)
	ctx.Assert(ok, "the body must be a JSON object: %s", r.Text())
	return job
}

func apiJobs(ctx *harness.Ctx) []string { return ctx.Redis.Keys("ft:job:*") }

func CheckRoute(ctx *harness.Ctx) {
	c := apiClient(ctx)
	r := apiPost(c, apiGood(), "k-1", "ml-search")
	ctx.Equal(r.Status, 201, "a valid submission (%s)", r.Text())
	job := apiJob(ctx, r)
	for _, key := range []string{"job_id", "status", "base_model", "dataset_version", "dataset_sha256", "config_hash", "hyperparameters", "compute_budget"} {
		_, ok := job[key]
		ctx.Assert(ok, "the 201 body lacks %s: %s", key, r.Text())
	}
	ctx.Assert(job["status"] == "queued" && job["base_model"] == "llama-3.1-8b" && job["dataset_version"] == "support-tickets@v3" && job["compute_budget"] == float64(400), "the job echoes the request with status queued: %s", r.Text())
	ctx.Equal(job["dataset_sha256"], apiV3SHA, "dataset_sha256 must be the registry's hash of support-tickets@v3")
	hash, _ := job["config_hash"].(string)
	ctx.Assert(regexp.MustCompile("^[0-9a-f]{64}$").MatchString(hash), "config_hash must be recipe.ConfigHash's SHA-256 hex, got %q", hash)
	id, _ := job["job_id"].(string)
	team, _ := ctx.Redis.HGet("ft:job:"+id, "team")
	ctx.Equal(team, "ml-search", "the job must be in the job store (ft:job:{id}) with its team (keys %v)", apiJobs(ctx))
	noTeam := c.Post("/v1/finetune/jobs", apiGood(), "Idempotency-Key", "k-2")
	ctx.Equal(noTeam.Status, 401, "without X-Team-Id the submission")
}

func CheckRegisteredDataset(ctx *harness.Ctx) {
	c := apiClient(ctx)
	r := apiPost(c, apiWith("dataset_version", "support-tickets@v2"), "k-retired", "ml-search")
	ctx.Equal(r.Status, 400, "support-tickets@v2 is retired (it held customer e-mail addresses): a job must train only on a registered version; the submission")
	r = apiPost(c, apiWith("dataset_version", "s3://exports/tickets-final.jsonl"), "k-path", "ml-search")
	ctx.Equal(r.Status, 400, "a path the registry does not know")
	ctx.Equal(len(apiJobs(ctx)), 0, "a refused dataset must store no job; jobs stored")
	r = apiPost(c, apiWith("dataset_version", "legal-qa@v1"), "k-legal", "ml-search")
	ctx.Equal(r.Status, 201, "legal-qa@v1 is registered (%s)", r.Text())
	ctx.Equal(apiJob(ctx, r)["dataset_sha256"], apiLegalSHA, "the job carries the registry's sha256 of legal-qa@v1")
}

func CheckSupportedHyperparameters(ctx *harness.Ctx) {
	c := apiClient(ctx)
	r := apiPost(c, apiWith("base_model", "mistral-7b-v0.3"), "k-mistral-lora", "ml-search")
	ctx.Equal(r.Status, 400, "mistral-7b-v0.3 is a full fine-tune and does not read lora_rank: the trainer would ignore it and the config hash would describe a recipe that never ran; the submission")
	r = apiPost(c, apiWith("hyperparameters", map[string]any{"learning_rate": 0.0002, "warmup_ratio": 0.1}), "k-warmup", "ml-search")
	ctx.Equal(r.Status, 400, "warmup_ratio is supported by no base model")
	ctx.Equal(len(apiJobs(ctx)), 0, "refused hyperparameters must store no job; jobs stored")
	mistral := apiWith("base_model", "mistral-7b-v0.3")
	mistral["hyperparameters"] = map[string]any{"learning_rate": 0.00001, "epochs": 2}
	r = apiPost(c, mistral, "k-mistral", "ml-search")
	ctx.Equal(r.Status, 201, "learning_rate and epochs are in mistral-7b-v0.3's supported list (%s)", r.Text())
	r = apiPost(c, apiGood(), "k-llama", "ml-search")
	ctx.Equal(r.Status, 201, "lora_rank is in llama-3.1-8b's supported list (%s)", r.Text())
}

func CheckPositiveBudget(ctx *harness.Ctx) {
	c := apiClient(ctx)
	for _, budget := range []int{0, -5, 10_001} {
		r := apiPost(c, apiWith("compute_budget", budget), "k-"+harness.Show(budget), "ml-search")
		ctx.Equal(r.Status, 400, "compute_budget=%d (1..10000 GPU-hours)", budget)
	}
	ctx.Equal(len(apiJobs(ctx)), 0, "refused budgets must store no job; jobs stored")
	for _, budget := range []int{1, 10_000} {
		r := apiPost(c, apiWith("compute_budget", budget), "k-"+harness.Show(budget), "ml-search")
		ctx.Equal(r.Status, 201, "compute_budget=%d is within 1..10000 (%s)", budget, r.Text())
	}
}

func CheckIdempotencyKey(ctx *harness.Ctx) {
	c := apiClient(ctx)
	noKey := c.Post("/v1/finetune/jobs", apiGood(), "X-Team-Id", "ml-search")
	ctx.Equal(noKey.Status, 400, "a submission without Idempotency-Key")
	first := apiPost(c, apiGood(), "k-7", "ml-search")
	ctx.Equal(first.Status, 201, "the first submission (%s)", first.Text())
	replay := apiPost(c, apiGood(), "k-7", "ml-search")
	ctx.Equal(replay.Status, 200, "a replay of the same (team, Idempotency-Key) must answer the stored job: the client timed out and retried, it must not get a second job")
	ctx.Equal(apiJob(ctx, replay)["job_id"], apiJob(ctx, first)["job_id"], "the replay must answer the same job")
	ctx.Equal(len(apiJobs(ctx)), 1, "one key, one job: jobs stored after a submission and its replay")
	other := apiPost(c, apiGood(), "k-7", "ml-legal")
	ctx.Assert(other.Status == 201 && apiJob(ctx, other)["job_id"] != apiJob(ctx, first)["job_id"], "another team reusing the key gets its own job (keys are per team)")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <regex>
#include <string>

namespace {

using json = nlohmann::json;

const std::string kV3Sha = "b108b116b5f56ba4df62e748a011bf05de20e7c8756e0c18471ff5d04ca29031";
const std::string kLegalSha = "06e8599cc710041a091e9b7278ce26cf29e740a60cd3bbe8544805004264cabc";

const json kGood = {
    {"base_model", "llama-3.1-8b"},
    {"dataset_version", "support-tickets@v3"},
    {"hyperparameters", {{"learning_rate", 0.0002}, {"lora_rank", 16}, {"epochs", 3}}},
    {"compute_budget", 400},
};

struct Api {
  httplib::Server svr;
  harness::HTTP http;
  explicit Api(harness::Ctx& ctx) : http(ctx.HTTP(svr)) { register_routes(svr); }

  harness::Response post(const json& body, const std::string& key, const std::string& team = "ml-search") {
    return http.Post("/v1/finetune/jobs", body.dump(), "X-Team-Id", team, "Idempotency-Key", key);
  }
};

json with(json body, const std::string& field, const json& value) {
  body[field] = value;
  return body;
}

json jobOf(harness::Ctx& ctx, const harness::Response& r) {
  const json job = json::parse(r.Text(), nullptr, false);
  ctx.Assert(job.is_object(), "the body must be a JSON object: %s", r.Text());
  return job;
}

}  // namespace

void CheckRoute(harness::Ctx& ctx) {
  Api api(ctx);
  const auto r = api.post(kGood, "k-1");
  ctx.Equal(r.Status, 201, "a valid submission (%s)", r.Text());
  const json job = jobOf(ctx, r);
  for (const char* key : {"job_id", "status", "base_model", "dataset_version", "dataset_sha256", "config_hash", "hyperparameters", "compute_budget"}) {
    ctx.Assert(job.contains(key), "the 201 body lacks %s: %s", key, r.Text());
  }
  ctx.Assert(job.value("status", "") == "queued" && job.value("base_model", "") == "llama-3.1-8b" && job.value("dataset_version", "") == "support-tickets@v3" &&
                 job.value("compute_budget", 0) == 400,
             "the job echoes the request with status queued: %s", r.Text());
  ctx.Equal(job.value("dataset_sha256", ""), kV3Sha, "dataset_sha256 must be the registry's hash of support-tickets@v3");
  const std::string hash = job.value("config_hash", "");
  ctx.Assert(std::regex_match(hash, std::regex("[0-9a-f]{64}")), "config_hash must be recipe::config_hash's SHA-256 hex, got %q", hash);
  const auto team = ctx.Redis.HGet("ft:job:" + job.value("job_id", ""), "team");
  ctx.Assert(team && *team == "ml-search", "the job must be in the job store (ft:job:{id}) with its team (keys %v)", ctx.Redis.Keys("ft:job:*"));
  const auto noTeam = api.http.Post("/v1/finetune/jobs", kGood.dump(), "Idempotency-Key", "k-2");
  ctx.Equal(noTeam.Status, 401, "without X-Team-Id the submission");
}

void CheckRegisteredDataset(harness::Ctx& ctx) {
  Api api(ctx);
  auto r = api.post(with(kGood, "dataset_version", "support-tickets@v2"), "k-retired");
  ctx.Equal(r.Status, 400, "support-tickets@v2 is retired (it held customer e-mail addresses): a job must train only on a registered version; the submission");
  r = api.post(with(kGood, "dataset_version", "s3://exports/tickets-final.jsonl"), "k-path");
  ctx.Equal(r.Status, 400, "a path the registry does not know");
  ctx.Equal(ctx.Redis.Keys("ft:job:*").size(), 0, "a refused dataset must store no job; jobs stored");
  r = api.post(with(kGood, "dataset_version", "legal-qa@v1"), "k-legal");
  ctx.Equal(r.Status, 201, "legal-qa@v1 is registered (%s)", r.Text());
  ctx.Equal(jobOf(ctx, r).value("dataset_sha256", ""), kLegalSha, "the job carries the registry's sha256 of legal-qa@v1");
}

void CheckSupportedHyperparameters(harness::Ctx& ctx) {
  Api api(ctx);
  const json mistral = with(kGood, "base_model", "mistral-7b-v0.3");
  auto r = api.post(mistral, "k-mistral-lora");
  ctx.Equal(r.Status, 400, "mistral-7b-v0.3 is a full fine-tune and does not read lora_rank: the trainer would ignore it and the config hash would describe a recipe that never ran; the submission");
  r = api.post(with(kGood, "hyperparameters", {{"learning_rate", 0.0002}, {"warmup_ratio", 0.1}}), "k-warmup");
  ctx.Equal(r.Status, 400, "warmup_ratio is supported by no base model");
  ctx.Equal(ctx.Redis.Keys("ft:job:*").size(), 0, "refused hyperparameters must store no job; jobs stored");
  r = api.post(with(mistral, "hyperparameters", {{"learning_rate", 0.00001}, {"epochs", 2}}), "k-mistral");
  ctx.Equal(r.Status, 201, "learning_rate and epochs are in mistral-7b-v0.3's supported list (%s)", r.Text());
  r = api.post(kGood, "k-llama");
  ctx.Equal(r.Status, 201, "lora_rank is in llama-3.1-8b's supported list (%s)", r.Text());
}

void CheckPositiveBudget(harness::Ctx& ctx) {
  Api api(ctx);
  for (int budget : {0, -5, 10001}) {
    const auto r = api.post(with(kGood, "compute_budget", budget), "k-" + std::to_string(budget));
    ctx.Equal(r.Status, 400, "compute_budget=%d (1..10000 GPU-hours)", budget);
  }
  ctx.Equal(ctx.Redis.Keys("ft:job:*").size(), 0, "refused budgets must store no job; jobs stored");
  for (int budget : {1, 10000}) {
    const auto r = api.post(with(kGood, "compute_budget", budget), "k-" + std::to_string(budget));
    ctx.Equal(r.Status, 201, "compute_budget=%d is within 1..10000 (%s)", budget, r.Text());
  }
}

void CheckIdempotencyKey(harness::Ctx& ctx) {
  Api api(ctx);
  const auto noKey = api.http.Post("/v1/finetune/jobs", kGood.dump(), "X-Team-Id", "ml-search");
  ctx.Equal(noKey.Status, 400, "a submission without Idempotency-Key");
  const auto first = api.post(kGood, "k-7");
  ctx.Equal(first.Status, 201, "the first submission (%s)", first.Text());
  const auto replay = api.post(kGood, "k-7");
  ctx.Equal(replay.Status, 200, "a replay of the same (team, Idempotency-Key) must answer the stored job: the client timed out and retried, it must not get a second job");
  ctx.Equal(jobOf(ctx, replay)["job_id"], jobOf(ctx, first)["job_id"], "the replay must answer the same job");
  ctx.Equal(ctx.Redis.Keys("ft:job:*").size(), 1, "one key, one job: jobs stored after a submission and its replay");
  const auto other = api.post(kGood, "k-7", "ml-legal");
  ctx.Assert(other.Status == 201 && jobOf(ctx, other)["job_id"] != jobOf(ctx, first)["job_id"], "another team reusing the key gets its own job (keys are per team)");
}
`,
  },
  hints: [
    'Symptom: a job queues on support-tickets@v2, which was pulled for holding customer e-mail addresses; mistral-7b-v0.3 accepts `lora_rank`; a zero-hour budget is accepted; a retried submission becomes a second job.',
    'Mechanism: the starter asks only whether the registry knows the version, not its `status`; it checks names against one fixed list, not the model\u2019s `supported`; it bounds the budget from above only; and it keys the job by its fresh id, so replays miss.',
    'Change: `dataset["status"] != "registered"` is 400; diff the keys against `model["supported"]`; add `MIN_COMPUTE_BUDGET = 1` to the range; require `Idempotency-Key`, answer 200 from `store.get(team, key)` and `store.put(team, key, job)` after every guard.',
  ],
  debrief: `A submission is the last cheap place to enforce reproducibility: once the trainer starts, a dataset version and a set of knobs are baked into days of GPU time. That is why the registry is asked two questions (does the version exist, is it still allowed) and why the hyperparameters are checked against the model they will configure: an ignored knob makes the config hash lie about the run. The idempotency key is per team because clients pick keys and collide. A production orchestrator also pins the tokenizer, the training image digest and the seed into the config hash, and checks the team's remaining GPU-hours here instead of letting the queue discover it.`,
};
