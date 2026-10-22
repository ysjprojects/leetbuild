import type {Step} from '@/lib/types';

export const endpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/jobs: enqueue with a dedupe key that means something',
  concept: 'http',
  file: 'api',
  focus: ['client', 'api', 'registry', 'redis'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it registers the route, mints a
job id and answers \`201 queued\`. It compiles, it serves the demo, and it hides three production
flaws. Review it like the owner of the queue, fix it, and prove the fix with the checks below.

Implement \`POST /v1/jobs\` with body \`{"type": "email.send", "payload": {"to": "…", "subject": "…"}}\`.

- The tenant comes from the authenticated \`X-Tenant-Id\` header; a missing tenant is **401**.
- \`type\` must be a key of the **job registry** — the map of job types to the payload schema each one
  accepts. Anything else is **400**, and the rejection happens **before** the dedupe reservation, the
  job row or any queue write: a type no worker knows is a job that is accepted and then skipped
  forever.
- \`payload\` is validated against the schema of *that* type. A missing field, a field of the wrong
  type, or a field the schema does not list is **422** with the offending path in the body:
  \`{"error": "invalid payload", "path": "amount_cents"}\`. The registry is **closed**: the fields a
  schema lists are exactly the fields the type accepts, in every language.
- \`Dedupe-Key\` is required (**400** when missing) and is reserved as
  \`SET jobs:dedupe:{tenant}:{key} <job_id> NX EX DEDUPE_WINDOW_S\` with \`DEDUPE_WINDOW_S = 86400\`
  **before** the job is enqueued. A replay inside the window answers **200** with the **original**
  job id and enqueues no second job; only the request that won the \`NX\` reservation may enqueue.
- The \`job_id\` is issued by the **API** (a fresh UUID) and the job row is written to the store
  **before** the response, so the id a client retries with is one the queue can actually find.
- Answer **201** with \`{"job_id", "state": "queued"}\`.
- Log the decision (job id, tenant, type) — the payload never appears in a log line.

**Failure mode the checks target.** The dedupe reservation is the one that costs money: the caller's
retry is not the queue's duplicate, so without the reservation a timed-out enqueue runs the same
side effect twice. The registry lookup is the one that loses work quietly: a typo in \`type\` is
accepted, a job row exists, and every worker skips a type it does not know — nothing errors and
nothing runs. The payload check is the one that moves a producer bug into the worker: an
unvalidated payload is only discovered after a worker has claimed the job, retried it five times and
dead-lettered it for a reason that was knowable at the door.`,
  sequence: {
    participants: ['Client', 'Job API', 'Job registry', 'Redis queue'],
    messages: [
      {from: 'Client', to: 'Job API', label: 'POST /v1/jobs · X-Tenant-Id · Dedupe-Key', kind: 'sync'},
      {from: 'Job API', to: 'Job registry', label: 'schema for the requested type', kind: 'sync'},
      {from: 'Job registry', to: 'Job API', label: 'schema / unknown type', kind: 'reply'},
      {from: 'Job API', to: 'Job API', label: 'validate payload · collect reject paths', kind: 'sync'},
      {from: 'Job API', to: 'Redis queue', label: 'SET jobs:dedupe:{tenant}:{key} job_id NX EX 86400', kind: 'sync'},
      {from: 'Redis queue', to: 'Job API', label: '1 reserved / 0 already reserved', kind: 'reply'},
      {from: 'Job API', to: 'Redis queue', label: 'RPUSH jobs:queue job_id · HSET jobs:job:{id}', kind: 'async'},
      {from: 'Job API', to: 'Client', label: '201 {job_id, state: queued} · 200 on a replay', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Handles POST /v1/jobs',
      detail: 'Register the enqueue route on `POST /v1/jobs`.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/jobs["']/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/jobs['"]/]},
        go: {all: [/HandleFunc\(\s*"POST \/v1\/jobs"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"jobs"\s*\)/, /\bpost\s*\{/]},
        cpp: {all: [/svr\.Post\(\s*"\/v1\/jobs"/]},
      },
    },
    {
      id: 'job-type',
      title: 'An unregistered job type is 400 before anything is enqueued',
      detail:
        'The type is looked up in the job registry and rejected with **400** before the dedupe reservation, the job row and the queue write. The draft accepts whatever it is given, so a typo produces a job no worker will ever run.',
      match: {
        python: {all: [/JOB_REGISTRY/, /status_code\s*=\s*400/], order: [/JOB_REGISTRY/, /\.enqueue\(/]},
        typescript: {all: [/JOB_REGISTRY/, /code\(400\)/], order: [/JOB_REGISTRY/, /enqueue\(/]},
        go: {all: [/jobRegistry/, /StatusBadRequest/], order: [/jobRegistry/, /\.Enqueue\(/]},
        scala: {all: [/JobRegistry/, /StatusCodes\.BadRequest/], order: [/JobRegistry/, /\.enqueue\(/]},
        cpp: {all: [/kJobRegistry/, /\b400\b/], order: [/kJobRegistry/, /queue\.enqueue\(/]},
      },
    },
    {
      id: 'payload-schema',
      title: 'A schema-invalid payload is 422 with the offending path',
      detail:
        'The payload is validated against the type’s schema and the first rejected path is returned: missing field, wrong type, or a field the closed schema does not list. The draft passes the payload straight through, so the failure surfaces in a worker after five attempts instead of at the door.',
      match: {
        python: {all: [/def validate_payload\(/, /status_code\s*=\s*422/, /['"]path['"]/]},
        typescript: {all: [/function validatePayload\(/, /code\(422\)/, /path:/]},
        go: {all: [/func validatePayload\(/, /StatusUnprocessableEntity/, /['"]path['"]/]},
        scala: {all: [/def validatePayload\(/, /StatusCodes\.UnprocessableEntity/, /['"]path['"]/]},
        cpp: {all: [/validatePayload\(/, /\b422\b/, /['"]path['"]/]},
      },
    },
    {
      id: 'dedupe-window',
      title: 'A replayed Dedupe-Key returns the original job id',
      detail:
        'The key is reserved with `SET jobs:dedupe:{tenant}:{key} <job_id> NX EX DEDUPE_WINDOW_S` (86 400 s) before the job is enqueued, and a replay reads the reserved id back and answers **200** with it instead of enqueueing a second job. The draft has no dedupe at all: a client retry runs the side effect twice.',
      match: {
        python: {all: [/DEDUPE_WINDOW_S/, /Dedupe-Key/, /reserve_dedupe\(/, /peek_dedupe\(/]},
        typescript: {all: [/DEDUPE_WINDOW_S/, /dedupe-key/, /reserveDedupe\(/, /peekDedupe\(/]},
        go: {all: [/dedupeWindowS/, /Dedupe-Key/, /ReserveDedupe\(/, /PeekDedupe\(/]},
        scala: {all: [/DedupeWindowS/, /Dedupe-Key/, /reserveDedupe\(/, /peekDedupe\(/]},
        cpp: {all: [/kDedupeWindowS/, /Dedupe-Key/, /reserveDedupe\(/, /peekDedupe\(/]},
      },
    },
    {
      id: 'durable-enqueue',
      title: 'The API issues the id, persists the job, and logs no payload',
      detail:
        'The job id is an API-issued UUID and the job row is written before the response, so a retry can find the job it was told about. The log line carries ids and the type, never the payload. The draft mints a counter id, stores nothing and logs the request.',
      match: {
        python: {all: [/uuid\.uuid4\(\)/, /store\.put\(/], none: [/logger\.\w+\([^)]*payload/]},
        typescript: {all: [/randomUUID\(\)/, /store\.put\(/], none: [/\.log\.\w+\([^)]*payload/]},
        go: {all: [/uuid\.NewString\(\)/, /store\.Put\(/], none: [/log\.\w+\([^)]*[Pp]ayload/]},
        scala: {all: [/UUID\.randomUUID\(\)/, /store\.put\(/], none: [/log\.info\([^)]*payload/]},
        cpp: {all: [/uuidString\(\)/, /store\.put\(/], none: [/cerr[^;]*payload/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import itertools
import logging

from fastapi import FastAPI, Header
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()
logger = logging.getLogger("jobqd")

job_counter = itertools.count(1)


class EnqueueRequest(BaseModel):
    type: str
    payload: dict = {}


class JobStore:
    def put(self, job: dict) -> None:
        """Persist the job row before the response."""
        raise NotImplementedError


class JobQueue:
    def enqueue(self, job: dict) -> None:
        """Push the job id onto the Redis queue."""
        raise NotImplementedError


store = JobStore()
queue = JobQueue()


@app.post("/v1/jobs")
def enqueue(body: EnqueueRequest, tenant: str = Header(alias="X-Tenant-Id")) -> JSONResponse:
    # TODO: this draft accepts any job type (so a worker silently skips an unknown one), passes the
    # payload through unvalidated, and has no dedupe key, so a retried enqueue runs the job twice.
    # Review all three before a job is allowed to reach a worker.
    job_id = f"job-{next(job_counter)}"
    logger.info("job enqueued job_id=%s tenant=%s type=%s", job_id, tenant, body.type)
    queue.enqueue({"job_id": job_id, "type": body.type, "payload": body.payload})
    return JSONResponse({"job_id": job_id, "state": "queued"}, status_code=201)
`,
      solution: `import logging
import uuid

from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()
logger = logging.getLogger("jobqd")

DEDUPE_WINDOW_S = 86400

# Job type -> payload schema. The registry is closed: a type accepts exactly these fields.
JOB_REGISTRY: dict[str, dict[str, type]] = {
    "email.send": {"to": str, "subject": str},
    "invoice.charge": {"account_id": str, "amount_cents": int, "currency": str},
    "report.build": {"report_id": str},
}


class EnqueueRequest(BaseModel):
    type: str
    payload: dict = {}


class JobStore:
    def put(self, job: dict) -> None:
        """Persist the job row before the response."""
        raise NotImplementedError


class JobQueue:
    def reserve_dedupe(self, tenant: str, dedupe_key: str, job_id: str, window_s: int) -> bool:
        """SET jobs:dedupe:{tenant}:{key} job_id NX EX window_s; True when this call won it."""
        raise NotImplementedError

    def peek_dedupe(self, tenant: str, dedupe_key: str) -> str | None:
        """The job id reserved under (tenant, key), if any."""
        raise NotImplementedError

    def enqueue(self, job: dict) -> None:
        """Push the job id onto the Redis queue."""
        raise NotImplementedError


store = JobStore()
queue = JobQueue()


def validate_payload(job_type: str, payload: dict) -> list[str]:
    """Every payload path the type's schema rejects: missing, wrong type, or not in the schema."""
    schema = JOB_REGISTRY[job_type]
    rejected: list[str] = []
    for field, expected in schema.items():
        value = payload.get(field)
        if expected is int:
            ok = isinstance(value, int) and not isinstance(value, bool)
        else:
            ok = isinstance(value, str) and value.strip() != ""
        if not ok:
            rejected.append(field)
    rejected.extend(field for field in payload if field not in schema)
    return sorted(rejected)


@app.post("/v1/jobs")
def enqueue(
    body: EnqueueRequest,
    tenant: str | None = Header(default=None, alias="X-Tenant-Id"),
    dedupe_key: str | None = Header(default=None, alias="Dedupe-Key"),
) -> JSONResponse:
    if tenant is None or tenant == "":
        raise HTTPException(status_code=401, detail="missing X-Tenant-Id")
    if dedupe_key is None or dedupe_key == "":
        raise HTTPException(status_code=400, detail="Dedupe-Key is required")
    if body.type not in JOB_REGISTRY:
        raise HTTPException(status_code=400, detail=f"unknown job type {body.type}")
    rejected = validate_payload(body.type, body.payload)
    if rejected:
        raise HTTPException(status_code=422, detail={"error": "invalid payload", "path": rejected[0]})

    reserved = queue.peek_dedupe(tenant, dedupe_key)
    if reserved is not None:
        return JSONResponse({"job_id": reserved, "state": "queued"}, status_code=200)

    job_id = str(uuid.uuid4())
    if not queue.reserve_dedupe(tenant, dedupe_key, job_id, DEDUPE_WINDOW_S):
        raise HTTPException(status_code=409, detail="duplicate enqueue in flight")

    job = {
        "job_id": job_id,
        "tenant": tenant,
        "type": body.type,
        "payload": body.payload,
        "state": "queued",
        "attempts": 0,
    }
    store.put(job)
    queue.enqueue(job)
    logger.info("job enqueued job_id=%s tenant=%s type=%s", job_id, tenant, body.type)
    return JSONResponse({"job_id": job_id, "state": "queued"}, status_code=201)
`,
    },
    typescript: {
      starter: `/** POST /v1/jobs: a model-generated draft that queues whatever it is handed. */
import Fastify from 'fastify';

export const app = Fastify();

let jobCounter = 0;

interface EnqueueBody {
  type: string;
  payload?: Record<string, unknown>;
}

const queue = {
  async enqueue(job: Record<string, unknown>): Promise<void> {},
};

app.post('/v1/jobs', async (request, reply) => {
  // TODO: this draft accepts any job type (so a worker silently skips an unknown one), passes the
  // payload through unvalidated, and has no dedupe key, so a retried enqueue runs the job twice.
  // Review all three before a job is allowed to reach a worker.
  const tenant = request.headers['x-tenant-id'] as string;
  const body = request.body as EnqueueBody;
  const jobId = \`job-\${++jobCounter}\`;
  request.log.info({tenant, type: body.type}, 'job enqueued');
  await queue.enqueue({job_id: jobId, type: body.type, payload: body.payload ?? {}});
  return reply.code(201).send({job_id: jobId, state: 'queued'});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** POST /v1/jobs: registry-checked, schema-validated, deduped enqueue. */
import {randomUUID} from 'node:crypto';

import Fastify from 'fastify';

import {queue, store} from './store';

export const app = Fastify();

const DEDUPE_WINDOW_S = 86400;

type FieldKind = 'string' | 'integer';

/** Job type -> payload schema. The registry is closed: a type accepts exactly these fields. */
const JOB_REGISTRY: Record<string, Record<string, FieldKind>> = {
  'email.send': {to: 'string', subject: 'string'},
  'invoice.charge': {account_id: 'string', amount_cents: 'integer', currency: 'string'},
  'report.build': {report_id: 'string'},
};

interface EnqueueBody {
  type: string;
  payload?: Record<string, unknown>;
}

/** Every payload path the type's schema rejects: missing, wrong type, or not in the schema. */
function validatePayload(jobType: string, payload: Record<string, unknown>): string[] {
  const schema = JOB_REGISTRY[jobType];
  const rejected: string[] = [];
  for (const [field, expected] of Object.entries(schema)) {
    const value = payload[field];
    const ok = expected === 'string' ? typeof value === 'string' && value.trim() !== '' : Number.isInteger(value);
    if (!ok) rejected.push(field);
  }
  for (const field of Object.keys(payload)) if (!(field in schema)) rejected.push(field);
  return rejected.sort();
}

app.post('/v1/jobs', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing X-Tenant-Id'});
  const dedupeKey = request.headers['dedupe-key'];
  if (typeof dedupeKey !== 'string' || dedupeKey === '')
    return reply.code(400).send({error: 'Dedupe-Key is required'});

  const body = request.body as Partial<EnqueueBody> | null;
  if (body === null || typeof body !== 'object' || typeof body.type !== 'string' || !(body.type in JOB_REGISTRY))
    return reply.code(400).send({error: 'unknown job type'});
  const payload = body.payload ?? {};
  if (typeof payload !== 'object' || Array.isArray(payload))
    return reply.code(422).send({error: 'invalid payload', path: 'payload'});
  const rejected = validatePayload(body.type, payload as Record<string, unknown>);
  if (rejected.length > 0) return reply.code(422).send({error: 'invalid payload', path: rejected[0]});

  const reserved: string | null = await queue.peekDedupe(tenant, dedupeKey);
  if (reserved !== null) return reply.code(200).send({job_id: reserved, state: 'queued'});

  const jobId = randomUUID();
  if (!(await queue.reserveDedupe(tenant, dedupeKey, jobId, DEDUPE_WINDOW_S)))
    return reply.code(409).send({error: 'duplicate enqueue in flight'});

  const job = {job_id: jobId, tenant, type: body.type, payload, state: 'queued', attempts: 0};
  await store.put(job);
  await queue.enqueue(job);
  request.log.info({job_id: jobId, tenant, type: body.type}, 'job enqueued');
  return reply.code(201).send({job_id: jobId, state: 'queued'});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"sync/atomic"
)

var jobCounter atomic.Int64

type EnqueueRequest struct {
	Type    string         \`json:"type"\`
	Payload map[string]any \`json:"payload"\`
}

type JobQueue struct{}

func (q *JobQueue) Enqueue(ctx context.Context, job map[string]any) error { return nil }

var queue = &JobQueue{}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func enqueue(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	var body EnqueueRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	// TODO: this draft accepts any job type (so a worker silently skips an unknown one), passes the
	// payload through unvalidated, and has no dedupe key, so a retried enqueue runs the job twice.
	// Review all three before a job is allowed to reach a worker.
	jobID := fmt.Sprintf("job-%d", jobCounter.Add(1))
	log.Printf("job enqueued job_id=%s tenant=%s type=%s", jobID, tenant, body.Type)
	queue.Enqueue(r.Context(), map[string]any{"job_id": jobID, "type": body.Type, "payload": body.Payload})
	writeJSON(rw, http.StatusCreated, map[string]any{"job_id": jobID, "state": "queued"})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/jobs", enqueue)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"sort"

	"github.com/google/uuid"
)

const dedupeWindowS = 86400

type fieldKind string

const (
	fieldString  fieldKind = "string"
	fieldInteger fieldKind = "integer"
)

// Job type -> payload schema. The registry is closed: a type accepts exactly these fields.
var jobRegistry = map[string]map[string]fieldKind{
	"email.send":     {"to": fieldString, "subject": fieldString},
	"invoice.charge": {"account_id": fieldString, "amount_cents": fieldInteger, "currency": fieldString},
	"report.build":   {"report_id": fieldString},
}

type EnqueueRequest struct {
	Type    string         \`json:"type"\`
	Payload map[string]any \`json:"payload"\`
}

type JobStore interface {
	Put(ctx context.Context, job map[string]any) error
}

type JobQueue interface {
	ReserveDedupe(ctx context.Context, tenant, dedupeKey, jobID string, windowS int) (bool, error)
	PeekDedupe(ctx context.Context, tenant, dedupeKey string) (string, error)
	Enqueue(ctx context.Context, job map[string]any) error
}

var store JobStore
var queue JobQueue

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

// validatePayload returns every payload path the type's schema rejects: missing, wrong type, or
// not in the schema.
func validatePayload(jobType string, payload map[string]any) []string {
	schema := jobRegistry[jobType]
	rejected := make([]string, 0, len(schema))
	for field, kind := range schema {
		value, present := payload[field]
		ok := false
		switch kind {
		case fieldString:
			text, isText := value.(string)
			ok = present && isText && text != ""
		case fieldInteger:
			_, isNumber := value.(float64)
			ok = present && isNumber
		}
		if !ok {
			rejected = append(rejected, field)
		}
	}
	for field := range payload {
		if _, known := schema[field]; !known {
			rejected = append(rejected, field)
		}
	}
	sort.Strings(rejected)
	return rejected
}

func enqueue(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-Tenant-Id"})
		return
	}
	dedupeKey := r.Header.Get("Dedupe-Key")
	if dedupeKey == "" {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "Dedupe-Key is required"})
		return
	}
	var body EnqueueRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	if _, known := jobRegistry[body.Type]; !known {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "unknown job type"})
		return
	}
	if rejected := validatePayload(body.Type, body.Payload); len(rejected) > 0 {
		writeJSON(rw, http.StatusUnprocessableEntity,
			map[string]string{"error": "invalid payload", "path": rejected[0]})
		return
	}
	reserved, err := queue.PeekDedupe(r.Context(), tenant, dedupeKey)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	if reserved != "" {
		writeJSON(rw, http.StatusOK, map[string]any{"job_id": reserved, "state": "queued"})
		return
	}
	jobID := uuid.NewString()
	won, err := queue.ReserveDedupe(r.Context(), tenant, dedupeKey, jobID, dedupeWindowS)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	if !won {
		writeJSON(rw, http.StatusConflict, map[string]string{"error": "duplicate enqueue in flight"})
		return
	}
	job := map[string]any{
		"job_id":   jobID,
		"tenant":   tenant,
		"type":     body.Type,
		"payload":  body.Payload,
		"state":    "queued",
		"attempts": 0,
	}
	if err := store.Put(r.Context(), job); err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	if err := queue.Enqueue(r.Context(), job); err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	log.Printf("job enqueued job_id=%s tenant=%s type=%s", jobID, tenant, body.Type)
	writeJSON(rw, http.StatusCreated, map[string]any{"job_id": jobID, "state": "queued"})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/jobs", enqueue)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

object JobApi {
  implicit val system: ActorSystem = ActorSystem("jobqd")

  private val jobCounter = new java.util.concurrent.atomic.AtomicLong(0)

  val route: Route =
    path("v1" / "jobs") {
      post {
        headerValueByName("X-Tenant-Id") { tenant =>
          entity(as[String]) { raw =>
            val body = raw.parseJson.asJsObject
            // TODO: this draft accepts any job type (so a worker silently skips an unknown one),
            // passes the payload through unvalidated, and has no dedupe key, so a retried enqueue
            // runs the job twice. Review all three before a job is allowed to reach a worker.
            val jobType = body.fields.get("type").collect { case JsString(value) => value }.getOrElse("")
            val jobId = s"job-\${jobCounter.incrementAndGet()}"
            system.log.info(s"job enqueued job_id=$jobId tenant=$tenant type=$jobType")
            complete(StatusCodes.Created, s"""{"job_id":"$jobId","state":"queued"}""")
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
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

final case class Job(job_id: String, tenant: String, job_type: String, payload: JsObject, state: String, attempts: Int)

object JobApi {
  implicit val system: ActorSystem = ActorSystem("jobqd")

  val DedupeWindowS = 86400

  /** Job type -> payload schema. The registry is closed: a type accepts exactly these fields. */
  val JobRegistry: Map[String, Map[String, String]] = Map(
    "email.send" -> Map("to" -> "string", "subject" -> "string"),
    "invoice.charge" -> Map("account_id" -> "string", "amount_cents" -> "integer", "currency" -> "string"),
    "report.build" -> Map("report_id" -> "string")
  )

  val store = JobStore.open()
  val queue = JobQueue.open()

  /** Every payload path the type's schema rejects: missing, wrong type, or not in the schema. */
  def validatePayload(jobType: String, payload: Map[String, JsValue]): List[String] = {
    val schema = JobRegistry.getOrElse(jobType, Map.empty[String, String])
    val missing = schema.toList.collect {
      case (field, "string") if !payload.get(field).exists(v => v.isInstanceOf[JsString] && v != JsString("")) =>
        field
      case (field, "integer") if !payload.get(field).exists(_.isInstanceOf[JsNumber]) => field
    }
    (missing ++ payload.keys.filterNot(schema.contains)).sorted
  }

  val route: Route =
    path("v1" / "jobs") {
      post {
        optionalHeaderValueByName("X-Tenant-Id") { tenantOpt =>
          optionalHeaderValueByName("Dedupe-Key") { dedupeOpt =>
            entity(as[String]) { raw =>
              val body = raw.parseJson.asJsObject
              val jobType = body.fields.get("type").collect { case JsString(value) => value }.getOrElse("")
              if (!tenantOpt.exists(_.nonEmpty)) {
                complete(StatusCodes.Unauthorized, """{"error":"missing X-Tenant-Id"}""")
              } else if (!dedupeOpt.exists(_.nonEmpty)) {
                complete(StatusCodes.BadRequest, """{"error":"Dedupe-Key is required"}""")
              } else if (!JobRegistry.contains(jobType)) {
                complete(StatusCodes.BadRequest, """{"error":"unknown job type"}""")
              } else {
                val payload = body.fields.get("payload").collect { case obj: JsObject => obj.fields } getOrElse Map.empty
                val rejected = validatePayload(jobType, payload)
                if (rejected.nonEmpty) {
                  complete(StatusCodes.UnprocessableEntity, s"""{"error":"invalid payload","path":"\${rejected.head}"}""")
                } else {
                  val tenant = tenantOpt.get
                  val dedupeKey = dedupeOpt.get
                  queue.peekDedupe(tenant, dedupeKey) match {
                    case Some(reserved) =>
                      complete(StatusCodes.OK, s"""{"job_id":"$reserved","state":"queued"}""")
                    case None =>
                      val jobId = UUID.randomUUID().toString
                      if (!queue.reserveDedupe(tenant, dedupeKey, jobId, DedupeWindowS)) {
                        complete(StatusCodes.Conflict, """{"error":"duplicate enqueue in flight"}""")
                      } else {
                        val job = Job(jobId, tenant, jobType, JsObject(payload), "queued", 0)
                        store.put(job)
                        queue.enqueue(job)
                        system.log.info(s"job enqueued job_id=$jobId tenant=$tenant type=$jobType")
                        complete(StatusCodes.Created, s"""{"job_id":"$jobId","state":"queued"}""")
                      }
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

#include <iostream>
#include <string>

using json = nlohmann::json;

struct JobStore {
  void put(const json& job);
};

JobStore store;
int jobCounter = 0;

int main() {
  httplib::Server svr;

  svr.Post("/v1/jobs", [](const httplib::Request& req, httplib::Response& res) {
    const auto tenant = req.get_header_value("X-Tenant-Id");
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) {
      res.status = 400;
      res.set_content(R"({"error":"invalid json"})", "application/json");
      return;
    }
    // TODO: this draft accepts any job type (so a worker silently skips an unknown one), passes the
    // payload through unvalidated, and has no dedupe key, so a retried enqueue runs the job twice.
    // Review all three before a job is allowed to reach a worker.
    const auto jobId = "job-" + std::to_string(++jobCounter);
    const auto jobType = body.value("type", std::string());
    std::cerr << "job enqueued job_id=" << jobId << " tenant=" << tenant << " type=" << jobType << "\\n";
    store.put(json{{"job_id", jobId}, {"type", jobType}});
    res.status = 201;
    res.set_content(json{{"job_id", jobId}, {"state", "queued"}}.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <algorithm>
#include <iostream>
#include <map>
#include <string>
#include <vector>

using json = nlohmann::json;

constexpr int kDedupeWindowS = 86400;

// Job type -> payload schema. The registry is closed: a type accepts exactly these fields.
const std::map<std::string, std::map<std::string, std::string>> kJobRegistry = {
    {"email.send", {{"to", "string"}, {"subject", "string"}}},
    {"invoice.charge", {{"account_id", "string"}, {"amount_cents", "integer"}, {"currency", "string"}}},
    {"report.build", {{"report_id", "string"}}},
};

struct JobStore {
  void put(const json& job);
};

struct JobQueue {
  bool reserveDedupe(const std::string& tenant, const std::string& dedupeKey, const std::string& jobId, int windowS);
  std::string peekDedupe(const std::string& tenant, const std::string& dedupeKey);
  void enqueue(const json& job);
};

JobStore store;
JobQueue queue;
std::string uuidString();

// Every payload path the type's schema rejects: missing, wrong type, or not in the schema.
std::vector<std::string> validatePayload(const std::string& jobType, const json& payload) {
  const auto schema = kJobRegistry.at(jobType);
  std::vector<std::string> rejected;
  for (const auto& [field, kind] : schema) {
    if (!payload.is_object() || !payload.contains(field)) {
      rejected.push_back(field);
      continue;
    }
    const auto& value = payload.at(field);
    const bool ok = kind == "string" ? value.is_string() && !value.get<std::string>().empty()
                                     : value.is_number_integer();
    if (!ok) rejected.push_back(field);
  }
  if (payload.is_object())
    for (const auto& [field, value] : payload.items())
      if (schema.count(field) == 0) rejected.push_back(field);
  std::sort(rejected.begin(), rejected.end());
  return rejected;
}

int main() {
  httplib::Server svr;

  svr.Post("/v1/jobs", [](const httplib::Request& req, httplib::Response& res) {
    const auto tenant = req.get_header_value("X-Tenant-Id");
    if (tenant.empty()) {
      res.status = 401;
      res.set_content(R"({"error":"missing X-Tenant-Id"})", "application/json");
      return;
    }
    const auto dedupeKey = req.get_header_value("Dedupe-Key");
    if (dedupeKey.empty()) {
      res.status = 400;
      res.set_content(R"({"error":"Dedupe-Key is required"})", "application/json");
      return;
    }
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object() || !body.contains("type")) {
      res.status = 400;
      res.set_content(R"({"error":"invalid json"})", "application/json");
      return;
    }
    const auto jobType = body.value("type", std::string());
    if (kJobRegistry.count(jobType) == 0) {
      res.status = 400;
      res.set_content(R"({"error":"unknown job type"})", "application/json");
      return;
    }
    const auto payload = body.contains("payload") ? body.at("payload") : json::object();
    const auto rejected = validatePayload(jobType, payload);
    if (!rejected.empty()) {
      res.status = 422;
      res.set_content(json{{"error", "invalid payload"}, {"path", rejected.front()}}.dump(), "application/json");
      return;
    }
    const auto reserved = queue.peekDedupe(tenant, dedupeKey);
    if (!reserved.empty()) {
      res.status = 200;
      res.set_content(json{{"job_id", reserved}, {"state", "queued"}}.dump(), "application/json");
      return;
    }
    const auto jobId = uuidString();
    if (!queue.reserveDedupe(tenant, dedupeKey, jobId, kDedupeWindowS)) {
      res.status = 409;
      res.set_content(R"({"error":"duplicate enqueue in flight"})", "application/json");
      return;
    }
    const json job = {
        {"job_id", jobId},
        {"tenant", tenant},
        {"type", jobType},
        {"payload", payload},
        {"state", "queued"},
        {"attempts", 0},
    };
    store.put(job);
    queue.enqueue(job);
    std::cerr << "job enqueued job_id=" << jobId << " tenant=" << tenant << " type=" << jobType << "\\n";
    res.status = 201;
    res.set_content(json{{"job_id", jobId}, {"state", "queued"}}.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  hints: [
    'Order the guard clauses by cost: tenant, `Dedupe-Key`, then the registry lookup, then the payload schema. Every one of them answers before `store.put` and `queue.enqueue`, so a rejected submission never reserves a dedupe key or occupies a queue position.',
    'The dedupe reservation must be one command: `SET jobs:dedupe:{tenant}:{key} <job_id> NX EX DEDUPE_WINDOW_S`. `NX` is what makes concurrent enqueues of the same key pick exactly one winner; the expiry is the documented window, so the key is a suppression window and not a permanent lock.',
    'The payload schema is closed and the rejection names a path, not the payload: `{"error": "invalid payload", "path": "amount_cents"}`. Return the path so the caller can fix the producer, and keep the payload out of the response and out of the log line.',
  ],
  debrief: `The interviewer is testing whether you can review a generated handler at the admission boundary of
a queue. The draft reads fine because the demo posts one valid job from one tenant and never retries.
Three defects are being checked: the registry lookup that keeps an unknown type from becoming a job
no worker will ever run, the schema validation that turns a producer bug into a 422 at the door
instead of five failed attempts in a worker, and the dedupe reservation that makes a client retry
idempotent — the caller's retry is *not* the queue's duplicate. The fourth habit is the durable id:
the API issues it and writes the job row before it answers, so the id it hands out is one the queue
can actually find. Real queues add per-tenant quotas, a DLQ for schema-violating producers, payload
size caps, and a dedupe key scoped to the tenant so one tenant's key can never suppress another's
job.`,
};
