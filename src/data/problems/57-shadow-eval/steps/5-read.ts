import type {Step} from '@/lib/types';

export const shadowReadStep: Step = {
  id: 'read',
  title: 'GET /v1/shadow/configs/{id}/report: an interval before a verdict',
  concept: 'http',
  guides: ['honest-reads', 'request-boundaries'],
  file: 'read',
  focus: ['client', 'shadow', 'redis'],
  task: `## Task

**Starting point.** The starter serves \`GET /v1/shadow/configs/{id}/report\`: it loads the config by
id (404 when there is none) and the paired-delta aggregate \`store.pair_stats(id)\` (\`n\`, \`sum\`,
\`sumsq\`, \`first_at\`, \`last_at\`, kept by the comparison consumer), and answers
\`{config_id, candidate_version, delta, verdict}\` with the mean delta and \`candidate_better\`
whenever it is positive. It serves the demo and hides four flaws.

**Failure mode the checks target.** A measurement turned into a decision it cannot support. Twelve
pairs with a positive mean are reported as a win with no count beside them; a mean of +0.01 with an
interval from -0.03 to +0.05 is reported as a win; nothing says which traffic the numbers came
from; and any caller reads any tenant's experiment.

- A missing \`X-Tenant-Id\` is **401**; a config of another tenant is **404**, the same answer as a
  config that does not exist.
- The report adds \`sample_count\` (\`n\`), \`ci_low\` and \`ci_high\` (mean ± \`Z_95\` = 1.96 ×
  √(s² / n), with s² = (sumsq − n·mean²) / (n − 1)), and \`window_start\` / \`window_end\` (\`first_at\`,
  \`last_at\`).
- \`verdict\` is \`inconclusive\` below \`MIN_PAIRED_SAMPLES\` = 500 pairs or when the interval contains
  0; otherwise \`candidate_better\` (\`ci_low\` > 0) or \`candidate_worse\` (\`ci_high\` < 0).`,
  sequence: {
    participants: ['Client', 'Shadow runner', 'Redis'],
    messages: [
      {from: 'Client', to: 'Shadow runner', label: 'GET /v1/shadow/configs/{id}/report · X-Tenant-Id', kind: 'sync'},
      {from: 'Shadow runner', to: 'Redis', label: 'HGETALL shadow:config:{id}', kind: 'sync'},
      {from: 'Redis', to: 'Shadow runner', label: 'config · another tenant → 404', kind: 'reply'},
      {from: 'Shadow runner', to: 'Redis', label: 'HGETALL shadow:{id}:pairs', kind: 'sync'},
      {
        from: 'Shadow runner',
        to: 'Shadow runner',
        label: 'mean · 95 % interval · n < 500 → inconclusive',
        kind: 'sync',
      },
      {
        from: 'Shadow runner',
        to: 'Client',
        label: '200 {sample_count, delta, ci_low, ci_high, window, verdict}',
        kind: 'reply',
      },
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Handles GET /v1/shadow/configs/{id}/report',
      detail: 'Register `GET /v1/shadow/configs/{id}/report`; the owner of a config gets 200 with its `config_id`.',
      match: {
        python: {all: [/@app\.get\(\s*["']\/v1\/shadow\/configs\/\{id\}\/report["']/]},
        typescript: {all: [/app\.get\(\s*['"]\/v1\/shadow\/configs\/:id\/report['"]/]},
        go: {all: [/HandleFunc\(\s*"GET \/v1\/shadow\/configs\/\{id\}\/report"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"shadow"\s*\/\s*"configs"\s*\/\s*Segment\s*\/\s*"report"\s*\)/]},
        cpp: {all: [/svr\.Get\(\s*R"\(\/v1\/shadow\/configs/]},
      },
    },
    {
      id: 'samples',
      title: 'Reports the pair count and decides nothing below 500 pairs',
      detail:
        'The report carries `sample_count`, and below `MIN_PAIRED_SAMPLES` (500) the verdict is `inconclusive`. The starter declares a winner from 12 pairs and hides the count.',
      match: {
        python: {all: [/MIN_PAIRED_SAMPLES\s*=\s*500\b/, /["']sample_count["']/, /[<>]=?\s*MIN_PAIRED_SAMPLES/]},
        typescript: {all: [/MIN_PAIRED_SAMPLES\s*=\s*500\b/, /sample_count/, /[<>]=?\s*MIN_PAIRED_SAMPLES/]},
        go: {all: [/minPairedSamples\s*=\s*500\b/, /"sample_count"/, /[<>]=?\s*minPairedSamples/]},
        scala: {all: [/MinPairedSamples\s*=\s*500L?\b/, /"sample_count"/, /[<>]=?\s*MinPairedSamples/]},
        cpp: {all: [/kMinPairedSamples\s*=\s*500\b/, /"sample_count"/, /[<>]=?\s*kMinPairedSamples/]},
      },
    },
    {
      id: 'interval',
      title: 'Returns a 95 percent interval and decides from it',
      detail:
        'The report returns `ci_low` and `ci_high` around the mean delta, and a verdict needs the whole interval on one side of 0. The starter reports a bare mean, so a +0.01 inside ±0.04 of noise is called a win.',
      match: {
        python: {all: [/["']ci_low["']/, /["']ci_high["']/, /Z_95\s*=\s*1\.96\b/, /sqrt\(/]},
        typescript: {all: [/ci_low/, /ci_high/, /Z_95\s*=\s*1\.96\b/, /Math\.sqrt\(/]},
        go: {all: [/"ci_low"/, /"ci_high"/, /z95\s*=\s*1\.96\b/, /math\.Sqrt\(/]},
        scala: {all: [/"ci_low"/, /"ci_high"/, /Z95\s*=\s*1\.96\b/, /math\.sqrt\(|Math\.sqrt\(/]},
        cpp: {all: [/"ci_low"/, /"ci_high"/, /kZ95\s*=\s*1\.96\b/, /std::sqrt\(/]},
      },
    },
    {
      id: 'window',
      title: 'Reports the traffic window the pairs came from',
      detail:
        'The report carries `window_start` and `window_end` (the first and last pair, unix seconds). The starter returns neither, so a delta cannot be tied to the period and traffic mix behind it.',
      match: {
        python: {all: [/["']window_start["']/, /["']window_end["']/, /first_at/]},
        typescript: {all: [/window_start/, /window_end/, /first_at/]},
        go: {all: [/"window_start"/, /"window_end"/, /FirstAt/]},
        scala: {all: [/"window_start"/, /"window_end"/, /firstAt/]},
        cpp: {all: [/"window_start"/, /"window_end"/, /first_at/]},
      },
    },
    {
      id: 'tenant-scope',
      title: "Scopes the report to the caller's tenant",
      detail:
        "A missing `X-Tenant-Id` is **401**, and a config of another tenant is **404** like one that does not exist, so a report never confirms someone else's experiment. The starter serves any config to any caller.",
      match: {
        python: {all: [/x-tenant-id/i, /\b401\b/, /!=\s*tenant\b|\btenant\s*!=/]},
        typescript: {all: [/x-tenant-id/i, /\b401\b/, /!==\s*tenant\b|\btenant\s*!==/]},
        go: {all: [/X-Tenant-Id/i, /StatusUnauthorized|\b401\b/, /!=\s*tenant\b|\btenant\s*!=/]},
        scala: {all: [/X-Tenant-Id/i, /StatusCodes\.Unauthorized/, /!=\s*tenant\b|\btenant\s*!=/]},
        cpp: {all: [/X-Tenant-Id/i, /\b401\b/, /!=\s*tenant\b|\btenant\s*!=/]},
      },
    },
  ],
  code: {
    python: {
      starter: `from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from shadow import store  # get_config, pair_stats

app = FastAPI()


@app.get("/v1/shadow/configs/{id}/report")
def shadow_report(id: str, request: Request) -> JSONResponse:
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    config = store.get_config(id)
    if config is None:
        return JSONResponse({"error": "no such config"}, status_code=404)
    stats = store.pair_stats(id)
    delta = stats["sum"] / stats["n"] if stats else 0.0
    verdict = "candidate_better" if delta > 0 else "candidate_worse"
    return JSONResponse({"config_id": id, "candidate_version": config["candidate_version"], "delta": delta, "verdict": verdict})
`,
      solution: `import math

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from shadow import store  # get_config, pair_stats

app = FastAPI()

MIN_PAIRED_SAMPLES = 500
Z_95 = 1.96


@app.get("/v1/shadow/configs/{id}/report")
def shadow_report(id: str, request: Request) -> JSONResponse:
    tenant = request.headers.get("x-tenant-id", "")
    if not tenant:
        return JSONResponse({"error": "X-Tenant-Id is required"}, status_code=401)
    config = store.get_config(id)
    if config is None or config["tenant"] != tenant:
        # Another tenant's config answers like a missing one: the report confirms nothing about it.
        return JSONResponse({"error": "no such config"}, status_code=404)
    stats = store.pair_stats(id)
    n = stats["n"] if stats else 0
    mean = stats["sum"] / n if n else 0.0
    variance = max(stats["sumsq"] - n * mean * mean, 0.0) / (n - 1) if n > 1 else 0.0
    half = Z_95 * math.sqrt(variance / n) if n else 0.0
    ci_low, ci_high = mean - half, mean + half
    if n < MIN_PAIRED_SAMPLES or ci_low <= 0 <= ci_high:
        verdict = "inconclusive"
    else:
        verdict = "candidate_better" if ci_low > 0 else "candidate_worse"
    return JSONResponse({
        "config_id": id,
        "candidate_version": config["candidate_version"],
        "sample_count": n,
        "delta": mean,
        "ci_low": ci_low,
        "ci_high": ci_high,
        "window_start": stats["first_at"] if stats else None,
        "window_end": stats["last_at"] if stats else None,
        "verdict": verdict,
    })
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';

import {getConfig, pairStats} from 'shadow/store';

export const app = Fastify();

app.get('/v1/shadow/configs/:id/report', async (request, reply) => {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const {id} = request.params as {id: string};
  const config = await getConfig(id);
  if (config === null) return reply.code(404).send({error: 'no such config'});
  const stats = await pairStats(id);
  const delta = stats === null ? 0 : stats.sum / stats.n;
  const verdict = delta > 0 ? 'candidate_better' : 'candidate_worse';
  return {config_id: id, candidate_version: config.candidate_version, delta, verdict};
});
`,
      solution: `import Fastify from 'fastify';

import {getConfig, pairStats} from 'shadow/store';

export const app = Fastify();

export const MIN_PAIRED_SAMPLES = 500;
export const Z_95 = 1.96;

app.get('/v1/shadow/configs/:id/report', async (request, reply) => {
  const tenant = (request.headers['x-tenant-id'] as string | undefined) ?? '';
  if (tenant === '') return reply.code(401).send({error: 'X-Tenant-Id is required'});
  const {id} = request.params as {id: string};
  const config = await getConfig(id);
  // Another tenant's config answers like a missing one: the report confirms nothing about it.
  if (config === null || config.tenant !== tenant) return reply.code(404).send({error: 'no such config'});
  const stats = await pairStats(id);
  const n = stats?.n ?? 0;
  const mean = stats !== null && n > 0 ? stats.sum / n : 0;
  const variance = stats !== null && n > 1 ? Math.max(stats.sumsq - n * mean * mean, 0) / (n - 1) : 0;
  const half = n > 0 ? Z_95 * Math.sqrt(variance / n) : 0;
  const ciLow = mean - half;
  const ciHigh = mean + half;
  let verdict = 'inconclusive';
  if (n >= MIN_PAIRED_SAMPLES && ciLow > 0) verdict = 'candidate_better';
  if (n >= MIN_PAIRED_SAMPLES && ciHigh < 0) verdict = 'candidate_worse';
  return {
    config_id: id,
    candidate_version: config.candidate_version,
    sample_count: n,
    delta: mean,
    ci_low: ciLow,
    ci_high: ciHigh,
    window_start: stats?.first_at ?? null,
    window_end: stats?.last_at ?? null,
    verdict,
  };
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"net/http"

	"shadow/store" // store.GetConfig, GetPairStats
)

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func shadowReport(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	id := r.PathValue("id")
	config := store.GetConfig(r.Context(), id)
	if config == nil {
		http.Error(rw, "no such config", http.StatusNotFound)
		return
	}
	delta := 0.0
	if stats := store.GetPairStats(r.Context(), id); stats != nil {
		delta = stats.Sum / float64(stats.N)
	}
	verdict := "candidate_worse"
	if delta > 0 {
		verdict = "candidate_better"
	}
	writeJSON(rw, http.StatusOK, map[string]any{"config_id": id, "candidate_version": config.CandidateVersion, "delta": delta, "verdict": verdict})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/shadow/configs/{id}/report", shadowReport)
}
`,
      solution: `package main

import (
	"encoding/json"
	"math"
	"net/http"

	"shadow/store" // store.GetConfig, GetPairStats
)

const (
	minPairedSamples = 500
	z95              = 1.96
)

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func shadowReport(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		http.Error(rw, "X-Tenant-Id is required", http.StatusUnauthorized)
		return
	}
	id := r.PathValue("id")
	config := store.GetConfig(r.Context(), id)
	if config == nil || config.Tenant != tenant {
		// Another tenant's config answers like a missing one: the report confirms nothing about it.
		http.Error(rw, "no such config", http.StatusNotFound)
		return
	}
	stats := store.GetPairStats(r.Context(), id)
	var n int64
	mean, variance := 0.0, 0.0
	var windowStart, windowEnd any
	if stats != nil {
		n = stats.N
		windowStart, windowEnd = stats.FirstAt, stats.LastAt
		if n > 0 {
			mean = stats.Sum / float64(n)
		}
		if n > 1 {
			variance = math.Max(stats.SumSq-float64(n)*mean*mean, 0) / float64(n-1)
		}
	}
	half := 0.0
	if n > 0 {
		half = z95 * math.Sqrt(variance/float64(n))
	}
	ciLow, ciHigh := mean-half, mean+half
	verdict := "inconclusive"
	if n >= minPairedSamples && ciLow > 0 {
		verdict = "candidate_better"
	} else if n >= minPairedSamples && ciHigh < 0 {
		verdict = "candidate_worse"
	}
	writeJSON(rw, http.StatusOK, map[string]any{
		"config_id": id, "candidate_version": config.CandidateVersion, "sample_count": n, "delta": mean,
		"ci_low": ciLow, "ci_high": ciHigh, "window_start": windowStart, "window_end": windowEnd, "verdict": verdict,
	})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/shadow/configs/{id}/report", shadowReport)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import shadow.Store // Store.getConfig, pairStats

object ShadowReport {
  val route: Route = path("v1" / "shadow" / "configs" / Segment / "report") { id =>
    get {
      // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
      Store.getConfig(id) match {
        case None => complete(StatusCodes.NotFound -> "no such config")
        case Some(config) =>
          val delta = Store.pairStats(id).map(s => s.sum / s.n).getOrElse(0.0)
          val verdict = if (delta > 0) "candidate_better" else "candidate_worse"
          val body = JsObject(
            "config_id" -> JsString(id),
            "candidate_version" -> JsString(config.candidateVersion),
            "delta" -> JsNumber(delta),
            "verdict" -> JsString(verdict))
          complete(HttpResponse(StatusCodes.OK, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint)))
      }
    }
  }
}
`,
      solution: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import shadow.Store // Store.getConfig, pairStats

object ShadowReport {
  val MinPairedSamples = 500L
  val Z95 = 1.96

  val route: Route = path("v1" / "shadow" / "configs" / Segment / "report") { id =>
    get {
      optionalHeaderValueByName("X-Tenant-Id") {
        case None | Some("") => complete(StatusCodes.Unauthorized -> "X-Tenant-Id is required")
        case Some(tenant) =>
          Store.getConfig(id).filterNot(_.tenant != tenant) match {
            // Another tenant's config answers like a missing one: the report confirms nothing about it.
            case None => complete(StatusCodes.NotFound -> "no such config")
            case Some(config) =>
              val stats = Store.pairStats(id)
              val n = stats.map(_.n).getOrElse(0L)
              val mean = stats.filter(_.n > 0).map(s => s.sum / s.n).getOrElse(0.0)
              val variance = stats.filter(_.n > 1).map(s => math.max(s.sumsq - s.n * mean * mean, 0.0) / (s.n - 1)).getOrElse(0.0)
              val half = if (n > 0) Z95 * math.sqrt(variance / n) else 0.0
              val (ciLow, ciHigh) = (mean - half, mean + half)
              val verdict =
                if (n < MinPairedSamples || (ciLow <= 0 && ciHigh >= 0)) "inconclusive"
                else if (ciLow > 0) "candidate_better"
                else "candidate_worse"
              val body = JsObject(
                "config_id" -> JsString(id),
                "candidate_version" -> JsString(config.candidateVersion),
                "sample_count" -> JsNumber(n),
                "delta" -> JsNumber(mean),
                "ci_low" -> JsNumber(ciLow),
                "ci_high" -> JsNumber(ciHigh),
                "window_start" -> stats.map(s => JsNumber(s.firstAt)).getOrElse(JsNull),
                "window_end" -> stats.map(s => JsNumber(s.lastAt)).getOrElse(JsNull),
                "verdict" -> JsString(verdict))
              complete(HttpResponse(StatusCodes.OK, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint)))
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

#include "shadow/store.h"  // store::getConfig, pairStats

using json = nlohmann::json;

void shadow_report(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const std::string id = req.matches[1];
  const auto config = store::getConfig(id);
  if (!config) {
    res.status = 404;
    res.set_content("no such config", "text/plain");
    return;
  }
  const auto stats = store::pairStats(id);
  const double delta = stats && stats->n > 0 ? stats->sum / stats->n : 0.0;
  const std::string verdict = delta > 0 ? "candidate_better" : "candidate_worse";
  res.set_content(json{{"config_id", id}, {"candidate_version", config->candidate_version}, {"delta", delta}, {"verdict", verdict}}.dump(),
                  "application/json");
}

void register_routes(httplib::Server& svr) { svr.Get(R"(/v1/shadow/configs/([\\w-]+)/report)", shadow_report); }
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <algorithm>
#include <cmath>
#include <string>

#include "shadow/store.h"  // store::getConfig, pairStats

using json = nlohmann::json;

constexpr long long kMinPairedSamples = 500;
constexpr double kZ95 = 1.96;

void shadow_report(const httplib::Request& req, httplib::Response& res) {
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) {
    res.status = 401;
    res.set_content("X-Tenant-Id is required", "text/plain");
    return;
  }
  const std::string id = req.matches[1];
  const auto config = store::getConfig(id);
  if (!config || config->tenant != tenant) {
    // Another tenant's config answers like a missing one: the report confirms nothing about it.
    res.status = 404;
    res.set_content("no such config", "text/plain");
    return;
  }
  const auto stats = store::pairStats(id);
  const long long n = stats ? stats->n : 0;
  const double mean = n > 0 ? stats->sum / n : 0.0;
  const double variance = n > 1 ? std::max(stats->sumsq - n * mean * mean, 0.0) / (n - 1) : 0.0;
  const double half = n > 0 ? kZ95 * std::sqrt(variance / n) : 0.0;
  const double ci_low = mean - half;
  const double ci_high = mean + half;
  std::string verdict = "inconclusive";
  if (n >= kMinPairedSamples && ci_low > 0) verdict = "candidate_better";
  if (n >= kMinPairedSamples && ci_high < 0) verdict = "candidate_worse";
  res.set_content(json{{"config_id", id},
                       {"candidate_version", config->candidate_version},
                       {"sample_count", n},
                       {"delta", mean},
                       {"ci_low", ci_low},
                       {"ci_high", ci_high},
                       {"window_start", stats ? json(stats->first_at) : json(nullptr)},
                       {"window_end", stats ? json(stats->last_at) : json(nullptr)},
                       {"verdict", verdict}}
                      .dump(),
                  "application/json");
}

void register_routes(httplib::Server& svr) { svr.Get(R"(/v1/shadow/configs/([\\w-]+)/report)", shadow_report); }
`,
    },
  },
  harness: {
    python: `import math

from shadow import store

T1 = {"X-Tenant-Id": "t1"}
START = 1767225600
END = 1767312000


def _api(ctx):
    return ctx.client(ctx.load("read").app)


def _config(tenant="t1"):
    return store.create_config(tenant, "cand-2026-04", 5, ["quality"])["config_id"]


def _seed(ctx, cfg, n, mean, sd):
    """The comparison consumer's aggregate for n pairs with this mean and sample standard deviation."""
    sumsq = (n - 1) * sd * sd + n * mean * mean
    ctx.redis.hset(f"shadow:{cfg}:pairs", mapping={"n": n, "sum": repr(n * mean), "sumsq": repr(sumsq), "first_at": START, "last_at": END})


async def _report(c, cfg, headers=T1):
    r = await c.get(f"/v1/shadow/configs/{cfg}/report", headers=headers)
    assert r.status_code == 200, f"GET /v1/shadow/configs/{cfg}/report answered {r.status_code}: {r.text}"
    return r.json()


async def check_route(ctx):
    cfg = _config()
    async with _api(ctx) as c:
        body = await _report(c, cfg)
    assert body.get("config_id") == cfg and body.get("candidate_version") == "cand-2026-04", f"the report is {body}, expected config_id {cfg} and its candidate version"


async def check_samples(ctx):
    cfg = _config()
    for i, delta in enumerate([0.2, 0.1, 0.3] * 4):
        store.record_pair(cfg, delta, START + 60 * i)
    async with _api(ctx) as c:
        body = await _report(c, cfg)
    assert body.get("sample_count") == 12, f"the report's sample_count is {body.get('sample_count')!r}, expected 12: a delta without its count cannot be judged"
    assert body.get("verdict") == "inconclusive", f"12 pairs gave the verdict {body.get('verdict')!r}: below MIN_PAIRED_SAMPLES (500) it is inconclusive, however good the mean looks"


async def check_interval(ctx):
    noisy, better, worse = _config(), _config(), _config()
    _seed(ctx, noisy, 600, 0.01, 0.5)
    _seed(ctx, better, 600, 0.1, 0.5)
    _seed(ctx, worse, 600, -0.1, 0.5)
    half = 1.96 * math.sqrt(0.25 / 600)
    async with _api(ctx) as c:
        body = await _report(c, noisy)
        assert body.get("sample_count") == 600, f"the report's sample_count is {body.get('sample_count')!r}, expected 600"
        for name, want in (("delta", 0.01), ("ci_low", 0.01 - half), ("ci_high", 0.01 + half)):
            got = body.get(name)
            assert isinstance(got, (int, float)) and abs(got - want) < 1e-6, f"the report's {name} is {got!r}, expected {want:.6f} (mean ± 1.96 × √(s²/n)) for 600 pairs with mean 0.01 and s = 0.5"
        assert body.get("verdict") == "inconclusive", f"600 pairs with an interval from {0.01 - half:.3f} to {0.01 + half:.3f} gave the verdict {body.get('verdict')!r}: an interval that contains 0 is inconclusive"
        body = await _report(c, better)
        assert body.get("verdict") == "candidate_better", f"600 pairs with mean +0.1 (interval {0.1 - half:.3f} to {0.1 + half:.3f}) gave {body.get('verdict')!r}, expected candidate_better"
        body = await _report(c, worse)
        assert body.get("verdict") == "candidate_worse", f"600 pairs with mean -0.1 gave {body.get('verdict')!r}, expected candidate_worse"


async def check_window(ctx):
    cfg = _config()
    _seed(ctx, cfg, 600, 0.1, 0.5)
    async with _api(ctx) as c:
        body = await _report(c, cfg)
    assert body.get("window_start") == START and body.get("window_end") == END, f"the report's window is {body.get('window_start')!r} to {body.get('window_end')!r}, expected {START} to {END} (first_at, last_at of the pairs)"


async def check_tenant_scope(ctx):
    cfg = _config("t1")
    _seed(ctx, cfg, 600, 0.1, 0.5)
    async with _api(ctx) as c:
        r = await c.get(f"/v1/shadow/configs/{cfg}/report")
        assert r.status_code == 401, f"a report without X-Tenant-Id answered {r.status_code}, expected 401"
        r = await c.get(f"/v1/shadow/configs/{cfg}/report", headers={"X-Tenant-Id": "t2"})
        assert r.status_code == 404, f"tenant t2 asked for t1's report and got {r.status_code}, expected 404"
        assert "cand-2026-04" not in r.text, f"the answer to t2 names t1's candidate version: {r.text}"
        r = await c.get("/v1/shadow/configs/cfg-404/report", headers=T1)
        assert r.status_code == 404, f"a config that does not exist answered {r.status_code}, expected 404"
        await _report(c, cfg)
`,
    typescript: `const T1 = {'X-Tenant-Id': 't1'};
const START = 1767225600;
const END = 1767312000;

function world(ctx) {
  const m = ctx.load('read');
  return {c: ctx.client(m.app), store: ctx.load('/support/shadow/store.ts')};
}

const newConfig = async (store, tenant = 't1'): Promise<string> => (await store.createConfig(tenant, 'cand-2026-04', 5, ['quality'])).config_id;

/** The comparison consumer's aggregate for n pairs with this mean and sample standard deviation. */
function seed(ctx, cfg: string, n: number, mean: number, sd: number): void {
  const sumsq = (n - 1) * sd * sd + n * mean * mean;
  ctx.redis.hset(\`shadow:\${cfg}:pairs\`, 'n', String(n), 'sum', String(n * mean), 'sumsq', String(sumsq), 'first_at', String(START), 'last_at', String(END));
}

async function report(c, cfg: string) {
  const r = await c.get(\`/v1/shadow/configs/\${cfg}/report\`, {headers: T1});
  assert.equal(r.status, 200, \`GET /v1/shadow/configs/\${cfg}/report answered \${r.status}: \${r.text}\`);
  return r.json();
}

export async function check_route(ctx) {
  const {c, store} = world(ctx);
  const cfg = await newConfig(store);
  const body = await report(c, cfg);
  assert(body.config_id === cfg && body.candidate_version === 'cand-2026-04', \`the report is \${JSON.stringify(body)}, expected config_id \${cfg} and its candidate version\`);
}

export async function check_samples(ctx) {
  const {c, store} = world(ctx);
  const cfg = await newConfig(store);
  const deltas = [0.2, 0.1, 0.3, 0.2, 0.1, 0.3, 0.2, 0.1, 0.3, 0.2, 0.1, 0.3];
  for (const [i, delta] of deltas.entries()) await store.recordPair(cfg, delta, START + 60 * i);
  const body = await report(c, cfg);
  assert.equal(body.sample_count, 12, \`the report's sample_count is \${JSON.stringify(body.sample_count)}, expected 12: a delta without its count cannot be judged\`);
  assert.equal(body.verdict, 'inconclusive', \`12 pairs gave the verdict \${JSON.stringify(body.verdict)}: below MIN_PAIRED_SAMPLES (500) it is inconclusive, however good the mean looks\`);
}

export async function check_interval(ctx) {
  const {c, store} = world(ctx);
  const noisy = await newConfig(store);
  const better = await newConfig(store);
  const worse = await newConfig(store);
  seed(ctx, noisy, 600, 0.01, 0.5);
  seed(ctx, better, 600, 0.1, 0.5);
  seed(ctx, worse, 600, -0.1, 0.5);
  const half = 1.96 * Math.sqrt(0.25 / 600);
  let body = await report(c, noisy);
  assert.equal(body.sample_count, 600, \`the report's sample_count is \${JSON.stringify(body.sample_count)}, expected 600\`);
  for (const [name, want] of [['delta', 0.01], ['ci_low', 0.01 - half], ['ci_high', 0.01 + half]] as const) {
    const got = body[name];
    assert(typeof got === 'number' && Math.abs(got - want) < 1e-6, \`the report's \${name} is \${JSON.stringify(got)}, expected \${want.toFixed(6)} (mean ± 1.96 × √(s²/n)) for 600 pairs with mean 0.01 and s = 0.5\`);
  }
  assert.equal(body.verdict, 'inconclusive', \`600 pairs with an interval from \${(0.01 - half).toFixed(3)} to \${(0.01 + half).toFixed(3)} gave the verdict \${JSON.stringify(body.verdict)}: an interval that contains 0 is inconclusive\`);
  body = await report(c, better);
  assert.equal(body.verdict, 'candidate_better', \`600 pairs with mean +0.1 gave \${JSON.stringify(body.verdict)}, expected candidate_better\`);
  body = await report(c, worse);
  assert.equal(body.verdict, 'candidate_worse', \`600 pairs with mean -0.1 gave \${JSON.stringify(body.verdict)}, expected candidate_worse\`);
}

export async function check_window(ctx) {
  const {c, store} = world(ctx);
  const cfg = await newConfig(store);
  seed(ctx, cfg, 600, 0.1, 0.5);
  const body = await report(c, cfg);
  assert(body.window_start === START && body.window_end === END, \`the report's window is \${JSON.stringify(body.window_start)} to \${JSON.stringify(body.window_end)}, expected \${START} to \${END} (first_at, last_at of the pairs)\`);
}

export async function check_tenant_scope(ctx) {
  const {c, store} = world(ctx);
  const cfg = await newConfig(store, 't1');
  seed(ctx, cfg, 600, 0.1, 0.5);
  let r = await c.get(\`/v1/shadow/configs/\${cfg}/report\`);
  assert.equal(r.status, 401, \`a report without X-Tenant-Id answered \${r.status}, expected 401\`);
  r = await c.get(\`/v1/shadow/configs/\${cfg}/report\`, {headers: {'X-Tenant-Id': 't2'}});
  assert.equal(r.status, 404, \`tenant t2 asked for t1's report and got \${r.status}, expected 404\`);
  assert(!r.text.includes('cand-2026-04'), \`the answer to t2 names t1's candidate version: \${r.text}\`);
  r = await c.get('/v1/shadow/configs/cfg-404/report', {headers: T1});
  assert.equal(r.status, 404, \`a config that does not exist answered \${r.status}, expected 404\`);
  await report(c, cfg);
}
`,
    go: `package main

import (
	"context"
	"fmt"
	"math"
	"net/http"
	"strings"

	"shadow/store"

	"leetbuild/harness"
)

const (
	windowStart = 1767225600
	windowEnd   = 1767312000
)

var readBg = context.Background()

func readAPI(ctx *harness.Ctx) *harness.HTTP {
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

func readConfig(tenant string) string {
	return store.CreateConfig(readBg, tenant, "cand-2026-04", 5, []string{"quality"}).ConfigID
}

// seedPairs writes the comparison consumer's aggregate for n pairs with this mean and sample standard deviation.
func seedPairs(ctx *harness.Ctx, cfg string, n int, mean, sd float64) {
	sumsq := float64(n-1)*sd*sd + float64(n)*mean*mean
	ctx.Redis.Do("HSET", "shadow:"+cfg+":pairs", "n", fmt.Sprint(n), "sum", fmt.Sprint(float64(n)*mean), "sumsq", fmt.Sprint(sumsq),
		"first_at", fmt.Sprint(windowStart), "last_at", fmt.Sprint(windowEnd))
}

func readReport(ctx *harness.Ctx, c *harness.HTTP, cfg string) map[string]any {
	r := c.Get("/v1/shadow/configs/"+cfg+"/report", "X-Tenant-Id", "t1")
	ctx.Equal(r.Status, 200, "GET /v1/shadow/configs/%s/report (%s)", cfg, r.Text())
	var body map[string]any
	r.Decode(&body)
	return body
}

func CheckRoute(ctx *harness.Ctx) {
	c := readAPI(ctx)
	cfg := readConfig("t1")
	body := readReport(ctx, c, cfg)
	ctx.Assert(body["config_id"] == cfg && body["candidate_version"] == "cand-2026-04", "the report is %v, expected config_id %s and its candidate version", body, cfg)
}

func CheckSamples(ctx *harness.Ctx) {
	c := readAPI(ctx)
	cfg := readConfig("t1")
	for i := 0; i < 12; i++ {
		store.RecordPair(readBg, cfg, []float64{0.2, 0.1, 0.3}[i%3], int64(windowStart+60*i))
	}
	body := readReport(ctx, c, cfg)
	ctx.Equal(body["sample_count"], 12.0, "a delta without its count cannot be judged; the report's sample_count")
	ctx.Equal(body["verdict"], "inconclusive", "12 pairs: below MIN_PAIRED_SAMPLES (500) the verdict is inconclusive, however good the mean looks; the verdict")
}

func CheckInterval(ctx *harness.Ctx) {
	c := readAPI(ctx)
	noisy, better, worse := readConfig("t1"), readConfig("t1"), readConfig("t1")
	seedPairs(ctx, noisy, 600, 0.01, 0.5)
	seedPairs(ctx, better, 600, 0.1, 0.5)
	seedPairs(ctx, worse, 600, -0.1, 0.5)
	half := 1.96 * math.Sqrt(0.25/600)
	body := readReport(ctx, c, noisy)
	ctx.Equal(body["sample_count"], 600.0, "the report's sample_count")
	for _, f := range []struct {
		name string
		want float64
	}{{"delta", 0.01}, {"ci_low", 0.01 - half}, {"ci_high", 0.01 + half}} {
		got, ok := body[f.name].(float64)
		ctx.Assert(ok && math.Abs(got-f.want) < 1e-6, "the report's %s is %v, expected %.6f (mean ± 1.96 × √(s²/n)) for 600 pairs with mean 0.01 and s = 0.5", f.name, body[f.name], f.want)
	}
	ctx.Equal(body["verdict"], "inconclusive", "600 pairs with an interval from %.3f to %.3f: an interval that contains 0 is inconclusive; the verdict", 0.01-half, 0.01+half)
	ctx.Equal(readReport(ctx, c, better)["verdict"], "candidate_better", "600 pairs with mean +0.1; the verdict")
	ctx.Equal(readReport(ctx, c, worse)["verdict"], "candidate_worse", "600 pairs with mean -0.1; the verdict")
}

func CheckWindow(ctx *harness.Ctx) {
	c := readAPI(ctx)
	cfg := readConfig("t1")
	seedPairs(ctx, cfg, 600, 0.1, 0.5)
	body := readReport(ctx, c, cfg)
	ctx.Assert(body["window_start"] == float64(windowStart) && body["window_end"] == float64(windowEnd), "the report's window is %v to %v, expected %d to %d (first_at, last_at of the pairs)", body["window_start"], body["window_end"], windowStart, windowEnd)
}

func CheckTenantScope(ctx *harness.Ctx) {
	c := readAPI(ctx)
	cfg := readConfig("t1")
	seedPairs(ctx, cfg, 600, 0.1, 0.5)
	r := c.Get("/v1/shadow/configs/" + cfg + "/report")
	ctx.Equal(r.Status, 401, "a report without X-Tenant-Id")
	r = c.Get("/v1/shadow/configs/"+cfg+"/report", "X-Tenant-Id", "t2")
	ctx.Equal(r.Status, 404, "tenant t2 asked for t1's report")
	ctx.Assert(!strings.Contains(r.Text(), "cand-2026-04"), "the answer to t2 names t1's candidate version: %s", r.Text())
	r = c.Get("/v1/shadow/configs/cfg-404/report", "X-Tenant-Id", "t1")
	ctx.Equal(r.Status, 404, "a config that does not exist")
	readReport(ctx, c, cfg)
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <cmath>
#include <string>

#include "shadow/store.h"

namespace {

constexpr long long kWindowStart = 1767225600;
constexpr long long kWindowEnd = 1767312000;

harness::HTTP readApi(harness::Ctx& ctx) {
  static httplib::Server* svr = nullptr;
  delete svr;
  svr = new httplib::Server;
  register_routes(*svr);
  return ctx.HTTP(*svr);
}

std::string readConfig(const std::string& tenant) { return store::createConfig(tenant, "cand-2026-04", 5, {"quality"}).config_id; }

std::string number(double v) {
  char out[64];
  std::snprintf(out, sizeof out, "%.17g", v);
  return out;
}

// The comparison consumer's aggregate for n pairs with this mean and sample standard deviation.
void seedPairs(harness::Ctx& ctx, const std::string& cfg, int n, double mean, double sd) {
  const double sumsq = (n - 1) * sd * sd + n * mean * mean;
  ctx.Redis.Do("HSET", "shadow:" + cfg + ":pairs", "n", std::to_string(n), "sum", number(n * mean), "sumsq", number(sumsq), "first_at",
               std::to_string(kWindowStart), "last_at", std::to_string(kWindowEnd));
}

nlohmann::json readReport(harness::Ctx& ctx, harness::HTTP& c, const std::string& cfg) {
  const auto r = c.Get("/v1/shadow/configs/" + cfg + "/report", "X-Tenant-Id", "t1");
  ctx.Equal(r.Status, 200, "GET /v1/shadow/configs/%s/report (%s)", cfg, r.Text());
  const auto body = nlohmann::json::parse(r.Text(), nullptr, false);
  ctx.Assert(body.is_object(), "the report must be a JSON object, got %s", r.Text());
  return body;
}

nlohmann::json field(const nlohmann::json& body, const std::string& name) { return body.contains(name) ? body[name] : nlohmann::json(); }

}  // namespace

void CheckRoute(harness::Ctx& ctx) {
  auto c = readApi(ctx);
  const std::string cfg = readConfig("t1");
  const auto body = readReport(ctx, c, cfg);
  ctx.Assert(field(body, "config_id") == cfg && field(body, "candidate_version") == "cand-2026-04", "the report is %s, expected config_id %s and its candidate version", body.dump(), cfg);
}

void CheckSamples(harness::Ctx& ctx) {
  auto c = readApi(ctx);
  const std::string cfg = readConfig("t1");
  const double deltas[] = {0.2, 0.1, 0.3};
  for (int i = 0; i < 12; i++) store::recordPair(cfg, deltas[i % 3], kWindowStart + 60 * i);
  const auto body = readReport(ctx, c, cfg);
  ctx.Equal(field(body, "sample_count"), nlohmann::json(12), "a delta without its count cannot be judged; the report's sample_count");
  ctx.Equal(field(body, "verdict"), nlohmann::json("inconclusive"), "12 pairs: below MIN_PAIRED_SAMPLES (500) the verdict is inconclusive, however good the mean looks; the verdict");
}

void CheckInterval(harness::Ctx& ctx) {
  auto c = readApi(ctx);
  const std::string noisy = readConfig("t1");
  const std::string better = readConfig("t1");
  const std::string worse = readConfig("t1");
  seedPairs(ctx, noisy, 600, 0.01, 0.5);
  seedPairs(ctx, better, 600, 0.1, 0.5);
  seedPairs(ctx, worse, 600, -0.1, 0.5);
  const double half = 1.96 * std::sqrt(0.25 / 600);
  const auto body = readReport(ctx, c, noisy);
  ctx.Equal(field(body, "sample_count"), nlohmann::json(600), "the report's sample_count");
  for (const auto& [name, want] : {std::pair<std::string, double>{"delta", 0.01}, {"ci_low", 0.01 - half}, {"ci_high", 0.01 + half}}) {
    const auto got = field(body, name);
    ctx.Assert(got.is_number() && std::fabs(got.get<double>() - want) < 1e-6, "the report's %s is %s, expected %.6f (mean ± 1.96 × √(s²/n)) for 600 pairs with mean 0.01 and s = 0.5", name, got.dump(), want);
  }
  ctx.Equal(field(body, "verdict"), nlohmann::json("inconclusive"), "600 pairs with an interval from %.3f to %.3f: an interval that contains 0 is inconclusive; the verdict", 0.01 - half, 0.01 + half);
  ctx.Equal(field(readReport(ctx, c, better), "verdict"), nlohmann::json("candidate_better"), "600 pairs with mean +0.1; the verdict");
  ctx.Equal(field(readReport(ctx, c, worse), "verdict"), nlohmann::json("candidate_worse"), "600 pairs with mean -0.1; the verdict");
}

void CheckWindow(harness::Ctx& ctx) {
  auto c = readApi(ctx);
  const std::string cfg = readConfig("t1");
  seedPairs(ctx, cfg, 600, 0.1, 0.5);
  const auto body = readReport(ctx, c, cfg);
  ctx.Assert(field(body, "window_start") == kWindowStart && field(body, "window_end") == kWindowEnd, "the report's window is %s to %s, expected %d to %d (first_at, last_at of the pairs)",
             field(body, "window_start").dump(), field(body, "window_end").dump(), kWindowStart, kWindowEnd);
}

void CheckTenantScope(harness::Ctx& ctx) {
  auto c = readApi(ctx);
  const std::string cfg = readConfig("t1");
  seedPairs(ctx, cfg, 600, 0.1, 0.5);
  auto r = c.Get("/v1/shadow/configs/" + cfg + "/report");
  ctx.Equal(r.Status, 401, "a report without X-Tenant-Id");
  r = c.Get("/v1/shadow/configs/" + cfg + "/report", "X-Tenant-Id", "t2");
  ctx.Equal(r.Status, 404, "tenant t2 asked for t1's report");
  ctx.Assert(r.Text().find("cand-2026-04") == std::string::npos, "the answer to t2 names t1's candidate version: %s", r.Text());
  r = c.Get("/v1/shadow/configs/cfg-404/report", "X-Tenant-Id", "t1");
  ctx.Equal(r.Status, 404, "a config that does not exist");
  readReport(ctx, c, cfg);
}
`,
  },
  hints: [
    "Open a config's report after a dozen pairs: it already names the candidate the winner. Ask for another tenant's config id with your own tenant header: you get their report.",
    'The verdict looks at the sign of the mean only, so it moves with noise and with sample size alike, and the handler loads the config by id without comparing its tenant with the caller.',
    '401 without a tenant; 404 when `config["tenant"] != tenant`; s² = (sumsq − n·mean²)/(n − 1), half = 1.96·√(s²/n); return n, the interval and `first_at`/`last_at`; `inconclusive` below 500 or when the interval contains 0.',
  ],
  debrief: `The report is shaped so it cannot say more than the data does. The count and the interval travel with the mean, so a reader sees how much noise sits around a delta, and the verdict takes the interval's side of 0, not the mean's. The 500-pair floor guards the normal approximation and the habit of peeking, and the window ties the number to the traffic it came from. A foreign config answers 404 so the endpoint confirms nothing. Peeking every hour still inflates false wins, which is why experiment platforms use sequential tests with always-valid intervals (mSPRT, as Optimizely's Stats Engine does) and compare each metric against a guardrail rather than a single delta.`,
};
