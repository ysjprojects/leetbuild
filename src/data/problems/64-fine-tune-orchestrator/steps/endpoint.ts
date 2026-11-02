import type {Step} from '@/lib/types';

export const endpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/finetune/jobs: a config that is reproducible',
  concept: 'http',
  file: 'api',
  focus: ['api', 'registry'],
  task: `## Task

**Starting point.** The starter registers \`POST /v1/finetune/jobs\`, reads the team from
\`X-Team-Id\`, stores whatever the body carries (\`base_model\`, a raw \`dataset_file\`, the
hyperparameter block, \`compute_budget\`) and returns a fresh job id. It serves the demo and hides
four flaws.

**Failure mode the checks target.** A caller-supplied \`dataset_file\` bypasses registry provenance,
so a fine-tune can train on an export nobody can reproduce. An unchecked hyperparameter key means
"the same config" says nothing a year later. A zero budget reserves nothing and still runs. And an
un-keyed submit launches a twin on every client retry, each reserving its own GPU budget.

Body: \`{"base_model", "dataset_version", "hyperparameters": {…}, "compute_budget": 1200}\`.

- The team comes from \`X-Team-Id\`; a missing team is **401**.
- \`base_model\` is a registered model version; unknown is **400**.
- \`dataset_version\` is a registered dataset version, not a path; anything else is **400**. The job
  stores the version id and its \`sha256\`.
- Every \`hyperparameters\` key must be in the base model's supported set (\`learning_rate\`,
  \`lora_rank\`, \`lora_alpha\`, \`epochs\`, \`batch_size\`); an unknown key is **400**. The block is
  canonicalised into a \`config_hash\`.
- \`compute_budget\` is a positive integer (**400** otherwise).
- \`Idempotency-Key\` is required (**400** when missing); a retry with the same \`(team, key)\`
  returns the original job.
- Log team and job id, not the hyperparameter block.`,
  sequence: {
    participants: ['Client', 'Fine-tune API', 'Registry', 'Redis'],
    messages: [
      {
        from: 'Client',
        to: 'Fine-tune API',
        label: 'POST /v1/finetune/jobs · X-Team-Id · Idempotency-Key',
        kind: 'sync',
      },
      {
        from: 'Fine-tune API',
        to: 'Fine-tune API',
        label: 'validate budget · dataset version · hyperparameters',
        kind: 'sync',
      },
      {from: 'Fine-tune API', to: 'Registry', label: 'get_dataset(version) · get_base_model(version)', kind: 'sync'},
      {from: 'Registry', to: 'Fine-tune API', label: 'registered versions / none', kind: 'reply'},
      {from: 'Fine-tune API', to: 'Redis', label: 'get(team:key) — replay?', kind: 'sync'},
      {from: 'Redis', to: 'Fine-tune API', label: 'stored job id / none', kind: 'reply'},
      {from: 'Fine-tune API', to: 'Redis', label: 'put(team:key, job_id) · config hash', kind: 'async'},
      {from: 'Fine-tune API', to: 'Client', label: '201 {job_id, config_hash}', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Handles POST /v1/finetune/jobs',
      detail: 'Register the job submission route on `POST /v1/finetune/jobs`.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/finetune\/jobs["']/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/finetune\/jobs['"]/]},
        go: {all: [/HandleFunc\(\s*"POST \/v1\/finetune\/jobs"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"finetune"\s*\/\s*"jobs"\s*\)/, /\bpost\s*\{/]},
        cpp: {all: [/svr\.Post\(\s*"\/v1\/finetune\/jobs"/]},
      },
    },
    {
      id: 'dataset-version',
      title: 'Rejects anything that is not a registered dataset version',
      detail:
        'The dataset is a registry version id; the handler resolves it and returns **400** for an unknown or unregistered version. The starter stores the caller-supplied `dataset_file` and never consults the registry.',
      match: {
        python: {all: [/dataset_version/, /registry\.get_dataset\(/, /status_code\s*=\s*400/]},
        typescript: {all: [/dataset_version/, /registry\.getDataset\(/, /code\(\s*400\s*\)/]},
        go: {all: [/DatasetVersion/, /GetDataset\(/, /StatusBadRequest/]},
        scala: {all: [/datasetVersion/, /registry\.getDataset\(/, /StatusCodes\.BadRequest/]},
        cpp: {all: [/dataset_version/, /registry\.getDataset\(/, /\b400\b/]},
      },
    },
    {
      id: 'hyperparams',
      title: 'Validates hyperparameters against the base model’s supported set',
      detail:
        'Every key in `hyperparameters` must be one the base model supports; an unknown key is **400**. The starter accepts the block verbatim and would train on an undefined knob.',
      match: {
        python: {all: [/SUPPORTED_HYPERPARAMS/, /status_code\s*=\s*400/]},
        typescript: {all: [/SUPPORTED_HYPERPARAMS/, /code\(\s*400\s*\)/]},
        go: {all: [/supportedHyperparams/, /StatusBadRequest/]},
        scala: {all: [/SupportedHyperparams/, /StatusCodes\.BadRequest/]},
        cpp: {all: [/kSupportedHyperparams/, /\b400\b/]},
      },
    },
    {
      id: 'idempotency',
      title: 'Replays the original job for a repeated key',
      detail:
        '`Idempotency-Key` is required and the job is stored under `(team, key)`; a replay returns the stored job instead of submitting a second one. The starter ignores the header.',
      match: {
        python: {all: [/Idempotency-Key/, /store\.get\(/, /store\.put\(/]},
        typescript: {all: [/idempotency-key/, /store\.get\(/, /store\.put\(/]},
        go: {all: [/Idempotency-Key/, /store\.Get\(/, /store\.Put\(/]},
        scala: {all: [/Idempotency-Key/, /store\.get\(/, /store\.put\(/]},
        cpp: {all: [/Idempotency-Key/, /store\.get\(/, /store\.put\(/]},
      },
    },
    {
      id: 'budget',
      title: 'Requires a positive compute budget',
      detail:
        '`compute_budget` must be a positive integer — **400** otherwise — and is stored verbatim on the job. The starter trusts the field, so a zero or negative budget slips through.',
      match: {
        python: {all: [/compute_budget/, /compute_budget\s*<=\s*0/]},
        typescript: {all: [/computeBudget/, /computeBudget\s*<=\s*0/]},
        go: {all: [/ComputeBudget/, /ComputeBudget\s*<=\s*0/]},
        scala: {all: [/computeBudget/, /computeBudget\s*<=\s*0/]},
        cpp: {all: [/compute_budget/, /compute_budget\s*<=\s*0/]},
      },
    },
  ],
  code: {
    python: {
      starter: `"""Fine-tune job submission API: flawed code that trusts the caller's dataset file."""
import logging
from typing import Any, Dict

from fastapi import FastAPI, Header
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()
logger = logging.getLogger("finetune")
jobs: Dict[str, Dict[str, Any]] = {}


class JobRequest(BaseModel):
    base_model: str
    dataset_file: str
    hyperparameters: Dict[str, Any]
    compute_budget: int


@app.post("/v1/finetune/jobs")
async def create_job(body: JobRequest, x_team_id: str = Header(...)) -> JSONResponse:
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    job_id = f"job-{len(jobs) + 1}"
    jobs[job_id] = {
        "id": job_id,
        "team": x_team_id,
        "base_model": body.base_model,
        "dataset_file": body.dataset_file,
        "hyperparameters": body.hyperparameters,
        "compute_budget": body.compute_budget,
    }
    logger.info("submitted %s for team %s", job_id, x_team_id)
    return JSONResponse({"job_id": job_id}, status_code=201)
`,
      solution: `"""Fine-tune job submission API."""
import hashlib
import logging
from typing import Any, Dict

from fastapi import FastAPI, Header
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()
logger = logging.getLogger("finetune")
jobs: Dict[str, Dict[str, Any]] = {}

# Hyperparameters the base model's fine-tune recipe supports.
SUPPORTED_HYPERPARAMS = {"learning_rate", "lora_rank", "lora_alpha", "epochs", "batch_size"}


class Store:
    """Idempotency store: one job per (team, key)."""

    def __init__(self) -> None:
        self._rows: Dict[str, str] = {}

    def get(self, key: str) -> Any:
        return self._rows.get(key)

    def put(self, key: str, value: str) -> None:
        self._rows[key] = value


store = Store()


class JobRequest(BaseModel):
    base_model: str
    dataset_version: str
    hyperparameters: Dict[str, Any]
    compute_budget: int


def _reject(detail: str) -> JSONResponse:
    return JSONResponse({"detail": detail}, status_code=400)


def _config_hash(hyperparameters: Dict[str, Any]) -> str:
    canonical = repr(sorted(hyperparameters.items()))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


@app.post("/v1/finetune/jobs")
async def create_job(
    body: JobRequest,
    x_team_id: str = Header(...),
    idempotency_key: str = Header(..., alias="Idempotency-Key"),
) -> JSONResponse:
    if not isinstance(body.compute_budget, int) or body.compute_budget <= 0:
        return _reject("compute_budget must be a positive integer")
    dataset = registry.get_dataset(body.dataset_version)
    if dataset is None or dataset["status"] != "registered":
        return _reject("dataset_version must be a registered dataset version")
    base_model = registry.get_base_model(body.base_model)
    if base_model is None:
        return _reject("base_model must be a registered model version")
    unknown = set(body.hyperparameters) - SUPPORTED_HYPERPARAMS
    if unknown:
        return _reject(f"unsupported hyperparameters: {sorted(unknown)}")
    key = f"{x_team_id}:{idempotency_key}"
    existing = store.get(key)
    if existing is not None:
        return JSONResponse(jobs[existing], status_code=200)
    job_id = f"job-{len(jobs) + 1}"
    jobs[job_id] = {
        "id": job_id,
        "team": x_team_id,
        "base_model": base_model["id"],
        "dataset_version": dataset["id"],
        "dataset_sha256": dataset["sha256"],
        "hyperparameters": dict(body.hyperparameters),
        "compute_budget": body.compute_budget,
        "config_hash": _config_hash(body.hyperparameters),
    }
    store.put(key, job_id)
    logger.info("submitted %s for team %s", job_id, x_team_id)
    return JSONResponse(jobs[job_id], status_code=201)
`,
    },
    typescript: {
      starter: `/** POST /v1/finetune/jobs: flawed code that trusts the caller's dataset file. */
import Fastify from 'fastify';
import {createClient} from 'ioredis';

export const app = Fastify();
const redis = createClient({url: process.env.REDIS_URL});

interface JobRequest {
  base_model: string;
  dataset_file: string;
  hyperparameters: Record<string, unknown>;
  compute_budget: number;
}

app.post('/v1/finetune/jobs', async (request, reply) => {
  const team = request.headers['x-team-id'] as string;
  const body = request.body as JobRequest;
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const jobId = \`job-\${Date.now()}\`;
  await redis.set(\`job:\${jobId}\`, JSON.stringify({...body, team}));
  return reply.code(201).send({job_id: jobId});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** POST /v1/finetune/jobs: validate the recipe, then store it verbatim under an idempotency key. */
import Fastify from 'fastify';
import {createHash} from 'node:crypto';
import {createClient} from 'ioredis';

export const app = Fastify();
const redis = createClient({url: process.env.REDIS_URL});

const SUPPORTED_HYPERPARAMS = new Set(['learning_rate', 'lora_rank', 'lora_alpha', 'epochs', 'batch_size']);

interface JobRequest {
  base_model: string;
  dataset_version: string;
  hyperparameters: Record<string, unknown>;
  compute_budget: number;
}

const store = {
  async get(key: string): Promise<string | null> {
    return redis.get(\`idem:\${key}\`);
  },
  async put(key: string, jobId: string): Promise<void> {
    await redis.set(\`idem:\${key}\`, jobId, 'NX');
  },
};

const configHash = (hyperparameters: Record<string, unknown>): string =>
  createHash('sha256').update(JSON.stringify(hyperparameters, Object.keys(hyperparameters).sort())).digest('hex');

app.post('/v1/finetune/jobs', async (request, reply) => {
  const team = request.headers['x-team-id'] as string;
  const idempotencyKey = request.headers['idempotency-key'] as string | undefined;
  if (!team) return reply.code(401).send({detail: 'team required'});
  if (!idempotencyKey) return reply.code(400).send({detail: 'Idempotency-Key required'});
  const body = request.body as JobRequest;
  const computeBudget = body.compute_budget;
  if (!Number.isInteger(computeBudget) || computeBudget <= 0)
    return reply.code(400).send({detail: 'compute_budget must be a positive integer'});
  const dataset = registry.getDataset(body.dataset_version);
  if (dataset === undefined || dataset.status !== 'registered')
    return reply.code(400).send({detail: 'dataset_version must be a registered dataset version'});
  const baseModel = registry.getBaseModel(body.base_model);
  if (baseModel === undefined) return reply.code(400).send({detail: 'base_model must be a registered model version'});
  for (const name of Object.keys(body.hyperparameters))
    if (!SUPPORTED_HYPERPARAMS.has(name)) return reply.code(400).send({detail: \`unsupported hyperparameter \${name}\`});
  const key = \`\${team}:\${idempotencyKey}\`;
  const existing = await store.get(key);
  if (existing !== null) {
    const stored = await redis.get(\`job:\${existing}\`);
    return reply.code(200).send(stored === null ? {} : JSON.parse(stored));
  }
  const jobId = \`job-\${Date.now()}\`;
  const job = {
    id: jobId,
    team,
    base_model: baseModel.id,
    dataset_version: dataset.id,
    dataset_sha256: dataset.sha256,
    hyperparameters: body.hyperparameters,
    compute_budget: computeBudget,
    config_hash: configHash(body.hyperparameters),
  };
  await redis.set(\`job:\${jobId}\`, JSON.stringify(job));
  await store.put(key, jobId);
  return reply.code(201).send(job);
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
    },
    go: {
      starter: `// Package api is the fine-tune job submission API: flawed code that trusts the caller's dataset file.
package api

import (
	"encoding/json"
	"log"
	"net/http"
)

type JobRequest struct {
	BaseModel       string         \`json:"base_model"\`
	DatasetFile     string         \`json:"dataset_file"\`
	Hyperparameters map[string]any \`json:"hyperparameters"\`
	ComputeBudget   int            \`json:"compute_budget"\`
}

var jobs = map[string]map[string]any{}

func Register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/finetune/jobs", func(w http.ResponseWriter, r *http.Request) {
		var body JobRequest
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, "bad json", http.StatusBadRequest)
			return
		}
		// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
		team := r.Header.Get("X-Team-Id")
		jobID := "job-" + team
		jobs[jobID] = map[string]any{
			"id":             jobID,
			"team":           team,
			"base_model":     body.BaseModel,
			"dataset_file":   body.DatasetFile,
			"hyperparameters": body.Hyperparameters,
			"compute_budget": body.ComputeBudget,
		}
		log.Printf("submitted %s for team %s", jobID, team)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(map[string]any{"job_id": jobID})
	})
}
`,
      solution: `// Package api is the fine-tune job submission API.
package api

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"log"
	"net/http"
)

type JobRequest struct {
	BaseModel       string         \`json:"base_model"\`
	DatasetVersion  string         \`json:"dataset_version"\`
	Hyperparameters map[string]any \`json:"hyperparameters"\`
	ComputeBudget   int            \`json:"compute_budget"\`
}

var supportedHyperparams = map[string]bool{
	"learning_rate": true, "lora_rank": true, "lora_alpha": true, "epochs": true, "batch_size": true,
}

var jobs = map[string]map[string]any{}

type jobStore struct{}

var store jobStore

func (jobStore) Get(key string) (string, bool) { return idemGet(key) }
func (jobStore) Put(key, value string)         { idemPut(key, value) }

func configHash(h map[string]any) string {
	canonical, _ := json.Marshal(h)
	sum := sha256.Sum256(canonical)
	return hex.EncodeToString(sum[:])
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func Register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/finetune/jobs", func(w http.ResponseWriter, r *http.Request) {
		var body JobRequest
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, "bad json", http.StatusBadRequest)
			return
		}
		team := r.Header.Get("X-Team-Id")
		idempotencyKey := r.Header.Get("Idempotency-Key")
		if team == "" {
			http.Error(w, "team required", http.StatusUnauthorized)
			return
		}
		if idempotencyKey == "" {
			http.Error(w, "Idempotency-Key required", http.StatusBadRequest)
			return
		}
		if body.ComputeBudget <= 0 {
			http.Error(w, "compute_budget must be a positive integer", http.StatusBadRequest)
			return
		}
		dataset, ok := registry.GetDataset(body.DatasetVersion)
		if !ok || dataset.Status != "registered" {
			http.Error(w, "dataset_version must be a registered dataset version", http.StatusBadRequest)
			return
		}
		baseModel, ok := registry.GetBaseModel(body.BaseModel)
		if !ok {
			http.Error(w, "base_model must be a registered model version", http.StatusBadRequest)
			return
		}
		for name := range body.Hyperparameters {
			if !supportedHyperparams[name] {
				http.Error(w, "unsupported hyperparameter", http.StatusBadRequest)
				return
			}
		}
		key := team + ":" + idempotencyKey
		if existing, ok := store.Get(key); ok {
			writeJSON(w, http.StatusOK, jobs[existing])
			return
		}
		jobID := "job-" + team
		jobs[jobID] = map[string]any{
			"id":              jobID,
			"team":            team,
			"base_model":      baseModel.ID,
			"dataset_version": dataset.ID,
			"dataset_sha256":  dataset.SHA256,
			"hyperparameters": body.Hyperparameters,
			"compute_budget":  body.ComputeBudget,
			"config_hash":     configHash(body.Hyperparameters),
		}
		store.Put(key, jobID)
		log.Printf("submitted %s for team %s", jobID, team)
		writeJSON(w, http.StatusCreated, jobs[jobID])
	})
}
`,
    },
    scala: {
      starter: `package finetune

import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route

object Api {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  final case class JobRequest(
      baseModel: String,
      datasetFile: String,
      hyperparameters: Map[String, String],
      computeBudget: Int,
  )

  val route: Route = path("v1" / "finetune" / "jobs") {
    post {
      entity(as[JobRequest]) { body =>
        complete(201, s"""{"job_id":"job-\${body.baseModel}"}""")
      }
    }
  }
}
`,
      solution: `package finetune

import org.apache.pekko.http.scaladsl.model.StatusCodes
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route

import java.security.MessageDigest

object Api {
  final case class JobRequest(
      baseModel: String,
      datasetVersion: String,
      hyperparameters: Map[String, String],
      computeBudget: Int,
  )

  val SupportedHyperparams: Set[String] =
    Set("learning_rate", "lora_rank", "lora_alpha", "epochs", "batch_size")

  object store {
    def get(key: String): Option[String] = IdemStore.get(key)
    def put(key: String, value: String): Unit = IdemStore.put(key, value)
  }

  def configHash(hyperparameters: Map[String, String]): String = {
    val canonical = hyperparameters.toSeq.sorted.map { case (k, v) => s"$k=$v" }.mkString(",")
    val md = MessageDigest.getInstance("SHA-256")
    md.update(canonical.getBytes("UTF-8"))
    md.digest().map("%02x".format(_)).mkString
  }

  val route: Route = path("v1" / "finetune" / "jobs") {
    post {
      headerValueByName("X-Team-Id") { team =>
        headerValueByName("Idempotency-Key") { idempotencyKey =>
          entity(as[JobRequest]) { body =>
            if (body.computeBudget <= 0) {
              complete(StatusCodes.BadRequest, "compute_budget must be a positive integer")
            } else if (!SupportedHyperparams.containsAll(body.hyperparameters.keySet)) {
              complete(StatusCodes.BadRequest, "unsupported hyperparameters")
            } else {
              registry.getDataset(body.datasetVersion) match {
                case Some(dataset) if dataset.status == "registered" =>
                  registry.getBaseModel(body.baseModel) match {
                    case Some(baseModel) =>
                      val key = s"$team:$idempotencyKey"
                      store.get(key) match {
                        case Some(jobId) => complete(StatusCodes.OK, s"""{"job_id":"$jobId"}""")
                        case None =>
                          val jobId = s"job-\${baseModel.id}"
                          store.put(key, jobId)
                          complete(
                            StatusCodes.Created,
                            s"""{"job_id":"$jobId","config_hash":"\${configHash(body.hyperparameters)}"}""",
                          )
                      }
                    case None => complete(StatusCodes.BadRequest, "base_model must be a registered model version")
                  }
                case _ => complete(StatusCodes.BadRequest, "dataset_version must be a registered dataset version")
              }
            }
          }
        }
      }
    }
  }
}
`,
    },
    cpp: {
      starter: `// Fine-tune job submission API: flawed code that trusts the caller's dataset file.
#include <httplib.h>
#include <nlohmann/json.hpp>

using json = nlohmann::json;

void Register(httplib::Server& svr) {
  svr.Post("/v1/finetune/jobs", [](const httplib::Request& req, httplib::Response& res) {
    // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    json body = json::parse(req.body);
    json job = {
        {"id", "job-" + body["base_model"].get<std::string>()},
        {"team", req.get_header_value("X-Team-Id")},
        {"base_model", body["base_model"]},
        {"dataset_file", body["dataset_file"]},
        {"hyperparameters", body["hyperparameters"]},
        {"compute_budget", body["compute_budget"]},
    };
    res.status = 201;
    res.set_content(job.dump(), "application/json");
  });
}
`,
      solution: `// Fine-tune job submission API.
#include <httplib.h>
#include <nlohmann/json.hpp>

#include <set>
#include <string>

using json = nlohmann::json;

namespace {
const std::set<std::string> kSupportedHyperparams = {
    "learning_rate", "lora_rank", "lora_alpha", "epochs", "batch_size"};

std::string ConfigHash(const json& hyperparameters) {
  json ordered = json::object();
  for (auto& [name, value] : hyperparameters.items()) ordered[name] = value;
  return sha256_hex(ordered.dump());
}
}  // namespace

void Register(httplib::Server& svr) {
  svr.Post("/v1/finetune/jobs", [](const httplib::Request& req, httplib::Response& res) {
    json body = json::parse(req.body);
    const std::string team = req.get_header_value("X-Team-Id");
    const std::string idempotency_key = req.get_header_value("Idempotency-Key");
    if (team.empty()) {
      res.status = 401;
      res.set_content(R"({"detail":"team required"})", "application/json");
      return;
    }
    if (idempotency_key.empty()) {
      res.status = 400;
      res.set_content(R"({"detail":"Idempotency-Key required"})", "application/json");
      return;
    }
    const int compute_budget = body.value("compute_budget", 0);
    if (compute_budget <= 0) {
      res.status = 400;
      res.set_content(R"({"detail":"compute_budget must be a positive integer"})", "application/json");
      return;
    }
    const std::string dataset_version = body.value("dataset_version", "");
    auto dataset = registry.getDataset(dataset_version);
    if (!dataset.has_value() || dataset->status != "registered") {
      res.status = 400;
      res.set_content(R"({"detail":"dataset_version must be a registered dataset version"})", "application/json");
      return;
    }
    auto base_model = registry.getBaseModel(body.value("base_model", ""));
    if (!base_model.has_value()) {
      res.status = 400;
      res.set_content(R"({"detail":"base_model must be a registered model version"})", "application/json");
      return;
    }
    for (auto& [name, value] : body["hyperparameters"].items()) {
      if (kSupportedHyperparams.count(name) == 0) {
        res.status = 400;
        res.set_content(R"({"detail":"unsupported hyperparameter"})", "application/json");
        return;
      }
    }
    const std::string key = team + ":" + idempotency_key;
    if (auto existing = store.get(key); existing.has_value()) {
      res.status = 200;
      res.set_content(jobs[*existing].dump(), "application/json");
      return;
    }
    const std::string job_id = "job-" + base_model->id;
    jobs[job_id] = {
        {"id", job_id},
        {"team", team},
        {"base_model", base_model->id},
        {"dataset_version", dataset_version},
        {"dataset_sha256", dataset->sha256},
        {"hyperparameters", body["hyperparameters"]},
        {"compute_budget", compute_budget},
        {"config_hash", ConfigHash(body["hyperparameters"])},
    };
    store.put(key, job_id);
    res.status = 201;
    res.set_content(jobs[job_id].dump(), "application/json");
  });
}
`,
    },
  },
  hints: [
    'A client that timed out and retried now owns two jobs, both burning budget, and one of them trains on an `s3://` export the registry has no record of.',
    'The handler copies the body straight into the job record: no registry lookup for the dataset, no key check against `SUPPORTED_HYPERPARAMS`, no `<= 0` budget test, and nobody reads `Idempotency-Key`.',
    'In `create_job`, resolve `dataset_version` via `registry.get_dataset`, reject keys outside `SUPPORTED_HYPERPARAMS` and `compute_budget <= 0` with 400, then `store.get`/`store.put` the job under `(team, key)`.',
  ],
  debrief: `The fix has this shape because a submission is the only place where reproducibility can still be enforced cheaply: once the trainer starts, a dataset without a registry hash or a knob the recipe does not define is already baked into a week of GPU time. Resolving the version, restricting the hyperparameter keys and hashing the block make two equal recipes hash equal; the idempotency store keyed by team keeps a retry from paying for the same recipe twice; the budget check keeps a zero reservation from starting a real job. Production orchestrators go further on the same axis: the tokenizer version, the training image digest and the random seed are pinned and folded into the config hash.`,
};
