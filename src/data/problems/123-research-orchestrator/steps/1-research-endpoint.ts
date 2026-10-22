import type {Step} from '@/lib/types';

export const researchEndpointStep: Step = {
  id: 'research-endpoint',
  title: 'POST /v1/research: effort budgets, 202 and a job id',
  concept: 'http',
  file: 'research_api',
  focus: ['client', 'api', 'lead'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it registers the route, parses
the body and returns a research report. It compiles, it serves the demo, and it hides four
production flaws. Review it like the service owner, fix it, and prove the fix with the checks below.

Implement \`POST /v1/research\` with body \`{"query": "…", "effort": "compare"}\` and
\`GET /v1/research/{job_id}\`.

- The tenant comes from the authenticated \`X-Tenant-Id\` header; a missing tenant is **401** on
  both routes.
- \`query\` is a non-empty string of at most **8 KiB** (\`1 << 13\` bytes) of UTF-8; larger is
  **413**.
- \`effort\` is one of \`fact\`, \`compare\`, \`deep\` (**400** otherwise) and defaults to \`fact\`.
  The budget is chosen server-side from an effort table — the source's scaling rules — and the
  caller can never set it: \`fact\` → 1 subagent, 10 tool calls, 50 000 tokens; \`compare\` → 4
  subagents, 60 tool calls, 250 000 tokens; \`deep\` → 10 subagents, 150 tool calls, 1 000 000
  tokens.
- \`Idempotency-Key\` is required (**400** when missing). A retry with the same \`(tenant, key)\`
  returns the stored job instead of starting a second one.
- The handler stores the job, **enqueues** it for the lead agent and answers **202** with
  \`{job_id, status: "queued", budget}\`. It never runs the research inline: a job can take minutes
  and fifteen chats' worth of tokens, and an HTTP request is neither a durable nor a resumable
  place to hold it.
- \`GET /v1/research/{job_id}\` returns the job's status for the tenant that owns it, **404** when
  there is none.

**Failure mode the checks target.** Running the research inside the request ties a worker to a
multi-minute job and loses it on every timeout, retry or deploy; a caller-supplied budget turns one
request into an unbounded bill — the source's whole economic argument is that multi-agent spend
must be matched to the value of the task; the missing cap on the query is the same leak at the
input; and an un-keyed start endpoint spawns a second job, with a second budget, for every client
retry.`,
  sequence: {
    participants: ['Client', 'researchd API', 'job store', 'Lead agent'],
    messages: [
      {from: 'Client', to: 'researchd API', label: 'POST /v1/research · X-Tenant-Id · Idempotency-Key', kind: 'sync'},
      {
        from: 'researchd API',
        to: 'researchd API',
        label: 'validate tenant · query ≤ 8 KiB · effort → budget',
        kind: 'sync',
      },
      {from: 'researchd API', to: 'job store', label: 'get(tenant, idem_key)', kind: 'sync'},
      {from: 'job store', to: 'researchd API', label: 'stored job / none', kind: 'reply'},
      {from: 'researchd API', to: 'job store', label: 'put(tenant, idem_key, job)', kind: 'sync'},
      {from: 'researchd API', to: 'Lead agent', label: 'enqueue(job)', kind: 'async'},
      {from: 'researchd API', to: 'Client', label: '202 {job_id, status: queued, budget}', kind: 'reply'},
      {from: 'Client', to: 'researchd API', label: 'GET /v1/research/{job_id}', kind: 'sync'},
      {from: 'researchd API', to: 'Client', label: '200 {job_id, status, …}', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'routes',
      title: 'Handles POST /v1/research and GET /v1/research/{job_id}',
      detail:
        'Register the start route on `POST /v1/research` and the status route on `GET /v1/research/{job_id}`. The draft has no status route because it answers the report inline.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/research["']/, /@app\.get\(\s*["']\/v1\/research\/\{job_id\}["']/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/research['"]/, /app\.get\(\s*['"]\/v1\/research\/:\w+['"]/]},
        go: {all: [/HandleFunc\(\s*"POST \/v1\/research"/, /HandleFunc\(\s*"GET \/v1\/research\/\{\w+\}"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"research"\s*\)/, /path\(\s*"v1"\s*\/\s*"research"\s*\/\s*Segment\s*\)/]},
        cpp: {all: [/svr\.Post\(\s*"\/v1\/research"/, /svr\.Get\(\s*R"\(\/v1\/research\//]},
      },
    },
    {
      id: 'validate',
      title: 'Authenticates the tenant, caps the query, checks the effort',
      detail:
        'A missing `X-Tenant-Id` is **401**; a query over `1 << 13` bytes is **413**; an `effort` outside `fact`/`compare`/`deep` is **400**. The draft accepts any query size and any effort string from anyone.',
      match: {
        python: {all: [/MAX_QUERY_BYTES/, /ALLOWED_EFFORTS/, /status_code\s*=\s*413/, /status_code\s*=\s*401/]},
        typescript: {all: [/MAX_QUERY_BYTES/, /ALLOWED_EFFORTS/, /code\(\s*413\s*\)/, /code\(\s*401\s*\)/]},
        go: {all: [/maxQueryBytes/, /allowedEfforts/, /StatusRequestEntityTooLarge/, /StatusUnauthorized/]},
        scala: {
          all: [/MaxQueryBytes/, /AllowedEfforts/, /StatusCodes\.RequestEntityTooLarge/, /StatusCodes\.Unauthorized/],
        },
        cpp: {all: [/kMaxQueryBytes/, /kAllowedEfforts/, /\b413\b/, /\b401\b/]},
      },
    },
    {
      id: 'budget-table',
      title: 'Maps effort to a server-side budget',
      detail:
        'The budget — `max_subagents`, `max_tool_calls`, `token_budget` — comes from an `EFFORT_BUDGETS` table keyed by effort. The draft copies `max_subagents` and friends from the request body, so the caller sets their own spend.',
      match: {
        python: {
          all: [/EFFORT_BUDGETS/, /max_subagents/, /max_tool_calls/, /token_budget/],
          none: [/body\.max_subagents/, /body\.max_tool_calls/],
        },
        typescript: {
          all: [/EFFORT_BUDGETS/, /max_subagents/, /max_tool_calls/, /token_budget/],
          none: [/body\.max_subagents/, /body\.max_tool_calls/],
        },
        go: {
          all: [/effortBudgets/, /MaxSubagents/, /MaxToolCalls/, /TokenBudget/],
          none: [/body\.MaxSubagents/, /body\.MaxToolCalls/],
        },
        scala: {
          all: [/EffortBudgets/, /max_subagents/, /max_tool_calls/, /token_budget/],
          none: [/body\.max_subagents/, /body\.max_tool_calls/],
        },
        cpp: {
          all: [/kEffortBudgets/, /max_subagents/, /max_tool_calls/, /token_budget/],
          none: [/body\.value\(\s*"max_subagents"/, /body\.value\(\s*"max_tool_calls"/],
        },
      },
    },
    {
      id: 'idempotency-key',
      title: 'Keys retries by (tenant, Idempotency-Key)',
      detail:
        '`Idempotency-Key` is required and the job is stored under `(tenant, key)`; a replay returns the stored job instead of starting a second one. The draft ignores the header, so every client retry spawns another job with its own budget.',
      match: {
        python: {all: [/Idempotency-Key/, /jobs\.get\(/, /jobs\.put\(/]},
        typescript: {all: [/idempotency-key/, /jobs\.get\(/, /jobs\.put\(/]},
        go: {all: [/Idempotency-Key/, /jobs\.Get\(/, /jobs\.Put\(/]},
        scala: {all: [/Idempotency-Key/, /jobs\.get\(/, /jobs\.put\(/]},
        cpp: {all: [/Idempotency-Key/, /jobs\.get\(/, /jobs\.put\(/]},
      },
    },
    {
      id: 'async-202',
      title: 'Enqueues the job and answers 202',
      detail:
        'The handler enqueues the job for the lead agent and answers **202** with the job id; the research never runs inside the request. The draft calls the lead agent synchronously and holds the connection for the whole job.',
      match: {
        python: {all: [/status_code\s*=\s*202/, /queue\.enqueue\(/], none: [/run_research\(/]},
        typescript: {all: [/code\(\s*202\s*\)/, /queue\.enqueue\(/], none: [/runResearch\(/]},
        go: {all: [/StatusAccepted/, /queue\.Enqueue\(/], none: [/runResearch\(/]},
        scala: {all: [/StatusCodes\.Accepted/, /queue\.enqueue\(/], none: [/runResearch\(/]},
        cpp: {all: [/status\s*=\s*202/, /queue\.enqueue\(/], none: [/runResearch\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import logging
import uuid

from fastapi import FastAPI, Header
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from lead_agent import run_research

app = FastAPI()
logger = logging.getLogger("researchd")


class ResearchRequest(BaseModel):
    query: str
    effort: str = "fact"
    max_subagents: int = 10
    max_tool_calls: int = 150
    token_budget: int = 1_000_000


class JobStore:
    def get(self, tenant: str, idem_key: str):
        """The job stored for (tenant, idem_key), if any."""
        raise NotImplementedError

    def put(self, tenant: str, idem_key: str, job: dict) -> None:
        """Store the job under (tenant, idem_key)."""
        raise NotImplementedError


jobs = JobStore()


@app.post("/v1/research")
def research(body: ResearchRequest, tenant: str = Header(alias="X-Tenant-Id")) -> JSONResponse:
    # TODO: this draft runs the whole research job inside the request, takes the budget from the
    # caller, caps neither the query nor the effort, and ignores Idempotency-Key. Review all four.
    job_id = str(uuid.uuid4())
    budget = {
        "max_subagents": body.max_subagents,
        "max_tool_calls": body.max_tool_calls,
        "token_budget": body.token_budget,
    }
    logger.info("research tenant=%s job=%s effort=%s", tenant, job_id, body.effort)
    report = run_research(job_id, body.query, budget)
    return JSONResponse({"job_id": job_id, "status": "done", "report": report}, status_code=200)
`,
      solution: `import logging
import uuid

from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()
logger = logging.getLogger("researchd")

MAX_QUERY_BYTES = 1 << 13
ALLOWED_EFFORTS = {"fact", "compare", "deep"}
EFFORT_BUDGETS = {
    "fact": {"max_subagents": 1, "max_tool_calls": 10, "token_budget": 50_000},
    "compare": {"max_subagents": 4, "max_tool_calls": 60, "token_budget": 250_000},
    "deep": {"max_subagents": 10, "max_tool_calls": 150, "token_budget": 1_000_000},
}


class ResearchRequest(BaseModel):
    query: str
    effort: str = "fact"


class JobStore:
    def get(self, tenant: str, idem_key: str) -> dict | None:
        """The job stored for (tenant, idem_key), if any."""
        raise NotImplementedError

    def put(self, tenant: str, idem_key: str, job: dict) -> None:
        """Store the job under (tenant, idem_key) and under its job id."""
        raise NotImplementedError

    def status(self, tenant: str, job_id: str) -> dict | None:
        """The job with this id, if the tenant owns it."""
        raise NotImplementedError


class JobQueue:
    def enqueue(self, job: dict) -> None:
        """Hand the job to a lead agent worker; the request does not wait for it."""
        raise NotImplementedError


jobs = JobStore()
queue = JobQueue()


def require_tenant(tenant: str | None) -> str:
    if tenant is None or tenant == "":
        raise HTTPException(status_code=401, detail="missing X-Tenant-Id")
    return tenant


@app.post("/v1/research")
def research(
    body: ResearchRequest,
    tenant: str | None = Header(default=None, alias="X-Tenant-Id"),
    idem_key: str | None = Header(default=None, alias="Idempotency-Key"),
) -> JSONResponse:
    tenant = require_tenant(tenant)
    if idem_key is None or idem_key == "":
        raise HTTPException(status_code=400, detail="Idempotency-Key is required")
    if body.query == "":
        raise HTTPException(status_code=400, detail="query must be a non-empty string")
    if len(body.query.encode("utf-8")) > MAX_QUERY_BYTES:
        raise HTTPException(status_code=413, detail="query exceeds 8 KiB")
    if body.effort not in ALLOWED_EFFORTS:
        raise HTTPException(status_code=400, detail="effort must be fact, compare or deep")

    stored = jobs.get(tenant, idem_key)
    if stored is not None:
        return JSONResponse(stored, status_code=202)

    budget = EFFORT_BUDGETS[body.effort]
    job = {
        "job_id": str(uuid.uuid4()),
        "tenant": tenant,
        "effort": body.effort,
        "status": "queued",
        "budget": budget,
    }
    jobs.put(tenant, idem_key, job)
    queue.enqueue({**job, "query": body.query})
    logger.info("research tenant=%s job=%s effort=%s", tenant, job["job_id"], body.effort)
    return JSONResponse(job, status_code=202)


@app.get("/v1/research/{job_id}")
def research_status(job_id: str, tenant: str | None = Header(default=None, alias="X-Tenant-Id")) -> JSONResponse:
    tenant = require_tenant(tenant)
    job = jobs.status(tenant, job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="no such job")
    return JSONResponse(job, status_code=200)
`,
    },
    typescript: {
      starter: `/** POST /v1/research: a model-generated draft that researches inline and trusts the caller's budget. */
import {randomUUID} from 'node:crypto';

import Fastify from 'fastify';

import {runResearch} from './lead_agent';

export const app = Fastify();

interface ResearchBody {
  query: string;
  effort?: string;
  max_subagents?: number;
  max_tool_calls?: number;
  token_budget?: number;
}

app.post('/v1/research', async (request, reply) => {
  // TODO: this draft runs the whole research job inside the request, takes the budget from the
  // caller, caps neither the query nor the effort, and ignores Idempotency-Key. Review all four.
  const tenant = request.headers['x-tenant-id'] as string;
  const body = request.body as ResearchBody;
  const jobId = randomUUID();
  const budget = {
    max_subagents: body.max_subagents ?? 10,
    max_tool_calls: body.max_tool_calls ?? 150,
    token_budget: body.token_budget ?? 1_000_000,
  };
  request.log.info({tenant, jobId, effort: body.effort ?? 'fact'}, 'research');
  const report = await runResearch(jobId, body.query, budget);
  return reply.code(200).send({job_id: jobId, status: 'done', report});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** POST /v1/research: authenticated, capped, budgeted by effort, idempotent, queued. */
import {randomUUID} from 'node:crypto';

import Fastify from 'fastify';

import {jobs, queue} from './jobs';

export const app = Fastify();

const MAX_QUERY_BYTES = 1 << 13;
const ALLOWED_EFFORTS: Record<string, true> = {fact: true, compare: true, deep: true};

interface Budget {
  max_subagents: number;
  max_tool_calls: number;
  token_budget: number;
}

const EFFORT_BUDGETS: Record<string, Budget> = {
  fact: {max_subagents: 1, max_tool_calls: 10, token_budget: 50_000},
  compare: {max_subagents: 4, max_tool_calls: 60, token_budget: 250_000},
  deep: {max_subagents: 10, max_tool_calls: 150, token_budget: 1_000_000},
};

interface ResearchBody {
  query: string;
  effort?: string;
}

export interface Job {
  job_id: string;
  tenant: string;
  effort: string;
  status: string;
  budget: Budget;
}

function tenantOf(headers: Record<string, unknown>): string | null {
  const tenant = headers['x-tenant-id'];
  return typeof tenant === 'string' && tenant !== '' ? tenant : null;
}

app.post('/v1/research', async (request, reply) => {
  const tenant = tenantOf(request.headers);
  if (tenant === null) return reply.code(401).send({error: 'missing X-Tenant-Id'});
  const idemKey = request.headers['idempotency-key'];
  if (typeof idemKey !== 'string' || idemKey === '')
    return reply.code(400).send({error: 'Idempotency-Key is required'});

  const body = request.body as Partial<ResearchBody> | null;
  if (body === null || typeof body !== 'object' || typeof body.query !== 'string' || body.query === '')
    return reply.code(400).send({error: 'query must be a non-empty string'});
  if (Buffer.byteLength(body.query, 'utf8') > MAX_QUERY_BYTES)
    return reply.code(413).send({error: 'query exceeds 8 KiB'});
  const effort = body.effort ?? 'fact';
  if (ALLOWED_EFFORTS[effort] !== true)
    return reply.code(400).send({error: 'effort must be fact, compare or deep'});

  const stored: Job | null = await jobs.get(tenant, idemKey);
  if (stored !== null) return reply.code(202).send(stored);

  const budget = EFFORT_BUDGETS[effort];
  const job: Job = {job_id: randomUUID(), tenant, effort, status: 'queued', budget};
  await jobs.put(tenant, idemKey, job);
  await queue.enqueue({...job, query: body.query});
  request.log.info({tenant, jobId: job.job_id, effort}, 'research');
  return reply.code(202).send(job);
});

app.get('/v1/research/:jobId', async (request, reply) => {
  const tenant = tenantOf(request.headers);
  if (tenant === null) return reply.code(401).send({error: 'missing X-Tenant-Id'});
  const {jobId} = request.params as {jobId: string};
  const job: Job | null = await jobs.status(tenant, jobId);
  if (job === null) return reply.code(404).send({error: 'no such job'});
  return reply.code(200).send(job);
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

type ResearchRequest struct {
	Query        string \`json:"query"\`
	Effort       string \`json:"effort"\`
	MaxSubagents int    \`json:"max_subagents"\`
	MaxToolCalls int    \`json:"max_tool_calls"\`
	TokenBudget  int    \`json:"token_budget"\`
}

type Budget struct {
	MaxSubagents int \`json:"max_subagents"\`
	MaxToolCalls int \`json:"max_tool_calls"\`
	TokenBudget  int \`json:"token_budget"\`
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func research(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	var body ResearchRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	// TODO: this draft runs the whole research job inside the request, takes the budget from the
	// caller, caps neither the query nor the effort, and ignores Idempotency-Key. Review all four.
	jobID := uuid.NewString()
	budget := Budget{MaxSubagents: body.MaxSubagents, MaxToolCalls: body.MaxToolCalls, TokenBudget: body.TokenBudget}
	log.Printf("research tenant=%s job=%s effort=%s", tenant, jobID, body.Effort)
	report, err := runResearch(r.Context(), jobID, body.Query, budget)
	if err != nil {
		writeJSON(rw, http.StatusBadGateway, map[string]string{"error": "research failed"})
		return
	}
	writeJSON(rw, http.StatusOK, map[string]any{"job_id": jobID, "status": "done", "report": report})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/research", research)
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

const maxQueryBytes = 1 << 13

var allowedEfforts = map[string]bool{"fact": true, "compare": true, "deep": true}

type Budget struct {
	MaxSubagents int \`json:"max_subagents"\`
	MaxToolCalls int \`json:"max_tool_calls"\`
	TokenBudget  int \`json:"token_budget"\`
}

var effortBudgets = map[string]Budget{
	"fact":    {MaxSubagents: 1, MaxToolCalls: 10, TokenBudget: 50000},
	"compare": {MaxSubagents: 4, MaxToolCalls: 60, TokenBudget: 250000},
	"deep":    {MaxSubagents: 10, MaxToolCalls: 150, TokenBudget: 1000000},
}

type ResearchRequest struct {
	Query  string \`json:"query"\`
	Effort string \`json:"effort"\`
}

type Job struct {
	JobID  string \`json:"job_id"\`
	Tenant string \`json:"tenant"\`
	Effort string \`json:"effort"\`
	Status string \`json:"status"\`
	Budget Budget \`json:"budget"\`
	Query  string \`json:"-"\`
}

type JobStore struct{}

func (s *JobStore) Get(ctx context.Context, tenant, idemKey string) (*Job, error) {
	return nil, nil
}

func (s *JobStore) Put(ctx context.Context, tenant, idemKey string, job *Job) error {
	return nil
}

func (s *JobStore) Status(ctx context.Context, tenant, jobID string) (*Job, error) {
	return nil, nil
}

type JobQueue struct{}

func (q *JobQueue) Enqueue(ctx context.Context, job *Job) error {
	return nil
}

var (
	jobs  = &JobStore{}
	queue = &JobQueue{}
)

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func requireTenant(rw http.ResponseWriter, r *http.Request) (string, bool) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-Tenant-Id"})
		return "", false
	}
	return tenant, true
}

func research(rw http.ResponseWriter, r *http.Request) {
	tenant, ok := requireTenant(rw, r)
	if !ok {
		return
	}
	idemKey := r.Header.Get("Idempotency-Key")
	if idemKey == "" {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "Idempotency-Key is required"})
		return
	}
	var body ResearchRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	if body.Query == "" {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "query must be a non-empty string"})
		return
	}
	if len([]byte(body.Query)) > maxQueryBytes {
		writeJSON(rw, http.StatusRequestEntityTooLarge, map[string]string{"error": "query exceeds 8 KiB"})
		return
	}
	effort := body.Effort
	if effort == "" {
		effort = "fact"
	}
	if !allowedEfforts[effort] {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "effort must be fact, compare or deep"})
		return
	}
	stored, err := jobs.Get(r.Context(), tenant, idemKey)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	if stored != nil {
		writeJSON(rw, http.StatusAccepted, stored)
		return
	}
	job := &Job{
		JobID:  uuid.NewString(),
		Tenant: tenant,
		Effort: effort,
		Status: "queued",
		Budget: effortBudgets[effort],
		Query:  body.Query,
	}
	if err := jobs.Put(r.Context(), tenant, idemKey, job); err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	if err := queue.Enqueue(r.Context(), job); err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	log.Printf("research tenant=%s job=%s effort=%s", tenant, job.JobID, effort)
	writeJSON(rw, http.StatusAccepted, job)
}

func researchStatus(rw http.ResponseWriter, r *http.Request) {
	tenant, ok := requireTenant(rw, r)
	if !ok {
		return
	}
	job, err := jobs.Status(r.Context(), tenant, r.PathValue("jobID"))
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	if job == nil {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "no such job"})
		return
	}
	writeJSON(rw, http.StatusOK, job)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/research", research)
	mux.HandleFunc("GET /v1/research/{jobID}", researchStatus)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
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

final case class ResearchRequest(
    query: String,
    effort: String,
    max_subagents: Int,
    max_tool_calls: Int,
    token_budget: Int
)
final case class Budget(max_subagents: Int, max_tool_calls: Int, token_budget: Int)

object ResearchApi {
  implicit val system: ActorSystem = ActorSystem("researchd")
  implicit val requestFormat: RootJsonFormat[ResearchRequest] = jsonFormat5(ResearchRequest)
  implicit val budgetFormat: RootJsonFormat[Budget] = jsonFormat3(Budget)

  val route: Route =
    path("v1" / "research") {
      post {
        headerValueByName("X-Tenant-Id") { tenant =>
          entity(as[ResearchRequest]) { body =>
            // TODO: this draft runs the whole research job inside the request, takes the budget
            // from the caller, caps neither the query nor the effort, and ignores Idempotency-Key.
            val jobId = UUID.randomUUID().toString
            val budget = Budget(body.max_subagents, body.max_tool_calls, body.token_budget)
            system.log.info(s"research tenant=$tenant job=$jobId effort=\${body.effort}")
            val report = LeadAgent.runResearch(jobId, body.query, budget)
            complete(StatusCodes.OK, s"""{"job_id":"$jobId","status":"done","report":"$report"}""")
          }
        }
      }
    }

  def main(args: Array[String]): Unit = {
    Http().newServerAt("0.0.0.0", 8443).bind(route)
  }
}
`,
      solution: `import java.nio.charset.StandardCharsets
import java.util.UUID

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class ResearchRequest(query: String, effort: Option[String])
final case class Budget(max_subagents: Int, max_tool_calls: Int, token_budget: Int)
final case class Job(job_id: String, tenant: String, effort: String, status: String, budget: Budget)

object ResearchApi {
  implicit val system: ActorSystem = ActorSystem("researchd")
  implicit val requestFormat: RootJsonFormat[ResearchRequest] = jsonFormat2(ResearchRequest)
  implicit val budgetFormat: RootJsonFormat[Budget] = jsonFormat3(Budget)
  implicit val jobFormat: RootJsonFormat[Job] = jsonFormat5(Job)

  val MaxQueryBytes = 1 << 13
  val AllowedEfforts = Set("fact", "compare", "deep")
  val EffortBudgets = Map(
    "fact" -> Budget(1, 10, 50000),
    "compare" -> Budget(4, 60, 250000),
    "deep" -> Budget(10, 150, 1000000)
  )

  val jobs = JobStore.open()
  val queue = JobQueue.open()

  val route: Route =
    concat(
      path("v1" / "research") {
        post {
          optionalHeaderValueByName("X-Tenant-Id") { tenantOpt =>
            optionalHeaderValueByName("Idempotency-Key") { idemOpt =>
              entity(as[ResearchRequest]) { body =>
                val effort = body.effort.getOrElse("fact")
                if (!tenantOpt.exists(_.nonEmpty)) {
                  complete(StatusCodes.Unauthorized, """{"error":"missing X-Tenant-Id"}""")
                } else if (!idemOpt.exists(_.nonEmpty)) {
                  complete(StatusCodes.BadRequest, """{"error":"Idempotency-Key is required"}""")
                } else if (body.query.isEmpty) {
                  complete(StatusCodes.BadRequest, """{"error":"query must be a non-empty string"}""")
                } else if (body.query.getBytes(StandardCharsets.UTF_8).length > MaxQueryBytes) {
                  complete(StatusCodes.RequestEntityTooLarge, """{"error":"query exceeds 8 KiB"}""")
                } else if (!AllowedEfforts.contains(effort)) {
                  complete(StatusCodes.BadRequest, """{"error":"effort must be fact, compare or deep"}""")
                } else {
                  val tenant = tenantOpt.get
                  val idemKey = idemOpt.get
                  jobs.get(tenant, idemKey) match {
                    case Some(stored) =>
                      complete(StatusCodes.Accepted, stored)
                    case None =>
                      val job = Job(UUID.randomUUID().toString, tenant, effort, "queued", EffortBudgets(effort))
                      jobs.put(tenant, idemKey, job)
                      queue.enqueue(job, body.query)
                      system.log.info(s"research tenant=$tenant job=\${job.job_id} effort=$effort")
                      complete(StatusCodes.Accepted, job)
                  }
                }
              }
            }
          }
        }
      },
      path("v1" / "research" / Segment) { jobId =>
        get {
          optionalHeaderValueByName("X-Tenant-Id") { tenantOpt =>
            if (!tenantOpt.exists(_.nonEmpty)) {
              complete(StatusCodes.Unauthorized, """{"error":"missing X-Tenant-Id"}""")
            } else {
              jobs.status(tenantOpt.get, jobId) match {
                case Some(job) => complete(StatusCodes.OK, job)
                case None => complete(StatusCodes.NotFound, """{"error":"no such job"}""")
              }
            }
          }
        }
      }
    )

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

#include "lead_agent.h"

using json = nlohmann::json;

std::string uuidString();

int main() {
  httplib::Server svr;

  svr.Post("/v1/research", [](const httplib::Request& req, httplib::Response& res) {
    const auto tenant = req.get_header_value("X-Tenant-Id");
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) {
      res.status = 400;
      res.set_content(R"({"error":"invalid json"})", "application/json");
      return;
    }
    // TODO: this draft runs the whole research job inside the request, takes the budget from the
    // caller, caps neither the query nor the effort, and ignores Idempotency-Key. Review all four.
    const auto jobId = uuidString();
    const auto effort = body.value("effort", std::string("fact"));
    const json budget = {
        {"max_subagents", body.value("max_subagents", 10)},
        {"max_tool_calls", body.value("max_tool_calls", 150)},
        {"token_budget", body.value("token_budget", 1000000)},
    };
    std::cerr << "research tenant=" << tenant << " job=" << jobId << " effort=" << effort << "\\n";
    const auto report = runResearch(jobId, body.value("query", std::string()), budget);
    res.status = 200;
    res.set_content(json{{"job_id", jobId}, {"status", "done"}, {"report", report}}.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <iostream>
#include <map>
#include <optional>
#include <set>
#include <string>

using json = nlohmann::json;

constexpr std::size_t kMaxQueryBytes = 1 << 13;
const std::set<std::string> kAllowedEfforts = {"fact", "compare", "deep"};
const std::map<std::string, json> kEffortBudgets = {
    {"fact", {{"max_subagents", 1}, {"max_tool_calls", 10}, {"token_budget", 50000}}},
    {"compare", {{"max_subagents", 4}, {"max_tool_calls", 60}, {"token_budget", 250000}}},
    {"deep", {{"max_subagents", 10}, {"max_tool_calls", 150}, {"token_budget", 1000000}}},
};

struct JobStore {
  std::optional<json> get(const std::string& tenant, const std::string& idemKey);
  void put(const std::string& tenant, const std::string& idemKey, const json& job);
  std::optional<json> status(const std::string& tenant, const std::string& jobId);
};

struct JobQueue {
  void enqueue(const json& job);
};

JobStore jobs;
JobQueue queue;
std::string uuidString();

bool requireTenant(const httplib::Request& req, httplib::Response& res, std::string& tenant) {
  tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) {
    res.status = 401;
    res.set_content(R"({"error":"missing X-Tenant-Id"})", "application/json");
    return false;
  }
  return true;
}

int main() {
  httplib::Server svr;

  svr.Post("/v1/research", [](const httplib::Request& req, httplib::Response& res) {
    std::string tenant;
    if (!requireTenant(req, res, tenant)) return;
    const auto idemKey = req.get_header_value("Idempotency-Key");
    if (idemKey.empty()) {
      res.status = 400;
      res.set_content(R"({"error":"Idempotency-Key is required"})", "application/json");
      return;
    }
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object() || !body.contains("query") || !body["query"].is_string()) {
      res.status = 400;
      res.set_content(R"({"error":"query must be a non-empty string"})", "application/json");
      return;
    }
    const auto query = body["query"].get<std::string>();
    if (query.empty()) {
      res.status = 400;
      res.set_content(R"({"error":"query must be a non-empty string"})", "application/json");
      return;
    }
    if (query.size() > kMaxQueryBytes) {
      res.status = 413;
      res.set_content(R"({"error":"query exceeds 8 KiB"})", "application/json");
      return;
    }
    const auto effort = body.value("effort", std::string("fact"));
    if (kAllowedEfforts.count(effort) == 0) {
      res.status = 400;
      res.set_content(R"({"error":"effort must be fact, compare or deep"})", "application/json");
      return;
    }
    const auto stored = jobs.get(tenant, idemKey);
    if (stored) {
      res.status = 202;
      res.set_content(stored->dump(), "application/json");
      return;
    }
    const json job = {
        {"job_id", uuidString()},
        {"tenant", tenant},
        {"effort", effort},
        {"status", "queued"},
        {"budget", kEffortBudgets.at(effort)},
    };
    jobs.put(tenant, idemKey, job);
    json queued = job;
    queued["query"] = query;
    queue.enqueue(queued);
    std::cerr << "research tenant=" << tenant << " job=" << job["job_id"] << " effort=" << effort << "\\n";
    res.status = 202;
    res.set_content(job.dump(), "application/json");
  });

  svr.Get(R"(/v1/research/([^/]+))", [](const httplib::Request& req, httplib::Response& res) {
    std::string tenant;
    if (!requireTenant(req, res, tenant)) return;
    const auto job = jobs.status(tenant, req.matches[1]);
    if (!job) {
      res.status = 404;
      res.set_content(R"({"error":"no such job"})", "application/json");
      return;
    }
    res.status = 200;
    res.set_content(job->dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  hints: [
    'Write the guard clauses first, in cost order: tenant, Idempotency-Key, query shape, byte length, effort whitelist. Every one of them returns before the job store is touched, so a malformed request can never reserve a budget.',
    'The budget is a lookup, not an input: `EFFORT_BUDGETS[effort]` gives `max_subagents`, `max_tool_calls` and `token_budget`; delete the body fields that let the caller set them. The source’s scaling rules — one agent for a fact, 2–4 for a comparison, 10+ for deep research — are the table.',
    'The handler’s last three lines are `jobs.put(tenant, idem_key, job)`, `queue.enqueue(job)`, `202`. A replay hits `jobs.get` first and returns the stored job with the same 202. The lead agent reads the queue; nothing in the request waits for it.',
  ],
  debrief: `The interviewer is testing whether you can review a generated handler for a job that costs fifteen chats and runs for minutes. The draft reads fine because the demo sends one short query, waits, and never retries. Four separate defects are being checked: the synchronous call (a multi-minute job inside an HTTP request dies on every timeout, retry and deploy, and cannot be resumed), the caller-supplied budget (the source's economic argument is that multi-agent spend must be matched to the task's value — a server-side effort table is how that becomes code), the missing input caps, and idempotency keyed by tenant so a retry cannot spawn a second job with a second budget. The status route is the half candidates forget: a 202 without a way to poll is a fire-and-forget. Real systems add per-tenant concurrency limits on open jobs, a daily token budget on top of the per-job one, and a cancel route that stops the subagents and refunds nothing.`,
};
