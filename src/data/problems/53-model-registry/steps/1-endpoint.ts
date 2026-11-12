import type {Step} from '@/lib/types';

export const endpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/models: a version with checked lineage',
  concept: 'http',
  guides: ['request-boundaries', 'idempotent-requests', 'model-output'],
  file: 'api',
  focus: ['client', 'registry', 'db', 'eval'],
  task: `## Task

**Starting point.** The starter serves \`POST /v1/models\` with body
\`{name, artifact_digest, training_run_id, eval_id}\`: it reads the tenant from \`X-Tenant-Id\` (401
when missing), calls \`store.register_version\` (\`registry.store\`, provided), which mints the next
version as \`staged\`, and answers **201** with the version row. It serves the demo and hides three
flaws.

**Failure mode the checks target.** A version that names bytes the artifact store cannot fetch or a
training run of another model; an eval score measured on another model or another digest opening
the promotion gate; and a client that times out and retries minting a second version.

- \`store.artifact(digest)\` must resolve and \`store.training_run(run_id)\` must be a run of this
  model; otherwise **422** and nothing is registered.
- \`store.eval_record(eval_id)\` must name this model and this exact \`artifact_digest\`; otherwise
  **422**.
- \`Idempotency-Key\` is required (**400**). Look \`(tenant, key)\` up with \`store.registration\` before
  registering, answer the recorded row on a replay, and record a new one with
  \`store.record_registration\`.`,
  sequence: {
    participants: ['Client', 'registryd', 'registry.store'],
    messages: [
      {from: 'Client', to: 'registryd', label: 'POST /v1/models · X-Tenant-Id · Idempotency-Key', kind: 'sync'},
      {from: 'registryd', to: 'registry.store', label: 'registration(tenant, key) → recorded / none', kind: 'sync'},
      {from: 'registryd', to: 'registry.store', label: 'artifact(digest) · training_run(run_id)', kind: 'sync'},
      {from: 'registryd', to: 'registry.store', label: 'eval_record(eval_id): this model, this digest?', kind: 'sync'},
      {from: 'registryd', to: 'registry.store', label: 'register_version · record_registration', kind: 'sync'},
      {from: 'registryd', to: 'Client', label: '201 {name, version, stage: "staged"} · or 422', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Registers a version on POST /v1/models',
      detail: 'Register `POST /v1/models`; a valid registration answers 201 with the version the store minted.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/models["']/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/models['"]/]},
        go: {all: [/HandleFunc\(\s*"POST \/v1\/models"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"models"\s*\)/, /\bpost\s*\{/]},
        cpp: {all: [/svr\.Post\(\s*"\/v1\/models"/]},
      },
    },
    {
      id: 'lineage',
      title: 'Refuses an artifact that does not resolve or a run of another model',
      detail:
        'The digest is looked up with `artifact` and the run with `training_run`/`trainingRun`, which must name this model; either failing answers **422** before anything is registered.',
      match: {
        python: {all: [/store\.artifact\(/, /store\.training_run\(/, /\b422\b/]},
        typescript: {all: [/\bartifact\(/, /\btrainingRun\(/, /\b422\b/]},
        go: {all: [/store\.Artifact\(/, /store\.TrainingRun\(/, /StatusUnprocessableEntity|\b422\b/]},
        scala: {all: [/Store\.artifact\(/, /Store\.trainingRun\(/, /UnprocessableEntity|\b422\b/]},
        cpp: {all: [/store::artifact\(/, /store::trainingRun\(/, /\b422\b/]},
      },
    },
    {
      id: 'eval-bound',
      title: 'Binds the eval record to this model and this digest',
      detail:
        'The eval record (`eval_record`/`evalRecord`) must exist and name this model and this exact artifact digest; a score measured on other bytes answers **422**.',
      match: {
        python: {all: [/store\.eval_record\(/, /\[["']artifact_digest["']\]/]},
        typescript: {all: [/\bevalRecord\(/, /\.artifact_digest\s*(!==|===)/]},
        go: {all: [/store\.EvalRecord\(/, /\.ArtifactDigest\s*(!=|==)/]},
        scala: {all: [/Store\.evalRecord\(/, /\.artifactDigest\s*(!=|==)/]},
        cpp: {all: [/store::evalRecord\(/, /->artifact_digest\s*(!=|==)/]},
      },
    },
    {
      id: 'idempotent-version',
      title: 'A retried registration answers the recorded version',
      detail:
        '`Idempotency-Key` is required (400 without it) and `(tenant, key)` is looked up with `registration` before `register_version`; a replay answers the recorded row and a new registration is recorded.',
      match: {
        python: {
          all: [/idempotency-key/i, /store\.registration\(/, /store\.record_registration\(/, /\b400\b/],
          order: [/store\.registration\(/, /store\.register_version\(/],
        },
        typescript: {
          all: [/idempotency-key/i, /\bregistration\(/, /recordRegistration\(/, /\b400\b/],
          order: [/\bregistration\(/, /registerVersion\(/],
        },
        go: {
          all: [/Idempotency-Key/i, /store\.Registration\(/, /store\.RecordRegistration\(/, /StatusBadRequest|\b400\b/],
          order: [/store\.Registration\(/, /store\.RegisterVersion\(/],
        },
        scala: {
          all: [/Idempotency-Key/i, /Store\.registration\(/, /Store\.recordRegistration\(/, /BadRequest|\b400\b/],
          order: [/Store\.registration\(/, /Store\.registerVersion\(/],
        },
        cpp: {
          all: [/Idempotency-Key/i, /store::registration\(/, /store::recordRegistration\(/, /\b400\b/],
          order: [/store::registration\(/, /store::registerVersion\(/],
        },
      },
    },
  ],
  code: {
    python: {
      starter: `from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from registry import store  # artifact, training_run, eval_record, register_version, registration, record_registration

app = FastAPI()


class RegisterBody(BaseModel):
    name: str
    artifact_digest: str
    training_run_id: str
    eval_id: str


@app.post("/v1/models", status_code=201)
def register_model(body: RegisterBody, request: Request) -> JSONResponse:
    # TODO: this starter has three flaws. The task says where to look; the checks say what must change.
    tenant = request.headers.get("x-tenant-id", "")
    if not tenant:
        raise HTTPException(status_code=401, detail="X-Tenant-Id is required")
    row = store.register_version(tenant, body.name, body.artifact_digest, body.training_run_id, body.eval_id)
    return JSONResponse(row, status_code=201)
`,
      solution: `from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from registry import store  # artifact, training_run, eval_record, register_version, registration, record_registration

app = FastAPI()


class RegisterBody(BaseModel):
    name: str
    artifact_digest: str
    training_run_id: str
    eval_id: str


@app.post("/v1/models", status_code=201)
def register_model(body: RegisterBody, request: Request) -> JSONResponse:
    tenant = request.headers.get("x-tenant-id", "")
    if not tenant:
        raise HTTPException(status_code=401, detail="X-Tenant-Id is required")
    key = request.headers.get("idempotency-key", "")
    if not key:
        raise HTTPException(status_code=400, detail="Idempotency-Key is required")
    recorded = store.registration(tenant, key)
    if recorded is not None:
        return JSONResponse(recorded, status_code=201)  # a retry answers what the first attempt answered
    # Lineage the registry checks itself: the bytes exist and the run trained this model.
    if store.artifact(body.artifact_digest) is None:
        raise HTTPException(status_code=422, detail=f"artifact {body.artifact_digest} does not resolve")
    run = store.training_run(body.training_run_id)
    if run is None or run["model"] != body.name:
        raise HTTPException(status_code=422, detail=f"training run {body.training_run_id} did not train {body.name}")
    # The score that opens the gate must have been measured on exactly these bytes.
    record = store.eval_record(body.eval_id)
    if record is None or record["model"] != body.name or record["artifact_digest"] != body.artifact_digest:
        raise HTTPException(status_code=422, detail=f"eval {body.eval_id} did not score {body.name} at {body.artifact_digest}")
    row = store.register_version(tenant, body.name, body.artifact_digest, body.training_run_id, body.eval_id)
    store.record_registration(tenant, key, row)
    return JSONResponse(row, status_code=201)
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';

import {artifact, evalRecord, recordRegistration, registerVersion, registration, trainingRun} from 'registry/store';

export const app = Fastify();

interface RegisterBody {
  name: string;
  artifact_digest: string;
  training_run_id: string;
  eval_id: string;
}

app.post('/v1/models', async (request, reply) => {
  // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'X-Tenant-Id is required'});
  const body = request.body as RegisterBody;
  const row = await registerVersion(tenant, body.name, body.artifact_digest, body.training_run_id, body.eval_id);
  return reply.code(201).send(row);
});
`,
      solution: `import Fastify from 'fastify';

import {artifact, evalRecord, recordRegistration, registerVersion, registration, trainingRun} from 'registry/store';

export const app = Fastify();

interface RegisterBody {
  name: string;
  artifact_digest: string;
  training_run_id: string;
  eval_id: string;
}

app.post('/v1/models', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'X-Tenant-Id is required'});
  const key = request.headers['idempotency-key'];
  if (typeof key !== 'string' || key === '') return reply.code(400).send({error: 'Idempotency-Key is required'});
  const recorded = await registration(tenant, key);
  if (recorded !== null) return reply.code(201).send(recorded); // a retry answers what the first attempt answered
  const body = request.body as RegisterBody;
  // Lineage the registry checks itself: the bytes exist and the run trained this model.
  if ((await artifact(body.artifact_digest)) === null) {
    return reply.code(422).send({error: \`artifact \${body.artifact_digest} does not resolve\`});
  }
  const run = await trainingRun(body.training_run_id);
  if (run === null || run.model !== body.name) {
    return reply.code(422).send({error: \`training run \${body.training_run_id} did not train \${body.name}\`});
  }
  // The score that opens the gate must have been measured on exactly these bytes.
  const record = await evalRecord(body.eval_id);
  if (record === null || record.model !== body.name || record.artifact_digest !== body.artifact_digest) {
    return reply.code(422).send({error: \`eval \${body.eval_id} did not score \${body.name} at \${body.artifact_digest}\`});
  }
  const row = await registerVersion(tenant, body.name, body.artifact_digest, body.training_run_id, body.eval_id);
  await recordRegistration(tenant, key, {...row});
  return reply.code(201).send(row);
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"net/http"

	"registry/store" // store.Artifact, TrainingRun, EvalRecord, RegisterVersion, Registration, RecordRegistration
)

type registerBody struct {
	Name           string \`json:"name"\`
	ArtifactDigest string \`json:"artifact_digest"\`
	TrainingRunID  string \`json:"training_run_id"\`
	EvalID         string \`json:"eval_id"\`
}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func registerModel(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has three flaws. The task says where to look; the checks say what must change.
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		http.Error(rw, "X-Tenant-Id is required", http.StatusUnauthorized)
		return
	}
	var body registerBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(rw, err.Error(), http.StatusBadRequest)
		return
	}
	row := store.RegisterVersion(r.Context(), tenant, body.Name, body.ArtifactDigest, body.TrainingRunID, body.EvalID)
	writeJSON(rw, http.StatusCreated, row)
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/models", registerModel)
}
`,
      solution: `package main

import (
	"encoding/json"
	"fmt"
	"net/http"

	"registry/store" // store.Artifact, TrainingRun, EvalRecord, RegisterVersion, Registration, RecordRegistration
)

type registerBody struct {
	Name           string \`json:"name"\`
	ArtifactDigest string \`json:"artifact_digest"\`
	TrainingRunID  string \`json:"training_run_id"\`
	EvalID         string \`json:"eval_id"\`
}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func registerModel(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		http.Error(rw, "X-Tenant-Id is required", http.StatusUnauthorized)
		return
	}
	key := r.Header.Get("Idempotency-Key")
	if key == "" {
		http.Error(rw, "Idempotency-Key is required", http.StatusBadRequest)
		return
	}
	if recorded := store.Registration(r.Context(), tenant, key); recorded != nil {
		writeJSON(rw, http.StatusCreated, recorded) // a retry answers what the first attempt answered
		return
	}
	var body registerBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(rw, err.Error(), http.StatusBadRequest)
		return
	}
	// Lineage the registry checks itself: the bytes exist and the run trained this model.
	if store.Artifact(r.Context(), body.ArtifactDigest) == nil {
		http.Error(rw, fmt.Sprintf("artifact %s does not resolve", body.ArtifactDigest), http.StatusUnprocessableEntity)
		return
	}
	if run := store.TrainingRun(r.Context(), body.TrainingRunID); run == nil || run.Model != body.Name {
		http.Error(rw, fmt.Sprintf("training run %s did not train %s", body.TrainingRunID, body.Name), http.StatusUnprocessableEntity)
		return
	}
	// The score that opens the gate must have been measured on exactly these bytes.
	record := store.EvalRecord(r.Context(), body.EvalID)
	if record == nil || record.Model != body.Name || record.ArtifactDigest != body.ArtifactDigest {
		http.Error(rw, fmt.Sprintf("eval %s did not score %s at %s", body.EvalID, body.Name, body.ArtifactDigest), http.StatusUnprocessableEntity)
		return
	}
	row := store.RegisterVersion(r.Context(), tenant, body.Name, body.ArtifactDigest, body.TrainingRunID, body.EvalID)
	store.RecordRegistration(r.Context(), tenant, key, row)
	writeJSON(rw, http.StatusCreated, row)
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/models", registerModel)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import registry.Store // Store.artifact, trainingRun, evalRecord, registerVersion, registration, recordRegistration, rowJson

object Api {
  private def created(body: JsObject): HttpResponse =
    HttpResponse(StatusCodes.Created, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  /** A string field of the request body ("" when absent). */
  private def text(body: JsObject, name: String): String = body.fields.get(name).collect { case JsString(s) => s }.getOrElse("")

  val route: Route =
    path("v1" / "models") {
      post {
        optionalHeaderValueByName("X-Tenant-Id") {
          case None | Some("") => complete(StatusCodes.Unauthorized -> "X-Tenant-Id is required")
          case Some(tenant) =>
            entity(as[String]) { raw =>
              // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
              val body = raw.parseJson.asJsObject
              val row = Store.registerVersion(tenant, text(body, "name"), text(body, "artifact_digest"), text(body, "training_run_id"), text(body, "eval_id"))
              complete(created(Store.rowJson(row)))
            }
        }
      }
    }
}
`,
      solution: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import registry.Store // Store.artifact, trainingRun, evalRecord, registerVersion, registration, recordRegistration, rowJson

object Api {
  private def created(body: JsObject): HttpResponse =
    HttpResponse(StatusCodes.Created, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  /** A string field of the request body ("" when absent). */
  private def text(body: JsObject, name: String): String = body.fields.get(name).collect { case JsString(s) => s }.getOrElse("")

  /** Why the lineage or the eval binding refuses this registration, if it does. */
  private def refusal(name: String, digest: String, runId: String, evalId: String): Option[String] =
    if (Store.artifact(digest).isEmpty) Some(s"artifact $digest does not resolve")
    else if (!Store.trainingRun(runId).exists(_.model == name)) Some(s"training run $runId did not train $name")
    else
      Store.evalRecord(evalId) match {
        // The score that opens the gate must have been measured on exactly these bytes.
        case Some(record) if record.model == name && record.artifactDigest == digest => None
        case _ => Some(s"eval $evalId did not score $name at $digest")
      }

  val route: Route =
    path("v1" / "models") {
      post {
        optionalHeaderValueByName("X-Tenant-Id") {
          case None | Some("") => complete(StatusCodes.Unauthorized -> "X-Tenant-Id is required")
          case Some(tenant) =>
            optionalHeaderValueByName("Idempotency-Key") {
              case None | Some("") => complete(StatusCodes.BadRequest -> "Idempotency-Key is required")
              case Some(key) =>
                entity(as[String]) { raw =>
                  Store.registration(tenant, key) match {
                    case Some(recorded) => complete(created(recorded)) // a retry answers what the first attempt answered
                    case None =>
                      val body = raw.parseJson.asJsObject
                      val (name, digest, runId, evalId) = (text(body, "name"), text(body, "artifact_digest"), text(body, "training_run_id"), text(body, "eval_id"))
                      refusal(name, digest, runId, evalId) match {
                        case Some(reason) => complete(StatusCodes.UnprocessableEntity -> reason)
                        case None =>
                          val row = Store.rowJson(Store.registerVersion(tenant, name, digest, runId, evalId))
                          Store.recordRegistration(tenant, key, row)
                          complete(created(row))
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
      starter: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <string>

#include "registry/store.h"  // store::artifact, trainingRun, evalRecord, registerVersion, registration, recordRegistration, rowJson

using json = nlohmann::json;

void register_model(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) {
    res.status = 401;
    res.set_content("X-Tenant-Id is required", "text/plain");
    return;
  }
  const json body = json::parse(req.body);
  const store::Row row = store::registerVersion(tenant, body.value("name", ""), body.value("artifact_digest", ""),
                                                body.value("training_run_id", ""), body.value("eval_id", ""));
  res.status = 201;
  res.set_content(store::rowJson(row).dump(), "application/json");
}

void register_routes(httplib::Server& svr) {
  svr.Post("/v1/models", register_model);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <string>

#include "registry/store.h"  // store::artifact, trainingRun, evalRecord, registerVersion, registration, recordRegistration, rowJson

using json = nlohmann::json;

void refuse(httplib::Response& res, int status, const std::string& reason) {
  res.status = status;
  res.set_content(reason, "text/plain");
}

void register_model(const httplib::Request& req, httplib::Response& res) {
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) return refuse(res, 401, "X-Tenant-Id is required");
  const std::string key = req.get_header_value("Idempotency-Key");
  if (key.empty()) return refuse(res, 400, "Idempotency-Key is required");
  if (const auto recorded = store::registration(tenant, key)) {
    res.status = 201;  // a retry answers what the first attempt answered
    res.set_content(recorded->dump(), "application/json");
    return;
  }
  const json body = json::parse(req.body);
  const std::string name = body.value("name", "");
  const std::string digest = body.value("artifact_digest", "");
  const std::string run_id = body.value("training_run_id", "");
  const std::string eval_id = body.value("eval_id", "");
  // Lineage the registry checks itself: the bytes exist and the run trained this model.
  if (!store::artifact(digest)) return refuse(res, 422, "artifact " + digest + " does not resolve");
  const auto run = store::trainingRun(run_id);
  if (!run || run->model != name) return refuse(res, 422, "training run " + run_id + " did not train " + name);
  // The score that opens the gate must have been measured on exactly these bytes.
  const auto record = store::evalRecord(eval_id);
  if (!record || record->model != name || record->artifact_digest != digest) {
    return refuse(res, 422, "eval " + eval_id + " did not score " + name + " at " + digest);
  }
  const json row = store::rowJson(store::registerVersion(tenant, name, digest, run_id, eval_id));
  store::recordRegistration(tenant, key, row);
  res.status = 201;
  res.set_content(row.dump(), "application/json");
}

void register_routes(httplib::Server& svr) {
  svr.Post("/v1/models", register_model);
}
`,
    },
  },
  harness: {
    python: `from registry import store

DIGEST = "sha256:a1"
OTHER = "sha256:b2"
FRAUD = {"name": "fraud", "artifact_digest": DIGEST, "training_run_id": "r-1", "eval_id": "e-1"}
CHURN = {"name": "churn", "artifact_digest": DIGEST, "training_run_id": "r-churn", "eval_id": "e-churn"}


def _api(ctx):
    m = ctx.load("api")
    store.add_artifact(DIGEST, "s3://models/a1")
    store.add_artifact(OTHER, "s3://models/b2")
    store.add_training_run("r-1", "fraud")
    store.add_training_run("r-churn", "churn")
    store.add_eval("e-1", "fraud", DIGEST, 0.91, 0.85, "precision 0.91 on holdout-2026-10")
    store.add_eval("e-other", "fraud", OTHER, 0.93, 0.85, "precision 0.93 on holdout-2026-10")
    store.add_eval("e-churn", "churn", DIGEST, 0.88, 0.85, "recall 0.88 on churn-holdout")
    return ctx.client(m.app)


async def _post(c, body, key="k-1", tenant="t1"):
    headers = {"X-Tenant-Id": tenant}
    if key:
        headers["Idempotency-Key"] = key
    return await c.post("/v1/models", json=body, headers=headers)


async def _refused(ctx, c, body, key, why):
    r = await _post(c, body, key)
    assert r.status_code == 422, f"{why}: the registration answered {r.status_code} {r.text}, expected 422"
    assert ctx.redis.keys("model:*:v*") == [], f"{why}: a version was written anyway ({ctx.redis.keys('model:*:v*')})"


async def check_route(ctx):
    async with _api(ctx) as c:
        r = await _post(c, FRAUD)
        assert r.status_code == 201, f"POST /v1/models answered {r.status_code}: {r.text}"
        body = r.json()
        assert body.get("name") == "fraud" and body.get("version") == 1 and body.get("stage") == "staged", f"the first registration must answer fraud version 1, staged; got {body}"
        row = store.version("fraud", 1)
        assert row is not None and row["artifact_digest"] == DIGEST, f"the store holds {row} for fraud version 1"
        none = await c.post("/v1/models", json=FRAUD, headers={"Idempotency-Key": "k-2"})
    assert none.status_code == 401, f"a registration without X-Tenant-Id answered {none.status_code}, expected 401"


async def check_lineage(ctx):
    async with _api(ctx) as c:
        await _refused(ctx, c, {**FRAUD, "artifact_digest": "sha256:dead"}, "k-1", "with an artifact digest that does not resolve")
        await _refused(ctx, c, {**FRAUD, "training_run_id": "r-churn"}, "k-2", "with a training run of the churn model")
        await _refused(ctx, c, {**FRAUD, "training_run_id": "r-404"}, "k-3", "with a training run that does not exist")
        r = await _post(c, FRAUD, "k-4")
    assert r.status_code == 201 and r.json().get("version") == 1, f"with its lineage in place the registration must answer version 1, got {r.status_code} {r.text}"


async def check_eval_bound(ctx):
    async with _api(ctx) as c:
        await _refused(ctx, c, {**FRAUD, "eval_id": "e-churn"}, "k-1", "with an eval record of the churn model")
        await _refused(ctx, c, {**FRAUD, "eval_id": "e-other"}, "k-2", "with an eval record measured on another digest of fraud")
        await _refused(ctx, c, {**FRAUD, "eval_id": "e-404"}, "k-3", "with an eval record that does not exist")
        r = await _post(c, FRAUD, "k-4")
        assert r.status_code == 201, f"with its own eval record the registration answered {r.status_code}: {r.text}"
        r = await _post(c, {**FRAUD, "artifact_digest": OTHER, "eval_id": "e-other"}, "k-5")
    assert r.status_code == 201 and r.json().get("version") == 2, f"the other digest with the eval measured on it must register as version 2, got {r.status_code} {r.text}"


async def check_idempotent_version(ctx):
    async with _api(ctx) as c:
        first = await _post(c, FRAUD, "k-1")
        assert first.status_code == 201, f"the first registration answered {first.status_code}: {first.text}"
        replay = await _post(c, FRAUD, "k-1")
        assert replay.status_code == 201 and replay.json() == first.json(), f"a retry with the same Idempotency-Key must answer the recorded version: first {first.json()}, retry {replay.json()}"
        assert ctx.redis.exists("model:fraud:v2") == 0, "the retry minted fraud version 2: one registration, two versions"
        fresh = await _post(c, FRAUD, "k-2")
        assert fresh.json().get("version") == 2, f"a new Idempotency-Key is a new registration (version 2), got {fresh.text}"
        other = await _post(c, CHURN, "k-1", tenant="t2")
        assert other.status_code == 201 and other.json().get("name") == "churn", f"another tenant's k-1 is its own registration: it answered {other.text}"
        none = await _post(c, FRAUD, "")
    assert none.status_code == 400, f"a registration without Idempotency-Key answered {none.status_code}, expected 400"
`,
    typescript: `const DIGEST = 'sha256:a1';
const OTHER = 'sha256:b2';
const FRAUD = {name: 'fraud', artifact_digest: DIGEST, training_run_id: 'r-1', eval_id: 'e-1'};
const CHURN = {name: 'churn', artifact_digest: DIGEST, training_run_id: 'r-churn', eval_id: 'e-churn'};

async function api(ctx) {
  const m = ctx.load('api');
  const store = ctx.load('/support/registry/store.ts');
  await store.addArtifact(DIGEST, 's3://models/a1');
  await store.addArtifact(OTHER, 's3://models/b2');
  await store.addTrainingRun('r-1', 'fraud');
  await store.addTrainingRun('r-churn', 'churn');
  await store.addEval('e-1', 'fraud', DIGEST, 0.91, 0.85, 'precision 0.91 on holdout-2026-10');
  await store.addEval('e-other', 'fraud', OTHER, 0.93, 0.85, 'precision 0.93 on holdout-2026-10');
  await store.addEval('e-churn', 'churn', DIGEST, 0.88, 0.85, 'recall 0.88 on churn-holdout');
  return {c: ctx.client(m.app), store};
}

function post(c, body, key = 'k-1', tenant = 't1') {
  const headers: Record<string, string> = {'X-Tenant-Id': tenant};
  if (key) headers['Idempotency-Key'] = key;
  return c.post('/v1/models', {json: body, headers});
}

async function refused(ctx, c, body, key: string, why: string): Promise<void> {
  const r = await post(c, body, key);
  assert.equal(r.status, 422, \`\${why}: the registration answered \${r.status} \${r.text}, expected 422\`);
  const versions = ctx.redis.keys('model:*:v*');
  assert.equal(versions.length, 0, \`\${why}: a version was written anyway (\${JSON.stringify(versions)})\`);
}

export async function check_route(ctx) {
  const {c, store} = await api(ctx);
  const r = await post(c, FRAUD);
  assert.equal(r.status, 201, \`POST /v1/models answered \${r.status}: \${r.text}\`);
  const body = r.json();
  assert(body.name === 'fraud' && body.version === 1 && body.stage === 'staged', \`the first registration must answer fraud version 1, staged; got \${r.text}\`);
  const row = await store.version('fraud', 1);
  assert(row !== null && row.artifact_digest === DIGEST, \`the store holds \${JSON.stringify(row)} for fraud version 1\`);
  const none = await c.post('/v1/models', {json: FRAUD, headers: {'Idempotency-Key': 'k-2'}});
  assert.equal(none.status, 401, \`a registration without X-Tenant-Id answered \${none.status}, expected 401\`);
}

export async function check_lineage(ctx) {
  const {c} = await api(ctx);
  await refused(ctx, c, {...FRAUD, artifact_digest: 'sha256:dead'}, 'k-1', 'with an artifact digest that does not resolve');
  await refused(ctx, c, {...FRAUD, training_run_id: 'r-churn'}, 'k-2', 'with a training run of the churn model');
  await refused(ctx, c, {...FRAUD, training_run_id: 'r-404'}, 'k-3', 'with a training run that does not exist');
  const r = await post(c, FRAUD, 'k-4');
  assert(r.status === 201 && r.json().version === 1, \`with its lineage in place the registration must answer version 1, got \${r.status} \${r.text}\`);
}

export async function check_eval_bound(ctx) {
  const {c} = await api(ctx);
  await refused(ctx, c, {...FRAUD, eval_id: 'e-churn'}, 'k-1', 'with an eval record of the churn model');
  await refused(ctx, c, {...FRAUD, eval_id: 'e-other'}, 'k-2', 'with an eval record measured on another digest of fraud');
  await refused(ctx, c, {...FRAUD, eval_id: 'e-404'}, 'k-3', 'with an eval record that does not exist');
  let r = await post(c, FRAUD, 'k-4');
  assert.equal(r.status, 201, \`with its own eval record the registration answered \${r.status}: \${r.text}\`);
  r = await post(c, {...FRAUD, artifact_digest: OTHER, eval_id: 'e-other'}, 'k-5');
  assert(r.status === 201 && r.json().version === 2, \`the other digest with the eval measured on it must register as version 2, got \${r.status} \${r.text}\`);
}

export async function check_idempotent_version(ctx) {
  const {c} = await api(ctx);
  const first = await post(c, FRAUD, 'k-1');
  assert.equal(first.status, 201, \`the first registration answered \${first.status}: \${first.text}\`);
  const replay = await post(c, FRAUD, 'k-1');
  assert(replay.status === 201 && replay.json().version === first.json().version, \`a retry with the same Idempotency-Key must answer the recorded version: first \${first.text}, retry \${replay.text}\`);
  assert.equal(ctx.redis.exists('model:fraud:v2'), 0, 'the retry minted fraud version 2: one registration, two versions');
  const fresh = await post(c, FRAUD, 'k-2');
  assert.equal(fresh.json().version, 2, \`a new Idempotency-Key is a new registration (version 2), got \${fresh.text}\`);
  const other = await post(c, CHURN, 'k-1', 't2');
  assert(other.status === 201 && other.json().name === 'churn', \`another tenant's k-1 is its own registration: it answered \${other.text}\`);
  const none = await post(c, FRAUD, '');
  assert.equal(none.status, 400, \`a registration without Idempotency-Key answered \${none.status}, expected 400\`);
}
`,
    go: `package main

import (
	"context"
	"net/http"

	"registry/store"

	"leetbuild/harness"
)

const (
	digest = "sha256:a1"
	other  = "sha256:b2"
)

var (
	apiBg = context.Background()
	fraud = map[string]string{"name": "fraud", "artifact_digest": digest, "training_run_id": "r-1", "eval_id": "e-1"}
	churn = map[string]string{"name": "churn", "artifact_digest": digest, "training_run_id": "r-churn", "eval_id": "e-churn"}
)

func with(body map[string]string, field, value string) map[string]string {
	out := map[string]string{}
	for k, v := range body {
		out[k] = v
	}
	out[field] = value
	return out
}

func api(ctx *harness.Ctx) *harness.HTTP {
	store.AddArtifact(apiBg, digest, "s3://models/a1")
	store.AddArtifact(apiBg, other, "s3://models/b2")
	store.AddTrainingRun(apiBg, "r-1", "fraud")
	store.AddTrainingRun(apiBg, "r-churn", "churn")
	store.AddEval(apiBg, "e-1", "fraud", digest, 0.91, 0.85, "precision 0.91 on holdout-2026-10")
	store.AddEval(apiBg, "e-other", "fraud", other, 0.93, 0.85, "precision 0.93 on holdout-2026-10")
	store.AddEval(apiBg, "e-churn", "churn", digest, 0.88, 0.85, "recall 0.88 on churn-holdout")
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

func post(c *harness.HTTP, body map[string]string, key, tenant string) *harness.Response {
	if key == "" {
		return c.Post("/v1/models", body, "X-Tenant-Id", tenant)
	}
	return c.Post("/v1/models", body, "X-Tenant-Id", tenant, "Idempotency-Key", key)
}

type answer struct {
	Name    string \`json:"name"\`
	Version int    \`json:"version"\`
	Stage   string \`json:"stage"\`
}

func decode(r *harness.Response) answer {
	var a answer
	r.Decode(&a)
	return a
}

func refused(ctx *harness.Ctx, c *harness.HTTP, body map[string]string, key, why string) {
	r := post(c, body, key, "t1")
	ctx.Equal(r.Status, 422, "%s: the registration answered %s; the status", why, r.Text())
	ctx.Equal(len(ctx.Redis.Keys("model:*:v*")), 0, "%s: a version was written anyway; the versions", why)
}

func CheckRoute(ctx *harness.Ctx) {
	c := api(ctx)
	r := post(c, fraud, "k-1", "t1")
	ctx.Equal(r.Status, 201, "POST /v1/models (%s)", r.Text())
	a := decode(r)
	ctx.Assert(a.Name == "fraud" && a.Version == 1 && a.Stage == "staged", "the first registration must answer fraud version 1, staged; got %s", r.Text())
	row := store.Version(apiBg, "fraud", 1)
	ctx.Assert(row != nil && row.ArtifactDigest == digest, "the store holds %+v for fraud version 1", row)
	none := c.Post("/v1/models", fraud, "Idempotency-Key", "k-2")
	ctx.Equal(none.Status, 401, "a registration without X-Tenant-Id")
}

func CheckLineage(ctx *harness.Ctx) {
	c := api(ctx)
	refused(ctx, c, with(fraud, "artifact_digest", "sha256:dead"), "k-1", "with an artifact digest that does not resolve")
	refused(ctx, c, with(fraud, "training_run_id", "r-churn"), "k-2", "with a training run of the churn model")
	refused(ctx, c, with(fraud, "training_run_id", "r-404"), "k-3", "with a training run that does not exist")
	r := post(c, fraud, "k-4", "t1")
	ctx.Assert(r.Status == 201 && decode(r).Version == 1, "with its lineage in place the registration must answer version 1, got %d %s", r.Status, r.Text())
}

func CheckEvalBound(ctx *harness.Ctx) {
	c := api(ctx)
	refused(ctx, c, with(fraud, "eval_id", "e-churn"), "k-1", "with an eval record of the churn model")
	refused(ctx, c, with(fraud, "eval_id", "e-other"), "k-2", "with an eval record measured on another digest of fraud")
	refused(ctx, c, with(fraud, "eval_id", "e-404"), "k-3", "with an eval record that does not exist")
	r := post(c, fraud, "k-4", "t1")
	ctx.Equal(r.Status, 201, "with its own eval record the registration (%s)", r.Text())
	r = post(c, with(with(fraud, "artifact_digest", other), "eval_id", "e-other"), "k-5", "t1")
	ctx.Assert(r.Status == 201 && decode(r).Version == 2, "the other digest with the eval measured on it must register as version 2, got %d %s", r.Status, r.Text())
}

func CheckIdempotentVersion(ctx *harness.Ctx) {
	c := api(ctx)
	first := post(c, fraud, "k-1", "t1")
	ctx.Equal(first.Status, 201, "the first registration (%s)", first.Text())
	replay := post(c, fraud, "k-1", "t1")
	ctx.Assert(replay.Status == 201 && decode(replay).Version == decode(first).Version, "a retry with the same Idempotency-Key must answer the recorded version: first %s, retry %s", first.Text(), replay.Text())
	ctx.Equal(ctx.Redis.Exists("model:fraud:v2"), 0, "the retry minted fraud version 2 (one registration, two versions); model:fraud:v2 exists")
	fresh := post(c, fraud, "k-2", "t1")
	ctx.Equal(decode(fresh).Version, 2, "a new Idempotency-Key is a new registration (%s); the version", fresh.Text())
	theirs := post(c, churn, "k-1", "t2")
	ctx.Assert(theirs.Status == 201 && decode(theirs).Name == "churn", "another tenant's k-1 is its own registration: it answered %s", theirs.Text())
	none := post(c, fraud, "", "t1")
	ctx.Equal(none.Status, 400, "a registration without Idempotency-Key")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <string>

namespace {

const std::string kDigest = "sha256:a1";
const std::string kOther = "sha256:b2";

nlohmann::json body(const std::string& name, const std::string& digest, const std::string& run_id, const std::string& eval_id) {
  return {{"name", name}, {"artifact_digest", digest}, {"training_run_id", run_id}, {"eval_id", eval_id}};
}

const nlohmann::json kFraud = body("fraud", kDigest, "r-1", "e-1");
const nlohmann::json kChurn = body("churn", kDigest, "r-churn", "e-churn");

nlohmann::json with(nlohmann::json b, const std::string& field, const std::string& value) {
  b[field] = value;
  return b;
}

harness::HTTP api(harness::Ctx& ctx) {
  store::addArtifact(kDigest, "s3://models/a1");
  store::addArtifact(kOther, "s3://models/b2");
  store::addTrainingRun("r-1", "fraud");
  store::addTrainingRun("r-churn", "churn");
  store::addEval("e-1", "fraud", kDigest, 0.91, 0.85, "precision 0.91 on holdout-2026-10");
  store::addEval("e-other", "fraud", kOther, 0.93, 0.85, "precision 0.93 on holdout-2026-10");
  store::addEval("e-churn", "churn", kDigest, 0.88, 0.85, "recall 0.88 on churn-holdout");
  static httplib::Server* svr = nullptr;
  delete svr;
  svr = new httplib::Server;
  register_routes(*svr);
  return ctx.HTTP(*svr);
}

harness::Response post(harness::HTTP& c, const nlohmann::json& b, const std::string& key, const std::string& tenant = "t1") {
  if (key.empty()) return c.Post("/v1/models", b.dump(), "Content-Type", "application/json", "X-Tenant-Id", tenant);
  return c.Post("/v1/models", b.dump(), "Content-Type", "application/json", "X-Tenant-Id", tenant, "Idempotency-Key", key);
}

nlohmann::json decode(const harness::Response& r) {
  const auto j = nlohmann::json::parse(r.Text(), nullptr, false);
  return j.is_object() ? j : nlohmann::json::object();
}

void refused(harness::Ctx& ctx, harness::HTTP& c, const nlohmann::json& b, const std::string& key, const std::string& why) {
  const auto r = post(c, b, key);
  ctx.Equal(r.Status, 422, "%s: the registration answered %s; the status", why, r.Text());
  ctx.Equal(ctx.Redis.Keys("model:*:v*").size(), 0, "%s: a version was written anyway; the versions", why);
}

}  // namespace

void CheckRoute(harness::Ctx& ctx) {
  auto c = api(ctx);
  const auto r = post(c, kFraud, "k-1");
  ctx.Equal(r.Status, 201, "POST /v1/models (%s)", r.Text());
  const auto a = decode(r);
  ctx.Assert(a.value("name", "") == "fraud" && a.value("version", 0L) == 1 && a.value("stage", "") == "staged",
             "the first registration must answer fraud version 1, staged; got %s", r.Text());
  const auto row = store::version("fraud", 1);
  ctx.Assert(row && row->artifact_digest == kDigest, "the store holds no fraud version 1 at %s", kDigest);
  const auto none = c.Post("/v1/models", kFraud.dump(), "Content-Type", "application/json", "Idempotency-Key", "k-2");
  ctx.Equal(none.Status, 401, "a registration without X-Tenant-Id");
}

void CheckLineage(harness::Ctx& ctx) {
  auto c = api(ctx);
  refused(ctx, c, with(kFraud, "artifact_digest", "sha256:dead"), "k-1", "with an artifact digest that does not resolve");
  refused(ctx, c, with(kFraud, "training_run_id", "r-churn"), "k-2", "with a training run of the churn model");
  refused(ctx, c, with(kFraud, "training_run_id", "r-404"), "k-3", "with a training run that does not exist");
  const auto r = post(c, kFraud, "k-4");
  ctx.Assert(r.Status == 201 && decode(r).value("version", 0L) == 1, "with its lineage in place the registration must answer version 1, got %d %s", r.Status, r.Text());
}

void CheckEvalBound(harness::Ctx& ctx) {
  auto c = api(ctx);
  refused(ctx, c, with(kFraud, "eval_id", "e-churn"), "k-1", "with an eval record of the churn model");
  refused(ctx, c, with(kFraud, "eval_id", "e-other"), "k-2", "with an eval record measured on another digest of fraud");
  refused(ctx, c, with(kFraud, "eval_id", "e-404"), "k-3", "with an eval record that does not exist");
  auto r = post(c, kFraud, "k-4");
  ctx.Equal(r.Status, 201, "with its own eval record the registration (%s)", r.Text());
  r = post(c, with(with(kFraud, "artifact_digest", kOther), "eval_id", "e-other"), "k-5");
  ctx.Assert(r.Status == 201 && decode(r).value("version", 0L) == 2, "the other digest with the eval measured on it must register as version 2, got %d %s", r.Status, r.Text());
}

void CheckIdempotentVersion(harness::Ctx& ctx) {
  auto c = api(ctx);
  const auto first = post(c, kFraud, "k-1");
  ctx.Equal(first.Status, 201, "the first registration (%s)", first.Text());
  const auto replay = post(c, kFraud, "k-1");
  ctx.Assert(replay.Status == 201 && decode(replay).value("version", 0L) == decode(first).value("version", -1L),
             "a retry with the same Idempotency-Key must answer the recorded version: first %s, retry %s", first.Text(), replay.Text());
  ctx.Equal(ctx.Redis.Exists("model:fraud:v2"), 0, "the retry minted fraud version 2 (one registration, two versions); model:fraud:v2 exists");
  const auto fresh = post(c, kFraud, "k-2");
  ctx.Equal(decode(fresh).value("version", 0L), 2, "a new Idempotency-Key is a new registration (%s); the version", fresh.Text());
  const auto theirs = post(c, kChurn, "k-1", "t2");
  ctx.Assert(theirs.Status == 201 && decode(theirs).value("name", "") == "churn", "another tenant's k-1 is its own registration: it answered %s", theirs.Text());
  const auto none = post(c, kFraud, "");
  ctx.Equal(none.Status, 400, "a registration without Idempotency-Key");
}
`,
  },
  hints: [
    'Register fraud with a digest nobody uploaded, or with the eval record of the churn model: both come back 201. Retry a registration after a timeout and the model has two versions.',
    'The handler hands the body straight to `register_version`: nothing asks the artifact store, the training-run log or the eval store, and nothing remembers what an `Idempotency-Key` already answered.',
    'Before registering: 400 without the key, answer `store.registration(tenant, key)` when recorded, 422 unless `artifact` resolves, `training_run` names this model and `eval_record` names this model and digest; then `record_registration`.',
  ],
  debrief: `The registry checks lineage itself because it is the only party that sees all three stores at once: a caller can claim any run and any score, and the claim becomes the audit trail. Binding the eval to the digest rather than to the model name is what makes a score evidence about these bytes. The registration record keyed by tenant and key turns a retry into a read, so a client timeout never forks the version history. Production registries also fingerprint the request body so a reused key with a different body is refused rather than replayed, expire the records after a retention window, and verify the artifact's checksum against the bytes rather than trusting that the digest exists.`,
};
