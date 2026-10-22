import type {Step} from '@/lib/types';

export const readStep: Step = {
  id: 'read',
  title: 'GET /v1/features/{name}/versions/{v}/stats: drift that is visible',
  concept: 'http',
  file: 'read',
  focus: ['client', 'api', 'monitor', 'redis'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it reads two versions of stats
and returns a mean and a drift boolean. It answers 200 for every request, including the one it should
have shouted about. Find the flaws, fix them, and prove the fix with the checks below.

Implement \`GET /v1/features/{name}/versions/{v}/stats\`:

- Report the **distribution** of the version: \`mean\`, \`std\`, \`p50\`, \`p95\`.
- Report the **null rate** and the baseline's null rate. The draft reports means only, and a mean that
  looks stable hides the rows that stopped arriving — the single most common way a feature silently
  degrades.
- The baseline is **pinned to a declared version** (\`baseline_version\`), not to whatever version
  happened to be last. The draft compares against \`v - 1\`, so the baseline walks forward with every
  deployment and real drift is measured against a moving target.
- Flag **\`drift\`** when the version's null rate moved more than **three standard deviations** from the
  baseline's null rate (\`null_rate_mean + 3 × null_rate_std\`).
- Report **freshness** and a **\`stale\`** flag: \`freshness_s\` is how long ago the newest value was
  computed, and it is stale when it exceeds the definition's \`freshness_slo\`. A stale feature must be
  visible in the response, not silently averaged in.

**Failure mode the checks target.** A stats endpoint that reports only a mean is a dashboard that
cannot fail; drift has to be measured against a fixed, declared baseline and staleness has to be a
value in the response rather than something the reader is expected to infer.

## What to keep

The readings, the response shape and the store are fine. The fix is what the response contains, which
version the baseline is, and the threshold the comparison uses.`,
  sequence: {
    participants: ['Dashboard', 'Feature API', 'Stats store'],
    messages: [
      {
        from: 'Dashboard',
        to: 'Feature API',
        label: 'GET /v1/features/amount_7d/versions/3/stats',
        kind: 'sync',
      },
      {from: 'Feature API', to: 'Stats store', label: 'GET stats:amount_7d:3', kind: 'sync'},
      {from: 'Feature API', to: 'Stats store', label: 'GET stats:amount_7d:1 (pinned baseline)', kind: 'sync'},
      {from: 'Stats store', to: 'Feature API', label: 'distribution · null rate · freshness', kind: 'reply'},
      {
        from: 'Feature API',
        to: 'Feature API',
        label: 'null rate > baseline mean + 3σ → drift · freshness_s > slo → stale',
        kind: 'sync',
      },
      {
        from: 'Feature API',
        to: 'Dashboard',
        label: '200 {distribution, null_rate, drift, freshness_s, stale}',
        kind: 'reply',
      },
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Handles GET /v1/features/{name}/versions/{v}/stats',
      detail: 'Register the stats route on `GET /v1/features/{name}/versions/{v}/stats`.',
      match: {
        python: {all: [/@app\.get\(\s*["']\/v1\/features\/\{name\}\/versions\/\{v\}\/stats["']\)/]},
        typescript: {all: [/app\.get\(\s*['"]\/v1\/features\/:name\/versions\/:v\/stats['"]/]},
        go: {all: [/HandleFunc\(\s*"GET \/v1\/features\/\{name\}\/versions\/\{v\}\/stats"/]},
        scala: {
          all: [
            /path\(\s*"v1"\s*\/\s*"features"\s*\/\s*Segment\s*\/\s*"versions"\s*\/\s*Segment\s*\/\s*"stats"\s*\)/,
            /\bget\s*\{/,
          ],
        },
        cpp: {all: [/svr\.Get\(\s*"\/v1\/features\/:name\/versions\/:v\/stats"/]},
      },
    },
    {
      id: 'null-rate',
      title: 'Surfaces the null rate',
      detail:
        'The response carries `null_rate`, the fraction of rows that arrived empty, alongside the distribution. The draft hides it and reports a mean that cannot show rows that stopped arriving.',
      match: {
        python: {all: [/null_rate/]},
        typescript: {all: [/null_rate/]},
        go: {all: [/NullRate/]},
        scala: {all: [/null_rate/]},
        cpp: {all: [/null_rate/]},
      },
    },
    {
      id: 'pinned-baseline',
      title: 'Pins the baseline to a declared version',
      detail:
        'The comparison uses a declared `baseline_version` (1), not the previous version, so the baseline cannot walk forward with each deployment. The draft compares against `v - 1`.',
      match: {
        python: {all: [/BASELINE_VERSION/, /baseline/]},
        typescript: {all: [/BASELINE_VERSION/, /baseline/]},
        go: {all: [/baselineVersion/, /baseline/]},
        scala: {all: [/BaselineVersion/, /baseline/]},
        cpp: {all: [/kBaselineVersion/, /baseline/]},
      },
    },
    {
      id: 'three-sigma-drift',
      title: 'Flags a null rate more than three σ from the baseline',
      detail:
        '`drift` is true when the version’s null rate exceeds `null_rate_mean + 3 × null_rate_std` of the pinned baseline. The draft flags any worsening mean, which is both the wrong statistic and the wrong baseline.',
      match: {
        python: {all: [/DRIFT_SIGMA/, /drift/]},
        typescript: {all: [/DRIFT_SIGMA/, /drift/]},
        go: {all: [/driftSigma/, /drift/]},
        scala: {all: [/DriftSigma/, /drift/]},
        cpp: {all: [/kDriftSigma/, /drift/]},
      },
    },
    {
      id: 'freshness-stale',
      title: 'Reports freshness and a stale flag',
      detail:
        'The response carries `freshness_s` and `stale`, so a feature whose newest value is older than its SLO is visibly stale instead of silently averaged. The draft reports neither.',
      match: {
        python: {all: [/freshness_s/, /stale/]},
        typescript: {all: [/freshness_s/, /stale/]},
        go: {all: [/FreshnessS/, /stale/]},
        scala: {all: [/freshness_s/, /stale/]},
        cpp: {all: [/freshness_s/, /stale/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json

import redis
from fastapi import FastAPI

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)


@app.get("/v1/features/{name}/versions/{v}/stats")
def stats(name: str, v: int) -> dict:
    # TODO: surface the null rate, pin the baseline to a declared version instead of the previous
    # one, flag a null rate that moved more than three standard deviations from that baseline, and
    # report freshness so a stale feature is visible in the response.
    current = json.loads(r.get(f"stats:{name}:{v}") or "{}")
    previous = json.loads(r.get(f"stats:{name}:{v - 1}") or "{}")
    return {
        "version": v,
        "mean": current.get("mean", 0.0),
        "baseline_mean": previous.get("mean", 0.0),
        "drift": current.get("mean", 0.0) > previous.get("mean", 0.0),
    }
`,
      solution: `import json
import time

import redis
from fastapi import FastAPI
from fastapi.responses import JSONResponse

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)

BASELINE_VERSION = 1
DRIFT_SIGMA = 3.0


def load_stats(name: str, version: int) -> dict | None:
    record = r.get(f"stats:{name}:{version}")
    return None if record is None else json.loads(record)


@app.get("/v1/features/{name}/versions/{v}/stats")
def stats(name: str, v: int) -> JSONResponse:
    current = load_stats(name, v)
    baseline = load_stats(name, BASELINE_VERSION)
    if current is None or baseline is None:
        return JSONResponse({"error": "no stats"}, status_code=404)
    threshold = baseline["null_rate_mean"] + DRIFT_SIGMA * baseline["null_rate_std"]
    null_rate = current["null_rate"]
    drift = null_rate > threshold
    freshness_s = int(time.time()) - current["event_ts"]
    stale = freshness_s > current["freshness_slo"]
    return JSONResponse(
        {
            "version": v,
            "baseline_version": BASELINE_VERSION,
            "distribution": {
                "mean": current["mean"],
                "std": current["std"],
                "p50": current["p50"],
                "p95": current["p95"],
            },
            "null_rate": null_rate,
            "null_rate_baseline": baseline["null_rate_mean"],
            "drift": drift,
            "freshness_s": freshness_s,
            "stale": stale,
        },
        status_code=200,
    )
`,
    },
    typescript: {
      starter: `/** GET /v1/features/:name/versions/:v/stats: a model-generated draft that reports means. */
import Fastify from 'fastify';
import {Redis} from 'ioredis';

export const app = Fastify();
const r = new Redis('redis://redis:6379');

app.get('/v1/features/:name/versions/:v/stats', async (request, reply) => {
  const {name, v} = request.params as {name: string; v: string};
  // TODO: surface the null rate, pin the baseline to a declared version instead of the previous
  // one, flag a null rate that moved more than three standard deviations from that baseline, and
  // report freshness so a stale feature is visible in the response.
  const current = JSON.parse((await r.get(\`stats:\${name}:\${v}\`)) ?? '{}');
  const previous = JSON.parse((await r.get(\`stats:\${name}:\${Number(v) - 1}\`)) ?? '{}');
  return reply.code(200).send({
    version: Number(v),
    mean: current.mean ?? 0,
    baseline_mean: previous.mean ?? 0,
    drift: (current.mean ?? 0) > (previous.mean ?? 0),
  });
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** GET /v1/features/:name/versions/:v/stats: distribution, null rate and freshness per version. */
import Fastify from 'fastify';
import {Redis} from 'ioredis';

export const app = Fastify();
const r = new Redis('redis://redis:6379');

const BASELINE_VERSION = 1;
const DRIFT_SIGMA = 3;

interface VersionStats {
  mean: number;
  std: number;
  p50: number;
  p95: number;
  null_rate: number;
  null_rate_mean: number;
  null_rate_std: number;
  event_ts: number;
  freshness_slo: number;
}

async function loadStats(name: string, version: number): Promise<VersionStats | null> {
  const record = await r.get(\`stats:\${name}:\${version}\`);
  return record === null ? null : (JSON.parse(record) as VersionStats);
}

app.get('/v1/features/:name/versions/:v/stats', async (request, reply) => {
  const {name, v} = request.params as {name: string; v: string};
  const current = await loadStats(name, Number(v));
  const baseline = await loadStats(name, BASELINE_VERSION);
  if (current === null || baseline === null) return reply.code(404).send({error: 'no stats'});
  const threshold = baseline.null_rate_mean + DRIFT_SIGMA * baseline.null_rate_std;
  const drift = current.null_rate > threshold;
  const freshness_s = Math.floor(Date.now() / 1000) - current.event_ts;
  const stale = freshness_s > current.freshness_slo;
  return reply.code(200).send({
    version: Number(v),
    baseline_version: BASELINE_VERSION,
    distribution: {mean: current.mean, std: current.std, p50: current.p50, p95: current.p95},
    null_rate: current.null_rate,
    null_rate_baseline: baseline.null_rate_mean,
    drift,
    freshness_s,
    stale,
  });
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"

	"github.com/redis/go-redis/v9"
)

var rdb *redis.Client

func featureStats(rw http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	version, _ := strconv.Atoi(r.PathValue("v"))
	// TODO: surface the null rate, pin the baseline to a declared version instead of the previous
	// one, flag a null rate that moved more than three standard deviations from that baseline, and
	// report freshness so a stale feature is visible in the response.
	current := map[string]float64{}
	previous := map[string]float64{}
	_ = json.Unmarshal([]byte(rdb.Get(r.Context(), fmt.Sprintf("stats:%s:%d", name, version)).Val()), &current)
	_ = json.Unmarshal([]byte(rdb.Get(r.Context(), fmt.Sprintf("stats:%s:%d", name, version-1)).Val()), &previous)
	_ = json.NewEncoder(rw).Encode(map[string]any{
		"version":       version,
		"mean":          current["mean"],
		"baseline_mean": previous["mean"],
		"drift":         current["mean"] > previous["mean"],
	})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/features/{name}/versions/{v}/stats", featureStats)
	_ = http.ListenAndServe(":8443", mux)
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"
)

const (
	baselineVersion = 1
	driftSigma      = 3.0
)

var rdb *redis.Client

type versionStats struct {
	Mean       float64 \`json:"mean"\`
	Std        float64 \`json:"std"\`
	P50        float64 \`json:"p50"\`
	P95        float64 \`json:"p95"\`
	NullRate   float64 \`json:"null_rate"\`
	NullMean   float64 \`json:"null_rate_mean"\`
	NullStd    float64 \`json:"null_rate_std"\`
	EventTs    int64   \`json:"event_ts"\`
	FreshnessS int64   \`json:"freshness_slo"\`
}

func loadStats(ctx context.Context, name string, version int) (*versionStats, error) {
	record, err := rdb.Get(ctx, fmt.Sprintf("stats:%s:%d", name, version)).Result()
	if err != nil {
		return nil, err
	}
	var stats versionStats
	if err := json.Unmarshal([]byte(record), &stats); err != nil {
		return nil, err
	}
	return &stats, nil
}

func featureStats(rw http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	name := r.PathValue("name")
	version, _ := strconv.Atoi(r.PathValue("v"))
	current, err := loadStats(ctx, name, version)
	if err != nil {
		http.Error(rw, \`{"error":"no stats"}\`, http.StatusNotFound)
		return
	}
	baseline, err := loadStats(ctx, name, baselineVersion)
	if err != nil {
		http.Error(rw, \`{"error":"no baseline"}\`, http.StatusNotFound)
		return
	}
	threshold := baseline.NullMean + driftSigma*baseline.NullStd
	drift := current.NullRate > threshold
	freshnessS := time.Now().Unix() - current.EventTs
	stale := freshnessS > current.FreshnessS
	_ = json.NewEncoder(rw).Encode(map[string]any{
		"version":            version,
		"baseline_version":   baselineVersion,
		"distribution":       map[string]any{"mean": current.Mean, "std": current.Std, "p50": current.P50, "p95": current.P95},
		"null_rate":          current.NullRate,
		"null_rate_baseline": baseline.NullMean,
		"drift":              drift,
		"freshness_s":        freshnessS,
		"stale":              stale,
	})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/features/{name}/versions/{v}/stats", featureStats)
	_ = http.ListenAndServe(":8443", mux)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.model.StatusCodes
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import redis.clients.jedis.Jedis
import spray.json._

object StatsApi {
  implicit val system: ActorSystem = ActorSystem("feature-store")
  val jedis = new Jedis("redis", 6379)

  val route: Route =
    path("v1" / "features" / Segment / "versions" / Segment / "stats") { (name, version) =>
      get {
        // TODO: surface the null rate, pin the baseline to a declared version instead of the
        // previous one, flag a null rate that moved more than three standard deviations from that
        // baseline, and report freshness so a stale feature is visible in the response.
        val current = jedis.get(s"stats:$name:$version")
        val previous = jedis.get(s"stats:$name:\${version.toInt - 1}")
        complete(StatusCodes.OK, s"""{"version":$version,"mean":$current,"baseline_mean":$previous}""")
      }
    }

  def main(args: Array[String]): Unit = {
    Http().newServerAt("0.0.0.0", 8443).bind(route)
  }
}
`,
      solution: `import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.model.StatusCodes
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import redis.clients.jedis.Jedis
import spray.json._

object StatsApi {
  implicit val system: ActorSystem = ActorSystem("feature-store")
  val BaselineVersion = 1
  val DriftSigma = 3.0
  val jedis = new Jedis("redis", 6379)

  def loadStats(name: String, version: Int): Option[JsObject] = {
    val record = jedis.get(s"stats:$name:$version")
    if (record == null) None else Some(record.parseJson.asJsObject)
  }

  def number(stats: JsObject, field: String): Double =
    stats.fields.get(field).map(_.convertTo[Double]).getOrElse(0.0)

  val route: Route =
    path("v1" / "features" / Segment / "versions" / Segment / "stats") { (name, version) =>
      get {
        (loadStats(name, version.toInt), loadStats(name, BaselineVersion)) match {
          case (Some(current), Some(baseline)) =>
            val threshold = number(baseline, "null_rate_mean") + DriftSigma * number(baseline, "null_rate_std")
            val null_rate = number(current, "null_rate")
            val drift = null_rate > threshold
            val freshness_s = System.currentTimeMillis() / 1000 - number(current, "event_ts").toLong
            val stale = freshness_s > number(current, "freshness_slo").toLong
            val body =
              s"""{"version":$version,"baseline_version":$BaselineVersion,"distribution":{"mean":\${number(current, "mean")},"std":\${number(current, "std")},"p50":\${number(current, "p50")},"p95":\${number(current, "p95")}},"null_rate":$null_rate,"drift":$drift,"freshness_s":$freshness_s,"stale":$stale}"""
            complete(StatusCodes.OK, body)
          case _ =>
            complete(StatusCodes.NotFound, s"""{"error":"no stats"}""")
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

  svr.Get("/v1/features/:name/versions/:v/stats", [&redis](const httplib::Request& req, httplib::Response& res) {
    const auto name = req.path_params.at("name");
    const auto version = std::stoi(req.path_params.at("v"));
    // TODO: surface the null rate, pin the baseline to a declared version instead of the previous
    // one, flag a null rate that moved more than three standard deviations from that baseline, and
    // report freshness so a stale feature is visible in the response.
    const auto current = redis.get("stats:" + name + ":" + std::to_string(version));
    const auto previous = redis.get("stats:" + name + ":" + std::to_string(version - 1));
    res.status = 200;
    res.set_content(json{{"version", version},
                         {"mean", current.value_or("null")},
                         {"baseline_mean", previous.value_or("null")}}
                        .dump(),
                    "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <chrono>
#include <string>

using json = nlohmann::json;

constexpr int kBaselineVersion = 1;
constexpr double kDriftSigma = 3.0;

json load_stats(sw::redis::Redis& redis, const std::string& name, int version) {
  const auto record = redis.get("stats:" + name + ":" + std::to_string(version));
  if (!record) return json();
  return json::parse(*record, nullptr, false);
}

int main() {
  sw::redis::Redis redis("tcp://redis:6379");
  httplib::Server svr;

  svr.Get("/v1/features/:name/versions/:v/stats", [&redis](const httplib::Request& req, httplib::Response& res) {
    const auto name = req.path_params.at("name");
    const auto version = std::stoi(req.path_params.at("v"));
    const auto current = load_stats(redis, name, version);
    const auto baseline = load_stats(redis, name, kBaselineVersion);
    if (current.is_null() || baseline.is_null()) {
      res.status = 404;
      res.set_content(json{{"error", "no stats"}}.dump(), "application/json");
      return;
    }
    const auto threshold =
        baseline.value("null_rate_mean", 0.0) + kDriftSigma * baseline.value("null_rate_std", 0.0);
    const auto null_rate = current.value("null_rate", 0.0);
    const auto drift = null_rate > threshold;
    const auto now = std::chrono::system_clock::to_time_t(std::chrono::system_clock::now());
    const auto freshness_s = now - current.value("event_ts", 0LL);
    const auto stale = freshness_s > current.value("freshness_slo", 0LL);
    res.status = 200;
    res.set_content(
        json{{"version", version},
             {"baseline_version", kBaselineVersion},
             {"distribution",
              json{{"mean", current.value("mean", 0.0)},
                   {"std", current.value("std", 0.0)},
                   {"p50", current.value("p50", 0.0)},
                   {"p95", current.value("p95", 0.0)}}},
             {"null_rate", null_rate},
             {"null_rate_baseline", baseline.value("null_rate_mean", 0.0)},
             {"drift", drift},
             {"freshness_s", freshness_s},
             {"stale", stale}}
            .dump(),
        "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  hints: [
    'A mean is the one statistic that hides a null-rate regression: rows that stopped arriving simply do not contribute. Report the distribution you have (`mean`, `std`, `p50`, `p95`) next to `null_rate`, and compare the null rate, because that is the number that moves when the pipeline breaks.',
    'The baseline is a decision, not a coincidence: pin it to a declared `baseline_version` and compare against that version’s recorded `null_rate_mean` and `null_rate_std`. Comparing with `v - 1` means every deploy moves the baseline, and drift measured against a moving target is not drift.',
    'Staleness is a fact about the data, not about the request: compute `freshness_s` from the newest value’s `event_ts`, compare it with the definition’s `freshness_slo`, and put `stale` in the response. A feature whose freshest value is two days old must not look like any other 200.',
  ],
  debrief: `The interview question behind this step is what an observability endpoint owes its reader. A stats route is a contract: its caller is deciding whether to page someone, retrain a model, or trust tonight’s backfill, so every number that changes that decision has to be in the payload. A mean alone fails that test because it is insensitive to the failure mode that matters most — rows that never arrived — while the null rate moves immediately. The baseline is the second half: drift only means something against a fixed reference, so the reference version is declared, and the threshold is a statistic rather than a vibe — three standard deviations of the baseline’s own null rate. The third half is freshness: a feature can be numerically perfect and still useless because it stopped being updated, so \`stale\` belongs in the response where the dashboard cannot miss it. Real platforms add per-entity freshness, seasonality-aware thresholds, and an alert that distinguishes a paging regression from a ticket.`,
};
