import type {Step} from '@/lib/types';

export const cacheReadStep: Step = {
  id: 'read',
  title: 'GET /v1/cache/stats: the ratio a rollout decision trusts',
  concept: 'http',
  file: 'read',
  focus: ['client', 'cache', 'consumer', 'redis'],
  task: `## Task

**Starting point.** The starter serves \`GET /v1/cache/stats\`: it divides two global counters into
one ratio, prices the savings with a literal \`rate = 0.002\`, reports a fixed
\`handler_duration_ms\`, and answers for whichever \`?tenant=\` the caller names. It serves the demo
and hides five flaws.

**Failure mode the checks target.** A ratio is only as trustworthy as its slice and its price. The
global number hides the tenant that is subsidising everyone else, the hardcoded price makes the
savings line unauditable, and the missing tenant check leaks all of it to anyone with a request.

- **The tenant comes from the authenticated header**; a missing tenant is **401**.
- **\`?tenant=\` must match the caller.** Another tenant's slice is **403** \`{"error": "forbidden"}\`,
  not an empty result.
- **One slice per prompt version, for the caller's tenant only.** Read \`pc:versions:{tenant}\` and,
  per version, \`pc:access:{tenant}:{version}\` (\`hits\`, \`misses\`, \`tokens_saved\`,
  \`fill_latency_ms\`).
- **\`hit_ratio\` is \`hits / (hits + misses)\` per slice** from those counters, 0 with no traffic.
- **\`fill_latency_ms\` is the average the events carry**, not the handler's own duration: the number
  that matters is how long the *misses* took.
- **Savings come from a versioned rate table**: \`tokens_saved / 1000 * RATE_TABLE[version]\` with a
  default row for unlisted versions, so a price change is a table change rather than a rewrite of
  history.
- The response is \`{"tenant", "versions": [{"version", "hit_ratio", "fill_latency_ms", "savings_usd"}]}\`.`,
  sequence: {
    participants: ['Operator', 'Prompt Cache', 'Redis'],
    messages: [
      {
        from: 'Operator',
        to: 'Prompt Cache',
        label: 'GET /v1/cache/stats?tenant=acme · x-tenant-id: acme',
        kind: 'sync',
      },
      {
        from: 'Prompt Cache',
        to: 'Prompt Cache',
        label: 'requested tenant must equal the authenticated tenant, else 403',
        kind: 'sync',
      },
      {from: 'Prompt Cache', to: 'Redis', label: 'SMEMBERS pc:versions:acme', kind: 'sync'},
      {from: 'Redis', to: 'Prompt Cache', label: '[7, 8]', kind: 'reply'},
      {
        from: 'Prompt Cache',
        to: 'Redis',
        label: 'HGET pc:access:acme:7 {hits, misses, tokens_saved, fill_latency_ms}',
        kind: 'sync',
      },
      {from: 'Redis', to: 'Prompt Cache', label: 'counters written by the fill path and the consumer', kind: 'reply'},
      {
        from: 'Prompt Cache',
        to: 'Operator',
        label: '200 {tenant, versions:[{version, hit_ratio, fill_latency_ms, savings_usd}]}',
        kind: 'reply',
      },
    ],
  },
  hints: [
    "A rollout reads a healthy 0.8 ratio while one tenant's misses are paying for everyone else's hits, any caller can read any tenant's numbers, and last quarter's savings figure cannot be recomputed.",
    "The handler reads `global_hits` and `global_misses`, takes `requested` from `?tenant=` without comparing it to the header, hardcodes `rate`, and reports a constant `handler_duration_ms` under the cache's name.",
    "Answer 403 when `?tenant=` differs from `x-tenant-id`; iterate `pc:versions:{tenant}`, read `pc:access:{tenant}:{version}`, compute `hits / (hits + misses)`, price with `RATE_TABLE.get(version, default)`, and report the counters' `fill_latency_ms`.",
  ],
  checks: [
    {
      id: 'per-tenant-version-slice',
      title: 'Reports one slice per prompt version for the caller’s tenant',
      detail:
        'The endpoint reads `pc:versions:{tenant}` and, per version, the counters at `pc:access:{tenant}:{version}`. The starter reports one `global` ratio over every tenant and version, so one tenant’s misses are hidden behind another tenant’s hits.',
      match: {
        python: {all: [/def stats_for_tenant\(/, /pc:access:\{tenant\}:\{version\}/], none: [/global/]},
        typescript: {all: [/function statsForTenant\(/, /pc:access:\$\{tenant\}:\$\{version\}/], none: [/global/]},
        go: {all: [/func statsForTenant\(/, /pc:access:%s:%d/], none: [/global/]},
        scala: {all: [/def statsForTenant\(/, /s"pc:access:\$tenant:\$version"/], none: [/global/]},
        cpp: {all: [/stats_for_tenant\(/, /"pc:access:" \+ tenant/], none: [/global/]},
      },
    },
    {
      id: 'foreign-tenant-403',
      title: 'A foreign tenant slice is 403',
      detail:
        'A `?tenant=` that differs from the authenticated tenant is answered `403 {"error": "forbidden"}` — an explicit refusal, not an empty slice. The starter serves any tenant’s slice to any caller.',
      match: {
        python: {all: [/\b403\b/, /requested != tenant/]},
        typescript: {all: [/\.code\(\s*403\s*\)|\b403\b/, /requested !== tenant/]},
        go: {all: [/StatusForbidden/, /requested != tenant/]},
        scala: {all: [/Forbidden/, /requested\.exists\(_ != tenant\)/]},
        cpp: {all: [/\b403\b/, /requested != tenant/]},
      },
    },
    {
      id: 'ratio-from-counters',
      title: 'Hit ratio is hits / (hits + misses) per slice',
      detail:
        'Each slice computes `hit_ratio` from the two counters the consumer writes — `total = hits + misses`, then `hits / total` (0 when there is no traffic). The starter divides a global hits counter by a global misses counter it never updates.',
      match: {
        python: {all: [/total = hits \+ misses/, /hit_ratio/]},
        typescript: {all: [/const total = hits \+ misses/, /hit_ratio/]},
        go: {all: [/total := hits \+ misses/, /"hit_ratio"/]},
        scala: {all: [/val total = hits \+ misses/, /hit_ratio/]},
        cpp: {all: [/const int total = hits \+ misses/, /"hit_ratio"/]},
      },
    },
    {
      id: 'rate-table',
      title: 'Savings use a versioned rate table, not a hardcoded price',
      detail:
        '`savings_usd` is `tokens_saved / 1000 * RATE_TABLE[version]` with a default row for unlisted versions, so a price change is a table change. The starter multiplies by a literal rate, which makes the savings number impossible to reproduce later.',
      match: {
        python: {all: [/RATE_TABLE = \{/, /RATE_TABLE\.get\(version/], none: [/rate = 0\.0/]},
        typescript: {all: [/RATE_TABLE: Record<number, number> = \{/, /RATE_TABLE\[version\]/], none: [/rate = 0\.0/]},
        go: {all: [/rateTable = map\[int\]float64/, /rateTable\[version\]/], none: [/rate = 0\.0/]},
        scala: {all: [/RateTable: Map\[Int, Double\] = Map\(/, /RateTable\.getOrElse\(version/], none: [/rate = 0\.0/]},
        cpp: {all: [/kRateTable = \{/, /kRateTable\.find\(version\)/], none: [/rate = 0\.0/]},
      },
    },
    {
      id: 'fill-latency',
      title: 'Reports the misses’ latency, not the handler’s',
      detail:
        '`fill_latency_ms` comes from the counters the events maintain, so it describes how long cache misses take. The starter reports its own `handler_duration_ms` under the cache’s name, which tells a rollout nothing about the miss path.',
      match: {
        python: {all: [/"fill_latency_ms"/], none: [/handler_duration/, /perf_counter\(\)/]},
        typescript: {all: [/fill_latency_ms/], none: [/handler_duration/]},
        go: {all: [/"fill_latency_ms"/], none: [/handlerDuration/]},
        scala: {all: [/fill_latency_ms/], none: [/handlerDuration/]},
        cpp: {all: [/"fill_latency_ms"/], none: [/handler_duration/]},
      },
    },
  ],
  code: {
    python: {
      starter: `from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from redis.asyncio import Redis

app = FastAPI()
store = Redis.from_url("redis://cache:6379/0")


@app.get("/v1/cache/stats")
async def cache_stats(request: Request) -> JSONResponse:
    # TODO: this starter has five flaws. The task says where to look; the checks say what must change.
    tenant = request.headers.get("x-tenant-id")
    requested = request.query_params.get("tenant", tenant)
    hits = int(await store.get("global_hits") or 0)
    misses = int(await store.get("global_misses") or 0)
    ratio = hits / (hits + misses) if hits + misses else 0.0
    rate = 0.002
    savings_usd = misses * 4096 / 1_000_000 * rate
    return JSONResponse(
        {
            "tenant": requested,
            "hit_ratio": ratio,
            "handler_duration_ms": 12,
            "savings_usd": savings_usd,
        }
    )
`,
      solution: `from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from redis.asyncio import Redis

app = FastAPI()
store = Redis.from_url("redis://cache:6379/0")

# USD per 1k tokens saved, per prompt version: a price change is a new row, not a code change.
RATE_TABLE = {7: 0.0004, 8: 0.0005}
DEFAULT_RATE_VERSION = 8


async def stats_for_tenant(tenant: str) -> list[dict]:
    """One slice per prompt version, from the counters the fill path and the consumer write."""
    versions = sorted(int(v) for v in await store.smembers(f"pc:versions:{tenant}"))
    slices = []
    for version in versions:
        counter = f"pc:access:{tenant}:{version}"
        hits = int(await store.hget(counter, "hits") or 0)
        misses = int(await store.hget(counter, "misses") or 0)
        total = hits + misses
        tokens_saved = int(await store.hget(counter, "tokens_saved") or 0)
        rate = RATE_TABLE.get(version, RATE_TABLE[DEFAULT_RATE_VERSION])
        slices.append(
            {
                "version": version,
                "hit_ratio": hits / total if total else 0.0,
                "fill_latency_ms": int(await store.hget(counter, "fill_latency_ms") or 0),
                "savings_usd": tokens_saved / 1000 * rate,
            }
        )
    return slices


@app.get("/v1/cache/stats")
async def cache_stats(request: Request) -> JSONResponse:
    tenant = request.headers.get("x-tenant-id")
    if not tenant:
        return JSONResponse({"error": "tenant_required"}, status_code=401)
    requested = request.query_params.get("tenant", tenant)
    if requested != tenant:
        # A ratio is a slice of somebody's traffic: a foreign tenant is forbidden, not empty.
        return JSONResponse({"error": "forbidden"}, status_code=403)
    return JSONResponse({"tenant": tenant, "versions": await stats_for_tenant(tenant)})
`,
    },
    typescript: {
      starter: `/** GET /v1/cache/stats: a dashboard endpoint with one global number. */
import Fastify from 'fastify';
import {Redis} from 'ioredis';

export const app = Fastify();
const store = new Redis('redis://cache:6379');

app.get('/v1/cache/stats', async (request, reply) => {
  // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
  const startedAt = Date.now();
  const tenant = request.headers['x-tenant-id'] as string;
  const requested = (request.query as {tenant?: string}).tenant ?? tenant;
  const hits = Number((await store.get('global_hits')) ?? 0);
  const misses = Number((await store.get('global_misses')) ?? 0);
  const ratio = hits + misses === 0 ? 0 : hits / (hits + misses);
  const rate = 0.002;
  return reply.code(200).send({
    tenant: requested,
    hit_ratio: ratio,
    handler_duration_ms: Date.now() - startedAt,
    savings_usd: (misses * 4096 * rate) / 1_000_000,
  });
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** GET /v1/cache/stats: the per-tenant, per-version slice a rollout decision can trust. */
import Fastify from 'fastify';
import {Redis} from 'ioredis';

export const app = Fastify();
const store = new Redis('redis://cache:6379');

// USD per 1k tokens saved, per prompt version: a price change is a new row, not a code change.
const RATE_TABLE: Record<number, number> = {7: 0.0004, 8: 0.0005};
const DEFAULT_RATE_VERSION = 8;

interface VersionSlice {
  version: number;
  hit_ratio: number;
  fill_latency_ms: number;
  savings_usd: number;
}

/** One slice per prompt version, from the counters the fill path and the consumer write. */
async function statsForTenant(tenant: string): Promise<VersionSlice[]> {
  const versions = (await store.smembers(\`pc:versions:\${tenant}\`)).map(Number).sort();
  const slices: VersionSlice[] = [];
  for (const version of versions) {
    const counter = \`pc:access:\${tenant}:\${version}\`;
    const hits = Number((await store.hget(counter, 'hits')) ?? 0);
    const misses = Number((await store.hget(counter, 'misses')) ?? 0);
    const total = hits + misses;
    const tokensSaved = Number((await store.hget(counter, 'tokens_saved')) ?? 0);
    const rate = RATE_TABLE[version] ?? RATE_TABLE[DEFAULT_RATE_VERSION];
    slices.push({
      version,
      hit_ratio: total === 0 ? 0 : hits / total,
      fill_latency_ms: Number((await store.hget(counter, 'fill_latency_ms')) ?? 0),
      savings_usd: (tokensSaved / 1000) * rate,
    });
  }
  return slices;
}

app.get('/v1/cache/stats', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') {
    return reply.code(401).send({error: 'tenant_required'});
  }
  const requested = (request.query as {tenant?: string}).tenant ?? tenant;
  if (requested !== tenant) {
    // A ratio is a slice of somebody's traffic: a foreign tenant is forbidden, not empty.
    return reply.code(403).send({error: 'forbidden'});
  }
  return reply.code(200).send({tenant, versions: await statsForTenant(tenant)});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
    },
    go: {
      starter: `package main

import (
	"fmt"
	"net/http"

	"github.com/redis/go-redis/v9"
)

// TODO: this starter has five flaws. The task says where to look; the checks say what must change.
func cacheStats(r *redis.Client) http.HandlerFunc {
	return func(w http.ResponseWriter, req *http.Request) {
		startedAt := nowMillis()
		tenant := req.Header.Get("x-tenant-id")
		requested := req.URL.Query().Get("tenant")
		if requested == "" {
			requested = tenant
		}
		hits, _ := r.Get(req.Context(), "global_hits").Int()
		misses, _ := r.Get(req.Context(), "global_misses").Int()
		ratio := 0.0
		if hits+misses > 0 {
			ratio = float64(hits) / float64(hits+misses)
		}
		rate := 0.002
		writeJSON(w, http.StatusOK, map[string]any{
			"tenant":              requested,
			"hit_ratio":           ratio,
			"handler_duration_ms": nowMillis() - startedAt,
			"savings_usd":         float64(misses*4096) / 1_000_000 * rate,
		})
	}
}

var _ = fmt.Sprintf
`,
      solution: `package main

import (
	"context"
	"fmt"
	"net/http"
	"strconv"

	"github.com/redis/go-redis/v9"
)

// USD per 1k tokens saved, per prompt version: a price change is a new row, not a code change.
var rateTable = map[int]float64{7: 0.0004, 8: 0.0005}

const defaultRateVersion = 8

type versionSlice struct {
	Version       int     \`json:"version"\`
	HitRatio      float64 \`json:"hit_ratio"\`
	FillLatencyMs int     \`json:"fill_latency_ms"\`
	SavingsUSD    float64 \`json:"savings_usd"\`
}

// statsForTenant reports one slice per prompt version, from the counters the writers maintain.
func statsForTenant(ctx context.Context, r *redis.Client, tenant string) ([]versionSlice, error) {
	raw, err := r.SMembers(ctx, fmt.Sprintf("pc:versions:%s", tenant)).Result()
	if err != nil {
		return nil, err
	}
	slices := make([]versionSlice, 0, len(raw))
	for _, value := range raw {
		version, err := strconv.Atoi(value)
		if err != nil {
			continue
		}
		counter := fmt.Sprintf("pc:access:%s:%d", tenant, version)
		hits, _ := strconv.Atoi(r.HGet(ctx, counter, "hits").Val())
		misses, _ := strconv.Atoi(r.HGet(ctx, counter, "misses").Val())
		total := hits + misses
		tokensSaved, _ := strconv.Atoi(r.HGet(ctx, counter, "tokens_saved").Val())
		latency, _ := strconv.Atoi(r.HGet(ctx, counter, "fill_latency_ms").Val())
		rate, ok := rateTable[version]
		if !ok {
			rate = rateTable[defaultRateVersion]
		}
		ratio := 0.0
		if total > 0 {
			ratio = float64(hits) / float64(total)
		}
		slices = append(slices, versionSlice{
			Version:       version,
			HitRatio:      ratio,
			FillLatencyMs: latency,
			SavingsUSD:    float64(tokensSaved) / 1000 * rate,
		})
	}
	return slices, nil
}

func cacheStats(r *redis.Client) http.HandlerFunc {
	return func(w http.ResponseWriter, req *http.Request) {
		tenant := req.Header.Get("x-tenant-id")
		if tenant == "" {
			writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "tenant_required"})
			return
		}
		requested := req.URL.Query().Get("tenant")
		if requested == "" {
			requested = tenant
		}
		if requested != tenant {
			// A ratio is a slice of somebody's traffic: a foreign tenant is forbidden, not empty.
			writeJSON(w, http.StatusForbidden, map[string]any{"error": "forbidden"})
			return
		}
		slices, err := statsForTenant(req.Context(), r, tenant)
		if err != nil {
			writeJSON(w, http.StatusServiceUnavailable, map[string]any{"error": "stats_unavailable"})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"tenant": tenant, "versions": slices})
	}
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.http.scaladsl.model.StatusCodes
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route

object CacheStats {
  // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
  val routes: Route = get {
    path("v1" / "cache" / "stats") {
      parameter("tenant".?) { requested =>
        val startedAt = System.nanoTime()
        val hits = jedis.get("global_hits").toInt
        val misses = jedis.get("global_misses").toInt
        val ratio = if (hits + misses == 0) 0.0 else hits.toDouble / (hits + misses)
        val rate = 0.002
        complete(
          StatusCodes.OK,
          s"""{"tenant":"\${requested.getOrElse("")}","hit_ratio":$ratio,"handler_duration_ms":\${(System.nanoTime() - startedAt) / 1000000},"savings_usd":\${misses * 4096 / 1_000_000.0 * rate}}"""
        )
      }
    }
  }
}
`,
      solution: `import org.apache.pekko.http.scaladsl.model.StatusCodes
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route

import scala.jdk.CollectionConverters._

object CacheStats {
  // USD per 1k tokens saved, per prompt version: a price change is a new row, not a code change.
  val RateTable: Map[Int, Double] = Map(7 -> 0.0004, 8 -> 0.0005)
  val DefaultRateVersion = 8

  final case class VersionSlice(version: Int, hit_ratio: Double, fill_latency_ms: Int, savings_usd: Double)

  /** One slice per prompt version, from the counters the fill path and the consumer write. */
  def statsForTenant(jedis: Jedis, tenant: String): List[VersionSlice] =
    jedis.smembers(s"pc:versions:$tenant").asScala.toList.map(_.toInt).sorted.map { version =>
      val counter = s"pc:access:$tenant:$version"
      val hits = Option(jedis.hget(counter, "hits")).map(_.toInt).getOrElse(0)
      val misses = Option(jedis.hget(counter, "misses")).map(_.toInt).getOrElse(0)
      val total = hits + misses
      val tokensSaved = Option(jedis.hget(counter, "tokens_saved")).map(_.toInt).getOrElse(0)
      val rate = RateTable.getOrElse(version, RateTable(DefaultRateVersion))
      VersionSlice(
        version = version,
        hit_ratio = if (total == 0) 0.0 else hits.toDouble / total,
        fill_latency_ms = Option(jedis.hget(counter, "fill_latency_ms")).map(_.toInt).getOrElse(0),
        savings_usd = tokensSaved / 1000.0 * rate,
      )
    }

  val routes: Route = get {
    path("v1" / "cache" / "stats") {
      optionalHeaderValueByName("x-tenant-id") { header =>
        parameter("tenant".?) { requested =>
          header match {
            case None => complete((StatusCodes.Unauthorized, """{"error":"tenant_required"}"""))
            case Some(tenant) if requested.exists(_ != tenant) =>
              // A ratio is a slice of somebody's traffic: a foreign tenant is forbidden, not empty.
              complete((StatusCodes.Forbidden, """{"error":"forbidden"}"""))
            case Some(tenant) =>
              val slices = statsForTenant(jedis, tenant)
              complete((StatusCodes.OK, render(tenant, slices)))
          }
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

#include <string>

using json = nlohmann::json;

// TODO: this starter has five flaws. The task says where to look; the checks say what must change.
void register_cache_stats(httplib::Server& server, sw::redis::Redis& cache) {
  server.Get("/v1/cache/stats", [&cache](const httplib::Request& request, httplib::Response& response) {
    const auto started = std::chrono::steady_clock::now();
    const std::string tenant = request.get_header_value("x-tenant-id");
    const std::string requested = request.has_param("tenant") ? request.get_param_value("tenant") : tenant;
    const int hits = std::stoi(cache.get("global_hits").value_or("0"));
    const int misses = std::stoi(cache.get("global_misses").value_or("0"));
    const double ratio = hits + misses == 0 ? 0.0 : static_cast<double>(hits) / (hits + misses);
    const double rate = 0.002;
    const auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - started);
    response.set_content(
        json{{"tenant", requested},
             {"hit_ratio", ratio},
             {"handler_duration_ms", elapsed.count()},
             {"savings_usd", misses * 4096 / 1'000'000.0 * rate}}
            .dump(),
        "application/json");
  });
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <map>
#include <string>

using json = nlohmann::json;

// USD per 1k tokens saved, per prompt version: a price change is a new row, not a code change.
const std::map<int, double> kRateTable = {{7, 0.0004}, {8, 0.0005}};
const int kDefaultRateVersion = 8;

// stats_for_tenant reports one slice per prompt version, from the counters the writers maintain.
json stats_for_tenant(sw::redis::Redis& cache, const std::string& tenant) {
  json slices = json::array();
  const auto versions = cache.smembers("pc:versions:" + tenant);
  for (const auto& value : versions) {
    const int version = std::stoi(value);
    const std::string counter = "pc:access:" + tenant + ":" + std::to_string(version);
    const int hits = std::stoi(cache.hget(counter, "hits").value_or("0"));
    const int misses = std::stoi(cache.hget(counter, "misses").value_or("0"));
    const int total = hits + misses;
    const int tokens_saved = std::stoi(cache.hget(counter, "tokens_saved").value_or("0"));
    const auto row = kRateTable.find(version);
    const double rate = row == kRateTable.end() ? kRateTable.at(kDefaultRateVersion) : row->second;
    slices.push_back({
        {"version", version},
        {"hit_ratio", total == 0 ? 0.0 : static_cast<double>(hits) / total},
        {"fill_latency_ms", std::stoi(cache.hget(counter, "fill_latency_ms").value_or("0"))},
        {"savings_usd", tokens_saved / 1000.0 * rate},
    });
  }
  return slices;
}

void register_cache_stats(httplib::Server& server, sw::redis::Redis& cache) {
  server.Get("/v1/cache/stats", [&cache](const httplib::Request& request, httplib::Response& response) {
    const std::string tenant = request.get_header_value("x-tenant-id");
    if (tenant.empty()) {
      response.status = 401;
      response.set_content(json{{"error", "tenant_required"}}.dump(), "application/json");
      return;
    }
    const std::string requested = request.has_param("tenant") ? request.get_param_value("tenant") : tenant;
    if (requested != tenant) {
      // A ratio is a slice of somebody's traffic: a foreign tenant is forbidden, not empty.
      response.status = 403;
      response.set_content(json{{"error", "forbidden"}}.dump(), "application/json");
      return;
    }
    response.set_content(json{{"tenant", tenant}, {"versions", stats_for_tenant(cache, tenant)}}.dump(),
                         "application/json");
  });
}
`,
    },
  },
  debrief: `The fix treats the ratio as a claim that has to be defensible line by line, because a rollout acts on it. The slice is the caller's own tenant *and* version, so one tenant's misses cannot hide behind another's hits; the price is a row attached to the version, so the savings figure can be recomputed after a price change; the latency describes the misses rather than the query that reported them; and the tenant check turns a disclosure back into a metrics endpoint. Production stats endpoints usually add a time window to the slice, since lifetime totals dilute this hour's regression with last week's hits, and emit the same numbers as Prometheus series so the rollout gate can alert on a drop instead of polling.`,
};
