import type {Step} from '@/lib/types';

export const endpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/synthetic/jobs: seeds must be licensed and versioned',
  concept: 'http',
  file: 'api',
  focus: ['client', 'synth', 'db'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it registers the route, reads
the recipe and starts generating. It compiles, it serves the demo, and it expands a seed nobody can
account for. Review it like the service owner, fix it, and prove the fix with the checks below.

Implement \`POST /v1/synthetic/jobs\` with body
\`{"seed_dataset": "wiki-dump", "seed_version": "2026-04-01", "recipe": "qa-pairs", "max_records": 1000}\`.

- The tenant comes from the authenticated \`X-Tenant-Id\` header; a missing tenant is **401**.
- \`Idempotency-Key\` is required (**400** when missing). A replay of the same \`(tenant, key)\`
  returns the stored job — the *same* job id and the same cap — instead of starting a second run.
- \`seed_dataset\` and \`seed_version\` are looked up in the **seed registry**. An unregistered
  dataset, or a version that was never published, is **422** — unprocessable, not unauthorized:
  the request is well formed, the seed just cannot be used.
- The seed's **license must permit derivative generation** (\`derivative_ok\` on the registered
  seed entry). A seed whose license forbids derivatives is **422**. This check runs
  **before any generation work is enqueued** — refusing after the job started leaves unlicensed
  derivatives on disk.
- \`max_records\` is an integer from **1** to \`MAX_RECORDS = 100000\` (**400** otherwise) and is
  part of the job the service creates: the cap is enforced by the service, not by the client
  stopping the stream.
- \`recipe\` is a non-empty string (**400** otherwise) and is stored on the job so record events can
  be keyed by it later.
- Log the job id, the seed dataset and the cap — never the seed content.

**Failure mode the checks target.** An unregistered seed means the corpus cannot be traced or
licensed at all, and the draft expands whatever file path or dataset name the caller sends. The
license flag is the subtle one: a dataset can be perfectly registered and still be *forbidden* to
derive from, so the registry lookup and the license decision are two different checks. The missing
cap is the expensive one — the draft keeps generating until the client disconnects, so one request
can produce an unbounded, unlicensed, unmeasured dataset.`,
  sequence: {
    participants: ['Data curator', 'Synthetic Data API', 'seed registry'],
    messages: [
      {
        from: 'Data curator',
        to: 'Synthetic Data API',
        label: 'POST /v1/synthetic/jobs · X-Tenant-Id · Idempotency-Key',
        kind: 'sync',
      },
      {from: 'Synthetic Data API', to: 'Synthetic Data API', label: 'validate tenant · cap · recipe', kind: 'sync'},
      {from: 'Synthetic Data API', to: 'seed registry', label: 'get(seed_dataset, seed_version)', kind: 'sync'},
      {from: 'seed registry', to: 'Synthetic Data API', label: 'seed row + license · or none → 422', kind: 'reply'},
      {from: 'Synthetic Data API', to: 'seed registry', label: 'derivative_ok? → 422 before generation', kind: 'sync'},
      {from: 'Synthetic Data API', to: 'seed registry', label: 'put(tenant, idem_key, job)', kind: 'async'},
      {from: 'Synthetic Data API', to: 'Data curator', label: '201 {job_id, max_records}', kind: 'reply'},
    ],
  },
  hints: [
    'Two different refusals: a missing tenant or a missing `Idempotency-Key` is the caller’s mistake (**400**/**401**), while a seed that exists but may not be derived from is **422**. Return the registry row on the miss path so the caller learns which field was wrong.',
    'Do the registry lookup and the license decision before you create the job or enqueue anything. The check is an `order` check — the code that reads `derivative_ok` has to sit above the call that starts generation, not below it.',
    'The cap is not a hint to the generator: put `max_records` on the stored job and let the worker stop at it. And key the idempotency store by `(tenant, idem_key)`, so a client retry returns the job that already exists instead of a second one against the same seed.',
  ],
  checks: [
    {
      id: 'route',
      title: 'Handles POST /v1/synthetic/jobs',
      detail: 'Register the submit route on `POST /v1/synthetic/jobs`.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/synthetic\/jobs["']/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/synthetic\/jobs['"]/]},
        go: {all: [/HandleFunc\(\s*"POST \/v1\/synthetic\/jobs"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"synthetic"\s*\/\s*"jobs"\s*\)/, /\bpost\s*\{/]},
        cpp: {all: [/svr\.Post\(\s*"\/v1\/synthetic\/jobs"/]},
      },
    },
    {
      id: 'licensed-seed',
      title: 'Refuses an unregistered seed or a no-derivatives license with 422',
      detail:
        'The seed dataset *and* version are resolved in `SEED_REGISTRY`, and its `derivative_ok` license flag is required; an unknown seed or a no-derivatives license is **422**. The draft expands whatever dataset name it is handed and never reads a license flag.',
      match: {
        python: {all: [/SEED_REGISTRY/, /derivative_ok/, /status_code\s*=\s*422/]},
        typescript: {all: [/seedRegistry/, /derivativeOk/, /code\(\s*422\s*\)/]},
        go: {all: [/seedRegistry/, /DerivativeOK/, /StatusUnprocessableEntity/]},
        scala: {all: [/SeedRegistry/, /DerivativeOk/, /StatusCodes\.UnprocessableEntity/]},
        cpp: {all: [/kSeedRegistry/, /derivative_ok/, /\b422\b/]},
      },
    },
    {
      id: 'record-cap',
      title: 'Enforces the service-side 1..100000 record cap',
      detail:
        '`max_records` must be an integer in `1..MAX_RECORDS` (**400** otherwise) and the accepted value is stored on the job, so the service stops at the cap instead of generating until the client disconnects. The draft has no cap at all.',
      match: {
        python: {all: [/MAX_RECORDS\s*=\s*100000/, /status_code\s*=\s*400/, /body\.max_records/]},
        typescript: {all: [/MAX_RECORDS\s*=\s*100000/, /code\(\s*400\s*\)/, /max_records/]},
        go: {all: [/maxRecords\s*=\s*100000/, /StatusBadRequest/, /MaxRecords/]},
        scala: {all: [/MaxRecords\s*=\s*100000/, /StatusCodes\.BadRequest/, /max_records/]},
        cpp: {all: [/kMaxRecords\s*=\s*100000/, /\b400\b/, /max_records/]},
      },
    },
    {
      id: 'idempotent-submit',
      title: 'Requires the tenant and Idempotency-Key, and resumes the stored job',
      detail:
        'A missing `X-Tenant-Id` is **401**, a missing `Idempotency-Key` is **400**, and the job is stored under `(tenant, key)` so a replay returns the job that already exists. The draft ignores both headers.',
      match: {
        python: {all: [/X-Tenant-Id/, /status_code\s*=\s*401/, /Idempotency-Key/, /store\.get\(/, /store\.put\(/]},
        typescript: {all: [/x-tenant-id/, /code\(\s*401\s*\)/, /idempotency-key/, /store\.get\(/, /store\.put\(/]},
        go: {all: [/X-Tenant-Id/, /StatusUnauthorized/, /Idempotency-Key/, /store\.Get\(/, /store\.Put\(/]},
        scala: {all: [/X-Tenant-Id/, /StatusCodes\.Unauthorized/, /Idempotency-Key/, /store\.get\(/, /store\.put\(/]},
        cpp: {all: [/X-Tenant-Id/, /\b401\b/, /Idempotency-Key/, /store\.get\(/, /store\.put\(/]},
      },
    },
    {
      id: 'license-before-generate',
      title: 'Decides the license before any generation is enqueued',
      detail:
        'The license read (`derivative_ok`) appears above the call that enqueues generation, so a forbidden seed never produces a single derivative. The draft enqueues first and would have to delete rows after the fact.',
      match: {
        python: {order: [/derivative_ok/, /enqueue\(/]},
        typescript: {order: [/derivativeOk/, /enqueue\(/]},
        go: {order: [/DerivativeOK/, /enqueue\(/]},
        scala: {order: [/DerivativeOk/, /enqueue\(/]},
        cpp: {order: [/derivative_ok/, /enqueue\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `"""POST /v1/synthetic/jobs: a model-generated draft that expands whatever seed it is handed."""
import uuid

from fastapi import FastAPI, Header
from pydantic import BaseModel

app = FastAPI()


class JobRequest(BaseModel):
    seed_dataset: str
    seed_version: str
    recipe: str


def start_expansion(job_id: str, seed_dataset: str, recipe: str) -> None:
    """Stream records for the job; readers stop whenever they have enough."""


@app.post("/v1/synthetic/jobs")
def create_job(body: JobRequest, tenant: str | None = Header(default=None, alias="X-Tenant-Id")) -> dict:
    # TODO: this draft expands whatever seed_dataset the caller sends, never consults the registry or
    # the seed's license, has no record cap, and validates neither header: no tenant check and no
    # idempotency, so one client retry expands the same seed a second time.
    job_id = str(uuid.uuid4())
    start_expansion(job_id, body.seed_dataset, body.recipe)
    return {"job_id": job_id, "seed_dataset": body.seed_dataset, "status": "queued"}
`,
      solution: `import logging
import uuid

from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()
logger = logging.getLogger("synthd")

MAX_RECORDS = 100000

# (dataset, version) -> registered seed row; expanding anything absent from this table is 422.
SEED_REGISTRY: dict[tuple[str, str], dict] = {
    ("wiki-dump", "2026-04-01"): {"license": "CC-BY-4.0", "derivative_ok": True},
    ("wiki-dump", "2026-01-01"): {"license": "CC-BY-ND-4.0", "derivative_ok": False},
}


class JobRequest(BaseModel):
    seed_dataset: str
    seed_version: str
    recipe: str
    max_records: int | None = None


class JobStore:
    """Idempotency store: at most one job per (tenant, Idempotency-Key)."""

    def __init__(self) -> None:
        self._jobs: dict[tuple[str, str], dict] = {}

    def get(self, tenant: str, idem_key: str) -> dict | None:
        """The job stored under (tenant, idem_key), if any."""
        return self._jobs.get((tenant, idem_key))

    def put(self, tenant: str, idem_key: str, job: dict) -> None:
        """Store the job under (tenant, idem_key)."""
        self._jobs[(tenant, idem_key)] = job


store = JobStore()


def resolve_seed(seed_dataset: str, seed_version: str) -> dict:
    """The registered seed row; an unknown seed or a no-derivatives license is 422."""
    seed = SEED_REGISTRY.get((seed_dataset, seed_version))
    if seed is None:
        raise HTTPException(status_code=422, detail="seed dataset/version is not registered")
    if not seed["derivative_ok"]:
        raise HTTPException(status_code=422, detail="seed license forbids derivative generation")
    return seed


def enqueue(job: dict) -> None:
    """Hand the accepted job to the generation workers; only reached after the license check."""
    # Publishes job["job_id"] to the synthetic.record topic; the worker enforces job["max_records"].


@app.post("/v1/synthetic/jobs")
def create_job(
    body: JobRequest,
    tenant: str | None = Header(default=None, alias="X-Tenant-Id"),
    idem_key: str | None = Header(default=None, alias="Idempotency-Key"),
) -> JSONResponse:
    if tenant is None or tenant == "":
        raise HTTPException(status_code=401, detail="missing X-Tenant-Id")
    if idem_key is None or idem_key == "":
        raise HTTPException(status_code=400, detail="Idempotency-Key is required")
    if body.recipe == "":
        raise HTTPException(status_code=400, detail="recipe is required")
    if body.max_records is None or not 1 <= body.max_records <= MAX_RECORDS:
        raise HTTPException(status_code=400, detail="max_records must be 1..100000")

    resolve_seed(body.seed_dataset, body.seed_version)

    stored = store.get(tenant, idem_key)
    if stored is not None:
        return JSONResponse(stored, status_code=200)

    job = {
        "job_id": str(uuid.uuid4()),
        "tenant": tenant,
        "seed_dataset": body.seed_dataset,
        "seed_version": body.seed_version,
        "recipe": body.recipe,
        "max_records": body.max_records,
        "status": "queued",
    }
    store.put(tenant, idem_key, job)
    enqueue(job)
    logger.info(
        "job queued job_id=%s seed_dataset=%s max_records=%s",
        job["job_id"],
        body.seed_dataset,
        body.max_records,
    )
    return JSONResponse({"job_id": job["job_id"], "max_records": job["max_records"]}, status_code=201)
`,
    },
    typescript: {
      starter: `/** POST /v1/synthetic/jobs: a model-generated draft that expands whatever seed the caller sends. */
import {randomUUID} from 'node:crypto';

import Fastify from 'fastify';

export const app = Fastify();

interface JobBody {
  seed_dataset: string;
  seed_version: string;
  recipe: string;
}

async function startExpansion(jobId: string, seedDataset: string, seedVersion: string, recipe: string): Promise<void> {
  void jobId;
  void seedDataset;
  void seedVersion;
  void recipe;
}

app.post('/v1/synthetic/jobs', async (request, reply) => {
  // TODO: this draft expands whatever seed_dataset the caller sends, never consults the registry or
  // the seed's license, has no record cap, and validates neither header: no tenant check and no
  // idempotency, so one client retry expands the same seed a second time.
  const tenant = request.headers['x-tenant-id'];
  const body = request.body as JobBody;
  const jobId = randomUUID();
  await startExpansion(jobId, body.seed_dataset, body.seed_version, body.recipe);
  request.log.info({tenant, job_id: jobId, seed_dataset: body.seed_dataset}, 'job queued');
  return reply.code(202).send({job_id: jobId, seed_dataset: body.seed_dataset, status: 'queued'});
});

void app.listen({port: 8080, host: '0.0.0.0'});
`,
      solution: `/** POST /v1/synthetic/jobs: a licensed, versioned, capped job per (tenant, key). */
import {randomUUID} from 'node:crypto';

import Fastify from 'fastify';

import {seedRegistry, store} from './store';

export const app = Fastify();

const MAX_RECORDS = 100000;

interface JobBody {
  seed_dataset?: string;
  seed_version?: string;
  recipe?: string;
  max_records?: number;
}

interface Seed {
  dataset: string;
  version: string;
  license: string;
  derivativeOk: boolean;
}

interface Job {
  job_id: string;
  seed_dataset: string;
  seed_version: string;
  recipe: string;
  max_records: number;
  status: string;
}

async function enqueue(job: Job): Promise<void> {
  // Publishes the job to synthetic.record; the worker stops the expansion at job.max_records.
  void job;
}

app.post('/v1/synthetic/jobs', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '')
    return reply.code(401).send({error: 'missing X-Tenant-Id'});
  const idemKey = request.headers['idempotency-key'];
  if (typeof idemKey !== 'string' || idemKey === '')
    return reply.code(400).send({error: 'Idempotency-Key is required'});

  const body = request.body as Partial<JobBody> | null;
  if (body === null || typeof body !== 'object') return reply.code(400).send({error: 'invalid job'});
  if (typeof body.recipe !== 'string' || body.recipe === '')
    return reply.code(400).send({error: 'recipe is required'});
  const recipe = body.recipe;
  const cap = body.max_records;
  if (!Number.isInteger(cap) || (cap as number) < 1 || (cap as number) > MAX_RECORDS)
    return reply.code(400).send({error: 'max_records must be 1..100000'});

  const seed = await seedRegistry.get(body.seed_dataset ?? '', body.seed_version ?? '');
  if (seed === null) return reply.code(422).send({error: 'seed dataset/version is not registered'});
  if (!seed.derivativeOk) return reply.code(422).send({error: 'seed license forbids derivative generation'});

  const stored: Job | null = await store.get(tenant, idemKey);
  if (stored !== null) return reply.code(200).send(stored);

  const job: Job = {
    job_id: randomUUID(),
    seed_dataset: seed.dataset,
    seed_version: seed.version,
    recipe,
    max_records: cap as number,
    status: 'queued',
  };
  await store.put(tenant, idemKey, job);
  await enqueue(job);
  request.log.info({job_id: job.job_id, seed_dataset: job.seed_dataset, max_records: job.max_records}, 'job queued');
  return reply.code(201).send({job_id: job.job_id, max_records: job.max_records});
});

void app.listen({port: 8080, host: '0.0.0.0'});
`,
    },
    go: {
      starter: `// POST /v1/synthetic/jobs: a model-generated draft that expands whatever seed the caller sends.
package main

import (
	"encoding/json"
	"log"
	"net/http"

	"github.com/google/uuid"
)

type JobRequest struct {
	SeedDataset string \`json:"seed_dataset"\`
	SeedVersion string \`json:"seed_version"\`
	Recipe      string \`json:"recipe"\`
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func startExpansion(jobID, seedDataset, seedVersion, recipe string) {}

func submitJob(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	var body JobRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	// TODO: this draft expands whatever seed_dataset the caller sends, never consults the registry or
	// the seed's license, has no record cap, and validates neither header: no tenant check and no
	// idempotency, so one client retry expands the same seed a second time.
	jobID := uuid.NewString()
	startExpansion(jobID, body.SeedDataset, body.SeedVersion, body.Recipe)
	log.Printf("job queued tenant=%s job_id=%s seed_dataset=%s", tenant, jobID, body.SeedDataset)
	writeJSON(rw, http.StatusAccepted, map[string]any{
		"job_id":       jobID,
		"seed_dataset": body.SeedDataset,
		"status":       "queued",
	})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/synthetic/jobs", submitJob)
	log.Fatal(http.ListenAndServe(":8080", mux))
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

const maxRecords = 100000

type JobRequest struct {
	SeedDataset string \`json:"seed_dataset"\`
	SeedVersion string \`json:"seed_version"\`
	Recipe      string \`json:"recipe"\`
	MaxRecords  int    \`json:"max_records"\`
}

type Seed struct {
	Dataset      string
	Version      string
	License      string
	DerivativeOK bool
}

type SeedRegistry struct{}

// Get resolves a published seed; ok is false when (dataset, version) is not registered.
func (r *SeedRegistry) Get(ctx context.Context, dataset, version string) (Seed, bool) {
	return Seed{}, false
}

type JobStore struct{}

func (s *JobStore) Get(ctx context.Context, tenant, idemKey string) (map[string]any, error) {
	return nil, nil
}

func (s *JobStore) Put(ctx context.Context, tenant, idemKey string, job map[string]any) error {
	return nil
}

var (
	seedRegistry = &SeedRegistry{}
	store        = &JobStore{}
)

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

// enqueue publishes the accepted job; only reached after the registry license check.
func enqueue(ctx context.Context, job map[string]any) {}

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
	seed, ok := seedRegistry.Get(r.Context(), body.SeedDataset, body.SeedVersion)
	if !ok {
		writeJSON(rw, http.StatusUnprocessableEntity, map[string]string{"error": "seed dataset/version is not registered"})
		return
	}
	if !seed.DerivativeOK {
		writeJSON(rw, http.StatusUnprocessableEntity, map[string]string{"error": "seed license forbids derivative generation"})
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
	job := map[string]any{
		"job_id":       uuid.NewString(),
		"seed_dataset": body.SeedDataset,
		"seed_version": body.SeedVersion,
		"recipe":       body.Recipe,
		"max_records":  body.MaxRecords,
		"status":       "queued",
	}
	if err := store.Put(r.Context(), tenant, idemKey, job); err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	enqueue(r.Context(), job)
	log.Printf("job queued job_id=%s seed_dataset=%s max_records=%d", job["job_id"], body.SeedDataset, body.MaxRecords)
	writeJSON(rw, http.StatusCreated, map[string]any{"job_id": job["job_id"], "max_records": body.MaxRecords})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/synthetic/jobs", submitJob)
	log.Fatal(http.ListenAndServe(":8080", mux))
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

final case class JobRequest(seed_dataset: String, seed_version: String, recipe: String)

object SynthApi {
  implicit val system: ActorSystem = ActorSystem("synthd")
  implicit val jobFormat: RootJsonFormat[JobRequest] = jsonFormat3(JobRequest)

  def startExpansion(jobId: String, seedDataset: String, seedVersion: String, recipe: String): Unit = ()

  val route: Route =
    path("v1" / "synthetic" / "jobs") {
      post {
        headerValueByName("X-Tenant-Id") { tenant =>
          entity(as[JobRequest]) { body =>
            // TODO: this draft expands whatever seed_dataset the caller sends, never consults the
            // registry or the seed's license, has no record cap, and validates neither header: no
            // tenant check and no idempotency, so one client retry expands the seed twice.
            val jobId = UUID.randomUUID().toString
            startExpansion(jobId, body.seed_dataset, body.seed_version, body.recipe)
            complete(StatusCodes.Accepted, s"""{"job_id":"$jobId","seed_dataset":"\${body.seed_dataset}"}""")
          }
        }
      }
    }

  def main(args: Array[String]): Unit = {
    Http().newServerAt("0.0.0.0", 8080).bind(route)
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

final case class JobRequest(seed_dataset: String, seed_version: String, recipe: String, max_records: Int)
final case class Job(job_id: String, seed_dataset: String, seed_version: String, recipe: String, max_records: Int, status: String)
final case class Seed(dataset: String, version: String, license: String, DerivativeOk: Boolean)

object SeedRegistry {
  // The registered seed row; None means (dataset, version) was never published.
  def get(dataset: String, version: String): Option[Seed] = None
}

object JobStore {
  def get(tenant: String, idemKey: String): Option[String] = None
  def put(tenant: String, idemKey: String, job: String): Unit = ()
}

object SynthApi {
  implicit val system: ActorSystem = ActorSystem("synthd")
  implicit val jobRequestFormat: RootJsonFormat[JobRequest] = jsonFormat4(JobRequest)
  implicit val jobFormat: RootJsonFormat[Job] = jsonFormat6(Job)

  val MaxRecords = 100000

  val seedRegistry = SeedRegistry
  val store = JobStore

  // Publishes the accepted job; only reached after the registry license check.
  def enqueue(job: Job): Unit = ()

  val route: Route =
    path("v1" / "synthetic" / "jobs") {
      post {
        optionalHeaderValueByName("X-Tenant-Id") { tenantOpt =>
          optionalHeaderValueByName("Idempotency-Key") { idemOpt =>
            entity(as[JobRequest]) { body =>
              if (!tenantOpt.exists(_.nonEmpty)) {
                complete(StatusCodes.Unauthorized, """{"error":"missing X-Tenant-Id"}""")
              } else if (!idemOpt.exists(_.nonEmpty)) {
                complete(StatusCodes.BadRequest, """{"error":"Idempotency-Key is required"}""")
              } else if (body.recipe.isEmpty) {
                complete(StatusCodes.BadRequest, """{"error":"recipe is required"}""")
              } else if (body.max_records < 1 || body.max_records > MaxRecords) {
                complete(StatusCodes.BadRequest, """{"error":"max_records must be 1..100000"}""")
              } else {
                seedRegistry.get(body.seed_dataset, body.seed_version) match {
                  case None =>
                    complete(StatusCodes.UnprocessableEntity, """{"error":"seed dataset/version is not registered"}""")
                  case Some(seed) if !seed.DerivativeOk =>
                    complete(StatusCodes.UnprocessableEntity, """{"error":"seed license forbids derivative generation"}""")
                  case Some(_) =>
                    val tenant = tenantOpt.get
                    val idemKey = idemOpt.get
                    store.get(tenant, idemKey) match {
                      case Some(stored) =>
                        complete(StatusCodes.OK, stored)
                      case None =>
                        val job = Job(
                          UUID.randomUUID().toString,
                          body.seed_dataset,
                          body.seed_version,
                          body.recipe,
                          body.max_records,
                          "queued")
                        val storedJson = s"""{"job_id":"\${job.job_id}","seed_dataset":"\${job.seed_dataset}","max_records":\${job.max_records},"status":"queued"}"""
                        store.put(tenant, idemKey, storedJson)
                        enqueue(job)
                        complete(StatusCodes.Created, s"""{"job_id":"\${job.job_id}","max_records":\${job.max_records}}""")
                    }
                }
              }
            }
          }
        }
      }
    }

  def main(args: Array[String]): Unit = {
    Http().newServerAt("0.0.0.0", 8080).bind(route)
  }
}
`,
    },
    cpp: {
      starter: `// POST /v1/synthetic/jobs: a model-generated draft that expands whatever seed the caller sends.
#include <httplib.h>
#include <nlohmann/json.hpp>

#include <iostream>
#include <string>

using json = nlohmann::json;

struct JobRequest {
  std::string seed_dataset;
  std::string seed_version;
  std::string recipe;
};

void startExpansion(const std::string& jobId, const std::string& seedDataset, const std::string& seedVersion,
                    const std::string& recipe) {}

std::string uuidString();

int main() {
  httplib::Server svr;

  svr.Post("/v1/synthetic/jobs", [](const httplib::Request& req, httplib::Response& res) {
    const auto tenant = req.get_header_value("X-Tenant-Id");
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) {
      res.status = 400;
      res.set_content(R"({"error":"invalid json"})", "application/json");
      return;
    }
    // TODO: this draft expands whatever seed_dataset the caller sends, never consults the registry or
    // the seed's license, has no record cap, and validates neither header: no tenant check and no
    // idempotency, so one client retry expands the same seed a second time.
    const auto jobId = uuidString();
    const auto dataset = body.value("seed_dataset", std::string());
    startExpansion(jobId, dataset, body.value("seed_version", std::string()), body.value("recipe", std::string()));
    std::cerr << "job queued tenant=" << tenant << " job_id=" << jobId << " seed_dataset=" << dataset << "\\n";
    res.status = 202;
    res.set_content(json{{"job_id", jobId}, {"seed_dataset", dataset}, {"status", "queued"}}.dump(),
                    "application/json");
  });

  svr.listen("0.0.0.0", 8080);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <iostream>
#include <optional>
#include <string>

using json = nlohmann::json;

constexpr int kMaxRecords = 100000;

struct Seed {
  std::string dataset;
  std::string version;
  std::string license;
  bool derivative_ok = false;
};

struct SeedRegistry {
  // The registered seed row; nullopt means (dataset, version) was never published.
  std::optional<Seed> get(const std::string& dataset, const std::string& version);
};

struct JobStore {
  // At most one job per (tenant, Idempotency-Key): a replay returns the stored job.
  std::optional<json> get(const std::string& tenant, const std::string& idemKey);
  void put(const std::string& tenant, const std::string& idemKey, const json& job);
};

SeedRegistry kSeedRegistry;
JobStore store;
std::string uuidString();

// Publishes the accepted job; only reached after the registry license check.
void enqueue(const json& job) {}

int main() {
  httplib::Server svr;

  svr.Post("/v1/synthetic/jobs", [](const httplib::Request& req, httplib::Response& res) {
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
    if (!body.is_object() || !body.contains("seed_dataset") || !body.contains("seed_version") || !body.contains("recipe")) {
      res.status = 400;
      res.set_content(R"({"error":"invalid job"})", "application/json");
      return;
    }
    const auto dataset = body["seed_dataset"].get<std::string>();
    const auto version = body["seed_version"].get<std::string>();
    const auto recipe = body["recipe"].get<std::string>();
    if (recipe.empty()) {
      res.status = 400;
      res.set_content(R"({"error":"recipe is required"})", "application/json");
      return;
    }
    const int cap = body.value("max_records", 0);
    if (cap < 1 || cap > kMaxRecords) {
      res.status = 400;
      res.set_content(R"({"error":"max_records must be 1..100000"})", "application/json");
      return;
    }
    const auto seed = kSeedRegistry.get(dataset, version);
    if (!seed) {
      res.status = 422;
      res.set_content(R"({"error":"seed dataset/version is not registered"})", "application/json");
      return;
    }
    if (!seed->derivative_ok) {
      res.status = 422;
      res.set_content(R"({"error":"seed license forbids derivative generation"})", "application/json");
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
        {"seed_dataset", dataset},
        {"seed_version", version},
        {"recipe", recipe},
        {"max_records", cap},
        {"status", "queued"},
    };
    store.put(tenant, idemKey, job);
    enqueue(job);
    std::cerr << "job queued job_id=" << job["job_id"] << " seed_dataset=" << dataset << " max_records=" << cap << "\\n";
    res.status = 201;
    res.set_content(json{{"job_id", job["job_id"]}, {"max_records", cap}}.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8080);
}
`,
    },
  },
  debrief: `The interviewer is testing whether you can review a generated handler at the license boundary. The draft reads fine because the demo always sends a seed the platform owns and never retries. Five separate defects are being checked: authentication, the request cap, the registry lookup, the license decision, and the order the two happen in. The subtle one is the license: most candidates stop at "the dataset exists", but a registered dataset whose license forbids derivatives turns every generated record into a legal problem, and the fix has to run before generation starts, not after. The idempotency key is what makes a retried submit safe: without it, one client retry doubles the corpus against the same seed and the cap you validated is now two caps. Real services add a seed registry audit trail, per-tenant seed allowlists, and a license term record pinned to the job.`,
};
