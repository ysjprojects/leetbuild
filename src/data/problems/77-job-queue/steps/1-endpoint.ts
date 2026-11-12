import type {Step} from '@/lib/types';

export const endpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/jobs: enqueue with a dedupe key that means something',
  concept: 'http',
  guides: ['request-boundaries', 'idempotent-requests', 'atomic-state'],
  file: 'api',
  focus: ['client', 'api', 'registry', 'redis'],
  task: `## Task

**Starting point.** The starter serves \`POST /v1/jobs\` with body \`{type, payload}\` and the headers
\`X-Tenant-Id\` and \`Dedupe-Key\`: it looks the key up with \`GET jobs:dedupe:{tenant}:{key}\` and
answers a hit with \`200 {job_id, duplicate: true}\`; otherwise it queues the job with
\`store.create_job\` (provided), writes the key with a plain \`SET\` and answers
\`202 {job_id, state: "queued"}\`. It serves the demo and hides three flaws.

**Failure mode the checks target.** A job type nobody registered and a payload its schema rejects
are queued and fail in a worker five attempts later; two replicas that receive one retried request
both queue it, and a key reserved once is never released.

- A type missing from \`store.JOB_TYPES\` is **400**, before anything is written.
- \`store.validate_payload(type, payload)\` returns the first path the schema rejects
  (\`payload.amount_cents\`); a rejected payload is **422** with that path in the body.
- Reserve the key with one \`SET … NX EX DEDUPE_WINDOW_S\` (86 400 s) before the job is created;
  when the reservation is refused, answer \`200\` with the job id the key holds.`,
  sequence: {
    participants: ['Client', 'Job API', 'Job registry', 'Redis'],
    messages: [
      {from: 'Client', to: 'Job API', label: 'POST /v1/jobs · X-Tenant-Id · Dedupe-Key', kind: 'sync'},
      {from: 'Job API', to: 'Job registry', label: 'type in JOB_TYPES? → 400', kind: 'sync'},
      {from: 'Job API', to: 'Job registry', label: 'validate_payload(type, payload) → 422 path', kind: 'sync'},
      {from: 'Job API', to: 'Redis', label: 'SET jobs:dedupe:{tenant}:{key} job_id NX EX 86400', kind: 'sync'},
      {from: 'Redis', to: 'Job API', label: 'taken → 200 {job_id of the key, duplicate}', kind: 'reply'},
      {from: 'Job API', to: 'Redis', label: 'create_job · HSET job:{id} · RPUSH jobs:queue', kind: 'sync'},
      {from: 'Job API', to: 'Client', label: '202 {job_id, state: "queued"}', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Queues a job on POST /v1/jobs',
      detail:
        'A valid `email.send` job answers **202** with its id; the job record is `queued` and the id is on `jobs:queue`.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/jobs["']/, /store\.create_job\(/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/jobs['"]/, /store\.createJob\(/]},
        go: {all: [/HandleFunc\(\s*"POST \/v1\/jobs"/, /store\.CreateJob\(/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"jobs"\s*\)/, /Store\.createJob\(/]},
        cpp: {all: [/svr\.Post\(\s*"\/v1\/jobs"/, /store::createJob\(/]},
      },
    },
    {
      id: 'job-type',
      title: 'An unregistered job type is 400 and nothing is queued',
      detail:
        'The type is looked up in the registry before the job is created: `emial.send` answers **400**, and neither a job record nor a queue entry exists afterwards. The starter queues whatever type it is given.',
      match: {
        python: {all: [/store\.JOB_TYPES\b/], order: [/store\.JOB_TYPES\b/, /store\.create_job\(/]},
        typescript: {all: [/store\.JOB_TYPES\b/], order: [/store\.JOB_TYPES\b/, /store\.createJob\(/]},
        go: {all: [/store\.JobTypes\[/], order: [/store\.JobTypes\[/, /store\.CreateJob\(/]},
        scala: {
          all: [/Store\.JobTypes\.(contains|get)\(|Store\.JobTypes\(/],
          order: [/Store\.JobTypes\.(contains|get)\(|Store\.JobTypes\(/, /Store\.createJob\(/],
        },
        cpp: {
          all: [/store::kJobTypes\.(count|find|contains)\(/],
          order: [/store::kJobTypes\.(count|find|contains)\(/, /store::createJob\(/],
        },
      },
    },
    {
      id: 'payload-schema',
      title: 'A payload the schema rejects is 422 naming the path',
      detail:
        'A missing field, a field of the wrong type and a field the closed schema does not list each answer **422** with the path `validate_payload` returns, and nothing is queued. The starter passes the payload straight to the queue.',
      match: {
        python: {
          all: [/store\.validate_payload\(/, /\b422\b/],
          order: [/store\.validate_payload\(/, /store\.create_job\(/],
        },
        typescript: {
          all: [/store\.validatePayload\(/, /\b422\b/],
          order: [/store\.validatePayload\(/, /store\.createJob\(/],
        },
        go: {
          all: [/store\.ValidatePayload\(/, /StatusUnprocessableEntity|\b422\b/],
          order: [/store\.ValidatePayload\(/, /store\.CreateJob\(/],
        },
        scala: {
          all: [/Store\.validatePayload\(/, /UnprocessableEntity|\b422\b/],
          order: [/Store\.validatePayload\(/, /Store\.createJob\(/],
        },
        cpp: {all: [/store::validatePayload\(/, /\b422\b/], order: [/store::validatePayload\(/, /store::createJob\(/]},
      },
    },
    {
      id: 'dedupe-window',
      title: 'Reserves the Dedupe-Key in one SET NX EX before the job exists',
      detail:
        'A replay answers **200** with the original job id; the key expires after `DEDUPE_WINDOW_S`; and when another replica reserves the key between two of your commands, its job id is answered and no second job is queued. The starter reads with `GET`, queues, then writes with a plain `SET`.',
      match: {
        python: {all: [/nx\s*=\s*True/, /ex\s*=\s*DEDUPE_WINDOW_S/], order: [/nx\s*=\s*True/, /store\.create_job\(/]},
        typescript: {all: [/['"]NX['"]/, /DEDUPE_WINDOW_S/], order: [/['"]NX['"]/, /store\.createJob\(/]},
        go: {all: [/\.SetNX\(/, /dedupeWindow/], order: [/\.SetNX\(/, /store\.CreateJob\(/]},
        scala: {all: [/\.nx\(\)/, /\.ex\(\s*DedupeWindowS\s*\)/], order: [/\.nx\(\)/, /Store\.createJob\(/]},
        cpp: {all: [/UpdateType::NOT_EXIST/, /kDedupeWindowS/], order: [/UpdateType::NOT_EXIST/, /store::createJob\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import redis
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from jobs import store  # JOB_TYPES, validate_payload, dedupe_key, new_job_id, create_job

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)


@app.post("/v1/jobs")
async def enqueue_job(request: Request) -> JSONResponse:
    # TODO: this starter has three flaws. The task says where to look; the checks say what must change.
    tenant = request.headers.get("x-tenant-id", "")
    if not tenant:
        return JSONResponse({"error": "X-Tenant-Id is required"}, status_code=400)
    body = await request.json()
    job_type = body.get("type", "")
    payload = body.get("payload")
    dedupe = request.headers.get("dedupe-key", "")
    if dedupe:
        existing = r.get(store.dedupe_key(tenant, dedupe))
        if existing is not None:
            return JSONResponse({"job_id": existing, "duplicate": True})
    job_id = store.new_job_id()
    store.create_job(job_id, tenant, job_type, payload)
    if dedupe:
        r.set(store.dedupe_key(tenant, dedupe), job_id)
    return JSONResponse({"job_id": job_id, "state": "queued"}, status_code=202)
`,
      solution: `import redis
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from jobs import store  # JOB_TYPES, validate_payload, dedupe_key, new_job_id, create_job

DEDUPE_WINDOW_S = 86_400

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)


@app.post("/v1/jobs")
async def enqueue_job(request: Request) -> JSONResponse:
    tenant = request.headers.get("x-tenant-id", "")
    if not tenant:
        return JSONResponse({"error": "X-Tenant-Id is required"}, status_code=400)
    body = await request.json()
    job_type = body.get("type", "")
    if job_type not in store.JOB_TYPES:
        return JSONResponse({"error": "unknown job type", "type": job_type}, status_code=400)
    payload = body.get("payload")
    path = store.validate_payload(job_type, payload)
    if path is not None:
        return JSONResponse({"error": "payload rejected", "path": path}, status_code=422)
    job_id = store.new_job_id()
    dedupe = request.headers.get("dedupe-key", "")
    if dedupe:
        key = store.dedupe_key(tenant, dedupe)
        # One command reserves the key for this job or reports it taken: no gap between read and write.
        if not r.set(key, job_id, nx=True, ex=DEDUPE_WINDOW_S):
            return JSONResponse({"job_id": r.get(key), "duplicate": True})
    store.create_job(job_id, tenant, job_type, payload)
    return JSONResponse({"job_id": job_id, "state": "queued"}, status_code=202)
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';
import Redis from 'ioredis';

import * as store from 'jobs/store'; // JOB_TYPES, validatePayload, dedupeKey, newJobId, createJob

export const app = Fastify();
const redis = new Redis({host: 'redis', port: 6379});

app.post('/v1/jobs', async (request, reply) => {
  // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(400).send({error: 'X-Tenant-Id is required'});
  const {type: jobType = '', payload} = request.body as {type?: string; payload?: Record<string, unknown>};
  const dedupe = request.headers['dedupe-key'];
  if (typeof dedupe === 'string' && dedupe !== '') {
    const existing = await redis.get(store.dedupeKey(tenant, dedupe));
    if (existing !== null) return {job_id: existing, duplicate: true};
  }
  const jobId = await store.newJobId();
  await store.createJob(jobId, tenant, jobType, payload ?? {});
  if (typeof dedupe === 'string' && dedupe !== '') await redis.set(store.dedupeKey(tenant, dedupe), jobId);
  return reply.code(202).send({job_id: jobId, state: 'queued'});
});
`,
      solution: `import Fastify from 'fastify';
import Redis from 'ioredis';

import * as store from 'jobs/store'; // JOB_TYPES, validatePayload, dedupeKey, newJobId, createJob

export const DEDUPE_WINDOW_S = 86_400;

export const app = Fastify();
const redis = new Redis({host: 'redis', port: 6379});

app.post('/v1/jobs', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(400).send({error: 'X-Tenant-Id is required'});
  const {type: jobType = '', payload} = request.body as {type?: string; payload?: Record<string, unknown>};
  if (!(jobType in store.JOB_TYPES)) return reply.code(400).send({error: 'unknown job type', type: jobType});
  const path = store.validatePayload(jobType, payload);
  if (path !== null) return reply.code(422).send({error: 'payload rejected', path});
  const jobId = await store.newJobId();
  const dedupe = request.headers['dedupe-key'];
  if (typeof dedupe === 'string' && dedupe !== '') {
    const key = store.dedupeKey(tenant, dedupe);
    // One command reserves the key for this job or reports it taken: no gap between read and write.
    const reserved = await redis.set(key, jobId, 'EX', DEDUPE_WINDOW_S, 'NX');
    if (reserved === null) return {job_id: await redis.get(key), duplicate: true};
  }
  await store.createJob(jobId, tenant, jobType, payload as Record<string, unknown>);
  return reply.code(202).send({job_id: jobId, state: 'queued'});
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"net/http"

	"github.com/redis/go-redis/v9"

	"jobs/store" // store.JobTypes, ValidatePayload, DedupeKey, NewJobID, CreateJob
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func enqueueJob(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has three flaws. The task says where to look; the checks say what must change.
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "X-Tenant-Id is required"})
		return
	}
	var body struct {
		Type    string         \`json:"type"\`
		Payload map[string]any \`json:"payload"\`
	}
	json.NewDecoder(r.Body).Decode(&body)
	dedupe := r.Header.Get("Dedupe-Key")
	if dedupe != "" {
		if existing, err := rdb.Get(r.Context(), store.DedupeKey(tenant, dedupe)).Result(); err == nil {
			writeJSON(rw, http.StatusOK, map[string]any{"job_id": existing, "duplicate": true})
			return
		}
	}
	jobID := store.NewJobID(r.Context())
	if err := store.CreateJob(r.Context(), jobID, tenant, body.Type, body.Payload); err != nil {
		http.Error(rw, err.Error(), http.StatusInternalServerError)
		return
	}
	if dedupe != "" {
		rdb.Set(r.Context(), store.DedupeKey(tenant, dedupe), jobID, 0)
	}
	writeJSON(rw, http.StatusAccepted, map[string]any{"job_id": jobID, "state": "queued"})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/jobs", enqueueJob)
}
`,
      solution: `package main

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/redis/go-redis/v9"

	"jobs/store" // store.JobTypes, ValidatePayload, DedupeKey, NewJobID, CreateJob
)

const dedupeWindow = 86400 * time.Second

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func enqueueJob(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "X-Tenant-Id is required"})
		return
	}
	var body struct {
		Type    string         \`json:"type"\`
		Payload map[string]any \`json:"payload"\`
	}
	json.NewDecoder(r.Body).Decode(&body)
	if _, ok := store.JobTypes[body.Type]; !ok {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "unknown job type", "type": body.Type})
		return
	}
	if path := store.ValidatePayload(body.Type, body.Payload); path != "" {
		writeJSON(rw, http.StatusUnprocessableEntity, map[string]string{"error": "payload rejected", "path": path})
		return
	}
	jobID := store.NewJobID(r.Context())
	if dedupe := r.Header.Get("Dedupe-Key"); dedupe != "" {
		key := store.DedupeKey(tenant, dedupe)
		// One command reserves the key for this job or reports it taken: no gap between read and write.
		reserved, err := rdb.SetNX(r.Context(), key, jobID, dedupeWindow).Result()
		if err != nil {
			http.Error(rw, err.Error(), http.StatusInternalServerError)
			return
		}
		if !reserved {
			writeJSON(rw, http.StatusOK, map[string]any{"job_id": rdb.Get(r.Context(), key).Val(), "duplicate": true})
			return
		}
	}
	if err := store.CreateJob(r.Context(), jobID, tenant, body.Type, body.Payload); err != nil {
		http.Error(rw, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(rw, http.StatusAccepted, map[string]any{"job_id": jobID, "state": "queued"})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/jobs", enqueueJob)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import redis.clients.jedis.JedisPooled
import spray.json._

import jobs.Store // Store.JobTypes, validatePayload, dedupeKey, newJobId, createJob

object Api {
  val jedis = new JedisPooled("redis", 6379)

  private def json(status: StatusCode, body: JsObject): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  val route: Route = path("v1" / "jobs") {
    post {
      (optionalHeaderValueByName("X-Tenant-Id") & optionalHeaderValueByName("Dedupe-Key")) { (tenantHeader, dedupeHeader) =>
        entity(as[String]) { raw =>
          // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
          val tenant = tenantHeader.getOrElse("")
          if (tenant.isEmpty) complete(json(StatusCodes.BadRequest, JsObject("error" -> JsString("X-Tenant-Id is required"))))
          else {
            val body = raw.parseJson.asJsObject.fields
            val jobType = body.get("type").collect { case JsString(s) => s }.getOrElse("")
            val payload = body.get("payload").collect { case o: JsObject => o }.getOrElse(JsObject.empty)
            val dedupe = dedupeHeader.filter(_.nonEmpty)
            dedupe.flatMap(key => Option(jedis.get(Store.dedupeKey(tenant, key)))) match {
              case Some(existing) => complete(json(StatusCodes.OK, JsObject("job_id" -> JsString(existing), "duplicate" -> JsTrue)))
              case None =>
                val jobId = Store.newJobId()
                Store.createJob(jobId, tenant, jobType, payload)
                dedupe.foreach(key => jedis.set(Store.dedupeKey(tenant, key), jobId))
                complete(json(StatusCodes.Accepted, JsObject("job_id" -> JsString(jobId), "state" -> JsString("queued"))))
            }
          }
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
import redis.clients.jedis.params.SetParams
import spray.json._

import jobs.Store // Store.JobTypes, validatePayload, dedupeKey, newJobId, createJob

object Api {
  val DedupeWindowS = 86400L

  val jedis = new JedisPooled("redis", 6379)

  private def json(status: StatusCode, body: JsObject): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  val route: Route = path("v1" / "jobs") {
    post {
      (optionalHeaderValueByName("X-Tenant-Id") & optionalHeaderValueByName("Dedupe-Key")) { (tenantHeader, dedupeHeader) =>
        entity(as[String]) { raw =>
          val tenant = tenantHeader.getOrElse("")
          val body = raw.parseJson.asJsObject.fields
          val jobType = body.get("type").collect { case JsString(s) => s }.getOrElse("")
          val payload = body.getOrElse("payload", JsNull)
          if (tenant.isEmpty) complete(json(StatusCodes.BadRequest, JsObject("error" -> JsString("X-Tenant-Id is required"))))
          else if (!Store.JobTypes.contains(jobType))
            complete(json(StatusCodes.BadRequest, JsObject("error" -> JsString("unknown job type"), "type" -> JsString(jobType))))
          else
            Store.validatePayload(jobType, payload) match {
              case Some(path) => complete(json(StatusCodes.UnprocessableEntity, JsObject("error" -> JsString("payload rejected"), "path" -> JsString(path))))
              case None =>
                val jobId = Store.newJobId()
                // One command reserves the key for this job or reports it taken: no gap between read and write.
                val taken = dedupeHeader.filter(_.nonEmpty).map(key => Store.dedupeKey(tenant, key)).flatMap { key =>
                  if (jedis.set(key, jobId, SetParams.setParams().nx().ex(DedupeWindowS)) == null) Some(jedis.get(key)) else None
                }
                taken match {
                  case Some(existing) => complete(json(StatusCodes.OK, JsObject("job_id" -> JsString(existing), "duplicate" -> JsTrue)))
                  case None =>
                    Store.createJob(jobId, tenant, jobType, payload.asJsObject)
                    complete(json(StatusCodes.Accepted, JsObject("job_id" -> JsString(jobId), "state" -> JsString("queued"))))
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
#include <sw/redis++/redis++.h>

#include <string>

#include "jobs/store.h"  // store::kJobTypes, validatePayload, dedupeKey, newJobId, createJob

using json = nlohmann::json;

sw::redis::Redis redis("tcp://redis:6379");

void reply_json(httplib::Response& res, int status, const json& body) {
  res.status = status;
  res.set_content(body.dump(), "application/json");
}

void enqueue_job(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) return reply_json(res, 400, {{"error", "X-Tenant-Id is required"}});
  const json body = json::parse(req.body, nullptr, false);
  const std::string job_type = body.is_object() ? body.value("type", "") : "";
  const json payload = body.is_object() && body.contains("payload") ? body["payload"] : json::object();
  const std::string dedupe = req.get_header_value("Dedupe-Key");
  if (!dedupe.empty()) {
    if (const auto existing = redis.get(store::dedupeKey(tenant, dedupe))) {
      return reply_json(res, 200, {{"job_id", *existing}, {"duplicate", true}});
    }
  }
  const std::string job_id = store::newJobId();
  store::createJob(job_id, tenant, job_type, payload);
  if (!dedupe.empty()) redis.set(store::dedupeKey(tenant, dedupe), job_id);
  reply_json(res, 202, {{"job_id", job_id}, {"state", "queued"}});
}

void register_routes(httplib::Server& svr) { svr.Post("/v1/jobs", enqueue_job); }
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <chrono>
#include <string>

#include "jobs/store.h"  // store::kJobTypes, validatePayload, dedupeKey, newJobId, createJob

using json = nlohmann::json;

constexpr long kDedupeWindowS = 86400;

sw::redis::Redis redis("tcp://redis:6379");

void reply_json(httplib::Response& res, int status, const json& body) {
  res.status = status;
  res.set_content(body.dump(), "application/json");
}

void enqueue_job(const httplib::Request& req, httplib::Response& res) {
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) return reply_json(res, 400, {{"error", "X-Tenant-Id is required"}});
  const json body = json::parse(req.body, nullptr, false);
  const std::string job_type = body.is_object() ? body.value("type", "") : "";
  if (store::kJobTypes.count(job_type) == 0) return reply_json(res, 400, {{"error", "unknown job type"}, {"type", job_type}});
  const json payload = body.is_object() && body.contains("payload") ? body["payload"] : json();
  const std::string path = store::validatePayload(job_type, payload);
  if (!path.empty()) return reply_json(res, 422, {{"error", "payload rejected"}, {"path", path}});
  const std::string job_id = store::newJobId();
  const std::string dedupe = req.get_header_value("Dedupe-Key");
  if (!dedupe.empty()) {
    const std::string key = store::dedupeKey(tenant, dedupe);
    // One command reserves the key for this job or reports it taken: no gap between read and write.
    if (!redis.set(key, job_id, std::chrono::seconds(kDedupeWindowS), sw::redis::UpdateType::NOT_EXIST)) {
      return reply_json(res, 200, {{"job_id", redis.get(key).value_or("")}, {"duplicate", true}});
    }
  }
  store::createJob(job_id, tenant, job_type, payload);
  reply_json(res, 202, {{"job_id", job_id}, {"state", "queued"}});
}

void register_routes(httplib::Server& svr) { svr.Post("/v1/jobs", enqueue_job); }
`,
    },
  },
  harness: {
    python: `from jobs import store

TENANT = {"X-Tenant-Id": "t-1"}
EMAIL = {"type": "email.send", "payload": {"to": "ada@example.com", "template": "welcome"}}


def _api(ctx):
    return ctx.client(ctx.load("api").app)


def _queued(ctx):
    return ctx.redis.lrange("jobs:queue", 0, -1)


async def check_route(ctx):
    async with _api(ctx) as c:
        r = await c.post("/v1/jobs", json=EMAIL, headers=TENANT)
    assert r.status_code == 202, f"POST /v1/jobs answered {r.status_code}: {r.text}"
    job_id = r.json().get("job_id")
    assert job_id, f"the 202 must carry the job id, got {r.text}"
    job = store.get_job(job_id)
    assert job is not None and job["state"] == "queued" and job["tenant"] == "t-1", f"the job record of {job_id} is {job}"
    assert _queued(ctx) == [job_id], f"jobs:queue holds {_queued(ctx)}, expected [{job_id!r}]"


async def check_job_type(ctx):
    async with _api(ctx) as c:
        r = await c.post("/v1/jobs", json={"type": "emial.send", "payload": EMAIL["payload"]}, headers=TENANT)
        assert r.status_code == 400, f"the unregistered type emial.send answered {r.status_code}, expected 400: no worker runs a type the registry does not know"
        assert _queued(ctx) == [], f"an unregistered job type was queued: jobs:queue holds {_queued(ctx)}"
        assert ctx.redis.keys("job:*") == [], f"an unregistered job type left a job record: {ctx.redis.keys('job:*')}"
        r = await c.post("/v1/jobs", json=EMAIL, headers=TENANT)
    assert r.status_code == 202, f"a registered type answered {r.status_code}: {r.text}"


async def check_payload_schema(ctx):
    cases = [
        ({"invoice_id": "inv-7"}, "payload.amount_cents", "a payload missing amount_cents"),
        ({"invoice_id": "inv-7", "amount_cents": "1200"}, "payload.amount_cents", "an amount sent as a string"),
        ({"invoice_id": "inv-7", "amount_cents": 1200, "card_number": "4242"}, "payload.card_number", "a field the schema does not list"),
    ]
    async with _api(ctx) as c:
        for payload, path, what in cases:
            r = await c.post("/v1/jobs", json={"type": "invoice.charge", "payload": payload}, headers=TENANT)
            assert r.status_code == 422, f"{what} answered {r.status_code}, expected 422: the job would fail in a worker five times instead"
            assert path in r.text, f"the 422 for {what} must name {path}, got {r.text}"
        assert _queued(ctx) == [], f"a rejected payload was queued: jobs:queue holds {_queued(ctx)}"
        r = await c.post("/v1/jobs", json={"type": "invoice.charge", "payload": {"invoice_id": "inv-7", "amount_cents": 1200}}, headers=TENANT)
    assert r.status_code == 202, f"a payload that fits the schema answered {r.status_code}: {r.text}"


async def check_dedupe_window(ctx):
    headers = {**TENANT, "Dedupe-Key": "welcome-ada"}
    key = store.dedupe_key("t-1", "welcome-ada")
    async with _api(ctx) as c:
        first = await c.post("/v1/jobs", json=EMAIL, headers=headers)
        assert first.status_code == 202, f"the first POST answered {first.status_code}: {first.text}"
        original = first.json()["job_id"]
        replay = await c.post("/v1/jobs", json=EMAIL, headers=headers)
        assert replay.status_code == 200 and replay.json().get("job_id") == original, f"a replayed Dedupe-Key must answer 200 with the original job id {original}, got {replay.status_code} {replay.text}"
        assert len(_queued(ctx)) == 1, f"a replay queued a second job: jobs:queue holds {_queued(ctx)}"
        ttl = ctx.redis.ttl(key)
        assert 0 < ttl <= 86400, f"{key} has TTL {ttl}: the reservation must expire after DEDUPE_WINDOW_S (86400 s), not hold the key forever"
        ctx.clock.advance(86401)
        later = await c.post("/v1/jobs", json=EMAIL, headers=headers)
        assert later.status_code == 202 and later.json().get("job_id") != original, f"a day later the same key must queue a new job, got {later.status_code} {later.text}"
        race = store.dedupe_key("t-1", "invoice-7")
        # Another replica, handling the same retried request, reserves the key right after this request's first command on it.
        probe = ctx.redis_after(race, lambda: ctx.redis.set(race, "job-other", nx=True, ex=86400))
        before = len(_queued(ctx))
        r = await c.post("/v1/jobs", json=EMAIL, headers={**TENANT, "Dedupe-Key": "invoice-7"})
    assert probe.fired, "the request never touched the Dedupe-Key's reservation"
    if probe.result:
        assert r.json().get("job_id") == "job-other" and len(_queued(ctx)) == before, f"another replica reserved the key between your read and your write; you queued {r.json().get('job_id')} anyway and the key now holds {ctx.redis.get(race)}: reserve with one SET NX EX before the job exists"
    else:
        assert ctx.redis.get(race) == r.json().get("job_id") and len(_queued(ctx)) == before + 1, f"your request reserved the key, so it must queue its job: the key holds {ctx.redis.get(race)}, the answer was {r.text}"
`,
    typescript: `const TENANT = {'X-Tenant-Id': 't-1'};
const EMAIL = {type: 'email.send', payload: {to: 'ada@example.com', template: 'welcome'}};

function api(ctx) {
  return {c: ctx.client(ctx.load('api').app), store: ctx.load('/support/jobs/store.ts')};
}

const queued = (ctx): string[] => ctx.redis.lrange('jobs:queue', 0, -1);

export async function check_route(ctx) {
  const {c, store} = api(ctx);
  const r = await c.post('/v1/jobs', {json: EMAIL, headers: TENANT});
  assert.equal(r.status, 202, \`POST /v1/jobs answered \${r.status}: \${r.text}\`);
  const jobId = r.json().job_id;
  assert(jobId, \`the 202 must carry the job id, got \${r.text}\`);
  const job = await store.getJob(jobId);
  assert(job !== null && job.state === 'queued' && job.tenant === 't-1', \`the job record of \${jobId} is \${JSON.stringify(job)}\`);
  assert.deepEqual(queued(ctx), [jobId], \`jobs:queue holds \${JSON.stringify(queued(ctx))}\`);
}

export async function check_job_type(ctx) {
  const {c} = api(ctx);
  let r = await c.post('/v1/jobs', {json: {type: 'emial.send', payload: EMAIL.payload}, headers: TENANT});
  assert.equal(r.status, 400, \`the unregistered type emial.send answered \${r.status}, expected 400: no worker runs a type the registry does not know\`);
  assert.deepEqual(queued(ctx), [], \`an unregistered job type was queued: jobs:queue holds \${JSON.stringify(queued(ctx))}\`);
  assert.deepEqual(ctx.redis.keys('job:*'), [], \`an unregistered job type left a job record: \${JSON.stringify(ctx.redis.keys('job:*'))}\`);
  r = await c.post('/v1/jobs', {json: EMAIL, headers: TENANT});
  assert.equal(r.status, 202, \`a registered type answered \${r.status}: \${r.text}\`);
}

export async function check_payload_schema(ctx) {
  const {c} = api(ctx);
  const cases: [Record<string, unknown>, string, string][] = [
    [{invoice_id: 'inv-7'}, 'payload.amount_cents', 'a payload missing amount_cents'],
    [{invoice_id: 'inv-7', amount_cents: '1200'}, 'payload.amount_cents', 'an amount sent as a string'],
    [{invoice_id: 'inv-7', amount_cents: 1200, card_number: '4242'}, 'payload.card_number', 'a field the schema does not list'],
  ];
  for (const [payload, path, what] of cases) {
    const r = await c.post('/v1/jobs', {json: {type: 'invoice.charge', payload}, headers: TENANT});
    assert.equal(r.status, 422, \`\${what} answered \${r.status}, expected 422: the job would fail in a worker five times instead\`);
    assert(r.text.includes(path), \`the 422 for \${what} must name \${path}, got \${r.text}\`);
  }
  assert.deepEqual(queued(ctx), [], \`a rejected payload was queued: jobs:queue holds \${JSON.stringify(queued(ctx))}\`);
  const r = await c.post('/v1/jobs', {json: {type: 'invoice.charge', payload: {invoice_id: 'inv-7', amount_cents: 1200}}, headers: TENANT});
  assert.equal(r.status, 202, \`a payload that fits the schema answered \${r.status}: \${r.text}\`);
}

export async function check_dedupe_window(ctx) {
  const {c, store} = api(ctx);
  const headers = {...TENANT, 'Dedupe-Key': 'welcome-ada'};
  const key = store.dedupeKey('t-1', 'welcome-ada');
  const first = await c.post('/v1/jobs', {json: EMAIL, headers});
  assert.equal(first.status, 202, \`the first POST answered \${first.status}: \${first.text}\`);
  const original = first.json().job_id;
  const replay = await c.post('/v1/jobs', {json: EMAIL, headers});
  assert(replay.status === 200 && replay.json().job_id === original, \`a replayed Dedupe-Key must answer 200 with the original job id \${original}, got \${replay.status} \${replay.text}\`);
  assert.equal(queued(ctx).length, 1, \`a replay queued a second job: jobs:queue holds \${JSON.stringify(queued(ctx))}\`);
  const ttl = ctx.redis.ttl(key);
  assert(ttl > 0 && ttl <= 86400, \`\${key} has TTL \${ttl}: the reservation must expire after DEDUPE_WINDOW_S (86400 s), not hold the key forever\`);
  ctx.clock.advance(86401);
  const later = await c.post('/v1/jobs', {json: EMAIL, headers});
  assert(later.status === 202 && later.json().job_id !== original, \`a day later the same key must queue a new job, got \${later.status} \${later.text}\`);
  const race = store.dedupeKey('t-1', 'invoice-7');
  // Another replica, handling the same retried request, reserves the key right after this request's first command on it.
  const probe = ctx.redisAfter(race, () => ctx.redis.set(race, 'job-other', 'NX', 'EX', 86400));
  const before = queued(ctx).length;
  const r = await c.post('/v1/jobs', {json: EMAIL, headers: {...TENANT, 'Dedupe-Key': 'invoice-7'}});
  assert(probe.fired, "the request never touched the Dedupe-Key's reservation");
  if (probe.result === 'OK') {
    assert(r.json().job_id === 'job-other' && queued(ctx).length === before, \`another replica reserved the key between your read and your write; you queued \${r.json().job_id} anyway and the key now holds \${ctx.redis.get(race)}: reserve with one SET NX EX before the job exists\`);
  } else {
    assert(ctx.redis.get(race) === r.json().job_id && queued(ctx).length === before + 1, \`your request reserved the key, so it must queue its job: the key holds \${ctx.redis.get(race)}, the answer was \${r.text}\`);
  }
}
`,
    go: `package main

import (
	"context"
	"net/http"

	"jobs/store"

	"leetbuild/harness"
)

var (
	tenantHeader = []string{"X-Tenant-Id", "t-1"}
	emailJob     = map[string]any{"type": "email.send", "payload": map[string]any{"to": "ada@example.com", "template": "welcome"}}
)

func api(ctx *harness.Ctx) *harness.HTTP {
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

func jobIDOf(r *harness.Response) string {
	var body struct {
		JobID string \`json:"job_id"\`
	}
	r.Decode(&body)
	return body.JobID
}

func CheckRoute(ctx *harness.Ctx) {
	c := api(ctx)
	r := c.Post("/v1/jobs", emailJob, tenantHeader...)
	ctx.Equal(r.Status, 202, "POST /v1/jobs (%s)", r.Text())
	jobID := jobIDOf(r)
	ctx.Assert(jobID != "", "the 202 must carry the job id, got %s", r.Text())
	job := store.GetJob(context.Background(), jobID)
	ctx.Assert(job != nil && job.State == "queued" && job.Tenant == "t-1", "the job record of %s is %+v", jobID, job)
	ctx.Equal(ctx.Redis.LRange("jobs:queue", 0, -1), []string{jobID}, "jobs:queue")
}

func CheckJobType(ctx *harness.Ctx) {
	c := api(ctx)
	r := c.Post("/v1/jobs", map[string]any{"type": "emial.send", "payload": emailJob["payload"]}, tenantHeader...)
	ctx.Equal(r.Status, 400, "the unregistered type emial.send must be 400 (no worker runs a type the registry does not know); the status")
	ctx.Equal(ctx.Redis.LLen("jobs:queue"), 0, "an unregistered job type was queued; jobs:queue length")
	ctx.Equal(len(ctx.Redis.Keys("job:*")), 0, "an unregistered job type left a job record %v; job records", ctx.Redis.Keys("job:*"))
	r = c.Post("/v1/jobs", emailJob, tenantHeader...)
	ctx.Equal(r.Status, 202, "a registered type (%s)", r.Text())
}

func CheckPayloadSchema(ctx *harness.Ctx) {
	c := api(ctx)
	cases := []struct {
		payload map[string]any
		path    string
		what    string
	}{
		{map[string]any{"invoice_id": "inv-7"}, "payload.amount_cents", "a payload missing amount_cents"},
		{map[string]any{"invoice_id": "inv-7", "amount_cents": "1200"}, "payload.amount_cents", "an amount sent as a string"},
		{map[string]any{"invoice_id": "inv-7", "amount_cents": 1200, "card_number": "4242"}, "payload.card_number", "a field the schema does not list"},
	}
	for _, tc := range cases {
		r := c.Post("/v1/jobs", map[string]any{"type": "invoice.charge", "payload": tc.payload}, tenantHeader...)
		ctx.Equal(r.Status, 422, "%s must be 422 (the job would fail in a worker five times instead); the status", tc.what)
		ctx.Assert(contains(r.Text(), tc.path), "the 422 for %s must name %s, got %s", tc.what, tc.path, r.Text())
	}
	ctx.Equal(ctx.Redis.LLen("jobs:queue"), 0, "a rejected payload was queued; jobs:queue length")
	r := c.Post("/v1/jobs", map[string]any{"type": "invoice.charge", "payload": map[string]any{"invoice_id": "inv-7", "amount_cents": 1200}}, tenantHeader...)
	ctx.Equal(r.Status, 202, "a payload that fits the schema (%s)", r.Text())
}

func contains(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}

func CheckDedupeWindow(ctx *harness.Ctx) {
	c := api(ctx)
	headers := append(append([]string{}, tenantHeader...), "Dedupe-Key", "welcome-ada")
	key := store.DedupeKey("t-1", "welcome-ada")
	first := c.Post("/v1/jobs", emailJob, headers...)
	ctx.Equal(first.Status, 202, "the first POST (%s)", first.Text())
	original := jobIDOf(first)
	replay := c.Post("/v1/jobs", emailJob, headers...)
	ctx.Assert(replay.Status == 200 && jobIDOf(replay) == original, "a replayed Dedupe-Key must answer 200 with the original job id %s, got %d %s", original, replay.Status, replay.Text())
	ctx.Equal(ctx.Redis.LLen("jobs:queue"), 1, "a replay queued a second job; jobs:queue length")
	ttl := ctx.Redis.TTL(key)
	ctx.Assert(ttl > 0 && ttl <= 86400, "%s has TTL %d: the reservation must expire after the dedupe window (86400 s), not hold the key forever", key, ttl)
	ctx.Clock.Advance(86401)
	later := c.Post("/v1/jobs", emailJob, headers...)
	ctx.Assert(later.Status == 202 && jobIDOf(later) != original, "a day later the same key must queue a new job, got %d %s", later.Status, later.Text())
	race := store.DedupeKey("t-1", "invoice-7")
	// Another replica, handling the same retried request, reserves the key right after this request's first command on it.
	probe := ctx.Redis.After(race, func() any { return ctx.Redis.Set(race, "job-other", "NX", "EX", 86400) })
	before := ctx.Redis.LLen("jobs:queue")
	r := c.Post("/v1/jobs", emailJob, append(append([]string{}, tenantHeader...), "Dedupe-Key", "invoice-7")...)
	ctx.Assert(probe.Fired, "the request never touched the Dedupe-Key's reservation")
	held, _ := ctx.Redis.Get(race)
	if won, _ := probe.Result.(bool); won {
		ctx.Assert(jobIDOf(r) == "job-other" && ctx.Redis.LLen("jobs:queue") == before, "another replica reserved the key between your read and your write; you queued %s anyway and the key now holds %s: reserve with one SET NX EX before the job exists", jobIDOf(r), held)
	} else {
		ctx.Assert(held == jobIDOf(r) && ctx.Redis.LLen("jobs:queue") == before+1, "your request reserved the key, so it must queue its job: the key holds %s, the answer was %s", held, r.Text())
	}
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <string>

#include "jobs/store.h"

namespace {

const std::string kEmail = R"({"type": "email.send", "payload": {"to": "ada@example.com", "template": "welcome"}})";

harness::HTTP api(harness::Ctx& ctx) {
  static httplib::Server* svr = nullptr;
  delete svr;
  svr = new httplib::Server;
  register_routes(*svr);
  return ctx.HTTP(*svr);
}

harness::Response post(harness::HTTP& c, const std::string& body, const std::string& dedupe = "") {
  if (dedupe.empty()) return c.Post("/v1/jobs", body, "Content-Type", "application/json", "X-Tenant-Id", "t-1");
  return c.Post("/v1/jobs", body, "Content-Type", "application/json", "X-Tenant-Id", "t-1", "Dedupe-Key", dedupe);
}

std::string jobIdOf(const harness::Response& r) {
  const auto body = nlohmann::json::parse(r.Text(), nullptr, false);
  return body.is_object() ? body.value("job_id", "") : "";
}

}  // namespace

void CheckRoute(harness::Ctx& ctx) {
  auto c = api(ctx);
  const auto r = post(c, kEmail);
  ctx.Equal(r.Status, 202, "POST /v1/jobs (%s)", r.Text());
  const std::string job_id = jobIdOf(r);
  ctx.Assert(!job_id.empty(), "the 202 must carry the job id, got %s", r.Text());
  const auto job = store::getJob(job_id);
  ctx.Assert(job && job->state == "queued" && job->tenant == "t-1", "the job record of %s is %s", job_id, job ? job->state : "missing");
  ctx.Equal(ctx.Redis.LRange("jobs:queue", 0, -1), std::vector<std::string>{job_id}, "jobs:queue");
}

void CheckJobType(harness::Ctx& ctx) {
  auto c = api(ctx);
  auto r = post(c, R"({"type": "emial.send", "payload": {"to": "ada@example.com", "template": "welcome"}})");
  ctx.Equal(r.Status, 400, "the unregistered type emial.send must be 400 (no worker runs a type the registry does not know); the status");
  ctx.Equal(ctx.Redis.LLen("jobs:queue"), 0, "an unregistered job type was queued; jobs:queue length");
  ctx.Equal(ctx.Redis.Keys("job:*").size(), 0, "an unregistered job type left a job record; job records");
  r = post(c, kEmail);
  ctx.Equal(r.Status, 202, "a registered type (%s)", r.Text());
}

void CheckPayloadSchema(harness::Ctx& ctx) {
  auto c = api(ctx);
  const std::vector<std::vector<std::string>> cases = {
      {R"({"invoice_id": "inv-7"})", "payload.amount_cents", "a payload missing amount_cents"},
      {R"({"invoice_id": "inv-7", "amount_cents": "1200"})", "payload.amount_cents", "an amount sent as a string"},
      {R"({"invoice_id": "inv-7", "amount_cents": 1200, "card_number": "4242"})", "payload.card_number", "a field the schema does not list"},
  };
  for (const auto& tc : cases) {
    const auto r = post(c, R"({"type": "invoice.charge", "payload": )" + tc[0] + "}");
    ctx.Equal(r.Status, 422, "%s must be 422 (the job would fail in a worker five times instead); the status", tc[2]);
    ctx.Assert(r.Text().find(tc[1]) != std::string::npos, "the 422 for %s must name %s, got %s", tc[2], tc[1], r.Text());
  }
  ctx.Equal(ctx.Redis.LLen("jobs:queue"), 0, "a rejected payload was queued; jobs:queue length");
  const auto r = post(c, R"({"type": "invoice.charge", "payload": {"invoice_id": "inv-7", "amount_cents": 1200}})");
  ctx.Equal(r.Status, 202, "a payload that fits the schema (%s)", r.Text());
}

void CheckDedupeWindow(harness::Ctx& ctx) {
  auto c = api(ctx);
  const std::string key = store::dedupeKey("t-1", "welcome-ada");
  const auto first = post(c, kEmail, "welcome-ada");
  ctx.Equal(first.Status, 202, "the first POST (%s)", first.Text());
  const std::string original = jobIdOf(first);
  const auto replay = post(c, kEmail, "welcome-ada");
  ctx.Assert(replay.Status == 200 && jobIdOf(replay) == original, "a replayed Dedupe-Key must answer 200 with the original job id %s, got %d %s", original, replay.Status, replay.Text());
  ctx.Equal(ctx.Redis.LLen("jobs:queue"), 1, "a replay queued a second job; jobs:queue length");
  const long long ttl = ctx.Redis.TTL(key);
  ctx.Assert(ttl > 0 && ttl <= 86400, "%s has TTL %d: the reservation must expire after the dedupe window (86400 s), not hold the key forever", key, ttl);
  ctx.Clock.Advance(86401);
  const auto later = post(c, kEmail, "welcome-ada");
  ctx.Assert(later.Status == 202 && jobIdOf(later) != original, "a day later the same key must queue a new job, got %d %s", later.Status, later.Text());
  const std::string race = store::dedupeKey("t-1", "invoice-7");
  bool fired = false;
  bool other_won = false;
  // Another replica, handling the same retried request, reserves the key right after this request's first command on it.
  ctx.Redis.After(race, [&] {
    fired = true;
    other_won = ctx.Redis.Set(race, "job-other", "NX", "EX", 86400);
  });
  const long long before = ctx.Redis.LLen("jobs:queue");
  const auto r = post(c, kEmail, "invoice-7");
  ctx.Assert(fired, "the request never touched the Dedupe-Key's reservation");
  const std::string held = ctx.Redis.Get(race).value_or("");
  if (other_won) {
    ctx.Assert(jobIdOf(r) == "job-other" && ctx.Redis.LLen("jobs:queue") == before, "another replica reserved the key between your read and your write; you queued %s anyway and the key now holds %s: reserve with one SET NX EX before the job exists", jobIdOf(r), held);
  } else {
    ctx.Assert(held == jobIdOf(r) && ctx.Redis.LLen("jobs:queue") == before + 1, "your request reserved the key, so it must queue its job: the key holds %s, the answer was %s", held, r.Text());
  }
}
`,
  },
  hints: [
    'Post the same Dedupe-Key twice, a day apart: the second request still gets the old job. Post a job of type `emial.send`, or an amount sent as a string: both are queued and fail later in a worker.',
    'Nothing asks the registry or the schema before `create_job`. The dedupe key is read with `GET` and written with a plain `SET` after the job is queued: a second replica can land between the two, and nothing ever expires the key.',
    'Answer 400 when the type is not in `store.JOB_TYPES` and 422 with the path `store.validate_payload` returns; then `r.set(key, job_id, nx=True, ex=DEDUPE_WINDOW_S)` before `create_job`, and on a refusal answer 200 with `r.get(key)`.',
  ],
  debrief: `The registry and the schema are checked at the door because the door is the last place a caller is still waiting for an answer: past it, a bad payload becomes five failed attempts and a dead letter. The reservation is one \`SET NX EX\` because a read followed by a write leaves a gap that a second replica, handling the same retried request, falls into, and then both queue the job. The expiry bounds how long a key means "the same request". Production queues also store a hash of the request body with the key, so a reused key carrying a different body is answered 409 instead of silently returning the old job.`,
};
