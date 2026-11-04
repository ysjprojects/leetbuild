import type {Step} from '@/lib/types';

export const readStatsStep: Step = {
  id: 'read',
  title: 'GET /v1/rerank/cache/stats: per model version, at the boundaries',
  concept: 'http',
  file: 'read',
  focus: ['client', 'api', 'redis', 'consumer'],
  task: `## Task

**Starting point.** The starter serves \`GET /v1/rerank/cache/stats\` from the fleet totals the
first dashboard read (\`rerank.config\`: \`FLEET_HITS_KEY\`, \`FLEET_MISSES_KEY\`, \`CLIENT_LATENCY_KEY\`)
and answers \`{"hit_ratio", "latency_ms": {"p50", "p95"}}\`, with a provided nearest-rank
\`percentile(samples, p)\`. The stats consumer also keeps, per model version, the counters hash
\`stats_key(v)\` (requests, hits, misses, batches, unscored_batches, fallback_requests), the sample
lists \`latency_key(v, "queue")\` and \`latency_key(v, "model")\`, and the set \`VERSIONS_KEY\`. It
serves the demo and hides 4 flaws.

**Failure mode the checks target.** The endpoint looks like observability and hides the incident: a
build whose batches time out shows the same hit ratio as a healthy one, its regression vanishes into
the fleet average, and a deep queue reads as a slow model.

Answer \`{"versions": [...]}\`, one entry per version in \`VERSIONS_KEY\`, sorted by version, each with:

- \`model_version\` and \`hit_ratio\` (hits / (hits + misses)) from that version's counters.
- \`unscored_share\`: unscored_batches / batches.
- \`fallback_share\`: fallback_requests / requests.
- \`latency_ms\`: \`{"queue": {"p50", "p95"}, "model": {"p50", "p95"}}\` from the two boundary lists.

A share with a zero denominator is 0.`,
  sequence: {
    participants: ['Client', 'Rerank API', 'Redis'],
    messages: [
      {from: 'Client', to: 'Rerank API', label: 'GET /v1/rerank/cache/stats', kind: 'sync'},
      {from: 'Rerank API', to: 'Redis', label: 'SMEMBERS rerank:versions', kind: 'sync'},
      {from: 'Rerank API', to: 'Redis', label: 'HGETALL rerank:stats:{v}', kind: 'sync'},
      {from: 'Rerank API', to: 'Redis', label: 'LRANGE rerank:latency:{v}:queue · :model', kind: 'sync'},
      {from: 'Rerank API', to: 'Client', label: '200 {versions: [hit, unscored, fallback, latency]}', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Serves GET /v1/rerank/cache/stats',
      detail: '`GET /v1/rerank/cache/stats` answers 200 with a JSON object, also before any stats exist.',
      match: {
        python: {all: [/@app\.get\(\s*["']\/v1\/rerank\/cache\/stats["']/]},
        typescript: {all: [/app\.get\(\s*['"]\/v1\/rerank\/cache\/stats['"]/]},
        go: {all: [/HandleFunc\(\s*"GET \/v1\/rerank\/cache\/stats"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"rerank"\s*\/\s*"cache"\s*\/\s*"stats"\s*\)/, /\bget\s*\{/]},
        cpp: {all: [/svr\.Get\(\s*"\/v1\/rerank\/cache\/stats"/]},
      },
    },
    {
      id: 'per-version',
      title: 'Reports each model version on its own',
      detail:
        "With xenc-v7 at 90 hits / 10 misses and xenc-v8 at 20 / 80, the answer lists both versions in order with hit ratios 0.9 and 0.2, read from each version's counters. The starter reports the fleet's 0.55.",
      match: {
        python: {all: [/VERSIONS_KEY/, /stats_key\(/], none: [/FLEET_HITS_KEY/]},
        typescript: {all: [/VERSIONS_KEY/, /statsKey\(/], none: [/FLEET_HITS_KEY/]},
        go: {all: [/config\.VersionsKey/, /config\.StatsKey\(/], none: [/FleetHitsKey/]},
        scala: {all: [/Config\.VersionsKey/, /Config\.statsKey\(/], none: [/FleetHitsKey/]},
        cpp: {all: [/config::kVersionsKey/, /config::stats_key\(/], none: [/kFleetHitsKey/]},
      },
    },
    {
      id: 'unscored-share',
      title: 'Reports the unscored batch share',
      detail:
        '`unscored_share` is unscored_batches / batches per version (0.05 for xenc-v7, 0.5 for xenc-v8), so a build whose batches fail cannot read as healthy. The starter has no such field.',
      match: {
        python: {all: [/unscored_share/, /unscored_batches/]},
        typescript: {all: [/unscored_share/, /unscored_batches/]},
        go: {all: [/unscored_share/, /unscored_batches/]},
        scala: {all: [/unscored_share/, /unscored_batches/]},
        cpp: {all: [/unscored_share/, /unscored_batches/]},
      },
    },
    {
      id: 'fallback-share',
      title: 'Reports the share of requests served in retrieval order',
      detail:
        "`fallback_share` is fallback_requests / requests per version (0 for xenc-v7, 0.4 for xenc-v8): how often users got the retriever's order instead of the model's. The starter has no such field.",
      match: {
        python: {all: [/fallback_share/, /fallback_requests/]},
        typescript: {all: [/fallback_share/, /fallback_requests/]},
        go: {all: [/fallback_share/, /fallback_requests/]},
        scala: {all: [/fallback_share/, /fallback_requests/]},
        cpp: {all: [/fallback_share/, /fallback_requests/]},
      },
    },
    {
      id: 'boundary-latency',
      title: 'Reports queue and model latency apart',
      detail:
        'Each version carries `latency_ms.queue` and `latency_ms.model`, nearest-rank p50 and p95 of its two boundary lists (xenc-v8: queue 900 / 1200 ms, model 45 / 55 ms), so a deep queue is not charged to the model. The starter reports client-observed times.',
      match: {
        python: {all: [/latency_key\(/, /["']queue["']/, /["']model["']/], none: [/CLIENT_LATENCY_KEY/]},
        typescript: {all: [/latencyKey\(/, /queue/, /model/], none: [/CLIENT_LATENCY_KEY/]},
        go: {all: [/config\.LatencyKey\(/, /"queue"/, /"model"/], none: [/ClientLatencyKey/]},
        scala: {all: [/Config\.latencyKey\(/, /"queue"/, /"model"/], none: [/ClientLatencyKey/]},
        cpp: {all: [/config::latency_key\(/, /"queue"/, /"model"/], none: [/kClientLatencyKey/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import redis
from fastapi import FastAPI
from fastapi.responses import JSONResponse

from rerank import config  # the stats layout the stats consumer keeps — provided

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)


def percentile(samples: list[int], p: int) -> int:
    """Nearest rank: the sample at rank ceil(p * n / 100) of the sorted samples; 0 for none."""
    if not samples:
        return 0
    ordered = sorted(samples)
    return ordered[max(1, (p * len(ordered) + 99) // 100) - 1]


@app.get("/v1/rerank/cache/stats")
def stats() -> JSONResponse:
    # TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
    hits = int(r.get(config.FLEET_HITS_KEY) or 0)
    misses = int(r.get(config.FLEET_MISSES_KEY) or 0)
    client = [int(ms) for ms in r.lrange(config.CLIENT_LATENCY_KEY, 0, -1)]
    return JSONResponse({
        "hit_ratio": hits / (hits + misses) if hits + misses else 0.0,
        "latency_ms": {"p50": percentile(client, 50), "p95": percentile(client, 95)},
    })
`,
      solution: `import redis
from fastapi import FastAPI
from fastapi.responses import JSONResponse

from rerank import config  # the stats layout the stats consumer keeps — provided

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)


def percentile(samples: list[int], p: int) -> int:
    """Nearest rank: the sample at rank ceil(p * n / 100) of the sorted samples; 0 for none."""
    if not samples:
        return 0
    ordered = sorted(samples)
    return ordered[max(1, (p * len(ordered) + 99) // 100) - 1]


def share(part: int, whole: int) -> float:
    return part / whole if whole else 0.0


def boundary(model_version: str, name: str) -> dict:
    """p50 and p95 of the samples taken at one boundary: the queue wait or the model call."""
    samples = [int(ms) for ms in r.lrange(config.latency_key(model_version, name), 0, -1)]
    return {"p50": percentile(samples, 50), "p95": percentile(samples, 95)}


def version_stats(model_version: str) -> dict:
    n = {field: int(value) for field, value in r.hgetall(config.stats_key(model_version)).items()}
    hits, misses = n.get("hits", 0), n.get("misses", 0)
    return {
        "model_version": model_version,
        "hit_ratio": share(hits, hits + misses),
        "unscored_share": share(n.get("unscored_batches", 0), n.get("batches", 0)),
        "fallback_share": share(n.get("fallback_requests", 0), n.get("requests", 0)),
        "latency_ms": {"queue": boundary(model_version, "queue"), "model": boundary(model_version, "model")},
    }


@app.get("/v1/rerank/cache/stats")
def stats() -> JSONResponse:
    # One entry per version: a regression in one build must not average away into the fleet.
    return JSONResponse({"versions": [version_stats(v) for v in sorted(r.smembers(config.VERSIONS_KEY))]})
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';
import Redis from 'ioredis';

import {CLIENT_LATENCY_KEY, FLEET_HITS_KEY, FLEET_MISSES_KEY} from 'rerank/config'; // the stats layout — provided

export const app = Fastify();
const redis = new Redis({host: 'redis', port: 6379});

/** Nearest rank: the sample at rank ceil(p * n / 100) of the sorted samples; 0 for none. */
export function percentile(samples: number[], p: number): number {
  if (samples.length === 0) return 0;
  const ordered = [...samples].sort((a, b) => a - b);
  return ordered[Math.max(1, Math.ceil((p * ordered.length) / 100)) - 1];
}

app.get('/v1/rerank/cache/stats', async () => {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  const hits = Number((await redis.get(FLEET_HITS_KEY)) ?? 0);
  const misses = Number((await redis.get(FLEET_MISSES_KEY)) ?? 0);
  const client = (await redis.lrange(CLIENT_LATENCY_KEY, 0, -1)).map(Number);
  return {
    hit_ratio: hits + misses > 0 ? hits / (hits + misses) : 0,
    latency_ms: {p50: percentile(client, 50), p95: percentile(client, 95)},
  };
});
`,
      solution: `import Fastify from 'fastify';
import Redis from 'ioredis';

import {VERSIONS_KEY, latencyKey, statsKey} from 'rerank/config'; // the stats layout — provided

export const app = Fastify();
const redis = new Redis({host: 'redis', port: 6379});

/** Nearest rank: the sample at rank ceil(p * n / 100) of the sorted samples; 0 for none. */
export function percentile(samples: number[], p: number): number {
  if (samples.length === 0) return 0;
  const ordered = [...samples].sort((a, b) => a - b);
  return ordered[Math.max(1, Math.ceil((p * ordered.length) / 100)) - 1];
}

const share = (part: number, whole: number): number => (whole > 0 ? part / whole : 0);

/** p50 and p95 of the samples taken at one boundary: the queue wait or the model call. */
async function boundary(modelVersion: string, name: 'queue' | 'model') {
  const samples = (await redis.lrange(latencyKey(modelVersion, name), 0, -1)).map(Number);
  return {p50: percentile(samples, 50), p95: percentile(samples, 95)};
}

async function versionStats(modelVersion: string) {
  const raw = await redis.hgetall(statsKey(modelVersion));
  const n = (field: string): number => Number(raw[field] ?? 0);
  return {
    model_version: modelVersion,
    hit_ratio: share(n('hits'), n('hits') + n('misses')),
    unscored_share: share(n('unscored_batches'), n('batches')),
    fallback_share: share(n('fallback_requests'), n('requests')),
    latency_ms: {queue: await boundary(modelVersion, 'queue'), model: await boundary(modelVersion, 'model')},
  };
}

app.get('/v1/rerank/cache/stats', async () => {
  // One entry per version: a regression in one build must not average away into the fleet.
  const versions = (await redis.smembers(VERSIONS_KEY)).sort();
  return {versions: await Promise.all(versions.map(versionStats))};
});
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"net/http"
	"sort"
	"strconv"

	"github.com/redis/go-redis/v9"

	"rerank/config" // the stats layout the stats consumer keeps — provided
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// percentile is the nearest rank: the sample at rank ceil(p * n / 100) of the sorted samples; 0 for none.
func percentile(samples []int, p int) int {
	if len(samples) == 0 {
		return 0
	}
	ordered := append([]int{}, samples...)
	sort.Ints(ordered)
	rank := (p*len(ordered) + 99) / 100
	if rank < 1 {
		rank = 1
	}
	return ordered[rank-1]
}

func intsOf(values []string) []int {
	out := make([]int, 0, len(values))
	for _, v := range values {
		n, _ := strconv.Atoi(v)
		out = append(out, n)
	}
	return out
}

func stats(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
	ctx := context.Background()
	hits, _ := rdb.Get(ctx, config.FleetHitsKey).Int()
	misses, _ := rdb.Get(ctx, config.FleetMissesKey).Int()
	raw, _ := rdb.LRange(ctx, config.ClientLatencyKey, 0, -1).Result()
	client := intsOf(raw)
	ratio := 0.0
	if hits+misses > 0 {
		ratio = float64(hits) / float64(hits+misses)
	}
	rw.Header().Set("Content-Type", "application/json")
	json.NewEncoder(rw).Encode(map[string]any{
		"hit_ratio":  ratio,
		"latency_ms": map[string]int{"p50": percentile(client, 50), "p95": percentile(client, 95)},
	})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/rerank/cache/stats", stats)
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"net/http"
	"sort"
	"strconv"

	"github.com/redis/go-redis/v9"

	"rerank/config" // the stats layout the stats consumer keeps — provided
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// percentile is the nearest rank: the sample at rank ceil(p * n / 100) of the sorted samples; 0 for none.
func percentile(samples []int, p int) int {
	if len(samples) == 0 {
		return 0
	}
	ordered := append([]int{}, samples...)
	sort.Ints(ordered)
	rank := (p*len(ordered) + 99) / 100
	if rank < 1 {
		rank = 1
	}
	return ordered[rank-1]
}

func intsOf(values []string) []int {
	out := make([]int, 0, len(values))
	for _, v := range values {
		n, _ := strconv.Atoi(v)
		out = append(out, n)
	}
	return out
}

func share(part, whole int) float64 {
	if whole == 0 {
		return 0
	}
	return float64(part) / float64(whole)
}

type percentiles struct {
	P50 int \`json:"p50"\`
	P95 int \`json:"p95"\`
}

type versionStats struct {
	ModelVersion  string                 \`json:"model_version"\`
	HitRatio      float64                \`json:"hit_ratio"\`
	UnscoredShare float64                \`json:"unscored_share"\`
	FallbackShare float64                \`json:"fallback_share"\`
	LatencyMs     map[string]percentiles \`json:"latency_ms"\`
}

// boundary is p50 and p95 of the samples taken at one boundary: the queue wait or the model call.
func boundary(ctx context.Context, modelVersion, name string) (percentiles, error) {
	raw, err := rdb.LRange(ctx, config.LatencyKey(modelVersion, name), 0, -1).Result()
	if err != nil {
		return percentiles{}, err
	}
	samples := intsOf(raw)
	return percentiles{P50: percentile(samples, 50), P95: percentile(samples, 95)}, nil
}

func statsFor(ctx context.Context, modelVersion string) (versionStats, error) {
	raw, err := rdb.HGetAll(ctx, config.StatsKey(modelVersion)).Result()
	if err != nil {
		return versionStats{}, err
	}
	n := func(field string) int {
		v, _ := strconv.Atoi(raw[field])
		return v
	}
	queue, err := boundary(ctx, modelVersion, "queue")
	if err != nil {
		return versionStats{}, err
	}
	model, err := boundary(ctx, modelVersion, "model")
	if err != nil {
		return versionStats{}, err
	}
	return versionStats{
		ModelVersion:  modelVersion,
		HitRatio:      share(n("hits"), n("hits")+n("misses")),
		UnscoredShare: share(n("unscored_batches"), n("batches")),
		FallbackShare: share(n("fallback_requests"), n("requests")),
		LatencyMs:     map[string]percentiles{"queue": queue, "model": model},
	}, nil
}

func stats(rw http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	versions, err := rdb.SMembers(ctx, config.VersionsKey).Result()
	if err != nil {
		http.Error(rw, err.Error(), http.StatusInternalServerError)
		return
	}
	sort.Strings(versions)
	// One entry per version: a regression in one build must not average away into the fleet.
	out := make([]versionStats, 0, len(versions))
	for _, v := range versions {
		entry, err := statsFor(ctx, v)
		if err != nil {
			http.Error(rw, err.Error(), http.StatusInternalServerError)
			return
		}
		out = append(out, entry)
	}
	rw.Header().Set("Content-Type", "application/json")
	json.NewEncoder(rw).Encode(map[string]any{"versions": out})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/rerank/cache/stats", stats)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

import rerank.Config // the stats layout the stats consumer keeps — provided

object StatsApi {
  private val jedis = new JedisPooled("redis", 6379)

  /** Nearest rank: the sample at rank ceil(p * n / 100) of the sorted samples; 0 for none. */
  def percentile(samples: Seq[Int], p: Int): Int =
    if (samples.isEmpty) 0 else samples.sorted.apply(math.max(1, (p * samples.size + 99) / 100) - 1)

  val route: Route = path("v1" / "rerank" / "cache" / "stats") {
    get {
      // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
      val hits = Option(jedis.get(Config.FleetHitsKey)).fold(0)(_.toInt)
      val misses = Option(jedis.get(Config.FleetMissesKey)).fold(0)(_.toInt)
      val client = jedis.lrange(Config.ClientLatencyKey, 0, -1).asScala.toSeq.map(_.toInt)
      val body = ujson.Obj(
        "hit_ratio" -> (if (hits + misses > 0) hits.toDouble / (hits + misses) else 0.0),
        "latency_ms" -> ujson.Obj("p50" -> percentile(client, 50), "p95" -> percentile(client, 95))
      )
      complete(HttpResponse(StatusCodes.OK, entity = HttpEntity(ContentTypes.\`application/json\`, ujson.write(body))))
    }
  }
}
`,
      solution: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

import rerank.Config // the stats layout the stats consumer keeps — provided

object StatsApi {
  private val jedis = new JedisPooled("redis", 6379)

  /** Nearest rank: the sample at rank ceil(p * n / 100) of the sorted samples; 0 for none. */
  def percentile(samples: Seq[Int], p: Int): Int =
    if (samples.isEmpty) 0 else samples.sorted.apply(math.max(1, (p * samples.size + 99) / 100) - 1)

  private def share(part: Int, whole: Int): Double = if (whole > 0) part.toDouble / whole else 0.0

  /** p50 and p95 of the samples taken at one boundary: the queue wait or the model call. */
  private def boundary(modelVersion: String, name: String): ujson.Obj = {
    val samples = jedis.lrange(Config.latencyKey(modelVersion, name), 0, -1).asScala.toSeq.map(_.toInt)
    ujson.Obj("p50" -> percentile(samples, 50), "p95" -> percentile(samples, 95))
  }

  private def versionStats(modelVersion: String): ujson.Obj = {
    val raw = jedis.hgetAll(Config.statsKey(modelVersion)).asScala
    def n(field: String): Int = raw.get(field).fold(0)(_.toInt)
    ujson.Obj(
      "model_version" -> modelVersion,
      "hit_ratio" -> share(n("hits"), n("hits") + n("misses")),
      "unscored_share" -> share(n("unscored_batches"), n("batches")),
      "fallback_share" -> share(n("fallback_requests"), n("requests")),
      "latency_ms" -> ujson.Obj("queue" -> boundary(modelVersion, "queue"), "model" -> boundary(modelVersion, "model"))
    )
  }

  val route: Route = path("v1" / "rerank" / "cache" / "stats") {
    get {
      // One entry per version: a regression in one build must not average away into the fleet.
      val versions = jedis.smembers(Config.VersionsKey).asScala.toSeq.sorted
      val body = ujson.Obj("versions" -> ujson.Arr.from(versions.map(versionStats)))
      complete(HttpResponse(StatusCodes.OK, entity = HttpEntity(ContentTypes.\`application/json\`, ujson.write(body))))
    }
  }
}
`,
    },
    cpp: {
      starter: `#include <httplib.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <algorithm>
#include <string>
#include <vector>

#include "rerank/config.h"  // the stats layout the stats consumer keeps — provided

using json = nlohmann::json;

sw::redis::Redis& stats_redis() {
  static sw::redis::Redis conn("tcp://redis:6379");
  return conn;
}

// Nearest rank: the sample at rank ceil(p * n / 100) of the sorted samples; 0 for none.
long long percentile(std::vector<long long> samples, int p) {
  if (samples.empty()) return 0;
  std::sort(samples.begin(), samples.end());
  const size_t rank = std::max<size_t>(1, (p * samples.size() + 99) / 100);
  return samples[rank - 1];
}

std::vector<long long> numbers(const std::vector<std::string>& values) {
  std::vector<long long> out;
  for (const auto& v : values) out.push_back(std::stoll(v));
  return out;
}

void stats(const httplib::Request&, httplib::Response& res) {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  const auto hits_raw = stats_redis().get(config::kFleetHitsKey);
  const auto misses_raw = stats_redis().get(config::kFleetMissesKey);
  const long long hits = hits_raw ? std::stoll(*hits_raw) : 0;
  const long long misses = misses_raw ? std::stoll(*misses_raw) : 0;
  const auto client = numbers(stats_redis().lrange(config::kClientLatencyKey, 0, -1));
  const json body = {{"hit_ratio", hits + misses > 0 ? static_cast<double>(hits) / static_cast<double>(hits + misses) : 0.0},
                     {"latency_ms", {{"p50", percentile(client, 50)}, {"p95", percentile(client, 95)}}}};
  res.set_content(body.dump(), "application/json");
}

void register_routes(httplib::Server& svr) { svr.Get("/v1/rerank/cache/stats", stats); }
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <algorithm>
#include <string>
#include <unordered_map>
#include <vector>

#include "rerank/config.h"  // the stats layout the stats consumer keeps — provided

using json = nlohmann::json;

sw::redis::Redis& stats_redis() {
  static sw::redis::Redis conn("tcp://redis:6379");
  return conn;
}

// Nearest rank: the sample at rank ceil(p * n / 100) of the sorted samples; 0 for none.
long long percentile(std::vector<long long> samples, int p) {
  if (samples.empty()) return 0;
  std::sort(samples.begin(), samples.end());
  const size_t rank = std::max<size_t>(1, (p * samples.size() + 99) / 100);
  return samples[rank - 1];
}

std::vector<long long> numbers(const std::vector<std::string>& values) {
  std::vector<long long> out;
  for (const auto& v : values) out.push_back(std::stoll(v));
  return out;
}

double share(long long part, long long whole) { return whole > 0 ? static_cast<double>(part) / static_cast<double>(whole) : 0.0; }

// p50 and p95 of the samples taken at one boundary: the queue wait or the model call.
json boundary(const std::string& model_version, const std::string& name) {
  const auto samples = numbers(stats_redis().lrange(config::latency_key(model_version, name), 0, -1));
  return {{"p50", percentile(samples, 50)}, {"p95", percentile(samples, 95)}};
}

json versionStats(const std::string& model_version) {
  const std::unordered_map<std::string, std::string> raw = stats_redis().hgetall(config::stats_key(model_version));
  const auto n = [&raw](const char* field) { return raw.count(field) ? std::stoll(raw.at(field)) : 0LL; };
  return {{"model_version", model_version},
          {"hit_ratio", share(n("hits"), n("hits") + n("misses"))},
          {"unscored_share", share(n("unscored_batches"), n("batches"))},
          {"fallback_share", share(n("fallback_requests"), n("requests"))},
          {"latency_ms", {{"queue", boundary(model_version, "queue")}, {"model", boundary(model_version, "model")}}}};
}

void stats(const httplib::Request&, httplib::Response& res) {
  std::vector<std::string> versions = stats_redis().smembers(config::kVersionsKey);
  std::sort(versions.begin(), versions.end());
  // One entry per version: a regression in one build must not average away into the fleet.
  json out = json::array();
  for (const auto& v : versions) out.push_back(versionStats(v));
  res.set_content(json{{"versions", out}}.dump(), "application/json");
}

void register_routes(httplib::Server& svr) { svr.Get("/v1/rerank/cache/stats", stats); }
`,
    },
  },
  harness: {
    python: `STATS = "/v1/rerank/cache/stats"


def _seed(ctx):
    """Two builds as the stats consumer recorded them: xenc-v7 healthy, xenc-v8 failing batches behind a deep queue."""
    ctx.redis.sadd("rerank:versions", "xenc-v8", "xenc-v7")
    ctx.redis.hset("rerank:stats:xenc-v7", mapping={"requests": 10, "hits": 90, "misses": 10, "batches": 40, "unscored_batches": 2, "fallback_requests": 0})
    ctx.redis.hset("rerank:stats:xenc-v8", mapping={"requests": 20, "hits": 20, "misses": 80, "batches": 50, "unscored_batches": 25, "fallback_requests": 8})
    ctx.redis.rpush("rerank:latency:xenc-v7:queue", 20, 5, 15, 10)
    ctx.redis.rpush("rerank:latency:xenc-v7:model", 300, 40, 60, 50, 70)
    ctx.redis.rpush("rerank:latency:xenc-v8:queue", 900, 1200, 800)
    ctx.redis.rpush("rerank:latency:xenc-v8:model", 55, 45)
    ctx.redis.set("rerank:hits", 110)
    ctx.redis.set("rerank:misses", 90)
    ctx.redis.rpush("rerank:latency:client", 950, 1300, 120, 400)


async def _versions(ctx):
    _seed(ctx)
    async with ctx.client(ctx.load("read").app) as c:
        r = await c.get(STATS)
    assert r.status_code == 200, f"GET {STATS} answered {r.status_code}: {r.text}"
    versions = r.json().get("versions")
    assert isinstance(versions, list), f"the answer must carry versions, one entry per model version, got {r.text}"
    return {v.get("model_version"): v for v in versions}, [v.get("model_version") for v in versions], r.text


def _near(got, want):
    return isinstance(got, (int, float)) and abs(got - want) < 1e-6


async def check_route(ctx):
    async with ctx.client(ctx.load("read").app) as c:
        r = await c.get(STATS)
    assert r.status_code == 200, f"GET {STATS} answered {r.status_code} before any stats exist: {r.text}"
    assert isinstance(r.json(), dict), f"the answer must be a JSON object, got {r.text}"


async def check_per_version(ctx):
    by_version, order, text = await _versions(ctx)
    assert order == ["xenc-v7", "xenc-v8"], f"expected one entry per version, sorted (xenc-v7, xenc-v8), got {order}"
    v7, v8 = by_version["xenc-v7"].get("hit_ratio"), by_version["xenc-v8"].get("hit_ratio")
    assert _near(v7, 0.9) and _near(v8, 0.2), f"the hit ratios must be each version's own (0.9 and 0.2), got {v7} and {v8}: {text}"


async def check_unscored_share(ctx):
    by_version, _, text = await _versions(ctx)
    got = {v: by_version.get(v, {}).get("unscored_share") for v in ("xenc-v7", "xenc-v8")}
    assert _near(got["xenc-v7"], 0.05) and _near(got["xenc-v8"], 0.5), f"unscored_share must be unscored_batches / batches (0.05 and 0.5), got {got}: {text}"


async def check_fallback_share(ctx):
    by_version, _, text = await _versions(ctx)
    got = {v: by_version.get(v, {}).get("fallback_share") for v in ("xenc-v7", "xenc-v8")}
    assert _near(got["xenc-v7"], 0.0) and _near(got["xenc-v8"], 0.4), f"fallback_share must be fallback_requests / requests (0 and 0.4), got {got}: {text}"


async def check_boundary_latency(ctx):
    by_version, _, text = await _versions(ctx)
    want = {
        "xenc-v7": {"queue": {"p50": 10, "p95": 20}, "model": {"p50": 60, "p95": 300}},
        "xenc-v8": {"queue": {"p50": 900, "p95": 1200}, "model": {"p50": 45, "p95": 55}},
    }
    for version, latency in want.items():
        got = by_version.get(version, {}).get("latency_ms")
        assert got == latency, f"{version}'s latency_ms must be the queue and model boundaries apart, nearest-rank p50/p95 {latency}, got {got}: {text}"
`,
    typescript: `const STATS = '/v1/rerank/cache/stats';

/** Two builds as the stats consumer recorded them: xenc-v7 healthy, xenc-v8 failing batches behind a deep queue. */
function seed(ctx) {
  ctx.redis.sadd('rerank:versions', 'xenc-v8', 'xenc-v7');
  ctx.redis.hset('rerank:stats:xenc-v7', 'requests', '10', 'hits', '90', 'misses', '10', 'batches', '40', 'unscored_batches', '2', 'fallback_requests', '0');
  ctx.redis.hset('rerank:stats:xenc-v8', 'requests', '20', 'hits', '20', 'misses', '80', 'batches', '50', 'unscored_batches', '25', 'fallback_requests', '8');
  ctx.redis.rpush('rerank:latency:xenc-v7:queue', 20, 5, 15, 10);
  ctx.redis.rpush('rerank:latency:xenc-v7:model', 300, 40, 60, 50, 70);
  ctx.redis.rpush('rerank:latency:xenc-v8:queue', 900, 1200, 800);
  ctx.redis.rpush('rerank:latency:xenc-v8:model', 55, 45);
  ctx.redis.set('rerank:hits', 110);
  ctx.redis.set('rerank:misses', 90);
  ctx.redis.rpush('rerank:latency:client', 950, 1300, 120, 400);
}

async function versions(ctx) {
  seed(ctx);
  const r = await ctx.client(ctx.load('read').app).get(STATS);
  assert.equal(r.status, 200, \`GET \${STATS} answered \${r.status}: \${r.text}\`);
  const list = r.json().versions;
  assert(Array.isArray(list), \`the answer must carry versions, one entry per model version, got \${r.text}\`);
  return {byVersion: Object.fromEntries(list.map(v => [v.model_version, v])), order: list.map(v => v.model_version), text: r.text};
}

const near = (got, want: number) => typeof got === 'number' && Math.abs(got - want) < 1e-6;

export async function check_route(ctx) {
  const r = await ctx.client(ctx.load('read').app).get(STATS);
  assert.equal(r.status, 200, \`GET \${STATS} answered \${r.status} before any stats exist: \${r.text}\`);
  const body = r.json();
  assert(body !== null && typeof body === 'object' && !Array.isArray(body), \`the answer must be a JSON object, got \${r.text}\`);
}

export async function check_per_version(ctx) {
  const {byVersion, order, text} = await versions(ctx);
  assert.deepEqual(order, ['xenc-v7', 'xenc-v8'], \`expected one entry per version, sorted (xenc-v7, xenc-v8), got \${JSON.stringify(order)}\`);
  const v7 = byVersion['xenc-v7'].hit_ratio;
  const v8 = byVersion['xenc-v8'].hit_ratio;
  assert(near(v7, 0.9) && near(v8, 0.2), \`the hit ratios must be each version's own (0.9 and 0.2), got \${v7} and \${v8}: \${text}\`);
}

export async function check_unscored_share(ctx) {
  const {byVersion, text} = await versions(ctx);
  const v7 = byVersion['xenc-v7']?.unscored_share;
  const v8 = byVersion['xenc-v8']?.unscored_share;
  assert(near(v7, 0.05) && near(v8, 0.5), \`unscored_share must be unscored_batches / batches (0.05 and 0.5), got \${v7} and \${v8}: \${text}\`);
}

export async function check_fallback_share(ctx) {
  const {byVersion, text} = await versions(ctx);
  const v7 = byVersion['xenc-v7']?.fallback_share;
  const v8 = byVersion['xenc-v8']?.fallback_share;
  assert(near(v7, 0) && near(v8, 0.4), \`fallback_share must be fallback_requests / requests (0 and 0.4), got \${v7} and \${v8}: \${text}\`);
}

export async function check_boundary_latency(ctx) {
  const {byVersion, text} = await versions(ctx);
  const want = {
    'xenc-v7': {queue: {p50: 10, p95: 20}, model: {p50: 60, p95: 300}},
    'xenc-v8': {queue: {p50: 900, p95: 1200}, model: {p50: 45, p95: 55}},
  };
  for (const [version, latency] of Object.entries(want)) {
    assert.deepEqual(byVersion[version]?.latency_ms, latency, \`\${version}'s latency_ms must be the queue and model boundaries apart, nearest-rank p50/p95 \${JSON.stringify(latency)}, got \${JSON.stringify(byVersion[version]?.latency_ms)}: \${text}\`);
  }
}
`,
    go: `package main

import (
	"math"
	"net/http"

	"leetbuild/harness"
)

const readStats = "/v1/rerank/cache/stats"

type readPercentiles struct {
	P50 int \`json:"p50"\`
	P95 int \`json:"p95"\`
}

type readEntry struct {
	ModelVersion  string                     \`json:"model_version"\`
	HitRatio      *float64                   \`json:"hit_ratio"\`
	UnscoredShare *float64                   \`json:"unscored_share"\`
	FallbackShare *float64                   \`json:"fallback_share"\`
	LatencyMs     map[string]readPercentiles \`json:"latency_ms"\`
}

func readClient(ctx *harness.Ctx) *harness.HTTP {
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

// readSeed: two builds as the stats consumer recorded them, xenc-v7 healthy, xenc-v8 failing batches behind a deep queue.
func readSeed(ctx *harness.Ctx) {
	ctx.Redis.Do("SADD", "rerank:versions", "xenc-v8", "xenc-v7")
	ctx.Redis.Do("HSET", "rerank:stats:xenc-v7", "requests", 10, "hits", 90, "misses", 10, "batches", 40, "unscored_batches", 2, "fallback_requests", 0)
	ctx.Redis.Do("HSET", "rerank:stats:xenc-v8", "requests", 20, "hits", 20, "misses", 80, "batches", 50, "unscored_batches", 25, "fallback_requests", 8)
	ctx.Redis.Do("RPUSH", "rerank:latency:xenc-v7:queue", 20, 5, 15, 10)
	ctx.Redis.Do("RPUSH", "rerank:latency:xenc-v7:model", 300, 40, 60, 50, 70)
	ctx.Redis.Do("RPUSH", "rerank:latency:xenc-v8:queue", 900, 1200, 800)
	ctx.Redis.Do("RPUSH", "rerank:latency:xenc-v8:model", 55, 45)
	ctx.Redis.Set("rerank:hits", 110)
	ctx.Redis.Set("rerank:misses", 90)
	ctx.Redis.Do("RPUSH", "rerank:latency:client", 950, 1300, 120, 400)
}

func readVersions(ctx *harness.Ctx) (map[string]readEntry, []string, string) {
	readSeed(ctx)
	r := readClient(ctx).Get(readStats)
	ctx.Equal(r.Status, 200, "GET %s (%s)", readStats, r.Text())
	var body struct {
		Versions []readEntry \`json:"versions"\`
	}
	r.Decode(&body)
	ctx.Assert(body.Versions != nil, "the answer must carry versions, one entry per model version, got %s", r.Text())
	byVersion := map[string]readEntry{}
	order := []string{}
	for _, v := range body.Versions {
		byVersion[v.ModelVersion] = v
		order = append(order, v.ModelVersion)
	}
	return byVersion, order, r.Text()
}

func readNear(got *float64, want float64) bool { return got != nil && math.Abs(*got-want) < 1e-6 }

func CheckRoute(ctx *harness.Ctx) {
	r := readClient(ctx).Get(readStats)
	ctx.Equal(r.Status, 200, "GET %s before any stats exist (%s)", readStats, r.Text())
	_, isObject := r.JSON().(map[string]any)
	ctx.Assert(isObject, "the answer must be a JSON object, got %s", r.Text())
}

func CheckPerVersion(ctx *harness.Ctx) {
	byVersion, order, text := readVersions(ctx)
	ctx.Equal(order, []string{"xenc-v7", "xenc-v8"}, "one entry per version, sorted; the versions")
	ctx.Assert(readNear(byVersion["xenc-v7"].HitRatio, 0.9) && readNear(byVersion["xenc-v8"].HitRatio, 0.2), "the hit ratios must be each version's own (0.9 and 0.2): %s", text)
}

func CheckUnscoredShare(ctx *harness.Ctx) {
	byVersion, _, text := readVersions(ctx)
	ctx.Assert(readNear(byVersion["xenc-v7"].UnscoredShare, 0.05) && readNear(byVersion["xenc-v8"].UnscoredShare, 0.5), "unscored_share must be unscored_batches / batches (0.05 and 0.5): %s", text)
}

func CheckFallbackShare(ctx *harness.Ctx) {
	byVersion, _, text := readVersions(ctx)
	ctx.Assert(readNear(byVersion["xenc-v7"].FallbackShare, 0) && readNear(byVersion["xenc-v8"].FallbackShare, 0.4), "fallback_share must be fallback_requests / requests (0 and 0.4): %s", text)
}

func CheckBoundaryLatency(ctx *harness.Ctx) {
	byVersion, _, text := readVersions(ctx)
	want := map[string]map[string]readPercentiles{
		"xenc-v7": {"queue": {P50: 10, P95: 20}, "model": {P50: 60, P95: 300}},
		"xenc-v8": {"queue": {P50: 900, P95: 1200}, "model": {P50: 45, P95: 55}},
	}
	for _, version := range []string{"xenc-v7", "xenc-v8"} {
		ctx.Equal(byVersion[version].LatencyMs, want[version], "%s's latency_ms must be the queue and model boundaries apart, nearest-rank p50/p95 (%s)", version, text)
	}
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <cmath>
#include <map>
#include <string>
#include <vector>

namespace {

const std::string kStats = "/v1/rerank/cache/stats";

harness::HTTP readClient(harness::Ctx& ctx) {
  static httplib::Server* svr = nullptr;
  delete svr;
  svr = new httplib::Server;
  register_routes(*svr);
  return ctx.HTTP(*svr);
}

// Two builds as the stats consumer recorded them: xenc-v7 healthy, xenc-v8 failing batches behind a deep queue.
void readSeed(harness::Ctx& ctx) {
  ctx.Redis.Do("SADD", "rerank:versions", "xenc-v8", "xenc-v7");
  ctx.Redis.Do("HSET", "rerank:stats:xenc-v7", "requests", 10, "hits", 90, "misses", 10, "batches", 40, "unscored_batches", 2, "fallback_requests", 0);
  ctx.Redis.Do("HSET", "rerank:stats:xenc-v8", "requests", 20, "hits", 20, "misses", 80, "batches", 50, "unscored_batches", 25, "fallback_requests", 8);
  ctx.Redis.Do("RPUSH", "rerank:latency:xenc-v7:queue", 20, 5, 15, 10);
  ctx.Redis.Do("RPUSH", "rerank:latency:xenc-v7:model", 300, 40, 60, 50, 70);
  ctx.Redis.Do("RPUSH", "rerank:latency:xenc-v8:queue", 900, 1200, 800);
  ctx.Redis.Do("RPUSH", "rerank:latency:xenc-v8:model", 55, 45);
  ctx.Redis.Set("rerank:hits", 110);
  ctx.Redis.Set("rerank:misses", 90);
  ctx.Redis.Do("RPUSH", "rerank:latency:client", 950, 1300, 120, 400);
}

struct Versions {
  std::map<std::string, nlohmann::json> by_version;
  std::vector<std::string> order;
  std::string text;
};

Versions readVersions(harness::Ctx& ctx) {
  readSeed(ctx);
  auto c = readClient(ctx);
  const auto r = c.Get(kStats);
  ctx.Equal(r.Status, 200, "GET %s (%s)", kStats, r.Text());
  const auto body = nlohmann::json::parse(r.Text(), nullptr, false);
  ctx.Assert(body.is_object() && body.contains("versions") && body["versions"].is_array(), "the answer must carry versions, one entry per model version, got %s", r.Text());
  Versions out;
  out.text = r.Text();
  for (const auto& v : body["versions"]) {
    const std::string name = v.value("model_version", "");
    out.by_version[name] = v;
    out.order.push_back(name);
  }
  return out;
}

bool near(const nlohmann::json& entry, const std::string& field, double want) {
  return entry.is_object() && entry.contains(field) && entry[field].is_number() && std::fabs(entry[field].get<double>() - want) < 1e-6;
}

}  // namespace

void CheckRoute(harness::Ctx& ctx) {
  auto c = readClient(ctx);
  const auto r = c.Get(kStats);
  ctx.Equal(r.Status, 200, "GET %s before any stats exist (%s)", kStats, r.Text());
  ctx.Assert(nlohmann::json::parse(r.Text(), nullptr, false).is_object(), "the answer must be a JSON object, got %s", r.Text());
}

void CheckPerVersion(harness::Ctx& ctx) {
  auto v = readVersions(ctx);
  ctx.Equal(v.order, std::vector<std::string>{"xenc-v7", "xenc-v8"}, "one entry per version, sorted; the versions");
  ctx.Assert(near(v.by_version["xenc-v7"], "hit_ratio", 0.9) && near(v.by_version["xenc-v8"], "hit_ratio", 0.2), "the hit ratios must be each version's own (0.9 and 0.2): %s", v.text);
}

void CheckUnscoredShare(harness::Ctx& ctx) {
  auto v = readVersions(ctx);
  ctx.Assert(near(v.by_version["xenc-v7"], "unscored_share", 0.05) && near(v.by_version["xenc-v8"], "unscored_share", 0.5), "unscored_share must be unscored_batches / batches (0.05 and 0.5): %s", v.text);
}

void CheckFallbackShare(harness::Ctx& ctx) {
  auto v = readVersions(ctx);
  ctx.Assert(near(v.by_version["xenc-v7"], "fallback_share", 0) && near(v.by_version["xenc-v8"], "fallback_share", 0.4), "fallback_share must be fallback_requests / requests (0 and 0.4): %s", v.text);
}

void CheckBoundaryLatency(harness::Ctx& ctx) {
  auto v = readVersions(ctx);
  const std::map<std::string, nlohmann::json> want = {
      {"xenc-v7", {{"queue", {{"p50", 10}, {"p95", 20}}}, {"model", {{"p50", 60}, {"p95", 300}}}}},
      {"xenc-v8", {{"queue", {{"p50", 900}, {"p95", 1200}}}, {"model", {{"p50", 45}, {"p95", 55}}}}},
  };
  for (const auto& [version, latency] : want) {
    const auto& entry = v.by_version[version];
    ctx.Equal(entry.is_object() && entry.contains("latency_ms") ? entry["latency_ms"] : nlohmann::json(), latency,
              "%s's latency_ms must be the queue and model boundaries apart, nearest-rank p50/p95 (%s)", version, v.text);
  }
}
`,
  },
  hints: [
    'Roll out a build whose batches time out: the stats page still shows a healthy hit ratio, the new build is invisible beside the old one, and its slow queue shows up as a slow model.',
    'The handler reads the fleet totals (hits and misses over every version, latency as clients saw it) and never the per-version hash, the unscored batch counter, the fallback counter or the two boundary lists.',
    'For each version in sorted `SMEMBERS VERSIONS_KEY`: `HGETALL stats_key(v)` for `hit_ratio`, `unscored_share`, `fallback_share`; `percentile` over `LRANGE latency_key(v, "queue")` and `(v, "model")` for `latency_ms`.',
  ],
  debrief: `Every number is per version because a rollout is a comparison: the build that regressed is one of two, and a fleet average weighted by traffic hides it until it is all of the traffic. The unscored and fallback shares sit beside the hit ratio because a reranker that silently falls back to retrieval order still serves 200s at full speed; those two numbers are its error rate. Latency is measured at the queue and at the model call because the fixes differ, more replicas for one, a smaller batch or a faster build for the other, and a client's clock adds the network to both. Production dashboards keep these as time series per version and alert on the difference between versions, with a minimum request count before a share means anything.`,
};
