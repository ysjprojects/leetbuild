import type {Step} from '@/lib/types';

export const cacheReadStep: Step = {
  id: 'read',
  title: 'GET /v1/cache/stats: the numbers a rollout decision trusts',
  concept: 'http',
  file: 'stats',
  focus: ['client', 'cache', 'consumer', 'redis'],
  task: `## Task

**Starting point.** The starter serves \`GET /v1/cache/stats\` with \`X-Tenant-Id\` (401 without it) and an
optional \`?tenant=\`. It reads the tenant's versions from \`pc-versions:{tenant}\` and, per version, the
\`pc-stats:{tenant}:{version}\` hash step 4 writes, and answers \`{tenant, slices: [{version, hits, misses,
hit_ratio, fill_latency_ms, savings_usd}]}\` sorted by version. The demo shows one slice per version. It
hides 4 flaws.

**Failure mode the checks target.** These numbers decide whether a prompt version rolls out, and each
one is wrong in a way that looks plausible on a dashboard: a ratio above 1, a fill latency averaged
over hits that never called the model, savings priced at one model's rate for every version. And
\`?tenant=\` lets any caller read any tenant's traffic.

- \`?tenant=\` naming another tenant is **403** \`{"error": "forbidden"}\`; naming the caller is fine.
- \`hit_ratio\` is \`hits / (hits + misses)\`, 0 with no traffic.
- \`fill_latency_ms\` is \`fill_ms / misses\`, 0 with no misses.
- \`savings_usd\` is \`tokens_saved / 1000 × price_per_1k(version)\` (\`pcache/config\`), rounded to six
  decimal places.`,
  sequence: {
    participants: ['Client', 'Prompt Cache', 'Redis'],
    messages: [
      {from: 'Client', to: 'Prompt Cache', label: 'GET /v1/cache/stats · X-Tenant-Id: t1', kind: 'sync'},
      {from: 'Prompt Cache', to: 'Redis', label: 'SMEMBERS pc-versions:t1', kind: 'sync'},
      {from: 'Prompt Cache', to: 'Redis', label: 'HGETALL pc-stats:t1:{version} per version', kind: 'sync'},
      {from: 'Redis', to: 'Prompt Cache', label: 'hits · misses · fill_ms · tokens_saved', kind: 'reply'},
      {from: 'Prompt Cache', to: 'Client', label: '200 {tenant, slices: [{version, hit_ratio, …}]}', kind: 'reply'},
    ],
  },
  hints: [
    "A healthy version shows a hit ratio of 3.0, fill latency falls whenever hits rise, version 8 saves as much per token as version 7, and a tenant reads another tenant's traffic by editing the URL.",
    'The starter divides hits by misses, averages fill_ms over every lookup although only misses called the model, prices with a literal RATE_PER_1K_USD, and lets `?tenant=` replace the authenticated tenant.',
    'Answer 403 when `?tenant=` differs from `X-Tenant-Id`; compute `hits / lookups` and `fill_ms / misses`, each 0 when its divisor is 0; price with `price_per_1k(version)`.',
  ],
  checks: [
    {
      id: 'route',
      title: 'Serves one slice per prompt version',
      detail:
        "GET /v1/cache/stats answers 200 with the caller's tenant and one slice per version in pc-versions:{tenant}, sorted, carrying that version's hits and misses; 401 without X-Tenant-Id.",
      match: {
        python: {all: [/@app\.get\(\s*["']\/v1\/cache\/stats["']/]},
        typescript: {all: [/app\.get\(\s*['"]\/v1\/cache\/stats['"]/]},
        go: {all: [/HandleFunc\(\s*"GET \/v1\/cache\/stats"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"cache"\s*\/\s*"stats"\s*\)/]},
        cpp: {all: [/svr\.Get\(\s*"\/v1\/cache\/stats"/]},
      },
    },
    {
      id: 'foreign-tenant',
      title: "Another tenant's stats are 403",
      detail:
        "With X-Tenant-Id t1, ?tenant=t2 answers 403 and none of t2's numbers; ?tenant=t1 answers t1's slices. The starter serves whichever tenant the query names.",
      match: {
        python: {all: [/status_code\s*=\s*403/]},
        typescript: {all: [/code\(\s*403\s*\)/]},
        go: {all: [/StatusForbidden/]},
        scala: {all: [/StatusCodes\.Forbidden/]},
        cpp: {all: [/\b403\b/]},
      },
    },
    {
      id: 'hit-ratio',
      title: 'Hit ratio is hits over lookups',
      detail:
        'hits 3, misses 1 reads 0.75; a version with no traffic reads 0. The starter divides hits by misses and reports 3.0.',
      match: {
        python: {all: [/hits\s*\/\s*lookups/], none: [/hits\s*\/\s*misses/]},
        typescript: {all: [/hits\s*\/\s*lookups/], none: [/hits\s*\/\s*misses/]},
        go: {all: [/float64\(hits\)\s*\/\s*float64\(lookups\)/], none: [/float64\(hits\)\s*\/\s*float64\(misses\)/]},
        scala: {all: [/hits\.toDouble\s*\/\s*lookups/], none: [/hits\.toDouble\s*\/\s*misses/]},
        cpp: {all: [/static_cast<double>\(hits\)\s*\/\s*lookups/], none: [/static_cast<double>\(hits\)\s*\/\s*misses/]},
      },
    },
    {
      id: 'fill-latency',
      title: 'Fill latency averages the misses only',
      detail:
        'fill_ms 900 over 3 misses and 7 hits reads 300 ms; a version with no misses reads 0. The starter divides by every lookup and reports 90.',
      match: {
        python: {all: [/fill_ms\s*\/\s*misses/], none: [/fill_ms\s*\/\s*lookups/]},
        typescript: {all: [/fillMs\s*\/\s*misses/], none: [/fillMs\s*\/\s*lookups/]},
        go: {
          all: [/float64\(fillMs\)\s*\/\s*float64\(misses\)/],
          none: [/float64\(fillMs\)\s*\/\s*float64\(lookups\)/],
        },
        scala: {all: [/fillMs\.toDouble\s*\/\s*misses/], none: [/fillMs\.toDouble\s*\/\s*lookups/]},
        cpp: {
          all: [/static_cast<double>\(fill_ms\)\s*\/\s*misses/],
          none: [/static_cast<double>\(fill_ms\)\s*\/\s*lookups/],
        },
      },
    },
    {
      id: 'version-price',
      title: "Savings use the version's price",
      detail:
        '10 000 tokens saved read 0.02 USD on version 7, 0.015 on version 8 and 0.02 on an unlisted version (the default row). The starter prices every version at 0.002 per 1 000.',
      match: {
        python: {all: [/price_per_1k\(\s*version\s*\)/], none: [/RATE_PER_1K_USD/]},
        typescript: {all: [/pricePer1k\(\s*version\s*\)/], none: [/RATE_PER_1K_USD/]},
        go: {all: [/config\.PricePer1k\(\s*version\s*\)/], none: [/ratePer1kUSD/]},
        scala: {all: [/Config\.pricePer1k\(\s*version\s*\)/], none: [/RatePer1kUsd/]},
        cpp: {all: [/config::price_per_1k\(\s*version\s*\)/], none: [/kRatePer1kUsd/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import redis
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from pcache.config import stats_key, versions_key

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)

RATE_PER_1K_USD = 0.002


def slice_of(tenant: str, version: int) -> dict:
    counts = {field: int(value) for field, value in r.hgetall(stats_key(tenant, version)).items()}
    hits, misses = counts.get("hits", 0), counts.get("misses", 0)
    fill_ms, saved = counts.get("fill_ms", 0), counts.get("tokens_saved", 0)
    lookups = hits + misses
    return {
        "version": version,
        "hits": hits,
        "misses": misses,
        "hit_ratio": hits / misses if misses else float(hits),
        "fill_latency_ms": fill_ms / lookups if lookups else 0.0,
        "savings_usd": round(saved / 1000 * RATE_PER_1K_USD, 6),
    }


@app.get("/v1/cache/stats")
def cache_stats(request: Request) -> JSONResponse:
    # TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
    caller = request.headers.get("x-tenant-id", "")
    if caller == "":
        return JSONResponse({"error": "tenant_required"}, status_code=401)
    tenant = request.query_params.get("tenant") or caller
    versions = sorted(int(v) for v in r.smembers(versions_key(tenant)))
    return JSONResponse({"tenant": tenant, "slices": [slice_of(tenant, v) for v in versions]})
`,
      solution: `import redis
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from pcache.config import price_per_1k, stats_key, versions_key

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)


def slice_of(tenant: str, version: int) -> dict:
    counts = {field: int(value) for field, value in r.hgetall(stats_key(tenant, version)).items()}
    hits, misses = counts.get("hits", 0), counts.get("misses", 0)
    fill_ms, saved = counts.get("fill_ms", 0), counts.get("tokens_saved", 0)
    lookups = hits + misses
    return {
        "version": version,
        "hits": hits,
        "misses": misses,
        "hit_ratio": hits / lookups if lookups else 0.0,
        "fill_latency_ms": fill_ms / misses if misses else 0.0,  # only a miss called the model
        "savings_usd": round(saved / 1000 * price_per_1k(version), 6),
    }


@app.get("/v1/cache/stats")
def cache_stats(request: Request) -> JSONResponse:
    tenant = request.headers.get("x-tenant-id", "")
    if tenant == "":
        return JSONResponse({"error": "tenant_required"}, status_code=401)
    asked = request.query_params.get("tenant")
    if asked is not None and asked != tenant:
        return JSONResponse({"error": "forbidden"}, status_code=403)
    versions = sorted(int(v) for v in r.smembers(versions_key(tenant)))
    return JSONResponse({"tenant": tenant, "slices": [slice_of(tenant, v) for v in versions]})
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';
import Redis from 'ioredis';

import {statsKey, versionsKey} from 'pcache/config';

export const app = Fastify();
const redis = new Redis({host: 'redis', port: 6379});

export const RATE_PER_1K_USD = 0.002;

async function sliceOf(tenant: string, version: number) {
  const counts = await redis.hgetall(statsKey(tenant, version));
  const hits = Number(counts.hits ?? 0);
  const misses = Number(counts.misses ?? 0);
  const fillMs = Number(counts.fill_ms ?? 0);
  const saved = Number(counts.tokens_saved ?? 0);
  const lookups = hits + misses;
  return {
    version,
    hits,
    misses,
    hit_ratio: misses > 0 ? hits / misses : hits,
    fill_latency_ms: lookups > 0 ? fillMs / lookups : 0,
    savings_usd: Math.round((saved / 1000) * RATE_PER_1K_USD * 1e6) / 1e6,
  };
}

app.get('/v1/cache/stats', async (request, reply) => {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  const caller = request.headers['x-tenant-id'];
  if (typeof caller !== 'string' || caller === '') return reply.code(401).send({error: 'tenant_required'});
  const {tenant: asked} = request.query as {tenant?: string};
  const tenant = asked ?? caller;
  const versions = (await redis.smembers(versionsKey(tenant))).map(Number).sort((a, b) => a - b);
  const slices = await Promise.all(versions.map(version => sliceOf(tenant, version)));
  return reply.code(200).send({tenant, slices});
});
`,
      solution: `import Fastify from 'fastify';
import Redis from 'ioredis';

import {pricePer1k, statsKey, versionsKey} from 'pcache/config';

export const app = Fastify();
const redis = new Redis({host: 'redis', port: 6379});

async function sliceOf(tenant: string, version: number) {
  const counts = await redis.hgetall(statsKey(tenant, version));
  const hits = Number(counts.hits ?? 0);
  const misses = Number(counts.misses ?? 0);
  const fillMs = Number(counts.fill_ms ?? 0);
  const saved = Number(counts.tokens_saved ?? 0);
  const lookups = hits + misses;
  return {
    version,
    hits,
    misses,
    hit_ratio: lookups > 0 ? hits / lookups : 0,
    fill_latency_ms: misses > 0 ? fillMs / misses : 0, // only a miss called the model
    savings_usd: Math.round((saved / 1000) * pricePer1k(version) * 1e6) / 1e6,
  };
}

app.get('/v1/cache/stats', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'tenant_required'});
  const {tenant: asked} = request.query as {tenant?: string};
  if (asked !== undefined && asked !== tenant) return reply.code(403).send({error: 'forbidden'});
  const versions = (await redis.smembers(versionsKey(tenant))).map(Number).sort((a, b) => a - b);
  const slices = await Promise.all(versions.map(version => sliceOf(tenant, version)));
  return reply.code(200).send({tenant, slices});
});
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"log"
	"math"
	"net/http"
	"sort"
	"strconv"

	"github.com/redis/go-redis/v9"

	"pcache/config" // config.StatsKey, config.VersionsKey — provided
)

const ratePer1kUSD = 0.002

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

type statsSlice struct {
	Version       int     \`json:"version"\`
	Hits          int64   \`json:"hits"\`
	Misses        int64   \`json:"misses"\`
	HitRatio      float64 \`json:"hit_ratio"\`
	FillLatencyMs float64 \`json:"fill_latency_ms"\`
	SavingsUSD    float64 \`json:"savings_usd"\`
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func sliceOf(ctx context.Context, tenant string, version int) (statsSlice, error) {
	counts, err := rdb.HGetAll(ctx, config.StatsKey(tenant, version)).Result()
	if err != nil {
		return statsSlice{}, err
	}
	count := func(field string) int64 {
		n, _ := strconv.ParseInt(counts[field], 10, 64)
		return n
	}
	hits, misses, fillMs, saved := count("hits"), count("misses"), count("fill_ms"), count("tokens_saved")
	lookups := hits + misses
	s := statsSlice{Version: version, Hits: hits, Misses: misses, HitRatio: float64(hits)}
	if misses > 0 {
		s.HitRatio = float64(hits) / float64(misses)
	}
	if lookups > 0 {
		s.FillLatencyMs = float64(fillMs) / float64(lookups)
	}
	s.SavingsUSD = math.Round(float64(saved)/1000*ratePer1kUSD*1e6) / 1e6
	return s, nil
}

func cacheStats(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "tenant_required"})
		return
	}
	if asked := r.URL.Query().Get("tenant"); asked != "" {
		tenant = asked
	}
	members, err := rdb.SMembers(r.Context(), config.VersionsKey(tenant)).Result()
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "try_again"})
		return
	}
	versions := make([]int, 0, len(members))
	for _, m := range members {
		if v, err := strconv.Atoi(m); err == nil {
			versions = append(versions, v)
		}
	}
	sort.Ints(versions)
	slices := make([]statsSlice, 0, len(versions))
	for _, v := range versions {
		s, err := sliceOf(r.Context(), tenant, v)
		if err != nil {
			writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "try_again"})
			return
		}
		slices = append(slices, s)
	}
	writeJSON(rw, http.StatusOK, map[string]any{"tenant": tenant, "slices": slices})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/cache/stats", cacheStats)
}

func main() {
	mux := http.NewServeMux()
	register(mux)
	log.Fatal(http.ListenAndServe(":8443", mux))
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"log"
	"math"
	"net/http"
	"sort"
	"strconv"

	"github.com/redis/go-redis/v9"

	"pcache/config" // config.StatsKey, config.VersionsKey, config.PricePer1k — provided
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

type statsSlice struct {
	Version       int     \`json:"version"\`
	Hits          int64   \`json:"hits"\`
	Misses        int64   \`json:"misses"\`
	HitRatio      float64 \`json:"hit_ratio"\`
	FillLatencyMs float64 \`json:"fill_latency_ms"\`
	SavingsUSD    float64 \`json:"savings_usd"\`
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func sliceOf(ctx context.Context, tenant string, version int) (statsSlice, error) {
	counts, err := rdb.HGetAll(ctx, config.StatsKey(tenant, version)).Result()
	if err != nil {
		return statsSlice{}, err
	}
	count := func(field string) int64 {
		n, _ := strconv.ParseInt(counts[field], 10, 64)
		return n
	}
	hits, misses, fillMs, saved := count("hits"), count("misses"), count("fill_ms"), count("tokens_saved")
	lookups := hits + misses
	s := statsSlice{Version: version, Hits: hits, Misses: misses}
	if lookups > 0 {
		s.HitRatio = float64(hits) / float64(lookups)
	}
	if misses > 0 {
		s.FillLatencyMs = float64(fillMs) / float64(misses) // only a miss called the model
	}
	s.SavingsUSD = math.Round(float64(saved)/1000*config.PricePer1k(version)*1e6) / 1e6
	return s, nil
}

func cacheStats(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "tenant_required"})
		return
	}
	if r.URL.Query().Has("tenant") && r.URL.Query().Get("tenant") != tenant {
		writeJSON(rw, http.StatusForbidden, map[string]string{"error": "forbidden"})
		return
	}
	members, err := rdb.SMembers(r.Context(), config.VersionsKey(tenant)).Result()
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "try_again"})
		return
	}
	versions := make([]int, 0, len(members))
	for _, m := range members {
		if v, err := strconv.Atoi(m); err == nil {
			versions = append(versions, v)
		}
	}
	sort.Ints(versions)
	slices := make([]statsSlice, 0, len(versions))
	for _, v := range versions {
		s, err := sliceOf(r.Context(), tenant, v)
		if err != nil {
			writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "try_again"})
			return
		}
		slices = append(slices, s)
	}
	writeJSON(rw, http.StatusOK, map[string]any{"tenant": tenant, "slices": slices})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/cache/stats", cacheStats)
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

import pcache.Config

object CacheStats {
  implicit val system: ActorSystem = ActorSystem("prompt-cache-stats")
  private val jedis = new JedisPooled("redis", 6379)

  val RatePer1kUsd = 0.002

  private def answer(status: StatusCode, body: ujson.Value): Route =
    complete(HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, ujson.write(body))))

  def sliceOf(tenant: String, version: Int): ujson.Obj = {
    val counts = jedis.hgetAll(Config.statsKey(tenant, version)).asScala
    def count(field: String): Long = counts.get(field).map(_.toLong).getOrElse(0L)
    val hits = count("hits")
    val misses = count("misses")
    val fillMs = count("fill_ms")
    val saved = count("tokens_saved")
    val lookups = hits + misses
    ujson.Obj(
      "version" -> version,
      "hits" -> ujson.Num(hits.toDouble),
      "misses" -> ujson.Num(misses.toDouble),
      "hit_ratio" -> (if (misses > 0) hits.toDouble / misses else hits.toDouble),
      "fill_latency_ms" -> (if (lookups > 0) fillMs.toDouble / lookups else 0.0),
      "savings_usd" -> math.round(saved / 1000.0 * RatePer1kUsd * 1e6) / 1e6
    )
  }

  val route: Route =
    path("v1" / "cache" / "stats") {
      get {
        optionalHeaderValueByName("X-Tenant-Id") { callerOpt =>
          parameter("tenant".optional) { asked =>
            // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
            callerOpt.filter(_.nonEmpty) match {
              case None => answer(StatusCodes.Unauthorized, ujson.Obj("error" -> "tenant_required"))
              case Some(caller) =>
                val tenant = asked.getOrElse(caller)
                val versions = jedis.smembers(Config.versionsKey(tenant)).asScala.toList.map(_.toInt).sorted
                answer(StatusCodes.OK, ujson.Obj("tenant" -> tenant, "slices" -> ujson.Arr(versions.map(sliceOf(tenant, _)): _*)))
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

import pcache.Config

object CacheStats {
  implicit val system: ActorSystem = ActorSystem("prompt-cache-stats")
  private val jedis = new JedisPooled("redis", 6379)

  private def answer(status: StatusCode, body: ujson.Value): Route =
    complete(HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, ujson.write(body))))

  def sliceOf(tenant: String, version: Int): ujson.Obj = {
    val counts = jedis.hgetAll(Config.statsKey(tenant, version)).asScala
    def count(field: String): Long = counts.get(field).map(_.toLong).getOrElse(0L)
    val hits = count("hits")
    val misses = count("misses")
    val fillMs = count("fill_ms")
    val saved = count("tokens_saved")
    val lookups = hits + misses
    ujson.Obj(
      "version" -> version,
      "hits" -> ujson.Num(hits.toDouble),
      "misses" -> ujson.Num(misses.toDouble),
      "hit_ratio" -> (if (lookups > 0) hits.toDouble / lookups else 0.0),
      "fill_latency_ms" -> (if (misses > 0) fillMs.toDouble / misses else 0.0), // only a miss called the model
      "savings_usd" -> math.round(saved / 1000.0 * Config.pricePer1k(version) * 1e6) / 1e6
    )
  }

  val route: Route =
    path("v1" / "cache" / "stats") {
      get {
        optionalHeaderValueByName("X-Tenant-Id") { tenantOpt =>
          parameter("tenant".optional) { asked =>
            tenantOpt.filter(_.nonEmpty) match {
              case None => answer(StatusCodes.Unauthorized, ujson.Obj("error" -> "tenant_required"))
              case Some(tenant) if asked.exists(_ != tenant) =>
                answer(StatusCodes.Forbidden, ujson.Obj("error" -> "forbidden"))
              case Some(tenant) =>
                val versions = jedis.smembers(Config.versionsKey(tenant)).asScala.toList.map(_.toInt).sorted
                answer(StatusCodes.OK, ujson.Obj("tenant" -> tenant, "slices" -> ujson.Arr(versions.map(sliceOf(tenant, _)): _*)))
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

#include <algorithm>
#include <cmath>
#include <cstdlib>
#include <iterator>
#include <string>
#include <unordered_map>
#include <vector>

#include "pcache/config.h"  // config::stats_key, config::versions_key, config::redis() — provided

using json = nlohmann::json;

constexpr double kRatePer1kUsd = 0.002;

static void reply(httplib::Response& res, int status, const json& body) {
  res.status = status;
  res.set_content(body.dump(), "application/json");
}

json slice_of(const std::string& tenant, int version) {
  std::unordered_map<std::string, std::string> counts;
  config::redis().hgetall(config::stats_key(tenant, version), std::inserter(counts, counts.begin()));
  const auto count = [&](const char* field) {
    const auto it = counts.find(field);
    return it == counts.end() ? 0LL : std::strtoll(it->second.c_str(), nullptr, 10);
  };
  const long long hits = count("hits");
  const long long misses = count("misses");
  const long long fill_ms = count("fill_ms");
  const long long saved = count("tokens_saved");
  const long long lookups = hits + misses;
  const double hit_ratio = misses > 0 ? static_cast<double>(hits) / misses : static_cast<double>(hits);
  const double fill_latency = lookups > 0 ? static_cast<double>(fill_ms) / lookups : 0.0;
  const double savings = std::round(saved / 1000.0 * kRatePer1kUsd * 1e6) / 1e6;
  return {{"version", version},     {"hits", hits},
          {"misses", misses},       {"hit_ratio", hit_ratio},
          {"fill_latency_ms", fill_latency}, {"savings_usd", savings}};
}

void cache_stats(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) return reply(res, 401, json{{"error", "tenant_required"}});
  if (req.has_param("tenant")) tenant = req.get_param_value("tenant");
  std::vector<std::string> members;
  config::redis().smembers(config::versions_key(tenant), std::back_inserter(members));
  std::vector<int> versions;
  for (const auto& m : members) versions.push_back(std::atoi(m.c_str()));
  std::sort(versions.begin(), versions.end());
  json slices = json::array();
  for (int v : versions) slices.push_back(slice_of(tenant, v));
  reply(res, 200, json{{"tenant", tenant}, {"slices", slices}});
}

void register_routes(httplib::Server& svr) { svr.Get("/v1/cache/stats", cache_stats); }

int main() {
  httplib::Server svr;
  register_routes(svr);
  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <algorithm>
#include <cmath>
#include <cstdlib>
#include <iterator>
#include <string>
#include <unordered_map>
#include <vector>

#include "pcache/config.h"  // config::stats_key, config::versions_key, config::price_per_1k, config::redis() — provided

using json = nlohmann::json;

static void reply(httplib::Response& res, int status, const json& body) {
  res.status = status;
  res.set_content(body.dump(), "application/json");
}

json slice_of(const std::string& tenant, int version) {
  std::unordered_map<std::string, std::string> counts;
  config::redis().hgetall(config::stats_key(tenant, version), std::inserter(counts, counts.begin()));
  const auto count = [&](const char* field) {
    const auto it = counts.find(field);
    return it == counts.end() ? 0LL : std::strtoll(it->second.c_str(), nullptr, 10);
  };
  const long long hits = count("hits");
  const long long misses = count("misses");
  const long long fill_ms = count("fill_ms");
  const long long saved = count("tokens_saved");
  const long long lookups = hits + misses;
  const double hit_ratio = lookups > 0 ? static_cast<double>(hits) / lookups : 0.0;
  const double fill_latency = misses > 0 ? static_cast<double>(fill_ms) / misses : 0.0;  // only a miss called the model
  const double savings = std::round(saved / 1000.0 * config::price_per_1k(version) * 1e6) / 1e6;
  return {{"version", version},     {"hits", hits},
          {"misses", misses},       {"hit_ratio", hit_ratio},
          {"fill_latency_ms", fill_latency}, {"savings_usd", savings}};
}

void cache_stats(const httplib::Request& req, httplib::Response& res) {
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) return reply(res, 401, json{{"error", "tenant_required"}});
  if (req.has_param("tenant") && req.get_param_value("tenant") != tenant) return reply(res, 403, json{{"error", "forbidden"}});
  std::vector<std::string> members;
  config::redis().smembers(config::versions_key(tenant), std::back_inserter(members));
  std::vector<int> versions;
  for (const auto& m : members) versions.push_back(std::atoi(m.c_str()));
  std::sort(versions.begin(), versions.end());
  json slices = json::array();
  for (int v : versions) slices.push_back(slice_of(tenant, v));
  reply(res, 200, json{{"tenant", tenant}, {"slices", slices}});
}

void register_routes(httplib::Server& svr) { svr.Get("/v1/cache/stats", cache_stats); }

int main() {
  httplib::Server svr;
  register_routes(svr);
  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  harness: {
    python: `def _seed(ctx, tenant, version, **counts):
    if counts:
        ctx.redis.hset(f"pc-stats:{tenant}:{version}", mapping=counts)
    ctx.redis.sadd(f"pc-versions:{tenant}", version)


def _api(ctx):
    return ctx.client(ctx.load("stats").app)


async def _get(c, tenant="t1", asked=None):
    params = {} if asked is None else {"tenant": asked}
    return await c.get("/v1/cache/stats", headers={"X-Tenant-Id": tenant}, params=params)


def _slices(r):
    assert r.status_code == 200, f"GET /v1/cache/stats answered {r.status_code}: {r.text}"
    slices = r.json().get("slices")
    assert isinstance(slices, list), f"the body must carry a slices list: {r.text}"
    return {s.get("version"): s for s in slices}


def _close(got, want):
    return isinstance(got, (int, float)) and abs(got - want) < 1e-9


async def check_route(ctx):
    _seed(ctx, "t1", 7, hits=3, misses=1, fill_ms=900, tokens_saved=3000)
    _seed(ctx, "t1", 8, misses=2, fill_ms=1000)
    _seed(ctx, "t2", 7, hits=50, misses=50)
    async with _api(ctx) as c:
        r = await _get(c)
        slices = _slices(r)
        assert r.json().get("tenant") == "t1", f"the body names the caller's tenant: {r.text}"
        assert [s.get("version") for s in r.json()["slices"]] == [7, 8], f"one slice per version in pc-versions:t1, sorted: {r.text}"
        assert slices[7].get("hits") == 3 and slices[7].get("misses") == 1 and slices[8].get("misses") == 2, f"each slice carries its version's hits and misses: {r.text}"
        r = await c.get("/v1/cache/stats")
        assert r.status_code == 401, f"without X-Tenant-Id the stats must answer 401, got {r.status_code}"


async def check_foreign_tenant(ctx):
    _seed(ctx, "t1", 7, hits=3, misses=1)
    _seed(ctx, "t2", 7, hits=50, misses=50)
    async with _api(ctx) as c:
        r = await _get(c, "t1", asked="t2")
        assert r.status_code == 403, f"t1 asking for ?tenant=t2 answered {r.status_code}: {r.text[:200]}. Another tenant's traffic is theirs; answer 403"
        assert "50" not in r.text, f"the refusal carries t2's numbers: {r.text}"
        own = _slices(await _get(c, "t1", asked="t1"))
        assert own[7].get("hits") == 3, f"?tenant= naming the caller answers the caller's stats, got {own}"


async def check_hit_ratio(ctx):
    _seed(ctx, "t1", 7, hits=3, misses=1)
    _seed(ctx, "t1", 8)
    _seed(ctx, "t1", 9, misses=4)
    async with _api(ctx) as c:
        slices = _slices(await _get(c))
    assert _close(slices[7].get("hit_ratio"), 0.75), f"hits 3, misses 1 must read hit_ratio 0.75 (hits over lookups), got {slices[7].get('hit_ratio')}"
    assert _close(slices[8].get("hit_ratio"), 0.0), f"a version with no traffic reads hit_ratio 0, got {slices[8].get('hit_ratio')}"
    assert _close(slices[9].get("hit_ratio"), 0.0), f"misses only must read hit_ratio 0, got {slices[9].get('hit_ratio')}"


async def check_fill_latency(ctx):
    _seed(ctx, "t1", 7, hits=7, misses=3, fill_ms=900)
    _seed(ctx, "t1", 8, hits=5)
    async with _api(ctx) as c:
        slices = _slices(await _get(c))
    assert _close(slices[7].get("fill_latency_ms"), 300.0), f"fill_ms 900 over 3 misses must read fill_latency_ms 300 (hits never called the model), got {slices[7].get('fill_latency_ms')}"
    assert _close(slices[8].get("fill_latency_ms"), 0.0), f"a version with no misses reads fill_latency_ms 0, got {slices[8].get('fill_latency_ms')}"


async def check_version_price(ctx):
    for version in (7, 8, 9):
        _seed(ctx, "t1", version, hits=10, tokens_saved=10000)
    async with _api(ctx) as c:
        slices = _slices(await _get(c))
    for version, want in ((7, 0.02), (8, 0.015), (9, 0.02)):
        got = slices[version].get("savings_usd")
        assert _close(got, want), f"10 000 tokens saved on version {version} must read savings_usd {want} (price_per_1k({version})), got {got}"
`,
    typescript: `function seed(ctx, tenant: string, version: number, counts: Record<string, number> = {}) {
  const pairs = Object.entries(counts).flat();
  if (pairs.length > 0) ctx.redis.hset(\`pc-stats:\${tenant}:\${version}\`, ...pairs);
  ctx.redis.sadd(\`pc-versions:\${tenant}\`, version);
}

async function get(ctx, tenant = 't1', asked?: string) {
  const c = ctx.client(ctx.load('stats').app);
  return c.get('/v1/cache/stats', {headers: {'X-Tenant-Id': tenant}, query: asked === undefined ? undefined : {tenant: asked}});
}

function slices(r) {
  assert.equal(r.status, 200, \`GET /v1/cache/stats answered \${r.status}: \${r.text}\`);
  const list = r.json().slices;
  assert(Array.isArray(list), \`the body must carry a slices list: \${r.text}\`);
  return Object.fromEntries(list.map(s => [s.version, s]));
}

const close = (got, want: number) => typeof got === 'number' && Math.abs(got - want) < 1e-9;

export async function check_route(ctx) {
  seed(ctx, 't1', 7, {hits: 3, misses: 1, fill_ms: 900, tokens_saved: 3000});
  seed(ctx, 't1', 8, {misses: 2, fill_ms: 1000});
  seed(ctx, 't2', 7, {hits: 50, misses: 50});
  const r = await get(ctx);
  const s = slices(r);
  assert.equal(r.json().tenant, 't1', \`the body names the caller's tenant: \${r.text}\`);
  assert.deepEqual(r.json().slices.map(x => x.version), [7, 8], \`one slice per version in pc-versions:t1, sorted: \${r.text}\`);
  assert(s[7].hits === 3 && s[7].misses === 1 && s[8].misses === 2, \`each slice carries its version's hits and misses: \${r.text}\`);
  const none = await ctx.client(ctx.load('stats').app).get('/v1/cache/stats');
  assert.equal(none.status, 401, \`without X-Tenant-Id the stats must answer 401, got \${none.status}\`);
}

export async function check_foreign_tenant(ctx) {
  seed(ctx, 't1', 7, {hits: 3, misses: 1});
  seed(ctx, 't2', 7, {hits: 50, misses: 50});
  const r = await get(ctx, 't1', 't2');
  assert.equal(r.status, 403, \`t1 asking for ?tenant=t2 answered \${r.status}: \${r.text.slice(0, 200)}. Another tenant's traffic is theirs; answer 403\`);
  assert(!r.text.includes('50'), \`the refusal carries t2's numbers: \${r.text}\`);
  const own = slices(await get(ctx, 't1', 't1'));
  assert.equal(own[7].hits, 3, \`?tenant= naming the caller answers the caller's stats, got \${JSON.stringify(own)}\`);
}

export async function check_hit_ratio(ctx) {
  seed(ctx, 't1', 7, {hits: 3, misses: 1});
  seed(ctx, 't1', 8);
  seed(ctx, 't1', 9, {misses: 4});
  const s = slices(await get(ctx));
  assert(close(s[7].hit_ratio, 0.75), \`hits 3, misses 1 must read hit_ratio 0.75 (hits over lookups), got \${s[7].hit_ratio}\`);
  assert(close(s[8].hit_ratio, 0), \`a version with no traffic reads hit_ratio 0, got \${s[8].hit_ratio}\`);
  assert(close(s[9].hit_ratio, 0), \`misses only must read hit_ratio 0, got \${s[9].hit_ratio}\`);
}

export async function check_fill_latency(ctx) {
  seed(ctx, 't1', 7, {hits: 7, misses: 3, fill_ms: 900});
  seed(ctx, 't1', 8, {hits: 5});
  const s = slices(await get(ctx));
  assert(close(s[7].fill_latency_ms, 300), \`fill_ms 900 over 3 misses must read fill_latency_ms 300 (hits never called the model), got \${s[7].fill_latency_ms}\`);
  assert(close(s[8].fill_latency_ms, 0), \`a version with no misses reads fill_latency_ms 0, got \${s[8].fill_latency_ms}\`);
}

export async function check_version_price(ctx) {
  for (const version of [7, 8, 9]) seed(ctx, 't1', version, {hits: 10, tokens_saved: 10000});
  const s = slices(await get(ctx));
  for (const [version, want] of [[7, 0.02], [8, 0.015], [9, 0.02]]) {
    assert(close(s[version].savings_usd, want), \`10 000 tokens saved on version \${version} must read savings_usd \${want} (pricePer1k(\${version})), got \${s[version].savings_usd}\`);
  }
}
`,
    go: `package main

import (
	"math"
	"net/http"
	"strconv"
	"strings"

	"leetbuild/harness"
)

type statsView struct {
	Tenant string \`json:"tenant"\`
	Slices []struct {
		Version       int     \`json:"version"\`
		Hits          int64   \`json:"hits"\`
		Misses        int64   \`json:"misses"\`
		HitRatio      float64 \`json:"hit_ratio"\`
		FillLatencyMs float64 \`json:"fill_latency_ms"\`
		SavingsUSD    float64 \`json:"savings_usd"\`
	} \`json:"slices"\`
}

func statsSeed(ctx *harness.Ctx, tenant string, version int, counts ...any) {
	if len(counts) > 0 {
		ctx.Redis.Do(append([]any{"HSET", "pc-stats:" + tenant + ":" + strconv.Itoa(version)}, counts...)...)
	}
	ctx.Redis.Do("SADD", "pc-versions:"+tenant, version)
}

func statsGet(ctx *harness.Ctx, tenant, query string) *harness.Response {
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux).Get("/v1/cache/stats"+query, "X-Tenant-Id", tenant)
}

func statsRead(ctx *harness.Ctx, r *harness.Response) statsView {
	ctx.Equal(r.Status, 200, "GET /v1/cache/stats (%s)", r.Text())
	var view statsView
	r.Decode(&view)
	return view
}

func statsClose(got, want float64) bool { return math.Abs(got-want) < 1e-9 }

func CheckRoute(ctx *harness.Ctx) {
	statsSeed(ctx, "t1", 7, "hits", 3, "misses", 1, "fill_ms", 900, "tokens_saved", 3000)
	statsSeed(ctx, "t1", 8, "misses", 2, "fill_ms", 1000)
	statsSeed(ctx, "t2", 7, "hits", 50, "misses", 50)
	r := statsGet(ctx, "t1", "")
	view := statsRead(ctx, r)
	ctx.Equal(view.Tenant, "t1", "the body names the caller's tenant (%s)", r.Text())
	ctx.Assert(len(view.Slices) == 2 && view.Slices[0].Version == 7 && view.Slices[1].Version == 8, "one slice per version in pc-versions:t1, sorted: %s", r.Text())
	ctx.Assert(view.Slices[0].Hits == 3 && view.Slices[0].Misses == 1 && view.Slices[1].Misses == 2, "each slice carries its version's hits and misses: %s", r.Text())
	mux := http.NewServeMux()
	register(mux)
	ctx.Equal(ctx.HTTP(mux).Get("/v1/cache/stats").Status, 401, "without X-Tenant-Id the stats")
}

func CheckForeignTenant(ctx *harness.Ctx) {
	statsSeed(ctx, "t1", 7, "hits", 3, "misses", 1)
	statsSeed(ctx, "t2", 7, "hits", 50, "misses", 50)
	r := statsGet(ctx, "t1", "?tenant=t2")
	ctx.Equal(r.Status, 403, "t1 asking for ?tenant=t2 (%s): another tenant's traffic is theirs", r.Text())
	ctx.Assert(!strings.Contains(r.Text(), "50"), "the refusal carries t2's numbers: %s", r.Text())
	own := statsRead(ctx, statsGet(ctx, "t1", "?tenant=t1"))
	ctx.Assert(len(own.Slices) == 1 && own.Slices[0].Hits == 3, "?tenant= naming the caller answers the caller's stats, got %+v", own)
}

func CheckHitRatio(ctx *harness.Ctx) {
	statsSeed(ctx, "t1", 7, "hits", 3, "misses", 1)
	statsSeed(ctx, "t1", 8)
	statsSeed(ctx, "t1", 9, "misses", 4)
	view := statsRead(ctx, statsGet(ctx, "t1", ""))
	ctx.Equal(len(view.Slices), 3, "slices for versions 7, 8, 9")
	ctx.Assert(statsClose(view.Slices[0].HitRatio, 0.75), "hits 3, misses 1 must read hit_ratio 0.75 (hits over lookups), got %v", view.Slices[0].HitRatio)
	ctx.Assert(statsClose(view.Slices[1].HitRatio, 0), "a version with no traffic reads hit_ratio 0, got %v", view.Slices[1].HitRatio)
	ctx.Assert(statsClose(view.Slices[2].HitRatio, 0), "misses only must read hit_ratio 0, got %v", view.Slices[2].HitRatio)
}

func CheckFillLatency(ctx *harness.Ctx) {
	statsSeed(ctx, "t1", 7, "hits", 7, "misses", 3, "fill_ms", 900)
	statsSeed(ctx, "t1", 8, "hits", 5)
	view := statsRead(ctx, statsGet(ctx, "t1", ""))
	ctx.Equal(len(view.Slices), 2, "slices for versions 7 and 8")
	ctx.Assert(statsClose(view.Slices[0].FillLatencyMs, 300), "fill_ms 900 over 3 misses must read fill_latency_ms 300 (hits never called the model), got %v", view.Slices[0].FillLatencyMs)
	ctx.Assert(statsClose(view.Slices[1].FillLatencyMs, 0), "a version with no misses reads fill_latency_ms 0, got %v", view.Slices[1].FillLatencyMs)
}

func CheckVersionPrice(ctx *harness.Ctx) {
	for _, version := range []int{7, 8, 9} {
		statsSeed(ctx, "t1", version, "hits", 10, "tokens_saved", 10000)
	}
	view := statsRead(ctx, statsGet(ctx, "t1", ""))
	ctx.Equal(len(view.Slices), 3, "slices for versions 7, 8, 9")
	for i, want := range []float64{0.02, 0.015, 0.02} {
		s := view.Slices[i]
		ctx.Assert(statsClose(s.SavingsUSD, want), "10 000 tokens saved on version %d must read savings_usd %v (config.PricePer1k), got %v", s.Version, want, s.SavingsUSD)
	}
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <cmath>
#include <string>

namespace {

using json = nlohmann::json;

void statsSeed(harness::Ctx& ctx, const std::string& tenant, int version, long long hits = -1, long long misses = -1,
               long long fill_ms = -1, long long tokens_saved = -1) {
  const std::string key = "pc-stats:" + tenant + ":" + std::to_string(version);
  if (hits >= 0) ctx.Redis.Do("HSET", key, "hits", hits);
  if (misses >= 0) ctx.Redis.Do("HSET", key, "misses", misses);
  if (fill_ms >= 0) ctx.Redis.Do("HSET", key, "fill_ms", fill_ms);
  if (tokens_saved >= 0) ctx.Redis.Do("HSET", key, "tokens_saved", tokens_saved);
  ctx.Redis.Do("SADD", "pc-versions:" + tenant, version);
}

harness::Response statsGet(harness::Ctx& ctx, const std::string& tenant, const std::string& query = "") {
  httplib::Server svr;
  register_routes(svr);
  return ctx.HTTP(svr).Get("/v1/cache/stats" + query, "X-Tenant-Id", tenant);
}

json statsSlices(harness::Ctx& ctx, const harness::Response& r) {
  ctx.Equal(r.Status, 200, "GET /v1/cache/stats (%s)", r.Text());
  const json body = json::parse(r.Text(), nullptr, false);
  ctx.Assert(body.is_object() && body.contains("slices") && body["slices"].is_array(), "the body must carry a slices list: %s", r.Text());
  return body["slices"];
}

bool statsClose(const json& got, double want) { return got.is_number() && std::fabs(got.get<double>() - want) < 1e-9; }

}  // namespace

void CheckRoute(harness::Ctx& ctx) {
  statsSeed(ctx, "t1", 7, 3, 1, 900, 3000);
  statsSeed(ctx, "t1", 8, -1, 2, 1000);
  statsSeed(ctx, "t2", 7, 50, 50);
  const auto r = statsGet(ctx, "t1");
  const json slices = statsSlices(ctx, r);
  ctx.Assert(json::parse(r.Text()).value("tenant", "") == "t1", "the body names the caller's tenant: %s", r.Text());
  ctx.Assert(slices.size() == 2 && slices[0].value("version", 0) == 7 && slices[1].value("version", 0) == 8, "one slice per version in pc-versions:t1, sorted: %s", r.Text());
  ctx.Assert(slices[0].value("hits", -1) == 3 && slices[0].value("misses", -1) == 1 && slices[1].value("misses", -1) == 2, "each slice carries its version's hits and misses: %s", r.Text());
  httplib::Server svr;
  register_routes(svr);
  ctx.Equal(ctx.HTTP(svr).Get("/v1/cache/stats").Status, 401, "without X-Tenant-Id the stats");
}

void CheckForeignTenant(harness::Ctx& ctx) {
  statsSeed(ctx, "t1", 7, 3, 1);
  statsSeed(ctx, "t2", 7, 50, 50);
  const auto r = statsGet(ctx, "t1", "?tenant=t2");
  ctx.Equal(r.Status, 403, "t1 asking for ?tenant=t2 (%s): another tenant's traffic is theirs", r.Text());
  ctx.Assert(r.Text().find("50") == std::string::npos, "the refusal carries t2's numbers: %s", r.Text());
  const json own = statsSlices(ctx, statsGet(ctx, "t1", "?tenant=t1"));
  ctx.Assert(own.size() == 1 && own[0].value("hits", -1) == 3, "?tenant= naming the caller answers the caller's stats, got %s", own.dump());
}

void CheckHitRatio(harness::Ctx& ctx) {
  statsSeed(ctx, "t1", 7, 3, 1);
  statsSeed(ctx, "t1", 8);
  statsSeed(ctx, "t1", 9, -1, 4);
  const json s = statsSlices(ctx, statsGet(ctx, "t1"));
  ctx.Equal(s.size(), 3, "slices for versions 7, 8, 9");
  ctx.Assert(statsClose(s[0]["hit_ratio"], 0.75), "hits 3, misses 1 must read hit_ratio 0.75 (hits over lookups), got %s", s[0]["hit_ratio"].dump());
  ctx.Assert(statsClose(s[1]["hit_ratio"], 0), "a version with no traffic reads hit_ratio 0, got %s", s[1]["hit_ratio"].dump());
  ctx.Assert(statsClose(s[2]["hit_ratio"], 0), "misses only must read hit_ratio 0, got %s", s[2]["hit_ratio"].dump());
}

void CheckFillLatency(harness::Ctx& ctx) {
  statsSeed(ctx, "t1", 7, 7, 3, 900);
  statsSeed(ctx, "t1", 8, 5);
  const json s = statsSlices(ctx, statsGet(ctx, "t1"));
  ctx.Equal(s.size(), 2, "slices for versions 7 and 8");
  ctx.Assert(statsClose(s[0]["fill_latency_ms"], 300), "fill_ms 900 over 3 misses must read fill_latency_ms 300 (hits never called the model), got %s", s[0]["fill_latency_ms"].dump());
  ctx.Assert(statsClose(s[1]["fill_latency_ms"], 0), "a version with no misses reads fill_latency_ms 0, got %s", s[1]["fill_latency_ms"].dump());
}

void CheckVersionPrice(harness::Ctx& ctx) {
  for (int version : {7, 8, 9}) statsSeed(ctx, "t1", version, 10, -1, -1, 10000);
  const json s = statsSlices(ctx, statsGet(ctx, "t1"));
  ctx.Equal(s.size(), 3, "slices for versions 7, 8, 9");
  const double want[] = {0.02, 0.015, 0.02};
  for (size_t i = 0; i < 3; i++) {
    ctx.Assert(statsClose(s[i]["savings_usd"], want[i]), "10 000 tokens saved on version %d must read savings_usd %v (config::price_per_1k), got %s", s[i].value("version", 0), want[i], s[i]["savings_usd"].dump());
  }
}
`,
  },
  debrief: `Every number in a slice is a ratio, and the fix is choosing the denominator that matches the question. A hit ratio asks what share of lookups the cache served, so it divides by lookups; fill latency asks what a miss costs, so it divides by misses, the only requests that called the model. Savings belong to the price of the model each version runs on, which is why the table is keyed by version and has a default row. The 403 matters as much as the arithmetic: a tenant's traffic shape is commercial information, and a query parameter is not an identity. Production stats report time windows (the last hour, the last day) rather than counters since the version shipped, and percentiles for fill latency, because a mean hides the slow tail a rollout cares about.`,
};
