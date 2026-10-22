import type {Step} from '@/lib/types';

export const readStep: Step = {
  id: 'read',
  title: 'GET /v1/crawl/jobs/{id}: coverage without overclaiming',
  concept: 'http',
  file: 'read',
  focus: ['client', 'crawler', 'redis', 'index'],
  task: `## Task

The starter is a plausible model-generated draft: it answers with counts, a percentage and an HTTP
200, so a dashboard has something to draw. The number it draws is not true. Find the flaws, fix
them, and prove the fix.

Implement \`GET /v1/crawl/jobs/{job_id}\` — the report an operator reads to decide whether a crawl is
healthy:

- The tenant comes from the authenticated \`X-Tenant-Id\` header (**401** when missing), and a job
  that belongs to a **different tenant is 404** — never 403, which would confirm the job exists. The
  draft serves any job to any caller.
- The counts — \`fetched\`, \`refused\`, \`pending\`, \`indexed\` — come from the **live frontier**,
  not from a report cached on a timer. The draft refreshes its cached copy hourly, so an operator
  watching a crawl that just died sees a stale picture.
- \`oldest_pending_age_s\` is the age of the oldest URL still waiting, and it drives an explicit
  **\`stalled\`** flag: \`stalled = pending > 0 and oldest_pending_age_s > STALL_AFTER_S\`. A crawl
  whose counts have not moved is “in progress” to the draft and “stalled” to an operator.
- \`coverage\` is honest: **refused pages are excluded from it**. It is
  \`indexed / (fetched + pending)\` — never \`1.0\` just because the queue drained, because a crawl
  that refused half a site and fetched the rest has not covered half a site.

**Failure mode the checks target.** A cached counter lies about the present; a coverage number that
counts refusals as progress is the kind of metric that gets a crawl turned off a week too late; and a
stall that is not a field cannot be alerted on, so the first person to notice is the customer.`,
  sequence: {
    participants: ['Operator', 'Crawl service', 'Redis frontier', 'Search index'],
    messages: [
      {from: 'Operator', to: 'Crawl service', label: 'GET /v1/crawl/jobs/nightly · X-Tenant-Id', kind: 'sync'},
      {from: 'Crawl service', to: 'Crawl service', label: 'job owner is the calling tenant, else 404', kind: 'sync'},
      {from: 'Crawl service', to: 'Redis frontier', label: 'counts(job) · oldest pending age — live', kind: 'sync'},
      {from: 'Redis frontier', to: 'Crawl service', label: '{fetched, refused, pending} · age', kind: 'reply'},
      {from: 'Crawl service', to: 'Search index', label: 'indexed(job) — live', kind: 'sync'},
      {from: 'Search index', to: 'Crawl service', label: 'indexed count', kind: 'reply'},
      {
        from: 'Crawl service',
        to: 'Operator',
        label: '200 {counts, coverage, oldest_pending_age_s, stalled}',
        kind: 'reply',
      },
    ],
  },
  hints: [
    'Ownership is part of the lookup, not a separate check: fetch the job and compare its tenant to the caller’s in the same step, and answer 404 for a miss or a foreign job. A 403 for a foreign job still tells the caller the id exists.',
    'The coverage denominator is the work you can still do plus the work you did: `indexed / (fetched + pending)`. Refused URLs are neither — they are decisions, not progress — so they must not appear in either the numerator or the denominator, and a drained queue with refusals is not 100%.',
    'A stall is a fact about waiting, not about totals: expose the age of the oldest pending URL, compare it against a threshold constant, and return the flag explicitly. Downstream alerting should not have to re-derive “nothing has moved for ten minutes” from two counters that both look fine.',
  ],
  checks: [
    {
      id: 'route',
      title: 'Handles GET /v1/crawl/jobs/{job_id}',
      detail: 'Register the report route on `GET /v1/crawl/jobs/{job_id}`.',
      match: {
        python: {all: [/@app\.get\(\s*["']\/v1\/crawl\/jobs\/\{job_id\}["']/]},
        typescript: {all: [/app\.get\(\s*['"]\/v1\/crawl\/jobs\/:job_id['"]/]},
        go: {all: [/HandleFunc\(\s*"GET \/v1\/crawl\/jobs\/\{job_id\}"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"crawl"\s*\/\s*"jobs"\s*\/\s*Segment\s*\)/, /\bget\s*\{/]},
        cpp: {all: [/svr\.Get\(\s*R"\(\/v1\/crawl\/jobs\//]},
      },
    },
    {
      id: 'live-counts',
      title: 'Reports live frontier counts, not a cached snapshot',
      detail:
        'The counts are read from the frontier on every request, along with the oldest pending age. The draft serves a report cached for an hour, so an operator sees a picture from the last refresh.',
      match: {
        python: {all: [/frontier\.counts\(/, /oldest_pending/], none: [/cached/]},
        typescript: {all: [/frontier\.counts\(/, /oldestPending/], none: [/cached/]},
        go: {all: [/frontier\.Counts\(/, /OldestPending/], none: [/cached/]},
        scala: {all: [/frontier\.counts\(/, /oldestPending/], none: [/cached/]},
        cpp: {all: [/frontier\.counts\(/, /oldest_pending/], none: [/cached/]},
      },
    },
    {
      id: 'coverage',
      title: 'Coverage excludes refused pages',
      detail:
        'The report returns a `refused` count and a `coverage` that excludes those pages from the work actually done: `indexed / (fetched + pending)`. The draft claims 100% as soon as the queue drains, refusals and all.',
      match: {
        python: {all: [/coverage/, /refused/]},
        typescript: {all: [/coverage/, /refused/]},
        go: {all: [/coverage/, /Refused/]},
        scala: {all: [/coverage/, /refused/]},
        cpp: {all: [/coverage/, /refused/]},
      },
    },
    {
      id: 'stall-flag',
      title: 'The oldest pending age drives a stall flag',
      detail:
        'The report exposes `oldest_pending_age_s` and a `stalled` flag computed from it against `STALL_AFTER_S`. The draft has neither, so a crawl that stopped is indistinguishable from one that is working.',
      match: {
        python: {all: [/oldest_pending_age_s\(/, /stalled\s*=/]},
        typescript: {all: [/oldestPendingAgeS\(/, /stalled\s*=/]},
        go: {all: [/OldestPending\(/, /stalled\s*:=/]},
        scala: {all: [/oldestPendingAgeS\(/, /stalled\s*=/]},
        cpp: {all: [/oldest_pending_age_s\(/, /stalled\s*=/]},
      },
    },
    {
      id: 'foreign-404',
      title: 'A foreign job id is 404',
      detail:
        'A job that exists but belongs to another tenant answers **404**, the same as an unknown job. The draft serves any job to any caller.',
      match: {
        python: {all: [/job\.tenant\s*!=\s*tenant/, /status_code\s*=\s*404/]},
        typescript: {all: [/job\.tenant\s*!==\s*tenant/, /code\(\s*404\s*\)/]},
        go: {all: [/job\.Tenant\s*!=\s*tenant/, /StatusNotFound/]},
        scala: {all: [/job\.tenant\s*!=\s*tenant/, /StatusCodes\.NotFound/]},
        cpp: {all: [/job->tenant\s*!=\s*tenant/, /\b404\b/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import time

from fastapi import FastAPI
from fastapi.responses import JSONResponse

app = FastAPI()

CACHE_TTL_S = 3600
cached_reports: dict = {}


@app.get("/v1/crawl/jobs/{job_id}")
def report(job_id: str) -> JSONResponse:
    # TODO: this draft serves a counter cached for an hour, claims 100 percent once the queue
    # drains even if pages were refused, never says how long the oldest pending URL has waited,
    # and serves any job to any caller. Read the live frontier, keep refused pages out of coverage,
    # expose the pending age and a stall flag, and 404 a job that belongs to another tenant.
    entry = cached_reports.get(job_id)
    if entry is None or time.time() - entry["refreshed_at"] > CACHE_TTL_S:
        counts = frontier.counts(job_id)
        total = counts["fetched"] + counts["pending"]
        coverage = 1.0 if counts["pending"] == 0 else round(counts["indexed"] / total, 4)
        entry = {"counts": counts, "coverage": coverage, "refreshed_at": time.time()}
        cached_reports[job_id] = entry
    return JSONResponse({"job_id": job_id, **entry["counts"], "coverage": entry["coverage"]})
`,
      solution: `import time

from fastapi import FastAPI, Header, HTTPException

app = FastAPI()

STALL_AFTER_S = 300


@app.get("/v1/crawl/jobs/{job_id}")
def report(job_id: str, tenant: str | None = Header(default=None, alias="X-Tenant-Id")) -> dict:
    """The job report, computed from the live frontier and scoped to the calling tenant."""
    if tenant is None or tenant == "":
        raise HTTPException(status_code=401, detail="missing X-Tenant-Id")
    job = jobs.get(job_id)
    if job is None or job.tenant != tenant:
        raise HTTPException(status_code=404, detail="unknown job")
    counts = frontier.counts(job_id)
    oldest_pending_age_s = frontier.oldest_pending_age_s(job_id)
    total = counts["fetched"] + counts["pending"]
    coverage = round(counts["indexed"] / total, 4) if total > 0 else 0.0
    stalled = counts["pending"] > 0 and oldest_pending_age_s > STALL_AFTER_S
    return {
        "job_id": job_id,
        "fetched": counts["fetched"],
        "refused": counts["refused"],
        "pending": counts["pending"],
        "indexed": counts["indexed"],
        "oldest_pending_age_s": oldest_pending_age_s,
        "coverage": coverage,
        "stalled": stalled,
    }
`,
    },
    typescript: {
      starter: `/** Job report: a model-generated draft that serves a cached counter to any caller. */
import Fastify from 'fastify';

export const app = Fastify();

const CACHE_TTL_MS = 3600 * 1000;

const cachedReports = new Map<string, {report: Record<string, number>; refreshedAt: number}>();

app.get('/v1/crawl/jobs/:job_id', async (request, reply) => {
  // TODO: this draft serves a counter cached for an hour, claims 100 percent once the queue
  // drains even if pages were refused, never says how long the oldest pending URL has waited,
  // and serves any job to any caller. Read the live frontier, keep refused pages out of coverage,
  // expose the pending age and a stall flag, and 404 a job that belongs to another tenant.
  const {job_id: jobId} = request.params as {job_id: string};
  const cached = cachedReports.get(jobId);
  if (cached === undefined || Date.now() - cached.refreshedAt > CACHE_TTL_MS) {
    const counts = await frontier.counts(jobId);
    const total = counts.fetched + counts.pending;
    const coverage = counts.pending === 0 ? 1 : Math.round((counts.indexed / total) * 10000) / 10000;
    cachedReports.set(jobId, {report: {...counts, coverage}, refreshedAt: Date.now()});
    return reply.code(200).send({job_id: jobId, ...counts, coverage});
  }
  return reply.code(200).send({job_id: jobId, ...cached.report});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** Job report: live frontier counts, honest coverage, an explicit stall flag, tenant scoped. */
import Fastify from 'fastify';

export const app = Fastify();

const STALL_AFTER_S = 300;

app.get('/v1/crawl/jobs/:job_id', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing X-Tenant-Id'});
  const {job_id: jobId} = request.params as {job_id: string};
  const job = await jobs.get(jobId);
  if (job === null || job.tenant !== tenant) return reply.code(404).send({error: 'unknown job'});
  const counts = await frontier.counts(jobId);
  const oldestPendingAgeS = await frontier.oldestPendingAgeS(jobId);
  const total = counts.fetched + counts.pending;
  const coverage = total === 0 ? 0 : Math.round((counts.indexed / total) * 10000) / 10000;
  const stalled = counts.pending > 0 && oldestPendingAgeS > STALL_AFTER_S;
  return reply.code(200).send({
    job_id: jobId,
    fetched: counts.fetched,
    refused: counts.refused,
    pending: counts.pending,
    indexed: counts.indexed,
    oldest_pending_age_s: oldestPendingAgeS,
    coverage,
    stalled,
  });
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
    },
    go: {
      starter: `package report

import (
	"encoding/json"
	"log"
	"math"
	"net/http"
	"sync"
	"time"
)

const cacheTTL = time.Hour

type JobReport struct {
	JobID    string  \`json:"job_id"\`
	Counts   Counts  \`json:"counts"\`
	Coverage float64 \`json:"coverage"\`
}

type Counts struct {
	Fetched int \`json:"fetched"\`
	Pending int \`json:"pending"\`
	Indexed int \`json:"indexed"\`
}

var (
	mu            sync.Mutex
	cachedReports = map[string]cachedReport{}
)

type cachedReport struct {
	report      JobReport
	refreshedAt time.Time
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func jobReport(rw http.ResponseWriter, r *http.Request) {
	// TODO: this draft serves a counter cached for an hour, claims 100 percent once the queue
	// drains even if pages were refused, never says how long the oldest pending URL has waited,
	// and serves any job to any caller. Read the live frontier, keep refused pages out of coverage,
	// expose the pending age and a stall flag, and 404 a job that belongs to another tenant.
	jobID := r.PathValue("job_id")
	mu.Lock()
	cached, found := cachedReports[jobID]
	if !found || time.Since(cached.refreshedAt) > cacheTTL {
		counts, err := frontier.Counts(r.Context(), jobID)
		if err != nil {
			mu.Unlock()
			writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
			return
		}
		coverage := 1.0
		total := counts.Fetched + counts.Pending
		if total > 0 {
			coverage = math.Round(float64(counts.Indexed)/float64(total)*10000) / 10000
		}
		cached = cachedReport{report: JobReport{JobID: jobID, Counts: counts, Coverage: coverage}, refreshedAt: time.Now()}
		cachedReports[jobID] = cached
	}
	mu.Unlock()
	writeJSON(rw, http.StatusOK, cached.report)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/crawl/jobs/{job_id}", jobReport)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
      solution: `package report

import (
	"encoding/json"
	"log"
	"math"
	"net/http"
)

const stallAfterS = 300

type Counts struct {
	Fetched int \`json:"fetched"\`
	Refused int \`json:"refused"\`
	Pending int \`json:"pending"\`
	Indexed int \`json:"indexed"\`
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func jobReport(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-Tenant-Id"})
		return
	}
	jobID := r.PathValue("job_id")
	job, err := jobs.Get(r.Context(), jobID)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	if job == nil || job.Tenant != tenant {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "unknown job"})
		return
	}
	counts, err := frontier.Counts(r.Context(), jobID)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	oldestPendingAgeS, err := frontier.OldestPending(r.Context(), jobID)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	total := counts.Fetched + counts.Pending
	coverage := 0.0
	if total > 0 {
		coverage = math.Round(float64(counts.Indexed)/float64(total)*10000) / 10000
	}
	stalled := counts.Pending > 0 && oldestPendingAgeS > stallAfterS
	writeJSON(rw, http.StatusOK, map[string]any{
		"job_id":               jobID,
		"fetched":              counts.Fetched,
		"refused":              counts.Refused,
		"pending":              counts.Pending,
		"indexed":              counts.Indexed,
		"oldest_pending_age_s": oldestPendingAgeS,
		"coverage":             coverage,
		"stalled":              stalled,
	})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/crawl/jobs/{job_id}", jobReport)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
    },
    scala: {
      starter: `import java.time.{Duration, Instant}

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route

object JobReportApi {
  implicit val system: ActorSystem = ActorSystem("crawl-index")

  val CacheTtl = Duration.ofHours(1)
  var cachedReports: Map[String, (String, Instant)] = Map.empty

  val route: Route =
    path("v1" / "crawl" / "jobs" / Segment) { jobId =>
      get {
        // TODO: this draft serves a counter cached for an hour, claims 100 percent once the queue
        // drains even if pages were refused, never says how long the oldest pending URL has
        // waited, and serves any job to any caller. Read the live frontier, keep refused pages out
        // of coverage, expose the pending age and a stall flag, and 404 a job that belongs to
        // another tenant.
        val cached = cachedReports.get(jobId) match {
          case Some((body, refreshedAt)) if Duration.between(refreshedAt, Instant.now()).compareTo(CacheTtl) < 0 =>
            Some(body)
          case _ => None
        }
        cached match {
          case Some(body) => complete(StatusCodes.OK, body)
          case None =>
            val counts = frontier.counts(jobId)
            val total = counts.fetched + counts.pending
            val coverage = if (counts.pending == 0) 1.0 else math.round(counts.indexed.toDouble / total * 10000) / 10000.0
            val body = s"""{"job_id":"$jobId","fetched":\${counts.fetched},"pending":\${counts.pending},"indexed":\${counts.indexed},"coverage":$coverage}"""
            cachedReports = cachedReports.updated(jobId, (body, Instant.now()))
            complete(StatusCodes.OK, body)
        }
      }
    }

  def main(args: Array[String]): Unit = {
    Http().newServerAt("0.0.0.0", 8443).bind(route)
  }
}
`,
      solution: `import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class Job(
    job_id: String,
    tenant: String,
    fetched: Int,
    refused: Int,
    pending: Int,
    indexed: Int,
    oldest_pending_age_s: Long,
    coverage: Double,
    stalled: Boolean,
)

object JobReportApi {
  implicit val system: ActorSystem = ActorSystem("crawl-index")
  implicit val jobFormat: RootJsonFormat[Job] = jsonFormat9(Job)

  val StallAfterS = 300L

  val route: Route =
    path("v1" / "crawl" / "jobs" / Segment) { jobId =>
      get {
        optionalHeaderValueByName("X-Tenant-Id") { tenantOpt =>
          val tenant = tenantOpt.getOrElse("")
          if (tenant.isEmpty) {
            complete(StatusCodes.Unauthorized, """{"error":"missing X-Tenant-Id"}""")
          } else {
            jobs.get(jobId) match {
              case Some(job) if job.tenant != tenant =>
                complete(StatusCodes.NotFound, """{"error":"unknown job"}""")
              case None =>
                complete(StatusCodes.NotFound, """{"error":"unknown job"}""")
              case Some(job) =>
                val counts = frontier.counts(jobId)
                val oldestPendingAgeS = frontier.oldestPendingAgeS(jobId)
                val total = counts.fetched + counts.pending
                val coverage = if (total == 0) 0.0 else math.round(counts.indexed.toDouble / total * 10000) / 10000.0
                val stalled = counts.pending > 0 && oldestPendingAgeS > StallAfterS
                complete(
                  StatusCodes.OK,
                  Job(
                    jobId,
                    job.tenant,
                    counts.fetched,
                    counts.refused,
                    counts.pending,
                    counts.indexed,
                    oldestPendingAgeS,
                    coverage,
                    stalled
                  )
                )
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

#include <chrono>
#include <map>
#include <string>

using json = nlohmann::json;

constexpr long long kCacheTtlS = 3600;

std::map<std::string, json> cachedReports;

void jobReport(const httplib::Request& req, httplib::Response& res) {
  // TODO: this draft serves a counter cached for an hour, claims 100 percent once the queue
  // drains even if pages were refused, never says how long the oldest pending URL has waited,
  // and serves any job to any caller. Read the live frontier, keep refused pages out of coverage,
  // expose the pending age and a stall flag, and 404 a job that belongs to another tenant.
  const auto jobId = req.matches[1];
  const auto& cached = cachedReports[jobId];
  if (cached.is_null()) {
    const auto counts = frontier.counts(jobId);
    const int total = counts.fetched + counts.pending;
    const double coverage = counts.pending == 0 ? 1.0 : static_cast<double>(counts.indexed) / total;
    cachedReports[jobId] = json{{"job_id", jobId}, {"fetched", counts.fetched}, {"pending", counts.pending},
                                {"indexed", counts.indexed}, {"coverage", coverage}};
  }
  res.status = 200;
  res.set_content(cachedReports[jobId].dump(), "application/json");
}

int main() {
  httplib::Server svr;
  svr.Get(R"(/v1/crawl/jobs/([^/]+))", jobReport);
  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <cmath>
#include <string>

using json = nlohmann::json;

constexpr long long kStallAfterS = 300;

void jobReport(const httplib::Request& req, httplib::Response& res) {
  const auto tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) {
    res.status = 401;
    res.set_content(R"({"error":"missing X-Tenant-Id"})", "application/json");
    return;
  }
  const auto jobId = req.matches[1];
  const auto job = jobs.get(jobId);
  if (!job || job->tenant != tenant) {
    res.status = 404;
    res.set_content(R"({"error":"unknown job"})", "application/json");
    return;
  }
  const auto counts = frontier.counts(jobId);
  const auto oldestPendingAgeS = frontier.oldest_pending_age_s(jobId);
  const int total = counts.fetched + counts.pending;
  const double coverage =
      total == 0 ? 0.0 : std::round(static_cast<double>(counts.indexed) / total * 10000.0) / 10000.0;
  const bool stalled = counts.pending > 0 && oldestPendingAgeS > kStallAfterS;
  res.status = 200;
  res.set_content(
      json{{"job_id", jobId},
           {"fetched", counts.fetched},
           {"refused", counts.refused},
           {"pending", counts.pending},
           {"indexed", counts.indexed},
           {"oldest_pending_age_s", oldestPendingAgeS},
           {"coverage", coverage},
           {"stalled", stalled}}
          .dump(),
      "application/json");
}

int main() {
  httplib::Server svr;
  svr.Get(R"(/v1/crawl/jobs/([^/]+))", jobReport);
  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  debrief: `The interviewer is testing whether a read path can be reviewed as carefully as a write path. The draft is a dashboard-shaped endpoint: it returns numbers, and the numbers move. Three defects are being checked: a cached counter that reports the past, a coverage percentage that treats refusal as progress, and a missing stall signal that leaves “nothing has moved” invisible until a customer notices. The tenancy check is the quiet one: a 403 on a foreign job would confirm the id exists, so the honest answer for a job that is not yours is the same 404 you give for a job that does not exist. Real crawl consoles also break the numbers down per host, expose the frontier's oldest and newest pending URLs, and show the last refusal rule per host so an operator can see why coverage stopped moving.`,
};
