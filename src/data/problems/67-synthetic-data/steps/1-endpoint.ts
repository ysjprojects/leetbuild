import type {Step} from '@/lib/types';

export const endpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/synthetic/jobs: a licensed seed, a cap and a key',
  concept: 'http',
  file: 'api',
  focus: ['client', 'api', 'redis'],
  task: `## Task

**Starting point.** The starter serves \`POST /v1/synthetic/jobs\` with body \`{"seed_dataset",
"seed_version", "recipe", "max_records"}\`: it answers 401 without \`X-Tenant-Id\`, builds a queued job,
hands it to the generator workers with \`enqueue\`, then asks the provided registry
\`seeds.lookup(dataset, version)\` (422 when the seed is not registered) and stores the job through the
job store under \`(tenant, job_id)\`. It serves the demo and hides 4 flaws.

**Failure mode the checks target.** A seed whose license forbids derivatives gets expanded anyway, and
once records exist the breach is in the corpus. A refusal that comes after \`enqueue\` is too late: the
workers already have the job. Without a cap one request asks for an unbounded corpus, and without the
key a client retry starts a second expansion.

- The seed must be registered and its \`derivative_ok\` must be true; **422** otherwise.
- Every refusal happens **before** \`enqueue\` and \`store.put\`: a refused job leaves nothing queued or
  stored.
- \`max_records\` is an integer from **1** to \`MAX_RECORDS\` (100 000) and \`recipe\` is non-empty;
  **400** otherwise.
- \`Idempotency-Key\` is required (**400**); the job is stored under \`(tenant, key)\` and a replay answers
  **200** with the stored job.
- A new job answers **201** with \`{job_id, status: "queued", seed_dataset, seed_version, recipe,
  max_records}\`.`,
  sequence: {
    participants: ['Data curator', 'synthd API', 'seed registry', 'job store'],
    messages: [
      {
        from: 'Data curator',
        to: 'synthd API',
        label: 'POST /v1/synthetic/jobs · X-Tenant-Id · Idempotency-Key',
        kind: 'sync',
      },
      {from: 'synthd API', to: 'synthd API', label: 'validate recipe · max_records', kind: 'sync'},
      {from: 'synthd API', to: 'seed registry', label: 'lookup(dataset, version)', kind: 'sync'},
      {from: 'seed registry', to: 'synthd API', label: '{license, derivative_ok}', kind: 'reply'},
      {from: 'synthd API', to: 'job store', label: 'get(tenant, key) · put(tenant, key, job)', kind: 'sync'},
      {from: 'synthd API', to: 'job store', label: 'enqueue(job)', kind: 'async'},
      {from: 'synthd API', to: 'Data curator', label: '201 {job_id, status, max_records, …}', kind: 'reply'},
    ],
  },
  hints: [
    'Symptom: a job over a no-derivatives news seed is accepted, a job for an unregistered version answers 422 yet the workers start it, a cap of ten million passes, and a retried submit doubles the corpus.',
    'Mechanism: `enqueue` runs before the registry lookup, so a refusal arrives after the workers have the job; nobody reads `derivative_ok` or bounds `max_records`; the store key is the fresh job id, so a replay finds nothing.',
    'Change: guard clauses in order (tenant 401, Idempotency-Key 400, recipe and `1 <= max_records <= MAX_RECORDS` 400, lookup and `derivative_ok` 422), then `store.get(tenant, key)` for a replay, then `store.put(tenant, key, job)` and `enqueue(job)` last.',
  ],
  checks: [
    {
      id: 'route',
      title: 'Handles POST /v1/synthetic/jobs',
      detail:
        'The submit route answers 201 with the job (job_id, status queued, the seed, the recipe, max_records), stores and queues it, and answers 401 without X-Tenant-Id.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/synthetic\/jobs["']/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/synthetic\/jobs['"]/]},
        go: {all: [/HandleFunc\(\s*"POST \/v1\/synthetic\/jobs"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"synthetic"\s*\/\s*"jobs"\s*\)/, /\bpost\s*\{/]},
        cpp: {all: [/svr\.Post\(\s*"\/v1\/synthetic\/jobs"/]},
      },
    },
    {
      id: 'derivative-license',
      title: 'Refuses a seed whose license forbids derivatives',
      detail:
        'A registered seed whose derivative_ok is false is 422 with nothing queued or stored; a seed that allows derivatives is accepted. The starter checks only that the seed is registered and never reads the license.',
      match: {
        python: {all: [/derivative_ok/, /status_code\s*=\s*422/]},
        typescript: {all: [/derivative_ok/, /code\(\s*422\s*\)/]},
        go: {all: [/DerivativeOK/, /StatusUnprocessableEntity/]},
        scala: {all: [/derivativeOk/, /StatusCodes\.UnprocessableEntity/]},
        cpp: {all: [/derivative_ok/, /\b422\b/]},
      },
    },
    {
      id: 'record-cap',
      title: 'Bounds max_records to 1..100000',
      detail:
        'max_records outside 1..MAX_RECORDS, or an empty recipe, is 400 with nothing queued or stored; 1 and 100000 are accepted and stored on the job. The starter accepts any cap, a negative one included.',
      match: {
        python: {all: [/MAX_RECORDS/, /status_code\s*=\s*400/]},
        typescript: {all: [/MAX_RECORDS/, /code\(\s*400\s*\)/]},
        go: {all: [/maxRecords/, /StatusBadRequest/]},
        scala: {all: [/MaxRecords/, /StatusCodes\.BadRequest/]},
        cpp: {all: [/kMaxRecords/, /\b400\b/]},
      },
    },
    {
      id: 'idempotency-key',
      title: 'Keys job submits by (tenant, Idempotency-Key)',
      detail:
        'Idempotency-Key is required (400 without it); a replay of the same (tenant, key) answers 200 with the same job_id and queues nothing new; another tenant with the same key gets its own job. The starter stores the job under its own fresh id, so every retry starts another expansion.',
      match: {
        python: {all: [/Idempotency-Key/, /store\.get\(\s*tenant\s*,/, /store\.put\(\s*tenant\s*,\s*idem/]},
        typescript: {all: [/idempotency-key/, /store\.get\(\s*tenant\s*,/, /store\.put\(\s*tenant\s*,\s*idem/]},
        go: {all: [/Idempotency-Key/, /jobs\.Get\(/, /jobs\.Put\(\s*[\w.()]+,\s*tenant\s*,\s*idem/]},
        scala: {all: [/Idempotency-Key/, /Jobs\.get\(\s*tenant\s*,/, /Jobs\.put\(\s*tenant\s*,\s*idem/]},
        cpp: {all: [/Idempotency-Key/, /jobs::get\(\s*tenant\s*,/, /jobs::put\(\s*tenant\s*,\s*idem/]},
      },
    },
    {
      id: 'gate-before-enqueue',
      title: 'Decides the seed before anything is queued',
      detail:
        'An unregistered seed is 422 and the generation queue stays empty: the registry answers before enqueue runs. The starter enqueues first and refuses afterwards, so the workers expand a seed the API said no to.',
      match: {
        python: {order: [/seeds\.lookup\(/, /\benqueue\(/]},
        typescript: {order: [/\blookup\(/, /\benqueue\(/]},
        go: {order: [/seeds\.Lookup\(/, /jobs\.Enqueue\(/]},
        scala: {order: [/Seeds\.lookup\(/, /Jobs\.enqueue\(/]},
        cpp: {order: [/seeds::lookup\(/, /jobs::enqueue\(/]},
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

from synth import seeds
from synth.jobs import enqueue, store

app = FastAPI()
logger = logging.getLogger("synthd")


class JobRequest(BaseModel):
    seed_dataset: str
    seed_version: str
    recipe: str
    max_records: int


@app.post("/v1/synthetic/jobs")
def submit_job(body: JobRequest, request: Request) -> JSONResponse:
    # TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
    tenant = request.headers.get("X-Tenant-Id", "")
    if tenant == "":
        raise HTTPException(status_code=401, detail="missing X-Tenant-Id")
    job = {
        "job_id": str(uuid.uuid4()),
        "status": "queued",
        "seed_dataset": body.seed_dataset,
        "seed_version": body.seed_version,
        "recipe": body.recipe,
        "max_records": body.max_records,
    }
    enqueue(job)
    if seeds.lookup(body.seed_dataset, body.seed_version) is None:
        raise HTTPException(status_code=422, detail="seed dataset/version is not registered")
    store.put(tenant, job["job_id"], job)
    logger.info("synthetic job=%s seed=%s@%s cap=%d", job["job_id"], body.seed_dataset, body.seed_version, body.max_records)
    return JSONResponse(job, status_code=201)
`,
      solution: `import logging
import uuid

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from synth import seeds
from synth.jobs import enqueue, store

app = FastAPI()
logger = logging.getLogger("synthd")

MAX_RECORDS = 100_000


class JobRequest(BaseModel):
    seed_dataset: str
    seed_version: str
    recipe: str
    max_records: int


@app.post("/v1/synthetic/jobs")
def submit_job(body: JobRequest, request: Request) -> JSONResponse:
    tenant = request.headers.get("X-Tenant-Id", "")
    if tenant == "":
        raise HTTPException(status_code=401, detail="missing X-Tenant-Id")
    idem_key = request.headers.get("Idempotency-Key", "")
    if idem_key == "":
        raise HTTPException(status_code=400, detail="Idempotency-Key is required")
    if body.recipe == "":
        raise HTTPException(status_code=400, detail="recipe is required")
    if not 1 <= body.max_records <= MAX_RECORDS:
        raise HTTPException(status_code=400, detail=f"max_records must be 1..{MAX_RECORDS}")
    seed = seeds.lookup(body.seed_dataset, body.seed_version)
    if seed is None:
        raise HTTPException(status_code=422, detail="seed dataset/version is not registered")
    if not seed["derivative_ok"]:
        raise HTTPException(status_code=422, detail=f"seed license {seed['license']} forbids derivatives")

    stored = store.get(tenant, idem_key)
    if stored is not None:
        return JSONResponse(stored, status_code=200)

    job = {
        "job_id": str(uuid.uuid4()),
        "status": "queued",
        "seed_dataset": body.seed_dataset,
        "seed_version": body.seed_version,
        "recipe": body.recipe,
        "max_records": body.max_records,
    }
    store.put(tenant, idem_key, job)
    enqueue(job)
    logger.info("synthetic job=%s seed=%s@%s cap=%d", job["job_id"], body.seed_dataset, body.seed_version, body.max_records)
    return JSONResponse(job, status_code=201)
`,
    },
    typescript: {
      starter: `import {randomUUID} from 'node:crypto';

import Fastify from 'fastify';

import {type Job, enqueue, store} from 'synth/jobs';
import {lookup} from 'synth/seeds';

export const app = Fastify();

interface JobBody {
  seed_dataset: string;
  seed_version: string;
  recipe: string;
  max_records: number;
}

app.post('/v1/synthetic/jobs', async (request, reply) => {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing X-Tenant-Id'});
  const body = request.body as JobBody;
  const job: Job = {
    job_id: randomUUID(),
    status: 'queued',
    seed_dataset: body.seed_dataset,
    seed_version: body.seed_version,
    recipe: body.recipe,
    max_records: body.max_records,
  };
  await enqueue(job);
  if (lookup(body.seed_dataset, body.seed_version) === null)
    return reply.code(422).send({error: 'seed dataset/version is not registered'});
  await store.put(tenant, job.job_id, job);
  request.log.info({job_id: job.job_id, seed: \`\${job.seed_dataset}@\${job.seed_version}\`, cap: job.max_records}, 'job queued');
  return reply.code(201).send(job);
});
`,
      solution: `import {randomUUID} from 'node:crypto';

import Fastify from 'fastify';

import {type Job, enqueue, store} from 'synth/jobs';
import {lookup} from 'synth/seeds';

export const app = Fastify();

export const MAX_RECORDS = 100_000;

interface JobBody {
  seed_dataset: string;
  seed_version: string;
  recipe: string;
  max_records: number;
}

app.post('/v1/synthetic/jobs', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing X-Tenant-Id'});
  const idemKey = request.headers['idempotency-key'];
  if (typeof idemKey !== 'string' || idemKey === '') return reply.code(400).send({error: 'Idempotency-Key is required'});
  const body = (request.body ?? {}) as Partial<JobBody>;
  if (typeof body.recipe !== 'string' || body.recipe === '') return reply.code(400).send({error: 'recipe is required'});
  const cap = body.max_records;
  if (!Number.isInteger(cap) || (cap as number) < 1 || (cap as number) > MAX_RECORDS)
    return reply.code(400).send({error: \`max_records must be 1..\${MAX_RECORDS}\`});
  const seed = lookup(String(body.seed_dataset), String(body.seed_version));
  if (seed === null) return reply.code(422).send({error: 'seed dataset/version is not registered'});
  if (!seed.derivative_ok) return reply.code(422).send({error: \`seed license \${seed.license} forbids derivatives\`});

  const stored = await store.get(tenant, idemKey);
  if (stored !== null) return reply.code(200).send(stored);

  const job: Job = {
    job_id: randomUUID(),
    status: 'queued',
    seed_dataset: seed.dataset,
    seed_version: seed.version,
    recipe: body.recipe,
    max_records: cap as number,
  };
  await store.put(tenant, idemKey, job);
  await enqueue(job);
  request.log.info({job_id: job.job_id, seed: \`\${job.seed_dataset}@\${job.seed_version}\`, cap: job.max_records}, 'job queued');
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

	"synth/jobs"  // jobs.Job, jobs.Get/Put(ctx, tenant, idemKey, …), jobs.Enqueue(ctx, job) — provided
	"synth/seeds" // seeds.Lookup(dataset, version) (Seed, bool) — provided
)

type JobRequest struct {
	SeedDataset string \`json:"seed_dataset"\`
	SeedVersion string \`json:"seed_version"\`
	Recipe      string \`json:"recipe"\`
	MaxRecords  int    \`json:"max_records"\`
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func submitJob(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-Tenant-Id"})
		return
	}
	var body JobRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	job := jobs.Job{
		JobID:       uuid.NewString(),
		Status:      "queued",
		SeedDataset: body.SeedDataset,
		SeedVersion: body.SeedVersion,
		Recipe:      body.Recipe,
		MaxRecords:  body.MaxRecords,
	}
	if err := jobs.Enqueue(r.Context(), job); err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	if _, ok := seeds.Lookup(body.SeedDataset, body.SeedVersion); !ok {
		writeJSON(rw, http.StatusUnprocessableEntity, map[string]string{"error": "seed dataset/version is not registered"})
		return
	}
	if err := jobs.Put(r.Context(), tenant, job.JobID, job); err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	log.Printf("synthetic job=%s seed=%s@%s cap=%d", job.JobID, job.SeedDataset, job.SeedVersion, job.MaxRecords)
	writeJSON(rw, http.StatusCreated, job)
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/synthetic/jobs", submitJob)
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

	"synth/jobs"  // jobs.Job, jobs.Get/Put(ctx, tenant, idemKey, …), jobs.Enqueue(ctx, job) — provided
	"synth/seeds" // seeds.Lookup(dataset, version) (Seed, bool) — provided
)

const maxRecords = 100_000

type JobRequest struct {
	SeedDataset string \`json:"seed_dataset"\`
	SeedVersion string \`json:"seed_version"\`
	Recipe      string \`json:"recipe"\`
	MaxRecords  int    \`json:"max_records"\`
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func submitJob(rw http.ResponseWriter, r *http.Request) {
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
	var body JobRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	if body.Recipe == "" {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "recipe is required"})
		return
	}
	if body.MaxRecords < 1 || body.MaxRecords > maxRecords {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "max_records must be 1..100000"})
		return
	}
	seed, ok := seeds.Lookup(body.SeedDataset, body.SeedVersion)
	if !ok {
		writeJSON(rw, http.StatusUnprocessableEntity, map[string]string{"error": "seed dataset/version is not registered"})
		return
	}
	if !seed.DerivativeOK {
		writeJSON(rw, http.StatusUnprocessableEntity, map[string]string{"error": "seed license " + seed.License + " forbids derivatives"})
		return
	}

	stored, err := jobs.Get(r.Context(), tenant, idemKey)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	if stored != nil {
		writeJSON(rw, http.StatusOK, stored)
		return
	}

	job := jobs.Job{
		JobID:       uuid.NewString(),
		Status:      "queued",
		SeedDataset: body.SeedDataset,
		SeedVersion: body.SeedVersion,
		Recipe:      body.Recipe,
		MaxRecords:  body.MaxRecords,
	}
	if err := jobs.Put(r.Context(), tenant, idemKey, job); err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	if err := jobs.Enqueue(r.Context(), job); err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	log.Printf("synthetic job=%s seed=%s@%s cap=%d", job.JobID, job.SeedDataset, job.SeedVersion, job.MaxRecords)
	writeJSON(rw, http.StatusCreated, job)
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/synthetic/jobs", submitJob)
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

import synth.{Job, Jobs, Seeds}

final case class JobRequest(seed_dataset: String, seed_version: String, recipe: String, max_records: Int)

object SynthApi {
  implicit val system: ActorSystem = ActorSystem("synthetic-data")
  implicit val requestFormat: RootJsonFormat[JobRequest] = jsonFormat4(JobRequest)
  implicit val jobFormat: RootJsonFormat[Job] = jsonFormat6(Job)

  val route: Route =
    path("v1" / "synthetic" / "jobs") {
      post {
        optionalHeaderValueByName("X-Tenant-Id") { tenantOpt =>
          entity(as[JobRequest]) { body =>
            // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
            if (!tenantOpt.exists(_.nonEmpty)) {
              complete(StatusCodes.Unauthorized, """{"error":"missing X-Tenant-Id"}""")
            } else {
              val tenant = tenantOpt.get
              val job = Job(UUID.randomUUID().toString, "queued", body.seed_dataset, body.seed_version, body.recipe, body.max_records)
              Jobs.enqueue(job)
              if (Seeds.lookup(body.seed_dataset, body.seed_version).isEmpty) {
                complete(StatusCodes.UnprocessableEntity, """{"error":"seed dataset/version is not registered"}""")
              } else {
                Jobs.put(tenant, job.job_id, job)
                system.log.info(s"synthetic job=\${job.job_id} seed=\${job.seed_dataset}@\${job.seed_version} cap=\${job.max_records}")
                complete(StatusCodes.Created, job)
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
      solution: `import java.util.UUID

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

import synth.{Job, Jobs, Seeds}

final case class JobRequest(seed_dataset: String, seed_version: String, recipe: String, max_records: Int)

object SynthApi {
  implicit val system: ActorSystem = ActorSystem("synthetic-data")
  implicit val requestFormat: RootJsonFormat[JobRequest] = jsonFormat4(JobRequest)
  implicit val jobFormat: RootJsonFormat[Job] = jsonFormat6(Job)

  val MaxRecords = 100000

  val route: Route =
    path("v1" / "synthetic" / "jobs") {
      post {
        optionalHeaderValueByName("X-Tenant-Id") { tenantOpt =>
          optionalHeaderValueByName("Idempotency-Key") { idemOpt =>
            entity(as[JobRequest]) { body =>
              val seed = Seeds.lookup(body.seed_dataset, body.seed_version)
              if (!tenantOpt.exists(_.nonEmpty)) {
                complete(StatusCodes.Unauthorized, """{"error":"missing X-Tenant-Id"}""")
              } else if (!idemOpt.exists(_.nonEmpty)) {
                complete(StatusCodes.BadRequest, """{"error":"Idempotency-Key is required"}""")
              } else if (body.recipe.isEmpty) {
                complete(StatusCodes.BadRequest, """{"error":"recipe is required"}""")
              } else if (body.max_records < 1 || body.max_records > MaxRecords) {
                complete(StatusCodes.BadRequest, """{"error":"max_records must be 1..100000"}""")
              } else if (seed.isEmpty) {
                complete(StatusCodes.UnprocessableEntity, """{"error":"seed dataset/version is not registered"}""")
              } else if (!seed.get.derivativeOk) {
                complete(StatusCodes.UnprocessableEntity, """{"error":"seed license forbids derivatives"}""")
              } else {
                val tenant = tenantOpt.get
                val idemKey = idemOpt.get
                Jobs.get(tenant, idemKey) match {
                  case Some(stored) =>
                    complete(StatusCodes.OK, stored.job)
                  case None =>
                    val job =
                      Job(UUID.randomUUID().toString, "queued", body.seed_dataset, body.seed_version, body.recipe, body.max_records)
                    Jobs.put(tenant, idemKey, job)
                    Jobs.enqueue(job)
                    system.log.info(s"synthetic job=\${job.job_id} seed=\${job.seed_dataset}@\${job.seed_version} cap=\${job.max_records}")
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
#include <string>

#include "ids.h"           // new_uuid() — provided
#include "synth/jobs.h"    // jobs::get/put(tenant, idem_key, …), jobs::enqueue(job) — provided
#include "synth/seeds.h"   // seeds::lookup(dataset, version) -> optional<Seed> — provided

using json = nlohmann::json;

void submit_job(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) {
    res.status = 401;
    res.set_content(R"({"error":"missing X-Tenant-Id"})", "application/json");
    return;
  }
  const json body = json::parse(req.body, nullptr, false);
  if (!body.is_object()) {
    res.status = 400;
    res.set_content(R"({"error":"invalid json"})", "application/json");
    return;
  }
  const std::string dataset = body.value("seed_dataset", std::string());
  const std::string version = body.value("seed_version", std::string());
  const json job = {
      {"job_id", new_uuid()},
      {"status", "queued"},
      {"seed_dataset", dataset},
      {"seed_version", version},
      {"recipe", body.value("recipe", std::string())},
      {"max_records", body.value("max_records", 0)},
  };
  jobs::enqueue(job);
  if (!seeds::lookup(dataset, version)) {
    res.status = 422;
    res.set_content(R"({"error":"seed dataset/version is not registered"})", "application/json");
    return;
  }
  jobs::put(tenant, job["job_id"].get<std::string>(), job);
  std::cerr << "synthetic job=" << job["job_id"] << " seed=" << dataset << "@" << version << "\\n";
  res.status = 201;
  res.set_content(job.dump(), "application/json");
}

void register_routes(httplib::Server& svr) { svr.Post("/v1/synthetic/jobs", submit_job); }

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

#include "ids.h"           // new_uuid() — provided
#include "synth/jobs.h"    // jobs::get/put(tenant, idem_key, …), jobs::enqueue(job) — provided
#include "synth/seeds.h"   // seeds::lookup(dataset, version) -> optional<Seed> — provided

using json = nlohmann::json;

constexpr int kMaxRecords = 100000;

void reject(httplib::Response& res, int status, const std::string& error) {
  res.status = status;
  res.set_content(json({{"error", error}}).dump(), "application/json");
}

void submit_job(const httplib::Request& req, httplib::Response& res) {
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) return reject(res, 401, "missing X-Tenant-Id");
  const std::string idem_key = req.get_header_value("Idempotency-Key");
  if (idem_key.empty()) return reject(res, 400, "Idempotency-Key is required");
  const json body = json::parse(req.body, nullptr, false);
  if (!body.is_object()) return reject(res, 400, "invalid json");
  const std::string recipe = body.value("recipe", std::string());
  if (recipe.empty()) return reject(res, 400, "recipe is required");
  if (!body.contains("max_records") || !body["max_records"].is_number_integer()) return reject(res, 400, "max_records must be 1..100000");
  const long long max_records = body["max_records"].get<long long>();
  if (max_records < 1 || max_records > kMaxRecords) return reject(res, 400, "max_records must be 1..100000");
  const std::string dataset = body.value("seed_dataset", std::string());
  const std::string version = body.value("seed_version", std::string());
  const auto seed = seeds::lookup(dataset, version);
  if (!seed) return reject(res, 422, "seed dataset/version is not registered");
  if (!seed->derivative_ok) return reject(res, 422, "seed license " + seed->license + " forbids derivatives");

  if (const auto stored = jobs::get(tenant, idem_key)) {
    res.status = 200;
    res.set_content(stored->dump(), "application/json");
    return;
  }
  const json job = {
      {"job_id", new_uuid()},
      {"status", "queued"},
      {"seed_dataset", dataset},
      {"seed_version", version},
      {"recipe", recipe},
      {"max_records", max_records},
  };
  jobs::put(tenant, idem_key, job);
  jobs::enqueue(job);
  std::cerr << "synthetic job=" << job["job_id"] << " seed=" << dataset << "@" << version << " cap=" << max_records << "\\n";
  res.status = 201;
  res.set_content(job.dump(), "application/json");
}

void register_routes(httplib::Server& svr) { svr.Post("/v1/synthetic/jobs", submit_job); }

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

GOOD = {"seed_dataset": "wiki-qa", "seed_version": "2026-04-01", "recipe": "qa-pairs", "max_records": 1000}
FIELDS = ("job_id", "status", "seed_dataset", "seed_version", "recipe", "max_records")


def _api(ctx):
    m = ctx.load("api")
    return ctx.client(m.app)


async def _post(c, body, key="k-1", tenant="t1", with_key=True):
    headers = {"X-Tenant-Id": tenant}
    if with_key:
        headers["Idempotency-Key"] = key
    return await c.post("/v1/synthetic/jobs", json=body, headers=headers)


def _queued(ctx):
    return ctx.redis.lrange("synth:queue", 0, -1)


def _jobs(ctx):
    return ctx.redis.keys("synth:job:*")


def _nothing_left(ctx, what):
    assert _queued(ctx) == [], f"{what}, yet the generation queue holds {_queued(ctx)}: the workers will expand it"
    assert _jobs(ctx) == [], f"{what}, yet the job store holds {_jobs(ctx)}"


async def check_route(ctx):
    async with _api(ctx) as c:
        r = await _post(c, GOOD)
        assert r.status_code == 201, f"a valid submit answered {r.status_code}: {r.text}"
        job = r.json()
        for key in FIELDS:
            assert key in job, f"the 201 body lacks {key!r}: {job}"
        assert job["status"] == "queued" and job["seed_dataset"] == "wiki-qa" and job["seed_version"] == "2026-04-01" and job["recipe"] == "qa-pairs" and job["max_records"] == 1000, f"the job echoes the request with status queued: {job}"
        assert ctx.redis.get(f"synth:job:{job['job_id']}") is not None, f"the job {job['job_id']} must be in the job store (synth:job:{{id}}): keys {sorted(ctx.redis.keys('synth:*'))}"
        assert _queued(ctx) == [job["job_id"]], f"the accepted job must be handed to the workers once: the queue holds {_queued(ctx)}"
        r = await c.post("/v1/synthetic/jobs", json=GOOD, headers={"Idempotency-Key": "k-2"})
        assert r.status_code == 401, f"without X-Tenant-Id the submit must answer 401, got {r.status_code}"


async def check_derivative_license(ctx):
    async with _api(ctx) as c:
        r = await _post(c, {**GOOD, "seed_dataset": "news-crawl", "seed_version": "2026-02-15"}, key="k-nd")
        assert r.status_code == 422, f"news-crawl@2026-02-15 is registered with a no-derivatives license and answered {r.status_code}, expected 422: synthetic records are derivatives of their seed"
        _nothing_left(ctx, "a seed whose license forbids derivatives was refused")
        r = await _post(c, GOOD, key="k-ok")
        assert r.status_code == 201, f"wiki-qa@2026-04-01 allows derivatives, got {r.status_code}: {r.text}"


async def check_record_cap(ctx):
    async with _api(ctx) as c:
        for cap in (0, -5, 100_001, 10_000_000):
            r = await _post(c, {**GOOD, "max_records": cap}, key=f"k-{cap}")
            assert r.status_code == 400, f"max_records={cap} answered {r.status_code}, expected 400 (the service bounds a job to 1..100000 records)"
        r = await _post(c, {**GOOD, "recipe": ""}, key="k-recipe")
        assert r.status_code == 400, f"an empty recipe answered {r.status_code}, expected 400"
        _nothing_left(ctx, "every one of those submits was refused")
        for cap in (1, 100_000):
            r = await _post(c, {**GOOD, "max_records": cap}, key=f"k-ok-{cap}")
            assert r.status_code == 201, f"max_records={cap} is within 1..100000 inclusive, got {r.status_code}: {r.text}"
            stored = json.loads(ctx.redis.get(f"synth:job:{r.json()['job_id']}"))
            assert stored.get("max_records") == cap, f"the stored job must carry the cap the workers enforce, got {stored}"


async def check_idempotency_key(ctx):
    async with _api(ctx) as c:
        r = await _post(c, GOOD, with_key=False)
        assert r.status_code == 400, f"a submit without Idempotency-Key answered {r.status_code}, expected 400"
        first = await _post(c, GOOD, key="k-7")
        assert first.status_code == 201, f"the first submit answered {first.status_code}: {first.text}"
        replay = await _post(c, GOOD, key="k-7")
        assert replay.status_code == 200, f"a replay of the same (tenant, Idempotency-Key) answered {replay.status_code}, expected 200 with the stored job (the client retried; it must not start a second expansion)"
        assert replay.json()["job_id"] == first.json()["job_id"], f"the replay must resume the same job: got {replay.json()['job_id']}, the first submit made {first.json()['job_id']}"
        assert len(_jobs(ctx)) == 1 and len(_queued(ctx)) == 1, f"one key, one job: after a submit and its replay the store holds {len(_jobs(ctx))} jobs and the queue {len(_queued(ctx))}"
        other = await _post(c, GOOD, key="k-7", tenant="t2")
        assert other.status_code == 201 and other.json()["job_id"] != first.json()["job_id"], "another tenant reusing the key gets its own job (keys are per tenant)"


async def check_gate_before_enqueue(ctx):
    async with _api(ctx) as c:
        r = await _post(c, {**GOOD, "seed_version": "2027-01-01"}, key="k-unknown")
        assert r.status_code == 422, f"an unregistered seed version answered {r.status_code}, expected 422"
        _nothing_left(ctx, "an unregistered seed was refused with 422")
        r = await _post(c, {**GOOD, "seed_dataset": "forum-scrape"}, key="k-unknown-2")
        assert r.status_code == 422, f"an unregistered dataset answered {r.status_code}, expected 422"
        _nothing_left(ctx, "an unregistered dataset was refused with 422")
`,
    typescript: `const GOOD = {seed_dataset: 'wiki-qa', seed_version: '2026-04-01', recipe: 'qa-pairs', max_records: 1000};
const FIELDS = ['job_id', 'status', 'seed_dataset', 'seed_version', 'recipe', 'max_records'];

function api(ctx) {
  const m = ctx.load('api');
  return ctx.client(m.app);
}

async function post(c, body, {key = 'k-1', tenant = 't1', withKey = true} = {}) {
  const headers: Record<string, string> = {'X-Tenant-Id': tenant};
  if (withKey) headers['Idempotency-Key'] = key;
  return c.post('/v1/synthetic/jobs', {body, headers});
}

const queued = ctx => ctx.redis.lrange('synth:queue', 0, -1);
const jobKeys = ctx => ctx.redis.keys('synth:job:*');

function nothingLeft(ctx, what: string) {
  assert.deepEqual(queued(ctx), [], \`\${what}, yet the generation queue holds \${JSON.stringify(queued(ctx))}: the workers will expand it\`);
  assert.deepEqual(jobKeys(ctx), [], \`\${what}, yet the job store holds \${JSON.stringify(jobKeys(ctx))}\`);
}

export async function check_route(ctx) {
  const c = api(ctx);
  const r = await post(c, GOOD);
  assert.equal(r.status, 201, \`a valid submit answered \${r.status}: \${r.text}\`);
  const job = r.json();
  for (const key of FIELDS) assert(key in job, \`the 201 body lacks \${key}: \${r.text}\`);
  assert(job.status === 'queued' && job.seed_dataset === 'wiki-qa' && job.seed_version === '2026-04-01' && job.recipe === 'qa-pairs' && job.max_records === 1000, \`the job echoes the request with status queued: \${r.text}\`);
  assert(ctx.redis.get(\`synth:job:\${job.job_id}\`) !== null, \`the job \${job.job_id} must be in the job store (synth:job:{id}): keys \${JSON.stringify(ctx.redis.keys('synth:*').sort())}\`);
  assert.deepEqual(queued(ctx), [job.job_id], \`the accepted job must be handed to the workers once: the queue holds \${JSON.stringify(queued(ctx))}\`);
  const noTenant = await c.post('/v1/synthetic/jobs', {body: GOOD, headers: {'Idempotency-Key': 'k-2'}});
  assert.equal(noTenant.status, 401, \`without X-Tenant-Id the submit must answer 401, got \${noTenant.status}\`);
}

export async function check_derivative_license(ctx) {
  const c = api(ctx);
  let r = await post(c, {...GOOD, seed_dataset: 'news-crawl', seed_version: '2026-02-15'}, {key: 'k-nd'});
  assert.equal(r.status, 422, \`news-crawl@2026-02-15 is registered with a no-derivatives license and answered \${r.status}, expected 422: synthetic records are derivatives of their seed\`);
  nothingLeft(ctx, 'a seed whose license forbids derivatives was refused');
  r = await post(c, GOOD, {key: 'k-ok'});
  assert.equal(r.status, 201, \`wiki-qa@2026-04-01 allows derivatives, got \${r.status}: \${r.text}\`);
}

export async function check_record_cap(ctx) {
  const c = api(ctx);
  for (const cap of [0, -5, 100_001, 10_000_000]) {
    const r = await post(c, {...GOOD, max_records: cap}, {key: \`k-\${cap}\`});
    assert.equal(r.status, 400, \`max_records=\${cap} answered \${r.status}, expected 400 (the service bounds a job to 1..100000 records)\`);
  }
  const noRecipe = await post(c, {...GOOD, recipe: ''}, {key: 'k-recipe'});
  assert.equal(noRecipe.status, 400, \`an empty recipe answered \${noRecipe.status}, expected 400\`);
  nothingLeft(ctx, 'every one of those submits was refused');
  for (const cap of [1, 100_000]) {
    const r = await post(c, {...GOOD, max_records: cap}, {key: \`k-ok-\${cap}\`});
    assert.equal(r.status, 201, \`max_records=\${cap} is within 1..100000 inclusive, got \${r.status}: \${r.text}\`);
    const stored = JSON.parse(ctx.redis.get(\`synth:job:\${r.json().job_id}\`));
    assert.equal(stored.max_records, cap, \`the stored job must carry the cap the workers enforce, got \${JSON.stringify(stored)}\`);
  }
}

export async function check_idempotency_key(ctx) {
  const c = api(ctx);
  const noKey = await post(c, GOOD, {withKey: false});
  assert.equal(noKey.status, 400, \`a submit without Idempotency-Key answered \${noKey.status}, expected 400\`);
  const first = await post(c, GOOD, {key: 'k-7'});
  assert.equal(first.status, 201, \`the first submit answered \${first.status}: \${first.text}\`);
  const replay = await post(c, GOOD, {key: 'k-7'});
  assert.equal(replay.status, 200, \`a replay of the same (tenant, Idempotency-Key) answered \${replay.status}, expected 200 with the stored job (the client retried; it must not start a second expansion)\`);
  assert.equal(replay.json().job_id, first.json().job_id, \`the replay must resume the same job: got \${replay.json().job_id}, the first submit made \${first.json().job_id}\`);
  assert(jobKeys(ctx).length === 1 && queued(ctx).length === 1, \`one key, one job: after a submit and its replay the store holds \${jobKeys(ctx).length} jobs and the queue \${queued(ctx).length}\`);
  const other = await post(c, GOOD, {key: 'k-7', tenant: 't2'});
  assert(other.status === 201 && other.json().job_id !== first.json().job_id, 'another tenant reusing the key gets its own job (keys are per tenant)');
}

export async function check_gate_before_enqueue(ctx) {
  const c = api(ctx);
  let r = await post(c, {...GOOD, seed_version: '2027-01-01'}, {key: 'k-unknown'});
  assert.equal(r.status, 422, \`an unregistered seed version answered \${r.status}, expected 422\`);
  nothingLeft(ctx, 'an unregistered seed was refused with 422');
  r = await post(c, {...GOOD, seed_dataset: 'forum-scrape'}, {key: 'k-unknown-2'});
  assert.equal(r.status, 422, \`an unregistered dataset answered \${r.status}, expected 422\`);
  nothingLeft(ctx, 'an unregistered dataset was refused with 422');
}
`,
    go: `package main

import (
	"encoding/json"
	"net/http"

	"leetbuild/harness"
)

var apiGood = map[string]any{"seed_dataset": "wiki-qa", "seed_version": "2026-04-01", "recipe": "qa-pairs", "max_records": 1000}

func apiClient(ctx *harness.Ctx) *harness.HTTP {
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

func apiWith(overrides map[string]any) map[string]any {
	out := map[string]any{}
	for k, v := range apiGood {
		out[k] = v
	}
	for k, v := range overrides {
		out[k] = v
	}
	return out
}

func apiPost(c *harness.HTTP, body map[string]any, key, tenant string) *harness.Response {
	return c.Post("/v1/synthetic/jobs", body, "X-Tenant-Id", tenant, "Idempotency-Key", key)
}

func apiJob(ctx *harness.Ctx, r *harness.Response) map[string]any {
	job, ok := r.JSON().(map[string]any)
	ctx.Assert(ok, "the body must be a JSON object: %s", r.Text())
	return job
}

func apiNothingLeft(ctx *harness.Ctx, what string) {
	ctx.Equal(len(ctx.Redis.LRange("synth:queue", 0, -1)), 0, "%s, yet the generation queue holds %v (the workers will expand it); queued jobs", what, ctx.Redis.LRange("synth:queue", 0, -1))
	ctx.Equal(len(ctx.Redis.Keys("synth:job:*")), 0, "%s, yet the job store holds %v; stored jobs", what, ctx.Redis.Keys("synth:job:*"))
}

func CheckRoute(ctx *harness.Ctx) {
	c := apiClient(ctx)
	r := apiPost(c, apiGood, "k-1", "t1")
	ctx.Equal(r.Status, 201, "a valid submit (%s)", r.Text())
	job := apiJob(ctx, r)
	for _, key := range []string{"job_id", "status", "seed_dataset", "seed_version", "recipe", "max_records"} {
		_, ok := job[key]
		ctx.Assert(ok, "the 201 body lacks %s: %s", key, r.Text())
	}
	ctx.Assert(job["status"] == "queued" && job["seed_dataset"] == "wiki-qa" && job["seed_version"] == "2026-04-01" && job["recipe"] == "qa-pairs" && job["max_records"] == float64(1000), "the job echoes the request with status queued: %s", r.Text())
	id, _ := job["job_id"].(string)
	_, stored := ctx.Redis.Get("synth:job:" + id)
	ctx.Assert(stored, "the job %s must be in the job store (synth:job:{id}): keys %v", id, ctx.Redis.Keys("synth:*"))
	ctx.Equal(ctx.Redis.LRange("synth:queue", 0, -1), []string{id}, "the accepted job must be handed to the workers once; the queue")
	noTenant := c.Post("/v1/synthetic/jobs", apiGood, "Idempotency-Key", "k-2")
	ctx.Equal(noTenant.Status, 401, "without X-Tenant-Id the submit")
}

func CheckDerivativeLicense(ctx *harness.Ctx) {
	c := apiClient(ctx)
	r := apiPost(c, apiWith(map[string]any{"seed_dataset": "news-crawl", "seed_version": "2026-02-15"}), "k-nd", "t1")
	ctx.Equal(r.Status, 422, "news-crawl@2026-02-15 is registered with a no-derivatives license (synthetic records are derivatives of their seed)")
	apiNothingLeft(ctx, "a seed whose license forbids derivatives was refused")
	r = apiPost(c, apiGood, "k-ok", "t1")
	ctx.Equal(r.Status, 201, "wiki-qa@2026-04-01 allows derivatives (%s)", r.Text())
}

func CheckRecordCap(ctx *harness.Ctx) {
	c := apiClient(ctx)
	for _, cap := range []int{0, -5, 100_001, 10_000_000} {
		r := apiPost(c, apiWith(map[string]any{"max_records": cap}), "k-"+harness.Show(cap), "t1")
		ctx.Equal(r.Status, 400, "max_records=%d (the service bounds a job to 1..100000 records)", cap)
	}
	r := apiPost(c, apiWith(map[string]any{"recipe": ""}), "k-recipe", "t1")
	ctx.Equal(r.Status, 400, "an empty recipe")
	apiNothingLeft(ctx, "every one of those submits was refused")
	for _, cap := range []int{1, 100_000} {
		r := apiPost(c, apiWith(map[string]any{"max_records": cap}), "k-ok-"+harness.Show(cap), "t1")
		ctx.Equal(r.Status, 201, "max_records=%d is within 1..100000 inclusive (%s)", cap, r.Text())
		id, _ := apiJob(ctx, r)["job_id"].(string)
		raw, _ := ctx.Redis.Get("synth:job:" + id)
		var stored map[string]any
		json.Unmarshal([]byte(raw), &stored)
		ctx.Equal(stored["max_records"], float64(cap), "the stored job must carry the cap the workers enforce (%s)", raw)
	}
}

func CheckIdempotencyKey(ctx *harness.Ctx) {
	c := apiClient(ctx)
	noKey := c.Post("/v1/synthetic/jobs", apiGood, "X-Tenant-Id", "t1")
	ctx.Equal(noKey.Status, 400, "a submit without Idempotency-Key")
	first := apiPost(c, apiGood, "k-7", "t1")
	ctx.Equal(first.Status, 201, "the first submit (%s)", first.Text())
	replay := apiPost(c, apiGood, "k-7", "t1")
	ctx.Equal(replay.Status, 200, "a replay of the same (tenant, Idempotency-Key) must answer the stored job (the client retried; it must not start a second expansion)")
	ctx.Equal(apiJob(ctx, replay)["job_id"], apiJob(ctx, first)["job_id"], "the replay must resume the same job")
	ctx.Assert(len(ctx.Redis.Keys("synth:job:*")) == 1 && len(ctx.Redis.LRange("synth:queue", 0, -1)) == 1, "one key, one job: after a submit and its replay the store holds %d jobs and the queue %d", len(ctx.Redis.Keys("synth:job:*")), len(ctx.Redis.LRange("synth:queue", 0, -1)))
	other := apiPost(c, apiGood, "k-7", "t2")
	ctx.Assert(other.Status == 201 && apiJob(ctx, other)["job_id"] != apiJob(ctx, first)["job_id"], "another tenant reusing the key gets its own job (keys are per tenant)")
}

func CheckGateBeforeEnqueue(ctx *harness.Ctx) {
	c := apiClient(ctx)
	r := apiPost(c, apiWith(map[string]any{"seed_version": "2027-01-01"}), "k-unknown", "t1")
	ctx.Equal(r.Status, 422, "an unregistered seed version")
	apiNothingLeft(ctx, "an unregistered seed was refused with 422")
	r = apiPost(c, apiWith(map[string]any{"seed_dataset": "forum-scrape"}), "k-unknown-2", "t1")
	ctx.Equal(r.Status, 422, "an unregistered dataset")
	apiNothingLeft(ctx, "an unregistered dataset was refused with 422")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <string>
#include <vector>

namespace {

using json = nlohmann::json;

const json kGood = {{"seed_dataset", "wiki-qa"}, {"seed_version", "2026-04-01"}, {"recipe", "qa-pairs"}, {"max_records", 1000}};

struct Api {
  httplib::Server svr;
  harness::HTTP http;
  explicit Api(harness::Ctx& ctx) : http(ctx.HTTP(svr)) { register_routes(svr); }

  harness::Response post(const json& body, const std::string& key = "k-1", const std::string& tenant = "t1") {
    return http.Post("/v1/synthetic/jobs", body.dump(), "X-Tenant-Id", tenant, "Idempotency-Key", key);
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

void nothingLeft(harness::Ctx& ctx, const std::string& what) {
  ctx.Equal(ctx.Redis.LLen("synth:queue"), 0, "%s, yet the generation queue holds %v (the workers will expand it); queued jobs", what, ctx.Redis.LRange("synth:queue", 0, -1));
  ctx.Equal(ctx.Redis.Keys("synth:job:*").size(), 0, "%s, yet the job store holds %v; stored jobs", what, ctx.Redis.Keys("synth:job:*"));
}

}  // namespace

void CheckRoute(harness::Ctx& ctx) {
  Api api(ctx);
  const auto r = api.post(kGood);
  ctx.Equal(r.Status, 201, "a valid submit (%s)", r.Text());
  const json job = jobOf(ctx, r);
  for (const char* key : {"job_id", "status", "seed_dataset", "seed_version", "recipe", "max_records"}) {
    ctx.Assert(job.contains(key), "the 201 body lacks %s: %s", key, r.Text());
  }
  ctx.Assert(job["status"] == "queued" && job["seed_dataset"] == "wiki-qa" && job["seed_version"] == "2026-04-01" && job["recipe"] == "qa-pairs" && job["max_records"] == 1000,
             "the job echoes the request with status queued: %s", r.Text());
  const std::string id = job["job_id"].is_string() ? job["job_id"].get<std::string>() : "";
  ctx.Assert(ctx.Redis.Get("synth:job:" + id).has_value(), "the job %s must be in the job store (synth:job:{id}): keys %v", id, ctx.Redis.Keys("synth:*"));
  ctx.Equal(ctx.Redis.LRange("synth:queue", 0, -1), std::vector<std::string>{id}, "the accepted job must be handed to the workers once; the queue");
  const auto noTenant = api.http.Post("/v1/synthetic/jobs", kGood.dump(), "Idempotency-Key", "k-2");
  ctx.Equal(noTenant.Status, 401, "without X-Tenant-Id the submit");
}

void CheckDerivativeLicense(harness::Ctx& ctx) {
  Api api(ctx);
  auto r = api.post(with(with(kGood, "seed_dataset", "news-crawl"), "seed_version", "2026-02-15"), "k-nd");
  ctx.Equal(r.Status, 422, "news-crawl@2026-02-15 is registered with a no-derivatives license (synthetic records are derivatives of their seed)");
  nothingLeft(ctx, "a seed whose license forbids derivatives was refused");
  r = api.post(kGood, "k-ok");
  ctx.Equal(r.Status, 201, "wiki-qa@2026-04-01 allows derivatives (%s)", r.Text());
}

void CheckRecordCap(harness::Ctx& ctx) {
  Api api(ctx);
  for (long long cap : {0LL, -5LL, 100001LL, 10000000LL}) {
    const auto r = api.post(with(kGood, "max_records", cap), "k-" + std::to_string(cap));
    ctx.Equal(r.Status, 400, "max_records=%d (the service bounds a job to 1..100000 records)", cap);
  }
  const auto noRecipe = api.post(with(kGood, "recipe", ""), "k-recipe");
  ctx.Equal(noRecipe.Status, 400, "an empty recipe");
  nothingLeft(ctx, "every one of those submits was refused");
  for (long long cap : {1LL, 100000LL}) {
    const auto r = api.post(with(kGood, "max_records", cap), "k-ok-" + std::to_string(cap));
    ctx.Equal(r.Status, 201, "max_records=%d is within 1..100000 inclusive (%s)", cap, r.Text());
    const json job = jobOf(ctx, r);
    const std::string id = job.value("job_id", std::string());
    const json stored = json::parse(ctx.Redis.Get("synth:job:" + id).value_or("{}"), nullptr, false);
    ctx.Assert(stored.is_object() && stored.value("max_records", 0LL) == cap, "the stored job must carry the cap the workers enforce, got %s", stored.dump());
  }
}

void CheckIdempotencyKey(harness::Ctx& ctx) {
  Api api(ctx);
  const auto noKey = api.http.Post("/v1/synthetic/jobs", kGood.dump(), "X-Tenant-Id", "t1");
  ctx.Equal(noKey.Status, 400, "a submit without Idempotency-Key");
  const auto first = api.post(kGood, "k-7");
  ctx.Equal(first.Status, 201, "the first submit (%s)", first.Text());
  const auto replay = api.post(kGood, "k-7");
  ctx.Equal(replay.Status, 200, "a replay of the same (tenant, Idempotency-Key) must answer the stored job (the client retried; it must not start a second expansion)");
  ctx.Equal(jobOf(ctx, replay)["job_id"], jobOf(ctx, first)["job_id"], "the replay must resume the same job");
  ctx.Assert(ctx.Redis.Keys("synth:job:*").size() == 1 && ctx.Redis.LLen("synth:queue") == 1, "one key, one job: after a submit and its replay the store holds %d jobs and the queue %d",
             ctx.Redis.Keys("synth:job:*").size(), ctx.Redis.LLen("synth:queue"));
  const auto other = api.post(kGood, "k-7", "t2");
  ctx.Assert(other.Status == 201 && jobOf(ctx, other)["job_id"] != jobOf(ctx, first)["job_id"], "another tenant reusing the key gets its own job (keys are per tenant)");
}

void CheckGateBeforeEnqueue(harness::Ctx& ctx) {
  Api api(ctx);
  auto r = api.post(with(kGood, "seed_version", "2027-01-01"), "k-unknown");
  ctx.Equal(r.Status, 422, "an unregistered seed version");
  nothingLeft(ctx, "an unregistered seed was refused with 422");
  r = api.post(with(kGood, "seed_dataset", "forum-scrape"), "k-unknown-2");
  ctx.Equal(r.Status, 422, "an unregistered dataset");
  nothingLeft(ctx, "an unregistered dataset was refused with 422");
}
`,
  },
  debrief: `The order of the guards is the fix. The caller's mistakes (headers, recipe, cap) come first and are 400; the seed is resolved next, and the license is read from the registry row rather than trusted from the request, so a well-formed job over a no-derivatives seed is 422 before anything exists to undo. \`enqueue\` goes last because it is the one call that cannot be taken back: once a worker has the job, records start existing. Keying the store by \`(tenant, Idempotency-Key)\` makes a retry resume instead of doubling the corpus. A production registry also versions the license text itself, records which license a job was accepted under, and answers a replay whose body differs from the stored job with 409 instead of the old job.`,
};
