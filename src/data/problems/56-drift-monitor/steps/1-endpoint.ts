import type {Step} from '@/lib/types';

export const monitorEndpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/monitors: monitors that observe something real',
  concept: 'http',
  guides: ['request-boundaries', 'idempotent-requests'],
  file: 'api',
  focus: ['client', 'monitor', 'registry'],
  task: `## Task

**Starting point.** The starter serves \`POST /v1/monitors\` with body \`{"model_version", "metric",
"window_s", "baseline", "threshold"}\` on the monitor store (\`drift.store\`, provided): it reads
\`X-Tenant-Id\`, stores the body with \`store.create_monitor\` and answers 201 with the monitor. It
serves the demo and hides four flaws.

**Failure mode the checks target.** A monitor on a misspelled metric or a one-minute window pages on
noise; a monitor on a version the registry never promoted watches traffic that does not exist; a
baseline that is not a frozen reference moves with the signal it judges; and a client that retries
its registration gets two monitors and two pages.

- A missing tenant is **401**. \`metric\` is one of \`METRICS\` (\`input_distribution\`,
  \`outcome_rate\`, \`calibration\`) and \`window_s\` runs from \`MIN_WINDOW_S\` = 300 to
  \`MAX_WINDOW_S\` = 86400 (default 3600); anything else is **400**.
- \`model_version\` must be promoted (\`store.is_promoted\`), or **400**.
- \`baseline\` must match \`BASELINE_RE\`, \`baseline:{model_version}:{yyyy-mm-dd}\`, or **400**.
- \`Idempotency-Key\` is required (**400**). Look it up with \`store.monitor_for_key(tenant, key)\`
  before creating, answer the recorded monitor on a replay, and call \`store.remember_key\` after
  creating.`,
  sequence: {
    participants: ['Client', 'Drift Monitor', 'model registry', 'monitor store'],
    messages: [
      {from: 'Client', to: 'Drift Monitor', label: 'POST /v1/monitors · X-Tenant-Id · Idempotency-Key', kind: 'sync'},
      {from: 'Drift Monitor', to: 'Drift Monitor', label: 'METRICS · window 300..86400 · BASELINE_RE', kind: 'sync'},
      {from: 'Drift Monitor', to: 'model registry', label: 'is_promoted(model_version)', kind: 'sync'},
      {from: 'model registry', to: 'Drift Monitor', label: 'promoted / not promoted → 400', kind: 'reply'},
      {from: 'Drift Monitor', to: 'monitor store', label: 'monitor_for_key(tenant, key)', kind: 'sync'},
      {from: 'monitor store', to: 'Drift Monitor', label: 'recorded monitor → replay / none', kind: 'reply'},
      {from: 'Drift Monitor', to: 'monitor store', label: 'create_monitor · remember_key', kind: 'sync'},
      {from: 'Drift Monitor', to: 'Client', label: '201 {monitor_id, metric, window_s, baseline}', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Registers a monitor on POST /v1/monitors',
      detail: 'Register `POST /v1/monitors`: a valid registration answers 201 with the stored monitor and its id.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/monitors["']/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/monitors['"]/]},
        go: {all: [/HandleFunc\(\s*"POST \/v1\/monitors"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"monitors"\s*\)/, /\bpost\s*\{/]},
        cpp: {all: [/svr\.Post\(\s*"\/v1\/monitors"/]},
      },
    },
    {
      id: 'metric-window',
      title: 'Requires a tenant, a known metric and a bounded window',
      detail:
        'A missing `X-Tenant-Id` is **401**; a metric outside `METRICS` or a `window_s` outside `MIN_WINDOW_S`..`MAX_WINDOW_S` is **400**, and none of them stores a monitor.',
      match: {
        python: {all: [/METRICS/, /MIN_WINDOW_S/, /MAX_WINDOW_S/, /\b401\b/]},
        typescript: {all: [/METRICS/, /MIN_WINDOW_S/, /MAX_WINDOW_S/, /\b401\b/]},
        go: {all: [/\bmetrics\b/, /minWindowS/, /maxWindowS/, /StatusUnauthorized|\b401\b/]},
        scala: {all: [/\bMetrics\b/, /MinWindowS/, /MaxWindowS/, /Unauthorized|\b401\b/]},
        cpp: {all: [/kMetrics/, /kMinWindowS/, /kMaxWindowS/, /\b401\b/]},
      },
    },
    {
      id: 'promoted',
      title: 'Refuses a monitor on an unpromoted model version',
      detail:
        'The registry is asked (`is_promoted`/`isPromoted`) before the monitor is created, and a version it has not promoted is **400**.',
      match: {
        python: {order: [/store\.is_promoted\(/, /store\.create_monitor\(/]},
        typescript: {order: [/isPromoted\(/, /createMonitor\(\{/]},
        go: {order: [/store\.IsPromoted\(/, /store\.CreateMonitor\(/]},
        scala: {order: [/Store\.isPromoted\(/, /Store\.createMonitor\(/]},
        cpp: {order: [/store::isPromoted\(/, /store::createMonitor\(/]},
      },
    },
    {
      id: 'baseline',
      title: 'Accepts only a frozen, dated baseline reference',
      detail:
        'The baseline is matched against `BASELINE_RE` (`baseline:{model_version}:{yyyy-mm-dd}`) and anything else, a live segment included, is **400**.',
      match: {
        python: {all: [/BASELINE_RE\s*=/, /BASELINE_RE\.(fullmatch|match)\(/]},
        typescript: {all: [/BASELINE_RE\s*=/, /BASELINE_RE\.test\(/]},
        go: {all: [/baselineRe\s*=/, /baselineRe\.MatchString\(/]},
        scala: {all: [/BaselineRe\s*=/, /matches\(\s*BaselineRe\s*\)|BaselineRe\.(pattern|findFirstIn|unapplySeq)/]},
        cpp: {all: [/kBaselineRe/, /std::regex_match\([^\n]*kBaselineRe/]},
      },
    },
    {
      id: 'idempotency',
      title: 'Answers the recorded monitor for a replayed registration',
      detail:
        '`Idempotency-Key` is required (**400**) and looked up per tenant (`monitor_for_key`/`monitorForKey`) before the monitor is created; a replay answers the recorded monitor and a new registration records its key.',
      match: {
        python: {
          all: [/idempotency-key/i, /store\.remember_key\(/],
          order: [/store\.monitor_for_key\(/, /store\.create_monitor\(/],
        },
        typescript: {all: [/idempotency-key/i, /rememberKey\(/], order: [/monitorForKey\(/, /createMonitor\(\{/]},
        go: {
          all: [/Idempotency-Key/i, /store\.RememberKey\(/],
          order: [/store\.MonitorForKey\(/, /store\.CreateMonitor\(/],
        },
        scala: {
          all: [/Idempotency-Key/i, /Store\.rememberKey\(/],
          order: [/Store\.monitorForKey\(/, /Store\.createMonitor\(/],
        },
        cpp: {
          all: [/Idempotency-Key/i, /store::rememberKey\(/],
          order: [/store::monitorForKey\(/, /store::createMonitor\(/],
        },
      },
    },
  ],
  code: {
    python: {
      starter: `from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from drift import store  # create_monitor, monitor_for_key, remember_key, is_promoted

app = FastAPI()


class MonitorRequest(BaseModel):
    model_version: str
    metric: str
    window_s: int = 3600
    baseline: str
    threshold: float = 0.2


@app.post("/v1/monitors", status_code=201)
def register_monitor(body: MonitorRequest, request: Request) -> JSONResponse:
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    tenant = request.headers.get("x-tenant-id", "")
    monitor = store.create_monitor({"tenant": tenant, **body.model_dump()})
    return JSONResponse(monitor, status_code=201)
`,
      solution: `import re

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from drift import store  # create_monitor, monitor_for_key, remember_key, is_promoted

app = FastAPI()

METRICS = ("input_distribution", "outcome_rate", "calibration")
MIN_WINDOW_S = 300
MAX_WINDOW_S = 86_400
# A frozen, dated reference: baseline:{model_version}:{yyyy-mm-dd}.
BASELINE_RE = re.compile(r"baseline:[A-Za-z0-9._-]+:[0-9]{4}-[0-9]{2}-[0-9]{2}")


class MonitorRequest(BaseModel):
    model_version: str
    metric: str
    window_s: int = 3600
    baseline: str
    threshold: float = 0.2


@app.post("/v1/monitors", status_code=201)
def register_monitor(body: MonitorRequest, request: Request) -> JSONResponse:
    tenant = request.headers.get("x-tenant-id", "")
    if not tenant:
        raise HTTPException(status_code=401, detail="X-Tenant-Id is required")
    key = request.headers.get("idempotency-key", "")
    if not key:
        raise HTTPException(status_code=400, detail="Idempotency-Key is required")
    if body.metric not in METRICS:
        raise HTTPException(status_code=400, detail=f"metric must be one of {', '.join(METRICS)}")
    if not MIN_WINDOW_S <= body.window_s <= MAX_WINDOW_S:
        raise HTTPException(status_code=400, detail=f"window_s must be {MIN_WINDOW_S}..{MAX_WINDOW_S}")
    if not BASELINE_RE.fullmatch(body.baseline):
        raise HTTPException(status_code=400, detail="baseline must be a frozen reference baseline:{model_version}:{yyyy-mm-dd}")
    if not store.is_promoted(body.model_version):
        raise HTTPException(status_code=400, detail=f"model version {body.model_version} is not promoted")
    recorded = store.monitor_for_key(tenant, key)
    if recorded is not None:
        return JSONResponse(recorded)  # a retry answers the monitor the first attempt registered
    monitor = store.create_monitor({"tenant": tenant, **body.model_dump()})
    store.remember_key(tenant, key, monitor["monitor_id"])
    return JSONResponse(monitor, status_code=201)
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';

import {createMonitor, isPromoted, monitorForKey, rememberKey} from 'drift/store';

export const app = Fastify();

interface MonitorBody {
  model_version: string;
  metric: string;
  window_s?: number;
  baseline: string;
  threshold?: number;
}

app.post('/v1/monitors', async (request, reply) => {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const body = request.body as MonitorBody;
  const tenant = String(request.headers['x-tenant-id'] ?? '');
  const monitor = await createMonitor({
    tenant,
    model_version: body.model_version,
    metric: body.metric,
    window_s: body.window_s ?? 3600,
    baseline: body.baseline,
    threshold: body.threshold ?? 0.2,
  });
  return reply.code(201).send(monitor);
});
`,
      solution: `import Fastify from 'fastify';

import {createMonitor, isPromoted, monitorForKey, rememberKey} from 'drift/store';

export const app = Fastify();

const METRICS = ['input_distribution', 'outcome_rate', 'calibration'];
const MIN_WINDOW_S = 300;
const MAX_WINDOW_S = 86_400;
/** A frozen, dated reference: baseline:{model_version}:{yyyy-mm-dd}. */
const BASELINE_RE = /^baseline:[A-Za-z0-9._-]+:[0-9]{4}-[0-9]{2}-[0-9]{2}$/;

interface MonitorBody {
  model_version: string;
  metric: string;
  window_s?: number;
  baseline: string;
  threshold?: number;
}

app.post('/v1/monitors', async (request, reply) => {
  const body = request.body as MonitorBody;
  const tenant = String(request.headers['x-tenant-id'] ?? '');
  if (tenant === '') return reply.code(401).send({error: 'X-Tenant-Id is required'});
  const key = String(request.headers['idempotency-key'] ?? '');
  if (key === '') return reply.code(400).send({error: 'Idempotency-Key is required'});
  const windowS = body.window_s ?? 3600;
  if (!METRICS.includes(body.metric)) return reply.code(400).send({error: \`metric must be one of \${METRICS.join(', ')}\`});
  if (!Number.isInteger(windowS) || windowS < MIN_WINDOW_S || windowS > MAX_WINDOW_S) {
    return reply.code(400).send({error: \`window_s must be \${MIN_WINDOW_S}..\${MAX_WINDOW_S}\`});
  }
  if (!BASELINE_RE.test(body.baseline ?? '')) {
    return reply.code(400).send({error: 'baseline must be a frozen reference baseline:{model_version}:{yyyy-mm-dd}'});
  }
  if (!(await isPromoted(body.model_version))) {
    return reply.code(400).send({error: \`model version \${body.model_version} is not promoted\`});
  }
  const recorded = await monitorForKey(tenant, key);
  if (recorded !== null) return reply.code(200).send(recorded); // a retry answers the monitor the first attempt registered
  const monitor = await createMonitor({
    tenant,
    model_version: body.model_version,
    metric: body.metric,
    window_s: windowS,
    baseline: body.baseline,
    threshold: body.threshold ?? 0.2,
  });
  await rememberKey(tenant, key, monitor.monitor_id);
  return reply.code(201).send(monitor);
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"net/http"

	"drift/store" // store.CreateMonitor, MonitorForKey, RememberKey, IsPromoted
)

type monitorRequest struct {
	ModelVersion string  \`json:"model_version"\`
	Metric       string  \`json:"metric"\`
	WindowS      int64   \`json:"window_s"\`
	Baseline     string  \`json:"baseline"\`
	Threshold    float64 \`json:"threshold"\`
}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func registerMonitor(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	body := monitorRequest{WindowS: 3600, Threshold: 0.2}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(rw, "the body must be a JSON monitor", http.StatusBadRequest)
		return
	}
	monitor := store.CreateMonitor(r.Context(), store.Monitor{
		Tenant:       r.Header.Get("X-Tenant-Id"),
		ModelVersion: body.ModelVersion,
		Metric:       body.Metric,
		WindowS:      body.WindowS,
		Baseline:     body.Baseline,
		Threshold:    body.Threshold,
	})
	writeJSON(rw, http.StatusCreated, monitor)
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/monitors", registerMonitor)
}
`,
      solution: `package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"regexp"

	"drift/store" // store.CreateMonitor, MonitorForKey, RememberKey, IsPromoted
)

var metrics = map[string]bool{"input_distribution": true, "outcome_rate": true, "calibration": true}

const (
	minWindowS = 300
	maxWindowS = 86400
)

// baselineRe is a frozen, dated reference: baseline:{model_version}:{yyyy-mm-dd}.
var baselineRe = regexp.MustCompile("^baseline:[A-Za-z0-9._-]+:[0-9]{4}-[0-9]{2}-[0-9]{2}$")

type monitorRequest struct {
	ModelVersion string  \`json:"model_version"\`
	Metric       string  \`json:"metric"\`
	WindowS      int64   \`json:"window_s"\`
	Baseline     string  \`json:"baseline"\`
	Threshold    float64 \`json:"threshold"\`
}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func registerMonitor(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		http.Error(rw, "X-Tenant-Id is required", http.StatusUnauthorized)
		return
	}
	key := r.Header.Get("Idempotency-Key")
	if key == "" {
		http.Error(rw, "Idempotency-Key is required", http.StatusBadRequest)
		return
	}
	body := monitorRequest{WindowS: 3600, Threshold: 0.2}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(rw, "the body must be a JSON monitor", http.StatusBadRequest)
		return
	}
	if !metrics[body.Metric] {
		http.Error(rw, "metric must be input_distribution, outcome_rate or calibration", http.StatusBadRequest)
		return
	}
	if body.WindowS < minWindowS || body.WindowS > maxWindowS {
		http.Error(rw, fmt.Sprintf("window_s must be %d..%d", minWindowS, maxWindowS), http.StatusBadRequest)
		return
	}
	if !baselineRe.MatchString(body.Baseline) {
		http.Error(rw, "baseline must be a frozen reference baseline:{model_version}:{yyyy-mm-dd}", http.StatusBadRequest)
		return
	}
	if !store.IsPromoted(r.Context(), body.ModelVersion) {
		http.Error(rw, "model version "+body.ModelVersion+" is not promoted", http.StatusBadRequest)
		return
	}
	if recorded := store.MonitorForKey(r.Context(), tenant, key); recorded != nil {
		writeJSON(rw, http.StatusOK, recorded) // a retry answers the monitor the first attempt registered
		return
	}
	monitor := store.CreateMonitor(r.Context(), store.Monitor{
		Tenant:       tenant,
		ModelVersion: body.ModelVersion,
		Metric:       body.Metric,
		WindowS:      body.WindowS,
		Baseline:     body.Baseline,
		Threshold:    body.Threshold,
	})
	store.RememberKey(r.Context(), tenant, key, monitor.MonitorID)
	writeJSON(rw, http.StatusCreated, monitor)
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/monitors", registerMonitor)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import drift.Store // Store.createMonitor, monitorForKey, rememberKey, isPromoted

object Api {
  private def json(status: StatusCode, body: JsObject): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  /** The monitor a request body describes, for tenant (window_s defaults to 3600, threshold to 0.2). */
  private def monitorOf(tenant: String, raw: String): Store.Monitor = {
    val fields = raw.parseJson.asJsObject.fields
    def text(name: String): String = fields.get(name).collect { case JsString(s) => s }.getOrElse("")
    def number(name: String, default: BigDecimal): BigDecimal = fields.get(name).collect { case JsNumber(n) => n }.getOrElse(default)
    Store.Monitor("", tenant, text("model_version"), text("metric"), number("window_s", 3600).toLong, text("baseline"), number("threshold", 0.2).toDouble)
  }

  val route: Route = path("v1" / "monitors") {
    post {
      optionalHeaderValueByName("X-Tenant-Id") { tenant =>
        entity(as[String]) { raw =>
          // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
          val monitor = Store.createMonitor(monitorOf(tenant.getOrElse(""), raw))
          complete(json(StatusCodes.Created, Store.toJson(monitor)))
        }
      }
    }
  }
}
`,
      solution: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import drift.Store // Store.createMonitor, monitorForKey, rememberKey, isPromoted

object Api {
  val Metrics: Set[String] = Set("input_distribution", "outcome_rate", "calibration")
  val MinWindowS = 300L
  val MaxWindowS = 86400L
  /** A frozen, dated reference: baseline:{model_version}:{yyyy-mm-dd}. */
  val BaselineRe = "baseline:[A-Za-z0-9._-]+:[0-9]{4}-[0-9]{2}-[0-9]{2}"

  private def json(status: StatusCode, body: JsObject): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  /** The monitor a request body describes, for tenant (window_s defaults to 3600, threshold to 0.2). */
  private def monitorOf(tenant: String, raw: String): Store.Monitor = {
    val fields = raw.parseJson.asJsObject.fields
    def text(name: String): String = fields.get(name).collect { case JsString(s) => s }.getOrElse("")
    def number(name: String, default: BigDecimal): BigDecimal = fields.get(name).collect { case JsNumber(n) => n }.getOrElse(default)
    Store.Monitor("", tenant, text("model_version"), text("metric"), number("window_s", 3600).toLong, text("baseline"), number("threshold", 0.2).toDouble)
  }

  /** Why the requested monitor is refused, if it is. */
  private def refusal(m: Store.Monitor): Option[String] =
    if (!Metrics.contains(m.metric)) Some("metric must be input_distribution, outcome_rate or calibration")
    else if (m.windowS < MinWindowS || m.windowS > MaxWindowS) Some(s"window_s must be $MinWindowS..$MaxWindowS")
    else if (!m.baseline.matches(BaselineRe)) Some("baseline must be a frozen reference baseline:{model_version}:{yyyy-mm-dd}")
    else if (!Store.isPromoted(m.modelVersion)) Some(s"model version \${m.modelVersion} is not promoted")
    else None

  val route: Route = path("v1" / "monitors") {
    post {
      optionalHeaderValueByName("X-Tenant-Id") {
        case None | Some("") => complete(StatusCodes.Unauthorized -> "X-Tenant-Id is required")
        case Some(tenant) =>
          optionalHeaderValueByName("Idempotency-Key") {
            case None | Some("") => complete(StatusCodes.BadRequest -> "Idempotency-Key is required")
            case Some(key) =>
              entity(as[String]) { raw =>
                val requested = monitorOf(tenant, raw)
                refusal(requested) match {
                  case Some(reason) => complete(StatusCodes.BadRequest -> reason)
                  case None =>
                    Store.monitorForKey(tenant, key) match {
                      case Some(recorded) => complete(json(StatusCodes.OK, Store.toJson(recorded))) // a retry answers the first monitor
                      case None =>
                        val monitor = Store.createMonitor(requested)
                        Store.rememberKey(tenant, key, monitor.monitorId)
                        complete(json(StatusCodes.Created, Store.toJson(monitor)))
                    }
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
      starter: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <string>

#include "drift/store.h"  // store::createMonitor, monitorForKey, rememberKey, isPromoted

using json = nlohmann::json;

// The monitor a request body describes, for tenant (window_s defaults to 3600, threshold to 0.2).
store::Monitor monitorOf(const std::string& tenant, const json& body) {
  store::Monitor m;
  m.tenant = tenant;
  m.model_version = body.value("model_version", "");
  m.metric = body.value("metric", "");
  m.window_s = body.value("window_s", 3600L);
  m.baseline = body.value("baseline", "");
  m.threshold = body.value("threshold", 0.2);
  return m;
}

void register_monitor(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const store::Monitor monitor = store::createMonitor(monitorOf(req.get_header_value("X-Tenant-Id"), json::parse(req.body)));
  res.status = 201;
  res.set_content(store::toJson(monitor).dump(), "application/json");
}

void register_routes(httplib::Server& svr) { svr.Post("/v1/monitors", register_monitor); }
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <regex>
#include <set>
#include <string>

#include "drift/store.h"  // store::createMonitor, monitorForKey, rememberKey, isPromoted

using json = nlohmann::json;

const std::set<std::string> kMetrics = {"input_distribution", "outcome_rate", "calibration"};
constexpr long kMinWindowS = 300;
constexpr long kMaxWindowS = 86400;
// A frozen, dated reference: baseline:{model_version}:{yyyy-mm-dd}.
const std::regex kBaselineRe("baseline:[A-Za-z0-9._-]+:[0-9]{4}-[0-9]{2}-[0-9]{2}");

// The monitor a request body describes, for tenant (window_s defaults to 3600, threshold to 0.2).
store::Monitor monitorOf(const std::string& tenant, const json& body) {
  store::Monitor m;
  m.tenant = tenant;
  m.model_version = body.value("model_version", "");
  m.metric = body.value("metric", "");
  m.window_s = body.value("window_s", 3600L);
  m.baseline = body.value("baseline", "");
  m.threshold = body.value("threshold", 0.2);
  return m;
}

void fail(httplib::Response& res, int status, const std::string& reason) {
  res.status = status;
  res.set_content(json{{"error", reason}}.dump(), "application/json");
}

void register_monitor(const httplib::Request& req, httplib::Response& res) {
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) return fail(res, 401, "X-Tenant-Id is required");
  const std::string key = req.get_header_value("Idempotency-Key");
  if (key.empty()) return fail(res, 400, "Idempotency-Key is required");
  const store::Monitor requested = monitorOf(tenant, json::parse(req.body));
  if (!kMetrics.count(requested.metric)) return fail(res, 400, "metric must be input_distribution, outcome_rate or calibration");
  if (requested.window_s < kMinWindowS || requested.window_s > kMaxWindowS) return fail(res, 400, "window_s must be 300..86400");
  if (!std::regex_match(requested.baseline, kBaselineRe)) {
    return fail(res, 400, "baseline must be a frozen reference baseline:{model_version}:{yyyy-mm-dd}");
  }
  if (!store::isPromoted(requested.model_version)) return fail(res, 400, "model version " + requested.model_version + " is not promoted");
  if (const auto recorded = store::monitorForKey(tenant, key)) {
    res.set_content(store::toJson(*recorded).dump(), "application/json");  // a retry answers the first monitor
    return;
  }
  const store::Monitor monitor = store::createMonitor(requested);
  store::rememberKey(tenant, key, monitor.monitor_id);
  res.status = 201;
  res.set_content(store::toJson(monitor).dump(), "application/json");
}

void register_routes(httplib::Server& svr) { svr.Post("/v1/monitors", register_monitor); }
`,
    },
  },
  harness: {
    python: `from drift import store

GOOD = {"model_version": "v3", "metric": "input_distribution", "window_s": 3600, "baseline": "baseline:v3:2026-10-01", "threshold": 0.2}


def _api(ctx):
    ctx.redis.sadd("registry:promoted", "v3")
    return ctx.client(ctx.load("api").app)


def _headers(tenant="t1", key="k-1"):
    headers = {"X-Tenant-Id": tenant, "Idempotency-Key": key}
    return {name: value for name, value in headers.items() if value}


def _monitors(ctx):
    return sorted(ctx.redis.keys("monitor:m-*"))


async def _refused(c, ctx, body, headers, status, why):
    r = await c.post("/v1/monitors", json=body, headers=headers)
    assert r.status_code == status, f"{why} answered {r.status_code} {r.text}, expected {status}"
    assert _monitors(ctx) == [], f"{why} was refused but the store holds {_monitors(ctx)}: a refused registration must not create a monitor"


async def check_route(ctx):
    async with _api(ctx) as c:
        r = await c.post("/v1/monitors", json=GOOD, headers=_headers())
    assert r.status_code == 201, f"POST /v1/monitors answered {r.status_code}: {r.text}"
    body = r.json()
    for name, value in GOOD.items():
        assert body.get(name) == value, f"the response's {name} is {body.get(name)!r}, expected {value!r}: {body}"
    stored = store.get_monitor(body.get("monitor_id", ""))
    assert stored is not None and stored["tenant"] == "t1", f"monitor {body.get('monitor_id')!r} is not in the store for tenant t1: {stored}"


async def check_metric_window(ctx):
    async with _api(ctx) as c:
        await _refused(c, ctx, GOOD, _headers(tenant=""), 401, "a registration without X-Tenant-Id")
        await _refused(c, ctx, {**GOOD, "metric": "accuracy"}, _headers(key="k-2"), 400, "the metric accuracy (not in METRICS)")
        await _refused(c, ctx, {**GOOD, "window_s": 60}, _headers(key="k-3"), 400, "a 60 s window (below MIN_WINDOW_S = 300)")
        await _refused(c, ctx, {**GOOD, "window_s": 172_800}, _headers(key="k-4"), 400, "a two-day window (above MAX_WINDOW_S = 86400)")
        bare = {name: value for name, value in GOOD.items() if name != "window_s"}
        r = await c.post("/v1/monitors", json=bare, headers=_headers(key="k-5"))
    assert r.status_code == 201 and r.json().get("window_s") == 3600, f"a registration without window_s answered {r.status_code} {r.text}, expected 201 with the default window 3600"


async def check_promoted(ctx):
    async with _api(ctx) as c:
        await _refused(c, ctx, {**GOOD, "model_version": "v9", "baseline": "baseline:v9:2026-10-01"}, _headers(), 400, "a monitor on v9, which the registry never promoted,")
        r = await c.post("/v1/monitors", json=GOOD, headers=_headers(key="k-2"))
    assert r.status_code == 201, f"a monitor on the promoted v3 answered {r.status_code}: {r.text}"


async def check_baseline(ctx):
    async with _api(ctx) as c:
        await _refused(c, ctx, {**GOOD, "baseline": "live:v3"}, _headers(), 400, "the baseline live:v3 (the traffic the monitor watches)")
        await _refused(c, ctx, {**GOOD, "baseline": "baseline:v3:latest"}, _headers(key="k-2"), 400, "the baseline baseline:v3:latest (a moving reference)")
        r = await c.post("/v1/monitors", json=GOOD, headers=_headers(key="k-3"))
    assert r.status_code == 201, f"the frozen baseline baseline:v3:2026-10-01 answered {r.status_code}: {r.text}"


async def check_idempotency(ctx):
    async with _api(ctx) as c:
        await _refused(c, ctx, GOOD, _headers(key=""), 400, "a registration without Idempotency-Key")
        first = await c.post("/v1/monitors", json=GOOD, headers=_headers(key="k-1"))
        assert first.status_code == 201, f"the first registration answered {first.status_code}: {first.text}"
        replay = await c.post("/v1/monitors", json=GOOD, headers=_headers(key="k-1"))
        assert replay.status_code in (200, 201) and replay.json().get("monitor_id") == first.json().get("monitor_id"), f"a retry with the same Idempotency-Key answered {replay.status_code} {replay.text}, expected the first monitor {first.json().get('monitor_id')}"
        assert len(_monitors(ctx)) == 1, f"one registration and its retry left {_monitors(ctx)}: the retry registered a second monitor, which pages a second time"
        other = await c.post("/v1/monitors", json=GOOD, headers=_headers(tenant="t2", key="k-1"))
    assert other.status_code == 201 and other.json().get("monitor_id") != first.json().get("monitor_id"), f"tenant t2 using the key k-1 got {other.status_code} {other.text}: keys are scoped by tenant, so it is a new monitor"
`,
    typescript: `const GOOD = {model_version: 'v3', metric: 'input_distribution', window_s: 3600, baseline: 'baseline:v3:2026-10-01', threshold: 0.2};

function api(ctx) {
  ctx.redis.sadd('registry:promoted', 'v3');
  return {c: ctx.client(ctx.load('api').app), store: ctx.load('/support/drift/store.ts')};
}

const headers = (tenant = 't1', key = 'k-1'): Record<string, string> =>
  Object.fromEntries(Object.entries({'X-Tenant-Id': tenant, 'Idempotency-Key': key}).filter(([, value]) => value !== ''));

const monitors = (ctx): string[] => (ctx.redis.keys('monitor:m-*') as string[]).sort();

async function refused(c, ctx, body, h, status: number, why: string): Promise<void> {
  const r = await c.post('/v1/monitors', {json: body, headers: h});
  assert.equal(r.status, status, \`\${why} answered \${r.status} \${r.text}, expected \${status}\`);
  assert.deepStrictEqual(monitors(ctx), [], \`\${why} was refused but the store holds \${JSON.stringify(monitors(ctx))}: a refused registration must not create a monitor\`);
}

export async function check_route(ctx) {
  const {c, store} = api(ctx);
  const r = await c.post('/v1/monitors', {json: GOOD, headers: headers()});
  assert.equal(r.status, 201, \`POST /v1/monitors answered \${r.status}: \${r.text}\`);
  const body = r.json();
  for (const [name, value] of Object.entries(GOOD)) assert.equal(body[name], value, \`the response's \${name} is \${JSON.stringify(body[name])}, expected \${JSON.stringify(value)}: \${r.text}\`);
  const stored = await store.getMonitor(body.monitor_id ?? '');
  assert(stored !== null && stored.tenant === 't1', \`monitor \${JSON.stringify(body.monitor_id)} is not in the store for tenant t1: \${JSON.stringify(stored)}\`);
}

export async function check_metric_window(ctx) {
  const {c} = api(ctx);
  await refused(c, ctx, GOOD, headers(''), 401, 'a registration without X-Tenant-Id');
  await refused(c, ctx, {...GOOD, metric: 'accuracy'}, headers('t1', 'k-2'), 400, 'the metric accuracy (not in METRICS)');
  await refused(c, ctx, {...GOOD, window_s: 60}, headers('t1', 'k-3'), 400, 'a 60 s window (below MIN_WINDOW_S = 300)');
  await refused(c, ctx, {...GOOD, window_s: 172_800}, headers('t1', 'k-4'), 400, 'a two-day window (above MAX_WINDOW_S = 86400)');
  const {window_s: _omitted, ...bare} = GOOD;
  const r = await c.post('/v1/monitors', {json: bare, headers: headers('t1', 'k-5')});
  assert(r.status === 201 && r.json().window_s === 3600, \`a registration without window_s answered \${r.status} \${r.text}, expected 201 with the default window 3600\`);
}

export async function check_promoted(ctx) {
  const {c} = api(ctx);
  await refused(c, ctx, {...GOOD, model_version: 'v9', baseline: 'baseline:v9:2026-10-01'}, headers(), 400, 'a monitor on v9, which the registry never promoted,');
  const r = await c.post('/v1/monitors', {json: GOOD, headers: headers('t1', 'k-2')});
  assert.equal(r.status, 201, \`a monitor on the promoted v3 answered \${r.status}: \${r.text}\`);
}

export async function check_baseline(ctx) {
  const {c} = api(ctx);
  await refused(c, ctx, {...GOOD, baseline: 'live:v3'}, headers(), 400, 'the baseline live:v3 (the traffic the monitor watches)');
  await refused(c, ctx, {...GOOD, baseline: 'baseline:v3:latest'}, headers('t1', 'k-2'), 400, 'the baseline baseline:v3:latest (a moving reference)');
  const r = await c.post('/v1/monitors', {json: GOOD, headers: headers('t1', 'k-3')});
  assert.equal(r.status, 201, \`the frozen baseline baseline:v3:2026-10-01 answered \${r.status}: \${r.text}\`);
}

export async function check_idempotency(ctx) {
  const {c} = api(ctx);
  await refused(c, ctx, GOOD, headers('t1', ''), 400, 'a registration without Idempotency-Key');
  const first = await c.post('/v1/monitors', {json: GOOD, headers: headers('t1', 'k-1')});
  assert.equal(first.status, 201, \`the first registration answered \${first.status}: \${first.text}\`);
  const replay = await c.post('/v1/monitors', {json: GOOD, headers: headers('t1', 'k-1')});
  assert((replay.status === 200 || replay.status === 201) && replay.json().monitor_id === first.json().monitor_id, \`a retry with the same Idempotency-Key answered \${replay.status} \${replay.text}, expected the first monitor \${first.json().monitor_id}\`);
  assert.equal(monitors(ctx).length, 1, \`one registration and its retry left \${JSON.stringify(monitors(ctx))}: the retry registered a second monitor, which pages a second time\`);
  const other = await c.post('/v1/monitors', {json: GOOD, headers: headers('t2', 'k-1')});
  assert(other.status === 201 && other.json().monitor_id !== first.json().monitor_id, \`tenant t2 using the key k-1 got \${other.status} \${other.text}: keys are scoped by tenant, so it is a new monitor\`);
}
`,
    go: `package main

import (
	"context"
	"net/http"

	"drift/store"

	"leetbuild/harness"
)

var good = map[string]any{"model_version": "v3", "metric": "input_distribution", "window_s": 3600, "baseline": "baseline:v3:2026-10-01", "threshold": 0.2}

func api(ctx *harness.Ctx) *harness.HTTP {
	ctx.Redis.Do("SADD", "registry:promoted", "v3")
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

func with(changes map[string]any, drop string) map[string]any {
	out := map[string]any{}
	for k, v := range good {
		if k != drop {
			out[k] = v
		}
	}
	for k, v := range changes {
		out[k] = v
	}
	return out
}

func headers(tenant, key string) []string {
	var h []string
	if tenant != "" {
		h = append(h, "X-Tenant-Id", tenant)
	}
	if key != "" {
		h = append(h, "Idempotency-Key", key)
	}
	return h
}

func post(c *harness.HTTP, body map[string]any, h []string) *harness.Response {
	return c.Post("/v1/monitors", body, h...)
}

func field(r *harness.Response, name string) any {
	body, _ := r.JSON().(map[string]any)
	return body[name]
}

func refused(ctx *harness.Ctx, c *harness.HTTP, body map[string]any, h []string, status int, why string) {
	r := post(c, body, h)
	ctx.Equal(r.Status, status, "%s answered %s", why, r.Text())
	ctx.Equal(len(ctx.Redis.Keys("monitor:m-*")), 0, "%s was refused, so it must not create a monitor; monitors in the store", why)
}

func CheckRoute(ctx *harness.Ctx) {
	c := api(ctx)
	r := post(c, good, headers("t1", "k-1"))
	ctx.Equal(r.Status, 201, "POST /v1/monitors (%s)", r.Text())
	for name, value := range good {
		ctx.Equal(field(r, name), value, "the response's %s (%s)", name, r.Text())
	}
	id, _ := field(r, "monitor_id").(string)
	stored := store.GetMonitor(context.Background(), id)
	ctx.Assert(stored != nil && stored.Tenant == "t1", "monitor %q is not in the store for tenant t1: %+v", id, stored)
}

func CheckMetricWindow(ctx *harness.Ctx) {
	c := api(ctx)
	refused(ctx, c, good, headers("", "k-1"), 401, "a registration without X-Tenant-Id")
	refused(ctx, c, with(map[string]any{"metric": "accuracy"}, ""), headers("t1", "k-2"), 400, "the metric accuracy (not in metrics)")
	refused(ctx, c, with(map[string]any{"window_s": 60}, ""), headers("t1", "k-3"), 400, "a 60 s window (below minWindowS = 300)")
	refused(ctx, c, with(map[string]any{"window_s": 172800}, ""), headers("t1", "k-4"), 400, "a two-day window (above maxWindowS = 86400)")
	r := post(c, with(nil, "window_s"), headers("t1", "k-5"))
	ctx.Assert(r.Status == 201 && field(r, "window_s") == float64(3600), "a registration without window_s answered %d %s, expected 201 with the default window 3600", r.Status, r.Text())
}

func CheckPromoted(ctx *harness.Ctx) {
	c := api(ctx)
	refused(ctx, c, with(map[string]any{"model_version": "v9", "baseline": "baseline:v9:2026-10-01"}, ""), headers("t1", "k-1"), 400, "a monitor on v9, which the registry never promoted,")
	r := post(c, good, headers("t1", "k-2"))
	ctx.Equal(r.Status, 201, "a monitor on the promoted v3 (%s)", r.Text())
}

func CheckBaseline(ctx *harness.Ctx) {
	c := api(ctx)
	refused(ctx, c, with(map[string]any{"baseline": "live:v3"}, ""), headers("t1", "k-1"), 400, "the baseline live:v3 (the traffic the monitor watches)")
	refused(ctx, c, with(map[string]any{"baseline": "baseline:v3:latest"}, ""), headers("t1", "k-2"), 400, "the baseline baseline:v3:latest (a moving reference)")
	r := post(c, good, headers("t1", "k-3"))
	ctx.Equal(r.Status, 201, "the frozen baseline baseline:v3:2026-10-01 (%s)", r.Text())
}

func CheckIdempotency(ctx *harness.Ctx) {
	c := api(ctx)
	refused(ctx, c, good, headers("t1", ""), 400, "a registration without Idempotency-Key")
	first := post(c, good, headers("t1", "k-1"))
	ctx.Equal(first.Status, 201, "the first registration (%s)", first.Text())
	replay := post(c, good, headers("t1", "k-1"))
	ctx.Assert((replay.Status == 200 || replay.Status == 201) && field(replay, "monitor_id") == field(first, "monitor_id"), "a retry with the same Idempotency-Key answered %d %s, expected the first monitor %v", replay.Status, replay.Text(), field(first, "monitor_id"))
	ctx.Equal(len(ctx.Redis.Keys("monitor:m-*")), 1, "one registration and its retry must leave one monitor (a second one pages a second time); monitors in the store")
	other := post(c, good, headers("t2", "k-1"))
	ctx.Assert(other.Status == 201 && field(other, "monitor_id") != field(first, "monitor_id"), "tenant t2 using the key k-1 got %d %s: keys are scoped by tenant, so it is a new monitor", other.Status, other.Text())
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <string>
#include <vector>

#include "drift/store.h"

using json = nlohmann::json;

namespace {

const json kGood = {{"model_version", "v3"}, {"metric", "input_distribution"}, {"window_s", 3600}, {"baseline", "baseline:v3:2026-10-01"}, {"threshold", 0.2}};

harness::HTTP api(harness::Ctx& ctx) {
  ctx.Redis.Do("SADD", "registry:promoted", "v3");
  static httplib::Server* svr = nullptr;
  delete svr;
  svr = new httplib::Server;
  register_routes(*svr);
  return ctx.HTTP(*svr);
}

json with(const json& changes, const std::string& drop = "") {
  json out = kGood;
  if (!drop.empty()) out.erase(drop);
  for (const auto& [k, v] : changes.items()) out[k] = v;
  return out;
}

harness::Response post(harness::HTTP& c, const json& body, const std::string& tenant, const std::string& key) {
  if (tenant.empty()) return c.Post("/v1/monitors", body.dump(), "Content-Type", "application/json", "Idempotency-Key", key);
  if (key.empty()) return c.Post("/v1/monitors", body.dump(), "Content-Type", "application/json", "X-Tenant-Id", tenant);
  return c.Post("/v1/monitors", body.dump(), "Content-Type", "application/json", "X-Tenant-Id", tenant, "Idempotency-Key", key);
}

json bodyOf(const harness::Response& r) {
  const json body = json::parse(r.Text(), nullptr, false);
  return body.is_object() ? body : json::object();
}

void refused(harness::Ctx& ctx, harness::HTTP& c, const json& body, const std::string& tenant, const std::string& key, int status, const std::string& why) {
  const auto r = post(c, body, tenant, key);
  ctx.Equal(r.Status, status, "%s answered %s", why, r.Text());
  ctx.Equal(ctx.Redis.Keys("monitor:m-*").size(), 0, "%s was refused, so it must not create a monitor; monitors in the store", why);
}

}  // namespace

void CheckRoute(harness::Ctx& ctx) {
  auto c = api(ctx);
  const auto r = post(c, kGood, "t1", "k-1");
  ctx.Equal(r.Status, 201, "POST /v1/monitors (%s)", r.Text());
  const json body = bodyOf(r);
  for (const auto& [name, value] : kGood.items()) {
    ctx.Assert(body.contains(name) && body[name] == value, "the response's %s is %s, expected %s", name, body.value(name, json()).dump(), value.dump());
  }
  const auto stored = store::getMonitor(body.value("monitor_id", ""));
  ctx.Assert(stored && stored->tenant == "t1", "monitor %q is not in the store for tenant t1", body.value("monitor_id", ""));
}

void CheckMetricWindow(harness::Ctx& ctx) {
  auto c = api(ctx);
  refused(ctx, c, kGood, "", "k-1", 401, "a registration without X-Tenant-Id");
  refused(ctx, c, with({{"metric", "accuracy"}}), "t1", "k-2", 400, "the metric accuracy (not in kMetrics)");
  refused(ctx, c, with({{"window_s", 60}}), "t1", "k-3", 400, "a 60 s window (below kMinWindowS = 300)");
  refused(ctx, c, with({{"window_s", 172800}}), "t1", "k-4", 400, "a two-day window (above kMaxWindowS = 86400)");
  const auto r = post(c, with(json::object(), "window_s"), "t1", "k-5");
  ctx.Assert(r.Status == 201 && bodyOf(r).value("window_s", 0L) == 3600, "a registration without window_s answered %d %s, expected 201 with the default window 3600", r.Status, r.Text());
}

void CheckPromoted(harness::Ctx& ctx) {
  auto c = api(ctx);
  refused(ctx, c, with({{"model_version", "v9"}, {"baseline", "baseline:v9:2026-10-01"}}), "t1", "k-1", 400, "a monitor on v9, which the registry never promoted,");
  const auto r = post(c, kGood, "t1", "k-2");
  ctx.Equal(r.Status, 201, "a monitor on the promoted v3 (%s)", r.Text());
}

void CheckBaseline(harness::Ctx& ctx) {
  auto c = api(ctx);
  refused(ctx, c, with({{"baseline", "live:v3"}}), "t1", "k-1", 400, "the baseline live:v3 (the traffic the monitor watches)");
  refused(ctx, c, with({{"baseline", "baseline:v3:latest"}}), "t1", "k-2", 400, "the baseline baseline:v3:latest (a moving reference)");
  const auto r = post(c, kGood, "t1", "k-3");
  ctx.Equal(r.Status, 201, "the frozen baseline baseline:v3:2026-10-01 (%s)", r.Text());
}

void CheckIdempotency(harness::Ctx& ctx) {
  auto c = api(ctx);
  refused(ctx, c, kGood, "t1", "", 400, "a registration without Idempotency-Key");
  const auto first = post(c, kGood, "t1", "k-1");
  ctx.Equal(first.Status, 201, "the first registration (%s)", first.Text());
  const std::string id = bodyOf(first).value("monitor_id", "");
  const auto replay = post(c, kGood, "t1", "k-1");
  ctx.Assert((replay.Status == 200 || replay.Status == 201) && bodyOf(replay).value("monitor_id", "") == id, "a retry with the same Idempotency-Key answered %d %s, expected the first monitor %s", replay.Status, replay.Text(), id);
  ctx.Equal(ctx.Redis.Keys("monitor:m-*").size(), 1, "one registration and its retry must leave one monitor (a second one pages a second time); monitors in the store");
  const auto other = post(c, kGood, "t2", "k-1");
  ctx.Assert(other.Status == 201 && bodyOf(other).value("monitor_id", "") != id, "tenant t2 using the key k-1 got %d %s: keys are scoped by tenant, so it is a new monitor", other.Status, other.Text());
}
`,
  },
  hints: [
    'Register a monitor on the metric `accuracy`, another on the unpromoted `v9`, then retry one registration: every call answers 201, and the retry shows up as a second monitor with its own id.',
    'The handler hands the body to `store.create_monitor` without reading it: nothing compares the metric and window with the allowed values, asks the registry about the version, matches the baseline or looks at the `Idempotency-Key`.',
    'Answer 401 without a tenant and 400 without a key; 400 for a metric outside `METRICS`, a window outside 300..86400, a baseline `BASELINE_RE` refuses or a version `store.is_promoted` denies; then replay `store.monitor_for_key`, or create and `remember_key`.',
  ],
  debrief: `Every guard returns before the monitor exists, so a refused registration leaves nothing behind that could page. The order follows cost: headers and body fields are free, the registry is one Redis read, and only a request that passed them all touches the idempotency index. The key is scoped by tenant because two tenants may pick the same key. The baseline rule is a format on purpose: a dated reference names a sample that can no longer change, which is what lets the monitor fire at all. Production registries claim the key with SET NX before creating, so two retries racing each other cannot both miss the index, and re-freeze baselines when a new version is promoted.`,
};
