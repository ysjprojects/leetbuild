import type {Step} from '@/lib/types';

export const readStep: Step = {
  id: 'read',
  title: 'GET /v1/crawl/jobs/{job_id}: a live report that says when a crawl stalls',
  concept: 'http',
  file: 'read',
  focus: ['client', 'crawler', 'registry', 'redis'],
  task: `## Task

**Starting point.** The starter serves \`GET /v1/crawl/jobs/{job_id}\` with the tenant in
\`X-Tenant-Id\` (401 without it), the report an operator reads to decide whether a crawl is
healthy: it checks the job's tenant with \`registry.job_of\`, builds \`{job_id, fetched, refused,
gone, failed, indexed, pending, oldest_pending_age_s, coverage}\` from \`records.counts\` and
\`pending:{job_id}\`, and keeps each report for \`REPORT_TTL_S\` (five minutes). It serves the demo
and hides four flaws.

**Failure mode the checks target.** A probe learns which job ids exist by watching 403 turn into
404; an operator reads five-minute-old numbers during an incident; a crawl whose first URL has
waited an hour looks fresh because the age is measured from the newest URL; and coverage counts
refused pages against the crawl, then jumps to 1.0 the moment the queue drains.

- Another tenant's job is **404**, exactly like a job that does not exist.
- Every request reads the live counts: no cached report.
- \`oldest_pending_age_s\` is the age of the oldest member of \`pending:{job_id}\`, and \`stalled\` is
  \`pending > 0 and oldest_pending_age_s > STALL_AFTER_S\` (600).
- \`coverage = indexed / (fetched + failed + pending)\`, rounded to 3 places (0 when nothing is
  owed): refused and gone pages are left out, with no shortcut when the queue drains.`,
  sequence: {
    participants: ['Operator', 'crawld', 'Target registry', 'Redis'],
    messages: [
      {from: 'Operator', to: 'crawld', label: 'GET /v1/crawl/jobs/{job_id} · X-Tenant-Id', kind: 'sync'},
      {from: 'crawld', to: 'Target registry', label: 'job_of(job_id) → another tenant: 404', kind: 'sync'},
      {from: 'crawld', to: 'Redis', label: 'HGETALL counts:{job} · ZCARD pending:{job}', kind: 'sync'},
      {from: 'crawld', to: 'Redis', label: 'ZRANGE pending:{job} 0 0 WITHSCORES', kind: 'sync'},
      {from: 'Redis', to: 'crawld', label: 'oldest pending URL and its enqueue time', kind: 'reply'},
      {
        from: 'crawld',
        to: 'Operator',
        label: '200 {counts, pending, oldest_pending_age_s, stalled, coverage}',
        kind: 'reply',
      },
    ],
  },
  checks: [
    {
      id: 'tenant-404',
      title: "Another tenant's job is 404",
      detail:
        'A job that belongs to another tenant answers **404**, exactly like an unknown job, so the answer reveals nothing about which ids exist; no request answers 403. The starter answers 403 for a tenant mismatch.',
      match: {
        python: {all: [/status_code\s*=\s*404/], none: [/status_code\s*=\s*403/]},
        typescript: {all: [/code\(\s*404\s*\)/], none: [/code\(\s*403\s*\)/]},
        go: {all: [/StatusNotFound/], none: [/StatusForbidden/]},
        scala: {all: [/NotFound/], none: [/Forbidden/]},
        cpp: {all: [/\b404\b/], none: [/\b403\b/]},
      },
    },
    {
      id: 'live-counts',
      title: 'Reads the live counts on every request',
      detail:
        'Each request reads `records.counts` and `pending:{job_id}`; nothing is served from a cached report. The starter keeps each report in `_reports` for `REPORT_TTL_S`.',
      match: {
        python: {all: [/records\.counts\(/], none: [/_reports\[|_reports\.get\(/]},
        typescript: {all: [/counts\(/], none: [/reports\.(get|set)\(/]},
        go: {all: [/records\.Counts\(/], none: [/reports\[/]},
        scala: {all: [/Records\.counts\(/], none: [/reports\.(get|put|update)\(/]},
        cpp: {all: [/records::counts\(/], none: [/reports\[|reports\.find\(/]},
      },
    },
    {
      id: 'stalled',
      title: 'Ages the oldest pending URL and flags a stall',
      detail:
        '`oldest_pending_age_s` comes from the first member of `pending:{job_id}` (`ZRANGE … 0 0 WITHSCORES`), and `stalled` is true when URLs are pending and the oldest has waited longer than `STALL_AFTER_S`. The starter ages the newest URL and has no stall flag.',
      match: {
        python: {
          all: [/STALL_AFTER_S/, /["']stalled["']/, /zrange\([\s\S]{0,80}?,\s*0\s*,\s*0\b/],
          none: [/-1\s*,\s*-1/],
        },
        typescript: {all: [/STALL_AFTER_S/, /stalled/, /zrange\([\s\S]{0,80}?,\s*0\s*,\s*0\b/], none: [/-1\s*,\s*-1/]},
        go: {
          all: [/stallAfterS/, /"stalled"/, /ZRangeWithScores\([\s\S]{0,80}?,\s*0\s*,\s*0\)/],
          none: [/-1\s*,\s*-1/],
        },
        scala: {
          all: [/StallAfterS/, /"stalled"/, /zrangeWithScores\([\s\S]{0,80}?,\s*0\s*,\s*0\)/],
          none: [/-1\s*,\s*-1/],
        },
        cpp: {all: [/kStallAfterS/, /"stalled"/, /zrange\([\s\S]{0,80}?,\s*0\s*,\s*0\s*,/], none: [/-1\s*,\s*-1/]},
      },
    },
    {
      id: 'coverage',
      title: 'Coverage leaves refused and gone pages out',
      detail:
        "`coverage = indexed / (fetched + failed + pending)`: refused and gone pages are the site's answer, not work the crawl owes, and a drained queue is no reason to answer 1.0. The starter divides by fetched + refused + pending and answers 1.0 whenever nothing is pending.",
      match: {
        python: {all: [/counts\[["']failed["']\]/], none: [/counts\[["']refused["']\]/, /1\.0 if/]},
        typescript: {all: [/\bc(ounts)?\.failed/], none: [/\bc(ounts)?\.refused/, /\?\s*1(\.0)?\s*:/]},
        go: {all: [/counts\["failed"\]/], none: [/counts\["refused"\]/, /coverage\s*:=\s*1\.0/]},
        scala: {all: [/counts\("failed"\)/], none: [/counts\("refused"\)/, /\b1\.0\s+else|else\s+1\.0\b/]},
        cpp: {
          all: [/counts\["failed"\]|counts\.at\("failed"\)/],
          none: [/counts\["refused"\]|counts\.at\("refused"\)/, /\?\s*1\.0\s*:/],
        },
      },
    },
  ],
  code: {
    python: {
      starter: `import time

import redis
from fastapi import FastAPI, HTTPException, Request

from crawl import frontier, records, registry  # registry.job_of; records.counts; frontier.pending_key

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)

REPORT_TTL_S = 300
_reports: dict[str, tuple[float, dict]] = {}


@app.get("/v1/crawl/jobs/{job_id}")
def job_report(job_id: str, request: Request) -> dict:
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    tenant = request.headers.get("x-tenant-id")
    if not tenant:
        raise HTTPException(status_code=401, detail="X-Tenant-Id is required")
    job = registry.job_of(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="no such job")
    if job["tenant"] != tenant:
        raise HTTPException(status_code=403, detail="the job belongs to another tenant")
    cached = _reports.get(job_id)
    if cached is not None and time.time() - cached[0] < REPORT_TTL_S:
        return cached[1]
    counts = records.counts(job_id)
    pending = r.zcard(frontier.pending_key(job_id))
    newest = r.zrange(frontier.pending_key(job_id), -1, -1, withscores=True)
    age = int(time.time() - newest[0][1]) if newest else 0
    coverage = 1.0 if pending == 0 else counts["indexed"] / (counts["fetched"] + counts["refused"] + pending)
    report = {"job_id": job_id, **counts, "pending": pending, "oldest_pending_age_s": age, "coverage": round(coverage, 3)}
    _reports[job_id] = (time.time(), report)
    return report
`,
      solution: `import time

import redis
from fastapi import FastAPI, HTTPException, Request

from crawl import frontier, records, registry  # registry.job_of; records.counts; frontier.pending_key

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)

STALL_AFTER_S = 600


@app.get("/v1/crawl/jobs/{job_id}")
def job_report(job_id: str, request: Request) -> dict:
    tenant = request.headers.get("x-tenant-id")
    if not tenant:
        raise HTTPException(status_code=401, detail="X-Tenant-Id is required")
    job = registry.job_of(job_id)
    # Another tenant's job answers exactly like a job that does not exist.
    if job is None or job["tenant"] != tenant:
        raise HTTPException(status_code=404, detail="no such job")
    counts = records.counts(job_id)
    pending = r.zcard(frontier.pending_key(job_id))
    oldest = r.zrange(frontier.pending_key(job_id), 0, 0, withscores=True)
    age = int(time.time() - oldest[0][1]) if oldest else 0
    # Refused and gone pages are the site's answer, not work the crawl owes.
    owed = counts["fetched"] + counts["failed"] + pending
    coverage = round(counts["indexed"] / owed, 3) if owed else 0.0
    return {
        "job_id": job_id,
        **counts,
        "pending": pending,
        "oldest_pending_age_s": age,
        "stalled": pending > 0 and age > STALL_AFTER_S,
        "coverage": coverage,
    }
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';
import Redis from 'ioredis';

import {pendingKey} from 'crawl/frontier';
import {counts} from 'crawl/records';
import {jobOf} from 'crawl/registry';

export const app = Fastify();
const redis = new Redis({host: 'redis', port: 6379});

export const REPORT_TTL_S = 300;
const reports = new Map<string, {at: number; report: Record<string, unknown>}>();

app.get('/v1/crawl/jobs/:jobId', async (request, reply) => {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'X-Tenant-Id is required'});
  const {jobId} = request.params as {jobId: string};
  const job = await jobOf(jobId);
  if (job === null) return reply.code(404).send({error: 'no such job'});
  if (job.tenant !== tenant) return reply.code(403).send({error: 'the job belongs to another tenant'});
  const cached = reports.get(jobId);
  if (cached !== undefined && Date.now() - cached.at < REPORT_TTL_S * 1000) return cached.report;
  const c = await counts(jobId);
  const pending = await redis.zcard(pendingKey(jobId));
  const newest = await redis.zrange(pendingKey(jobId), -1, -1, 'WITHSCORES');
  const age = newest.length === 2 ? Math.floor(Date.now() / 1000 - Number(newest[1])) : 0;
  const coverage = pending === 0 ? 1 : c.indexed / (c.fetched + c.refused + pending);
  const report = {job_id: jobId, ...c, pending, oldest_pending_age_s: age, coverage: Math.round(coverage * 1000) / 1000};
  reports.set(jobId, {at: Date.now(), report});
  return report;
});
`,
      solution: `import Fastify from 'fastify';
import Redis from 'ioredis';

import {pendingKey} from 'crawl/frontier';
import {counts} from 'crawl/records';
import {jobOf} from 'crawl/registry';

export const app = Fastify();
const redis = new Redis({host: 'redis', port: 6379});

export const STALL_AFTER_S = 600;

app.get('/v1/crawl/jobs/:jobId', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'X-Tenant-Id is required'});
  const {jobId} = request.params as {jobId: string};
  const job = await jobOf(jobId);
  // Another tenant's job answers exactly like a job that does not exist.
  if (job === null || job.tenant !== tenant) return reply.code(404).send({error: 'no such job'});
  const c = await counts(jobId);
  const pending = await redis.zcard(pendingKey(jobId));
  const oldest = await redis.zrange(pendingKey(jobId), 0, 0, 'WITHSCORES');
  const age = oldest.length === 2 ? Math.floor(Date.now() / 1000 - Number(oldest[1])) : 0;
  // Refused and gone pages are the site's answer, not work the crawl owes.
  const owed = c.fetched + c.failed + pending;
  const coverage = owed === 0 ? 0 : Math.round((c.indexed / owed) * 1000) / 1000;
  return {job_id: jobId, ...c, pending, oldest_pending_age_s: age, stalled: pending > 0 && age > STALL_AFTER_S, coverage};
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"math"
	"net/http"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"

	"crawl/frontier" // frontier.PendingKey
	"crawl/records"  // records.Counts
	"crawl/registry" // registry.JobOf
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const reportTTL = 300 * time.Second

type cachedReport struct {
	at     time.Time
	report map[string]any
}

var (
	reportsMu sync.Mutex
	reports   = map[string]cachedReport{}
)

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func jobReport(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		http.Error(rw, "X-Tenant-Id is required", http.StatusUnauthorized)
		return
	}
	jobID := r.PathValue("id")
	job := registry.JobOf(r.Context(), jobID)
	if job == nil {
		http.Error(rw, "no such job", http.StatusNotFound)
		return
	}
	if job.Tenant != tenant {
		http.Error(rw, "the job belongs to another tenant", http.StatusForbidden)
		return
	}
	reportsMu.Lock()
	cached, ok := reports[jobID]
	reportsMu.Unlock()
	if ok && time.Since(cached.at) < reportTTL {
		writeJSON(rw, http.StatusOK, cached.report)
		return
	}
	counts := records.Counts(r.Context(), jobID)
	pending := rdb.ZCard(r.Context(), frontier.PendingKey(jobID)).Val()
	age := int64(0)
	if newest := rdb.ZRangeWithScores(r.Context(), frontier.PendingKey(jobID), -1, -1).Val(); len(newest) > 0 {
		age = int64(float64(time.Now().UnixMilli())/1000 - newest[0].Score)
	}
	coverage := 1.0
	if pending > 0 {
		coverage = float64(counts["indexed"]) / float64(counts["fetched"]+counts["refused"]+pending)
	}
	report := map[string]any{"job_id": jobID, "pending": pending, "oldest_pending_age_s": age, "coverage": math.Round(coverage*1000) / 1000}
	for name, n := range counts {
		report[name] = n
	}
	reportsMu.Lock()
	reports[jobID] = cachedReport{at: time.Now(), report: report}
	reportsMu.Unlock()
	writeJSON(rw, http.StatusOK, report)
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/crawl/jobs/{id}", jobReport)
}
`,
      solution: `package main

import (
	"encoding/json"
	"math"
	"net/http"
	"time"

	"github.com/redis/go-redis/v9"

	"crawl/frontier" // frontier.PendingKey
	"crawl/records"  // records.Counts
	"crawl/registry" // registry.JobOf
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const stallAfterS = 600

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func jobReport(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		http.Error(rw, "X-Tenant-Id is required", http.StatusUnauthorized)
		return
	}
	jobID := r.PathValue("id")
	job := registry.JobOf(r.Context(), jobID)
	// Another tenant's job answers exactly like a job that does not exist.
	if job == nil || job.Tenant != tenant {
		http.Error(rw, "no such job", http.StatusNotFound)
		return
	}
	counts := records.Counts(r.Context(), jobID)
	pending := rdb.ZCard(r.Context(), frontier.PendingKey(jobID)).Val()
	age := int64(0)
	if oldest := rdb.ZRangeWithScores(r.Context(), frontier.PendingKey(jobID), 0, 0).Val(); len(oldest) > 0 {
		age = int64(float64(time.Now().UnixMilli())/1000 - oldest[0].Score)
	}
	// Refused and gone pages are the site's answer, not work the crawl owes.
	coverage := 0.0
	if owed := counts["fetched"] + counts["failed"] + pending; owed > 0 {
		coverage = math.Round(float64(counts["indexed"])/float64(owed)*1000) / 1000
	}
	report := map[string]any{
		"job_id":               jobID,
		"pending":              pending,
		"oldest_pending_age_s": age,
		"stalled":              pending > 0 && age > stallAfterS,
		"coverage":             coverage,
	}
	for name, n := range counts {
		report[name] = n
	}
	writeJSON(rw, http.StatusOK, report)
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/crawl/jobs/{id}", jobReport)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import redis.clients.jedis.JedisPooled
import spray.json._

import scala.jdk.CollectionConverters._

import crawl.{Frontier, Records, Registry} // Registry.jobOf; Records.counts; Frontier.pendingKey

object Read {
  val jedis = new JedisPooled("redis", 6379)

  val ReportTtlMs = 300000L
  private val reports = scala.collection.concurrent.TrieMap.empty[String, (Long, JsObject)]

  private def ok(body: JsObject): HttpResponse = HttpResponse(StatusCodes.OK, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  private def build(jobId: String): JsObject = {
    val counts = Records.counts(jobId)
    val pending = jedis.zcard(Frontier.pendingKey(jobId))
    val newest = jedis.zrangeWithScores(Frontier.pendingKey(jobId), -1, -1).asScala.headOption.map(_.getScore)
    val age = newest.map(score => (System.currentTimeMillis / 1000.0 - score).toLong).getOrElse(0L)
    val coverage = if (pending == 0) 1.0 else counts("indexed").toDouble / (counts("fetched") + counts("refused") + pending)
    JsObject(counts.map { case (name, n) => name -> JsNumber(n) } ++ Map(
      "job_id" -> JsString(jobId),
      "pending" -> JsNumber(pending),
      "oldest_pending_age_s" -> JsNumber(age),
      "coverage" -> JsNumber(math.round(coverage * 1000) / 1000.0)))
  }

  val route: Route = path("v1" / "crawl" / "jobs" / Segment) { jobId =>
    get {
      // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
      optionalHeaderValueByName("X-Tenant-Id") {
        case None | Some("") => complete(StatusCodes.Unauthorized -> "X-Tenant-Id is required")
        case Some(tenant) =>
          Registry.jobOf(jobId) match {
            case None => complete(StatusCodes.NotFound -> "no such job")
            case Some(job) if job.tenant != tenant => complete(StatusCodes.Forbidden -> "the job belongs to another tenant")
            case Some(_) =>
              val now = System.currentTimeMillis
              val report = reports.get(jobId).filter { case (at, _) => now - at < ReportTtlMs }.map(_._2).getOrElse {
                val fresh = build(jobId)
                reports.put(jobId, (now, fresh))
                fresh
              }
              complete(ok(report))
          }
      }
    }
  }
}
`,
      solution: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import redis.clients.jedis.JedisPooled
import spray.json._

import scala.jdk.CollectionConverters._

import crawl.{Frontier, Records, Registry} // Registry.jobOf; Records.counts; Frontier.pendingKey

object Read {
  val jedis = new JedisPooled("redis", 6379)

  val StallAfterS = 600L

  private def ok(body: JsObject): HttpResponse = HttpResponse(StatusCodes.OK, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  private def build(jobId: String): JsObject = {
    val counts = Records.counts(jobId)
    val pending = jedis.zcard(Frontier.pendingKey(jobId))
    val oldest = jedis.zrangeWithScores(Frontier.pendingKey(jobId), 0, 0).asScala.headOption.map(_.getScore)
    val age = oldest.map(score => (System.currentTimeMillis / 1000.0 - score).toLong).getOrElse(0L)
    // Refused and gone pages are the site's answer, not work the crawl owes.
    val owed = counts("fetched") + counts("failed") + pending
    val coverage = if (owed == 0) 0.0 else math.round(counts("indexed").toDouble / owed * 1000) / 1000.0
    JsObject(counts.map { case (name, n) => name -> JsNumber(n) } ++ Map(
      "job_id" -> JsString(jobId),
      "pending" -> JsNumber(pending),
      "oldest_pending_age_s" -> JsNumber(age),
      "stalled" -> JsBoolean(pending > 0 && age > StallAfterS),
      "coverage" -> JsNumber(coverage)))
  }

  val route: Route = path("v1" / "crawl" / "jobs" / Segment) { jobId =>
    get {
      optionalHeaderValueByName("X-Tenant-Id") {
        case None | Some("") => complete(StatusCodes.Unauthorized -> "X-Tenant-Id is required")
        case Some(tenant) =>
          // Another tenant's job answers exactly like a job that does not exist.
          Registry.jobOf(jobId).filter(_.tenant == tenant) match {
            case None => complete(StatusCodes.NotFound -> "no such job")
            case Some(_) => complete(ok(build(jobId)))
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

#include <chrono>
#include <cmath>
#include <iterator>
#include <map>
#include <mutex>
#include <string>
#include <utility>
#include <vector>

#include "crawl/frontier.h"  // frontier::pendingKey
#include "crawl/records.h"   // records::counts
#include "crawl/registry.h"  // registry::jobOf

using json = nlohmann::json;

sw::redis::Redis redis("tcp://redis:6379");

constexpr std::chrono::seconds kReportTtl{300};
std::mutex reports_mu;
std::map<std::string, std::pair<std::chrono::system_clock::time_point, json>> reports;

double nowSeconds() {
  return std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count() / 1000.0;
}

void reply_json(httplib::Response& res, int status, const json& body) {
  res.status = status;
  res.set_content(body.dump(), "application/json");
}

void job_report(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) return reply_json(res, 401, {{"error", "X-Tenant-Id is required"}});
  const std::string job_id = req.matches[1];
  const auto job = registry::jobOf(job_id);
  if (!job) return reply_json(res, 404, {{"error", "no such job"}});
  if (job->tenant != tenant) return reply_json(res, 403, {{"error", "the job belongs to another tenant"}});
  const auto now = std::chrono::system_clock::now();
  {
    std::lock_guard<std::mutex> lock(reports_mu);
    const auto cached = reports.find(job_id);
    if (cached != reports.end() && now - cached->second.first < kReportTtl) return reply_json(res, 200, cached->second.second);
  }
  const auto counts = records::counts(job_id);
  const long long pending = redis.zcard(frontier::pendingKey(job_id));
  std::vector<std::pair<std::string, double>> newest;
  redis.zrange(frontier::pendingKey(job_id), -1, -1, std::back_inserter(newest));
  const long long age = newest.empty() ? 0 : static_cast<long long>(nowSeconds() - newest[0].second);
  const double coverage = pending == 0 ? 1.0 : static_cast<double>(counts.at("indexed")) / (counts.at("fetched") + counts.at("refused") + pending);
  json report = {{"job_id", job_id}, {"pending", pending}, {"oldest_pending_age_s", age}, {"coverage", std::round(coverage * 1000) / 1000}};
  for (const auto& [name, n] : counts) report[name] = n;
  {
    std::lock_guard<std::mutex> lock(reports_mu);
    reports[job_id] = {now, report};
  }
  reply_json(res, 200, report);
}

void register_routes(httplib::Server& svr) { svr.Get(R"(/v1/crawl/jobs/([\\w-]+))", job_report); }
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <chrono>
#include <cmath>
#include <iterator>
#include <string>
#include <utility>
#include <vector>

#include "crawl/frontier.h"  // frontier::pendingKey
#include "crawl/records.h"   // records::counts
#include "crawl/registry.h"  // registry::jobOf

using json = nlohmann::json;

sw::redis::Redis redis("tcp://redis:6379");

constexpr long long kStallAfterS = 600;

double nowSeconds() {
  return std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count() / 1000.0;
}

void reply_json(httplib::Response& res, int status, const json& body) {
  res.status = status;
  res.set_content(body.dump(), "application/json");
}

void job_report(const httplib::Request& req, httplib::Response& res) {
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) return reply_json(res, 401, {{"error", "X-Tenant-Id is required"}});
  const std::string job_id = req.matches[1];
  const auto job = registry::jobOf(job_id);
  // Another tenant's job answers exactly like a job that does not exist.
  if (!job || job->tenant != tenant) return reply_json(res, 404, {{"error", "no such job"}});
  const auto counts = records::counts(job_id);
  const long long pending = redis.zcard(frontier::pendingKey(job_id));
  std::vector<std::pair<std::string, double>> oldest;
  redis.zrange(frontier::pendingKey(job_id), 0, 0, std::back_inserter(oldest));
  const long long age = oldest.empty() ? 0 : static_cast<long long>(nowSeconds() - oldest[0].second);
  // Refused and gone pages are the site's answer, not work the crawl owes.
  const long long owed = counts.at("fetched") + counts.at("failed") + pending;
  const double coverage = owed == 0 ? 0.0 : std::round(static_cast<double>(counts.at("indexed")) / owed * 1000) / 1000;
  json report = {{"job_id", job_id},
                 {"pending", pending},
                 {"oldest_pending_age_s", age},
                 {"stalled", pending > 0 && age > kStallAfterS},
                 {"coverage", coverage}};
  for (const auto& [name, n] : counts) report[name] = n;
  reply_json(res, 200, report);
}

void register_routes(httplib::Server& svr) { svr.Get(R"(/v1/crawl/jobs/([\\w-]+))", job_report); }
`,
    },
  },
  harness: {
    python: `from crawl import frontier, records, registry

JOB = "nightly"
HOST = "blog.example.com"
ACME = {"X-Tenant-Id": "acme"}


def _url(n):
    return f"https://{HOST}/p/{n}"


def _world(ctx, *urls):
    registry.insert(JOB, _url(0), "acme")
    for url in urls:
        frontier.enqueue(JOB, HOST, url)
    return ctx.client(ctx.load("read").app)


async def _report(c, headers=ACME, job=JOB):
    return await c.get(f"/v1/crawl/jobs/{job}", headers=headers)


def _number(report, name):
    value = report.get(name)
    assert isinstance(value, (int, float)) and not isinstance(value, bool), f"the report's {name} is {value!r}, expected a number: {report}"
    return value


async def check_tenant_404(ctx):
    async with _world(ctx, _url(1)) as c:
        own = await _report(c)
        other = await _report(c, {"X-Tenant-Id": "globex"})
        unknown = await _report(c, job="weekly")
        anonymous = await _report(c, {})
    assert own.status_code == 200, f"the job's own tenant got {own.status_code}: {own.text}"
    assert unknown.status_code == 404, f"an unknown job answered {unknown.status_code}, expected 404"
    assert other.status_code == 404, f"another tenant's job answered {other.status_code} while an unknown job answers 404: the difference tells a probe which job ids exist"
    assert anonymous.status_code == 401, f"a request without X-Tenant-Id answered {anonymous.status_code}, expected 401"


async def check_live_counts(ctx):
    async with _world(ctx, _url(1), _url(2)) as c:
        first = (await _report(c)).json()
        assert first.get("pending") == 2 and first.get("fetched") == 0, f"a job with two queued URLs reports {first}"
        records.mark_fetched(JOB, _url(1), "sha256:1", "pages/1")
        records.mark_indexed(JOB, _url(1))
        ctx.clock.advance(10)
        second = (await _report(c)).json()
    assert second.get("fetched") == 1 and second.get("indexed") == 1 and second.get("pending") == 1, f"10 s after a page was fetched and indexed the report still says {second}: every request must read the live counts"


async def check_stalled(ctx):
    async with _world(ctx, _url(1)) as c:
        ctx.clock.advance(700)
        frontier.enqueue(JOB, HOST, _url(2))
        report = (await _report(c)).json()
        assert report.get("pending") == 2, f"two URLs are pending, the report says {report}"
        age = _number(report, "oldest_pending_age_s")
        assert 699 <= age <= 701, f"the oldest pending URL has waited 700 s, the report says {age}: age the oldest member of pending:{JOB}"
        assert report.get("stalled") is True, f"a URL waiting 700 s (STALL_AFTER_S = 600) must make the report say stalled: true, got {report.get('stalled')!r}"
        records.mark_fetched(JOB, _url(1), "sha256:1", "pages/1")
        ctx.clock.advance(1)
        fresh = (await _report(c)).json()
    assert fresh.get("stalled") is False and _number(fresh, "oldest_pending_age_s") <= 2, f"once the old URL is fetched the one left was queued a second ago: stalled false, got {fresh}"


async def check_coverage(ctx):
    urls = [_url(n) for n in range(1, 6)]
    async with _world(ctx, *urls) as c:
        records.mark_fetched(JOB, urls[0], "sha256:1", "pages/1")
        records.mark_indexed(JOB, urls[0])
        records.mark_refused(JOB, urls[1], "forbidden")
        records.mark_gone(JOB, urls[2])
        records.mark_fetched(JOB, urls[3], "sha256:4", "pages/4")
        cov = _number((await _report(c)).json(), "coverage")
        assert abs(cov - 1 / 3) < 0.01, f"1 indexed of 2 fetched + 0 failed + 1 pending is coverage 0.333, the report says {cov}: refused and gone pages are the site's answer, not work the crawl owes"
        records.mark_failed(JOB, urls[4], "UNAVAILABLE")
        ctx.clock.advance(1)
        drained = (await _report(c)).json()
    cov = _number(drained, "coverage")
    assert drained.get("pending") == 0 and abs(cov - 1 / 3) < 0.01, f"with the queue drained and one page failed coverage is 1 / (2 + 1) = 0.333, the report says {cov}: a drained queue is no reason to answer 1.0"
`,
    typescript: `const JOB = 'nightly';
const HOST = 'blog.example.com';
const ACME = {'X-Tenant-Id': 'acme'};
const url = (n: number): string => \`https://\${HOST}/p/\${n}\`;

async function world(ctx, ...urls: string[]) {
  const registry = ctx.load('/support/crawl/registry.ts');
  const frontier = ctx.load('/support/crawl/frontier.ts');
  const records = ctx.load('/support/crawl/records.ts');
  await registry.insert(JOB, url(0), 'acme');
  for (const u of urls) await frontier.enqueue(JOB, HOST, u);
  return {c: ctx.client(ctx.load('read').app), frontier, records};
}

const report = (c, headers: Record<string, string> = ACME, job = JOB) => c.get(\`/v1/crawl/jobs/\${job}\`, {headers});

function numberOf(r, name: string): number {
  assert(typeof r[name] === 'number', \`the report's \${name} is \${JSON.stringify(r[name])}, expected a number: \${JSON.stringify(r)}\`);
  return r[name];
}

export async function check_tenant_404(ctx) {
  const {c} = await world(ctx, url(1));
  const own = await report(c);
  const other = await report(c, {'X-Tenant-Id': 'globex'});
  const unknown = await report(c, ACME, 'weekly');
  const anonymous = await report(c, {});
  assert.equal(own.status, 200, \`the job's own tenant got \${own.status}: \${own.text}\`);
  assert.equal(unknown.status, 404, \`an unknown job answered \${unknown.status}, expected 404\`);
  assert.equal(other.status, 404, \`another tenant's job answered \${other.status} while an unknown job answers 404: the difference tells a probe which job ids exist\`);
  assert.equal(anonymous.status, 401, \`a request without X-Tenant-Id answered \${anonymous.status}, expected 401\`);
}

export async function check_live_counts(ctx) {
  const {c, records} = await world(ctx, url(1), url(2));
  const first = (await report(c)).json();
  assert(first.pending === 2 && first.fetched === 0, \`a job with two queued URLs reports \${JSON.stringify(first)}\`);
  await records.markFetched(JOB, url(1), 'sha256:1', 'pages/1');
  await records.markIndexed(JOB, url(1));
  ctx.clock.advance(10);
  const second = (await report(c)).json();
  assert(second.fetched === 1 && second.indexed === 1 && second.pending === 1, \`10 s after a page was fetched and indexed the report still says \${JSON.stringify(second)}: every request must read the live counts\`);
}

export async function check_stalled(ctx) {
  const {c, frontier, records} = await world(ctx, url(1));
  ctx.clock.advance(700);
  await frontier.enqueue(JOB, HOST, url(2));
  const r = (await report(c)).json();
  assert.equal(r.pending, 2, \`two URLs are pending, the report says \${JSON.stringify(r)}\`);
  const age = numberOf(r, 'oldest_pending_age_s');
  assert(699 <= age && age <= 701, \`the oldest pending URL has waited 700 s, the report says \${age}: age the oldest member of pending:\${JOB}\`);
  assert.equal(r.stalled, true, \`a URL waiting 700 s (STALL_AFTER_S = 600) must make the report say stalled: true, got \${JSON.stringify(r.stalled)}\`);
  await records.markFetched(JOB, url(1), 'sha256:1', 'pages/1');
  ctx.clock.advance(1);
  const fresh = (await report(c)).json();
  assert(fresh.stalled === false && numberOf(fresh, 'oldest_pending_age_s') <= 2, \`once the old URL is fetched the one left was queued a second ago: stalled false, got \${JSON.stringify(fresh)}\`);
}

export async function check_coverage(ctx) {
  const urls = [1, 2, 3, 4, 5].map(url);
  const {c, records} = await world(ctx, ...urls);
  await records.markFetched(JOB, urls[0], 'sha256:1', 'pages/1');
  await records.markIndexed(JOB, urls[0]);
  await records.markRefused(JOB, urls[1], 'forbidden');
  await records.markGone(JOB, urls[2]);
  await records.markFetched(JOB, urls[3], 'sha256:4', 'pages/4');
  let cov = numberOf((await report(c)).json(), 'coverage');
  assert(Math.abs(cov - 1 / 3) < 0.01, \`1 indexed of 2 fetched + 0 failed + 1 pending is coverage 0.333, the report says \${cov}: refused and gone pages are the site's answer, not work the crawl owes\`);
  await records.markFailed(JOB, urls[4], 'UNAVAILABLE');
  ctx.clock.advance(1);
  const drained = (await report(c)).json();
  cov = numberOf(drained, 'coverage');
  assert(drained.pending === 0 && Math.abs(cov - 1 / 3) < 0.01, \`with the queue drained and one page failed coverage is 1 / (2 + 1) = 0.333, the report says \${cov}: a drained queue is no reason to answer 1.0\`);
}
`,
    go: `package main

import (
	"context"
	"fmt"
	"math"
	"net/http"

	"crawl/frontier"
	"crawl/records"
	"crawl/registry"

	"leetbuild/harness"
)

const (
	readJob  = "nightly"
	readHost = "blog.example.com"
)

var readBg = context.Background()

func readURL(n int) string { return fmt.Sprintf("https://%s/p/%d", readHost, n) }

func readWorld(ctx *harness.Ctx, urls ...string) *harness.HTTP {
	registry.Insert(readBg, readJob, readURL(0), "acme")
	for _, u := range urls {
		ctx.NoError(frontier.Enqueue(readBg, readJob, readHost, u), "enqueue %s", u)
	}
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

func reportOf(ctx *harness.Ctx, c *harness.HTTP) map[string]any {
	r := c.Get("/v1/crawl/jobs/"+readJob, "X-Tenant-Id", "acme")
	ctx.Equal(r.Status, 200, "GET /v1/crawl/jobs/%s (%s)", readJob, r.Text())
	m, _ := r.JSON().(map[string]any)
	ctx.Assert(m != nil, "the report is not a JSON object: %s", r.Text())
	return m
}

func numberIn(ctx *harness.Ctx, report map[string]any, name string) float64 {
	n, ok := report[name].(float64)
	ctx.Assert(ok, "the report's %s is %v, expected a number: %v", name, report[name], report)
	return n
}

func CheckTenant404(ctx *harness.Ctx) {
	c := readWorld(ctx, readURL(1))
	own := c.Get("/v1/crawl/jobs/"+readJob, "X-Tenant-Id", "acme")
	other := c.Get("/v1/crawl/jobs/"+readJob, "X-Tenant-Id", "globex")
	unknown := c.Get("/v1/crawl/jobs/weekly", "X-Tenant-Id", "acme")
	anonymous := c.Get("/v1/crawl/jobs/" + readJob)
	ctx.Equal(own.Status, 200, "the job's own tenant (%s)", own.Text())
	ctx.Equal(unknown.Status, 404, "an unknown job")
	ctx.Equal(other.Status, 404, "another tenant's job must answer like an unknown job, or the difference tells a probe which job ids exist; the status")
	ctx.Equal(anonymous.Status, 401, "a request without X-Tenant-Id")
}

func CheckLiveCounts(ctx *harness.Ctx) {
	c := readWorld(ctx, readURL(1), readURL(2))
	first := reportOf(ctx, c)
	ctx.Assert(first["pending"] == float64(2) && first["fetched"] == float64(0), "a job with two queued URLs reports %v", first)
	records.MarkFetched(readBg, readJob, readURL(1), "sha256:1", "pages/1")
	records.MarkIndexed(readBg, readJob, readURL(1))
	ctx.Clock.Advance(10)
	second := reportOf(ctx, c)
	ctx.Assert(second["fetched"] == float64(1) && second["indexed"] == float64(1) && second["pending"] == float64(1), "10 s after a page was fetched and indexed the report still says %v: every request must read the live counts", second)
}

func CheckStalled(ctx *harness.Ctx) {
	c := readWorld(ctx, readURL(1))
	ctx.Clock.Advance(700)
	ctx.NoError(frontier.Enqueue(readBg, readJob, readHost, readURL(2)), "enqueue")
	report := reportOf(ctx, c)
	ctx.Equal(report["pending"], 2, "two URLs are pending; the report's pending")
	age := numberIn(ctx, report, "oldest_pending_age_s")
	ctx.Assert(699 <= age && age <= 701, "the oldest pending URL has waited 700 s, the report says %v: age the oldest member of pending:%s", age, readJob)
	ctx.Equal(report["stalled"], true, "a URL waiting 700 s (STALL_AFTER_S = 600) must make the report say stalled; stalled")
	records.MarkFetched(readBg, readJob, readURL(1), "sha256:1", "pages/1")
	ctx.Clock.Advance(1)
	fresh := reportOf(ctx, c)
	ctx.Assert(fresh["stalled"] == false && numberIn(ctx, fresh, "oldest_pending_age_s") <= 2, "once the old URL is fetched the one left was queued a second ago: stalled false, got %v", fresh)
}

func CheckCoverage(ctx *harness.Ctx) {
	urls := []string{readURL(1), readURL(2), readURL(3), readURL(4), readURL(5)}
	c := readWorld(ctx, urls...)
	records.MarkFetched(readBg, readJob, urls[0], "sha256:1", "pages/1")
	records.MarkIndexed(readBg, readJob, urls[0])
	records.MarkRefused(readBg, readJob, urls[1], "forbidden")
	records.MarkGone(readBg, readJob, urls[2])
	records.MarkFetched(readBg, readJob, urls[3], "sha256:4", "pages/4")
	cov := numberIn(ctx, reportOf(ctx, c), "coverage")
	ctx.Assert(math.Abs(cov-1.0/3) < 0.01, "1 indexed of 2 fetched + 0 failed + 1 pending is coverage 0.333, the report says %v: refused and gone pages are the site's answer, not work the crawl owes", cov)
	records.MarkFailed(readBg, readJob, urls[4], "UNAVAILABLE")
	ctx.Clock.Advance(1)
	drained := reportOf(ctx, c)
	cov = numberIn(ctx, drained, "coverage")
	ctx.Assert(drained["pending"] == float64(0) && math.Abs(cov-1.0/3) < 0.01, "with the queue drained and one page failed coverage is 1 / (2 + 1) = 0.333, the report says %v: a drained queue is no reason to answer 1.0", cov)
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <cmath>
#include <string>
#include <vector>

using json = nlohmann::json;

namespace {

const std::string kJob = "nightly";
const std::string kHost = "blog.example.com";

std::string readUrl(int n) { return "https://" + kHost + "/p/" + std::to_string(n); }

harness::HTTP readWorld(harness::Ctx& ctx, const std::vector<std::string>& urls) {
  registry::insert(kJob, readUrl(0), "acme");
  for (const std::string& u : urls) frontier::enqueue(kJob, kHost, u);
  static httplib::Server* svr = nullptr;
  delete svr;
  svr = new httplib::Server;
  register_routes(*svr);
  return ctx.HTTP(*svr);
}

json reportOf(harness::Ctx& ctx, harness::HTTP& c) {
  const auto r = c.Get("/v1/crawl/jobs/" + kJob, "X-Tenant-Id", "acme");
  ctx.Equal(r.Status, 200, "GET /v1/crawl/jobs/%s (%s)", kJob, r.Text());
  try {
    return json::parse(r.Text());
  } catch (const std::exception&) {
    ctx.Fatalf("the report is not JSON: %s", r.Text());
  }
}

double numberIn(harness::Ctx& ctx, const json& report, const std::string& name) {
  ctx.Assert(report.contains(name) && report[name].is_number(), "the report's %s is not a number: %s", name, report.dump());
  return report[name].get<double>();
}

}  // namespace

void CheckTenant404(harness::Ctx& ctx) {
  auto c = readWorld(ctx, {readUrl(1)});
  const auto own = c.Get("/v1/crawl/jobs/" + kJob, "X-Tenant-Id", "acme");
  const auto other = c.Get("/v1/crawl/jobs/" + kJob, "X-Tenant-Id", "globex");
  const auto unknown = c.Get("/v1/crawl/jobs/weekly", "X-Tenant-Id", "acme");
  const auto anonymous = c.Get("/v1/crawl/jobs/" + kJob);
  ctx.Equal(own.Status, 200, "the job's own tenant (%s)", own.Text());
  ctx.Equal(unknown.Status, 404, "an unknown job");
  ctx.Equal(other.Status, 404, "another tenant's job must answer like an unknown job, or the difference tells a probe which job ids exist; the status");
  ctx.Equal(anonymous.Status, 401, "a request without X-Tenant-Id");
}

void CheckLiveCounts(harness::Ctx& ctx) {
  auto c = readWorld(ctx, {readUrl(1), readUrl(2)});
  const json first = reportOf(ctx, c);
  ctx.Assert(first.value("pending", -1) == 2 && first.value("fetched", -1) == 0, "a job with two queued URLs reports %s", first.dump());
  records::markFetched(kJob, readUrl(1), "sha256:1", "pages/1");
  records::markIndexed(kJob, readUrl(1));
  ctx.Clock.Advance(10);
  const json second = reportOf(ctx, c);
  ctx.Assert(second.value("fetched", -1) == 1 && second.value("indexed", -1) == 1 && second.value("pending", -1) == 1,
             "10 s after a page was fetched and indexed the report still says %s: every request must read the live counts", second.dump());
}

void CheckStalled(harness::Ctx& ctx) {
  auto c = readWorld(ctx, {readUrl(1)});
  ctx.Clock.Advance(700);
  frontier::enqueue(kJob, kHost, readUrl(2));
  const json report = reportOf(ctx, c);
  ctx.Equal(report.value("pending", -1), 2, "two URLs are pending; the report's pending");
  const double age = numberIn(ctx, report, "oldest_pending_age_s");
  ctx.Assert(699 <= age && age <= 701, "the oldest pending URL has waited 700 s, the report says %v: age the oldest member of pending:%s", age, kJob);
  ctx.Assert(report.contains("stalled") && report["stalled"] == true, "a URL waiting 700 s (kStallAfterS = 600) must make the report say stalled: true, got %s", report.dump());
  records::markFetched(kJob, readUrl(1), "sha256:1", "pages/1");
  ctx.Clock.Advance(1);
  const json fresh = reportOf(ctx, c);
  ctx.Assert(fresh.contains("stalled") && fresh["stalled"] == false && numberIn(ctx, fresh, "oldest_pending_age_s") <= 2,
             "once the old URL is fetched the one left was queued a second ago: stalled false, got %s", fresh.dump());
}

void CheckCoverage(harness::Ctx& ctx) {
  const std::vector<std::string> urls = {readUrl(1), readUrl(2), readUrl(3), readUrl(4), readUrl(5)};
  auto c = readWorld(ctx, urls);
  records::markFetched(kJob, urls[0], "sha256:1", "pages/1");
  records::markIndexed(kJob, urls[0]);
  records::markRefused(kJob, urls[1], "forbidden");
  records::markGone(kJob, urls[2]);
  records::markFetched(kJob, urls[3], "sha256:4", "pages/4");
  double cov = numberIn(ctx, reportOf(ctx, c), "coverage");
  ctx.Assert(std::abs(cov - 1.0 / 3) < 0.01, "1 indexed of 2 fetched + 0 failed + 1 pending is coverage 0.333, the report says %v: refused and gone pages are the site's answer, not work the crawl owes", cov);
  records::markFailed(kJob, urls[4], "UNAVAILABLE");
  ctx.Clock.Advance(1);
  const json drained = reportOf(ctx, c);
  cov = numberIn(ctx, drained, "coverage");
  ctx.Assert(drained.value("pending", -1) == 0 && std::abs(cov - 1.0 / 3) < 0.01, "with the queue drained and one page failed coverage is 1 / (2 + 1) = 0.333, the report says %v: a drained queue is no reason to answer 1.0", cov);
}
`,
  },
  hints: [
    "Ask for another tenant's job and you get 403 where an unknown id gets 404. A fetched page leaves the report unchanged for minutes, an hour-old URL shows seconds of age, and a drained queue shows coverage 1.0.",
    'A tenant mismatch answers 403; `_reports` serves a report for `REPORT_TTL_S`; the age comes from `ZRANGE … -1 -1`, the newest member; coverage divides by fetched + refused + pending, or is 1.0 when nothing is pending.',
    "Answer 404 for a missing job and for another tenant's. Drop `_reports`. Read the oldest with `ZRANGE pending:{job_id} 0 0 WITHSCORES`, add `stalled`, and compute `indexed / (fetched + failed + pending)`.",
  ],
  debrief: `A report is only as useful as the moment it describes, so every field is read from live state on each request: a few Redis reads cost less than the incident a stale number hides. The oldest pending URL is the crawl's pulse. A queue whose newest member is fresh can still hold a URL nobody has taken in an hour, and \`stalled\` turns that into a flag an alert can watch. Coverage leaves refused and gone pages out because they are the site's answer, not work the crawl owes, and the 404 for another tenant's job keeps the id space private. Production systems also export these numbers as metrics with per-host breakdowns and page on the stall flag rather than on raw counts.`,
};
