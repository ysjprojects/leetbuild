import type {Step} from '@/lib/types';

export const endpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/models: a version with real lineage',
  concept: 'http',
  file: 'api',
  focus: ['client', 'registry', 'db', 'eval'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it registers the route, reads
the body, mints a version and returns it. It compiles, it serves the demo, and it accepts three
claims the registry exists to verify. Review it like the service owner, fix it, and prove the fix
with the checks below.

Implement \`POST /v1/models\` with body
\`{"name": "…", "artifact_digest": "sha256:…", "training_run_id": "…", "eval_id": "…", "lineage_tag": "…"}\`.

- The tenant comes from the authenticated \`X-Tenant-Id\` header; a missing tenant is **401**.
- \`Idempotency-Key\` is required (**400** when missing). A retry with the same \`(tenant, key)\`
  returns the version stored the first time instead of minting a second one.
- The \`artifact_digest\` must **resolve** in the artifact store. An unresolvable digest is
  **422** — a version may not name bytes the registry cannot fetch.
- The \`training_run_id\` must exist **and belong to this model**; an unknown or foreign run is
  **422**. Lineage is a claim, and every claim is checked against the store.
- The \`eval_id\` must exist and be **bound to this model and this exact artifact digest**. An eval
  produced for another model, or for a different digest of the same model, is **422** — otherwise a
  promotion gate could be opened by a score that never saw this artifact.
- The **version is minted by the registry**, never supplied by the caller, and the response carries
  the lineage the registry will serve from: \`{"name", "version", "artifact_digest", "eval_id",
  "lineage_tag", "stage"}\` with \`stage = "staged"\`.

**Failure mode the checks target.** The draft accepts whatever digest it is handed, so a version
can point at bytes that do not exist; it accepts any eval id, so a score from a different model
opens this version's gate; and it mints a fresh version on every retry, so a flaky client forks a
model's history into two versions that were meant to be one.

## What to keep

The response shape and the stage the version starts in are fine. The fix is verification before
minting — artifact, training run, eval binding — plus a version minted from the registry and stored
under \`(tenant, Idempotency-Key)\` so a replay is not a second version.`,
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
        'The digest is resolved in the artifact store and an unknown one answers **422**. The draft accepts any digest the caller sends, so a version can name bytes the registry cannot fetch.',
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
        'The training run is looked up and must belong to this model; an unknown run is **422**. The draft never consults the training store, so lineage can be invented.',
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
        'The eval record must name this model and this exact artifact digest; a mismatch is **422**. The draft lets a version point at an eval from a different model, so a score that never saw these bytes can open the gate.',
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
        'The response is stored under `(tenant, Idempotency-Key)` and a replay returns it instead of minting a second version. The draft mints a new version on every call, so a client retry forks the model’s history.',
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
    # TODO: the draft trusts every claim — it never resolves the artifact digest, never checks the
    # training run, never binds the eval record to the model and the exact digest, and mints a new
    # version on every retry. Verify the lineage, mint the version here, and store the response
    # under (tenant, Idempotency-Key) so a replay returns the original version.
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
      starter: `/** POST /v1/models: a model-generated draft that trusts the caller's lineage. */
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
  // TODO: the draft trusts every claim — it never resolves the artifact digest, never checks the
  // training run, never binds the eval record to the model and the exact digest, and mints a new
  // version on every retry. Verify the lineage, mint the version here, and store the response
  // under (tenant, Idempotency-Key) so a replay returns the original version.
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
	// TODO: the draft trusts every claim — it never resolves the artifact digest, never checks the
	// training run, never binds the eval record to the model and the exact digest, and mints a new
	// version on every retry. Verify the lineage, mint the version here, and store the response
	// under (tenant, Idempotency-Key) so a replay returns the original version.
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
            // TODO: the draft trusts every claim — it never resolves the artifact digest, never
            // checks the training run, never binds the eval record to the model and the exact
            // digest, and mints a new version on every retry. Verify the lineage, mint the version
            // here, and store the response under (tenant, Idempotency-Key) so a replay returns the
            // original version.
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
    // TODO: the draft trusts every claim — it never resolves the artifact digest, never checks the
    // training run, never binds the eval record to the model and the exact digest, and mints a new
    // version on every retry. Verify the lineage, mint the version here, and store the response
    // under (tenant, Idempotency-Key) so a replay returns the original version.
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
    'Verify before you mint. Order the guard clauses by cost: tenant, Idempotency-Key, artifact digest, training run, eval binding — every one of them returns `422` (or `401`/`400`) before a version exists, so an unverifiable lineage can never be stored.',
    'The eval record is not a score you trust, it is a record you match. Require `record.model == body.name` **and** `record.artifact_digest == body.artifact_digest`: a score from another model, or from another digest of the same model, saw different bytes and cannot open this version’s gate.',
    'Mint the version from the registry, never from the caller, and store the response under `(tenant, Idempotency-Key)` before returning it. A replay then reads the stored version back — the same id, the same lineage — instead of forking the model into two versions.',
  ],
  debrief: `The interviewer is testing whether you can review a generated handler at the trust boundary. The draft reads fine because the demo registers well-formed requests from one tenant and never retries. The three defects are one habit: it accepts the caller's claims as facts. A digest that does not resolve makes a version that cannot be served; an eval id that belongs to another model opens a gate on a score that never saw this artifact; a retry that mints a new version forks a model's history into two ids that were meant to be one. Real registries add signature verification of the artifact, immutable version records, a lineage graph that links training runs to data snapshots, and an audit trail that records who registered what and when.`,
};
