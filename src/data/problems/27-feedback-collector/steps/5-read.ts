import type {Step} from '@/lib/types';

/**
 * Step 5 — the read endpoint. A model version's satisfaction is only published when it has enough
 * samples, over a window from a documented set, and the cached score expires.
 */
export const readStep: Step = {
  id: 'read',
  title: 'GET /v1/models/{v}/satisfaction: aggregates with an honesty floor',
  concept: 'http',
  file: 'read',
  focus: ['client', 'collector', 'db', 'redis'],
  sequence: {
    participants: ['Client', 'Feedback Collector', 'feedback store'],
    messages: [
      {
        from: 'Client',
        to: 'Feedback Collector',
        label: 'GET /v1/models/{version}/satisfaction?window=24h',
        kind: 'sync',
      },
      {
        from: 'Feedback Collector',
        to: 'Feedback Collector',
        label: 'window in the documented set? otherwise 400',
        kind: 'sync',
      },
      {
        from: 'Feedback Collector',
        to: 'feedback store',
        label: 'counts(model_version, since = now − window)',
        kind: 'sync',
      },
      {from: 'feedback store', to: 'Feedback Collector', label: 'total, positive', kind: 'reply'},
      {
        from: 'Feedback Collector',
        to: 'Feedback Collector',
        label: 'total < 50 → insufficient_data, no score',
        kind: 'sync',
      },
      {from: 'Feedback Collector', to: 'Client', label: '200 · {samples, score | insufficient_data}', kind: 'reply'},
    ],
  },
  task: `## Task

**Review premise.** You are the AI platform engineer on call. A model version that shipped an hour ago
already shows a healthy satisfaction score, because the endpoint aggregated all time and inherited the
previous model's reputation. The model-generated handler below also serves a cached score that never
refreshes after a bad release, and it lets the caller pass \`?window=all\` to choose whatever sample set
flatters the number.

Review \`read\` and make the score honest.

- Route \`GET /v1/models/{version}/satisfaction\`. The window comes from a documented set — \`1h\`, \`24h\`,
  \`7d\` (default \`24h\`) — and anything else is \`400\`; a caller must not be able to shrink the sample
  set to cherry-pick.
- Refuse to publish a score below \`MIN_SAMPLES = 50\`. A fresh version answers with its sample count and
  \`insufficient_data\` rather than a number built on three votes.
- Aggregate only the recent window: compute \`since = now − WINDOW_SECONDS[window]\` and count the ratings
  inside it, so a fresh version cannot inherit an old model's reputation.
- Cache the aggregate for a short TTL (\`CACHE_TTL_SECONDS = 60\`) keyed by version and window, and track
  \`cached_at\`, so the score reflects feedback up to the last minute instead of a value frozen at the
  bad release.

**Failure mode the checks target.** An all-time aggregate plus an eternal cache is how a fresh model
inherits the last one's score, and an open window parameter is how the sample set becomes a choice
rather than a fact. The checks below require the honesty floor, the constrained window, the recent
aggregate and the expiring cache.`,
  hints: [
    'The window is a whitelist, not a free parameter: keep the documented set in `ALLOWED_WINDOWS` and answer `400` for anything else. Default to `24h`, never to `all`.',
    'Compute `since` from `WINDOW_SECONDS[window]` and ask the store for counts inside that window — the aggregate must not be able to fall back to all time.',
    'Refuse to publish below `MIN_SAMPLES = 50`: report `samples` and `insufficient_data`. Cache the result with `CACHE_TTL_SECONDS = 60` and a `cached_at` stamp so a bad release cannot freeze the score forever.',
  ],
  checks: [
    {
      id: 'route',
      title: 'Handles GET /v1/models/{version}/satisfaction',
      detail:
        'Register the satisfaction route on `GET /v1/models/{version}/satisfaction` and read the model version from the path.',
      match: {
        python: {all: [/@app\.get\(\s*["']\/v1\/models\/\{version\}\/satisfaction["']\)/]},
        typescript: {all: [/app\.get\(\s*['"]\/v1\/models\/:version\/satisfaction['"]/]},
        go: {all: [/HandleFunc\(\s*"GET \/v1\/models\/\{version\}\/satisfaction"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"models"\s*\/\s*Segment\s*\/\s*"satisfaction"\s*\)/, /\bget\s*\{/]},
        cpp: {all: [/svr\.Get\(/, /\/v1\/models\/.*satisfaction/]},
      },
    },
    {
      id: 'min-samples',
      title: 'Refuses to publish a score below 50 samples',
      detail:
        'With fewer than `MIN_SAMPLES = 50` ratings, answer with the sample count and `insufficient_data` instead of a score, so a fresh version cannot look measured.',
      match: {
        python: {all: [/MIN_SAMPLES\s*=\s*50/, /insufficient/]},
        typescript: {all: [/MIN_SAMPLES\s*=\s*50/, /insufficient/]},
        go: {all: [/minSamples\s*=\s*50/, /insufficient/]},
        scala: {all: [/MinSamples\s*=\s*50/, /[Ii]nsufficient/]},
        cpp: {all: [/kMinSamples\s*=\s*50/, /insufficient/]},
      },
    },
    {
      id: 'window-set',
      title: 'The window parameter is constrained to the documented set',
      detail:
        'Accept only the documented windows (`1h`, `24h`, `7d`) from `ALLOWED_WINDOWS` and answer `400` otherwise, so a caller cannot shrink the sample set to cherry-pick a score.',
      match: {
        python: {all: [/ALLOWED_WINDOWS/, /status_code\s*=\s*400/]},
        typescript: {all: [/ALLOWED_WINDOWS/, /code\(\s*400\s*\)/]},
        go: {all: [/allowedWindows/, /StatusBadRequest/]},
        scala: {all: [/AllowedWindows/, /StatusCodes\.BadRequest/]},
        cpp: {all: [/kAllowedWindows/, /\b400\b/]},
      },
    },
    {
      id: 'fresh-window',
      title: 'The score reflects the recent window, not all time',
      detail:
        'Compute `since` from `WINDOW_SECONDS[window]` and aggregate only the ratings inside it; an all-time aggregate is how a fresh version inherits an old model\u2019s reputation.',
      match: {
        python: {all: [/WINDOW_SECONDS/, /since\s*=/], none: [/all_time|ALL_TIME/]},
        typescript: {all: [/WINDOW_SECONDS/, /since\s*=/], none: [/allTime|ALL_TIME/]},
        go: {all: [/windowSeconds/, /since\s*:=/], none: [/allTime|AllTime/]},
        scala: {all: [/WindowSeconds/, /since\s*=/], none: [/AllTime|allTime/]},
        cpp: {all: [/kWindowSeconds/, /since\s*=/], none: [/kAllTime|AllTime/]},
      },
    },
    {
      id: 'cache-refresh',
      title: 'The cached score expires',
      detail:
        'Cache the aggregate for `CACHE_TTL_SECONDS = 60` with a `cached_at` stamp, so a bad release cannot freeze the score forever and the number reflects feedback up to the last minute.',
      match: {
        python: {all: [/CACHE_TTL_SECONDS\s*=\s*60/, /cached_at/]},
        typescript: {all: [/CACHE_TTL_SECONDS\s*=\s*60/, /cachedAt/]},
        go: {all: [/cacheTtlSeconds\s*=\s*60/, /cachedAt/]},
        scala: {all: [/CacheTtlSeconds\s*=\s*60/, /cachedAt/]},
        cpp: {all: [/kCacheTtlSeconds\s*=\s*60/, /cachedAt/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import logging

from fastapi import FastAPI
from fastapi.responses import JSONResponse

app = FastAPI()
logger = logging.getLogger("feedback")

SCORE_CACHE: dict[str, dict] = {}


class SatisfactionStore:
    """The aggregate counts behind one model version."""

    def all_time_totals(self, model_version: str) -> dict:
        raise NotImplementedError


satisfaction = SatisfactionStore()


@app.get("/v1/models/{version}/satisfaction")
def read_satisfaction(version: str, window: str = "all") -> JSONResponse:
    # TODO: this draft serves a cache that never expires after a bad release, aggregates over all
    # time so a fresh version inherits an old model's reputation, and lets ?window= shrink the
    # sample set. Review all three.
    if version in SCORE_CACHE:
        return JSONResponse(SCORE_CACHE[version])
    counts = satisfaction.all_time_totals(version)
    samples = counts["total"]
    body = {
        "model_version": version,
        "window": window,
        "samples": samples,
        "score": counts["positive"] / samples if samples else 0.0,
    }
    SCORE_CACHE[version] = body
    return JSONResponse(body)
`,
      solution: `import logging
import time

from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse

app = FastAPI()
logger = logging.getLogger("feedback")

MIN_SAMPLES = 50
CACHE_TTL_SECONDS = 60
WINDOW_SECONDS = {"1h": 3600, "24h": 86400, "7d": 7 * 86400}
ALLOWED_WINDOWS = {"1h", "24h", "7d"}


class SatisfactionStore:
    """The aggregate counts behind one model version."""

    def counts(self, model_version: str, since: float) -> dict:
        raise NotImplementedError


satisfaction = SatisfactionStore()


class CacheEntry:
    def __init__(self, value: dict) -> None:
        self.cached_at = time.time()
        self.value = value


_cache: dict[str, CacheEntry] = {}


def cached(key: str, compute) -> dict:
    entry = _cache.get(key)
    if entry is not None and time.time() - entry.cached_at < CACHE_TTL_SECONDS:
        return entry.value
    value = compute()
    _cache[key] = CacheEntry(value)
    return value


@app.get("/v1/models/{version}/satisfaction")
def read_satisfaction(version: str, window: str = "24h") -> JSONResponse:
    if window not in ALLOWED_WINDOWS:
        raise HTTPException(status_code=400, detail="unknown window")

    def compute() -> dict:
        since = time.time() - WINDOW_SECONDS[window]
        counts = satisfaction.counts(version, since)
        samples = counts["total"]
        if samples < MIN_SAMPLES:
            return {
                "model_version": version,
                "window": window,
                "samples": samples,
                "status": "insufficient_data",
            }
        return {
            "model_version": version,
            "window": window,
            "samples": samples,
            "score": counts["positive"] / samples,
            "status": "ok",
        }

    return JSONResponse(cached(f"{version}:{window}", compute))
`,
    },
    typescript: {
      starter: `/** GET /v1/models/{version}/satisfaction. */
import Fastify from 'fastify';

const SCORE_CACHE = new Map<string, unknown>();

export const app = Fastify();

export interface SatisfactionCounts {
  total: number;
  positive: number;
}

export class SatisfactionStore {
  async allTimeTotals(modelVersion: string): Promise<SatisfactionCounts> {
    throw new Error('not implemented');
  }
}

export const satisfaction = new SatisfactionStore();

app.get('/v1/models/:version/satisfaction', async (request, reply) => {
  // TODO: this draft serves a cache that never expires after a bad release, aggregates over all
  // time so a fresh version inherits an old model's reputation, and lets ?window= shrink the
  // sample set. Review all three.
  const {version} = request.params as {version: string};
  const window = (request.query as {window?: string}).window ?? 'all';
  const hit = SCORE_CACHE.get(version);
  if (hit !== undefined) return reply.code(200).send(hit);
  const counts = await satisfaction.allTimeTotals(version);
  const body = {
    model_version: version,
    window,
    samples: counts.total,
    score: counts.total === 0 ? 0 : counts.positive / counts.total,
  };
  SCORE_CACHE.set(version, body);
  return reply.code(200).send(body);
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** GET /v1/models/{version}/satisfaction: an honest, expiring aggregate. */
import Fastify from 'fastify';

const MIN_SAMPLES = 50;
const CACHE_TTL_SECONDS = 60;
const WINDOW_SECONDS: Record<string, number> = {'1h': 3600, '24h': 86400, '7d': 7 * 86400};
const ALLOWED_WINDOWS = Object.keys(WINDOW_SECONDS);

export const app = Fastify();

export interface SatisfactionCounts {
  total: number;
  positive: number;
}

export class SatisfactionStore {
  async counts(modelVersion: string, since: number): Promise<SatisfactionCounts> {
    throw new Error('not implemented');
  }
}

export const satisfaction = new SatisfactionStore();

interface CacheEntry {
  cachedAt: number;
  value: unknown;
}

const cache = new Map<string, CacheEntry>();

async function cached(key: string, compute: () => Promise<unknown>): Promise<unknown> {
  const hit = cache.get(key);
  if (hit !== undefined && Date.now() - hit.cachedAt < CACHE_TTL_SECONDS * 1000) return hit.value;
  const value = await compute();
  cache.set(key, {cachedAt: Date.now(), value});
  return value;
}

app.get('/v1/models/:version/satisfaction', async (request, reply) => {
  const {version} = request.params as {version: string};
  const window = (request.query as {window?: string}).window ?? '24h';
  if (!ALLOWED_WINDOWS.includes(window)) return reply.code(400).send({error: 'unknown window'});

  const body = await cached(\`\${version}:\${window}\`, async () => {
    const since = Date.now() / 1000 - WINDOW_SECONDS[window];
    const counts = await satisfaction.counts(version, since);
    if (counts.total < MIN_SAMPLES) {
      return {model_version: version, window, samples: counts.total, status: 'insufficient_data'};
    }
    return {
      model_version: version,
      window,
      samples: counts.total,
      score: counts.positive / counts.total,
      status: 'ok',
    };
  });
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
	"log"
	"net/http"
)

type counts struct {
	total    int
	positive int
}

var scoreCache = map[string]map[string]any{}

type SatisfactionStore struct{}

func (s *SatisfactionStore) AllTimeTotals(ctx context.Context, modelVersion string) (counts, error) {
	return counts{}, nil
}

var satisfaction = &SatisfactionStore{}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	_ = json.NewEncoder(rw).Encode(body)
}

func readSatisfaction(rw http.ResponseWriter, r *http.Request) {
	// TODO: this draft serves a cache that never expires after a bad release, aggregates over all
	// time so a fresh version inherits an old model's reputation, and lets ?window= shrink the
	// sample set. Review all three.
	version := r.PathValue("version")
	window := r.URL.Query().Get("window")
	if window == "" {
		window = "all"
	}
	if hit, ok := scoreCache[version]; ok {
		writeJSON(rw, http.StatusOK, hit)
		return
	}
	totals, _ := satisfaction.AllTimeTotals(r.Context(), version)
	body := map[string]any{
		"model_version": version,
		"window":        window,
		"samples":       totals.total,
		"score":         float64(totals.positive) / float64(totals.total),
	}
	scoreCache[version] = body
	writeJSON(rw, http.StatusOK, body)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/models/{version}/satisfaction", readSatisfaction)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"time"
)

const (
	minSamples      = 50
	cacheTtlSeconds = 60
)

var windowSeconds = map[string]int64{"1h": 3600, "24h": 86400, "7d": 7 * 86400}

var allowedWindows = map[string]bool{"1h": true, "24h": true, "7d": true}

type counts struct {
	total    int
	positive int
}

type cacheEntry struct {
	cachedAt time.Time
	value    map[string]any
}

var satisfactionCache = map[string]cacheEntry{}

type SatisfactionStore struct{}

func (s *SatisfactionStore) Counts(ctx context.Context, modelVersion string, since time.Time) (counts, error) {
	return counts{}, nil
}

var satisfaction = &SatisfactionStore{}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	_ = json.NewEncoder(rw).Encode(body)
}

func readSatisfaction(rw http.ResponseWriter, r *http.Request) {
	version := r.PathValue("version")
	window := r.URL.Query().Get("window")
	if window == "" {
		window = "24h"
	}
	if !allowedWindows[window] {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "unknown window"})
		return
	}
	key := version + ":" + window
	if hit, ok := satisfactionCache[key]; ok && time.Since(hit.cachedAt) < time.Duration(cacheTtlSeconds)*time.Second {
		writeJSON(rw, http.StatusOK, hit.value)
		return
	}
	since := time.Now().Add(-time.Duration(windowSeconds[window]) * time.Second)
	totals, err := satisfaction.Counts(r.Context(), version, since)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	body := map[string]any{
		"model_version": version,
		"window":        window,
		"samples":       totals.total,
	}
	if totals.total < minSamples {
		body["status"] = "insufficient_data"
	} else {
		body["score"] = float64(totals.positive) / float64(totals.total)
		body["status"] = "ok"
	}
	satisfactionCache[key] = cacheEntry{cachedAt: time.Now(), value: body}
	writeJSON(rw, http.StatusOK, body)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/models/{version}/satisfaction", readSatisfaction)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
    },
    scala: {
      starter: `package feedback

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model.StatusCodes
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class Satisfaction(model_version: String, window: String, samples: Int, score: Double)

object SatisfactionApi {
  implicit val system: ActorSystem = ActorSystem("feedback-read")
  implicit val satisfactionFormat: RootJsonFormat[Satisfaction] = jsonFormat4(Satisfaction)

  private var scoreCache: Map[String, Satisfaction] = Map.empty

  val route: Route =
    path("v1" / "models" / Segment / "satisfaction") { version =>
      get {
        parameter("window".?) { windowOpt =>
          // TODO: this draft serves a cache that never expires after a bad release, aggregates over
          // all time so a fresh version inherits an old model's reputation, and lets ?window=
          // shrink the sample set. Review all three.
          scoreCache.get(version) match {
            case Some(body) =>
              complete(StatusCodes.OK, body)
            case None =>
              val totals = satisfaction.allTimeTotals(version)
              val body = Satisfaction(
                version,
                windowOpt.getOrElse("all"),
                totals.total,
                totals.positive.toDouble / totals.total,
              )
              scoreCache = scoreCache.updated(version, body)
              complete(StatusCodes.OK, body)
          }
        }
      }
    }

  def main(args: Array[String]): Unit = {
    Http().newServerAt("0.0.0.0", 8443).bind(route)
  }
}
`,
      solution: `package feedback

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model.StatusCodes
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class Satisfaction(
    model_version: String,
    window: String,
    samples: Int,
    score: Option[Double],
    status: String,
)

final case class Totals(total: Int, positive: Int)

object SatisfactionApi {
  val MinSamples = 50
  val CacheTtlSeconds = 60
  val WindowSeconds = Map("1h" -> 3600L, "24h" -> 86400L, "7d" -> 7L * 86400L)
  val AllowedWindows = WindowSeconds.keySet

  implicit val system: ActorSystem = ActorSystem("feedback-read")
  implicit val satisfactionFormat: RootJsonFormat[Satisfaction] = jsonFormat5(Satisfaction)

  private var cache: Map[String, (Long, Satisfaction)] = Map.empty

  val route: Route =
    path("v1" / "models" / Segment / "satisfaction") { version =>
      get {
        parameter("window".?) { windowOpt =>
          val window = windowOpt.getOrElse("24h")
          if (!AllowedWindows.contains(window)) {
            complete(StatusCodes.BadRequest, """{"error":"unknown window"}""")
          } else {
            val key = s"$version:$window"
            val now = System.currentTimeMillis()
            cache.get(key) match {
              case Some((cachedAt, body)) if now - cachedAt < CacheTtlSeconds * 1000L =>
                complete(StatusCodes.OK, body)
              case _ =>
                val since = now - WindowSeconds(window) * 1000L
                val totals = satisfaction.counts(version, since)
                val body =
                  if (totals.total < MinSamples)
                    Satisfaction(version, window, totals.total, None, "insufficient_data")
                  else
                    Satisfaction(version, window, totals.total, Some(totals.positive.toDouble / totals.total), "ok")
                cache = cache.updated(key, (now, body))
                complete(StatusCodes.OK, body)
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

#include <map>
#include <string>

using json = nlohmann::json;

std::map<std::string, json> scoreCache;

struct SatisfactionStore {
  json allTimeTotals(const std::string& modelVersion);
};

SatisfactionStore satisfaction;

int main() {
  httplib::Server svr;

  svr.Get(R"(/v1/models/([^/]+)/satisfaction)", [](const httplib::Request& req, httplib::Response& res) {
    // TODO: this draft serves a cache that never expires after a bad release, aggregates over all
    // time so a fresh version inherits an old model's reputation, and lets ?window= shrink the
    // sample set. Review all three.
    const std::string version = req.matches[1];
    const auto hit = scoreCache.find(version);
    if (hit != scoreCache.end()) {
      res.status = 200;
      res.set_content(hit->second.dump(), "application/json");
      return;
    }
    const json totals = satisfaction.allTimeTotals(version);
    const json body = {
        {"model_version", version},
        {"window", req.has_param("window") ? req.get_param_value("window") : "all"},
        {"samples", totals.at("total")},
        {"score", totals.at("positive").get<double>() / totals.at("total").get<double>()},
    };
    scoreCache[version] = body;
    res.status = 200;
    res.set_content(body.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <chrono>
#include <map>
#include <set>
#include <string>

using json = nlohmann::json;

constexpr int kMinSamples = 50;
constexpr int kCacheTtlSeconds = 60;

const std::map<std::string, long long> kWindowSeconds = {{"1h", 3600}, {"24h", 86400}, {"7d", 7 * 86400}};
const std::set<std::string> kAllowedWindows = {"1h", "24h", "7d"};

struct CacheEntry {
  long long cachedAt;
  json value;
};

std::map<std::string, CacheEntry> satisfactionCache;

struct SatisfactionStore {
  json counts(const std::string& modelVersion, long long sinceMillis);
};

SatisfactionStore satisfaction;

int main() {
  httplib::Server svr;

  svr.Get(R"(/v1/models/([^/]+)/satisfaction)", [](const httplib::Request& req, httplib::Response& res) {
    const std::string version = req.matches[1];
    const std::string window = req.has_param("window") ? req.get_param_value("window") : "24h";
    if (kAllowedWindows.count(window) == 0) {
      res.status = 400;
      res.set_content(R"({"error":"unknown window"})", "application/json");
      return;
    }
    const std::string key = version + ":" + window;
    const long long now = std::chrono::duration_cast<std::chrono::milliseconds>(
                              std::chrono::system_clock::now().time_since_epoch())
                              .count();
    const auto hit = satisfactionCache.find(key);
    if (hit != satisfactionCache.end() && now - hit->second.cachedAt < kCacheTtlSeconds * 1000LL) {
      res.status = 200;
      res.set_content(hit->second.value.dump(), "application/json");
      return;
    }
    const long long since = now - kWindowSeconds.at(window) * 1000LL;
    const json totals = satisfaction.counts(version, since);
    json body = {
        {"model_version", version},
        {"window", window},
        {"samples", totals.at("total")},
    };
    if (totals.at("total").get<int>() < kMinSamples) {
      body["status"] = "insufficient_data";
    } else {
      body["score"] = totals.at("positive").get<double>() / totals.at("total").get<double>();
      body["status"] = "ok";
    }
    satisfactionCache[key] = CacheEntry{now, body};
    res.status = 200;
    res.set_content(body.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  debrief: `A satisfaction number is a claim, and the honesty floor is what makes it one: below 50 samples
the only truthful answer is the sample count, because a score over three votes is noise wearing a
decimal point. The window is the other half — an all-time aggregate lets a fresh model inherit the
previous model's reputation, and an open \`window\` parameter lets the caller pick whichever sample set
flatters the number.

The cache is a correctness problem, not a performance one: a score cached without an expiry keeps
serving the pre-release value until someone clears it by hand. A short TTL keyed by version and window
bounds how stale the number can be. Real systems separate "the score for the window" from "the
confidence in it", and often expose the unattributed share beside the score so a big attribution gap is
visible instead of being averaged away.`,
};
