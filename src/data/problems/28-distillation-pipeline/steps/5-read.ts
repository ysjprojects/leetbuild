import type {Step} from '@/lib/types';

export const readStep: Step = {
  id: 'read',
  title: 'GET /v1/distill/jobs/{id}: the acceptance report',
  concept: 'http',
  guides: ['honest-reads'],
  file: 'read',
  focus: ['client', 'api', 'redis'],
  task: `## Task

**Starting point.** The starter serves \`GET /v1/distill/jobs/{job_id}\`: 401 without \`X-Tenant-Id\`, 404
when the provided job store has no such job for the tenant, then \`{job_id, status, sampled, accepted,
rejected, acceptance_rate}\` from the progress hash of \`distill/config\`, read once per job and kept in
a process-local cache, with \`accepted\` computed as \`sampled - rejected\`. The dashboard shows a healthy
percentage. It hides four flaws.

**Failure mode the checks target.** Deriving \`accepted\` from the other two is the one that ships a bad
student: a sample reserved by a worker that died before it recorded is neither accepted nor rejected,
and the arithmetic quietly calls it accepted. The cache makes it worse: the report cannot change when a
rejection lands after the first read, so a run looks clean for as long as the process lives.

Requirements:

- \`sampled\`, \`accepted\`, \`rejected\` and \`duplicate\` come from the **live** progress hash on every
  request, with the \`updated_at\` stamp step 2 wrote, so two reports can be told apart.
- The counts **reconcile**: \`accepted + rejected == sampled\`, or the report is **409** rather than a
  plausible number.
- \`reasons\` is the rejection breakdown from \`distill:reasons:{job_id}\` (\`refusal\`, \`empty\`,
  \`deadline\`, \`unavailable\`, \`budget\`), so a 40 percent rejection rate can be explained.
- An acceptance rate above \`UNRELIABLE_ACCEPTANCE_RATE\` (0.95) is **flagged** as
  \`implausible_acceptance_rate\` rather than certified: a filter that accepts nearly everything is
  usually a filter that is not running. The flag is \`null\` otherwise.
- The report is **200** with \`{job_id, status, sampled, accepted, rejected, duplicate, reasons,
  acceptance_rate, updated_at, flagged}\`.`,
  sequence: {
    participants: ['Client', 'Distill API', 'Redis'],
    messages: [
      {from: 'Client', to: 'Distill API', label: 'GET /v1/distill/jobs/{id} · X-Tenant-Id', kind: 'sync'},
      {from: 'Distill API', to: 'Redis', label: 'GET distill:job:{id}', kind: 'sync'},
      {from: 'Distill API', to: 'Redis', label: 'HGETALL progress · HGETALL reasons', kind: 'sync'},
      {
        from: 'Redis',
        to: 'Distill API',
        label: '{sampled 100, accepted 98, rejected 2, updated_at} · {refusal 2}',
        kind: 'reply',
      },
      {
        from: 'Distill API',
        to: 'Distill API',
        label: 'accepted + rejected == sampled · rate 0.98 > 0.95',
        kind: 'sync',
      },
      {from: 'Distill API', to: 'Client', label: '200 {…, flagged: implausible_acceptance_rate}', kind: 'reply'},
    ],
  },
  hints: [
    'Symptom: a job whose worker crashed mid-sample still reports every sample accepted, a rejection that landed after the first dashboard load never shows, and a run that accepted 99 percent is celebrated.',
    'Mechanism: `accepted = sampled - rejected` assumes every sample ended in one of two ways, the cache keeps the first reading per job for the life of the process, and nothing reads the reasons hash or compares the rate to a ceiling.',
    'Change: HGETALL the progress and reasons hashes on every request, answer 409 when `accepted + rejected != sampled`, report `reasons` and `updated_at`, and set `flagged` when `sampled > 0 and rate > UNRELIABLE_ACCEPTANCE_RATE`.',
  ],
  checks: [
    {
      id: 'route',
      title: 'Handles GET /v1/distill/jobs/{id}',
      detail:
        "The report route answers 401 without X-Tenant-Id, 404 for an unknown job or another tenant's job, and 200 with the job's counts.",
      match: {
        python: {all: [/@app\.get\(\s*["']\/v1\/distill\/jobs\/\{job_id\}["']/]},
        typescript: {all: [/app\.get\(\s*['"]\/v1\/distill\/jobs\/:job_id['"]/]},
        go: {all: [/HandleFunc\(\s*"GET \/v1\/distill\/jobs\/\{jobID\}"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"distill"\s*\/\s*"jobs"\s*\/\s*Segment\s*\)/, /\bget\s*\{/]},
        cpp: {all: [/svr\.Get\([^,\n]*v1\/distill\/jobs\//]},
      },
    },
    {
      id: 'reconcile',
      title: 'Answers 409 when accepted + rejected differs from sampled',
      detail:
        'The report compares accepted + rejected with sampled and answers 409 when they differ, instead of deriving one count from the others. The starter computes accepted as sampled - rejected.',
      match: {
        python: {
          all: [
            /accepted\s*\+\s*rejected\s*!=\s*sampled|sampled\s*!=\s*accepted\s*\+\s*rejected/,
            /status_code\s*=\s*409/,
          ],
          none: [/sampled\s*-\s*rejected/],
        },
        typescript: {
          all: [
            /accepted\s*\+\s*rejected\s*!==\s*sampled|sampled\s*!==\s*accepted\s*\+\s*rejected/,
            /code\(\s*409\s*\)/,
          ],
          none: [/sampled\s*-\s*rejected/],
        },
        go: {
          all: [
            /accepted\s*\+\s*rejected\s*!=\s*sampled|sampled\s*!=\s*accepted\s*\+\s*rejected/,
            /StatusConflict|\b409\b/,
          ],
          none: [/sampled\s*-\s*rejected/],
        },
        scala: {
          all: [
            /accepted\s*\+\s*rejected\s*!=\s*sampled|sampled\s*!=\s*accepted\s*\+\s*rejected/,
            /StatusCodes\.Conflict/,
          ],
          none: [/sampled\s*-\s*rejected/],
        },
        cpp: {
          all: [/accepted\s*\+\s*rejected\s*!=\s*sampled|sampled\s*!=\s*accepted\s*\+\s*rejected/, /\b409\b/],
          none: [/sampled\s*-\s*rejected/],
        },
      },
    },
    {
      id: 'reasons',
      title: 'Reports the rejection reasons by name',
      detail:
        'The reply carries reasons, the distill:reasons:{job_id} hash as numbers, beside rejected. The starter reports a single rejected number.',
      match: {
        python: {all: [/reasons_key\(|distill:reasons:/, /["']reasons["']\s*:/]},
        typescript: {all: [/reasonsKey\(|distill:reasons:/, /\breasons\b/]},
        go: {all: [/ReasonsKey\(|distill:reasons:/, /"reasons"/]},
        scala: {all: [/reasonsKey\(|distill:reasons:/, /"reasons"/]},
        cpp: {all: [/reasons_key\(|distill:reasons:/, /"reasons"/]},
      },
    },
    {
      id: 'implausible-rate',
      title: 'Flags an acceptance rate above 95 percent',
      detail:
        'With samples and a rate above UNRELIABLE_ACCEPTANCE_RATE the report says flagged: implausible_acceptance_rate; at or below it, and for an empty job, flagged is null. The starter has no ceiling.',
      match: {
        python: {all: [/UNRELIABLE_ACCEPTANCE_RATE/, /implausible_acceptance_rate/]},
        typescript: {all: [/UNRELIABLE_ACCEPTANCE_RATE/, /implausible_acceptance_rate/]},
        go: {all: [/unreliableAcceptanceRate/, /implausible_acceptance_rate/]},
        scala: {all: [/UnreliableAcceptanceRate/, /implausible_acceptance_rate/]},
        cpp: {all: [/kUnreliableAcceptanceRate/, /implausible_acceptance_rate/]},
      },
    },
    {
      id: 'live-counters',
      title: 'Reads the live counters and reports updated_at',
      detail:
        'Every request reads the progress hash (HGETALL) and reports its updated_at, so a rejection that lands between two reads shows in the second. The starter serves the first reading from a process-local cache.',
      match: {
        python: {all: [/hgetall\(/, /updated_at/], none: [/REPORT_CACHE/]},
        typescript: {all: [/hgetall\(/, /updated_at/], none: [/REPORT_CACHE/]},
        go: {all: [/HGetAll\(/, /updated_at/], none: [/reportCache/]},
        scala: {all: [/hgetAll\(/, /updated_at/], none: [/reportCache/]},
        cpp: {all: [/hgetall\(/, /updated_at/], none: [/report_cache/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import redis
from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse

from distill.config import progress_key
from distill.jobs import store

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)

REPORT_CACHE: dict[str, dict[str, int]] = {}


@app.get("/v1/distill/jobs/{job_id}")
def read_job(job_id: str, tenant: str | None = Header(default=None, alias="X-Tenant-Id")) -> JSONResponse:
    # TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
    if tenant is None or tenant == "":
        raise HTTPException(status_code=401, detail="missing X-Tenant-Id")
    job = store.by_id(job_id)
    if job is None or job.get("tenant") != tenant:
        raise HTTPException(status_code=404, detail="unknown job")
    counts = REPORT_CACHE.get(job_id)
    if counts is None:
        counts = {key: int(value) for key, value in r.hgetall(progress_key(job_id)).items()}
        REPORT_CACHE[job_id] = counts
    sampled = counts.get("sampled", 0)
    rejected = counts.get("rejected", 0)
    accepted = sampled - rejected
    return JSONResponse(
        {
            "job_id": job_id,
            "status": job["status"],
            "sampled": sampled,
            "accepted": accepted,
            "rejected": rejected,
            "acceptance_rate": accepted / sampled if sampled else 0.0,
        },
        status_code=200,
    )
`,
      solution: `import logging

import redis
from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse

from distill.config import progress_key, reasons_key
from distill.jobs import store

app = FastAPI()
logger = logging.getLogger("distill.report")
r = redis.Redis(host="redis", port=6379, decode_responses=True)

UNRELIABLE_ACCEPTANCE_RATE = 0.95


@app.get("/v1/distill/jobs/{job_id}")
def read_job(job_id: str, tenant: str | None = Header(default=None, alias="X-Tenant-Id")) -> JSONResponse:
    if tenant is None or tenant == "":
        raise HTTPException(status_code=401, detail="missing X-Tenant-Id")
    job = store.by_id(job_id)
    if job is None or job.get("tenant") != tenant:
        raise HTTPException(status_code=404, detail="unknown job")

    pipe = r.pipeline()
    pipe.hgetall(progress_key(job_id))
    pipe.hgetall(reasons_key(job_id))
    progress, reasons = pipe.execute()
    counts = {key: int(value) for key, value in progress.items()}
    sampled = counts.get("sampled", 0)
    accepted = counts.get("accepted", 0)
    rejected = counts.get("rejected", 0)
    if accepted + rejected != sampled:
        logger.error("distill report job=%s counters do not reconcile: %s", job_id, counts)
        raise HTTPException(status_code=409, detail=f"job {job_id} counters do not reconcile")

    rate = accepted / sampled if sampled else 0.0
    flagged = "implausible_acceptance_rate" if sampled > 0 and rate > UNRELIABLE_ACCEPTANCE_RATE else None
    if flagged:
        logger.warning("distill report job=%s rate=%.3f: review a sample by hand", job_id, rate)
    return JSONResponse(
        {
            "job_id": job_id,
            "status": job["status"],
            "sampled": sampled,
            "accepted": accepted,
            "rejected": rejected,
            "duplicate": counts.get("duplicate", 0),
            "reasons": {key: int(value) for key, value in reasons.items()},
            "acceptance_rate": rate,
            "updated_at": counts.get("updated_at", 0),
            "flagged": flagged,
        },
        status_code=200,
    )
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';
import Redis from 'ioredis';

import {progressKey} from 'distill/config';
import {store} from 'distill/jobs';

export const app = Fastify();
const redis = new Redis({host: 'redis', port: 6379});

const REPORT_CACHE: Record<string, Record<string, number>> = {};

app.get('/v1/distill/jobs/:job_id', async (request, reply) => {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing X-Tenant-Id'});
  const {job_id: jobId} = request.params as {job_id: string};
  const job = await store.byId(jobId);
  if (job === null || job.tenant !== tenant) return reply.code(404).send({error: 'unknown job'});
  let counts = REPORT_CACHE[jobId];
  if (counts === undefined) {
    counts = Object.fromEntries(Object.entries(await redis.hgetall(progressKey(jobId))).map(([k, v]) => [k, Number(v)]));
    REPORT_CACHE[jobId] = counts;
  }
  const sampled = counts.sampled ?? 0;
  const rejected = counts.rejected ?? 0;
  const accepted = sampled - rejected;
  return reply.code(200).send({
    job_id: jobId,
    status: job.status,
    sampled,
    accepted,
    rejected,
    acceptance_rate: sampled > 0 ? accepted / sampled : 0,
  });
});
`,
      solution: `import Fastify from 'fastify';
import Redis from 'ioredis';

import {progressKey, reasonsKey} from 'distill/config';
import {store} from 'distill/jobs';

export const app = Fastify();
const redis = new Redis({host: 'redis', port: 6379});

export const UNRELIABLE_ACCEPTANCE_RATE = 0.95;

const numbers = (hash: Record<string, string>): Record<string, number> =>
  Object.fromEntries(Object.entries(hash).map(([k, v]) => [k, Number(v)]));

app.get('/v1/distill/jobs/:job_id', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing X-Tenant-Id'});
  const {job_id: jobId} = request.params as {job_id: string};
  const job = await store.byId(jobId);
  if (job === null || job.tenant !== tenant) return reply.code(404).send({error: 'unknown job'});

  const counts = numbers(await redis.hgetall(progressKey(jobId)));
  const reasons = numbers(await redis.hgetall(reasonsKey(jobId)));
  const sampled = counts.sampled ?? 0;
  const accepted = counts.accepted ?? 0;
  const rejected = counts.rejected ?? 0;
  if (accepted + rejected !== sampled) {
    request.log.error({job_id: jobId, counts}, 'counters do not reconcile');
    return reply.code(409).send({error: \`job \${jobId} counters do not reconcile\`});
  }

  const rate = sampled > 0 ? accepted / sampled : 0;
  const flagged = sampled > 0 && rate > UNRELIABLE_ACCEPTANCE_RATE ? 'implausible_acceptance_rate' : null;
  if (flagged !== null) request.log.warn({job_id: jobId, rate}, 'review a sample by hand');
  return reply.code(200).send({
    job_id: jobId,
    status: job.status,
    sampled,
    accepted,
    rejected,
    duplicate: counts.duplicate ?? 0,
    reasons,
    acceptance_rate: rate,
    updated_at: counts.updated_at ?? 0,
    flagged,
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

	"distill/config" // config.ProgressKey, config.ReasonsKey — provided
	"distill/jobs"   // jobs.ByID(ctx, jobID) — provided
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

var reportCache = map[string]map[string]int64{}

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
	if job == nil || job.Tenant != tenant {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "unknown job"})
		return
	}
	counts, ok := reportCache[jobID]
	if !ok {
		hash, err := rdb.HGetAll(r.Context(), config.ProgressKey(jobID)).Result()
		if err != nil {
			writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
			return
		}
		counts = counters(hash)
		reportCache[jobID] = counts
	}
	sampled, rejected := counts["sampled"], counts["rejected"]
	accepted := sampled - rejected
	rate := 0.0
	if sampled > 0 {
		rate = float64(accepted) / float64(sampled)
	}
	writeJSON(rw, http.StatusOK, map[string]any{
		"job_id":          jobID,
		"status":          job.Status,
		"sampled":         sampled,
		"accepted":        accepted,
		"rejected":        rejected,
		"acceptance_rate": rate,
	})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/distill/jobs/{jobID}", readJob)
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

	"distill/config" // config.ProgressKey, config.ReasonsKey — provided
	"distill/jobs"   // jobs.ByID(ctx, jobID) — provided
)

const unreliableAcceptanceRate = 0.95

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
	reasonsCmd := pipe.HGetAll(r.Context(), config.ReasonsKey(jobID))
	if _, err := pipe.Exec(r.Context()); err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	counts := counters(progressCmd.Val())
	sampled, accepted, rejected := counts["sampled"], counts["accepted"], counts["rejected"]
	if accepted+rejected != sampled {
		log.Printf("distill report job=%s counters do not reconcile: %v", jobID, counts)
		writeJSON(rw, http.StatusConflict, map[string]string{"error": "job " + jobID + " counters do not reconcile"})
		return
	}

	rate := 0.0
	if sampled > 0 {
		rate = float64(accepted) / float64(sampled)
	}
	var flagged any
	if sampled > 0 && rate > unreliableAcceptanceRate {
		flagged = "implausible_acceptance_rate"
		log.Printf("distill report job=%s rate=%.3f: review a sample by hand", jobID, rate)
	}
	writeJSON(rw, http.StatusOK, map[string]any{
		"job_id":          jobID,
		"status":          job.Status,
		"sampled":         sampled,
		"accepted":        accepted,
		"rejected":        rejected,
		"duplicate":       counts["duplicate"],
		"reasons":         counters(reasonsCmd.Val()),
		"acceptance_rate": rate,
		"updated_at":      counts["updated_at"],
		"flagged":         flagged,
	})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/distill/jobs/{jobID}", readJob)
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

import scala.collection.mutable
import scala.jdk.CollectionConverters._

import distill.{Config, Jobs}

object DistillReport {
  implicit val system: ActorSystem = ActorSystem("distill-report")
  val jedis = new JedisPooled("redis", 6379)

  private val reportCache = mutable.Map[String, Map[String, Long]]()

  val route: Route =
    path("v1" / "distill" / "jobs" / Segment) { jobId =>
      get {
        optionalHeaderValueByName("X-Tenant-Id") { tenantOpt =>
          // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
          if (!tenantOpt.exists(_.nonEmpty)) {
            complete(StatusCodes.Unauthorized, """{"error":"missing X-Tenant-Id"}""")
          } else {
            Jobs.byId(jobId).filter(_.tenant == tenantOpt.get) match {
              case None => complete(StatusCodes.NotFound, """{"error":"unknown job"}""")
              case Some(row) =>
                val counts = reportCache.getOrElseUpdate(
                  jobId,
                  jedis.hgetAll(Config.progressKey(jobId)).asScala.toMap.map { case (k, v) => k -> v.toLong }
                )
                val sampled = counts.getOrElse("sampled", 0L)
                val rejected = counts.getOrElse("rejected", 0L)
                val accepted = sampled - rejected
                val report = ujson.Obj(
                  "job_id" -> jobId,
                  "status" -> row.job.status,
                  "sampled" -> sampled,
                  "accepted" -> accepted,
                  "rejected" -> rejected,
                  "acceptance_rate" -> (if (sampled > 0) accepted.toDouble / sampled else 0.0)
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

import distill.{Config, Jobs}

object DistillReport {
  implicit val system: ActorSystem = ActorSystem("distill-report")
  val jedis = new JedisPooled("redis", 6379)

  val UnreliableAcceptanceRate = 0.95

  private def numbers(key: String): Map[String, Long] =
    jedis.hgetAll(key).asScala.toMap.map { case (k, v) => k -> v.toLong }

  val route: Route =
    path("v1" / "distill" / "jobs" / Segment) { jobId =>
      get {
        optionalHeaderValueByName("X-Tenant-Id") { tenantOpt =>
          if (!tenantOpt.exists(_.nonEmpty)) {
            complete(StatusCodes.Unauthorized, """{"error":"missing X-Tenant-Id"}""")
          } else {
            Jobs.byId(jobId).filter(_.tenant == tenantOpt.get) match {
              case None => complete(StatusCodes.NotFound, """{"error":"unknown job"}""")
              case Some(row) =>
                val counts = numbers(Config.progressKey(jobId))
                val reasons = numbers(Config.reasonsKey(jobId))
                val sampled = counts.getOrElse("sampled", 0L)
                val accepted = counts.getOrElse("accepted", 0L)
                val rejected = counts.getOrElse("rejected", 0L)
                if (accepted + rejected != sampled) {
                  system.log.error(s"distill report job=$jobId counters do not reconcile: $counts")
                  complete(StatusCodes.Conflict, s"""{"error":"job $jobId counters do not reconcile"}""")
                } else {
                  val rate = if (sampled > 0) accepted.toDouble / sampled else 0.0
                  val flagged: ujson.Value =
                    if (sampled > 0 && rate > UnreliableAcceptanceRate) ujson.Str("implausible_acceptance_rate") else ujson.Null
                  val report = ujson.Obj(
                    "job_id" -> jobId,
                    "status" -> row.job.status,
                    "sampled" -> sampled,
                    "accepted" -> accepted,
                    "rejected" -> rejected,
                    "duplicate" -> ujson.Num(counts.getOrElse("duplicate", 0L).toDouble),
                    "reasons" -> ujson.Obj.from(reasons.map { case (k, v) => k -> ujson.Num(v.toDouble) }),
                    "acceptance_rate" -> rate,
                    "updated_at" -> ujson.Num(counts.getOrElse("updated_at", 0L).toDouble),
                    "flagged" -> flagged
                  )
                  complete(HttpEntity(ContentTypes.\`application/json\`, ujson.write(report)))
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
    },
    cpp: {
      starter: `#include <httplib.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <map>
#include <string>

#include "distill/config.h"  // config::progress_key, config::reasons_key — provided
#include "distill/jobs.h"    // jobs::by_id(job_id) — provided

using json = nlohmann::json;

sw::redis::Redis redis("tcp://redis:6379");

std::map<std::string, std::map<std::string, long long>> report_cache;

std::map<std::string, long long> counters(const std::string& key) {
  std::map<std::string, long long> out;
  for (const auto& [field, value] : redis.hgetall(key)) out[field] = std::stoll(value);
  return out;
}

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
  if (!job || job->value("tenant", "") != tenant) {
    res.status = 404;
    res.set_content(R"({"error":"unknown job"})", "application/json");
    return;
  }
  auto cached = report_cache.find(job_id);
  if (cached == report_cache.end()) cached = report_cache.emplace(job_id, counters(config::progress_key(job_id))).first;
  const auto& counts = cached->second;
  const long long sampled = counts.count("sampled") ? counts.at("sampled") : 0;
  const long long rejected = counts.count("rejected") ? counts.at("rejected") : 0;
  const long long accepted = sampled - rejected;
  const json report = {
      {"job_id", job_id},
      {"status", job->value("status", "")},
      {"sampled", sampled},
      {"accepted", accepted},
      {"rejected", rejected},
      {"acceptance_rate", sampled > 0 ? static_cast<double>(accepted) / static_cast<double>(sampled) : 0.0},
  };
  res.status = 200;
  res.set_content(report.dump(), "application/json");
}

void register_routes(httplib::Server& svr) { svr.Get(R"(/v1/distill/jobs/([^/]+))", read_job); }

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

#include "distill/config.h"  // config::progress_key, config::reasons_key — provided
#include "distill/jobs.h"    // jobs::by_id(job_id) — provided

using json = nlohmann::json;

constexpr double kUnreliableAcceptanceRate = 0.95;

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

  const auto counts = counters(config::progress_key(job_id));
  const auto reasons = counters(config::reasons_key(job_id));
  const long long sampled = count_of(counts, "sampled");
  const long long accepted = count_of(counts, "accepted");
  const long long rejected = count_of(counts, "rejected");
  if (accepted + rejected != sampled) {
    std::cerr << "distill report job=" << job_id << " counters do not reconcile\\n";
    res.status = 409;
    res.set_content(json({{"error", "job " + job_id + " counters do not reconcile"}}).dump(), "application/json");
    return;
  }

  const double rate = sampled > 0 ? static_cast<double>(accepted) / static_cast<double>(sampled) : 0.0;
  json flagged = nullptr;
  if (sampled > 0 && rate > kUnreliableAcceptanceRate) {
    flagged = "implausible_acceptance_rate";
    std::cerr << "distill report job=" << job_id << " rate=" << rate << ": review a sample by hand\\n";
  }
  const json report = {
      {"job_id", job_id},
      {"status", job->value("status", "")},
      {"sampled", sampled},
      {"accepted", accepted},
      {"rejected", rejected},
      {"duplicate", count_of(counts, "duplicate")},
      {"reasons", json(reasons)},
      {"acceptance_rate", rate},
      {"updated_at", count_of(counts, "updated_at")},
      {"flagged", flagged},
  };
  res.status = 200;
  res.set_content(report.dump(), "application/json");
}

void register_routes(httplib::Server& svr) { svr.Get(R"(/v1/distill/jobs/([^/]+))", read_job); }

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
TENANT = {"X-Tenant-Id": "t1"}


def _seed(ctx, sampled, accepted, rejected, duplicate=0, reasons=None, updated_at=1_700_000_000):
    ctx.redis.set(f"distill:job:{JOB}", json.dumps({"job_id": JOB, "status": "running", "teacher": "teach-70b-v3", "dataset_id": "ds-support", "sample_cap": 1000, "sampled": 0, "accepted": 0, "rejected": 0, "tenant": "t1"}))
    ctx.redis.hset(f"distill:progress:{JOB}", mapping={"sampled": sampled, "accepted": accepted, "rejected": rejected, "duplicate": duplicate, "updated_at": updated_at})
    if reasons:
        ctx.redis.hset(f"distill:reasons:{JOB}", mapping=reasons)


def _api(ctx):
    m = ctx.load("read")
    return ctx.client(m.app)


async def _report(c, job_id=JOB, headers=TENANT):
    return await c.get(f"/v1/distill/jobs/{job_id}", headers=headers)


async def check_route(ctx):
    _seed(ctx, 10, 7, 3, reasons={"refusal": 3})
    async with _api(ctx) as c:
        r = await _report(c, headers={})
        assert r.status_code == 401, f"without X-Tenant-Id the report must answer 401, got {r.status_code}"
        r = await _report(c, job_id="nope")
        assert r.status_code == 404, f"an unknown job must answer 404, got {r.status_code}"
        r = await _report(c, headers={"X-Tenant-Id": "t2"})
        assert r.status_code == 404, f"another tenant's job must answer 404, got {r.status_code}"
        r = await _report(c)
        assert r.status_code == 200, f"the report answered {r.status_code}: {r.text}"
        body = r.json()
        for key in ("job_id", "status", "sampled", "accepted", "rejected", "acceptance_rate"):
            assert key in body, f"the report lacks {key!r}: {body}"
        assert body["job_id"] == JOB and body["status"] == "running", f"the report names the job and its status: {body}"
        assert (body["sampled"], body["accepted"], body["rejected"]) == (10, 7, 3), f"the counts must be the job's: {body}"
        assert abs(body["acceptance_rate"] - 0.7) < 1e-9, f"acceptance_rate must be accepted / sampled = 0.7, got {body['acceptance_rate']}"


async def check_reconcile(ctx):
    _seed(ctx, 10, 3, 5, reasons={"refusal": 5})  # two samples reserved by a worker that died before it recorded
    async with _api(ctx) as c:
        r = await _report(c)
        assert r.status_code == 409, f"sampled 10, accepted 3, rejected 5 do not reconcile: the report must answer 409, got {r.status_code} with {r.text} (accepted = sampled - rejected would call the two lost samples accepted)"
        ctx.redis.hset(f"distill:progress:{JOB}", "rejected", 7)
        r = await _report(c)
        assert r.status_code == 200 and r.json()["accepted"] == 3 and r.json()["rejected"] == 7, f"once the counts reconcile the report is 200 with the live accepted and rejected, got {r.status_code}: {r.text}"


async def check_reasons(ctx):
    _seed(ctx, 10, 5, 5, reasons={"refusal": 3, "empty": 1, "deadline": 1})
    async with _api(ctx) as c:
        r = await _report(c)
        assert r.status_code == 200, f"the report answered {r.status_code}: {r.text}"
        body = r.json()
        assert body.get("reasons") == {"refusal": 3, "empty": 1, "deadline": 1}, f"reasons must be the distill:reasons hash as numbers, got {body.get('reasons')!r}"
        assert body["rejected"] == 5, f"rejected stays the count: {body}"


async def check_implausible_rate(ctx):
    _seed(ctx, 100, 98, 2, reasons={"refusal": 2})
    async with _api(ctx) as c:
        r = await _report(c)
        body = r.json()
        assert r.status_code == 200 and abs(body["acceptance_rate"] - 0.98) < 1e-9, f"a 98 percent run is reported, got {r.status_code}: {r.text}"
        assert body.get("flagged") == "implausible_acceptance_rate", f"98 percent accepted is above the 95 percent ceiling and must be flagged implausible_acceptance_rate, got flagged={body.get('flagged')!r}"
        ctx.redis.hset(f"distill:progress:{JOB}", mapping={"accepted": 90, "rejected": 10})
        body = (await _report(c)).json()
        assert body.get("flagged") is None, f"90 percent is within the ceiling: flagged must be null, got {body.get('flagged')!r}"
        ctx.redis.hset(f"distill:progress:{JOB}", mapping={"sampled": 0, "accepted": 0, "rejected": 0})
        r = await _report(c)
        assert r.status_code == 200 and r.json().get("flagged") is None and r.json()["acceptance_rate"] == 0, f"an empty job has rate 0 and no flag, got {r.status_code}: {r.text}"


async def check_live_counters(ctx):
    _seed(ctx, 10, 7, 3, duplicate=2, reasons={"refusal": 3}, updated_at=1_700_000_000)
    async with _api(ctx) as c:
        first = (await _report(c)).json()
        assert first.get("updated_at") == 1_700_000_000, f"the report must carry the progress hash's updated_at, got {first.get('updated_at')!r}"
        assert first.get("duplicate") == 2, f"the report carries the duplicate count, got {first.get('duplicate')!r}"
        ctx.redis.hset(f"distill:progress:{JOB}", mapping={"sampled": 12, "rejected": 5, "updated_at": 1_700_000_300})
        ctx.redis.hincrby(f"distill:reasons:{JOB}", "deadline", 2)
        second = (await _report(c)).json()
        assert (second["sampled"], second["accepted"], second["rejected"]) == (12, 7, 5), f"two rejections landed after the first read and the report still says {second}: read the live counters on every request"
        assert second.get("updated_at") == 1_700_000_300, f"the second report must carry the new updated_at, got {second.get('updated_at')!r}"
        assert second.get("reasons", {}).get("deadline") == 2, f"the reasons are read live too: {second.get('reasons')}"
`,
    typescript: `const JOB = 'j1';
const TENANT = {'X-Tenant-Id': 't1'};

function seed(ctx, sampled: number, accepted: number, rejected: number, {duplicate = 0, reasons = {} as Record<string, number>, updatedAt = 1_700_000_000} = {}) {
  ctx.redis.set(\`distill:job:\${JOB}\`, JSON.stringify({job_id: JOB, status: 'running', teacher: 'teach-70b-v3', dataset_id: 'ds-support', sample_cap: 1000, sampled: 0, accepted: 0, rejected: 0, tenant: 't1'}));
  ctx.redis.hset(\`distill:progress:\${JOB}\`, 'sampled', sampled, 'accepted', accepted, 'rejected', rejected, 'duplicate', duplicate, 'updated_at', updatedAt);
  for (const [reason, n] of Object.entries(reasons)) ctx.redis.hset(\`distill:reasons:\${JOB}\`, reason, n);
}

function api(ctx) {
  const m = ctx.load('read');
  return ctx.client(m.app);
}

const report = (c, jobId = JOB, headers: Record<string, string> = TENANT) => c.get(\`/v1/distill/jobs/\${jobId}\`, {headers});

export async function check_route(ctx) {
  seed(ctx, 10, 7, 3, {reasons: {refusal: 3}});
  const c = api(ctx);
  let r = await report(c, JOB, {});
  assert.equal(r.status, 401, \`without X-Tenant-Id the report must answer 401, got \${r.status}\`);
  r = await report(c, 'nope');
  assert.equal(r.status, 404, \`an unknown job must answer 404, got \${r.status}\`);
  r = await report(c, JOB, {'X-Tenant-Id': 't2'});
  assert.equal(r.status, 404, \`another tenant's job must answer 404, got \${r.status}\`);
  r = await report(c);
  assert.equal(r.status, 200, \`the report answered \${r.status}: \${r.text}\`);
  const body = r.json();
  for (const key of ['job_id', 'status', 'sampled', 'accepted', 'rejected', 'acceptance_rate']) assert(key in body, \`the report lacks \${key}: \${r.text}\`);
  assert(body.job_id === JOB && body.status === 'running', \`the report names the job and its status: \${r.text}\`);
  assert.deepEqual([body.sampled, body.accepted, body.rejected], [10, 7, 3], \`the counts must be the job's: \${r.text}\`);
  assert(Math.abs(body.acceptance_rate - 0.7) < 1e-9, \`acceptance_rate must be accepted / sampled = 0.7, got \${body.acceptance_rate}\`);
}

export async function check_reconcile(ctx) {
  seed(ctx, 10, 3, 5, {reasons: {refusal: 5}}); // two samples reserved by a worker that died before it recorded
  const c = api(ctx);
  let r = await report(c);
  assert.equal(r.status, 409, \`sampled 10, accepted 3, rejected 5 do not reconcile: the report must answer 409, got \${r.status} with \${r.text} (accepted = sampled - rejected would call the two lost samples accepted)\`);
  ctx.redis.hset(\`distill:progress:\${JOB}\`, 'rejected', 7);
  r = await report(c);
  assert(r.status === 200 && r.json().accepted === 3 && r.json().rejected === 7, \`once the counts reconcile the report is 200 with the live accepted and rejected, got \${r.status}: \${r.text}\`);
}

export async function check_reasons(ctx) {
  seed(ctx, 10, 5, 5, {reasons: {refusal: 3, empty: 1, deadline: 1}});
  const c = api(ctx);
  const r = await report(c);
  assert.equal(r.status, 200, \`the report answered \${r.status}: \${r.text}\`);
  const body = r.json();
  assert.deepEqual(body.reasons, {refusal: 3, empty: 1, deadline: 1}, \`reasons must be the distill:reasons hash as numbers, got \${JSON.stringify(body.reasons)}\`);
  assert.equal(body.rejected, 5, \`rejected stays the count: \${r.text}\`);
}

export async function check_implausible_rate(ctx) {
  seed(ctx, 100, 98, 2, {reasons: {refusal: 2}});
  const c = api(ctx);
  let r = await report(c);
  let body = r.json();
  assert(r.status === 200 && Math.abs(body.acceptance_rate - 0.98) < 1e-9, \`a 98 percent run is reported, got \${r.status}: \${r.text}\`);
  assert.equal(body.flagged, 'implausible_acceptance_rate', \`98 percent accepted is above the 95 percent ceiling and must be flagged implausible_acceptance_rate, got flagged=\${JSON.stringify(body.flagged)}\`);
  ctx.redis.hset(\`distill:progress:\${JOB}\`, 'accepted', 90, 'rejected', 10);
  body = (await report(c)).json();
  assert(body.flagged === null || body.flagged === undefined, \`90 percent is within the ceiling: flagged must be null, got \${JSON.stringify(body.flagged)}\`);
  ctx.redis.hset(\`distill:progress:\${JOB}\`, 'sampled', 0, 'accepted', 0, 'rejected', 0);
  r = await report(c);
  body = r.json();
  assert(r.status === 200 && (body.flagged === null || body.flagged === undefined) && body.acceptance_rate === 0, \`an empty job has rate 0 and no flag, got \${r.status}: \${r.text}\`);
}

export async function check_live_counters(ctx) {
  seed(ctx, 10, 7, 3, {duplicate: 2, reasons: {refusal: 3}, updatedAt: 1_700_000_000});
  const c = api(ctx);
  const first = (await report(c)).json();
  assert.equal(first.updated_at, 1_700_000_000, \`the report must carry the progress hash's updated_at, got \${JSON.stringify(first.updated_at)}\`);
  assert.equal(first.duplicate, 2, \`the report carries the duplicate count, got \${JSON.stringify(first.duplicate)}\`);
  ctx.redis.hset(\`distill:progress:\${JOB}\`, 'sampled', 12, 'rejected', 5, 'updated_at', 1_700_000_300);
  ctx.redis.hincrby(\`distill:reasons:\${JOB}\`, 'deadline', 2);
  const second = (await report(c)).json();
  assert.deepEqual([second.sampled, second.accepted, second.rejected], [12, 7, 5], \`two rejections landed after the first read and the report still says \${JSON.stringify(second)}: read the live counters on every request\`);
  assert.equal(second.updated_at, 1_700_000_300, \`the second report must carry the new updated_at, got \${JSON.stringify(second.updated_at)}\`);
  assert.equal(second.reasons?.deadline, 2, \`the reasons are read live too: \${JSON.stringify(second.reasons)}\`);
}
`,
    go: `package main

import (
	"encoding/json"
	"math"
	"net/http"

	"leetbuild/harness"
)

const readJobID = "j1"

func readSeed(ctx *harness.Ctx, sampled, accepted, rejected, duplicate int, reasons map[string]int, updatedAt int64) {
	row, _ := json.Marshal(map[string]any{"job_id": readJobID, "status": "running", "teacher": "teach-70b-v3", "dataset_id": "ds-support", "sample_cap": 1000, "sampled": 0, "accepted": 0, "rejected": 0, "tenant": "t1"})
	ctx.Redis.Set("distill:job:"+readJobID, string(row))
	ctx.Redis.Do("HSET", "distill:progress:"+readJobID, "sampled", sampled, "accepted", accepted, "rejected", rejected, "duplicate", duplicate, "updated_at", updatedAt)
	for reason, n := range reasons {
		ctx.Redis.Do("HSET", "distill:reasons:"+readJobID, reason, n)
	}
}

func readClient(ctx *harness.Ctx) *harness.HTTP {
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

func readReport(c *harness.HTTP, jobID string, header ...string) *harness.Response {
	if len(header) == 0 {
		header = []string{"X-Tenant-Id", "t1"}
	}
	return c.Get("/v1/distill/jobs/"+jobID, header...)
}

func readBody(ctx *harness.Ctx, r *harness.Response) map[string]any {
	body, ok := r.JSON().(map[string]any)
	ctx.Assert(ok, "the report must be a JSON object: %s", r.Text())
	return body
}

func CheckRoute(ctx *harness.Ctx) {
	readSeed(ctx, 10, 7, 3, 0, map[string]int{"refusal": 3}, 1_700_000_000)
	c := readClient(ctx)
	r := c.Get("/v1/distill/jobs/" + readJobID)
	ctx.Equal(r.Status, 401, "without X-Tenant-Id the report")
	r = readReport(c, "nope")
	ctx.Equal(r.Status, 404, "an unknown job")
	r = readReport(c, readJobID, "X-Tenant-Id", "t2")
	ctx.Equal(r.Status, 404, "another tenant's job")
	r = readReport(c, readJobID)
	ctx.Equal(r.Status, 200, "the report (%s)", r.Text())
	body := readBody(ctx, r)
	for _, key := range []string{"job_id", "status", "sampled", "accepted", "rejected", "acceptance_rate"} {
		_, ok := body[key]
		ctx.Assert(ok, "the report lacks %s: %s", key, r.Text())
	}
	ctx.Assert(body["job_id"] == readJobID && body["status"] == "running", "the report names the job and its status: %s", r.Text())
	ctx.Equal([]any{body["sampled"], body["accepted"], body["rejected"]}, []any{10, 7, 3}, "the counts must be the job's")
	rate, _ := body["acceptance_rate"].(float64)
	ctx.Assert(math.Abs(rate-0.7) < 1e-9, "acceptance_rate must be accepted / sampled = 0.7, got %v", body["acceptance_rate"])
}

func CheckReconcile(ctx *harness.Ctx) {
	readSeed(ctx, 10, 3, 5, 0, map[string]int{"refusal": 5}, 1_700_000_000) // two samples reserved by a worker that died before it recorded
	c := readClient(ctx)
	r := readReport(c, readJobID)
	ctx.Equal(r.Status, 409, "sampled 10, accepted 3, rejected 5 do not reconcile (%s): accepted = sampled - rejected would call the two lost samples accepted; the status", r.Text())
	ctx.Redis.Do("HSET", "distill:progress:"+readJobID, "rejected", 7)
	r = readReport(c, readJobID)
	body := readBody(ctx, r)
	ctx.Assert(r.Status == 200 && body["accepted"] == float64(3) && body["rejected"] == float64(7), "once the counts reconcile the report is 200 with the live accepted and rejected, got %d: %s", r.Status, r.Text())
}

func CheckReasons(ctx *harness.Ctx) {
	readSeed(ctx, 10, 5, 5, 0, map[string]int{"refusal": 3, "empty": 1, "deadline": 1}, 1_700_000_000)
	c := readClient(ctx)
	r := readReport(c, readJobID)
	ctx.Equal(r.Status, 200, "the report (%s)", r.Text())
	body := readBody(ctx, r)
	ctx.Equal(body["reasons"], map[string]any{"refusal": 3, "empty": 1, "deadline": 1}, "reasons must be the distill:reasons hash as numbers")
	ctx.Equal(body["rejected"], 5, "rejected stays the count")
}

func CheckImplausibleRate(ctx *harness.Ctx) {
	readSeed(ctx, 100, 98, 2, 0, map[string]int{"refusal": 2}, 1_700_000_000)
	c := readClient(ctx)
	r := readReport(c, readJobID)
	body := readBody(ctx, r)
	rate, _ := body["acceptance_rate"].(float64)
	ctx.Assert(r.Status == 200 && math.Abs(rate-0.98) < 1e-9, "a 98 percent run is reported, got %d: %s", r.Status, r.Text())
	ctx.Equal(body["flagged"], "implausible_acceptance_rate", "98 percent accepted is above the 95 percent ceiling and must be flagged; flagged")
	ctx.Redis.Do("HSET", "distill:progress:"+readJobID, "accepted", 90, "rejected", 10)
	body = readBody(ctx, readReport(c, readJobID))
	ctx.Assert(body["flagged"] == nil, "90 percent is within the ceiling: flagged must be null, got %v", body["flagged"])
	ctx.Redis.Do("HSET", "distill:progress:"+readJobID, "sampled", 0, "accepted", 0, "rejected", 0)
	r = readReport(c, readJobID)
	body = readBody(ctx, r)
	ctx.Assert(r.Status == 200 && body["flagged"] == nil && body["acceptance_rate"] == float64(0), "an empty job has rate 0 and no flag, got %d: %s", r.Status, r.Text())
}

func CheckLiveCounters(ctx *harness.Ctx) {
	readSeed(ctx, 10, 7, 3, 2, map[string]int{"refusal": 3}, 1_700_000_000)
	c := readClient(ctx)
	first := readBody(ctx, readReport(c, readJobID))
	ctx.Equal(first["updated_at"], 1_700_000_000, "the report must carry the progress hash's updated_at")
	ctx.Equal(first["duplicate"], 2, "the report carries the duplicate count")
	ctx.Redis.Do("HSET", "distill:progress:"+readJobID, "sampled", 12, "rejected", 5, "updated_at", 1_700_000_300)
	ctx.Redis.Do("HINCRBY", "distill:reasons:"+readJobID, "deadline", 2)
	second := readBody(ctx, readReport(c, readJobID))
	ctx.Equal([]any{second["sampled"], second["accepted"], second["rejected"]}, []any{12, 7, 5}, "two rejections landed after the first read (read the live counters on every request); sampled, accepted, rejected")
	ctx.Equal(second["updated_at"], 1_700_000_300, "the second report must carry the new updated_at")
	reasons, _ := second["reasons"].(map[string]any)
	ctx.Equal(reasons["deadline"], 2, "the reasons are read live too")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <cmath>
#include <map>
#include <string>

namespace {

using json = nlohmann::json;

const std::string kJob = "j1";

void readSeed(harness::Ctx& ctx, int sampled, int accepted, int rejected, int duplicate, const std::map<std::string, int>& reasons, long long updated_at) {
  const json row = {{"job_id", kJob}, {"status", "running"}, {"teacher", "teach-70b-v3"}, {"dataset_id", "ds-support"}, {"sample_cap", 1000}, {"sampled", 0}, {"accepted", 0}, {"rejected", 0}, {"tenant", "t1"}};
  ctx.Redis.Set("distill:job:" + kJob, row.dump());
  ctx.Redis.Do("HSET", "distill:progress:" + kJob, "sampled", sampled, "accepted", accepted, "rejected", rejected, "duplicate", duplicate, "updated_at", updated_at);
  for (const auto& [reason, n] : reasons) ctx.Redis.Do("HSET", "distill:reasons:" + kJob, reason, n);
}

struct Api {
  httplib::Server svr;
  harness::HTTP http;
  explicit Api(harness::Ctx& ctx) : http(ctx.HTTP(svr)) { register_routes(svr); }
  harness::Response report(const std::string& job_id = kJob, const std::string& tenant = "t1") {
    return http.Get("/v1/distill/jobs/" + job_id, "X-Tenant-Id", tenant);
  }
};

json bodyOf(harness::Ctx& ctx, const harness::Response& r) {
  const json body = json::parse(r.Text(), nullptr, false);
  ctx.Assert(body.is_object(), "the report must be a JSON object: %s", r.Text());
  return body;
}

}  // namespace

void CheckRoute(harness::Ctx& ctx) {
  readSeed(ctx, 10, 7, 3, 0, {{"refusal", 3}}, 1700000000);
  Api api(ctx);
  auto r = api.http.Get("/v1/distill/jobs/" + kJob);
  ctx.Equal(r.Status, 401, "without X-Tenant-Id the report");
  r = api.report("nope");
  ctx.Equal(r.Status, 404, "an unknown job");
  r = api.report(kJob, "t2");
  ctx.Equal(r.Status, 404, "another tenant's job");
  r = api.report();
  ctx.Equal(r.Status, 200, "the report (%s)", r.Text());
  const json body = bodyOf(ctx, r);
  for (const char* key : {"job_id", "status", "sampled", "accepted", "rejected", "acceptance_rate"}) ctx.Assert(body.contains(key), "the report lacks %s: %s", key, r.Text());
  ctx.Assert(body["job_id"] == kJob && body["status"] == "running", "the report names the job and its status: %s", r.Text());
  ctx.Assert(body["sampled"] == 10 && body["accepted"] == 7 && body["rejected"] == 3, "the counts must be the job's: %s", r.Text());
  ctx.Assert(body["acceptance_rate"].is_number() && std::fabs(body["acceptance_rate"].get<double>() - 0.7) < 1e-9, "acceptance_rate must be accepted / sampled = 0.7, got %s", body["acceptance_rate"].dump());
}

void CheckReconcile(harness::Ctx& ctx) {
  readSeed(ctx, 10, 3, 5, 0, {{"refusal", 5}}, 1700000000);  // two samples reserved by a worker that died before it recorded
  Api api(ctx);
  auto r = api.report();
  ctx.Equal(r.Status, 409, "sampled 10, accepted 3, rejected 5 do not reconcile (%s): accepted = sampled - rejected would call the two lost samples accepted; the status", r.Text());
  ctx.Redis.Do("HSET", "distill:progress:" + kJob, "rejected", 7);
  r = api.report();
  const json body = bodyOf(ctx, r);
  ctx.Assert(r.Status == 200 && body["accepted"] == 3 && body["rejected"] == 7, "once the counts reconcile the report is 200 with the live accepted and rejected, got %d: %s", r.Status, r.Text());
}

void CheckReasons(harness::Ctx& ctx) {
  readSeed(ctx, 10, 5, 5, 0, {{"refusal", 3}, {"empty", 1}, {"deadline", 1}}, 1700000000);
  Api api(ctx);
  const auto r = api.report();
  ctx.Equal(r.Status, 200, "the report (%s)", r.Text());
  const json body = bodyOf(ctx, r);
  ctx.Equal(body.value("reasons", json()), json({{"refusal", 3}, {"empty", 1}, {"deadline", 1}}), "reasons must be the distill:reasons hash as numbers");
  ctx.Equal(body.value("rejected", json()), json(5), "rejected stays the count");
}

void CheckImplausibleRate(harness::Ctx& ctx) {
  readSeed(ctx, 100, 98, 2, 0, {{"refusal", 2}}, 1700000000);
  Api api(ctx);
  auto r = api.report();
  json body = bodyOf(ctx, r);
  ctx.Assert(r.Status == 200 && body["acceptance_rate"].is_number() && std::fabs(body["acceptance_rate"].get<double>() - 0.98) < 1e-9, "a 98 percent run is reported, got %d: %s", r.Status, r.Text());
  ctx.Equal(body.value("flagged", json()), json("implausible_acceptance_rate"), "98 percent accepted is above the 95 percent ceiling and must be flagged; flagged");
  ctx.Redis.Do("HSET", "distill:progress:" + kJob, "accepted", 90, "rejected", 10);
  body = bodyOf(ctx, api.report());
  ctx.Assert(!body.contains("flagged") || body["flagged"].is_null(), "90 percent is within the ceiling: flagged must be null, got %s", body.value("flagged", json()).dump());
  ctx.Redis.Do("HSET", "distill:progress:" + kJob, "sampled", 0, "accepted", 0, "rejected", 0);
  r = api.report();
  body = bodyOf(ctx, r);
  ctx.Assert(r.Status == 200 && (!body.contains("flagged") || body["flagged"].is_null()) && body["acceptance_rate"] == 0, "an empty job has rate 0 and no flag, got %d: %s", r.Status, r.Text());
}

void CheckLiveCounters(harness::Ctx& ctx) {
  readSeed(ctx, 10, 7, 3, 2, {{"refusal", 3}}, 1700000000);
  Api api(ctx);
  const json first = bodyOf(ctx, api.report());
  ctx.Equal(first.value("updated_at", json()), json(1700000000), "the report must carry the progress hash's updated_at");
  ctx.Equal(first.value("duplicate", json()), json(2), "the report carries the duplicate count");
  ctx.Redis.Do("HSET", "distill:progress:" + kJob, "sampled", 12, "rejected", 5, "updated_at", 1700000300);
  ctx.Redis.Do("HINCRBY", "distill:reasons:" + kJob, "deadline", 2);
  const json second = bodyOf(ctx, api.report());
  ctx.Assert(second["sampled"] == 12 && second["accepted"] == 7 && second["rejected"] == 5, "two rejections landed after the first read and the report still says %s: read the live counters on every request", second.dump());
  ctx.Equal(second.value("updated_at", json()), json(1700000300), "the second report must carry the new updated_at");
  ctx.Equal(second.value("reasons", json()).value("deadline", json()), json(2), "the reasons are read live too");
}
`,
  },
  debrief: `A report is believed because its numbers are checked against each other, not because they look good. Reading the hash on every request and carrying its stamp makes the report a measurement; comparing the three counts makes it a verified one, and 409 says "I will not guess" when a worker died between a reservation and its record. The reasons hash turns a rate into an explanation (duplicates dominant means the filter is working, refusals dominant means the teacher is), and the flag treats a near-perfect rate as a reason to look at samples by hand. Production platforms break the report down by dataset shard and teacher version, put confidence bounds on the rate, and keep a stored sample of what the filter rejected so the flag can be investigated without rerunning the job.`,
};
