import type {Step} from '@/lib/types';

export const readStep: Step = {
  id: 'read',
  title: 'GET /v1/semantic-cache/{tenant}/stats: a hit rate with its context',
  concept: 'http',
  guides: ['honest-reads', 'request-boundaries'],
  file: 'read',
  focus: ['client', 'cache', 'stats', 'redis'],
  task: `## Task

**Starting point.** The starter serves \`GET /v1/semantic-cache/{tenant}/stats?model_version=\`: it
reads the counters the stats consumer keeps, computes \`hit_rate\` and \`avg_similarity\`, and answers
\`{"tenant", "model_version", "hit_rate", "avg_similarity"}\`. It serves the demo and hides four flaws.

**Failure mode the checks target.** Any caller can read any tenant's numbers. Every tenant and every
model version is reported as one number, so a regression in one version hides in another's
traffic. A 99% hit rate reads as healthy when the hits are a day old or come from a crawler
re-asking the same question.

- The caller is \`X-Tenant-Id\`: missing is **401**, a caller other than the path's tenant is
  **403**; \`model_version\` is required (**400**).
- The counters are read from \`stats:{tenant}:{model_version}\` (\`stats_key\`), the hash the
  consumer (step 4) maintains: \`hits_total\`, \`misses_total\`, \`similarity_sum\`,
  \`automated_total\`, \`automated_hits\`, \`hits_older_than_1h\`; a missing field is 0 and a rate with
  a zero denominator is \`0.0\`.
- The response is \`{"tenant", "model_version", "hit_rate", "hit_rate_automated",
  "automated_share", "avg_similarity", "aging_hits", "hits_older_than_1h_share"}\`: hits over
  lookups, automated hits over automated lookups, automated lookups over lookups, similarity sum
  over hits, the \`hits_older_than_1h\` count, and that count over hits.`,
  sequence: {
    participants: ['Client', 'Semantic Cache', 'Redis'],
    messages: [
      {
        from: 'Client',
        to: 'Semantic Cache',
        label: 'GET /v1/semantic-cache/{tenant}/stats?model_version= · X-Tenant-Id',
        kind: 'sync',
      },
      {
        from: 'Semantic Cache',
        to: 'Semantic Cache',
        label: 'no caller → 401 · caller ≠ tenant → 403 · no model_version → 400',
        kind: 'sync',
      },
      {from: 'Semantic Cache', to: 'Redis', label: 'HGETALL stats:{tenant}:{model_version}', kind: 'sync'},
      {
        from: 'Redis',
        to: 'Semantic Cache',
        label: 'hits_total · misses_total · similarity_sum · automated_* · hits_older_than_1h',
        kind: 'reply',
      },
      {
        from: 'Semantic Cache',
        to: 'Client',
        label:
          '200 {hit_rate, hit_rate_automated, automated_share, avg_similarity, aging_hits, hits_older_than_1h_share}',
        kind: 'reply',
      },
    ],
  },
  hints: [
    "A customer reads a competitor's hit rate, one tenant's bad week is invisible in everyone's good month, and a dashboard stays green while every human lookup misses.",
    'The handler reads no header, so the path alone picks the tenant; it reads one hash, `stats:all`, whatever the path says; and it divides hits by lookups without separating the automated lookups or counting the old hits the consumer tallied.',
    'Compare `X-Tenant-Id` to the path (401, 403), read `stats:{tenant}:{model_version}`, and add `hit_rate_automated`, `automated_share`, `aging_hits` and `hits_older_than_1h_share` with every division guarded against zero.',
  ],
  checks: [
    {
      id: 'route',
      title: 'Serves GET /v1/semantic-cache/{tenant}/stats',
      detail:
        'The report is served on the tenant-scoped path with `tenant`, `model_version` and `hit_rate` in the body.',
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
      title: "Refuses another tenant's stats",
      detail:
        'The caller in `X-Tenant-Id` may read only its own tenant: missing is 401, another tenant is 403. The starter answers for whatever tenant the path names.',
      match: {
        python: {all: [/X-Tenant-Id/i, /\b403\b/]},
        typescript: {all: [/x-tenant-id/i, /\b403\b/]},
        go: {all: [/X-Tenant-Id/i, /StatusForbidden|\b403\b/]},
        scala: {all: [/X-Tenant-Id/i, /Forbidden|\b403\b/]},
        cpp: {all: [/X-Tenant-Id/i, /\b403\b/]},
      },
    },
    {
      id: 'age',
      title: 'Reports the share of hits older than an hour',
      detail:
        'The response carries `aging_hits` (the `hits_older_than_1h` counter) and `hits_older_than_1h_share` (over hits). The starter reports no age, so a cache serving day-old answers reads as healthy.',
      match: {
        python: {all: [/hits_older_than_1h/, /aging_hits/]},
        typescript: {all: [/hits_older_than_1h/, /aging_hits/]},
        go: {all: [/hits_older_than_1h/, /aging_hits/]},
        scala: {all: [/hits_older_than_1h/, /aging_hits/]},
        cpp: {all: [/hits_older_than_1h/, /aging_hits/]},
      },
    },
    {
      id: 'automated',
      title: 'Separates the automated near-duplicate traffic',
      detail:
        'The response carries `hit_rate_automated` (`automated_hits` over `automated_total`) and `automated_share` (`automated_total` over lookups) beside `hit_rate`. The starter merges both classes into one rate.',
      match: {
        python: {all: [/automated_hits/, /hit_rate_automated/, /automated_share/]},
        typescript: {all: [/automated_hits/, /hit_rate_automated/, /automated_share/]},
        go: {all: [/automated_hits/, /hit_rate_automated/, /automated_share/]},
        scala: {all: [/automated_hits/, /hit_rate_automated/, /automated_share/]},
        cpp: {all: [/automated_hits/, /hit_rate_automated/, /automated_share/]},
      },
    },
    {
      id: 'scope',
      title: 'Counts per tenant and model version',
      detail:
        'The counters come from `stats:{tenant}:{model_version}`, the hash the consumer maintains, so no tenant and no model version shares a number; a missing `model_version` is 400 and a hash with no traffic reports 0.0 everywhere. The starter reads one `stats:all` hash.',
      match: {
        python: {all: [/stats:\{tenant\}:\{model_version\}/], none: [/stats:all/]},
        typescript: {all: [/stats:\$\{tenant\}:\$\{modelVersion\}/], none: [/stats:all/]},
        go: {all: [/"stats:%s:%s"|"stats:"\s*\+\s*tenant/], none: [/stats:all/]},
        scala: {all: [/s"stats:\$\{?tenant\}?:\$\{?modelVersion\}?"/], none: [/stats:all/]},
        cpp: {all: [/"stats:"\s*\+\s*tenant/], none: [/stats:all/]},
      },
    },
  ],
  code: {
    python: {
      starter: `"""GET /v1/semantic-cache/{tenant}/stats: the cache's counters as a report."""
import redis
from fastapi import FastAPI
from fastapi.responses import JSONResponse

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)


def _ratio(numerator: float, denominator: float) -> float:
    return numerator / denominator if denominator > 0 else 0.0


@app.get("/v1/semantic-cache/{tenant}/stats")
def stats(tenant: str, model_version: str = "") -> JSONResponse:
    # TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
    raw = r.hgetall("stats:all")
    hits = int(raw.get("hits_total", 0))
    misses = int(raw.get("misses_total", 0))
    lookups = hits + misses
    return JSONResponse(
        {
            "tenant": tenant,
            "model_version": model_version,
            "hit_rate": _ratio(hits, lookups),
            "avg_similarity": _ratio(float(raw.get("similarity_sum", 0)), hits),
        }
    )
`,
      solution: `"""GET /v1/semantic-cache/{tenant}/stats: one tenant and model version's counters as a report."""
import redis
from fastapi import FastAPI, Header
from fastapi.responses import JSONResponse

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)


def stats_key(tenant: str, model_version: str) -> str:
    return f"stats:{tenant}:{model_version}"


def _ratio(numerator: float, denominator: float) -> float:
    return numerator / denominator if denominator > 0 else 0.0


@app.get("/v1/semantic-cache/{tenant}/stats")
def stats(
    tenant: str,
    model_version: str = "",
    caller: str | None = Header(default=None, alias="X-Tenant-Id"),
) -> JSONResponse:
    if not caller:
        return JSONResponse({"error": "missing X-Tenant-Id"}, status_code=401)
    if caller != tenant:
        return JSONResponse({"error": "not your tenant"}, status_code=403)
    if not model_version:
        return JSONResponse({"error": "model_version is required"}, status_code=400)
    raw = r.hgetall(stats_key(tenant, model_version))
    hits = int(raw.get("hits_total", 0))
    misses = int(raw.get("misses_total", 0))
    lookups = hits + misses
    automated_total = int(raw.get("automated_total", 0))
    automated_hits = int(raw.get("automated_hits", 0))
    aging_hits = int(raw.get("hits_older_than_1h", 0))
    return JSONResponse(
        {
            "tenant": tenant,
            "model_version": model_version,
            "hit_rate": _ratio(hits, lookups),
            "hit_rate_automated": _ratio(automated_hits, automated_total),
            "automated_share": _ratio(automated_total, lookups),
            "avg_similarity": _ratio(float(raw.get("similarity_sum", 0)), hits),
            "aging_hits": aging_hits,
            "hits_older_than_1h_share": _ratio(aging_hits, hits),
        }
    )
`,
    },
    typescript: {
      starter: `/** GET /v1/semantic-cache/:tenant/stats: the cache's counters as a report. */
import Fastify from 'fastify';
import Redis from 'ioredis';

export const app = Fastify();
const redis = new Redis({host: 'redis', port: 6379});

const ratio = (numerator: number, denominator: number): number => (denominator > 0 ? numerator / denominator : 0);

app.get('/v1/semantic-cache/:tenant/stats', async (request, reply) => {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  const {tenant} = request.params as {tenant: string};
  const modelVersion = (request.query as {model_version?: string}).model_version ?? '';
  const raw = await redis.hgetall('stats:all');
  const hits = Number(raw.hits_total ?? 0);
  const misses = Number(raw.misses_total ?? 0);
  const lookups = hits + misses;
  return reply.send({
    tenant,
    model_version: modelVersion,
    hit_rate: ratio(hits, lookups),
    avg_similarity: ratio(Number(raw.similarity_sum ?? 0), hits),
  });
});
`,
      solution: `/** GET /v1/semantic-cache/:tenant/stats: one tenant and model version's counters as a report. */
import Fastify from 'fastify';
import Redis from 'ioredis';

export const app = Fastify();
const redis = new Redis({host: 'redis', port: 6379});

export function statsKey(tenant: string, modelVersion: string): string {
  return \`stats:\${tenant}:\${modelVersion}\`;
}

const ratio = (numerator: number, denominator: number): number => (denominator > 0 ? numerator / denominator : 0);

app.get('/v1/semantic-cache/:tenant/stats', async (request, reply) => {
  const {tenant} = request.params as {tenant: string};
  const caller = request.headers['x-tenant-id'];
  if (typeof caller !== 'string' || caller === '') return reply.code(401).send({error: 'missing X-Tenant-Id'});
  if (caller !== tenant) return reply.code(403).send({error: 'not your tenant'});
  const modelVersion = (request.query as {model_version?: string}).model_version ?? '';
  if (modelVersion === '') return reply.code(400).send({error: 'model_version is required'});
  const raw = await redis.hgetall(statsKey(tenant, modelVersion));
  const hits = Number(raw.hits_total ?? 0);
  const misses = Number(raw.misses_total ?? 0);
  const lookups = hits + misses;
  const automatedTotal = Number(raw.automated_total ?? 0);
  const automatedHits = Number(raw.automated_hits ?? 0);
  const agingHits = Number(raw.hits_older_than_1h ?? 0);
  return reply.send({
    tenant,
    model_version: modelVersion,
    hit_rate: ratio(hits, lookups),
    hit_rate_automated: ratio(automatedHits, automatedTotal),
    automated_share: ratio(automatedTotal, lookups),
    avg_similarity: ratio(Number(raw.similarity_sum ?? 0), hits),
    aging_hits: agingHits,
    hits_older_than_1h_share: ratio(agingHits, hits),
  });
});
`,
    },
    go: {
      starter: `// GET /v1/semantic-cache/{tenant}/stats: the cache's counters as a report.
package main

import (
	"encoding/json"
	"net/http"
	"strconv"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

func ratio(numerator, denominator float64) float64 {
	if denominator > 0 {
		return numerator / denominator
	}
	return 0
}

func counter(raw map[string]string, field string) float64 {
	v, _ := strconv.ParseFloat(raw[field], 64)
	return v
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func stats(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
	tenant := r.PathValue("tenant")
	modelVersion := r.URL.Query().Get("model_version")
	raw, err := rdb.HGetAll(r.Context(), "stats:all").Result()
	if err != nil {
		writeJSON(rw, http.StatusInternalServerError, map[string]any{"error": err.Error()})
		return
	}
	hits := counter(raw, "hits_total")
	misses := counter(raw, "misses_total")
	lookups := hits + misses
	writeJSON(rw, http.StatusOK, map[string]any{
		"tenant":         tenant,
		"model_version":  modelVersion,
		"hit_rate":       ratio(hits, lookups),
		"avg_similarity": ratio(counter(raw, "similarity_sum"), hits),
	})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/semantic-cache/{tenant}/stats", stats)
}
`,
      solution: `// GET /v1/semantic-cache/{tenant}/stats: one tenant and model version's counters as a report.
package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

func statsKey(tenant, modelVersion string) string {
	return fmt.Sprintf("stats:%s:%s", tenant, modelVersion)
}

func ratio(numerator, denominator float64) float64 {
	if denominator > 0 {
		return numerator / denominator
	}
	return 0
}

func counter(raw map[string]string, field string) float64 {
	v, _ := strconv.ParseFloat(raw[field], 64)
	return v
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func stats(rw http.ResponseWriter, r *http.Request) {
	tenant := r.PathValue("tenant")
	caller := r.Header.Get("X-Tenant-Id")
	if caller == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]any{"error": "missing X-Tenant-Id"})
		return
	}
	if caller != tenant {
		writeJSON(rw, http.StatusForbidden, map[string]any{"error": "not your tenant"})
		return
	}
	modelVersion := r.URL.Query().Get("model_version")
	if modelVersion == "" {
		writeJSON(rw, http.StatusBadRequest, map[string]any{"error": "model_version is required"})
		return
	}
	raw, err := rdb.HGetAll(r.Context(), statsKey(tenant, modelVersion)).Result()
	if err != nil {
		writeJSON(rw, http.StatusInternalServerError, map[string]any{"error": err.Error()})
		return
	}
	hits := counter(raw, "hits_total")
	misses := counter(raw, "misses_total")
	lookups := hits + misses
	automatedTotal := counter(raw, "automated_total")
	automatedHits := counter(raw, "automated_hits")
	agingHits := counter(raw, "hits_older_than_1h")
	writeJSON(rw, http.StatusOK, map[string]any{
		"tenant":                   tenant,
		"model_version":            modelVersion,
		"hit_rate":                 ratio(hits, lookups),
		"hit_rate_automated":       ratio(automatedHits, automatedTotal),
		"automated_share":          ratio(automatedTotal, lookups),
		"avg_similarity":           ratio(counter(raw, "similarity_sum"), hits),
		"aging_hits":               int64(agingHits),
		"hits_older_than_1h_share": ratio(agingHits, hits),
	})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/semantic-cache/{tenant}/stats", stats)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

/** GET /v1/semantic-cache/{tenant}/stats: the cache's counters as a report. */
object Read {
  val jedis = new JedisPooled("redis", 6379)

  private def ratio(numerator: Double, denominator: Double): Double = if (denominator > 0) numerator / denominator else 0.0

  private def counter(raw: Map[String, String], field: String): Double = raw.get(field).map(_.toDouble).getOrElse(0.0)

  private def json(status: StatusCode, value: ujson.Value): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, ujson.write(value)))

  val route: Route =
    path("v1" / "semantic-cache" / Segment / "stats") { tenant =>
      get {
        parameter("model_version".?) { modelVersion =>
          // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
          val raw = jedis.hgetAll("stats:all").asScala.toMap
          val hits = counter(raw, "hits_total")
          val misses = counter(raw, "misses_total")
          val lookups = hits + misses
          complete(json(StatusCodes.OK, ujson.Obj(
            "tenant" -> tenant,
            "model_version" -> ujson.Str(modelVersion.getOrElse("")),
            "hit_rate" -> ratio(hits, lookups),
            "avg_similarity" -> ratio(counter(raw, "similarity_sum"), hits))))
        }
      }
    }
}
`,
      solution: `import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

/** GET /v1/semantic-cache/{tenant}/stats: one tenant and model version's counters as a report. */
object Read {
  val jedis = new JedisPooled("redis", 6379)

  def statsKey(tenant: String, modelVersion: String): String = s"stats:$tenant:$modelVersion"

  private def ratio(numerator: Double, denominator: Double): Double = if (denominator > 0) numerator / denominator else 0.0

  private def counter(raw: Map[String, String], field: String): Double = raw.get(field).map(_.toDouble).getOrElse(0.0)

  private def json(status: StatusCode, value: ujson.Value): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, ujson.write(value)))

  val route: Route =
    path("v1" / "semantic-cache" / Segment / "stats") { tenant =>
      get {
        optionalHeaderValueByName("X-Tenant-Id") { caller =>
          parameter("model_version".?) { modelVersion =>
            caller.filter(_.nonEmpty) match {
              case None => complete(json(StatusCodes.Unauthorized, ujson.Obj("error" -> "missing X-Tenant-Id")))
              case Some(c) if c != tenant => complete(json(StatusCodes.Forbidden, ujson.Obj("error" -> "not your tenant")))
              case Some(_) =>
                modelVersion.filter(_.nonEmpty) match {
                  case None => complete(json(StatusCodes.BadRequest, ujson.Obj("error" -> "model_version is required")))
                  case Some(mv) =>
                    val raw = jedis.hgetAll(statsKey(tenant, mv)).asScala.toMap
                    val hits = counter(raw, "hits_total")
                    val misses = counter(raw, "misses_total")
                    val lookups = hits + misses
                    val automatedTotal = counter(raw, "automated_total")
                    val automatedHits = counter(raw, "automated_hits")
                    val agingHits = counter(raw, "hits_older_than_1h")
                    complete(json(StatusCodes.OK, ujson.Obj(
                      "tenant" -> tenant,
                      "model_version" -> mv,
                      "hit_rate" -> ratio(hits, lookups),
                      "hit_rate_automated" -> ratio(automatedHits, automatedTotal),
                      "automated_share" -> ratio(automatedTotal, lookups),
                      "avg_similarity" -> ratio(counter(raw, "similarity_sum"), hits),
                      "aging_hits" -> agingHits.toInt,
                      "hits_older_than_1h_share" -> ratio(agingHits, hits))))
                }
            }
          }
        }
      }
    }
}
`,
    },
    cpp: {
      starter: `// GET /v1/semantic-cache/{tenant}/stats: the cache's counters as a report.
#include <httplib.h>
#include <sw/redis++/redis++.h>

#include <nlohmann/json.hpp>

#include <string>
#include <unordered_map>

using json = nlohmann::json;

sw::redis::Redis redis("tcp://redis:6379");

double ratio(double numerator, double denominator) { return denominator > 0 ? numerator / denominator : 0.0; }

double counter(const std::unordered_map<std::string, std::string>& raw, const std::string& field) {
  return raw.count(field) ? std::stod(raw.at(field)) : 0.0;
}

void stats(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  const std::string tenant = req.matches[1];
  const std::string model_version = req.get_param_value("model_version");
  const auto raw = redis.hgetall("stats:all");
  const double hits = counter(raw, "hits_total");
  const double misses = counter(raw, "misses_total");
  const double lookups = hits + misses;
  res.set_content(json{{"tenant", tenant},
                       {"model_version", model_version},
                       {"hit_rate", ratio(hits, lookups)},
                       {"avg_similarity", ratio(counter(raw, "similarity_sum"), hits)}}
                      .dump(),
                  "application/json");
}

void register_routes(httplib::Server& svr) { svr.Get(R"(/v1/semantic-cache/([^/]+)/stats)", stats); }
`,
      solution: `// GET /v1/semantic-cache/{tenant}/stats: one tenant and model version's counters as a report.
#include <httplib.h>
#include <sw/redis++/redis++.h>

#include <nlohmann/json.hpp>

#include <string>
#include <unordered_map>

using json = nlohmann::json;

sw::redis::Redis redis("tcp://redis:6379");

std::string stats_key(const std::string& tenant, const std::string& model_version) {
  return "stats:" + tenant + ":" + model_version;
}

double ratio(double numerator, double denominator) { return denominator > 0 ? numerator / denominator : 0.0; }

double counter(const std::unordered_map<std::string, std::string>& raw, const std::string& field) {
  return raw.count(field) ? std::stod(raw.at(field)) : 0.0;
}

void stats(const httplib::Request& req, httplib::Response& res) {
  const std::string tenant = req.matches[1];
  const std::string caller = req.get_header_value("X-Tenant-Id");
  if (caller.empty()) {
    res.status = 401;
    res.set_content(json{{"error", "missing X-Tenant-Id"}}.dump(), "application/json");
    return;
  }
  if (caller != tenant) {
    res.status = 403;
    res.set_content(json{{"error", "not your tenant"}}.dump(), "application/json");
    return;
  }
  const std::string model_version = req.get_param_value("model_version");
  if (model_version.empty()) {
    res.status = 400;
    res.set_content(json{{"error", "model_version is required"}}.dump(), "application/json");
    return;
  }
  const auto raw = redis.hgetall(stats_key(tenant, model_version));
  const double hits = counter(raw, "hits_total");
  const double misses = counter(raw, "misses_total");
  const double lookups = hits + misses;
  const double automated_total = counter(raw, "automated_total");
  const double automated_hits = counter(raw, "automated_hits");
  const double aging_hits = counter(raw, "hits_older_than_1h");
  res.set_content(json{{"tenant", tenant},
                       {"model_version", model_version},
                       {"hit_rate", ratio(hits, lookups)},
                       {"hit_rate_automated", ratio(automated_hits, automated_total)},
                       {"automated_share", ratio(automated_total, lookups)},
                       {"avg_similarity", ratio(counter(raw, "similarity_sum"), hits)},
                       {"aging_hits", static_cast<long>(aging_hits)},
                       {"hits_older_than_1h_share", ratio(aging_hits, hits)}}
                      .dump(),
                  "application/json");
}

void register_routes(httplib::Server& svr) { svr.Get(R"(/v1/semantic-cache/([^/]+)/stats)", stats); }
`,
    },
  },
  harness: {
    python: `ACME = {"X-Tenant-Id": "acme"}
FULL = {"hits_total": 10, "misses_total": 10, "similarity_sum": 9.1, "automated_total": 10, "automated_hits": 9, "hits_older_than_1h": 3}


def _counters(ctx, key, **fields):
    """The hash the stats consumer (step 4) maintains, as it would stand after the traffic."""
    ctx.redis.hset(key, mapping=fields)


async def _get(c, tenant="acme", model_version="2024-06", headers=ACME):
    params = {"model_version": model_version} if model_version else {}
    return await c.get(f"/v1/semantic-cache/{tenant}/stats", params=params, headers=headers)


def _near(value, expected):
    return isinstance(value, (int, float)) and abs(value - expected) < 1e-9


async def check_route(ctx):
    m = ctx.load("read")
    _counters(ctx, "stats:acme:2024-06", **FULL)
    _counters(ctx, "stats:all", **FULL)
    async with ctx.client(m.app) as c:
        r = await _get(c)
    assert r.status_code == 200, f"GET /v1/semantic-cache/acme/stats answered {r.status_code}: {r.text}"
    assert r.headers.get("content-type", "").startswith("application/json"), f"the report must be JSON, got Content-Type {r.headers.get('content-type')!r}"
    body = r.json()
    assert body.get("tenant") == "acme" and body.get("model_version") == "2024-06", f"the report names its tenant and model version: {body}"
    assert _near(body.get("hit_rate"), 0.5), f"hit_rate is {body.get('hit_rate')!r}, expected 10 hits / 20 lookups = 0.5"


async def check_tenant_authz(ctx):
    m = ctx.load("read")
    _counters(ctx, "stats:acme:2024-06", **FULL)
    _counters(ctx, "stats:all", **FULL)
    async with ctx.client(m.app) as c:
        r = await _get(c, headers={})
        assert r.status_code == 401, f"a request without X-Tenant-Id answered {r.status_code}, expected 401"
        r = await _get(c, headers={"X-Tenant-Id": "globex"})
        assert r.status_code == 403, f"globex asked for acme's stats and got {r.status_code}, expected 403: {r.text}"
        r = await _get(c)
        assert r.status_code == 200, f"acme asked for its own stats and got {r.status_code}: {r.text}"


async def check_age(ctx):
    m = ctx.load("read")
    _counters(ctx, "stats:acme:2024-06", **FULL)
    async with ctx.client(m.app) as c:
        r = await _get(c)
    assert r.status_code == 200, f"stats answered {r.status_code}: {r.text}"
    body = r.json()
    assert body.get("aging_hits") == 3, f"aging_hits is {body.get('aging_hits')!r}, expected the consumer's hits_older_than_1h count, 3"
    assert _near(body.get("hits_older_than_1h_share"), 0.3), f"hits_older_than_1h_share is {body.get('hits_older_than_1h_share')!r}, expected 3 / 10 hits = 0.3"


async def check_automated(ctx):
    m = ctx.load("read")
    _counters(ctx, "stats:acme:2024-06", **FULL)
    async with ctx.client(m.app) as c:
        r = await _get(c)
    assert r.status_code == 200, f"stats answered {r.status_code}: {r.text}"
    body = r.json()
    assert _near(body.get("hit_rate"), 0.5), f"hit_rate is {body.get('hit_rate')!r}, expected 0.5"
    assert _near(body.get("hit_rate_automated"), 0.9), f"hit_rate_automated is {body.get('hit_rate_automated')!r}, expected 9 automated hits / 10 automated lookups = 0.9"
    assert _near(body.get("automated_share"), 0.5), f"automated_share is {body.get('automated_share')!r}, expected 10 automated lookups / 20 lookups = 0.5"
    assert _near(body.get("avg_similarity"), 0.91), f"avg_similarity is {body.get('avg_similarity')!r}, expected 9.1 / 10 hits = 0.91"


async def check_scope(ctx):
    m = ctx.load("read")
    _counters(ctx, "stats:all", hits_total=99, misses_total=1, similarity_sum=90)
    _counters(ctx, "stats:acme:2024-06", **FULL)
    _counters(ctx, "stats:acme:2024-07", hits_total=1, misses_total=9, similarity_sum=0.9)
    async with ctx.client(m.app) as c:
        r = await _get(c)
        assert _near(r.json().get("hit_rate"), 0.5), f"acme 2024-06 reports hit_rate {r.json().get('hit_rate')!r}, expected 0.5 from stats:acme:2024-06 (not another hash's numbers)"
        r = await _get(c, model_version="2024-07")
        assert _near(r.json().get("hit_rate"), 0.1), f"acme 2024-07 reports hit_rate {r.json().get('hit_rate')!r}, expected 0.1 from stats:acme:2024-07"
        r = await _get(c, model_version="")
        assert r.status_code == 400, f"a request without model_version answered {r.status_code}, expected 400"
        r = await _get(c, tenant="globex", headers={"X-Tenant-Id": "globex"})
        assert r.status_code == 200, f"a tenant with no traffic answered {r.status_code}: {r.text}"
        body = r.json()
        for field in ("hit_rate", "hit_rate_automated", "automated_share", "avg_similarity", "hits_older_than_1h_share"):
            assert _near(body.get(field), 0.0), f"{field} is {body.get(field)!r} for a tenant with no traffic, expected 0.0 (no NaN, no division error)"
`,
    typescript: `const ACME = {'X-Tenant-Id': 'acme'};
const FULL = {hits_total: 10, misses_total: 10, similarity_sum: 9.1, automated_total: 10, automated_hits: 9, hits_older_than_1h: 3};

/** The hash the stats consumer (step 4) maintains, as it would stand after the traffic. */
function counters(ctx, key: string, fields: Record<string, number>) {
  ctx.redis.hset(key, ...Object.entries(fields).flat());
}

function get(c, {tenant = 'acme', modelVersion = '2024-06', headers = ACME as Record<string, string>} = {}) {
  return c.get(\`/v1/semantic-cache/\${tenant}/stats\`, {query: modelVersion === '' ? {} : {model_version: modelVersion}, headers});
}

const near = (value: unknown, expected: number): boolean => typeof value === 'number' && Math.abs(value - expected) < 1e-9;

export async function check_route(ctx) {
  const m = ctx.load('read');
  counters(ctx, 'stats:acme:2024-06', FULL);
  counters(ctx, 'stats:all', FULL);
  const r = await get(ctx.client(m.app));
  assert.equal(r.status, 200, \`GET /v1/semantic-cache/acme/stats answered \${r.status}: \${r.text}\`);
  assert((r.headers['content-type'] ?? '').startsWith('application/json'), \`the report must be JSON, got Content-Type \${JSON.stringify(r.headers['content-type'])}\`);
  const body = r.json();
  assert(body.tenant === 'acme' && body.model_version === '2024-06', \`the report names its tenant and model version: \${r.text}\`);
  assert(near(body.hit_rate, 0.5), \`hit_rate is \${JSON.stringify(body.hit_rate)}, expected 10 hits / 20 lookups = 0.5\`);
}

export async function check_tenant_authz(ctx) {
  const m = ctx.load('read');
  counters(ctx, 'stats:acme:2024-06', FULL);
  counters(ctx, 'stats:all', FULL);
  const c = ctx.client(m.app);
  let r = await get(c, {headers: {}});
  assert.equal(r.status, 401, \`a request without X-Tenant-Id answered \${r.status}, expected 401\`);
  r = await get(c, {headers: {'X-Tenant-Id': 'globex'}});
  assert.equal(r.status, 403, \`globex asked for acme's stats and got \${r.status}, expected 403: \${r.text}\`);
  r = await get(c);
  assert.equal(r.status, 200, \`acme asked for its own stats and got \${r.status}: \${r.text}\`);
}

export async function check_age(ctx) {
  const m = ctx.load('read');
  counters(ctx, 'stats:acme:2024-06', FULL);
  const r = await get(ctx.client(m.app));
  assert.equal(r.status, 200, \`stats answered \${r.status}: \${r.text}\`);
  const body = r.json();
  assert.equal(body.aging_hits, 3, \`aging_hits is \${JSON.stringify(body.aging_hits)}, expected the consumer's hits_older_than_1h count, 3\`);
  assert(near(body.hits_older_than_1h_share, 0.3), \`hits_older_than_1h_share is \${JSON.stringify(body.hits_older_than_1h_share)}, expected 3 / 10 hits = 0.3\`);
}

export async function check_automated(ctx) {
  const m = ctx.load('read');
  counters(ctx, 'stats:acme:2024-06', FULL);
  const r = await get(ctx.client(m.app));
  assert.equal(r.status, 200, \`stats answered \${r.status}: \${r.text}\`);
  const body = r.json();
  assert(near(body.hit_rate, 0.5), \`hit_rate is \${JSON.stringify(body.hit_rate)}, expected 0.5\`);
  assert(near(body.hit_rate_automated, 0.9), \`hit_rate_automated is \${JSON.stringify(body.hit_rate_automated)}, expected 9 automated hits / 10 automated lookups = 0.9\`);
  assert(near(body.automated_share, 0.5), \`automated_share is \${JSON.stringify(body.automated_share)}, expected 10 automated lookups / 20 lookups = 0.5\`);
  assert(near(body.avg_similarity, 0.91), \`avg_similarity is \${JSON.stringify(body.avg_similarity)}, expected 9.1 / 10 hits = 0.91\`);
}

export async function check_scope(ctx) {
  const m = ctx.load('read');
  counters(ctx, 'stats:all', {hits_total: 99, misses_total: 1, similarity_sum: 90});
  counters(ctx, 'stats:acme:2024-06', FULL);
  counters(ctx, 'stats:acme:2024-07', {hits_total: 1, misses_total: 9, similarity_sum: 0.9});
  const c = ctx.client(m.app);
  let r = await get(c);
  assert(near(r.json().hit_rate, 0.5), \`acme 2024-06 reports hit_rate \${JSON.stringify(r.json().hit_rate)}, expected 0.5 from stats:acme:2024-06 (not another hash's numbers)\`);
  r = await get(c, {modelVersion: '2024-07'});
  assert(near(r.json().hit_rate, 0.1), \`acme 2024-07 reports hit_rate \${JSON.stringify(r.json().hit_rate)}, expected 0.1 from stats:acme:2024-07\`);
  r = await get(c, {modelVersion: ''});
  assert.equal(r.status, 400, \`a request without model_version answered \${r.status}, expected 400\`);
  r = await get(c, {tenant: 'globex', headers: {'X-Tenant-Id': 'globex'}});
  assert.equal(r.status, 200, \`a tenant with no traffic answered \${r.status}: \${r.text}\`);
  const body = r.json();
  for (const field of ['hit_rate', 'hit_rate_automated', 'automated_share', 'avg_similarity', 'hits_older_than_1h_share']) {
    assert(near(body[field], 0), \`\${field} is \${JSON.stringify(body[field])} for a tenant with no traffic, expected 0.0 (no NaN, no division error)\`);
  }
}
`,
    go: `package main

import (
	"math"
	"net/http"
	"strings"

	"leetbuild/harness"
)

var readFull = map[string]any{"hits_total": 10, "misses_total": 10, "similarity_sum": 9.1, "automated_total": 10, "automated_hits": 9, "hits_older_than_1h": 3}

// readCounters writes the hash the stats consumer (step 4) maintains, as it would stand after the traffic.
func readCounters(ctx *harness.Ctx, key string, fields map[string]any) {
	args := []any{"HSET", key}
	for _, field := range []string{"hits_total", "misses_total", "similarity_sum", "automated_total", "automated_hits", "hits_older_than_1h"} {
		if v, ok := fields[field]; ok {
			args = append(args, field, v)
		}
	}
	ctx.Redis.Do(args...)
}

func readServer(ctx *harness.Ctx) *harness.HTTP {
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

func readGet(c *harness.HTTP, tenant, modelVersion string, header ...string) *harness.Response {
	path := "/v1/semantic-cache/" + tenant + "/stats"
	if modelVersion != "" {
		path += "?model_version=" + modelVersion
	}
	return c.Get(path, header...)
}

func readBody(ctx *harness.Ctx, r *harness.Response) map[string]any {
	body, ok := r.JSON().(map[string]any)
	ctx.Assert(ok, "the report must be a JSON object, got %s", r.Text())
	return body
}

func readNear(v any, expected float64) bool {
	f, ok := v.(float64)
	return ok && math.Abs(f-expected) < 1e-9
}

func CheckRoute(ctx *harness.Ctx) {
	c := readServer(ctx)
	readCounters(ctx, "stats:acme:2024-06", readFull)
	readCounters(ctx, "stats:all", readFull)
	r := readGet(c, "acme", "2024-06", "X-Tenant-Id", "acme")
	ctx.Equal(r.Status, 200, "GET /v1/semantic-cache/acme/stats (%s)", r.Text())
	ctx.Assert(strings.HasPrefix(r.Header.Get("Content-Type"), "application/json"), "the report must be JSON, got Content-Type %q", r.Header.Get("Content-Type"))
	body := readBody(ctx, r)
	ctx.Assert(body["tenant"] == "acme" && body["model_version"] == "2024-06", "the report names its tenant and model version: %s", r.Text())
	ctx.Assert(readNear(body["hit_rate"], 0.5), "hit_rate is %v, expected 10 hits / 20 lookups = 0.5", body["hit_rate"])
}

func CheckTenantAuthz(ctx *harness.Ctx) {
	c := readServer(ctx)
	readCounters(ctx, "stats:acme:2024-06", readFull)
	readCounters(ctx, "stats:all", readFull)
	r := readGet(c, "acme", "2024-06")
	ctx.Equal(r.Status, 401, "a request without X-Tenant-Id")
	r = readGet(c, "acme", "2024-06", "X-Tenant-Id", "globex")
	ctx.Equal(r.Status, 403, "globex asked for acme's stats (%s)", r.Text())
	r = readGet(c, "acme", "2024-06", "X-Tenant-Id", "acme")
	ctx.Equal(r.Status, 200, "acme asked for its own stats (%s)", r.Text())
}

func CheckAge(ctx *harness.Ctx) {
	c := readServer(ctx)
	readCounters(ctx, "stats:acme:2024-06", readFull)
	r := readGet(c, "acme", "2024-06", "X-Tenant-Id", "acme")
	ctx.Equal(r.Status, 200, "stats (%s)", r.Text())
	body := readBody(ctx, r)
	ctx.Equal(body["aging_hits"], 3, "aging_hits must be the consumer's hits_older_than_1h count")
	ctx.Assert(readNear(body["hits_older_than_1h_share"], 0.3), "hits_older_than_1h_share is %v, expected 3 / 10 hits = 0.3", body["hits_older_than_1h_share"])
}

func CheckAutomated(ctx *harness.Ctx) {
	c := readServer(ctx)
	readCounters(ctx, "stats:acme:2024-06", readFull)
	r := readGet(c, "acme", "2024-06", "X-Tenant-Id", "acme")
	ctx.Equal(r.Status, 200, "stats (%s)", r.Text())
	body := readBody(ctx, r)
	ctx.Assert(readNear(body["hit_rate"], 0.5), "hit_rate is %v, expected 0.5", body["hit_rate"])
	ctx.Assert(readNear(body["hit_rate_automated"], 0.9), "hit_rate_automated is %v, expected 9 automated hits / 10 automated lookups = 0.9", body["hit_rate_automated"])
	ctx.Assert(readNear(body["automated_share"], 0.5), "automated_share is %v, expected 10 automated lookups / 20 lookups = 0.5", body["automated_share"])
	ctx.Assert(readNear(body["avg_similarity"], 0.91), "avg_similarity is %v, expected 9.1 / 10 hits = 0.91", body["avg_similarity"])
}

func CheckScope(ctx *harness.Ctx) {
	c := readServer(ctx)
	readCounters(ctx, "stats:all", map[string]any{"hits_total": 99, "misses_total": 1, "similarity_sum": 90})
	readCounters(ctx, "stats:acme:2024-06", readFull)
	readCounters(ctx, "stats:acme:2024-07", map[string]any{"hits_total": 1, "misses_total": 9, "similarity_sum": 0.9})
	r := readGet(c, "acme", "2024-06", "X-Tenant-Id", "acme")
	ctx.Assert(readNear(readBody(ctx, r)["hit_rate"], 0.5), "acme 2024-06 reports hit_rate %v, expected 0.5 from stats:acme:2024-06 (not another hash's numbers)", readBody(ctx, r)["hit_rate"])
	r = readGet(c, "acme", "2024-07", "X-Tenant-Id", "acme")
	ctx.Assert(readNear(readBody(ctx, r)["hit_rate"], 0.1), "acme 2024-07 reports hit_rate %v, expected 0.1 from stats:acme:2024-07", readBody(ctx, r)["hit_rate"])
	r = readGet(c, "acme", "", "X-Tenant-Id", "acme")
	ctx.Equal(r.Status, 400, "a request without model_version")
	r = readGet(c, "globex", "2024-06", "X-Tenant-Id", "globex")
	ctx.Equal(r.Status, 200, "a tenant with no traffic (%s)", r.Text())
	body := readBody(ctx, r)
	for _, field := range []string{"hit_rate", "hit_rate_automated", "automated_share", "avg_similarity", "hits_older_than_1h_share"} {
		ctx.Assert(readNear(body[field], 0), "%s is %v for a tenant with no traffic, expected 0.0 (no NaN, no division error)", field, body[field])
	}
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <cmath>
#include <map>
#include <string>

namespace {

const std::map<std::string, double> kFull = {{"hits_total", 10}, {"misses_total", 10}, {"similarity_sum", 9.1},
                                              {"automated_total", 10}, {"automated_hits", 9}, {"hits_older_than_1h", 3}};

// The hash the stats consumer (step 4) maintains, as it would stand after the traffic.
void readCounters(harness::Ctx& ctx, const std::string& key, const std::map<std::string, double>& fields) {
  std::vector<std::string> args = {"HSET", key};
  for (const auto& [field, value] : fields) {
    args.push_back(field);
    args.push_back(harness::Value(value));
  }
  ctx.Redis.Must(args);
}

struct ReadServer {
  httplib::Server svr;
};

harness::HTTP readServer(harness::Ctx& ctx) {
  static ReadServer* server = nullptr;
  delete server;
  server = new ReadServer;
  register_routes(server->svr);
  return ctx.HTTP(server->svr);
}

harness::Response readGet(harness::HTTP& c, const std::string& tenant, const std::string& modelVersion, const std::string& caller) {
  std::string path = "/v1/semantic-cache/" + tenant + "/stats";
  if (!modelVersion.empty()) path += "?model_version=" + modelVersion;
  if (caller.empty()) return c.Get(path);
  return c.Get(path, "X-Tenant-Id", caller);
}

nlohmann::json readBody(harness::Ctx& ctx, const harness::Response& r) {
  nlohmann::json body;
  try {
    body = nlohmann::json::parse(r.Text());
  } catch (const std::exception&) {
  }
  ctx.Assert(body.is_object(), "the report must be a JSON object, got %s", r.Text());
  return body;
}

bool readNear(const nlohmann::json& body, const std::string& field, double expected) {
  return body.contains(field) && body[field].is_number() && std::fabs(body[field].get<double>() - expected) < 1e-9;
}

std::string shown(const nlohmann::json& body, const std::string& field) { return body.value(field, nlohmann::json()).dump(); }

}  // namespace

void CheckRoute(harness::Ctx& ctx) {
  auto c = readServer(ctx);
  readCounters(ctx, "stats:acme:2024-06", kFull);
  readCounters(ctx, "stats:all", kFull);
  auto r = readGet(c, "acme", "2024-06", "acme");
  ctx.Equal(r.Status, 200, "GET /v1/semantic-cache/acme/stats (%s)", r.Text());
  ctx.Assert(r.HeaderValue("Content-Type").rfind("application/json", 0) == 0, "the report must be JSON, got Content-Type %q",
             r.HeaderValue("Content-Type"));
  const auto body = readBody(ctx, r);
  ctx.Assert(body.value("tenant", "") == "acme" && body.value("model_version", "") == "2024-06", "the report names its tenant and model version: %s",
             r.Text());
  ctx.Assert(readNear(body, "hit_rate", 0.5), "hit_rate is %s, expected 10 hits / 20 lookups = 0.5", shown(body, "hit_rate"));
}

void CheckTenantAuthz(harness::Ctx& ctx) {
  auto c = readServer(ctx);
  readCounters(ctx, "stats:acme:2024-06", kFull);
  readCounters(ctx, "stats:all", kFull);
  auto r = readGet(c, "acme", "2024-06", "");
  ctx.Equal(r.Status, 401, "a request without X-Tenant-Id");
  r = readGet(c, "acme", "2024-06", "globex");
  ctx.Equal(r.Status, 403, "globex asked for acme's stats (%s)", r.Text());
  r = readGet(c, "acme", "2024-06", "acme");
  ctx.Equal(r.Status, 200, "acme asked for its own stats (%s)", r.Text());
}

void CheckAge(harness::Ctx& ctx) {
  auto c = readServer(ctx);
  readCounters(ctx, "stats:acme:2024-06", kFull);
  auto r = readGet(c, "acme", "2024-06", "acme");
  ctx.Equal(r.Status, 200, "stats (%s)", r.Text());
  const auto body = readBody(ctx, r);
  ctx.Assert(body.contains("aging_hits") && body["aging_hits"] == 3, "aging_hits is %s, expected the consumer's hits_older_than_1h count, 3",
             shown(body, "aging_hits"));
  ctx.Assert(readNear(body, "hits_older_than_1h_share", 0.3), "hits_older_than_1h_share is %s, expected 3 / 10 hits = 0.3",
             shown(body, "hits_older_than_1h_share"));
}

void CheckAutomated(harness::Ctx& ctx) {
  auto c = readServer(ctx);
  readCounters(ctx, "stats:acme:2024-06", kFull);
  auto r = readGet(c, "acme", "2024-06", "acme");
  ctx.Equal(r.Status, 200, "stats (%s)", r.Text());
  const auto body = readBody(ctx, r);
  ctx.Assert(readNear(body, "hit_rate", 0.5), "hit_rate is %s, expected 0.5", shown(body, "hit_rate"));
  ctx.Assert(readNear(body, "hit_rate_automated", 0.9), "hit_rate_automated is %s, expected 9 automated hits / 10 automated lookups = 0.9",
             shown(body, "hit_rate_automated"));
  ctx.Assert(readNear(body, "automated_share", 0.5), "automated_share is %s, expected 10 automated lookups / 20 lookups = 0.5",
             shown(body, "automated_share"));
  ctx.Assert(readNear(body, "avg_similarity", 0.91), "avg_similarity is %s, expected 9.1 / 10 hits = 0.91", shown(body, "avg_similarity"));
}

void CheckScope(harness::Ctx& ctx) {
  auto c = readServer(ctx);
  readCounters(ctx, "stats:all", {{"hits_total", 99}, {"misses_total", 1}, {"similarity_sum", 90}});
  readCounters(ctx, "stats:acme:2024-06", kFull);
  readCounters(ctx, "stats:acme:2024-07", {{"hits_total", 1}, {"misses_total", 9}, {"similarity_sum", 0.9}});
  auto r = readGet(c, "acme", "2024-06", "acme");
  auto body = readBody(ctx, r);
  ctx.Assert(readNear(body, "hit_rate", 0.5), "acme 2024-06 reports hit_rate %s, expected 0.5 from stats:acme:2024-06 (not another hash's numbers)",
             shown(body, "hit_rate"));
  r = readGet(c, "acme", "2024-07", "acme");
  body = readBody(ctx, r);
  ctx.Assert(readNear(body, "hit_rate", 0.1), "acme 2024-07 reports hit_rate %s, expected 0.1 from stats:acme:2024-07", shown(body, "hit_rate"));
  r = readGet(c, "acme", "", "acme");
  ctx.Equal(r.Status, 400, "a request without model_version");
  r = readGet(c, "globex", "2024-06", "globex");
  ctx.Equal(r.Status, 200, "a tenant with no traffic (%s)", r.Text());
  body = readBody(ctx, r);
  for (const std::string field : {"hit_rate", "hit_rate_automated", "automated_share", "avg_similarity", "hits_older_than_1h_share"}) {
    ctx.Assert(readNear(body, field, 0), "%s is %s for a tenant with no traffic, expected 0.0 (no NaN, no division error)", field,
               shown(body, field));
  }
}
`,
  },
  debrief: `The report has the same scope as the counters because that is the only honest scope: the consumer keys its hash by tenant and model version, so the endpoint reads one hash and answers for one pair, and the caller check keeps that pair the caller's own. The automated split and the age share are there because a hit rate without them is a number with no meaning: a crawler re-asking one question inflates it, and a cache whose hits are all a day old is degrading in a way the rate alone hides. Guarding every division keeps a quiet tenant from reporting NaN. A production report also windows the counters (the last hour, the last day) instead of totals since the hash was created, and exposes them as metrics for alerting rather than as an endpoint to poll.`,
};
