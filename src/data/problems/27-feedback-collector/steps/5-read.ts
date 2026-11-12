import type {Step} from '@/lib/types';

export const readStep: Step = {
  id: 'read',
  title: 'GET satisfaction: a recent window, a sample floor and a 60-second cache',
  concept: 'http',
  guides: ['honest-reads', 'keys-and-expiry'],
  file: 'read',
  focus: ['client', 'collector', 'redis'],
  task: `## Task

**Starting point.** \`read\` serves \`GET /v1/models/{version}/satisfaction\`: it echoes \`?window=\`
(default \`all\`), reads \`store.totals(version)\`, the counters since the model shipped, answers
\`{model_version, window, samples, status: "ok", score}\` with \`score = positive / samples\`, and keeps
that body in \`SCORE_CACHE[version]\` for good. It serves the demo and hides four flaws.

**Failure mode the checks target.** A prompt change sinks the model today and the dashboard stays
green: last week's votes dominate the all-time counters, the cached score does not refresh, three votes
read as a verdict, and any window a caller types is accepted.

- \`window\` is a key of \`WINDOW_HOURS\` (\`1h\`: 1, \`24h\`: 24, \`7d\`: 168), default \`24h\`; anything
  else is **400**.
- Sum \`store.hour_totals(version, h)\` over the window's hour buckets, \`h\` from
  \`now // 3600 - hours + 1\` to \`now // 3600\`.
- Below \`MIN_SAMPLES = 50\` the body has \`status: "insufficient_data"\` and \`score: null\`.
- Cache each body for \`CACHE_TTL_S = 60\` seconds per \`(version, window)\`.`,
  sequence: {
    participants: ['Dashboard', 'feedbackd', 'Redis'],
    messages: [
      {
        from: 'Dashboard',
        to: 'feedbackd',
        label: 'GET /v1/models/support-llm-2026-09/satisfaction?window=24h',
        kind: 'sync',
      },
      {
        from: 'feedbackd',
        to: 'feedbackd',
        label: 'window in WINDOW_HOURS? cache (version, 24h) younger than 60 s?',
        kind: 'sync',
      },
      {from: 'feedbackd', to: 'Redis', label: 'HGETALL quality:{version}:{h} for the last 24 hours', kind: 'sync'},
      {
        from: 'feedbackd',
        to: 'Dashboard',
        label: '{samples: 60, status: "ok", score: 0.25} · below 50: insufficient_data',
        kind: 'reply',
      },
    ],
  },
  checks: [
    {
      id: 'window',
      title: 'The window comes from a fixed set',
      detail:
        'The window is one of `1h`, `24h`, `7d` (`WINDOW_HOURS`), `24h` by default, and anything else is `400`; the starter echoes whatever the caller sent and defaults to `all`.',
      match: {
        python: {all: [/WINDOW_HOURS/, /\b400\b/], none: [/["']all["']/]},
        typescript: {all: [/WINDOW_HOURS/, /\b400\b/], none: [/['"]all['"]/]},
        go: {all: [/windowHours/, /StatusBadRequest|\b400\b/], none: [/"all"/]},
        scala: {all: [/WindowHours/, /BadRequest|\b400\b/], none: [/"all"/]},
        cpp: {all: [/kWindowHours/, /\b400\b/], none: [/"all"/]},
      },
    },
    {
      id: 'recent-window',
      title: 'Counts only the ratings inside the window',
      detail:
        "The score sums the hour buckets of the window (`hour_totals`), so a version's past does not hide its present; the starter reads the counters since the model shipped.",
      match: {
        python: {all: [/store\.hour_totals\(/], none: [/store\.totals\(/]},
        typescript: {all: [/hourTotals\(/], none: [/\btotals\(/]},
        go: {all: [/store\.HourTotals\(/], none: [/store\.Totals\(/]},
        scala: {all: [/Store\.hourTotals\(/], none: [/Store\.totals\(/]},
        cpp: {all: [/store::hourTotals\(/], none: [/store::totals\(/]},
      },
    },
    {
      id: 'sample-floor',
      title: 'Below 50 samples there is no score',
      detail:
        'Under `MIN_SAMPLES` (50) ratings the body says `insufficient_data` with a null score; the starter turns three votes into a percentage.',
      match: {
        python: {all: [/MIN_SAMPLES\s*=\s*50\b/, /insufficient_data/]},
        typescript: {all: [/MIN_SAMPLES\s*=\s*50\b/, /insufficient_data/]},
        go: {all: [/minSamples\s*=\s*50\b/, /insufficient_data/]},
        scala: {all: [/MinSamples\s*=\s*50\b/, /insufficient_data/]},
        cpp: {all: [/kMinSamples\s*=\s*50\b/, /insufficient_data/]},
      },
    },
    {
      id: 'cache-ttl',
      title: 'The score is cached for 60 seconds per version and window',
      detail:
        'A body is reused for `CACHE_TTL_S` (60 s) and only for the same version and window; the starter keys the cache by version alone and keeps it forever.',
      match: {
        python: {all: [/CACHE_TTL_S\s*=\s*60\b/, /time\.time\(\)|time\.monotonic\(\)/]},
        typescript: {all: [/CACHE_TTL_MS\s*=\s*60_?000\b/, /Date\.now\(\)/]},
        go: {all: [/cacheTTL\s*=\s*(60\s*\*\s*time\.Second|time\.Minute)/, /time\.Now\(\)/]},
        scala: {all: [/CacheTtlMillis\s*=\s*(60000|60\s*\*\s*1000)L?\b/, /System\.currentTimeMillis\(\)/]},
        cpp: {all: [/kCacheTtl\{60\}/, /_clock::now\(\)/]},
      },
    },
  ],
  code: {
    python: {
      starter: `from fastapi import FastAPI, Request

from feedback import store  # totals, hour_totals

app = FastAPI()

SCORE_CACHE: dict[str, dict] = {}


@app.get("/v1/models/{version}/satisfaction")
def satisfaction(version: str, request: Request) -> dict:
    """The share of thumbs-up among the ratings of a model version."""
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    window = request.query_params.get("window", "all")
    cached = SCORE_CACHE.get(version)
    if cached is not None:
        return cached
    samples, positive = store.totals(version)
    body = {"model_version": version, "window": window, "samples": samples, "status": "ok", "score": positive / samples if samples else 0.0}
    SCORE_CACHE[version] = body
    return body
`,
      solution: `import time

from fastapi import FastAPI, HTTPException, Request

from feedback import store  # totals, hour_totals

app = FastAPI()

WINDOW_HOURS = {"1h": 1, "24h": 24, "7d": 168}
MIN_SAMPLES = 50
CACHE_TTL_S = 60

# (version, window) -> (computed at, body)
SCORE_CACHE: dict[tuple[str, str], tuple[float, dict]] = {}


@app.get("/v1/models/{version}/satisfaction")
def satisfaction(version: str, request: Request) -> dict:
    """The share of thumbs-up among the ratings of a model version."""
    window = request.query_params.get("window", "24h")
    if window not in WINDOW_HOURS:
        raise HTTPException(status_code=400, detail="window must be 1h, 24h or 7d")
    now = time.time()
    cached = SCORE_CACHE.get((version, window))
    if cached is not None and now - cached[0] < CACHE_TTL_S:
        return cached[1]
    hour = int(now // 3600)
    samples = positive = 0
    for h in range(hour - WINDOW_HOURS[window] + 1, hour + 1):
        s, p = store.hour_totals(version, h)
        samples += s
        positive += p
    body = {"model_version": version, "window": window, "samples": samples}
    if samples < MIN_SAMPLES:
        body.update(status="insufficient_data", score=None)
    else:
        body.update(status="ok", score=positive / samples)
    SCORE_CACHE[(version, window)] = (now, body)
    return body
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';

import {hourTotals, totals} from 'feedback/store';

export const app = Fastify();

const SCORE_CACHE = new Map<string, Record<string, unknown>>();

app.get('/v1/models/:version/satisfaction', async request => {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const {version} = request.params as {version: string};
  const {window = 'all'} = request.query as {window?: string};
  const cached = SCORE_CACHE.get(version);
  if (cached !== undefined) return cached;
  const [samples, positive] = await totals(version);
  const body = {model_version: version, window, samples, status: 'ok', score: samples > 0 ? positive / samples : 0};
  SCORE_CACHE.set(version, body);
  return body;
});

void hourTotals;
`,
      solution: `import Fastify from 'fastify';

import {hourTotals} from 'feedback/store';

export const app = Fastify();

const WINDOW_HOURS: Record<string, number> = {'1h': 1, '24h': 24, '7d': 168};
const MIN_SAMPLES = 50;
const CACHE_TTL_MS = 60_000;

/** version/window → when the body was computed, and the body. */
const SCORE_CACHE = new Map<string, {at: number; body: Record<string, unknown>}>();

app.get('/v1/models/:version/satisfaction', async (request, reply) => {
  const {version} = request.params as {version: string};
  const {window = '24h'} = request.query as {window?: string};
  if (!Object.hasOwn(WINDOW_HOURS, window)) return reply.code(400).send({error: 'window must be 1h, 24h or 7d'});
  const now = Date.now();
  const key = \`\${version}/\${window}\`;
  const cached = SCORE_CACHE.get(key);
  if (cached !== undefined && now - cached.at < CACHE_TTL_MS) return cached.body;
  const hour = Math.floor(now / 3_600_000);
  let samples = 0;
  let positive = 0;
  for (let h = hour - WINDOW_HOURS[window] + 1; h <= hour; h += 1) {
    const [s, p] = await hourTotals(version, h);
    samples += s;
    positive += p;
  }
  const body =
    samples < MIN_SAMPLES
      ? {model_version: version, window, samples, status: 'insufficient_data', score: null}
      : {model_version: version, window, samples, status: 'ok', score: positive / samples};
  SCORE_CACHE.set(key, {at: now, body});
  return body;
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"net/http"

	"feedback/store" // store.Totals, HourTotals
)

var scoreCache = map[string]map[string]any{}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

// satisfaction is the share of thumbs-up among the ratings of a model version.
func satisfaction(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	version := r.PathValue("version")
	window := r.URL.Query().Get("window")
	if window == "" {
		window = "all"
	}
	if cached, ok := scoreCache[version]; ok {
		writeJSON(rw, http.StatusOK, cached)
		return
	}
	samples, positive, err := store.Totals(r.Context(), version)
	if err != nil {
		http.Error(rw, err.Error(), http.StatusInternalServerError)
		return
	}
	score := 0.0
	if samples > 0 {
		score = float64(positive) / float64(samples)
	}
	body := map[string]any{"model_version": version, "window": window, "samples": samples, "status": "ok", "score": score}
	scoreCache[version] = body
	writeJSON(rw, http.StatusOK, body)
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/models/{version}/satisfaction", satisfaction)
}
`,
      solution: `package main

import (
	"encoding/json"
	"net/http"
	"time"

	"feedback/store" // store.Totals, HourTotals
)

const (
	minSamples = 50
	cacheTTL   = 60 * time.Second
)

var windowHours = map[string]int64{"1h": 1, "24h": 24, "7d": 168}

type cachedScore struct {
	at   time.Time
	body map[string]any
}

// scoreCache is keyed by version and window.
var scoreCache = map[string]cachedScore{}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

// satisfaction is the share of thumbs-up among the ratings of a model version.
func satisfaction(rw http.ResponseWriter, r *http.Request) {
	version := r.PathValue("version")
	window := r.URL.Query().Get("window")
	if window == "" {
		window = "24h"
	}
	hours, ok := windowHours[window]
	if !ok {
		http.Error(rw, "window must be 1h, 24h or 7d", http.StatusBadRequest)
		return
	}
	now := time.Now()
	key := version + "/" + window
	if cached, ok := scoreCache[key]; ok && now.Sub(cached.at) < cacheTTL {
		writeJSON(rw, http.StatusOK, cached.body)
		return
	}
	hour := now.Unix() / 3600
	var samples, positive int64
	for h := hour - hours + 1; h <= hour; h++ {
		s, p, err := store.HourTotals(r.Context(), version, h)
		if err != nil {
			http.Error(rw, err.Error(), http.StatusInternalServerError)
			return
		}
		samples += s
		positive += p
	}
	body := map[string]any{"model_version": version, "window": window, "samples": samples, "status": "ok", "score": nil}
	if samples < minSamples {
		body["status"] = "insufficient_data"
	} else {
		body["score"] = float64(positive) / float64(samples)
	}
	scoreCache[key] = cachedScore{at: now, body: body}
	writeJSON(rw, http.StatusOK, body)
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/models/{version}/satisfaction", satisfaction)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import feedback.Store // Store.totals, hourTotals

object Read {
  private val scoreCache = scala.collection.mutable.Map.empty[String, JsObject]

  private def json(body: JsObject): HttpResponse =
    HttpResponse(StatusCodes.OK, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  /** The share of thumbs-up among the ratings of a model version. */
  val route: Route = path("v1" / "models" / Segment / "satisfaction") { version =>
    get {
      parameter("window".optional) { windowParam =>
        // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
        val window = windowParam.getOrElse("all")
        val body = scoreCache.getOrElseUpdate(version, {
          val (samples, positive) = Store.totals(version)
          JsObject(
            "model_version" -> JsString(version),
            "window" -> JsString(window),
            "samples" -> JsNumber(samples),
            "status" -> JsString("ok"),
            "score" -> JsNumber(if (samples > 0) positive.toDouble / samples else 0.0))
        })
        complete(json(body))
      }
    }
  }
}
`,
      solution: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import feedback.Store // Store.totals, hourTotals

object Read {
  val WindowHours: Map[String, Long] = Map("1h" -> 1L, "24h" -> 24L, "7d" -> 168L)
  val MinSamples = 50
  val CacheTtlMillis = 60000L

  /** (version, window) → (computed at, body). */
  private val scoreCache = scala.collection.mutable.Map.empty[(String, String), (Long, JsObject)]

  private def json(body: JsObject): HttpResponse =
    HttpResponse(StatusCodes.OK, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  private def compute(version: String, window: String, hours: Long, now: Long): JsObject = {
    val hour = now / 3600000L
    val buckets = (hour - hours + 1 to hour).map(h => Store.hourTotals(version, h))
    val samples = buckets.map(_._1).sum
    val positive = buckets.map(_._2).sum
    val base = Map("model_version" -> JsString(version), "window" -> JsString(window), "samples" -> JsNumber(samples))
    if (samples < MinSamples) JsObject(base ++ Map("status" -> JsString("insufficient_data"), "score" -> JsNull))
    else JsObject(base ++ Map("status" -> JsString("ok"), "score" -> JsNumber(positive.toDouble / samples)))
  }

  /** The share of thumbs-up among the ratings of a model version. */
  val route: Route = path("v1" / "models" / Segment / "satisfaction") { version =>
    get {
      parameter("window".optional) { windowParam =>
        val window = windowParam.getOrElse("24h")
        WindowHours.get(window) match {
          case None => complete(StatusCodes.BadRequest -> "window must be 1h, 24h or 7d")
          case Some(hours) =>
            val now = System.currentTimeMillis()
            val body = scoreCache.get((version, window)) match {
              case Some((at, cached)) if now - at < CacheTtlMillis => cached
              case _ =>
                val fresh = compute(version, window, hours, now)
                scoreCache((version, window)) = (now, fresh)
                fresh
            }
            complete(json(body))
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

#include <map>
#include <string>

#include "feedback/store.h"  // store::totals, hourTotals

using json = nlohmann::json;

std::map<std::string, json> score_cache;

// The share of thumbs-up among the ratings of a model version.
void satisfaction(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const std::string version = req.matches[1];
  const std::string window = req.has_param("window") ? req.get_param_value("window") : "all";
  if (const auto hit = score_cache.find(version); hit != score_cache.end()) {
    res.set_content(hit->second.dump(), "application/json");
    return;
  }
  const auto [samples, positive] = store::totals(version);
  const json body = {{"model_version", version},
                     {"window", window},
                     {"samples", samples},
                     {"status", "ok"},
                     {"score", samples > 0 ? static_cast<double>(positive) / samples : 0.0}};
  score_cache[version] = body;
  res.set_content(body.dump(), "application/json");
}

void register_routes(httplib::Server& svr) { svr.Get(R"(/v1/models/([\\w.-]+)/satisfaction)", satisfaction); }
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <chrono>
#include <map>
#include <string>

#include "feedback/store.h"  // store::totals, hourTotals

using json = nlohmann::json;

const std::map<std::string, long long> kWindowHours = {{"1h", 1}, {"24h", 24}, {"7d", 168}};
constexpr long long kMinSamples = 50;
constexpr std::chrono::seconds kCacheTtl{60};

struct CachedScore {
  std::chrono::system_clock::time_point at;
  json body;
};

// Keyed by version and window.
std::map<std::string, CachedScore> score_cache;

// The share of thumbs-up among the ratings of a model version.
void satisfaction(const httplib::Request& req, httplib::Response& res) {
  const std::string version = req.matches[1];
  const std::string window = req.has_param("window") ? req.get_param_value("window") : "24h";
  const auto hours = kWindowHours.find(window);
  if (hours == kWindowHours.end()) {
    res.status = 400;
    res.set_content("window must be 1h, 24h or 7d", "text/plain");
    return;
  }
  const auto now = std::chrono::system_clock::now();
  const std::string key = version + "/" + window;
  if (const auto hit = score_cache.find(key); hit != score_cache.end() && now - hit->second.at < kCacheTtl) {
    res.set_content(hit->second.body.dump(), "application/json");
    return;
  }
  const long long hour = std::chrono::duration_cast<std::chrono::seconds>(now.time_since_epoch()).count() / 3600;
  long long samples = 0;
  long long positive = 0;
  for (long long h = hour - hours->second + 1; h <= hour; h++) {
    const auto [s, p] = store::hourTotals(version, h);
    samples += s;
    positive += p;
  }
  json body = {{"model_version", version}, {"window", window}, {"samples", samples}};
  if (samples < kMinSamples) {
    body["status"] = "insufficient_data";
    body["score"] = nullptr;
  } else {
    body["status"] = "ok";
    body["score"] = static_cast<double>(positive) / samples;
  }
  score_cache[key] = CachedScore{now, body};
  res.set_content(body.dump(), "application/json");
}

void register_routes(httplib::Server& svr) { svr.Get(R"(/v1/models/([\\w.-]+)/satisfaction)", satisfaction); }
`,
    },
  },
  harness: {
    python: `import time

from feedback import store

VERSION = "support-llm-2026-09"


def _align(ctx):
    """Move the clock to the middle of an hour, so the buckets a check writes are the ones the read sums."""
    ctx.clock.advance(3600 - time.time() % 3600 + 1800)
    return int(time.time())


def _seed(n, positive, at):
    for i in range(n):
        store.record_quality(VERSION, 1 if i < positive else -1, at)


def _api(ctx):
    return ctx.client(ctx.load("read").app)


async def _get(c, query=""):
    return await c.get(f"/v1/models/{VERSION}/satisfaction{query}")


async def check_window(ctx):
    _seed(60, 30, _align(ctx))
    async with _api(ctx) as c:
        default = await _get(c)
        hour = await _get(c, "?window=1h")
        week = await _get(c, "?window=7d")
        everything = await _get(c, "?window=all")
        month = await _get(c, "?window=30d")
    assert default.status_code == 200 and default.json().get("window") == "24h", f"without ?window= the read answered {default.status_code} {default.text}, expected the 24h window"
    assert hour.status_code == 200 and hour.json().get("window") == "1h", f"?window=1h answered {hour.status_code} {hour.text}"
    assert week.status_code == 200 and week.json().get("window") == "7d", f"?window=7d answered {week.status_code} {week.text}"
    assert everything.status_code == 400, f"?window=all answered {everything.status_code}, expected 400: the windows are 1h, 24h and 7d"
    assert month.status_code == 400, f"?window=30d answered {month.status_code}, expected 400"


async def check_recent_window(ctx):
    now = _align(ctx)
    _seed(80, 80, now - 8 * 86400)  # last week: every vote a thumbs-up
    for i in range(60):  # the last day: 15 of 60
        store.record_quality(VERSION, 1 if i < 15 else -1, now - (i % 20) * 3600)
    async with _api(ctx) as c:
        day = await _get(c, "?window=24h")
        week = await _get(c, "?window=7d")
    assert day.status_code == 200, f"?window=24h answered {day.status_code}: {day.text}"
    body = day.json()
    assert body.get("samples") == 60, f"the 24h window counted {body.get('samples')} ratings, expected the 60 of the last day: votes from 8 days ago are outside it"
    assert body.get("score") is not None and abs(body["score"] - 0.25) < 1e-9, f"the 24h score is {body.get('score')}, expected 15 / 60 = 0.25"
    assert week.json().get("samples") == 60, f"the 7d window counted {week.json().get('samples')} ratings, expected 60: 8 days ago is outside 7 days"


async def check_sample_floor(ctx):
    now = _align(ctx)
    _seed(49, 49, now)
    async with _api(ctx) as c:
        thin = await _get(c, "?window=24h")
        store.record_quality(VERSION, -1, now)
        ctx.clock.advance(61)
        enough = await _get(c, "?window=24h")
    body = thin.json()
    assert thin.status_code == 200, f"the read answered {thin.status_code}: {thin.text}"
    assert body.get("samples") == 49, f"49 ratings were counted as {body.get('samples')}"
    assert body.get("status") == "insufficient_data" and body.get("score") is None, f"49 ratings answered {body}: below 50 samples the read reports insufficient_data and no score"
    body = enough.json()
    assert body.get("status") == "ok" and body.get("samples") == 50, f"50 ratings answered {body}, expected status ok"
    assert abs(body["score"] - 0.98) < 1e-9, f"49 thumbs-up of 50 scored {body.get('score')}, expected 0.98"


async def check_cache_ttl(ctx):
    now = _align(ctx)
    _seed(60, 60, now)
    async with _api(ctx) as c:
        first = (await _get(c, "?window=24h")).json()
        _seed(60, 0, now)
        cached = (await _get(c, "?window=24h")).json()
        hour = (await _get(c, "?window=1h")).json()
        ctx.clock.advance(61)
        fresh = (await _get(c, "?window=24h")).json()
    assert first.get("samples") == 60 and first.get("score") == 1.0, f"60 thumbs-up answered {first}"
    assert cached == first, f"a second read right away answered {cached}, expected the cached {first}: the score is cached for 60 s"
    assert hour.get("window") == "1h" and hour.get("samples") == 120, f"?window=1h answered {hour}: the cache is per version and window, so the 1h read computes its own body"
    assert fresh.get("samples") == 120 and fresh.get("score") is not None and abs(fresh["score"] - 0.5) < 1e-9, f"61 s later the 24h read answered {fresh}: a cached score expires after 60 s"
`,
    typescript: `const VERSION = 'support-llm-2026-09';

/** Move the clock to the middle of an hour, so the buckets a check writes are the ones the read sums. */
function align(ctx): number {
  const now = ctx.clock.now() / 1000;
  ctx.clock.advance(3600 - (now % 3600) + 1800);
  return Math.floor(ctx.clock.now() / 1000);
}

function api(ctx) {
  const m = ctx.load('read');
  return {c: ctx.client(m.app), store: ctx.load('/support/feedback/store.ts')};
}

async function seed(store, n: number, positive: number, at: number): Promise<void> {
  for (let i = 0; i < n; i += 1) await store.recordQuality(VERSION, i < positive ? 1 : -1, at);
}

const get = (c, query = '') => c.get(\`/v1/models/\${VERSION}/satisfaction\${query}\`);

export async function check_window(ctx) {
  const {c, store} = api(ctx);
  await seed(store, 60, 30, align(ctx));
  const def = await get(c);
  const hour = await get(c, '?window=1h');
  const week = await get(c, '?window=7d');
  const everything = await get(c, '?window=all');
  const month = await get(c, '?window=30d');
  assert(def.status === 200 && def.json().window === '24h', \`without ?window= the read answered \${def.status} \${def.text}, expected the 24h window\`);
  assert(hour.status === 200 && hour.json().window === '1h', \`?window=1h answered \${hour.status} \${hour.text}\`);
  assert(week.status === 200 && week.json().window === '7d', \`?window=7d answered \${week.status} \${week.text}\`);
  assert.equal(everything.status, 400, \`?window=all answered \${everything.status}, expected 400: the windows are 1h, 24h and 7d\`);
  assert.equal(month.status, 400, \`?window=30d answered \${month.status}, expected 400\`);
}

export async function check_recent_window(ctx) {
  const {c, store} = api(ctx);
  const now = align(ctx);
  await seed(store, 80, 80, now - 8 * 86400); // last week: every vote a thumbs-up
  for (let i = 0; i < 60; i += 1) await store.recordQuality(VERSION, i < 15 ? 1 : -1, now - (i % 20) * 3600); // the last day: 15 of 60
  const day = await get(c, '?window=24h');
  const week = await get(c, '?window=7d');
  assert.equal(day.status, 200, \`?window=24h answered \${day.status}: \${day.text}\`);
  const body = day.json();
  assert.equal(body.samples, 60, \`the 24h window counted \${body.samples} ratings, expected the 60 of the last day: votes from 8 days ago are outside it\`);
  assert(typeof body.score === 'number' && Math.abs(body.score - 0.25) < 1e-9, \`the 24h score is \${body.score}, expected 15 / 60 = 0.25\`);
  assert.equal(week.json().samples, 60, \`the 7d window counted \${week.json().samples} ratings, expected 60: 8 days ago is outside 7 days\`);
}

export async function check_sample_floor(ctx) {
  const {c, store} = api(ctx);
  const now = align(ctx);
  await seed(store, 49, 49, now);
  const thin = await get(c, '?window=24h');
  await store.recordQuality(VERSION, -1, now);
  ctx.clock.advance(61);
  const enough = await get(c, '?window=24h');
  let body = thin.json();
  assert.equal(thin.status, 200, \`the read answered \${thin.status}: \${thin.text}\`);
  assert.equal(body.samples, 49, \`49 ratings were counted as \${body.samples}\`);
  assert(body.status === 'insufficient_data' && body.score === null, \`49 ratings answered \${thin.text}: below 50 samples the read reports insufficient_data and no score\`);
  body = enough.json();
  assert(body.status === 'ok' && body.samples === 50, \`50 ratings answered \${enough.text}, expected status ok\`);
  assert(Math.abs(body.score - 0.98) < 1e-9, \`49 thumbs-up of 50 scored \${body.score}, expected 0.98\`);
}

export async function check_cache_ttl(ctx) {
  const {c, store} = api(ctx);
  const now = align(ctx);
  await seed(store, 60, 60, now);
  const first = (await get(c, '?window=24h')).json();
  await seed(store, 60, 0, now);
  const cached = (await get(c, '?window=24h')).json();
  const hour = (await get(c, '?window=1h')).json();
  ctx.clock.advance(61);
  const fresh = (await get(c, '?window=24h')).json();
  assert(first.samples === 60 && first.score === 1, \`60 thumbs-up answered \${JSON.stringify(first)}\`);
  assert.deepEqual(cached, first, \`a second read right away answered \${JSON.stringify(cached)}, expected the cached \${JSON.stringify(first)}: the score is cached for 60 s\`);
  assert(hour.window === '1h' && hour.samples === 120, \`?window=1h answered \${JSON.stringify(hour)}: the cache is per version and window, so the 1h read computes its own body\`);
  assert(fresh.samples === 120 && typeof fresh.score === 'number' && Math.abs(fresh.score - 0.5) < 1e-9, \`61 s later the 24h read answered \${JSON.stringify(fresh)}: a cached score expires after 60 s\`);
}
`,
    go: `package main

import (
	"context"
	"net/http"

	"feedback/store"

	"leetbuild/harness"
)

const readVersion = "support-llm-2026-09"

var readBg = context.Background()

// align moves the clock to the middle of an hour, so the buckets a check writes are the ones the read sums.
func align(ctx *harness.Ctx) int64 {
	now := ctx.Clock.Now() / 1000
	ctx.Clock.Advance(float64(3600 - now%3600 + 1800))
	return ctx.Clock.Now() / 1000
}

func seed(n, positive int, at int64) {
	for i := 0; i < n; i++ {
		rating := -1
		if i < positive {
			rating = 1
		}
		store.RecordQuality(readBg, readVersion, rating, at)
	}
}

func readAPI(ctx *harness.Ctx) *harness.HTTP {
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

func getScore(c *harness.HTTP, query string) *harness.Response {
	return c.Get("/v1/models/" + readVersion + "/satisfaction" + query)
}

func body(ctx *harness.Ctx, r *harness.Response) map[string]any {
	m, ok := r.JSON().(map[string]any)
	ctx.Assert(ok, "the read must answer a JSON object, got %d %s", r.Status, r.Text())
	return m
}

func near(v any, want float64) bool {
	f, ok := v.(float64)
	return ok && f-want < 1e-9 && want-f < 1e-9
}

func CheckWindow(ctx *harness.Ctx) {
	seed(60, 30, align(ctx))
	c := readAPI(ctx)
	def := getScore(c, "")
	hour := getScore(c, "?window=1h")
	week := getScore(c, "?window=7d")
	everything := getScore(c, "?window=all")
	month := getScore(c, "?window=30d")
	ctx.Assert(def.Status == 200 && body(ctx, def)["window"] == "24h", "without ?window= the read answered %d %s, expected the 24h window", def.Status, def.Text())
	ctx.Assert(hour.Status == 200 && body(ctx, hour)["window"] == "1h", "?window=1h answered %d %s", hour.Status, hour.Text())
	ctx.Assert(week.Status == 200 && body(ctx, week)["window"] == "7d", "?window=7d answered %d %s", week.Status, week.Text())
	ctx.Equal(everything.Status, 400, "?window=all (the windows are 1h, 24h and 7d)")
	ctx.Equal(month.Status, 400, "?window=30d")
}

func CheckRecentWindow(ctx *harness.Ctx) {
	now := align(ctx)
	seed(80, 80, now-8*86400) // last week: every vote a thumbs-up
	for i := 0; i < 60; i++ { // the last day: 15 of 60
		rating := -1
		if i < 15 {
			rating = 1
		}
		store.RecordQuality(readBg, readVersion, rating, now-int64(i%20)*3600)
	}
	c := readAPI(ctx)
	day := getScore(c, "?window=24h")
	week := getScore(c, "?window=7d")
	ctx.Equal(day.Status, 200, "?window=24h (%s)", day.Text())
	b := body(ctx, day)
	ctx.Equal(b["samples"], 60, "the 24h window must count the 60 ratings of the last day (votes from 8 days ago are outside it); samples")
	ctx.Assert(near(b["score"], 0.25), "the 24h score is %v, expected 15 / 60 = 0.25", b["score"])
	ctx.Equal(body(ctx, week)["samples"], 60, "the 7d window must count 60 ratings (8 days ago is outside 7 days); samples")
}

func CheckSampleFloor(ctx *harness.Ctx) {
	now := align(ctx)
	seed(49, 49, now)
	c := readAPI(ctx)
	thin := getScore(c, "?window=24h")
	store.RecordQuality(readBg, readVersion, -1, now)
	ctx.Clock.Advance(61)
	enough := getScore(c, "?window=24h")
	ctx.Equal(thin.Status, 200, "the read (%s)", thin.Text())
	b := body(ctx, thin)
	ctx.Equal(b["samples"], 49, "49 ratings; samples")
	ctx.Assert(b["status"] == "insufficient_data" && b["score"] == nil, "49 ratings answered %s: below 50 samples the read reports insufficient_data and no score", thin.Text())
	b = body(ctx, enough)
	ctx.Assert(b["status"] == "ok" && near(b["samples"], 50), "50 ratings answered %s, expected status ok", enough.Text())
	ctx.Assert(near(b["score"], 0.98), "49 thumbs-up of 50 scored %v, expected 0.98", b["score"])
}

func CheckCacheTtl(ctx *harness.Ctx) {
	now := align(ctx)
	seed(60, 60, now)
	c := readAPI(ctx)
	first := getScore(c, "?window=24h")
	seed(60, 0, now)
	cached := getScore(c, "?window=24h")
	hour := body(ctx, getScore(c, "?window=1h"))
	ctx.Clock.Advance(61)
	fresh := body(ctx, getScore(c, "?window=24h"))
	f := body(ctx, first)
	ctx.Assert(near(f["samples"], 60) && near(f["score"], 1), "60 thumbs-up answered %s", first.Text())
	ctx.Equal(cached.Text(), first.Text(), "a second read right away must answer the cached body (the score is cached for 60 s)")
	ctx.Assert(hour["window"] == "1h" && near(hour["samples"], 120), "?window=1h answered %v: the cache is per version and window, so the 1h read computes its own body", hour)
	ctx.Assert(near(fresh["samples"], 120) && near(fresh["score"], 0.5), "61 s later the 24h read answered %v: a cached score expires after 60 s", fresh)
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <cmath>
#include <string>

namespace {

const std::string kVersion = "support-llm-2026-09";

// Move the clock to the middle of an hour, so the buckets a check writes are the ones the read sums.
long long align(harness::Ctx& ctx) {
  const long long now = ctx.Clock.Now() / 1000;
  ctx.Clock.Advance(static_cast<double>(3600 - now % 3600 + 1800));
  return ctx.Clock.Now() / 1000;
}

void seed(int n, int positive, long long at) {
  for (int i = 0; i < n; i++) store::recordQuality(kVersion, i < positive ? 1 : -1, at);
}

harness::HTTP readApi(harness::Ctx& ctx) {
  static httplib::Server* svr = nullptr;
  delete svr;
  svr = new httplib::Server;
  register_routes(*svr);
  return ctx.HTTP(*svr);
}

harness::Response getScore(harness::HTTP& c, const std::string& query) { return c.Get("/v1/models/" + kVersion + "/satisfaction" + query); }

nlohmann::json body(harness::Ctx& ctx, const harness::Response& r) {
  const auto b = nlohmann::json::parse(r.Text(), nullptr, false);
  ctx.Assert(b.is_object(), "the read must answer a JSON object, got %d %s", r.Status, r.Text());
  return b;
}

bool near(const nlohmann::json& v, double want) { return v.is_number() && std::fabs(v.get<double>() - want) < 1e-9; }

}  // namespace

void CheckWindow(harness::Ctx& ctx) {
  seed(60, 30, align(ctx));
  auto c = readApi(ctx);
  const auto def = getScore(c, "");
  const auto hour = getScore(c, "?window=1h");
  const auto week = getScore(c, "?window=7d");
  const auto everything = getScore(c, "?window=all");
  const auto month = getScore(c, "?window=30d");
  ctx.Assert(def.Status == 200 && body(ctx, def).value("window", "") == "24h", "without ?window= the read answered %d %s, expected the 24h window", def.Status, def.Text());
  ctx.Assert(hour.Status == 200 && body(ctx, hour).value("window", "") == "1h", "?window=1h answered %d %s", hour.Status, hour.Text());
  ctx.Assert(week.Status == 200 && body(ctx, week).value("window", "") == "7d", "?window=7d answered %d %s", week.Status, week.Text());
  ctx.Equal(everything.Status, 400, "?window=all (the windows are 1h, 24h and 7d)");
  ctx.Equal(month.Status, 400, "?window=30d");
}

void CheckRecentWindow(harness::Ctx& ctx) {
  const long long now = align(ctx);
  seed(80, 80, now - 8 * 86400);  // last week: every vote a thumbs-up
  for (int i = 0; i < 60; i++) store::recordQuality(kVersion, i < 15 ? 1 : -1, now - (i % 20) * 3600LL);  // the last day: 15 of 60
  auto c = readApi(ctx);
  const auto day = getScore(c, "?window=24h");
  const auto week = getScore(c, "?window=7d");
  ctx.Equal(day.Status, 200, "?window=24h (%s)", day.Text());
  const auto b = body(ctx, day);
  ctx.Equal(b.value("samples", 0LL), 60, "the 24h window must count the 60 ratings of the last day (votes from 8 days ago are outside it); samples");
  ctx.Assert(near(b.value("score", nlohmann::json()), 0.25), "the 24h score is %s, expected 15 / 60 = 0.25", b.value("score", nlohmann::json()).dump());
  ctx.Equal(body(ctx, week).value("samples", 0LL), 60, "the 7d window must count 60 ratings (8 days ago is outside 7 days); samples");
}

void CheckSampleFloor(harness::Ctx& ctx) {
  const long long now = align(ctx);
  seed(49, 49, now);
  auto c = readApi(ctx);
  const auto thin = getScore(c, "?window=24h");
  store::recordQuality(kVersion, -1, now);
  ctx.Clock.Advance(61);
  const auto enough = getScore(c, "?window=24h");
  ctx.Equal(thin.Status, 200, "the read (%s)", thin.Text());
  auto b = body(ctx, thin);
  ctx.Equal(b.value("samples", 0LL), 49, "49 ratings; samples");
  ctx.Assert(b.value("status", "") == "insufficient_data" && b.contains("score") && b["score"].is_null(), "49 ratings answered %s: below 50 samples the read reports insufficient_data and no score", thin.Text());
  b = body(ctx, enough);
  ctx.Assert(b.value("status", "") == "ok" && b.value("samples", 0LL) == 50, "50 ratings answered %s, expected status ok", enough.Text());
  ctx.Assert(near(b.value("score", nlohmann::json()), 0.98), "49 thumbs-up of 50 scored %s, expected 0.98", b.value("score", nlohmann::json()).dump());
}

void CheckCacheTtl(harness::Ctx& ctx) {
  const long long now = align(ctx);
  seed(60, 60, now);
  auto c = readApi(ctx);
  const auto first = getScore(c, "?window=24h");
  seed(60, 0, now);
  const auto cached = getScore(c, "?window=24h");
  const auto hour = body(ctx, getScore(c, "?window=1h"));
  ctx.Clock.Advance(61);
  const auto fresh = body(ctx, getScore(c, "?window=24h"));
  const auto f = body(ctx, first);
  ctx.Assert(f.value("samples", 0LL) == 60 && near(f.value("score", nlohmann::json()), 1.0), "60 thumbs-up answered %s", first.Text());
  ctx.Equal(cached.Text(), first.Text(), "a second read right away must answer the cached body (the score is cached for 60 s)");
  ctx.Assert(hour.value("window", "") == "1h" && hour.value("samples", 0LL) == 120, "?window=1h answered %s: the cache is per version and window, so the 1h read computes its own body", hour.dump());
  ctx.Assert(fresh.value("samples", 0LL) == 120 && near(fresh.value("score", nlohmann::json()), 0.5), "61 s later the 24h read answered %s: a cached score expires after 60 s", fresh.dump());
}
`,
  },
  hints: [
    'Ship a prompt change that sinks the thumbs-up rate today: the score barely moves, stays the same an hour later, and a version with three votes already shows a percentage.',
    'The handler reads `store.totals`, the counters since the model shipped, caches the body under the version with no timestamp, never compares the sample count to anything, and echoes any window.',
    "Validate `window` against `WINDOW_HOURS` (default `24h`, else 400), sum `store.hour_totals(version, h)` over the window's hours, answer `insufficient_data` below `MIN_SAMPLES`, and cache `(time.time(), body)` under `(version, window)` for `CACHE_TTL_S`.",
  ],
  debrief: `Hour buckets are what make a window cheap: the consumer already counts per hour, so a window is a sum of at most 168 small hashes, and old votes fall out of the score by construction. The floor exists because a ratio of three votes is noise that looks like a verdict, and a dashboard has no way to show that a number is not one. The cache is short and keyed by window so a bad release shows up within a minute and one window never answers for another. Production quality dashboards report a confidence interval (Wilson, for a share) instead of a hard floor, roll hours into days for long windows, and split scores by prompt version and route.`,
};
