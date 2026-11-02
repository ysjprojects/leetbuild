import type {Step} from '@/lib/types';

export const readStep: Step = {
  id: 'read',
  title: 'GET /v1/crawl/jobs/{id}: coverage without overclaiming',
  concept: 'http',
  file: 'read',
  focus: ['client', 'crawler', 'redis', 'index'],
  task: `## Task

**Starting point.** The starter serves \`GET /v1/crawl/jobs/{job_id}\`, the report an operator
reads to decide whether a crawl is healthy: it builds \`{fetched, refused, pending, indexed,
coverage}\` from the frontier, caches that entry per job and answers 200. It serves the demo and
hides four flaws.

**Failure mode the checks target.** A cached counter describes the past; a coverage number that
counts refusals as progress gets a crawl turned off a week too late; a stall that is not a field
cannot be alerted on, so the customer notices first; and a report that answers any caller is a
cross-tenant read.

- The tenant comes from the authenticated \`X-Tenant-Id\` header (**401** when missing), and a
  job that belongs to a **different tenant is 404**, not 403, which would confirm the job exists.
- The counts \`fetched\`, \`refused\`, \`pending\` and \`indexed\` come from the **live
  frontier** on every request, not from a report cached on a timer.
- \`oldest_pending_age_s\` is the age of the oldest URL still waiting, and it drives an explicit
  **\`stalled\`** flag: \`stalled = pending > 0 and oldest_pending_age_s > STALL_AFTER_S\`.
- \`coverage\` **excludes refused pages**: \`indexed / (fetched + pending)\`, with no shortcut to
  \`1.0\` when the queue drains.`,
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
    'A crawl died twenty minutes ago and the dashboard still shows it moving. A job that refused half a site reports 100% coverage, and any tenant can read any job id.',
    '`report` serves `cached_reports` until `CACHE_TTL_S` expires, sets coverage to `1.0` whenever `pending == 0`, computes no pending age, and reads no tenant header before answering.',
    'Require `X-Tenant-Id` and 404 a job owned by another tenant; call `frontier.counts` on every request; compute `indexed / (fetched + pending)`; return `oldest_pending_age_s` and `stalled = pending > 0 and age > STALL_AFTER_S`.',
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
        'The counts are read from the frontier on every request, along with the oldest pending age. The starter serves a report cached for an hour, so an operator sees a picture from the last refresh.',
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
        'The report returns a `refused` count and a `coverage` that excludes those pages from the work actually done: `indexed / (fetched + pending)`. The starter claims 100% as soon as the queue drains, refusals and all.',
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
        'The report exposes `oldest_pending_age_s` and a `stalled` flag computed from it against `STALL_AFTER_S`. The starter has neither, so a crawl that stopped is indistinguishable from one that is working.',
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
        'A job that exists but belongs to another tenant answers **404**, the same as an unknown job. The starter serves any job to any caller.',
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
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
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
      starter: `/** Job report: flawed code that serves a cached counter to any caller. */
import Fastify from 'fastify';

export const app = Fastify();

const CACHE_TTL_MS = 3600 * 1000;

const cachedReports = new Map<string, {report: Record<string, number>; refreshedAt: number}>();

app.get('/v1/crawl/jobs/:job_id', async (request, reply) => {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
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
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
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
        // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
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
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
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
  debrief: `The report reads live state and refuses to round in its own favour, because the property it protects is that an operator can act on it: a stale count describes a crawl that no longer exists, a coverage figure that counts refusals as progress hides the part of a site the crawler was told to leave alone, and a stall only derivable from two healthy-looking counters cannot be alerted on. The tenancy rule follows the same logic: a 404 for a foreign job gives the caller exactly as much as an unknown one. Production crawl consoles break the numbers down per host, record the last refusal rule per host so an operator sees why coverage stopped moving, and keep report history so a stall has a start time.`,
};
