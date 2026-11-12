import type {Step} from '@/lib/types';

export const readStep: Step = {
  id: 'read',
  title: 'GET /v1/experiments/{id}/report: no winner without the sample',
  concept: 'http',
  guides: ['honest-reads'],
  file: 'report',
  focus: ['client', 'api', 'redis'],
  task: `## Task

**Starting point.** The starter serves \`GET /v1/experiments/{id}/report\`: it reads the per-variant
counts (\`store.exposures\`, \`store.conversions\`), compares each variant with control (the first
variant) through \`stats.compare\` (\`expd.stats\`, provided: \`lift\`, \`ci_low\`, \`ci_high\`,
\`p_value\`), reports \`lift\` and \`p_value\` per variant, and names the variant with the largest
significant positive lift the winner, \`status: "complete"\`. It serves the demo and hides three
flaws.

**Failure mode the checks target.** The report calls winners it has not earned: a peek on day one
mints one, a split that drifted from the frozen 50/50 (a sign assignment or logging is broken) stays
hidden, and a lift printed alone makes a two-point effect and noise look the same.

- Below the experiment's \`min_sample\` total exposures: \`status: "inconclusive"\`, \`winner: null\`,
  whatever the p-value.
- A variant whose exposures deviate from its share of the split by more than \`SRM_TOLERANCE\` (2 %):
  \`status: "blocked"\`, \`winner: null\`,
  \`caveat: {"kind": "srm", "blocking": true, "variant", "observed", "expected"}\`.
- Every variant row carries \`ci_low\` and \`ci_high\`, whatever the status.`,
  sequence: {
    participants: ['Analyst', 'Experiment API', 'Redis'],
    messages: [
      {from: 'Analyst', to: 'Experiment API', label: 'GET /v1/experiments/{id}/report', kind: 'sync'},
      {
        from: 'Experiment API',
        to: 'Redis',
        label: 'exp:{id} · exp:{id}:exposures · exp:{id}:conversions',
        kind: 'sync',
      },
      {
        from: 'Experiment API',
        to: 'Experiment API',
        label: 'stats.compare per variant → lift, ci_low, ci_high, p_value',
        kind: 'sync',
      },
      {
        from: 'Experiment API',
        to: 'Experiment API',
        label: 'total < min_sample → inconclusive · SRM > 2 % → blocked',
        kind: 'sync',
      },
      {from: 'Experiment API', to: 'Analyst', label: '200 {status, winner, variants, caveat}', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Serves the report with a winner when one is earned',
      detail: 'Register `GET /v1/experiments/{id}/report`; an unknown experiment is **404**.',
      match: {
        python: {all: [/@app\.get\(\s*["']\/v1\/experiments\/\{experiment_id\}\/report["']/]},
        typescript: {all: [/app\.get\(\s*['"]\/v1\/experiments\/:id\/report['"]/]},
        go: {all: [/"GET \/v1\/experiments\/\{id\}\/report"/]},
        scala: {all: [/"report"/, /\bget\s*\{/]},
        cpp: {all: [/svr\.Get\(\s*R"\(\/v1\/experiments\//]},
      },
    },
    {
      id: 'min-sample',
      title: 'Inconclusive below the minimum sample',
      detail:
        "The total exposures are compared with the experiment's `min_sample` before any p-value is read; below it the report is `inconclusive` with no winner.",
      match: {
        python: {order: [/<\s*experiment\[["']min_sample["']\]/, /p_value["']\]\s*<\s*ALPHA/]},
        typescript: {order: [/<\s*experiment\.min_sample/, /p_value\s*<\s*ALPHA/]},
        go: {order: [/<\s*int64\(experiment\.MinSample\)/, /PValue\s*<\s*alpha/]},
        scala: {order: [/<\s*experiment\.minSample/, /pValue\s*<\s*Alpha/]},
        cpp: {order: [/<\s*experiment->min_sample/, /p_value\s*<\s*kAlpha/]},
      },
    },
    {
      id: 'srm',
      title: 'A sample ratio mismatch blocks the winner',
      detail:
        'A variant whose observed exposures deviate from its share of the frozen split by more than `SRM_TOLERANCE` (2 %) makes the report `blocked` with a blocking `srm` caveat and no winner.',
      match: {
        python: {all: [/>\s*SRM_TOLERANCE/, /["']blocked["']/]},
        typescript: {all: [/>\s*SRM_TOLERANCE/, /['"]blocked['"]/]},
        go: {all: [/>\s*srmTolerance/, /"blocked"/]},
        scala: {all: [/>\s*SrmTolerance/, /"blocked"/]},
        cpp: {all: [/>\s*kSrmTolerance/, /"blocked"/]},
      },
    },
    {
      id: 'interval',
      title: 'Every lift carries its 95 % interval',
      detail:
        'Each variant row carries `ci_low` and `ci_high` from `stats.compare` next to `lift`, whatever the status.',
      match: {
        python: {all: [/ci_low/, /ci_high/]},
        typescript: {all: [/ci_low/, /ci_high/]},
        go: {all: [/CILow/, /CIHigh/]},
        scala: {all: [/ciLow/, /ciHigh/]},
        cpp: {all: [/ci_low/, /ci_high/]},
      },
    },
  ],
  code: {
    python: {
      starter: `from fastapi import FastAPI, HTTPException

from expd import stats, store  # stats.compare; store.get, exposures, conversions

app = FastAPI()

ALPHA = 0.05
SRM_TOLERANCE = 0.02


@app.get("/v1/experiments/{experiment_id}/report")
def report(experiment_id: str) -> dict:
    # TODO: this starter has three flaws. The task says where to look; the checks say what must change.
    experiment = store.get(experiment_id)
    if experiment is None:
        raise HTTPException(status_code=404, detail="no such experiment")
    exposures = store.exposures(experiment_id)
    conversions = store.conversions(experiment_id)
    control = experiment["variants"][0]["key"]
    total = sum(exposures.get(v["key"], 0) for v in experiment["variants"])
    rows = []
    for v in experiment["variants"][1:]:
        key = v["key"]
        result = stats.compare(exposures.get(control, 0), conversions.get(control, 0), exposures.get(key, 0), conversions.get(key, 0))
        rows.append({"variant": key, "exposures": exposures.get(key, 0), "conversions": conversions.get(key, 0), "lift": result["lift"], "p_value": result["p_value"]})
    significant = [row for row in rows if row["p_value"] < ALPHA and row["lift"] > 0]
    winner = max(significant, key=lambda row: row["lift"])["variant"] if significant else None
    return {"experiment_id": experiment_id, "exposures": total, "variants": rows, "winner": winner, "caveat": None, "status": "complete"}
`,
      solution: `from fastapi import FastAPI, HTTPException

from expd import stats, store  # stats.compare; store.get, exposures, conversions

app = FastAPI()

ALPHA = 0.05
SRM_TOLERANCE = 0.02


def sample_ratio_mismatch(variants: list[dict], exposures: dict[str, int], total: int) -> dict | None:
    """The first variant whose share of the exposures strays from its weight by more than SRM_TOLERANCE."""
    for v in variants:
        expected = total * v["weight"] / 100
        observed = exposures.get(v["key"], 0)
        if expected > 0 and abs(observed - expected) / expected > SRM_TOLERANCE:
            return {"kind": "srm", "blocking": True, "variant": v["key"], "observed": observed, "expected": expected}
    return None


@app.get("/v1/experiments/{experiment_id}/report")
def report(experiment_id: str) -> dict:
    experiment = store.get(experiment_id)
    if experiment is None:
        raise HTTPException(status_code=404, detail="no such experiment")
    exposures = store.exposures(experiment_id)
    conversions = store.conversions(experiment_id)
    control = experiment["variants"][0]["key"]
    total = sum(exposures.get(v["key"], 0) for v in experiment["variants"])
    rows = []
    for v in experiment["variants"][1:]:
        key = v["key"]
        result = stats.compare(exposures.get(control, 0), conversions.get(control, 0), exposures.get(key, 0), conversions.get(key, 0))
        # Every lift travels with its interval.
        rows.append({"variant": key, "exposures": exposures.get(key, 0), "conversions": conversions.get(key, 0),
                     "lift": result["lift"], "ci_low": result["ci_low"], "ci_high": result["ci_high"], "p_value": result["p_value"]})
    body = {"experiment_id": experiment_id, "exposures": total, "variants": rows, "winner": None, "caveat": None}
    # The sample and the split are judged before any p-value is read.
    if total < experiment["min_sample"]:
        return {**body, "status": "inconclusive", "reason": "minimum sample not reached"}
    caveat = sample_ratio_mismatch(experiment["variants"], exposures, total)
    if caveat is not None:
        return {**body, "status": "blocked", "caveat": caveat}
    significant = [row for row in rows if row["p_value"] < ALPHA and row["lift"] > 0]
    winner = max(significant, key=lambda row: row["lift"])["variant"] if significant else None
    return {**body, "status": "complete", "winner": winner}
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';

import {compare} from 'expd/stats';
import {conversions, exposures, get} from 'expd/store';

export const app = Fastify();

export const ALPHA = 0.05;
export const SRM_TOLERANCE = 0.02;

app.get('/v1/experiments/:id/report', async (request, reply) => {
  // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
  const {id} = request.params as {id: string};
  const experiment = await get(id);
  if (experiment === null) return reply.code(404).send({error: 'no such experiment'});
  const seen = await exposures(id);
  const converted = await conversions(id);
  const control = experiment.variants[0].key;
  const total = experiment.variants.reduce((sum, v) => sum + (seen[v.key] ?? 0), 0);
  const rows = experiment.variants.slice(1).map(v => {
    const {lift, p_value} = compare(seen[control] ?? 0, converted[control] ?? 0, seen[v.key] ?? 0, converted[v.key] ?? 0);
    return {variant: v.key, exposures: seen[v.key] ?? 0, conversions: converted[v.key] ?? 0, lift, p_value};
  });
  const significant = rows.filter(row => row.p_value < ALPHA && row.lift > 0).sort((a, b) => b.lift - a.lift);
  return {experiment_id: id, exposures: total, variants: rows, winner: significant[0]?.variant ?? null, caveat: null, status: 'complete'};
});
`,
      solution: `import Fastify from 'fastify';

import {compare} from 'expd/stats';
import {type Variant, conversions, exposures, get} from 'expd/store';

export const app = Fastify();

export const ALPHA = 0.05;
export const SRM_TOLERANCE = 0.02;

/** The first variant whose share of the exposures strays from its weight by more than SRM_TOLERANCE. */
function sampleRatioMismatch(variants: Variant[], seen: Record<string, number>, total: number): Record<string, unknown> | null {
  for (const v of variants) {
    const expected = (total * v.weight) / 100;
    const observed = seen[v.key] ?? 0;
    if (expected > 0 && Math.abs(observed - expected) / expected > SRM_TOLERANCE) {
      return {kind: 'srm', blocking: true, variant: v.key, observed, expected};
    }
  }
  return null;
}

app.get('/v1/experiments/:id/report', async (request, reply) => {
  const {id} = request.params as {id: string};
  const experiment = await get(id);
  if (experiment === null) return reply.code(404).send({error: 'no such experiment'});
  const seen = await exposures(id);
  const converted = await conversions(id);
  const control = experiment.variants[0].key;
  const total = experiment.variants.reduce((sum, v) => sum + (seen[v.key] ?? 0), 0);
  // Every lift travels with its interval.
  const rows = experiment.variants.slice(1).map(v => {
    const {lift, ci_low, ci_high, p_value} = compare(seen[control] ?? 0, converted[control] ?? 0, seen[v.key] ?? 0, converted[v.key] ?? 0);
    return {variant: v.key, exposures: seen[v.key] ?? 0, conversions: converted[v.key] ?? 0, lift, ci_low, ci_high, p_value};
  });
  const body = {experiment_id: id, exposures: total, variants: rows, winner: null as string | null, caveat: null as Record<string, unknown> | null};
  // The sample and the split are judged before any p-value is read.
  if (total < experiment.min_sample) return {...body, status: 'inconclusive', reason: 'minimum sample not reached'};
  const caveat = sampleRatioMismatch(experiment.variants, seen, total);
  if (caveat !== null) return {...body, status: 'blocked', caveat};
  const significant = rows.filter(row => row.p_value < ALPHA && row.lift > 0).sort((a, b) => b.lift - a.lift);
  return {...body, status: 'complete', winner: significant[0]?.variant ?? null};
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"net/http"

	"expd/stats" // stats.Compare
	"expd/store" // store.Get, Exposures, Conversions
)

const alpha = 0.05

const srmTolerance = 0.02

func writeJSON(rw http.ResponseWriter, code int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(code)
	json.NewEncoder(rw).Encode(v)
}

func report(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has three flaws. The task says where to look; the checks say what must change.
	id := r.PathValue("id")
	experiment := store.Get(r.Context(), id)
	if experiment == nil {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "no such experiment"})
		return
	}
	exposures := store.Exposures(r.Context(), id)
	conversions := store.Conversions(r.Context(), id)
	control := experiment.Variants[0].Key
	var total int64
	for _, v := range experiment.Variants {
		total += exposures[v.Key]
	}
	rows := []map[string]any{}
	var winner any
	best := 0.0
	for _, v := range experiment.Variants[1:] {
		c := stats.Compare(exposures[control], conversions[control], exposures[v.Key], conversions[v.Key])
		rows = append(rows, map[string]any{"variant": v.Key, "exposures": exposures[v.Key], "conversions": conversions[v.Key], "lift": c.Lift, "p_value": c.PValue})
		if c.PValue < alpha && c.Lift > best {
			best, winner = c.Lift, v.Key
		}
	}
	writeJSON(rw, http.StatusOK, map[string]any{"experiment_id": id, "exposures": total, "variants": rows, "winner": winner, "caveat": nil, "status": "complete"})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/experiments/{id}/report", report)
}
`,
      solution: `package main

import (
	"encoding/json"
	"math"
	"net/http"

	"expd/stats" // stats.Compare
	"expd/store" // store.Get, Exposures, Conversions
)

const alpha = 0.05

const srmTolerance = 0.02

func writeJSON(rw http.ResponseWriter, code int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(code)
	json.NewEncoder(rw).Encode(v)
}

// sampleRatioMismatch is the first variant whose share of the exposures strays from its weight by
// more than srmTolerance, or nil.
func sampleRatioMismatch(variants []store.Variant, exposures map[string]int64, total int64) map[string]any {
	for _, v := range variants {
		expected := float64(total) * float64(v.Weight) / 100
		observed := exposures[v.Key]
		if expected > 0 && math.Abs(float64(observed)-expected)/expected > srmTolerance {
			return map[string]any{"kind": "srm", "blocking": true, "variant": v.Key, "observed": observed, "expected": expected}
		}
	}
	return nil
}

func report(rw http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	experiment := store.Get(r.Context(), id)
	if experiment == nil {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "no such experiment"})
		return
	}
	exposures := store.Exposures(r.Context(), id)
	conversions := store.Conversions(r.Context(), id)
	control := experiment.Variants[0].Key
	var total int64
	for _, v := range experiment.Variants {
		total += exposures[v.Key]
	}
	rows := []map[string]any{}
	comparisons := []stats.Comparison{}
	for _, v := range experiment.Variants[1:] {
		c := stats.Compare(exposures[control], conversions[control], exposures[v.Key], conversions[v.Key])
		comparisons = append(comparisons, c)
		// Every lift travels with its interval.
		rows = append(rows, map[string]any{"variant": v.Key, "exposures": exposures[v.Key], "conversions": conversions[v.Key],
			"lift": c.Lift, "ci_low": c.CILow, "ci_high": c.CIHigh, "p_value": c.PValue})
	}
	body := map[string]any{"experiment_id": id, "exposures": total, "variants": rows, "winner": nil, "caveat": nil}
	// The sample and the split are judged before any p-value is read.
	if total < int64(experiment.MinSample) {
		body["status"], body["reason"] = "inconclusive", "minimum sample not reached"
		writeJSON(rw, http.StatusOK, body)
		return
	}
	if caveat := sampleRatioMismatch(experiment.Variants, exposures, total); caveat != nil {
		body["status"], body["caveat"] = "blocked", caveat
		writeJSON(rw, http.StatusOK, body)
		return
	}
	var winner any
	best := 0.0
	for i, c := range comparisons {
		if c.PValue < alpha && c.Lift > best {
			best, winner = c.Lift, experiment.Variants[i+1].Key
		}
	}
	body["status"], body["winner"] = "complete", winner
	writeJSON(rw, http.StatusOK, body)
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/experiments/{id}/report", report)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import expd.{Stats, Store} // Stats.compare; Store.get, exposures, conversions

object Report {
  val Alpha = 0.05
  val SrmTolerance = 0.02

  def report(id: String): Option[JsObject] =
    // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
    Store.get(id).map { experiment =>
      val exposures = Store.exposures(id).withDefaultValue(0L)
      val conversions = Store.conversions(id).withDefaultValue(0L)
      val control = experiment.variants.head.key
      val total = experiment.variants.map(v => exposures(v.key)).sum
      val compared = experiment.variants.tail.map(v => v.key -> Stats.compare(exposures(control), conversions(control), exposures(v.key), conversions(v.key)))
      val rows = compared.map { case (key, c) =>
        JsObject("variant" -> JsString(key), "exposures" -> JsNumber(exposures(key)), "conversions" -> JsNumber(conversions(key)),
          "lift" -> JsNumber(c.lift), "p_value" -> JsNumber(c.pValue))
      }
      val winner = compared.filter { case (_, c) => c.pValue < Alpha && c.lift > 0 }.sortBy(-_._2.lift).headOption.map(_._1)
      JsObject("experiment_id" -> JsString(id), "exposures" -> JsNumber(total), "variants" -> JsArray(rows.toVector),
        "winner" -> winner.map(JsString(_)).getOrElse(JsNull), "caveat" -> JsNull, "status" -> JsString("complete"))
    }

  val route: Route = path("v1" / "experiments" / Segment / "report") { id =>
    get {
      report(id) match {
        case None => complete(StatusCodes.NotFound -> "no such experiment")
        case Some(body) => complete(HttpResponse(StatusCodes.OK, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint)))
      }
    }
  }
}
`,
      solution: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import expd.{Stats, Store} // Stats.compare; Store.get, exposures, conversions

object Report {
  val Alpha = 0.05
  val SrmTolerance = 0.02

  /** The first variant whose share of the exposures strays from its weight by more than SrmTolerance. */
  def sampleRatioMismatch(variants: Seq[Store.Variant], exposures: Map[String, Long], total: Long): Option[JsObject] =
    variants.iterator.map { v =>
      val expected = total.toDouble * v.weight / 100
      val observed = exposures.getOrElse(v.key, 0L)
      (v.key, observed, expected)
    }.collectFirst {
      case (key, observed, expected) if expected > 0 && math.abs(observed - expected) / expected > SrmTolerance =>
        JsObject("kind" -> JsString("srm"), "blocking" -> JsTrue, "variant" -> JsString(key), "observed" -> JsNumber(observed), "expected" -> JsNumber(expected))
    }

  def report(id: String): Option[JsObject] =
    Store.get(id).map { experiment =>
      val exposures = Store.exposures(id).withDefaultValue(0L)
      val conversions = Store.conversions(id).withDefaultValue(0L)
      val control = experiment.variants.head.key
      val total = experiment.variants.map(v => exposures(v.key)).sum
      val compared = experiment.variants.tail.map(v => v.key -> Stats.compare(exposures(control), conversions(control), exposures(v.key), conversions(v.key)))
      // Every lift travels with its interval.
      val rows = compared.map { case (key, c) =>
        JsObject("variant" -> JsString(key), "exposures" -> JsNumber(exposures(key)), "conversions" -> JsNumber(conversions(key)),
          "lift" -> JsNumber(c.lift), "ci_low" -> JsNumber(c.ciLow), "ci_high" -> JsNumber(c.ciHigh), "p_value" -> JsNumber(c.pValue))
      }
      val body = Map[String, JsValue]("experiment_id" -> JsString(id), "exposures" -> JsNumber(total), "variants" -> JsArray(rows.toVector),
        "winner" -> JsNull, "caveat" -> JsNull)
      // The sample and the split are judged before any p-value is read.
      if (total < experiment.minSample) JsObject(body ++ Map("status" -> JsString("inconclusive"), "reason" -> JsString("minimum sample not reached")))
      else
        sampleRatioMismatch(experiment.variants, exposures, total) match {
          case Some(caveat) => JsObject(body ++ Map("status" -> JsString("blocked"), "caveat" -> caveat))
          case None =>
            val winner = compared.filter { case (_, c) => c.pValue < Alpha && c.lift > 0 }.sortBy(-_._2.lift).headOption.map(_._1)
            JsObject(body ++ Map("status" -> JsString("complete"), "winner" -> winner.map(JsString(_)).getOrElse(JsNull)))
        }
    }

  val route: Route = path("v1" / "experiments" / Segment / "report") { id =>
    get {
      report(id) match {
        case None => complete(StatusCodes.NotFound -> "no such experiment")
        case Some(body) => complete(HttpResponse(StatusCodes.OK, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint)))
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

#include "expd/stats.h"  // stats::compare
#include "expd/store.h"  // store::get, exposures, conversions

using json = nlohmann::json;

constexpr double kAlpha = 0.05;
constexpr double kSrmTolerance = 0.02;

void report(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
  const std::string id = req.matches[1];
  const auto experiment = store::get(id);
  if (!experiment) {
    res.status = 404;
    res.set_content("no such experiment", "text/plain");
    return;
  }
  std::map<std::string, long long> exposures = store::exposures(id);
  std::map<std::string, long long> conversions = store::conversions(id);
  const std::string control = experiment->variants[0].key;
  long long total = 0;
  for (const auto& v : experiment->variants) total += exposures[v.key];
  json rows = json::array();
  json winner = nullptr;
  double best = 0;
  for (size_t i = 1; i < experiment->variants.size(); i++) {
    const std::string& key = experiment->variants[i].key;
    const stats::Comparison c = stats::compare(exposures[control], conversions[control], exposures[key], conversions[key]);
    rows.push_back({{"variant", key}, {"exposures", exposures[key]}, {"conversions", conversions[key]}, {"lift", c.lift}, {"p_value", c.p_value}});
    if (c.p_value < kAlpha && c.lift > best) {
      best = c.lift;
      winner = key;
    }
  }
  const json body = {{"experiment_id", id}, {"exposures", total}, {"variants", rows}, {"winner", winner}, {"caveat", nullptr}, {"status", "complete"}};
  res.set_content(body.dump(), "application/json");
}

void register_routes(httplib::Server& svr) {
  svr.Get(R"(/v1/experiments/([\\w-]+)/report)", report);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <cmath>
#include <map>
#include <string>
#include <vector>

#include "expd/stats.h"  // stats::compare
#include "expd/store.h"  // store::get, exposures, conversions

using json = nlohmann::json;

constexpr double kAlpha = 0.05;
constexpr double kSrmTolerance = 0.02;

// The first variant whose share of the exposures strays from its weight by more than
// kSrmTolerance, or null.
json sample_ratio_mismatch(const std::vector<store::Variant>& variants, std::map<std::string, long long>& exposures, long long total) {
  for (const auto& v : variants) {
    const double expected = static_cast<double>(total) * v.weight / 100;
    const long long observed = exposures[v.key];
    if (expected > 0 && std::fabs(observed - expected) / expected > kSrmTolerance) {
      return {{"kind", "srm"}, {"blocking", true}, {"variant", v.key}, {"observed", observed}, {"expected", expected}};
    }
  }
  return nullptr;
}

void report(const httplib::Request& req, httplib::Response& res) {
  const std::string id = req.matches[1];
  const auto experiment = store::get(id);
  if (!experiment) {
    res.status = 404;
    res.set_content("no such experiment", "text/plain");
    return;
  }
  std::map<std::string, long long> exposures = store::exposures(id);
  std::map<std::string, long long> conversions = store::conversions(id);
  const std::string control = experiment->variants[0].key;
  long long total = 0;
  for (const auto& v : experiment->variants) total += exposures[v.key];
  json rows = json::array();
  std::vector<stats::Comparison> compared;
  for (size_t i = 1; i < experiment->variants.size(); i++) {
    const std::string& key = experiment->variants[i].key;
    const stats::Comparison c = stats::compare(exposures[control], conversions[control], exposures[key], conversions[key]);
    compared.push_back(c);
    // Every lift travels with its interval.
    rows.push_back({{"variant", key}, {"exposures", exposures[key]}, {"conversions", conversions[key]}, {"lift", c.lift},
                    {"ci_low", c.ci_low}, {"ci_high", c.ci_high}, {"p_value", c.p_value}});
  }
  json body = {{"experiment_id", id}, {"exposures", total}, {"variants", rows}, {"winner", nullptr}, {"caveat", nullptr}};
  // The sample and the split are judged before any p-value is read.
  if (total < experiment->min_sample) {
    body["status"] = "inconclusive";
    body["reason"] = "minimum sample not reached";
  } else if (const json caveat = sample_ratio_mismatch(experiment->variants, exposures, total); !caveat.is_null()) {
    body["status"] = "blocked";
    body["caveat"] = caveat;
  } else {
    double best = 0;
    for (size_t i = 0; i < compared.size(); i++) {
      if (compared[i].p_value < kAlpha && compared[i].lift > best) {
        best = compared[i].lift;
        body["winner"] = experiment->variants[i + 1].key;
      }
    }
    body["status"] = "complete";
  }
  res.set_content(body.dump(), "application/json");
}

void register_routes(httplib::Server& svr) {
  svr.Get(R"(/v1/experiments/([\\w-]+)/report)", report);
}
`,
    },
  },
  harness: {
    python: `import math

from expd import store

SPLIT = [{"key": "control", "weight": 50}, {"key": "treatment", "weight": 50}]
BALANCED = ({"control": 5000, "treatment": 5000}, {"control": 500, "treatment": 600})
DRIFTED = ({"control": 5600, "treatment": 4400}, {"control": 560, "treatment": 528})


def _experiment(ctx, min_sample, counts):
    experiment_id = store.create({"name": "cta", "unit": "user", "variants": SPLIT, "min_sample": min_sample, "salt": "s-1"})["id"]
    ctx.redis.hset(f"exp:{experiment_id}:exposures", mapping=counts[0])
    ctx.redis.hset(f"exp:{experiment_id}:conversions", mapping=counts[1])
    return experiment_id


async def _report(ctx, experiment_id):
    async with ctx.client(ctx.load("report").app) as c:
        r = await c.get(f"/v1/experiments/{experiment_id}/report")
    assert r.status_code == 200, f"GET /v1/experiments/{experiment_id}/report answered {r.status_code}: {r.text}"
    return r.json()


def _treatment(body):
    row = next((row for row in body.get("variants") or [] if row.get("variant") == "treatment"), None)
    assert row is not None, f"the report has no treatment row: {body}"
    return row


async def check_route(ctx):
    e = _experiment(ctx, 2000, BALANCED)
    body = await _report(ctx, e)
    assert body.get("status") == "complete" and body.get("winner") == "treatment", f"10,000 balanced exposures with treatment converting 12 % against 10 % must name treatment, got {body}"
    row = _treatment(body)
    assert math.isclose(row.get("lift", 0), 0.02, abs_tol=1e-9) and row.get("p_value", 1) < 0.05, f"the treatment row must carry lift 0.02 and its p-value, got {row}"
    async with ctx.client(ctx.load("report").app) as c:
        r = await c.get("/v1/experiments/exp-404/report")
    assert r.status_code == 404, f"an unknown experiment answered {r.status_code}, expected 404"


async def check_min_sample(ctx):
    e = _experiment(ctx, 20000, BALANCED)
    body = await _report(ctx, e)
    assert body.get("winner") is None, f"with 10,000 of the 20,000 exposures the design needs, the report named {body.get('winner')!r} the winner: a peek is not a result"
    assert body.get("status") == "inconclusive", f"below min_sample the status must be inconclusive, got {body.get('status')!r}"


async def check_srm(ctx):
    e = _experiment(ctx, 2000, DRIFTED)
    body = await _report(ctx, e)
    assert body.get("winner") is None, f"a 56/44 split of a 50/50 design named {body.get('winner')!r} the winner: a sample ratio mismatch must block it"
    caveat = body.get("caveat") or {}
    assert body.get("status") == "blocked" and caveat.get("kind") == "srm" and caveat.get("blocking") is True, f"the report must be blocked with a blocking srm caveat, got status {body.get('status')!r}, caveat {body.get('caveat')}"
    near = _experiment(ctx, 2000, ({"control": 5050, "treatment": 4950}, {"control": 505, "treatment": 594}))
    body = await _report(ctx, near)
    assert body.get("status") == "complete" and body.get("winner") == "treatment", f"a 50.5/49.5 split is within SRM_TOLERANCE and must not block, got {body}"


async def check_interval(ctx):
    for min_sample, counts, status in ((2000, BALANCED, "complete"), (20000, BALANCED, "inconclusive"), (2000, DRIFTED, "blocked")):
        body = await _report(ctx, _experiment(ctx, min_sample, counts))
        row = _treatment(body)
        assert "ci_low" in row and "ci_high" in row, f"a {body.get('status')} report's treatment row has no interval: {row}. Every lift carries ci_low and ci_high"
        (cn, n), (cx, x) = (counts[0]["control"], counts[0]["treatment"]), (counts[1]["control"], counts[1]["treatment"])
        pc, pt = cx / cn, x / n
        half = 1.959964 * math.sqrt(pc * (1 - pc) / cn + pt * (1 - pt) / n)
        lift = pt - pc
        assert math.isclose(row["ci_low"], lift - half, abs_tol=1e-6) and math.isclose(row["ci_high"], lift + half, abs_tol=1e-6), f"the {status} report's interval is [{row['ci_low']}, {row['ci_high']}], expected [{lift - half:.6f}, {lift + half:.6f}] from stats.compare"
`,
    typescript: `const SPLIT = [
  {key: 'control', weight: 50},
  {key: 'treatment', weight: 50},
];
type Counts = [Record<string, number>, Record<string, number>];
const BALANCED: Counts = [{control: 5000, treatment: 5000}, {control: 500, treatment: 600}];
const DRIFTED: Counts = [{control: 5600, treatment: 4400}, {control: 560, treatment: 528}];

async function experiment(ctx, minSample: number, counts: Counts): Promise<string> {
  const store = ctx.load('/support/expd/store.ts');
  const id = (await store.create({name: 'cta', unit: 'user', variants: SPLIT, min_sample: minSample, salt: 's-1'})).id;
  ctx.redis.hset(\`exp:\${id}:exposures\`, counts[0]);
  ctx.redis.hset(\`exp:\${id}:conversions\`, counts[1]);
  return id;
}

async function report(ctx, id: string) {
  const r = await ctx.client(ctx.load('report').app).get(\`/v1/experiments/\${id}/report\`);
  assert.equal(r.status, 200, \`GET /v1/experiments/\${id}/report answered \${r.status}: \${r.text}\`);
  return r.json();
}

function treatment(body) {
  const row = (body.variants ?? []).find(v => v.variant === 'treatment');
  assert(row !== undefined, \`the report has no treatment row: \${JSON.stringify(body)}\`);
  return row;
}

export async function check_route(ctx) {
  const body = await report(ctx, await experiment(ctx, 2000, BALANCED));
  assert(body.status === 'complete' && body.winner === 'treatment', \`10,000 balanced exposures with treatment converting 12 % against 10 % must name treatment, got \${JSON.stringify(body)}\`);
  const row = treatment(body);
  assert(Math.abs(row.lift - 0.02) < 1e-9 && row.p_value < 0.05, \`the treatment row must carry lift 0.02 and its p-value, got \${JSON.stringify(row)}\`);
  const r = await ctx.client(ctx.load('report').app).get('/v1/experiments/exp-404/report');
  assert.equal(r.status, 404, \`an unknown experiment answered \${r.status}, expected 404\`);
}

export async function check_min_sample(ctx) {
  const body = await report(ctx, await experiment(ctx, 20000, BALANCED));
  assert.equal(body.winner, null, \`with 10,000 of the 20,000 exposures the design needs, the report named \${body.winner} the winner: a peek is not a result\`);
  assert.equal(body.status, 'inconclusive', \`below min_sample the status must be inconclusive, got \${body.status}\`);
}

export async function check_srm(ctx) {
  let body = await report(ctx, await experiment(ctx, 2000, DRIFTED));
  assert.equal(body.winner, null, \`a 56/44 split of a 50/50 design named \${body.winner} the winner: a sample ratio mismatch must block it\`);
  const caveat = body.caveat ?? {};
  assert(body.status === 'blocked' && caveat.kind === 'srm' && caveat.blocking === true, \`the report must be blocked with a blocking srm caveat, got status \${body.status}, caveat \${JSON.stringify(body.caveat)}\`);
  body = await report(ctx, await experiment(ctx, 2000, [{control: 5050, treatment: 4950}, {control: 505, treatment: 594}]));
  assert(body.status === 'complete' && body.winner === 'treatment', \`a 50.5/49.5 split is within SRM_TOLERANCE and must not block, got \${JSON.stringify(body)}\`);
}

export async function check_interval(ctx) {
  const cases: [number, Counts, string][] = [[2000, BALANCED, 'complete'], [20000, BALANCED, 'inconclusive'], [2000, DRIFTED, 'blocked']];
  for (const [minSample, counts, status] of cases) {
    const body = await report(ctx, await experiment(ctx, minSample, counts));
    const row = treatment(body);
    assert('ci_low' in row && 'ci_high' in row, \`a \${body.status} report's treatment row has no interval: \${JSON.stringify(row)}. Every lift carries ci_low and ci_high\`);
    const [cn, n, cx, x] = [counts[0].control, counts[0].treatment, counts[1].control, counts[1].treatment];
    const pc = cx / cn;
    const pt = x / n;
    const half = 1.959964 * Math.sqrt((pc * (1 - pc)) / cn + (pt * (1 - pt)) / n);
    const lift = pt - pc;
    assert(Math.abs(row.ci_low - (lift - half)) < 1e-6 && Math.abs(row.ci_high - (lift + half)) < 1e-6, \`the \${status} report's interval is [\${row.ci_low}, \${row.ci_high}], expected [\${lift - half}, \${lift + half}] from compare\`);
  }
}
`,
    go: `package main

import (
	"context"
	"math"
	"net/http"

	"expd/store"

	"leetbuild/harness"
)

type counts struct{ cn, n, cx, x int64 }

var (
	balanced = counts{5000, 5000, 500, 600}
	drifted  = counts{5600, 4400, 560, 528}
)

func reportOf(ctx *harness.Ctx, minSample int, c counts) map[string]any {
	id := store.Create(context.Background(), store.Design{Name: "cta", Unit: "user", Variants: []store.Variant{{Key: "control", Weight: 50}, {Key: "treatment", Weight: 50}}, MinSample: minSample, Salt: "s-1"}).ID
	ctx.Redis.Do("HSET", "exp:"+id+":exposures", "control", c.cn, "treatment", c.n)
	ctx.Redis.Do("HSET", "exp:"+id+":conversions", "control", c.cx, "treatment", c.x)
	mux := http.NewServeMux()
	register(mux)
	r := ctx.HTTP(mux).Get("/v1/experiments/" + id + "/report")
	ctx.Equal(r.Status, 200, "GET /v1/experiments/%s/report (%s)", id, r.Text())
	var body map[string]any
	r.Decode(&body)
	return body
}

func treatmentRow(ctx *harness.Ctx, body map[string]any) map[string]any {
	rows, _ := body["variants"].([]any)
	for _, raw := range rows {
		if row, ok := raw.(map[string]any); ok && row["variant"] == "treatment" {
			return row
		}
	}
	ctx.Fatalf("the report has no treatment row: %v", body)
	return nil
}

func CheckRoute(ctx *harness.Ctx) {
	body := reportOf(ctx, 2000, balanced)
	ctx.Assert(body["status"] == "complete" && body["winner"] == "treatment", "10,000 balanced exposures with treatment converting 12 %% against 10 %% must name treatment, got %v", body)
	row := treatmentRow(ctx, body)
	lift, _ := row["lift"].(float64)
	p, _ := row["p_value"].(float64)
	ctx.Assert(math.Abs(lift-0.02) < 1e-9 && p < 0.05, "the treatment row must carry lift 0.02 and its p-value, got %v", row)
	mux := http.NewServeMux()
	register(mux)
	r := ctx.HTTP(mux).Get("/v1/experiments/exp-404/report")
	ctx.Equal(r.Status, 404, "an unknown experiment")
}

func CheckMinSample(ctx *harness.Ctx) {
	body := reportOf(ctx, 20000, balanced)
	ctx.Assert(body["winner"] == nil, "with 10,000 of the 20,000 exposures the design needs, the report named %v the winner: a peek is not a result", body["winner"])
	ctx.Equal(body["status"], "inconclusive", "below min_sample the status")
}

func CheckSrm(ctx *harness.Ctx) {
	body := reportOf(ctx, 2000, drifted)
	ctx.Assert(body["winner"] == nil, "a 56/44 split of a 50/50 design named %v the winner: a sample ratio mismatch must block it", body["winner"])
	caveat, _ := body["caveat"].(map[string]any)
	ctx.Assert(body["status"] == "blocked" && caveat != nil && caveat["kind"] == "srm" && caveat["blocking"] == true, "the report must be blocked with a blocking srm caveat, got status %v, caveat %v", body["status"], body["caveat"])
	body = reportOf(ctx, 2000, counts{5050, 4950, 505, 594})
	ctx.Assert(body["status"] == "complete" && body["winner"] == "treatment", "a 50.5/49.5 split is within srmTolerance and must not block, got %v", body)
}

func CheckInterval(ctx *harness.Ctx) {
	for _, tc := range []struct {
		minSample int
		c         counts
		status    string
	}{{2000, balanced, "complete"}, {20000, balanced, "inconclusive"}, {2000, drifted, "blocked"}} {
		row := treatmentRow(ctx, reportOf(ctx, tc.minSample, tc.c))
		low, okLow := row["ci_low"].(float64)
		high, okHigh := row["ci_high"].(float64)
		ctx.Assert(okLow && okHigh, "a %s report's treatment row has no interval: %v. Every lift carries ci_low and ci_high", tc.status, row)
		pc, pt := float64(tc.c.cx)/float64(tc.c.cn), float64(tc.c.x)/float64(tc.c.n)
		half := 1.959964 * math.Sqrt(pc*(1-pc)/float64(tc.c.cn)+pt*(1-pt)/float64(tc.c.n))
		lift := pt - pc
		ctx.Assert(math.Abs(low-(lift-half)) < 1e-6 && math.Abs(high-(lift+half)) < 1e-6, "the %s report's interval is [%v, %v], expected [%v, %v] from stats.Compare", tc.status, low, high, lift-half, lift+half)
	}
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <cmath>
#include <string>
#include <vector>

#include "expd/store.h"

namespace {

using json = nlohmann::json;

struct Counts {
  long long cn, n, cx, x;
};

const Counts kBalanced{5000, 5000, 500, 600};
const Counts kDrifted{5600, 4400, 560, 528};

harness::HTTP api(harness::Ctx& ctx) {
  static httplib::Server* svr = nullptr;
  delete svr;
  svr = new httplib::Server;
  register_routes(*svr);
  return ctx.HTTP(*svr);
}

json reportOf(harness::Ctx& ctx, long min_sample, const Counts& c) {
  const std::string id = store::create(store::Design{"cta", "user", {{"control", 50}, {"treatment", 50}}, min_sample, "s-1"}).id;
  ctx.Redis.Do("HSET", "exp:" + id + ":exposures", "control", c.cn, "treatment", c.n);
  ctx.Redis.Do("HSET", "exp:" + id + ":conversions", "control", c.cx, "treatment", c.x);
  auto http = api(ctx);
  const auto r = http.Get("/v1/experiments/" + id + "/report");
  ctx.Equal(r.Status, 200, "GET /v1/experiments/%s/report (%s)", id, r.Text());
  return json::parse(r.Text(), nullptr, false);
}

json treatmentRow(harness::Ctx& ctx, const json& body) {
  if (body.is_object() && body.contains("variants") && body["variants"].is_array()) {
    for (const auto& row : body["variants"]) {
      if (row.is_object() && row.value("variant", "") == "treatment") return row;
    }
  }
  ctx.Fatalf("the report has no treatment row: %s", body.dump());
}

std::string text(const json& body, const char* field) { return body.contains(field) && body[field].is_string() ? body[field].get<std::string>() : ""; }

}  // namespace

void CheckRoute(harness::Ctx& ctx) {
  const json body = reportOf(ctx, 2000, kBalanced);
  ctx.Assert(text(body, "status") == "complete" && text(body, "winner") == "treatment", "10,000 balanced exposures with treatment converting 12 %% against 10 %% must name treatment, got %s", body.dump());
  const json row = treatmentRow(ctx, body);
  ctx.Assert(std::fabs(row.value("lift", 0.0) - 0.02) < 1e-9 && row.value("p_value", 1.0) < 0.05, "the treatment row must carry lift 0.02 and its p-value, got %s", row.dump());
  auto http = api(ctx);
  ctx.Equal(http.Get("/v1/experiments/exp-404/report").Status, 404, "an unknown experiment");
}

void CheckMinSample(harness::Ctx& ctx) {
  const json body = reportOf(ctx, 20000, kBalanced);
  ctx.Assert(body.contains("winner") && body["winner"].is_null(), "with 10,000 of the 20,000 exposures the design needs, the report named %s the winner: a peek is not a result", body.value("winner", json()).dump());
  ctx.Equal(text(body, "status"), "inconclusive", "below min_sample the status");
}

void CheckSrm(harness::Ctx& ctx) {
  json body = reportOf(ctx, 2000, kDrifted);
  ctx.Assert(body.contains("winner") && body["winner"].is_null(), "a 56/44 split of a 50/50 design named %s the winner: a sample ratio mismatch must block it", body.value("winner", json()).dump());
  const json caveat = body.value("caveat", json());
  ctx.Assert(text(body, "status") == "blocked" && caveat.is_object() && caveat.value("kind", "") == "srm" && caveat.value("blocking", false), "the report must be blocked with a blocking srm caveat, got status %q, caveat %s", text(body, "status"), caveat.dump());
  body = reportOf(ctx, 2000, Counts{5050, 4950, 505, 594});
  ctx.Assert(text(body, "status") == "complete" && text(body, "winner") == "treatment", "a 50.5/49.5 split is within kSrmTolerance and must not block, got %s", body.dump());
}

void CheckInterval(harness::Ctx& ctx) {
  struct Case {
    long min_sample;
    Counts c;
    std::string status;
  };
  for (const Case& tc : std::vector<Case>{{2000, kBalanced, "complete"}, {20000, kBalanced, "inconclusive"}, {2000, kDrifted, "blocked"}}) {
    const json row = treatmentRow(ctx, reportOf(ctx, tc.min_sample, tc.c));
    ctx.Assert(row.contains("ci_low") && row.contains("ci_high"), "a %s report's treatment row has no interval: %s. Every lift carries ci_low and ci_high", tc.status, row.dump());
    const double pc = static_cast<double>(tc.c.cx) / tc.c.cn, pt = static_cast<double>(tc.c.x) / tc.c.n;
    const double half = 1.959964 * std::sqrt(pc * (1 - pc) / tc.c.cn + pt * (1 - pt) / tc.c.n);
    const double lift = pt - pc;
    const double low = row.value("ci_low", 0.0), high = row.value("ci_high", 0.0);
    ctx.Assert(std::fabs(low - (lift - half)) < 1e-6 && std::fabs(high - (lift + half)) < 1e-6, "the %s report's interval is [%v, %v], expected [%v, %v] from stats::compare", tc.status, low, high, lift - half, lift + half);
  }
}
`,
  },
  hints: [
    'Ask for the report an hour into a test: it names a winner from a few hundred users. Feed it a 56/44 split for a 50/50 design: it names a winner just the same.',
    'The winner is chosen from the p-values alone: nothing compares the total with `min_sample` or the observed split with the frozen weights, and the rows copy `lift` and `p_value` out of `stats.compare` and drop the interval.',
    'Build each row from the whole `stats.compare` result. Before reading any p-value, return `inconclusive` when the total is below `min_sample`, then `blocked` with the srm caveat when `abs(observed - expected) / expected > SRM_TOLERANCE` for any variant.',
  ],
  debrief: `The report answers the cheap structural questions before the statistical one. A sample below the minimum makes the p-value meaningless, because the test was sized for that sample, and reading it on every refresh is exactly how false winners pile up. A sample ratio mismatch says the assignment or the exposure logging is broken, so no metric computed from those groups can be trusted, however small its p-value. The interval travels with the lift because a reader needs the range of effects the data allows, not one number. Production platforms test the split with a chi-squared test instead of a fixed tolerance, correct for many metrics and repeated looks with sequential methods, and show the interval on a relative scale next to the absolute one.`,
};
