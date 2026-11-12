import type {Step} from '@/lib/types';

export const readStep: Step = {
  id: 'read',
  title: 'GET /v1/finetune/jobs/{job_id}: trained is not promotable',
  concept: 'http',
  guides: ['honest-reads', 'request-boundaries', 'model-output'],
  file: 'read',
  focus: ['client', 'readapi', 'redis'],
  task: `## Task

**Starting point.** The starter serves \`GET /v1/finetune/jobs/{job_id}\`: it answers 401 without
\`X-Team-Id\` and 404 for an unknown id, loads the job with \`store.by_id\`, and returns \`job_id\`,
\`status\`, \`trained\` (status \`succeeded\`), the eval from \`evals.result\`, \`promotable\`, a \`budget\` of
\`reserved\` and \`spent\` from \`ft:reservation:{job_id}\` with \`remaining\` read from the team's pool, and
the latest \`checkpoint\`. It answers the dashboard and hides 4 flaws.

**Failure mode the checks target.** A run that finished training but failed its golden set reaches the
registry as promotable, because the flag copies \`trained\`. Any team that guesses an id reads another
team's run. The budget cannot be reconciled: \`remaining\` is the team's whole pool, not what this job
left of its reservation. And with only the latest checkpoint, nobody can explain the restarts.

Requirements:

- Another team's job is **404**, as an unknown one is: a foreign id cannot be confirmed to exist.
- \`promotable\` is true only when the run is \`succeeded\` **and** its eval passed; no eval yet is not
  promotable. \`eval\` is \`{passed, score}\` or null.
- \`budget\` is \`{reserved, spent, remaining}\` from the job's reservation, with
  \`remaining = reserved - spent\`.
- \`checkpoint_ids\` is the whole lineage, in order.`,
  sequence: {
    participants: ['Client', 'Job read API', 'Redis'],
    messages: [
      {from: 'Client', to: 'Job read API', label: 'GET /v1/finetune/jobs/job-7 · X-Team-Id', kind: 'sync'},
      {
        from: 'Job read API',
        to: 'Redis',
        label: 'HGETALL ft:job:job-7 · ft:eval:job-7 · ft:reservation:job-7',
        kind: 'sync',
      },
      {from: 'Redis', to: 'Job read API', label: 'job · eval · reservation', kind: 'reply'},
      {
        from: 'Job read API',
        to: 'Client',
        label: '200 {trained, eval, promotable, budget, checkpoint_ids}',
        kind: 'reply',
      },
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Handles GET /v1/finetune/jobs/{job_id}',
      detail:
        'The team\u2019s own job answers 200 with job_id, status and trained; an unknown id is 404 and a request without X-Team-Id is 401.',
      match: {
        python: {all: [/@app\.get\(\s*["']\/v1\/finetune\/jobs\/\{job_id\}["']/]},
        typescript: {all: [/app\.get\(\s*['"]\/v1\/finetune\/jobs\/:job_id['"]/]},
        go: {all: [/HandleFunc\(\s*"GET \/v1\/finetune\/jobs\/\{jobID\}"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"finetune"\s*\/\s*"jobs"\s*\/\s*Segment\s*\)/, /\bget\s*\{/]},
        cpp: {all: [/svr\.Get\([^,\n]*v1\/finetune\/jobs\//]},
      },
    },
    {
      id: 'tenant-scope',
      title: 'Answers 404 for another team\u2019s job',
      detail:
        'ml-legal reading ml-search\u2019s job gets 404, the same answer as an unknown id. The starter serves any job to any team.',
      match: {
        python: {all: [/\[\s*["']team["']\s*\]\s*!=\s*team|team\s*!=\s*job\[\s*["']team["']\s*\]/]},
        typescript: {all: [/job\.team\s*!==\s*team|team\s*!==\s*job\.team/]},
        go: {all: [/job\.Team\s*!=\s*team|team\s*!=\s*job\.Team/]},
        scala: {all: [/\.team\s*(==|!=)\s*team/]},
        cpp: {all: [/value\(\s*"team"[^)]*\)\s*!=\s*team/]},
      },
    },
    {
      id: 'promotable-gate',
      title: 'Promotable needs a succeeded run and a passing eval',
      detail:
        'A succeeded run whose eval failed, one with no eval yet and a failed run are not promotable; only succeeded with a passing eval is. The starter sets promotable to trained.',
      match: {
        python: {all: [/\[\s*["']passed["']\s*\]/], none: [/["']promotable["']\s*:\s*trained\s*[,}\n]/]},
        typescript: {all: [/\.passed\b/], none: [/promotable:\s*trained\s*[,}\n]/]},
        go: {all: [/\.Passed\b/], none: [/"promotable":\s*trained\s*[,}\n]/]},
        scala: {all: [/\.passed\b/], none: [/"promotable"\s*->\s*trained\s*[,)\n]/]},
        cpp: {all: [/->passed\b|\.passed\b/], none: [/\{\s*"promotable"\s*,\s*trained\s*\}/]},
      },
    },
    {
      id: 'budget-reconcile',
      title: 'Reconciles the job\u2019s reservation: remaining = reserved - spent',
      detail:
        'A job that reserved 600 GPU-hours and spent 450 reads {reserved: 600, spent: 450, remaining: 150}, whatever the team\u2019s pool holds. The starter reports the pool as remaining.',
      match: {
        python: {all: [/reserved\s*-\s*spent/], none: [/pool_key/]},
        typescript: {all: [/reserved\s*-\s*spent/], none: [/poolKey/]},
        go: {all: [/reserved\s*-\s*spent/], none: [/PoolKey/]},
        scala: {all: [/reserved\s*-\s*spent/], none: [/poolKey/]},
        cpp: {all: [/reserved\s*-\s*spent/], none: [/pool_key/]},
      },
    },
    {
      id: 'lineage',
      title: 'Returns the whole checkpoint lineage',
      detail:
        'A run restarted twice reads checkpoint_ids [ckpt-job-7-1, ckpt-job-7-2]. The starter returns only the latest checkpoint.',
      match: {
        python: {
          all: [/["']checkpoint_ids["']\s*:\s*job\[\s*["']checkpoint_ids["']\s*\]/],
          none: [/["']checkpoint["']\s*:/],
        },
        typescript: {all: [/checkpoint_ids:\s*job\.checkpoint_ids/], none: [/\bcheckpoint:/]},
        go: {all: [/"checkpoint_ids":\s*job\.CheckpointIDs/], none: [/"checkpoint":/]},
        scala: {all: [/"checkpoint_ids"\s*->/], none: [/"checkpoint"\s*->/]},
        cpp: {all: [/\{\s*"checkpoint_ids"\s*,/], none: [/\{\s*"checkpoint"\s*,/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import logging

import redis
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from finetune import evals
from finetune.config import pool_key, reservation_key
from finetune.jobs import store

app = FastAPI()
logger = logging.getLogger("finetune.read")
r = redis.Redis(host="redis", port=6379, decode_responses=True)


@app.get("/v1/finetune/jobs/{job_id}")
def read_job(job_id: str, request: Request) -> JSONResponse:
    # TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
    team = request.headers.get("X-Team-Id", "")
    if team == "":
        return JSONResponse({"error": "missing X-Team-Id"}, status_code=401)
    job = store.by_id(job_id)
    if job is None:
        return JSONResponse({"error": "unknown job"}, status_code=404)
    trained = job["status"] == "succeeded"
    reservation = r.hgetall(reservation_key(job_id))
    body = {
        "job_id": job_id,
        "status": job["status"],
        "trained": trained,
        "eval": evals.result(job_id),
        "promotable": trained,
        "budget": {
            "reserved": int(reservation.get("reserved", 0)),
            "spent": int(reservation.get("spent", 0)),
            "remaining": int(r.get(pool_key(job["team"])) or 0),
        },
        "checkpoint": job["checkpoint_ids"][-1] if job["checkpoint_ids"] else None,
    }
    logger.info("read job=%s team=%s", job_id, team)
    return JSONResponse(body)
`,
      solution: `import logging

import redis
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from finetune import evals
from finetune.config import reservation_key
from finetune.jobs import store

app = FastAPI()
logger = logging.getLogger("finetune.read")
r = redis.Redis(host="redis", port=6379, decode_responses=True)


@app.get("/v1/finetune/jobs/{job_id}")
def read_job(job_id: str, request: Request) -> JSONResponse:
    team = request.headers.get("X-Team-Id", "")
    if team == "":
        return JSONResponse({"error": "missing X-Team-Id"}, status_code=401)
    job = store.by_id(job_id)
    if job is None or job["team"] != team:
        return JSONResponse({"error": "unknown job"}, status_code=404)
    trained = job["status"] == "succeeded"
    result = evals.result(job_id)
    reservation = r.hgetall(reservation_key(job_id))
    reserved = int(reservation.get("reserved", 0))
    spent = int(reservation.get("spent", 0))
    body = {
        "job_id": job_id,
        "status": job["status"],
        "trained": trained,
        "eval": result,
        "promotable": trained and result is not None and result["passed"],
        "budget": {"reserved": reserved, "spent": spent, "remaining": reserved - spent},
        "checkpoint_ids": job["checkpoint_ids"],
    }
    logger.info("read job=%s team=%s", job_id, team)
    return JSONResponse(body)
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';
import Redis from 'ioredis';

import {poolKey, reservationKey} from 'finetune/config';
import {evals} from 'finetune/evals';
import {store} from 'finetune/jobs';

export const app = Fastify();
const redis = new Redis({host: 'redis', port: 6379});

app.get('/v1/finetune/jobs/:job_id', async (request, reply) => {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  const team = request.headers['x-team-id'];
  if (typeof team !== 'string' || team === '') return reply.code(401).send({error: 'missing X-Team-Id'});
  const {job_id: jobId} = request.params as {job_id: string};
  const job = await store.byId(jobId);
  if (job === null) return reply.code(404).send({error: 'unknown job'});
  const trained = job.status === 'succeeded';
  const reservation = await redis.hgetall(reservationKey(jobId));
  const body = {
    job_id: jobId,
    status: job.status,
    trained,
    eval: await evals.result(jobId),
    promotable: trained,
    budget: {
      reserved: Number(reservation.reserved ?? 0),
      spent: Number(reservation.spent ?? 0),
      remaining: Number((await redis.get(poolKey(job.team))) ?? 0),
    },
    checkpoint: job.checkpoint_ids.at(-1) ?? null,
  };
  request.log.info({job_id: jobId, team}, 'job read');
  return reply.code(200).send(body);
});
`,
      solution: `import Fastify from 'fastify';
import Redis from 'ioredis';

import {reservationKey} from 'finetune/config';
import {evals} from 'finetune/evals';
import {store} from 'finetune/jobs';

export const app = Fastify();
const redis = new Redis({host: 'redis', port: 6379});

app.get('/v1/finetune/jobs/:job_id', async (request, reply) => {
  const team = request.headers['x-team-id'];
  if (typeof team !== 'string' || team === '') return reply.code(401).send({error: 'missing X-Team-Id'});
  const {job_id: jobId} = request.params as {job_id: string};
  const job = await store.byId(jobId);
  if (job === null || job.team !== team) return reply.code(404).send({error: 'unknown job'});
  const trained = job.status === 'succeeded';
  const result = await evals.result(jobId);
  const reservation = await redis.hgetall(reservationKey(jobId));
  const reserved = Number(reservation.reserved ?? 0);
  const spent = Number(reservation.spent ?? 0);
  const body = {
    job_id: jobId,
    status: job.status,
    trained,
    eval: result,
    promotable: trained && result !== null && result.passed,
    budget: {reserved, spent, remaining: reserved - spent},
    checkpoint_ids: job.checkpoint_ids,
  };
  request.log.info({job_id: jobId, team}, 'job read');
  return reply.code(200).send(body);
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

	"finetune/config" // config.ReservationKey, config.PoolKey — provided
	"finetune/evals"  // evals.Get(ctx, jobID) — provided
	"finetune/jobs"   // jobs.ByID(ctx, jobID) — provided
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func readJob(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
	team := r.Header.Get("X-Team-Id")
	if team == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-Team-Id"})
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
	trained := job.Status == "succeeded"
	var evalBody any
	if result, ok, err := evals.Get(r.Context(), jobID); err == nil && ok {
		evalBody = result
	}
	reservation, _ := rdb.HGetAll(r.Context(), config.ReservationKey(jobID)).Result()
	reserved, _ := strconv.ParseInt(reservation["reserved"], 10, 64)
	spent, _ := strconv.ParseInt(reservation["spent"], 10, 64)
	pool, _ := rdb.Get(r.Context(), config.PoolKey(job.Team)).Int64()
	var latest any
	if len(job.CheckpointIDs) > 0 {
		latest = job.CheckpointIDs[len(job.CheckpointIDs)-1]
	}
	log.Printf("read job=%s team=%s", jobID, team)
	writeJSON(rw, http.StatusOK, map[string]any{
		"job_id":     jobID,
		"status":     job.Status,
		"trained":    trained,
		"eval":       evalBody,
		"promotable": trained,
		"budget":     map[string]int64{"reserved": reserved, "spent": spent, "remaining": pool},
		"checkpoint": latest,
	})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/finetune/jobs/{jobID}", readJob)
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

	"finetune/config" // config.ReservationKey — provided
	"finetune/evals"  // evals.Get(ctx, jobID) — provided
	"finetune/jobs"   // jobs.ByID(ctx, jobID) — provided
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func readJob(rw http.ResponseWriter, r *http.Request) {
	team := r.Header.Get("X-Team-Id")
	if team == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-Team-Id"})
		return
	}
	jobID := r.PathValue("jobID")
	job, err := jobs.ByID(r.Context(), jobID)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	if job == nil || job.Team != team {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "unknown job"})
		return
	}
	trained := job.Status == "succeeded"
	result, evaluated, err := evals.Get(r.Context(), jobID)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	var evalBody any
	if evaluated {
		evalBody = result
	}
	reservation, err := rdb.HGetAll(r.Context(), config.ReservationKey(jobID)).Result()
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	reserved, _ := strconv.ParseInt(reservation["reserved"], 10, 64)
	spent, _ := strconv.ParseInt(reservation["spent"], 10, 64)
	log.Printf("read job=%s team=%s", jobID, team)
	writeJSON(rw, http.StatusOK, map[string]any{
		"job_id":         jobID,
		"status":         job.Status,
		"trained":        trained,
		"eval":           evalBody,
		"promotable":     trained && evaluated && result.Passed,
		"budget":         map[string]int64{"reserved": reserved, "spent": spent, "remaining": reserved - spent},
		"checkpoint_ids": job.CheckpointIDs,
	})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/finetune/jobs/{jobID}", readJob)
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

import finetune.{Config, Evals, Jobs}

object JobReadApi {
  implicit val system: ActorSystem = ActorSystem("finetune-read")
  val jedis = new JedisPooled("redis", 6379)

  val route: Route =
    path("v1" / "finetune" / "jobs" / Segment) { jobId =>
      get {
        optionalHeaderValueByName("X-Team-Id") { teamOpt =>
          // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
          if (!teamOpt.exists(_.nonEmpty)) complete(StatusCodes.Unauthorized, """{"error":"missing X-Team-Id"}""")
          else
            Jobs.byId(jobId) match {
              case None => complete(StatusCodes.NotFound, """{"error":"unknown job"}""")
              case Some(job) =>
                val trained = job.status == "succeeded"
                val evalBody: ujson.Value =
                  Evals.result(jobId).map(e => ujson.Obj("passed" -> e.passed, "score" -> e.score)).getOrElse(ujson.Null)
                val reservation = jedis.hgetAll(Config.reservationKey(jobId)).asScala
                val pool = Option(jedis.get(Config.poolKey(job.team))).map(_.toLong).getOrElse(0L)
                val body = ujson.Obj(
                  "job_id" -> jobId,
                  "status" -> job.status,
                  "trained" -> trained,
                  "eval" -> evalBody,
                  "promotable" -> trained,
                  "budget" -> ujson.Obj(
                    "reserved" -> reservation.getOrElse("reserved", "0").toLong.toDouble,
                    "spent" -> reservation.getOrElse("spent", "0").toLong.toDouble,
                    "remaining" -> pool.toDouble
                  ),
                  "checkpoint" -> job.checkpoint_ids.lastOption.map(ujson.Str(_)).getOrElse(ujson.Null)
                )
                system.log.info(s"read job=$jobId team=\${teamOpt.get}")
                complete(HttpEntity(ContentTypes.\`application/json\`, ujson.write(body)))
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

import finetune.{Config, Evals, Jobs}

object JobReadApi {
  implicit val system: ActorSystem = ActorSystem("finetune-read")
  val jedis = new JedisPooled("redis", 6379)

  val route: Route =
    path("v1" / "finetune" / "jobs" / Segment) { jobId =>
      get {
        optionalHeaderValueByName("X-Team-Id") { teamOpt =>
          if (!teamOpt.exists(_.nonEmpty)) complete(StatusCodes.Unauthorized, """{"error":"missing X-Team-Id"}""")
          else
            Jobs.byId(jobId).filter(_.team == teamOpt.get) match {
              case None => complete(StatusCodes.NotFound, """{"error":"unknown job"}""")
              case Some(job) =>
                val trained = job.status == "succeeded"
                val result = Evals.result(jobId)
                val evalBody: ujson.Value = result.map(e => ujson.Obj("passed" -> e.passed, "score" -> e.score)).getOrElse(ujson.Null)
                val reservation = jedis.hgetAll(Config.reservationKey(jobId)).asScala
                val reserved = reservation.getOrElse("reserved", "0").toLong
                val spent = reservation.getOrElse("spent", "0").toLong
                val body = ujson.Obj(
                  "job_id" -> jobId,
                  "status" -> job.status,
                  "trained" -> trained,
                  "eval" -> evalBody,
                  "promotable" -> (trained && result.exists(_.passed)),
                  "budget" -> ujson.Obj(
                    "reserved" -> reserved.toDouble,
                    "spent" -> spent.toDouble,
                    "remaining" -> (reserved - spent).toDouble
                  ),
                  "checkpoint_ids" -> ujson.Arr.from(job.checkpoint_ids.map(ujson.Str(_)))
                )
                system.log.info(s"read job=$jobId team=\${teamOpt.get}")
                complete(HttpEntity(ContentTypes.\`application/json\`, ujson.write(body)))
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

#include <iostream>
#include <string>

#include "finetune/config.h"  // config::reservation_key, config::pool_key — provided
#include "finetune/evals.h"   // evals::result(job_id) — provided
#include "finetune/jobs.h"    // jobs::by_id(job_id) — provided

using json = nlohmann::json;

sw::redis::Redis redis("tcp://redis:6379");

long long field_of(const std::unordered_map<std::string, std::string>& hash, const std::string& name) {
  const auto it = hash.find(name);
  return it == hash.end() ? 0 : std::stoll(it->second);
}

void read_job(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  const std::string team = req.get_header_value("X-Team-Id");
  if (team.empty()) {
    res.status = 401;
    res.set_content(R"({"error":"missing X-Team-Id"})", "application/json");
    return;
  }
  const std::string job_id = req.matches[1].str();
  const auto job = jobs::by_id(job_id);
  if (!job) {
    res.status = 404;
    res.set_content(R"({"error":"unknown job"})", "application/json");
    return;
  }
  const bool trained = job->value("status", "") == "succeeded";
  json eval = nullptr;
  if (const auto result = evals::result(job_id)) eval = {{"passed", result->passed}, {"score", result->score}};
  const auto reservation = redis.hgetall(config::reservation_key(job_id));
  const auto pool = redis.get(config::pool_key(job->value("team", "")));
  const json& checkpoints = (*job)["checkpoint_ids"];
  const json body = {
      {"job_id", job_id},
      {"status", job->value("status", "")},
      {"trained", trained},
      {"eval", eval},
      {"promotable", trained},
      {"budget", {{"reserved", field_of(reservation, "reserved")}, {"spent", field_of(reservation, "spent")}, {"remaining", pool ? std::stoll(*pool) : 0}}},
      {"checkpoint", checkpoints.empty() ? json(nullptr) : checkpoints.back()},
  };
  std::cerr << "read job=" << job_id << " team=" << team << "\\n";
  res.status = 200;
  res.set_content(body.dump(), "application/json");
}

void register_routes(httplib::Server& svr) { svr.Get(R"(/v1/finetune/jobs/([^/]+))", read_job); }

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
#include <string>

#include "finetune/config.h"  // config::reservation_key — provided
#include "finetune/evals.h"   // evals::result(job_id) — provided
#include "finetune/jobs.h"    // jobs::by_id(job_id) — provided

using json = nlohmann::json;

sw::redis::Redis redis("tcp://redis:6379");

long long field_of(const std::unordered_map<std::string, std::string>& hash, const std::string& name) {
  const auto it = hash.find(name);
  return it == hash.end() ? 0 : std::stoll(it->second);
}

void read_job(const httplib::Request& req, httplib::Response& res) {
  const std::string team = req.get_header_value("X-Team-Id");
  if (team.empty()) {
    res.status = 401;
    res.set_content(R"({"error":"missing X-Team-Id"})", "application/json");
    return;
  }
  const std::string job_id = req.matches[1].str();
  const auto job = jobs::by_id(job_id);
  if (!job || job->value("team", "") != team) {
    res.status = 404;
    res.set_content(R"({"error":"unknown job"})", "application/json");
    return;
  }
  const bool trained = job->value("status", "") == "succeeded";
  const auto result = evals::result(job_id);
  json eval = nullptr;
  if (result) eval = {{"passed", result->passed}, {"score", result->score}};
  const auto reservation = redis.hgetall(config::reservation_key(job_id));
  const long long reserved = field_of(reservation, "reserved");
  const long long spent = field_of(reservation, "spent");
  const json body = {
      {"job_id", job_id},
      {"status", job->value("status", "")},
      {"trained", trained},
      {"eval", eval},
      {"promotable", trained && result && result->passed},
      {"budget", {{"reserved", reserved}, {"spent", spent}, {"remaining", reserved - spent}}},
      {"checkpoint_ids", (*job)["checkpoint_ids"]},
  };
  std::cerr << "read job=" << job_id << " team=" << team << "\\n";
  res.status = 200;
  res.set_content(body.dump(), "application/json");
}

void register_routes(httplib::Server& svr) { svr.Get(R"(/v1/finetune/jobs/([^/]+))", read_job); }

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

TEAM = {"X-Team-Id": "ml-search"}


def _seed(ctx, job_id, status, passed=None, team="ml-search"):
    ctx.redis.hset(f"ft:job:{job_id}", mapping={
        "job_id": job_id, "team": team, "status": status, "base_model": "llama-3.1-8b",
        "dataset_version": "support-tickets@v3", "dataset_sha256": "b1" * 32, "config_hash": "7e" * 32,
        "compute_budget": 600, "hyperparameters": json.dumps({"learning_rate": 0.0002, "lora_rank": 16}),
        "checkpoint_ids": json.dumps([f"ckpt-{job_id}-1", f"ckpt-{job_id}-2"]),
    })
    ctx.redis.hset(f"ft:reservation:{job_id}", mapping={"team": team, "reserved": 600, "spent": 450, "state": "completed"})
    ctx.redis.set(f"ft:pool:{team}", 5000)
    if passed is not None:
        ctx.redis.hset(f"ft:eval:{job_id}", mapping={"passed": 1 if passed else 0, "score": 0.91 if passed else 0.71})


def _api(ctx):
    return ctx.client(ctx.load("read").app)


async def check_route(ctx):
    _seed(ctx, "job-7", "succeeded", passed=True)
    async with _api(ctx) as c:
        r = await c.get("/v1/finetune/jobs/job-7", headers=TEAM)
        assert r.status_code == 200, f"the team's own job answered {r.status_code}: {r.text}"
        body = r.json()
        assert body.get("job_id") == "job-7" and body.get("status") == "succeeded" and body.get("trained") is True, f"the answer carries job_id, status and trained: {body}"
        r = await c.get("/v1/finetune/jobs/job-404", headers=TEAM)
        assert r.status_code == 404, f"an unknown id answered {r.status_code}, expected 404"
        r = await c.get("/v1/finetune/jobs/job-7")
        assert r.status_code == 401, f"without X-Team-Id the read must answer 401, got {r.status_code}"


async def check_tenant_scope(ctx):
    _seed(ctx, "job-7", "succeeded", passed=True)
    async with _api(ctx) as c:
        r = await c.get("/v1/finetune/jobs/job-7", headers={"X-Team-Id": "ml-legal"})
        assert r.status_code == 404, f"ml-legal read ml-search's job and got {r.status_code}: another team's job answers 404, as an unknown id does, so a guessed id confirms nothing"
        assert "ckpt-job-7" not in r.text, f"the refusal leaks the job: {r.text}"


async def check_promotable_gate(ctx):
    _seed(ctx, "job-7", "succeeded", passed=False)
    _seed(ctx, "job-8", "succeeded")
    _seed(ctx, "job-9", "succeeded", passed=True)
    _seed(ctx, "job-10", "failed", passed=True)
    async with _api(ctx) as c:
        body = (await c.get("/v1/finetune/jobs/job-7", headers=TEAM)).json()
        assert body.get("trained") is True and body.get("promotable") is False, f"job-7 trained but failed its golden set and reads promotable={body.get('promotable')!r}: a failed eval must keep it out of the registry"
        assert body.get("eval") == {"passed": False, "score": 0.71}, f"the eval is reported as {{passed, score}}, got {body.get('eval')}"
        body = (await c.get("/v1/finetune/jobs/job-8", headers=TEAM)).json()
        assert body.get("promotable") is False and body.get("eval") is None, f"job-8 has no eval yet: promotable must be False and eval null, got {body}"
        body = (await c.get("/v1/finetune/jobs/job-9", headers=TEAM)).json()
        assert body.get("promotable") is True, f"job-9 succeeded and passed its eval, so it is promotable: {body}"
        body = (await c.get("/v1/finetune/jobs/job-10", headers=TEAM)).json()
        assert body.get("promotable") is False, f"job-10 failed training: a passing eval of an earlier checkpoint does not make it promotable, got {body}"


async def check_budget_reconcile(ctx):
    _seed(ctx, "job-7", "succeeded", passed=True)
    async with _api(ctx) as c:
        body = (await c.get("/v1/finetune/jobs/job-7", headers=TEAM)).json()
        assert body.get("budget") == {"reserved": 600, "spent": 450, "remaining": 150}, f"job-7 reserved 600 GPU-hours and spent 450, so its budget reads {{reserved: 600, spent: 450, remaining: 150}}; got {body.get('budget')} (the team's pool holds 5000, which is not this job's remainder)"


async def check_lineage(ctx):
    _seed(ctx, "job-7", "succeeded", passed=True)
    async with _api(ctx) as c:
        body = (await c.get("/v1/finetune/jobs/job-7", headers=TEAM)).json()
        assert body.get("checkpoint_ids") == ["ckpt-job-7-1", "ckpt-job-7-2"], f"a run restarted twice must show both checkpoints in order, got checkpoint_ids={body.get('checkpoint_ids')!r}: with only the latest nobody can explain the restarts"
`,
    typescript: `const TEAM = {'X-Team-Id': 'ml-search'};

function seed(ctx, jobId: string, status: string, passed: boolean | null = null, team = 'ml-search') {
  const job = {
    job_id: jobId, team, status, base_model: 'llama-3.1-8b', dataset_version: 'support-tickets@v3',
    dataset_sha256: 'b1'.repeat(32), config_hash: '7e'.repeat(32), compute_budget: '600',
    hyperparameters: JSON.stringify({learning_rate: 0.0002, lora_rank: 16}),
    checkpoint_ids: JSON.stringify([\`ckpt-\${jobId}-1\`, \`ckpt-\${jobId}-2\`]),
  };
  ctx.redis.hset(\`ft:job:\${jobId}\`, ...Object.entries(job).flat());
  ctx.redis.hset(\`ft:reservation:\${jobId}\`, 'team', team, 'reserved', '600', 'spent', '450', 'state', 'completed');
  ctx.redis.set(\`ft:pool:\${team}\`, '5000');
  if (passed !== null) ctx.redis.hset(\`ft:eval:\${jobId}\`, 'passed', passed ? '1' : '0', 'score', passed ? '0.91' : '0.71');
}

const api = ctx => ctx.client(ctx.load('read').app);
const read = async (c, jobId: string) => (await c.get(\`/v1/finetune/jobs/\${jobId}\`, {headers: TEAM})).json();

export async function check_route(ctx) {
  seed(ctx, 'job-7', 'succeeded', true);
  const c = api(ctx);
  let r = await c.get('/v1/finetune/jobs/job-7', {headers: TEAM});
  assert.equal(r.status, 200, \`the team's own job answered \${r.status}: \${r.text}\`);
  const body = r.json();
  assert(body.job_id === 'job-7' && body.status === 'succeeded' && body.trained === true, \`the answer carries job_id, status and trained: \${r.text}\`);
  r = await c.get('/v1/finetune/jobs/job-404', {headers: TEAM});
  assert.equal(r.status, 404, \`an unknown id answered \${r.status}, expected 404\`);
  r = await c.get('/v1/finetune/jobs/job-7');
  assert.equal(r.status, 401, \`without X-Team-Id the read must answer 401, got \${r.status}\`);
}

export async function check_tenant_scope(ctx) {
  seed(ctx, 'job-7', 'succeeded', true);
  const c = api(ctx);
  const r = await c.get('/v1/finetune/jobs/job-7', {headers: {'X-Team-Id': 'ml-legal'}});
  assert.equal(r.status, 404, \`ml-legal read ml-search's job and got \${r.status}: another team's job answers 404, as an unknown id does, so a guessed id confirms nothing\`);
  assert(!r.text.includes('ckpt-job-7'), \`the refusal leaks the job: \${r.text}\`);
}

export async function check_promotable_gate(ctx) {
  seed(ctx, 'job-7', 'succeeded', false);
  seed(ctx, 'job-8', 'succeeded');
  seed(ctx, 'job-9', 'succeeded', true);
  seed(ctx, 'job-10', 'failed', true);
  const c = api(ctx);
  let body = await read(c, 'job-7');
  assert(body.trained === true && body.promotable === false, \`job-7 trained but failed its golden set and reads promotable=\${JSON.stringify(body.promotable)}: a failed eval must keep it out of the registry\`);
  assert.deepEqual(body.eval, {passed: false, score: 0.71}, \`the eval is reported as {passed, score}, got \${JSON.stringify(body.eval)}\`);
  body = await read(c, 'job-8');
  assert(body.promotable === false && body.eval === null, \`job-8 has no eval yet: promotable must be false and eval null, got \${JSON.stringify(body)}\`);
  body = await read(c, 'job-9');
  assert.equal(body.promotable, true, \`job-9 succeeded and passed its eval, so it is promotable: \${JSON.stringify(body)}\`);
  body = await read(c, 'job-10');
  assert.equal(body.promotable, false, \`job-10 failed training: a passing eval of an earlier checkpoint does not make it promotable, got \${JSON.stringify(body)}\`);
}

export async function check_budget_reconcile(ctx) {
  seed(ctx, 'job-7', 'succeeded', true);
  const body = await read(api(ctx), 'job-7');
  assert.deepEqual(body.budget, {reserved: 600, spent: 450, remaining: 150}, \`job-7 reserved 600 GPU-hours and spent 450, so its budget reads {reserved: 600, spent: 450, remaining: 150}; got \${JSON.stringify(body.budget)} (the team's pool holds 5000, which is not this job's remainder)\`);
}

export async function check_lineage(ctx) {
  seed(ctx, 'job-7', 'succeeded', true);
  const body = await read(api(ctx), 'job-7');
  assert.deepEqual(body.checkpoint_ids, ['ckpt-job-7-1', 'ckpt-job-7-2'], \`a run restarted twice must show both checkpoints in order, got checkpoint_ids=\${JSON.stringify(body.checkpoint_ids)}: with only the latest nobody can explain the restarts\`);
}
`,
    go: `package main

import (
	"net/http"
	"strings"

	"leetbuild/harness"
)

var readTeam = []string{"X-Team-Id", "ml-search"}

// readSeed stores a job of status for ml-search, its reservation (600 reserved, 450 spent), a pool
// of 5000, and an eval: "pass", "fail" or "" for none yet.
func readSeed(ctx *harness.Ctx, jobID, status, eval string) {
	ctx.Redis.Do("HSET", "ft:job:"+jobID, "job_id", jobID, "team", "ml-search", "status", status, "base_model", "llama-3.1-8b",
		"dataset_version", "support-tickets@v3", "dataset_sha256", strings.Repeat("b1", 32), "config_hash", strings.Repeat("7e", 32),
		"compute_budget", "600", "hyperparameters", \`{"learning_rate":0.0002,"lora_rank":16}\`,
		"checkpoint_ids", \`["ckpt-\`+jobID+\`-1","ckpt-\`+jobID+\`-2"]\`)
	ctx.Redis.Do("HSET", "ft:reservation:"+jobID, "team", "ml-search", "reserved", "600", "spent", "450", "state", "completed")
	ctx.Redis.Set("ft:pool:ml-search", "5000")
	if eval == "pass" {
		ctx.Redis.Do("HSET", "ft:eval:"+jobID, "passed", "1", "score", "0.91")
	}
	if eval == "fail" {
		ctx.Redis.Do("HSET", "ft:eval:"+jobID, "passed", "0", "score", "0.71")
	}
}

func readClient(ctx *harness.Ctx) *harness.HTTP {
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

func readBody(ctx *harness.Ctx, c *harness.HTTP, jobID string) map[string]any {
	r := c.Get("/v1/finetune/jobs/"+jobID, readTeam...)
	body, ok := r.JSON().(map[string]any)
	ctx.Assert(ok, "the body must be a JSON object: %s", r.Text())
	return body
}

func CheckRoute(ctx *harness.Ctx) {
	readSeed(ctx, "job-7", "succeeded", "pass")
	c := readClient(ctx)
	r := c.Get("/v1/finetune/jobs/job-7", readTeam...)
	ctx.Equal(r.Status, 200, "the team's own job (%s)", r.Text())
	body := readBody(ctx, c, "job-7")
	ctx.Assert(body["job_id"] == "job-7" && body["status"] == "succeeded" && body["trained"] == true, "the answer carries job_id, status and trained: %v", body)
	ctx.Equal(c.Get("/v1/finetune/jobs/job-404", readTeam...).Status, 404, "an unknown id")
	ctx.Equal(c.Get("/v1/finetune/jobs/job-7").Status, 401, "without X-Team-Id the read")
}

func CheckTenantScope(ctx *harness.Ctx) {
	readSeed(ctx, "job-7", "succeeded", "pass")
	r := readClient(ctx).Get("/v1/finetune/jobs/job-7", "X-Team-Id", "ml-legal")
	ctx.Equal(r.Status, 404, "ml-legal read ml-search's job: another team's job answers 404, as an unknown id does, so a guessed id confirms nothing")
	ctx.Assert(!strings.Contains(r.Text(), "ckpt-job-7"), "the refusal leaks the job: %s", r.Text())
}

func CheckPromotableGate(ctx *harness.Ctx) {
	readSeed(ctx, "job-7", "succeeded", "fail")
	readSeed(ctx, "job-8", "succeeded", "")
	readSeed(ctx, "job-9", "succeeded", "pass")
	readSeed(ctx, "job-10", "failed", "pass")
	c := readClient(ctx)
	body := readBody(ctx, c, "job-7")
	ctx.Assert(body["trained"] == true && body["promotable"] == false, "job-7 trained but failed its golden set and reads promotable=%v: a failed eval must keep it out of the registry", body["promotable"])
	ctx.Equal(body["eval"], map[string]any{"passed": false, "score": 0.71}, "the eval is reported as {passed, score}")
	body = readBody(ctx, c, "job-8")
	_, hasEval := body["eval"]
	ctx.Assert(body["promotable"] == false && hasEval && body["eval"] == nil, "job-8 has no eval yet: promotable must be false and eval null, got %v", body)
	ctx.Equal(readBody(ctx, c, "job-9")["promotable"], true, "job-9 succeeded and passed its eval, so it is promotable")
	ctx.Equal(readBody(ctx, c, "job-10")["promotable"], false, "job-10 failed training: a passing eval of an earlier checkpoint does not make it promotable")
}

func CheckBudgetReconcile(ctx *harness.Ctx) {
	readSeed(ctx, "job-7", "succeeded", "pass")
	body := readBody(ctx, readClient(ctx), "job-7")
	ctx.Equal(body["budget"], map[string]any{"reserved": float64(600), "spent": float64(450), "remaining": float64(150)}, "job-7 reserved 600 GPU-hours and spent 450 (the team's pool holds 5000, which is not this job's remainder); the budget")
}

func CheckLineage(ctx *harness.Ctx) {
	readSeed(ctx, "job-7", "succeeded", "pass")
	body := readBody(ctx, readClient(ctx), "job-7")
	ctx.Equal(body["checkpoint_ids"], []any{"ckpt-job-7-1", "ckpt-job-7-2"}, "a run restarted twice must show both checkpoints in order (with only the latest nobody can explain the restarts); checkpoint_ids")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <string>

namespace {

using json = nlohmann::json;

// A job of status for ml-search, its reservation (600 reserved, 450 spent), a pool of 5000, and an
// eval: "pass", "fail" or "" for none yet.
void seedRead(harness::Ctx& ctx, const std::string& job_id, const std::string& status, const std::string& eval) {
  ctx.Redis.Do("HSET", "ft:job:" + job_id, "job_id", job_id, "team", "ml-search", "status", status, "base_model", "llama-3.1-8b", "dataset_version",
               "support-tickets@v3", "dataset_sha256", "b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1", "config_hash",
               "7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e", "compute_budget", "600", "hyperparameters",
               R"({"learning_rate":0.0002,"lora_rank":16})", "checkpoint_ids", "[\\"ckpt-" + job_id + "-1\\",\\"ckpt-" + job_id + "-2\\"]");
  ctx.Redis.Do("HSET", "ft:reservation:" + job_id, "team", "ml-search", "reserved", "600", "spent", "450", "state", "completed");
  ctx.Redis.Set("ft:pool:ml-search", "5000");
  if (eval == "pass") ctx.Redis.Do("HSET", "ft:eval:" + job_id, "passed", "1", "score", "0.91");
  if (eval == "fail") ctx.Redis.Do("HSET", "ft:eval:" + job_id, "passed", "0", "score", "0.71");
}

struct ReadApi {
  httplib::Server svr;
  harness::HTTP http;
  explicit ReadApi(harness::Ctx& ctx) : http(ctx.HTTP(svr)) { register_routes(svr); }

  json body(harness::Ctx& ctx, const std::string& job_id) {
    const auto r = http.Get("/v1/finetune/jobs/" + job_id, "X-Team-Id", "ml-search");
    const json out = json::parse(r.Text(), nullptr, false);
    ctx.Assert(out.is_object(), "the body must be a JSON object: %s", r.Text());
    return out;
  }
};

}  // namespace

void CheckRoute(harness::Ctx& ctx) {
  seedRead(ctx, "job-7", "succeeded", "pass");
  ReadApi api(ctx);
  const auto r = api.http.Get("/v1/finetune/jobs/job-7", "X-Team-Id", "ml-search");
  ctx.Equal(r.Status, 200, "the team's own job (%s)", r.Text());
  const json body = api.body(ctx, "job-7");
  ctx.Assert(body.value("job_id", "") == "job-7" && body.value("status", "") == "succeeded" && body.value("trained", false), "the answer carries job_id, status and trained: %v", body);
  ctx.Equal(api.http.Get("/v1/finetune/jobs/job-404", "X-Team-Id", "ml-search").Status, 404, "an unknown id");
  ctx.Equal(api.http.Get("/v1/finetune/jobs/job-7").Status, 401, "without X-Team-Id the read");
}

void CheckTenantScope(harness::Ctx& ctx) {
  seedRead(ctx, "job-7", "succeeded", "pass");
  ReadApi api(ctx);
  const auto r = api.http.Get("/v1/finetune/jobs/job-7", "X-Team-Id", "ml-legal");
  ctx.Equal(r.Status, 404, "ml-legal read ml-search's job: another team's job answers 404, as an unknown id does, so a guessed id confirms nothing");
  ctx.Assert(r.Text().find("ckpt-job-7") == std::string::npos, "the refusal leaks the job: %s", r.Text());
}

void CheckPromotableGate(harness::Ctx& ctx) {
  seedRead(ctx, "job-7", "succeeded", "fail");
  seedRead(ctx, "job-8", "succeeded", "");
  seedRead(ctx, "job-9", "succeeded", "pass");
  seedRead(ctx, "job-10", "failed", "pass");
  ReadApi api(ctx);
  json body = api.body(ctx, "job-7");
  ctx.Assert(body.value("trained", false) && body.contains("promotable") && body["promotable"] == false, "job-7 trained but failed its golden set and reads promotable=%v: a failed eval must keep it out of the registry", body.value("promotable", json()));
  ctx.Equal(body.value("eval", json()), json({{"passed", false}, {"score", 0.71}}), "the eval is reported as {passed, score}");
  body = api.body(ctx, "job-8");
  ctx.Assert(body.contains("promotable") && body["promotable"] == false && body.contains("eval") && body["eval"].is_null(), "job-8 has no eval yet: promotable must be false and eval null, got %v", body);
  ctx.Equal(api.body(ctx, "job-9").value("promotable", json()), json(true), "job-9 succeeded and passed its eval, so it is promotable");
  ctx.Equal(api.body(ctx, "job-10").value("promotable", json()), json(false), "job-10 failed training: a passing eval of an earlier checkpoint does not make it promotable");
}

void CheckBudgetReconcile(harness::Ctx& ctx) {
  seedRead(ctx, "job-7", "succeeded", "pass");
  ReadApi api(ctx);
  ctx.Equal(api.body(ctx, "job-7").value("budget", json()), json({{"reserved", 600}, {"spent", 450}, {"remaining", 150}}),
            "job-7 reserved 600 GPU-hours and spent 450 (the team's pool holds 5000, which is not this job's remainder); the budget");
}

void CheckLineage(harness::Ctx& ctx) {
  seedRead(ctx, "job-7", "succeeded", "pass");
  ReadApi api(ctx);
  ctx.Equal(api.body(ctx, "job-7").value("checkpoint_ids", json()), json({"ckpt-job-7-1", "ckpt-job-7-2"}),
            "a run restarted twice must show both checkpoints in order (with only the latest nobody can explain the restarts); checkpoint_ids");
}
`,
  },
  hints: [
    'Symptom: a run that failed its golden set shows as promotable, another team reads your runs by guessing ids, the budget\u2019s `remaining` is the team\u2019s whole pool, and a run restarted twice shows one checkpoint.',
    'Mechanism: `promotable` is assigned `trained`; the 404 branch tests only `job is None`; `remaining` comes from `pool_key(team)`; the response keeps `checkpoint_ids[-1]`.',
    'Change: 404 when `job["team"] != team`; `promotable = trained and result is not None and result["passed"]`; `remaining = reserved - spent` from the reservation hash; return `checkpoint_ids` whole.',
  ],
  debrief: `A read path is where a pipeline\u2019s decisions become someone else\u2019s inputs, so it must not round anything up. "Trained" and "promotable" are separate facts because the trainer and the eval answer different questions, and a registry that promotes on exit status alone ships every model that merely finished. The 404 for a foreign job keeps ids from being an oracle. The budget reconciles against the job\u2019s own reservation from step 2, so reserved, spent and remaining add up and can be audited later; the pool is a team-wide number. The lineage is what makes step 3\u2019s restarts explainable. A production API also signs promotion decisions, records which eval run gated them, and pages the owner when a promoted model\u2019s eval is later revised.`,
};
