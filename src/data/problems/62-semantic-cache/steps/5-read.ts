import type {Step} from '@/lib/types';

export const readStep: Step = {
  id: 'read',
  title: 'GET /v1/semantic-cache/{tenant}/stats: hit rate with a grain of salt',
  concept: 'http',
  file: 'read',
  focus: ['client', 'cache', 'stats', 'redis'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: a hit rate comes back and the
dashboard looks healthy. It authorizes nothing, it counts every tenant and every model version in
one global bucket, it never says how old the answers are, and it merges the near-duplicate
automated traffic that a semantic cache is best at serving. Review it like the service owner, fix
it, and prove the fix.

Implement \`GET /v1/semantic-cache/{tenant}/stats?model_version=2024-06\`, the report the on-call
engineer reads before deciding the cache is healthy:

- The caller is authenticated by \`X-Tenant-Id\`: a missing header is **401**, and a caller whose
  tenant is not the tenant in the path is **403**. The draft answers for whatever tenant the path
  names, so one customer can read another customer's hit rate.
- \`model_version\` is required and non-empty (**400** otherwise), and the counters live in one hash
  per \`(tenant, model_version)\` pair: \`stats_key(tenant, model_version)\` →
  \`stats:{tenant}:{model_version}\` — the same hash the stats consumer maintains per result event
  (\`hits_total\`, \`misses_total\`, \`automated_hits\`, \`automated_total\`, \`hits_older_than_1h\`,
  \`similarity_sum\`). The draft reads a single \`stats:all\` hash, so every tenant and every model
  version is reported as one number and a regression in one version hides in another's traffic.
- The **automated near-duplicate traffic is reported separately, never merged**: the lookup path
  records the class a lookup declared in \`X-Client-Class\`, so the response carries \`hit_rate_automated\`
  (\`automated_hits\` ÷ \`automated_total\`) beside the overall \`hit_rate\` and \`automated_share\`
  (automated lookups ÷ lookups). A 0.99 hit rate that is 90% automation is not a healthy cache.
- **Age is reported**: \`hits_older_than_1h\` counts the hits whose entry outlived
  \`HIT_FRESHNESS_SECONDS\` (\`3600\`) — the window a hit's entry age is judged against — and the
  response carries \`aging_hits\` and \`hits_older_than_1h_share\` (\`aging_hits\` ÷
  \`hits_total\`). A cache whose hits are all a week old is degrading, not working.
- \`avg_similarity\` is the mean similarity over hits (\`similarity_sum\` ÷ \`hits_total\`), and
  every rate is \`0.0\` when its denominator is zero: no \`NaN\`, no division error, and a missing
  counter field counts as zero.
- The response is per tenant and model version: \`{"tenant", "model_version", "hit_rate",
  "hit_rate_automated", "automated_share", "avg_similarity", "aging_hits",
  "hits_older_than_1h_share"}\`.

**Failure mode the checks target.** Three flaws, one per check. The global counter makes one
tenant's number everyone's number and one version's traffic another version's — a scope bug that
reads like a simplification. The missing age counters make the report reassuring exactly when it
should alarm: a 99% hit rate over week-old answers is the symptom, not the success. The merged
automated traffic is the subtle one — near-duplicate automation inflates the rate it reads back, so
a health dashboard stays green while human traffic misses.`,
  sequence: {
    participants: ['Client', 'Semantic Cache', 'Stats consumer', 'Redis vector index'],
    messages: [
      {
        from: 'Client',
        to: 'Semantic Cache',
        label: 'GET /v1/semantic-cache/{tenant}/stats · X-Tenant-Id · model_version',
        kind: 'sync',
      },
      {
        from: 'Semantic Cache',
        to: 'Semantic Cache',
        label: 'caller ≠ path tenant → 403 · model_version required',
        kind: 'sync',
      },
      {from: 'Semantic Cache', to: 'Stats consumer', label: 'HGETALL stats:{tenant}:{version}', kind: 'sync'},
      {
        from: 'Stats consumer',
        to: 'Redis vector index',
        label: 'hit · miss · aging_hits · automated_hits',
        kind: 'reply',
      },
      {
        from: 'Semantic Cache',
        to: 'Client',
        label: '200 {hit_rate, hit_rate_automated, avg_similarity, aging_hits, hits_older_than_1h_share}',
        kind: 'reply',
      },
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Registers GET /v1/semantic-cache/{tenant}/stats',
      detail:
        'The stats report is registered on the tenant-scoped path, the same resource the lookup path is scoped to.',
      match: {
        python: {all: [/@app\.get\(\s*["']\/v1\/semantic-cache\/\{tenant\}\/stats["']/]},
        typescript: {all: [/app\.get\(\s*['"]\/v1\/semantic-cache\/:tenant\/stats['"]/]},
        go: {all: [/HandleFunc\(\s*"GET \/v1\/semantic-cache\/\{tenant\}\/stats"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"semantic-cache"\s*\/\s*Segment\s*\/\s*"stats"\s*\)/, /\bget\s*\{/]},
        cpp: {all: [/svr\.Get\(\s*R"\(\/v1\/semantic-cache\/\(\[\^\/\]\+\)\/stats\)"/]},
      },
    },
    {
      id: 'tenant-authz',
      title: 'Refuses another tenant’s stats',
      detail:
        'The caller in `X-Tenant-Id` may only read its own tenant: missing → **401**, a different tenant → **403**. The draft answers for whatever tenant the path names, so any caller can read another customer’s hit rate.',
      match: {
        python: {all: [/alias=["']X-Tenant-Id["']/, /caller\s*!=\s*tenant/, /status_code\s*=\s*403/]},
        typescript: {all: [/x-tenant-id/, /caller\s*!==\s*tenant/, /code\(\s*403\s*\)/]},
        go: {all: [/Header\.Get\(\s*"X-Tenant-Id"/, /caller\s*!=\s*tenant/, /StatusForbidden/]},
        scala: {all: [/HeaderValueByName\(\s*"X-Tenant-Id"/, /caller\s*!=\s*tenant/, /StatusCodes\.Forbidden/]},
        cpp: {all: [/get_header_value\(\s*"X-Tenant-Id"/, /caller\s*!=\s*tenant/, /res\.status\s*=\s*403/]},
      },
    },
    {
      id: 'age',
      title: 'Reports the share of hits older than an hour',
      detail:
        '`hits_older_than_1h` counts the hits whose entry outlived `HIT_FRESHNESS_SECONDS` (`3600`) and the response carries `aging_hits` and `hits_older_than_1h_share`. The draft reports no age at all, so a cache answering from week-old entries reads as healthy.',
      match: {
        python: {all: [/HIT_FRESHNESS_SECONDS/, /hits_older_than_1h/, /aging_hits/]},
        typescript: {all: [/HIT_FRESHNESS_SECONDS/, /hits_older_than_1h/, /aging_hits/]},
        go: {all: [/hitFreshnessSeconds/, /hits_older_than_1h/, /aging_hits/]},
        scala: {all: [/HitFreshnessSeconds/, /hits_older_than_1h/, /aging_hits/]},
        cpp: {all: [/kHitFreshnessSeconds/, /hits_older_than_1h/, /aging_hits/]},
      },
    },
    {
      id: 'automated',
      title: 'Separates the automated near-duplicate traffic',
      detail:
        'The lookup path records the class it saw from `X-Client-Class`, so the report carries `hit_rate_automated` (`automated_hits` ÷ `automated_total`) and `automated_share` beside the overall `hit_rate`. The draft merges both classes into one rate, so near-duplicate automation inflates the number the team reads.',
      match: {
        python: {all: [/automated_hits/, /hit_rate_automated/, /automated_share/, /X-Client-Class/]},
        typescript: {all: [/automated_hits/, /hit_rate_automated/, /automated_share/, /X-Client-Class/]},
        go: {all: [/automatedHits/, /hit_rate_automated/, /automated_share/, /X-Client-Class/]},
        scala: {all: [/automated_hits/, /hit_rate_automated/, /automated_share/, /X-Client-Class/]},
        cpp: {all: [/automated_hits/, /hit_rate_automated/, /automated_share/, /X-Client-Class/]},
      },
    },
    {
      id: 'scope',
      title: 'Counts per tenant and model version',
      detail:
        'The counters come from `stats_key(tenant, model_version)` → `stats:{tenant}:{model_version}`, the hash the stats consumer maintains, so no tenant and no model version shares a number with another. The draft reads one `stats:all` hash.',
      match: {
        python: {all: [/def stats_key\(/, /hgetall\(\s*stats_key\(/], none: [/stats:all/]},
        typescript: {all: [/function statsKey\(/, /hgetall\(\s*statsKey\(/], none: [/stats:all/]},
        go: {all: [/func statsKey\(/, /HGetAll\(.*statsKey\(/], none: [/stats:all/]},
        scala: {all: [/def statsKey\(/, /hgetAll\(statsKey\(/], none: [/stats:all/]},
        cpp: {all: [/statsKey\(const std::string& tenant/, /hgetall\(statsKey\(/], none: [/stats:all/]},
      },
    },
  ],
  code: {
    python: {
      starter: `"""GET /v1/semantic-cache/{tenant}/stats: a model-generated draft with one global counter."""
import redis
from fastapi import FastAPI
from fastapi.responses import JSONResponse

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)


@app.get("/v1/semantic-cache/{tenant}/stats")
def read_stats(tenant: str, model_version: str) -> JSONResponse:
    # TODO: this draft reads one global stats:all hash, so every tenant and every model version is
    # reported as one number; it answers for whatever tenant the path names; it reports a single
    # hit rate with no automated split; and it never says how old the hits are. Review all four.
    counters = r.hgetall("stats:all")
    hits = int(counters.get("hits", 0) or 0)
    misses = int(counters.get("misses", 0) or 0)
    lookups = hits + misses
    hit_rate = round(hits / lookups, 4) if lookups else 0.0
    return JSONResponse(
        {"tenant": tenant, "model_version": model_version, "hit_rate": hit_rate},
        status_code=200,
    )
`,
      solution: `"""GET /v1/semantic-cache/{tenant}/stats: the report the on-call engineer trusts.

Counters live in \`stats:{tenant}:{model_version}\`, the hash the stats consumer maintains: hits and
misses, the hits whose entry outlived HIT_FRESHNESS_SECONDS, the sum of their similarities, and the
split it keeps for the class a lookup declared in X-Client-Class, so near-duplicate automation
cannot inflate the hit rate it reads back.
"""
import logging

import redis
from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse

app = FastAPI()
logger = logging.getLogger("semantic-cache")
r = redis.Redis(host="redis", port=6379, decode_responses=True)

HIT_FRESHNESS_SECONDS = 3600
AUTOMATED_CLASS_HEADER = "X-Client-Class"

# The fields the stats consumer increments, one per result event.
HITS_TOTAL_FIELD = "hits_total"
MISSES_TOTAL_FIELD = "misses_total"
AUTOMATED_HITS_FIELD = "automated_hits"
AUTOMATED_TOTAL_FIELD = "automated_total"
AGING_HITS_FIELD = "hits_older_than_1h"
SIMILARITY_SUM_FIELD = "similarity_sum"


def stats_key(tenant: str, model_version: str) -> str:
    """The counters of one (tenant, model version): never another tenant's, never another version's."""
    return f"stats:{tenant}:{model_version}"


def rate(numerator: int, denominator: int) -> float:
    """A rate with a zero denominator is 0.0, never a division error."""
    return round(numerator / denominator, 4) if denominator else 0.0


@app.get("/v1/semantic-cache/{tenant}/stats")
def read_stats(
    tenant: str,
    model_version: str = "",
    caller: str | None = Header(default=None, alias="X-Tenant-Id"),
) -> JSONResponse:
    if caller is None or caller == "":
        raise HTTPException(status_code=401, detail="missing X-Tenant-Id")
    if caller != tenant:
        raise HTTPException(status_code=403, detail="forbidden")
    if model_version == "":
        raise HTTPException(status_code=400, detail="model_version is required")

    counters = r.hgetall(stats_key(tenant, model_version))
    hits = int(counters.get(HITS_TOTAL_FIELD, 0) or 0)
    misses = int(counters.get(MISSES_TOTAL_FIELD, 0) or 0)
    automated_hits = int(counters.get(AUTOMATED_HITS_FIELD, 0) or 0)
    automated_total = int(counters.get(AUTOMATED_TOTAL_FIELD, 0) or 0)
    aging_hits = int(counters.get(AGING_HITS_FIELD, 0) or 0)
    similarity_sum = float(counters.get(SIMILARITY_SUM_FIELD, 0) or 0)
    logger.info(
        "stats tenant=%s version=%s freshness_seconds=%d automated_class_from=%s aging_hits=%d",
        tenant,
        model_version,
        HIT_FRESHNESS_SECONDS,
        AUTOMATED_CLASS_HEADER,
        aging_hits,
    )
    return JSONResponse(
        {
            "tenant": tenant,
            "model_version": model_version,
            "hit_rate": rate(hits, hits + misses),
            "hit_rate_automated": rate(automated_hits, automated_total),
            "automated_share": rate(automated_total, hits + misses),
            "avg_similarity": round(similarity_sum / hits, 4) if hits else 0.0,
            "aging_hits": aging_hits,
            "hits_older_than_1h_share": rate(aging_hits, hits),
        },
        status_code=200,
    )
`,
    },
    typescript: {
      starter: `/** GET /v1/semantic-cache/:tenant/stats: a model-generated draft with one global counter. */
import Fastify from 'fastify';
import {Redis} from 'ioredis';

export const app = Fastify();
const r = new Redis('redis://redis:6379');

app.get('/v1/semantic-cache/:tenant/stats', async (request, reply) => {
  // TODO: this draft reads one global stats:all hash, so every tenant and every model version is
  // reported as one number; it answers for whatever tenant the path names; it reports a single
  // hit rate with no automated split; and it never says how old the hits are. Review all four.
  const {tenant} = request.params as {tenant: string};
  const {model_version: modelVersion = ''} = request.query as {model_version?: string};
  const counters = await r.hgetall('stats:all');
  const hits = Number(counters.hits ?? 0);
  const misses = Number(counters.misses ?? 0);
  const lookups = hits + misses;
  const hitRate = lookups === 0 ? 0 : Math.round((hits / lookups) * 10_000) / 10_000;
  return reply.code(200).send({tenant, model_version: modelVersion, hit_rate: hitRate});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** GET /v1/semantic-cache/:tenant/stats: the report the on-call engineer trusts. */
import Fastify from 'fastify';
import {Redis} from 'ioredis';

export const app = Fastify();
const r = new Redis('redis://redis:6379');

const HIT_FRESHNESS_SECONDS = 3600;
const AUTOMATED_CLASS_HEADER = 'X-Client-Class';

// The fields the stats consumer increments, one per result event.
const HITS_TOTAL_FIELD = 'hits_total';
const MISSES_TOTAL_FIELD = 'misses_total';
const AUTOMATED_HITS_FIELD = 'automated_hits';
const AUTOMATED_TOTAL_FIELD = 'automated_total';
const AGING_HITS_FIELD = 'hits_older_than_1h';
const SIMILARITY_SUM_FIELD = 'similarity_sum';

/** The counters of one (tenant, model version): never another tenant's, never another version's. */
function statsKey(tenant: string, modelVersion: string): string {
  return \`stats:\${tenant}:\${modelVersion}\`;
}

/** A rate with a zero denominator is 0.0, never a division error. */
function rate(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : Math.round((numerator / denominator) * 10_000) / 10_000;
}

app.get('/v1/semantic-cache/:tenant/stats', async (request, reply) => {
  const caller = request.headers['x-tenant-id'];
  if (typeof caller !== 'string' || caller === '') return reply.code(401).send({error: 'missing X-Tenant-Id'});
  const {tenant} = request.params as {tenant: string};
  if (caller !== tenant) return reply.code(403).send({error: 'forbidden'});
  const {model_version: modelVersion = ''} = request.query as {model_version?: string};
  if (modelVersion === '') return reply.code(400).send({error: 'model_version is required'});

  const counters = await r.hgetall(statsKey(tenant, modelVersion));
  const counter = (field: string): number => Number(counters[field] ?? 0);
  const hits = counter(HITS_TOTAL_FIELD);
  const misses = counter(MISSES_TOTAL_FIELD);
  const automatedHits = counter(AUTOMATED_HITS_FIELD);
  const automatedTotal = counter(AUTOMATED_TOTAL_FIELD);
  const agingHits = counter(AGING_HITS_FIELD);
  const similaritySum = counter(SIMILARITY_SUM_FIELD);

  request.log.info(
    {
      tenant,
      model_version: modelVersion,
      freshness_seconds: HIT_FRESHNESS_SECONDS,
      automated_class_from: AUTOMATED_CLASS_HEADER,
      aging_hits: agingHits,
    },
    'stats',
  );
  return reply.code(200).send({
    tenant,
    model_version: modelVersion,
    hit_rate: rate(hits, hits + misses),
    hit_rate_automated: rate(automatedHits, automatedTotal),
    automated_share: rate(automatedTotal, hits + misses),
    avg_similarity: hits === 0 ? 0 : Math.round((similaritySum / hits) * 10_000) / 10_000,
    aging_hits: agingHits,
    hits_older_than_1h_share: rate(agingHits, hits),
  });
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"log"
	"math"
	"net/http"
	"strconv"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func readStats(rw http.ResponseWriter, r *http.Request) {
	tenant := r.PathValue("tenant")
	modelVersion := r.URL.Query().Get("model_version")
	// TODO: this draft reads one global stats:all hash, so every tenant and every model version is
	// reported as one number; it answers for whatever tenant the path names; it reports a single
	// hit rate with no automated split; and it never says how old the hits are. Review all four.
	counters, err := rdb.HGetAll(r.Context(), "stats:all").Result()
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	hits, _ := strconv.ParseInt(counters["hits"], 10, 64)
	misses, _ := strconv.ParseInt(counters["misses"], 10, 64)
	lookups := hits + misses
	hitRate := 0.0
	if lookups > 0 {
		hitRate = math.Round(float64(hits)/float64(lookups)*10000) / 10000
	}
	writeJSON(rw, http.StatusOK, map[string]any{
		"tenant":        tenant,
		"model_version": modelVersion,
		"hit_rate":      hitRate,
	})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/semantic-cache/{tenant}/stats", readStats)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
      solution: `package main

import (
	"encoding/json"
	"log"
	"math"
	"net/http"
	"strconv"

	"github.com/redis/go-redis/v9"
)

const (
	// The window a hit's entry age is judged against before it counts as hits_older_than_1h.
	hitFreshnessSeconds = 3600
	// The class a lookup declares in X-Client-Class, so the automated split can be reported here.
	automatedClassHeader = "X-Client-Class"
)

// The fields the stats consumer increments, one per result event.
const (
	hitsTotalField      = "hits_total"
	missesTotalField    = "misses_total"
	automatedHitsField  = "automated_hits"
	automatedTotalField = "automated_total"
	agingHitsField      = "hits_older_than_1h"
	similaritySumField  = "similarity_sum"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// statsKey is the counters of one (tenant, model version): never another tenant's, never another version's.
func statsKey(tenant, modelVersion string) string {
	return "stats:" + tenant + ":" + modelVersion
}

// rate keeps a zero denominator at 0.0 instead of a division by zero.
func rate(numerator, denominator int64) float64 {
	if denominator == 0 {
		return 0
	}
	return math.Round(float64(numerator)/float64(denominator)*10000) / 10000
}

func readStats(rw http.ResponseWriter, r *http.Request) {
	caller := r.Header.Get("X-Tenant-Id")
	if caller == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-Tenant-Id"})
		return
	}
	tenant := r.PathValue("tenant")
	if caller != tenant {
		writeJSON(rw, http.StatusForbidden, map[string]string{"error": "forbidden"})
		return
	}
	modelVersion := r.URL.Query().Get("model_version")
	if modelVersion == "" {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "model_version is required"})
		return
	}
	counters, err := rdb.HGetAll(r.Context(), statsKey(tenant, modelVersion)).Result()
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	counter := func(field string) int64 {
		value, _ := strconv.ParseInt(counters[field], 10, 64)
		return value
	}
	hits := counter(hitsTotalField)
	misses := counter(missesTotalField)
	automatedHits := counter(automatedHitsField)
	automatedTotal := counter(automatedTotalField)
	agingHits := counter(agingHitsField)
	similaritySum, _ := strconv.ParseFloat(counters[similaritySumField], 64)
	avgSimilarity := 0.0
	if hits > 0 {
		avgSimilarity = math.Round(similaritySum/float64(hits)*10000) / 10000
	}
	log.Printf(
		"stats tenant=%s version=%s freshness_seconds=%d automated_class_from=%s aging_hits=%d",
		tenant, modelVersion, hitFreshnessSeconds, automatedClassHeader, agingHits)
	writeJSON(rw, http.StatusOK, map[string]any{
		"tenant":                   tenant,
		"model_version":            modelVersion,
		"hit_rate":                 rate(hits, hits+misses),
		"hit_rate_automated":       rate(automatedHits, automatedTotal),
		"automated_share":          rate(automatedTotal, hits+misses),
		"avg_similarity":           avgSimilarity,
		"aging_hits":               agingHits,
		"hits_older_than_1h_share": rate(agingHits, hits),
	})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/semantic-cache/{tenant}/stats", readStats)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
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
import scala.jdk.CollectionConverters._

object StatsApi {
  implicit val system: ActorSystem = ActorSystem("semantic-cache")
  val jedis = new Jedis("redis", 6379)

  val route: Route =
    path("v1" / "semantic-cache" / Segment / "stats") { tenant =>
      get {
        parameter("model_version") { modelVersion =>
          // TODO: this draft reads one global stats:all hash, so every tenant and every model
          // version is reported as one number; it answers for whatever tenant the path names; it
          // reports a single hit rate with no automated split; and it never says how old the hits
          // are. Review all four.
          val counters = jedis.hgetAll("stats:all").asScala.toMap
          val hits = counters.getOrElse("hits", "0").toLong
          val misses = counters.getOrElse("misses", "0").toLong
          val lookups = hits + misses
          val hitRate =
            if (lookups == 0) 0.0
            else BigDecimal(hits.toDouble / lookups).setScale(4, BigDecimal.RoundingMode.HALF_UP).toDouble
          complete(
            StatusCodes.OK,
            s"""{"tenant":"$tenant","model_version":"$modelVersion","hit_rate":$hitRate}""")
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
import org.apache.pekko.http.scaladsl.model.StatusCodes
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import redis.clients.jedis.Jedis
import scala.jdk.CollectionConverters._

object StatsApi {
  implicit val system: ActorSystem = ActorSystem("semantic-cache")
  val jedis = new Jedis("redis", 6379)

  val HitFreshnessSeconds = 3600
  val AutomatedClassHeader = "X-Client-Class"
  val AgingHitsField = "hits_older_than_1h"

  /** The counters of one (tenant, model version): never another tenant's, never another version's. */
  def statsKey(tenant: String, modelVersion: String): String = s"stats:$tenant:$modelVersion"

  /** A rate with a zero denominator is 0.0, never a division error. */
  def rate(numerator: Long, denominator: Long): Double =
    if (denominator == 0) 0.0
    else BigDecimal(numerator.toDouble / denominator).setScale(4, BigDecimal.RoundingMode.HALF_UP).toDouble

  def readStats(caller: String, tenant: String, modelVersion: String): Either[Int, String] = {
    if (caller.isEmpty) Left(401)
    else if (caller != tenant) Left(403)
    else if (modelVersion.isEmpty) Left(400)
    else {
      // The same hash the stats consumer maintains: the report cannot disagree with what it counted.
      val counters = jedis.hgetAll(statsKey(tenant, modelVersion)).asScala.toMap
      def counter(field: String): Long = counters.getOrElse(field, "0").toLong
      val hits = counter("hits_total")
      val misses = counter("misses_total")
      val automatedHits = counter("automated_hits")
      val automatedTotal = counter("automated_total")
      val agingHits = counter(AgingHitsField)
      val similaritySum = counters.getOrElse("similarity_sum", "0.0").toDouble
      val avgSimilarity =
        if (hits == 0) 0.0
        else BigDecimal(similaritySum / hits).setScale(4, BigDecimal.RoundingMode.HALF_UP).toDouble
      system.log.info(
        s"stats tenant=$tenant version=$modelVersion freshness=\${HitFreshnessSeconds}s from=$AutomatedClassHeader aging_hits=$agingHits")
      Right(
        s"""{"tenant":"$tenant","model_version":"$modelVersion","hit_rate":\${rate(hits, hits + misses)},"hit_rate_automated":\${rate(automatedHits, automatedTotal)},"automated_share":\${rate(automatedTotal, hits + misses)},"avg_similarity":$avgSimilarity,"aging_hits":$agingHits,"hits_older_than_1h_share":\${rate(agingHits, hits)}}""")
    }
  }

  val route: Route =
    path("v1" / "semantic-cache" / Segment / "stats") { tenant =>
      get {
        parameter("model_version") { modelVersion =>
          optionalHeaderValueByName("X-Tenant-Id") { callerOpt =>
            readStats(callerOpt.getOrElse(""), tenant, modelVersion) match {
              case Left(401) => complete(StatusCodes.Unauthorized, """{"error":"missing X-Tenant-Id"}""")
              case Left(403) => complete(StatusCodes.Forbidden, """{"error":"forbidden"}""")
              case Left(_) => complete(StatusCodes.BadRequest, """{"error":"model_version is required"}""")
              case Right(body) => complete(StatusCodes.OK, body)
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

#include <cmath>
#include <iterator>
#include <string>
#include <unordered_map>

using json = nlohmann::json;

int main() {
  sw::redis::Redis redis("tcp://redis:6379");
  httplib::Server svr;

  svr.Get(R"(/v1/semantic-cache/([^/]+)/stats)", [&redis](const httplib::Request& req, httplib::Response& res) {
    // TODO: this draft reads one global stats:all hash, so every tenant and every model version is
    // reported as one number; it answers for whatever tenant the path names; it reports a single
    // hit rate with no automated split; and it never says how old the hits are. Review all four.
    const auto tenant = req.matches[1].str();
    const auto modelVersion = req.get_param_value("model_version");
    std::unordered_map<std::string, std::string> counters;
    redis.hgetall("stats:all", std::inserter(counters, counters.end()));
    const long long hits = counters.count("hits") ? std::stoll(counters["hits"]) : 0;
    const long long misses = counters.count("misses") ? std::stoll(counters["misses"]) : 0;
    const long long lookups = hits + misses;
    const double hitRate = lookups == 0
                               ? 0.0
                               : std::round(static_cast<double>(hits) / static_cast<double>(lookups) * 10000.0) / 10000.0;
    res.status = 200;
    res.set_content(
        json{{"tenant", tenant}, {"model_version", modelVersion}, {"hit_rate", hitRate}}.dump(),
        "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <cmath>
#include <iostream>
#include <iterator>
#include <string>
#include <unordered_map>

using json = nlohmann::json;

// The window a hit's entry age is judged against before it counts as hits_older_than_1h.
constexpr long long kHitFreshnessSeconds = 3600;
// The class a lookup declares in X-Client-Class, so the automated split can be reported here.
const std::string kAutomatedClassHeader = "X-Client-Class";
const std::string kAgingHitsField = "hits_older_than_1h";

// statsKey is the counters of one (tenant, model version): never another tenant's, never another version's.
std::string statsKey(const std::string& tenant, const std::string& modelVersion) {
  return "stats:" + tenant + ":" + modelVersion;
}

// rate keeps a zero denominator at 0.0 instead of a division by zero.
double rate(long long numerator, long long denominator) {
  return denominator == 0
             ? 0.0
             : std::round(static_cast<double>(numerator) / static_cast<double>(denominator) * 10000.0) / 10000.0;
}

int main() {
  sw::redis::Redis redis("tcp://redis:6379");
  httplib::Server svr;

  svr.Get(R"(/v1/semantic-cache/([^/]+)/stats)", [&redis](const httplib::Request& req, httplib::Response& res) {
    const auto caller = req.get_header_value("X-Tenant-Id");
    if (caller.empty()) {
      res.status = 401;
      res.set_content(R"({"error":"missing X-Tenant-Id"})", "application/json");
      return;
    }
    const auto tenant = req.matches[1].str();
    if (caller != tenant) {
      res.status = 403;
      res.set_content(R"({"error":"forbidden"})", "application/json");
      return;
    }
    const auto modelVersion = req.get_param_value("model_version");
    if (modelVersion.empty()) {
      res.status = 400;
      res.set_content(R"({"error":"model_version is required"})", "application/json");
      return;
    }
    std::unordered_map<std::string, std::string> counters;
    redis.hgetall(statsKey(tenant, modelVersion), std::inserter(counters, counters.end()));
    const auto counter = [&counters](const std::string& field) -> long long {
      const auto it = counters.find(field);
      return it == counters.end() ? 0 : std::stoll(it->second);
    };
    const long long hits = counter("hits_total");
    const long long misses = counter("misses_total");
    const long long automatedHits = counter("automated_hits");
    const long long automatedTotal = counter("automated_total");
    const long long agingHits = counter(kAgingHitsField);
    const auto similarityIt = counters.find("similarity_sum");
    const double similaritySum = similarityIt == counters.end() ? 0.0 : std::stod(similarityIt->second);
    const double avgSimilarity = hits == 0 ? 0.0 : std::round(similaritySum / static_cast<double>(hits) * 10000.0) / 10000.0;
    std::cerr << "stats tenant=" << tenant << " version=" << modelVersion
              << " freshness_seconds=" << kHitFreshnessSeconds << " automated_class_from=" << kAutomatedClassHeader
              << " aging_hits=" << agingHits << "\\n";
    res.status = 200;
    res.set_content(
        json{{"tenant", tenant},
             {"model_version", modelVersion},
             {"hit_rate", rate(hits, hits + misses)},
             {"hit_rate_automated", rate(automatedHits, automatedTotal)},
             {"automated_share", rate(automatedTotal, hits + misses)},
             {"avg_similarity", avgSimilarity},
             {"aging_hits", agingHits},
             {"hits_older_than_1h_share", rate(agingHits, hits)}}
            .dump(),
        "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  hints: [
    'Authorize the read like the write path: the tenant in the path is a claim, not a permission. Take the caller from `X-Tenant-Id`, answer **401** when it is missing and **403** on a mismatch, and require `model_version` — a tenant id nobody can guess is not access control.',
    'Read `stats_key(tenant, model_version)` → `stats:{tenant}:{model_version}`, so a version’s counters never mix with another version’s, and report the automated split beside the overall rate: `automated_hits` ÷ `automated_total` against `hits_total` ÷ lookups, with `automated_share` saying how much of the traffic that rate came from.',
    'Age is a counter, not a hunch: `hits_older_than_1h` against `hits_total` gives `hits_older_than_1h_share`, and an entry’s age is judged against `HIT_FRESHNESS_SECONDS` (`3600`). Guard every rate with its denominator — `0.0` when nobody looked anything up — because a `NaN` in a dashboard endpoint is a page in the middle of an incident.',
  ],
  debrief: `The read side of an AI feature is where a team decides the feature is working, so its scope, its split and its freshness are the product rather than the presentation. One global rate hands one tenant’s numbers to another and hides a bad model version inside a good one; merging the automated traffic hides that most of the “hits” are near-duplicate automation re-reading the same answers; and a hit rate without age makes stale answers look like a win. Real platforms add a per-version breakdown for canaries, a similarity histogram so a falling average shows up before the hit rate moves, and alerting on \`hits_older_than_1h_share\` instead of on hit rate alone.`,
};
