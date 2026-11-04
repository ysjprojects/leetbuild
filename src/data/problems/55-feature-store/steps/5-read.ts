import type {Step} from '@/lib/types';

export const readStep: Step = {
  id: 'read',
  title: 'GET /v1/features/{name}/versions/{v}/stats: null rate, pinned baseline, freshness',
  concept: 'http',
  file: 'read',
  focus: ['client', 'api', 'monitor', 'redis'],
  task: `## Task

**Starting point.** The starter serves \`GET /v1/features/{name}/versions/{version}/stats\` from the
running sums \`stats.read(name, version)\` (provided: \`count\` with nulls included, \`nulls\`, \`sum\`
and \`sumsq\` of the values, \`newest_ts\`, \`updated_at\`): it answers \`{feature, version, count,
mean, std, baseline_version, baseline, drift, freshness_s, stale}\` against version − 1, or 404 when
the version has no stats. It serves the demo and hides four flaws.

**Failure mode the checks target.** Six of ten rows arrive null and the response shows a falling
mean instead of a null rate; every version compares against the one before, so a bad deployment
becomes the next baseline; any rise of the mean raises drift; a feature nobody computed for two
hours reads as fresh because the backfill just touched its stats.

- \`mean\` and \`std\` are over the **non-null** values; the response carries **\`null_rate\`**
  (nulls / count), for the baseline too.
- The baseline is the **pinned** version, \`stats.baseline_of(name)\`; none pinned → \`baseline\`
  null and no drift.
- **\`drift\`** is true when |mean − baseline mean| > **\`DRIFT_SIGMAS\` = 3** × baseline std.
- **\`freshness_s\`** is now − \`newest_ts\` (the newest value's event time); **\`stale\`** is
  \`freshness_s\` > the definition's \`freshness_slo\`.`,
  sequence: {
    participants: ['Dashboard', 'Feature API', 'Redis stats', 'Registry'],
    messages: [
      {from: 'Dashboard', to: 'Feature API', label: 'GET /v1/features/amount_7d/versions/3/stats', kind: 'sync'},
      {
        from: 'Feature API',
        to: 'Redis stats',
        label: 'stats.read(amount_7d, 3) · baseline_of(amount_7d) → 1',
        kind: 'sync',
      },
      {from: 'Feature API', to: 'Redis stats', label: 'stats.read(amount_7d, 1)', kind: 'sync'},
      {from: 'Feature API', to: 'Registry', label: 'get_definition(amount_7d, 3) → freshness_slo', kind: 'sync'},
      {
        from: 'Feature API',
        to: 'Dashboard',
        label: '200 null_rate · mean ± std vs v1 · drift at 3σ · freshness_s from newest_ts',
        kind: 'reply',
      },
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Serves the stats of a version, 404 without any',
      detail:
        '`GET /v1/features/{name}/versions/{version}/stats` answers 200 with `feature`, `version` and `count`, and **404** for a version that has no stats.',
      match: {
        python: {all: [/@app\.get\(\s*["']\/v1\/features\/\{name\}\/versions\/\{version\}\/stats["']/, /\b404\b/]},
        typescript: {all: [/app\.get\(\s*['"]\/v1\/features\/:name\/versions\/:version\/stats['"]/, /\b404\b/]},
        go: {all: [/"GET \/v1\/features\/\{name\}\/versions\/\{version\}\/stats"/, /StatusNotFound|\b404\b/]},
        scala: {
          all: [
            /path\(\s*"v1"\s*\/\s*"features"\s*\/\s*Segment\s*\/\s*"versions"\s*\/\s*LongNumber\s*\/\s*"stats"\s*\)/,
            /NotFound/,
          ],
        },
        cpp: {all: [/svr\.Get\(\s*R"\(\/v1\/features\//, /\b404\b/]},
      },
    },
    {
      id: 'null-rate',
      title: 'Reports the null rate, the mean over values only',
      detail:
        '`mean` and `std` divide by the non-null rows (`count - nulls`) and the response carries `null_rate`; the starter divides by every row, so missing data reads as a falling mean, and reports no null rate.',
      match: {
        python: {all: [/["']null_rate["']/, /-\s*sums\[["']nulls["']\]/]},
        typescript: {all: [/null_rate/, /-\s*sums\.nulls/]},
        go: {all: [/"null_rate"/, /-\s*sums\.Nulls/]},
        scala: {all: [/"null_rate"/, /-\s*sums\.nulls/]},
        cpp: {all: [/"null_rate"/, /-\s*sums\.nulls/]},
      },
    },
    {
      id: 'pinned-baseline',
      title: 'Compares against the pinned baseline version',
      detail:
        'The baseline is `baseline_of`/`baselineOf(name)`, the version an operator pinned, and no pin means no baseline. The starter compares against `version - 1`, so a bad version becomes the next baseline.',
      match: {
        python: {all: [/stats\.baseline_of\(/], none: [/version\s*-\s*1/]},
        typescript: {all: [/stats\.baselineOf\(/], none: [/version\s*-\s*1/]},
        go: {all: [/stats\.BaselineOf\(/], none: [/version\s*-\s*1/]},
        scala: {all: [/Stats\.baselineOf\(/], none: [/version\s*-\s*1/]},
        cpp: {all: [/stats::baselineOf\(/], none: [/version\s*-\s*1/]},
      },
    },
    {
      id: 'drift-threshold',
      title: 'Flags drift beyond three baseline sigmas',
      detail:
        '`drift` is true when the mean is more than `DRIFT_SIGMAS` (3) baseline standard deviations from the baseline mean, in either direction. The starter flags any rise and no fall.',
      match: {
        python: {all: [/DRIFT_SIGMAS\s*=\s*3\b/, /abs\(/, /DRIFT_SIGMAS\s*\*/]},
        typescript: {all: [/DRIFT_SIGMAS\s*=\s*3\b/, /Math\.abs\(/, /DRIFT_SIGMAS\s*\*/]},
        go: {all: [/driftSigmas\s*=\s*3\b/, /math\.Abs\(/, /driftSigmas\s*\*/]},
        scala: {all: [/DriftSigmas\s*=\s*3\b/, /math\.abs\(/, /DriftSigmas\s*\*/]},
        cpp: {all: [/kDriftSigmas\s*=\s*3\b/, /std::(?:abs|fabs)\(/, /kDriftSigmas\s*\*/]},
      },
    },
    {
      id: 'freshness',
      title: "Measures freshness from the newest value's event time",
      detail:
        "`freshness_s` is now minus `newest_ts` and `stale` compares it with the definition's `freshness_slo`. The starter measures from `updated_at`, the last time stats were written, which says the job ran, not that the data is recent.",
      match: {
        python: {all: [/newest_ts/], none: [/updated_at/]},
        typescript: {all: [/newest_ts/], none: [/updated_at/]},
        go: {all: [/NewestTs/], none: [/UpdatedAt/]},
        scala: {all: [/newestTs/], none: [/updatedAt/]},
        cpp: {all: [/newest_ts/], none: [/updated_at/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import math
import time

from fastapi import FastAPI, HTTPException

from features import registry, stats  # stats.read, stats.baseline_of; registry.get_definition

app = FastAPI()


def summarize(sums: dict) -> dict:
    count = sums["count"]
    mean = sums["sum"] / count if count else 0.0
    std = math.sqrt(max(sums["sumsq"] / count - mean * mean, 0.0)) if count else 0.0
    return {"count": count, "mean": mean, "std": std}


@app.get("/v1/features/{name}/versions/{version}/stats")
def feature_stats(name: str, version: int) -> dict:
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    sums = stats.read(name, version)
    if sums is None:
        raise HTTPException(status_code=404, detail=f"no stats for {name} v{version}")
    current = summarize(sums)
    baseline_version = version - 1
    baseline_sums = stats.read(name, baseline_version)
    baseline = summarize(baseline_sums) if baseline_sums else None
    drift = baseline is not None and current["mean"] > baseline["mean"]
    definition = registry.get_definition(name, version)
    freshness_s = int(time.time()) - sums["updated_at"]
    stale = definition is not None and freshness_s > definition["freshness_slo"]
    return {
        "feature": name,
        "version": version,
        **current,
        "baseline_version": baseline_version,
        "baseline": baseline,
        "drift": drift,
        "freshness_s": freshness_s,
        "stale": stale,
    }
`,
      solution: `import math
import time

from fastapi import FastAPI, HTTPException

from features import registry, stats  # stats.read, stats.baseline_of; registry.get_definition

app = FastAPI()

DRIFT_SIGMAS = 3


def summarize(sums: dict) -> dict:
    """Count and null rate over every row; mean and std over the values only."""
    present = sums["count"] - sums["nulls"]
    mean = sums["sum"] / present if present else 0.0
    std = math.sqrt(max(sums["sumsq"] / present - mean * mean, 0.0)) if present else 0.0
    null_rate = sums["nulls"] / sums["count"] if sums["count"] else 0.0
    return {"count": sums["count"], "null_rate": null_rate, "mean": mean, "std": std}


@app.get("/v1/features/{name}/versions/{version}/stats")
def feature_stats(name: str, version: int) -> dict:
    sums = stats.read(name, version)
    if sums is None:
        raise HTTPException(status_code=404, detail=f"no stats for {name} v{version}")
    current = summarize(sums)
    # The pinned version, the same for every version compared with it.
    baseline_version = stats.baseline_of(name)
    baseline_sums = stats.read(name, baseline_version) if baseline_version is not None else None
    baseline = summarize(baseline_sums) if baseline_sums else None
    drift = baseline is not None and abs(current["mean"] - baseline["mean"]) > DRIFT_SIGMAS * baseline["std"]
    definition = registry.get_definition(name, version)
    # The newest value's own event time: when stats were last written only says the job ran.
    freshness_s = int(time.time()) - sums["newest_ts"]
    stale = definition is not None and freshness_s > definition["freshness_slo"]
    return {
        "feature": name,
        "version": version,
        **current,
        "baseline_version": baseline_version,
        "baseline": baseline,
        "drift": drift,
        "freshness_s": freshness_s,
        "stale": stale,
    }
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';

import * as registry from 'features/registry';
import * as stats from 'features/stats';

export const app = Fastify();

interface Summary {
  count: number;
  mean: number;
  std: number;
}

function summarize(sums: stats.Sums): Summary {
  const count = sums.count;
  const mean = count ? sums.sum / count : 0;
  const std = count ? Math.sqrt(Math.max(sums.sumsq / count - mean * mean, 0)) : 0;
  return {count, mean, std};
}

app.get('/v1/features/:name/versions/:version/stats', async (request, reply) => {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const {name} = request.params as {name: string};
  const version = Number((request.params as {version: string}).version);
  const sums = await stats.read(name, version);
  if (sums === null) return reply.code(404).send({error: \`no stats for \${name} v\${version}\`});
  const current = summarize(sums);
  const baselineVersion = version - 1;
  const baselineSums = await stats.read(name, baselineVersion);
  const baseline = baselineSums === null ? null : summarize(baselineSums);
  const drift = baseline !== null && current.mean > baseline.mean;
  const definition = await registry.getDefinition(name, version);
  const freshness = Math.floor(Date.now() / 1000) - sums.updated_at;
  const stale = definition !== null && freshness > definition.freshness_slo;
  return {feature: name, version, ...current, baseline_version: baselineVersion, baseline, drift, freshness_s: freshness, stale};
});
`,
      solution: `import Fastify from 'fastify';

import * as registry from 'features/registry';
import * as stats from 'features/stats';

export const app = Fastify();

export const DRIFT_SIGMAS = 3;

interface Summary {
  count: number;
  null_rate: number;
  mean: number;
  std: number;
}

/** Count and null rate over every row; mean and std over the values only. */
function summarize(sums: stats.Sums): Summary {
  const present = sums.count - sums.nulls;
  const mean = present ? sums.sum / present : 0;
  const std = present ? Math.sqrt(Math.max(sums.sumsq / present - mean * mean, 0)) : 0;
  return {count: sums.count, null_rate: sums.count ? sums.nulls / sums.count : 0, mean, std};
}

app.get('/v1/features/:name/versions/:version/stats', async (request, reply) => {
  const {name} = request.params as {name: string};
  const version = Number((request.params as {version: string}).version);
  const sums = await stats.read(name, version);
  if (sums === null) return reply.code(404).send({error: \`no stats for \${name} v\${version}\`});
  const current = summarize(sums);
  // The pinned version, the same for every version compared with it.
  const baselineVersion = await stats.baselineOf(name);
  const baselineSums = baselineVersion === null ? null : await stats.read(name, baselineVersion);
  const baseline = baselineSums === null ? null : summarize(baselineSums);
  const drift = baseline !== null && Math.abs(current.mean - baseline.mean) > DRIFT_SIGMAS * baseline.std;
  const definition = await registry.getDefinition(name, version);
  // The newest value's own event time: when stats were last written only says the job ran.
  const freshness = Math.floor(Date.now() / 1000) - sums.newest_ts;
  const stale = definition !== null && freshness > definition.freshness_slo;
  return {feature: name, version, ...current, baseline_version: baselineVersion, baseline, drift, freshness_s: freshness, stale};
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"math"
	"net/http"
	"strconv"
	"time"

	"features/registry" // registry.GetDefinition
	"features/stats"    // stats.Read, stats.BaselineOf
)

type summary struct {
	Count int64   \`json:"count"\`
	Mean  float64 \`json:"mean"\`
	Std   float64 \`json:"std"\`
}

func summarize(sums *stats.Sums) summary {
	count := float64(sums.Count)
	if count == 0 {
		return summary{}
	}
	mean := sums.Sum / count
	return summary{Count: sums.Count, Mean: mean, Std: math.Sqrt(math.Max(sums.SumSq/count-mean*mean, 0))}
}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func featureStats(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	name := r.PathValue("name")
	version, _ := strconv.Atoi(r.PathValue("version"))
	sums, err := stats.Read(r.Context(), name, version)
	if err != nil || sums == nil {
		http.Error(rw, "no stats for "+name, http.StatusNotFound)
		return
	}
	current := summarize(sums)
	baselineVersion := version - 1
	var baseline *summary
	if baselineSums, _ := stats.Read(r.Context(), name, baselineVersion); baselineSums != nil {
		b := summarize(baselineSums)
		baseline = &b
	}
	drift := baseline != nil && current.Mean > baseline.Mean
	definition, _ := registry.GetDefinition(r.Context(), name, version)
	freshness := time.Now().Unix() - sums.UpdatedAt
	stale := definition != nil && freshness > definition.FreshnessSLO
	writeJSON(rw, http.StatusOK, map[string]any{
		"feature": name, "version": version, "count": current.Count, "mean": current.Mean, "std": current.Std,
		"baseline_version": baselineVersion, "baseline": baseline, "drift": drift, "freshness_s": freshness, "stale": stale,
	})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/features/{name}/versions/{version}/stats", featureStats)
}
`,
      solution: `package main

import (
	"encoding/json"
	"math"
	"net/http"
	"strconv"
	"time"

	"features/registry" // registry.GetDefinition
	"features/stats"    // stats.Read, stats.BaselineOf
)

const driftSigmas = 3

type summary struct {
	Count    int64   \`json:"count"\`
	NullRate float64 \`json:"null_rate"\`
	Mean     float64 \`json:"mean"\`
	Std      float64 \`json:"std"\`
}

// summarize counts every row and its null rate; mean and std are over the values only.
func summarize(sums *stats.Sums) summary {
	out := summary{Count: sums.Count}
	if sums.Count > 0 {
		out.NullRate = float64(sums.Nulls) / float64(sums.Count)
	}
	present := float64(sums.Count - sums.Nulls)
	if present > 0 {
		out.Mean = sums.Sum / present
		out.Std = math.Sqrt(math.Max(sums.SumSq/present-out.Mean*out.Mean, 0))
	}
	return out
}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func featureStats(rw http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	version, _ := strconv.Atoi(r.PathValue("version"))
	sums, err := stats.Read(r.Context(), name, version)
	if err != nil || sums == nil {
		http.Error(rw, "no stats for "+name, http.StatusNotFound)
		return
	}
	current := summarize(sums)
	// The pinned version, the same for every version compared with it.
	var baselineVersion any
	var baseline *summary
	if pinned := stats.BaselineOf(r.Context(), name); pinned > 0 {
		baselineVersion = pinned
		if baselineSums, _ := stats.Read(r.Context(), name, pinned); baselineSums != nil {
			b := summarize(baselineSums)
			baseline = &b
		}
	}
	drift := baseline != nil && math.Abs(current.Mean-baseline.Mean) > driftSigmas*baseline.Std
	definition, _ := registry.GetDefinition(r.Context(), name, version)
	// The newest value's own event time: when stats were last written only says the job ran.
	freshness := time.Now().Unix() - sums.NewestTs
	stale := definition != nil && freshness > definition.FreshnessSLO
	writeJSON(rw, http.StatusOK, map[string]any{
		"feature": name, "version": version, "count": current.Count, "null_rate": current.NullRate, "mean": current.Mean, "std": current.Std,
		"baseline_version": baselineVersion, "baseline": baseline, "drift": drift, "freshness_s": freshness, "stale": stale,
	})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/features/{name}/versions/{version}/stats", featureStats)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import features.{Registry, Stats} // Stats.read, Stats.baselineOf; Registry.getDefinition

object Read {
  private def summarize(sums: Stats.Sums): JsObject = {
    val count = sums.count.toDouble
    val mean = if (count > 0) sums.sum / count else 0.0
    val std = if (count > 0) math.sqrt(math.max(sums.sumsq / count - mean * mean, 0.0)) else 0.0
    JsObject("count" -> JsNumber(sums.count), "mean" -> JsNumber(mean), "std" -> JsNumber(std))
  }

  private def number(summary: JsObject, field: String): Double = summary.fields(field).asInstanceOf[JsNumber].value.toDouble

  val route: Route = path("v1" / "features" / Segment / "versions" / LongNumber / "stats") { (name, version) =>
    get {
      // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
      Stats.read(name, version) match {
        case None => complete(StatusCodes.NotFound -> s"no stats for $name v$version")
        case Some(sums) =>
          val current = summarize(sums)
          val baselineVersion = version - 1
          val baseline = Stats.read(name, baselineVersion).map(summarize)
          val drift = baseline.exists(b => number(current, "mean") > number(b, "mean"))
          val freshness = System.currentTimeMillis() / 1000 - sums.updatedAt
          val stale = Registry.getDefinition(name, version).exists(d => freshness > d.freshnessSlo)
          val body = JsObject(current.fields ++ Map(
            "feature" -> JsString(name), "version" -> JsNumber(version), "baseline_version" -> JsNumber(baselineVersion),
            "baseline" -> baseline.getOrElse(JsNull), "drift" -> JsBoolean(drift), "freshness_s" -> JsNumber(freshness), "stale" -> JsBoolean(stale)))
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

import features.{Registry, Stats} // Stats.read, Stats.baselineOf; Registry.getDefinition

object Read {
  val DriftSigmas = 3

  /** Count and null rate over every row; mean and std over the values only. */
  private def summarize(sums: Stats.Sums): JsObject = {
    val present = (sums.count - sums.nulls).toDouble
    val mean = if (present > 0) sums.sum / present else 0.0
    val std = if (present > 0) math.sqrt(math.max(sums.sumsq / present - mean * mean, 0.0)) else 0.0
    val nullRate = if (sums.count > 0) sums.nulls.toDouble / sums.count else 0.0
    JsObject("count" -> JsNumber(sums.count), "null_rate" -> JsNumber(nullRate), "mean" -> JsNumber(mean), "std" -> JsNumber(std))
  }

  private def number(summary: JsObject, field: String): Double = summary.fields(field).asInstanceOf[JsNumber].value.toDouble

  val route: Route = path("v1" / "features" / Segment / "versions" / LongNumber / "stats") { (name, version) =>
    get {
      Stats.read(name, version) match {
        case None => complete(StatusCodes.NotFound -> s"no stats for $name v$version")
        case Some(sums) =>
          val current = summarize(sums)
          // The pinned version, the same for every version compared with it.
          val baselineVersion = Stats.baselineOf(name)
          val baseline = baselineVersion.flatMap(v => Stats.read(name, v)).map(summarize)
          val drift = baseline.exists(b => math.abs(number(current, "mean") - number(b, "mean")) > DriftSigmas * number(b, "std"))
          // The newest value's own event time: when stats were last written only says the job ran.
          val freshness = System.currentTimeMillis() / 1000 - sums.newestTs
          val stale = Registry.getDefinition(name, version).exists(d => freshness > d.freshnessSlo)
          val body = JsObject(current.fields ++ Map(
            "feature" -> JsString(name), "version" -> JsNumber(version), "baseline_version" -> baselineVersion.map(JsNumber(_)).getOrElse(JsNull),
            "baseline" -> baseline.getOrElse(JsNull), "drift" -> JsBoolean(drift), "freshness_s" -> JsNumber(freshness), "stale" -> JsBoolean(stale)))
          complete(HttpResponse(StatusCodes.OK, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint)))
      }
    }
  }
}
`,
    },
    cpp: {
      starter: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <algorithm>
#include <chrono>
#include <cmath>
#include <string>

#include "features/registry.h"  // registry::getDefinition
#include "features/stats.h"     // stats::read, stats::baselineOf

using json = nlohmann::json;

json summarize(const stats::Sums& sums) {
  const double count = static_cast<double>(sums.count);
  const double mean = count > 0 ? sums.sum / count : 0.0;
  const double std_dev = count > 0 ? std::sqrt(std::max(sums.sumsq / count - mean * mean, 0.0)) : 0.0;
  return json{{"count", sums.count}, {"mean", mean}, {"std", std_dev}};
}

long long now_seconds() {
  return std::chrono::duration_cast<std::chrono::seconds>(std::chrono::system_clock::now().time_since_epoch()).count();
}

void feature_stats(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const std::string name = req.matches[1];
  const long version = std::stol(req.matches[2]);
  const auto sums = stats::read(name, version);
  if (!sums) {
    res.status = 404;
    res.set_content("no stats for " + name, "text/plain");
    return;
  }
  json body = summarize(*sums);
  const long baseline_version = version - 1;
  const auto baseline_sums = stats::read(name, baseline_version);
  const json baseline = baseline_sums ? summarize(*baseline_sums) : json();
  const bool drift = !baseline.is_null() && body["mean"].get<double>() > baseline["mean"].get<double>();
  const auto definition = registry::getDefinition(name, version);
  const long long freshness = now_seconds() - sums->updated_at;
  body["feature"] = name;
  body["version"] = version;
  body["baseline_version"] = baseline_version;
  body["baseline"] = baseline;
  body["drift"] = drift;
  body["freshness_s"] = freshness;
  body["stale"] = definition && freshness > definition->freshness_slo;
  res.set_content(body.dump(), "application/json");
}

void register_routes(httplib::Server& svr) { svr.Get(R"(/v1/features/([\\w-]+)/versions/(\\d+)/stats)", feature_stats); }
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <algorithm>
#include <chrono>
#include <cmath>
#include <string>

#include "features/registry.h"  // registry::getDefinition
#include "features/stats.h"     // stats::read, stats::baselineOf

using json = nlohmann::json;

constexpr double kDriftSigmas = 3;

// Count and null rate over every row; mean and std over the values only.
json summarize(const stats::Sums& sums) {
  const double present = static_cast<double>(sums.count - sums.nulls);
  const double mean = present > 0 ? sums.sum / present : 0.0;
  const double std_dev = present > 0 ? std::sqrt(std::max(sums.sumsq / present - mean * mean, 0.0)) : 0.0;
  const double null_rate = sums.count > 0 ? static_cast<double>(sums.nulls) / static_cast<double>(sums.count) : 0.0;
  return json{{"count", sums.count}, {"null_rate", null_rate}, {"mean", mean}, {"std", std_dev}};
}

long long now_seconds() {
  return std::chrono::duration_cast<std::chrono::seconds>(std::chrono::system_clock::now().time_since_epoch()).count();
}

void feature_stats(const httplib::Request& req, httplib::Response& res) {
  const std::string name = req.matches[1];
  const long version = std::stol(req.matches[2]);
  const auto sums = stats::read(name, version);
  if (!sums) {
    res.status = 404;
    res.set_content("no stats for " + name, "text/plain");
    return;
  }
  json body = summarize(*sums);
  // The pinned version, the same for every version compared with it.
  const long pinned = stats::baselineOf(name);
  const auto baseline_sums = pinned > 0 ? stats::read(name, pinned) : std::nullopt;
  const json baseline = baseline_sums ? summarize(*baseline_sums) : json();
  const bool drift = !baseline.is_null() &&
                     std::fabs(body["mean"].get<double>() - baseline["mean"].get<double>()) > kDriftSigmas * baseline["std"].get<double>();
  const auto definition = registry::getDefinition(name, version);
  // The newest value's own event time: when stats were last written only says the job ran.
  const long long freshness = now_seconds() - sums->newest_ts;
  body["feature"] = name;
  body["version"] = version;
  body["baseline_version"] = pinned > 0 ? json(pinned) : json();
  body["baseline"] = baseline;
  body["drift"] = drift;
  body["freshness_s"] = freshness;
  body["stale"] = definition && freshness > definition->freshness_slo;
  res.set_content(body.dump(), "application/json");
}

void register_routes(httplib::Server& svr) { svr.Get(R"(/v1/features/([\\w-]+)/versions/(\\d+)/stats)", feature_stats); }
`,
    },
  },
  harness: {
    python: `import time

from features import registry, stats


def _read(ctx):
    now = int(time.time())
    for version in (1, 2, 3):
        registry.create_definition({"name": "amount_7d", "version": version, "dtype": "float64", "computation_ref": "window_avg_7d", "freshness_slo": 3600, "created_at": now})
    m = ctx.load("read")
    return ctx.client(m.app), now


def _observe(version, values, event_ts):
    for value in values:
        stats.observe("amount_7d", version, value, event_ts)


async def _stats(c, version):
    r = await c.get(f"/v1/features/amount_7d/versions/{version}/stats")
    assert r.status_code == 200, f"GET /v1/features/amount_7d/versions/{version}/stats answered {r.status_code}: {r.text}"
    return r.json()


def _near(a, b):
    return a is not None and abs(a - b) < 1e-6


async def check_route(ctx):
    c, now = _read(ctx)
    async with c:
        _observe(1, [8.0, 12.0], now - 60)
        body = await _stats(c, 1)
        assert body.get("feature") == "amount_7d" and body.get("version") == 1 and body.get("count") == 2, f"the stats of amount_7d v1 are {body}, expected feature, version and count 2"
        r = await c.get("/v1/features/amount_7d/versions/9/stats")
    assert r.status_code == 404, f"a version without stats answered {r.status_code}, expected 404"


async def check_null_rate(ctx):
    c, now = _read(ctx)
    async with c:
        _observe(1, [8.0, 12.0, 8.0, 12.0, None, None, None, None, None, None], now - 60)
        body = await _stats(c, 1)
    assert _near(body.get("null_rate"), 0.6), f"six of ten rows are null and null_rate is {body.get('null_rate')!r}, expected 0.6"
    assert _near(body.get("mean"), 10.0) and _near(body.get("std"), 2.0), f"the values are 8, 12, 8, 12 and the response says mean {body.get('mean')} std {body.get('std')}: nulls must not be averaged in as zeros"
    assert body.get("count") == 10, f"count is {body.get('count')}, expected every row (10)"


async def check_pinned_baseline(ctx):
    c, now = _read(ctx)
    async with c:
        _observe(1, [8.0, 12.0, 8.0, 12.0], now - 60)
        _observe(2, [30.0, 30.0, 30.0, 30.0], now - 60)  # a bad deployment
        _observe(3, [11.0, 9.0, 11.0, 9.0], now - 60)
        body = await _stats(c, 3)
        assert body.get("baseline_version") is None and body.get("baseline") is None and body.get("drift") is False, f"with no baseline pinned the response is {body}, expected baseline_version and baseline null and no drift"
        stats.pin_baseline("amount_7d", 1)
        body = await _stats(c, 3)
    assert body.get("baseline_version") == 1, f"version 1 is pinned as the baseline and the response compares against {body.get('baseline_version')!r}"
    baseline = body.get("baseline") or {}
    assert _near(baseline.get("mean"), 10.0), f"the baseline is {baseline}, expected the stats of version 1 (mean 10)"
    assert body.get("drift") is False, f"version 3 (mean 10) against the pinned version 1 (mean 10) reports drift {body.get('drift')!r}"


async def check_drift_threshold(ctx):
    c, now = _read(ctx)
    async with c:
        stats.pin_baseline("amount_7d", 1)
        _observe(1, [8.0, 12.0, 8.0, 12.0], now - 60)  # mean 10, std 2
        _observe(2, [11.0, 13.0, 11.0, 13.0], now - 60)  # mean 12: one sigma up
        _observe(3, [2.0, 4.0, 2.0, 4.0], now - 60)  # mean 3: three and a half sigmas down
        up = await _stats(c, 2)
        down = await _stats(c, 3)
    assert up.get("drift") is False, f"a mean one baseline sigma above the baseline reports drift {up.get('drift')!r}: drift is more than DRIFT_SIGMAS (3) sigmas away"
    assert down.get("drift") is True, f"a mean 3.5 baseline sigmas below the baseline reports drift {down.get('drift')!r}: a fall is drift too"


async def check_freshness(ctx):
    c, now = _read(ctx)
    async with c:
        _observe(1, [8.0, 12.0], now - 7200)  # the newest value is two hours old, observed just now
        _observe(2, [8.0, 12.0], now - 60)
        old = await _stats(c, 1)
        fresh = await _stats(c, 2)
    assert old.get("freshness_s") is not None and abs(old["freshness_s"] - 7200) <= 2, f"the newest value of v1 is 7200 s old and freshness_s is {old.get('freshness_s')!r}: measure from newest_ts, not from when the stats were written"
    assert old.get("stale") is True, f"a value 7200 s old under a 3600 s SLO reports stale {old.get('stale')!r}"
    assert fresh.get("stale") is False and abs(fresh.get("freshness_s", 0) - 60) <= 2, f"v2's newest value is 60 s old and the response is {fresh}"
`,
    typescript: `async function read(ctx) {
  const registry = ctx.load('/support/features/registry.ts');
  const stats = ctx.load('/support/features/stats.ts');
  const now = Math.floor(ctx.clock.now() / 1000);
  for (const version of [1, 2, 3]) {
    await registry.createDefinition({name: 'amount_7d', version, dtype: 'float64', computation_ref: 'window_avg_7d', freshness_slo: 3600, created_at: now});
  }
  const m = ctx.load('read');
  const observe = async (version: number, values: (number | null)[], eventTs: number) => {
    for (const value of values) await stats.observe('amount_7d', version, value, eventTs);
  };
  return {c: ctx.client(m.app), stats, observe, now};
}

async function statsOf(c, version: number) {
  const r = await c.get(\`/v1/features/amount_7d/versions/\${version}/stats\`);
  assert.equal(r.status, 200, \`GET /v1/features/amount_7d/versions/\${version}/stats answered \${r.status}: \${r.text}\`);
  return r.json();
}

const near = (a, b: number): boolean => typeof a === 'number' && Math.abs(a - b) < 1e-6;

export async function check_route(ctx) {
  const {c, observe, now} = await read(ctx);
  await observe(1, [8, 12], now - 60);
  const body = await statsOf(c, 1);
  assert(body.feature === 'amount_7d' && body.version === 1 && body.count === 2, \`the stats of amount_7d v1 are \${JSON.stringify(body)}, expected feature, version and count 2\`);
  const r = await c.get('/v1/features/amount_7d/versions/9/stats');
  assert.equal(r.status, 404, \`a version without stats answered \${r.status}, expected 404\`);
}

export async function check_null_rate(ctx) {
  const {c, observe, now} = await read(ctx);
  await observe(1, [8, 12, 8, 12, null, null, null, null, null, null], now - 60);
  const body = await statsOf(c, 1);
  assert(near(body.null_rate, 0.6), \`six of ten rows are null and null_rate is \${body.null_rate}, expected 0.6\`);
  assert(near(body.mean, 10) && near(body.std, 2), \`the values are 8, 12, 8, 12 and the response says mean \${body.mean} std \${body.std}: nulls must not be averaged in as zeros\`);
  assert.equal(body.count, 10, \`count is \${body.count}, expected every row (10)\`);
}

export async function check_pinned_baseline(ctx) {
  const {c, stats, observe, now} = await read(ctx);
  await observe(1, [8, 12, 8, 12], now - 60);
  await observe(2, [30, 30, 30, 30], now - 60); // a bad deployment
  await observe(3, [11, 9, 11, 9], now - 60);
  let body = await statsOf(c, 3);
  assert(body.baseline_version === null && body.baseline === null && body.drift === false, \`with no baseline pinned the response is \${JSON.stringify(body)}, expected baseline_version and baseline null and no drift\`);
  await stats.pinBaseline('amount_7d', 1);
  body = await statsOf(c, 3);
  assert.equal(body.baseline_version, 1, \`version 1 is pinned as the baseline and the response compares against \${body.baseline_version}\`);
  assert(near(body.baseline?.mean, 10), \`the baseline is \${JSON.stringify(body.baseline)}, expected the stats of version 1 (mean 10)\`);
  assert.equal(body.drift, false, \`version 3 (mean 10) against the pinned version 1 (mean 10) reports drift \${body.drift}\`);
}

export async function check_drift_threshold(ctx) {
  const {c, stats, observe, now} = await read(ctx);
  await stats.pinBaseline('amount_7d', 1);
  await observe(1, [8, 12, 8, 12], now - 60); // mean 10, std 2
  await observe(2, [11, 13, 11, 13], now - 60); // mean 12: one sigma up
  await observe(3, [2, 4, 2, 4], now - 60); // mean 3: three and a half sigmas down
  const up = await statsOf(c, 2);
  const down = await statsOf(c, 3);
  assert.equal(up.drift, false, \`a mean one baseline sigma above the baseline reports drift \${up.drift}: drift is more than DRIFT_SIGMAS (3) sigmas away\`);
  assert.equal(down.drift, true, \`a mean 3.5 baseline sigmas below the baseline reports drift \${down.drift}: a fall is drift too\`);
}

export async function check_freshness(ctx) {
  const {c, observe, now} = await read(ctx);
  await observe(1, [8, 12], now - 7200); // the newest value is two hours old, observed just now
  await observe(2, [8, 12], now - 60);
  const old = await statsOf(c, 1);
  const fresh = await statsOf(c, 2);
  assert(typeof old.freshness_s === 'number' && Math.abs(old.freshness_s - 7200) <= 2, \`the newest value of v1 is 7200 s old and freshness_s is \${old.freshness_s}: measure from newest_ts, not from when the stats were written\`);
  assert.equal(old.stale, true, \`a value 7200 s old under a 3600 s SLO reports stale \${old.stale}\`);
  assert(fresh.stale === false && Math.abs(fresh.freshness_s - 60) <= 2, \`v2's newest value is 60 s old and the response is \${JSON.stringify(fresh)}\`);
}
`,
    go: `package main

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"time"

	"features/registry"
	"features/stats"

	"leetbuild/harness"
)

var readBg = context.Background()

func read(ctx *harness.Ctx) (*harness.HTTP, int64) {
	now := time.Now().Unix()
	for version := 1; version <= 3; version++ {
		_, err := registry.CreateDefinition(readBg, registry.Definition{Name: "amount_7d", Version: version, Dtype: "float64", ComputationRef: "window_avg_7d", FreshnessSLO: 3600, CreatedAt: now})
		ctx.NoError(err, "CreateDefinition")
	}
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux), now
}

// observe feeds values to the sums of a version; NaN stands for a null.
func observe(ctx *harness.Ctx, version int, values []float64, eventTs int64) {
	for _, v := range values {
		value := v
		var p *float64
		if !math.IsNaN(value) {
			p = &value
		}
		ctx.NoError(stats.Observe(readBg, "amount_7d", version, p, eventTs), "stats.Observe")
	}
}

func statsOf(ctx *harness.Ctx, c *harness.HTTP, version int) map[string]any {
	r := c.Get(fmt.Sprintf("/v1/features/amount_7d/versions/%d/stats", version))
	ctx.Equal(r.Status, 200, "GET /v1/features/amount_7d/versions/%d/stats (%s)", version, r.Text())
	var body map[string]any
	ctx.NoError(json.Unmarshal(r.Body, &body), "the stats must be JSON, got %s", r.Text())
	return body
}

func near(v any, want float64) bool {
	f, ok := v.(float64)
	return ok && math.Abs(f-want) < 1e-6
}

func CheckRoute(ctx *harness.Ctx) {
	c, now := read(ctx)
	observe(ctx, 1, []float64{8, 12}, now-60)
	body := statsOf(ctx, c, 1)
	ctx.Assert(body["feature"] == "amount_7d" && near(body["version"], 1) && near(body["count"], 2), "the stats of amount_7d v1 are %v, expected feature, version and count 2", body)
	r := c.Get("/v1/features/amount_7d/versions/9/stats")
	ctx.Equal(r.Status, 404, "a version without stats")
}

func CheckNullRate(ctx *harness.Ctx) {
	c, now := read(ctx)
	null := math.NaN()
	observe(ctx, 1, []float64{8, 12, 8, 12, null, null, null, null, null, null}, now-60)
	body := statsOf(ctx, c, 1)
	ctx.Assert(near(body["null_rate"], 0.6), "six of ten rows are null and null_rate is %v, expected 0.6", body["null_rate"])
	ctx.Assert(near(body["mean"], 10) && near(body["std"], 2), "the values are 8, 12, 8, 12 and the response says mean %v std %v: nulls must not be averaged in as zeros", body["mean"], body["std"])
	ctx.Assert(near(body["count"], 10), "count is %v, expected every row (10)", body["count"])
}

func CheckPinnedBaseline(ctx *harness.Ctx) {
	c, now := read(ctx)
	observe(ctx, 1, []float64{8, 12, 8, 12}, now-60)
	observe(ctx, 2, []float64{30, 30, 30, 30}, now-60) // a bad deployment
	observe(ctx, 3, []float64{11, 9, 11, 9}, now-60)
	body := statsOf(ctx, c, 3)
	ctx.Assert(body["baseline_version"] == nil && body["baseline"] == nil && body["drift"] == false, "with no baseline pinned the response is %v, expected baseline_version and baseline null and no drift", body)
	ctx.NoError(stats.PinBaseline(readBg, "amount_7d", 1), "PinBaseline")
	body = statsOf(ctx, c, 3)
	ctx.Assert(near(body["baseline_version"], 1), "version 1 is pinned as the baseline and the response compares against %v", body["baseline_version"])
	baseline, _ := body["baseline"].(map[string]any)
	ctx.Assert(near(baseline["mean"], 10), "the baseline is %v, expected the stats of version 1 (mean 10)", body["baseline"])
	ctx.Equal(body["drift"], false, "version 3 (mean 10) against the pinned version 1 (mean 10); drift")
}

func CheckDriftThreshold(ctx *harness.Ctx) {
	c, now := read(ctx)
	ctx.NoError(stats.PinBaseline(readBg, "amount_7d", 1), "PinBaseline")
	observe(ctx, 1, []float64{8, 12, 8, 12}, now-60)   // mean 10, std 2
	observe(ctx, 2, []float64{11, 13, 11, 13}, now-60) // mean 12: one sigma up
	observe(ctx, 3, []float64{2, 4, 2, 4}, now-60)     // mean 3: three and a half sigmas down
	ctx.Equal(statsOf(ctx, c, 2)["drift"], false, "a mean one baseline sigma above the baseline is not drift (more than driftSigmas = 3 sigmas is); drift")
	ctx.Equal(statsOf(ctx, c, 3)["drift"], true, "a mean 3.5 baseline sigmas below the baseline is drift, a fall too; drift")
}

func CheckFreshness(ctx *harness.Ctx) {
	c, now := read(ctx)
	observe(ctx, 1, []float64{8, 12}, now-7200) // the newest value is two hours old, observed just now
	observe(ctx, 2, []float64{8, 12}, now-60)
	old := statsOf(ctx, c, 1)
	fresh := statsOf(ctx, c, 2)
	f, _ := old["freshness_s"].(float64)
	ctx.Assert(math.Abs(f-7200) <= 2, "the newest value of v1 is 7200 s old and freshness_s is %v: measure from newest_ts, not from when the stats were written", old["freshness_s"])
	ctx.Equal(old["stale"], true, "a value 7200 s old under a 3600 s SLO; stale")
	g, _ := fresh["freshness_s"].(float64)
	ctx.Assert(fresh["stale"] == false && math.Abs(g-60) <= 2, "v2's newest value is 60 s old and the response is %v", fresh)
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <chrono>
#include <cmath>
#include <optional>
#include <string>
#include <vector>

#include "features/registry.h"
#include "features/stats.h"

using json = nlohmann::json;

namespace {

harness::HTTP api(harness::Ctx& ctx) {
  static httplib::Server* svr = nullptr;
  delete svr;
  svr = new httplib::Server;
  register_routes(*svr);
  return ctx.HTTP(*svr);
}

long long setup() {
  const long long now = std::chrono::duration_cast<std::chrono::seconds>(std::chrono::system_clock::now().time_since_epoch()).count();
  for (long version = 1; version <= 3; version++) registry::createDefinition(registry::Definition{"amount_7d", version, "float64", "window_avg_7d", 3600, now});
  return now;
}

void observe(long version, const std::vector<std::optional<double>>& values, long long event_ts) {
  for (const auto& value : values) stats::observe("amount_7d", version, value, event_ts);
}

json statsOf(harness::Ctx& ctx, harness::HTTP& c, long version) {
  const auto r = c.Get("/v1/features/amount_7d/versions/" + std::to_string(version) + "/stats");
  ctx.Equal(r.Status, 200, "GET /v1/features/amount_7d/versions/%d/stats (%s)", version, r.Text());
  const json body = json::parse(r.Text(), nullptr, false);
  ctx.Assert(body.is_object(), "the stats must be JSON, got %s", r.Text());
  return body;
}

double number(const json& j, const std::string& field) {
  return j.is_object() && j.contains(field) && j[field].is_number() ? j[field].get<double>() : NAN;
}

bool near(double a, double b) { return std::fabs(a - b) < 1e-6; }

}  // namespace

void CheckRoute(harness::Ctx& ctx) {
  const long long now = setup();
  auto c = api(ctx);
  observe(1, {8.0, 12.0}, now - 60);
  const json body = statsOf(ctx, c, 1);
  ctx.Assert(body.value("feature", "") == "amount_7d" && near(number(body, "version"), 1) && near(number(body, "count"), 2), "the stats of amount_7d v1 are %s, expected feature, version and count 2", body.dump());
  const auto r = c.Get("/v1/features/amount_7d/versions/9/stats");
  ctx.Equal(r.Status, 404, "a version without stats");
}

void CheckNullRate(harness::Ctx& ctx) {
  const long long now = setup();
  auto c = api(ctx);
  observe(1, {8.0, 12.0, 8.0, 12.0, std::nullopt, std::nullopt, std::nullopt, std::nullopt, std::nullopt, std::nullopt}, now - 60);
  const json body = statsOf(ctx, c, 1);
  ctx.Assert(near(number(body, "null_rate"), 0.6), "six of ten rows are null and null_rate is %s, expected 0.6", body.contains("null_rate") ? body["null_rate"].dump() : "missing");
  ctx.Assert(near(number(body, "mean"), 10) && near(number(body, "std"), 2), "the values are 8, 12, 8, 12 and the response says mean %v std %v: nulls must not be averaged in as zeros", number(body, "mean"), number(body, "std"));
  ctx.Assert(near(number(body, "count"), 10), "count is %v, expected every row (10)", number(body, "count"));
}

void CheckPinnedBaseline(harness::Ctx& ctx) {
  const long long now = setup();
  auto c = api(ctx);
  observe(1, {8.0, 12.0, 8.0, 12.0}, now - 60);
  observe(2, {30.0, 30.0, 30.0, 30.0}, now - 60);  // a bad deployment
  observe(3, {11.0, 9.0, 11.0, 9.0}, now - 60);
  json body = statsOf(ctx, c, 3);
  ctx.Assert(body["baseline_version"].is_null() && body["baseline"].is_null() && body["drift"] == false, "with no baseline pinned the response is %s, expected baseline_version and baseline null and no drift", body.dump());
  stats::pinBaseline("amount_7d", 1);
  body = statsOf(ctx, c, 3);
  ctx.Assert(near(number(body, "baseline_version"), 1), "version 1 is pinned as the baseline and the response compares against %s", body["baseline_version"].dump());
  ctx.Assert(near(number(body["baseline"], "mean"), 10), "the baseline is %s, expected the stats of version 1 (mean 10)", body["baseline"].dump());
  ctx.Assert(body["drift"] == false, "version 3 (mean 10) against the pinned version 1 (mean 10) reports drift %s", body["drift"].dump());
}

void CheckDriftThreshold(harness::Ctx& ctx) {
  const long long now = setup();
  auto c = api(ctx);
  stats::pinBaseline("amount_7d", 1);
  observe(1, {8.0, 12.0, 8.0, 12.0}, now - 60);    // mean 10, std 2
  observe(2, {11.0, 13.0, 11.0, 13.0}, now - 60);  // mean 12: one sigma up
  observe(3, {2.0, 4.0, 2.0, 4.0}, now - 60);      // mean 3: three and a half sigmas down
  const json up = statsOf(ctx, c, 2);
  const json down = statsOf(ctx, c, 3);
  ctx.Assert(up["drift"] == false, "a mean one baseline sigma above the baseline reports drift %s: drift is more than kDriftSigmas (3) sigmas away", up["drift"].dump());
  ctx.Assert(down["drift"] == true, "a mean 3.5 baseline sigmas below the baseline reports drift %s: a fall is drift too", down["drift"].dump());
}

void CheckFreshness(harness::Ctx& ctx) {
  const long long now = setup();
  auto c = api(ctx);
  observe(1, {8.0, 12.0}, now - 7200);  // the newest value is two hours old, observed just now
  observe(2, {8.0, 12.0}, now - 60);
  const json old = statsOf(ctx, c, 1);
  const json fresh = statsOf(ctx, c, 2);
  ctx.Assert(std::fabs(number(old, "freshness_s") - 7200) <= 2, "the newest value of v1 is 7200 s old and freshness_s is %v: measure from newest_ts, not from when the stats were written", number(old, "freshness_s"));
  ctx.Assert(old["stale"] == true, "a value 7200 s old under a 3600 s SLO reports stale %s", old["stale"].dump());
  ctx.Assert(fresh["stale"] == false && std::fabs(number(fresh, "freshness_s") - 60) <= 2, "v2's newest value is 60 s old and the response is %s", fresh.dump());
}
`,
  },
  hints: [
    'Six of ten rows arrive null: the response shows a mean of 4 and no null rate. Ship a bad version and the next one is compared with it; a mean up by a fraction of a sigma raises drift.',
    'summarize divides by count, nulls included, and never reports them; the baseline is version − 1, not the pinned one; drift is any rise of the mean; freshness_s counts from updated_at, the last write of the stats.',
    'Divide by `count − nulls` and report `null_rate`; baseline = `stats.baseline_of(name)`; drift = `abs(mean − baseline mean) > DRIFT_SIGMAS × baseline std`; `freshness_s = now − newest_ts`, `stale = freshness_s > freshness_slo`.',
  ],
  debrief: `A stats read earns its place when it can contradict the dashboard. Counting nulls apart is what makes missing data visible: averaged in as zeros, a pipeline losing half its rows looks like a feature drifting down. A pinned baseline gives every version the same reference, so a slow drift accumulates against it instead of resetting at each deployment, and the three-sigma band says how far is far for this feature rather than treating any rise as news. Freshness comes from the data's own event time, since the last write of the stats only says the job ran. Monitoring tools compare whole distributions per feature (a Kolmogorov–Smirnov test, a population stability index) rather than means, and alert on the null rate as a signal of its own.`,
};
