import type {Step} from '@/lib/types';

export const readStep: Step = {
  id: 'read',
  title: 'GET /v1/synthetic/jobs/{id}: a report a reviewer can trace',
  concept: 'http',
  file: 'read',
  focus: ['client', 'api', 'redis'],
  task: `## Task

**Starting point.** The starter serves \`GET /v1/synthetic/jobs/{job_id}\`: 401 without \`X-Tenant-Id\`,
404 when the provided job store has no such job, then the job's fields with \`generated\`, \`rejected\` and
\`throttled\` from \`synth:progress:{job}\`, \`admitted\` computed as \`generated - rejected\`, \`entities\` as
the number of fields in \`synth:coverage:{job}\`, and a \`provenance\` object with the seed's license from
\`seeds.lookup\`. The dashboard shows a healthy job. It hides 4 flaws.

**Failure mode the checks target.** The report is what a reviewer signs off on. Derived from the other
counts, \`admitted\` silently includes every record the judge never scored. An entity count says
nothing about a corpus where one entity holds 90 percent of the records. A license is not provenance:
nobody can trace a single record to its seed. And any tenant can read any job.

- A job owned by another tenant is **404**, the same as a missing one.
- \`generated\`, \`admitted\`, \`parked\`, \`rejected\` and \`throttled\` come from the progress hash as
  stored; nothing is derived.
- \`coverage\` is the per-entity map from \`synth:coverage:{job}\`.
- \`records\` maps every admitted record id to its stored seed digest from \`synth:records:{job}\`.
- The report is **200** with the job's fields, the counts, \`coverage\`, \`records\` and \`updated_at\`.`,
  sequence: {
    participants: ['Data curator', 'synthd API', 'Redis'],
    messages: [
      {from: 'Data curator', to: 'synthd API', label: 'GET /v1/synthetic/jobs/{id} · X-Tenant-Id', kind: 'sync'},
      {from: 'synthd API', to: 'Redis', label: 'GET synth:job:{id} · tenant matches', kind: 'sync'},
      {from: 'synthd API', to: 'Redis', label: 'HGETALL progress · coverage · records', kind: 'sync'},
      {
        from: 'Redis',
        to: 'synthd API',
        label: '{admitted 6, parked 3, …} · {e-paris 4, e-lima 2} · {r-1: digest, …}',
        kind: 'reply',
      },
      {from: 'synthd API', to: 'Data curator', label: '200 {counts, coverage, records, updated_at}', kind: 'reply'},
    ],
  },
  hints: [
    'Symptom: a job whose judge timed out on a third of its records reports them as admitted, a corpus dominated by one entity looks like any other, a reviewer cannot trace a record, and another tenant can read the report.',
    'Mechanism: `admitted = generated - rejected` counts parked records as admitted; `HLEN` reduces coverage to one number; `provenance` comes from the registry, not from the stored digests; the 404 tests only that the job exists.',
    "Change: 404 when `job['tenant'] != tenant`; report `admitted` and `parked` as stored; `coverage` from HGETALL of the coverage hash; `records` from HGETALL of `records_key(job_id)`; drop `entities` and the registry lookup.",
  ],
  checks: [
    {
      id: 'route',
      title: 'Handles GET /v1/synthetic/jobs/{id}',
      detail:
        'The report route answers 401 without X-Tenant-Id, 404 for an unknown job, and 200 with the job and its counts.',
      match: {
        python: {all: [/@app\.get\(\s*["']\/v1\/synthetic\/jobs\/\{job_id\}["']/]},
        typescript: {all: [/app\.get\(\s*['"]\/v1\/synthetic\/jobs\/:job_id['"]/]},
        go: {all: [/HandleFunc\(\s*"GET \/v1\/synthetic\/jobs\/\{jobID\}"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"synthetic"\s*\/\s*"jobs"\s*\/\s*Segment\s*\)/, /\bget\s*\{/]},
        cpp: {all: [/svr\.Get\([^,\n]*v1\/synthetic\/jobs\//]},
      },
    },
    {
      id: 'tenant-scope',
      title: "Answers 404 for another tenant's job",
      detail:
        'A job stored for tenant t1 is 404 for tenant t2, with nothing of the job in the body. The starter checks only that the job exists.',
      match: {
        python: {all: [/\[["']tenant["']\]|get\(\s*["']tenant["']\s*\)/]},
        typescript: {all: [/\.tenant\s*!==?\s*tenant/]},
        go: {all: [/\.Tenant\s*!=\s*tenant/]},
        scala: {all: [/\.tenant\s*[!=]=\s*tenant/]},
        cpp: {all: [/\["tenant"\]|value\(\s*"tenant"/]},
      },
    },
    {
      id: 'parked-apart',
      title: 'Reports parked records apart from admitted ones',
      detail:
        'admitted, parked and rejected are the stored counters, so 10 generated with 6 admitted, 3 parked and 1 rejected reads that way. The starter computes admitted as generated - rejected and reports no parked count.',
      match: {
        python: {all: [/["']parked["']/], none: [/generated\s*-\s*rejected/]},
        typescript: {all: [/\bparked\b/], none: [/generated\s*-\s*rejected/]},
        go: {all: [/"parked"/], none: [/generated\s*-\s*rejected/]},
        scala: {all: [/"parked"/], none: [/generated\s*-\s*rejected/]},
        cpp: {all: [/"parked"/], none: [/generated\s*-\s*rejected/]},
      },
    },
    {
      id: 'coverage',
      title: 'Reports per-entity coverage',
      detail:
        'coverage is the synth:coverage:{job} hash as numbers, read on every request. The starter reports how many entities there are, which hides a corpus dominated by one of them.',
      match: {
        python: {all: [/["']coverage["']/], none: [/\.hlen\(/]},
        typescript: {all: [/\bcoverage:/], none: [/\.hlen\(/]},
        go: {all: [/"coverage"/], none: [/\.HLen\(/]},
        scala: {all: [/"coverage"/], none: [/\.hlen\(/]},
        cpp: {all: [/"coverage"/], none: [/\.hlen\(/]},
      },
    },
    {
      id: 'provenance',
      title: 'Traces every admitted record to its seed digest',
      detail:
        "records maps each admitted record id to the seed digest stored when it was admitted (synth:records:{job}). The starter reports the seed's license from the registry, which traces no record.",
      match: {
        python: {all: [/records_key\(/], none: [/seeds\.lookup\(/]},
        typescript: {all: [/recordsKey\(/], none: [/\blookup\(/]},
        go: {all: [/RecordsKey\(/], none: [/seeds\.Lookup\(/]},
        scala: {all: [/recordsKey\(/], none: [/Seeds\.lookup\(/]},
        cpp: {all: [/records_key\(/], none: [/seeds::lookup\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import redis
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse

from synth import seeds
from synth.config import coverage_key, progress_key
from synth.jobs import store

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)


@app.get("/v1/synthetic/jobs/{job_id}")
def read_job(job_id: str, request: Request) -> JSONResponse:
    # TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
    tenant = request.headers.get("X-Tenant-Id", "")
    if tenant == "":
        raise HTTPException(status_code=401, detail="missing X-Tenant-Id")
    job = store.by_id(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="unknown job")
    progress = r.hgetall(progress_key(job_id))
    counts = {key: int(value) for key, value in progress.items()}
    generated = counts.get("generated", 0)
    rejected = counts.get("rejected", 0)
    seed = seeds.lookup(job["seed_dataset"], job["seed_version"])
    return JSONResponse(
        {
            "job_id": job_id,
            "status": job["status"],
            "seed_dataset": job["seed_dataset"],
            "seed_version": job["seed_version"],
            "recipe": job["recipe"],
            "max_records": job["max_records"],
            "generated": generated,
            "admitted": generated - rejected,
            "rejected": rejected,
            "throttled": counts.get("throttled", 0),
            "entities": r.hlen(coverage_key(job_id)),
            "provenance": {"license": seed["license"] if seed else None},
            "updated_at": counts.get("updated_at", 0),
        },
        status_code=200,
    )
`,
      solution: `import redis
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse

from synth.config import coverage_key, progress_key, records_key
from synth.jobs import store

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)


@app.get("/v1/synthetic/jobs/{job_id}")
def read_job(job_id: str, request: Request) -> JSONResponse:
    tenant = request.headers.get("X-Tenant-Id", "")
    if tenant == "":
        raise HTTPException(status_code=401, detail="missing X-Tenant-Id")
    job = store.by_id(job_id)
    if job is None or job["tenant"] != tenant:
        raise HTTPException(status_code=404, detail="unknown job")

    pipe = r.pipeline()
    pipe.hgetall(progress_key(job_id))
    pipe.hgetall(coverage_key(job_id))
    pipe.hgetall(records_key(job_id))
    progress, coverage, records = pipe.execute()
    counts = {key: int(value) for key, value in progress.items()}
    return JSONResponse(
        {
            "job_id": job_id,
            "status": job["status"],
            "seed_dataset": job["seed_dataset"],
            "seed_version": job["seed_version"],
            "recipe": job["recipe"],
            "max_records": job["max_records"],
            "generated": counts.get("generated", 0),
            "admitted": counts.get("admitted", 0),
            "parked": counts.get("parked", 0),
            "rejected": counts.get("rejected", 0),
            "throttled": counts.get("throttled", 0),
            "coverage": {entity: int(n) for entity, n in coverage.items()},
            "records": records,
            "updated_at": counts.get("updated_at", 0),
        },
        status_code=200,
    )
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';
import Redis from 'ioredis';

import {coverageKey, progressKey} from 'synth/config';
import {store} from 'synth/jobs';
import {lookup} from 'synth/seeds';

export const app = Fastify();
const redis = new Redis({host: 'redis', port: 6379});

app.get('/v1/synthetic/jobs/:job_id', async (request, reply) => {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing X-Tenant-Id'});
  const {job_id: jobId} = request.params as {job_id: string};
  const job = await store.byId(jobId);
  if (job === null) return reply.code(404).send({error: 'unknown job'});
  const counts = Object.fromEntries(Object.entries(await redis.hgetall(progressKey(jobId))).map(([k, v]) => [k, Number(v)]));
  const generated = counts.generated ?? 0;
  const rejected = counts.rejected ?? 0;
  const seed = lookup(job.seed_dataset, job.seed_version);
  return reply.code(200).send({
    job_id: jobId,
    status: job.status,
    seed_dataset: job.seed_dataset,
    seed_version: job.seed_version,
    recipe: job.recipe,
    max_records: job.max_records,
    generated,
    admitted: generated - rejected,
    rejected,
    throttled: counts.throttled ?? 0,
    entities: await redis.hlen(coverageKey(jobId)),
    provenance: {license: seed?.license ?? null},
    updated_at: counts.updated_at ?? 0,
  });
});
`,
      solution: `import Fastify from 'fastify';
import Redis from 'ioredis';

import {coverageKey, progressKey, recordsKey} from 'synth/config';
import {store} from 'synth/jobs';

export const app = Fastify();
const redis = new Redis({host: 'redis', port: 6379});

const numbers = (hash: Record<string, string>): Record<string, number> =>
  Object.fromEntries(Object.entries(hash).map(([k, v]) => [k, Number(v)]));

app.get('/v1/synthetic/jobs/:job_id', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing X-Tenant-Id'});
  const {job_id: jobId} = request.params as {job_id: string};
  const job = await store.byId(jobId);
  if (job === null || job.tenant !== tenant) return reply.code(404).send({error: 'unknown job'});

  const counts = numbers(await redis.hgetall(progressKey(jobId)));
  const coverage = numbers(await redis.hgetall(coverageKey(jobId)));
  const records = await redis.hgetall(recordsKey(jobId));
  return reply.code(200).send({
    job_id: jobId,
    status: job.status,
    seed_dataset: job.seed_dataset,
    seed_version: job.seed_version,
    recipe: job.recipe,
    max_records: job.max_records,
    generated: counts.generated ?? 0,
    admitted: counts.admitted ?? 0,
    parked: counts.parked ?? 0,
    rejected: counts.rejected ?? 0,
    throttled: counts.throttled ?? 0,
    coverage: coverage,
    records,
    updated_at: counts.updated_at ?? 0,
  });
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"log"
	"net/http"
	"strconv"

	"github.com/redis/go-redis/v9"

	"synth/config" // config.ProgressKey, config.CoverageKey — provided
	"synth/jobs"   // jobs.ByID(ctx, jobID) — provided
	"synth/seeds"  // seeds.Lookup(dataset, version) — provided
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func readJob(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-Tenant-Id"})
		return
	}
	jobID := r.PathValue("jobID")
	job, err := jobs.ByID(r.Context(), jobID)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	if job == nil {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "unknown job"})
		return
	}
	hash, err := rdb.HGetAll(r.Context(), config.ProgressKey(jobID)).Result()
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	counts := map[string]int64{}
	for k, v := range hash {
		counts[k], _ = strconv.ParseInt(v, 10, 64)
	}
	generated, rejected := counts["generated"], counts["rejected"]
	entities, _ := rdb.HLen(r.Context(), config.CoverageKey(jobID)).Result()
	license := ""
	if seed, ok := seeds.Lookup(job.SeedDataset, job.SeedVersion); ok {
		license = seed.License
	}
	writeJSON(rw, http.StatusOK, map[string]any{
		"job_id":       jobID,
		"status":       job.Status,
		"seed_dataset": job.SeedDataset,
		"seed_version": job.SeedVersion,
		"recipe":       job.Recipe,
		"max_records":  job.MaxRecords,
		"generated":    generated,
		"admitted":     generated - rejected,
		"rejected":     rejected,
		"throttled":    counts["throttled"],
		"entities":     entities,
		"provenance":   map[string]string{"license": license},
		"updated_at":   counts["updated_at"],
	})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/synthetic/jobs/{jobID}", readJob)
}

func main() {
	mux := http.NewServeMux()
	register(mux)
	log.Fatal(http.ListenAndServe(":8443", mux))
}
`,
      solution: `package main

import (
	"encoding/json"
	"log"
	"net/http"
	"strconv"

	"github.com/redis/go-redis/v9"

	"synth/config" // config.ProgressKey, config.CoverageKey, config.RecordsKey — provided
	"synth/jobs"   // jobs.ByID(ctx, jobID) — provided
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func numbers(hash map[string]string) map[string]int64 {
	out := make(map[string]int64, len(hash))
	for k, v := range hash {
		n, _ := strconv.ParseInt(v, 10, 64)
		out[k] = n
	}
	return out
}

func readJob(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-Tenant-Id"})
		return
	}
	jobID := r.PathValue("jobID")
	job, err := jobs.ByID(r.Context(), jobID)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	if job == nil || job.Tenant != tenant {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "unknown job"})
		return
	}
	pipe := rdb.Pipeline()
	progressCmd := pipe.HGetAll(r.Context(), config.ProgressKey(jobID))
	coverageCmd := pipe.HGetAll(r.Context(), config.CoverageKey(jobID))
	recordsCmd := pipe.HGetAll(r.Context(), config.RecordsKey(jobID))
	if _, err := pipe.Exec(r.Context()); err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	counts := numbers(progressCmd.Val())
	writeJSON(rw, http.StatusOK, map[string]any{
		"job_id":       jobID,
		"status":       job.Status,
		"seed_dataset": job.SeedDataset,
		"seed_version": job.SeedVersion,
		"recipe":       job.Recipe,
		"max_records":  job.MaxRecords,
		"generated":    counts["generated"],
		"admitted":     counts["admitted"],
		"parked":       counts["parked"],
		"rejected":     counts["rejected"],
		"throttled":    counts["throttled"],
		"coverage":     numbers(coverageCmd.Val()),
		"records":      recordsCmd.Val(),
		"updated_at":   counts["updated_at"],
	})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/synthetic/jobs/{jobID}", readJob)
}

func main() {
	mux := http.NewServeMux()
	register(mux)
	log.Fatal(http.ListenAndServe(":8443", mux))
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

import synth.{Config, Jobs, Seeds}

object SynthReport {
  implicit val system: ActorSystem = ActorSystem("synthetic-report")
  val jedis = new JedisPooled("redis", 6379)

  val route: Route =
    path("v1" / "synthetic" / "jobs" / Segment) { jobId =>
      get {
        optionalHeaderValueByName("X-Tenant-Id") { tenantOpt =>
          // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
          if (!tenantOpt.exists(_.nonEmpty)) {
            complete(StatusCodes.Unauthorized, """{"error":"missing X-Tenant-Id"}""")
          } else {
            Jobs.byId(jobId) match {
              case None => complete(StatusCodes.NotFound, """{"error":"unknown job"}""")
              case Some(row) =>
                val counts = jedis.hgetAll(Config.progressKey(jobId)).asScala.toMap.map { case (k, v) => k -> v.toLong }
                val generated = counts.getOrElse("generated", 0L)
                val rejected = counts.getOrElse("rejected", 0L)
                val license = Seeds.lookup(row.job.seed_dataset, row.job.seed_version).map(_.license).getOrElse("")
                val report = ujson.Obj(
                  "job_id" -> jobId,
                  "status" -> row.job.status,
                  "seed_dataset" -> row.job.seed_dataset,
                  "seed_version" -> row.job.seed_version,
                  "recipe" -> row.job.recipe,
                  "max_records" -> row.job.max_records,
                  "generated" -> ujson.Num(generated.toDouble),
                  "admitted" -> ujson.Num((generated - rejected).toDouble),
                  "rejected" -> ujson.Num(rejected.toDouble),
                  "throttled" -> ujson.Num(counts.getOrElse("throttled", 0L).toDouble),
                  "entities" -> ujson.Num(jedis.hlen(Config.coverageKey(jobId)).toDouble),
                  "provenance" -> ujson.Obj("license" -> license),
                  "updated_at" -> ujson.Num(counts.getOrElse("updated_at", 0L).toDouble)
                )
                complete(HttpEntity(ContentTypes.\`application/json\`, ujson.write(report)))
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
      solution: `import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

import synth.{Config, Jobs}

object SynthReport {
  implicit val system: ActorSystem = ActorSystem("synthetic-report")
  val jedis = new JedisPooled("redis", 6379)

  private def numbers(key: String): Map[String, Long] =
    jedis.hgetAll(key).asScala.toMap.map { case (k, v) => k -> v.toLong }

  val route: Route =
    path("v1" / "synthetic" / "jobs" / Segment) { jobId =>
      get {
        optionalHeaderValueByName("X-Tenant-Id") { tenantOpt =>
          if (!tenantOpt.exists(_.nonEmpty)) {
            complete(StatusCodes.Unauthorized, """{"error":"missing X-Tenant-Id"}""")
          } else {
            Jobs.byId(jobId).filter(_.tenant == tenantOpt.get) match {
              case None => complete(StatusCodes.NotFound, """{"error":"unknown job"}""")
              case Some(row) =>
                val counts = numbers(Config.progressKey(jobId))
                val coverage = numbers(Config.coverageKey(jobId))
                val records = jedis.hgetAll(Config.recordsKey(jobId)).asScala.toMap
                def count(field: String): ujson.Value = ujson.Num(counts.getOrElse(field, 0L).toDouble)
                val report = ujson.Obj(
                  "job_id" -> jobId,
                  "status" -> row.job.status,
                  "seed_dataset" -> row.job.seed_dataset,
                  "seed_version" -> row.job.seed_version,
                  "recipe" -> row.job.recipe,
                  "max_records" -> row.job.max_records,
                  "generated" -> count("generated"),
                  "admitted" -> count("admitted"),
                  "parked" -> count("parked"),
                  "rejected" -> count("rejected"),
                  "throttled" -> count("throttled"),
                  "coverage" -> ujson.Obj.from(coverage.map { case (k, v) => k -> ujson.Num(v.toDouble) }),
                  "records" -> ujson.Obj.from(records.map { case (k, v) => k -> ujson.Str(v) }),
                  "updated_at" -> count("updated_at")
                )
                complete(HttpEntity(ContentTypes.\`application/json\`, ujson.write(report)))
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
#include <sw/redis++/redis++.h>

#include <map>
#include <string>

#include "synth/config.h"  // config::progress_key, config::coverage_key — provided
#include "synth/jobs.h"    // jobs::by_id(job_id) — provided
#include "synth/seeds.h"   // seeds::lookup(dataset, version) — provided

using json = nlohmann::json;

sw::redis::Redis redis("tcp://redis:6379");

void read_job(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) {
    res.status = 401;
    res.set_content(R"({"error":"missing X-Tenant-Id"})", "application/json");
    return;
  }
  const std::string job_id = req.matches[1].str();
  const auto job = jobs::by_id(job_id);
  if (!job) {
    res.status = 404;
    res.set_content(R"({"error":"unknown job"})", "application/json");
    return;
  }
  std::map<std::string, long long> counts;
  for (const auto& [field, value] : redis.hgetall(config::progress_key(job_id))) counts[field] = std::stoll(value);
  const long long generated = counts["generated"];
  const long long rejected = counts["rejected"];
  const auto seed = seeds::lookup(job->value("seed_dataset", ""), job->value("seed_version", ""));
  const json report = {
      {"job_id", job_id},
      {"status", job->value("status", "")},
      {"seed_dataset", job->value("seed_dataset", "")},
      {"seed_version", job->value("seed_version", "")},
      {"recipe", job->value("recipe", "")},
      {"max_records", job->value("max_records", 0)},
      {"generated", generated},
      {"admitted", generated - rejected},
      {"rejected", rejected},
      {"throttled", counts["throttled"]},
      {"entities", redis.hlen(config::coverage_key(job_id))},
      {"provenance", {{"license", seed ? seed->license : ""}}},
      {"updated_at", counts["updated_at"]},
  };
  res.status = 200;
  res.set_content(report.dump(), "application/json");
}

void register_routes(httplib::Server& svr) { svr.Get(R"(/v1/synthetic/jobs/([^/]+))", read_job); }

int main() {
  httplib::Server svr;
  register_routes(svr);
  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <map>
#include <string>

#include "synth/config.h"  // config::progress_key, config::coverage_key, config::records_key — provided
#include "synth/jobs.h"    // jobs::by_id(job_id) — provided

using json = nlohmann::json;

sw::redis::Redis redis("tcp://redis:6379");

std::map<std::string, long long> numbers(const std::string& key) {
  std::map<std::string, long long> out;
  for (const auto& [field, value] : redis.hgetall(key)) out[field] = std::stoll(value);
  return out;
}

void read_job(const httplib::Request& req, httplib::Response& res) {
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) {
    res.status = 401;
    res.set_content(R"({"error":"missing X-Tenant-Id"})", "application/json");
    return;
  }
  const std::string job_id = req.matches[1].str();
  const auto job = jobs::by_id(job_id);
  if (!job || job->value("tenant", "") != tenant) {
    res.status = 404;
    res.set_content(R"({"error":"unknown job"})", "application/json");
    return;
  }
  auto counts = numbers(config::progress_key(job_id));
  json records = json::object();
  for (const auto& [record_id, digest] : redis.hgetall(config::records_key(job_id))) records[record_id] = digest;
  const json report = {
      {"job_id", job_id},
      {"status", job->value("status", "")},
      {"seed_dataset", job->value("seed_dataset", "")},
      {"seed_version", job->value("seed_version", "")},
      {"recipe", job->value("recipe", "")},
      {"max_records", job->value("max_records", 0)},
      {"generated", counts["generated"]},
      {"admitted", counts["admitted"]},
      {"parked", counts["parked"]},
      {"rejected", counts["rejected"]},
      {"throttled", counts["throttled"]},
      {"coverage", numbers(config::coverage_key(job_id))},
      {"records", records},
      {"updated_at", counts["updated_at"]},
  };
  res.status = 200;
  res.set_content(report.dump(), "application/json");
}

void register_routes(httplib::Server& svr) { svr.Get(R"(/v1/synthetic/jobs/([^/]+))", read_job); }

int main() {
  httplib::Server svr;
  register_routes(svr);
  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  harness: {
    python: `import json

JOB = "j1"
ROW = {"job_id": JOB, "status": "queued", "seed_dataset": "wiki-qa", "seed_version": "2026-04-01", "recipe": "qa-pairs", "max_records": 1000, "tenant": "t1"}
PROGRESS = {"generated": 10, "admitted": 6, "parked": 3, "rejected": 1, "throttled": 4, "updated_at": 1_790_000_000}
COVERAGE = {"e-paris": 4, "e-lima": 2}
RECORDS = {f"r-{i}": f"{i:02d}" * 32 for i in range(1, 7)}


def _seed(ctx):
    ctx.redis.set(f"synth:job:{JOB}", json.dumps(ROW))
    ctx.redis.hset(f"synth:progress:{JOB}", mapping=PROGRESS)
    ctx.redis.hset(f"synth:coverage:{JOB}", mapping=COVERAGE)
    ctx.redis.hset(f"synth:records:{JOB}", mapping=RECORDS)


def _api(ctx):
    _seed(ctx)
    return ctx.client(ctx.load("read").app)


async def _get(c, job=JOB, tenant="t1"):
    return await c.get(f"/v1/synthetic/jobs/{job}", headers={"X-Tenant-Id": tenant})


async def check_route(ctx):
    async with _api(ctx) as c:
        r = await _get(c)
        assert r.status_code == 200, f"the owner's report answered {r.status_code}: {r.text}"
        body = r.json()
        assert body.get("job_id") == JOB and body.get("status") == "queued" and body.get("seed_dataset") == "wiki-qa", f"the report carries the job: {body}"
        assert body.get("generated") == 10 and body.get("throttled") == 4, f"the report carries the progress counts: {body}"
        r = await _get(c, job="j-missing")
        assert r.status_code == 404, f"an unknown job answered {r.status_code}, expected 404"
        r = await c.get(f"/v1/synthetic/jobs/{JOB}")
        assert r.status_code == 401, f"without X-Tenant-Id the report must answer 401, got {r.status_code}"


async def check_tenant_scope(ctx):
    async with _api(ctx) as c:
        r = await _get(c, tenant="t2")
        assert r.status_code == 404, f"tenant t2 read t1's job and got {r.status_code}, expected 404 (the same answer as a missing job)"
        assert "wiki-qa" not in r.text and "qa-pairs" not in r.text, f"the refusal leaks the job: {r.text}"
        assert (await _get(c)).status_code == 200, "the owner still reads its job"


async def check_parked_apart(ctx):
    async with _api(ctx) as c:
        body = (await _get(c)).json()
        counts = {k: body.get(k) for k in ("generated", "admitted", "parked", "rejected")}
        assert counts == {"generated": 10, "admitted": 6, "parked": 3, "rejected": 1}, f"the progress hash says 10 generated, 6 admitted, 3 parked, 1 rejected; the report says {counts}: a record the judge never scored is not admitted"


async def check_coverage(ctx):
    async with _api(ctx) as c:
        body = (await _get(c)).json()
        assert body.get("coverage") == COVERAGE, f"coverage must be the per-entity map {COVERAGE}, the report says {body.get('coverage')!r}"
        ctx.redis.hincrby(f"synth:coverage:{JOB}", "e-rome", 1)
        body = (await _get(c)).json()
        assert body.get("coverage") == {**COVERAGE, "e-rome": 1}, f"an admission that lands between two reads shows in the second: {body.get('coverage')!r}"


async def check_provenance(ctx):
    async with _api(ctx) as c:
        body = (await _get(c)).json()
        assert body.get("records") == RECORDS, f"records must map every admitted record id to its stored seed digest ({len(RECORDS)} records), the report says {body.get('records')!r}"
`,
    typescript: `const JOB = 'j1';
const ROW = {job_id: JOB, status: 'queued', seed_dataset: 'wiki-qa', seed_version: '2026-04-01', recipe: 'qa-pairs', max_records: 1000, tenant: 't1'};
const PROGRESS = {generated: 10, admitted: 6, parked: 3, rejected: 1, throttled: 4, updated_at: 1_790_000_000};
const COVERAGE = {'e-paris': 4, 'e-lima': 2};
const RECORDS = Object.fromEntries([1, 2, 3, 4, 5, 6].map(i => [\`r-\${i}\`, String(i).padStart(2, '0').repeat(32)]));

function api(ctx) {
  ctx.redis.set(\`synth:job:\${JOB}\`, JSON.stringify(ROW));
  ctx.redis.hset(\`synth:progress:\${JOB}\`, PROGRESS);
  ctx.redis.hset(\`synth:coverage:\${JOB}\`, COVERAGE);
  ctx.redis.hset(\`synth:records:\${JOB}\`, RECORDS);
  return ctx.client(ctx.load('read').app);
}

const get = (c, job = JOB, tenant = 't1') => c.get(\`/v1/synthetic/jobs/\${job}\`, {headers: {'X-Tenant-Id': tenant}});

export async function check_route(ctx) {
  const c = api(ctx);
  let r = await get(c);
  assert.equal(r.status, 200, \`the owner's report answered \${r.status}: \${r.text}\`);
  const body = r.json();
  assert(body.job_id === JOB && body.status === 'queued' && body.seed_dataset === 'wiki-qa', \`the report carries the job: \${r.text}\`);
  assert(body.generated === 10 && body.throttled === 4, \`the report carries the progress counts: \${r.text}\`);
  r = await get(c, 'j-missing');
  assert.equal(r.status, 404, \`an unknown job answered \${r.status}, expected 404\`);
  r = await c.get(\`/v1/synthetic/jobs/\${JOB}\`);
  assert.equal(r.status, 401, \`without X-Tenant-Id the report must answer 401, got \${r.status}\`);
}

export async function check_tenant_scope(ctx) {
  const c = api(ctx);
  const r = await get(c, JOB, 't2');
  assert.equal(r.status, 404, \`tenant t2 read t1's job and got \${r.status}, expected 404 (the same answer as a missing job)\`);
  assert(!r.text.includes('wiki-qa') && !r.text.includes('qa-pairs'), \`the refusal leaks the job: \${r.text}\`);
  assert.equal((await get(c)).status, 200, 'the owner still reads its job');
}

export async function check_parked_apart(ctx) {
  const c = api(ctx);
  const body = (await get(c)).json();
  const counts = {generated: body.generated, admitted: body.admitted, parked: body.parked, rejected: body.rejected};
  assert.deepEqual(counts, {generated: 10, admitted: 6, parked: 3, rejected: 1}, \`the progress hash says 10 generated, 6 admitted, 3 parked, 1 rejected; the report says \${JSON.stringify(counts)}: a record the judge never scored is not admitted\`);
}

export async function check_coverage(ctx) {
  const c = api(ctx);
  let body = (await get(c)).json();
  assert.deepEqual(body.coverage, COVERAGE, \`coverage must be the per-entity map \${JSON.stringify(COVERAGE)}, the report says \${JSON.stringify(body.coverage)}\`);
  ctx.redis.hincrby(\`synth:coverage:\${JOB}\`, 'e-rome', 1);
  body = (await get(c)).json();
  assert.deepEqual(body.coverage, {...COVERAGE, 'e-rome': 1}, \`an admission that lands between two reads shows in the second: \${JSON.stringify(body.coverage)}\`);
}

export async function check_provenance(ctx) {
  const c = api(ctx);
  const body = (await get(c)).json();
  assert.deepEqual(body.records, RECORDS, \`records must map every admitted record id to its stored seed digest (6 records), the report says \${JSON.stringify(body.records)}\`);
}
`,
    go: `package main

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"

	"leetbuild/harness"
)

const readJobID = "j1"

var (
	readCoverage = map[string]any{"e-paris": float64(4), "e-lima": float64(2)}
	readRecords  = map[string]any{}
)

func readClient(ctx *harness.Ctx) *harness.HTTP {
	row, _ := json.Marshal(map[string]any{"job_id": readJobID, "status": "queued", "seed_dataset": "wiki-qa", "seed_version": "2026-04-01", "recipe": "qa-pairs", "max_records": 1000, "tenant": "t1"})
	ctx.Redis.Set("synth:job:"+readJobID, string(row))
	ctx.Redis.Do("HSET", "synth:progress:"+readJobID, "generated", 10, "admitted", 6, "parked", 3, "rejected", 1, "throttled", 4, "updated_at", 1790000000)
	ctx.Redis.Do("HSET", "synth:coverage:"+readJobID, "e-paris", 4, "e-lima", 2)
	for i := 1; i <= 6; i++ {
		id := "r-" + strconv.Itoa(i)
		digest := strings.Repeat("0"+strconv.Itoa(i), 32)
		readRecords[id] = digest
		ctx.Redis.Do("HSET", "synth:records:"+readJobID, id, digest)
	}
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

func readGet(c *harness.HTTP, job, tenant string) *harness.Response {
	return c.Get("/v1/synthetic/jobs/"+job, "X-Tenant-Id", tenant)
}

func readBody(ctx *harness.Ctx, r *harness.Response) map[string]any {
	body, ok := r.JSON().(map[string]any)
	ctx.Assert(ok, "the report must be a JSON object: %s", r.Text())
	return body
}

func CheckRoute(ctx *harness.Ctx) {
	c := readClient(ctx)
	r := readGet(c, readJobID, "t1")
	ctx.Equal(r.Status, 200, "the owner's report (%s)", r.Text())
	body := readBody(ctx, r)
	ctx.Assert(body["job_id"] == readJobID && body["status"] == "queued" && body["seed_dataset"] == "wiki-qa", "the report carries the job: %s", r.Text())
	ctx.Assert(body["generated"] == float64(10) && body["throttled"] == float64(4), "the report carries the progress counts: %s", r.Text())
	ctx.Equal(readGet(c, "j-missing", "t1").Status, 404, "an unknown job")
	ctx.Equal(c.Get("/v1/synthetic/jobs/"+readJobID).Status, 401, "without X-Tenant-Id the report")
}

func CheckTenantScope(ctx *harness.Ctx) {
	c := readClient(ctx)
	r := readGet(c, readJobID, "t2")
	ctx.Equal(r.Status, 404, "tenant t2 reading t1's job (the same answer as a missing job)")
	ctx.Assert(!strings.Contains(r.Text(), "wiki-qa") && !strings.Contains(r.Text(), "qa-pairs"), "the refusal leaks the job: %s", r.Text())
	ctx.Equal(readGet(c, readJobID, "t1").Status, 200, "the owner still reads its job")
}

func CheckParkedApart(ctx *harness.Ctx) {
	c := readClient(ctx)
	body := readBody(ctx, readGet(c, readJobID, "t1"))
	got := []any{body["generated"], body["admitted"], body["parked"], body["rejected"]}
	ctx.Equal(got, []any{float64(10), float64(6), float64(3), float64(1)}, "the progress hash says 10 generated, 6 admitted, 3 parked, 1 rejected (a record the judge never scored is not admitted); generated, admitted, parked, rejected")
}

func CheckCoverage(ctx *harness.Ctx) {
	c := readClient(ctx)
	body := readBody(ctx, readGet(c, readJobID, "t1"))
	ctx.Equal(body["coverage"], readCoverage, "coverage must be the per-entity map")
	ctx.Redis.Do("HINCRBY", "synth:coverage:"+readJobID, "e-rome", 1)
	body = readBody(ctx, readGet(c, readJobID, "t1"))
	ctx.Equal(body["coverage"], map[string]any{"e-paris": float64(4), "e-lima": float64(2), "e-rome": float64(1)}, "an admission that lands between two reads shows in the second")
}

func CheckProvenance(ctx *harness.Ctx) {
	c := readClient(ctx)
	body := readBody(ctx, readGet(c, readJobID, "t1"))
	ctx.Equal(body["records"], readRecords, "records must map every admitted record id to its stored seed digest")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <string>

namespace {

using json = nlohmann::json;

const std::string kJob = "j1";

struct Api {
  httplib::Server svr;
  harness::HTTP http;
  json records = json::object();
  explicit Api(harness::Ctx& ctx) : http(ctx.HTTP(svr)) {
    const json row = {{"job_id", kJob}, {"status", "queued"}, {"seed_dataset", "wiki-qa"}, {"seed_version", "2026-04-01"}, {"recipe", "qa-pairs"}, {"max_records", 1000}, {"tenant", "t1"}};
    ctx.Redis.Set("synth:job:" + kJob, row.dump());
    ctx.Redis.Do("HSET", "synth:progress:" + kJob, "generated", 10, "admitted", 6, "parked", 3, "rejected", 1, "throttled", 4, "updated_at", 1790000000);
    ctx.Redis.Do("HSET", "synth:coverage:" + kJob, "e-paris", 4, "e-lima", 2);
    for (int i = 1; i <= 6; i++) {
      std::string digest;
      for (int k = 0; k < 32; k++) digest += "0" + std::to_string(i);
      records["r-" + std::to_string(i)] = digest;
      ctx.Redis.Do("HSET", "synth:records:" + kJob, "r-" + std::to_string(i), digest);
    }
    register_routes(svr);
  }
  harness::Response report(const std::string& job_id = kJob, const std::string& tenant = "t1") {
    return http.Get("/v1/synthetic/jobs/" + job_id, "X-Tenant-Id", tenant);
  }
};

json bodyOf(harness::Ctx& ctx, const harness::Response& r) {
  const json body = json::parse(r.Text(), nullptr, false);
  ctx.Assert(body.is_object(), "the report must be a JSON object: %s", r.Text());
  return body;
}

}  // namespace

void CheckRoute(harness::Ctx& ctx) {
  Api api(ctx);
  const auto r = api.report();
  ctx.Equal(r.Status, 200, "the owner's report (%s)", r.Text());
  const json body = bodyOf(ctx, r);
  ctx.Assert(body.value("job_id", "") == kJob && body.value("status", "") == "queued" && body.value("seed_dataset", "") == "wiki-qa", "the report carries the job: %s", r.Text());
  ctx.Assert(body.value("generated", -1) == 10 && body.value("throttled", -1) == 4, "the report carries the progress counts: %s", r.Text());
  ctx.Equal(api.report("j-missing").Status, 404, "an unknown job");
  ctx.Equal(api.http.Get("/v1/synthetic/jobs/" + kJob).Status, 401, "without X-Tenant-Id the report");
}

void CheckTenantScope(harness::Ctx& ctx) {
  Api api(ctx);
  const auto r = api.report(kJob, "t2");
  ctx.Equal(r.Status, 404, "tenant t2 reading t1's job (the same answer as a missing job)");
  ctx.Assert(r.Text().find("wiki-qa") == std::string::npos && r.Text().find("qa-pairs") == std::string::npos, "the refusal leaks the job: %s", r.Text());
  ctx.Equal(api.report().Status, 200, "the owner still reads its job");
}

void CheckParkedApart(harness::Ctx& ctx) {
  Api api(ctx);
  const json body = bodyOf(ctx, api.report());
  const json got = {body.value("generated", -1), body.value("admitted", -1), body.value("parked", -1), body.value("rejected", -1)};
  ctx.Equal(got, json({10, 6, 3, 1}), "the progress hash says 10 generated, 6 admitted, 3 parked, 1 rejected (a record the judge never scored is not admitted); generated, admitted, parked, rejected (-1: absent)");
}

void CheckCoverage(harness::Ctx& ctx) {
  Api api(ctx);
  json body = bodyOf(ctx, api.report());
  ctx.Equal(body.value("coverage", json()), json({{"e-paris", 4}, {"e-lima", 2}}), "coverage must be the per-entity map");
  ctx.Redis.Do("HINCRBY", "synth:coverage:" + kJob, "e-rome", 1);
  body = bodyOf(ctx, api.report());
  ctx.Equal(body.value("coverage", json()), json({{"e-paris", 4}, {"e-lima", 2}, {"e-rome", 1}}), "an admission that lands between two reads shows in the second");
}

void CheckProvenance(harness::Ctx& ctx) {
  Api api(ctx);
  const json body = bodyOf(ctx, api.report());
  ctx.Equal(body.value("records", json()), api.records, "records must map every admitted record id to its stored seed digest");
}
`,
  },
  debrief: `A report is only worth what a reviewer can check against it. Reading the counters as stored keeps parked records visible: they are exactly the records nobody scored, and deriving \`admitted\` folded them into the number that goes into a training run. Per-entity coverage is what shows a collapse that a count of entities hides. Returning the stored digests, rather than a license looked up today, means each admitted record points at the seed it was expanded from, even after the registry moves on. The tenant check gives a foreign job the same 404 as a missing one, so job ids cannot be probed. Production reports paginate the record list, compute a dominance ratio over coverage, and sign the report so a reviewer's approval is tied to the exact counts it saw.`,
};
