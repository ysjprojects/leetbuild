import type {Step} from '@/lib/types';

export const researchEndpointStep: Step = {
  id: 'research-endpoint',
  title: 'POST /v1/research: the server sets the budget, a retry finds its job',
  concept: 'http',
  guides: ['request-boundaries', 'idempotent-requests'],
  file: 'api',
  focus: ['client', 'api', 'redis'],
  task: `## Task

**Starting point.** The starter serves \`POST /v1/research\` with body \`{"query": "…", "effort":
"compare"}\` and \`GET /v1/research/{job_id}\` on the job store (\`research.jobs\`, provided). The
start route reads \`X-Tenant-Id\`, builds the budget from the body's \`max_subagents\`,
\`max_tool_calls\` and \`token_budget\` (the fact budget when they are absent), stores the job with
\`create_job\`, enqueues it and answers **202** with the job; the status route answers the job the id
names. It serves the demo and hides 4 flaws.

**Failure mode the checks target.** A request asks for a hundred thousand tool calls and gets them; a
client that times out and retries starts a second job and a second bill; a request with no tenant, a
50 KB query or an effort nobody defined is accepted; any tenant reads any job by its id.

- \`X-Tenant-Id\` is required on both routes (**401**); \`query\` is non-empty and at most
  \`MAX_QUERY_BYTES\` = 8192 bytes of UTF-8 (**413**); \`effort\` is \`fact\`, \`compare\` or \`deep\`
  (**400**), default \`fact\`.
- The budget comes from \`EFFORT_BUDGETS\` only: \`fact\` 1 subagent, 10 tool calls, 50 000 tokens;
  \`compare\` 4, 60, 250 000; \`deep\` 10, 150, 1 000 000.
- \`Idempotency-Key\` is required (**400**): answer \`job_for_key(tenant, key)\` when it is set;
  otherwise create the job, \`remember_key\` it (it returns the job the key belongs to, so a
  concurrent retry that won is answered instead) and enqueue only your own.
- The status route answers **404** for another tenant's job.`,
  sequence: {
    participants: ['Client', 'researchd API', 'job store'],
    messages: [
      {from: 'Client', to: 'researchd API', label: 'POST /v1/research · X-Tenant-Id · Idempotency-Key', kind: 'sync'},
      {
        from: 'researchd API',
        to: 'researchd API',
        label: 'tenant · query ≤ 8192 B · effort → EFFORT_BUDGETS',
        kind: 'sync',
      },
      {from: 'researchd API', to: 'job store', label: 'job_for_key(tenant, key) → job / none', kind: 'sync'},
      {from: 'researchd API', to: 'job store', label: 'create_job · remember_key · enqueue', kind: 'sync'},
      {from: 'researchd API', to: 'Client', label: '202 {job_id, status: queued, budget}', kind: 'reply'},
      {from: 'Client', to: 'researchd API', label: 'GET /v1/research/{job_id} · X-Tenant-Id', kind: 'sync'},
      {from: 'researchd API', to: 'Client', label: '200 the job · 404 another tenant’s', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'routes',
      title: 'Starts a job with 202 and answers its status',
      detail:
        '`POST /v1/research` stores the job, enqueues its id on `research:queue` and answers **202** with the job; `GET /v1/research/{job_id}` answers it.',
      match: {
        python: {
          all: [
            /@app\.post\(\s*["']\/v1\/research["']/,
            /@app\.get\(\s*["']\/v1\/research\/\{job_id\}["']/,
            /jobs\.enqueue\(/,
          ],
        },
        typescript: {
          all: [/app\.post\(\s*['"]\/v1\/research['"]/, /app\.get\(\s*['"]\/v1\/research\/:\w+['"]/, /\benqueue\(/],
        },
        go: {
          all: [
            /HandleFunc\(\s*"POST \/v1\/research"/,
            /HandleFunc\(\s*"GET \/v1\/research\/\{\w+\}"/,
            /jobs\.Enqueue\(/,
          ],
        },
        scala: {
          all: [
            /path\(\s*"v1"\s*\/\s*"research"\s*\)/,
            /path\(\s*"v1"\s*\/\s*"research"\s*\/\s*Segment\s*\)/,
            /Jobs\.enqueue\(/,
          ],
        },
        cpp: {all: [/svr\.Post\(\s*"\/v1\/research"/, /svr\.Get\(\s*R"\(\/v1\/research\//, /jobs::enqueue\(/]},
      },
    },
    {
      id: 'validate',
      title: 'Refuses a request without a tenant, an oversized query or an unknown effort',
      detail:
        'A missing `X-Tenant-Id` is **401**, a query over `MAX_QUERY_BYTES` (8192 bytes of UTF-8) is **413**, an effort outside the budget table is **400**, and none of them creates a job.',
      match: {
        python: {all: [/MAX_QUERY_BYTES\s*=/, /\b401\b/, /\b413\b/, /\.encode\(/]},
        typescript: {all: [/MAX_QUERY_BYTES\s*=/, /code\(\s*401\s*\)/, /code\(\s*413\s*\)/, /TextEncoder|byteLength/]},
        go: {all: [/maxQueryBytes\s*=/, /StatusUnauthorized|\b401\b/, /StatusRequestEntityTooLarge|\b413\b/]},
        scala: {
          all: [
            /MaxQueryBytes\s*=/,
            /Unauthorized|\b401\b/,
            /PayloadTooLarge|RequestEntityTooLarge|\b413\b/,
            /getBytes\(/,
          ],
        },
        cpp: {all: [/kMaxQueryBytes\s*=/, /\b401\b/, /\b413\b/]},
      },
    },
    {
      id: 'budget-table',
      title: 'The budget comes from the server-side effort table',
      detail:
        '`max_subagents`, `max_tool_calls` and `token_budget` are looked up in `EFFORT_BUDGETS` by effort; a budget field in the body is ignored.',
      match: {
        python: {
          all: [/EFFORT_BUDGETS\s*=/, /EFFORT_BUDGETS\[/],
          none: [/body(\.get\(|\[)\s*["'](max_subagents|max_tool_calls|token_budget)/],
        },
        typescript: {
          all: [/EFFORT_BUDGETS\s*[:=]/, /EFFORT_BUDGETS\.get\(|EFFORT_BUDGETS\[/],
          none: [/body\.(max_subagents|max_tool_calls|token_budget)/],
        },
        go: {all: [/effortBudgets\s*=/, /effortBudgets\[/], none: [/body\.(MaxSubagents|MaxToolCalls|TokenBudget)/]},
        scala: {
          all: [/EffortBudgets\s*[:=]/, /EffortBudgets\.get\(/],
          none: [/number\(\s*body\s*,\s*"(max_subagents|max_tool_calls|token_budget)"/],
        },
        cpp: {
          all: [/kEffortBudgets\s*=/, /kEffortBudgets\.find\(|kEffortBudgets\.at\(/],
          none: [/body\.value\(\s*"(max_subagents|max_tool_calls|token_budget)"/],
        },
      },
    },
    {
      id: 'idempotency-key',
      title: 'A retry with the same Idempotency-Key answers the first job',
      detail:
        '`Idempotency-Key` is required (**400**); `job_for_key`/`jobForKey` is asked before a job is created, so a retry creates no second job; a new job is recorded with `remember_key`/`rememberKey`, and a start that loses the key to a concurrent retry answers that retry’s job and enqueues nothing.',
      match: {
        python: {
          all: [/idempotency-key/i, /jobs\.job_for_key\(/, /jobs\.remember_key\(/, /\b400\b/],
          order: [/jobs\.job_for_key\(/, /jobs\.create_job\(/],
        },
        typescript: {
          all: [/idempotency-key/i, /jobForKey\(/, /rememberKey\(/, /\b400\b/],
          order: [/jobForKey\(/, /createJob\(/],
        },
        go: {
          all: [/Idempotency-Key/i, /jobs\.JobForKey\(/, /jobs\.RememberKey\(/, /StatusBadRequest|\b400\b/],
          order: [/jobs\.JobForKey\(/, /jobs\.CreateJob\(/],
        },
        scala: {
          all: [/Idempotency-Key/i, /Jobs\.jobForKey\(/, /Jobs\.rememberKey\(/, /BadRequest|\b400\b/],
          order: [/Jobs\.jobForKey\(/, /Jobs\.createJob\(/],
        },
        cpp: {
          all: [/Idempotency-Key/i, /jobs::jobForKey\(/, /jobs::rememberKey\(/, /\b400\b/],
          order: [/jobs::jobForKey\(/, /jobs::createJob\(/],
        },
      },
    },
    {
      id: 'tenant-scope',
      title: 'A tenant reads only its own jobs',
      detail:
        'The status route requires `X-Tenant-Id` and compares it with the job’s tenant: another tenant’s job is **404**, as if it did not exist.',
      match: {
        python: {all: [/job\[["']tenant["']\]\s*(!=|==)\s*tenant/]},
        typescript: {all: [/job\.tenant\s*(!==|===|!=|==)\s*tenant/]},
        go: {all: [/job\.Tenant\s*(!=|==)\s*tenant/]},
        scala: {all: [/job\.tenant\s*(!=|==)\s*tenant/]},
        cpp: {all: [/job(->|\.)tenant\s*(!=|==)\s*tenant/]},
      },
    },
  ],
  code: {
    python: {
      starter: `from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse

from research import jobs  # create_job, get_job, job_for_key, remember_key, enqueue

app = FastAPI()


@app.post("/v1/research")
async def start_research(request: Request) -> JSONResponse:
    # TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
    tenant = request.headers.get("x-tenant-id", "")
    body = await request.json()
    budget = {
        "max_subagents": int(body.get("max_subagents", 1)),
        "max_tool_calls": int(body.get("max_tool_calls", 10)),
        "token_budget": int(body.get("token_budget", 50_000)),
    }
    job = jobs.create_job(tenant, body.get("query", ""), body.get("effort", "fact"), budget)
    jobs.enqueue(job["job_id"])
    return JSONResponse(job, status_code=202)


@app.get("/v1/research/{job_id}")
def research_status(job_id: str, request: Request) -> JSONResponse:
    job = jobs.get_job(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="no such job")
    return JSONResponse(job)
`,
      solution: `from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse

from research import jobs  # create_job, get_job, job_for_key, remember_key, enqueue

app = FastAPI()

MAX_QUERY_BYTES = 8192
# The spend is the server's decision: a budget field in the body is ignored.
EFFORT_BUDGETS = {
    "fact": {"max_subagents": 1, "max_tool_calls": 10, "token_budget": 50_000},
    "compare": {"max_subagents": 4, "max_tool_calls": 60, "token_budget": 250_000},
    "deep": {"max_subagents": 10, "max_tool_calls": 150, "token_budget": 1_000_000},
}


def require_tenant(request: Request) -> str:
    tenant = request.headers.get("x-tenant-id", "")
    if not tenant:
        raise HTTPException(status_code=401, detail="X-Tenant-Id is required")
    return tenant


@app.post("/v1/research")
async def start_research(request: Request) -> JSONResponse:
    tenant = require_tenant(request)
    key = request.headers.get("idempotency-key", "")
    if not key:
        raise HTTPException(status_code=400, detail="Idempotency-Key is required")
    body = await request.json()
    query = body.get("query", "")
    effort = body.get("effort", "fact")
    if not isinstance(query, str) or query == "":
        raise HTTPException(status_code=400, detail="query must be a non-empty string")
    if len(query.encode("utf-8")) > MAX_QUERY_BYTES:
        raise HTTPException(status_code=413, detail=f"query exceeds {MAX_QUERY_BYTES} bytes")
    if effort not in EFFORT_BUDGETS:
        raise HTTPException(status_code=400, detail="effort must be fact, compare or deep")
    stored = jobs.job_for_key(tenant, key)
    if stored is not None:
        return JSONResponse(jobs.get_job(stored), status_code=202)  # a retry answers the first job
    job = jobs.create_job(tenant, query, effort, EFFORT_BUDGETS[effort])
    owner = jobs.remember_key(tenant, key, job["job_id"])
    if owner != job["job_id"]:
        return JSONResponse(jobs.get_job(owner), status_code=202)  # a concurrent retry won the key
    jobs.enqueue(job["job_id"])
    return JSONResponse(job, status_code=202)


@app.get("/v1/research/{job_id}")
def research_status(job_id: str, request: Request) -> JSONResponse:
    tenant = require_tenant(request)
    job = jobs.get_job(job_id)
    if job is None or job["tenant"] != tenant:
        raise HTTPException(status_code=404, detail="no such job")  # another tenant's job does not exist here
    return JSONResponse(job)
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';

import {createJob, enqueue, getJob, jobForKey, rememberKey} from 'research/jobs';

export const app = Fastify();

interface StartBody {
  query?: string;
  effort?: string;
  max_subagents?: number;
  max_tool_calls?: number;
  token_budget?: number;
}

app.post('/v1/research', async (request, reply) => {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  const tenant = String(request.headers['x-tenant-id'] ?? '');
  const body = (request.body ?? {}) as StartBody;
  const budget = {max_subagents: body.max_subagents ?? 1, max_tool_calls: body.max_tool_calls ?? 10, token_budget: body.token_budget ?? 50_000};
  const job = await createJob(tenant, body.query ?? '', body.effort ?? 'fact', budget);
  await enqueue(job.job_id);
  return reply.code(202).send(job);
});

app.get('/v1/research/:jobId', async (request, reply) => {
  const {jobId} = request.params as {jobId: string};
  const job = await getJob(jobId);
  if (job === null) return reply.code(404).send({error: 'no such job'});
  return job;
});
`,
      solution: `import Fastify from 'fastify';

import {type Budget, createJob, enqueue, getJob, jobForKey, rememberKey} from 'research/jobs';

export const app = Fastify();

export const MAX_QUERY_BYTES = 8192;
// The spend is the server's decision: a budget field in the body is ignored.
export const EFFORT_BUDGETS: Record<string, Budget> = {
  fact: {max_subagents: 1, max_tool_calls: 10, token_budget: 50_000},
  compare: {max_subagents: 4, max_tool_calls: 60, token_budget: 250_000},
  deep: {max_subagents: 10, max_tool_calls: 150, token_budget: 1_000_000},
};

interface StartBody {
  query?: unknown;
  effort?: string;
}

app.post('/v1/research', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'X-Tenant-Id is required'});
  const key = request.headers['idempotency-key'];
  if (typeof key !== 'string' || key === '') return reply.code(400).send({error: 'Idempotency-Key is required'});
  const {query, effort = 'fact'} = (request.body ?? {}) as StartBody;
  if (typeof query !== 'string' || query === '') return reply.code(400).send({error: 'query must be a non-empty string'});
  if (new TextEncoder().encode(query).length > MAX_QUERY_BYTES) return reply.code(413).send({error: \`query exceeds \${MAX_QUERY_BYTES} bytes\`});
  const budget = Object.hasOwn(EFFORT_BUDGETS, effort) ? EFFORT_BUDGETS[effort] : undefined;
  if (budget === undefined) return reply.code(400).send({error: 'effort must be fact, compare or deep'});
  const stored = await jobForKey(tenant, key);
  if (stored !== null) return reply.code(202).send(await getJob(stored)); // a retry answers the first job
  const job = await createJob(tenant, query, effort, budget);
  const owner = await rememberKey(tenant, key, job.job_id);
  if (owner !== job.job_id) return reply.code(202).send(await getJob(owner)); // a concurrent retry won the key
  await enqueue(job.job_id);
  return reply.code(202).send(job);
});

app.get('/v1/research/:jobId', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'X-Tenant-Id is required'});
  const {jobId} = request.params as {jobId: string};
  const job = await getJob(jobId);
  // Another tenant's job does not exist here.
  if (job === null || job.tenant !== tenant) return reply.code(404).send({error: 'no such job'});
  return job;
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"net/http"

	"research/jobs" // jobs.CreateJob, GetJob, JobForKey, RememberKey, Enqueue
)

type startBody struct {
	Query        string \`json:"query"\`
	Effort       string \`json:"effort"\`
	MaxSubagents int    \`json:"max_subagents"\`
	MaxToolCalls int    \`json:"max_tool_calls"\`
	TokenBudget  int    \`json:"token_budget"\`
}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func startResearch(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
	tenant := r.Header.Get("X-Tenant-Id")
	body := startBody{Effort: "fact", MaxSubagents: 1, MaxToolCalls: 10, TokenBudget: 50000}
	json.NewDecoder(r.Body).Decode(&body)
	budget := jobs.Budget{MaxSubagents: body.MaxSubagents, MaxToolCalls: body.MaxToolCalls, TokenBudget: body.TokenBudget}
	job := jobs.CreateJob(r.Context(), tenant, body.Query, body.Effort, budget)
	jobs.Enqueue(r.Context(), job.JobID)
	writeJSON(rw, http.StatusAccepted, job)
}

func researchStatus(rw http.ResponseWriter, r *http.Request) {
	job := jobs.GetJob(r.Context(), r.PathValue("id"))
	if job == nil {
		http.Error(rw, "no such job", http.StatusNotFound)
		return
	}
	writeJSON(rw, http.StatusOK, job)
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/research", startResearch)
	mux.HandleFunc("GET /v1/research/{id}", researchStatus)
}
`,
      solution: `package main

import (
	"encoding/json"
	"fmt"
	"net/http"

	"research/jobs" // jobs.CreateJob, GetJob, JobForKey, RememberKey, Enqueue
)

const maxQueryBytes = 8192

// The spend is the server's decision: a budget field in the body is ignored.
var effortBudgets = map[string]jobs.Budget{
	"fact":    {MaxSubagents: 1, MaxToolCalls: 10, TokenBudget: 50000},
	"compare": {MaxSubagents: 4, MaxToolCalls: 60, TokenBudget: 250000},
	"deep":    {MaxSubagents: 10, MaxToolCalls: 150, TokenBudget: 1000000},
}

type startBody struct {
	Query  string \`json:"query"\`
	Effort string \`json:"effort"\`
}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func startResearch(rw http.ResponseWriter, r *http.Request) {
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
	body := startBody{Effort: "fact"}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Query == "" {
		http.Error(rw, "query must be a non-empty string", http.StatusBadRequest)
		return
	}
	if len(body.Query) > maxQueryBytes {
		http.Error(rw, fmt.Sprintf("query exceeds %d bytes", maxQueryBytes), http.StatusRequestEntityTooLarge)
		return
	}
	budget, known := effortBudgets[body.Effort]
	if !known {
		http.Error(rw, "effort must be fact, compare or deep", http.StatusBadRequest)
		return
	}
	if stored := jobs.JobForKey(r.Context(), tenant, key); stored != "" {
		writeJSON(rw, http.StatusAccepted, jobs.GetJob(r.Context(), stored)) // a retry answers the first job
		return
	}
	job := jobs.CreateJob(r.Context(), tenant, body.Query, body.Effort, budget)
	if owner := jobs.RememberKey(r.Context(), tenant, key, job.JobID); owner != job.JobID {
		writeJSON(rw, http.StatusAccepted, jobs.GetJob(r.Context(), owner)) // a concurrent retry won the key
		return
	}
	jobs.Enqueue(r.Context(), job.JobID)
	writeJSON(rw, http.StatusAccepted, job)
}

func researchStatus(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		http.Error(rw, "X-Tenant-Id is required", http.StatusUnauthorized)
		return
	}
	job := jobs.GetJob(r.Context(), r.PathValue("id"))
	if job == nil || job.Tenant != tenant {
		http.Error(rw, "no such job", http.StatusNotFound) // another tenant's job does not exist here
		return
	}
	writeJSON(rw, http.StatusOK, job)
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/research", startResearch)
	mux.HandleFunc("GET /v1/research/{id}", researchStatus)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import research.Jobs // Jobs.createJob, getJob, jobForKey, rememberKey, enqueue

object Api {
  private def json(status: StatusCode, body: JsValue): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  private def jobJson(job: Jobs.Job): JsObject = JsObject(
    "job_id" -> JsString(job.jobId), "tenant" -> JsString(job.tenant), "effort" -> JsString(job.effort), "status" -> JsString(job.status),
    "budget" -> JsObject("max_subagents" -> JsNumber(job.budget.maxSubagents), "max_tool_calls" -> JsNumber(job.budget.maxToolCalls),
      "token_budget" -> JsNumber(job.budget.tokenBudget)),
    "version" -> JsString(job.version))

  private def text(body: Map[String, JsValue], name: String, default: String): String =
    body.get(name).collect { case JsString(s) => s }.getOrElse(default)

  private def number(body: Map[String, JsValue], name: String, default: Long): Long =
    body.get(name).collect { case JsNumber(n) => n.toLong }.getOrElse(default)

  val route: Route = concat(
    path("v1" / "research") {
      post {
        optionalHeaderValueByName("X-Tenant-Id") { tenant =>
          entity(as[String]) { raw =>
            // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
            val body = raw.parseJson.asJsObject.fields
            val budget = Jobs.Budget(number(body, "max_subagents", 1).toInt, number(body, "max_tool_calls", 10).toInt, number(body, "token_budget", 50000))
            val job = Jobs.createJob(tenant.getOrElse(""), text(body, "query", ""), text(body, "effort", "fact"), budget)
            Jobs.enqueue(job.jobId)
            complete(json(StatusCodes.Accepted, jobJson(job)))
          }
        }
      }
    },
    path("v1" / "research" / Segment) { jobId =>
      get {
        Jobs.getJob(jobId) match {
          case None => complete(StatusCodes.NotFound -> "no such job")
          case Some(job) => complete(json(StatusCodes.OK, jobJson(job)))
        }
      }
    },
  )
}
`,
      solution: `import java.nio.charset.StandardCharsets

import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import research.Jobs // Jobs.createJob, getJob, jobForKey, rememberKey, enqueue

object Api {
  val MaxQueryBytes = 8192
  // The spend is the server's decision: a budget field in the body is ignored.
  val EffortBudgets: Map[String, Jobs.Budget] = Map(
    "fact" -> Jobs.Budget(1, 10, 50000L), "compare" -> Jobs.Budget(4, 60, 250000L), "deep" -> Jobs.Budget(10, 150, 1000000L))

  private def json(status: StatusCode, body: JsValue): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  private def jobJson(job: Jobs.Job): JsObject = JsObject(
    "job_id" -> JsString(job.jobId), "tenant" -> JsString(job.tenant), "effort" -> JsString(job.effort), "status" -> JsString(job.status),
    "budget" -> JsObject("max_subagents" -> JsNumber(job.budget.maxSubagents), "max_tool_calls" -> JsNumber(job.budget.maxToolCalls),
      "token_budget" -> JsNumber(job.budget.tokenBudget)),
    "version" -> JsString(job.version))

  private def text(body: Map[String, JsValue], name: String, default: String): String =
    body.get(name).collect { case JsString(s) => s }.getOrElse(default)

  private def start(tenant: String, key: String, query: String, effort: String): Route =
    if (query.isEmpty) complete(StatusCodes.BadRequest -> "query must be a non-empty string")
    else if (query.getBytes(StandardCharsets.UTF_8).length > MaxQueryBytes) complete(StatusCodes.PayloadTooLarge -> s"query exceeds $MaxQueryBytes bytes")
    else EffortBudgets.get(effort) match {
      case None => complete(StatusCodes.BadRequest -> "effort must be fact, compare or deep")
      case Some(budget) =>
        Jobs.jobForKey(tenant, key).flatMap(Jobs.getJob) match {
          case Some(stored) => complete(json(StatusCodes.Accepted, jobJson(stored))) // a retry answers the first job
          case None =>
            val job = Jobs.createJob(tenant, query, effort, budget)
            val owner = Jobs.rememberKey(tenant, key, job.jobId)
            if (owner != job.jobId) complete(json(StatusCodes.Accepted, jobJson(Jobs.getJob(owner).getOrElse(job)))) // a concurrent retry won the key
            else {
              Jobs.enqueue(job.jobId)
              complete(json(StatusCodes.Accepted, jobJson(job)))
            }
        }
    }

  val route: Route = concat(
    path("v1" / "research") {
      post {
        (optionalHeaderValueByName("X-Tenant-Id") & optionalHeaderValueByName("Idempotency-Key")) { (tenant, key) =>
          entity(as[String]) { raw =>
            val body = raw.parseJson.asJsObject.fields
            (tenant.filter(_.nonEmpty), key.filter(_.nonEmpty)) match {
              case (None, _) => complete(StatusCodes.Unauthorized -> "X-Tenant-Id is required")
              case (_, None) => complete(StatusCodes.BadRequest -> "Idempotency-Key is required")
              case (Some(t), Some(k)) => start(t, k, text(body, "query", ""), text(body, "effort", "fact"))
            }
          }
        }
      }
    },
    path("v1" / "research" / Segment) { jobId =>
      get {
        optionalHeaderValueByName("X-Tenant-Id") {
          case None | Some("") => complete(StatusCodes.Unauthorized -> "X-Tenant-Id is required")
          case Some(tenant) =>
            Jobs.getJob(jobId) match {
              // Another tenant's job does not exist here.
              case Some(job) if job.tenant == tenant => complete(json(StatusCodes.OK, jobJson(job)))
              case _ => complete(StatusCodes.NotFound -> "no such job")
            }
        }
      }
    },
  )
}
`,
    },
    cpp: {
      starter: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <string>

#include "research/jobs.h"  // jobs::createJob, getJob, jobForKey, rememberKey, enqueue

using json = nlohmann::json;

void start_research(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  const json body = json::parse(req.body);
  const jobs::Budget budget{body.value("max_subagents", 1L), body.value("max_tool_calls", 10L), body.value("token_budget", 50000L)};
  const jobs::Job job = jobs::createJob(tenant, body.value("query", ""), body.value("effort", "fact"), budget);
  jobs::enqueue(job.job_id);
  res.status = 202;
  res.set_content(json(job).dump(), "application/json");
}

void research_status(const httplib::Request& req, httplib::Response& res) {
  const auto job = jobs::getJob(req.matches[1]);
  if (!job) {
    res.status = 404;
    res.set_content("no such job", "text/plain");
    return;
  }
  res.set_content(json(*job).dump(), "application/json");
}

void register_routes(httplib::Server& svr) {
  svr.Post("/v1/research", start_research);
  svr.Get(R"(/v1/research/([\\w-]+))", research_status);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <map>
#include <string>

#include "research/jobs.h"  // jobs::createJob, getJob, jobForKey, rememberKey, enqueue

using json = nlohmann::json;

constexpr size_t kMaxQueryBytes = 8192;
// The spend is the server's decision: a budget field in the body is ignored.
const std::map<std::string, jobs::Budget> kEffortBudgets = {
    {"fact", {1, 10, 50000}}, {"compare", {4, 60, 250000}}, {"deep", {10, 150, 1000000}}};

void refuse(httplib::Response& res, int status, const std::string& reason) {
  res.status = status;
  res.set_content(reason, "text/plain");
}

void answer(httplib::Response& res, int status, const jobs::Job& job) {
  res.status = status;
  res.set_content(json(job).dump(), "application/json");
}

void start_research(const httplib::Request& req, httplib::Response& res) {
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) return refuse(res, 401, "X-Tenant-Id is required");
  const std::string key = req.get_header_value("Idempotency-Key");
  if (key.empty()) return refuse(res, 400, "Idempotency-Key is required");
  const json body = json::parse(req.body, nullptr, false);
  const std::string query = body.is_object() && body.contains("query") && body["query"].is_string() ? body["query"].get<std::string>() : "";
  const std::string effort = body.is_object() ? body.value("effort", "fact") : "fact";
  if (query.empty()) return refuse(res, 400, "query must be a non-empty string");
  if (query.size() > kMaxQueryBytes) return refuse(res, 413, "query exceeds 8192 bytes");
  const auto budget = kEffortBudgets.find(effort);
  if (budget == kEffortBudgets.end()) return refuse(res, 400, "effort must be fact, compare or deep");
  if (const auto stored = jobs::jobForKey(tenant, key)) return answer(res, 202, *jobs::getJob(*stored));  // a retry answers the first job
  const jobs::Job job = jobs::createJob(tenant, query, effort, budget->second);
  const std::string owner = jobs::rememberKey(tenant, key, job.job_id);
  if (owner != job.job_id) return answer(res, 202, *jobs::getJob(owner));  // a concurrent retry won the key
  jobs::enqueue(job.job_id);
  answer(res, 202, job);
}

void research_status(const httplib::Request& req, httplib::Response& res) {
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) return refuse(res, 401, "X-Tenant-Id is required");
  const auto job = jobs::getJob(req.matches[1]);
  if (!job || job->tenant != tenant) return refuse(res, 404, "no such job");  // another tenant's job does not exist here
  answer(res, 200, *job);
}

void register_routes(httplib::Server& svr) {
  svr.Post("/v1/research", start_research);
  svr.Get(R"(/v1/research/([\\w-]+))", research_status);
}
`,
    },
  },
  harness: {
    python: `from research import jobs

FACT = {"max_subagents": 1, "max_tool_calls": 10, "token_budget": 50000}
COMPARE = {"max_subagents": 4, "max_tool_calls": 60, "token_budget": 250000}
DEEP = {"max_subagents": 10, "max_tool_calls": 150, "token_budget": 1000000}
QUERY = "Compare the board composition of the five largest European banks"


def _api(ctx):
    return ctx.client(ctx.load("api").app)


async def _start(c, tenant="acme", key="k-1", **body):
    headers = {}
    if tenant is not None:
        headers["X-Tenant-Id"] = tenant
    if key is not None:
        headers["Idempotency-Key"] = key
    return await c.post("/v1/research", json={"query": QUERY, "effort": "compare", **body}, headers=headers)


def _queue(ctx):
    return ctx.redis.lrange("research:queue", 0, -1)


async def check_routes(ctx):
    async with _api(ctx) as c:
        r = await _start(c)
        assert r.status_code == 202, f"POST /v1/research answered {r.status_code}: {r.text}"
        job = r.json()
        assert job.get("status") == "queued" and job.get("job_id"), f"the 202 must carry the queued job, got {job}"
        assert _queue(ctx) == [job["job_id"]], f"research:queue holds {_queue(ctx)}: the job must be enqueued for the lead agent workers"
        s = await c.get(f"/v1/research/{job['job_id']}", headers={"X-Tenant-Id": "acme"})
    assert s.status_code == 200, f"GET /v1/research/{job['job_id']} answered {s.status_code}: {s.text}"
    assert s.json().get("job_id") == job["job_id"], f"the status route answered {s.json()}"


async def check_validate(ctx):
    async with _api(ctx) as c:
        r = await _start(c, tenant=None)
        assert r.status_code == 401, f"a request without X-Tenant-Id answered {r.status_code}, expected 401"
        r = await _start(c, key="k-2", effort="exhaustive")
        assert r.status_code == 400, f"an effort outside fact, compare and deep answered {r.status_code}, expected 400"
        r = await _start(c, key="k-6", effort="constructor")
        assert r.status_code == 400, f"the effort 'constructor' answered {r.status_code}, expected 400: only fact, compare and deep are efforts"
        r = await _start(c, key="k-3", query="é" * 4097)
        assert r.status_code == 413, f"a query of 8194 bytes (4097 characters of UTF-8) answered {r.status_code}, expected 413: the cap counts bytes"
        r = await _start(c, key="k-4", query="")
        assert r.status_code == 400, f"an empty query answered {r.status_code}, expected 400"
        assert _queue(ctx) == [], f"refused requests enqueued {_queue(ctx)}"
        r = await _start(c, key="k-5", query="q" * 8192)
    assert r.status_code == 202, f"a query of exactly 8192 bytes answered {r.status_code}: {r.text}"
    assert len(_queue(ctx)) == 1, f"research:queue holds {_queue(ctx)}, expected the one valid job"


async def check_budget_table(ctx):
    async with _api(ctx) as c:
        r = await _start(c, key="k-1", effort="fact", max_subagents=50, max_tool_calls=100000, token_budget=10**9)
        assert r.status_code == 202, f"POST /v1/research answered {r.status_code}: {r.text}"
        job = r.json()
        assert job.get("budget") == FACT, f"a fact job asking for 100000 tool calls got the budget {job.get('budget')}: the budget comes from EFFORT_BUDGETS, not the body"
        stored = jobs.get_job(job["job_id"])
        assert stored["budget"] == FACT, f"the stored job's budget is {stored['budget']}, expected {FACT}"
        deep = (await _start(c, key="k-2", effort="deep", max_subagents=1, max_tool_calls=3)).json()
        assert deep.get("budget") == DEEP, f"a deep job asking for 3 tool calls got {deep.get('budget')}, expected {DEEP}: a budget field in the body is ignored, larger or smaller"
        compare = (await _start(c, key="k-3")).json()
        assert compare.get("budget") == COMPARE, f"a compare job got {compare.get('budget')}, expected {COMPARE}"
        r = await c.post("/v1/research", json={"query": QUERY}, headers={"X-Tenant-Id": "acme", "Idempotency-Key": "k-4"})
    assert r.status_code == 202 and r.json().get("budget") == FACT, f"a request without an effort must get the fact budget, got {r.status_code} {r.text}"


async def check_idempotency_key(ctx):
    async with _api(ctx) as c:
        first = await _start(c, key="k-1")
        assert first.status_code == 202, f"the first start answered {first.status_code}: {first.text}"
        replay = await _start(c, key="k-1")
        assert replay.status_code == 202 and replay.json().get("job_id") == first.json()["job_id"], f"a retry with the same Idempotency-Key started {replay.json().get('job_id')}, expected the first job {first.json()['job_id']}"
        assert _queue(ctx) == [first.json()["job_id"]], f"research:queue holds {_queue(ctx)}: a retry must not enqueue a second job"
        stored = sorted(ctx.redis.keys("research:job-*"))
        assert stored == [f"research:{first.json()['job_id']}"], f"after a start and its retry Redis holds the jobs {stored}: a retry must find its job with job_for_key, not create another"
        # A concurrent retry with key k-9 records its job between this request's lookup and its own record.
        rival = jobs.create_job("acme", QUERY, "compare", COMPARE)["job_id"]
        probe = ctx.redis_after("research:idem:acme:k-9", lambda: ctx.redis.set("research:idem:acme:k-9", rival))
        lost = await _start(c, key="k-9")
        assert probe.fired, "the start with Idempotency-Key k-9 never looked the key up"
        assert lost.status_code == 202 and lost.json().get("job_id") == rival, f"a concurrent retry recorded {rival} under the key first, but the start answered {lost.status_code} {lost.text}: answer the job remember_key says the key belongs to"
        assert _queue(ctx) == [first.json()["job_id"]], f"research:queue holds {_queue(ctx)} after a start lost the key to a concurrent retry: enqueue only your own job, and only when the key is yours"
        other = await _start(c, tenant="beta", key="k-1")
        assert other.status_code == 202 and other.json().get("job_id") != first.json()["job_id"], "the same key from another tenant is another request: it must start its own job"
        none = await _start(c, key=None)
    assert none.status_code == 400, f"a start without Idempotency-Key answered {none.status_code}, expected 400"
    assert len(_queue(ctx)) == 2, f"research:queue holds {_queue(ctx)}, expected acme's job and beta's"


async def check_tenant_scope(ctx):
    async with _api(ctx) as c:
        job = (await _start(c)).json()
        path = f"/v1/research/{job['job_id']}"
        other = await c.get(path, headers={"X-Tenant-Id": "beta"})
        assert other.status_code == 404, f"tenant beta read acme's job: {other.status_code} {other.text}. Another tenant's job is 404"
        anonymous = await c.get(path)
        assert anonymous.status_code == 401, f"a status request without X-Tenant-Id answered {anonymous.status_code}, expected 401"
        own = await c.get(path, headers={"X-Tenant-Id": "acme"})
        assert own.status_code == 200 and own.json().get("job_id") == job["job_id"], f"acme must read its own job, got {own.status_code} {own.text}"
        missing = await c.get("/v1/research/job-999", headers={"X-Tenant-Id": "acme"})
    assert missing.status_code == 404, f"an unknown job answered {missing.status_code}, expected 404"
`,
    typescript: `const FACT = {max_subagents: 1, max_tool_calls: 10, token_budget: 50000};
const COMPARE = {max_subagents: 4, max_tool_calls: 60, token_budget: 250000};
const DEEP = {max_subagents: 10, max_tool_calls: 150, token_budget: 1000000};
const QUERY = 'Compare the board composition of the five largest European banks';

function api(ctx) {
  return {c: ctx.client(ctx.load('api').app), jobs: ctx.load('/support/research/jobs.ts')};
}

function start(c, {tenant = 'acme' as string | null, key = 'k-1' as string | null, ...body} = {}) {
  const headers: Record<string, string> = {};
  if (tenant !== null) headers['X-Tenant-Id'] = tenant;
  if (key !== null) headers['Idempotency-Key'] = key;
  return c.post('/v1/research', {json: {query: QUERY, effort: 'compare', ...body}, headers});
}

const queue = (ctx): string[] => ctx.redis.lrange('research:queue', 0, -1);

export async function check_routes(ctx) {
  const {c} = api(ctx);
  const r = await start(c);
  assert.equal(r.status, 202, \`POST /v1/research answered \${r.status}: \${r.text}\`);
  const job = r.json();
  assert(job.status === 'queued' && job.job_id, \`the 202 must carry the queued job, got \${r.text}\`);
  assert.deepStrictEqual(queue(ctx), [job.job_id], \`research:queue holds \${JSON.stringify(queue(ctx))}: the job must be enqueued for the lead agent workers\`);
  const s = await c.get(\`/v1/research/\${job.job_id}\`, {headers: {'X-Tenant-Id': 'acme'}});
  assert.equal(s.status, 200, \`GET /v1/research/\${job.job_id} answered \${s.status}: \${s.text}\`);
  assert.equal(s.json().job_id, job.job_id, \`the status route answered \${s.text}\`);
}

export async function check_validate(ctx) {
  const {c} = api(ctx);
  let r = await start(c, {tenant: null});
  assert.equal(r.status, 401, \`a request without X-Tenant-Id answered \${r.status}, expected 401\`);
  r = await start(c, {key: 'k-2', effort: 'exhaustive'});
  assert.equal(r.status, 400, \`an effort outside fact, compare and deep answered \${r.status}, expected 400\`);
  r = await start(c, {key: 'k-6', effort: 'constructor'});
  assert.equal(r.status, 400, \`the effort 'constructor' answered \${r.status}, expected 400: only fact, compare and deep are efforts\`);
  r = await start(c, {key: 'k-3', query: 'é'.repeat(4097)});
  assert.equal(r.status, 413, \`a query of 8194 bytes (4097 characters of UTF-8) answered \${r.status}, expected 413: the cap counts bytes\`);
  r = await start(c, {key: 'k-4', query: ''});
  assert.equal(r.status, 400, \`an empty query answered \${r.status}, expected 400\`);
  assert.deepStrictEqual(queue(ctx), [], \`refused requests enqueued \${JSON.stringify(queue(ctx))}\`);
  r = await start(c, {key: 'k-5', query: 'q'.repeat(8192)});
  assert.equal(r.status, 202, \`a query of exactly 8192 bytes answered \${r.status}: \${r.text}\`);
  assert.equal(queue(ctx).length, 1, \`research:queue holds \${JSON.stringify(queue(ctx))}, expected the one valid job\`);
}

export async function check_budget_table(ctx) {
  const {c, jobs} = api(ctx);
  let r = await start(c, {key: 'k-1', effort: 'fact', max_subagents: 50, max_tool_calls: 100000, token_budget: 1e9});
  assert.equal(r.status, 202, \`POST /v1/research answered \${r.status}: \${r.text}\`);
  const job = r.json();
  assert.deepStrictEqual(job.budget, FACT, \`a fact job asking for 100000 tool calls got the budget \${JSON.stringify(job.budget)}: the budget comes from EFFORT_BUDGETS, not the body\`);
  assert.deepStrictEqual((await jobs.getJob(job.job_id)).budget, FACT, 'the stored job must carry the fact budget');
  const deep = (await start(c, {key: 'k-2', effort: 'deep', max_subagents: 1, max_tool_calls: 3})).json();
  assert.deepStrictEqual(deep.budget, DEEP, \`a deep job asking for 3 tool calls got \${JSON.stringify(deep.budget)}: a budget field in the body is ignored, larger or smaller\`);
  assert.deepStrictEqual((await start(c, {key: 'k-3'})).json().budget, COMPARE, 'a compare job must get the compare budget');
  r = await c.post('/v1/research', {json: {query: QUERY}, headers: {'X-Tenant-Id': 'acme', 'Idempotency-Key': 'k-4'}});
  assert(r.status === 202 && JSON.stringify(r.json().budget) === JSON.stringify(FACT), \`a request without an effort must get the fact budget, got \${r.status} \${r.text}\`);
}

export async function check_idempotency_key(ctx) {
  const {c, jobs} = api(ctx);
  const first = await start(c, {key: 'k-1'});
  assert.equal(first.status, 202, \`the first start answered \${first.status}: \${first.text}\`);
  const replay = await start(c, {key: 'k-1'});
  assert(replay.status === 202 && replay.json().job_id === first.json().job_id, \`a retry with the same Idempotency-Key started \${replay.json().job_id}, expected the first job \${first.json().job_id}\`);
  assert.deepStrictEqual(queue(ctx), [first.json().job_id], \`research:queue holds \${JSON.stringify(queue(ctx))}: a retry must not enqueue a second job\`);
  const stored = ctx.redis.keys('research:job-*').sort();
  assert.deepStrictEqual(stored, [\`research:\${first.json().job_id}\`], \`after a start and its retry Redis holds the jobs \${JSON.stringify(stored)}: a retry must find its job with jobForKey, not create another\`);
  // A concurrent retry with key k-9 records its job between this request's lookup and its own record.
  const rival = (await jobs.createJob('acme', QUERY, 'compare', COMPARE)).job_id;
  const probe = ctx.redisAfter('research:idem:acme:k-9', () => ctx.redis.set('research:idem:acme:k-9', rival));
  const lost = await start(c, {key: 'k-9'});
  assert(probe.fired, 'the start with Idempotency-Key k-9 never looked the key up');
  assert(lost.status === 202 && lost.json().job_id === rival, \`a concurrent retry recorded \${rival} under the key first, but the start answered \${lost.status} \${lost.text}: answer the job rememberKey says the key belongs to\`);
  assert.deepStrictEqual(queue(ctx), [first.json().job_id], \`research:queue holds \${JSON.stringify(queue(ctx))} after a start lost the key to a concurrent retry: enqueue only your own job, and only when the key is yours\`);
  const other = await start(c, {tenant: 'beta', key: 'k-1'});
  assert(other.status === 202 && other.json().job_id !== first.json().job_id, 'the same key from another tenant is another request: it must start its own job');
  const none = await start(c, {key: null});
  assert.equal(none.status, 400, \`a start without Idempotency-Key answered \${none.status}, expected 400\`);
  assert.equal(queue(ctx).length, 2, \`research:queue holds \${JSON.stringify(queue(ctx))}, expected acme's job and beta's\`);
}

export async function check_tenant_scope(ctx) {
  const {c} = api(ctx);
  const job = (await start(c)).json();
  const path = \`/v1/research/\${job.job_id}\`;
  const other = await c.get(path, {headers: {'X-Tenant-Id': 'beta'}});
  assert.equal(other.status, 404, \`tenant beta read acme's job: \${other.status} \${other.text}. Another tenant's job is 404\`);
  const anonymous = await c.get(path);
  assert.equal(anonymous.status, 401, \`a status request without X-Tenant-Id answered \${anonymous.status}, expected 401\`);
  const own = await c.get(path, {headers: {'X-Tenant-Id': 'acme'}});
  assert(own.status === 200 && own.json().job_id === job.job_id, \`acme must read its own job, got \${own.status} \${own.text}\`);
  const missing = await c.get('/v1/research/job-999', {headers: {'X-Tenant-Id': 'acme'}});
  assert.equal(missing.status, 404, \`an unknown job answered \${missing.status}, expected 404\`);
}
`,
    go: `package main

import (
	"context"
	"net/http"
	"sort"
	"strings"

	"research/jobs"

	"leetbuild/harness"
)

const apiQuery = "Compare the board composition of the five largest European banks"

var (
	factBudget    = jobs.Budget{MaxSubagents: 1, MaxToolCalls: 10, TokenBudget: 50000}
	compareBudget = jobs.Budget{MaxSubagents: 4, MaxToolCalls: 60, TokenBudget: 250000}
	deepBudget    = jobs.Budget{MaxSubagents: 10, MaxToolCalls: 150, TokenBudget: 1000000}
)

func api(ctx *harness.Ctx) *harness.HTTP {
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

// start posts a research request; tenant or key "" leaves that header out.
func start(c *harness.HTTP, tenant, key string, body map[string]any) *harness.Response {
	payload := map[string]any{"query": apiQuery, "effort": "compare"}
	for k, v := range body {
		payload[k] = v
	}
	var headers []string
	if tenant != "" {
		headers = append(headers, "X-Tenant-Id", tenant)
	}
	if key != "" {
		headers = append(headers, "Idempotency-Key", key)
	}
	return c.Post("/v1/research", payload, headers...)
}

func jobOf(r *harness.Response) jobs.Job {
	var job jobs.Job
	r.Decode(&job)
	return job
}

func queue(ctx *harness.Ctx) []string { return ctx.Redis.LRange("research:queue", 0, -1) }

func CheckRoutes(ctx *harness.Ctx) {
	c := api(ctx)
	r := start(c, "acme", "k-1", nil)
	ctx.Equal(r.Status, 202, "POST /v1/research (%s)", r.Text())
	job := jobOf(r)
	ctx.Assert(job.Status == "queued" && job.JobID != "", "the 202 must carry the queued job, got %s", r.Text())
	ctx.Equal(queue(ctx), []string{job.JobID}, "the job must be enqueued for the lead agent workers; research:queue")
	s := c.Get("/v1/research/"+job.JobID, "X-Tenant-Id", "acme")
	ctx.Equal(s.Status, 200, "GET /v1/research/%s (%s)", job.JobID, s.Text())
	ctx.Equal(jobOf(s).JobID, job.JobID, "the status route's job_id")
}

func CheckValidate(ctx *harness.Ctx) {
	c := api(ctx)
	ctx.Equal(start(c, "", "k-1", nil).Status, 401, "a request without X-Tenant-Id")
	ctx.Equal(start(c, "acme", "k-2", map[string]any{"effort": "exhaustive"}).Status, 400, "an effort outside fact, compare and deep")
	ctx.Equal(start(c, "acme", "k-6", map[string]any{"effort": "constructor"}).Status, 400, "the effort 'constructor' (only fact, compare and deep are efforts)")
	ctx.Equal(start(c, "acme", "k-3", map[string]any{"query": strings.Repeat("é", 4097)}).Status, 413, "a query of 8194 bytes (4097 characters of UTF-8; the cap counts bytes)")
	ctx.Equal(start(c, "acme", "k-4", map[string]any{"query": ""}).Status, 400, "an empty query")
	ctx.Equal(len(queue(ctx)), 0, "refused requests must not enqueue a job; research:queue length")
	r := start(c, "acme", "k-5", map[string]any{"query": strings.Repeat("q", 8192)})
	ctx.Equal(r.Status, 202, "a query of exactly 8192 bytes (%s)", r.Text())
	ctx.Equal(len(queue(ctx)), 1, "the one valid job; research:queue length")
}

func CheckBudgetTable(ctx *harness.Ctx) {
	c := api(ctx)
	r := start(c, "acme", "k-1", map[string]any{"effort": "fact", "max_subagents": 50, "max_tool_calls": 100000, "token_budget": 1000000000})
	ctx.Equal(r.Status, 202, "POST /v1/research (%s)", r.Text())
	job := jobOf(r)
	ctx.Equal(job.Budget, factBudget, "a fact job asking for 100000 tool calls must get the fact budget: the budget comes from effortBudgets, not the body")
	ctx.Equal(jobs.GetJob(context.Background(), job.JobID).Budget, factBudget, "the stored job's budget")
	ctx.Equal(jobOf(start(c, "acme", "k-2", map[string]any{"effort": "deep", "max_subagents": 1, "max_tool_calls": 3})).Budget, deepBudget, "a deep job asking for 3 tool calls must get the deep budget: a budget field in the body is ignored, larger or smaller")
	ctx.Equal(jobOf(start(c, "acme", "k-3", nil)).Budget, compareBudget, "a compare job's budget")
	r = c.Post("/v1/research", map[string]any{"query": apiQuery}, "X-Tenant-Id", "acme", "Idempotency-Key", "k-4")
	ctx.Equal(r.Status, 202, "a request without an effort (%s)", r.Text())
	ctx.Equal(jobOf(r).Budget, factBudget, "a request without an effort must get the fact budget")
}

func CheckIdempotencyKey(ctx *harness.Ctx) {
	c := api(ctx)
	first := start(c, "acme", "k-1", nil)
	ctx.Equal(first.Status, 202, "the first start (%s)", first.Text())
	replay := start(c, "acme", "k-1", nil)
	ctx.Equal(jobOf(replay).JobID, jobOf(first).JobID, "a retry with the same Idempotency-Key must answer the first job; the job_id")
	ctx.Equal(queue(ctx), []string{jobOf(first).JobID}, "a retry must not enqueue a second job; research:queue")
	stored := ctx.Redis.Keys("research:job-*")
	sort.Strings(stored)
	ctx.Equal(stored, []string{jobs.JobKey(jobOf(first).JobID)}, "a retry must find its job with JobForKey, not create another; the job hashes after a start and its retry")
	// A concurrent retry with key k-9 records its job between this request's lookup and its own record.
	rival := jobs.CreateJob(context.Background(), "acme", apiQuery, "compare", compareBudget).JobID
	probe := ctx.Redis.After("research:idem:acme:k-9", func() any { return ctx.Redis.Set("research:idem:acme:k-9", rival) })
	lost := start(c, "acme", "k-9", nil)
	ctx.Assert(probe.Fired, "the start with Idempotency-Key k-9 never looked the key up")
	ctx.Assert(lost.Status == 202 && jobOf(lost).JobID == rival, "a concurrent retry recorded %s under the key first, but the start answered %d %s: answer the job RememberKey says the key belongs to", rival, lost.Status, lost.Text())
	ctx.Equal(queue(ctx), []string{jobOf(first).JobID}, "after a start lost the key to a concurrent retry, enqueue only your own job and only when the key is yours; research:queue")
	other := start(c, "beta", "k-1", nil)
	ctx.Assert(other.Status == 202 && jobOf(other).JobID != jobOf(first).JobID, "the same key from another tenant is another request: it must start its own job, got %s", other.Text())
	ctx.Equal(start(c, "acme", "", nil).Status, 400, "a start without Idempotency-Key")
	ctx.Equal(len(queue(ctx)), 2, "acme's job and beta's; research:queue length")
}

func CheckTenantScope(ctx *harness.Ctx) {
	c := api(ctx)
	job := jobOf(start(c, "acme", "k-1", nil))
	path := "/v1/research/" + job.JobID
	other := c.Get(path, "X-Tenant-Id", "beta")
	ctx.Equal(other.Status, 404, "tenant beta read acme's job (%s); another tenant's job is 404", other.Text())
	ctx.Equal(c.Get(path).Status, 401, "a status request without X-Tenant-Id")
	own := c.Get(path, "X-Tenant-Id", "acme")
	ctx.Assert(own.Status == 200 && jobOf(own).JobID == job.JobID, "acme must read its own job, got %d %s", own.Status, own.Text())
	ctx.Equal(c.Get("/v1/research/job-999", "X-Tenant-Id", "acme").Status, 404, "an unknown job")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <algorithm>
#include <string>
#include <vector>

#include "research/jobs.h"

namespace {

const std::string kQuery = "Compare the board composition of the five largest European banks";
const nlohmann::json kFact = {{"max_subagents", 1}, {"max_tool_calls", 10}, {"token_budget", 50000}};
const nlohmann::json kCompare = {{"max_subagents", 4}, {"max_tool_calls", 60}, {"token_budget", 250000}};
const nlohmann::json kDeep = {{"max_subagents", 10}, {"max_tool_calls", 150}, {"token_budget", 1000000}};

harness::HTTP api(harness::Ctx& ctx) {
  static httplib::Server* svr = nullptr;
  delete svr;
  svr = new httplib::Server;
  register_routes(*svr);
  return ctx.HTTP(*svr);
}

// A research request; an empty tenant or key leaves that header out.
harness::Response start(harness::HTTP& c, const std::string& tenant, const std::string& key, nlohmann::json body = nlohmann::json::object()) {
  nlohmann::json payload = {{"query", kQuery}, {"effort", "compare"}};
  payload.update(body);
  std::vector<std::string> headers = {"Content-Type", "application/json"};
  if (!tenant.empty()) headers.insert(headers.end(), {"X-Tenant-Id", tenant});
  if (!key.empty()) headers.insert(headers.end(), {"Idempotency-Key", key});
  return c.Send("POST", "/v1/research", payload.dump(), headers);
}

nlohmann::json jobOf(const harness::Response& r) {
  const auto job = nlohmann::json::parse(r.Text(), nullptr, false);
  return job.is_object() ? job : nlohmann::json::object();
}

std::vector<std::string> queue(harness::Ctx& ctx) { return ctx.Redis.LRange("research:queue", 0, -1); }

}  // namespace

void CheckRoutes(harness::Ctx& ctx) {
  auto c = api(ctx);
  const auto r = start(c, "acme", "k-1");
  ctx.Equal(r.Status, 202, "POST /v1/research (%s)", r.Text());
  const auto job = jobOf(r);
  const std::string job_id = job.value("job_id", "");
  ctx.Assert(job.value("status", "") == "queued" && !job_id.empty(), "the 202 must carry the queued job, got %s", r.Text());
  ctx.Equal(queue(ctx), {job_id}, "the job must be enqueued for the lead agent workers; research:queue");
  const auto s = c.Get("/v1/research/" + job_id, "X-Tenant-Id", "acme");
  ctx.Equal(s.Status, 200, "GET /v1/research/%s (%s)", job_id, s.Text());
  ctx.Equal(jobOf(s).value("job_id", ""), job_id, "the status route's job_id");
}

void CheckValidate(harness::Ctx& ctx) {
  auto c = api(ctx);
  ctx.Equal(start(c, "", "k-1").Status, 401, "a request without X-Tenant-Id");
  ctx.Equal(start(c, "acme", "k-2", {{"effort", "exhaustive"}}).Status, 400, "an effort outside fact, compare and deep");
  ctx.Equal(start(c, "acme", "k-6", {{"effort", "constructor"}}).Status, 400, "the effort 'constructor' (only fact, compare and deep are efforts)");
  std::string wide;
  for (int i = 0; i < 4097; i++) wide += "é";
  ctx.Equal(start(c, "acme", "k-3", {{"query", wide}}).Status, 413, "a query of 8194 bytes (4097 characters of UTF-8; the cap counts bytes)");
  ctx.Equal(start(c, "acme", "k-4", {{"query", ""}}).Status, 400, "an empty query");
  ctx.Equal(queue(ctx).size(), 0, "refused requests must not enqueue a job; research:queue length");
  const auto r = start(c, "acme", "k-5", {{"query", std::string(8192, 'q')}});
  ctx.Equal(r.Status, 202, "a query of exactly 8192 bytes (%s)", r.Text());
  ctx.Equal(queue(ctx).size(), 1, "the one valid job; research:queue length");
}

void CheckBudgetTable(harness::Ctx& ctx) {
  auto c = api(ctx);
  auto r = start(c, "acme", "k-1", {{"effort", "fact"}, {"max_subagents", 50}, {"max_tool_calls", 100000}, {"token_budget", 1000000000}});
  ctx.Equal(r.Status, 202, "POST /v1/research (%s)", r.Text());
  const auto job = jobOf(r);
  ctx.Equal(job.value("budget", nlohmann::json()), kFact, "a fact job asking for 100000 tool calls must get the fact budget: the budget comes from kEffortBudgets, not the body");
  ctx.Equal(jobs::getJob(job.value("job_id", ""))->budget.max_tool_calls, 10, "the stored job's max_tool_calls");
  ctx.Equal(jobOf(start(c, "acme", "k-2", {{"effort", "deep"}, {"max_subagents", 1}, {"max_tool_calls", 3}})).value("budget", nlohmann::json()), kDeep,
            "a deep job asking for 3 tool calls must get the deep budget: a budget field in the body is ignored, larger or smaller");
  ctx.Equal(jobOf(start(c, "acme", "k-3")).value("budget", nlohmann::json()), kCompare, "a compare job's budget");
  r = c.Post("/v1/research", nlohmann::json{{"query", kQuery}}.dump(), "Content-Type", "application/json", "X-Tenant-Id", "acme", "Idempotency-Key", "k-4");
  ctx.Equal(r.Status, 202, "a request without an effort (%s)", r.Text());
  ctx.Equal(jobOf(r).value("budget", nlohmann::json()), kFact, "a request without an effort must get the fact budget");
}

void CheckIdempotencyKey(harness::Ctx& ctx) {
  auto c = api(ctx);
  const auto first = start(c, "acme", "k-1");
  ctx.Equal(first.Status, 202, "the first start (%s)", first.Text());
  const std::string first_id = jobOf(first).value("job_id", "");
  const auto replay = start(c, "acme", "k-1");
  ctx.Equal(jobOf(replay).value("job_id", ""), first_id, "a retry with the same Idempotency-Key must answer the first job; the job_id");
  ctx.Equal(queue(ctx), {first_id}, "a retry must not enqueue a second job; research:queue");
  auto stored = ctx.Redis.Keys("research:job-*");
  std::sort(stored.begin(), stored.end());
  ctx.Equal(stored, {jobs::jobKey(first_id)}, "a retry must find its job with jobs::jobForKey, not create another; the job hashes after a start and its retry");
  // A concurrent retry with key k-9 records its job between this request's lookup and its own record.
  const std::string rival = jobs::createJob("acme", kQuery, "compare", {4, 60, 250000}).job_id;
  bool fired = false;
  ctx.Redis.After("research:idem:acme:k-9", [&ctx, &fired, rival] {
    fired = true;
    ctx.Redis.Set("research:idem:acme:k-9", rival);
  });
  const auto lost = start(c, "acme", "k-9");
  ctx.Assert(fired, "the start with Idempotency-Key k-9 never looked the key up");
  ctx.Assert(lost.Status == 202 && jobOf(lost).value("job_id", "") == rival,
             "a concurrent retry recorded %s under the key first, but the start answered %d %s: answer the job jobs::rememberKey says the key belongs to", rival, lost.Status, lost.Text());
  ctx.Equal(queue(ctx), {first_id}, "after a start lost the key to a concurrent retry, enqueue only your own job and only when the key is yours; research:queue");
  const auto other = start(c, "beta", "k-1");
  ctx.Assert(other.Status == 202 && jobOf(other).value("job_id", "") != first_id, "the same key from another tenant is another request: it must start its own job, got %s", other.Text());
  ctx.Equal(start(c, "acme", "").Status, 400, "a start without Idempotency-Key");
  ctx.Equal(queue(ctx).size(), 2, "acme's job and beta's; research:queue length");
}

void CheckTenantScope(harness::Ctx& ctx) {
  auto c = api(ctx);
  const std::string job_id = jobOf(start(c, "acme", "k-1")).value("job_id", "");
  const std::string path = "/v1/research/" + job_id;
  const auto other = c.Get(path, "X-Tenant-Id", "beta");
  ctx.Equal(other.Status, 404, "tenant beta read acme's job (%s); another tenant's job is 404", other.Text());
  ctx.Equal(c.Get(path).Status, 401, "a status request without X-Tenant-Id");
  const auto own = c.Get(path, "X-Tenant-Id", "acme");
  ctx.Assert(own.Status == 200 && jobOf(own).value("job_id", "") == job_id, "acme must read its own job, got %d %s", own.Status, own.Text());
  ctx.Equal(c.Get("/v1/research/job-999", "X-Tenant-Id", "acme").Status, 404, "an unknown job");
}
`,
  },
  hints: [
    'A client that timed out and retried has two jobs in `research:queue`, a body with `"max_tool_calls": 100000` gets exactly that budget, and tenant beta reads acme’s job by guessing its id.',
    'The handler copies the budget out of the body and never reads `Idempotency-Key`; it checks neither the tenant, the query’s size nor the effort, and the status route loads a job by id without comparing its tenant with the caller.',
    'Guard `X-Tenant-Id` (401), the key (400), the UTF-8 bytes against `MAX_QUERY_BYTES` (413) and the effort (400); budget = `EFFORT_BUDGETS[effort]`; `job_for_key` first, then `create_job`, `remember_key`, `enqueue`; 404 when `job["tenant"]` is not the caller.',
  ],
  debrief: `The budget is a server decision because the bill is the server's: a budget field in a request body is a request to spend, and the effort table turns three words into numbers the service can afford. The byte cap is the same rule at the input, counted in bytes because that is what a context window and a log line pay for. The idempotency record is keyed by tenant and key and claimed with \`SET NX\`, so a retry and a concurrent duplicate both land on one job. Answering 404 for another tenant's job keeps job ids from confirming that a job exists. Production services add a per-tenant limit on open jobs, a daily token budget over the per-job one, and a cancel route that stops the subagents.`,
};
