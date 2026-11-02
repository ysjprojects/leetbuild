import type {Step} from '@/lib/types';

export const endpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/models: a version with real lineage',
  concept: 'http',
  file: 'api',
  focus: ['client', 'registry', 'db', 'eval'],
  task: `## Task

**Starting point.** The starter handles \`POST /v1/models\` with body
\`{"name", "artifact_digest", "training_run_id", "eval_id", "lineage_tag"}\`, reads \`X-Tenant-Id\`,
mints a version from a UUID and answers **201** with
\`{"name", "version", "artifact_digest", "eval_id", "lineage_tag", "stage": "staged"}\`. It never
reads any store. It compiles and hides four flaws.

**Failure mode the checks target.** A version that names bytes the artifact store cannot fetch, a
training run that was invented, an eval score that was measured on another model or another
digest, and a client retry that mints a second version for the same model.

- A missing tenant is **401**. \`Idempotency-Key\` is required (**400** when missing); a retry with
  the same \`(tenant, key)\` reads the stored response with \`store.get\` and returns it, and a first
  call saves it with \`store.put\` before answering.
- \`require_artifact\`: the digest must resolve in the artifact store, else **422**.
- \`require_training_run\`: the run must exist and belong to this model, else **422**.
- \`require_eval_binding\`: the eval record must name this model and this exact
  \`artifact_digest\`, else **422**.
- The version is minted by the registry, not taken from the body, and the response shape and
  \`stage = "staged"\` stay as they are.`,
  sequence: {
    participants: ['Client', 'Model Registry', 'Artifact store', 'Eval store'],
    messages: [
      {from: 'Client', to: 'Model Registry', label: 'POST /v1/models · X-Tenant-Id · Idempotency-Key', kind: 'sync'},
      {from: 'Model Registry', to: 'Model Registry', label: 'lookup (tenant, key) · replay?', kind: 'sync'},
      {from: 'Model Registry', to: 'Artifact store', label: 'get(artifact_digest)', kind: 'sync'},
      {from: 'Artifact store', to: 'Model Registry', label: 'record · or none → 422', kind: 'reply'},
      {from: 'Model Registry', to: 'Eval store', label: 'get(eval_id)', kind: 'sync'},
      {from: 'Eval store', to: 'Model Registry', label: 'record must match model + digest', kind: 'reply'},
      {from: 'Model Registry', to: 'Model Registry', label: 'mint version · stage = staged', kind: 'sync'},
      {from: 'Model Registry', to: 'Client', label: '201 {name, version, lineage_tag, stage}', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Handles POST /v1/models',
      detail: 'Register the registration route on `POST /v1/models`.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/models["']/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/models['"]/]},
        go: {all: [/HandleFunc\(\s*"POST \/v1\/models"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"models"\s*\)/, /\bpost\s*\{/]},
        cpp: {all: [/svr\.Post\(\s*"\/v1\/models"/]},
      },
    },
    {
      id: 'artifact-resolves',
      title: 'Refuses an artifact digest that does not resolve',
      detail:
        'The digest is resolved in the artifact store and an unknown one answers **422**. The starter accepts any digest the caller sends, so a version can name bytes the registry cannot fetch.',
      match: {
        python: {all: [/require_artifact/, /status_code\s*=\s*422/]},
        typescript: {all: [/requireArtifact/, /\b422\b/]},
        go: {all: [/requireArtifact/, /StatusUnprocessableEntity/]},
        scala: {all: [/requireArtifact/, /UnprocessableEntity/]},
        cpp: {all: [/require_artifact/, /\b422\b/]},
      },
    },
    {
      id: 'training-run-exists',
      title: 'Refuses a training run that does not exist',
      detail:
        'The training run is looked up and must belong to this model; an unknown run is **422**. The starter never consults the training store, so lineage can be invented.',
      match: {
        python: {all: [/require_training_run/, /status_code\s*=\s*422/]},
        typescript: {all: [/requireTrainingRun/, /\b422\b/]},
        go: {all: [/requireTrainingRun/, /StatusUnprocessableEntity/]},
        scala: {all: [/requireTrainingRun/, /UnprocessableEntity/]},
        cpp: {all: [/require_training_run/, /\b422\b/]},
      },
    },
    {
      id: 'eval-bound',
      title: 'Binds the eval record to this model and this digest',
      detail:
        'The eval record must name this model and this exact artifact digest; a mismatch is **422**. The starter lets a version point at an eval from a different model, so a score that never saw these bytes can open the gate.',
      match: {
        python: {all: [/require_eval_binding/, /status_code\s*=\s*422/]},
        typescript: {all: [/requireEvalBinding/, /\b422\b/]},
        go: {all: [/requireEvalBinding/, /StatusUnprocessableEntity/]},
        scala: {all: [/requireEvalBinding/, /UnprocessableEntity/]},
        cpp: {all: [/require_eval_binding/, /\b422\b/]},
      },
    },
    {
      id: 'idempotent-version',
      title: 'Returns the stored version on a replayed registration',
      detail:
        'The response is stored under `(tenant, Idempotency-Key)` and a replay returns it instead of minting a second version. The starter mints a new version on every call, so a client retry forks the model’s history.',
      match: {
        python: {all: [/Idempotency-Key/, /store\.get\(/, /store\.put\(/]},
        typescript: {all: [/idempotency-key/, /store\.get\(/, /store\.put\(/]},
        go: {all: [/Idempotency-Key/, /store\.Get\(/, /store\.Put\(/]},
        scala: {all: [/Idempotency-Key/, /store\.get\(/, /store\.put\(/]},
        cpp: {all: [/Idempotency-Key/, /store\.get\(/, /store\.put\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import uuid

from fastapi import FastAPI, Header
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()


class RegisterBody(BaseModel):
    name: str
    artifact_digest: str
    training_run_id: str
    eval_id: str
    lineage_tag: str


@app.post("/v1/models")
def register_model(body: RegisterBody, tenant: str = Header(alias="X-Tenant-Id")) -> JSONResponse:
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    return JSONResponse(
        {
            "name": body.name,
            "version": f"v{uuid.uuid4().hex[:8]}",
            "artifact_digest": body.artifact_digest,
            "eval_id": body.eval_id,
            "lineage_tag": body.lineage_tag,
            "stage": "staged",
        },
        status_code=201,
    )
`,
      solution: `import uuid

from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()


class RegisterBody(BaseModel):
    name: str
    artifact_digest: str
    training_run_id: str
    eval_id: str
    lineage_tag: str


class ArtifactStore:
    def get(self, digest: str) -> dict | None:
        """The artifact recorded for this digest, if any."""
        raise NotImplementedError


class TrainingRunStore:
    def get(self, run_id: str) -> dict | None:
        """The training run, if any."""
        raise NotImplementedError


class EvalStore:
    def get(self, eval_id: str) -> dict | None:
        """The eval record, if any."""
        raise NotImplementedError


class RegistryStore:
    def get(self, tenant: str, idem_key: str) -> dict | None:
        """The version stored under (tenant, idem_key), if any."""
        raise NotImplementedError

    def put(self, tenant: str, idem_key: str, response: dict) -> None:
        """Store the response under (tenant, idem_key)."""
        raise NotImplementedError


artifacts = ArtifactStore()
training_runs = TrainingRunStore()
evals = EvalStore()
store = RegistryStore()


def require_artifact(digest: str) -> dict:
    record = artifacts.get(digest)
    if record is None:
        raise HTTPException(status_code=422, detail="artifact digest does not resolve")
    return record


def require_training_run(run_id: str, name: str) -> dict:
    run = training_runs.get(run_id)
    if run is None or run.get("model") != name:
        raise HTTPException(status_code=422, detail="unknown training run for this model")
    return run


def require_eval_binding(record: dict, name: str, digest: str) -> None:
    if record.get("model") != name or record.get("artifact_digest") != digest:
        raise HTTPException(status_code=422, detail="eval record is bound to another artifact")


@app.post("/v1/models")
def register_model(
    body: RegisterBody,
    tenant: str | None = Header(default=None, alias="X-Tenant-Id"),
    idem_key: str | None = Header(default=None, alias="Idempotency-Key"),
) -> JSONResponse:
    if tenant is None or tenant == "":
        raise HTTPException(status_code=401, detail="missing X-Tenant-Id")
    if idem_key is None or idem_key == "":
        raise HTTPException(status_code=400, detail="Idempotency-Key is required")

    stored = store.get(tenant, idem_key)
    if stored is not None:
        return JSONResponse(stored, status_code=201)

    require_artifact(body.artifact_digest)
    require_training_run(body.training_run_id, body.name)
    eval_record = evals.get(body.eval_id)
    if eval_record is None:
        raise HTTPException(status_code=422, detail="unknown eval record")
    require_eval_binding(eval_record, body.name, body.artifact_digest)

    response = {
        "name": body.name,
        "version": f"v{uuid.uuid4().hex[:8]}",
        "artifact_digest": body.artifact_digest,
        "eval_id": body.eval_id,
        "lineage_tag": body.lineage_tag,
        "stage": "staged",
    }
    store.put(tenant, idem_key, response)
    return JSONResponse(response, status_code=201)
`,
    },
    typescript: {
      starter: `/** POST /v1/models: registers a version from the request body. */
import {randomUUID} from 'node:crypto';

import Fastify from 'fastify';

export const app = Fastify();

interface RegisterBody {
  name: string;
  artifact_digest: string;
  training_run_id: string;
  eval_id: string;
  lineage_tag: string;
}

app.post('/v1/models', async (request, reply) => {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const body = request.body as RegisterBody;
  return reply.code(201).send({
    name: body.name,
    version: \`v\${randomUUID().slice(0, 8)}\`,
    artifact_digest: body.artifact_digest,
    eval_id: body.eval_id,
    lineage_tag: body.lineage_tag,
    stage: 'staged',
  });
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** POST /v1/models: a version registered only after its lineage is verified. */
import {randomUUID} from 'node:crypto';

import Fastify from 'fastify';

import {artifacts, evals, store, trainingRuns} from './registry';

export const app = Fastify();

interface RegisterBody {
  name: string;
  artifact_digest: string;
  training_run_id: string;
  eval_id: string;
  lineage_tag: string;
}

class RegisterError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function requireArtifact(digest: string): void {
  if (artifacts.get(digest) === null) throw new RegisterError(422, 'artifact digest does not resolve');
}

function requireTrainingRun(runId: string, name: string): void {
  const run = trainingRuns.get(runId);
  if (run === null || run.model !== name) throw new RegisterError(422, 'unknown training run for this model');
}

function requireEvalBinding(record: {model: string; artifact_digest: string}, name: string, digest: string): void {
  if (record.model !== name || record.artifact_digest !== digest)
    throw new RegisterError(422, 'eval record is bound to another artifact');
}

app.post('/v1/models', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing X-Tenant-Id'});
  const idemKey = request.headers['idempotency-key'];
  if (typeof idemKey !== 'string' || idemKey === '')
    return reply.code(400).send({error: 'Idempotency-Key is required'});

  const body = request.body as RegisterBody;
  try {
    const stored = await store.get(tenant, idemKey);
    if (stored !== null) return reply.code(201).send(stored);

    requireArtifact(body.artifact_digest);
    requireTrainingRun(body.training_run_id, body.name);
    const evalRecord = evals.get(body.eval_id);
    if (evalRecord === null) throw new RegisterError(422, 'unknown eval record');
    requireEvalBinding(evalRecord, body.name, body.artifact_digest);

    const response = {
      name: body.name,
      version: \`v\${randomUUID().slice(0, 8)}\`,
      artifact_digest: body.artifact_digest,
      eval_id: body.eval_id,
      lineage_tag: body.lineage_tag,
      stage: 'staged',
    };
    await store.put(tenant, idemKey, response);
    return reply.code(201).send(response);
  } catch (error) {
    if (error instanceof RegisterError) return reply.code(error.status).send({error: error.message});
    throw error;
  }
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

type RegisterBody struct {
	Name           string \`json:"name"\`
	ArtifactDigest string \`json:"artifact_digest"\`
	TrainingRunID  string \`json:"training_run_id"\`
	EvalID         string \`json:"eval_id"\`
	LineageTag     string \`json:"lineage_tag"\`
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func registerModel(rw http.ResponseWriter, r *http.Request) {
	var body RegisterBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	writeJSON(rw, http.StatusCreated, map[string]any{
		"name":            body.Name,
		"version":         "v" + uuid.NewString()[:8],
		"artifact_digest": body.ArtifactDigest,
		"eval_id":         body.EvalID,
		"lineage_tag":     body.LineageTag,
		"stage":           "staged",
	})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/models", registerModel)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
      solution: `package main

import (
	"encoding/json"
	"log"
	"net/http"

	"github.com/google/uuid"
)

type RegisterBody struct {
	Name           string \`json:"name"\`
	ArtifactDigest string \`json:"artifact_digest"\`
	TrainingRunID  string \`json:"training_run_id"\`
	EvalID         string \`json:"eval_id"\`
	LineageTag     string \`json:"lineage_tag"\`
}

type ArtifactStore struct{}

func (s *ArtifactStore) Get(digest string) map[string]any { return nil }

type TrainingRunStore struct{}

func (s *TrainingRunStore) Get(runID string) map[string]any { return nil }

type EvalStore struct{}

func (s *EvalStore) Get(evalID string) map[string]any { return nil }

type RegistryStore struct{}

func (s *RegistryStore) Get(ctx context.Context, tenant, idemKey string) (map[string]any, error) {
	return nil, nil
}

func (s *RegistryStore) Put(ctx context.Context, tenant, idemKey string, response map[string]any) error {
	return nil
}

var (
	artifacts    = &ArtifactStore{}
	trainingRuns = &TrainingRunStore{}
	evals        = &EvalStore{}
	store        = &RegistryStore{}
)

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func requireArtifact(digest string) bool {
	return artifacts.Get(digest) != nil
}

func requireTrainingRun(runID, name string) bool {
	run := trainingRuns.Get(runID)
	return run != nil && run["model"] == name
}

func requireEvalBinding(record map[string]any, name, digest string) bool {
	return record["model"] == name && record["artifact_digest"] == digest
}

func registerModel(rw http.ResponseWriter, r *http.Request) {
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
	var body RegisterBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	stored, err := store.Get(r.Context(), tenant, idemKey)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	if stored != nil {
		writeJSON(rw, http.StatusCreated, stored)
		return
	}
	if !requireArtifact(body.ArtifactDigest) {
		writeJSON(rw, http.StatusUnprocessableEntity, map[string]string{"error": "artifact digest does not resolve"})
		return
	}
	if !requireTrainingRun(body.TrainingRunID, body.Name) {
		writeJSON(rw, http.StatusUnprocessableEntity, map[string]string{"error": "unknown training run for this model"})
		return
	}
	evalRecord := evals.Get(body.EvalID)
	if evalRecord == nil {
		writeJSON(rw, http.StatusUnprocessableEntity, map[string]string{"error": "unknown eval record"})
		return
	}
	if !requireEvalBinding(evalRecord, body.Name, body.ArtifactDigest) {
		writeJSON(rw, http.StatusUnprocessableEntity, map[string]string{"error": "eval record is bound to another artifact"})
		return
	}
	response := map[string]any{
		"name":            body.Name,
		"version":         "v" + uuid.NewString()[:8],
		"artifact_digest": body.ArtifactDigest,
		"eval_id":         body.EvalID,
		"lineage_tag":     body.LineageTag,
		"stage":           "staged",
	}
	if err := store.Put(r.Context(), tenant, idemKey, response); err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	writeJSON(rw, http.StatusCreated, response)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/models", registerModel)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
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
import spray.json.RootJsonFormat

final case class RegisterBody(
    name: String,
    artifact_digest: String,
    training_run_id: String,
    eval_id: String,
    lineage_tag: String
)

object RegistryApi {
  implicit val system: ActorSystem = ActorSystem("model-registry")
  implicit val registerFormat: RootJsonFormat[RegisterBody] = jsonFormat5(RegisterBody)

  val route: Route =
    path("v1" / "models") {
      post {
        headerValueByName("X-Tenant-Id") { tenant =>
          entity(as[RegisterBody]) { body =>
            // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
            val version = s"v\${java.util.UUID.randomUUID().toString.take(8)}"
            complete(
              StatusCodes.Created,
              s"""{"name":"\${body.name}","version":"$version","artifact_digest":"\${body.artifact_digest}","eval_id":"\${body.eval_id}","lineage_tag":"\${body.lineage_tag}","stage":"staged"}"""
            )
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
import org.apache.pekko.http.scaladsl.server.{ExceptionHandler, Route}
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class RegisterBody(
    name: String,
    artifact_digest: String,
    training_run_id: String,
    eval_id: String,
    lineage_tag: String
)

final case class RegisterError(status: StatusCode, message: String) extends RuntimeException(message)

object RegistryApi {
  implicit val system: ActorSystem = ActorSystem("model-registry")
  implicit val registerFormat: RootJsonFormat[RegisterBody] = jsonFormat5(RegisterBody)

  val artifacts = ArtifactStore.open()
  val trainingRuns = TrainingRunStore.open()
  val evals = EvalStore.open()
  val store = RegistryStore.open()

  def requireArtifact(digest: String): Unit =
    if (artifacts.get(digest).isEmpty)
      throw RegisterError(StatusCodes.UnprocessableEntity, "artifact digest does not resolve")

  def requireTrainingRun(runId: String, name: String): Unit =
    trainingRuns.get(runId) match {
      case Some(run) if run.model == name => ()
      case _ => throw RegisterError(StatusCodes.UnprocessableEntity, "unknown training run for this model")
    }

  def requireEvalBinding(record: EvalRecord, name: String, digest: String): Unit =
    if (record.model != name || record.artifact_digest != digest)
      throw RegisterError(StatusCodes.UnprocessableEntity, "eval record is bound to another artifact")

  val handler: ExceptionHandler = ExceptionHandler { case RegisterError(status, message) =>
    complete(status, s"""{"error":"$message"}""")
  }

  val route: Route =
    handleExceptions(handler) {
      path("v1" / "models") {
        post {
          optionalHeaderValueByName("X-Tenant-Id") { tenantOpt =>
            optionalHeaderValueByName("Idempotency-Key") { idemOpt =>
              entity(as[RegisterBody]) { body =>
                if (!tenantOpt.exists(_.nonEmpty)) {
                  complete(StatusCodes.Unauthorized, """{"error":"missing X-Tenant-Id"}""")
                } else if (!idemOpt.exists(_.nonEmpty)) {
                  complete(StatusCodes.BadRequest, """{"error":"Idempotency-Key is required"}""")
                } else {
                  val tenant = tenantOpt.get
                  val idemKey = idemOpt.get
                  store.get(tenant, idemKey) match {
                    case Some(stored) =>
                      complete(StatusCodes.Created, stored)
                    case None =>
                      requireArtifact(body.artifact_digest)
                      requireTrainingRun(body.training_run_id, body.name)
                      val record = evals
                        .get(body.eval_id)
                        .getOrElse(throw RegisterError(StatusCodes.UnprocessableEntity, "unknown eval record"))
                      requireEvalBinding(record, body.name, body.artifact_digest)
                      val version = s"v\${java.util.UUID.randomUUID().toString.take(8)}"
                      val response =
                        s"""{"name":"\${body.name}","version":"$version","artifact_digest":"\${body.artifact_digest}","eval_id":"\${body.eval_id}","lineage_tag":"\${body.lineage_tag}","stage":"staged"}"""
                      store.put(tenant, idemKey, response)
                      complete(StatusCodes.Created, response)
                  }
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

#include <string>

using json = nlohmann::json;

std::string uuidString();

int main() {
  httplib::Server svr;

  svr.Post("/v1/models", [](const httplib::Request& req, httplib::Response& res) {
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) {
      res.status = 400;
      res.set_content(R"({"error":"invalid json"})", "application/json");
      return;
    }
    // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    const json response = {
        {"name", body.value("name", std::string())},
        {"version", "v" + uuidString().substr(0, 8)},
        {"artifact_digest", body.value("artifact_digest", std::string())},
        {"eval_id", body.value("eval_id", std::string())},
        {"lineage_tag", body.value("lineage_tag", std::string())},
        {"stage", "staged"},
    };
    res.status = 201;
    res.set_content(response.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <optional>
#include <string>

using json = nlohmann::json;

struct ArtifactStore {
  std::optional<json> get(const std::string& digest);
};

struct TrainingRunStore {
  std::optional<json> get(const std::string& run_id);
};

struct EvalStore {
  std::optional<json> get(const std::string& eval_id);
};

struct RegistryStore {
  std::optional<json> get(const std::string& tenant, const std::string& idem_key);
  void put(const std::string& tenant, const std::string& idem_key, const json& response);
};

ArtifactStore artifacts;
TrainingRunStore training_runs;
EvalStore evals;
RegistryStore store;

std::string uuidString();

struct RegisterError {
  int status;
  std::string message;
};

void require_artifact(const std::string& digest) {
  if (!artifacts.get(digest)) throw RegisterError{422, "artifact digest does not resolve"};
}

void require_training_run(const std::string& run_id, const std::string& name) {
  const auto run = training_runs.get(run_id);
  if (!run || run->value("model", std::string()) != name)
    throw RegisterError{422, "unknown training run for this model"};
}

void require_eval_binding(const json& record, const std::string& name, const std::string& digest) {
  if (record.value("model", std::string()) != name || record.value("artifact_digest", std::string()) != digest)
    throw RegisterError{422, "eval record is bound to another artifact"};
}

int main() {
  httplib::Server svr;

  svr.Post("/v1/models", [](const httplib::Request& req, httplib::Response& res) {
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
    if (!body.is_object()) {
      res.status = 400;
      res.set_content(R"({"error":"invalid json"})", "application/json");
      return;
    }
    try {
      const auto stored = store.get(tenant, idemKey);
      if (stored) {
        res.status = 201;
        res.set_content(stored->dump(), "application/json");
        return;
      }
      require_artifact(body.value("artifact_digest", std::string()));
      require_training_run(body.value("training_run_id", std::string()), body.value("name", std::string()));
      const auto record = evals.get(body.value("eval_id", std::string()));
      if (!record) throw RegisterError{422, "unknown eval record"};
      require_eval_binding(*record, body.value("name", std::string()), body.value("artifact_digest", std::string()));
      const json response = {
          {"name", body.value("name", std::string())},
          {"version", "v" + uuidString().substr(0, 8)},
          {"artifact_digest", body.value("artifact_digest", std::string())},
          {"eval_id", body.value("eval_id", std::string())},
          {"lineage_tag", body.value("lineage_tag", std::string())},
          {"stage", "staged"},
      };
      store.put(tenant, idemKey, response);
      res.status = 201;
      res.set_content(response.dump(), "application/json");
    } catch (const RegisterError& error) {
      res.status = error.status;
      res.set_content(json{{"error", error.message}}.dump(), "application/json");
    }
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  hints: [
    'A client retries a registration after a network blip and the model now has two versions with identical lineage. A promotion later names one of them while the serving pool loaded the other.',
    'The handler mints a fresh UUID on every call and consults no store, so nothing distinguishes a replay from a new registration, and nothing distinguishes a real digest from a typo.',
    'Guard in cost order: tenant, `Idempotency-Key` (`store.get` replay), `require_artifact`, `require_training_run`, `require_eval_binding` (model and digest both equal), each `422`; then mint, `store.put`, return. The checks cover each guard.',
  ],
  debrief: `The guards run before the mint because a version is a promise the rest of the platform acts on: the serving probe compares against the registered digest, the promotion gate reads the eval record, and the event stream replays the lineage. Each guard answers 422 with the field that failed so a pipeline can repair its request instead of guessing. Storing the response under (tenant, Idempotency-Key) before returning it turns a retry into a read. Production registries go further: MLflow keeps the artifact in an object store it controls and records a source run per version, and model signing (Sigstore, in-toto attestations) lets the registry check who produced the bytes, not only that the bytes exist.`,
};
