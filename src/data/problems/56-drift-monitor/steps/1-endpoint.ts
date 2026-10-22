import type {Step} from '@/lib/types';

export const monitorEndpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/monitors: monitors that observe something real',
  concept: 'http',
  file: 'api',
  focus: ['client', 'monitor', 'registry'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it registers the route, parses
the body and returns a monitor id. It compiles, the demo registers one monitor against a promoted
version, and the three ways a monitor can be born useless are all invisible until drift fails to
fire. Review it like the service owner, fix it, and prove the fix with the checks below.

Implement \`POST /v1/monitors\` with body
\`{"model_version": "…", "metric": "input_distribution", "window_s": 3600, "baseline": "…"}\`.

- The tenant comes from the authenticated \`X-Tenant-Id\` header; a missing tenant is **401**.
- \`metric\` is one of \`input_distribution\`, \`outcome_rate\` or \`calibration\` (**400** otherwise).
- \`window_s\` is an integer from **300** to **86400** seconds (**400** otherwise) and defaults to 3600.
- \`model_version\` must be **promoted** in the model registry (**400** otherwise). A monitor on an
  unpromoted version watches traffic that does not exist yet, and its alerts can never be attributed
  to a release.
- \`baseline\` must be a **resolvable** reference in the form \`baseline:{model_version}:{yyyy-mm-dd}\`
  (**400** otherwise), and it must not point at **live traffic**: the draft lets the baseline be the
  very traffic the monitor is meant to watch, so it compares the signal with itself and drift can
  never fire.
- \`Idempotency-Key\` is required (**400** when missing). A retry with the same \`(tenant, key)\`
  returns the **original** monitor instead of registering a second one; the draft has no key, so a
  client retry multiplies monitors and pages twice.
- The response carries the monitor id, tenant, model version, metric, window and baseline reference.
- Log the registration with tenant, monitor id and metric — never the whole body.

**Failure mode the checks target.** A monitor is only as good as what it observes and what it is
compared against. Registering against an unpromoted version, accepting the live traffic itself as the
baseline, and duplicating on retry are three quiet ways to ship a detector that never fires or fires
twice — and none of them shows up in a happy-path demo.`,
  sequence: {
    participants: ['Client', 'Drift Monitor', 'model registry', 'monitor store'],
    messages: [
      {from: 'Client', to: 'Drift Monitor', label: 'POST /v1/monitors · X-Tenant-Id · Idempotency-Key', kind: 'sync'},
      {from: 'Drift Monitor', to: 'Drift Monitor', label: 'validate metric · window · baseline form', kind: 'sync'},
      {from: 'Drift Monitor', to: 'model registry', label: 'is_promoted(model_version)', kind: 'sync'},
      {from: 'model registry', to: 'Drift Monitor', label: 'promoted / not promoted', kind: 'reply'},
      {from: 'Drift Monitor', to: 'monitor store', label: 'get(tenant, idem_key)', kind: 'sync'},
      {from: 'monitor store', to: 'Drift Monitor', label: 'stored monitor / none', kind: 'reply'},
      {from: 'Drift Monitor', to: 'monitor store', label: 'put(tenant, idem_key, monitor)', kind: 'async'},
      {from: 'Drift Monitor', to: 'Client', label: '201 {monitor_id, metric, window_s, baseline}', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Handles POST /v1/monitors',
      detail: 'Register the registration route on `POST /v1/monitors`.',
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
      title: 'Whitelists the metric, bounds the window and requires a tenant',
      detail:
        'The metric is checked against `input_distribution`/`outcome_rate`/`calibration` and `window_s` against 300..86400 (**400**), and a missing `X-Tenant-Id` is **401**. The draft accepts any metric and any window for anybody.',
      match: {
        python: {all: [/METRICS/, /MIN_WINDOW_S/, /MAX_WINDOW_S/, /status_code\s*=\s*401/]},
        typescript: {all: [/METRICS/, /MIN_WINDOW_S/, /MAX_WINDOW_S/, /code\(\s*401\s*\)/]},
        go: {all: [/metricsSet/, /minWindowS/, /maxWindowS/, /StatusUnauthorized/]},
        scala: {all: [/\bMetrics\b/, /MinWindowS/, /MaxWindowS/, /StatusCodes\.Unauthorized/]},
        cpp: {all: [/kMetrics/, /kMinWindowS/, /kMaxWindowS/, /\b401\b/]},
      },
    },
    {
      id: 'promoted',
      title: 'Refuses a monitor on an unpromoted model version',
      detail:
        'The model version is resolved against the registry and an unpromoted version is **400**, before the monitor is stored. The draft registers against any version it is handed.',
      match: {
        python: {all: [/registry\.is_promoted\(/, /status_code\s*=\s*400/]},
        typescript: {all: [/registry\.isPromoted\(/, /code\(\s*400\s*\)/]},
        go: {all: [/registry\.IsPromoted\(/, /StatusBadRequest/]},
        scala: {all: [/registry\.isPromoted\(/, /StatusCodes\.BadRequest/]},
        cpp: {all: [/registry\.isPromoted\(/, /\b400\b/]},
      },
    },
    {
      id: 'baseline',
      title: 'Rejects a baseline that is live traffic',
      detail:
        'The reference must match the frozen form `baseline:{version}:{date}` and a reference that points at live traffic is **400**. The draft accepts the live traffic it is meant to watch as the baseline, so the reference drifts with the signal and nothing can ever fire.',
      match: {
        python: {all: [/BASELINE_RE\.match\(/, /is_live_baseline\(/, /status_code\s*=\s*400/]},
        typescript: {all: [/BASELINE_RE\.test\(/, /isLiveBaseline\(/, /code\(\s*400\s*\)/]},
        go: {all: [/baselineRe\.MatchString\(/, /isLiveBaseline\(/, /StatusBadRequest/]},
        scala: {all: [/BaselineRe\.matches\(/, /isLiveBaseline\(/, /StatusCodes\.BadRequest/]},
        cpp: {all: [/std::regex_match\(/, /isLiveBaseline\(/, /\b400\b/]},
      },
    },
    {
      id: 'idempotency',
      title: 'Returns the original monitor for a replayed registration',
      detail:
        '`Idempotency-Key` is required and the monitor is stored under `(tenant, key)`; a replay returns the stored monitor instead of registering a second one. The draft ignores the header and registers a duplicate every time a client retries.',
      match: {
        python: {all: [/Idempotency-Key/, /store\.get\(/, /store\.put\(/]},
        typescript: {all: [/idempotency-key/, /store\.get\(/, /store\.put\(/]},
        go: {all: [/Idempotency-Key/, /store\.Get\(/, /store\.Put\(/]},
        scala: {all: [/Idempotency-Key/, /store\.get\(/, /store\.put\(/]},
        cpp: {all: [/Idempotency-Key/, /store\.get\(/, /store\.put\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import logging
import uuid

from fastapi import FastAPI, Header
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()
logger = logging.getLogger("drift-monitor")

REGISTERED = []


class MonitorRequest(BaseModel):
    model_version: str
    metric: str
    window_s: int = 3600
    baseline: str


@app.post("/v1/monitors")
def create_monitor(
    body: MonitorRequest,
    tenant: str | None = Header(default=None, alias="X-Tenant-Id"),
) -> JSONResponse:
    # TODO: this draft registers a monitor against any model version, lets the baseline be the live
    # traffic the monitor is meant to watch, and ignores Idempotency-Key, so a client retry
    # registers a second monitor. Review all three.
    monitor = {
        "monitor_id": str(uuid.uuid4()),
        "tenant": tenant,
        "model_version": body.model_version,
        "metric": body.metric,
        "window_s": body.window_s,
        "baseline": body.baseline,
    }
    REGISTERED.append(monitor)
    logger.info("monitor registered tenant=%s monitor=%s", tenant, monitor["monitor_id"])
    return JSONResponse(monitor, status_code=201)
`,
      solution: `import logging
import re
import uuid

from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()
logger = logging.getLogger("drift-monitor")

METRICS = {"input_distribution", "outcome_rate", "calibration"}
MIN_WINDOW_S = 300
MAX_WINDOW_S = 86_400
DEFAULT_WINDOW_S = 3600
BASELINE_RE = re.compile(r"^baseline:[a-z0-9._-]+:[0-9]{4}-[0-9]{2}-[0-9]{2}$")


class MonitorRequest(BaseModel):
    model_version: str
    metric: str
    window_s: int = DEFAULT_WINDOW_S
    baseline: str


class Registry:
    def is_promoted(self, model_version: str) -> bool:
        """Whether this model version is promoted in the registry."""
        raise NotImplementedError


class MonitorStore:
    def get(self, tenant: str, idem_key: str) -> dict | None:
        """The monitor stored for (tenant, idem_key), if any."""
        raise NotImplementedError

    def put(self, tenant: str, idem_key: str, monitor: dict) -> None:
        """Store the monitor under (tenant, idem_key)."""
        raise NotImplementedError


registry = Registry()
store = MonitorStore()


def is_live_baseline(reference: str) -> bool:
    segment = reference.split(":")[1] if ":" in reference else ""
    return segment in {"live", "traffic"}


@app.post("/v1/monitors")
def create_monitor(
    body: MonitorRequest,
    tenant: str | None = Header(default=None, alias="X-Tenant-Id"),
    idem_key: str | None = Header(default=None, alias="Idempotency-Key"),
) -> JSONResponse:
    if tenant is None or tenant == "":
        raise HTTPException(status_code=401, detail="missing X-Tenant-Id")
    if idem_key is None or idem_key == "":
        raise HTTPException(status_code=400, detail="Idempotency-Key is required")
    if body.metric not in METRICS:
        raise HTTPException(status_code=400, detail="unknown metric")
    if not MIN_WINDOW_S <= body.window_s <= MAX_WINDOW_S:
        raise HTTPException(status_code=400, detail="window_s must be 300..86400")
    if not registry.is_promoted(body.model_version):
        raise HTTPException(status_code=400, detail="model version is not promoted")
    if not BASELINE_RE.match(body.baseline or ""):
        raise HTTPException(status_code=400, detail="baseline reference is not resolvable")
    if is_live_baseline(body.baseline):
        raise HTTPException(status_code=400, detail="baseline must be frozen traffic, not live")

    stored = store.get(tenant, idem_key)
    if stored is not None:
        return JSONResponse(stored, status_code=200)

    monitor = {
        "monitor_id": str(uuid.uuid4()),
        "tenant": tenant,
        "model_version": body.model_version,
        "metric": body.metric,
        "window_s": body.window_s,
        "baseline": body.baseline,
    }
    store.put(tenant, idem_key, monitor)
    logger.info("monitor registered tenant=%s monitor=%s metric=%s", tenant, monitor["monitor_id"], body.metric)
    return JSONResponse(monitor, status_code=201)
`,
    },
    typescript: {
      starter: `/** POST /v1/monitors: a model-generated draft that registers whatever it is handed. */
import {randomUUID} from 'node:crypto';

import Fastify from 'fastify';

export const app = Fastify();

const REGISTERED: unknown[] = [];

interface MonitorBody {
  model_version: string;
  metric: string;
  window_s?: number;
  baseline: string;
}

app.post('/v1/monitors', async (request, reply) => {
  // TODO: this draft registers a monitor against any model version, lets the baseline be the live
  // traffic the monitor is meant to watch, and ignores Idempotency-Key, so a client retry
  // registers a second monitor. Review all three.
  const tenant = request.headers['x-tenant-id'] as string;
  const body = request.body as MonitorBody;
  const monitor = {
    monitor_id: randomUUID(),
    tenant,
    model_version: body.model_version,
    metric: body.metric,
    window_s: body.window_s ?? 3600,
    baseline: body.baseline,
  };
  REGISTERED.push(monitor);
  request.log.info({tenant, monitor: monitor.monitor_id}, 'monitor registered');
  return reply.code(201).send(monitor);
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** POST /v1/monitors: register a monitor that actually observes something. */
import {randomUUID} from 'node:crypto';

import Fastify from 'fastify';

import {registry, store} from './store';

export const app = Fastify();

const METRICS: Record<string, true> = {input_distribution: true, outcome_rate: true, calibration: true};
const MIN_WINDOW_S = 300;
const MAX_WINDOW_S = 86_400;
const DEFAULT_WINDOW_S = 3600;
const BASELINE_RE = /^baseline:[a-z0-9._-]+:[0-9]{4}-[0-9]{2}-[0-9]{2}$/;

interface MonitorBody {
  model_version: string;
  metric: string;
  window_s?: number;
  baseline: string;
}

interface Monitor {
  monitor_id: string;
  tenant: string;
  model_version: string;
  metric: string;
  window_s: number;
  baseline: string;
}

function isLiveBaseline(reference: string): boolean {
  const segment = reference.split(':')[1] ?? '';
  return segment === 'live' || segment === 'traffic';
}

app.post('/v1/monitors', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing X-Tenant-Id'});
  const idemKey = request.headers['idempotency-key'];
  if (typeof idemKey !== 'string' || idemKey === '')
    return reply.code(400).send({error: 'Idempotency-Key is required'});

  const body = request.body as Partial<MonitorBody> | null;
  if (body === null || typeof body !== 'object') return reply.code(400).send({error: 'body required'});
  if (typeof body.model_version !== 'string' || body.model_version === '')
    return reply.code(400).send({error: 'model_version is required'});
  if (METRICS[body.metric ?? ''] !== true) return reply.code(400).send({error: 'unknown metric'});
  const windowS = body.window_s ?? DEFAULT_WINDOW_S;
  if (!Number.isInteger(windowS) || windowS < MIN_WINDOW_S || windowS > MAX_WINDOW_S)
    return reply.code(400).send({error: 'window_s must be 300..86400'});
  if (!registry.isPromoted(body.model_version))
    return reply.code(400).send({error: 'model version is not promoted'});
  const reference = body.baseline ?? '';
  if (!BASELINE_RE.test(reference))
    return reply.code(400).send({error: 'baseline reference is not resolvable'});
  if (isLiveBaseline(reference))
    return reply.code(400).send({error: 'baseline must be frozen traffic, not live'});

  const stored: Monitor | null = await store.get(tenant, idemKey);
  if (stored !== null) return reply.code(200).send(stored);

  const monitor: Monitor = {
    monitor_id: randomUUID(),
    tenant,
    model_version: body.model_version,
    metric: body.metric,
    window_s: windowS,
    baseline: reference,
  };
  await store.put(tenant, idemKey, monitor);
  request.log.info({tenant, monitor: monitor.monitor_id, metric: monitor.metric}, 'monitor registered');
  return reply.code(201).send(monitor);
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"log"
	"net/http"

	"github.com/google/uuid"
)

type MonitorRequest struct {
	ModelVersion string \`json:"model_version"\`
	Metric       string \`json:"metric"\`
	WindowS      int    \`json:"window_s"\`
	Baseline     string \`json:"baseline"\`
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	_ = json.NewEncoder(rw).Encode(body)
}

func createMonitor(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	var body MonitorRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	// TODO: this draft registers a monitor against any model version, lets the baseline be the live
	// traffic the monitor is meant to watch, and ignores Idempotency-Key, so a client retry
	// registers a second monitor. Review all three.
	log.Printf("monitor registered tenant=%s version=%s", tenant, body.ModelVersion)
	writeJSON(rw, http.StatusCreated, map[string]any{
		"monitor_id":    uuid.NewString(),
		"tenant":        tenant,
		"model_version": body.ModelVersion,
		"metric":        body.Metric,
		"window_s":      body.WindowS,
		"baseline":      body.Baseline,
	})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/monitors", createMonitor)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"regexp"
	"strings"

	"github.com/google/uuid"
)

const (
	minWindowS     = 300
	maxWindowS     = 86400
	defaultWindowS = 3600
)

var metricsSet = map[string]bool{"input_distribution": true, "outcome_rate": true, "calibration": true}

var baselineRe = regexp.MustCompile("^baseline:[a-z0-9._-]+:[0-9]{4}-[0-9]{2}-[0-9]{2}$")

type MonitorRequest struct {
	ModelVersion string \`json:"model_version"\`
	Metric       string \`json:"metric"\`
	WindowS      int    \`json:"window_s"\`
	Baseline     string \`json:"baseline"\`
}

type Monitor struct {
	MonitorID    string \`json:"monitor_id"\`
	Tenant       string \`json:"tenant"\`
	ModelVersion string \`json:"model_version"\`
	Metric       string \`json:"metric"\`
	WindowS      int    \`json:"window_s"\`
	Baseline     string \`json:"baseline"\`
}

type Registry interface {
	IsPromoted(ctx context.Context, modelVersion string) (bool, error)
}

type MonitorStore interface {
	Get(ctx context.Context, tenant, idemKey string) (*Monitor, error)
	Put(ctx context.Context, tenant, idemKey string, monitor *Monitor) error
}

var (
	registry Registry
	store    MonitorStore
)

func isLiveBaseline(reference string) bool {
	parts := strings.Split(reference, ":")
	if len(parts) < 2 {
		return true
	}
	return parts[1] == "live" || parts[1] == "traffic"
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	_ = json.NewEncoder(rw).Encode(body)
}

func createMonitor(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-Tenant-Id"})
		return
	}
	idemKey := r.Header.Get("Idempotency-Key")
	if idemKey == "" {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "Idempotency-Key is required"})
		return
	}
	var body MonitorRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	if body.ModelVersion == "" {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "model_version is required"})
		return
	}
	if !metricsSet[body.Metric] {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "unknown metric"})
		return
	}
	if body.WindowS == 0 {
		body.WindowS = defaultWindowS
	}
	if body.WindowS < minWindowS || body.WindowS > maxWindowS {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "window_s must be 300..86400"})
		return
	}
	promoted, err := registry.IsPromoted(r.Context(), body.ModelVersion)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	if !promoted {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "model version is not promoted"})
		return
	}
	if !baselineRe.MatchString(body.Baseline) {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "baseline reference is not resolvable"})
		return
	}
	if isLiveBaseline(body.Baseline) {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "baseline must be frozen traffic, not live"})
		return
	}
	stored, err := store.Get(r.Context(), tenant, idemKey)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	if stored != nil {
		writeJSON(rw, http.StatusOK, stored)
		return
	}
	monitor := &Monitor{
		MonitorID:    uuid.NewString(),
		Tenant:       tenant,
		ModelVersion: body.ModelVersion,
		Metric:       body.Metric,
		WindowS:      body.WindowS,
		Baseline:     body.Baseline,
	}
	if err := store.Put(r.Context(), tenant, idemKey, monitor); err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	log.Printf("monitor registered tenant=%s monitor=%s metric=%s", tenant, monitor.MonitorID, monitor.Metric)
	writeJSON(rw, http.StatusCreated, monitor)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/monitors", createMonitor)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
    },
    scala: {
      starter: `import java.util.UUID

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class MonitorRequest(model_version: String, metric: String, window_s: Int, baseline: String)
final case class Monitor(
    monitor_id: String,
    tenant: String,
    model_version: String,
    metric: String,
    window_s: Int,
    baseline: String,
)

object MonitorApi {
  implicit val system: ActorSystem = ActorSystem("drift-monitor")
  implicit val requestFormat: RootJsonFormat[MonitorRequest] = jsonFormat4(MonitorRequest)
  implicit val monitorFormat: RootJsonFormat[Monitor] = jsonFormat6(Monitor)

  val route: Route =
    path("v1" / "monitors") {
      post {
        headerValueByName("X-Tenant-Id") { tenant =>
          entity(as[MonitorRequest]) { body =>
            // TODO: this draft registers a monitor against any model version, lets the baseline be
            // the live traffic the monitor is meant to watch, and ignores Idempotency-Key, so a
            // client retry registers a second monitor. Review all three.
            system.log.info(s"monitor registered tenant=$tenant")
            complete(
              StatusCodes.Created,
              Monitor(UUID.randomUUID().toString, tenant, body.model_version, body.metric, body.window_s, body.baseline),
            )
          }
        }
      }
    }

  def main(args: Array[String]): Unit = {
    Http().newServerAt("0.0.0.0", 8443).bind(route)
  }
}
`,
      solution: `import java.util.UUID

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class MonitorRequest(model_version: String, metric: String, window_s: Int, baseline: String)
final case class Monitor(
    monitor_id: String,
    tenant: String,
    model_version: String,
    metric: String,
    window_s: Int,
    baseline: String,
)

object MonitorApi {
  implicit val system: ActorSystem = ActorSystem("drift-monitor")
  implicit val requestFormat: RootJsonFormat[MonitorRequest] = jsonFormat4(MonitorRequest)
  implicit val monitorFormat: RootJsonFormat[Monitor] = jsonFormat6(Monitor)

  val Metrics = Set("input_distribution", "outcome_rate", "calibration")
  val MinWindowS = 300
  val MaxWindowS = 86400
  val DefaultWindowS = 3600
  val BaselineRe = "^baseline:[a-z0-9._-]+:[0-9]{4}-[0-9]{2}-[0-9]{2}$".r

  val registry = Registry.open()
  val store = MonitorStore.open()

  def isLiveBaseline(reference: String): Boolean = {
    val segment = reference.split(":").lift(1).getOrElse("")
    segment == "live" || segment == "traffic"
  }

  val route: Route =
    path("v1" / "monitors") {
      post {
        optionalHeaderValueByName("X-Tenant-Id") { tenantOpt =>
          optionalHeaderValueByName("Idempotency-Key") { idemOpt =>
            entity(as[MonitorRequest]) { body =>
              if (!tenantOpt.exists(_.nonEmpty)) {
                complete(StatusCodes.Unauthorized, """{"error":"missing X-Tenant-Id"}""")
              } else if (!idemOpt.exists(_.nonEmpty)) {
                complete(StatusCodes.BadRequest, """{"error":"Idempotency-Key is required"}""")
              } else if (!Metrics.contains(body.metric)) {
                complete(StatusCodes.BadRequest, """{"error":"unknown metric"}""")
              } else if (body.window_s < MinWindowS || body.window_s > MaxWindowS) {
                complete(StatusCodes.BadRequest, """{"error":"window_s must be 300..86400"}""")
              } else if (!registry.isPromoted(body.model_version)) {
                complete(StatusCodes.BadRequest, """{"error":"model version is not promoted"}""")
              } else if (!BaselineRe.matches(body.baseline)) {
                complete(StatusCodes.BadRequest, """{"error":"baseline reference is not resolvable"}""")
              } else if (isLiveBaseline(body.baseline)) {
                complete(StatusCodes.BadRequest, """{"error":"baseline must be frozen traffic, not live"}""")
              } else {
                val tenant = tenantOpt.get
                val idemKey = idemOpt.get
                store.get(tenant, idemKey) match {
                  case Some(stored) =>
                    complete(StatusCodes.OK, stored)
                  case None =>
                    val monitor = Monitor(
                      UUID.randomUUID().toString,
                      tenant,
                      body.model_version,
                      body.metric,
                      body.window_s,
                      body.baseline,
                    )
                    store.put(tenant, idemKey, monitor)
                    system.log.info(s"monitor registered tenant=$tenant monitor=\${monitor.monitor_id} metric=\${monitor.metric}")
                    complete(StatusCodes.Created, monitor)
                }
              }
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

#include <iostream>
#include <string>
#include <vector>

using json = nlohmann::json;

std::vector<json> registered;

int main() {
  httplib::Server svr;

  svr.Post("/v1/monitors", [](const httplib::Request& req, httplib::Response& res) {
    const auto tenant = req.get_header_value("X-Tenant-Id");
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) {
      res.status = 400;
      res.set_content(R"({"error":"invalid json"})", "application/json");
      return;
    }
    // TODO: this draft registers a monitor against any model version, lets the baseline be the live
    // traffic the monitor is meant to watch, and ignores Idempotency-Key, so a client retry
    // registers a second monitor. Review all three.
    std::cerr << "monitor registered tenant=" << tenant << "\\n";
    res.status = 201;
    res.set_content(
        json{{"monitor_id", uuidString()},
             {"tenant", tenant},
             {"model_version", body.value("model_version", std::string())},
             {"metric", body.value("metric", std::string())},
             {"window_s", body.value("window_s", 3600)},
             {"baseline", body.value("baseline", std::string())}}
            .dump(),
        "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <iostream>
#include <regex>
#include <set>
#include <string>

using json = nlohmann::json;

const std::set<std::string> kMetrics = {"input_distribution", "outcome_rate", "calibration"};
constexpr int kMinWindowS = 300;
constexpr int kMaxWindowS = 86400;
constexpr int kDefaultWindowS = 3600;
const std::regex kBaselineRe(R"(^baseline:[a-z0-9._-]+:[0-9]{4}-[0-9]{2}-[0-9]{2}$)");

struct Registry {
  bool isPromoted(const std::string& modelVersion);
};

struct MonitorStore {
  std::optional<json> get(const std::string& tenant, const std::string& idemKey);
  void put(const std::string& tenant, const std::string& idemKey, const json& monitor);
};

Registry registry;
MonitorStore store;
std::string uuidString();

bool isLiveBaseline(const std::string& reference) {
  const auto colon = reference.find(':');
  if (colon == std::string::npos) return true;
  const auto segment = reference.substr(colon + 1, reference.find(':', colon + 1) - colon - 1);
  return segment == "live" || segment == "traffic";
}

int main() {
  httplib::Server svr;

  svr.Post("/v1/monitors", [](const httplib::Request& req, httplib::Response& res) {
    const auto tenant = req.get_header_value("X-Tenant-Id");
    if (tenant.empty()) {
      res.status = 401;
      res.set_content(R"({"error":"missing X-Tenant-Id"})", "application/json");
      return;
    }
    const auto idemKey = req.get_header_value("Idempotency-Key");
    if (idemKey.empty()) {
      res.status = 400;
      res.set_content(R"({"error":"Idempotency-Key is required"})", "application/json");
      return;
    }
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) {
      res.status = 400;
      res.set_content(R"({"error":"invalid json"})", "application/json");
      return;
    }
    const auto modelVersion = body.value("model_version", std::string());
    if (modelVersion.empty()) {
      res.status = 400;
      res.set_content(R"({"error":"model_version is required"})", "application/json");
      return;
    }
    const auto metric = body.value("metric", std::string());
    if (kMetrics.count(metric) == 0) {
      res.status = 400;
      res.set_content(R"({"error":"unknown metric"})", "application/json");
      return;
    }
    const int windowS = body.value("window_s", kDefaultWindowS);
    if (windowS < kMinWindowS || windowS > kMaxWindowS) {
      res.status = 400;
      res.set_content(R"({"error":"window_s must be 300..86400"})", "application/json");
      return;
    }
    if (!registry.isPromoted(modelVersion)) {
      res.status = 400;
      res.set_content(R"({"error":"model version is not promoted"})", "application/json");
      return;
    }
    const auto reference = body.value("baseline", std::string());
    if (!std::regex_match(reference, kBaselineRe)) {
      res.status = 400;
      res.set_content(R"({"error":"baseline reference is not resolvable"})", "application/json");
      return;
    }
    if (isLiveBaseline(reference)) {
      res.status = 400;
      res.set_content(R"({"error":"baseline must be frozen traffic, not live"})", "application/json");
      return;
    }
    const auto stored = store.get(tenant, idemKey);
    if (stored) {
      res.status = 200;
      res.set_content(stored->dump(), "application/json");
      return;
    }
    const json monitor = {
        {"monitor_id", uuidString()},
        {"tenant", tenant},
        {"model_version", modelVersion},
        {"metric", metric},
        {"window_s", windowS},
        {"baseline", reference},
    };
    store.put(tenant, idemKey, monitor);
    std::cerr << "monitor registered tenant=" << tenant << " monitor=" << monitor["monitor_id"] << "\\n";
    res.status = 201;
    res.set_content(monitor.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  hints: [
    'Write the guard clauses in cost order before anything is stored: tenant, Idempotency-Key, metric, window, promoted version, baseline reference. Each one returns before the monitor exists, so an invalid registration can never page anyone.',
    'The baseline check is two questions: is the reference resolvable at all (`BASELINE_RE`), and does it point at frozen traffic? `baseline:model-7:2026-09-01` is frozen; `baseline:live:2026-10-21` is the traffic you are trying to watch, and comparing it with itself can never fire.',
    'The idempotency lookup is keyed by `(tenant, key)` and happens before the store write; a hit returns the stored monitor with 200. Storing the monitor — not just the request hash — is what lets a replay answer without generating a second id.',
  ],
  debrief: `The interviewer is testing whether you can review a registration endpoint at the trust boundary. The
draft reads fine because a demo registers one monitor, for one promoted version, once. Three defects
are being checked: authentication and the metric/window whitelist (cheap rejections before anything is
written), resolution against the registry (a monitor on an unpromoted version is watching a release
that does not exist), and baseline validity — the subtle one. A baseline that is live traffic makes the
monitor structurally unable to fire, because the reference moves with the signal; the fix is to demand
a frozen, dated reference and to reject the live segment explicitly. Idempotency on registration is the
fourth: registration is a client retry away from duplicates, so it is keyed like any other write. Real
platforms add a promotion audit trail, per-tenant baseline retention, and a scheduled job that re-freezes
the baseline when a new version is promoted.`,
};
