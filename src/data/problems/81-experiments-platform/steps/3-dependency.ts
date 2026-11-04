import type {Step} from '@/lib/types';

export const dependencyStep: Step = {
  id: 'dependency',
  title: 'Guardrail checks before every ramp',
  concept: 'grpc',
  file: 'ramp',
  focus: ['api', 'stats'],
  task: `## Task

**Starting point.** The starter serves \`POST /v1/experiments/{id}/ramp\` with \`{"to_percent": 50}\`:
it checks that the target is above the current percentage and at most 100, asks the stats service
\`Guardrails.CheckGuardrails\` over gRPC (\`stats:50051\`) and, on a clean verdict, moves the traffic
with \`store.set_percent\`. It serves the demo and hides four flaws.

**Failure mode the checks target.** The gate is open exactly when it matters: a stuck stats service
holds every ramp request open, a stats outage ramps without a check, a breached guardrail answers 409
but leaves the experiment running for the next scheduled ramp, and \`skip_guardrails\` in the body
bypasses the check.

- Every \`CheckGuardrails\` call carries a **2-second** deadline (\`GUARDRAIL_DEADLINE_S\`).
- No verdict is not a pass: an error status (deadline, unavailable) answers **503** and moves nothing.
- A breach pauses: \`store.set_status(id, "paused")\`, no traffic change, **409**
  \`{"status": "paused", "metric", "limit", "observed"}\`. A clean verdict sets the percentage and
  \`running\` again.
- A body naming any of \`OVERRIDE_FIELDS\` (\`skip_guardrails\`, \`override\`, \`force\`) is **400**.`,
  sequence: {
    participants: ['Ramp scheduler', 'Experiment API', 'Stats service', 'experiment store'],
    messages: [
      {
        from: 'Ramp scheduler',
        to: 'Experiment API',
        label: 'POST /v1/experiments/{id}/ramp {"to_percent": 50}',
        kind: 'sync',
      },
      {
        from: 'Experiment API',
        to: 'Stats service',
        label: 'CheckGuardrails(experiment_id, to_percent) · deadline 2 s',
        kind: 'sync',
      },
      {from: 'Stats service', to: 'Experiment API', label: 'breached · error_rate 0.12 > 0.05', kind: 'reply'},
      {
        from: 'Experiment API',
        to: 'experiment store',
        label: 'set_status(id, "paused") · percent unchanged',
        kind: 'sync',
      },
      {
        from: 'Experiment API',
        to: 'Ramp scheduler',
        label: '409 {status: "paused", metric, limit, observed}',
        kind: 'reply',
      },
      {
        from: 'Experiment API',
        to: 'Ramp scheduler',
        label: 'deadline / unavailable → 503, nothing moved',
        kind: 'reply',
      },
    ],
  },
  checks: [
    {
      id: 'deadline',
      title: 'CheckGuardrails carries a 2-second deadline',
      detail:
        'Every guardrail call is made with a deadline of `GUARDRAIL_DEADLINE_S` (2 s); the starter sets none, so a stats service that hangs holds the ramp request for as long as it hangs.',
      match: {
        python: {all: [/CheckGuardrails\([\s\S]{0,200}?timeout\s*=/]},
        typescript: {all: [/deadline:\s*Date\.now\(\)\s*\+/]},
        go: {all: [/context\.WithTimeout\(/]},
        scala: {all: [/withDeadlineAfter\(/]},
        cpp: {all: [/set_deadline\(/]},
      },
    },
    {
      id: 'fail-closed',
      title: 'No verdict answers 503 and moves nothing',
      detail:
        'A `CheckGuardrails` error (deadline, unavailable) answers **503** and leaves the percentage; the starter logs it and ramps as if the check had passed.',
      match: {
        python: {all: [/\b503\b/], none: [/verdict\s*=\s*None/]},
        typescript: {all: [/\b503\b/], none: [/verdict\s*=\s*null/]},
        go: {all: [/StatusServiceUnavailable|\b503\b/], none: [/verdict\s*=\s*nil/]},
        scala: {all: [/ServiceUnavailable|\b503\b/]},
        cpp: {all: [/\b503\b/]},
      },
    },
    {
      id: 'pause-on-breach',
      title: 'A breach pauses the experiment and names the metric',
      detail:
        'A breached verdict writes `paused` to the store, leaves the percentage, and answers **409** with the metric, its limit and the observed value.',
      match: {
        python: {all: [/set_status\([^\n]*["']paused["']/, /observed/]},
        typescript: {all: [/setStatus\([^\n]*['"]paused['"]/, /observed/]},
        go: {all: [/SetStatus\([^\n]*"paused"/, /observed/]},
        scala: {all: [/setStatus\([^\n]*"paused"/, /observed/]},
        cpp: {all: [/setStatus\([^\n]*"paused"/, /observed/]},
      },
    },
    {
      id: 'no-override',
      title: 'The body cannot switch the check off',
      detail:
        'A body naming any of `OVERRIDE_FIELDS` (`skip_guardrails`, `override`, `force`) answers **400** before anything else happens.',
      match: {
        python: {all: [/OVERRIDE_FIELDS/], none: [/\.get\(\s*["']skip_guardrails["']\s*\)/]},
        typescript: {all: [/OVERRIDE_FIELDS/], none: [/body\.skip_guardrails/]},
        go: {all: [/overrideFields/], none: [/body\["skip_guardrails"\]/]},
        scala: {all: [/OverrideFields/], none: [/get\("skip_guardrails"\)/]},
        cpp: {all: [/kOverrideFields/], none: [/value\("skip_guardrails"/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import logging

import grpc
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse

import experiments_platform_pb2
import experiments_platform_pb2_grpc
from expd import store  # get, set_status, set_percent

app = FastAPI()
log = logging.getLogger("ramp")

stats = experiments_platform_pb2_grpc.GuardrailsStub(grpc.insecure_channel("stats:50051"))


@app.post("/v1/experiments/{experiment_id}/ramp")
async def ramp(experiment_id: str, request: Request):
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    body = await request.json()
    experiment = store.get(experiment_id)
    if experiment is None:
        raise HTTPException(status_code=404, detail="no such experiment")
    to_percent = body.get("to_percent")
    if not isinstance(to_percent, int) or isinstance(to_percent, bool) or not experiment["percent"] < to_percent <= 100:
        raise HTTPException(status_code=400, detail=f"to_percent must be an integer above {experiment['percent']} and at most 100")
    if not body.get("skip_guardrails"):
        try:
            verdict = stats.CheckGuardrails(experiments_platform_pb2.GuardrailRequest(experiment_id=experiment_id, to_percent=to_percent))
        except grpc.RpcError as exc:
            log.warning("stats unavailable (%s), ramping %s without a guardrail check", exc.code().name, experiment_id)
            verdict = None
        if verdict is not None and verdict.breached:
            return JSONResponse(status_code=409, content={"status": "breached", "metric": verdict.metric})
    store.set_percent(experiment_id, to_percent)
    return {"id": experiment_id, "percent": to_percent, "status": "running"}
`,
      solution: `import logging

import grpc
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse

import experiments_platform_pb2
import experiments_platform_pb2_grpc
from expd import store  # get, set_status, set_percent

app = FastAPI()
log = logging.getLogger("ramp")

GUARDRAIL_DEADLINE_S = 2.0
OVERRIDE_FIELDS = ("skip_guardrails", "override", "force")

stats = experiments_platform_pb2_grpc.GuardrailsStub(grpc.insecure_channel("stats:50051"))


@app.post("/v1/experiments/{experiment_id}/ramp")
async def ramp(experiment_id: str, request: Request):
    body = await request.json()
    if any(name in body for name in OVERRIDE_FIELDS):
        raise HTTPException(status_code=400, detail="guardrails cannot be skipped")
    experiment = store.get(experiment_id)
    if experiment is None:
        raise HTTPException(status_code=404, detail="no such experiment")
    to_percent = body.get("to_percent")
    if not isinstance(to_percent, int) or isinstance(to_percent, bool) or not experiment["percent"] < to_percent <= 100:
        raise HTTPException(status_code=400, detail=f"to_percent must be an integer above {experiment['percent']} and at most 100")
    try:
        verdict = stats.CheckGuardrails(
            experiments_platform_pb2.GuardrailRequest(experiment_id=experiment_id, to_percent=to_percent),
            timeout=GUARDRAIL_DEADLINE_S,
        )
    except grpc.RpcError as exc:
        # No verdict is not a pass: the traffic stays where it is.
        log.warning("guardrail check for %s failed: %s", experiment_id, exc.code().name)
        return JSONResponse(status_code=503, content={"error": "guardrail check unavailable", "code": exc.code().name})
    if verdict.breached:
        store.set_status(experiment_id, "paused")
        return JSONResponse(
            status_code=409,
            content={"status": "paused", "metric": verdict.metric, "limit": verdict.limit, "observed": verdict.observed},
        )
    store.set_percent(experiment_id, to_percent)
    store.set_status(experiment_id, "running")
    return {"id": experiment_id, "percent": to_percent, "status": "running"}
`,
    },
    typescript: {
      starter: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import Fastify from 'fastify';

import {get, setPercent, setStatus} from 'expd/store';

export const app = Fastify();

interface GuardrailVerdict {
  breached?: boolean;
  metric?: string;
  limit?: number;
  observed?: number;
}

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('experiments_platform.proto')) as unknown as {
  expguard: {Guardrails: grpc.ServiceClientConstructor};
};
const stats = new pkg.expguard.Guardrails('stats:50051', grpc.credentials.createInsecure()) as grpc.Client & {
  CheckGuardrails(request: {experiment_id: string; to_percent: number}, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<GuardrailVerdict>;
};

app.post('/v1/experiments/:id/ramp', async (request, reply) => {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const {id} = request.params as {id: string};
  const body = (request.body ?? {}) as {to_percent?: unknown; skip_guardrails?: boolean};
  const experiment = await get(id);
  if (experiment === null) return reply.code(404).send({error: 'no such experiment'});
  const toPercent = body.to_percent;
  if (typeof toPercent !== 'number' || !Number.isInteger(toPercent) || toPercent <= experiment.percent || toPercent > 100) {
    return reply.code(400).send({error: \`to_percent must be an integer above \${experiment.percent} and at most 100\`});
  }
  if (!body.skip_guardrails) {
    let verdict: GuardrailVerdict | null;
    try {
      verdict = await stats.CheckGuardrails({experiment_id: id, to_percent: toPercent}, new grpc.Metadata(), {});
    } catch (e) {
      console.warn(\`stats unavailable (\${(e as grpc.ServiceError).code}), ramping \${id} without a guardrail check\`);
      verdict = null;
    }
    if (verdict !== null && verdict.breached) return reply.code(409).send({status: 'breached', metric: verdict.metric});
  }
  await setPercent(id, toPercent);
  return {id, percent: toPercent, status: 'running'};
});
`,
      solution: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import Fastify from 'fastify';

import {get, setPercent, setStatus} from 'expd/store';

export const app = Fastify();

export const GUARDRAIL_DEADLINE_MS = 2000;
export const OVERRIDE_FIELDS = ['skip_guardrails', 'override', 'force'];

interface GuardrailVerdict {
  breached?: boolean;
  metric?: string;
  limit?: number;
  observed?: number;
}

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('experiments_platform.proto')) as unknown as {
  expguard: {Guardrails: grpc.ServiceClientConstructor};
};
const stats = new pkg.expguard.Guardrails('stats:50051', grpc.credentials.createInsecure()) as grpc.Client & {
  CheckGuardrails(request: {experiment_id: string; to_percent: number}, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<GuardrailVerdict>;
};

app.post('/v1/experiments/:id/ramp', async (request, reply) => {
  const {id} = request.params as {id: string};
  const body = (request.body ?? {}) as Record<string, unknown>;
  if (OVERRIDE_FIELDS.some(name => name in body)) return reply.code(400).send({error: 'guardrails cannot be skipped'});
  const experiment = await get(id);
  if (experiment === null) return reply.code(404).send({error: 'no such experiment'});
  const toPercent = body.to_percent;
  if (typeof toPercent !== 'number' || !Number.isInteger(toPercent) || toPercent <= experiment.percent || toPercent > 100) {
    return reply.code(400).send({error: \`to_percent must be an integer above \${experiment.percent} and at most 100\`});
  }
  let verdict: GuardrailVerdict;
  try {
    verdict = await stats.CheckGuardrails({experiment_id: id, to_percent: toPercent}, new grpc.Metadata(), {deadline: Date.now() + GUARDRAIL_DEADLINE_MS});
  } catch (e) {
    // No verdict is not a pass: the traffic stays where it is.
    return reply.code(503).send({error: 'guardrail check unavailable', code: grpc.status[(e as grpc.ServiceError).code]});
  }
  if (verdict.breached) {
    await setStatus(id, 'paused');
    return reply.code(409).send({status: 'paused', metric: verdict.metric, limit: verdict.limit, observed: verdict.observed});
  }
  await setPercent(id, toPercent);
  await setStatus(id, 'running');
  return {id, percent: toPercent, status: 'running'};
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"log"
	"net/http"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"

	pb "expd/gen/experiments_platform"
	"expd/store" // store.Get, SetStatus, SetPercent
)

var (
	statsConn, _ = grpc.NewClient("stats:50051", grpc.WithTransportCredentials(insecure.NewCredentials()))
	stats        = pb.NewGuardrailsClient(statsConn)
)

func writeJSON(rw http.ResponseWriter, code int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(code)
	json.NewEncoder(rw).Encode(v)
}

func ramp(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	id := r.PathValue("id")
	body := map[string]any{}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "malformed body"})
		return
	}
	experiment := store.Get(r.Context(), id)
	if experiment == nil {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "no such experiment"})
		return
	}
	f, ok := body["to_percent"].(float64)
	toPercent := int(f)
	if !ok || float64(toPercent) != f || toPercent <= experiment.Percent || toPercent > 100 {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "to_percent must be an integer above the current percentage and at most 100"})
		return
	}
	if skip, _ := body["skip_guardrails"].(bool); !skip {
		verdict, err := stats.CheckGuardrails(r.Context(), &pb.GuardrailRequest{ExperimentId: id, ToPercent: int32(toPercent)})
		if err != nil {
			log.Printf("stats unavailable (%v), ramping %s without a guardrail check", status.Code(err), id)
			verdict = nil
		}
		if verdict != nil && verdict.GetBreached() {
			writeJSON(rw, http.StatusConflict, map[string]any{"status": "breached", "metric": verdict.GetMetric()})
			return
		}
	}
	store.SetPercent(r.Context(), id, toPercent)
	writeJSON(rw, http.StatusOK, map[string]any{"id": id, "percent": toPercent, "status": "running"})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/experiments/{id}/ramp", ramp)
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"net/http"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"

	pb "expd/gen/experiments_platform"
	"expd/store" // store.Get, SetStatus, SetPercent
)

const guardrailDeadline = 2 * time.Second

var overrideFields = []string{"skip_guardrails", "override", "force"}

var (
	statsConn, _ = grpc.NewClient("stats:50051", grpc.WithTransportCredentials(insecure.NewCredentials()))
	stats        = pb.NewGuardrailsClient(statsConn)
)

func writeJSON(rw http.ResponseWriter, code int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(code)
	json.NewEncoder(rw).Encode(v)
}

func ramp(rw http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	body := map[string]any{}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "malformed body"})
		return
	}
	for _, name := range overrideFields {
		if _, ok := body[name]; ok {
			writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "guardrails cannot be skipped"})
			return
		}
	}
	experiment := store.Get(r.Context(), id)
	if experiment == nil {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "no such experiment"})
		return
	}
	f, ok := body["to_percent"].(float64)
	toPercent := int(f)
	if !ok || float64(toPercent) != f || toPercent <= experiment.Percent || toPercent > 100 {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "to_percent must be an integer above the current percentage and at most 100"})
		return
	}
	callCtx, cancel := context.WithTimeout(r.Context(), guardrailDeadline)
	defer cancel()
	verdict, err := stats.CheckGuardrails(callCtx, &pb.GuardrailRequest{ExperimentId: id, ToPercent: int32(toPercent)})
	if err != nil {
		// No verdict is not a pass: the traffic stays where it is.
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "guardrail check unavailable", "code": status.Code(err).String()})
		return
	}
	if verdict.GetBreached() {
		store.SetStatus(r.Context(), id, "paused")
		writeJSON(rw, http.StatusConflict, map[string]any{"status": "paused", "metric": verdict.GetMetric(), "limit": verdict.GetLimit(), "observed": verdict.GetObserved()})
		return
	}
	store.SetPercent(r.Context(), id, toPercent)
	store.SetStatus(r.Context(), id, "running")
	writeJSON(rw, http.StatusOK, map[string]any{"id": id, "percent": toPercent, "status": "running"})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/experiments/{id}/ramp", ramp)
}
`,
    },
    scala: {
      starter: `import io.grpc.{ManagedChannelBuilder, StatusRuntimeException}
import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import expd.Store // Store.get, setStatus, setPercent
import expguard.experiments_platform.{GuardrailRequest, GuardrailVerdict, GuardrailsGrpc}

object Ramp {
  private val guardrails = GuardrailsGrpc.blockingStub(ManagedChannelBuilder.forAddress("stats", 50051).usePlaintext().build())

  private def json(status: StatusCode, body: JsValue): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  private def error(message: String): JsObject = JsObject("error" -> JsString(message))

  def ramp(id: String, body: JsObject): HttpResponse =
    // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    Store.get(id) match {
      case None => json(StatusCodes.NotFound, error("no such experiment"))
      case Some(experiment) =>
        body.fields.get("to_percent") match {
          case Some(JsNumber(n)) if n.isValidInt && n.toInt > experiment.percent && n.toInt <= 100 =>
            val toPercent = n.toInt
            val verdict: Option[GuardrailVerdict] =
              if (body.fields.get("skip_guardrails").contains(JsTrue)) None
              else
                try Some(guardrails.checkGuardrails(GuardrailRequest(id, toPercent)))
                catch {
                  case e: StatusRuntimeException =>
                    println(s"stats unavailable (\${e.getStatus.getCode}), ramping $id without a guardrail check")
                    None
                }
            verdict.filter(_.breached) match {
              case Some(v) => json(StatusCodes.Conflict, JsObject("status" -> JsString("breached"), "metric" -> JsString(v.metric)))
              case None =>
                Store.setPercent(id, toPercent)
                json(StatusCodes.OK, JsObject("id" -> JsString(id), "percent" -> JsNumber(toPercent), "status" -> JsString("running")))
            }
          case _ => json(StatusCodes.BadRequest, error("to_percent must be an integer above the current percentage and at most 100"))
        }
    }

  val route: Route = path("v1" / "experiments" / Segment / "ramp") { id =>
    post {
      entity(as[String]) { raw =>
        complete(ramp(id, raw.parseJson.asJsObject))
      }
    }
  }
}
`,
      solution: `import java.util.concurrent.TimeUnit

import io.grpc.{ManagedChannelBuilder, StatusRuntimeException}
import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import expd.Store // Store.get, setStatus, setPercent
import expguard.experiments_platform.{GuardrailRequest, GuardrailsGrpc}

object Ramp {
  val GuardrailDeadlineMs = 2000L
  val OverrideFields: Seq[String] = Seq("skip_guardrails", "override", "force")

  private val guardrails = GuardrailsGrpc.blockingStub(ManagedChannelBuilder.forAddress("stats", 50051).usePlaintext().build())

  private def json(status: StatusCode, body: JsValue): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  private def error(message: String): JsObject = JsObject("error" -> JsString(message))

  def ramp(id: String, body: JsObject): HttpResponse =
    if (OverrideFields.exists(body.fields.contains)) json(StatusCodes.BadRequest, error("guardrails cannot be skipped"))
    else
      Store.get(id) match {
        case None => json(StatusCodes.NotFound, error("no such experiment"))
        case Some(experiment) =>
          body.fields.get("to_percent") match {
            case Some(JsNumber(n)) if n.isValidInt && n.toInt > experiment.percent && n.toInt <= 100 =>
              val toPercent = n.toInt
              try {
                val verdict = guardrails.withDeadlineAfter(GuardrailDeadlineMs, TimeUnit.MILLISECONDS).checkGuardrails(GuardrailRequest(id, toPercent))
                if (verdict.breached) {
                  Store.setStatus(id, "paused")
                  json(StatusCodes.Conflict, JsObject("status" -> JsString("paused"), "metric" -> JsString(verdict.metric),
                    "limit" -> JsNumber(verdict.limit), "observed" -> JsNumber(verdict.observed)))
                } else {
                  Store.setPercent(id, toPercent)
                  Store.setStatus(id, "running")
                  json(StatusCodes.OK, JsObject("id" -> JsString(id), "percent" -> JsNumber(toPercent), "status" -> JsString("running")))
                }
              } catch {
                // No verdict is not a pass: the traffic stays where it is.
                case e: StatusRuntimeException =>
                  json(StatusCodes.ServiceUnavailable, JsObject("error" -> JsString("guardrail check unavailable"), "code" -> JsString(e.getStatus.getCode.name)))
              }
            case _ => json(StatusCodes.BadRequest, error("to_percent must be an integer above the current percentage and at most 100"))
          }
      }

  val route: Route = path("v1" / "experiments" / Segment / "ramp") { id =>
    post {
      entity(as[String]) { raw =>
        complete(ramp(id, raw.parseJson.asJsObject))
      }
    }
  }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>
#include <httplib.h>
#include <nlohmann/json.hpp>

#include <iostream>
#include <string>

#include "experiments_platform.grpc.pb.h"
#include "expd/store.h"  // store::get, setStatus, setPercent

using json = nlohmann::json;

auto guardrails = expguard::Guardrails::NewStub(grpc::CreateChannel("stats:50051", grpc::InsecureChannelCredentials()));

void reply(httplib::Response& res, int status, const json& body) {
  res.status = status;
  res.set_content(body.dump(), "application/json");
}

void ramp(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const std::string id = req.matches[1];
  const json body = json::parse(req.body, nullptr, false);
  if (!body.is_object()) return reply(res, 400, {{"error", "malformed body"}});
  const auto experiment = store::get(id);
  if (!experiment) return reply(res, 404, {{"error", "no such experiment"}});
  if (!body.contains("to_percent") || !body["to_percent"].is_number_integer()) return reply(res, 400, {{"error", "to_percent must be an integer"}});
  const long to_percent = body["to_percent"];
  if (to_percent <= experiment->percent || to_percent > 100) return reply(res, 400, {{"error", "to_percent must be above the current percentage and at most 100"}});
  if (!body.value("skip_guardrails", false)) {
    grpc::ClientContext ctx;
    expguard::GuardrailRequest request;
    request.set_experiment_id(id);
    request.set_to_percent(to_percent);
    expguard::GuardrailVerdict verdict;
    const grpc::Status status = guardrails->CheckGuardrails(&ctx, request, &verdict);
    if (!status.ok()) {
      std::cerr << "stats unavailable (" << status.error_message() << "), ramping " << id << " without a guardrail check\\n";
    } else if (verdict.breached()) {
      return reply(res, 409, {{"status", "breached"}, {"metric", verdict.metric()}});
    }
  }
  store::setPercent(id, to_percent);
  reply(res, 200, {{"id", id}, {"percent", to_percent}, {"status", "running"}});
}

void register_routes(httplib::Server& svr) {
  svr.Post(R"(/v1/experiments/([\\w-]+)/ramp)", ramp);
}
`,
      solution: `#include <grpcpp/grpcpp.h>
#include <httplib.h>
#include <nlohmann/json.hpp>

#include <chrono>
#include <string>
#include <vector>

#include "experiments_platform.grpc.pb.h"
#include "expd/store.h"  // store::get, setStatus, setPercent

using json = nlohmann::json;

constexpr std::chrono::milliseconds kGuardrailDeadline{2000};
const std::vector<std::string> kOverrideFields = {"skip_guardrails", "override", "force"};

auto guardrails = expguard::Guardrails::NewStub(grpc::CreateChannel("stats:50051", grpc::InsecureChannelCredentials()));

void reply(httplib::Response& res, int status, const json& body) {
  res.status = status;
  res.set_content(body.dump(), "application/json");
}

void ramp(const httplib::Request& req, httplib::Response& res) {
  const std::string id = req.matches[1];
  const json body = json::parse(req.body, nullptr, false);
  if (!body.is_object()) return reply(res, 400, {{"error", "malformed body"}});
  for (const std::string& name : kOverrideFields) {
    if (body.contains(name)) return reply(res, 400, {{"error", "guardrails cannot be skipped"}});
  }
  const auto experiment = store::get(id);
  if (!experiment) return reply(res, 404, {{"error", "no such experiment"}});
  if (!body.contains("to_percent") || !body["to_percent"].is_number_integer()) return reply(res, 400, {{"error", "to_percent must be an integer"}});
  const long to_percent = body["to_percent"];
  if (to_percent <= experiment->percent || to_percent > 100) return reply(res, 400, {{"error", "to_percent must be above the current percentage and at most 100"}});
  grpc::ClientContext ctx;
  ctx.set_deadline(std::chrono::system_clock::now() + kGuardrailDeadline);
  expguard::GuardrailRequest request;
  request.set_experiment_id(id);
  request.set_to_percent(to_percent);
  expguard::GuardrailVerdict verdict;
  const grpc::Status status = guardrails->CheckGuardrails(&ctx, request, &verdict);
  // No verdict is not a pass: the traffic stays where it is.
  if (!status.ok()) return reply(res, 503, {{"error", "guardrail check unavailable"}, {"code", static_cast<int>(status.error_code())}});
  if (verdict.breached()) {
    store::setStatus(id, "paused");
    return reply(res, 409, {{"status", "paused"}, {"metric", verdict.metric()}, {"limit", verdict.limit()}, {"observed", verdict.observed()}});
  }
  store::setPercent(id, to_percent);
  store::setStatus(id, "running");
  reply(res, 200, {{"id", id}, {"percent", to_percent}, {"status", "running"}});
}

void register_routes(httplib::Server& svr) {
  svr.Post(R"(/v1/experiments/([\\w-]+)/ramp)", ramp);
}
`,
    },
  },
  harness: {
    python: `import grpc

import experiments_platform_pb2
import experiments_platform_pb2_grpc
from expd import store

SPLIT = [{"key": "control", "weight": 50}, {"key": "treatment", "weight": 50}]


class Stats(experiments_platform_pb2_grpc.GuardrailsServicer):
    """Clean verdicts unless breach holds (metric, limit, observed)."""

    def __init__(self):
        self.breach = None

    def CheckGuardrails(self, request, context):
        if self.breach is None:
            return experiments_platform_pb2.GuardrailVerdict(breached=False)
        metric, limit, observed = self.breach
        return experiments_platform_pb2.GuardrailVerdict(breached=True, metric=metric, limit=limit, observed=observed)


def _setup(ctx):
    stats = Stats()
    ctx.grpc.serve(experiments_platform_pb2_grpc.add_GuardrailsServicer_to_server, stats)
    experiment_id = store.create({"name": "cta", "unit": "user", "variants": SPLIT, "min_sample": 1000, "salt": "s-1"})["id"]
    store.set_percent(experiment_id, 10)
    return ctx.client(ctx.load("ramp").app), stats, experiment_id


async def _ramp(c, experiment_id, body):
    return await c.post(f"/v1/experiments/{experiment_id}/ramp", json=body)


async def check_deadline(ctx):
    c, _, e = _setup(ctx)
    async with c:
        r = await _ramp(c, e, {"to_percent": 25})
        assert r.status_code == 200, f"a ramp to 25 % with clean guardrails answered {r.status_code}: {r.text}"
        calls = ctx.grpc.calls_to("CheckGuardrails")
        assert calls, "the ramp made no CheckGuardrails call"
        timeout = calls[-1].timeout
        assert timeout is not None, "the CheckGuardrails call carries no deadline: a stats service that hangs holds every ramp request open"
        assert 1.5 <= timeout <= 2.5, f"the CheckGuardrails call carries a {timeout} s deadline, expected GUARDRAIL_DEADLINE_S = 2"
        ctx.grpc.set_latency("CheckGuardrails", 30.0)
        r = await _ramp(c, e, {"to_percent": 50})
    assert r.status_code == 503, f"with the stats service answering after 30 s the ramp answered {r.status_code} {r.text}, expected 503"
    assert store.get(e)["percent"] == 25, f"a ramp whose guardrail check timed out moved the traffic to {store.get(e)['percent']} %"


async def check_fail_closed(ctx):
    c, _, e = _setup(ctx)
    ctx.grpc.fail("CheckGuardrails", grpc.StatusCode.UNAVAILABLE, "stats is down", times=5)
    async with c:
        r = await _ramp(c, e, {"to_percent": 50})
    assert r.status_code == 503, f"with the stats service unavailable the ramp answered {r.status_code} {r.text}, expected 503: no verdict is not a pass"
    assert store.get(e)["percent"] == 10, f"a ramp without a guardrail verdict moved the traffic to {store.get(e)['percent']} %"


async def check_pause_on_breach(ctx):
    c, stats, e = _setup(ctx)
    stats.breach = ("error_rate", 0.05, 0.12)
    async with c:
        r = await _ramp(c, e, {"to_percent": 50})
        assert r.status_code == 409, f"with error_rate breached the ramp answered {r.status_code} {r.text}, expected 409"
        body = r.json()
        assert body.get("status") == "paused" and body.get("metric") == "error_rate", f"the 409 must say paused and name the metric, got {body}"
        assert body.get("limit") == 0.05 and body.get("observed") == 0.12, f"the 409 must carry the limit and the observed value, got {body}"
        stored = store.get(e)
        assert stored["status"] == "paused", f"after a breach the experiment is {stored['status']!r}: the pause must be written, or the next scheduled ramp tries again"
        assert stored["percent"] == 10, f"a breached ramp moved the traffic to {stored['percent']} %"
        stats.breach = None
        r = await _ramp(c, e, {"to_percent": 50})
    assert r.status_code == 200, f"once the guardrails are clean the ramp answered {r.status_code}: {r.text}"
    stored = store.get(e)
    assert stored["percent"] == 50 and stored["status"] == "running", f"a clean ramp must set 50 % and running, the store holds {stored}"


async def check_no_override(ctx):
    c, stats, e = _setup(ctx)
    stats.breach = ("latency_p99_ms", 800.0, 1450.0)
    async with c:
        for flag in ("skip_guardrails", "override", "force"):
            r = await _ramp(c, e, {"to_percent": 50, flag: True})
            assert r.status_code == 400, f"a ramp with {flag} in the body answered {r.status_code} {r.text}, expected 400: the body cannot switch the check off"
    assert store.get(e)["percent"] == 10, f"an override moved the traffic to {store.get(e)['percent']} % while latency is breached"
`,
    typescript: `const SPLIT = [
  {key: 'control', weight: 50},
  {key: 'treatment', weight: 50},
];

async function setup(ctx) {
  const pkg = ctx.proto('experiments_platform.proto');
  const stats: {breach: null | {metric: string; limit: number; observed: number}} = {breach: null};
  ctx.grpc.serve(pkg.expguard.Guardrails.service, {
    CheckGuardrails(_call, callback) {
      callback(null, stats.breach === null ? {breached: false} : {breached: true, ...stats.breach});
    },
  });
  const store = ctx.load('/support/expd/store.ts');
  const e = (await store.create({name: 'cta', unit: 'user', variants: SPLIT, min_sample: 1000, salt: 's-1'})).id;
  await store.setPercent(e, 10);
  const c = ctx.client(ctx.load('ramp').app);
  const ramp = body => c.post(\`/v1/experiments/\${e}/ramp\`, {json: body});
  return {store, stats, e, ramp};
}

export async function check_deadline(ctx) {
  const {store, e, ramp} = await setup(ctx);
  let r = await ramp({to_percent: 25});
  assert.equal(r.status, 200, \`a ramp to 25 % with clean guardrails answered \${r.status}: \${r.text}\`);
  const calls = ctx.grpc.callsTo('CheckGuardrails');
  assert(calls.length > 0, 'the ramp made no CheckGuardrails call');
  const timeout = calls[calls.length - 1].timeout;
  assert(timeout !== null && timeout !== undefined, 'the CheckGuardrails call carries no deadline: a stats service that hangs holds every ramp request open');
  assert(1.5 <= timeout && timeout <= 2.5, \`the CheckGuardrails call carries a \${timeout} s deadline, expected GUARDRAIL_DEADLINE_MS = 2000\`);
  ctx.grpc.setLatency('CheckGuardrails', 30.0);
  r = await ramp({to_percent: 50});
  assert.equal(r.status, 503, \`with the stats service answering after 30 s the ramp answered \${r.status} \${r.text}, expected 503\`);
  assert.equal((await store.get(e)).percent, 25, 'a ramp whose guardrail check timed out moved the traffic');
}

export async function check_fail_closed(ctx) {
  const {store, e, ramp} = await setup(ctx);
  ctx.grpc.fail('CheckGuardrails', ctx.grpc.status.UNAVAILABLE, 'stats is down', 5);
  const r = await ramp({to_percent: 50});
  assert.equal(r.status, 503, \`with the stats service unavailable the ramp answered \${r.status} \${r.text}, expected 503: no verdict is not a pass\`);
  assert.equal((await store.get(e)).percent, 10, 'a ramp without a guardrail verdict moved the traffic');
}

export async function check_pause_on_breach(ctx) {
  const {store, stats, e, ramp} = await setup(ctx);
  stats.breach = {metric: 'error_rate', limit: 0.05, observed: 0.12};
  let r = await ramp({to_percent: 50});
  assert.equal(r.status, 409, \`with error_rate breached the ramp answered \${r.status} \${r.text}, expected 409\`);
  const body = r.json();
  assert(body.status === 'paused' && body.metric === 'error_rate', \`the 409 must say paused and name the metric, got \${r.text}\`);
  assert(body.limit === 0.05 && body.observed === 0.12, \`the 409 must carry the limit and the observed value, got \${r.text}\`);
  let stored = await store.get(e);
  assert.equal(stored.status, 'paused', \`after a breach the experiment is \${stored.status}: the pause must be written, or the next scheduled ramp tries again\`);
  assert.equal(stored.percent, 10, 'a breached ramp moved the traffic');
  stats.breach = null;
  r = await ramp({to_percent: 50});
  assert.equal(r.status, 200, \`once the guardrails are clean the ramp answered \${r.status}: \${r.text}\`);
  stored = await store.get(e);
  assert(stored.percent === 50 && stored.status === 'running', \`a clean ramp must set 50 % and running, the store holds \${JSON.stringify(stored)}\`);
}

export async function check_no_override(ctx) {
  const {store, stats, e, ramp} = await setup(ctx);
  stats.breach = {metric: 'latency_p99_ms', limit: 800, observed: 1450};
  for (const flag of ['skip_guardrails', 'override', 'force']) {
    const r = await ramp({to_percent: 50, [flag]: true});
    assert.equal(r.status, 400, \`a ramp with \${flag} in the body answered \${r.status} \${r.text}, expected 400: the body cannot switch the check off\`);
  }
  assert.equal((await store.get(e)).percent, 10, 'an override moved the traffic while latency is breached');
}
`,
    go: `package main

import (
	"context"
	"net/http"
	"strings"
	"time"

	"google.golang.org/grpc/codes"

	pb "expd/gen/experiments_platform"
	"expd/store"

	"leetbuild/harness"
)

var rampBg = context.Background()

// statsPeer answers clean verdicts unless breach is set.
type statsPeer struct {
	pb.UnimplementedGuardrailsServer
	breach *pb.GuardrailVerdict
}

func (s *statsPeer) CheckGuardrails(_ context.Context, _ *pb.GuardrailRequest) (*pb.GuardrailVerdict, error) {
	if s.breach != nil {
		return s.breach, nil
	}
	return &pb.GuardrailVerdict{}, nil
}

func setup(ctx *harness.Ctx) (*harness.HTTP, *statsPeer, string) {
	peer := &statsPeer{}
	pb.RegisterGuardrailsServer(ctx.GRPC.Server(""), peer)
	e := store.Create(rampBg, store.Design{Name: "cta", Unit: "user", Variants: []store.Variant{{Key: "control", Weight: 50}, {Key: "treatment", Weight: 50}}, MinSample: 1000, Salt: "s-1"}).ID
	store.SetPercent(rampBg, e, 10)
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux), peer, e
}

func rampTo(c *harness.HTTP, e string, body map[string]any) *harness.Response {
	return c.Post("/v1/experiments/"+e+"/ramp", body)
}

func CheckDeadline(ctx *harness.Ctx) {
	c, _, e := setup(ctx)
	r := rampTo(c, e, map[string]any{"to_percent": 25})
	ctx.Equal(r.Status, 200, "a ramp to 25 %% with clean guardrails (%s)", r.Text())
	calls := ctx.GRPC.CallsTo("CheckGuardrails", "")
	ctx.Assert(len(calls) > 0, "the ramp made no CheckGuardrails call")
	call := calls[len(calls)-1]
	ctx.Assert(call.HasDeadline(), "the CheckGuardrails call carries no deadline: a stats service that hangs holds every ramp request open")
	ctx.Assert(1500*time.Millisecond <= call.Timeout && call.Timeout <= 2500*time.Millisecond, "the CheckGuardrails call carries a %v deadline, expected 2 s", call.Timeout)
	ctx.GRPC.SetLatency("CheckGuardrails", 30.0, "")
	r = rampTo(c, e, map[string]any{"to_percent": 50})
	ctx.Equal(r.Status, 503, "with the stats service answering after 30 s the ramp (%s)", r.Text())
	ctx.Equal(store.Get(rampBg, e).Percent, 25, "a ramp whose guardrail check timed out must not move the traffic; the percent")
}

func CheckFailClosed(ctx *harness.Ctx) {
	c, _, e := setup(ctx)
	ctx.GRPC.Fail("CheckGuardrails", codes.Unavailable, "stats is down", 5, "")
	r := rampTo(c, e, map[string]any{"to_percent": 50})
	ctx.Assert(r.Status == 503, "with the stats service unavailable the ramp answered %d %s, expected 503: no verdict is not a pass", r.Status, r.Text())
	ctx.Equal(store.Get(rampBg, e).Percent, 10, "a ramp without a guardrail verdict must not move the traffic; the percent")
}

func CheckPauseOnBreach(ctx *harness.Ctx) {
	c, peer, e := setup(ctx)
	peer.breach = &pb.GuardrailVerdict{Breached: true, Metric: "error_rate", Limit: 0.05, Observed: 0.12}
	r := rampTo(c, e, map[string]any{"to_percent": 50})
	ctx.Equal(r.Status, 409, "with error_rate breached the ramp (%s)", r.Text())
	var body map[string]any
	r.Decode(&body)
	ctx.Assert(body["status"] == "paused" && body["metric"] == "error_rate", "the 409 must say paused and name the metric, got %s", r.Text())
	ctx.Assert(body["limit"] == 0.05 && body["observed"] == 0.12, "the 409 must carry the limit and the observed value, got %s", r.Text())
	stored := store.Get(rampBg, e)
	ctx.Assert(stored.Status == "paused", "after a breach the experiment is %q: the pause must be written, or the next scheduled ramp tries again", stored.Status)
	ctx.Equal(stored.Percent, 10, "a breached ramp must not move the traffic; the percent")
	peer.breach = nil
	r = rampTo(c, e, map[string]any{"to_percent": 50})
	ctx.Equal(r.Status, 200, "once the guardrails are clean the ramp (%s)", r.Text())
	stored = store.Get(rampBg, e)
	ctx.Assert(stored.Percent == 50 && stored.Status == "running", "a clean ramp must set 50 %% and running, the store holds %+v", stored)
}

func CheckNoOverride(ctx *harness.Ctx) {
	c, peer, e := setup(ctx)
	peer.breach = &pb.GuardrailVerdict{Breached: true, Metric: "latency_p99_ms", Limit: 800, Observed: 1450}
	for _, flag := range []string{"skip_guardrails", "override", "force"} {
		r := rampTo(c, e, map[string]any{"to_percent": 50, flag: true})
		ctx.Assert(r.Status == 400, "a ramp with %s in the body answered %d %s, expected 400: the body cannot switch the check off", flag, r.Status, strings.TrimSpace(r.Text()))
	}
	ctx.Equal(store.Get(rampBg, e).Percent, 10, "an override must not move the traffic while latency is breached; the percent")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <optional>
#include <string>

#include "experiments_platform.grpc.pb.h"
#include "expd/store.h"

namespace {

// Clean verdicts unless breach is set.
class StatsPeer final : public expguard::Guardrails::Service {
 public:
  std::optional<expguard::GuardrailVerdict> breach;
  grpc::Status CheckGuardrails(grpc::ServerContext*, const expguard::GuardrailRequest*, expguard::GuardrailVerdict* out) override {
    if (breach) *out = *breach;
    return grpc::Status::OK;
  }
};

expguard::GuardrailVerdict breached(const std::string& metric, double limit, double observed) {
  expguard::GuardrailVerdict v;
  v.set_breached(true);
  v.set_metric(metric);
  v.set_limit(limit);
  v.set_observed(observed);
  return v;
}

struct World {
  StatsPeer stats;
  httplib::Server svr;
};

struct Setup {
  harness::HTTP c;
  StatsPeer& stats;
  std::string e;
};

Setup setup(harness::Ctx& ctx) {
  static World* world = nullptr;
  delete world;
  world = new World;
  ctx.GRPC.Server("")->RegisterService(&world->stats);
  const std::string e = store::create(store::Design{"cta", "user", {{"control", 50}, {"treatment", 50}}, 1000, "s-1"}).id;
  store::setPercent(e, 10);
  register_routes(world->svr);
  return Setup{ctx.HTTP(world->svr), world->stats, e};
}

harness::Response rampTo(Setup& s, const nlohmann::json& body) {
  return s.c.Post("/v1/experiments/" + s.e + "/ramp", body.dump(), "Content-Type", "application/json");
}

}  // namespace

void CheckDeadline(harness::Ctx& ctx) {
  Setup s = setup(ctx);
  auto r = rampTo(s, {{"to_percent", 25}});
  ctx.Equal(r.Status, 200, "a ramp to 25 %% with clean guardrails (%s)", r.Text());
  const auto calls = ctx.GRPC.CallsTo("CheckGuardrails");
  ctx.Assert(!calls.empty(), "the ramp made no CheckGuardrails call");
  ctx.Assert(calls.back().HasDeadline(), "the CheckGuardrails call carries no deadline: a stats service that hangs holds every ramp request open");
  ctx.Assert(1.5 <= calls.back().TimeoutSeconds() && calls.back().TimeoutSeconds() <= 2.5, "the CheckGuardrails call carries a %v s deadline, expected kGuardrailDeadline = 2 s", calls.back().TimeoutSeconds());
  ctx.GRPC.SetLatency("CheckGuardrails", 30.0);
  r = rampTo(s, {{"to_percent", 50}});
  ctx.Equal(r.Status, 503, "with the stats service answering after 30 s the ramp (%s)", r.Text());
  ctx.Equal(store::get(s.e)->percent, 25, "a ramp whose guardrail check timed out must not move the traffic; the percent");
}

void CheckFailClosed(harness::Ctx& ctx) {
  Setup s = setup(ctx);
  ctx.GRPC.Fail("CheckGuardrails", grpc::StatusCode::UNAVAILABLE, "stats is down", 5);
  const auto r = rampTo(s, {{"to_percent", 50}});
  ctx.Assert(r.Status == 503, "with the stats service unavailable the ramp answered %d %s, expected 503: no verdict is not a pass", r.Status, r.Text());
  ctx.Equal(store::get(s.e)->percent, 10, "a ramp without a guardrail verdict must not move the traffic; the percent");
}

void CheckPauseOnBreach(harness::Ctx& ctx) {
  Setup s = setup(ctx);
  s.stats.breach = breached("error_rate", 0.05, 0.12);
  auto r = rampTo(s, {{"to_percent", 50}});
  ctx.Equal(r.Status, 409, "with error_rate breached the ramp (%s)", r.Text());
  const auto body = nlohmann::json::parse(r.Text(), nullptr, false);
  ctx.Assert(body.is_object() && body.value("status", "") == "paused" && body.value("metric", "") == "error_rate", "the 409 must say paused and name the metric, got %s", r.Text());
  ctx.Assert(body.value("limit", 0.0) == 0.05 && body.value("observed", 0.0) == 0.12, "the 409 must carry the limit and the observed value, got %s", r.Text());
  auto stored = store::get(s.e);
  ctx.Assert(stored->status == "paused", "after a breach the experiment is %q: the pause must be written, or the next scheduled ramp tries again", stored->status);
  ctx.Equal(stored->percent, 10, "a breached ramp must not move the traffic; the percent");
  s.stats.breach.reset();
  r = rampTo(s, {{"to_percent", 50}});
  ctx.Equal(r.Status, 200, "once the guardrails are clean the ramp (%s)", r.Text());
  stored = store::get(s.e);
  ctx.Assert(stored->percent == 50 && stored->status == "running", "a clean ramp must set 50 %% and running, the store holds %s", store::toJson(*stored).dump());
}

void CheckNoOverride(harness::Ctx& ctx) {
  Setup s = setup(ctx);
  s.stats.breach = breached("latency_p99_ms", 800, 1450);
  for (const std::string flag : {"skip_guardrails", "override", "force"}) {
    const auto r = rampTo(s, {{"to_percent", 50}, {flag, true}});
    ctx.Assert(r.Status == 400, "a ramp with %s in the body answered %d %s, expected 400: the body cannot switch the check off", flag, r.Status, r.Text());
  }
  ctx.Equal(store::get(s.e)->percent, 10, "an override must not move the traffic while latency is breached; the percent");
}
`,
  },
  hints: [
    'Make the stats service hang and fire a ramp: the request waits as long as it does. Take the service down: the ramp succeeds. Breach a guardrail: the experiment still says running, and the next scheduled ramp tries again.',
    'The call has no deadline, the `except` turns an error into "no verdict" and carries on, the breach branch answers without writing the pause, and `skip_guardrails` jumps straight to `set_percent`.',
    'Pass `timeout=GUARDRAIL_DEADLINE_S` (2.0); on `grpc.RpcError` answer 503; on a breach call `store.set_status(id, "paused")` and answer 409 with metric, limit and observed; answer 400 when the body names any of `OVERRIDE_FIELDS`.',
  ],
  debrief: `A guardrail is only a gate if every path that does not end in a clean verdict leaves the traffic where it was. That is why an RPC error answers 503 instead of falling through: the stats service being down says nothing about the metrics, and ramping blind is how one bad build reaches every user. The deadline bounds how long the scheduler waits, and the pause is written to the store because ramps are driven by a scheduler that will try again; the stored state is what stops it and tells a person which metric breached. Production platforms evaluate guardrails with sequential tests, so a check can run every few minutes without piling up false alarms, and page the experiment owner when a pause lands.`,
};
