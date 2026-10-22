import type {Step} from '@/lib/types';

export const readStep: Step = {
  id: 'read',
  title: 'GET /v1/sandbox/jobs/{id}: results with provenance',
  concept: 'http',
  file: 'read',
  focus: ['client', 'api', 'store'],
  task: `## Task

The starter is a plausible model-generated draft: it returns the stored job and the demo shows a
result, so the read path looks done. It reports the wrong profile, serves the wrong tenant, and hands
out output nobody verified. Find the flaws, fix them, and prove the fix.

Implement \`GET /v1/sandbox/jobs/{job_id}\`:

- The tenant comes from \`X-Tenant-Id\` (**401** when missing). The job must belong to that tenant —
  a job id from another tenant is **404**, not a 403 that confirms the id exists and not a 200.
- Only a **finished** job has a result: a queued or running job answers **409**, so a reader can
  never mistake "not done yet" for "done". The draft returns whatever the record holds.
- Report the isolation profile the runner **actually used** (\`used_profile\`), not the one the
  submitter requested. Provenance means the read path describes what ran, not what was asked for.
- The response carries \`exit_code\` and \`usage\` (wall time, CPU time, peak memory, and whether the
  job hit its limit).
- Every output is returned as a **digest-verified download**: recompute the digest of the stored
  output and compare it with the recorded one before publishing a URL. On mismatch answer **500**
  and serve nothing — a result whose bytes do not match its digest is not a result.
- The draft also reads an expired job’s leftovers: a job whose lease lapsed without a result is not
  a finished job, and the **409/404** path above must catch it.

**Failure mode the checks target.** A read path that trusts the record is the last place a mistake
becomes invisible: the used profile is the evidence the isolation actually held, the digest is the
only proof the bytes are the ones the job produced, and the tenant check is what stops one tenant
from reading another tenant’s program output by guessing an id.`,
  sequence: {
    participants: ['Client', 'Sandbox API', 'job store'],
    messages: [
      {from: 'Client', to: 'Sandbox API', label: 'GET /v1/sandbox/jobs/{id} · X-Tenant-Id', kind: 'sync'},
      {from: 'Sandbox API', to: 'job store', label: 'get(job_id)', kind: 'sync'},
      {from: 'job store', to: 'Sandbox API', label: '{tenant, status, used_profile, digests}', kind: 'reply'},
      {from: 'Sandbox API', to: 'Sandbox API', label: 'other tenant or unfinished → 404 / 409', kind: 'sync'},
      {from: 'Sandbox API', to: 'job store', label: 'read_output(job_id) for the digest check', kind: 'sync'},
      {
        from: 'Sandbox API',
        to: 'Client',
        label: '200 {exit_code, usage, used_profile, output{url, digest}}',
        kind: 'reply',
      },
    ],
  },
  hints: [
    'The tenant is part of the lookup, not a filter after it: `if job is None or job["tenant"] != tenant: 404`. Returning the record first and checking afterwards is how one tenant reads another tenant’s output.',
    'Provenance is the point of the read path: `used_profile` comes from the runner’s record of what actually started, while `requested_profile` was only ever a request. An evaluator or an auditor comparing the two is the whole reason to store both.',
    'Verify before serving: recompute the digest of the stored output and compare it with the recorded digest. A mismatch is a 500 with no download, because a URL that serves bytes the job never produced is worse than an error. And a job that has not finished — or whose lease lapsed without a result — is a 409, never a 200 with an empty output.',
  ],
  checks: [
    {
      id: 'route',
      title: 'Handles GET /v1/sandbox/jobs/{id}',
      detail: 'Register the read route on `GET /v1/sandbox/jobs/{job_id}`.',
      match: {
        python: {all: [/@app\.get\(\s*["']\/v1\/sandbox\/jobs\/\{job_id\}["']/]},
        typescript: {all: [/app\.get\(\s*['"]\/v1\/sandbox\/jobs\/:id['"]/]},
        go: {all: [/HandleFunc\(\s*"GET \/v1\/sandbox\/jobs\//]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"sandbox"\s*\/\s*"jobs"\s*\/\s*Segment\s*\)/, /\bget\s*\{/]},
        cpp: {all: [/svr\.Get\(\s*"\/v1\/sandbox\/jobs\//]},
      },
    },
    {
      id: 'used-profile',
      title: 'Reports the isolation profile actually used',
      detail:
        'The response carries the runner’s `used_profile`, not the profile the submitter requested. The draft reports the requested one, so a container that started weaker reads as if it had been isolated.',
      match: {
        python: {all: [/used_profile/]},
        typescript: {all: [/used_profile/]},
        go: {all: [/UsedProfile/]},
        scala: {all: [/used_profile/]},
        cpp: {all: [/used_profile/]},
      },
    },
    {
      id: 'digest-verify',
      title: 'Verifies the output digest before serving it',
      detail:
        'The stored output is re-hashed and compared with the recorded digest (`verify_digest`); a mismatch is a 500 with no download. The draft hands out the raw output nobody checked.',
      match: {
        python: {all: [/def verify_digest\(/, /DIGEST_MISMATCH/]},
        typescript: {all: [/function verifyDigest/, /DIGEST_MISMATCH/]},
        go: {all: [/func verifyDigest\(/, /digestMismatch/]},
        scala: {all: [/def verifyDigest/, /DigestMismatch/]},
        cpp: {all: [/verifyDigest\(/, /kDigestMismatch/]},
      },
    },
    {
      id: 'tenant-scope',
      title: 'A foreign or unknown job is 404',
      detail:
        'The job id is looked up **with** the tenant, and a job belonging to someone else is **404**. The draft serves any tenant’s job by id — a cross-tenant read of another team’s program output.',
      match: {
        python: {all: [/tenant/, /status_code\s*=\s*404/]},
        typescript: {all: [/tenant/, /code\(\s*404\s*\)/]},
        go: {all: [/tenant/, /StatusNotFound/]},
        scala: {all: [/tenant/, /StatusCodes\.NotFound/]},
        cpp: {all: [/tenant/, /\b404\b/]},
      },
    },
    {
      id: 'finished-only',
      title: 'Serves a result only for a finished job',
      detail:
        'A queued, running or lease-expired job answers **409**, so the reader can tell "not done" from "done with no output". The draft returns a 200 for any record it finds.',
      match: {
        python: {all: [/JOB_FINISHED/, /status_code\s*=\s*409/]},
        typescript: {all: [/JOB_FINISHED/, /code\(\s*409\s*\)/]},
        go: {all: [/jobFinished/, /StatusConflict/]},
        scala: {all: [/JobFinished/, /StatusCodes\.Conflict/]},
        cpp: {all: [/kJobFinished/, /\b409\b/]},
      },
    },
  ],
  code: {
    python: {
      starter: `from fastapi import FastAPI
from fastapi.responses import JSONResponse

app = FastAPI()


class JobStore:
    def get(self, job_id: str) -> dict | None:
        """The job record, whoever it belongs to."""
        raise NotImplementedError

    def read_output(self, job_id: str) -> bytes:
        """The stored output bytes of the job."""
        raise NotImplementedError


store = JobStore()


@app.get("/v1/sandbox/jobs/{job_id}")
def read_job(job_id: str) -> JSONResponse:
    # TODO: check the tenant and answer 404 for a foreign job, refuse an unfinished job with 409,
    # report the profile that was actually used instead of the requested one, and verify the output
    # digest before publishing a download.
    job = store.get(job_id)
    return JSONResponse(
        {
            "job_id": job_id,
            "exit_code": job["exit_code"],
            "usage": job["usage"],
            "profile": job["requested_profile"],
            "output": {"url": f"/v1/sandbox/jobs/{job_id}/output", "body": store.read_output(job_id)},
        },
        status_code=200,
    )
`,
      solution: `import hashlib

from fastapi import FastAPI, Header, HTTPException

app = FastAPI()

JOB_FINISHED = "finished"
DIGEST_MISMATCH = "output digest does not match the stored result"


class JobStore:
    def get(self, job_id: str) -> dict | None:
        """The job record, whoever it belongs to."""
        raise NotImplementedError

    def read_output(self, job_id: str) -> bytes:
        """The stored output bytes of the job."""
        raise NotImplementedError


store = JobStore()


def verify_digest(body: bytes, digest: str) -> bool:
    """Whether the stored bytes are the ones the job produced: the only provenance the reader has."""
    return hashlib.sha256(body).hexdigest() == digest


@app.get("/v1/sandbox/jobs/{job_id}")
def read_job(
    job_id: str,
    tenant: str | None = Header(default=None, alias="X-Tenant-Id"),
) -> dict:
    if tenant is None or tenant == "":
        raise HTTPException(status_code=401, detail="missing X-Tenant-Id")
    job = store.get(job_id)
    if job is None or job["tenant"] != tenant:
        raise HTTPException(status_code=404, detail="job not found")
    if job["status"] != JOB_FINISHED:
        raise HTTPException(status_code=409, detail=f"job is {job['status']}")

    output = None
    if job["output_digest"] is not None:
        body = store.read_output(job_id)
        if not verify_digest(body, job["output_digest"]):
            raise HTTPException(status_code=500, detail=DIGEST_MISMATCH)
        output = {
            "url": f"/v1/sandbox/jobs/{job_id}/output",
            "digest": job["output_digest"],
            "verified": True,
        }
    return {
        "job_id": job_id,
        "status": job["status"],
        "exit_code": job["exit_code"],
        "usage": job["usage"],
        "used_profile": job["used_profile"],
        "output": output,
    }
`,
    },
    typescript: {
      starter: `/** GET /v1/sandbox/jobs/:id: a model-generated draft that serves any job it finds. */
import Fastify from 'fastify';

import {store} from './job_store';

export const app = Fastify();

app.get('/v1/sandbox/jobs/:id', async (request, reply) => {
  // TODO: check the tenant and answer 404 for a foreign job, refuse an unfinished job with 409,
  // report the profile that was actually used instead of the requested one, and verify the output
  // digest before publishing a download.
  const {id} = request.params as {id: string};
  const job = await store.get(id);
  return reply.code(200).send({
    job_id: id,
    exit_code: job.exitCode,
    usage: job.usage,
    profile: job.requestedProfile,
    output: {url: \`/v1/sandbox/jobs/\${id}/output\`, body: await store.readOutput(id)},
  });
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** GET /v1/sandbox/jobs/:id: the result with provenance — used profile and a verified digest. */
import {createHash} from 'node:crypto';
import Fastify from 'fastify';

import {store} from './job_store';

export const app = Fastify();

const JOB_FINISHED = 'finished';
const DIGEST_MISMATCH = 'output digest does not match the stored result';

/** Whether the stored bytes are the ones the job produced: the only provenance the reader has. */
function verifyDigest(body: Buffer, digest: string): boolean {
  return createHash('sha256').update(body).digest('hex') === digest;
}

app.get('/v1/sandbox/jobs/:id', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '')
    return reply.code(401).send({error: 'missing X-Tenant-Id'});
  const {id} = request.params as {id: string};
  const job = await store.get(id);
  if (job === null || job.tenant !== tenant) return reply.code(404).send({error: 'job not found'});
  if (job.status !== JOB_FINISHED) return reply.code(409).send({error: \`job is \${job.status}\`});

  let output = null;
  if (job.outputDigest !== null) {
    const body = await store.readOutput(id);
    if (!verifyDigest(body, job.outputDigest)) return reply.code(500).send({error: DIGEST_MISMATCH});
    output = {url: \`/v1/sandbox/jobs/\${id}/output\`, digest: job.outputDigest, verified: true};
  }
  return reply.code(200).send({
    job_id: id,
    status: job.status,
    exit_code: job.exitCode,
    usage: job.usage,
    used_profile: job.usedProfile,
    output,
  });
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"net/http"
)

type JobRecord struct {
	JobID            string         \`json:"job_id"\`
	Tenant           string         \`json:"tenant"\`
	Status           string         \`json:"status"\`
	ExitCode         int            \`json:"exit_code"\`
	Usage            map[string]int \`json:"usage"\`
	RequestedProfile string         \`json:"requested_profile"\`
	OutputDigest     string         \`json:"output_digest"\`
}

type JobStore struct{}

func (s *JobStore) Get(ctx context.Context, jobID string) (*JobRecord, error) { return nil, nil }

func (s *JobStore) ReadOutput(ctx context.Context, jobID string) ([]byte, error) { return nil, nil }

var store = &JobStore{}

func readJob(rw http.ResponseWriter, r *http.Request) {
	// TODO: check the tenant and answer 404 for a foreign job, refuse an unfinished job with 409,
	// report the profile that was actually used instead of the requested one, and verify the output
	// digest before publishing a download.
	jobID := r.PathValue("id")
	job, _ := store.Get(r.Context(), jobID)
	body, _ := store.ReadOutput(r.Context(), jobID)
	writeJSON(rw, http.StatusOK, map[string]any{
		"job_id":    jobID,
		"exit_code": job.ExitCode,
		"usage":     job.Usage,
		"profile":   job.RequestedProfile,
		"output":    string(body),
	})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/sandbox/jobs/{id}", readJob)
}
`,
      solution: `package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"log"
	"net/http"
)

const (
	jobFinished    = "finished"
	digestMismatch = "output digest does not match the stored result"
)

type JobRecord struct {
	JobID        string         \`json:"job_id"\`
	Tenant       string         \`json:"tenant"\`
	Status       string         \`json:"status"\`
	ExitCode     int            \`json:"exit_code"\`
	Usage        map[string]int \`json:"usage"\`
	UsedProfile  string         \`json:"used_profile"\`
	OutputDigest string         \`json:"output_digest"\`
}

type JobStore struct{}

func (s *JobStore) Get(ctx context.Context, jobID string) (*JobRecord, error) { return nil, nil }

func (s *JobStore) ReadOutput(ctx context.Context, jobID string) ([]byte, error) { return nil, nil }

var store = &JobStore{}

// Whether the stored bytes are the ones the job produced: the only provenance the reader has.
func verifyDigest(body []byte, digest string) bool {
	sum := sha256.Sum256(body)
	return hex.EncodeToString(sum[:]) == digest
}

func readJob(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-Tenant-Id"})
		return
	}
	jobID := r.PathValue("id")
	job, _ := store.Get(r.Context(), jobID)
	if job == nil || job.Tenant != tenant {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "job not found"})
		return
	}
	if job.Status != jobFinished {
		writeJSON(rw, http.StatusConflict, map[string]string{"error": "job is " + job.Status})
		return
	}
	var output any
	if job.OutputDigest != "" {
		body, _ := store.ReadOutput(r.Context(), jobID)
		if !verifyDigest(body, job.OutputDigest) {
			writeJSON(rw, http.StatusInternalServerError, map[string]string{"error": digestMismatch})
			return
		}
		output = map[string]any{
			"url":      "/v1/sandbox/jobs/" + jobID + "/output",
			"digest":   job.OutputDigest,
			"verified": true,
		}
	}
	writeJSON(rw, http.StatusOK, map[string]any{
		"job_id":       jobID,
		"status":       job.Status,
		"exit_code":    job.ExitCode,
		"usage":        job.Usage,
		"used_profile": job.UsedProfile,
		"output":       output,
	})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/sandbox/jobs/{id}", readJob)
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

object ReadApi {
  implicit val system: ActorSystem = ActorSystem("sandbox")

  val route: Route =
    path("v1" / "sandbox" / "jobs" / Segment) { jobId =>
      get {
        // TODO: check the tenant and answer 404 for a foreign job, refuse an unfinished job with
        // 409, report the profile that was actually used, and verify the output digest before
        // publishing a download.
        val job = store.get(jobId).get
        complete(
          StatusCodes.OK,
          s"""{"job_id":"$jobId","exit_code":\${job.exitCode},"profile":"\${job.requestedProfile}","output":"\${store.readOutput(jobId)}"}"""
        )
      }
    }

  def main(args: Array[String]): Unit = {
    Http().newServerAt("0.0.0.0", 8443).bind(route)
  }
}
`,
      solution: `import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import java.security.MessageDigest

object ReadApi {
  implicit val system: ActorSystem = ActorSystem("sandbox")

  val JobFinished = "finished"
  val DigestMismatch = "output digest does not match the stored result"

  // Whether the stored bytes are the ones the job produced: the only provenance the reader has.
  def verifyDigest(body: Array[Byte], digest: String): Boolean = {
    MessageDigest.getInstance("SHA-256").digest(body).map("%02x".format(_)).mkString == digest
  }

  val route: Route =
    path("v1" / "sandbox" / "jobs" / Segment) { jobId =>
      get {
        optionalHeaderValueByName("X-Tenant-Id") { tenantOpt =>
          if (!tenantOpt.exists(_.nonEmpty)) {
            complete(StatusCodes.Unauthorized, """{"error":"missing X-Tenant-Id"}""")
          } else {
            store.get(jobId) match {
              case Some(job) if job.tenant == tenantOpt.get =>
                if (job.status != JobFinished) {
                  complete(StatusCodes.Conflict, s"""{"error":"job is \${job.status}"}""")
                } else {
                  val output = job.outputDigest.map { digest =>
                    if (!verifyDigest(store.readOutput(jobId), digest)) {
                      throw new IllegalStateException(DigestMismatch)
                    }
                    s"""{"url":"/v1/sandbox/jobs/$jobId/output","digest":"$digest","verified":true}"""
                  }
                  complete(
                    StatusCodes.OK,
                    s"""{"job_id":"$jobId","exit_code":\${job.exitCode},"usage":\${job.usage.toJson.compactPrint},"used_profile":"\${job.usedProfile}","output":\${output.getOrElse("null")}}"""
                  )
                }
              case _ =>
                complete(StatusCodes.NotFound, """{"error":"job not found"}""")
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

#include <string>

using json = nlohmann::json;

struct JobStore {
  std::optional<json> get(const std::string& jobId);
  std::string readOutput(const std::string& jobId);
};

JobStore store;

int main() {
  httplib::Server svr;

  svr.Get("/v1/sandbox/jobs/([^/]+)", [](const httplib::Request& req, httplib::Response& res) {
    // TODO: check the tenant and answer 404 for a foreign job, refuse an unfinished job with 409,
    // report the profile that was actually used instead of the requested one, and verify the output
    // digest before publishing a download.
    const auto jobId = req.matches[1].str();
    const auto job = store.get(jobId);
    res.status = 200;
    res.set_content(
        json{{"job_id", jobId},
             {"exit_code", (*job)["exit_code"]},
             {"profile", (*job)["requested_profile"]},
             {"output", store.readOutput(jobId)}}
            .dump(),
        "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <openssl/sha.h>
#include <nlohmann/json.hpp>

#include <iomanip>
#include <sstream>
#include <string>

using json = nlohmann::json;

const std::string kJobFinished = "finished";
const std::string kDigestMismatch = "output digest does not match the stored result";

struct JobStore {
  std::optional<json> get(const std::string& jobId);
  std::string readOutput(const std::string& jobId);
};

JobStore store;

// Whether the stored bytes are the ones the job produced: the only provenance the reader has.
bool verifyDigest(const std::string& body, const std::string& digest) {
  unsigned char sum[SHA256_DIGEST_LENGTH];
  SHA256(reinterpret_cast<const unsigned char*>(body.data()), body.size(), sum);
  std::ostringstream out;
  for (unsigned char byte : sum) out << std::hex << std::setw(2) << std::setfill('0') << static_cast<int>(byte);
  return out.str() == digest;
}

int main() {
  httplib::Server svr;

  svr.Get("/v1/sandbox/jobs/([^/]+)", [](const httplib::Request& req, httplib::Response& res) {
    const auto tenant = req.get_header_value("X-Tenant-Id");
    if (tenant.empty()) {
      res.status = 401;
      res.set_content(R"({"error":"missing X-Tenant-Id"})", "application/json");
      return;
    }
    const auto jobId = req.matches[1].str();
    const auto job = store.get(jobId);
    if (!job || (*job)["tenant"] != tenant) {
      res.status = 404;
      res.set_content(R"({"error":"job not found"})", "application/json");
      return;
    }
    if ((*job)["status"] != kJobFinished) {
      res.status = 409;
      res.set_content(R"({"error":"job is not finished"})", "application/json");
      return;
    }

    json output = nullptr;
    const auto digest = (*job)["output_digest"].is_null() ? std::string() : (*job)["output_digest"].get<std::string>();
    if (!digest.empty()) {
      if (!verifyDigest(store.readOutput(jobId), digest)) {
        res.status = 500;
        res.set_content(json{{"error", kDigestMismatch}}.dump(), "application/json");
        return;
      }
      output = json{{"url", "/v1/sandbox/jobs/" + jobId + "/output"}, {"digest", digest}, {"verified", true}};
    }
    res.status = 200;
    res.set_content(
        json{{"job_id", jobId},
             {"exit_code", (*job)["exit_code"]},
             {"usage", (*job)["usage"]},
             {"used_profile", (*job)["used_profile"]},
             {"output", output}}
            .dump(),
        "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  debrief: `The interview question is "what makes a stored result trustworthy?" Three things, in this
order. The tenant is part of the primary key, so a read is scoped by construction and a foreign job
id is indistinguishable from an unknown one — 404 for both, because a 403 confirms the id exists.
The status is part of the answer: returning a job that is still queued, or whose lease lapsed
without a result, teaches every caller to treat an empty output as a real one. And the digest is the
read path’s own verification: the runner recorded what it ran, so the API can prove the bytes it is
about to serve are the bytes the job produced instead of trusting a path it never checked. The used
profile belongs in the same sentence — provenance means describing what ran, and the requested
profile is a request, not a fact. Real platforms add signed download URLs with short TTLs, per-tenant
access logs on every read, and a retention policy that deletes output bytes while keeping the
digests.`,
};
