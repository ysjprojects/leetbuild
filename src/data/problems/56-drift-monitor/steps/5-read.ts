import type {Step} from '@/lib/types';

export const monitorReportStep: Step = {
  id: 'read',
  title: 'GET /v1/monitors/{id}/report: significance, not just a number',
  concept: 'http',
  file: 'read',
  focus: ['client', 'monitor', 'redis'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: the endpoint returns a distance,
the demo looks right, and the number is meaningless. It hides three flaws. Review it, fix it, and prove
the fix.

Implement \`GET /v1/monitors/{monitor_id}/report\`:

- The tenant comes from \`X-Tenant-Id\` (**401** when absent) and the monitor is resolved **scoped by
  tenant** — \`store.report(tenant, monitor_id)\`. A foreign or unknown monitor id is **404**, never
  another tenant's drift.
- The report always carries the **sample counts** on both sides (\`sample_count\`,
  \`baseline_sample_count\`), the current window boundaries and the **baseline window**. A distance
  without counts cannot be judged; the draft hides them.
- The state is **explicit**: fewer than \`MIN_SAMPLES = 200\` samples on either side reports
  \`state: "insufficient_data"\` rather than an alert. The draft calls a distance computed from a single
  batch of 20 samples significant.
- \`threshold_crossed\` is true only when the samples are sufficient **and** \`distance >= threshold\`;
  otherwise it is false, and the state says why.
- The response carries numbers about the distribution, never feature values.

**Failure mode the checks target.** A number without its counts is an opinion: on 20 samples a
distance of 0.4 is noise, and a monitor that reports it as a crossing trains everyone to ignore it. A
report that resolves the monitor by id alone also leaks one tenant's drift to another. Both flaws pass
every demo, because demos ask for their own monitor and never look at the sample count.`,
  sequence: {
    participants: ['Client', 'Drift Monitor', 'report store', 'Redis'],
    messages: [
      {from: 'Client', to: 'Drift Monitor', label: 'GET /v1/monitors/{id}/report · X-Tenant-Id', kind: 'sync'},
      {from: 'Drift Monitor', to: 'report store', label: 'report(tenant, monitor_id)', kind: 'sync'},
      {from: 'report store', to: 'Drift Monitor', label: 'distance · counts · baseline window / none', kind: 'reply'},
      {from: 'Drift Monitor', to: 'Redis', label: 'HGET sketch:live:… · HGET baseline', kind: 'async'},
      {
        from: 'Drift Monitor',
        to: 'Client',
        label: '200 {state, distance, sample_count, baseline_window, threshold_crossed}',
        kind: 'reply',
      },
      {from: 'Drift Monitor', to: 'Client', label: '404 when the monitor belongs to another tenant', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Handles GET /v1/monitors/{id}/report',
      detail: 'Register the report route on `GET /v1/monitors/{monitor_id}/report`.',
      match: {
        python: {all: [/@app\.get\(\s*["']\/v1\/monitors\/\{monitor_id\}\/report["']/]},
        typescript: {all: [/app\.get\(\s*['"]\/v1\/monitors\/:monitor_id\/report['"]/]},
        go: {all: [/HandleFunc\(\s*"GET \/v1\/monitors\/\{monitor_id\}\/report"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"monitors"\s*\/\s*Segment\s*\/\s*"report"\s*\)/, /\bget\s*\{/]},
        cpp: {all: [/svr\.Get\([^,]*\/v1\/monitors\//]},
      },
    },
    {
      id: 'tenant-scope',
      title: 'Resolves the monitor inside the tenant',
      detail:
        'The lookup is `store.report(tenant, monitor_id)` and a missing or foreign monitor is **404** — not another tenant’s drift and not a 403. The draft resolves by monitor id alone, so any caller can read any monitor.',
      match: {
        python: {all: [/store\.report\(tenant, monitor_id\)/, /status_code\s*=\s*404/]},
        typescript: {all: [/store\.report\(tenant, monitorId\)/, /code\(\s*404\s*\)/]},
        go: {all: [/store\.Report\(r\.Context\(\), tenant, monitorID\)/, /StatusNotFound/]},
        scala: {all: [/store\.report\(tenant, monitorId\)/, /StatusCodes\.NotFound/]},
        cpp: {all: [/store\.report\(tenant, monitorId\)/, /\b404\b/]},
      },
    },
    {
      id: 'sample-counts',
      title: 'Always returns the sample counts and the baseline window',
      detail:
        'The report includes `sample_count`, `baseline_sample_count` and `baseline_window` alongside the distance. The draft returns the distance and hides everything a reader needs to judge it.',
      match: {
        python: {all: [/sample_count/, /baseline_sample_count/, /baseline_window/]},
        typescript: {all: [/sample_count/, /baseline_sample_count/, /baseline_window/]},
        go: {all: [/SampleCount/, /BaselineSampleCount/, /BaselineWindow/]},
        scala: {all: [/sampleCount/, /baselineSampleCount/, /baselineWindow/]},
        cpp: {all: [/sample_count/, /baseline_sample_count/, /baseline_window/]},
      },
    },
    {
      id: 'insufficient-data',
      title: 'Calls out insufficient data below the sample floor',
      detail:
        'Fewer than `MIN_SAMPLES = 200` samples on either side reports `insufficient_data` instead of a crossing. The draft treats 20 samples as significant because the distance looked large.',
      match: {
        python: {all: [/MIN_SAMPLES\s*=\s*200/, /insufficient_data/]},
        typescript: {all: [/MIN_SAMPLES\s*=\s*200/, /insufficient_data/]},
        go: {all: [/minSamples\s*=\s*200/, /insufficient_data/]},
        scala: {all: [/MinSamples\s*=\s*200/, /insufficient_data/]},
        cpp: {all: [/kMinSamples\s*=\s*200/, /insufficient_data/]},
      },
    },
    {
      id: 'threshold-crossed',
      title: 'Reports a crossing only for a sufficient, over-threshold window',
      detail:
        '`threshold_crossed` is computed as `sufficient and distance >= threshold`, never hardcoded. The draft returns `"significant": true` for whatever it found.',
      match: {
        python: {all: [/threshold_crossed/, /distance\s*>=\s*threshold/]},
        typescript: {all: [/threshold_crossed/, /distance\s*>=\s*threshold/]},
        go: {all: [/threshold_crossed/, /distance\s*>=\s*threshold/]},
        scala: {all: [/threshold_crossed/, /distance\s*>=\s*threshold/]},
        cpp: {all: [/threshold_crossed/, /distance\s*>=\s*threshold/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import logging

from fastapi import FastAPI, Header
from fastapi.responses import JSONResponse

app = FastAPI()
logger = logging.getLogger("drift-monitor")


class ReportStore:
    def resolve(self, monitor_id: str) -> dict | None:
        """The latest evaluation for a monitor id."""
        raise NotImplementedError


store = ReportStore()


@app.get("/v1/monitors/{monitor_id}/report")
def monitor_report(
    monitor_id: str,
    tenant: str | None = Header(default=None, alias="X-Tenant-Id"),
) -> JSONResponse:
    # TODO: this draft resolves the monitor by id alone, so any tenant can read any monitor; it
    # reports a distance computed from a single 20-sample batch as significant; and it hides the
    # sample counts. Review all three.
    latest = store.resolve(monitor_id)
    if latest is None:
        return JSONResponse({"error": "not found"}, status_code=404)
    return JSONResponse(
        {
            "monitor_id": monitor_id,
            "metric": latest["metric"],
            "distance": latest["distance"],
            "significant": True,
        },
        status_code=200,
    )
`,
      solution: `import logging

from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse

app = FastAPI()
logger = logging.getLogger("drift-monitor")

MIN_SAMPLES = 200


class ReportStore:
    def report(self, tenant: str, monitor_id: str) -> dict | None:
        """The monitor's report view, scoped to its owner, or None when it is not theirs."""
        raise NotImplementedError


store = ReportStore()


@app.get("/v1/monitors/{monitor_id}/report")
def monitor_report(
    monitor_id: str,
    tenant: str | None = Header(default=None, alias="X-Tenant-Id"),
) -> JSONResponse:
    if tenant is None or tenant == "":
        raise HTTPException(status_code=401, detail="missing X-Tenant-Id")
    report = store.report(tenant, monitor_id)
    if report is None:
        raise HTTPException(status_code=404, detail="monitor not found")

    sample_count = int(report["sample_count"])
    baseline_sample_count = int(report["baseline_sample_count"])
    distance = float(report["distance"])
    threshold = float(report["threshold"])
    sufficient = sample_count >= MIN_SAMPLES and baseline_sample_count >= MIN_SAMPLES
    crossed = sufficient and distance >= threshold
    logger.info("report tenant=%s monitor=%s sufficient=%s", tenant, monitor_id, sufficient)
    return JSONResponse(
        {
            "monitor_id": monitor_id,
            "metric": report["metric"],
            "state": "ok" if sufficient else "insufficient_data",
            "distance": distance,
            "threshold": threshold,
            "sample_count": sample_count,
            "baseline_sample_count": baseline_sample_count,
            "window_start": report["window_start"],
            "window_end": report["window_end"],
            "baseline_window": report["baseline_window"],
            "threshold_crossed": crossed,
        },
        status_code=200,
    )
`,
    },
    typescript: {
      starter: `/** GET /v1/monitors/{id}/report: a model-generated draft. */
import Fastify from 'fastify';

import {store} from './store';

export const app = Fastify();

app.get('/v1/monitors/:monitor_id/report', async (request, reply) => {
  // TODO: this draft resolves the monitor by id alone, so any tenant can read any monitor; it
  // reports a distance computed from a single 20-sample batch as significant; and it hides the
  // sample counts. Review all three.
  const {monitor_id: monitorId} = request.params as {monitor_id: string};
  const latest = await store.resolve(monitorId);
  if (latest === null) return reply.code(404).send({error: 'not found'});
  return reply.code(200).send({
    monitor_id: monitorId,
    metric: latest.metric,
    distance: latest.distance,
    significant: true,
  });
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** GET /v1/monitors/{id}/report: significance, not just a number. */
import Fastify from 'fastify';

import {store} from './store';

export const app = Fastify();

const MIN_SAMPLES = 200;

app.get('/v1/monitors/:monitor_id/report', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing X-Tenant-Id'});
  const {monitor_id: monitorId} = request.params as {monitor_id: string};
  const report = await store.report(tenant, monitorId);
  if (report === null) return reply.code(404).send({error: 'monitor not found'});

  const sample_count = report.sample_count;
  const baseline_sample_count = report.baseline_sample_count;
  const distance = report.distance;
  const threshold = report.threshold;
  const sufficient = sample_count >= MIN_SAMPLES && baseline_sample_count >= MIN_SAMPLES;
  const crossed = sufficient && distance >= threshold;
  request.log.info({tenant, monitor: monitorId, sufficient}, 'reported drift');
  return reply.code(200).send({
    monitor_id: monitorId,
    metric: report.metric,
    state: sufficient ? 'ok' : 'insufficient_data',
    distance,
    threshold,
    sample_count,
    baseline_sample_count,
    window_start: report.window_start,
    window_end: report.window_end,
    baseline_window: report.baseline_window,
    threshold_crossed: crossed,
  });
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"net/http"
)

type Report struct {
	Metric   string  \`json:"metric"\`
	Distance float64 \`json:"distance"\`
}

type ReportStore interface {
	Resolve(ctx context.Context, monitorID string) (*Report, error)
}

var store ReportStore

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	_ = json.NewEncoder(rw).Encode(body)
}

func monitorReport(rw http.ResponseWriter, r *http.Request) {
	// TODO: this draft resolves the monitor by id alone, so any tenant can read any monitor; it
	// reports a distance computed from a single 20-sample batch as significant; and it hides the
	// sample counts. Review all three.
	monitorID := r.PathValue("monitor_id")
	latest, err := store.Resolve(r.Context(), monitorID)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	if latest == nil {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	}
	writeJSON(rw, http.StatusOK, map[string]any{
		"monitor_id":  monitorID,
		"metric":      latest.Metric,
		"distance":    latest.Distance,
		"significant": true,
	})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/monitors/{monitor_id}/report", monitorReport)
	_ = http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux)
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"net/http"
)

const minSamples = 200

type Report struct {
	Metric              string  \`json:"metric"\`
	Distance            float64 \`json:"distance"\`
	Threshold           float64 \`json:"threshold"\`
	SampleCount         int64   \`json:"sample_count"\`
	BaselineSampleCount int64   \`json:"baseline_sample_count"\`
	WindowStart         int64   \`json:"window_start"\`
	WindowEnd           int64   \`json:"window_end"\`
	BaselineWindow      int64   \`json:"baseline_window"\`
}

type ReportStore interface {
	Report(ctx context.Context, tenant, monitorID string) (*Report, error)
}

var store ReportStore

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	_ = json.NewEncoder(rw).Encode(body)
}

func monitorReport(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-Tenant-Id"})
		return
	}
	monitorID := r.PathValue("monitor_id")
	report, err := store.Report(r.Context(), tenant, monitorID)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	if report == nil {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "monitor not found"})
		return
	}
	sampleCount := report.SampleCount
	baselineSampleCount := report.BaselineSampleCount
	distance := report.Distance
	threshold := report.Threshold
	sufficient := sampleCount >= minSamples && baselineSampleCount >= minSamples
	crossed := sufficient && distance >= threshold
	writeJSON(rw, http.StatusOK, map[string]any{
		"monitor_id":            monitorID,
		"metric":                report.Metric,
		"state":                 map[bool]string{true: "ok", false: "insufficient_data"}[sufficient],
		"distance":              distance,
		"threshold":             threshold,
		"sample_count":          sampleCount,
		"baseline_sample_count": baselineSampleCount,
		"window_start":          report.WindowStart,
		"window_end":            report.WindowEnd,
		"baseline_window":       report.BaselineWindow,
		"threshold_crossed":     crossed,
	})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/monitors/{monitor_id}/report", monitorReport)
	_ = http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route

final case class ReportView(metric: String, distance: Double)

object ReportApi {
  implicit val system: ActorSystem = ActorSystem("drift-monitor")

  val store = ReportStore.open()

  val route: Route =
    path("v1" / "monitors" / Segment / "report") { monitorId =>
      get {
        // TODO: this draft resolves the monitor by id alone, so any tenant can read any monitor; it
        // reports a distance computed from a single 20-sample batch as significant; and it hides the
        // sample counts. Review all three.
        store.resolve(monitorId) match {
          case None =>
            complete(StatusCodes.NotFound, """{"error":"not found"}""")
          case Some(latest) =>
            complete(StatusCodes.OK, s"""{"monitor_id":"$monitorId","distance":\${latest.distance}}""")
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
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class MonitorReport(
    monitor_id: String,
    metric: String,
    state: String,
    distance: Double,
    threshold: Double,
    sample_count: Long,
    baseline_sample_count: Long,
    window_start: Long,
    window_end: Long,
    baseline_window: Long,
    threshold_crossed: Boolean,
)

object ReportApi {
  implicit val system: ActorSystem = ActorSystem("drift-monitor")
  implicit val reportFormat: RootJsonFormat[MonitorReport] = jsonFormat11(MonitorReport)

  val MinSamples = 200
  val store = ReportStore.open()

  val route: Route =
    path("v1" / "monitors" / Segment / "report") { monitorId =>
      get {
        optionalHeaderValueByName("X-Tenant-Id") { tenantOpt =>
          if (!tenantOpt.exists(_.nonEmpty)) {
            complete(StatusCodes.Unauthorized, """{"error":"missing X-Tenant-Id"}""")
          } else {
            val tenant = tenantOpt.get
            store.report(tenant, monitorId) match {
              case None =>
                complete(StatusCodes.NotFound, """{"error":"monitor not found"}""")
              case Some(report) =>
                val sampleCount = report.sampleCount
                val baselineSampleCount = report.baselineSampleCount
                val distance = report.distance
                val threshold = report.threshold
                val sufficient = sampleCount >= MinSamples && baselineSampleCount >= MinSamples
                val crossed = sufficient && distance >= threshold
                complete(
                  StatusCodes.OK,
                  MonitorReport(
                    monitor_id = monitorId,
                    metric = report.metric,
                    state = if (sufficient) "ok" else "insufficient_data",
                    distance = distance,
                    threshold = threshold,
                    sample_count = sampleCount,
                    baseline_sample_count = baselineSampleCount,
                    window_start = report.windowStart,
                    window_end = report.windowEnd,
                    baseline_window = report.baselineWindow,
                    threshold_crossed = crossed,
                  ),
                )
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

#include <optional>
#include <string>

using json = nlohmann::json;

struct MonitorReport {
  std::string metric;
  double distance;
};

struct ReportStore {
  std::optional<MonitorReport> resolve(const std::string& monitorId);
};

ReportStore store;

int main() {
  httplib::Server svr;

  svr.Get(R"(/v1/monitors/([^/]+)/report)", [](const httplib::Request& req, httplib::Response& res) {
    // TODO: this draft resolves the monitor by id alone, so any tenant can read any monitor; it
    // reports a distance computed from a single 20-sample batch as significant; and it hides the
    // sample counts. Review all three.
    const auto monitorId = req.matches[1].str();
    const auto latest = store.resolve(monitorId);
    if (!latest) {
      res.status = 404;
      res.set_content(R"({"error":"not found"})", "application/json");
      return;
    }
    res.status = 200;
    res.set_content(json{{"monitor_id", monitorId},
                         {"metric", latest->metric},
                         {"distance", latest->distance},
                         {"significant", true}}
                        .dump(),
                    "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <optional>
#include <string>

using json = nlohmann::json;

constexpr int kMinSamples = 200;

struct MonitorReport {
  std::string metric;
  double distance;
  double threshold;
  long sample_count;
  long baseline_sample_count;
  long window_start;
  long window_end;
  long baseline_window;
};

struct ReportStore {
  std::optional<MonitorReport> report(const std::string& tenant, const std::string& monitorId);
};

ReportStore store;

int main() {
  httplib::Server svr;

  svr.Get(R"(/v1/monitors/([^/]+)/report)", [](const httplib::Request& req, httplib::Response& res) {
    const auto tenant = req.get_header_value("X-Tenant-Id");
    if (tenant.empty()) {
      res.status = 401;
      res.set_content(R"({"error":"missing X-Tenant-Id"})", "application/json");
      return;
    }
    const auto monitorId = req.matches[1].str();
    const auto report = store.report(tenant, monitorId);
    if (!report) {
      res.status = 404;
      res.set_content(R"({"error":"monitor not found"})", "application/json");
      return;
    }
    const long sample_count = report->sample_count;
    const long baseline_sample_count = report->baseline_sample_count;
    const double distance = report->distance;
    const double threshold = report->threshold;
    const bool sufficient = sample_count >= kMinSamples && baseline_sample_count >= kMinSamples;
    const bool crossed = sufficient && distance >= threshold;
    const json body = {
        {"monitor_id", monitorId},
        {"metric", report->metric},
        {"state", sufficient ? "ok" : "insufficient_data"},
        {"distance", distance},
        {"threshold", threshold},
        {"sample_count", sample_count},
        {"baseline_sample_count", baseline_sample_count},
        {"window_start", report->window_start},
        {"window_end", report->window_end},
        {"baseline_window", report->baseline_window},
        {"threshold_crossed", crossed},
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
    'Authorize with the same lookup you read with: `store.report(tenant, monitor_id)` returns nothing when the monitor belongs to someone else, and that nothing is a **404**. Resolving by monitor id alone and then comparing owners in the handler is the bug the draft ships.',
    'Ship the counts with the number. `sample_count`, `baseline_sample_count` and `baseline_window` are what let a reader decide whether a distance of 0.4 is drift or noise — a report without them is an opinion.',
    'Make the state explicit rather than implied: `sufficient = sample_count >= MIN_SAMPLES and baseline_sample_count >= MIN_SAMPLES`, `state = "ok" / "insufficient_data"`, and `threshold_crossed = sufficient and distance >= threshold`. Never return a crossing the samples cannot support.',
  ],
  debrief: `The last step is the one that decides whether the monitor is trusted. Three habits are being tested:
scope every read to the tenant that owns the object, so a monitor id from another workspace is a 404
rather than a leak; report the counts alongside the distance, because significance is a property of the
sample, not of the number; and model the third state explicitly — drift monitors have "no drift", "drift"
and "not enough data yet", and collapsing the third into either of the others is how a monitor earns a
reputation for crying wolf. Real platforms add confidence intervals or p-values per distance measure,
per-feature breakdowns, a report cache keyed by (monitor, window), and a retention policy that keeps the
baseline window readable for as long as the comparison is offered.`,
};
