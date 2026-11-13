import type {Step} from '@/lib/types';

export const transcriptionReadStep: Step = {
  id: 'read',
  title: 'GET /v1/transcriptions/{id}: done only when it is done',
  concept: 'http',
  guides: ['honest-reads', 'request-boundaries'],
  file: 'read',
  focus: ['client', 'api', 'db', 'redis'],
  task: `## Task

**Starting point.** The starter serves \`GET /v1/transcriptions/{job_id}\` for the tenant in
\`X-Tenant-Id\` (401 without it): it loads the job (\`jobs.get\`), its saved segments (\`jobs.segments\`)
and the done count (\`progress.completed\`, the ledger of step 2), and answers \`{job_id, status,
completed_chunks, total_chunks, segments, next_cursor}\` with the first \`PAGE_SIZE\` (100) segments.
It serves the demo and hides four flaws.

**Failure mode the checks target.** Any tenant reads any job by its id; a job with a failed chunk
reads \`done\` because some segments exist, and a finished job reports 0 completed chunks once its
ledger has expired; segments come back in the order chunks finished, not the order they were
spoken; and a four-hour recording stops at the 100th segment.

- Another tenant's job is **404**, the same answer as a missing id (a 403 would confirm it exists).
- \`status\` is \`done\` only when the job record says so (\`jobs.mark_done\`, step 2), and then
  \`completed_chunks\` is \`total_chunks\`; otherwise it is \`partial\`, with the ledger's count, even when
  that count has reached \`total_chunks\`.
- \`segments\` are ordered by \`start_ms\` across the whole transcript.
- \`?cursor=N\` starts the page at segment N (any N, not only one a page handed out); \`next_cursor\`
  is the next page's cursor while segments remain and \`null\` on the last page, so 200 segments are
  two pages. A negative cursor is **400**.`,
  sequence: {
    participants: ['Client', 'Transcription API', 'jobs store', 'Redis ledger'],
    messages: [
      {
        from: 'Client',
        to: 'Transcription API',
        label: 'GET /v1/transcriptions/tr-7?cursor=100 · X-Tenant-Id',
        kind: 'sync',
      },
      {from: 'Transcription API', to: 'jobs store', label: "get(tr-7) → another tenant's → 404", kind: 'sync'},
      {from: 'Transcription API', to: 'Redis ledger', label: 'completed(tr-7), unless the job is done', kind: 'sync'},
      {from: 'Transcription API', to: 'jobs store', label: 'segments(tr-7) → sort by start_ms', kind: 'sync'},
      {
        from: 'Transcription API',
        to: 'Client',
        label: '200 {status: partial, completed_chunks, segments[100..199], next_cursor: "200"}',
        kind: 'reply',
      },
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Serves GET /v1/transcriptions/{job_id}',
      detail:
        "Register the read: the tenant's job answers **200** with its id and chunk count, a missing id is **404** and a request without `X-Tenant-Id` is **401**.",
      match: {
        python: {all: [/@app\.get\(\s*["']\/v1\/transcriptions\/\{job_id\}["']/]},
        typescript: {all: [/app\.get\(\s*['"]\/v1\/transcriptions\/:jobId['"]/]},
        go: {all: [/HandleFunc\(\s*"GET \/v1\/transcriptions\/\{id\}"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"transcriptions"\s*\/\s*Segment\s*\)/, /\bget\s*\{/]},
        cpp: {all: [/svr\.Get\(\s*R"\(\/v1\/transcriptions\//]},
      },
    },
    {
      id: 'tenant-scope',
      title: "Another tenant's job is 404",
      detail:
        'The job is resolved for the authenticated tenant: an id that belongs to someone else answers **404**, exactly like a missing one, and never 403, which would confirm the job exists. The starter serves any job to anyone who knows its id.',
      match: {
        python: {all: [/job\[["']tenant["']\]\s*!=\s*tenant|tenant\s*!=\s*job\[["']tenant["']\]/], none: [/\b403\b/]},
        typescript: {all: [/job\.tenant\s*!==\s*tenant|tenant\s*!==\s*job\.tenant/], none: [/\b403\b/]},
        go: {all: [/job\.Tenant\s*!=\s*tenant|tenant\s*!=\s*job\.Tenant/], none: [/StatusForbidden|\b403\b/]},
        scala: {all: [/\.tenant\s*[!=]=\s*tenant|tenant\s*[!=]=\s*\w+\.tenant/], none: [/Forbidden|\b403\b/]},
        cpp: {all: [/->tenant\s*!=\s*tenant|tenant\s*!=\s*\w+->tenant/], none: [/\b403\b/]},
      },
    },
    {
      id: 'honest-status',
      title: 'done comes from the job record, not from the segments',
      detail:
        "`status` is `done` only when the job record is (every chunk finished, step 2), with `completed_chunks` equal to `total_chunks`; otherwise `partial` with the ledger's count, even a ledger that counts every chunk done. The starter answers `done` whenever a segment exists and reads the count from a ledger that expires.",
      match: {
        python: {all: [/job\[["']status["']\]\s*==\s*["']done["']/], none: [/["']done["']\s+if\s+segments\b/]},
        typescript: {all: [/job\.status\s*===\s*['"]done['"]/], none: [/segments\.length\s*>\s*0\s*\?\s*['"]done['"]/]},
        go: {all: [/job\.Status\s*==\s*"done"/], none: [/len\(segments\)\s*>\s*0/]},
        scala: {all: [/\.status\s*==\s*"done"/], none: [/segments\.nonEmpty/]},
        cpp: {all: [/->status\s*==\s*"done"/], none: [/segments\.empty\(\)\s*\?/]},
      },
    },
    {
      id: 'segment-order',
      title: 'Segments in the order they were spoken',
      detail:
        'The segments are ordered by `start_ms` before the page is cut; chunks finish in any order, and the starter returns them in the order they were saved.',
      match: {
        python: {all: [/sorted\([^\n]*start_ms|\.sort\([^\n]*start_ms/]},
        typescript: {all: [/\.sort\([^\n]*start_ms/]},
        go: {all: [/sort\.(?:Slice|SliceStable)\([^\n]*StartMs/]},
        scala: {all: [/sortBy\(\s*_\.startMs\s*\)/]},
        cpp: {all: [/std::(?:stable_)?sort\([\s\S]{0,200}?start_ms/]},
      },
    },
    {
      id: 'cursor-pagination',
      title: 'A cursor walks past the first page',
      detail:
        "`?cursor=N` starts the page at segment N (`?cursor=150` reads segments 150 to 249) and `next_cursor` names the next page while segments remain, `null` on the last (200 segments are two pages); a negative cursor is **400** (FastAPI's 422 too). The starter always answers the first 100 with `next_cursor: null`, so a long recording is cut off.",
      match: {
        python: {all: [/query_params\.get\(\s*["']cursor["']/], none: [/["']next_cursor["']\s*:\s*None/]},
        typescript: {all: [/cursor\?*\s*:\s*string|query[^\n]*cursor/], none: [/next_cursor:\s*null\b/]},
        go: {all: [/Query\(\)\.Get\(\s*"cursor"\s*\)/], none: [/NextCursor:\s*nil/]},
        scala: {all: [/parameter\(\s*"cursor"/], none: [/"next_cursor"\s*->\s*JsNull/]},
        cpp: {all: [/get_param_value\(\s*"cursor"\s*\)/], none: [/\{"next_cursor",\s*nullptr\}/]},
      },
    },
  ],
  code: {
    python: {
      starter: `from fastapi import FastAPI, HTTPException, Request

from transcribe import jobs, progress  # jobs.get, jobs.segments; progress.completed

app = FastAPI()

PAGE_SIZE = 100


@app.get("/v1/transcriptions/{job_id}")
def read_transcription(job_id: str, request: Request) -> dict:
    tenant = request.headers.get("x-tenant-id", "")
    if not tenant:
        raise HTTPException(status_code=401, detail="X-Tenant-Id is required")
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    job = jobs.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="no such transcription")
    segments = jobs.segments(job_id)
    return {
        "job_id": job_id,
        "status": "done" if segments else "partial",
        "completed_chunks": progress.completed(job_id),
        "total_chunks": job["total_chunks"],
        "segments": segments[:PAGE_SIZE],
        "next_cursor": None,
    }
`,
      solution: `from fastapi import FastAPI, HTTPException, Request

from transcribe import jobs, progress  # jobs.get, jobs.segments; progress.completed

app = FastAPI()

PAGE_SIZE = 100


@app.get("/v1/transcriptions/{job_id}")
def read_transcription(job_id: str, request: Request) -> dict:
    tenant = request.headers.get("x-tenant-id", "")
    if not tenant:
        raise HTTPException(status_code=401, detail="X-Tenant-Id is required")
    cursor = request.query_params.get("cursor", "0")
    if not cursor.isdigit():
        raise HTTPException(status_code=400, detail="cursor must be a segment offset")
    job = jobs.get(job_id)
    # Another tenant's job answers exactly like a missing one: a 403 would confirm it exists.
    if job is None or job["tenant"] != tenant:
        raise HTTPException(status_code=404, detail="no such transcription")
    # The job record is the one place that says every chunk finished; the ledger expires after that.
    done = job["status"] == "done"
    segments = sorted(jobs.segments(job_id), key=lambda s: s["start_ms"])
    start = int(cursor)
    end = start + PAGE_SIZE
    return {
        "job_id": job_id,
        "status": "done" if done else "partial",
        "completed_chunks": job["total_chunks"] if done else progress.completed(job_id),
        "total_chunks": job["total_chunks"],
        "segments": segments[start:end],
        "next_cursor": str(end) if end < len(segments) else None,
    }
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';

import {get, segments as savedSegments} from 'transcribe/jobs';
import {completed} from 'transcribe/progress';

export const app = Fastify();

export const PAGE_SIZE = 100;

app.get('/v1/transcriptions/:jobId', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'X-Tenant-Id is required'});
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const {jobId} = request.params as {jobId: string};
  const job = await get(jobId);
  if (job === null) return reply.code(404).send({error: 'no such transcription'});
  const segments = await savedSegments(jobId);
  return {
    job_id: jobId,
    status: segments.length > 0 ? 'done' : 'partial',
    completed_chunks: await completed(jobId),
    total_chunks: job.total_chunks,
    segments: segments.slice(0, PAGE_SIZE),
    next_cursor: null,
  };
});
`,
      solution: `import Fastify from 'fastify';

import {get, segments as savedSegments} from 'transcribe/jobs';
import {completed} from 'transcribe/progress';

export const app = Fastify();

export const PAGE_SIZE = 100;

app.get('/v1/transcriptions/:jobId', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'X-Tenant-Id is required'});
  const {cursor = '0'} = request.query as {cursor?: string};
  if (!/^\\d+$/.test(cursor)) return reply.code(400).send({error: 'cursor must be a segment offset'});
  const {jobId} = request.params as {jobId: string};
  const job = await get(jobId);
  // Another tenant's job answers exactly like a missing one: a 403 would confirm it exists.
  if (job === null || job.tenant !== tenant) return reply.code(404).send({error: 'no such transcription'});
  // The job record is the one place that says every chunk finished; the ledger expires after that.
  const done = job.status === 'done';
  const segments = (await savedSegments(jobId)).sort((a, b) => a.start_ms - b.start_ms);
  const start = Number(cursor);
  const end = start + PAGE_SIZE;
  return {
    job_id: jobId,
    status: done ? 'done' : 'partial',
    completed_chunks: done ? job.total_chunks : await completed(jobId),
    total_chunks: job.total_chunks,
    segments: segments.slice(start, end),
    next_cursor: end < segments.length ? String(end) : null,
  };
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"net/http"

	"transcribe/jobs"     // jobs.Get, jobs.Segments
	"transcribe/progress" // progress.Completed(ctx, jobID)
)

const pageSize = 100

type transcriptView struct {
	JobID           string         \`json:"job_id"\`
	Status          string         \`json:"status"\`
	CompletedChunks int            \`json:"completed_chunks"\`
	TotalChunks     int            \`json:"total_chunks"\`
	Segments        []jobs.Segment \`json:"segments"\`
	NextCursor      *string        \`json:"next_cursor"\`
}

func readTranscription(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		http.Error(rw, "X-Tenant-Id is required", http.StatusUnauthorized)
		return
	}
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	jobID := r.PathValue("id")
	job := jobs.Get(r.Context(), jobID)
	if job == nil {
		http.Error(rw, "no such transcription", http.StatusNotFound)
		return
	}
	segments := jobs.Segments(r.Context(), jobID)
	status := "partial"
	if len(segments) > 0 {
		status = "done"
	}
	page := segments[:min(pageSize, len(segments))]
	view := transcriptView{JobID: jobID, Status: status, CompletedChunks: progress.Completed(r.Context(), jobID), TotalChunks: job.TotalChunks, Segments: page, NextCursor: nil}
	rw.Header().Set("Content-Type", "application/json")
	json.NewEncoder(rw).Encode(view)
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/transcriptions/{id}", readTranscription)
}
`,
      solution: `package main

import (
	"encoding/json"
	"net/http"
	"sort"
	"strconv"

	"transcribe/jobs"     // jobs.Get, jobs.Segments
	"transcribe/progress" // progress.Completed(ctx, jobID)
)

const pageSize = 100

type transcriptView struct {
	JobID           string         \`json:"job_id"\`
	Status          string         \`json:"status"\`
	CompletedChunks int            \`json:"completed_chunks"\`
	TotalChunks     int            \`json:"total_chunks"\`
	Segments        []jobs.Segment \`json:"segments"\`
	NextCursor      *string        \`json:"next_cursor"\`
}

func readTranscription(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		http.Error(rw, "X-Tenant-Id is required", http.StatusUnauthorized)
		return
	}
	start := 0
	if cursor := r.URL.Query().Get("cursor"); cursor != "" {
		n, err := strconv.Atoi(cursor)
		if err != nil || n < 0 {
			http.Error(rw, "cursor must be a segment offset", http.StatusBadRequest)
			return
		}
		start = n
	}
	jobID := r.PathValue("id")
	job := jobs.Get(r.Context(), jobID)
	// Another tenant's job answers exactly like a missing one: a 403 would confirm it exists.
	if job == nil || job.Tenant != tenant {
		http.Error(rw, "no such transcription", http.StatusNotFound)
		return
	}
	// The job record is the one place that says every chunk finished; the ledger expires after that.
	view := transcriptView{JobID: jobID, Status: "partial", TotalChunks: job.TotalChunks}
	if job.Status == "done" {
		view.Status = "done"
		view.CompletedChunks = job.TotalChunks
	} else {
		view.CompletedChunks = progress.Completed(r.Context(), jobID)
	}
	segments := jobs.Segments(r.Context(), jobID)
	sort.SliceStable(segments, func(i, j int) bool { return segments[i].StartMs < segments[j].StartMs })
	end := start + pageSize
	view.Segments = segments[min(start, len(segments)):min(end, len(segments))]
	if end < len(segments) {
		next := strconv.Itoa(end)
		view.NextCursor = &next
	}
	rw.Header().Set("Content-Type", "application/json")
	json.NewEncoder(rw).Encode(view)
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/transcriptions/{id}", readTranscription)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import transcribe.{Jobs, Progress} // Jobs.get, Jobs.segments; Progress.completed

object Read {
  val PageSize = 100

  val route: Route = path("v1" / "transcriptions" / Segment) { jobId =>
    get {
      optionalHeaderValueByName("X-Tenant-Id") {
        case None | Some("") => complete(StatusCodes.Unauthorized -> "X-Tenant-Id is required")
        case Some(tenant) =>
          // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
          Jobs.get(jobId) match {
            case None => complete(StatusCodes.NotFound -> "no such transcription")
            case Some(job) =>
              val segments = Jobs.segments(jobId)
              val body = JsObject(
                "job_id" -> JsString(jobId),
                "status" -> JsString(if (segments.nonEmpty) "done" else "partial"),
                "completed_chunks" -> JsNumber(Progress.completed(jobId)),
                "total_chunks" -> JsNumber(job.totalChunks),
                "segments" -> JsArray(segments.take(PageSize).map(Jobs.segmentJson).toVector),
                "next_cursor" -> JsNull)
              complete(HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))
          }
      }
    }
  }
}
`,
      solution: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import transcribe.{Jobs, Progress} // Jobs.get, Jobs.segments; Progress.completed

object Read {
  val PageSize = 100

  val route: Route = path("v1" / "transcriptions" / Segment) { jobId =>
    get {
      optionalHeaderValueByName("X-Tenant-Id") {
        case None | Some("") => complete(StatusCodes.Unauthorized -> "X-Tenant-Id is required")
        case Some(tenant) =>
          parameter("cursor".optional) { cursor =>
            val start = cursor.getOrElse("0")
            if (!start.forall(_.isDigit) || start.isEmpty) complete(StatusCodes.BadRequest -> "cursor must be a segment offset")
            else
              // Another tenant's job answers exactly like a missing one: a 403 would confirm it exists.
              Jobs.get(jobId).filter(_.tenant == tenant) match {
                case None => complete(StatusCodes.NotFound -> "no such transcription")
                case Some(job) =>
                  // The job record is the one place that says every chunk finished; the ledger expires after that.
                  val done = job.status == "done"
                  val segments = Jobs.segments(jobId).sortBy(_.startMs)
                  val from = start.toInt
                  val end = from + PageSize
                  val body = JsObject(
                    "job_id" -> JsString(jobId),
                    "status" -> JsString(if (done) "done" else "partial"),
                    "completed_chunks" -> JsNumber(if (done) job.totalChunks else Progress.completed(jobId)),
                    "total_chunks" -> JsNumber(job.totalChunks),
                    "segments" -> JsArray(segments.slice(from, end).map(Jobs.segmentJson).toVector),
                    "next_cursor" -> (if (end < segments.size) JsString(end.toString) else JsNull))
                  complete(HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))
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

#include <algorithm>
#include <string>
#include <vector>

#include "transcribe/jobs.h"      // jobs::get, jobs::segments
#include "transcribe/progress.h"  // progress::completed(job_id)

using json = nlohmann::json;

constexpr size_t kPageSize = 100;

void read_transcription(const httplib::Request& req, httplib::Response& res) {
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) {
    res.status = 401;
    res.set_content("X-Tenant-Id is required", "text/plain");
    return;
  }
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const std::string job_id = req.matches[1];
  const auto job = jobs::get(job_id);
  if (!job) {
    res.status = 404;
    res.set_content("no such transcription", "text/plain");
    return;
  }
  const std::vector<jobs::Segment> segments = jobs::segments(job_id);
  json page = json::array();
  for (size_t i = 0; i < std::min(kPageSize, segments.size()); i++) page.push_back(jobs::toJson(segments[i]));
  const json body = {{"job_id", job_id}, {"status", segments.empty() ? "partial" : "done"}, {"completed_chunks", progress::completed(job_id)},
                     {"total_chunks", job->total_chunks}, {"segments", page}, {"next_cursor", nullptr}};
  res.set_content(body.dump(), "application/json");
}

void register_routes(httplib::Server& svr) { svr.Get(R"(/v1/transcriptions/([\\w-]+))", read_transcription); }
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <algorithm>
#include <string>
#include <vector>

#include "transcribe/jobs.h"      // jobs::get, jobs::segments
#include "transcribe/progress.h"  // progress::completed(job_id)

using json = nlohmann::json;

constexpr size_t kPageSize = 100;

void read_transcription(const httplib::Request& req, httplib::Response& res) {
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) {
    res.status = 401;
    res.set_content("X-Tenant-Id is required", "text/plain");
    return;
  }
  const std::string cursor = req.has_param("cursor") ? req.get_param_value("cursor") : "0";
  if (cursor.empty() || !std::all_of(cursor.begin(), cursor.end(), ::isdigit)) {
    res.status = 400;
    res.set_content("cursor must be a segment offset", "text/plain");
    return;
  }
  const std::string job_id = req.matches[1];
  const auto job = jobs::get(job_id);
  // Another tenant's job answers exactly like a missing one: a 403 would confirm it exists.
  if (!job || job->tenant != tenant) {
    res.status = 404;
    res.set_content("no such transcription", "text/plain");
    return;
  }
  // The job record is the one place that says every chunk finished; the ledger expires after that.
  const bool done = job->status == "done";
  std::vector<jobs::Segment> segments = jobs::segments(job_id);
  std::stable_sort(segments.begin(), segments.end(), [](const jobs::Segment& a, const jobs::Segment& b) { return a.start_ms < b.start_ms; });
  const size_t start = std::stoul(cursor);
  const size_t end = start + kPageSize;
  json page = json::array();
  for (size_t i = start; i < std::min(end, segments.size()); i++) page.push_back(jobs::toJson(segments[i]));
  const json next = end < segments.size() ? json(std::to_string(end)) : json(nullptr);
  const json body = {{"job_id", job_id}, {"status", done ? "done" : "partial"}, {"completed_chunks", done ? job->total_chunks : progress::completed(job_id)},
                     {"total_chunks", job->total_chunks}, {"segments", page}, {"next_cursor", next}};
  res.set_content(body.dump(), "application/json");
}

void register_routes(httplib::Server& svr) { svr.Get(R"(/v1/transcriptions/([\\w-]+))", read_transcription); }
`,
    },
  },
  harness: {
    python: `from transcribe import jobs

T1 = {"X-Tenant-Id": "t-1"}


def _segment(index, start_ms, text="words"):
    return {"chunk_index": index, "start_ms": start_ms, "end_ms": start_ms + 10000, "speaker": "A", "text": text}


def _job(tenant="t-1", ref="s3://calls/a.wav", total=3):
    return jobs.create(tenant, ref, ref, total * 30, "en", total)["job_id"]


def _api(ctx):
    return ctx.client(ctx.load("read").app)


async def _read(c, job_id, tenant="t-1", cursor=None):
    url = f"/v1/transcriptions/{job_id}" + ("" if cursor is None else f"?cursor={cursor}")
    return await c.get(url, headers={"X-Tenant-Id": tenant})


async def check_route(ctx):
    job = _job()
    jobs.save_segments(job, [_segment(0, 0), _segment(0, 10000)])
    async with _api(ctx) as c:
        r = await _read(c, job)
        missing = await _read(c, "tr-404")
        anonymous = await c.get(f"/v1/transcriptions/{job}")
    assert r.status_code == 200, f"GET /v1/transcriptions/{job} answered {r.status_code}: {r.text}"
    body = r.json()
    assert body.get("job_id") == job and body.get("total_chunks") == 3 and len(body.get("segments", [])) == 2, f"the read must answer the job, its chunk count and its segments, got {body}"
    assert missing.status_code == 404, f"a missing job answered {missing.status_code}, expected 404"
    assert anonymous.status_code == 401, f"a read without X-Tenant-Id answered {anonymous.status_code}, expected 401"


async def check_tenant_scope(ctx):
    job = _job(tenant="t-1")
    jobs.save_segments(job, [_segment(0, 0, "the account number is on the letter")])
    async with _api(ctx) as c:
        foreign = await _read(c, job, tenant="t-2")
        missing = await _read(c, "tr-404", tenant="t-2")
    assert foreign.status_code == 404, f"tenant t-2 reading t-1's job answered {foreign.status_code}, expected 404 (the same answer as a missing id): {foreign.text}"
    assert "account number" not in foreign.text, "the foreign read leaked the transcript"
    assert missing.status_code == 404, f"a missing job answered {missing.status_code}"


async def check_honest_status(ctx):
    job = _job(total=3)
    jobs.save_segments(job, [_segment(0, 0), _segment(0, 10000)])
    ledger = f"job:{job}:chunks"
    # The ledger counts every chunk done, but the job record has not been marked done yet.
    ctx.redis.hset(ledger, mapping={"0": "done", "1": "done", "2": "done"})
    async with _api(ctx) as c:
        unmarked = (await _read(c, job)).json()
        assert unmarked.get("status") == "partial" and unmarked.get("completed_chunks") == 3, f"a job whose ledger counts 3 of 3 chunks done but whose record is still queued reads {unmarked.get('status')!r} with {unmarked.get('completed_chunks')} chunks completed, expected partial with 3: only the job record says it is done"
        ctx.redis.delete(ledger)
        ctx.redis.hset(ledger, mapping={"0": "done", "1": "failed"})
        partial = (await _read(c, job)).json()
        assert partial.get("status") == "partial" and partial.get("completed_chunks") == 1, f"a job with chunk 1 failed and chunk 2 pending reads {partial.get('status')!r} with {partial.get('completed_chunks')} chunks completed, expected partial with 1"
        # Every chunk finished, and 24 hours later the ledger has expired.
        jobs.mark_done(job)
        ctx.redis.delete(ledger)
        done = (await _read(c, job)).json()
    assert done.get("status") == "done" and done.get("completed_chunks") == 3, f"a finished job whose ledger expired reads {done.get('status')!r} with {done.get('completed_chunks')} of 3 chunks completed, expected done with 3: the job record is what says it finished"


async def check_segment_order(ctx):
    job = _job(total=3)
    # Chunks finish out of order: chunk 2, then chunk 0, then chunk 1.
    jobs.save_segments(job, [_segment(2, 60000), _segment(2, 70000)])
    jobs.save_segments(job, [_segment(0, 0), _segment(0, 10000)])
    jobs.save_segments(job, [_segment(1, 30000)])
    # 150 segments whose chunks finish last to first: the first page is the first 100 spoken.
    long = _job(ref="s3://calls/b.wav", total=50)
    for chunk in reversed(range(50)):
        jobs.save_segments(long, [_segment(chunk, (chunk * 3 + k) * 10000) for k in range(3)])
    async with _api(ctx) as c:
        body = (await _read(c, job)).json()
        first = (await _read(c, long)).json()
    starts = [s["start_ms"] for s in body.get("segments", [])]
    assert starts == [0, 10000, 30000, 60000, 70000], f"the transcript must read in the order it was spoken, got segments starting at {starts}"
    page = [s["start_ms"] for s in first.get("segments", [])]
    assert page == [i * 10000 for i in range(100)], f"the first page of 150 segments saved last chunk first starts at {page[:3]} and ends at {page[-3:]} ({len(page)} segments), expected the first 100 spoken, 0 to 990 000 ms: sort the whole transcript before cutting the page"


async def _walk(c, job):
    seen, cursor, pages = [], None, 0
    while pages < 5:
        body = (await _read(c, job, cursor=cursor)).json()
        pages += 1
        seen += [s["start_ms"] for s in body.get("segments", [])]
        cursor = body.get("next_cursor")
        if cursor is None:
            break
    return seen, pages


async def check_cursor_pagination(ctx):
    job = _job(total=84)
    jobs.save_segments(job, [_segment(i // 3, i * 10000) for i in range(250)])
    exact = _job(ref="s3://calls/b.wav", total=67)
    jobs.save_segments(exact, [_segment(i // 3, i * 10000) for i in range(200)])
    async with _api(ctx) as c:
        seen, pages = await _walk(c, job)
        assert seen == [i * 10000 for i in range(250)], f"walking next_cursor returned {len(seen)} of 250 segments in {pages} pages: a long recording must be readable past the first page"
        assert pages == 3, f"250 segments at 100 a page are 3 pages, the walk took {pages}"
        seen, pages = await _walk(c, exact)
        assert seen == [i * 10000 for i in range(200)] and pages == 2, f"200 segments are 2 pages, the second with next_cursor null; walking next_cursor took {pages} pages for {len(seen)} segments"
        middle = (await _read(c, job, cursor=150)).json()
        negative = await _read(c, job, cursor=-1)
    starts = [s["start_ms"] for s in middle.get("segments", [])]
    assert starts == [i * 10000 for i in range(150, 250)] and middle.get("next_cursor") is None, f"?cursor=150 starts the page at segment 150: got {len(starts)} segments from {starts[:1]} ms with next_cursor {middle.get('next_cursor')!r}, expected the 100 from 1 500 000 ms and null"
    assert 400 <= negative.status_code < 500, f"?cursor=-1 answered {negative.status_code}, expected 400 (or FastAPI's 422): a cursor is a segment offset, and a negative one is the client's error"
`,
    typescript: `const T1 = {'X-Tenant-Id': 't-1'};

const segmentOf = (index: number, startMs: number, text = 'words') => ({chunk_index: index, start_ms: startMs, end_ms: startMs + 10000, speaker: 'A', text});

function world(ctx) {
  return {c: ctx.client(ctx.load('read').app), jobs: ctx.load('/support/transcribe/jobs.ts')};
}

async function newJob(jobs, tenant = 't-1', ref = 's3://calls/a.wav', total = 3): Promise<string> {
  return (await jobs.create(tenant, ref, ref, total * 30, 'en', total)).job_id;
}

const read = (c, jobId: string, tenant = 't-1', cursor: string | null = null) =>
  c.get(\`/v1/transcriptions/\${jobId}\${cursor === null ? '' : \`?cursor=\${cursor}\`}\`, {headers: {'X-Tenant-Id': tenant}});

export async function check_route(ctx) {
  const {c, jobs} = world(ctx);
  const job = await newJob(jobs);
  await jobs.saveSegments(job, [segmentOf(0, 0), segmentOf(0, 10000)]);
  const r = await read(c, job);
  const missing = await read(c, 'tr-404');
  const anonymous = await c.get(\`/v1/transcriptions/\${job}\`, {headers: {}});
  assert.equal(r.status, 200, \`GET /v1/transcriptions/\${job} answered \${r.status}: \${r.text}\`);
  const body = r.json();
  assert(body.job_id === job && body.total_chunks === 3 && (body.segments ?? []).length === 2, \`the read must answer the job, its chunk count and its segments, got \${r.text}\`);
  assert.equal(missing.status, 404, \`a missing job answered \${missing.status}, expected 404\`);
  assert.equal(anonymous.status, 401, \`a read without X-Tenant-Id answered \${anonymous.status}, expected 401\`);
  void T1;
}

export async function check_tenant_scope(ctx) {
  const {c, jobs} = world(ctx);
  const job = await newJob(jobs, 't-1');
  await jobs.saveSegments(job, [segmentOf(0, 0, 'the account number is on the letter')]);
  const foreign = await read(c, job, 't-2');
  const missing = await read(c, 'tr-404', 't-2');
  assert.equal(foreign.status, 404, \`tenant t-2 reading t-1's job answered \${foreign.status}, expected 404 (the same answer as a missing id): \${foreign.text}\`);
  assert(!foreign.text.includes('account number'), 'the foreign read leaked the transcript');
  assert.equal(missing.status, 404, \`a missing job answered \${missing.status}\`);
}

export async function check_honest_status(ctx) {
  const {c, jobs} = world(ctx);
  const job = await newJob(jobs);
  await jobs.saveSegments(job, [segmentOf(0, 0), segmentOf(0, 10000)]);
  const ledger = \`job:\${job}:chunks\`;
  // The ledger counts every chunk done, but the job record has not been marked done yet.
  ctx.redis.hset(ledger, '0', 'done', '1', 'done', '2', 'done');
  const unmarked = (await read(c, job)).json();
  assert(unmarked.status === 'partial' && unmarked.completed_chunks === 3, \`a job whose ledger counts 3 of 3 chunks done but whose record is still queued reads \${unmarked.status} with \${unmarked.completed_chunks} chunks completed, expected partial with 3: only the job record says it is done\`);
  ctx.redis.del(ledger);
  ctx.redis.hset(ledger, '0', 'done', '1', 'failed');
  const partial = (await read(c, job)).json();
  assert(partial.status === 'partial' && partial.completed_chunks === 1, \`a job with chunk 1 failed and chunk 2 pending reads \${partial.status} with \${partial.completed_chunks} chunks completed, expected partial with 1\`);
  // Every chunk finished, and 24 hours later the ledger has expired.
  await jobs.markDone(job);
  ctx.redis.del(ledger);
  const done = (await read(c, job)).json();
  assert(done.status === 'done' && done.completed_chunks === 3, \`a finished job whose ledger expired reads \${done.status} with \${done.completed_chunks} of 3 chunks completed, expected done with 3: the job record is what says it finished\`);
}

export async function check_segment_order(ctx) {
  const {c, jobs} = world(ctx);
  const job = await newJob(jobs);
  // Chunks finish out of order: chunk 2, then chunk 0, then chunk 1.
  await jobs.saveSegments(job, [segmentOf(2, 60000), segmentOf(2, 70000)]);
  await jobs.saveSegments(job, [segmentOf(0, 0), segmentOf(0, 10000)]);
  await jobs.saveSegments(job, [segmentOf(1, 30000)]);
  // 150 segments whose chunks finish last to first: the first page is the first 100 spoken.
  const long = await newJob(jobs, 't-1', 's3://calls/b.wav', 50);
  for (let chunk = 49; chunk >= 0; chunk--) {
    await jobs.saveSegments(long, [0, 1, 2].map(k => segmentOf(chunk, (chunk * 3 + k) * 10000)));
  }
  const body = (await read(c, job)).json();
  const starts = (body.segments ?? []).map(s => s.start_ms);
  assert.deepStrictEqual(starts, [0, 10000, 30000, 60000, 70000], \`the transcript must read in the order it was spoken, got segments starting at \${JSON.stringify(starts)}\`);
  const page = ((await read(c, long)).json().segments ?? []).map(s => s.start_ms);
  assert.deepStrictEqual(page, Array.from({length: 100}, (_, i) => i * 10000), \`the first page of 150 segments saved last chunk first starts at \${JSON.stringify(page.slice(0, 3))} and ends at \${JSON.stringify(page.slice(-3))} (\${page.length} segments), expected the first 100 spoken, 0 to 990 000 ms: sort the whole transcript before cutting the page\`);
}

async function walk(c, job: string): Promise<{seen: number[]; pages: number}> {
  const seen: number[] = [];
  let cursor: string | null = null;
  let pages = 0;
  while (pages < 5) {
    const body = (await read(c, job, 't-1', cursor)).json();
    pages += 1;
    seen.push(...(body.segments ?? []).map(s => s.start_ms));
    cursor = body.next_cursor ?? null;
    if (cursor === null) break;
  }
  return {seen, pages};
}

export async function check_cursor_pagination(ctx) {
  const {c, jobs} = world(ctx);
  const job = await newJob(jobs, 't-1', 's3://calls/a.wav', 84);
  await jobs.saveSegments(job, Array.from({length: 250}, (_, i) => segmentOf(Math.floor(i / 3), i * 10000)));
  const exact = await newJob(jobs, 't-1', 's3://calls/b.wav', 67);
  await jobs.saveSegments(exact, Array.from({length: 200}, (_, i) => segmentOf(Math.floor(i / 3), i * 10000)));
  const long = await walk(c, job);
  assert.deepStrictEqual(long.seen, Array.from({length: 250}, (_, i) => i * 10000), \`walking next_cursor returned \${long.seen.length} of 250 segments in \${long.pages} pages: a long recording must be readable past the first page\`);
  assert.equal(long.pages, 3, \`250 segments at 100 a page are 3 pages, the walk took \${long.pages}\`);
  const even = await walk(c, exact);
  assert(even.pages === 2 && even.seen.length === 200, \`200 segments are 2 pages, the second with next_cursor null; walking next_cursor took \${even.pages} pages for \${even.seen.length} segments\`);
  const middle = (await read(c, job, 't-1', '150')).json();
  const starts = (middle.segments ?? []).map(s => s.start_ms);
  assert(starts.length === 100 && starts[0] === 1500000 && middle.next_cursor === null, \`?cursor=150 starts the page at segment 150: got \${starts.length} segments from \${JSON.stringify(starts.slice(0, 1))} ms with next_cursor \${JSON.stringify(middle.next_cursor)}, expected the 100 from 1 500 000 ms and null\`);
  const negative = await read(c, job, 't-1', '-1');
  assert(negative.status >= 400 && negative.status < 500, \`?cursor=-1 answered \${negative.status}, expected 400: a cursor is a segment offset, and a negative one is the client's error\`);
}
`,
    go: `package main

import (
	"context"
	"fmt"
	"net/http"

	"transcribe/jobs"

	"leetbuild/harness"
)

var readBg = context.Background()

type readView struct {
	JobID           string         \`json:"job_id"\`
	Status          string         \`json:"status"\`
	CompletedChunks int            \`json:"completed_chunks"\`
	TotalChunks     int            \`json:"total_chunks"\`
	Segments        []jobs.Segment \`json:"segments"\`
	NextCursor      any            \`json:"next_cursor"\` // a string, or a number
}

func readSegment(index, startMs int, text string) jobs.Segment {
	return jobs.Segment{ChunkIndex: index, StartMs: startMs, EndMs: startMs + 10000, Speaker: "A", Text: text}
}

func readJob(tenant string, total int) string {
	return jobs.Create(readBg, tenant, "s3://calls/a.wav", "s3://calls/a.wav", total*30, "en", total).JobID
}

func readAPI(ctx *harness.Ctx) *harness.HTTP {
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

func readOne(c *harness.HTTP, jobID, tenant, cursor string) (*harness.Response, readView) {
	path := "/v1/transcriptions/" + jobID
	if cursor != "" {
		path += "?cursor=" + cursor
	}
	r := c.Get(path, "X-Tenant-Id", tenant)
	var v readView
	if r.Status == 200 {
		r.Decode(&v)
	}
	return r, v
}

func startsIn(segments []jobs.Segment) []int {
	out := []int{}
	for _, s := range segments {
		out = append(out, s.StartMs)
	}
	return out
}

func CheckRoute(ctx *harness.Ctx) {
	c := readAPI(ctx)
	job := readJob("t-1", 3)
	jobs.SaveSegments(readBg, job, []jobs.Segment{readSegment(0, 0, "words"), readSegment(0, 10000, "words")})
	r, v := readOne(c, job, "t-1", "")
	ctx.Equal(r.Status, 200, "GET /v1/transcriptions/%s (%s)", job, r.Text())
	ctx.Assert(v.JobID == job && v.TotalChunks == 3 && len(v.Segments) == 2, "the read must answer the job, its chunk count and its segments, got %s", r.Text())
	missing, _ := readOne(c, "tr-404", "t-1", "")
	ctx.Equal(missing.Status, 404, "a missing job")
	ctx.Equal(c.Get("/v1/transcriptions/"+job).Status, 401, "a read without X-Tenant-Id")
}

func CheckTenantScope(ctx *harness.Ctx) {
	c := readAPI(ctx)
	job := readJob("t-1", 3)
	jobs.SaveSegments(readBg, job, []jobs.Segment{readSegment(0, 0, "the account number is on the letter")})
	foreign, _ := readOne(c, job, "t-2", "")
	ctx.Equal(foreign.Status, 404, "tenant t-2 reading t-1's job must get the same answer as a missing id (%s)", foreign.Text())
	missing, _ := readOne(c, "tr-404", "t-2", "")
	ctx.Equal(missing.Status, 404, "a missing job")
}

func CheckHonestStatus(ctx *harness.Ctx) {
	c := readAPI(ctx)
	job := readJob("t-1", 3)
	jobs.SaveSegments(readBg, job, []jobs.Segment{readSegment(0, 0, "words"), readSegment(0, 10000, "words")})
	ledger := "job:" + job + ":chunks"
	// The ledger counts every chunk done, but the job record has not been marked done yet.
	ctx.Redis.Do("HSET", ledger, "0", "done", "1", "done", "2", "done")
	_, unmarked := readOne(c, job, "t-1", "")
	ctx.Assert(unmarked.Status == "partial" && unmarked.CompletedChunks == 3, "a job whose ledger counts 3 of 3 chunks done but whose record is still queued reads %q with %d chunks completed, expected partial with 3: only the job record says it is done", unmarked.Status, unmarked.CompletedChunks)
	ctx.Redis.Del(ledger)
	ctx.Redis.Do("HSET", ledger, "0", "done", "1", "failed")
	_, partial := readOne(c, job, "t-1", "")
	ctx.Assert(partial.Status == "partial" && partial.CompletedChunks == 1, "a job with chunk 1 failed and chunk 2 pending reads %q with %d chunks completed, expected partial with 1", partial.Status, partial.CompletedChunks)
	// Every chunk finished, and 24 hours later the ledger has expired.
	jobs.MarkDone(readBg, job)
	ctx.Redis.Del(ledger)
	_, done := readOne(c, job, "t-1", "")
	ctx.Assert(done.Status == "done" && done.CompletedChunks == 3, "a finished job whose ledger expired reads %q with %d of 3 chunks completed, expected done with 3: the job record is what says it finished", done.Status, done.CompletedChunks)
}

func CheckSegmentOrder(ctx *harness.Ctx) {
	c := readAPI(ctx)
	job := readJob("t-1", 3)
	// Chunks finish out of order: chunk 2, then chunk 0, then chunk 1.
	jobs.SaveSegments(readBg, job, []jobs.Segment{readSegment(2, 60000, "words"), readSegment(2, 70000, "words")})
	jobs.SaveSegments(readBg, job, []jobs.Segment{readSegment(0, 0, "words"), readSegment(0, 10000, "words")})
	jobs.SaveSegments(readBg, job, []jobs.Segment{readSegment(1, 30000, "words")})
	// 150 segments whose chunks finish last to first: the first page is the first 100 spoken.
	long := readJob("t-1", 50)
	for chunk := 49; chunk >= 0; chunk-- {
		jobs.SaveSegments(readBg, long, []jobs.Segment{readSegment(chunk, chunk*30000, "words"), readSegment(chunk, chunk*30000+10000, "words"), readSegment(chunk, chunk*30000+20000, "words")})
	}
	_, v := readOne(c, job, "t-1", "")
	ctx.Equal(startsIn(v.Segments), []int{0, 10000, 30000, 60000, 70000}, "the transcript must read in the order it was spoken; the segment starts")
	_, first := readOne(c, long, "t-1", "")
	want := []int{}
	for i := 0; i < 100; i++ {
		want = append(want, i*10000)
	}
	ctx.Equal(startsIn(first.Segments), want, "the first page of 150 segments saved last chunk first must be the first 100 spoken, 0 to 990 000 ms (sort the whole transcript before cutting the page); the segment starts")
}

// readWalk follows next_cursor from the first page: every segment start it saw, and the pages it took.
func readWalk(c *harness.HTTP, job string) ([]int, int) {
	seen := []int{}
	cursor := ""
	pages := 0
	for pages < 5 {
		_, v := readOne(c, job, "t-1", cursor)
		pages++
		seen = append(seen, startsIn(v.Segments)...)
		if v.NextCursor == nil {
			break
		}
		cursor = fmt.Sprint(v.NextCursor)
	}
	return seen, pages
}

func CheckCursorPagination(ctx *harness.Ctx) {
	c := readAPI(ctx)
	job := readJob("t-1", 84)
	all := make([]jobs.Segment, 0, 250)
	want := make([]int, 0, 250)
	for i := 0; i < 250; i++ {
		all = append(all, readSegment(i/3, i*10000, "words"))
		want = append(want, i*10000)
	}
	jobs.SaveSegments(readBg, job, all)
	exact := readJob("t-1", 67)
	jobs.SaveSegments(readBg, exact, all[:200])
	seen, pages := readWalk(c, job)
	ctx.Assert(len(seen) == 250, "walking next_cursor returned %d of 250 segments in %d pages: a long recording must be readable past the first page", len(seen), pages)
	ctx.Equal(seen, want, "every segment once, in order, across the pages")
	ctx.Equal(pages, 3, "250 segments at 100 a page; pages")
	seen, pages = readWalk(c, exact)
	ctx.Assert(pages == 2 && len(seen) == 200, "200 segments are 2 pages, the second with next_cursor null; walking next_cursor took %d pages for %d segments", pages, len(seen))
	_, middle := readOne(c, job, "t-1", "150")
	starts := startsIn(middle.Segments)
	ctx.Assert(len(starts) == 100 && starts[0] == 1500000 && middle.NextCursor == nil, "?cursor=150 starts the page at segment 150: got %d segments from %v ms with next_cursor %v, expected the 100 from 1 500 000 ms and null", len(starts), starts[:min(1, len(starts))], middle.NextCursor)
	negative, _ := readOne(c, job, "t-1", "-1")
	ctx.Assert(negative.Status >= 400 && negative.Status < 500, "?cursor=-1 answered %d, expected 400: a cursor is a segment offset, and a negative one is the client's error", negative.Status)
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <string>
#include <utility>
#include <vector>

namespace {

jobs::Segment readSegment(int index, int start_ms, const std::string& text = "words") { return {index, start_ms, start_ms + 10000, "A", text}; }

std::string readJob(const std::string& tenant, long total) { return jobs::create(tenant, "s3://calls/a.wav", "s3://calls/a.wav", total * 30, "en", total).job_id; }

harness::HTTP readAPI(harness::Ctx& ctx) {
  static httplib::Server* svr = nullptr;
  delete svr;
  svr = new httplib::Server;
  register_routes(*svr);
  return ctx.HTTP(*svr);
}

harness::Response readOne(harness::HTTP& c, const std::string& job_id, const std::string& tenant, const std::string& cursor = "") {
  return c.Get("/v1/transcriptions/" + job_id + (cursor.empty() ? "" : "?cursor=" + cursor), "X-Tenant-Id", tenant);
}

nlohmann::json bodyOf(const harness::Response& r) { return nlohmann::json::parse(r.Text(), nullptr, false); }

std::vector<int> startsIn(const nlohmann::json& body) {
  std::vector<int> out;
  if (body.is_object() && body.contains("segments")) {
    for (const auto& s : body["segments"]) out.push_back(s.value("start_ms", 0));
  }
  return out;
}

// The cursor a page names for the next one (a string, or a number), empty on the last page.
std::string nextCursor(const nlohmann::json& body) {
  if (!body.is_object() || !body.contains("next_cursor")) return "";
  const auto& next = body["next_cursor"];
  if (next.is_string()) return next.get<std::string>();
  if (next.is_number_integer()) return std::to_string(next.get<long long>());
  return "";
}

// Follow next_cursor from the first page: every segment start seen, and the pages it took.
std::pair<std::vector<int>, int> readWalk(harness::HTTP& c, const std::string& job) {
  std::vector<int> seen;
  std::string cursor;
  int pages = 0;
  while (pages < 5) {
    const auto body = bodyOf(readOne(c, job, "t-1", cursor));
    pages++;
    for (int s : startsIn(body)) seen.push_back(s);
    cursor = nextCursor(body);
    if (cursor.empty()) break;
  }
  return {seen, pages};
}

}  // namespace

void CheckRoute(harness::Ctx& ctx) {
  auto c = readAPI(ctx);
  const std::string job = readJob("t-1", 3);
  jobs::saveSegments(job, {readSegment(0, 0), readSegment(0, 10000)});
  const auto r = readOne(c, job, "t-1");
  ctx.Equal(r.Status, 200, "GET /v1/transcriptions/%s (%s)", job, r.Text());
  const auto body = bodyOf(r);
  ctx.Assert(body.is_object() && body.value("job_id", "") == job && body.value("total_chunks", 0) == 3 && startsIn(body).size() == 2, "the read must answer the job, its chunk count and its segments, got %s", r.Text());
  ctx.Equal(readOne(c, "tr-404", "t-1").Status, 404, "a missing job");
  ctx.Equal(c.Get("/v1/transcriptions/" + job).Status, 401, "a read without X-Tenant-Id");
}

void CheckTenantScope(harness::Ctx& ctx) {
  auto c = readAPI(ctx);
  const std::string job = readJob("t-1", 3);
  jobs::saveSegments(job, {readSegment(0, 0, "the account number is on the letter")});
  const auto foreign = readOne(c, job, "t-2");
  ctx.Equal(foreign.Status, 404, "tenant t-2 reading t-1's job must get the same answer as a missing id (%s)", foreign.Text());
  ctx.Equal(readOne(c, "tr-404", "t-2").Status, 404, "a missing job");
}

void CheckHonestStatus(harness::Ctx& ctx) {
  auto c = readAPI(ctx);
  const std::string job = readJob("t-1", 3);
  jobs::saveSegments(job, {readSegment(0, 0), readSegment(0, 10000)});
  const std::string ledger = "job:" + job + ":chunks";
  // The ledger counts every chunk done, but the job record has not been marked done yet.
  ctx.Redis.Do("HSET", ledger, "0", "done", "1", "done", "2", "done");
  const auto unmarked = bodyOf(readOne(c, job, "t-1"));
  ctx.Assert(unmarked.is_object() && unmarked.value("status", "") == "partial" && unmarked.value("completed_chunks", -1) == 3, "a job whose ledger counts 3 of 3 chunks done but whose record is still queued must read partial with 3 chunks completed (only the job record says it is done), got %s", unmarked.dump());
  ctx.Redis.Del(ledger);
  ctx.Redis.Do("HSET", ledger, "0", "done", "1", "failed");
  const auto partial = bodyOf(readOne(c, job, "t-1"));
  ctx.Assert(partial.is_object() && partial.value("status", "") == "partial" && partial.value("completed_chunks", -1) == 1, "a job with chunk 1 failed and chunk 2 pending must read partial with 1 chunk completed, got %s", partial.dump());
  // Every chunk finished, and 24 hours later the ledger has expired.
  jobs::markDone(job);
  ctx.Redis.Del(ledger);
  const auto done = bodyOf(readOne(c, job, "t-1"));
  ctx.Assert(done.is_object() && done.value("status", "") == "done" && done.value("completed_chunks", -1) == 3, "a finished job whose ledger expired must read done with 3 of 3 chunks completed (the job record is what says it finished), got %s", done.dump());
}

void CheckSegmentOrder(harness::Ctx& ctx) {
  auto c = readAPI(ctx);
  const std::string job = readJob("t-1", 3);
  // Chunks finish out of order: chunk 2, then chunk 0, then chunk 1.
  jobs::saveSegments(job, {readSegment(2, 60000), readSegment(2, 70000)});
  jobs::saveSegments(job, {readSegment(0, 0), readSegment(0, 10000)});
  jobs::saveSegments(job, {readSegment(1, 30000)});
  // 150 segments whose chunks finish last to first: the first page is the first 100 spoken.
  const std::string long_job = readJob("t-1", 50);
  for (int chunk = 49; chunk >= 0; chunk--) {
    jobs::saveSegments(long_job, {readSegment(chunk, chunk * 30000), readSegment(chunk, chunk * 30000 + 10000), readSegment(chunk, chunk * 30000 + 20000)});
  }
  ctx.Equal(startsIn(bodyOf(readOne(c, job, "t-1"))), {0, 10000, 30000, 60000, 70000}, "the transcript must read in the order it was spoken; the segment starts");
  std::vector<int> want;
  for (int i = 0; i < 100; i++) want.push_back(i * 10000);
  ctx.Equal(startsIn(bodyOf(readOne(c, long_job, "t-1"))), want, "the first page of 150 segments saved last chunk first must be the first 100 spoken, 0 to 990 000 ms (sort the whole transcript before cutting the page); the segment starts");
}

void CheckCursorPagination(harness::Ctx& ctx) {
  auto c = readAPI(ctx);
  const std::string job = readJob("t-1", 84);
  std::vector<jobs::Segment> all;
  std::vector<int> want;
  for (int i = 0; i < 250; i++) {
    all.push_back(readSegment(i / 3, i * 10000));
    want.push_back(i * 10000);
  }
  jobs::saveSegments(job, all);
  const std::string exact = readJob("t-1", 67);
  jobs::saveSegments(exact, std::vector<jobs::Segment>(all.begin(), all.begin() + 200));
  const auto [seen, pages] = readWalk(c, job);
  ctx.Assert(seen.size() == 250, "walking next_cursor returned %d of 250 segments in %d pages: a long recording must be readable past the first page", seen.size(), pages);
  ctx.Equal(seen, want, "every segment once, in order, across the pages");
  ctx.Equal(pages, 3, "250 segments at 100 a page; pages");
  const auto [even, evenPages] = readWalk(c, exact);
  ctx.Assert(evenPages == 2 && even.size() == 200, "200 segments are 2 pages, the second with next_cursor null; walking next_cursor took %d pages for %d segments", evenPages, even.size());
  const auto middle = bodyOf(readOne(c, job, "t-1", "150"));
  const auto starts = startsIn(middle);
  const bool last = middle.is_object() && middle.contains("next_cursor") && middle["next_cursor"].is_null();
  ctx.Assert(starts.size() == 100 && starts[0] == 1500000 && last, "?cursor=150 starts the page at segment 150, expected the 100 from 1 500 000 ms and next_cursor null, got %d segments: %s", starts.size(), middle.is_object() && middle.contains("next_cursor") ? middle["next_cursor"].dump() : middle.dump());
  const auto negative = readOne(c, job, "t-1", "-1");
  ctx.Assert(negative.Status >= 400 && negative.Status < 500, "?cursor=-1 answered %d, expected 400: a cursor is a segment offset, and a negative one is the client's error", negative.Status);
}
`,
  },
  hints: [
    "Read a job with another tenant's header: it comes back. Read a job with a failed chunk: it says done. Read a two-hour recording: segments stop at 100, out of order, and `next_cursor` is always null.",
    'The lookup is by id alone; `status` tests whether any segment exists; the segments are served in the order chunks were saved; the page is always the first `PAGE_SIZE`, and the completed count comes from a ledger that expires.',
    'Answer 404 when `job["tenant"] != tenant`; take `done` from `job["status"] == "done"` (then `completed_chunks = total_chunks`); sort by `start_ms`; slice from `?cursor=` and return `str(end)` as `next_cursor` while segments remain.',
  ],
  debrief: `Each flaw is the read claiming more than it knows. A segment proves that some chunk finished, not that all of them did, so \`done\` comes from the one record step 2 writes when the last chunk lands, which also outlives the ledger's 24 hours. The tenant check returns the same 404 as a missing id, because a different answer would let anyone probe which job ids exist. Sorting by \`start_ms\` puts back the order the speakers used, since chunks finish in whatever order the workers free up, and the cursor makes four hours of audio reachable a page at a time. Production read paths encode the cursor as an opaque token, list failed chunk indexes for a retry button, and cache a finished transcript, since it no longer changes.`,
};
