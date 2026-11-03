import type {Step} from '@/lib/types';

export const readStep: Step = {
  id: 'read',
  title: 'GET /v1/evals/runs/{id}: the release gate',
  concept: 'http',
  file: 'read',
  focus: ['client', 'api', 'redis'],
  task: `## Task

**Starting point.** The starter serves \`GET /v1/evals/runs/{run_id}\`, the report the release pipeline
reads before it ships: 401 without \`X-Tenant-Id\`, 404 when the provided run store has no such run,
then a cached body from \`evals:report:{run_id}\` if there is one; otherwise it reads
\`evals:progress:{run_id}\`, computes \`pass_rate = passed / scored\`, labels the run \`passed\` or
\`failed\` against a \`threshold\` query parameter (default 0.9) and caches the body for 60 s. It hides
5 flaws.

**Failure mode the checks target.** A release decision is made from this body, so each flaw ships a
model: any tenant reads any run, a run is green after twelve samples, the caller picks its own bar, a
run scored mostly by the string metric is certified, and a report cached early hides the last batch's
failures.

Requirements:

- A run that belongs to another tenant answers **404**, like one that does not exist.
- Below **200** scored samples (\`MIN_SCORED_SAMPLES\`) the status is **\`pending\`**.
- When more than **20%** of the scored samples used the fallback (\`MAX_FALLBACK_SHARE\`), the status is
  **\`unreliable\`**.
- Otherwise the run is **\`passed\`** when \`pass_rate\` reaches \`RELEASE_THRESHOLD\` (0.9, server config),
  **\`failed\`** below it; a \`threshold\` in the query is ignored.
- The counters are read on **every request**; the body is \`{run_id, status, scored, passed, failed,
  fallback, pass_rate, threshold, updated_at}\`.`,
  sequence: {
    participants: ['Release pipeline', 'evald', 'Redis'],
    messages: [
      {from: 'Release pipeline', to: 'evald', label: 'GET /v1/evals/runs/{id} · X-Tenant-Id', kind: 'sync'},
      {from: 'evald', to: 'Redis', label: 'GET evals:run:{id} → tenant matches', kind: 'sync'},
      {from: 'evald', to: 'Redis', label: 'HGETALL evals:progress:{id}', kind: 'sync'},
      {from: 'Redis', to: 'evald', label: '{scored 300, passed 270, fallback 30, updated_at}', kind: 'reply'},
      {from: 'evald', to: 'evald', label: '≥ 200 scored · fallback ≤ 20% · 0.9 ≥ RELEASE_THRESHOLD', kind: 'sync'},
      {from: 'evald', to: 'Release pipeline', label: '200 {status: passed, pass_rate 0.9, …}', kind: 'reply'},
    ],
  },
  hints: [
    "Symptom: a run is reported passed after 12 of 500 samples, `?threshold=0.5` turns a failing run green, tenant t2 reads t1's run, and the report stays green for a minute after the last batch failed.",
    "Mechanism: the rate is compared with whatever the query says, with no floor and no look at `fallback`; the run's tenant is not compared with the caller's; and `evals:report:{run_id}` answers for 60 s after the first read.",
    "Change: 404 unless the run's tenant is the caller's; drop the report cache and `HGETALL` on every request; then `pending` below `MIN_SCORED_SAMPLES`, `unreliable` above `MAX_FALLBACK_SHARE`, else compare `pass_rate` with `RELEASE_THRESHOLD`.",
  ],
  checks: [
    {
      id: 'route',
      title: 'Handles GET /v1/evals/runs/{id}',
      detail:
        "The report answers 401 without X-Tenant-Id, 404 for an unknown run, and 200 with the run's counters and pass_rate: 250 scored, 240 passed reads 0.96 and passed.",
      match: {
        python: {all: [/@app\.get\(\s*["']\/v1\/evals\/runs\/\{run_id\}["']/]},
        typescript: {all: [/app\.get\(\s*['"]\/v1\/evals\/runs\/:run_id['"]/]},
        go: {all: [/HandleFunc\(\s*"GET \/v1\/evals\/runs\/\{runID\}"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"evals"\s*\/\s*"runs"\s*\/\s*Segment\s*\)/, /\bget\s*\{/]},
        cpp: {all: [/svr\.Get\([^,\n]*v1\/evals\/runs\//]},
      },
    },
    {
      id: 'tenant-scope',
      title: "Answers 404 for another tenant's run",
      detail:
        "Tenant t2 asking for t1's run gets 404, the answer an unknown run gets; t1 gets its report. The starter returns any run to any tenant.",
      match: {
        python: {
          all: [/run(\.get\(\s*["']tenant["']\s*\)|\[["']tenant["']\])\s*!=\s*tenant|tenant\s*!=\s*run(\.get\(|\[)/],
        },
        typescript: {all: [/run\.tenant\s*!==\s*tenant|tenant\s*!==\s*run\.tenant/]},
        go: {all: [/run\.Tenant\s*!=\s*tenant|tenant\s*!=\s*run\.Tenant/]},
        scala: {all: [/\.tenant\s*(==|!=)\s*tenant|tenant\s*(==|!=)\s*\w+\.tenant/]},
        cpp: {all: [/value\(\s*"tenant"\s*,\s*""\s*\)\s*!=\s*tenant|tenant\s*!=\s*\w+->value\(\s*"tenant"/]},
      },
    },
    {
      id: 'min-samples',
      title: 'Reports pending below 200 scored samples',
      detail:
        'Runs with 12 and 199 scored samples, all passing, report pending; at 200 the run is judged. The starter labels a run after any number of samples.',
      match: {
        python: {all: [/MIN_SCORED_SAMPLES/, /["']pending["']/]},
        typescript: {all: [/MIN_SCORED_SAMPLES/, /['"]pending['"]/]},
        go: {all: [/minScoredSamples/, /"pending"/]},
        scala: {all: [/MinScoredSamples/, /"pending"/]},
        cpp: {all: [/kMinScoredSamples/, /"pending"/]},
      },
    },
    {
      id: 'threshold-config',
      title: 'Takes the release threshold from server config',
      detail:
        "A run at 0.85 asked with ?threshold=0.5 still fails against RELEASE_THRESHOLD 0.9, and a run at exactly 0.9 passes. The starter compares with the caller's threshold.",
      match: {
        python: {all: [/RELEASE_THRESHOLD/], none: [/query_params|Query\(/]},
        typescript: {all: [/RELEASE_THRESHOLD/], none: [/request\.query/]},
        go: {all: [/releaseThreshold/], none: [/URL\.Query\(\)|FormValue\(/]},
        scala: {all: [/ReleaseThreshold/], none: [/parameters?\(/]},
        cpp: {all: [/kReleaseThreshold/], none: [/get_param_value\(|has_param\(/]},
      },
    },
    {
      id: 'fallback-share',
      title: 'Reports unreliable when fallbacks dominate',
      detail:
        'A run where 120 of 300 samples were scored by the string metric reports unreliable whatever its pass rate; with 30 of 300 it is judged. The starter never reads fallback.',
      match: {
        python: {all: [/MAX_FALLBACK_SHARE/, /["']unreliable["']/]},
        typescript: {all: [/MAX_FALLBACK_SHARE/, /['"]unreliable['"]/]},
        go: {all: [/maxFallbackShare/, /"unreliable"/]},
        scala: {all: [/MaxFallbackShare/, /"unreliable"/]},
        cpp: {all: [/kMaxFallbackShare/, /"unreliable"/]},
      },
    },
    {
      id: 'fresh-report',
      title: 'Reads the live counters on every request',
      detail:
        'Fifty failures that land after the first read show in the second: scored 300, failed 60, status failed, the new updated_at. The starter serves the first reading from evals:report:{run_id} for 60 s.',
      match: {
        python: {all: [/hgetall\(/], none: [/evals:report:|REPORT_TTL_S/]},
        typescript: {all: [/hgetall\(/], none: [/evals:report:|REPORT_TTL_S/]},
        go: {all: [/HGetAll\(/], none: [/evals:report:|reportTTL/]},
        scala: {all: [/hgetAll\(/], none: [/evals:report:|ReportTtlSeconds/]},
        cpp: {all: [/hgetall\(/], none: [/evals:report:|kReportTtl/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json

import redis
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse

from evals.config import progress_key
from evals.runs import store

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)

REPORT_TTL_S = 60


@app.get("/v1/evals/runs/{run_id}")
def read_run(run_id: str, request: Request) -> JSONResponse:
    # TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    tenant = request.headers.get("X-Tenant-Id", "")
    if tenant == "":
        raise HTTPException(status_code=401, detail="missing X-Tenant-Id")
    run = store.by_id(run_id)
    if run is None:
        raise HTTPException(status_code=404, detail="unknown run")
    cached = r.get(f"evals:report:{run_id}")
    if cached is not None:
        return JSONResponse(json.loads(cached), status_code=200)
    counts = {key: int(value) for key, value in r.hgetall(progress_key(run_id)).items()}
    scored = counts.get("scored", 0)
    passed = counts.get("passed", 0)
    threshold = float(request.query_params.get("threshold", "0.9"))
    rate = passed / scored if scored else 0.0
    report = {
        "run_id": run_id,
        "status": "passed" if rate >= threshold else "failed",
        "scored": scored,
        "passed": passed,
        "failed": counts.get("failed", 0),
        "pass_rate": rate,
        "threshold": threshold,
        "updated_at": counts.get("updated_at", 0),
    }
    r.set(f"evals:report:{run_id}", json.dumps(report), ex=REPORT_TTL_S)
    return JSONResponse(report, status_code=200)
`,
      solution: `import logging

import redis
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse

from evals.config import progress_key
from evals.runs import store

app = FastAPI()
logger = logging.getLogger("evald.report")
r = redis.Redis(host="redis", port=6379, decode_responses=True)

MIN_SCORED_SAMPLES = 200
RELEASE_THRESHOLD = 0.9
MAX_FALLBACK_SHARE = 0.2


@app.get("/v1/evals/runs/{run_id}")
def read_run(run_id: str, request: Request) -> JSONResponse:
    tenant = request.headers.get("X-Tenant-Id", "")
    if tenant == "":
        raise HTTPException(status_code=401, detail="missing X-Tenant-Id")
    run = store.by_id(run_id)
    if run is None or run.get("tenant") != tenant:
        raise HTTPException(status_code=404, detail="unknown run")

    counts = {key: int(value) for key, value in r.hgetall(progress_key(run_id)).items()}
    scored = counts.get("scored", 0)
    passed = counts.get("passed", 0)
    fallback = counts.get("fallback", 0)
    rate = passed / scored if scored else 0.0
    if scored < MIN_SCORED_SAMPLES:
        status = "pending"
    elif fallback / scored > MAX_FALLBACK_SHARE:
        status = "unreliable"
        logger.warning("eval report run=%s: %d of %d samples scored by the fallback", run_id, fallback, scored)
    elif rate >= RELEASE_THRESHOLD:
        status = "passed"
    else:
        status = "failed"
    return JSONResponse(
        {
            "run_id": run_id,
            "status": status,
            "scored": scored,
            "passed": passed,
            "failed": counts.get("failed", 0),
            "fallback": fallback,
            "pass_rate": rate,
            "threshold": RELEASE_THRESHOLD,
            "updated_at": counts.get("updated_at", 0),
        },
        status_code=200,
    )
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';
import Redis from 'ioredis';

import {progressKey} from 'evals/config';
import {store} from 'evals/runs';

export const app = Fastify();
const redis = new Redis({host: 'redis', port: 6379});

export const REPORT_TTL_S = 60;

app.get('/v1/evals/runs/:run_id', async (request, reply) => {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing X-Tenant-Id'});
  const {run_id: runId} = request.params as {run_id: string};
  const run = await store.byId(runId);
  if (run === null) return reply.code(404).send({error: 'unknown run'});
  const cached = await redis.get(\`evals:report:\${runId}\`);
  if (cached !== null) return reply.code(200).send(JSON.parse(cached));
  const counts = Object.fromEntries(Object.entries(await redis.hgetall(progressKey(runId))).map(([k, v]) => [k, Number(v)]));
  const scored = counts.scored ?? 0;
  const passed = counts.passed ?? 0;
  const {threshold = '0.9'} = request.query as {threshold?: string};
  const bar = Number(threshold);
  const rate = scored > 0 ? passed / scored : 0;
  const report = {
    run_id: runId,
    status: rate >= bar ? 'passed' : 'failed',
    scored,
    passed,
    failed: counts.failed ?? 0,
    pass_rate: rate,
    threshold: bar,
    updated_at: counts.updated_at ?? 0,
  };
  await redis.set(\`evals:report:\${runId}\`, JSON.stringify(report), 'EX', REPORT_TTL_S);
  return reply.code(200).send(report);
});
`,
      solution: `import Fastify from 'fastify';
import Redis from 'ioredis';

import {progressKey} from 'evals/config';
import {store} from 'evals/runs';

export const app = Fastify();
const redis = new Redis({host: 'redis', port: 6379});

export const MIN_SCORED_SAMPLES = 200;
export const RELEASE_THRESHOLD = 0.9;
export const MAX_FALLBACK_SHARE = 0.2;

app.get('/v1/evals/runs/:run_id', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing X-Tenant-Id'});
  const {run_id: runId} = request.params as {run_id: string};
  const run = await store.byId(runId);
  if (run === null || run.tenant !== tenant) return reply.code(404).send({error: 'unknown run'});

  const counts = Object.fromEntries(Object.entries(await redis.hgetall(progressKey(runId))).map(([k, v]) => [k, Number(v)]));
  const scored = counts.scored ?? 0;
  const passed = counts.passed ?? 0;
  const fallback = counts.fallback ?? 0;
  const rate = scored > 0 ? passed / scored : 0;
  let status: string;
  if (scored < MIN_SCORED_SAMPLES) status = 'pending';
  else if (fallback / scored > MAX_FALLBACK_SHARE) {
    status = 'unreliable';
    request.log.warn({run_id: runId, fallback, scored}, 'most samples scored by the fallback');
  } else status = rate >= RELEASE_THRESHOLD ? 'passed' : 'failed';
  return reply.code(200).send({
    run_id: runId,
    status,
    scored,
    passed,
    failed: counts.failed ?? 0,
    fallback,
    pass_rate: rate,
    threshold: RELEASE_THRESHOLD,
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
	"time"

	"github.com/redis/go-redis/v9"

	"evals/config" // config.ProgressKey — provided
	"evals/runs"   // runs.ByID(ctx, runID) — provided
)

const reportTTL = 60 * time.Second

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func counters(hash map[string]string) map[string]int64 {
	out := map[string]int64{}
	for k, v := range hash {
		n, _ := strconv.ParseInt(v, 10, 64)
		out[k] = n
	}
	return out
}

func readRun(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-Tenant-Id"})
		return
	}
	runID := r.PathValue("runID")
	run, err := runs.ByID(r.Context(), runID)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	if run == nil {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "unknown run"})
		return
	}
	if cached, err := rdb.Get(r.Context(), "evals:report:"+runID).Result(); err == nil {
		rw.Header().Set("Content-Type", "application/json")
		rw.Write([]byte(cached))
		return
	}
	hash, err := rdb.HGetAll(r.Context(), config.ProgressKey(runID)).Result()
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	counts := counters(hash)
	threshold := 0.9
	if q := r.URL.Query().Get("threshold"); q != "" {
		threshold, _ = strconv.ParseFloat(q, 64)
	}
	rate := 0.0
	if counts["scored"] > 0 {
		rate = float64(counts["passed"]) / float64(counts["scored"])
	}
	status := "failed"
	if rate >= threshold {
		status = "passed"
	}
	report, _ := json.Marshal(map[string]any{
		"run_id":     runID,
		"status":     status,
		"scored":     counts["scored"],
		"passed":     counts["passed"],
		"failed":     counts["failed"],
		"pass_rate":  rate,
		"threshold":  threshold,
		"updated_at": counts["updated_at"],
	})
	rdb.Set(r.Context(), "evals:report:"+runID, report, reportTTL)
	rw.Header().Set("Content-Type", "application/json")
	rw.Write(report)
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/evals/runs/{runID}", readRun)
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

	"evals/config" // config.ProgressKey — provided
	"evals/runs"   // runs.ByID(ctx, runID) — provided
)

const (
	minScoredSamples = 200
	releaseThreshold = 0.9
	maxFallbackShare = 0.2
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func counters(hash map[string]string) map[string]int64 {
	out := map[string]int64{}
	for k, v := range hash {
		n, _ := strconv.ParseInt(v, 10, 64)
		out[k] = n
	}
	return out
}

func readRun(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-Tenant-Id"})
		return
	}
	runID := r.PathValue("runID")
	run, err := runs.ByID(r.Context(), runID)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	if run == nil || run.Tenant != tenant {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "unknown run"})
		return
	}

	hash, err := rdb.HGetAll(r.Context(), config.ProgressKey(runID)).Result()
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	counts := counters(hash)
	scored, passed, fallback := counts["scored"], counts["passed"], counts["fallback"]
	rate := 0.0
	if scored > 0 {
		rate = float64(passed) / float64(scored)
	}
	var status string
	switch {
	case scored < minScoredSamples:
		status = "pending"
	case float64(fallback)/float64(scored) > maxFallbackShare:
		status = "unreliable"
		log.Printf("eval report run=%s: %d of %d samples scored by the fallback", runID, fallback, scored)
	case rate >= releaseThreshold:
		status = "passed"
	default:
		status = "failed"
	}
	writeJSON(rw, http.StatusOK, map[string]any{
		"run_id":     runID,
		"status":     status,
		"scored":     scored,
		"passed":     passed,
		"failed":     counts["failed"],
		"fallback":   fallback,
		"pass_rate":  rate,
		"threshold":  releaseThreshold,
		"updated_at": counts["updated_at"],
	})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/evals/runs/{runID}", readRun)
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

import evals.{Config, Runs}

object EvalReport {
  implicit val system: ActorSystem = ActorSystem("eval-report")
  val jedis = new JedisPooled("redis", 6379)

  val ReportTtlSeconds = 60L

  private def json(body: String) = HttpEntity(ContentTypes.\`application/json\`, body)

  val route: Route =
    path("v1" / "evals" / "runs" / Segment) { runId =>
      get {
        optionalHeaderValueByName("X-Tenant-Id") { tenantOpt =>
          parameter("threshold".as[Double].optional) { thresholdOpt =>
            // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
            if (!tenantOpt.exists(_.nonEmpty)) {
              complete(StatusCodes.Unauthorized, """{"error":"missing X-Tenant-Id"}""")
            } else if (Runs.byId(runId).isEmpty) {
              complete(StatusCodes.NotFound, """{"error":"unknown run"}""")
            } else {
              Option(jedis.get(s"evals:report:$runId")) match {
                case Some(cached) => complete(json(cached))
                case None =>
                  val counts = jedis.hgetAll(Config.progressKey(runId)).asScala.toMap.map { case (k, v) => k -> v.toLong }
                  val scored = counts.getOrElse("scored", 0L)
                  val passed = counts.getOrElse("passed", 0L)
                  val threshold = thresholdOpt.getOrElse(0.9)
                  val rate = if (scored > 0) passed.toDouble / scored else 0.0
                  val report = ujson.write(
                    ujson.Obj(
                      "run_id" -> runId,
                      "status" -> (if (rate >= threshold) "passed" else "failed"),
                      "scored" -> scored,
                      "passed" -> passed,
                      "failed" -> ujson.Num(counts.getOrElse("failed", 0L).toDouble),
                      "pass_rate" -> rate,
                      "threshold" -> threshold,
                      "updated_at" -> ujson.Num(counts.getOrElse("updated_at", 0L).toDouble)
                    )
                  )
                  jedis.setex(s"evals:report:$runId", ReportTtlSeconds, report)
                  complete(json(report))
              }
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

import evals.{Config, Runs}

object EvalReport {
  implicit val system: ActorSystem = ActorSystem("eval-report")
  val jedis = new JedisPooled("redis", 6379)

  val MinScoredSamples = 200L
  val ReleaseThreshold = 0.9
  val MaxFallbackShare = 0.2

  val route: Route =
    path("v1" / "evals" / "runs" / Segment) { runId =>
      get {
        optionalHeaderValueByName("X-Tenant-Id") { tenantOpt =>
          if (!tenantOpt.exists(_.nonEmpty)) {
            complete(StatusCodes.Unauthorized, """{"error":"missing X-Tenant-Id"}""")
          } else {
            Runs.byId(runId).filter(_.tenant == tenantOpt.get) match {
              case None => complete(StatusCodes.NotFound, """{"error":"unknown run"}""")
              case Some(_) =>
                val counts = jedis.hgetAll(Config.progressKey(runId)).asScala.toMap.map { case (k, v) => k -> v.toLong }
                val scored = counts.getOrElse("scored", 0L)
                val passed = counts.getOrElse("passed", 0L)
                val fallback = counts.getOrElse("fallback", 0L)
                val rate = if (scored > 0) passed.toDouble / scored else 0.0
                val status =
                  if (scored < MinScoredSamples) "pending"
                  else if (fallback.toDouble / scored > MaxFallbackShare) "unreliable"
                  else if (rate >= ReleaseThreshold) "passed"
                  else "failed"
                val report = ujson.Obj(
                  "run_id" -> runId,
                  "status" -> status,
                  "scored" -> scored,
                  "passed" -> passed,
                  "failed" -> ujson.Num(counts.getOrElse("failed", 0L).toDouble),
                  "fallback" -> fallback,
                  "pass_rate" -> rate,
                  "threshold" -> ReleaseThreshold,
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
    },
    cpp: {
      starter: `#include <httplib.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <map>
#include <string>

#include "evals/config.h"  // config::progress_key — provided
#include "evals/runs.h"    // runs::by_id(run_id) — provided

using json = nlohmann::json;

constexpr long long kReportTtlSeconds = 60;

sw::redis::Redis redis("tcp://redis:6379");

std::map<std::string, long long> counters(const std::string& key) {
  std::map<std::string, long long> out;
  for (const auto& [field, value] : redis.hgetall(key)) out[field] = std::stoll(value);
  return out;
}

long long count_of(const std::map<std::string, long long>& counts, const std::string& field) {
  const auto it = counts.find(field);
  return it == counts.end() ? 0 : it->second;
}

void read_run(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) {
    res.status = 401;
    res.set_content(R"({"error":"missing X-Tenant-Id"})", "application/json");
    return;
  }
  const std::string run_id = req.matches[1].str();
  if (!runs::by_id(run_id)) {
    res.status = 404;
    res.set_content(R"({"error":"unknown run"})", "application/json");
    return;
  }
  if (const auto cached = redis.get("evals:report:" + run_id)) {
    res.status = 200;
    res.set_content(*cached, "application/json");
    return;
  }
  const auto counts = counters(config::progress_key(run_id));
  const long long scored = count_of(counts, "scored");
  const long long passed = count_of(counts, "passed");
  const double threshold = req.has_param("threshold") ? std::stod(req.get_param_value("threshold")) : 0.9;
  const double rate = scored > 0 ? static_cast<double>(passed) / static_cast<double>(scored) : 0.0;
  const std::string report = json{{"run_id", run_id},
                                  {"status", rate >= threshold ? "passed" : "failed"},
                                  {"scored", scored},
                                  {"passed", passed},
                                  {"failed", count_of(counts, "failed")},
                                  {"pass_rate", rate},
                                  {"threshold", threshold},
                                  {"updated_at", count_of(counts, "updated_at")}}
                                 .dump();
  redis.set("evals:report:" + run_id, report, kReportTtlSeconds);
  res.status = 200;
  res.set_content(report, "application/json");
}

void register_routes(httplib::Server& svr) { svr.Get(R"(/v1/evals/runs/([^/]+))", read_run); }

int main() {
  httplib::Server svr;
  register_routes(svr);
  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <iostream>
#include <map>
#include <string>

#include "evals/config.h"  // config::progress_key — provided
#include "evals/runs.h"    // runs::by_id(run_id) — provided

using json = nlohmann::json;

constexpr long long kMinScoredSamples = 200;
constexpr double kReleaseThreshold = 0.9;
constexpr double kMaxFallbackShare = 0.2;

sw::redis::Redis redis("tcp://redis:6379");

std::map<std::string, long long> counters(const std::string& key) {
  std::map<std::string, long long> out;
  for (const auto& [field, value] : redis.hgetall(key)) out[field] = std::stoll(value);
  return out;
}

long long count_of(const std::map<std::string, long long>& counts, const std::string& field) {
  const auto it = counts.find(field);
  return it == counts.end() ? 0 : it->second;
}

void read_run(const httplib::Request& req, httplib::Response& res) {
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) {
    res.status = 401;
    res.set_content(R"({"error":"missing X-Tenant-Id"})", "application/json");
    return;
  }
  const std::string run_id = req.matches[1].str();
  const auto run = runs::by_id(run_id);
  if (!run || run->value("tenant", "") != tenant) {
    res.status = 404;
    res.set_content(R"({"error":"unknown run"})", "application/json");
    return;
  }

  const auto counts = counters(config::progress_key(run_id));
  const long long scored = count_of(counts, "scored");
  const long long passed = count_of(counts, "passed");
  const long long fallback = count_of(counts, "fallback");
  const double rate = scored > 0 ? static_cast<double>(passed) / static_cast<double>(scored) : 0.0;
  std::string status;
  if (scored < kMinScoredSamples) {
    status = "pending";
  } else if (static_cast<double>(fallback) / static_cast<double>(scored) > kMaxFallbackShare) {
    status = "unreliable";
    std::cerr << "eval report run=" << run_id << ": " << fallback << " of " << scored << " samples scored by the fallback\\n";
  } else {
    status = rate >= kReleaseThreshold ? "passed" : "failed";
  }
  const json report = {{"run_id", run_id},
                       {"status", status},
                       {"scored", scored},
                       {"passed", passed},
                       {"failed", count_of(counts, "failed")},
                       {"fallback", fallback},
                       {"pass_rate", rate},
                       {"threshold", kReleaseThreshold},
                       {"updated_at", count_of(counts, "updated_at")}};
  res.status = 200;
  res.set_content(report.dump(), "application/json");
}

void register_routes(httplib::Server& svr) { svr.Get(R"(/v1/evals/runs/([^/]+))", read_run); }

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

TENANT = {"X-Tenant-Id": "t1"}


def _seed(ctx, run_id, scored, passed, fallback=0, tenant="t1", updated_at=1_700_000_000):
    row = {"run_id": run_id, "status": "queued", "dataset_id": "gs-support-v3", "model_version": "support-bot-2026-10", "sample_budget": 500, "tenant": tenant}
    ctx.redis.set(f"evals:run:{run_id}", json.dumps(row))
    ctx.redis.hset(f"evals:progress:{run_id}", mapping={"scored": scored, "passed": passed, "failed": scored - passed, "fallback": fallback, "updated_at": updated_at})


def _api(ctx):
    return ctx.client(ctx.load("read").app)


async def _report(c, run_id, headers=TENANT, query=""):
    return await c.get(f"/v1/evals/runs/{run_id}{query}", headers=headers)


async def _body(c, run_id, query=""):
    r = await _report(c, run_id, query=query)
    assert r.status_code == 200, f"the report of {run_id} answered {r.status_code}: {r.text}"
    return r.json()


async def check_route(ctx):
    _seed(ctx, "r1", 250, 240)
    async with _api(ctx) as c:
        r = await _report(c, "r1", headers={})
        assert r.status_code == 401, f"without X-Tenant-Id the report must answer 401, got {r.status_code}"
        r = await _report(c, "nope")
        assert r.status_code == 404, f"an unknown run must answer 404, got {r.status_code}"
        body = await _body(c, "r1")
        for key in ("run_id", "status", "scored", "passed", "failed", "pass_rate"):
            assert key in body, f"the report lacks {key!r}: {body}"
        assert body["run_id"] == "r1" and (body["scored"], body["passed"], body["failed"]) == (250, 240, 10), f"the report carries the run's counters: {body}"
        assert abs(body["pass_rate"] - 0.96) < 1e-9, f"pass_rate is passed / scored = 0.96, got {body['pass_rate']}"
        assert body["status"] == "passed", f"250 samples at 0.96 pass, got {body}"


async def check_tenant_scope(ctx):
    _seed(ctx, "r1", 250, 240, tenant="t1")
    async with _api(ctx) as c:
        r = await _report(c, "r1", headers={"X-Tenant-Id": "t2"})
        assert r.status_code == 404, f"tenant t2 asked for tenant t1's run and got {r.status_code}: {r.text}; another tenant's run answers 404, like one that does not exist"
        r = await _report(c, "r1")
        assert r.status_code == 200, f"the owner t1 still gets its report, got {r.status_code}: {r.text}"


async def check_min_samples(ctx):
    _seed(ctx, "r12", 12, 12)
    _seed(ctx, "r199", 199, 199)
    _seed(ctx, "r200", 200, 190)
    async with _api(ctx) as c:
        for run_id, n in (("r12", 12), ("r199", 199)):
            body = await _body(c, run_id)
            assert body.get("status") == "pending", f"a run with {n} scored samples, every one passing, reported status {body.get('status')!r}: below MIN_SCORED_SAMPLES = 200 it is pending, not judged"
        body = await _body(c, "r200")
        assert body.get("status") == "passed", f"200 scored samples at 0.95 are judged and pass, got {body}"


async def check_threshold_config(ctx):
    _seed(ctx, "r85", 300, 255)
    _seed(ctx, "r90", 300, 270)
    async with _api(ctx) as c:
        body = await _body(c, "r85", "?threshold=0.5")
        assert body.get("status") == "failed", f"a run at 0.85 asked with ?threshold=0.5 reported {body.get('status')!r}: the bar is RELEASE_THRESHOLD = 0.9 from server config, not the caller's"
        assert body.get("threshold") == 0.9, f"the report states the bar it applied, 0.9, got {body.get('threshold')!r}"
        body = await _body(c, "r90")
        assert body.get("status") == "passed", f"a run at exactly 0.9 meets RELEASE_THRESHOLD and passes, got {body}"


async def check_fallback_share(ctx):
    _seed(ctx, "r-fb", 300, 290, fallback=120)
    _seed(ctx, "r-ok", 300, 290, fallback=30)
    async with _api(ctx) as c:
        body = await _body(c, "r-fb")
        assert body.get("status") == "unreliable", f"120 of 300 samples were scored by the string metric and the run reported {body.get('status')!r}: above MAX_FALLBACK_SHARE = 0.2 the judge barely saw it, so it is unreliable"
        assert body.get("fallback") == 120, f"the report carries the fallback count, got {body.get('fallback')!r}"
        body = await _body(c, "r-ok")
        assert body.get("status") == "passed", f"30 of 300 fallbacks is within the share: the run is judged and passes at 0.97, got {body}"


async def check_fresh_report(ctx):
    _seed(ctx, "r1", 250, 240, updated_at=1_700_000_000)
    async with _api(ctx) as c:
        first = await _body(c, "r1")
        assert first.get("status") == "passed", f"250 samples at 0.96 pass, got {first}"
        ctx.redis.hset("evals:progress:r1", mapping={"scored": 300, "failed": 60, "updated_at": 1_700_000_300})
        second = await _body(c, "r1")
        assert (second.get("scored"), second.get("passed"), second.get("failed")) == (300, 240, 60), f"the last 50 samples all failed after the first read and the report still says {second}: read the counters on every request"
        assert second.get("status") == "failed", f"240 of 300 is 0.8, below the bar: the gate must close the moment the counters move, got {second.get('status')!r}"
        assert second.get("updated_at") == 1_700_000_300, f"the report carries the progress hash's updated_at, got {second.get('updated_at')!r}"
`,
    typescript: `const TENANT = {'X-Tenant-Id': 't1'};

function seed(ctx, runId: string, scored: number, passed: number, {fallback = 0, tenant = 't1', updatedAt = 1_700_000_000} = {}) {
  const row = {run_id: runId, status: 'queued', dataset_id: 'gs-support-v3', model_version: 'support-bot-2026-10', sample_budget: 500, tenant};
  ctx.redis.set(\`evals:run:\${runId}\`, JSON.stringify(row));
  ctx.redis.hset(\`evals:progress:\${runId}\`, 'scored', scored, 'passed', passed, 'failed', scored - passed, 'fallback', fallback, 'updated_at', updatedAt);
}

function api(ctx) {
  return ctx.client(ctx.load('read').app);
}

const report = (c, runId: string, headers: Record<string, string> = TENANT, query = '') => c.get(\`/v1/evals/runs/\${runId}\${query}\`, {headers});

async function body(c, runId: string, query = '') {
  const r = await report(c, runId, TENANT, query);
  assert.equal(r.status, 200, \`the report of \${runId} answered \${r.status}: \${r.text}\`);
  return r.json();
}

export async function check_route(ctx) {
  seed(ctx, 'r1', 250, 240);
  const c = api(ctx);
  let r = await report(c, 'r1', {});
  assert.equal(r.status, 401, \`without X-Tenant-Id the report must answer 401, got \${r.status}\`);
  r = await report(c, 'nope');
  assert.equal(r.status, 404, \`an unknown run must answer 404, got \${r.status}\`);
  const b = await body(c, 'r1');
  for (const key of ['run_id', 'status', 'scored', 'passed', 'failed', 'pass_rate']) assert(key in b, \`the report lacks \${key}: \${JSON.stringify(b)}\`);
  assert(b.run_id === 'r1' && b.scored === 250 && b.passed === 240 && b.failed === 10, \`the report carries the run's counters: \${JSON.stringify(b)}\`);
  assert(Math.abs(b.pass_rate - 0.96) < 1e-9, \`pass_rate is passed / scored = 0.96, got \${b.pass_rate}\`);
  assert.equal(b.status, 'passed', \`250 samples at 0.96 pass, got \${JSON.stringify(b)}\`);
}

export async function check_tenant_scope(ctx) {
  seed(ctx, 'r1', 250, 240, {tenant: 't1'});
  const c = api(ctx);
  let r = await report(c, 'r1', {'X-Tenant-Id': 't2'});
  assert.equal(r.status, 404, \`tenant t2 asked for tenant t1's run and got \${r.status}: \${r.text}; another tenant's run answers 404, like one that does not exist\`);
  r = await report(c, 'r1');
  assert.equal(r.status, 200, \`the owner t1 still gets its report, got \${r.status}: \${r.text}\`);
}

export async function check_min_samples(ctx) {
  seed(ctx, 'r12', 12, 12);
  seed(ctx, 'r199', 199, 199);
  seed(ctx, 'r200', 200, 190);
  const c = api(ctx);
  for (const [runId, n] of [['r12', 12], ['r199', 199]] as const) {
    const b = await body(c, runId);
    assert.equal(b.status, 'pending', \`a run with \${n} scored samples, every one passing, reported status \${JSON.stringify(b.status)}: below MIN_SCORED_SAMPLES = 200 it is pending, not judged\`);
  }
  const b = await body(c, 'r200');
  assert.equal(b.status, 'passed', \`200 scored samples at 0.95 are judged and pass, got \${JSON.stringify(b)}\`);
}

export async function check_threshold_config(ctx) {
  seed(ctx, 'r85', 300, 255);
  seed(ctx, 'r90', 300, 270);
  const c = api(ctx);
  let b = await body(c, 'r85', '?threshold=0.5');
  assert.equal(b.status, 'failed', \`a run at 0.85 asked with ?threshold=0.5 reported \${JSON.stringify(b.status)}: the bar is RELEASE_THRESHOLD = 0.9 from server config, not the caller's\`);
  assert.equal(b.threshold, 0.9, \`the report states the bar it applied, 0.9, got \${JSON.stringify(b.threshold)}\`);
  b = await body(c, 'r90');
  assert.equal(b.status, 'passed', \`a run at exactly 0.9 meets RELEASE_THRESHOLD and passes, got \${JSON.stringify(b)}\`);
}

export async function check_fallback_share(ctx) {
  seed(ctx, 'r-fb', 300, 290, {fallback: 120});
  seed(ctx, 'r-ok', 300, 290, {fallback: 30});
  const c = api(ctx);
  let b = await body(c, 'r-fb');
  assert.equal(b.status, 'unreliable', \`120 of 300 samples were scored by the string metric and the run reported \${JSON.stringify(b.status)}: above MAX_FALLBACK_SHARE = 0.2 the judge barely saw it, so it is unreliable\`);
  assert.equal(b.fallback, 120, \`the report carries the fallback count, got \${JSON.stringify(b.fallback)}\`);
  b = await body(c, 'r-ok');
  assert.equal(b.status, 'passed', \`30 of 300 fallbacks is within the share: the run is judged and passes at 0.97, got \${JSON.stringify(b)}\`);
}

export async function check_fresh_report(ctx) {
  seed(ctx, 'r1', 250, 240);
  const c = api(ctx);
  const first = await body(c, 'r1');
  assert.equal(first.status, 'passed', \`250 samples at 0.96 pass, got \${JSON.stringify(first)}\`);
  ctx.redis.hset('evals:progress:r1', 'scored', 300, 'failed', 60, 'updated_at', 1_700_000_300);
  const second = await body(c, 'r1');
  assert.deepEqual([second.scored, second.passed, second.failed], [300, 240, 60], \`the last 50 samples all failed after the first read and the report still says \${JSON.stringify(second)}: read the counters on every request\`);
  assert.equal(second.status, 'failed', \`240 of 300 is 0.8, below the bar: the gate must close the moment the counters move, got \${JSON.stringify(second.status)}\`);
  assert.equal(second.updated_at, 1_700_000_300, \`the report carries the progress hash's updated_at, got \${JSON.stringify(second.updated_at)}\`);
}
`,
    go: `package main

import (
	"encoding/json"
	"math"
	"net/http"

	"leetbuild/harness"
)

func readSeed(ctx *harness.Ctx, runID string, scored, passed, fallback int, tenant string, updatedAt int64) {
	row, _ := json.Marshal(map[string]any{"run_id": runID, "status": "queued", "dataset_id": "gs-support-v3", "model_version": "support-bot-2026-10", "sample_budget": 500, "tenant": tenant})
	ctx.Redis.Set("evals:run:"+runID, string(row))
	ctx.Redis.Do("HSET", "evals:progress:"+runID, "scored", scored, "passed", passed, "failed", scored-passed, "fallback", fallback, "updated_at", updatedAt)
}

func readClient(ctx *harness.Ctx) *harness.HTTP {
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

func readBody(ctx *harness.Ctx, c *harness.HTTP, path string) map[string]any {
	r := c.Get(path, "X-Tenant-Id", "t1")
	ctx.Equal(r.Status, 200, "the report %s (%s)", path, r.Text())
	body, ok := r.JSON().(map[string]any)
	ctx.Assert(ok, "the report must be a JSON object: %s", r.Text())
	return body
}

func CheckRoute(ctx *harness.Ctx) {
	readSeed(ctx, "r1", 250, 240, 0, "t1", 1_700_000_000)
	c := readClient(ctx)
	ctx.Equal(c.Get("/v1/evals/runs/r1").Status, 401, "without X-Tenant-Id the report")
	ctx.Equal(c.Get("/v1/evals/runs/nope", "X-Tenant-Id", "t1").Status, 404, "an unknown run")
	body := readBody(ctx, c, "/v1/evals/runs/r1")
	for _, key := range []string{"run_id", "status", "scored", "passed", "failed", "pass_rate"} {
		_, ok := body[key]
		ctx.Assert(ok, "the report lacks %s: %v", key, body)
	}
	ctx.Equal([]any{body["run_id"], body["scored"], body["passed"], body["failed"]}, []any{"r1", 250, 240, 10}, "the report carries the run's counters")
	rate, _ := body["pass_rate"].(float64)
	ctx.Assert(math.Abs(rate-0.96) < 1e-9, "pass_rate is passed / scored = 0.96, got %v", body["pass_rate"])
	ctx.Equal(body["status"], "passed", "250 samples at 0.96 pass; the status")
}

func CheckTenantScope(ctx *harness.Ctx) {
	readSeed(ctx, "r1", 250, 240, 0, "t1", 1_700_000_000)
	c := readClient(ctx)
	r := c.Get("/v1/evals/runs/r1", "X-Tenant-Id", "t2")
	ctx.Equal(r.Status, 404, "tenant t2 asked for tenant t1's run (%s): another tenant's run answers 404, like one that does not exist", r.Text())
	ctx.Equal(c.Get("/v1/evals/runs/r1", "X-Tenant-Id", "t1").Status, 200, "the owner t1 still gets its report")
}

func CheckMinSamples(ctx *harness.Ctx) {
	readSeed(ctx, "r12", 12, 12, 0, "t1", 1_700_000_000)
	readSeed(ctx, "r199", 199, 199, 0, "t1", 1_700_000_000)
	readSeed(ctx, "r200", 200, 190, 0, "t1", 1_700_000_000)
	c := readClient(ctx)
	for _, runID := range []string{"r12", "r199"} {
		body := readBody(ctx, c, "/v1/evals/runs/"+runID)
		ctx.Equal(body["status"], "pending", "a run with %v scored samples, every one passing: below minScoredSamples = 200 it is pending, not judged; the status", body["scored"])
	}
	ctx.Equal(readBody(ctx, c, "/v1/evals/runs/r200")["status"], "passed", "200 scored samples at 0.95 are judged and pass; the status")
}

func CheckThresholdConfig(ctx *harness.Ctx) {
	readSeed(ctx, "r85", 300, 255, 0, "t1", 1_700_000_000)
	readSeed(ctx, "r90", 300, 270, 0, "t1", 1_700_000_000)
	c := readClient(ctx)
	body := readBody(ctx, c, "/v1/evals/runs/r85?threshold=0.5")
	ctx.Equal(body["status"], "failed", "a run at 0.85 asked with ?threshold=0.5: the bar is releaseThreshold = 0.9 from server config, not the caller's; the status")
	ctx.Equal(body["threshold"], 0.9, "the report states the bar it applied")
	ctx.Equal(readBody(ctx, c, "/v1/evals/runs/r90")["status"], "passed", "a run at exactly 0.9 meets releaseThreshold and passes; the status")
}

func CheckFallbackShare(ctx *harness.Ctx) {
	readSeed(ctx, "r-fb", 300, 290, 120, "t1", 1_700_000_000)
	readSeed(ctx, "r-ok", 300, 290, 30, "t1", 1_700_000_000)
	c := readClient(ctx)
	body := readBody(ctx, c, "/v1/evals/runs/r-fb")
	ctx.Equal(body["status"], "unreliable", "120 of 300 samples were scored by the string metric: above maxFallbackShare = 0.2 the judge barely saw the run, so it is unreliable; the status")
	ctx.Equal(body["fallback"], 120, "the report carries the fallback count")
	ctx.Equal(readBody(ctx, c, "/v1/evals/runs/r-ok")["status"], "passed", "30 of 300 fallbacks is within the share: the run is judged and passes at 0.97; the status")
}

func CheckFreshReport(ctx *harness.Ctx) {
	readSeed(ctx, "r1", 250, 240, 0, "t1", 1_700_000_000)
	c := readClient(ctx)
	ctx.Equal(readBody(ctx, c, "/v1/evals/runs/r1")["status"], "passed", "250 samples at 0.96 pass; the status")
	ctx.Redis.Do("HSET", "evals:progress:r1", "scored", 300, "failed", 60, "updated_at", 1_700_000_300)
	second := readBody(ctx, c, "/v1/evals/runs/r1")
	ctx.Equal([]any{second["scored"], second["passed"], second["failed"]}, []any{300, 240, 60}, "the last 50 samples all failed after the first read (read the counters on every request); scored, passed, failed")
	ctx.Equal(second["status"], "failed", "240 of 300 is 0.8, below the bar: the gate must close the moment the counters move; the status")
	ctx.Equal(second["updated_at"], 1_700_000_300, "the report carries the progress hash's updated_at")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <cmath>
#include <string>

namespace {

using json = nlohmann::json;

void readSeed(harness::Ctx& ctx, const std::string& run_id, int scored, int passed, int fallback = 0, const std::string& tenant = "t1", long long updated_at = 1700000000) {
  const json row = {{"run_id", run_id}, {"status", "queued"}, {"dataset_id", "gs-support-v3"}, {"model_version", "support-bot-2026-10"}, {"sample_budget", 500}, {"tenant", tenant}};
  ctx.Redis.Set("evals:run:" + run_id, row.dump());
  ctx.Redis.Do("HSET", "evals:progress:" + run_id, "scored", scored, "passed", passed, "failed", scored - passed, "fallback", fallback, "updated_at", updated_at);
}

struct Api {
  httplib::Server svr;
  harness::HTTP http;
  explicit Api(harness::Ctx& ctx) : http(ctx.HTTP(svr)) { register_routes(svr); }
};

json readBody(harness::Ctx& ctx, Api& api, const std::string& path) {
  const auto r = api.http.Get(path, "X-Tenant-Id", "t1");
  ctx.Equal(r.Status, 200, "the report %s (%s)", path, r.Text());
  const json body = json::parse(r.Text(), nullptr, false);
  ctx.Assert(body.is_object(), "the report must be a JSON object: %s", r.Text());
  return body;
}

json field(const json& body, const std::string& key) { return body.is_object() && body.contains(key) ? body[key] : json(); }

}  // namespace

void CheckRoute(harness::Ctx& ctx) {
  readSeed(ctx, "r1", 250, 240);
  Api api(ctx);
  ctx.Equal(api.http.Get("/v1/evals/runs/r1").Status, 401, "without X-Tenant-Id the report");
  ctx.Equal(api.http.Get("/v1/evals/runs/nope", "X-Tenant-Id", "t1").Status, 404, "an unknown run");
  const json body = readBody(ctx, api, "/v1/evals/runs/r1");
  for (const char* key : {"run_id", "status", "scored", "passed", "failed", "pass_rate"}) ctx.Assert(body.contains(key), "the report lacks %s: %s", key, body.dump());
  ctx.Assert(body["run_id"] == "r1" && body["scored"] == 250 && body["passed"] == 240 && body["failed"] == 10, "the report carries the run's counters: %s", body.dump());
  ctx.Assert(body["pass_rate"].is_number() && std::fabs(body["pass_rate"].get<double>() - 0.96) < 1e-9, "pass_rate is passed / scored = 0.96, got %s", field(body, "pass_rate").dump());
  ctx.Equal(field(body, "status"), json("passed"), "250 samples at 0.96 pass; the status");
}

void CheckTenantScope(harness::Ctx& ctx) {
  readSeed(ctx, "r1", 250, 240, 0, "t1");
  Api api(ctx);
  const auto r = api.http.Get("/v1/evals/runs/r1", "X-Tenant-Id", "t2");
  ctx.Equal(r.Status, 404, "tenant t2 asked for tenant t1's run (%s): another tenant's run answers 404, like one that does not exist", r.Text());
  ctx.Equal(api.http.Get("/v1/evals/runs/r1", "X-Tenant-Id", "t1").Status, 200, "the owner t1 still gets its report");
}

void CheckMinSamples(harness::Ctx& ctx) {
  readSeed(ctx, "r12", 12, 12);
  readSeed(ctx, "r199", 199, 199);
  readSeed(ctx, "r200", 200, 190);
  Api api(ctx);
  for (const std::string run_id : {"r12", "r199"}) {
    const json body = readBody(ctx, api, "/v1/evals/runs/" + run_id);
    ctx.Equal(field(body, "status"), json("pending"), "a run with %s scored samples, every one passing: below kMinScoredSamples = 200 it is pending, not judged; the status", field(body, "scored").dump());
  }
  ctx.Equal(field(readBody(ctx, api, "/v1/evals/runs/r200"), "status"), json("passed"), "200 scored samples at 0.95 are judged and pass; the status");
}

void CheckThresholdConfig(harness::Ctx& ctx) {
  readSeed(ctx, "r85", 300, 255);
  readSeed(ctx, "r90", 300, 270);
  Api api(ctx);
  const json body = readBody(ctx, api, "/v1/evals/runs/r85?threshold=0.5");
  ctx.Equal(field(body, "status"), json("failed"), "a run at 0.85 asked with ?threshold=0.5: the bar is kReleaseThreshold = 0.9 from server config, not the caller's; the status");
  ctx.Equal(field(body, "threshold"), json(0.9), "the report states the bar it applied");
  ctx.Equal(field(readBody(ctx, api, "/v1/evals/runs/r90"), "status"), json("passed"), "a run at exactly 0.9 meets kReleaseThreshold and passes; the status");
}

void CheckFallbackShare(harness::Ctx& ctx) {
  readSeed(ctx, "r-fb", 300, 290, 120);
  readSeed(ctx, "r-ok", 300, 290, 30);
  Api api(ctx);
  const json body = readBody(ctx, api, "/v1/evals/runs/r-fb");
  ctx.Equal(field(body, "status"), json("unreliable"), "120 of 300 samples were scored by the string metric: above kMaxFallbackShare = 0.2 the judge barely saw the run, so it is unreliable; the status");
  ctx.Equal(field(body, "fallback"), json(120), "the report carries the fallback count");
  ctx.Equal(field(readBody(ctx, api, "/v1/evals/runs/r-ok"), "status"), json("passed"), "30 of 300 fallbacks is within the share: the run is judged and passes at 0.97; the status");
}

void CheckFreshReport(harness::Ctx& ctx) {
  readSeed(ctx, "r1", 250, 240);
  Api api(ctx);
  ctx.Equal(field(readBody(ctx, api, "/v1/evals/runs/r1"), "status"), json("passed"), "250 samples at 0.96 pass; the status");
  ctx.Redis.Do("HSET", "evals:progress:r1", "scored", 300, "failed", 60, "updated_at", 1700000300);
  const json second = readBody(ctx, api, "/v1/evals/runs/r1");
  ctx.Assert(second["scored"] == 300 && second["passed"] == 240 && second["failed"] == 60, "the last 50 samples all failed after the first read and the report still says %s: read the counters on every request", second.dump());
  ctx.Equal(field(second, "status"), json("failed"), "240 of 300 is 0.8, below the bar: the gate must close the moment the counters move; the status");
  ctx.Equal(field(second, "updated_at"), json(1700000300), "the report carries the progress hash's updated_at");
}
`,
  },
  debrief: `A gate is only as good as the record it reads, and each fix narrows what the number can mean. The floor says a rate over twelve samples is noise, not a verdict; the server-side threshold says the bar belongs to the release process, not to whoever calls it; the fallback share says a score the judge never saw cannot certify a model; the tenant check says a run id is not a capability. Reading the hash on every request costs one round trip and buys a report that changes the moment the last sample lands. Production gates also compare against the previous release on the same golden-set version, report a confidence interval beside the bare rate, and record each decision with the counters it was made on.`,
};
