import type {Step} from '@/lib/types';

export const endpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/distill/jobs: a job with a real budget',
  concept: 'http',
  file: 'api',
  focus: ['client', 'api', 'db'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it registers the route, parses
the body and returns a job. It compiles, it serves the demo, and it hides three production flaws.
Review it like the pipeline owner, fix it, and prove the fix with the checks below.

Implement \`POST /v1/distill/jobs\` with body \`{"teacher": "teach-70b-v3", "dataset_id": "…",
"sample_cap": 1000}\`.

- The tenant comes from the authenticated \`X-Tenant-Id\` header; a missing tenant is **401**.
- \`teacher\` is checked against the **server-side approved catalog** (say \`teach-70b-v3\` and
  \`teach-13b-v2\`); anything else — including a provider model string the caller made up — is
  **400**. The caller never names the model that will burn the budget.
- \`dataset_id\` is a non-empty string (**400** otherwise).
- \`sample_cap\` is an integer from **100** to **10000** inclusive (**400** otherwise). The cap is
  the job's token budget: an uncapped job is an uncapped bill.
- \`Idempotency-Key\` is required (**400** when missing). A replay of \`(tenant, key)\` **resumes the
  same job** — same \`job_id\`, status \`queued\` — instead of starting a second one.
- Every validation happens **before the job is stored**: a rejected request must not leave a job row
  or enqueue any sampling work.
- The response is **201** with \`{job_id, status, teacher, dataset_id, sample_cap, sampled,
  accepted, rejected}\`; a resumed job answers **200** with the stored job.

**Failure mode the checks target.** A free-form \`teacher\` lets a caller spend the pipeline's budget
on a model the platform never approved, and the missing cap turns "a quick run" into a week of
teacher tokens. The un-keyed start endpoint is the quiet one: every client retry — and every
gateway retry after a timeout — starts another job over the same dataset.`,
  sequence: {
    participants: ['Client', 'Distill API', 'job store'],
    messages: [
      {from: 'Client', to: 'Distill API', label: 'POST /v1/distill/jobs · X-Tenant-Id · Idempotency-Key', kind: 'sync'},
      {from: 'Distill API', to: 'Distill API', label: 'validate tenant · teacher · cap', kind: 'sync'},
      {from: 'Distill API', to: 'job store', label: 'get(tenant, idem_key)', kind: 'sync'},
      {from: 'job store', to: 'Distill API', label: 'stored job / none', kind: 'reply'},
      {from: 'Distill API', to: 'job store', label: 'put(tenant, idem_key, job)', kind: 'async'},
      {from: 'Distill API', to: 'Client', label: '201 {job_id, status, sample_cap}', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Handles POST /v1/distill/jobs',
      detail: 'Register the start-a-job route on `POST /v1/distill/jobs`.',
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
        'The teacher is checked against a server-side catalog and anything else is **400**. The draft takes whatever string the caller sends as the model to spend the budget on.',
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
        '`sample_cap` is an integer in **100..10000** and anything else is **400** before any sampling: the cap is the job’s token budget. The draft accepts any cap, including a negative one.',
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
        '`Idempotency-Key` is required and the job is stored under `(tenant, key)`, so a replay resumes the same job instead of starting a second one. The draft ignores the header and starts a fresh job on every call.',
      match: {
        python: {all: [/Idempotency-Key/, /store\.get\(/, /store\.put\(/]},
        typescript: {all: [/idempotency-key/, /store\.get\(/, /store\.put\(/]},
        go: {all: [/Idempotency-Key/, /store\.Get\(/, /store\.Put\(/]},
        scala: {all: [/Idempotency-Key/, /store\.get\(/, /store\.put\(/]},
        cpp: {all: [/Idempotency-Key/, /store\.get\(/, /store\.put\(/]},
      },
    },
    {
      id: 'validate-before-create',
      title: 'Rejects before it creates or queues the job',
      detail:
        'The catalog and the cap are checked before the job row is written, so a rejected request cannot leave a job behind or enqueue sampling. The draft creates the job first and would have to unwind it.',
      match: {
        python: {order: [/MAX_SAMPLE_CAP/, /store\.put\(/]},
        typescript: {order: [/MAX_SAMPLE_CAP/, /store\.put\(/]},
        go: {order: [/maxSampleCap/, /store\.Put\(/]},
        scala: {order: [/MaxSampleCap/, /store\.put\(/]},
        cpp: {order: [/kMaxSampleCap/, /store\.put\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import logging

from fastapi import FastAPI, Header
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()
logger = logging.getLogger("distill")

JOBS: dict[str, dict] = {}


class JobRequest(BaseModel):
    teacher: str
    dataset_id: str
    sample_cap: int


@app.post("/v1/distill/jobs")
def start_job(body: JobRequest, tenant: str = Header(alias="X-Tenant-Id")) -> JSONResponse:
    # TODO: this draft trusts any teacher string the caller sends, accepts an unbounded sample_cap,
    # and has nothing keyed by the request, so every client retry starts another job. Review all three.
    job_id = f"job-{len(JOBS) + 1}"
    job = {
        "job_id": job_id,
        "status": "queued",
        "teacher": body.teacher,
        "dataset_id": body.dataset_id,
        "sample_cap": body.sample_cap,
        "sampled": 0,
        "accepted": 0,
        "rejected": 0,
    }
    JOBS[job_id] = job
    logger.info("distill job=%s teacher=%s cap=%d", job_id, body.teacher, body.sample_cap)
    return JSONResponse(job, status_code=201)
`,
      solution: `import logging
import uuid

from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()
logger = logging.getLogger("distill")

MIN_SAMPLE_CAP = 100
MAX_SAMPLE_CAP = 10_000
APPROVED_TEACHERS = {"teach-70b-v3", "teach-13b-v2"}


class JobRequest(BaseModel):
    teacher: str
    dataset_id: str
    sample_cap: int


class JobStore:
    def get(self, tenant: str, idem_key: str) -> dict | None:
        """The job stored for (tenant, idem_key), if any."""
        raise NotImplementedError

    def put(self, tenant: str, idem_key: str, job: dict) -> None:
        """Store the job under (tenant, idem_key) before a single sample is generated."""
        raise NotImplementedError


store = JobStore()


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
        raise HTTPException(
            status_code=400,
            detail=f"sample_cap must be {MIN_SAMPLE_CAP}..{MAX_SAMPLE_CAP}",
        )

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
    logger.info(
        "distill job=%s teacher=%s cap=%d dataset=%s",
        job["job_id"],
        job["teacher"],
        job["sample_cap"],
        job["dataset_id"],
    )
    return JSONResponse(job, status_code=201)
`,
    },
    typescript: {
      starter: `/** POST /v1/distill/jobs: a model-generated draft that trusts whatever the caller sends. */
import Fastify from 'fastify';

export const app = Fastify();

const JOBS: Record<string, unknown> = {};

interface JobBody {
  teacher: string;
  dataset_id: string;
  sample_cap: number;
}

app.post('/v1/distill/jobs', async (request, reply) => {
  // TODO: this draft trusts any teacher string the caller sends, accepts an unbounded sample_cap,
  // and has nothing keyed by the request, so every client retry starts another job. Review all three.
  const tenant = request.headers['x-tenant-id'] as string;
  const body = request.body as JobBody;
  const job = {
    job_id: \`job-\${Object.keys(JOBS).length + 1}\`,
    status: 'queued',
    teacher: body.teacher,
    dataset_id: body.dataset_id,
    sample_cap: body.sample_cap,
    sampled: 0,
    accepted: 0,
    rejected: 0,
  };
  JOBS[job.job_id] = job;
  request.log.info({tenant, teacher: body.teacher, cap: body.sample_cap}, 'job queued');
  return reply.code(201).send(job);
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** POST /v1/distill/jobs: an approved teacher, a bounded sample cap, and a replayable start. */
import {randomUUID} from 'node:crypto';

import Fastify from 'fastify';

export const app = Fastify();

const MIN_SAMPLE_CAP = 100;
const MAX_SAMPLE_CAP = 10_000;
const APPROVED_TEACHERS: Record<string, true> = {'teach-70b-v3': true, 'teach-13b-v2': true};

interface JobBody {
  teacher: string;
  dataset_id: string;
  sample_cap: number;
}

interface Job {
  job_id: string;
  status: string;
  teacher: string;
  dataset_id: string;
  sample_cap: number;
  sampled: number;
  accepted: number;
  rejected: number;
}

interface JobStore {
  get(tenant: string, idemKey: string): Promise<Job | null>;
  put(tenant: string, idemKey: string, job: Job): Promise<void>;
}

declare const store: JobStore;

app.post('/v1/distill/jobs', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing X-Tenant-Id'});
  const idemKey = request.headers['idempotency-key'];
  if (typeof idemKey !== 'string' || idemKey === '')
    return reply.code(400).send({error: 'Idempotency-Key is required'});

  const body = request.body as Partial<JobBody> | null;
  if (body === null || typeof body !== 'object' || typeof body.teacher !== 'string')
    return reply.code(400).send({error: 'teacher is required'});
  if (APPROVED_TEACHERS[body.teacher] !== true)
    return reply.code(400).send({error: 'teacher is not in the approved catalog'});
  if (typeof body.dataset_id !== 'string' || body.dataset_id === '')
    return reply.code(400).send({error: 'dataset_id is required'});
  const sampleCap = body.sample_cap;
  if (!Number.isInteger(sampleCap) || (sampleCap as number) < MIN_SAMPLE_CAP || (sampleCap as number) > MAX_SAMPLE_CAP)
    return reply.code(400).send({error: 'sample_cap must be ' + MIN_SAMPLE_CAP + '..' + MAX_SAMPLE_CAP});

  const stored = await store.get(tenant, idemKey);
  if (stored !== null) return reply.code(200).send(stored);

  const job: Job = {
    job_id: randomUUID(),
    status: 'queued',
    teacher: (body as JobBody).teacher,
    dataset_id: (body as JobBody).dataset_id,
    sample_cap: sampleCap as number,
    sampled: 0,
    accepted: 0,
    rejected: 0,
  };
  await store.put(tenant, idemKey, job);
  request.log.info({tenant, job_id: job.job_id, teacher: job.teacher, cap: job.sample_cap}, 'job queued');
  return reply.code(201).send(job);
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
	tenant := r.Header.Get("X-Tenant-Id")
	var body JobRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	// TODO: this draft trusts any teacher string the caller sends, accepts an unbounded sample_cap,
	// and has nothing keyed by the request, so every client retry starts another job. Review all three.
	job := map[string]any{
		"job_id":     "job-" + tenant,
		"status":     "queued",
		"teacher":    body.Teacher,
		"dataset_id": body.DatasetID,
		"sample_cap": body.SampleCap,
		"sampled":    0,
		"accepted":   0,
		"rejected":   0,
	}
	log.Printf("job queued tenant=%s teacher=%s cap=%d", tenant, body.Teacher, body.SampleCap)
	writeJSON(rw, http.StatusCreated, job)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/distill/jobs", startJob)
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

type Job struct {
	JobID     string \`json:"job_id"\`
	Status    string \`json:"status"\`
	Teacher   string \`json:"teacher"\`
	DatasetID string \`json:"dataset_id"\`
	SampleCap int    \`json:"sample_cap"\`
	Sampled   int    \`json:"sampled"\`
	Accepted  int    \`json:"accepted"\`
	Rejected  int    \`json:"rejected"\`
}

type JobStore struct{}

func (s *JobStore) Get(ctx context.Context, tenant, idemKey string) (*Job, error) {
	return nil, nil
}

func (s *JobStore) Put(ctx context.Context, tenant, idemKey string, job Job) error {
	return nil
}

var store = &JobStore{}

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

	stored, err := store.Get(r.Context(), tenant, idemKey)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	if stored != nil {
		writeJSON(rw, http.StatusOK, stored)
		return
	}

	job := Job{
		JobID:     uuid.NewString(),
		Status:    "queued",
		Teacher:   body.Teacher,
		DatasetID: body.DatasetID,
		SampleCap: body.SampleCap,
	}
	if err := store.Put(r.Context(), tenant, idemKey, job); err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	log.Printf("distill job=%s teacher=%s cap=%d dataset=%s", job.JobID, job.Teacher, job.SampleCap, job.DatasetID)
	writeJSON(rw, http.StatusCreated, job)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/distill/jobs", startJob)
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

final case class JobRequest(teacher: String, dataset_id: String, sample_cap: Int)
final case class Job(
    job_id: String,
    status: String,
    teacher: String,
    dataset_id: String,
    sample_cap: Int,
    sampled: Int,
    accepted: Int,
    rejected: Int
)

object DistillApi {
  implicit val system: ActorSystem = ActorSystem("distill-pipeline")
  implicit val jobFormat: RootJsonFormat[JobRequest] = jsonFormat3(JobRequest)

  var counter = 0

  val route: Route =
    path("v1" / "distill" / "jobs") {
      post {
        headerValueByName("X-Tenant-Id") { tenant =>
          entity(as[JobRequest]) { body =>
            // TODO: this draft trusts any teacher string the caller sends, accepts an unbounded
            // sample_cap, and has nothing keyed by the request, so every client retry starts
            // another job. Review all three.
            counter += 1
            val job = Job(s"job-$counter", "queued", body.teacher, body.dataset_id, body.sample_cap, 0, 0, 0)
            system.log.info(s"job queued tenant=$tenant teacher=\${body.teacher} cap=\${body.sample_cap}")
            complete(StatusCodes.Created, job)
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

final case class JobRequest(teacher: String, dataset_id: String, sample_cap: Int)
final case class Job(
    job_id: String,
    status: String,
    teacher: String,
    dataset_id: String,
    sample_cap: Int,
    sampled: Int,
    accepted: Int,
    rejected: Int
)

object DistillApi {
  implicit val system: ActorSystem = ActorSystem("distill-pipeline")
  implicit val jobFormat: RootJsonFormat[JobRequest] = jsonFormat3(JobRequest)

  val MinSampleCap = 100
  val MaxSampleCap = 10000
  val ApprovedTeachers = Set("teach-70b-v3", "teach-13b-v2")

  val store = JobStore.open()

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
                store.get(tenant, idemKey) match {
                  case Some(stored) =>
                    complete(StatusCodes.OK, stored)
                  case None =>
                    val job =
                      Job(UUID.randomUUID().toString, "queued", body.teacher, body.dataset_id, body.sample_cap, 0, 0, 0)
                    store.put(tenant, idemKey, job)
                    system.log.info(
                      s"distill job=\${job.job_id} teacher=\${job.teacher} cap=\${job.sample_cap} dataset=\${job.dataset_id}"
                    )
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

using json = nlohmann::json;

int jobCounter = 0;

int main() {
  httplib::Server svr;

  svr.Post("/v1/distill/jobs", [](const httplib::Request& req, httplib::Response& res) {
    const auto tenant = req.get_header_value("X-Tenant-Id");
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) {
      res.status = 400;
      res.set_content(R"({"error":"invalid json"})", "application/json");
      return;
    }
    // TODO: this draft trusts any teacher string the caller sends, accepts an unbounded sample_cap,
    // and has nothing keyed by the request, so every client retry starts another job. Review all three.
    jobCounter += 1;
    const json job = {
        {"job_id", "job-" + std::to_string(jobCounter)},
        {"status", "queued"},
        {"teacher", body.value("teacher", std::string())},
        {"dataset_id", body.value("dataset_id", std::string())},
        {"sample_cap", body.value("sample_cap", 0)},
        {"sampled", 0},
        {"accepted", 0},
        {"rejected", 0},
    };
    std::cerr << "job queued tenant=" << tenant << " cap=" << job["sample_cap"] << "\\n";
    res.status = 201;
    res.set_content(job.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <iostream>
#include <optional>
#include <set>
#include <string>

using json = nlohmann::json;

constexpr int kMinSampleCap = 100;
constexpr int kMaxSampleCap = 10000;
const std::set<std::string> kApprovedTeachers = {"teach-70b-v3", "teach-13b-v2"};

struct JobStore {
  std::optional<json> get(const std::string& tenant, const std::string& idemKey);
  void put(const std::string& tenant, const std::string& idemKey, const json& job);
};

JobStore store;
std::string uuidString();

int main() {
  httplib::Server svr;

  svr.Post("/v1/distill/jobs", [](const httplib::Request& req, httplib::Response& res) {
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
    if (!body.is_object() || !body.contains("teacher") || !body["teacher"].is_string()) {
      res.status = 400;
      res.set_content(R"({"error":"teacher is required"})", "application/json");
      return;
    }
    if (kApprovedTeachers.count(body["teacher"].get<std::string>()) == 0) {
      res.status = 400;
      res.set_content(R"({"error":"teacher is not in the approved catalog"})", "application/json");
      return;
    }
    if (!body.contains("dataset_id") || !body["dataset_id"].is_string() || body["dataset_id"].get<std::string>().empty()) {
      res.status = 400;
      res.set_content(R"({"error":"dataset_id is required"})", "application/json");
      return;
    }
    const int sampleCap = body.value("sample_cap", 0);
    if (sampleCap < kMinSampleCap || sampleCap > kMaxSampleCap) {
      res.status = 400;
      res.set_content(R"({"error":"sample_cap must be 100..10000"})", "application/json");
      return;
    }
    const auto stored = store.get(tenant, idemKey);
    if (stored) {
      res.status = 200;
      res.set_content(stored->dump(), "application/json");
      return;
    }
    const json job = {
        {"job_id", uuidString()},
        {"status", "queued"},
        {"teacher", body["teacher"]},
        {"dataset_id", body["dataset_id"]},
        {"sample_cap", sampleCap},
        {"sampled", 0},
        {"accepted", 0},
        {"rejected", 0},
    };
    store.put(tenant, idemKey, job);
    std::cerr << "distill job=" << job["job_id"] << " teacher=" << job["teacher"] << " cap=" << job["sample_cap"]
              << "\\n";
    res.status = 201;
    res.set_content(job.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  hints: [
    'Write the guard clauses first, in cost order: tenant, Idempotency-Key, teacher catalog, dataset id, cap. Each returns paired with its status, so a malformed request can never reach the point where a job row exists or a teacher token is spent.',
    'The catalog belongs to the pipeline, not to the caller: a set of approved teacher versions resolved server-side. Whatever string arrives, the job stores a version the platform approved — that is what keeps "point the pipeline at a random model" from being an API parameter.',
    'Idempotency for a job start is `(tenant, Idempotency-Key) → job_id`. Look the key up before you build anything, return the stored job on a hit, and write the job under the same key — that is what makes a client retry resume instead of double-sampling a dataset.',
  ],
  debrief: `The interviewer is testing whether you can review a generated handler at the trust boundary, where a distillation job is money. The draft reads fine because the demo sends one request from one tenant with a well-formed body and never retries. Three defects are being checked: the teacher catalog (the caller may name a dataset and a size, never a model), the sample cap (an uncapped job is an unbounded bill, and the rejection has to come before anything is created), and idempotency keyed by tenant (a retried start must resume the job, not start a twin over the same dataset). Real pipelines add per-tenant concurrency caps, a dataset allow-list, and a quota system that reserves budget before the call rather than when the bill arrives.`,
};
