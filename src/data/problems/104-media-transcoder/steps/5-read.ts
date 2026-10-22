import type {Step} from '@/lib/types';

export const readStep: Step = {
  id: 'read',
  title: 'GET /v1/transcodes/{id}: progress computed from the manifest',
  concept: 'http',
  file: 'read',
  focus: ['client', 'api', 'db', 'output'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it looks the job up, divides
encoded seconds by a duration and returns a percentage. On a file that was encoded in one piece it
looks right, which is why nobody questions it until a customer does. Review it, fix it, and prove
the fix with the checks below.

Implement \`GET /v1/transcodes/{job_id}\`:

- The job is read from the store and the caller must **own** it: a job whose tenant is not the
  authenticated \`X-Tenant-Id\` is **404** (not 403 — a foreign id must not be distinguishable from a
  missing one). The draft serves any job to any caller.
- Progress is **computed from the manifest**, never from elapsed time or a guessed total:
  \`completed_segments\` is what the manifest says is done, and the response carries
  \`segment_count\` and \`failed_segments\` (the indices that failed, sorted).
- \`state\` is \`"done"\` **only when the manifest covers every expected segment** —
  \`expected = range(segment_count)\`, nothing missing — and there are no failures. A job with
  failures is \`"failed"\`; anything else is \`"processing"\`. The draft calls a job done at 99 % of
  its segments, which is exactly how a file with a missing minute ships as finished.
- The response lists **renditions with durations** (\`preset\`, \`duration_s\`/\`durationS\`, and a
  signed reference), so a client can render an output list without a second call.
- The draft's guess never changes the manifest: the read may cache, but it may not invent progress.

**Failure mode the checks target.** Percent-of-a-guess reports a number that no longer means
anything once segments have different lengths; a 99 % threshold is a lie told to a customer; an
unowned read leaks another tenant's filenames, presets and signed URLs; and a response without
failed indices hides which segment needs re-encoding.`,
  sequence: {
    participants: ['Client', 'Transcoder API', 'job store', 'Output store'],
    messages: [
      {from: 'Client', to: 'Transcoder API', label: 'GET /v1/transcodes/{id} · X-Tenant-Id', kind: 'sync'},
      {from: 'Transcoder API', to: 'Transcoder API', label: 'tenant from header — required', kind: 'sync'},
      {from: 'Transcoder API', to: 'job store', label: 'get(job_id)', kind: 'sync'},
      {
        from: 'job store',
        to: 'Transcoder API',
        label: 'job row + manifest {segments, failed, renditions}',
        kind: 'reply',
      },
      {from: 'Transcoder API', to: 'Transcoder API', label: 'foreign tenant → 404, no row disclosed', kind: 'sync'},
      {
        from: 'Transcoder API',
        to: 'Transcoder API',
        label: 'missing = range(count) − done · done ⇔ missing empty',
        kind: 'sync',
      },
      {from: 'Transcoder API', to: 'Output store', label: 'sign rendition refs (short-lived)', kind: 'async'},
      {from: 'Transcoder API', to: 'Client', label: '200 {state, completed, failed, renditions}', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Handles GET /v1/transcodes/{id}',
      detail: 'Register the read route on `GET /v1/transcodes/{job_id}`.',
      match: {
        python: {all: [/@app\.get\(\s*["']\/v1\/transcodes\/\{job_id\}["']/]},
        typescript: {all: [/app\.get\(\s*['"]\/v1\/transcodes\/:jobId['"]/]},
        go: {all: [/HandleFunc\(\s*"GET \/v1\/transcodes\/\{job_id\}"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"transcodes"\s*\/\s*Segment\s*\)/, /\bget\s*\{/]},
        cpp: {all: [/svr\.Get\(/, /v1\/transcodes/]},
      },
    },
    {
      id: 'done-manifest',
      title: 'Done only when the manifest covers every expected segment',
      detail:
        'The state is `"done"` only when nothing is missing from `expected = range(segment_count)` (an `every`/`len(missing) == 0`/`isEmpty`/`empty()` check). The draft calls a job done at 99 % of its segments.',
      match: {
        python: {all: [/expected\s*=\s*set\(range\(job\["segment_count"\]\)\)/, /state = "done"/], none: [/0\.99/]},
        typescript: {all: [/const complete = expected\.every\(/, /'done'/], none: [/0\.99/]},
        go: {all: [/complete := len\(missing\) == 0/, /"done"/], none: [/0\.99/]},
        scala: {all: [/val complete = missing\.isEmpty/, /"done"/], none: [/0\.99/]},
        cpp: {all: [/const bool complete = missing\.empty\(\)/, /"done"/], none: [/0\.99/]},
      },
    },
    {
      id: 'failed-indices',
      title: 'Lists the failed segment indices',
      detail:
        'The response carries the failed segment indices, sorted, so a caller knows which part of the file must be re-encoded. The draft lists nothing at all.',
      match: {
        python: {all: [/"failed_segments"/, /failed/]},
        typescript: {all: [/failedSegments/, /failed/]},
        go: {all: [/failedSegments/, /Failed/]},
        scala: {all: [/failedSegments/, /failed/]},
        cpp: {all: [/failed_segments/, /failed/]},
      },
    },
    {
      id: 'renditions',
      title: 'Returns renditions with durations',
      detail:
        'The response lists the output renditions with their durations (`duration_s`/`durationS`/`DurationS`) and a signed reference, taken from the manifest. The draft returns no renditions.',
      match: {
        python: {all: [/renditions/, /duration_s/]},
        typescript: {all: [/renditions/, /durationS/]},
        go: {all: [/Renditions/, /DurationS/]},
        scala: {all: [/renditions/, /durationS/]},
        cpp: {all: [/renditions/, /duration_s/]},
      },
    },
    {
      id: 'owner-404',
      title: 'A foreign job is 404',
      detail:
        'The authenticated tenant is compared with the job’s owner and a foreign job answers `404` before any field is rendered. The draft serves any job to any caller.',
      match: {
        python: {all: [/tenant/, /status_code\s*=\s*404/]},
        typescript: {all: [/tenant/, /code\(\s*404\s*\)/]},
        go: {all: [/tenant/, /StatusNotFound/]},
        scala: {all: [/tenant/, /StatusCodes\.NotFound/]},
        cpp: {all: [/tenant/, /\b404\b/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import logging

from fastapi import FastAPI, Header
from fastapi.responses import JSONResponse

app = FastAPI()
logger = logging.getLogger("transcoder")

GUESSED_DURATION_S = 3600.0


class JobStore:
    def get(self, job_id: str) -> dict | None:
        """The job row with its encoded seconds."""
        raise NotImplementedError


jobs = JobStore()


@app.get("/v1/transcodes/{job_id}")
def read(job_id: str, tenant: str = Header(alias="X-Tenant-Id")) -> JSONResponse:
    # TODO: this draft guesses progress from encoded seconds, calls a job done at 99 percent of
    # its segments, lists no failed indices, returns no renditions and serves any tenant's job.
    # Review all five.
    job = jobs.get(job_id)
    percent = job["encoded_seconds"] / GUESSED_DURATION_S
    logger.info("job read job=%s tenant=%s percent=%.2f", job_id, tenant, percent)
    state = "done" if percent >= 0.99 else "processing"
    return JSONResponse({"job_id": job_id, "state": state, "percent": percent}, status_code=200)
`,
      solution: `import logging

from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse

app = FastAPI()
logger = logging.getLogger("transcoder")


class JobStore:
    def get(self, job_id: str) -> dict | None:
        """The job row: tenant, segment_count and the manifest {segments, failed, renditions}."""
        raise NotImplementedError


jobs = JobStore()


def rendition_views(rows: list[dict]) -> list[dict]:
    """Renditions as the manifest recorded them: preset, duration and a signed reference."""
    views = []
    for row in rows:
        views.append({"preset": row["preset"], "duration_s": row["duration_s"], "signed_url": row["signed_url"]})
    return views


@app.get("/v1/transcodes/{job_id}")
def read(job_id: str, tenant: str = Header(alias="X-Tenant-Id")) -> JSONResponse:
    job = jobs.get(job_id)
    # A foreign job must be indistinguishable from a missing one.
    if job is None or job["tenant"] != tenant:
        raise HTTPException(status_code=404, detail="unknown job")

    manifest = job["manifest"]
    expected = set(range(job["segment_count"]))
    done = set(manifest["segments"])
    missing = sorted(expected - done)
    failed = sorted(manifest["failed"])
    complete = not missing and job["segment_count"] > 0
    state = "done" if complete else ("failed" if failed else "processing")
    logger.info("job read job=%s tenant=%s state=%s missing=%d", job_id, tenant, state, len(missing))
    return JSONResponse(
        {
            "job_id": job_id,
            "state": state,
            "completed_segments": len(done),
            "segment_count": job["segment_count"],
            "failed_segments": failed,
            "missing_segments": missing,
            "renditions": rendition_views(manifest["renditions"]),
        },
        status_code=200,
    )
`,
    },
    typescript: {
      starter: `/** Job read: a model-generated draft that guesses a percentage and trusts the caller. */
import Fastify from 'fastify';

import {jobs} from './state';

export const app = Fastify();

const GUESSED_DURATION_S = 3600;

app.get('/v1/transcodes/:jobId', async (request, reply) => {
  // TODO: this draft guesses progress from encoded seconds, calls a job done at 99 percent of
  // its segments, lists no failed indices, returns no renditions and serves any tenant's job.
  // Review all five.
  const {jobId} = request.params as {jobId: string};
  const job = await jobs.get(jobId);
  const percent = job.encodedSeconds / GUESSED_DURATION_S;
  const state = percent >= 0.99 ? 'done' : 'processing';
  request.log.info({job_id: jobId, percent}, 'job read');
  return reply.code(200).send({job_id: jobId, state, percent});
});
`,
      solution: `/** Job read: progress from the manifest, done only when nothing is missing, owners only. */
import Fastify from 'fastify';

import {jobs} from './state';

export const app = Fastify();

interface Rendition {
  preset: string;
  durationS: number;
  signedUrl: string;
}

interface JobRow {
  tenant: string;
  segmentCount: number;
  manifest: {segments: number[]; failed: number[]; renditions: Rendition[]};
}

app.get('/v1/transcodes/:jobId', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '')
    return reply.code(400).send({error: 'missing X-Tenant-Id'});
  const {jobId} = request.params as {jobId: string};

  const job = (await jobs.get(jobId)) as JobRow | null;
  // A foreign job must be indistinguishable from a missing one.
  if (job === null || job.tenant !== tenant) return reply.code(404).send({error: 'unknown job'});

  const expected = new Set<number>();
  for (let index = 0; index < job.segmentCount; index++) expected.add(index);
  const done = new Set(job.manifest.segments);
  const missing = [...expected].filter(index => !done.has(index)).sort((a, b) => a - b);
  const failed = [...job.manifest.failed].sort((a, b) => a - b);
  const complete = expected.every(index => done.has(index));
  const state = complete ? 'done' : failed.length > 0 ? 'failed' : 'processing';
  return reply.code(200).send({
    job_id: jobId,
    state,
    completed_segments: done.size,
    segment_count: job.segmentCount,
    failedSegments: failed,
    missingSegments: missing,
    renditions: job.manifest.renditions.map(row => ({
      preset: row.preset,
      durationS: row.durationS,
      signedUrl: row.signedUrl,
    })),
  });
});
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"net/http"
)

const guessedDurationS = 3600.0

type JobRow struct {
	Tenant         string  \`json:"tenant"\`
	EncodedSeconds float64 \`json:"encoded_seconds"\`
}

type JobStore interface {
	Get(ctx context.Context, jobID string) (*JobRow, error)
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

// readJob is the draft: a percentage of a guessed duration, served to any caller.
func readJob(rw http.ResponseWriter, r *http.Request, jobs JobStore) {
	// TODO: this draft guesses progress from encoded seconds, calls a job done at 99 percent of
	// its segments, lists no failed indices, returns no renditions and serves any tenant's job.
	// Review all five.
	tenant := r.Header.Get("X-Tenant-Id")
	job, err := jobs.Get(r.Context(), r.PathValue("job_id"))
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	percent := job.EncodedSeconds / guessedDurationS
	state := "processing"
	if percent >= 0.99 {
		state = "done"
	}
	writeJSON(rw, http.StatusOK, map[string]any{
		"job_id": r.PathValue("job_id"), "state": state, "percent": percent, "tenant": tenant,
	})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/transcodes/{job_id}", func(rw http.ResponseWriter, r *http.Request) {
		readJob(rw, r, jobs)
	})
	http.ListenAndServe(":8443", mux)
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"net/http"
	"sort"
)

type Rendition struct {
	Preset    string  \`json:"preset"\`
	DurationS float64 \`json:"duration_s"\`
	SignedURL string  \`json:"signed_url"\`
}

type JobRow struct {
	Tenant       string      \`json:"tenant"\`
	SegmentCount int         \`json:"segment_count"\`
	Segments     []int       \`json:"segments"\`
	Failed       []int       \`json:"failed"\`
	Renditions   []Rendition \`json:"renditions"\`
}

type JobStore interface {
	Get(ctx context.Context, jobID string) (*JobRow, error)
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

// readJob answers from the manifest: done only when every expected segment is present.
func readJob(rw http.ResponseWriter, r *http.Request, jobs JobStore) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "missing X-Tenant-Id"})
		return
	}
	jobID := r.PathValue("job_id")
	job, err := jobs.Get(r.Context(), jobID)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	// A foreign job must be indistinguishable from a missing one.
	if job == nil || job.Tenant != tenant {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "unknown job"})
		return
	}

	done := map[int]bool{}
	for _, index := range job.Segments {
		done[index] = true
	}
	missing := []int{}
	for index := 0; index < job.SegmentCount; index++ {
		if !done[index] {
			missing = append(missing, index)
		}
	}
	failedSegments := append([]int{}, job.Failed...)
	sort.Ints(failedSegments)
	complete := len(missing) == 0
	state := "processing"
	if complete {
		state = "done"
	} else if len(failedSegments) > 0 {
		state = "failed"
	}
	writeJSON(rw, http.StatusOK, map[string]any{
		"job_id":             jobID,
		"state":              state,
		"completed_segments": len(done),
		"segment_count":      job.SegmentCount,
		"failedSegments":     failedSegments,
		"missingSegments":    missing,
		"renditions":         job.Renditions,
	})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/transcodes/{job_id}", func(rw http.ResponseWriter, r *http.Request) {
		readJob(rw, r, jobs)
	})
	http.ListenAndServe(":8443", mux)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route

object ReadApi {
  implicit val system: ActorSystem = ActorSystem("media-transcoder")

  val GuessedDurationS = 3600.0
  val jobs = new JobStore

  // The draft: a percentage of a guessed duration, served to any caller.
  val route: Route = path("v1" / "transcodes" / Segment) { jobId =>
    get {
      headerValueByName("X-Tenant-Id") { tenant =>
        // TODO: this draft guesses progress from encoded seconds, calls a job done at 99 percent
        // of its segments, lists no failed indices, returns no renditions and serves any
        // tenant's job. Review all five.
        val job = jobs.get(jobId).get
        val percent = job.encodedSeconds / GuessedDurationS
        val state = if (percent >= 0.99) "done" else "processing"
        system.log.info("job read job={} tenant={} percent={}", jobId, tenant, percent)
        complete(StatusCodes.OK, s"""{"job_id":"$jobId","state":"$state","percent":$percent}""")
      }
    }
  }

  def main(args: Array[String]): Unit = Http().newServerAt("0.0.0.0", 8443).bind(route)
}

class JobStore {
  def get(jobId: String): Option[JobRow] = None
}

final case class JobRow(tenant: String, encodedSeconds: Double)
`,
      solution: `import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route

final case class Rendition(preset: String, durationS: Double, signedUrl: String)
final case class Manifest(segments: List[Int], failed: List[Int], renditions: List[Rendition])
final case class JobRow(tenant: String, segmentCount: Int, manifest: Manifest)

object ReadApi {
  implicit val system: ActorSystem = ActorSystem("media-transcoder")

  val jobs = new JobStore

  def renditionJson(row: Rendition): String =
    s"""{"preset":"${'$'}{row.preset}","durationS":${'$'}{row.durationS},"signedUrl":"${'$'}{row.signedUrl}"}"""

  // Answers from the manifest: done only when every expected segment is present.
  val route: Route = path("v1" / "transcodes" / Segment) { jobId =>
    get {
      headerValueByName("X-Tenant-Id") { tenant =>
        jobs.get(jobId) match {
          // A foreign job must be indistinguishable from a missing one.
          case Some(job) if job.tenant == tenant =>
            val expected = (0 until job.segmentCount).toSet
            val done = job.manifest.segments.toSet
            val missing = (expected -- done).toList.sorted
            val failed = job.manifest.failed.sorted
            val complete = missing.isEmpty
            val state = if (complete) "done" else if (failed.nonEmpty) "failed" else "processing"
            val refs = job.manifest.renditions.map(renditionJson).mkString(",")
            system.log.info("job read job={} tenant={} state={} missing={}", jobId, tenant, state, missing.size)
            complete(
              StatusCodes.OK,
              s"""{"job_id":"$jobId","state":"$state","completed_segments":${'$'}{done.size},"segment_count":${'$'}{job.segmentCount},"failedSegments":${'$'}{failed.mkString("[", ",", "]")},"missingSegments":${'$'}{missing.mkString("[", ",", "]")},"renditions":[$refs]}"""
            )
          case _ =>
            complete(StatusCodes.NotFound, "unknown job")
        }
      }
    }
  }

  def main(args: Array[String]): Unit = Http().newServerAt("0.0.0.0", 8443).bind(route)
}

class JobStore {
  /** The job row with its tenant and manifest. */
  def get(jobId: String): Option[JobRow] = None
}
`,
    },
    cpp: {
      starter: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <string>

using json = nlohmann::json;

namespace {

constexpr double kGuessedDurationS = 3600.0;

}  // namespace

class JobStore {
 public:
  /** The job row with its encoded seconds. */
  std::optional<json> get(const std::string& job_id) { return std::nullopt; }
};

JobStore jobs;

int main() {
  httplib::Server svr;

  svr.Get(R"(/v1/transcodes/([^/]+))", [](const httplib::Request& req, httplib::Response& res) {
    // TODO: this draft guesses progress from encoded seconds, calls a job done at 99 percent of
    // its segments, lists no failed indices, returns no renditions and serves any tenant's job.
    // Review all five.
    const std::string job_id = req.matches[1];
    const std::string tenant = req.get_header_value("X-Tenant-Id");
    const auto job = jobs.get(job_id);
    const double percent = job->value("encoded_seconds", 0.0) / kGuessedDurationS;
    const std::string state = percent >= 0.99 ? "done" : "processing";
    std::clog << "job read job=" << job_id << " tenant=" << tenant << " percent=" << percent << std::endl;
    res.status = 200;
    res.set_content(json{{"job_id", job_id}, {"state", state}, {"percent", percent}}.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <algorithm>
#include <iostream>
#include <optional>
#include <set>
#include <string>
#include <vector>

using json = nlohmann::json;

class JobStore {
 public:
  /** The job row with its tenant and manifest. */
  std::optional<json> get(const std::string& job_id) { return std::nullopt; }
};

JobStore jobs;

int main() {
  httplib::Server svr;

  svr.Get(R"(/v1/transcodes/([^/]+))", [](const httplib::Request& req, httplib::Response& res) {
    const std::string tenant = req.get_header_value("X-Tenant-Id");
    if (tenant.empty()) {
      res.status = 400;
      res.set_content(json{{"error", "missing X-Tenant-Id"}}.dump(), "application/json");
      return;
    }
    const std::string job_id = req.matches[1];
    const auto job = jobs.get(job_id);
    // A foreign job must be indistinguishable from a missing one.
    if (!job || job->value("tenant", "") != tenant) {
      res.status = 404;
      res.set_content(json{{"error", "unknown job"}}.dump(), "application/json");
      return;
    }

    const int segment_count = job->value("segment_count", 0);
    std::set<int> expected;
    for (int index = 0; index < segment_count; ++index) expected.insert(index);
    std::set<int> done;
    for (const auto& index : job->at("segments")) done.insert(index.get<int>());
    std::vector<int> missing;
    std::set_difference(expected.begin(), expected.end(), done.begin(), done.end(), std::back_inserter(missing));
    std::vector<int> failed = job->at("failed").get<std::vector<int>>();
    std::sort(failed.begin(), failed.end());
    const bool complete = missing.empty();
    const std::string state = complete ? "done" : (failed.empty() ? "processing" : "failed");

    json renditions = json::array();
    for (const auto& row : job->at("renditions")) {
      renditions.push_back(json{{"preset", row.at("preset")},
                                {"duration_s", row.at("duration_s")},
                                {"signed_url", row.at("signed_url")}});
    }
    std::clog << "job read job=" << job_id << " tenant=" << tenant << " state=" << state << std::endl;
    res.status = 200;
    res.set_content(json{{"job_id", job_id},
                         {"state", state},
                         {"completed_segments", done.size()},
                         {"segment_count", segment_count},
                         {"failed_segments", failed},
                         {"missing_segments", missing},
                         {"renditions", renditions}}
                        .dump(),
                    "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  hints: [
    'Compare the authenticated tenant with the job’s owner before rendering anything, and answer 404 — not 403 — for a foreign job: a distinguishable status tells the caller that the id exists.',
    'Compute the state from sets, not from a percentage: `expected = range(segment_count)`, `done` from the manifest, `missing = expected − done`, and `done` only when `missing` is empty. A percentage is fine for a progress bar, never for a completion decision.',
    'The response is a contract with the player: completed segment count, the failing indices, and each rendition with its duration and a signed reference. Return all of it from the manifest so the read cannot disagree with the events.',
  ],
  debrief: `The interviewer is testing whether you can review a generated read endpoint that decides what "finished" means. The draft is convincing because a percentage is what a dashboard shows. Four defects are being checked: completion derived from a gapless manifest instead of a 99 % threshold (a file with a missing minute must never report done), the failed indices (a caller needs to know which segment to re-encode), renditions with durations from the manifest (so the output list never disagrees with the events), and ownership (a foreign job is 404, indistinguishable from a missing one). The percentage in the draft is the deeper flaw: it re-guesses the duration the pipeline already knows, and it silently hides the difference between a job that is nearly finished and one that is finished. Real reads add ETag caching on the manifest version, a streaming progress endpoint for long jobs, and a signed playback manifest per rendition.`,
};
