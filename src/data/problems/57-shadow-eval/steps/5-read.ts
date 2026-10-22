import type {Step} from '@/lib/types';

export const shadowReadStep: Step = {
  id: 'read',
  title: 'GET /v1/shadow/configs/{id}/report: significance before celebration',
  concept: 'http',
  file: 'read',
  focus: ['client', 'shadow', 'db'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it loads a config's samples,
computes a delta and returns a verdict. It compiles and the demo shows a winner. The flaw is that it
celebrates. Review it, fix it, and prove the fix.

Implement \`GET /v1/shadow/configs/{id}/report\`, the endpoint that turns paired samples into a
usable answer.

- The tenant comes from the authenticated \`X-Tenant-Id\` header; a missing tenant is **401**.
- The report returns the **paired score delta** together with the **sample count**, a **confidence
  interval** (\`ci_low\`, \`ci_high\`) and the **exact traffic window** (\`window_start\`,
  \`window_end\`) the samples were collected over. A delta without its sample count and window is not
  a result.
- Below **500 paired samples** the verdict is \`inconclusive\`, no matter how positive the delta
  looks. Interval and threshold together are what stop a twelve-sample fluke from shipping a model.
- A config that belongs to another tenant is **404**, never 403 — a shadow report must not confirm
  that someone else's experiment exists.
- Never return the raw samples or any request content; the report is counts, deltas, an interval and
  a window.

**Failure mode the checks target.** The draft declares a winner from **12 pairs** because the delta
is positive; it **hides the sample count** and returns no interval; and it serves **any config to any
caller**, so one tenant can read another's experiment. Each of those turns a measurement into a
decision it cannot support.`,
  sequence: {
    participants: ['Client', 'Shadow Service', 'report store'],
    messages: [
      {from: 'Client', to: 'Shadow Service', label: 'GET /v1/shadow/configs/{id}/report · X-Tenant-Id', kind: 'sync'},
      {from: 'Shadow Service', to: 'report store', label: 'load(tenant, config id)', kind: 'sync'},
      {from: 'report store', to: 'Shadow Service', label: 'samples + window / none (foreign)', kind: 'reply'},
      {from: 'Shadow Service', to: 'Shadow Service', label: 'count < 500 → inconclusive', kind: 'sync'},
      {from: 'Shadow Service', to: 'Shadow Service', label: 'confidence interval on paired deltas', kind: 'sync'},
      {from: 'Shadow Service', to: 'Client', label: '200 {sample_count, ci_low, ci_high, window} / 404', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Handles GET /v1/shadow/configs/{id}/report',
      detail: 'Register the report route on `GET /v1/shadow/configs/{id}/report`.',
      match: {
        python: {all: [/@app\.get\(\s*["']\/v1\/shadow\/configs\/\{id\}\/report["']/]},
        typescript: {all: [/app\.get/, /\/v1\/shadow\/configs\/:id\/report/]},
        go: {all: [/HandleFunc\(\s*"GET \/v1\/shadow\/configs\/\{id\}\/report"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"shadow"\s*\/\s*"configs"\s*\/\s*Segment\s*\/\s*"report"\s*\)/]},
        cpp: {all: [/Get\(\s*R"\(\/v1\/shadow\/configs/]},
      },
    },
    {
      id: 'samples',
      title: 'Reports the sample count and refuses to decide below 500 pairs',
      detail:
        'The response carries the paired sample count and the verdict is `inconclusive` when it is under 500. The draft declares a winner on 12 pairs and hides the count, so a positive fluke ships.',
      match: {
        python: {all: [/MIN_PAIRED_SAMPLES\s*=\s*500/, /sample_count|samples/]},
        typescript: {all: [/MIN_PAIRED_SAMPLES\s*=\s*500/, /sample_count|samples/]},
        go: {all: [/minPairedSamples\s*=\s*500/, /Sample/]},
        scala: {all: [/MinPairedSamples\s*=\s*500/, /sample_count|samples/]},
        cpp: {all: [/kMinPairedSamples\s*=\s*500/, /sample/]},
      },
    },
    {
      id: 'interval',
      title: 'Returns a confidence interval with the delta',
      detail:
        'The report returns `ci_low` and `ci_high` alongside the delta. The draft reports a bare delta, so the reader cannot tell a real effect from noise.',
      match: {
        python: {all: [/ci_low/, /ci_high/]},
        typescript: {all: [/ci_low/, /ci_high/]},
        go: {all: [/ci_low/, /ci_high/]},
        scala: {all: [/ci_low/, /ci_high/]},
        cpp: {all: [/ci_low/, /ci_high/]},
      },
    },
    {
      id: 'window',
      title: 'Reports the exact traffic window',
      detail:
        'The response carries `window_start` and `window_end` for the samples. The draft returns none, so a delta cannot be tied to the period and traffic mix it came from.',
      match: {
        python: {all: [/window_start/, /window_end/]},
        typescript: {all: [/window_start/, /window_end/]},
        go: {all: [/window_start/, /window_end/]},
        scala: {all: [/window_start/, /window_end/]},
        cpp: {all: [/window_start/, /window_end/]},
      },
    },
    {
      id: 'tenant-scope',
      title: 'Scopes the report to the tenant and 404s a foreign config',
      detail:
        'The config is loaded for the authenticated tenant, and a config that is not theirs is **404**. The draft serves any config to any caller, so one tenant reads another’s experiment.',
      match: {
        python: {all: [/status_code\s*=\s*404/, /tenant/]},
        typescript: {all: [/code\(\s*404\s*\)/, /tenant/i]},
        go: {all: [/StatusNotFound/, /[Tt]enant/]},
        scala: {all: [/StatusCodes\.NotFound/, /tenant/]},
        cpp: {all: [/\b404\b/, /tenant/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import logging

from fastapi import FastAPI, Header
from fastapi.responses import JSONResponse

app = FastAPI()
logger = logging.getLogger("shadow.report")


class ReportStore:
    def load(self, config_id: str) -> dict:
        """The paired samples of a config."""
        raise NotImplementedError


store = ReportStore()


@app.get("/v1/shadow/configs/{id}/report")
def shadow_report(
    id: str,
    tenant: str | None = Header(default=None, alias="X-Tenant-Id"),
) -> JSONResponse:
    # TODO: the draft declares a winner from twelve pairs because the delta is positive, hides the
    # sample count and the interval, and serves any config to any caller. Review all three.
    report = store.load(id)
    deltas = report["deltas"]
    delta = sum(deltas) / len(deltas)
    verdict = "candidate_better" if delta > 0 else "inconclusive"
    return JSONResponse({"config_id": id, "delta": delta, "verdict": verdict}, status_code=200)
`,
      solution: `import logging
import math

from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse

app = FastAPI()
logger = logging.getLogger("shadow.report")

MIN_PAIRED_SAMPLES = 500
Z_95 = 1.96


class ReportStore:
    def load(self, tenant: str, config_id: str) -> dict | None:
        """The config and its paired samples for this tenant, or None when it is not theirs."""
        raise NotImplementedError


store = ReportStore()


def confidence_interval(deltas: list[float]) -> tuple[float, float]:
    n = len(deltas)
    mean = sum(deltas) / n
    variance = sum((d - mean) ** 2 for d in deltas) / (n - 1)
    half = Z_95 * math.sqrt(variance / n)
    return mean - half, mean + half


def verdict(sample_count: int, ci_low: float, ci_high: float) -> str:
    # Below the threshold a positive delta is noise, not a winner.
    if sample_count < MIN_PAIRED_SAMPLES:
        return "inconclusive"
    if ci_low > 0:
        return "candidate_better"
    if ci_high < 0:
        return "production_better"
    return "inconclusive"


@app.get("/v1/shadow/configs/{id}/report")
def shadow_report(
    id: str,
    tenant: str | None = Header(default=None, alias="X-Tenant-Id"),
) -> JSONResponse:
    if tenant is None or tenant == "":
        raise HTTPException(status_code=401, detail="missing X-Tenant-Id")
    report = store.load(tenant, id)
    # Another tenant's config is not found, not forbidden: never confirm it exists.
    if report is None:
        raise HTTPException(status_code=404, detail="config not found")
    deltas = report["deltas"]
    ci_low, ci_high = confidence_interval(deltas)
    body = {
        "config_id": id,
        "sample_count": len(deltas),
        "delta": sum(deltas) / len(deltas),
        "ci_low": ci_low,
        "ci_high": ci_high,
        "window_start": report["window_start"],
        "window_end": report["window_end"],
        "verdict": verdict(len(deltas), ci_low, ci_high),
    }
    logger.info("shadow.report tenant=%s config=%s samples=%d", tenant, id, len(deltas))
    return JSONResponse(body, status_code=200)
`,
    },
    typescript: {
      starter: `/** GET /v1/shadow/configs/{id}/report: a model-generated draft that celebrates too early. */
import Fastify from 'fastify';

import {reportStore} from './store';

export const app = Fastify();

app.get<{Params: {id: string}}>('/v1/shadow/configs/:id/report', async (request, reply) => {
  // TODO: the draft declares a winner from twelve pairs because the delta is positive, hides the
  // sample count and the interval, and serves any config to any caller. Review all three.
  const {id} = request.params;
  const report = await reportStore.load(id);
  const delta = report.deltas.reduce((sum: number, d: number) => sum + d, 0) / report.deltas.length;
  const verdict = delta > 0 ? 'candidate_better' : 'inconclusive';
  return reply.code(200).send({config_id: id, delta, verdict});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** GET /v1/shadow/configs/{id}/report: significance before celebration. */
import Fastify from 'fastify';

import {reportStore} from './store';

export const app = Fastify();

const MIN_PAIRED_SAMPLES = 500;
const Z_95 = 1.96;

interface Interval {
  ci_low: number;
  ci_high: number;
}

function confidenceInterval(deltas: number[]): Interval {
  const n = deltas.length;
  const mean = deltas.reduce((sum, d) => sum + d, 0) / n;
  const variance = deltas.reduce((sum, d) => sum + (d - mean) ** 2, 0) / (n - 1);
  const half = Z_95 * Math.sqrt(variance / n);
  return {ci_low: mean - half, ci_high: mean + half};
}

function verdict(sampleCount: number, ciLow: number, ciHigh: number): string {
  if (sampleCount < MIN_PAIRED_SAMPLES) return 'inconclusive';
  if (ciLow > 0) return 'candidate_better';
  if (ciHigh < 0) return 'production_better';
  return 'inconclusive';
}

app.get<{Params: {id: string}}>('/v1/shadow/configs/:id/report', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing X-Tenant-Id'});
  const {id} = request.params;
  const report = await reportStore.load(tenant, id);
  // Another tenant's config is not found, not forbidden: never confirm it exists.
  if (report === null) return reply.code(404).send({error: 'config not found'});
  const {ci_low, ci_high} = confidenceInterval(report.deltas);
  return reply.code(200).send({
    config_id: id,
    sample_count: report.deltas.length,
    delta: report.deltas.reduce((sum, d) => sum + d, 0) / report.deltas.length,
    ci_low,
    ci_high,
    window_start: report.window_start,
    window_end: report.window_end,
    verdict: verdict(report.deltas.length, ci_low, ci_high),
  });
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
    },
    go: {
      starter: `package main

import (
	"log"
	"net/http"
)

type ReportStore struct{}

func (s *ReportStore) Load(configID string) (map[string]any, error) {
	return nil, nil
}

var reportStore = &ReportStore{}

func shadowReport(rw http.ResponseWriter, r *http.Request) {
	// TODO: the draft declares a winner from twelve pairs because the delta is positive, hides the
	// sample count and the interval, and serves any config to any caller. Review all three.
	configID := r.PathValue("id")
	report, _ := reportStore.Load(configID)
	verdict := "inconclusive"
	if report["delta"].(float64) > 0 {
		verdict = "candidate_better"
	}
	writeJSON(rw, http.StatusOK, map[string]any{"config_id": configID, "verdict": verdict})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/shadow/configs/{id}/report", shadowReport)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
      solution: `package main

import (
	"encoding/json"
	"log"
	"math"
	"net/http"
)

const minPairedSamples = 500
const z95 = 1.96

type ReportStore struct{}

func (s *ReportStore) Load(tenant, configID string) (map[string]any, error) {
	return nil, nil
}

var reportStore = &ReportStore{}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func confidenceInterval(deltas []float64) (float64, float64) {
	n := float64(len(deltas))
	mean := 0.0
	for _, d := range deltas {
		mean += d
	}
	mean /= n
	variance := 0.0
	for _, d := range deltas {
		variance += (d - mean) * (d - mean)
	}
	variance /= n - 1
	half := z95 * math.Sqrt(variance/n)
	return mean - half, mean + half
}

func reportVerdict(sampleCount int, ciLow, ciHigh float64) string {
	if sampleCount < minPairedSamples {
		return "inconclusive"
	}
	if ciLow > 0 {
		return "candidate_better"
	}
	if ciHigh < 0 {
		return "production_better"
	}
	return "inconclusive"
}

func shadowReport(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-Tenant-Id"})
		return
	}
	configID := r.PathValue("id")
	report, _ := reportStore.Load(tenant, configID)
	// Another tenant's config is not found, not forbidden: never confirm it exists.
	if report == nil {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "config not found"})
		return
	}
	deltas := toFloatSlice(report["deltas"])
	ciLow, ciHigh := confidenceInterval(deltas)
	writeJSON(rw, http.StatusOK, map[string]any{
		"config_id":    configID,
		"sample_count": len(deltas),
		"ci_low":       ciLow,
		"ci_high":      ciHigh,
		"window_start": report["window_start"],
		"window_end":   report["window_end"],
		"verdict":      reportVerdict(len(deltas), ciLow, ciHigh),
	})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/shadow/configs/{id}/report", shadowReport)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route

object ShadowReport {
  implicit val system: ActorSystem = ActorSystem("shadow-report")

  val reportStore = ReportStore.open()

  val route: Route =
    path("v1" / "shadow" / "configs" / Segment / "report") { configId =>
      get {
        // TODO: the draft declares a winner from twelve pairs because the delta is positive, hides
        // the sample count and the interval, and serves any config to any caller. Review all three.
        val report = reportStore.load(configId)
        val verdict = if (report.delta > 0) "candidate_better" else "inconclusive"
        complete(StatusCodes.OK, "{\\"config_id\\":\\"" + configId + "\\",\\"verdict\\":\\"" + verdict + "\\"}")
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
import spray.json._

object ShadowReport {
  implicit val system: ActorSystem = ActorSystem("shadow-report")

  val MinPairedSamples = 500
  val Z95 = 1.96

  val reportStore = ReportStore.open()

  def confidenceInterval(deltas: Seq[Double]): (Double, Double) = {
    val n = deltas.size.toDouble
    val mean = deltas.sum / n
    val variance = deltas.map(d => (d - mean) * (d - mean)).sum / (n - 1)
    val half = Z95 * math.sqrt(variance / n)
    (mean - half, mean + half)
  }

  def verdict(sampleCount: Int, ciLow: Double, ciHigh: Double): String =
    if (sampleCount < MinPairedSamples) "inconclusive"
    else if (ciLow > 0) "candidate_better"
    else if (ciHigh < 0) "production_better"
    else "inconclusive"

  def reportJson(configId: String, report: Report): String = {
    val (ciLow, ciHigh) = confidenceInterval(report.deltas)
    Json
      .obj(
        "config_id" -> configId.toJson,
        "sample_count" -> report.deltas.size.toJson,
        "ci_low" -> ciLow.toJson,
        "ci_high" -> ciHigh.toJson,
        "window_start" -> report.windowStart.toJson,
        "window_end" -> report.windowEnd.toJson,
        "verdict" -> verdict(report.deltas.size, ciLow, ciHigh).toJson
      )
      .compactPrint
  }

  val route: Route =
    path("v1" / "shadow" / "configs" / Segment / "report") { configId =>
      get {
        optionalHeaderValueByName("X-Tenant-Id") { tenantOpt =>
          if (!tenantOpt.exists(_.nonEmpty)) {
            complete(StatusCodes.Unauthorized, """{"error":"missing X-Tenant-Id"}""")
          } else {
            val tenant = tenantOpt.get
            reportStore.load(tenant, configId) match {
              case None =>
                // Another tenant's config is not found, not forbidden: never confirm it exists.
                complete(StatusCodes.NotFound, """{"error":"config not found"}""")
              case Some(report) =>
                complete(StatusCodes.OK, reportJson(configId, report))
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

#include <string>

using json = nlohmann::json;

struct Report {
  double delta;
};

struct ReportStore {
  Report load(const std::string& configId);
};

ReportStore reportStore;

int main() {
  httplib::Server svr;

  svr.Get(R"(/v1/shadow/configs/(\\d+)/report)", [](const httplib::Request& req, httplib::Response& res) {
    // TODO: the draft declares a winner from twelve pairs because the delta is positive, hides the
    // sample count and the interval, and serves any config to any caller. Review all three.
    const auto configId = req.matches[1].str();
    const auto report = reportStore.load(configId);
    const std::string verdict = report.delta > 0 ? "candidate_better" : "inconclusive";
    res.status = 200;
    res.set_content(json{{"config_id", configId}, {"verdict", verdict}}.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <cmath>
#include <cstddef>
#include <optional>
#include <string>
#include <utility>
#include <vector>

using json = nlohmann::json;

constexpr int kMinPairedSamples = 500;
constexpr double kZ95 = 1.96;

struct Report {
  std::vector<double> deltas;
  std::string window_start;
  std::string window_end;
};

struct ReportStore {
  std::optional<Report> load(const std::string& tenant, const std::string& configId);
};

ReportStore reportStore;

std::pair<double, double> confidenceInterval(const std::vector<double>& deltas) {
  const double n = static_cast<double>(deltas.size());
  double mean = 0.0;
  for (double d : deltas) mean += d;
  mean /= n;
  double variance = 0.0;
  for (double d : deltas) variance += (d - mean) * (d - mean);
  variance /= n - 1;
  const double half = kZ95 * std::sqrt(variance / n);
  return {mean - half, mean + half};
}

std::string verdict(std::size_t sampleCount, double ciLow, double ciHigh) {
  if (static_cast<int>(sampleCount) < kMinPairedSamples) return "inconclusive";
  if (ciLow > 0) return "candidate_better";
  if (ciHigh < 0) return "production_better";
  return "inconclusive";
}

int main() {
  httplib::Server svr;

  svr.Get(R"(/v1/shadow/configs/(\\d+)/report)", [](const httplib::Request& req, httplib::Response& res) {
    const auto tenant = req.get_header_value("X-Tenant-Id");
    if (tenant.empty()) {
      res.status = 401;
      res.set_content(R"({"error":"missing X-Tenant-Id"})", "application/json");
      return;
    }
    const auto configId = req.matches[1].str();
    const auto report = reportStore.load(tenant, configId);
    // Another tenant's config is not found, not forbidden: never confirm it exists.
    if (!report) {
      res.status = 404;
      res.set_content(R"({"error":"config not found"})", "application/json");
      return;
    }
    const auto [ciLow, ciHigh] = confidenceInterval(report->deltas);
    const json body = {
        {"config_id", configId},
        {"sample_count", report->deltas.size()},
        {"ci_low", ciLow},
        {"ci_high", ciHigh},
        {"window_start", report->window_start},
        {"window_end", report->window_end},
        {"verdict", verdict(report->deltas.size(), ciLow, ciHigh)},
    };
    res.status = 200;
    res.set_content(body.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  hints: [
    'A delta is not a result without its sample count and its window: return `sample_count`, `window_start` and `window_end` next to the delta. Then the threshold is a one-line comparison: `sample_count < 500` ⇒ `inconclusive`, whatever the delta says.',
    'The interval is what makes the delta readable: `ci_low` and `ci_high` around the paired mean (`z * sqrt(variance / n)`). A winner is only a winner when the interval excludes zero — and only above the sample threshold.',
    'Scope the load by tenant and answer **404** for anything that is not theirs — the same answer as a config that never existed. A 403 confirms the config exists, which is itself a leak between customers.',
  ],
  debrief: `The interviewer is testing whether you can keep a measurement from becoming an unsupported decision. Four defects are being checked. The threshold: twelve pairs and a positive delta is noise, and the endpoint must say \`inconclusive\` rather than crown a winner — a shadow that ships a model on a fluke is worse than no shadow. The interval: a delta without a confidence interval cannot be judged, so \`ci_low\`/\`ci_high\` travel with it. The window: a delta is only meaningful for the period and traffic mix it came from, so \`window_start\`/\`window_end\` are part of the answer. The scope: load the config for the authenticated tenant and return 404 for anything else, because a 403 confirms a foreign experiment exists. Real reports add the metric breakdown, the share actually observed versus configured, and a guard on the experiment’s own runtime before it is allowed to conclude anything.`,
};
