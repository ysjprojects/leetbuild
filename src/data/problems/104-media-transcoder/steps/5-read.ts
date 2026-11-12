import type {Step} from '@/lib/types';

export const readStep: Step = {
  id: 'read',
  title: 'GET /v1/transcodes/{id}: state from the manifest, failed segments, signed renditions',
  concept: 'http',
  file: 'read',
  focus: ['client', 'api', 'redis', 'output'],
  task: `## Task

**Starting point.** The starter serves \`GET /v1/transcodes/{job_id}\` with \`X-Tenant-Id\`: it
loads the job (\`jobs.get\`), reads \`segments.manifest\`, computes \`percent\` from the done count
and answers \`{job_id, state, percent, segment_count, completed_segments, renditions}\`, with
\`state\` \`"done"\` from 99 % and each rendition's storage URL. It renders a progress bar and it
hides four flaws.

**Failure mode the checks target.** A 100-segment job reports done with a segment missing; a job
whose segment failed reports "processing" forever and nobody can tell which segment to re-run; any
tenant reads any job by id; and the URLs handed to the player never expire.

- A job whose tenant is not \`X-Tenant-Id\` answers **404** with the same body as a job that does
  not exist.
- \`state\` is \`"failed"\` when \`segments.failed(job_id)\` lists anything, \`"done"\` only when the
  manifest is \`complete\`, else \`"processing"\`; the response carries \`failed_segments\`.
- Renditions are listed once the job is done, each with \`urls.sign(bucket, key, expires_at)\` and
  \`expires_at\` = now + \`urls.SIGNED_URL_TTL_S\`, signed at read time.`,
  sequence: {
    participants: ['Player', 'transcoderd', 'job store', 'Redis'],
    messages: [
      {from: 'Player', to: 'transcoderd', label: 'GET /v1/transcodes/tj-7 · X-Tenant-Id', kind: 'sync'},
      {from: 'transcoderd', to: 'job store', label: 'get(tj-7) → tenant, segment_count, renditions', kind: 'sync'},
      {from: 'transcoderd', to: 'transcoderd', label: 'tenant ≠ caller → 404 (same as missing)', kind: 'sync'},
      {from: 'transcoderd', to: 'Redis', label: 'manifest(tj-7, n) · failed(tj-7)', kind: 'sync'},
      {from: 'Redis', to: 'transcoderd', label: 'done · missing · failed indices', kind: 'reply'},
      {
        from: 'transcoderd',
        to: 'Player',
        label: '200 {state, completed_segments, failed_segments, signed renditions}',
        kind: 'reply',
      },
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Handles GET /v1/transcodes/{id}',
      detail:
        'Register `GET /v1/transcodes/{id}`: the owner reads the job with its segment count and completed segments.',
      match: {
        python: {all: [/@app\.get\(\s*["']\/v1\/transcodes\/\{/]},
        typescript: {all: [/app\.get\(\s*['"]\/v1\/transcodes\/:/]},
        go: {all: [/HandleFunc\(\s*"GET \/v1\/transcodes\/\{/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"transcodes"\s*\/\s*Segment\s*\)/, /\bget\s*\{/]},
        cpp: {all: [/svr\.Get\(\s*R?"\(?\/v1\/transcodes\//]},
      },
    },
    {
      id: 'done-manifest',
      title: '"done" only when the manifest covers every segment',
      detail:
        'The state follows the manifest: `"done"` only when it is `complete`, nothing missing. The starter calls 99 % done, which on a 100-segment job is a missing segment.',
      match: {
        python: {all: [/coverage\[["']complete["']\]/], none: [/\b99\b|percent/]},
        typescript: {all: [/coverage\.complete\b/], none: [/\b99\b|percent/]},
        go: {all: [/coverage\.Complete\b/], none: [/\b99\b|percent/]},
        scala: {all: [/coverage\.complete\b/], none: [/\b99\b|percent/]},
        cpp: {all: [/coverage\.complete\b/], none: [/\b99\b|percent/]},
      },
    },
    {
      id: 'failed-indices',
      title: 'Failed segments are reported, and fail the job',
      detail:
        'The read asks `failed(job_id)`, answers the sorted indices as `failed_segments` and the state `"failed"` when there are any; the starter never looks, so a failed segment reads as "processing" forever.',
      match: {
        python: {all: [/segments\.failed\(/, /failed_segments/]},
        typescript: {all: [/await failed\(/, /failed_segments/]},
        go: {all: [/segments\.Failed\(/, /failed_segments/]},
        scala: {all: [/Segments\.failed\(/, /failed_segments/]},
        cpp: {all: [/segments::failed\(/, /failed_segments/]},
      },
    },
    {
      id: 'owner-404',
      title: "Another tenant's job is 404",
      detail:
        "The job's tenant is compared with `X-Tenant-Id` before anything is rendered, and a mismatch answers 404 exactly like a missing job, so a guessed id reveals nothing.",
      match: {
        python: {all: [/job\[["']tenant["']\]\s*!=\s*tenant/]},
        typescript: {all: [/job\.tenant\s*!==\s*tenant/]},
        go: {all: [/job\.Tenant\s*!=\s*tenant/]},
        scala: {all: [/\.tenant\s*!=\s*tenant/]},
        cpp: {all: [/job->tenant\s*!=\s*tenant/]},
      },
    },
    {
      id: 'signed-renditions',
      title: 'Renditions are signed at read time',
      detail:
        'Each rendition carries `sign(bucket, key, expires_at)` with `expires_at` = now + `SIGNED_URL_TTL_S`, computed per read; a plain storage URL hands the player a grant that never lapses.',
      match: {
        python: {all: [/urls\.sign\(/, /urls\.SIGNED_URL_TTL_S/], none: [/storage\.example/]},
        typescript: {all: [/\bsign\(/, /SIGNED_URL_TTL_S/], none: [/storage\.example/]},
        go: {all: [/urls\.Sign\(/, /urls\.SignedURLTTL/], none: [/storage\.example/]},
        scala: {all: [/Urls\.sign\(/, /Urls\.SignedUrlTtlSeconds/], none: [/storage\.example/]},
        cpp: {all: [/urls::sign\(/, /urls::kSignedUrlTtlS/], none: [/storage\.example/]},
      },
    },
  ],
  code: {
    python: {
      starter: `from fastapi import FastAPI, HTTPException, Request

from transcoder import jobs  # jobs.get
from transcoder import segments  # segments.manifest, segments.failed
from transcoder import urls  # urls.sign(bucket, key, expires_at), urls.SIGNED_URL_TTL_S

app = FastAPI()


@app.get("/v1/transcodes/{job_id}")
def read_job(job_id: str, request: Request) -> dict:
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    tenant = request.headers.get("x-tenant-id", "")
    if not tenant:
        raise HTTPException(status_code=401, detail="X-Tenant-Id is required")
    job = jobs.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="no such job")
    coverage = segments.manifest(job_id, job["segment_count"])
    percent = 100 * len(coverage["done"]) // job["segment_count"]
    renditions = [
        {"preset": r["preset"], "duration_s": r["duration_s"], "url": f"https://{job['output_bucket']}.storage.example/{r['key']}"}
        for r in job["renditions"]
    ]
    return {
        "job_id": job_id,
        "state": "done" if percent >= 99 else "processing",
        "percent": percent,
        "segment_count": job["segment_count"],
        "completed_segments": len(coverage["done"]),
        "renditions": renditions,
    }
`,
      solution: `import time

from fastapi import FastAPI, HTTPException, Request

from transcoder import jobs  # jobs.get
from transcoder import segments  # segments.manifest, segments.failed
from transcoder import urls  # urls.sign(bucket, key, expires_at), urls.SIGNED_URL_TTL_S

app = FastAPI()


@app.get("/v1/transcodes/{job_id}")
def read_job(job_id: str, request: Request) -> dict:
    tenant = request.headers.get("x-tenant-id", "")
    if not tenant:
        raise HTTPException(status_code=401, detail="X-Tenant-Id is required")
    job = jobs.get(job_id)
    # Another tenant's job looks exactly like a job that does not exist.
    if job is None or job["tenant"] != tenant:
        raise HTTPException(status_code=404, detail="no such job")
    coverage = segments.manifest(job_id, job["segment_count"])
    failed = segments.failed(job_id)
    state = "failed" if failed else "done" if coverage["complete"] else "processing"
    renditions = []
    if state == "done":
        # Signed per read: the player gets a grant that lapses, the job row keeps only the key.
        expires_at = int(time.time()) + urls.SIGNED_URL_TTL_S
        renditions = [
            {"preset": r["preset"], "duration_s": r["duration_s"], "url": urls.sign(job["output_bucket"], r["key"], expires_at), "expires_at": expires_at}
            for r in job["renditions"]
        ]
    return {
        "job_id": job_id,
        "state": state,
        "segment_count": job["segment_count"],
        "completed_segments": len(coverage["done"]),
        "failed_segments": failed,
        "renditions": renditions,
    }
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';

import {get} from 'transcoder/jobs';
import {failed, manifest} from 'transcoder/segments';
import {SIGNED_URL_TTL_S, sign} from 'transcoder/urls';

export const app = Fastify();

app.get('/v1/transcodes/:jobId', async (request, reply) => {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'X-Tenant-Id is required'});
  const {jobId} = request.params as {jobId: string};
  const job = await get(jobId);
  if (job === null) return reply.code(404).send({error: 'no such job'});
  const coverage = await manifest(jobId, job.segment_count);
  const percent = Math.floor((100 * coverage.done.length) / job.segment_count);
  const renditions = job.renditions.map(r => ({preset: r.preset, duration_s: r.duration_s, url: \`https://\${job.output_bucket}.storage.example/\${r.key}\`}));
  return {
    job_id: jobId,
    state: percent >= 99 ? 'done' : 'processing',
    percent,
    segment_count: job.segment_count,
    completed_segments: coverage.done.length,
    renditions,
  };
});
`,
      solution: `import Fastify from 'fastify';

import {get} from 'transcoder/jobs';
import {failed, manifest} from 'transcoder/segments';
import {SIGNED_URL_TTL_S, sign} from 'transcoder/urls';

export const app = Fastify();

app.get('/v1/transcodes/:jobId', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'X-Tenant-Id is required'});
  const {jobId} = request.params as {jobId: string};
  const job = await get(jobId);
  // Another tenant's job looks exactly like a job that does not exist.
  if (job === null || job.tenant !== tenant) return reply.code(404).send({error: 'no such job'});
  const coverage = await manifest(jobId, job.segment_count);
  const failedSegments = await failed(jobId);
  const state = failedSegments.length > 0 ? 'failed' : coverage.complete ? 'done' : 'processing';
  // Signed per read: the player gets a grant that lapses, the job row keeps only the key.
  const expires_at = Math.floor(Date.now() / 1000) + SIGNED_URL_TTL_S;
  const renditions =
    state === 'done' ? job.renditions.map(r => ({preset: r.preset, duration_s: r.duration_s, url: sign(job.output_bucket, r.key, expires_at), expires_at})) : [];
  return {
    job_id: jobId,
    state,
    segment_count: job.segment_count,
    completed_segments: coverage.done.length,
    failed_segments: failedSegments,
    renditions,
  };
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"net/http"

	"transcoder/jobs"     // jobs.Get
	"transcoder/segments" // segments.Manifest, segments.Failed; urls.Sign and urls.SignedURLTTL live in "transcoder/urls"
)

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func readJob(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		http.Error(rw, "X-Tenant-Id is required", http.StatusUnauthorized)
		return
	}
	jobID := r.PathValue("id")
	job := jobs.Get(r.Context(), jobID)
	if job == nil {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "no such job"})
		return
	}
	coverage, err := segments.Manifest(r.Context(), jobID, job.SegmentCount)
	if err != nil {
		http.Error(rw, err.Error(), http.StatusInternalServerError)
		return
	}
	percent := 100 * len(coverage.Done) / job.SegmentCount
	state := "processing"
	if percent >= 99 {
		state = "done"
	}
	renditions := []map[string]any{}
	for _, rd := range job.Renditions {
		renditions = append(renditions, map[string]any{"preset": rd.Preset, "duration_s": rd.DurationS, "url": "https://" + job.OutputBucket + ".storage.example/" + rd.Key})
	}
	writeJSON(rw, http.StatusOK, map[string]any{
		"job_id": jobID, "state": state, "percent": percent, "segment_count": job.SegmentCount,
		"completed_segments": len(coverage.Done), "renditions": renditions,
	})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/transcodes/{id}", readJob)
}
`,
      solution: `package main

import (
	"encoding/json"
	"net/http"
	"time"

	"transcoder/jobs"     // jobs.Get
	"transcoder/segments" // segments.Manifest, segments.Failed
	"transcoder/urls"     // urls.Sign(bucket, key, expiresAt), urls.SignedURLTTL
)

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func readJob(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		http.Error(rw, "X-Tenant-Id is required", http.StatusUnauthorized)
		return
	}
	jobID := r.PathValue("id")
	job := jobs.Get(r.Context(), jobID)
	// Another tenant's job looks exactly like a job that does not exist.
	if job == nil || job.Tenant != tenant {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "no such job"})
		return
	}
	coverage, err := segments.Manifest(r.Context(), jobID, job.SegmentCount)
	if err != nil {
		http.Error(rw, err.Error(), http.StatusInternalServerError)
		return
	}
	failed, err := segments.Failed(r.Context(), jobID)
	if err != nil {
		http.Error(rw, err.Error(), http.StatusInternalServerError)
		return
	}
	state := "processing"
	if len(failed) > 0 {
		state = "failed"
	} else if coverage.Complete {
		state = "done"
	}
	renditions := []map[string]any{}
	if state == "done" {
		// Signed per read: the player gets a grant that lapses, the job row keeps only the key.
		expiresAt := time.Now().Unix() + urls.SignedURLTTL
		for _, rd := range job.Renditions {
			renditions = append(renditions, map[string]any{"preset": rd.Preset, "duration_s": rd.DurationS, "url": urls.Sign(job.OutputBucket, rd.Key, expiresAt), "expires_at": expiresAt})
		}
	}
	writeJSON(rw, http.StatusOK, map[string]any{
		"job_id": jobID, "state": state, "segment_count": job.SegmentCount,
		"completed_segments": len(coverage.Done), "failed_segments": failed, "renditions": renditions,
	})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/transcodes/{id}", readJob)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import transcoder.{Jobs, Segments, Urls} // Jobs.get, Segments.manifest, Segments.failed, Urls.sign, Urls.SignedUrlTtlSeconds

object Read {
  private def json(status: StatusCode, body: JsValue): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  private val NoSuchJob = JsObject("error" -> JsString("no such job"))

  val route: Route = path("v1" / "transcodes" / Segment) { jobId =>
    get {
      optionalHeaderValueByName("X-Tenant-Id") {
        case None | Some("") => complete(StatusCodes.Unauthorized -> "X-Tenant-Id is required")
        case Some(tenant) =>
          // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
          Jobs.get(jobId) match {
            case None => complete(json(StatusCodes.NotFound, NoSuchJob))
            case Some(job) =>
              val coverage = Segments.manifest(jobId, job.segmentCount)
              val percent = 100 * coverage.done.size / job.segmentCount
              val renditions = job.renditions.map { r =>
                JsObject("preset" -> JsString(r.preset), "duration_s" -> JsNumber(r.durationS),
                  "url" -> JsString(s"https://\${job.outputBucket}.storage.example/\${r.key}"))
              }
              complete(json(StatusCodes.OK, JsObject(
                "job_id" -> JsString(jobId), "state" -> JsString(if (percent >= 99) "done" else "processing"), "percent" -> JsNumber(percent),
                "segment_count" -> JsNumber(job.segmentCount), "completed_segments" -> JsNumber(coverage.done.size),
                "renditions" -> JsArray(renditions.toVector))))
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

import transcoder.{Jobs, Segments, Urls} // Jobs.get, Segments.manifest, Segments.failed, Urls.sign, Urls.SignedUrlTtlSeconds

object Read {
  private def json(status: StatusCode, body: JsValue): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  private val NoSuchJob = JsObject("error" -> JsString("no such job"))

  val route: Route = path("v1" / "transcodes" / Segment) { jobId =>
    get {
      optionalHeaderValueByName("X-Tenant-Id") {
        case None | Some("") => complete(StatusCodes.Unauthorized -> "X-Tenant-Id is required")
        case Some(tenant) =>
          Jobs.get(jobId) match {
            // Another tenant's job looks exactly like a job that does not exist.
            case Some(job) if job.tenant != tenant => complete(json(StatusCodes.NotFound, NoSuchJob))
            case None => complete(json(StatusCodes.NotFound, NoSuchJob))
            case Some(job) =>
              val coverage = Segments.manifest(jobId, job.segmentCount)
              val failed = Segments.failed(jobId)
              val state = if (failed.nonEmpty) "failed" else if (coverage.complete) "done" else "processing"
              // Signed per read: the player gets a grant that lapses, the job row keeps only the key.
              val expiresAt = System.currentTimeMillis() / 1000 + Urls.SignedUrlTtlSeconds
              val renditions =
                if (state != "done") Vector.empty
                else job.renditions.toVector.map { r =>
                  JsObject("preset" -> JsString(r.preset), "duration_s" -> JsNumber(r.durationS),
                    "url" -> JsString(Urls.sign(job.outputBucket, r.key, expiresAt)), "expires_at" -> JsNumber(expiresAt))
                }
              complete(json(StatusCodes.OK, JsObject(
                "job_id" -> JsString(jobId), "state" -> JsString(state), "segment_count" -> JsNumber(job.segmentCount),
                "completed_segments" -> JsNumber(coverage.done.size), "failed_segments" -> JsArray(failed.map(JsNumber(_)).toVector),
                "renditions" -> JsArray(renditions))))
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

#include "transcoder/jobs.h"      // jobs::get
#include "transcoder/segments.h"  // segments::manifest, segments::failed
#include "transcoder/urls.h"      // urls::sign(bucket, key, expires_at), urls::kSignedUrlTtlS

using json = nlohmann::json;

void read_job(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) {
    res.status = 401;
    res.set_content("X-Tenant-Id is required", "text/plain");
    return;
  }
  const std::string job_id = req.matches[1];
  const auto job = jobs::get(job_id);
  if (!job) {
    res.status = 404;
    res.set_content(json{{"error", "no such job"}}.dump(), "application/json");
    return;
  }
  const segments::Coverage coverage = segments::manifest(job_id, job->segment_count);
  const int percent = 100 * static_cast<int>(coverage.done.size()) / job->segment_count;
  json renditions = json::array();
  for (const jobs::Rendition& r : job->renditions) {
    renditions.push_back({{"preset", r.preset}, {"duration_s", r.duration_s}, {"url", "https://" + job->output_bucket + ".storage.example/" + r.key}});
  }
  res.set_content(json{{"job_id", job_id},
                       {"state", percent >= 99 ? "done" : "processing"},
                       {"percent", percent},
                       {"segment_count", job->segment_count},
                       {"completed_segments", coverage.done.size()},
                       {"renditions", renditions}}
                      .dump(),
                  "application/json");
}

void register_routes(httplib::Server& svr) { svr.Get(R"(/v1/transcodes/([\\w-]+))", read_job); }
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <chrono>
#include <string>
#include <vector>

#include "transcoder/jobs.h"      // jobs::get
#include "transcoder/segments.h"  // segments::manifest, segments::failed
#include "transcoder/urls.h"      // urls::sign(bucket, key, expires_at), urls::kSignedUrlTtlS

using json = nlohmann::json;

void read_job(const httplib::Request& req, httplib::Response& res) {
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) {
    res.status = 401;
    res.set_content("X-Tenant-Id is required", "text/plain");
    return;
  }
  const std::string job_id = req.matches[1];
  const auto job = jobs::get(job_id);
  // Another tenant's job looks exactly like a job that does not exist.
  if (!job || job->tenant != tenant) {
    res.status = 404;
    res.set_content(json{{"error", "no such job"}}.dump(), "application/json");
    return;
  }
  const segments::Coverage coverage = segments::manifest(job_id, job->segment_count);
  const std::vector<int> failed = segments::failed(job_id);
  const std::string state = !failed.empty() ? "failed" : coverage.complete ? "done" : "processing";
  json renditions = json::array();
  if (state == "done") {
    // Signed per read: the player gets a grant that lapses, the job row keeps only the key.
    const long long now = std::chrono::duration_cast<std::chrono::seconds>(std::chrono::system_clock::now().time_since_epoch()).count();
    const long long expires_at = now + urls::kSignedUrlTtlS;
    for (const jobs::Rendition& r : job->renditions) {
      renditions.push_back({{"preset", r.preset}, {"duration_s", r.duration_s}, {"url", urls::sign(job->output_bucket, r.key, expires_at)}, {"expires_at", expires_at}});
    }
  }
  res.set_content(json{{"job_id", job_id},
                       {"state", state},
                       {"segment_count", job->segment_count},
                       {"completed_segments", coverage.done.size()},
                       {"failed_segments", failed},
                       {"renditions", renditions}}
                      .dump(),
                  "application/json");
}

void register_routes(httplib::Server& svr) { svr.Get(R"(/v1/transcodes/([\\w-]+))", read_job); }
`,
    },
  },
  harness: {
    python: `from transcoder import jobs, presets, segments, urls


def _job(duration, tenant="t-1"):
    return jobs.create(tenant, "s3://uploads/talk.mov", "9f" * 32, duration, "h264-720p", presets.encoder_args("h264-720p"), "renditions", "talks/42")


def _done(job, indices):
    for i in indices:
        segments.mark_done(job["job_id"], i)


def _api(ctx):
    return ctx.client(ctx.load("read").app)


async def _read(c, job_id, tenant="t-1"):
    return await c.get(f"/v1/transcodes/{job_id}", headers={"X-Tenant-Id": tenant})


async def check_route(ctx):
    job = _job(18.0)
    _done(job, [0])
    async with _api(ctx) as c:
        r = await _read(c, job["job_id"])
    assert r.status_code == 200, f"the owner's read answered {r.status_code}: {r.text}"
    body = r.json()
    assert body.get("job_id") == job["job_id"] and body.get("segment_count") == 3 and body.get("completed_segments") == 1, f"a 3-segment job with segment 0 done answered {body}"
    assert body.get("state") == "processing", f"a job with 1 of 3 segments done reads as {body.get('state')!r}, expected processing"


async def check_done_manifest(ctx):
    job = _job(600.0)
    _done(job, [i for i in range(100) if i != 57])
    async with _api(ctx) as c:
        r = await _read(c, job["job_id"])
        body = r.json()
        assert body.get("completed_segments") == 99 and body.get("state") == "processing", f"a 100-segment job with segment 57 missing reads as {body.get('state')!r} ({body.get('completed_segments')} completed): done means every segment exists, not 99 %"
        _done(job, [57])
        r = await _read(c, job["job_id"])
    assert r.json().get("state") == "done", f"with every segment done the job reads as {r.json().get('state')!r}, expected done"


async def check_failed_indices(ctx):
    job = _job(30.0)
    _done(job, [0, 1, 3])
    segments.mark_failed(job["job_id"], 4)
    segments.mark_failed(job["job_id"], 2)
    async with _api(ctx) as c:
        r = await _read(c, job["job_id"])
    body = r.json()
    assert body.get("failed_segments") == [2, 4], f"segments 4 and 2 failed and the read answers failed_segments {body.get('failed_segments')!r}, expected [2, 4]"
    assert body.get("state") == "failed", f"a job with failed segments reads as {body.get('state')!r}, expected failed"


async def check_owner_404(ctx):
    job = _job(18.0)
    _done(job, [0, 1, 2])
    async with _api(ctx) as c:
        foreign = await _read(c, job["job_id"], tenant="t-2")
        missing = await _read(c, "tj-999", tenant="t-2")
        own = await _read(c, job["job_id"])
    assert foreign.status_code == 404, f"tenant t-2 read t-1's job and got {foreign.status_code}: {foreign.text}"
    assert foreign.text == missing.text, f"a foreign job answered {foreign.text} and a missing one {missing.text}: the two must be indistinguishable"
    assert own.status_code == 200, f"the owner's read answered {own.status_code}"


async def check_signed_renditions(ctx):
    job = _job(18.0)
    _done(job, [0, 1])
    async with _api(ctx) as c:
        r = await _read(c, job["job_id"])
        assert r.json().get("renditions") == [], f"a job still processing lists renditions {r.json().get('renditions')}"
        _done(job, [2])
        jobs.finalize_job(job["job_id"], [{"preset": "h264-720p", "key": jobs.output_key(job), "duration_s": 18.0}])
        r = await _read(c, job["job_id"])
    renditions = r.json().get("renditions") or [{}]
    rendition = renditions[0]
    expires = int(ctx.clock.time()) + 900
    assert rendition.get("expires_at") == expires, f"the rendition carries expires_at {rendition.get('expires_at')!r}, expected now + SIGNED_URL_TTL_S = {expires}"
    want = urls.sign("renditions", jobs.output_key(job), expires)
    assert rendition.get("url") == want, f"the read hands out {rendition.get('url')!r}: a plain storage URL never expires. Expected urls.sign(bucket, key, expires_at) = {want!r}"
    assert rendition.get("preset") == "h264-720p" and rendition.get("duration_s") == 18.0, f"the rendition must carry its preset and duration, got {rendition}"
`,
    typescript: `async function setup(ctx, duration: number, tenant = 't-1') {
  const jobs = ctx.load('/support/transcoder/jobs.ts');
  const presets = ctx.load('/support/transcoder/presets.ts');
  const segments = ctx.load('/support/transcoder/segments.ts');
  const urls = ctx.load('/support/transcoder/urls.ts');
  const job = await jobs.create(tenant, 's3://uploads/talk.mov', '9f'.repeat(32), duration, 'h264-720p', presets.encoderArgs('h264-720p'), 'renditions', 'talks/42');
  const done = async (indices: number[]) => {
    for (const i of indices) await segments.markDone(job.job_id, i);
  };
  return {c: ctx.client(ctx.load('read').app), jobs, segments, urls, job, done};
}

const read = (c, jobId: string, tenant = 't-1') => c.get(\`/v1/transcodes/\${jobId}\`, {headers: {'X-Tenant-Id': tenant}});

export async function check_route(ctx) {
  const {c, job, done} = await setup(ctx, 18);
  await done([0]);
  const r = await read(c, job.job_id);
  assert.equal(r.status, 200, \`the owner's read answered \${r.status}: \${r.text}\`);
  const body = r.json();
  assert(body.job_id === job.job_id && body.segment_count === 3 && body.completed_segments === 1, \`a 3-segment job with segment 0 done answered \${r.text}\`);
  assert.equal(body.state, 'processing', \`a job with 1 of 3 segments done reads as \${body.state}, expected processing\`);
}

export async function check_done_manifest(ctx) {
  const {c, job, done} = await setup(ctx, 600);
  await done(Array.from({length: 100}, (_, i) => i).filter(i => i !== 57));
  let body = (await read(c, job.job_id)).json();
  assert(body.completed_segments === 99 && body.state === 'processing', \`a 100-segment job with segment 57 missing reads as \${body.state} (\${body.completed_segments} completed): done means every segment exists, not 99 %\`);
  await done([57]);
  body = (await read(c, job.job_id)).json();
  assert.equal(body.state, 'done', \`with every segment done the job reads as \${body.state}, expected done\`);
}

export async function check_failed_indices(ctx) {
  const {c, segments, job, done} = await setup(ctx, 30);
  await done([0, 1, 3]);
  await segments.markFailed(job.job_id, 4);
  await segments.markFailed(job.job_id, 2);
  const body = (await read(c, job.job_id)).json();
  assert.deepStrictEqual(body.failed_segments, [2, 4], \`segments 4 and 2 failed and the read answers failed_segments \${JSON.stringify(body.failed_segments)}, expected [2, 4]\`);
  assert.equal(body.state, 'failed', \`a job with failed segments reads as \${body.state}, expected failed\`);
}

export async function check_owner_404(ctx) {
  const {c, job, done} = await setup(ctx, 18);
  await done([0, 1, 2]);
  const foreign = await read(c, job.job_id, 't-2');
  const missing = await read(c, 'tj-999', 't-2');
  const own = await read(c, job.job_id);
  assert.equal(foreign.status, 404, \`tenant t-2 read t-1's job and got \${foreign.status}: \${foreign.text}\`);
  assert.equal(foreign.text, missing.text, \`a foreign job answered \${foreign.text} and a missing one \${missing.text}: the two must be indistinguishable\`);
  assert.equal(own.status, 200, \`the owner's read answered \${own.status}\`);
}

export async function check_signed_renditions(ctx) {
  const {c, jobs, urls, job, done} = await setup(ctx, 18);
  await done([0, 1]);
  let body = (await read(c, job.job_id)).json();
  assert.deepStrictEqual(body.renditions, [], \`a job still processing lists renditions \${JSON.stringify(body.renditions)}\`);
  await done([2]);
  await jobs.finalizeJob(job.job_id, [{preset: 'h264-720p', key: jobs.outputKey(job), duration_s: 18}]);
  body = (await read(c, job.job_id)).json();
  const rendition = body.renditions?.[0] ?? {};
  const expires = Math.floor(ctx.clock.now() / 1000) + 900;
  assert.equal(rendition.expires_at, expires, \`the rendition carries expires_at \${rendition.expires_at}, expected now + SIGNED_URL_TTL_S = \${expires}\`);
  const want = urls.sign('renditions', jobs.outputKey(job), expires);
  assert.equal(rendition.url, want, \`the read hands out \${rendition.url}: a plain storage URL never expires. Expected sign(bucket, key, expires_at) = \${want}\`);
  assert(rendition.preset === 'h264-720p' && rendition.duration_s === 18, \`the rendition must carry its preset and duration, got \${JSON.stringify(rendition)}\`);
}
`,
    go: `package main

import (
	"context"
	"net/http"

	"transcoder/jobs"
	"transcoder/presets"
	"transcoder/segments"
	"transcoder/urls"

	"leetbuild/harness"
)

var readBg = context.Background()

type jobView struct {
	JobID             string \`json:"job_id"\`
	State             string \`json:"state"\`
	SegmentCount      int    \`json:"segment_count"\`
	CompletedSegments int    \`json:"completed_segments"\`
	FailedSegments    []int  \`json:"failed_segments"\`
	Renditions        []struct {
		Preset    string  \`json:"preset"\`
		DurationS float64 \`json:"duration_s"\`
		URL       string  \`json:"url"\`
		ExpiresAt int64   \`json:"expires_at"\`
	} \`json:"renditions"\`
}

func readerJob(duration float64) *jobs.Job {
	args, _ := presets.EncoderArgs("h264-720p")
	return jobs.Create(readBg, "t-1", "s3://uploads/talk.mov", "9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f", duration, "h264-720p", args, "renditions", "talks/42")
}

func markAll(job *jobs.Job, indices ...int) {
	for _, i := range indices {
		segments.MarkDone(readBg, job.JobID, i)
	}
}

func reader(ctx *harness.Ctx) *harness.HTTP {
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

func view(ctx *harness.Ctx, c *harness.HTTP, jobID string) jobView {
	r := c.Get("/v1/transcodes/"+jobID, "X-Tenant-Id", "t-1")
	ctx.Equal(r.Status, 200, "the owner's read of %s (%s)", jobID, r.Text())
	var v jobView
	r.Decode(&v)
	return v
}

func CheckRoute(ctx *harness.Ctx) {
	job := readerJob(18)
	markAll(job, 0)
	v := view(ctx, reader(ctx), job.JobID)
	ctx.Assert(v.JobID == job.JobID && v.SegmentCount == 3 && v.CompletedSegments == 1, "a 3-segment job with segment 0 done answered %+v", v)
	ctx.Equal(v.State, "processing", "a job with 1 of 3 segments done; its state")
}

func CheckDoneManifest(ctx *harness.Ctx) {
	job := readerJob(600)
	for i := 0; i < 100; i++ {
		if i != 57 {
			markAll(job, i)
		}
	}
	c := reader(ctx)
	v := view(ctx, c, job.JobID)
	ctx.Assert(v.CompletedSegments == 99 && v.State == "processing", "a 100-segment job with segment 57 missing reads as %q (%d completed): done means every segment exists, not 99 %%", v.State, v.CompletedSegments)
	markAll(job, 57)
	ctx.Equal(view(ctx, c, job.JobID).State, "done", "with every segment done, the state")
}

func CheckFailedIndices(ctx *harness.Ctx) {
	job := readerJob(30)
	markAll(job, 0, 1, 3)
	segments.MarkFailed(readBg, job.JobID, 4)
	segments.MarkFailed(readBg, job.JobID, 2)
	v := view(ctx, reader(ctx), job.JobID)
	ctx.Equal(v.FailedSegments, []int{2, 4}, "segments 4 and 2 failed; failed_segments")
	ctx.Equal(v.State, "failed", "a job with failed segments; its state")
}

func CheckOwner404(ctx *harness.Ctx) {
	job := readerJob(18)
	markAll(job, 0, 1, 2)
	c := reader(ctx)
	foreign := c.Get("/v1/transcodes/"+job.JobID, "X-Tenant-Id", "t-2")
	missing := c.Get("/v1/transcodes/tj-999", "X-Tenant-Id", "t-2")
	ctx.Equal(foreign.Status, 404, "tenant t-2 read t-1's job (%s); the status", foreign.Text())
	ctx.Equal(foreign.Text(), missing.Text(), "a foreign job and a missing one must be indistinguishable; the foreign body")
	view(ctx, c, job.JobID)
}

func CheckSignedRenditions(ctx *harness.Ctx) {
	job := readerJob(18)
	markAll(job, 0, 1)
	c := reader(ctx)
	ctx.Equal(len(view(ctx, c, job.JobID).Renditions), 0, "a job still processing must list no renditions; renditions")
	markAll(job, 2)
	jobs.FinalizeJob(readBg, job.JobID, []jobs.Rendition{{Preset: "h264-720p", Key: jobs.OutputKey(job), DurationS: 18}})
	v := view(ctx, c, job.JobID)
	ctx.Assert(len(v.Renditions) == 1, "a done job must list its rendition, got %+v", v.Renditions)
	r := v.Renditions[0]
	expires := ctx.Clock.Now()/1000 + 900
	ctx.Equal(r.ExpiresAt, expires, "the rendition's expires_at must be now + SignedURLTTL")
	ctx.Equal(r.URL, urls.Sign("renditions", jobs.OutputKey(job), expires), "a plain storage URL never expires; the URL must be urls.Sign(bucket, key, expires_at)")
	ctx.Assert(r.Preset == "h264-720p" && r.DurationS == 18, "the rendition must carry its preset and duration, got %+v", r)
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <string>
#include <vector>

#include "transcoder/jobs.h"
#include "transcoder/presets.h"
#include "transcoder/segments.h"
#include "transcoder/urls.h"

namespace {

jobs::Job readerJob(double duration) {
  return jobs::create("t-1", "s3://uploads/talk.mov", std::string(64, 'f'), duration, "h264-720p", *presets::encoderArgs("h264-720p"), "renditions", "talks/42");
}

void markAll(const jobs::Job& job, const std::vector<int>& indices) {
  for (int i : indices) segments::markDone(job.job_id, i);
}

harness::HTTP reader(harness::Ctx& ctx) {
  static httplib::Server* svr = nullptr;
  delete svr;
  svr = new httplib::Server;
  register_routes(*svr);
  return ctx.HTTP(*svr);
}

nlohmann::json view(harness::Ctx& ctx, harness::HTTP& c, const std::string& job_id) {
  const auto r = c.Get("/v1/transcodes/" + job_id, "X-Tenant-Id", "t-1");
  ctx.Equal(r.Status, 200, "the owner's read of %s (%s)", job_id, r.Text());
  const auto body = nlohmann::json::parse(r.Text(), nullptr, false);
  ctx.Assert(body.is_object(), "the read answered %s, not a JSON object", r.Text());
  return body;
}

}  // namespace

void CheckRoute(harness::Ctx& ctx) {
  const jobs::Job job = readerJob(18);
  markAll(job, {0});
  auto c = reader(ctx);
  const auto v = view(ctx, c, job.job_id);
  ctx.Assert(v.value("job_id", "") == job.job_id && v.value("segment_count", 0) == 3 && v.value("completed_segments", 0) == 1, "a 3-segment job with segment 0 done answered %s", v.dump());
  ctx.Equal(v.value("state", ""), "processing", "a job with 1 of 3 segments done; its state");
}

void CheckDoneManifest(harness::Ctx& ctx) {
  const jobs::Job job = readerJob(600);
  std::vector<int> all_but_57;
  for (int i = 0; i < 100; i++) {
    if (i != 57) all_but_57.push_back(i);
  }
  markAll(job, all_but_57);
  auto c = reader(ctx);
  const auto v = view(ctx, c, job.job_id);
  ctx.Assert(v.value("completed_segments", 0) == 99 && v.value("state", "") == "processing", "a 100-segment job with segment 57 missing reads as %s (%d completed): done means every segment exists, not 99 percent", v.value("state", ""), v.value("completed_segments", 0));
  markAll(job, {57});
  ctx.Equal(view(ctx, c, job.job_id).value("state", ""), "done", "with every segment done, the state");
}

void CheckFailedIndices(harness::Ctx& ctx) {
  const jobs::Job job = readerJob(30);
  markAll(job, {0, 1, 3});
  segments::markFailed(job.job_id, 4);
  segments::markFailed(job.job_id, 2);
  auto c = reader(ctx);
  const auto v = view(ctx, c, job.job_id);
  ctx.Equal(v.value("failed_segments", std::vector<int>{}), std::vector<int>{2, 4}, "segments 4 and 2 failed; failed_segments");
  ctx.Equal(v.value("state", ""), "failed", "a job with failed segments; its state");
}

void CheckOwner404(harness::Ctx& ctx) {
  const jobs::Job job = readerJob(18);
  markAll(job, {0, 1, 2});
  auto c = reader(ctx);
  const auto foreign = c.Get("/v1/transcodes/" + job.job_id, "X-Tenant-Id", "t-2");
  const auto missing = c.Get("/v1/transcodes/tj-999", "X-Tenant-Id", "t-2");
  ctx.Equal(foreign.Status, 404, "tenant t-2 read t-1's job (%s); the status", foreign.Text());
  ctx.Equal(foreign.Text(), missing.Text(), "a foreign job and a missing one must be indistinguishable; the foreign body");
  view(ctx, c, job.job_id);
}

void CheckSignedRenditions(harness::Ctx& ctx) {
  const jobs::Job job = readerJob(18);
  markAll(job, {0, 1});
  auto c = reader(ctx);
  ctx.Equal(view(ctx, c, job.job_id).value("renditions", nlohmann::json::array()).size(), size_t{0}, "a job still processing must list no renditions; renditions");
  markAll(job, {2});
  jobs::finalizeJob(job.job_id, {{"h264-720p", jobs::outputKey(job), 18}});
  const auto v = view(ctx, c, job.job_id);
  const auto renditions = v.value("renditions", nlohmann::json::array());
  ctx.Assert(renditions.size() == 1, "a done job must list its rendition, got %s", v.dump());
  const auto& r = renditions[0];
  const long long expires = ctx.Clock.Now() / 1000 + 900;
  ctx.Equal(r.value("expires_at", 0LL), expires, "the rendition's expires_at must be now + kSignedUrlTtlS");
  ctx.Equal(r.value("url", ""), urls::sign("renditions", jobs::outputKey(job), expires), "a plain storage URL never expires; the URL must be urls::sign(bucket, key, expires_at)");
  ctx.Assert(r.value("preset", "") == "h264-720p" && r.value("duration_s", 0.0) == 18, "the rendition must carry its preset and duration, got %s", r.dump());
}
`,
  },
  hints: [
    'A player opens a job marked done and skips a minute at 05:42; the support team cannot see which segment to re-run, and a second tenant reads the job by guessing its id.',
    'The state comes from `percent >= 99`, not from the manifest; `segments.failed` is never called; nothing compares `job["tenant"]` with the caller; the URLs are the plain storage path with no expiry.',
    'Answer 404 when `job["tenant"] != tenant`; set state to "failed" if `segments.failed(job_id)`, "done" if `coverage["complete"]`, else "processing"; return `failed_segments`; sign each rendition with `urls.sign(bucket, key, now + SIGNED_URL_TTL_S)`.',
  ],
  debrief: `The read reports facts the pipeline already holds instead of a guess: the manifest is the done set compared with every expected index, so "done" cannot run ahead of the segments, and failed indices come from the same Redis state the workers wrote, which is why the read cannot disagree with the events. Ownership is checked before anything is rendered and answers the same 404 as a missing job, so an id reveals nothing to another tenant. The job row keeps the rendition's key, and the read signs it for fifteen minutes each time. A production read also sets an \`ETag\` from the manifest so a polling dashboard gets a 304, and caps how often one client may poll.`,
};
