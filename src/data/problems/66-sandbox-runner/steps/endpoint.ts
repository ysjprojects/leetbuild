import type {Step} from '@/lib/types';

export const endpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/sandbox/jobs: code that declares what it needs',
  concept: 'http',
  file: 'api',
  focus: ['client', 'api', 'redis'],
  task: `## Task

**Starting point.** The starter registers \`POST /v1/sandbox/jobs\` on the job store
(\`sandbox.jobs\`, provided): it reads \`{code, profile, needs}\`, takes the tenant from
\`X-Tenant-Id\` (or \`anonymous\`), stores the job with \`jobs.create\` and answers **202**
\`{job_id, profile, code_digest}\`. It serves the demo and hides three flaws.

**Failure mode the checks target.** An anonymous caller submits a megabyte of code; a job asks for
\`network\` under \`runc\` and gets it; a client that retries its submit after a timeout queues the
same code twice.

- The tenant is \`X-Tenant-Id\`; a missing one is **401**. \`code\` is at most \`MAX_CODE_BYTES\`
  (256 KiB, counted in UTF-8 bytes); larger is **413**, before anything is stored.
- \`profile\` is one of \`ALLOWED_PROFILES\` (\`runc\`, \`gvisor\`, \`kata\`), and every entry of
  \`needs\` is granted to it by \`PROFILE_CAPABILITIES\` (\`runc\`: filesystem; \`gvisor\`: filesystem,
  subprocess; \`kata\`: those and network). Anything else is **400**: declaring a need does not
  grant it.
- \`Idempotency-Key\` is required (**400**). Look it up with \`jobs.lookup(tenant, key)\` before
  \`jobs.create\`, answer the original job on a replay, and \`jobs.remember\` a new one. A key
  belongs to its tenant.`,
  sequence: {
    participants: ['Client', 'Sandbox API', 'job store'],
    messages: [
      {from: 'Client', to: 'Sandbox API', label: 'POST /v1/sandbox/jobs · X-Tenant-Id · Idempotency-Key', kind: 'sync'},
      {from: 'Sandbox API', to: 'Sandbox API', label: '401 tenant · 413 size · 400 profile / capability', kind: 'sync'},
      {from: 'Sandbox API', to: 'job store', label: 'lookup(tenant, key)', kind: 'sync'},
      {from: 'job store', to: 'Sandbox API', label: 'original job id / none', kind: 'reply'},
      {from: 'Sandbox API', to: 'job store', label: 'create(tenant, profile, needs, code) · remember', kind: 'sync'},
      {from: 'Sandbox API', to: 'Client', label: '202 {job_id, profile, code_digest}', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Queues a job on POST /v1/sandbox/jobs',
      detail:
        'A submit answers **202** with the job id of a queued job, its profile and the SHA-256 of the code, and does not echo the code.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/sandbox\/jobs["']/, /\b202\b/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/sandbox\/jobs['"]/, /\b202\b/]},
        go: {all: [/HandleFunc\(\s*"POST \/v1\/sandbox\/jobs"/, /StatusAccepted|\b202\b/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"sandbox"\s*\/\s*"jobs"\s*\)/, /Accepted/]},
        cpp: {all: [/svr\.Post\(\s*"\/v1\/sandbox\/jobs"/, /\b202\b/]},
      },
    },
    {
      id: 'limits',
      title: 'Refuses an anonymous or oversized submit before storing it',
      detail:
        'No `X-Tenant-Id` is **401**; code over `MAX_CODE_BYTES` (256 KiB, counted in bytes) is **413**; neither creates a job. The starter files the job under `anonymous` and stores any size.',
      match: {
        python: {
          all: [/MAX_CODE_BYTES\s*=\s*(1\s*<<\s*18|262144|256\s*\*\s*1024)/, /\.encode\(/, /\b413\b/, /\b401\b/],
          none: [/["']anonymous["']/],
        },
        typescript: {
          all: [
            /MAX_CODE_BYTES\s*=\s*(1\s*<<\s*18|262144|256\s*\*\s*1024)/,
            /TextEncoder|Buffer\.byteLength/,
            /\b413\b/,
            /\b401\b/,
          ],
          none: [/['"]anonymous['"]/],
        },
        go: {
          all: [
            /maxCodeBytes\s*=\s*(1\s*<<\s*18|262144|256\s*\*\s*1024)/,
            /len\([^)\n]*\)\s*>\s*maxCodeBytes/,
            /StatusRequestEntityTooLarge|\b413\b/,
            /StatusUnauthorized|\b401\b/,
          ],
          none: [/"anonymous"/],
        },
        scala: {
          all: [
            /MaxCodeBytes[^\n]*=\s*(1\s*<<\s*18|262144|256\s*\*\s*1024)/,
            /getBytes/,
            /PayloadTooLarge|\b413\b/,
            /Unauthorized/,
          ],
          none: [/"anonymous"/],
        },
        cpp: {
          all: [
            /kMaxCodeBytes[^\n]*=\s*(1\s*<<\s*18|262144|256\s*\*\s*1024)/,
            /\.size\(\)\s*>\s*kMaxCodeBytes/,
            /\b413\b/,
            /\b401\b/,
          ],
          none: [/"anonymous"/],
        },
      },
    },
    {
      id: 'capabilities',
      title: 'Grants a need only when the profile does',
      detail:
        "The profile must be in `ALLOWED_PROFILES` and every need in the profile's `PROFILE_CAPABILITIES` entry, else **400** and no job: `network` under `runc` or `gvisor` is refused, as are an unknown profile and an unknown need. The starter stores whatever the body declares.",
      match: {
        python: {all: [/ALLOWED_PROFILES/, /PROFILE_CAPABILITIES\[/, /\b400\b/]},
        typescript: {all: [/ALLOWED_PROFILES/, /PROFILE_CAPABILITIES\[/, /\b400\b/]},
        go: {all: [/allowedProfiles/, /profileCapabilities\[/, /StatusBadRequest|\b400\b/]},
        scala: {all: [/AllowedProfiles/, /ProfileCapabilities\(/, /BadRequest/]},
        cpp: {all: [/kAllowedProfiles/, /kProfileCapabilities\.(at|find)\(|kProfileCapabilities\[/, /\b400\b/]},
      },
    },
    {
      id: 'idempotency',
      title: 'Answers a replayed submit with the original job',
      detail:
        "`Idempotency-Key` is required (400 without it) and looked up per tenant before `create`: a replay answers the first job id and creates nothing, a new key or another tenant's same key creates a job.",
      match: {
        python: {
          all: [/idempotency-key/i, /jobs\.lookup\(/, /jobs\.remember\(/],
          order: [/jobs\.lookup\(/, /jobs\.create\(/],
        },
        typescript: {all: [/idempotency-key/i, /\blookup\(/, /\bremember\(/], order: [/\blookup\(/, /\bcreate\(/]},
        go: {
          all: [/Idempotency-Key/i, /jobs\.Lookup\(/, /jobs\.Remember\(/],
          order: [/jobs\.Lookup\(/, /jobs\.Create\(/],
        },
        scala: {
          all: [/Idempotency-Key/i, /Jobs\.lookup\(/, /Jobs\.remember\(/],
          order: [/Jobs\.lookup\(/, /Jobs\.create\(/],
        },
        cpp: {
          all: [/Idempotency-Key/i, /jobs::lookup\(/, /jobs::remember\(/],
          order: [/jobs::lookup\(/, /jobs::create\(/],
        },
      },
    },
  ],
  code: {
    python: {
      starter: `from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from sandbox import jobs  # digest, create, get, lookup, remember

app = FastAPI()


@app.post("/v1/sandbox/jobs")
async def submit(request: Request) -> JSONResponse:
    # TODO: this starter has three flaws. The task says where to look; the checks say what must change.
    tenant = request.headers.get("x-tenant-id", "anonymous")
    body = await request.json()
    job = jobs.create(tenant, body.get("profile", "runc"), body.get("needs", []), body["code"])
    return JSONResponse({"job_id": job["job_id"], "profile": job["profile"], "code_digest": job["code_digest"]}, status_code=202)
`,
      solution: `from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from sandbox import jobs  # digest, create, get, lookup, remember

app = FastAPI()

MAX_CODE_BYTES = 1 << 18  # 256 KiB
ALLOWED_PROFILES = ("runc", "gvisor", "kata")
# Default deny: a profile grants exactly these capabilities, and nothing a submit merely declares.
PROFILE_CAPABILITIES = {
    "runc": {"filesystem"},
    "gvisor": {"filesystem", "subprocess"},
    "kata": {"filesystem", "subprocess", "network"},
}


def error(status: int, message: str) -> JSONResponse:
    return JSONResponse({"error": message}, status_code=status)


@app.post("/v1/sandbox/jobs")
async def submit(request: Request) -> JSONResponse:
    tenant = request.headers.get("x-tenant-id", "")
    if not tenant:
        return error(401, "X-Tenant-Id is required")
    key = request.headers.get("idempotency-key", "")
    if not key:
        return error(400, "Idempotency-Key is required")
    body = await request.json()
    code = body.get("code")
    if not isinstance(code, str) or code == "":
        return error(400, "code is required")
    if len(code.encode()) > MAX_CODE_BYTES:
        return error(413, f"code is larger than {MAX_CODE_BYTES} bytes")
    profile = body.get("profile")
    if profile not in ALLOWED_PROFILES:
        return error(400, f"unknown profile {profile!r}")
    needs = body.get("needs", [])
    denied = [need for need in needs if need not in PROFILE_CAPABILITIES[profile]]
    if denied:
        return error(400, f"profile {profile} does not grant {denied[0]}")
    replay = jobs.lookup(tenant, key)
    if replay is not None:
        job = jobs.get(replay)  # a retried submit answers the job it created the first time
    else:
        job = jobs.create(tenant, profile, needs, code)
        jobs.remember(tenant, key, job["job_id"])
    return JSONResponse({"job_id": job["job_id"], "profile": job["profile"], "code_digest": job["code_digest"]}, status_code=202)
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';

import {create, get, lookup, remember} from 'sandbox/jobs';

export const app = Fastify();

interface Submit {
  code: string;
  profile?: string;
  needs?: string[];
}

app.post('/v1/sandbox/jobs', async (request, reply) => {
  // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
  const tenant = (request.headers['x-tenant-id'] as string | undefined) ?? 'anonymous';
  const body = request.body as Submit;
  const job = await create(tenant, body.profile ?? 'runc', body.needs ?? [], body.code);
  return reply.code(202).send({job_id: job.job_id, profile: job.profile, code_digest: job.code_digest});
});
`,
      solution: `import Fastify from 'fastify';

import {create, get, lookup, remember} from 'sandbox/jobs';

export const app = Fastify();

export const MAX_CODE_BYTES = 1 << 18; // 256 KiB
export const ALLOWED_PROFILES = ['runc', 'gvisor', 'kata'];
// Default deny: a profile grants exactly these capabilities, and nothing a submit merely declares.
export const PROFILE_CAPABILITIES: Record<string, string[]> = {
  runc: ['filesystem'],
  gvisor: ['filesystem', 'subprocess'],
  kata: ['filesystem', 'subprocess', 'network'],
};

interface Submit {
  code?: unknown;
  profile?: unknown;
  needs?: string[];
}

app.post('/v1/sandbox/jobs', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'X-Tenant-Id is required'});
  const key = request.headers['idempotency-key'];
  if (typeof key !== 'string' || key === '') return reply.code(400).send({error: 'Idempotency-Key is required'});
  const {code, profile, needs = []} = request.body as Submit;
  if (typeof code !== 'string' || code === '') return reply.code(400).send({error: 'code is required'});
  if (new TextEncoder().encode(code).length > MAX_CODE_BYTES) {
    return reply.code(413).send({error: \`code is larger than \${MAX_CODE_BYTES} bytes\`});
  }
  if (typeof profile !== 'string' || !ALLOWED_PROFILES.includes(profile)) {
    return reply.code(400).send({error: \`unknown profile \${String(profile)}\`});
  }
  const denied = needs.find(need => !PROFILE_CAPABILITIES[profile].includes(need));
  if (denied !== undefined) return reply.code(400).send({error: \`profile \${profile} does not grant \${denied}\`});
  const replay = await lookup(tenant, key);
  // A retried submit answers the job it created the first time.
  let job = replay === null ? null : await get(replay);
  if (job === null) {
    job = await create(tenant, profile, needs, code);
    await remember(tenant, key, job.job_id);
  }
  return reply.code(202).send({job_id: job.job_id, profile: job.profile, code_digest: job.code_digest});
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"net/http"

	"sandbox/jobs" // jobs.Create, Get, Lookup, Remember
)

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func submit(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has three flaws. The task says where to look; the checks say what must change.
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		tenant = "anonymous"
	}
	body := struct {
		Code    string   \`json:"code"\`
		Profile string   \`json:"profile"\`
		Needs   []string \`json:"needs"\`
	}{Profile: "runc"}
	json.NewDecoder(r.Body).Decode(&body)
	job := jobs.Create(r.Context(), tenant, body.Profile, body.Needs, body.Code)
	writeJSON(rw, http.StatusAccepted, map[string]string{"job_id": job.JobID, "profile": job.Profile, "code_digest": job.CodeDigest})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/sandbox/jobs", submit)
}
`,
      solution: `package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"slices"

	"sandbox/jobs" // jobs.Create, Get, Lookup, Remember
)

const maxCodeBytes = 1 << 18 // 256 KiB

var allowedProfiles = []string{"runc", "gvisor", "kata"}

// Default deny: a profile grants exactly these capabilities, and nothing a submit merely declares.
var profileCapabilities = map[string][]string{
	"runc":   {"filesystem"},
	"gvisor": {"filesystem", "subprocess"},
	"kata":   {"filesystem", "subprocess", "network"},
}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func fail(rw http.ResponseWriter, status int, message string) {
	writeJSON(rw, status, map[string]string{"error": message})
}

func submit(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		fail(rw, http.StatusUnauthorized, "X-Tenant-Id is required")
		return
	}
	key := r.Header.Get("Idempotency-Key")
	if key == "" {
		fail(rw, http.StatusBadRequest, "Idempotency-Key is required")
		return
	}
	var body struct {
		Code    string   \`json:"code"\`
		Profile string   \`json:"profile"\`
		Needs   []string \`json:"needs"\`
	}
	json.NewDecoder(r.Body).Decode(&body)
	if body.Code == "" {
		fail(rw, http.StatusBadRequest, "code is required")
		return
	}
	if len(body.Code) > maxCodeBytes { // len of a Go string counts bytes
		fail(rw, http.StatusRequestEntityTooLarge, fmt.Sprintf("code is larger than %d bytes", maxCodeBytes))
		return
	}
	if !slices.Contains(allowedProfiles, body.Profile) {
		fail(rw, http.StatusBadRequest, fmt.Sprintf("unknown profile %q", body.Profile))
		return
	}
	for _, need := range body.Needs {
		if !slices.Contains(profileCapabilities[body.Profile], need) {
			fail(rw, http.StatusBadRequest, fmt.Sprintf("profile %s does not grant %s", body.Profile, need))
			return
		}
	}
	var job *jobs.Job
	if replay := jobs.Lookup(r.Context(), tenant, key); replay != "" {
		job = jobs.Get(r.Context(), replay) // a retried submit answers the job it created the first time
	}
	if job == nil {
		job = jobs.Create(r.Context(), tenant, body.Profile, body.Needs, body.Code)
		jobs.Remember(r.Context(), tenant, key, job.JobID)
	}
	writeJSON(rw, http.StatusAccepted, map[string]string{"job_id": job.JobID, "profile": job.Profile, "code_digest": job.CodeDigest})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/sandbox/jobs", submit)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import sandbox.Jobs // Jobs.create, get, lookup, remember

object Api {
  private def json(status: StatusCode, body: JsObject): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  private def text(fields: Map[String, JsValue], name: String, default: String): String =
    fields.get(name).collect { case JsString(s) => s }.getOrElse(default)

  val route: Route = path("v1" / "sandbox" / "jobs") {
    post {
      // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
      optionalHeaderValueByName("X-Tenant-Id") { header =>
        entity(as[String]) { raw =>
          val tenant = header.getOrElse("anonymous")
          val body = raw.parseJson.asJsObject.fields
          val needs = body.get("needs").collect { case JsArray(items) => items.collect { case JsString(s) => s } }.getOrElse(Vector.empty)
          val job = Jobs.create(tenant, text(body, "profile", "runc"), needs, text(body, "code", ""))
          complete(json(StatusCodes.Accepted, JsObject("job_id" -> JsString(job.jobId), "profile" -> JsString(job.profile), "code_digest" -> JsString(job.codeDigest))))
        }
      }
    }
  }
}
`,
      solution: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import sandbox.Jobs // Jobs.create, get, lookup, remember

object Api {
  val MaxCodeBytes: Int = 1 << 18 // 256 KiB
  val AllowedProfiles: Seq[String] = Seq("runc", "gvisor", "kata")
  // Default deny: a profile grants exactly these capabilities, and nothing a submit merely declares.
  val ProfileCapabilities: Map[String, Set[String]] =
    Map("runc" -> Set("filesystem"), "gvisor" -> Set("filesystem", "subprocess"), "kata" -> Set("filesystem", "subprocess", "network"))

  private def json(status: StatusCode, body: JsObject): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  private def error(status: StatusCode, message: String): HttpResponse = json(status, JsObject("error" -> JsString(message)))

  private def text(fields: Map[String, JsValue], name: String): String =
    fields.get(name).collect { case JsString(s) => s }.getOrElse("")

  private def submit(tenant: String, key: String, raw: String): HttpResponse = {
    val body = raw.parseJson.asJsObject.fields
    val code = text(body, "code")
    val profile = text(body, "profile")
    val needs = body.get("needs").collect { case JsArray(items) => items.collect { case JsString(s) => s } }.getOrElse(Vector.empty)
    if (code.isEmpty) error(StatusCodes.BadRequest, "code is required")
    else if (code.getBytes("UTF-8").length > MaxCodeBytes) error(StatusCodes.PayloadTooLarge, s"code is larger than $MaxCodeBytes bytes")
    else if (!AllowedProfiles.contains(profile)) error(StatusCodes.BadRequest, s"unknown profile $profile")
    else
      needs.find(need => !ProfileCapabilities(profile).contains(need)) match {
        case Some(denied) => error(StatusCodes.BadRequest, s"profile $profile does not grant $denied")
        case None =>
          // A retried submit answers the job it created the first time.
          val job = Jobs.lookup(tenant, key).flatMap(Jobs.get).getOrElse {
            val created = Jobs.create(tenant, profile, needs, code)
            Jobs.remember(tenant, key, created.jobId)
            created
          }
          json(StatusCodes.Accepted, JsObject("job_id" -> JsString(job.jobId), "profile" -> JsString(job.profile), "code_digest" -> JsString(job.codeDigest)))
      }
  }

  val route: Route = path("v1" / "sandbox" / "jobs") {
    post {
      optionalHeaderValueByName("X-Tenant-Id") {
        case None | Some("") => complete(error(StatusCodes.Unauthorized, "X-Tenant-Id is required"))
        case Some(tenant) =>
          optionalHeaderValueByName("Idempotency-Key") {
            case None | Some("") => complete(error(StatusCodes.BadRequest, "Idempotency-Key is required"))
            case Some(key) => entity(as[String])(raw => complete(submit(tenant, key, raw)))
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

#include <string>
#include <vector>

#include "sandbox/jobs.h"  // jobs::create, get, lookup, remember

using json = nlohmann::json;

void submit(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
  std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) tenant = "anonymous";
  const json body = json::parse(req.body);
  const jobs::Job job = jobs::create(tenant, body.value("profile", "runc"), body.value("needs", std::vector<std::string>{}), body.value("code", ""));
  res.status = 202;
  res.set_content(json{{"job_id", job.job_id}, {"profile", job.profile}, {"code_digest", job.code_digest}}.dump(), "application/json");
}

void register_routes(httplib::Server& svr) { svr.Post("/v1/sandbox/jobs", submit); }
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <algorithm>
#include <map>
#include <string>
#include <vector>

#include "sandbox/jobs.h"  // jobs::create, get, lookup, remember

using json = nlohmann::json;

constexpr size_t kMaxCodeBytes = 1 << 18;  // 256 KiB
const std::vector<std::string> kAllowedProfiles = {"runc", "gvisor", "kata"};
// Default deny: a profile grants exactly these capabilities, and nothing a submit merely declares.
const std::map<std::string, std::vector<std::string>> kProfileCapabilities = {
    {"runc", {"filesystem"}},
    {"gvisor", {"filesystem", "subprocess"}},
    {"kata", {"filesystem", "subprocess", "network"}},
};

void fail(httplib::Response& res, int status, const std::string& message) {
  res.status = status;
  res.set_content(json{{"error", message}}.dump(), "application/json");
}

bool listed(const std::vector<std::string>& names, const std::string& name) {
  return std::find(names.begin(), names.end(), name) != names.end();
}

void submit(const httplib::Request& req, httplib::Response& res) {
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) return fail(res, 401, "X-Tenant-Id is required");
  const std::string key = req.get_header_value("Idempotency-Key");
  if (key.empty()) return fail(res, 400, "Idempotency-Key is required");
  const json body = json::parse(req.body, nullptr, false);
  if (!body.is_object()) return fail(res, 400, "the body must be a JSON object");
  const std::string code = body.value("code", "");
  if (code.empty()) return fail(res, 400, "code is required");
  if (code.size() > kMaxCodeBytes) return fail(res, 413, "code is larger than " + std::to_string(kMaxCodeBytes) + " bytes");
  const std::string profile = body.value("profile", "");
  if (!listed(kAllowedProfiles, profile)) return fail(res, 400, "unknown profile " + profile);
  const std::vector<std::string> needs = body.value("needs", std::vector<std::string>{});
  for (const std::string& need : needs) {
    if (!listed(kProfileCapabilities.at(profile), need)) return fail(res, 400, "profile " + profile + " does not grant " + need);
  }
  std::optional<jobs::Job> job;
  if (const auto replay = jobs::lookup(tenant, key)) job = jobs::get(*replay);  // a retried submit answers its first job
  if (!job) {
    job = jobs::create(tenant, profile, needs, code);
    jobs::remember(tenant, key, job->job_id);
  }
  res.status = 202;
  res.set_content(json{{"job_id", job->job_id}, {"profile", job->profile}, {"code_digest", job->code_digest}}.dump(), "application/json");
}

void register_routes(httplib::Server& svr) { svr.Post("/v1/sandbox/jobs", submit); }
`,
    },
  },
  harness: {
    python: `from sandbox import jobs

CODE = "print('hello from the sandbox')"


def _api(ctx):
    return ctx.client(ctx.load("api").app)


async def _submit(c, body=None, tenant="t1", key="k-1"):
    headers = {}
    if tenant is not None:
        headers["X-Tenant-Id"] = tenant
    if key is not None:
        headers["Idempotency-Key"] = key
    return await c.post("/v1/sandbox/jobs", json=body or {"code": CODE, "profile": "gvisor", "needs": []}, headers=headers)


def _created(ctx):
    return int(ctx.redis.get("job:seq") or 0)


async def check_route(ctx):
    async with _api(ctx) as c:
        r = await _submit(c, {"code": CODE, "profile": "gvisor", "needs": ["filesystem"]})
    assert r.status_code == 202, f"POST /v1/sandbox/jobs answered {r.status_code}: {r.text}"
    body = r.json()
    job = jobs.get(body.get("job_id", ""))
    assert job is not None and job["status"] == "queued", f"the answered job_id {body.get('job_id')!r} is not a queued job in the store: {job}"
    assert body.get("profile") == "gvisor", f"the submit asked for gvisor and the answer names {body.get('profile')!r}"
    assert body.get("code_digest") == jobs.digest(CODE), f"code_digest must be the SHA-256 of the code, got {body.get('code_digest')!r}"
    assert CODE not in r.text, f"the response echoes the code: {r.text}"


async def check_limits(ctx):
    async with _api(ctx) as c:
        r = await _submit(c, tenant=None)
        assert r.status_code == 401, f"a submit without X-Tenant-Id answered {r.status_code}, expected 401"
        r = await _submit(c, {"code": "x" * ((1 << 18) + 1), "profile": "gvisor", "needs": []})
        assert r.status_code == 413, f"a submit of 256 KiB + 1 byte of code answered {r.status_code}, expected 413"
        r = await _submit(c, {"code": "é" * ((1 << 17) + 1), "profile": "gvisor", "needs": []})
        assert r.status_code == 413, f"131073 two-byte characters (256 KiB + 2 bytes) answered {r.status_code}, expected 413: count UTF-8 bytes, not characters"
        assert _created(ctx) == 0, f"refused submits created {_created(ctx)} job(s): check the tenant and the size before anything is stored"
        r = await _submit(c, {"code": "x" * (1 << 18), "profile": "gvisor", "needs": []}, key="k-2")
    assert r.status_code == 202, f"exactly 256 KiB of code answered {r.status_code}, expected 202"


async def check_capabilities(ctx):
    refused = [
        ("privileged", [], "an unknown profile"),
        ("runc", ["network"], "network under runc"),
        ("gvisor", ["network"], "network under gvisor"),
        ("kata", ["gpu"], "a capability no profile grants"),
    ]
    granted = [("kata", ["network"]), ("gvisor", ["filesystem", "subprocess"]), ("runc", [])]
    async with _api(ctx) as c:
        for i, (profile, needs, why) in enumerate(refused):
            r = await _submit(c, {"code": CODE, "profile": profile, "needs": needs}, key=f"r-{i}")
            assert r.status_code == 400, f"{why} ({profile}, needs {needs}) answered {r.status_code}, expected 400: a declared need is granted only by the profile"
        assert _created(ctx) == 0, f"refused submits created {_created(ctx)} job(s)"
        for i, (profile, needs) in enumerate(granted):
            r = await _submit(c, {"code": CODE, "profile": profile, "needs": needs}, key=f"g-{i}")
            assert r.status_code == 202, f"{profile} with needs {needs} answered {r.status_code}, expected 202: the profile grants them"


async def check_idempotency(ctx):
    async with _api(ctx) as c:
        first = await _submit(c, key="k-1")
        assert first.status_code == 202, f"the first submit answered {first.status_code}: {first.text}"
        replay = await _submit(c, key="k-1")
        assert replay.status_code == 202 and replay.json().get("job_id") == first.json().get("job_id"), f"a replay of Idempotency-Key k-1 answered {replay.text}, expected the original job {first.json().get('job_id')}"
        assert _created(ctx) == 1, f"a submit and its replay created {_created(ctx)} jobs: the retry queued the code again"
        other = await _submit(c, key="k-2")
        assert other.json().get("job_id") != first.json().get("job_id"), "a new Idempotency-Key must create a new job"
        foreign = await _submit(c, tenant="t2", key="k-1")
        assert foreign.status_code == 202 and foreign.json().get("job_id") != first.json().get("job_id"), f"tenant t2's key k-1 answered t1's job ({foreign.text}): a key belongs to its tenant"
        none = await _submit(c, key=None)
    assert none.status_code == 400, f"a submit without Idempotency-Key answered {none.status_code}, expected 400"
    assert _created(ctx) == 3, f"three distinct submits created {_created(ctx)} jobs"
`,
    typescript: `const CODE = "print('hello from the sandbox')";

function api(ctx) {
  return {c: ctx.client(ctx.load('api').app), jobs: ctx.load('/support/sandbox/jobs.ts')};
}

function submit(c, body: Record<string, unknown> | null = null, tenant: string | null = 't1', key: string | null = 'k-1') {
  const headers: Record<string, string> = {};
  if (tenant !== null) headers['X-Tenant-Id'] = tenant;
  if (key !== null) headers['Idempotency-Key'] = key;
  return c.post('/v1/sandbox/jobs', {json: body ?? {code: CODE, profile: 'gvisor', needs: []}, headers});
}

const created = (ctx): number => Number(ctx.redis.get('job:seq') ?? 0);

export async function check_route(ctx) {
  const {c, jobs} = api(ctx);
  const r = await submit(c, {code: CODE, profile: 'gvisor', needs: ['filesystem']});
  assert.equal(r.status, 202, \`POST /v1/sandbox/jobs answered \${r.status}: \${r.text}\`);
  const body = r.json();
  const job = await jobs.get(body.job_id ?? '');
  assert(job !== null && job.status === 'queued', \`the answered job_id \${body.job_id} is not a queued job in the store: \${JSON.stringify(job)}\`);
  assert.equal(body.profile, 'gvisor', \`the submit asked for gvisor and the answer names \${body.profile}\`);
  assert.equal(body.code_digest, jobs.digest(CODE), \`code_digest must be the SHA-256 of the code, got \${body.code_digest}\`);
  assert(!r.text.includes(CODE), \`the response echoes the code: \${r.text}\`);
}

export async function check_limits(ctx) {
  const {c} = api(ctx);
  let r = await submit(c, null, null);
  assert.equal(r.status, 401, \`a submit without X-Tenant-Id answered \${r.status}, expected 401\`);
  r = await submit(c, {code: 'x'.repeat((1 << 18) + 1), profile: 'gvisor', needs: []});
  assert.equal(r.status, 413, \`a submit of 256 KiB + 1 byte of code answered \${r.status}, expected 413\`);
  r = await submit(c, {code: 'é'.repeat((1 << 17) + 1), profile: 'gvisor', needs: []});
  assert.equal(r.status, 413, \`131073 two-byte characters (256 KiB + 2 bytes) answered \${r.status}, expected 413: count UTF-8 bytes, not characters\`);
  assert.equal(created(ctx), 0, \`refused submits created \${created(ctx)} job(s): check the tenant and the size before anything is stored\`);
  r = await submit(c, {code: 'x'.repeat(1 << 18), profile: 'gvisor', needs: []}, 't1', 'k-2');
  assert.equal(r.status, 202, \`exactly 256 KiB of code answered \${r.status}, expected 202\`);
}

export async function check_capabilities(ctx) {
  const {c} = api(ctx);
  const refused: [string, string[], string][] = [
    ['privileged', [], 'an unknown profile'],
    ['runc', ['network'], 'network under runc'],
    ['gvisor', ['network'], 'network under gvisor'],
    ['kata', ['gpu'], 'a capability no profile grants'],
  ];
  for (const [i, [profile, needs, why]] of refused.entries()) {
    const r = await submit(c, {code: CODE, profile, needs}, 't1', \`r-\${i}\`);
    assert.equal(r.status, 400, \`\${why} (\${profile}, needs \${JSON.stringify(needs)}) answered \${r.status}, expected 400: a declared need is granted only by the profile\`);
  }
  assert.equal(created(ctx), 0, \`refused submits created \${created(ctx)} job(s)\`);
  const granted: [string, string[]][] = [['kata', ['network']], ['gvisor', ['filesystem', 'subprocess']], ['runc', []]];
  for (const [i, [profile, needs]] of granted.entries()) {
    const r = await submit(c, {code: CODE, profile, needs}, 't1', \`g-\${i}\`);
    assert.equal(r.status, 202, \`\${profile} with needs \${JSON.stringify(needs)} answered \${r.status}, expected 202: the profile grants them\`);
  }
}

export async function check_idempotency(ctx) {
  const {c} = api(ctx);
  const first = await submit(c, null, 't1', 'k-1');
  assert.equal(first.status, 202, \`the first submit answered \${first.status}: \${first.text}\`);
  const replay = await submit(c, null, 't1', 'k-1');
  assert(replay.status === 202 && replay.json().job_id === first.json().job_id, \`a replay of Idempotency-Key k-1 answered \${replay.text}, expected the original job \${first.json().job_id}\`);
  assert.equal(created(ctx), 1, \`a submit and its replay created \${created(ctx)} jobs: the retry queued the code again\`);
  const other = await submit(c, null, 't1', 'k-2');
  assert.notEqual(other.json().job_id, first.json().job_id, 'a new Idempotency-Key must create a new job');
  const foreign = await submit(c, null, 't2', 'k-1');
  assert(foreign.status === 202 && foreign.json().job_id !== first.json().job_id, \`tenant t2's key k-1 answered t1's job (\${foreign.text}): a key belongs to its tenant\`);
  const none = await submit(c, null, 't1', null);
  assert.equal(none.status, 400, \`a submit without Idempotency-Key answered \${none.status}, expected 400\`);
  assert.equal(created(ctx), 3, \`three distinct submits created \${created(ctx)} jobs\`);
}
`,
    go: `package main

import (
	"context"
	"fmt"
	"net/http"
	"strconv"
	"strings"

	"sandbox/jobs"

	"leetbuild/harness"
)

const apiCode = "print('hello from the sandbox')"

type submitted struct {
	JobID      string \`json:"job_id"\`
	Profile    string \`json:"profile"\`
	CodeDigest string \`json:"code_digest"\`
}

func api(ctx *harness.Ctx) *harness.HTTP {
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

func submitJob(c *harness.HTTP, body map[string]any, tenant, key string) *harness.Response {
	if body == nil {
		body = map[string]any{"code": apiCode, "profile": "gvisor", "needs": []string{}}
	}
	headers := []string{}
	if tenant != "" {
		headers = append(headers, "X-Tenant-Id", tenant)
	}
	if key != "" {
		headers = append(headers, "Idempotency-Key", key)
	}
	return c.Post("/v1/sandbox/jobs", body, headers...)
}

func jobOf(r *harness.Response) submitted {
	var s submitted
	r.Decode(&s)
	return s
}

func created(ctx *harness.Ctx) int {
	text, _ := ctx.Redis.Get("job:seq")
	n, _ := strconv.Atoi(text)
	return n
}

func CheckRoute(ctx *harness.Ctx) {
	c := api(ctx)
	r := submitJob(c, map[string]any{"code": apiCode, "profile": "gvisor", "needs": []string{"filesystem"}}, "t1", "k-1")
	ctx.Equal(r.Status, 202, "POST /v1/sandbox/jobs (%s)", r.Text())
	body := jobOf(r)
	job := jobs.Get(context.Background(), body.JobID)
	ctx.Assert(job != nil && job.Status == "queued", "the answered job_id %q is not a queued job in the store: %+v", body.JobID, job)
	ctx.Equal(body.Profile, "gvisor", "the submit asked for gvisor; the answered profile")
	ctx.Equal(body.CodeDigest, jobs.Digest(apiCode), "code_digest must be the SHA-256 of the code")
	ctx.Assert(!strings.Contains(r.Text(), apiCode), "the response echoes the code: %s", r.Text())
}

func CheckLimits(ctx *harness.Ctx) {
	c := api(ctx)
	r := submitJob(c, nil, "", "k-1")
	ctx.Equal(r.Status, 401, "a submit without X-Tenant-Id")
	r = submitJob(c, map[string]any{"code": strings.Repeat("x", 1<<18+1), "profile": "gvisor", "needs": []string{}}, "t1", "k-1")
	ctx.Equal(r.Status, 413, "a submit of 256 KiB + 1 byte of code")
	r = submitJob(c, map[string]any{"code": strings.Repeat("é", 1<<17+1), "profile": "gvisor", "needs": []string{}}, "t1", "k-1")
	ctx.Equal(r.Status, 413, "131073 two-byte characters (256 KiB + 2 bytes): count UTF-8 bytes, not characters")
	ctx.Equal(created(ctx), 0, "check the tenant and the size before anything is stored; jobs created by refused submits")
	r = submitJob(c, map[string]any{"code": strings.Repeat("x", 1<<18), "profile": "gvisor", "needs": []string{}}, "t1", "k-2")
	ctx.Equal(r.Status, 202, "exactly 256 KiB of code (%s)", r.Text())
}

func CheckCapabilities(ctx *harness.Ctx) {
	c := api(ctx)
	refused := []struct {
		profile string
		needs   []string
		why     string
	}{
		{"privileged", []string{}, "an unknown profile"},
		{"runc", []string{"network"}, "network under runc"},
		{"gvisor", []string{"network"}, "network under gvisor"},
		{"kata", []string{"gpu"}, "a capability no profile grants"},
	}
	for i, tc := range refused {
		r := submitJob(c, map[string]any{"code": apiCode, "profile": tc.profile, "needs": tc.needs}, "t1", fmt.Sprintf("r-%d", i))
		ctx.Equal(r.Status, 400, "%s (%s, needs %v): a declared need is granted only by the profile", tc.why, tc.profile, tc.needs)
	}
	ctx.Equal(created(ctx), 0, "jobs created by refused submits")
	granted := []struct {
		profile string
		needs   []string
	}{{"kata", []string{"network"}}, {"gvisor", []string{"filesystem", "subprocess"}}, {"runc", []string{}}}
	for i, tc := range granted {
		r := submitJob(c, map[string]any{"code": apiCode, "profile": tc.profile, "needs": tc.needs}, "t1", fmt.Sprintf("g-%d", i))
		ctx.Equal(r.Status, 202, "%s with needs %v: the profile grants them (%s)", tc.profile, tc.needs, r.Text())
	}
}

func CheckIdempotency(ctx *harness.Ctx) {
	c := api(ctx)
	first := submitJob(c, nil, "t1", "k-1")
	ctx.Equal(first.Status, 202, "the first submit (%s)", first.Text())
	replay := submitJob(c, nil, "t1", "k-1")
	ctx.Assert(replay.Status == 202 && jobOf(replay).JobID == jobOf(first).JobID, "a replay of Idempotency-Key k-1 answered %s, expected the original job %s", replay.Text(), jobOf(first).JobID)
	ctx.Equal(created(ctx), 1, "a submit and its replay must create one job (the retry queued the code again); jobs created")
	other := submitJob(c, nil, "t1", "k-2")
	ctx.Assert(jobOf(other).JobID != jobOf(first).JobID, "a new Idempotency-Key must create a new job")
	foreign := submitJob(c, nil, "t2", "k-1")
	ctx.Assert(foreign.Status == 202 && jobOf(foreign).JobID != jobOf(first).JobID, "tenant t2's key k-1 answered t1's job (%s): a key belongs to its tenant", foreign.Text())
	none := submitJob(c, nil, "t1", "")
	ctx.Equal(none.Status, 400, "a submit without Idempotency-Key")
	ctx.Equal(created(ctx), 3, "three distinct submits; jobs created")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <string>
#include <vector>

#include "sandbox/jobs.h"

namespace {

const std::string kCode = "print('hello from the sandbox')";

harness::HTTP api(harness::Ctx& ctx) {
  static httplib::Server* svr = nullptr;
  delete svr;
  svr = new httplib::Server;
  register_routes(*svr);
  return ctx.HTTP(*svr);
}

nlohmann::json body(const std::string& code, const std::string& profile, const std::vector<std::string>& needs) {
  return nlohmann::json{{"code", code}, {"profile", profile}, {"needs", needs}};
}

harness::Response submitJob(harness::HTTP& c, const nlohmann::json& b, const std::string& tenant, const std::string& key) {
  std::vector<std::string> headers = {"Content-Type", "application/json"};
  if (!tenant.empty()) headers.insert(headers.end(), {"X-Tenant-Id", tenant});
  if (!key.empty()) headers.insert(headers.end(), {"Idempotency-Key", key});
  return c.Send("POST", "/v1/sandbox/jobs", b.dump(), headers);
}

std::string field(const harness::Response& r, const std::string& name) {
  const auto j = nlohmann::json::parse(r.Text(), nullptr, false);
  return j.is_object() && j.contains(name) && j[name].is_string() ? j[name].get<std::string>() : "";
}

long created(harness::Ctx& ctx) {
  const auto text = ctx.Redis.Get("job:seq");
  return text ? std::stol(*text) : 0;
}

}  // namespace

void CheckRoute(harness::Ctx& ctx) {
  auto c = api(ctx);
  const auto r = submitJob(c, body(kCode, "gvisor", {"filesystem"}), "t1", "k-1");
  ctx.Equal(r.Status, 202, "POST /v1/sandbox/jobs (%s)", r.Text());
  const auto job = jobs::get(field(r, "job_id"));
  ctx.Assert(job && job->status == "queued", "the answered job_id %q is not a queued job in the store", field(r, "job_id"));
  ctx.Equal(field(r, "profile"), "gvisor", "the submit asked for gvisor; the answered profile");
  ctx.Equal(field(r, "code_digest"), jobs::digest(kCode), "code_digest must be the SHA-256 of the code");
  ctx.Assert(r.Text().find(kCode) == std::string::npos, "the response echoes the code: %s", r.Text());
}

void CheckLimits(harness::Ctx& ctx) {
  auto c = api(ctx);
  auto r = submitJob(c, body(kCode, "gvisor", {}), "", "k-1");
  ctx.Equal(r.Status, 401, "a submit without X-Tenant-Id");
  r = submitJob(c, body(std::string((1 << 18) + 1, 'x'), "gvisor", {}), "t1", "k-1");
  ctx.Equal(r.Status, 413, "a submit of 256 KiB + 1 byte of code");
  std::string wide;
  for (int i = 0; i < (1 << 17) + 1; i++) wide += "\\xc3\\xa9";
  r = submitJob(c, body(wide, "gvisor", {}), "t1", "k-1");
  ctx.Equal(r.Status, 413, "131073 two-byte characters (256 KiB + 2 bytes): count UTF-8 bytes, not characters");
  ctx.Equal(created(ctx), 0, "check the tenant and the size before anything is stored; jobs created by refused submits");
  r = submitJob(c, body(std::string(1 << 18, 'x'), "gvisor", {}), "t1", "k-2");
  ctx.Equal(r.Status, 202, "exactly 256 KiB of code (%s)", r.Text());
}

void CheckCapabilities(harness::Ctx& ctx) {
  auto c = api(ctx);
  struct Refused {
    std::string profile;
    std::vector<std::string> needs;
    std::string why;
  };
  const std::vector<Refused> refused = {{"privileged", {}, "an unknown profile"},
                                        {"runc", {"network"}, "network under runc"},
                                        {"gvisor", {"network"}, "network under gvisor"},
                                        {"kata", {"gpu"}, "a capability no profile grants"}};
  for (size_t i = 0; i < refused.size(); i++) {
    const auto r = submitJob(c, body(kCode, refused[i].profile, refused[i].needs), "t1", "r-" + std::to_string(i));
    ctx.Equal(r.Status, 400, "%s (%s): a declared need is granted only by the profile", refused[i].why, refused[i].profile);
  }
  ctx.Equal(created(ctx), 0, "jobs created by refused submits");
  const std::vector<std::pair<std::string, std::vector<std::string>>> granted = {
      {"kata", {"network"}}, {"gvisor", {"filesystem", "subprocess"}}, {"runc", {}}};
  for (size_t i = 0; i < granted.size(); i++) {
    const auto r = submitJob(c, body(kCode, granted[i].first, granted[i].second), "t1", "g-" + std::to_string(i));
    ctx.Equal(r.Status, 202, "%s with the needs its profile grants (%s)", granted[i].first, r.Text());
  }
}

void CheckIdempotency(harness::Ctx& ctx) {
  auto c = api(ctx);
  const auto plain = body(kCode, "gvisor", {});
  const auto first = submitJob(c, plain, "t1", "k-1");
  ctx.Equal(first.Status, 202, "the first submit (%s)", first.Text());
  const auto replay = submitJob(c, plain, "t1", "k-1");
  ctx.Assert(replay.Status == 202 && field(replay, "job_id") == field(first, "job_id"), "a replay of Idempotency-Key k-1 answered %s, expected the original job %s", replay.Text(), field(first, "job_id"));
  ctx.Equal(created(ctx), 1, "a submit and its replay must create one job (the retry queued the code again); jobs created");
  const auto other = submitJob(c, plain, "t1", "k-2");
  ctx.Assert(field(other, "job_id") != field(first, "job_id"), "a new Idempotency-Key must create a new job");
  const auto foreign = submitJob(c, plain, "t2", "k-1");
  ctx.Assert(foreign.Status == 202 && field(foreign, "job_id") != field(first, "job_id"), "tenant t2's key k-1 answered t1's job (%s): a key belongs to its tenant", foreign.Text());
  const auto none = submitJob(c, plain, "t1", "");
  ctx.Equal(none.Status, 400, "a submit without Idempotency-Key");
  ctx.Equal(created(ctx), 3, "three distinct submits; jobs created");
}
`,
  },
  hints: [
    'Submit without `X-Tenant-Id`, with a megabyte of code, or with `profile: "runc"` and `needs: ["network"]`: every one answers 202 and a job is queued. Retry a submit after a timeout and a second job appears.',
    'The handler validates nothing it reads: the tenant falls back to `anonymous`, the size is never measured, the needs go into the store as declared, and nothing looks at `Idempotency-Key` before `jobs.create`.',
    "Return 401 without a tenant and 413 when the code's UTF-8 bytes exceed `MAX_CODE_BYTES`; 400 unless the profile is in `ALLOWED_PROFILES` and each need in its `PROFILE_CAPABILITIES`; then `jobs.lookup(tenant, key)` before `create` and `remember`.",
  ],
  debrief: `Every refusal happens before \`jobs.create\`, because a stored job is already a promise to run it: the size, the tenant and the capability set are the boundary, and they are checked at the edge or not at all. The capability table is keyed by profile and consulted per need, so a need a submit declares is a request, not a grant; adding a capability means editing the table, not trusting the caller. The idempotency record is scoped by tenant, so one tenant's key can never answer another's job. A real submit path also reserves the key before creating the job, so two concurrent retries cannot both create one, and records who submitted what code digest for the audit trail.`,
};
