import type {Step} from '@/lib/types';

export const readStep: Step = {
  id: 'read',
  title: 'GET /v1/jobs/{id}: state a support engineer can trust',
  concept: 'http',
  guides: ['honest-reads', 'request-boundaries'],
  file: 'read',
  focus: ['client', 'api', 'redis', 'dlq'],
  task: `## Task

**Starting point.** The starter serves \`GET /v1/jobs/{id}\` with the header \`X-Tenant-Id\`: it reads
the job record (\`store.get_job\`), answers \`404\` for an unknown id and \`403\` for another tenant's job,
and otherwise returns \`{job_id, type, state, attempts, attempt_history, next_retry_at_ms,
dead_reason}\` straight from the record and \`store.attempt_history\`. It serves the demo and hides three
flaws.

**Failure mode the checks target.** A caller learns which job ids exist in another tenant; a job
whose worker died shows \`running\` long after its claim expired; a retry whose time has passed, because
the reaper is behind, shows a \`next_retry_at_ms\` in the past with nothing to say so.

- Another tenant's job answers exactly what an unknown id answers: \`404\`, same body.
- Reconcile the state with \`jobs:inflight\`: a \`running\` job whose score (its claim deadline) is at or
  before now is \`stalled\`.
- Add \`retry_overdue\`: true for a \`retrying\` job whose score (its retry time) is at or before now,
  false otherwise.`,
  sequence: {
    participants: ['Support engineer', 'Job API', 'Redis'],
    messages: [
      {from: 'Support engineer', to: 'Job API', label: 'GET /v1/jobs/{id} · X-Tenant-Id', kind: 'sync'},
      {from: 'Job API', to: 'Redis', label: 'get_job(id) · tenant matches? else 404', kind: 'sync'},
      {from: 'Job API', to: 'Redis', label: 'ZSCORE jobs:inflight id → deadline or retry time', kind: 'sync'},
      {
        from: 'Job API',
        to: 'Job API',
        label: 'running past deadline → stalled · retrying past due → retry_overdue',
        kind: 'sync',
      },
      {
        from: 'Job API',
        to: 'Support engineer',
        label: '200 {state, attempts, attempt_history, dead_reason, …}',
        kind: 'reply',
      },
    ],
  },
  checks: [
    {
      id: 'status-route',
      title: 'Serves GET /v1/jobs/{id} from the job record',
      detail:
        "A queued job answers `queued` with no attempts; a buried job answers `dead` with its `dead_reason` and an `attempt_history` holding each attempt's error.",
      match: {
        python: {all: [/@app\.get\(\s*["']\/v1\/jobs\/\{job_id\}["']/, /store\.attempt_history\(/]},
        typescript: {all: [/app\.get\(\s*['"]\/v1\/jobs\/:jobId['"]/, /store\.attemptHistory\(/]},
        go: {all: [/HandleFunc\(\s*"GET \/v1\/jobs\/\{id\}"/, /store\.AttemptHistory\(/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"jobs"\s*\/\s*Segment\s*\)/, /Store\.attemptHistory\(/]},
        cpp: {all: [/svr\.Get\(\s*R"\(\/v1\/jobs\//, /store::attemptHistory\(/]},
      },
    },
    {
      id: 'tenant-404',
      title: "Another tenant's job is 404, as an unknown id is",
      detail:
        "Tenant `t-2` reading `t-1`'s job gets the same status and body as for an id that never existed. The starter answers 403, which confirms the job exists.",
      match: {
        python: {all: [/job\[["']tenant["']\]\s*!=\s*tenant/], none: [/\b403\b/]},
        typescript: {all: [/job\.tenant\s*!==\s*tenant/], none: [/\b403\b/]},
        go: {all: [/job\.Tenant\s*!=\s*tenant/], none: [/StatusForbidden|\b403\b/]},
        scala: {all: [/\.tenant\s*(!=|==)\s*tenant/], none: [/Forbidden|\b403\b/]},
        cpp: {all: [/job->tenant\s*!=\s*tenant/], none: [/\b403\b/]},
      },
    },
    {
      id: 'stalled-claim',
      title: 'A claim past its deadline reads as stalled',
      detail:
        "A claimed job reads `running`; 61 s later, with nobody reaping it, the same read answers `stalled`. The starter reports the record's state, which still says `running`.",
      match: {
        python: {all: [/\.zscore\(/, /["']stalled["']/]},
        typescript: {all: [/\.zscore\(/, /['"]stalled['"]/]},
        go: {all: [/\.ZScore\(/, /"stalled"/]},
        scala: {all: [/jedis\.zscore\(/, /"stalled"/]},
        cpp: {all: [/redis\.zscore\(/, /"stalled"/]},
      },
    },
    {
      id: 'retry-overdue',
      title: 'A retry whose time has passed is flagged retry_overdue',
      detail:
        'A job retrying in 2 s reads `retrying` with `retry_overdue: false` and its `next_retry_at_ms`; 3 s later it still reads `retrying`, with `retry_overdue: true`. The starter has no such field.',
      match: {
        python: {all: [/["']retry_overdue["']/]},
        typescript: {all: [/retry_overdue/]},
        go: {all: [/"retry_overdue"/]},
        scala: {all: [/"retry_overdue"/]},
        cpp: {all: [/"retry_overdue"/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import redis
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from jobs import store  # get_job, attempt_history

INFLIGHT_KEY = "jobs:inflight"

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)


@app.get("/v1/jobs/{job_id}")
def read_job(job_id: str, request: Request) -> JSONResponse:
    # TODO: this starter has three flaws. The task says where to look; the checks say what must change.
    tenant = request.headers.get("x-tenant-id", "")
    job = store.get_job(job_id)
    if job is None:
        return JSONResponse({"error": "no such job"}, status_code=404)
    if job["tenant"] != tenant:
        return JSONResponse({"error": "this job belongs to another tenant"}, status_code=403)
    return JSONResponse(
        {
            "job_id": job_id,
            "type": job["type"],
            "state": job["state"],
            "attempts": job["attempts"],
            "attempt_history": store.attempt_history(job_id),
            "next_retry_at_ms": job["next_retry_at_ms"],
            "dead_reason": job["dead_reason"],
        }
    )
`,
      solution: `import time

import redis
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from jobs import store  # get_job, attempt_history

INFLIGHT_KEY = "jobs:inflight"

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)


@app.get("/v1/jobs/{job_id}")
def read_job(job_id: str, request: Request) -> JSONResponse:
    tenant = request.headers.get("x-tenant-id", "")
    job = store.get_job(job_id)
    # Another tenant's job answers exactly as a missing one: a job id is not a capability.
    if job is None or job["tenant"] != tenant:
        return JSONResponse({"error": "no such job"}, status_code=404)
    state = job["state"]
    retry_overdue = False
    # The record says what the last writer meant; jobs:inflight says whether it still holds.
    due = r.zscore(INFLIGHT_KEY, job_id)
    if due is not None and due <= time.time() * 1000:
        if state == "running":
            state = "stalled"
        elif state == "retrying":
            retry_overdue = True
    return JSONResponse(
        {
            "job_id": job_id,
            "type": job["type"],
            "state": state,
            "attempts": job["attempts"],
            "attempt_history": store.attempt_history(job_id),
            "next_retry_at_ms": job["next_retry_at_ms"],
            "retry_overdue": retry_overdue,
            "dead_reason": job["dead_reason"],
        }
    )
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';
import Redis from 'ioredis';

import * as store from 'jobs/store'; // getJob, attemptHistory

export const INFLIGHT_KEY = 'jobs:inflight';

export const app = Fastify();
const redis = new Redis({host: 'redis', port: 6379});

app.get('/v1/jobs/:jobId', async (request, reply) => {
  // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
  const {jobId} = request.params as {jobId: string};
  const tenant = request.headers['x-tenant-id'] ?? '';
  const job = await store.getJob(jobId);
  if (job === null) return reply.code(404).send({error: 'no such job'});
  if (job.tenant !== tenant) return reply.code(403).send({error: 'this job belongs to another tenant'});
  return {
    job_id: jobId,
    type: job.type,
    state: job.state,
    attempts: job.attempts,
    attempt_history: await store.attemptHistory(jobId),
    next_retry_at_ms: job.next_retry_at_ms,
    dead_reason: job.dead_reason,
  };
});
`,
      solution: `import Fastify from 'fastify';
import Redis from 'ioredis';

import * as store from 'jobs/store'; // getJob, attemptHistory

export const INFLIGHT_KEY = 'jobs:inflight';

export const app = Fastify();
const redis = new Redis({host: 'redis', port: 6379});

app.get('/v1/jobs/:jobId', async (request, reply) => {
  const {jobId} = request.params as {jobId: string};
  const tenant = request.headers['x-tenant-id'] ?? '';
  const job = await store.getJob(jobId);
  // Another tenant's job answers exactly as a missing one: a job id is not a capability.
  if (job === null || job.tenant !== tenant) return reply.code(404).send({error: 'no such job'});
  let state = job.state;
  let retryOverdue = false;
  // The record says what the last writer meant; jobs:inflight says whether it still holds.
  const due = await redis.zscore(INFLIGHT_KEY, jobId);
  if (due !== null && Number(due) <= Date.now()) {
    if (state === 'running') state = 'stalled';
    else if (state === 'retrying') retryOverdue = true;
  }
  return {
    job_id: jobId,
    type: job.type,
    state,
    attempts: job.attempts,
    attempt_history: await store.attemptHistory(jobId),
    next_retry_at_ms: job.next_retry_at_ms,
    retry_overdue: retryOverdue,
    dead_reason: job.dead_reason,
  };
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"net/http"

	"github.com/redis/go-redis/v9"

	"jobs/store" // store.GetJob, AttemptHistory
)

const inflightKey = "jobs:inflight"

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

// orNull is v, or JSON null for the zero value of a field that does not apply.
func orNull[T comparable](v T) any {
	var zero T
	if v == zero {
		return nil
	}
	return v
}

func readJob(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has three flaws. The task says where to look; the checks say what must change.
	jobID := r.PathValue("id")
	tenant := r.Header.Get("X-Tenant-Id")
	job := store.GetJob(r.Context(), jobID)
	if job == nil {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "no such job"})
		return
	}
	if job.Tenant != tenant {
		writeJSON(rw, http.StatusForbidden, map[string]string{"error": "this job belongs to another tenant"})
		return
	}
	writeJSON(rw, http.StatusOK, map[string]any{
		"job_id":           jobID,
		"type":             job.Type,
		"state":            job.State,
		"attempts":         job.Attempts,
		"attempt_history":  store.AttemptHistory(r.Context(), jobID),
		"next_retry_at_ms": orNull(job.NextRetryAtMs),
		"dead_reason":      orNull(job.DeadReason),
	})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/jobs/{id}", readJob)
}
`,
      solution: `package main

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/redis/go-redis/v9"

	"jobs/store" // store.GetJob, AttemptHistory
)

const inflightKey = "jobs:inflight"

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

// orNull is v, or JSON null for the zero value of a field that does not apply.
func orNull[T comparable](v T) any {
	var zero T
	if v == zero {
		return nil
	}
	return v
}

func readJob(rw http.ResponseWriter, r *http.Request) {
	jobID := r.PathValue("id")
	tenant := r.Header.Get("X-Tenant-Id")
	job := store.GetJob(r.Context(), jobID)
	// Another tenant's job answers exactly as a missing one: a job id is not a capability.
	if job == nil || job.Tenant != tenant {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "no such job"})
		return
	}
	state := job.State
	retryOverdue := false
	// The record says what the last writer meant; jobs:inflight says whether it still holds.
	if due, err := rdb.ZScore(r.Context(), inflightKey, jobID).Result(); err == nil && int64(due) <= time.Now().UnixMilli() {
		if state == "running" {
			state = "stalled"
		} else if state == "retrying" {
			retryOverdue = true
		}
	}
	writeJSON(rw, http.StatusOK, map[string]any{
		"job_id":           jobID,
		"type":             job.Type,
		"state":            state,
		"attempts":         job.Attempts,
		"attempt_history":  store.AttemptHistory(r.Context(), jobID),
		"next_retry_at_ms": orNull(job.NextRetryAtMs),
		"retry_overdue":    retryOverdue,
		"dead_reason":      orNull(job.DeadReason),
	})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/jobs/{id}", readJob)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import redis.clients.jedis.JedisPooled
import spray.json._

import jobs.Store // Store.getJob, attemptHistory

object Read {
  val InflightKey = "jobs:inflight"

  val jedis = new JedisPooled("redis", 6379)

  private def json(status: StatusCode, body: JsObject): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  private def history(jobId: String): JsArray = JsArray(Store.attemptHistory(jobId).toVector.map { a =>
    JsObject("attempt" -> JsNumber(a.attempt), "error" -> JsString(a.error), "at_ms" -> JsNumber(a.atMs))
  })

  val route: Route = path("v1" / "jobs" / Segment) { jobId =>
    get {
      optionalHeaderValueByName("X-Tenant-Id") { tenantHeader =>
        // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
        val tenant = tenantHeader.getOrElse("")
        Store.getJob(jobId) match {
          case None => complete(json(StatusCodes.NotFound, JsObject("error" -> JsString("no such job"))))
          case Some(job) if job.tenant != tenant =>
            complete(json(StatusCodes.Forbidden, JsObject("error" -> JsString("this job belongs to another tenant"))))
          case Some(job) =>
            complete(json(StatusCodes.OK, JsObject(
              "job_id" -> JsString(jobId),
              "type" -> JsString(job.jobType),
              "state" -> JsString(job.state),
              "attempts" -> JsNumber(job.attempts),
              "attempt_history" -> history(jobId),
              "next_retry_at_ms" -> job.nextRetryAtMs.map(JsNumber(_)).getOrElse(JsNull),
              "dead_reason" -> job.deadReason.map(JsString(_)).getOrElse(JsNull))))
        }
      }
    }
  }
}
`,
      solution: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import redis.clients.jedis.JedisPooled
import spray.json._

import jobs.Store // Store.getJob, attemptHistory

object Read {
  val InflightKey = "jobs:inflight"

  val jedis = new JedisPooled("redis", 6379)

  private def json(status: StatusCode, body: JsObject): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  private def history(jobId: String): JsArray = JsArray(Store.attemptHistory(jobId).toVector.map { a =>
    JsObject("attempt" -> JsNumber(a.attempt), "error" -> JsString(a.error), "at_ms" -> JsNumber(a.atMs))
  })

  val route: Route = path("v1" / "jobs" / Segment) { jobId =>
    get {
      optionalHeaderValueByName("X-Tenant-Id") { tenantHeader =>
        val tenant = tenantHeader.getOrElse("")
        Store.getJob(jobId).filter(_.tenant == tenant) match {
          // Another tenant's job answers exactly as a missing one: a job id is not a capability.
          case None => complete(json(StatusCodes.NotFound, JsObject("error" -> JsString("no such job"))))
          case Some(job) =>
            // The record says what the last writer meant; jobs:inflight says whether it still holds.
            val past = Option(jedis.zscore(InflightKey, jobId)).exists(_.doubleValue <= System.currentTimeMillis)
            val state = if (past && job.state == "running") "stalled" else job.state
            complete(json(StatusCodes.OK, JsObject(
              "job_id" -> JsString(jobId),
              "type" -> JsString(job.jobType),
              "state" -> JsString(state),
              "attempts" -> JsNumber(job.attempts),
              "attempt_history" -> history(jobId),
              "next_retry_at_ms" -> job.nextRetryAtMs.map(JsNumber(_)).getOrElse(JsNull),
              "retry_overdue" -> JsBoolean(past && job.state == "retrying"),
              "dead_reason" -> job.deadReason.map(JsString(_)).getOrElse(JsNull))))
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
#include <sw/redis++/redis++.h>

#include <string>

#include "jobs/store.h"  // store::getJob, attemptHistory

using json = nlohmann::json;

const std::string kInflightKey = "jobs:inflight";

sw::redis::Redis redis("tcp://redis:6379");

void reply_json(httplib::Response& res, int status, const json& body) {
  res.status = status;
  res.set_content(body.dump(), "application/json");
}

json history(const std::string& job_id) {
  json out = json::array();
  for (const auto& a : store::attemptHistory(job_id)) out.push_back({{"attempt", a.attempt}, {"error", a.error}, {"at_ms", a.at_ms}});
  return out;
}

void read_job(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
  const std::string job_id = req.matches[1];
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  const auto job = store::getJob(job_id);
  if (!job) return reply_json(res, 404, {{"error", "no such job"}});
  if (job->tenant != tenant) return reply_json(res, 403, {{"error", "this job belongs to another tenant"}});
  reply_json(res, 200, {{"job_id", job_id},
                        {"type", job->type},
                        {"state", job->state},
                        {"attempts", job->attempts},
                        {"attempt_history", history(job_id)},
                        {"next_retry_at_ms", job->next_retry_at_ms ? json(job->next_retry_at_ms) : json()},
                        {"dead_reason", job->dead_reason.empty() ? json() : json(job->dead_reason)}});
}

void register_routes(httplib::Server& svr) { svr.Get(R"(/v1/jobs/([\\w-]+))", read_job); }
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <string>

#include "jobs/store.h"  // store::getJob, attemptHistory

using json = nlohmann::json;

const std::string kInflightKey = "jobs:inflight";

sw::redis::Redis redis("tcp://redis:6379");

void reply_json(httplib::Response& res, int status, const json& body) {
  res.status = status;
  res.set_content(body.dump(), "application/json");
}

json history(const std::string& job_id) {
  json out = json::array();
  for (const auto& a : store::attemptHistory(job_id)) out.push_back({{"attempt", a.attempt}, {"error", a.error}, {"at_ms", a.at_ms}});
  return out;
}

void read_job(const httplib::Request& req, httplib::Response& res) {
  const std::string job_id = req.matches[1];
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  const auto job = store::getJob(job_id);
  // Another tenant's job answers exactly as a missing one: a job id is not a capability.
  if (!job || job->tenant != tenant) return reply_json(res, 404, {{"error", "no such job"}});
  std::string state = job->state;
  bool retry_overdue = false;
  // The record says what the last writer meant; jobs:inflight says whether it still holds.
  const auto due = redis.zscore(kInflightKey, job_id);
  if (due && *due <= static_cast<double>(store::nowMs())) {
    if (state == "running") state = "stalled";
    else if (state == "retrying") retry_overdue = true;
  }
  reply_json(res, 200, {{"job_id", job_id},
                        {"type", job->type},
                        {"state", state},
                        {"attempts", job->attempts},
                        {"attempt_history", history(job_id)},
                        {"next_retry_at_ms", job->next_retry_at_ms ? json(job->next_retry_at_ms) : json()},
                        {"retry_overdue", retry_overdue},
                        {"dead_reason", job->dead_reason.empty() ? json() : json(job->dead_reason)}});
}

void register_routes(httplib::Server& svr) { svr.Get(R"(/v1/jobs/([\\w-]+))", read_job); }
`,
    },
  },
  harness: {
    python: `import time

from jobs import queue, store

T1 = {"X-Tenant-Id": "t-1"}


def _api(ctx):
    return ctx.client(ctx.load("read").app)


def _job(job_id, tenant="t-1"):
    store.create_job(job_id, tenant, "email.send", {"to": "ada@example.com", "template": "welcome"})


async def check_status_route(ctx):
    _job("job-1")
    _job("job-2")
    assert queue.claim("w-1") == "job-1"
    store.begin_attempt("job-1")
    store.record_attempt("job-1", 1, "INVALID_ARGUMENT: template welcome-v9 does not exist")
    queue.bury("job-1", "permanent_error")
    async with _api(ctx) as c:
        queued = await c.get("/v1/jobs/job-2", headers=T1)
        dead = await c.get("/v1/jobs/job-1", headers=T1)
    assert queued.status_code == 200, f"GET /v1/jobs/job-2 answered {queued.status_code}: {queued.text}"
    body = queued.json()
    assert body.get("state") == "queued" and body.get("attempts") == 0 and body.get("attempt_history") == [], f"a queued job reads {body}"
    assert dead.status_code == 200, f"GET /v1/jobs/job-1 answered {dead.status_code}: {dead.text}"
    body = dead.json()
    assert body.get("state") == "dead" and body.get("dead_reason") == "permanent_error", f"a buried job must read dead with its dead_reason, got {body}"
    history = body.get("attempt_history") or []
    assert len(history) == 1 and history[0].get("error", "").startswith("INVALID_ARGUMENT"), f"the attempt history must carry each attempt's error, got {history}"


async def check_tenant_404(ctx):
    _job("job-1", "t-1")
    async with _api(ctx) as c:
        missing = await c.get("/v1/jobs/job-404", headers={"X-Tenant-Id": "t-2"})
        foreign = await c.get("/v1/jobs/job-1", headers={"X-Tenant-Id": "t-2"})
        own = await c.get("/v1/jobs/job-1", headers=T1)
    assert missing.status_code == 404, f"an unknown id answered {missing.status_code}"
    assert foreign.status_code == 404, f"t-2 reading t-1's job got {foreign.status_code} {foreign.text}: anything but the 404 an unknown id gets tells t-2 the job exists"
    assert foreign.text == missing.text, f"the 404 for another tenant's job ({foreign.text}) must be the 404 for an unknown id ({missing.text})"
    assert own.status_code == 200, f"t-1 reading its own job answered {own.status_code}"


async def check_stalled_claim(ctx):
    _job("job-1")
    assert queue.claim("w-1") == "job-1"
    async with _api(ctx) as c:
        fresh = await c.get("/v1/jobs/job-1", headers=T1)
        assert fresh.json().get("state") == "running", f"a job claimed a moment ago reads {fresh.json()}"
        ctx.clock.advance(61)  # the worker died; no reaper has run
        late = await c.get("/v1/jobs/job-1", headers=T1)
    state = late.json().get("state")
    assert state == "stalled", f"61 s after the claim, with its deadline past, the job reads {state!r}: compare the jobs:inflight score with now and report stalled"


async def check_retry_overdue(ctx):
    _job("job-1")
    assert queue.claim("w-1") == "job-1"
    due = int(time.time() * 1000) + 2000
    queue.retry_later("job-1", due)
    async with _api(ctx) as c:
        ahead = (await c.get("/v1/jobs/job-1", headers=T1)).json()
        assert ahead.get("state") == "retrying" and ahead.get("next_retry_at_ms") == due, f"a job retrying in 2 s reads {ahead}"
        assert ahead.get("retry_overdue") is False, f"with the retry still ahead the read must say retry_overdue false, got {ahead}"
        ctx.clock.advance(3)  # the reaper is behind
        late = (await c.get("/v1/jobs/job-1", headers=T1)).json()
    assert late.get("state") == "retrying", f"an overdue retry is still retrying, got {late}"
    assert late.get("retry_overdue") is True, f"3 s after its retry time the job reads {late}: a next_retry_at_ms in the past must come with retry_overdue true"
`,
    typescript: `const T1 = {'X-Tenant-Id': 't-1'};

async function setup(ctx) {
  return {c: ctx.client(ctx.load('read').app), queue: ctx.load('/support/jobs/queue.ts'), store: ctx.load('/support/jobs/store.ts')};
}

const job = (store, jobId: string, tenant = 't-1') => store.createJob(jobId, tenant, 'email.send', {to: 'ada@example.com', template: 'welcome'});

export async function check_status_route(ctx) {
  const {c, queue, store} = await setup(ctx);
  await job(store, 'job-1');
  await job(store, 'job-2');
  assert.equal(await queue.claim('w-1'), 'job-1');
  await store.beginAttempt('job-1');
  await store.recordAttempt('job-1', 1, 'INVALID_ARGUMENT: template welcome-v9 does not exist');
  await queue.bury('job-1', 'permanent_error');
  const queued = await c.get('/v1/jobs/job-2', {headers: T1});
  assert.equal(queued.status, 200, \`GET /v1/jobs/job-2 answered \${queued.status}: \${queued.text}\`);
  let body = queued.json();
  assert(body.state === 'queued' && body.attempts === 0 && body.attempt_history.length === 0, \`a queued job reads \${queued.text}\`);
  const dead = await c.get('/v1/jobs/job-1', {headers: T1});
  assert.equal(dead.status, 200, \`GET /v1/jobs/job-1 answered \${dead.status}: \${dead.text}\`);
  body = dead.json();
  assert(body.state === 'dead' && body.dead_reason === 'permanent_error', \`a buried job must read dead with its dead_reason, got \${dead.text}\`);
  const history = body.attempt_history ?? [];
  assert(history.length === 1 && String(history[0].error).startsWith('INVALID_ARGUMENT'), \`the attempt history must carry each attempt's error, got \${JSON.stringify(history)}\`);
}

export async function check_tenant_404(ctx) {
  const {c, store} = await setup(ctx);
  await job(store, 'job-1', 't-1');
  const missing = await c.get('/v1/jobs/job-404', {headers: {'X-Tenant-Id': 't-2'}});
  const foreign = await c.get('/v1/jobs/job-1', {headers: {'X-Tenant-Id': 't-2'}});
  const own = await c.get('/v1/jobs/job-1', {headers: T1});
  assert.equal(missing.status, 404, \`an unknown id answered \${missing.status}\`);
  assert.equal(foreign.status, 404, \`t-2 reading t-1's job got \${foreign.status} \${foreign.text}: anything but the 404 an unknown id gets tells t-2 the job exists\`);
  assert.equal(foreign.text, missing.text, \`the 404 for another tenant's job (\${foreign.text}) must be the 404 for an unknown id (\${missing.text})\`);
  assert.equal(own.status, 200, \`t-1 reading its own job answered \${own.status}\`);
}

export async function check_stalled_claim(ctx) {
  const {c, queue, store} = await setup(ctx);
  await job(store, 'job-1');
  assert.equal(await queue.claim('w-1'), 'job-1');
  const fresh = await c.get('/v1/jobs/job-1', {headers: T1});
  assert.equal(fresh.json().state, 'running', \`a job claimed a moment ago reads \${fresh.text}\`);
  ctx.clock.advance(61); // the worker died; no reaper has run
  const late = await c.get('/v1/jobs/job-1', {headers: T1});
  const state = late.json().state;
  assert.equal(state, 'stalled', \`61 s after the claim, with its deadline past, the job reads \${state}: compare the jobs:inflight score with now and report stalled\`);
}

export async function check_retry_overdue(ctx) {
  const {c, queue, store} = await setup(ctx);
  await job(store, 'job-1');
  assert.equal(await queue.claim('w-1'), 'job-1');
  const due = Date.now() + 2000;
  await queue.retryLater('job-1', due);
  const ahead = (await c.get('/v1/jobs/job-1', {headers: T1})).json();
  assert(ahead.state === 'retrying' && ahead.next_retry_at_ms === due, \`a job retrying in 2 s reads \${JSON.stringify(ahead)}\`);
  assert.equal(ahead.retry_overdue, false, \`with the retry still ahead the read must say retry_overdue false, got \${JSON.stringify(ahead)}\`);
  ctx.clock.advance(3); // the reaper is behind
  const late = (await c.get('/v1/jobs/job-1', {headers: T1})).json();
  assert.equal(late.state, 'retrying', \`an overdue retry is still retrying, got \${JSON.stringify(late)}\`);
  assert.equal(late.retry_overdue, true, \`3 s after its retry time the job reads \${JSON.stringify(late)}: a next_retry_at_ms in the past must come with retry_overdue true\`);
}
`,
    go: `package main

import (
	"context"
	"net/http"
	"strings"

	"jobs/queue"
	"jobs/store"

	"leetbuild/harness"
)

var readBg = context.Background()

type readBody struct {
	State          string           \`json:"state"\`
	Attempts       int              \`json:"attempts"\`
	AttemptHistory []map[string]any \`json:"attempt_history"\`
	NextRetryAtMs  *int64           \`json:"next_retry_at_ms"\`
	RetryOverdue   *bool            \`json:"retry_overdue"\`
	DeadReason     *string          \`json:"dead_reason"\`
}

func readAPI(ctx *harness.Ctx) *harness.HTTP {
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

func readJobFor(ctx *harness.Ctx, jobID, tenant string) {
	ctx.NoError(store.CreateJob(readBg, jobID, tenant, "email.send", map[string]any{"to": "ada@example.com", "template": "welcome"}), "CreateJob")
}

func readGet(ctx *harness.Ctx, c *harness.HTTP, jobID string) readBody {
	r := c.Get("/v1/jobs/"+jobID, "X-Tenant-Id", "t-1")
	ctx.Equal(r.Status, 200, "GET /v1/jobs/%s (%s)", jobID, r.Text())
	var body readBody
	r.Decode(&body)
	return body
}

func CheckStatusRoute(ctx *harness.Ctx) {
	readJobFor(ctx, "job-1", "t-1")
	readJobFor(ctx, "job-2", "t-1")
	got, _ := queue.Claim(readBg, "w-1")
	ctx.Equal(got, "job-1", "the harness's claim")
	store.BeginAttempt(readBg, "job-1")
	store.RecordAttempt(readBg, "job-1", 1, "INVALID_ARGUMENT: template welcome-v9 does not exist")
	queue.Bury(readBg, "job-1", "permanent_error")
	c := readAPI(ctx)
	queued := readGet(ctx, c, "job-2")
	ctx.Assert(queued.State == "queued" && queued.Attempts == 0 && len(queued.AttemptHistory) == 0, "a queued job reads %+v", queued)
	dead := readGet(ctx, c, "job-1")
	ctx.Assert(dead.State == "dead" && dead.DeadReason != nil && *dead.DeadReason == "permanent_error", "a buried job must read dead with its dead_reason, got %+v", dead)
	ctx.Assert(len(dead.AttemptHistory) == 1 && strings.HasPrefix(dead.AttemptHistory[0]["error"].(string), "INVALID_ARGUMENT"), "the attempt history must carry each attempt's error, got %v", dead.AttemptHistory)
}

func CheckTenant404(ctx *harness.Ctx) {
	readJobFor(ctx, "job-1", "t-1")
	c := readAPI(ctx)
	missing := c.Get("/v1/jobs/job-404", "X-Tenant-Id", "t-2")
	foreign := c.Get("/v1/jobs/job-1", "X-Tenant-Id", "t-2")
	own := c.Get("/v1/jobs/job-1", "X-Tenant-Id", "t-1")
	ctx.Equal(missing.Status, 404, "an unknown id")
	ctx.Assert(foreign.Status == 404, "t-2 reading t-1's job got %d %s: anything but the 404 an unknown id gets tells t-2 the job exists", foreign.Status, foreign.Text())
	ctx.Equal(foreign.Text(), missing.Text(), "the 404 for another tenant's job must be the 404 for an unknown id")
	ctx.Equal(own.Status, 200, "t-1 reading its own job")
}

func CheckStalledClaim(ctx *harness.Ctx) {
	readJobFor(ctx, "job-1", "t-1")
	got, _ := queue.Claim(readBg, "w-1")
	ctx.Equal(got, "job-1", "the harness's claim")
	c := readAPI(ctx)
	ctx.Equal(readGet(ctx, c, "job-1").State, "running", "a job claimed a moment ago; its state")
	ctx.Clock.Advance(61) // the worker died; no reaper has run
	state := readGet(ctx, c, "job-1").State
	ctx.Assert(state == "stalled", "61 s after the claim, with its deadline past, the job reads %q: compare the jobs:inflight score with now and report stalled", state)
}

func CheckRetryOverdue(ctx *harness.Ctx) {
	readJobFor(ctx, "job-1", "t-1")
	got, _ := queue.Claim(readBg, "w-1")
	ctx.Equal(got, "job-1", "the harness's claim")
	due := ctx.Clock.Now() + 2000
	ctx.NoError(queue.RetryLater(readBg, "job-1", due), "RetryLater")
	c := readAPI(ctx)
	ahead := readGet(ctx, c, "job-1")
	ctx.Assert(ahead.State == "retrying" && ahead.NextRetryAtMs != nil && *ahead.NextRetryAtMs == due, "a job retrying in 2 s reads %+v", ahead)
	ctx.Assert(ahead.RetryOverdue != nil && !*ahead.RetryOverdue, "with the retry still ahead the read must say retry_overdue false, got %+v", ahead)
	ctx.Clock.Advance(3) // the reaper is behind
	late := readGet(ctx, c, "job-1")
	ctx.Equal(late.State, "retrying", "an overdue retry is still retrying; the state")
	ctx.Assert(late.RetryOverdue != nil && *late.RetryOverdue, "3 s after its retry time the job reads %+v: a next_retry_at_ms in the past must come with retry_overdue true", late)
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <string>

#include "jobs/queue.h"
#include "jobs/store.h"

namespace {

harness::HTTP readAPI(harness::Ctx& ctx) {
  static httplib::Server* svr = nullptr;
  delete svr;
  svr = new httplib::Server;
  register_routes(*svr);
  return ctx.HTTP(*svr);
}

void readJobFor(const std::string& job_id, const std::string& tenant) {
  store::createJob(job_id, tenant, "email.send", nlohmann::json{{"to", "ada@example.com"}, {"template", "welcome"}});
}

nlohmann::json readGet(harness::Ctx& ctx, harness::HTTP& c, const std::string& job_id) {
  const auto r = c.Get("/v1/jobs/" + job_id, "X-Tenant-Id", "t-1");
  ctx.Equal(r.Status, 200, "GET /v1/jobs/%s (%s)", job_id, r.Text());
  return nlohmann::json::parse(r.Text(), nullptr, false);
}

}  // namespace

void CheckStatusRoute(harness::Ctx& ctx) {
  readJobFor("job-1", "t-1");
  readJobFor("job-2", "t-1");
  ctx.Equal(queue::claim("w-1").value_or(""), "job-1", "the harness's claim");
  store::beginAttempt("job-1");
  store::recordAttempt("job-1", 1, "INVALID_ARGUMENT: template welcome-v9 does not exist");
  queue::bury("job-1", "permanent_error");
  auto c = readAPI(ctx);
  const auto queued = readGet(ctx, c, "job-2");
  ctx.Assert(queued.value("state", "") == "queued" && queued.value("attempts", -1) == 0 && queued["attempt_history"].empty(), "a queued job reads %s", queued.dump());
  const auto dead = readGet(ctx, c, "job-1");
  ctx.Assert(dead.value("state", "") == "dead" && dead["dead_reason"] == "permanent_error", "a buried job must read dead with its dead_reason, got %s", dead.dump());
  const auto& history = dead["attempt_history"];
  ctx.Assert(history.size() == 1 && history[0].value("error", "").rfind("INVALID_ARGUMENT", 0) == 0, "the attempt history must carry each attempt's error, got %s", history.dump());
}

void CheckTenant404(harness::Ctx& ctx) {
  readJobFor("job-1", "t-1");
  auto c = readAPI(ctx);
  const auto missing = c.Get("/v1/jobs/job-404", "X-Tenant-Id", "t-2");
  const auto foreign = c.Get("/v1/jobs/job-1", "X-Tenant-Id", "t-2");
  const auto own = c.Get("/v1/jobs/job-1", "X-Tenant-Id", "t-1");
  ctx.Equal(missing.Status, 404, "an unknown id");
  ctx.Assert(foreign.Status == 404, "t-2 reading t-1's job got %d %s: anything but the 404 an unknown id gets tells t-2 the job exists", foreign.Status, foreign.Text());
  ctx.Equal(foreign.Text(), missing.Text(), "the 404 for another tenant's job must be the 404 for an unknown id");
  ctx.Equal(own.Status, 200, "t-1 reading its own job");
}

void CheckStalledClaim(harness::Ctx& ctx) {
  readJobFor("job-1", "t-1");
  ctx.Equal(queue::claim("w-1").value_or(""), "job-1", "the harness's claim");
  auto c = readAPI(ctx);
  ctx.Equal(readGet(ctx, c, "job-1").value("state", ""), "running", "a job claimed a moment ago; its state");
  ctx.Clock.Advance(61);  // the worker died; no reaper has run
  const std::string state = readGet(ctx, c, "job-1").value("state", "");
  ctx.Assert(state == "stalled", "61 s after the claim, with its deadline past, the job reads %q: compare the jobs:inflight score with now and report stalled", state);
}

void CheckRetryOverdue(harness::Ctx& ctx) {
  readJobFor("job-1", "t-1");
  ctx.Equal(queue::claim("w-1").value_or(""), "job-1", "the harness's claim");
  const long long due = ctx.Clock.Now() + 2000;
  queue::retryLater("job-1", due);
  auto c = readAPI(ctx);
  const auto ahead = readGet(ctx, c, "job-1");
  ctx.Assert(ahead.value("state", "") == "retrying" && ahead["next_retry_at_ms"] == due, "a job retrying in 2 s reads %s", ahead.dump());
  ctx.Assert(ahead.contains("retry_overdue") && ahead["retry_overdue"] == false, "with the retry still ahead the read must say retry_overdue false, got %s", ahead.dump());
  ctx.Clock.Advance(3);  // the reaper is behind
  const auto late = readGet(ctx, c, "job-1");
  ctx.Equal(late.value("state", ""), "retrying", "an overdue retry is still retrying; the state");
  ctx.Assert(late.contains("retry_overdue") && late["retry_overdue"] == true, "3 s after its retry time the job reads %s: a next_retry_at_ms in the past must come with retry_overdue true", late.dump());
}
`,
  },
  hints: [
    "Read t-1's job as tenant t-2: the 403 confirms it exists. Read a claimed job a minute later with no reaper running: still `running`. Read a retrying job after its retry time: nothing says it is late.",
    'The handler reports the job record as last written. Whether that still holds is in `jobs:inflight`, whose score is the claim deadline or the retry time, and the handler never reads it.',
    'Answer the same 404 when `job["tenant"] != tenant`; read `r.zscore(INFLIGHT_KEY, job_id)` and, when it is at or before now, report `running` as `stalled` and set `retry_overdue` for a `retrying` job.',
  ],
  debrief: `A status read is what someone trusts at three in the morning, so it reconciles the record with the structure that decides what happens next: the record says \`running\` because the last worker wrote it, and only the in-flight score can say that worker's time ran out. The same reading turns a past \`next_retry_at_ms\` into an explicit \`retry_overdue\`, which points at the reaper rather than the job. Another tenant's job answers the unknown-id 404, because a 403 turns guessed ids into a map of which jobs exist. Production status endpoints also show which worker holds the claim and since when, and keep the history after the job record expires.`,
};
