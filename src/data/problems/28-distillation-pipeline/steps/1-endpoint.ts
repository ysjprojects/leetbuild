import type {Step} from '@/lib/types';

export const endpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/distill/jobs: a job with a budget and a key',
  concept: 'http',
  guides: ['request-boundaries', 'idempotent-requests'],
  file: 'api',
  focus: ['client', 'api', 'redis'],
  task: `## Task

**Starting point.** The starter serves \`POST /v1/distill/jobs\` with body \`{"teacher", "dataset_id",
"sample_cap"}\`: it answers 401 without \`X-Tenant-Id\`, builds a job with a fresh id and zero counters,
stores it through the provided job store under \`(tenant, job_id)\` and answers 201. It serves the demo
and hides four flaws.

**Failure mode the checks target.** A free-form \`teacher\` lets a caller spend the pipeline's budget on
a model the platform never approved, and an unbounded \`sample_cap\` turns "a quick run" into a week of
teacher tokens. The store key shows only under retries: every client retry, and every gateway retry
after a timeout, starts another job over the same dataset.

Requirements:

- \`teacher\` must be in the server-side catalog \`APPROVED_TEACHERS\` (\`teach-70b-v3\`, \`teach-13b-v2\`);
  anything else is **400**. The caller names a dataset and a size, not a model.
- \`dataset_id\` is a non-empty string; \`sample_cap\` is an integer from **100** to **10000**
  (\`MIN_SAMPLE_CAP\`, \`MAX_SAMPLE_CAP\`); **400** otherwise.
- \`Idempotency-Key\` is required (**400** when missing). The job is stored under \`(tenant, key)\`
  (\`store.put\`), and a replay of the same pair answers **200** with the stored job (\`store.get\`)
  instead of starting a second one.
- Every rejection happens **before** \`store.put\`: a rejected request leaves no job behind.
- A new job answers **201** with \`{job_id, status: "queued", teacher, dataset_id, sample_cap,
  sampled, accepted, rejected}\`.`,
  sequence: {
    participants: ['Client', 'Distill API', 'job store'],
    messages: [
      {from: 'Client', to: 'Distill API', label: 'POST /v1/distill/jobs · X-Tenant-Id · Idempotency-Key', kind: 'sync'},
      {from: 'Distill API', to: 'Distill API', label: 'validate teacher · dataset · cap', kind: 'sync'},
      {from: 'Distill API', to: 'job store', label: 'get(tenant, key)', kind: 'sync'},
      {from: 'job store', to: 'Distill API', label: 'stored job / none', kind: 'reply'},
      {from: 'Distill API', to: 'job store', label: 'put(tenant, key, job)', kind: 'sync'},
      {from: 'Distill API', to: 'Client', label: '201 {job_id, status, sample_cap, …}', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Handles POST /v1/distill/jobs',
      detail:
        'The start-a-job route answers 201 with the job (job_id, status queued, teacher, dataset_id, sample_cap, zero counters) and 401 without X-Tenant-Id.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/distill\/jobs["']/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/distill\/jobs['"]/]},
        go: {all: [/HandleFunc\(\s*"POST \/v1\/distill\/jobs"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"distill"\s*\/\s*"jobs"\s*\)/, /\bpost\s*\{/]},
        cpp: {all: [/svr\.Post\(\s*"\/v1\/distill\/jobs"/]},
      },
    },
    {
      id: 'approved-teacher',
      title: 'Refuses a teacher outside the approved catalog',
      detail:
        'The teacher is checked against the server-side catalog and anything else is 400 with no job stored. The starter stores whatever model string the caller sends.',
      match: {
        python: {all: [/APPROVED_TEACHERS/, /status_code\s*=\s*400/]},
        typescript: {all: [/APPROVED_TEACHERS/, /code\(\s*400\s*\)/]},
        go: {all: [/approvedTeachers/, /StatusBadRequest/]},
        scala: {all: [/ApprovedTeachers/, /StatusCodes\.BadRequest/]},
        cpp: {all: [/kApprovedTeachers/, /\b400\b/]},
      },
    },
    {
      id: 'sample-cap',
      title: 'Bounds sample_cap to 100..10000',
      detail:
        'A cap below 100 or above 10000 is 400 and stores nothing; 100 and 10000 are accepted. The starter accepts any cap, a negative one included.',
      match: {
        python: {all: [/MIN_SAMPLE_CAP/, /MAX_SAMPLE_CAP/, /status_code\s*=\s*400/]},
        typescript: {all: [/MIN_SAMPLE_CAP/, /MAX_SAMPLE_CAP/, /code\(\s*400\s*\)/]},
        go: {all: [/minSampleCap/, /maxSampleCap/, /StatusBadRequest/]},
        scala: {all: [/MinSampleCap/, /MaxSampleCap/, /StatusCodes\.BadRequest/]},
        cpp: {all: [/kMinSampleCap/, /kMaxSampleCap/, /\b400\b/]},
      },
    },
    {
      id: 'idempotency-key',
      title: 'Keys job starts by (tenant, Idempotency-Key)',
      detail:
        'Idempotency-Key is required (400 without it); a replay of the same (tenant, key) answers 200 with the same job_id, another tenant with the same key gets its own job. The starter stores the job under its own fresh id, so every retry starts a new job.',
      match: {
        python: {all: [/Idempotency-Key/, /store\.get\(\s*tenant\s*,/, /store\.put\(\s*tenant\s*,\s*idem/]},
        typescript: {all: [/idempotency-key/, /store\.get\(\s*tenant\s*,/, /store\.put\(\s*tenant\s*,\s*idem/]},
        go: {all: [/Idempotency-Key/, /jobs\.Get\(/, /jobs\.Put\(\s*[\w.()]+,\s*tenant\s*,\s*idem/]},
        scala: {all: [/Idempotency-Key/, /Jobs\.get\(\s*tenant\s*,/, /Jobs\.put\(\s*tenant\s*,\s*idem/]},
        cpp: {all: [/Idempotency-Key/, /jobs::get\(\s*tenant\s*,/, /jobs::put\(\s*tenant\s*,\s*idem/]},
      },
    },
    {
      id: 'validate-before-create',
      title: 'Rejects before it stores the job',
      detail:
        'The catalog and the cap are checked before store.put, so a rejected request touches the store not at all. The starter stores first.',
      match: {
        python: {order: [/[<>]=?\s*MAX_SAMPLE_CAP|MAX_SAMPLE_CAP\s*[<>]|le\s*=\s*MAX_SAMPLE_CAP/, /store\.put\(/]},
        typescript: {order: [/[<>]=?\s*MAX_SAMPLE_CAP|MAX_SAMPLE_CAP\s*[<>]/, /store\.put\(/]},
        go: {order: [/[<>]=?\s*maxSampleCap|maxSampleCap\s*[<>]/, /jobs\.Put\(/]},
        scala: {order: [/[<>]=?\s*MaxSampleCap|MaxSampleCap\s*[<>]/, /Jobs\.put\(/]},
        cpp: {order: [/[<>]=?\s*kMaxSampleCap|kMaxSampleCap\s*[<>]/, /jobs::put\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import logging
import uuid

from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from distill.jobs import store

app = FastAPI()
logger = logging.getLogger("distill")


class JobRequest(BaseModel):
    teacher: str
    dataset_id: str
    sample_cap: int


@app.post("/v1/distill/jobs")
def start_job(body: JobRequest, tenant: str | None = Header(default=None, alias="X-Tenant-Id")) -> JSONResponse:
    # TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
    if tenant is None or tenant == "":
        raise HTTPException(status_code=401, detail="missing X-Tenant-Id")
    job = {
        "job_id": str(uuid.uuid4()),
        "status": "queued",
        "teacher": body.teacher,
        "dataset_id": body.dataset_id,
        "sample_cap": body.sample_cap,
        "sampled": 0,
        "accepted": 0,
        "rejected": 0,
    }
    store.put(tenant, job["job_id"], job)
    logger.info("distill job=%s teacher=%s cap=%d", job["job_id"], body.teacher, body.sample_cap)
    return JSONResponse(job, status_code=201)
`,
      solution: `import logging
import uuid

from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from distill.jobs import store

app = FastAPI()
logger = logging.getLogger("distill")

MIN_SAMPLE_CAP = 100
MAX_SAMPLE_CAP = 10_000
APPROVED_TEACHERS = {"teach-70b-v3", "teach-13b-v2"}


class JobRequest(BaseModel):
    teacher: str
    dataset_id: str
    sample_cap: int


@app.post("/v1/distill/jobs")
def start_job(
    body: JobRequest,
    tenant: str | None = Header(default=None, alias="X-Tenant-Id"),
    idem_key: str | None = Header(default=None, alias="Idempotency-Key"),
) -> JSONResponse:
    if tenant is None or tenant == "":
        raise HTTPException(status_code=401, detail="missing X-Tenant-Id")
    if idem_key is None or idem_key == "":
        raise HTTPException(status_code=400, detail="Idempotency-Key is required")
    if body.teacher not in APPROVED_TEACHERS:
        raise HTTPException(status_code=400, detail="teacher is not in the approved catalog")
    if body.dataset_id == "":
        raise HTTPException(status_code=400, detail="dataset_id is required")
    if not MIN_SAMPLE_CAP <= body.sample_cap <= MAX_SAMPLE_CAP:
        raise HTTPException(status_code=400, detail=f"sample_cap must be {MIN_SAMPLE_CAP}..{MAX_SAMPLE_CAP}")

    stored = store.get(tenant, idem_key)
    if stored is not None:
        return JSONResponse(stored, status_code=200)

    job = {
        "job_id": str(uuid.uuid4()),
        "status": "queued",
        "teacher": body.teacher,
        "dataset_id": body.dataset_id,
        "sample_cap": body.sample_cap,
        "sampled": 0,
        "accepted": 0,
        "rejected": 0,
    }
    store.put(tenant, idem_key, job)
    logger.info("distill job=%s teacher=%s cap=%d", job["job_id"], body.teacher, body.sample_cap)
    return JSONResponse(job, status_code=201)
`,
    },
    typescript: {
      starter: `import {randomUUID} from 'node:crypto';

import Fastify from 'fastify';

import {type Job, store} from 'distill/jobs';

export const app = Fastify();

interface JobBody {
  teacher: string;
  dataset_id: string;
  sample_cap: number;
}

app.post('/v1/distill/jobs', async (request, reply) => {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing X-Tenant-Id'});
  const body = request.body as JobBody;
  const job: Job = {
    job_id: randomUUID(),
    status: 'queued',
    teacher: body.teacher,
    dataset_id: body.dataset_id,
    sample_cap: body.sample_cap,
    sampled: 0,
    accepted: 0,
    rejected: 0,
  };
  await store.put(tenant, job.job_id, job);
  request.log.info({tenant, job_id: job.job_id, teacher: job.teacher, cap: job.sample_cap}, 'job queued');
  return reply.code(201).send(job);
});
`,
      solution: `import {randomUUID} from 'node:crypto';

import Fastify from 'fastify';

import {type Job, store} from 'distill/jobs';

export const app = Fastify();

export const MIN_SAMPLE_CAP = 100;
export const MAX_SAMPLE_CAP = 10_000;
export const APPROVED_TEACHERS: Record<string, true> = {'teach-70b-v3': true, 'teach-13b-v2': true};

interface JobBody {
  teacher: string;
  dataset_id: string;
  sample_cap: number;
}

app.post('/v1/distill/jobs', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing X-Tenant-Id'});
  const idemKey = request.headers['idempotency-key'];
  if (typeof idemKey !== 'string' || idemKey === '') return reply.code(400).send({error: 'Idempotency-Key is required'});
  const body = (request.body ?? {}) as Partial<JobBody>;
  if (typeof body.teacher !== 'string' || APPROVED_TEACHERS[body.teacher] !== true)
    return reply.code(400).send({error: 'teacher is not in the approved catalog'});
  if (typeof body.dataset_id !== 'string' || body.dataset_id === '')
    return reply.code(400).send({error: 'dataset_id is required'});
  const cap = body.sample_cap;
  if (!Number.isInteger(cap) || (cap as number) < MIN_SAMPLE_CAP || (cap as number) > MAX_SAMPLE_CAP)
    return reply.code(400).send({error: \`sample_cap must be \${MIN_SAMPLE_CAP}..\${MAX_SAMPLE_CAP}\`});

  const stored = await store.get(tenant, idemKey);
  if (stored !== null) return reply.code(200).send(stored);

  const job: Job = {
    job_id: randomUUID(),
    status: 'queued',
    teacher: body.teacher,
    dataset_id: body.dataset_id,
    sample_cap: cap as number,
    sampled: 0,
    accepted: 0,
    rejected: 0,
  };
  await store.put(tenant, idemKey, job);
  request.log.info({tenant, job_id: job.job_id, teacher: job.teacher, cap: job.sample_cap}, 'job queued');
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

	"distill/jobs" // jobs.Job, jobs.Get(ctx, tenant, idemKey), jobs.Put(ctx, tenant, idemKey, job) — provided
)

type JobRequest struct {
	Teacher   string \`json:"teacher"\`
	DatasetID string \`json:"dataset_id"\`
	SampleCap int    \`json:"sample_cap"\`
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func startJob(rw http.ResponseWriter, r *http.Request) {
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
		JobID:     uuid.NewString(),
		Status:    "queued",
		Teacher:   body.Teacher,
		DatasetID: body.DatasetID,
		SampleCap: body.SampleCap,
	}
	if err := jobs.Put(r.Context(), tenant, job.JobID, job); err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	log.Printf("distill job=%s teacher=%s cap=%d", job.JobID, job.Teacher, job.SampleCap)
	writeJSON(rw, http.StatusCreated, job)
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/distill/jobs", startJob)
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

	"distill/jobs" // jobs.Job, jobs.Get(ctx, tenant, idemKey), jobs.Put(ctx, tenant, idemKey, job) — provided
)

const (
	minSampleCap = 100
	maxSampleCap = 10_000
)

var approvedTeachers = map[string]bool{"teach-70b-v3": true, "teach-13b-v2": true}

type JobRequest struct {
	Teacher   string \`json:"teacher"\`
	DatasetID string \`json:"dataset_id"\`
	SampleCap int    \`json:"sample_cap"\`
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func startJob(rw http.ResponseWriter, r *http.Request) {
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
	if !approvedTeachers[body.Teacher] {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "teacher is not in the approved catalog"})
		return
	}
	if body.DatasetID == "" {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "dataset_id is required"})
		return
	}
	if body.SampleCap < minSampleCap || body.SampleCap > maxSampleCap {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "sample_cap must be 100..10000"})
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
		JobID:     uuid.NewString(),
		Status:    "queued",
		Teacher:   body.Teacher,
		DatasetID: body.DatasetID,
		SampleCap: body.SampleCap,
	}
	if err := jobs.Put(r.Context(), tenant, idemKey, job); err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	log.Printf("distill job=%s teacher=%s cap=%d", job.JobID, job.Teacher, job.SampleCap)
	writeJSON(rw, http.StatusCreated, job)
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/distill/jobs", startJob)
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

import distill.{Job, Jobs}

final case class JobRequest(teacher: String, dataset_id: String, sample_cap: Int)

object DistillApi {
  implicit val system: ActorSystem = ActorSystem("distill-pipeline")
  implicit val requestFormat: RootJsonFormat[JobRequest] = jsonFormat3(JobRequest)
  implicit val jobFormat: RootJsonFormat[Job] = jsonFormat8(Job)

  val route: Route =
    path("v1" / "distill" / "jobs") {
      post {
        optionalHeaderValueByName("X-Tenant-Id") { tenantOpt =>
          entity(as[JobRequest]) { body =>
            // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
            if (!tenantOpt.exists(_.nonEmpty)) {
              complete(StatusCodes.Unauthorized, """{"error":"missing X-Tenant-Id"}""")
            } else {
              val tenant = tenantOpt.get
              val job = Job(UUID.randomUUID().toString, "queued", body.teacher, body.dataset_id, body.sample_cap, 0, 0, 0)
              Jobs.put(tenant, job.job_id, job)
              system.log.info(s"distill job=\${job.job_id} teacher=\${job.teacher} cap=\${job.sample_cap}")
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

import distill.{Job, Jobs}

final case class JobRequest(teacher: String, dataset_id: String, sample_cap: Int)

object DistillApi {
  implicit val system: ActorSystem = ActorSystem("distill-pipeline")
  implicit val requestFormat: RootJsonFormat[JobRequest] = jsonFormat3(JobRequest)
  implicit val jobFormat: RootJsonFormat[Job] = jsonFormat8(Job)

  val MinSampleCap = 100
  val MaxSampleCap = 10000
  val ApprovedTeachers = Set("teach-70b-v3", "teach-13b-v2")

  val route: Route =
    path("v1" / "distill" / "jobs") {
      post {
        optionalHeaderValueByName("X-Tenant-Id") { tenantOpt =>
          optionalHeaderValueByName("Idempotency-Key") { idemOpt =>
            entity(as[JobRequest]) { body =>
              if (!tenantOpt.exists(_.nonEmpty)) {
                complete(StatusCodes.Unauthorized, """{"error":"missing X-Tenant-Id"}""")
              } else if (!idemOpt.exists(_.nonEmpty)) {
                complete(StatusCodes.BadRequest, """{"error":"Idempotency-Key is required"}""")
              } else if (!ApprovedTeachers.contains(body.teacher)) {
                complete(StatusCodes.BadRequest, """{"error":"teacher is not in the approved catalog"}""")
              } else if (body.dataset_id.isEmpty) {
                complete(StatusCodes.BadRequest, """{"error":"dataset_id is required"}""")
              } else if (body.sample_cap < MinSampleCap || body.sample_cap > MaxSampleCap) {
                complete(StatusCodes.BadRequest, """{"error":"sample_cap must be 100..10000"}""")
              } else {
                val tenant = tenantOpt.get
                val idemKey = idemOpt.get
                Jobs.get(tenant, idemKey) match {
                  case Some(stored) =>
                    complete(StatusCodes.OK, stored.job)
                  case None =>
                    val job =
                      Job(UUID.randomUUID().toString, "queued", body.teacher, body.dataset_id, body.sample_cap, 0, 0, 0)
                    Jobs.put(tenant, idemKey, job)
                    system.log.info(s"distill job=\${job.job_id} teacher=\${job.teacher} cap=\${job.sample_cap}")
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

#include "distill/jobs.h"  // jobs::get(tenant, idem_key), jobs::put(tenant, idem_key, job) — provided
#include "ids.h"           // new_uuid() — provided

using json = nlohmann::json;

void start_job(const httplib::Request& req, httplib::Response& res) {
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
  const json job = {
      {"job_id", new_uuid()},
      {"status", "queued"},
      {"teacher", body.value("teacher", std::string())},
      {"dataset_id", body.value("dataset_id", std::string())},
      {"sample_cap", body.value("sample_cap", 0)},
      {"sampled", 0},
      {"accepted", 0},
      {"rejected", 0},
  };
  jobs::put(tenant, job["job_id"].get<std::string>(), job);
  std::cerr << "distill job=" << job["job_id"] << " cap=" << job["sample_cap"] << "\\n";
  res.status = 201;
  res.set_content(job.dump(), "application/json");
}

void register_routes(httplib::Server& svr) { svr.Post("/v1/distill/jobs", start_job); }

int main() {
  httplib::Server svr;
  register_routes(svr);
  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <iostream>
#include <set>
#include <string>

#include "distill/jobs.h"  // jobs::get(tenant, idem_key), jobs::put(tenant, idem_key, job) — provided
#include "ids.h"           // new_uuid() — provided

using json = nlohmann::json;

constexpr int kMinSampleCap = 100;
constexpr int kMaxSampleCap = 10000;
const std::set<std::string> kApprovedTeachers = {"teach-70b-v3", "teach-13b-v2"};

void reject(httplib::Response& res, int status, const std::string& error) {
  res.status = status;
  res.set_content(json({{"error", error}}).dump(), "application/json");
}

void start_job(const httplib::Request& req, httplib::Response& res) {
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) return reject(res, 401, "missing X-Tenant-Id");
  const std::string idem_key = req.get_header_value("Idempotency-Key");
  if (idem_key.empty()) return reject(res, 400, "Idempotency-Key is required");
  const json body = json::parse(req.body, nullptr, false);
  if (!body.is_object() || !body.contains("teacher") || !body["teacher"].is_string() ||
      kApprovedTeachers.count(body["teacher"].get<std::string>()) == 0)
    return reject(res, 400, "teacher is not in the approved catalog");
  if (!body.contains("dataset_id") || !body["dataset_id"].is_string() || body["dataset_id"].get<std::string>().empty())
    return reject(res, 400, "dataset_id is required");
  if (!body.contains("sample_cap") || !body["sample_cap"].is_number_integer()) return reject(res, 400, "sample_cap must be 100..10000");
  const int sample_cap = body["sample_cap"].get<int>();
  if (sample_cap < kMinSampleCap || sample_cap > kMaxSampleCap) return reject(res, 400, "sample_cap must be 100..10000");

  if (const auto stored = jobs::get(tenant, idem_key)) {
    res.status = 200;
    res.set_content(stored->dump(), "application/json");
    return;
  }
  const json job = {
      {"job_id", new_uuid()},
      {"status", "queued"},
      {"teacher", body["teacher"]},
      {"dataset_id", body["dataset_id"]},
      {"sample_cap", sample_cap},
      {"sampled", 0},
      {"accepted", 0},
      {"rejected", 0},
  };
  jobs::put(tenant, idem_key, job);
  std::cerr << "distill job=" << job["job_id"] << " teacher=" << job["teacher"] << " cap=" << sample_cap << "\\n";
  res.status = 201;
  res.set_content(job.dump(), "application/json");
}

void register_routes(httplib::Server& svr) { svr.Post("/v1/distill/jobs", start_job); }

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

TENANT = {"X-Tenant-Id": "t1"}
GOOD = {"teacher": "teach-70b-v3", "dataset_id": "ds-support-2026", "sample_cap": 1000}
FIELDS = ("job_id", "status", "teacher", "dataset_id", "sample_cap", "sampled", "accepted", "rejected")


def _api(ctx):
    m = ctx.load("api")
    return ctx.client(m.app)


async def _post(c, body, key="k-1", tenant="t1", with_key=True):
    headers = {"X-Tenant-Id": tenant}
    if with_key:
        headers["Idempotency-Key"] = key
    return await c.post("/v1/distill/jobs", json=body, headers=headers)


def _stored(ctx, job_id):
    raw = ctx.redis.get(f"distill:job:{job_id}")
    return json.loads(raw) if raw else None


async def check_route(ctx):
    async with _api(ctx) as c:
        r = await _post(c, GOOD)
        assert r.status_code == 201, f"a valid start answered {r.status_code}: {r.text}"
        job = r.json()
        for key in FIELDS:
            assert key in job, f"the 201 body lacks {key!r}: {job}"
        assert job["status"] == "queued" and job["teacher"] == GOOD["teacher"] and job["dataset_id"] == GOOD["dataset_id"] and job["sample_cap"] == 1000, f"the job echoes the request with status queued: {job}"
        assert (job["sampled"], job["accepted"], job["rejected"]) == (0, 0, 0), f"a new job has zero counters: {job}"
        assert job["job_id"], "the job needs a job_id"
        assert _stored(ctx, job["job_id"]) is not None, f"the job {job['job_id']} must be in the job store (distill:job:{{id}}): keys {sorted(ctx.redis.keys('distill:*'))}"
        r = await c.post("/v1/distill/jobs", json=GOOD, headers={"Idempotency-Key": "k-1"})
        assert r.status_code == 401, f"without X-Tenant-Id the start must answer 401, got {r.status_code}"


async def check_approved_teacher(ctx):
    async with _api(ctx) as c:
        r = await _post(c, {**GOOD, "teacher": "gpt-5-max"}, key="k-bad")
        assert r.status_code == 400, f"a teacher outside the catalog (gpt-5-max) answered {r.status_code}, expected 400: the caller must not pick the model that spends the budget"
        assert ctx.redis.keys("distill:job:*") == [], f"a refused start must store no job, found {ctx.redis.keys('distill:job:*')}"
        r = await _post(c, {**GOOD, "teacher": "teach-13b-v2"}, key="k-ok")
        assert r.status_code == 201, f"teach-13b-v2 is in the catalog, got {r.status_code}: {r.text}"


async def check_sample_cap(ctx):
    async with _api(ctx) as c:
        for cap in (99, 10001, 0, -5):
            r = await _post(c, {**GOOD, "sample_cap": cap}, key=f"k-{cap}")
            assert r.status_code == 400, f"sample_cap={cap} answered {r.status_code}, expected 400 (the cap is the job's budget: 100..10000)"
        assert ctx.redis.keys("distill:job:*") == [], f"refused caps must store no job, found {ctx.redis.keys('distill:job:*')}"
        for cap in (100, 10000):
            r = await _post(c, {**GOOD, "sample_cap": cap}, key=f"k-{cap}")
            assert r.status_code == 201, f"sample_cap={cap} is within 100..10000 inclusive, got {r.status_code}: {r.text}"


async def check_idempotency_key(ctx):
    async with _api(ctx) as c:
        r = await _post(c, GOOD, with_key=False)
        assert r.status_code == 400, f"a start without Idempotency-Key answered {r.status_code}, expected 400"
        first = await _post(c, GOOD, key="k-7")
        assert first.status_code == 201, f"the first start answered {first.status_code}: {first.text}"
        replay = await _post(c, GOOD, key="k-7")
        assert replay.status_code == 200, f"a replay of the same (tenant, Idempotency-Key) answered {replay.status_code}, expected 200 with the stored job (the client retried; it must not get a second job)"
        assert replay.json()["job_id"] == first.json()["job_id"], f"the replay must resume the same job: got {replay.json()['job_id']}, the first start made {first.json()['job_id']}"
        assert len(ctx.redis.keys("distill:job:*")) == 1, f"one key, one job: the store holds {len(ctx.redis.keys('distill:job:*'))} jobs after a start and its replay"
        other = await _post(c, GOOD, key="k-7", tenant="t2")
        assert other.status_code == 201 and other.json()["job_id"] != first.json()["job_id"], "another tenant reusing the key gets its own job (keys are per tenant)"


async def check_validate_before_create(ctx):
    async with _api(ctx) as c:
        touched = ctx.redis_after("distill:idem:t1:k-bad", lambda: sorted(ctx.redis.keys("distill:*")))
        r = await _post(c, {**GOOD, "sample_cap": 5}, key="k-bad")
        assert r.status_code == 400, f"sample_cap=5 answered {r.status_code}, expected 400"
        assert not touched.fired, f"a rejected start touched the job store (keys at that moment: {touched.result}): validate before store.put, so nothing has to be unwound"
        assert ctx.redis.keys("distill:*") == [], f"a rejected start must leave nothing in Redis, found {ctx.redis.keys('distill:*')}"
        r = await _post(c, {**GOOD, "teacher": "gpt-5-max"}, key="k-bad")
        assert r.status_code == 400 and ctx.redis.keys("distill:*") == [], "a refused teacher must leave nothing in Redis either"
`,
    typescript: `const GOOD = {teacher: 'teach-70b-v3', dataset_id: 'ds-support-2026', sample_cap: 1000};
const FIELDS = ['job_id', 'status', 'teacher', 'dataset_id', 'sample_cap', 'sampled', 'accepted', 'rejected'];

function api(ctx) {
  const m = ctx.load('api');
  return ctx.client(m.app);
}

async function post(c, body, {key = 'k-1', tenant = 't1', withKey = true} = {}) {
  const headers: Record<string, string> = {'X-Tenant-Id': tenant};
  if (withKey) headers['Idempotency-Key'] = key;
  return c.post('/v1/distill/jobs', {body, headers});
}

const jobKeys = ctx => ctx.redis.keys('distill:job:*');

export async function check_route(ctx) {
  const c = api(ctx);
  const r = await post(c, GOOD);
  assert.equal(r.status, 201, \`a valid start answered \${r.status}: \${r.text}\`);
  const job = r.json();
  for (const key of FIELDS) assert(key in job, \`the 201 body lacks \${key}: \${r.text}\`);
  assert(job.status === 'queued' && job.teacher === GOOD.teacher && job.dataset_id === GOOD.dataset_id && job.sample_cap === 1000, \`the job echoes the request with status queued: \${r.text}\`);
  assert(job.sampled === 0 && job.accepted === 0 && job.rejected === 0, \`a new job has zero counters: \${r.text}\`);
  assert(job.job_id, 'the job needs a job_id');
  assert(ctx.redis.get(\`distill:job:\${job.job_id}\`) !== null, \`the job \${job.job_id} must be in the job store (distill:job:{id}): keys \${JSON.stringify(ctx.redis.keys('distill:*').sort())}\`);
  const noTenant = await c.post('/v1/distill/jobs', {body: GOOD, headers: {'Idempotency-Key': 'k-1'}});
  assert.equal(noTenant.status, 401, \`without X-Tenant-Id the start must answer 401, got \${noTenant.status}\`);
}

export async function check_approved_teacher(ctx) {
  const c = api(ctx);
  let r = await post(c, {...GOOD, teacher: 'gpt-5-max'}, {key: 'k-bad'});
  assert.equal(r.status, 400, \`a teacher outside the catalog (gpt-5-max) answered \${r.status}, expected 400: the caller must not pick the model that spends the budget\`);
  assert.deepEqual(jobKeys(ctx), [], \`a refused start must store no job, found \${JSON.stringify(jobKeys(ctx))}\`);
  r = await post(c, {...GOOD, teacher: 'teach-13b-v2'}, {key: 'k-ok'});
  assert.equal(r.status, 201, \`teach-13b-v2 is in the catalog, got \${r.status}: \${r.text}\`);
}

export async function check_sample_cap(ctx) {
  const c = api(ctx);
  for (const cap of [99, 10001, 0, -5]) {
    const r = await post(c, {...GOOD, sample_cap: cap}, {key: \`k-\${cap}\`});
    assert.equal(r.status, 400, \`sample_cap=\${cap} answered \${r.status}, expected 400 (the cap is the job's budget: 100..10000)\`);
  }
  assert.deepEqual(jobKeys(ctx), [], \`refused caps must store no job, found \${JSON.stringify(jobKeys(ctx))}\`);
  for (const cap of [100, 10000]) {
    const r = await post(c, {...GOOD, sample_cap: cap}, {key: \`k-\${cap}\`});
    assert.equal(r.status, 201, \`sample_cap=\${cap} is within 100..10000 inclusive, got \${r.status}: \${r.text}\`);
  }
}

export async function check_idempotency_key(ctx) {
  const c = api(ctx);
  const noKey = await post(c, GOOD, {withKey: false});
  assert.equal(noKey.status, 400, \`a start without Idempotency-Key answered \${noKey.status}, expected 400\`);
  const first = await post(c, GOOD, {key: 'k-7'});
  assert.equal(first.status, 201, \`the first start answered \${first.status}: \${first.text}\`);
  const replay = await post(c, GOOD, {key: 'k-7'});
  assert.equal(replay.status, 200, \`a replay of the same (tenant, Idempotency-Key) answered \${replay.status}, expected 200 with the stored job (the client retried; it must not get a second job)\`);
  assert.equal(replay.json().job_id, first.json().job_id, \`the replay must resume the same job: got \${replay.json().job_id}, the first start made \${first.json().job_id}\`);
  assert.equal(jobKeys(ctx).length, 1, \`one key, one job: the store holds \${jobKeys(ctx).length} jobs after a start and its replay\`);
  const other = await post(c, GOOD, {key: 'k-7', tenant: 't2'});
  assert(other.status === 201 && other.json().job_id !== first.json().job_id, 'another tenant reusing the key gets its own job (keys are per tenant)');
}

export async function check_validate_before_create(ctx) {
  const c = api(ctx);
  const touched = ctx.redisAfter('distill:idem:t1:k-bad', () => ctx.redis.keys('distill:*').sort());
  let r = await post(c, {...GOOD, sample_cap: 5}, {key: 'k-bad'});
  assert.equal(r.status, 400, \`sample_cap=5 answered \${r.status}, expected 400\`);
  assert(!touched.fired, \`a rejected start touched the job store (keys at that moment: \${JSON.stringify(touched.result)}): validate before store.put, so nothing has to be unwound\`);
  assert.deepEqual(ctx.redis.keys('distill:*'), [], \`a rejected start must leave nothing in Redis, found \${JSON.stringify(ctx.redis.keys('distill:*'))}\`);
  r = await post(c, {...GOOD, teacher: 'gpt-5-max'}, {key: 'k-bad'});
  assert(r.status === 400 && ctx.redis.keys('distill:*').length === 0, 'a refused teacher must leave nothing in Redis either');
}
`,
    go: `package main

import (
	"net/http"

	"leetbuild/harness"
)

var apiGood = map[string]any{"teacher": "teach-70b-v3", "dataset_id": "ds-support-2026", "sample_cap": 1000}

func apiClient(ctx *harness.Ctx) *harness.HTTP {
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

func apiWith(body map[string]any, overrides map[string]any) map[string]any {
	out := map[string]any{}
	for k, v := range body {
		out[k] = v
	}
	for k, v := range overrides {
		out[k] = v
	}
	return out
}

func apiPost(c *harness.HTTP, body map[string]any, key, tenant string) *harness.Response {
	return c.Post("/v1/distill/jobs", body, "X-Tenant-Id", tenant, "Idempotency-Key", key)
}

func apiJob(ctx *harness.Ctx, r *harness.Response) map[string]any {
	job, ok := r.JSON().(map[string]any)
	ctx.Assert(ok, "the body must be a JSON object: %s", r.Text())
	return job
}

func CheckRoute(ctx *harness.Ctx) {
	c := apiClient(ctx)
	r := apiPost(c, apiGood, "k-1", "t1")
	ctx.Equal(r.Status, 201, "a valid start (%s)", r.Text())
	job := apiJob(ctx, r)
	for _, key := range []string{"job_id", "status", "teacher", "dataset_id", "sample_cap", "sampled", "accepted", "rejected"} {
		_, ok := job[key]
		ctx.Assert(ok, "the 201 body lacks %s: %s", key, r.Text())
	}
	ctx.Assert(job["status"] == "queued" && job["teacher"] == "teach-70b-v3" && job["dataset_id"] == "ds-support-2026" && job["sample_cap"] == float64(1000), "the job echoes the request with status queued: %s", r.Text())
	ctx.Assert(job["sampled"] == float64(0) && job["accepted"] == float64(0) && job["rejected"] == float64(0), "a new job has zero counters: %s", r.Text())
	id, _ := job["job_id"].(string)
	ctx.Assert(id != "", "the job needs a job_id")
	_, stored := ctx.Redis.Get("distill:job:" + id)
	ctx.Assert(stored, "the job %s must be in the job store (distill:job:{id}): keys %v", id, ctx.Redis.Keys("distill:*"))
	noTenant := c.Post("/v1/distill/jobs", apiGood, "Idempotency-Key", "k-1")
	ctx.Equal(noTenant.Status, 401, "without X-Tenant-Id the start")
}

func CheckApprovedTeacher(ctx *harness.Ctx) {
	c := apiClient(ctx)
	r := apiPost(c, apiWith(apiGood, map[string]any{"teacher": "gpt-5-max"}), "k-bad", "t1")
	ctx.Equal(r.Status, 400, "a teacher outside the catalog (gpt-5-max): the caller must not pick the model that spends the budget")
	ctx.Equal(len(ctx.Redis.Keys("distill:job:*")), 0, "a refused start must store no job; jobs stored")
	r = apiPost(c, apiWith(apiGood, map[string]any{"teacher": "teach-13b-v2"}), "k-ok", "t1")
	ctx.Equal(r.Status, 201, "teach-13b-v2 is in the catalog (%s)", r.Text())
}

func CheckSampleCap(ctx *harness.Ctx) {
	c := apiClient(ctx)
	for _, cap := range []int{99, 10001, 0, -5} {
		r := apiPost(c, apiWith(apiGood, map[string]any{"sample_cap": cap}), "k-cap", "t1")
		ctx.Equal(r.Status, 400, "sample_cap=%d (the cap is the job's budget: 100..10000)", cap)
	}
	ctx.Equal(len(ctx.Redis.Keys("distill:job:*")), 0, "refused caps must store no job; jobs stored")
	for _, cap := range []int{100, 10000} {
		r := apiPost(c, apiWith(apiGood, map[string]any{"sample_cap": cap}), "k-"+harness.Show(cap), "t1")
		ctx.Equal(r.Status, 201, "sample_cap=%d is within 100..10000 inclusive (%s)", cap, r.Text())
	}
}

func CheckIdempotencyKey(ctx *harness.Ctx) {
	c := apiClient(ctx)
	noKey := c.Post("/v1/distill/jobs", apiGood, "X-Tenant-Id", "t1")
	ctx.Equal(noKey.Status, 400, "a start without Idempotency-Key")
	first := apiPost(c, apiGood, "k-7", "t1")
	ctx.Equal(first.Status, 201, "the first start (%s)", first.Text())
	replay := apiPost(c, apiGood, "k-7", "t1")
	ctx.Equal(replay.Status, 200, "a replay of the same (tenant, Idempotency-Key) must answer the stored job (the client retried; it must not get a second job)")
	ctx.Equal(apiJob(ctx, replay)["job_id"], apiJob(ctx, first)["job_id"], "the replay must resume the same job")
	ctx.Equal(len(ctx.Redis.Keys("distill:job:*")), 1, "one key, one job: jobs stored after a start and its replay")
	other := apiPost(c, apiGood, "k-7", "t2")
	ctx.Assert(other.Status == 201 && apiJob(ctx, other)["job_id"] != apiJob(ctx, first)["job_id"], "another tenant reusing the key gets its own job (keys are per tenant)")
}

func CheckValidateBeforeCreate(ctx *harness.Ctx) {
	c := apiClient(ctx)
	touched := false
	ctx.Redis.After("distill:idem:t1:k-bad", func() any {
		touched = true
		return ctx.Redis.Keys("distill:*")
	})
	r := apiPost(c, apiWith(apiGood, map[string]any{"sample_cap": 5}), "k-bad", "t1")
	ctx.Equal(r.Status, 400, "sample_cap=5")
	ctx.Assert(!touched, "a rejected start touched the job store: validate before jobs.Put, so nothing has to be unwound")
	ctx.Equal(len(ctx.Redis.Keys("distill:*")), 0, "a rejected start must leave nothing in Redis; keys")
	r = apiPost(c, apiWith(apiGood, map[string]any{"teacher": "gpt-5-max"}), "k-bad", "t1")
	ctx.Assert(r.Status == 400 && len(ctx.Redis.Keys("distill:*")) == 0, "a refused teacher must leave nothing in Redis either")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <string>
#include <vector>

namespace {

using json = nlohmann::json;

const json kGood = {{"teacher", "teach-70b-v3"}, {"dataset_id", "ds-support-2026"}, {"sample_cap", 1000}};

struct Api {
  httplib::Server svr;
  harness::HTTP http;
  explicit Api(harness::Ctx& ctx) : http(ctx.HTTP(svr)) { register_routes(svr); }

  harness::Response post(const json& body, const std::string& key = "k-1", const std::string& tenant = "t1") {
    return http.Post("/v1/distill/jobs", body.dump(), "X-Tenant-Id", tenant, "Idempotency-Key", key);
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
  const auto r = api.post(kGood);
  ctx.Equal(r.Status, 201, "a valid start (%s)", r.Text());
  const json job = jobOf(ctx, r);
  for (const char* key : {"job_id", "status", "teacher", "dataset_id", "sample_cap", "sampled", "accepted", "rejected"}) {
    ctx.Assert(job.contains(key), "the 201 body lacks %s: %s", key, r.Text());
  }
  ctx.Assert(job["status"] == "queued" && job["teacher"] == "teach-70b-v3" && job["dataset_id"] == "ds-support-2026" && job["sample_cap"] == 1000,
             "the job echoes the request with status queued: %s", r.Text());
  ctx.Assert(job["sampled"] == 0 && job["accepted"] == 0 && job["rejected"] == 0, "a new job has zero counters: %s", r.Text());
  const std::string id = job["job_id"].is_string() ? job["job_id"].get<std::string>() : "";
  ctx.Assert(!id.empty(), "the job needs a job_id");
  ctx.Assert(ctx.Redis.Get("distill:job:" + id).has_value(), "the job %s must be in the job store (distill:job:{id}): keys %v", id, ctx.Redis.Keys("distill:*"));
  const auto noTenant = api.http.Post("/v1/distill/jobs", kGood.dump(), "Idempotency-Key", "k-1");
  ctx.Equal(noTenant.Status, 401, "without X-Tenant-Id the start");
}

void CheckApprovedTeacher(harness::Ctx& ctx) {
  Api api(ctx);
  auto r = api.post(with(kGood, "teacher", "gpt-5-max"), "k-bad");
  ctx.Equal(r.Status, 400, "a teacher outside the catalog (gpt-5-max): the caller must not pick the model that spends the budget");
  ctx.Equal(ctx.Redis.Keys("distill:job:*").size(), 0, "a refused start must store no job; jobs stored");
  r = api.post(with(kGood, "teacher", "teach-13b-v2"), "k-ok");
  ctx.Equal(r.Status, 201, "teach-13b-v2 is in the catalog (%s)", r.Text());
}

void CheckSampleCap(harness::Ctx& ctx) {
  Api api(ctx);
  for (int cap : {99, 10001, 0, -5}) {
    const auto r = api.post(with(kGood, "sample_cap", cap), "k-cap");
    ctx.Equal(r.Status, 400, "sample_cap=%d (the cap is the job's budget: 100..10000)", cap);
  }
  ctx.Equal(ctx.Redis.Keys("distill:job:*").size(), 0, "refused caps must store no job; jobs stored");
  for (int cap : {100, 10000}) {
    const auto r = api.post(with(kGood, "sample_cap", cap), "k-" + std::to_string(cap));
    ctx.Equal(r.Status, 201, "sample_cap=%d is within 100..10000 inclusive (%s)", cap, r.Text());
  }
}

void CheckIdempotencyKey(harness::Ctx& ctx) {
  Api api(ctx);
  const auto noKey = api.http.Post("/v1/distill/jobs", kGood.dump(), "X-Tenant-Id", "t1");
  ctx.Equal(noKey.Status, 400, "a start without Idempotency-Key");
  const auto first = api.post(kGood, "k-7");
  ctx.Equal(first.Status, 201, "the first start (%s)", first.Text());
  const auto replay = api.post(kGood, "k-7");
  ctx.Equal(replay.Status, 200, "a replay of the same (tenant, Idempotency-Key) must answer the stored job (the client retried; it must not get a second job)");
  ctx.Equal(jobOf(ctx, replay)["job_id"], jobOf(ctx, first)["job_id"], "the replay must resume the same job");
  ctx.Equal(ctx.Redis.Keys("distill:job:*").size(), 1, "one key, one job: jobs stored after a start and its replay");
  const auto other = api.post(kGood, "k-7", "t2");
  ctx.Assert(other.Status == 201 && jobOf(ctx, other)["job_id"] != jobOf(ctx, first)["job_id"], "another tenant reusing the key gets its own job (keys are per tenant)");
}

void CheckValidateBeforeCreate(harness::Ctx& ctx) {
  Api api(ctx);
  bool touched = false;
  ctx.Redis.After("distill:idem:t1:k-bad", [&touched] { touched = true; });
  auto r = api.post(with(kGood, "sample_cap", 5), "k-bad");
  ctx.Equal(r.Status, 400, "sample_cap=5");
  ctx.Assert(!touched, "a rejected start touched the job store: validate before jobs::put, so nothing has to be unwound");
  ctx.Equal(ctx.Redis.Keys("distill:*").size(), 0, "a rejected start must leave nothing in Redis; keys");
  r = api.post(with(kGood, "teacher", "gpt-5-max"), "k-bad");
  ctx.Assert(r.Status == 400 && ctx.Redis.Keys("distill:*").empty(), "a refused teacher must leave nothing in Redis either");
}
`,
  },
  hints: [
    'Symptom: a client that retried a slow start sees two jobs over one dataset, and a request naming a model the platform does not run, or a cap of a million, is accepted as if it were fine.',
    'Mechanism: the starter stores the job under its own fresh job_id, so a replay of the same Idempotency-Key finds nothing; and it copies teacher and sample_cap from the body into the job without a catalog or a range.',
    'Change: guard clauses in order (tenant 401, Idempotency-Key 400, catalog 400, dataset 400, cap 100..10000), then `store.get(tenant, key)` and answer 200 on a hit; `store.put(tenant, key, job)` only after every guard.',
  ],
  debrief: `The fix is a trust boundary: the caller names a dataset and a size, the server picks the model from its catalog and bounds the budget, and the store key is something the client controls on purpose. Keying by \`(tenant, Idempotency-Key)\` is what makes a retry resume rather than duplicate, and it is per tenant because keys are chosen by clients, who collide. Validating before the write means a rejected request has nothing to unwind, which matters once a job start also seeds a budget and enqueues work. Production pipelines go further: a per-tenant cap on concurrent jobs, a dataset allow-list, and a quota reservation at start time so the bill is bounded before the first teacher call, not when it arrives.`,
};
