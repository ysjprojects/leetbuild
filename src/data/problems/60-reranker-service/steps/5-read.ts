import type {Step} from '@/lib/types';

export const readStatsStep: Step = {
  id: 'read',
  title: 'GET /v1/rerank/cache/stats: the numbers that explain a regression',
  concept: 'http',
  file: 'read',
  focus: ['api', 'redis', 'db', 'consumer'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it registers the stats route,
reads a few counters and returns a hit ratio. It looks like observability and it is actually a way to
miss an incident. Review it like the service owner, fix it, and prove the fix with the checks below.

Implement \`GET /v1/rerank/cache/stats\`:

- Report **per model version**. A single global hit ratio hides the version that regressed, because
  the mix of versions changes the aggregate even when each version is steady.
- Make the **unscored batch share** a first-class number. If failed batches are invisible, a model
  that is degrading into unscored passes reads as healthy.
- Report **latency at both boundaries**: the **queue** wait (time waiting for a worker) and the
  **model** call, as percentiles. Client-observed time includes the queue, so it cannot tell a slow
  queue from a slow model.
- Report the **share of requests where fallback order was used**, so degradation caused by the
  retrieval-order fallback is visible alongside the unscored share.
- Keep the hit ratio, but compute it from per-version counters.

**Failure mode the checks target.** The draft returns one global \`hit_ratio\`, omits the unscored
share entirely, and computes latency from client-observed samples that include the queue wait — so
silent degradation looks like success and a real model slowdown is indistinguishable from a busy
worker pool.`,
  sequence: {
    participants: ['Client', 'Rerank API', 'Redis'],
    messages: [
      {from: 'Client', to: 'Rerank API', label: 'GET /v1/rerank/cache/stats', kind: 'sync'},
      {from: 'Rerank API', to: 'Redis', label: 'SMEMBERS rerank:versions', kind: 'sync'},
      {from: 'Redis', to: 'Rerank API', label: 'version list', kind: 'reply'},
      {from: 'Rerank API', to: 'Redis', label: 'HGET stats:{version} · queue/model samples', kind: 'sync'},
      {from: 'Redis', to: 'Rerank API', label: 'counters · latency samples', kind: 'reply'},
      {from: 'Rerank API', to: 'Client', label: '200 {versions: [hit ratio, unscored share, latency]}', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Handles GET /v1/rerank/cache/stats',
      detail: 'Register the stats route on `GET /v1/rerank/cache/stats`.',
      match: {
        python: {all: [/@app\.get\(\s*["']\/v1\/rerank\/cache\/stats["']/]},
        typescript: {all: [/app\.get\(\s*['"]\/v1\/rerank\/cache\/stats['"]/]},
        go: {all: [/HandleFunc\(\s*"GET \/v1\/rerank\/cache\/stats"/]},
        scala: {
          all: [/path\(\s*"v1"\s*\/\s*"rerank"\s*\/\s*"cache"\s*\/\s*"stats"\s*\)/, /\bget\s*\{/],
        },
        cpp: {all: [/svr\.Get\(\s*"\/v1\/rerank\/cache\/stats"/]},
      },
    },
    {
      id: 'unscored-share',
      title: 'Reports the unscored batch share',
      detail:
        'Failed batches are counted and surfaced as `unscored_share`, so silent degradation cannot read as success. The draft omits it.',
      match: {
        python: {all: [/unscored_share/, /unscored_batches/]},
        typescript: {all: [/unscored_share/, /unscoredBatches/]},
        go: {all: [/unscored_share/, /unscored_batches/]},
        scala: {all: [/unscored_share/, /unscoredBatches/]},
        cpp: {all: [/unscored_share/, /unscored_batches/]},
      },
    },
    {
      id: 'per-version',
      title: 'Breaks the stats down per model version',
      detail:
        'Each entry carries its `model_version` and is built per version, so a mixed fleet cannot hide the version that regressed. The draft reports one global ratio.',
      match: {
        python: {all: [/model_version/, /stats_for_version/]},
        typescript: {all: [/modelVersion/, /statsForVersion/]},
        go: {all: [/ModelVersion/, /statsForVersion/]},
        scala: {all: [/modelVersion/, /statsForVersion/]},
        cpp: {all: [/model_version/, /statsForVersion/]},
      },
    },
    {
      id: 'queue-latency',
      title: 'Reports queue latency separately',
      detail:
        'The queue wait is measured and reported on its own, so a slow queue is not charged to the model. The draft uses client-observed times that include the queue.',
      match: {
        python: {all: [/["']queue["']\s*:\s*latency_percentiles/]},
        typescript: {all: [/queue:\s*latencyPercentiles/]},
        go: {all: [/Queue\s+Percentiles/]},
        scala: {all: [/queueLatency\s*=/]},
        cpp: {all: [/queue_latency/]},
      },
    },
    {
      id: 'model-latency',
      title: 'Reports model latency separately',
      detail:
        'The model call is measured at its own boundary and reported as percentiles, so a regression in the model is visible apart from the queue.',
      match: {
        python: {all: [/["']model["']\s*:\s*latency_percentiles/]},
        typescript: {all: [/model:\s*latencyPercentiles/]},
        go: {all: [/Model\s+Percentiles/]},
        scala: {all: [/modelLatency\s*=/]},
        cpp: {all: [/model_latency/]},
      },
    },
  ],
  code: {
    python: {
      starter: `from fastapi import FastAPI
from fastapi.responses import JSONResponse

app = FastAPI()


@app.get("/v1/rerank/cache/stats")
def stats() -> JSONResponse:
    # TODO: this draft reports one global hit ratio, omits the unscored batch share so silent
    # degradation looks like success, and computes latency from client-observed times that include
    # the queue wait. Break it down per model version and keep the two latency boundaries apart.
    hits = int(redis.get("rerank:hits") or 0)
    misses = int(redis.get("rerank:misses") or 0)
    client_times = sorted(float(value) for value in redis.lrange("rerank:client_times", 0, -1))
    total = hits + misses
    return JSONResponse(
        {
            "hit_ratio": hits / total if total else 0.0,
            "latency_p50": client_times[len(client_times) // 2] if client_times else 0.0,
        },
        status_code=200,
    )
`,
      solution: `from fastapi import FastAPI, Header
from fastapi.responses import JSONResponse

app = FastAPI()


def latency_percentiles(redis, key: str) -> dict:
    samples = sorted(float(value) for value in redis.lrange(key, 0, -1))

    def pick(quantile: float) -> float:
        if not samples:
            return 0.0
        return samples[min(len(samples) - 1, int(quantile * len(samples)))]

    return {"p50": pick(0.5), "p95": pick(0.95), "p99": pick(0.99)}


def stats_for_version(redis, model_version: str) -> dict:
    prefix = "rerank:stats:" + model_version
    hits = int(redis.hget(prefix, "hits") or 0)
    misses = int(redis.hget(prefix, "misses") or 0)
    unscored_batches = int(redis.hget(prefix, "unscored_batches") or 0)
    batches = int(redis.hget(prefix, "batches") or 0)
    fallbacks = int(redis.hget(prefix, "fallbacks") or 0)
    requests = int(redis.hget(prefix, "requests") or 0)
    total = hits + misses
    return {
        "model_version": model_version,
        "hit_ratio": hits / total if total else 0.0,
        "unscored_share": unscored_batches / batches if batches else 0.0,
        "fallback_share": fallbacks / requests if requests else 0.0,
        "latency": {
            "queue": latency_percentiles(redis, prefix + ":queue"),
            "model": latency_percentiles(redis, prefix + ":model"),
        },
    }


@app.get("/v1/rerank/cache/stats")
def stats(tenant: str | None = Header(default=None, alias="X-Tenant-Id")) -> JSONResponse:
    if tenant is None:
        return JSONResponse({"error": "missing X-Tenant-Id"}, status_code=401)
    versions = sorted(redis.smembers("rerank:versions"))
    return JSONResponse({"versions": [stats_for_version(redis, version) for version in versions]}, status_code=200)
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';

const app = Fastify();

app.get('/v1/rerank/cache/stats', async (_request, reply) => {
  // TODO: this draft reports one global hit ratio, omits the unscored batch share so silent
  // degradation looks like success, and computes latency from client-observed times that include
  // the queue wait. Break it down per model version and keep the two latency boundaries apart.
  const hits = Number((await rdb.get('rerank:hits')) ?? 0);
  const misses = Number((await rdb.get('rerank:misses')) ?? 0);
  const clientTimes = (await rdb.lrange('rerank:client_times', 0, -1)).map(Number).sort((a, b) => a - b);
  const total = hits + misses;
  return reply.code(200).send({
    hit_ratio: total === 0 ? 0 : hits / total,
    latency_p50: clientTimes.length === 0 ? 0 : clientTimes[Math.floor(clientTimes.length / 2)],
  });
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `import Fastify from 'fastify';

const app = Fastify();

function latencyPercentiles(samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b);
  const pick = (quantile: number) =>
    sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor(quantile * sorted.length))];
  return {p50: pick(0.5), p95: pick(0.95), p99: pick(0.99)};
}

async function statsForVersion(modelVersion: string) {
  const prefix = 'rerank:stats:' + modelVersion;
  const hits = Number((await rdb.hget(prefix, 'hits')) ?? 0);
  const misses = Number((await rdb.hget(prefix, 'misses')) ?? 0);
  const unscoredBatches = Number((await rdb.hget(prefix, 'unscored_batches')) ?? 0);
  const batches = Number((await rdb.hget(prefix, 'batches')) ?? 0);
  const fallbacks = Number((await rdb.hget(prefix, 'fallbacks')) ?? 0);
  const requests = Number((await rdb.hget(prefix, 'requests')) ?? 0);
  const total = hits + misses;
  const queueSamples = (await rdb.lrange(prefix + ':queue', 0, -1)).map(Number);
  const modelSamples = (await rdb.lrange(prefix + ':model', 0, -1)).map(Number);
  return {
    model_version: modelVersion,
    hit_ratio: total === 0 ? 0 : hits / total,
    unscored_share: batches === 0 ? 0 : unscoredBatches / batches,
    fallback_share: requests === 0 ? 0 : fallbacks / requests,
    latency: {
      queue: latencyPercentiles(queueSamples),
      model: latencyPercentiles(modelSamples),
    },
  };
}

app.get('/v1/rerank/cache/stats', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') {
    return reply.code(401).send({error: 'missing X-Tenant-Id'});
  }
  const versions = (await rdb.smembers('rerank:versions')).sort();
  const stats = await Promise.all(versions.map(version => statsForVersion(version)));
  return reply.code(200).send({versions: stats});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"net/http"
)

func stats(w http.ResponseWriter, r *http.Request) {
	// TODO: this draft reports one global hit ratio, omits the unscored batch share so silent
	// degradation looks like success, and computes latency from client-observed times that include
	// the queue wait. Break it down per model version and keep the two latency boundaries apart.
	hits := readCounter("rerank:hits")
	misses := readCounter("rerank:misses")
	clientTimes := readSamples("rerank:client_times")
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"hit_ratio":   ratio(hits, hits+misses),
		"latency_p50": median(clientTimes),
	})
}

func main() {
	http.HandleFunc("GET /v1/rerank/cache/stats", stats)
	_ = http.ListenAndServe(":8443", nil)
}
`,
      solution: `package main

import (
	"encoding/json"
	"net/http"
	"sort"
)

type Percentiles struct {
	P50 float64 \`json:"p50"\`
	P95 float64 \`json:"p95"\`
	P99 float64 \`json:"p99"\`
}

type Latency struct {
	Queue Percentiles \`json:"queue"\`
	Model Percentiles \`json:"model"\`
}

type VersionStats struct {
	ModelVersion  string  \`json:"model_version"\`
	HitRatio      float64 \`json:"hit_ratio"\`
	UnscoredShare float64 \`json:"unscored_share"\`
	FallbackShare float64 \`json:"fallback_share"\`
	Latency       Latency \`json:"latency"\`
}

func percentiles(samples []float64) Percentiles {
	sort.Float64s(samples)
	pick := func(quantile float64) float64 {
		if len(samples) == 0 {
			return 0
		}
		return samples[min(len(samples)-1, int(quantile*float64(len(samples))))]
	}
	return Percentiles{P50: pick(0.5), P95: pick(0.95), P99: pick(0.99)}
}

func statsForVersion(modelVersion string) VersionStats {
	prefix := "rerank:stats:" + modelVersion
	hits := readCounter(prefix + ":hits")
	misses := readCounter(prefix + ":misses")
	unscoredBatches := readCounter(prefix + ":unscored_batches")
	batches := readCounter(prefix + ":batches")
	fallbacks := readCounter(prefix + ":fallbacks")
	requests := readCounter(prefix + ":requests")
	return VersionStats{
		ModelVersion:  modelVersion,
		HitRatio:      ratio(hits, hits+misses),
		UnscoredShare: ratio(unscoredBatches, batches),
		FallbackShare: ratio(fallbacks, requests),
		Latency: Latency{
			Queue: percentiles(readSamples(prefix + ":queue")),
			Model: percentiles(readSamples(prefix + ":model")),
		},
	}
}

func stats(w http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		w.WriteHeader(http.StatusUnauthorized)
		_ = json.NewEncoder(w).Encode(map[string]any{"error": "missing X-Tenant-Id"})
		return
	}
	versions := readVersions()
	stats := make([]VersionStats, 0, len(versions))
	for _, version := range versions {
		stats = append(stats, statsForVersion(version))
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"versions": stats})
}

func main() {
	http.HandleFunc("GET /v1/rerank/cache/stats", stats)
	_ = http.ListenAndServe(":8443", nil)
}
`,
    },
    scala: {
      starter: `import redis.clients.jedis.Jedis

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import spray.json._

object StatsApi extends DefaultJsonProtocol {
  val jedis = new Jedis("redis", 6379)

  def stats: JsObject = {
    // TODO: this draft reports one global hit ratio, omits the unscored batch share so silent
    // degradation looks like success, and computes latency from client-observed times that include
    // the queue wait. Break it down per model version and keep the two latency boundaries apart.
    val hits = counter("rerank:hits")
    val misses = counter("rerank:misses")
    val clientTimes = samples("rerank:client_times").sorted
    JsObject(
      "hit_ratio" -> JsNumber(if (hits + misses == 0) 0.0 else hits.toDouble / (hits + misses)),
      "latency_p50" -> JsNumber(if (clientTimes.isEmpty) 0.0 else clientTimes(clientTimes.size / 2))
    )
  }

  def main(args: Array[String]): Unit = {
    implicit val system: ActorSystem = ActorSystem("stats")
    val route =
      path("v1" / "rerank" / "cache" / "stats") {
        get {
          complete(StatusCodes.OK, stats.compactPrint)
        }
      }
    Http().newServerAt("0.0.0.0", 8443).bind(route)
  }
}
`,
      solution: `import redis.clients.jedis.Jedis

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import spray.json._

object StatsApi extends DefaultJsonProtocol {
  val jedis = new Jedis("redis", 6379)

  case class Percentiles(p50: Double, p95: Double, p99: Double)

  def percentiles(samples: Seq[Double]): Percentiles = {
    val sorted = samples.sorted
    def pick(quantile: Double): Double =
      if (sorted.isEmpty) 0.0 else sorted(math.min(sorted.size - 1, (quantile * sorted.size).toInt))
    Percentiles(pick(0.5), pick(0.95), pick(0.99))
  }

  def statsForVersion(modelVersion: String): JsObject = {
    val prefix = "rerank:stats:" + modelVersion
    val hits = counter(prefix + ":hits")
    val misses = counter(prefix + ":misses")
    val unscoredBatches = counter(prefix + ":unscored_batches")
    val batches = counter(prefix + ":batches")
    val fallbacks = counter(prefix + ":fallbacks")
    val requests = counter(prefix + ":requests")
    val queueLatency = percentiles(samples(prefix + ":queue"))
    val modelLatency = percentiles(samples(prefix + ":model"))
    JsObject(
      "model_version" -> JsString(modelVersion),
      "hit_ratio" -> JsNumber(if (hits + misses == 0) 0.0 else hits.toDouble / (hits + misses)),
      "unscored_share" -> JsNumber(if (batches == 0) 0.0 else unscoredBatches.toDouble / batches),
      "fallback_share" -> JsNumber(if (requests == 0) 0.0 else fallbacks.toDouble / requests),
      "latency" -> JsObject(
        "queue" -> JsObject("p50" -> JsNumber(queueLatency.p50), "p95" -> JsNumber(queueLatency.p95)),
        "model" -> JsObject("p50" -> JsNumber(modelLatency.p50), "p95" -> JsNumber(modelLatency.p95))
      )
    )
  }

  def stats: JsObject = {
    val versions = readVersions()
    JsObject("versions" -> JsArray(versions.map(statsForVersion).toVector))
  }

  def main(args: Array[String]): Unit = {
    implicit val system: ActorSystem = ActorSystem("stats")
    val route =
      path("v1" / "rerank" / "cache" / "stats") {
        get {
          complete(StatusCodes.OK, stats.compactPrint)
        }
      }
    Http().newServerAt("0.0.0.0", 8443).bind(route)
  }
}
`,
    },
    cpp: {
      starter: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <algorithm>
#include <string>
#include <vector>

using json = nlohmann::json;

int main() {
  httplib::Server svr;

  svr.Get("/v1/rerank/cache/stats", [](const httplib::Request& req, httplib::Response& res) {
    // TODO: this draft reports one global hit ratio, omits the unscored batch share so silent
    // degradation looks like success, and computes latency from client-observed times that include
    // the queue wait. Break it down per model version and keep the two latency boundaries apart.
    const auto hits = readCounter("rerank:hits");
    const auto misses = readCounter("rerank:misses");
    auto clientTimes = readSamples("rerank:client_times");
    std::sort(clientTimes.begin(), clientTimes.end());
    const double total = static_cast<double>(hits + misses);
    res.status = 200;
    res.set_content(json{{"hit_ratio", total == 0.0 ? 0.0 : hits / total},
                         {"latency_p50", clientTimes.empty() ? 0.0 : clientTimes[clientTimes.size() / 2]}}
                        .dump(),
                    "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <algorithm>
#include <string>
#include <vector>

using json = nlohmann::json;

static json percentiles(std::vector<double> samples) {
  std::sort(samples.begin(), samples.end());
  const auto pick = [&samples](double quantile) {
    if (samples.empty()) return 0.0;
    return samples[std::min(samples.size() - 1, static_cast<std::size_t>(quantile * samples.size()))];
  };
  return json{{"p50", pick(0.5)}, {"p95", pick(0.95)}, {"p99", pick(0.99)}};
}

static json statsForVersion(const std::string& modelVersion) {
  const std::string prefix = "rerank:stats:" + modelVersion;
  const auto hits = readCounter(prefix + ":hits");
  const auto misses = readCounter(prefix + ":misses");
  const auto unscoredBatches = readCounter(prefix + ":unscored_batches");
  const auto batches = readCounter(prefix + ":batches");
  const auto fallbacks = readCounter(prefix + ":fallbacks");
  const auto requests = readCounter(prefix + ":requests");
  const json queue_latency = percentiles(readSamples(prefix + ":queue"));
  const json model_latency = percentiles(readSamples(prefix + ":model"));
  const double total = static_cast<double>(hits + misses);
  return json{
      {"model_version", modelVersion},
      {"hit_ratio", total == 0.0 ? 0.0 : hits / total},
      {"unscored_share", batches == 0 ? 0.0 : static_cast<double>(unscoredBatches) / batches},
      {"fallback_share", requests == 0 ? 0.0 : static_cast<double>(fallbacks) / requests},
      {"latency", {{"queue", queue_latency}, {"model", model_latency}}},
  };
}

int main() {
  httplib::Server svr;

  svr.Get("/v1/rerank/cache/stats", [](const httplib::Request& req, httplib::Response& res) {
    const auto tenant = req.get_header_value("X-Tenant-Id");
    if (tenant.empty()) {
      res.status = 401;
      res.set_content("{\\"error\\":\\"missing X-Tenant-Id\\"}", "application/json");
      return;
    }
    json versions = json::array();
    for (const auto& version : readVersions()) versions.push_back(statsForVersion(version));
    res.status = 200;
    res.set_content(json{{"versions", versions}}.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  hints: [
    'Aggregate stats lie when the mix changes. Key the counters by model version and return one entry per version, so the version that regressed is the version with the bad numbers.',
    'Latency has two boundaries: time waiting for a worker and time inside the model call. Measure both as percentiles; a single client-observed number cannot tell a deep queue from a slow model.',
    'The unscored share is the number that would have caught this incident. Count failed batches alongside batches and return the ratio, next to the fallback share.',
  ],
  debrief: `The interviewer is testing whether you can design the numbers that explain a regression rather than the
numbers that look good. The draft reads fine because in the demo nothing fails and the model is fast.
Three defects are being checked: one global hit ratio (a version-specific regression hides in the
mix), a missing unscored share (silent degradation reads as success), and client-observed latency
(the queue wait is charged to the model). Splitting queue and model latency is the same discipline as
splitting unscored from scored: each boundary gets its own number so a change in one cannot be
mistaken for a change in the other. Real systems add per-tenant breakdowns, an alert on the unscored
share, and a dashboard that pins the metric definitions in version control so a change in the numbers
is a change in the system, not in the query.`,
};
