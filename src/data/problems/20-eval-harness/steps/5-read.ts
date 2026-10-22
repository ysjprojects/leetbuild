import type {Step} from '@/lib/types';

export const readStep: Step = {
  id: 'read',
  title: 'GET /v1/evals/runs/{id}: the gate that reads the record',
  concept: 'http',
  file: 'read',
  focus: ['client', 'harness', 'redis'],
  task: `## Task

The starter is a plausible model-generated draft: a run report comes back and the demo shows a
green badge. It authorizes nothing, it rewards a handful of samples, and it serves a stale copy.
Find the flaws, fix them, and prove the fix.

Implement \`GET /v1/evals/runs/{id}\`, the endpoint the release pipeline reads before it ships:

- The run is looked up for the **authenticated tenant**; a run that belongs to another tenant, or
  does not exist, answers **404**. The draft serves any run id it is handed.
- A run is only judged once it has at least **200 scored samples** (\`MIN_SCORED_SAMPLES\`); below
  that the report is **\`pending\`**. Twelve samples out of five hundred cannot pass a release.
- Above the floor the run **passes** only when the pass rate clears \`RELEASE_THRESHOLD\` **and**
  beats the previous release's pass rate by more than nothing: a version that merely ties the
  incumbent has not earned a rollout. Otherwise it is **\`failed\`**.
- The threshold comes from **server config** (\`RELEASE_THRESHOLD\`). A \`threshold\` in the query
  string is ignored — the caller does not get to choose the bar its own release must clear.
- The cache key includes the **scored count**: \`report:{tenant}:{run_id}:{scored}\`, so the report
  changes the moment the last sample lands instead of for the rest of the TTL. The draft caches per
  run and serves the copy taken when the run was at 12 samples.

**Failure mode the checks target.** The report is the artifact a release decision is made from, so
all three flaws are release bugs rather than display bugs: a caller who can lower the bar, a run
declared green on a sample it never scored, and a cached report that hides the failures of the last
batch. The subtle one is the cache key — it looks like a performance detail and is actually the
reason the last failures never reach the person clicking ship.`,
  sequence: {
    participants: ['Client', 'Eval Harness', 'Redis'],
    messages: [
      {from: 'Client', to: 'Eval Harness', label: 'GET /v1/evals/runs/run-7 · X-Tenant-Id', kind: 'sync'},
      {from: 'Eval Harness', to: 'Redis', label: 'HGET runs tenant:run-7', kind: 'sync'},
      {from: 'Redis', to: 'Eval Harness', label: 'owner + previous_release_rate / nil → 404', kind: 'reply'},
      {from: 'Eval Harness', to: 'Redis', label: 'HGET evals:run:run-7 scored · passed · failed', kind: 'sync'},
      {from: 'Redis', to: 'Eval Harness', label: '{scored, passed, failed}', kind: 'reply'},
      {
        from: 'Eval Harness',
        to: 'Eval Harness',
        label: 'scored < 200 → pending · else gate on RELEASE_THRESHOLD',
        kind: 'sync',
      },
      {from: 'Eval Harness', to: 'Redis', label: 'GET report:acme:run-7:{scored}', kind: 'sync'},
      {from: 'Eval Harness', to: 'Client', label: '{status, scored, passed, failed, pass_rate}', kind: 'reply'},
    ],
  },
  hints: [
    'Authorize the read like the write: fetch the run record under the authenticated tenant first and answer `404` for anything else, so a foreign run id is indistinguishable from a missing one.',
    'Compare the counters with the floor before you compare the rate: below `MIN_SCORED_SAMPLES` the only honest answer is `pending`, and the body should carry the floor and the current `scored` so the caller knows how far along the run is.',
    'Put the scored count in the cache key: `report:{tenant}:{run_id}:{scored}` is a different key the moment a sample lands, so the read after the last batch misses the stale entry. Ignore any `threshold` the caller passes — the constant in the config is what the pipeline was told to trust.',
  ],
  checks: [
    {
      id: 'min-samples',
      title: 'Requires 200 scored samples before a verdict',
      detail:
        'The gate is a named `MIN_SCORED_SAMPLES = 200` floor: a run with fewer scored samples can never be passed off a handful of them. The draft declares a run green on whatever it has.',
      match: {
        python: {all: [/MIN_SCORED_SAMPLES\s*=\s*200/]},
        typescript: {all: [/MIN_SCORED_SAMPLES\s*=\s*200/]},
        go: {all: [/minScoredSamples\s*=\s*200/]},
        scala: {all: [/MinScoredSamples\s*=\s*200/]},
        cpp: {all: [/kMinScoredSamples\s*=\s*200/]},
      },
    },
    {
      id: 'pending-gate',
      title: 'Reports pending until the run is complete',
      detail:
        'Below the floor the status is `pending` (with the floor and the current count in the body), so a partial run cannot be mistaken for a verdict. The draft jumps straight to passed/failed.',
      match: {
        python: {all: [/MIN_SCORED_SAMPLES/, /"pending"/]},
        typescript: {all: [/MIN_SCORED_SAMPLES/, /'pending'/]},
        go: {all: [/minScoredSamples/, /"pending"/]},
        scala: {all: [/MinScoredSamples/, /"pending"/]},
        cpp: {all: [/kMinScoredSamples/, /"pending"/]},
      },
    },
    {
      id: 'threshold-config',
      title: 'Takes the threshold from server config, not the query string',
      detail:
        'The bar is `RELEASE_THRESHOLD` from server config; a `threshold` passed in the query string is ignored. The draft lets the caller lower the bar its own release is measured against.',
      match: {
        python: {all: [/RELEASE_THRESHOLD/], none: [/threshold\s*:\s*float/, /query_params\.get\(\s*["']threshold/]},
        typescript: {all: [/RELEASE_THRESHOLD/], none: [/query[^;\n]*threshold/]},
        go: {all: [/releaseThreshold/], none: [/URL\.Query\(\)\.Get\("threshold"\)/]},
        scala: {all: [/ReleaseThreshold/], none: [/parameter\("threshold"/]},
        cpp: {all: [/kReleaseThreshold/], none: [/get_param_value\("threshold"\)/]},
      },
    },
    {
      id: 'fresh-cache',
      title: 'Invalidates the report when the scored count moves',
      detail:
        'The cache key carries the scored count, so the report read after the last batch misses the stale entry. The draft caches under the run id alone and keeps serving the copy from earlier in the run.',
      match: {
        python: {all: [/latest_scored/, /report:/]},
        typescript: {all: [/latestScored/, /report:/]},
        go: {all: [/latestScored/, /report:/]},
        scala: {all: [/latestScored/, /report:/]},
        cpp: {all: [/latest_scored/, /report:/]},
      },
    },
    {
      id: 'tenant-scope',
      title: 'Scopes the report to the authenticated tenant',
      detail:
        'The run is authorized against the request tenant before its counters are read, and a foreign run answers **404**. The draft serves any run id in the path.',
      match: {
        python: {all: [/assert_tenant_owns/, /404/]},
        typescript: {all: [/assertTenantOwns/, /404/]},
        go: {all: [/assertTenantOwns/, /StatusNotFound/]},
        scala: {all: [/assertTenantOwns/, /NotFound/]},
        cpp: {all: [/assert_tenant_owns/, /404/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json

import redis
from fastapi import FastAPI, Header
from pydantic import BaseModel

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)


class Report(BaseModel):
    pass


@app.get("/v1/evals/runs/{id}")
def read_run(id: str, tenant: str = Header(alias="X-Tenant-Id"), threshold: float = 0.9) -> dict:
    # TODO: ignore the caller-supplied threshold, require a minimum number of scored samples before
    # any verdict, authorize the run against the tenant, and key the cache on the scored count so
    # the report is current.
    cached = r.get(f"report:{id}")
    if cached is not None:
        return json.loads(cached)
    key = f"evals:run:{id}"
    scored = int(r.hget(key, "scored") or 0)
    passed = int(r.hget(key, "passed") or 0)
    failed = int(r.hget(key, "failed") or 0)
    rate = (passed / scored) if scored else 0.0
    body = {
        "run_id": id,
        "status": "passed" if rate >= threshold else "failed",
        "scored": scored,
        "passed": passed,
        "failed": failed,
        "pass_rate": rate,
    }
    r.set(f"report:{id}", json.dumps(body), ex=60)
    return body
`,
      solution: `import json

import redis
from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)

MIN_SCORED_SAMPLES = 200
RELEASE_THRESHOLD = 0.9


class RunRecord(BaseModel):
    run_id: str
    dataset_id: str
    model_version: str
    previous_release_rate: float


def assert_tenant_owns(tenant: str, run_id: str) -> RunRecord:
    raw = r.hget("runs", f"{tenant}:{run_id}")
    if raw is None:
        raise HTTPException(status_code=404, detail="run not found")
    return RunRecord(**json.loads(raw))


def read_counters(run_id: str) -> dict:
    key = f"evals:run:{run_id}"
    return {
        "scored": int(r.hget(key, "scored") or 0),
        "passed": int(r.hget(key, "passed") or 0),
        "failed": int(r.hget(key, "failed") or 0),
    }


@app.get("/v1/evals/runs/{id}")
def read_run(id: str, tenant: str = Header(alias="X-Tenant-Id")) -> dict:
    record = assert_tenant_owns(tenant, id)
    counters = read_counters(id)
    scored = counters["scored"]
    latest_scored = scored
    cached = r.get(f"report:{tenant}:{id}:{latest_scored}")
    if cached is not None:
        return json.loads(cached)

    body = {
        "run_id": id,
        "dataset_id": record.dataset_id,
        "model_version": record.model_version,
        "scored": scored,
        "passed": counters["passed"],
        "failed": counters["failed"],
    }
    if scored < MIN_SCORED_SAMPLES:
        body.update({"status": "pending", "required_scored": MIN_SCORED_SAMPLES, "pass_rate": None})
    else:
        rate = counters["passed"] / scored
        gate = rate >= RELEASE_THRESHOLD and rate > record.previous_release_rate
        body.update({"status": "passed" if gate else "failed", "pass_rate": round(rate, 4)})
    r.set(f"report:{tenant}:{id}:{latest_scored}", json.dumps(body), ex=60)
    return body
`,
    },
    typescript: {
      starter: `/** GET /v1/evals/runs/:id: a model-generated draft that lets the caller set the bar. */
import Fastify from 'fastify';
import {Redis} from 'ioredis';

export const app = Fastify();
const r = new Redis('redis://redis:6379');

interface Report {
  run_id: string;
  status: string;
  scored: number;
  passed: number;
  failed: number;
  pass_rate: number;
}

app.get('/v1/evals/runs/:id', async (request, reply) => {
  const {id} = request.params as {id: string};
  // TODO: ignore the caller-supplied threshold, require a minimum number of scored samples before
  // any verdict, authorize the run against the tenant, and key the cache on the scored count so the
  // report is current.
  const query = request.query as {threshold?: string};
  const threshold = Number(query.threshold ?? 0.9);
  const cached = await r.get(\`report:\${id}\`);
  if (cached !== null) return reply.code(200).send(JSON.parse(cached));
  const key = \`evals:run:\${id}\`;
  const scored = Number((await r.hget(key, 'scored')) ?? 0);
  const passed = Number((await r.hget(key, 'passed')) ?? 0);
  const failed = Number((await r.hget(key, 'failed')) ?? 0);
  const rate = scored === 0 ? 0 : passed / scored;
  const body: Report = {
    run_id: id,
    status: rate >= threshold ? 'passed' : 'failed',
    scored,
    passed,
    failed,
    pass_rate: rate,
  };
  await r.set(\`report:\${id}\`, JSON.stringify(body), 'EX', 60);
  return reply.code(200).send(body);
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** GET /v1/evals/runs/:id: tenant-scoped, gated on a complete record, cached on the count. */
import Fastify from 'fastify';
import {Redis} from 'ioredis';

export const app = Fastify();
const r = new Redis('redis://redis:6379');

const MIN_SCORED_SAMPLES = 200;
const RELEASE_THRESHOLD = 0.9;

interface RunRecord {
  run_id: string;
  dataset_id: string;
  model_version: string;
  previous_release_rate: number;
}

interface Report {
  run_id: string;
  dataset_id: string;
  model_version: string;
  status: string;
  scored: number;
  passed: number;
  failed: number;
  pass_rate: number | null;
  required_scored?: number;
}

async function assertTenantOwns(tenant: string, runId: string): Promise<RunRecord> {
  const raw = await r.hget('runs', \`\${tenant}:\${runId}\`);
  if (raw === null) {
    const error = new Error('run not found') as Error & {statusCode: number};
    error.statusCode = 404;
    throw error;
  }
  return JSON.parse(raw) as RunRecord;
}

app.get('/v1/evals/runs/:id', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'] as string;
  const {id} = request.params as {id: string};
  const record = await assertTenantOwns(tenant, id);
  const key = \`evals:run:\${id}\`;
  const counters = {
    scored: Number((await r.hget(key, 'scored')) ?? 0),
    passed: Number((await r.hget(key, 'passed')) ?? 0),
    failed: Number((await r.hget(key, 'failed')) ?? 0),
  };
  const latestScored = counters.scored;
  const cached = await r.get(\`report:\${tenant}:\${id}:\${latestScored}\`);
  if (cached !== null) return reply.code(200).send(JSON.parse(cached));

  const body: Report = {
    run_id: id,
    dataset_id: record.dataset_id,
    model_version: record.model_version,
    status: 'pending',
    scored: latestScored,
    passed: counters.passed,
    failed: counters.failed,
    pass_rate: null,
  };
  if (latestScored < MIN_SCORED_SAMPLES) {
    body.required_scored = MIN_SCORED_SAMPLES;
  } else {
    const rate = counters.passed / latestScored;
    body.status = rate >= RELEASE_THRESHOLD && rate > record.previous_release_rate ? 'passed' : 'failed';
    body.pass_rate = Math.round(rate * 10000) / 10000;
  }
  await r.set(\`report:\${tenant}:\${id}:\${latestScored}\`, JSON.stringify(body), 'EX', 60);
  return reply.code(200).send(body);
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"

	"github.com/redis/go-redis/v9"
)

var rdb *redis.Client

func readRun(rw http.ResponseWriter, r *http.Request) {
	ctx := context.Background()
	id := r.PathValue("id")
	// TODO: ignore the caller-supplied threshold, require a minimum number of scored samples before
	// any verdict, authorize the run against the tenant, and key the cache on the scored count so
	// the report is current.
	threshold, _ := strconv.ParseFloat(r.URL.Query().Get("threshold"), 64)
	if cached, err := rdb.Get(ctx, "report:"+id).Result(); err == nil {
		rw.Header().Set("Content-Type", "application/json")
		_, _ = rw.Write([]byte(cached))
		return
	}
	key := "evals:run:" + id
	scored, _ := rdb.HGet(ctx, key, "scored").Int64()
	passed, _ := rdb.HGet(ctx, key, "passed").Int64()
	failed, _ := rdb.HGet(ctx, key, "failed").Int64()
	rate := 0.0
	if scored > 0 {
		rate = float64(passed) / float64(scored)
	}
	status := "failed"
	if rate >= threshold {
		status = "passed"
	}
	body, _ := json.Marshal(map[string]any{
		"run_id":    id,
		"status":    status,
		"scored":    scored,
		"passed":    passed,
		"failed":    failed,
		"pass_rate": rate,
	})
	rdb.Set(ctx, "report:"+id, body, 0)
	rw.Header().Set("Content-Type", "application/json")
	_, _ = rw.Write(body)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/evals/runs/{id}", readRun)
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"

	"github.com/redis/go-redis/v9"
)

const (
	minScoredSamples = 200
	releaseThreshold = 0.9
)

var rdb *redis.Client

type RunRecord struct {
	RunID               string  \`json:"run_id"\`
	DatasetID           string  \`json:"dataset_id"\`
	ModelVersion        string  \`json:"model_version"\`
	PreviousReleaseRate float64 \`json:"previous_release_rate"\`
}

func assertTenantOwns(ctx context.Context, tenant, runID string) (RunRecord, error) {
	raw, err := rdb.HGet(ctx, "runs", tenant+":"+runID).Result()
	if err != nil {
		return RunRecord{}, err
	}
	var record RunRecord
	if err := json.Unmarshal([]byte(raw), &record); err != nil {
		return RunRecord{}, err
	}
	return record, nil
}

func readRun(rw http.ResponseWriter, r *http.Request) {
	ctx := context.Background()
	tenant := r.Header.Get("X-Tenant-Id")
	id := r.PathValue("id")
	record, err := assertTenantOwns(ctx, tenant, id)
	if err != nil {
		rw.WriteHeader(http.StatusNotFound)
		return
	}
	key := "evals:run:" + id
	scored, _ := rdb.HGet(ctx, key, "scored").Int64()
	passed, _ := rdb.HGet(ctx, key, "passed").Int64()
	failed, _ := rdb.HGet(ctx, key, "failed").Int64()
	latestScored := scored
	if cached, err := rdb.Get(ctx, "report:"+tenant+":"+id+":"+strconv.FormatInt(latestScored, 10)).Result(); err == nil {
		rw.Header().Set("Content-Type", "application/json")
		_, _ = rw.Write([]byte(cached))
		return
	}
	body := map[string]any{
		"run_id":        id,
		"dataset_id":    record.DatasetID,
		"model_version": record.ModelVersion,
		"scored":        scored,
		"passed":        passed,
		"failed":        failed,
		"pass_rate":     nil,
	}
	if scored < minScoredSamples {
		body["status"] = "pending"
		body["required_scored"] = minScoredSamples
	} else {
		rate := float64(passed) / float64(scored)
		if rate >= releaseThreshold && rate > record.PreviousReleaseRate {
			body["status"] = "passed"
		} else {
			body["status"] = "failed"
		}
		body["pass_rate"] = rate
	}
	encoded, _ := json.Marshal(body)
	rdb.Set(ctx, "report:"+tenant+":"+id+":"+strconv.FormatInt(latestScored, 10), encoded, 0)
	rw.Header().Set("Content-Type", "application/json")
	_, _ = rw.Write(encoded)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/evals/runs/{id}", readRun)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import redis.clients.jedis.Jedis

object ReportApi {
  implicit val system: ActorSystem = ActorSystem("eval-harness")
  val r = new Jedis("redis", 6379)

  val route: Route =
    path("v1" / "evals" / "runs" / Segment) { id =>
      get {
        parameter("threshold".?) { thresholdOpt =>
          // TODO: ignore the caller-supplied threshold, require a minimum number of scored samples
          // before any verdict, authorize the run against the tenant, and key the cache on the
          // scored count so the report is current.
          val threshold = thresholdOpt.map(_.toDouble).getOrElse(0.9)
          complete {
            Option(r.get(s"report:$id")) match {
              case Some(cached) => HttpResponse(StatusCodes.OK, entity = cached)
              case None =>
                val key = s"evals:run:$id"
                val scored = Option(r.hget(key, "scored")).map(_.toLong).getOrElse(0L)
                val passed = Option(r.hget(key, "passed")).map(_.toLong).getOrElse(0L)
                val rate = if (scored == 0) 0.0 else passed.toDouble / scored
                val status = if (rate >= threshold) "passed" else "failed"
                val body = s"""{"run_id":"$id","status":"$status","scored":$scored,"pass_rate":$rate}"""
                r.set(s"report:$id", body)
                HttpResponse(StatusCodes.OK, entity = body)
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
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import redis.clients.jedis.Jedis
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class RunRecord(
    run_id: String,
    dataset_id: String,
    model_version: String,
    previous_release_rate: Double
)

object ReportApi {
  implicit val system: ActorSystem = ActorSystem("eval-harness")
  implicit val recordFormat: RootJsonFormat[RunRecord] = jsonFormat4(RunRecord)
  val r = new Jedis("redis", 6379)

  val MinScoredSamples = 200
  val ReleaseThreshold = 0.9

  def assertTenantOwns(tenant: String, runId: String): RunRecord = {
    Option(r.hget("runs", s"$tenant:$runId")) match {
      case Some(raw) => recordFormat.read(raw.parseJson)
      case None => throw new NoSuchElementException("run not found")
    }
  }

  val route: Route =
    path("v1" / "evals" / "runs" / Segment) { id =>
      get {
        headerValueByName("X-Tenant-Id") { tenant =>
          complete {
            val maybeRecord =
              try Some(assertTenantOwns(tenant, id))
              catch { case _: NoSuchElementException => None }
            maybeRecord match {
              case None => HttpResponse(StatusCodes.NotFound, entity = """{"error":"run not found"}""")
              case Some(record) =>
                val key = s"evals:run:$id"
                val scored = Option(r.hget(key, "scored")).map(_.toLong).getOrElse(0L)
                val passed = Option(r.hget(key, "passed")).map(_.toLong).getOrElse(0L)
                val failed = Option(r.hget(key, "failed")).map(_.toLong).getOrElse(0L)
                val latestScored = scored
                Option(r.get(s"report:$tenant:$id:$latestScored")) match {
                  case Some(cached) => HttpResponse(StatusCodes.OK, entity = cached)
                  case None =>
                    val (status, rate) =
                      if (scored < MinScoredSamples) ("pending", None)
                      else {
                        val value = passed.toDouble / scored
                        val gate = value >= ReleaseThreshold && value > record.previous_release_rate
                        (if (gate) "passed" else "failed", Some(value))
                      }
                    val body =
                      s"""{"run_id":"$id","dataset_id":"\${record.dataset_id}","status":"$status","scored":$scored,"passed":$passed,"failed":$failed,"pass_rate":\${rate.getOrElse(0.0)}}"""
                    r.set(s"report:$tenant:$id:$latestScored", body)
                    HttpResponse(StatusCodes.OK, entity = body)
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

#include <string>

using json = nlohmann::json;

int main() {
  sw::redis::Redis redis("tcp://redis:6379");
  httplib::Server svr;

  svr.Get("/v1/evals/runs/:id", [&redis](const httplib::Request& req, httplib::Response& res) {
    const auto id = req.path_params.at("id");
    // TODO: ignore the caller-supplied threshold, require a minimum number of scored samples before
    // any verdict, authorize the run against the tenant, and key the cache on the scored count so
    // the report is current.
    const double threshold = req.has_param("threshold") ? std::stod(req.get_param_value("threshold")) : 0.9;
    if (auto cached = redis.get("report:" + id)) {
      res.status = 200;
      res.set_content(*cached, "application/json");
      return;
    }
    const auto key = "evals:run:" + id;
    auto rawScored = redis.hget(key, "scored");
    auto rawPassed = redis.hget(key, "passed");
    const long long scored = rawScored ? std::stoll(*rawScored) : 0;
    const long long passed = rawPassed ? std::stoll(*rawPassed) : 0;
    const double rate = scored == 0 ? 0.0 : static_cast<double>(passed) / static_cast<double>(scored);
    const json body = {
        {"run_id", id},
        {"status", rate >= threshold ? "passed" : "failed"},
        {"scored", scored},
        {"passed", passed},
        {"pass_rate", rate},
    };
    redis.set("report:" + id, body.dump());
    res.status = 200;
    res.set_content(body.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <optional>
#include <string>

using json = nlohmann::json;

constexpr long long kMinScoredSamples = 200;
constexpr double kReleaseThreshold = 0.9;

struct RunRecord {
  std::string run_id;
  std::string dataset_id;
  std::string model_version;
  double previous_release_rate = 0.0;
};

RunRecord assert_tenant_owns(sw::redis::Redis& redis, const std::string& tenant, const std::string& runId);

int main() {
  sw::redis::Redis redis("tcp://redis:6379");
  httplib::Server svr;

  svr.Get("/v1/evals/runs/:id", [&redis](const httplib::Request& req, httplib::Response& res) {
    const auto tenant = req.get_header_value("X-Tenant-Id");
    const auto id = req.path_params.at("id");
    const auto record = assert_tenant_owns(redis, tenant, id);
    if (record.run_id.empty()) {
      res.status = 404;
      res.set_content(R"({"error":"run not found"})", "application/json");
      return;
    }
    const auto key = "evals:run:" + id;
    auto rawScored = redis.hget(key, "scored");
    auto rawPassed = redis.hget(key, "passed");
    auto rawFailed = redis.hget(key, "failed");
    const long long scored = rawScored ? std::stoll(*rawScored) : 0;
    const long long passed = rawPassed ? std::stoll(*rawPassed) : 0;
    const long long failed = rawFailed ? std::stoll(*rawFailed) : 0;
    const long long latest_scored = scored;
    if (auto cached = redis.get("report:" + tenant + ":" + id + ":" + std::to_string(latest_scored))) {
      res.status = 200;
      res.set_content(*cached, "application/json");
      return;
    }
    json body = {
        {"run_id", id},
        {"dataset_id", record.dataset_id},
        {"model_version", record.model_version},
        {"scored", scored},
        {"passed", passed},
        {"failed", failed},
        {"pass_rate", nullptr},
    };
    if (scored < kMinScoredSamples) {
      body["status"] = "pending";
      body["required_scored"] = kMinScoredSamples;
    } else {
      const double rate = static_cast<double>(passed) / static_cast<double>(scored);
      const bool gate = rate >= kReleaseThreshold && rate > record.previous_release_rate;
      body["status"] = gate ? "passed" : "failed";
      body["pass_rate"] = rate;
    }
    redis.set("report:" + tenant + ":" + id + ":" + std::to_string(latest_scored), body.dump());
    res.status = 200;
    res.set_content(body.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  debrief: `The interview question is what makes a report trustworthy: the gate, the scope and the freshness. The gate needs a floor, because a pass rate over twelve samples is noise with a decimal point, and it needs to beat the incumbent rather than tie it, because a rollout that changes nothing is a cost with a risk. The scope needs the tenant, or one team reads another team’s release record. The freshness needs the scored count in the cache key: it looks like a cache detail and it is the difference between shipping on the last batch and shipping on the batch before it. And the threshold must come from config the pipeline trusts, not from the query string of whoever is clicking ship. Real harnesses add per-slice gates (a run can pass overall and fail on one language), a confidence bound instead of a bare rate, and a signed report the pipeline can verify after the fact.`,
};
