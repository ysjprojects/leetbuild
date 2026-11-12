import type {Step} from '@/lib/types';

export const endpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/redteam/runs: registered test targets only',
  concept: 'http',
  guides: ['request-boundaries', 'idempotent-requests'],
  file: 'api',
  focus: ['client', 'runner', 'redis'],
  task: `## Task

**Starting point.** The starter serves \`POST /v1/redteam/runs\` with body \`{"target", "probe_set"}\`: it
answers 401 without \`X-Tenant-Id\`, looks the probe set up in the provided catalog, builds a queued run
whose \`endpoint\` is the \`target\` string as sent, stores it through the provided run store under
\`(tenant, run_id)\` and answers 201. It serves the demo and hides 4 flaws.

**Failure mode the checks target.** A runner points adversarial traffic wherever the run says. A
target the registry has never heard of, or one that is production, must be refused before the run
exists. A probe set the catalog lacks must not quietly become another set, and a client that retries a
slow submission must not start a second run against the same system.

Requirements:

- \`target\` is a name resolved with \`targets.resolve\`: unknown is **400**; a target whose environment is
  \`targets.PRODUCTION\` is **403**. The run's \`endpoint\` comes from the registry.
- \`probe_set\` must be in the catalog (\`catalog.plan\`); unknown is **400**. \`probes\` is the plan's total.
- \`Idempotency-Key\` is required (**400**). The run is stored under \`(tenant, key)\` (\`store.put\`); a
  replay answers **200** with the stored run (\`store.get\`).
- A rejected request stores nothing. A new run answers **201** with \`{run_id, status: "queued",
  target, endpoint, probe_set, plan, probes}\`.`,
  sequence: {
    participants: ['Operator', 'redteamd', 'target registry', 'run store'],
    messages: [
      {from: 'Operator', to: 'redteamd', label: 'POST /v1/redteam/runs · X-Tenant-Id · Idempotency-Key', kind: 'sync'},
      {from: 'redteamd', to: 'target registry', label: 'resolve(target)', kind: 'sync'},
      {from: 'target registry', to: 'redteamd', label: 'endpoint + environment / none', kind: 'reply'},
      {from: 'redteamd', to: 'redteamd', label: '400 unknown · 403 production · 400 probe set', kind: 'sync'},
      {from: 'redteamd', to: 'run store', label: 'get(tenant, key) · put(tenant, key, run)', kind: 'sync'},
      {from: 'redteamd', to: 'Operator', label: '201 {run_id, endpoint, plan, probes}', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Handles POST /v1/redteam/runs',
      detail:
        'The start-a-run route answers 201 with the queued run (run_id, target, endpoint, probe_set, plan, probes) stored in the run store, and 401 without X-Tenant-Id.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/redteam\/runs["']/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/redteam\/runs['"]/]},
        go: {all: [/HandleFunc\(\s*"POST \/v1\/redteam\/runs"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"redteam"\s*\/\s*"runs"\s*\)/, /\bpost\s*\{/]},
        cpp: {all: [/svr\.Post\(\s*"\/v1\/redteam\/runs"/]},
      },
    },
    {
      id: 'resolve-registered-target',
      title: 'Resolves the target through the registry',
      detail:
        'An unregistered target is 400 and stores no run; a registered one gets the endpoint the registry holds. The starter stores the caller’s string as the endpoint, so any host is a valid destination.',
      match: {
        python: {all: [/targets\.resolve\(/], none: [/["']endpoint["']\s*:\s*body\.target/]},
        typescript: {all: [/targets\.resolve\(/], none: [/endpoint:\s*body\.target/]},
        go: {all: [/targets\.Resolve\(/], none: [/Endpoint:\s*body\.Target/]},
        scala: {all: [/Targets\.resolve\(/], none: [/body\.target\s*,\s*body\.target/]},
        cpp: {all: [/targets::resolve\(/], none: [/\{"endpoint",\s*body/]},
      },
    },
    {
      id: 'refuse-production',
      title: 'Refuses a production target',
      detail:
        'A registered target whose environment is production is 403 and stores no run. The starter has no notion of an environment, which is how a red-team run reaches production.',
      match: {
        python: {all: [/targets\.PRODUCTION/, /status_code\s*=\s*403/]},
        typescript: {all: [/targets\.PRODUCTION/, /code\(\s*403\s*\)/]},
        go: {all: [/targets\.Production/, /StatusForbidden/]},
        scala: {all: [/Targets\.Production/, /StatusCodes\.Forbidden/]},
        cpp: {all: [/targets::kProduction/, /\b403\b/]},
      },
    },
    {
      id: 'idempotent-replay',
      title: 'Keys run starts by (tenant, Idempotency-Key)',
      detail:
        'Idempotency-Key is required (400 without it); a replay of the same (tenant, key) answers 200 with the same run_id, and another tenant with the same key gets its own run. The starter stores the run under a fresh id, so every retry starts another run.',
      match: {
        python: {all: [/Idempotency-Key/, /store\.get\(\s*tenant\s*,/, /store\.put\(\s*tenant\s*,\s*idem/]},
        typescript: {all: [/idempotency-key/, /store\.get\(\s*tenant\s*,/, /store\.put\(\s*tenant\s*,\s*idem/]},
        go: {all: [/Idempotency-Key/, /runs\.Get\(/, /runs\.Put\(\s*[\w.()]+,\s*tenant\s*,\s*idem/]},
        scala: {all: [/Idempotency-Key/, /Runs\.get\(\s*tenant\s*,/, /Runs\.put\(\s*tenant\s*,\s*idem/]},
        cpp: {all: [/Idempotency-Key/, /runs::get\(\s*tenant\s*,/, /runs::put\(\s*tenant\s*,\s*idem/]},
      },
    },
    {
      id: 'known-probe-set',
      title: 'Refuses a probe set the catalog lacks',
      detail:
        'An unknown probe_set is 400 and stores no run; a known one carries its plan and total. The starter falls back to the baseline set, so a typo runs ten probes nobody asked for.',
      match: {
        python: {all: [/catalog\.plan\(/], none: [/plan\(\s*["']baseline["']\s*\)/]},
        typescript: {all: [/catalog\.plan\(/], none: [/plan\(\s*["']baseline["']\s*\)/]},
        go: {all: [/catalog\.Plan\(/], none: [/Plan\(\s*"baseline"\s*\)/]},
        scala: {all: [/Catalog\.plan\(/], none: [/plan\(\s*"baseline"\s*\)/]},
        cpp: {all: [/catalog::plan\(/], none: [/plan\(\s*"baseline"\s*\)/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import logging
import uuid

from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from redteam import catalog
from redteam.runs import store

app = FastAPI()
logger = logging.getLogger("redteam")


class RunRequest(BaseModel):
    target: str
    probe_set: str


@app.post("/v1/redteam/runs")
def start_run(body: RunRequest, tenant: str | None = Header(default=None, alias="X-Tenant-Id")) -> JSONResponse:
    # TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
    if tenant is None or tenant == "":
        raise HTTPException(status_code=401, detail="missing X-Tenant-Id")
    plan = catalog.plan(body.probe_set) or catalog.plan("baseline")
    run = {
        "run_id": str(uuid.uuid4()),
        "status": "queued",
        "target": body.target,
        "endpoint": body.target,
        "probe_set": body.probe_set,
        "plan": plan,
        "probes": sum(entry["probes"] for entry in plan),
    }
    store.put(tenant, run["run_id"], run)
    logger.info("redteam run=%s target=%s probes=%d", run["run_id"], body.target, run["probes"])
    return JSONResponse(run, status_code=201)
`,
      solution: `import logging
import uuid

from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from redteam import catalog, targets
from redteam.runs import store

app = FastAPI()
logger = logging.getLogger("redteam")


class RunRequest(BaseModel):
    target: str
    probe_set: str


@app.post("/v1/redteam/runs")
def start_run(
    body: RunRequest,
    tenant: str | None = Header(default=None, alias="X-Tenant-Id"),
    idem_key: str | None = Header(default=None, alias="Idempotency-Key"),
) -> JSONResponse:
    if tenant is None or tenant == "":
        raise HTTPException(status_code=401, detail="missing X-Tenant-Id")
    if idem_key is None or idem_key == "":
        raise HTTPException(status_code=400, detail="Idempotency-Key is required")
    target = targets.resolve(body.target)
    if target is None:
        raise HTTPException(status_code=400, detail="target is not registered")
    if target["environment"] == targets.PRODUCTION:
        raise HTTPException(status_code=403, detail="production targets are refused")
    plan = catalog.plan(body.probe_set)
    if plan is None:
        raise HTTPException(status_code=400, detail="probe_set is not in the catalog")

    stored = store.get(tenant, idem_key)
    if stored is not None:
        return JSONResponse(stored, status_code=200)

    run = {
        "run_id": str(uuid.uuid4()),
        "status": "queued",
        "target": target["name"],
        "endpoint": target["endpoint"],
        "probe_set": body.probe_set,
        "plan": plan,
        "probes": sum(entry["probes"] for entry in plan),
    }
    store.put(tenant, idem_key, run)
    logger.info("redteam run=%s target=%s probes=%d", run["run_id"], target["name"], run["probes"])
    return JSONResponse(run, status_code=201)
`,
    },
    typescript: {
      starter: `import {randomUUID} from 'node:crypto';

import Fastify from 'fastify';

import * as catalog from 'redteam/catalog';
import {type Run, store} from 'redteam/runs';

export const app = Fastify();

interface RunBody {
  target: string;
  probe_set: string;
}

app.post('/v1/redteam/runs', async (request, reply) => {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing X-Tenant-Id'});
  const body = request.body as RunBody;
  const plan = catalog.plan(body.probe_set) ?? catalog.plan('baseline') ?? [];
  const run: Run = {
    run_id: randomUUID(),
    status: 'queued',
    target: body.target,
    endpoint: body.target,
    probe_set: body.probe_set,
    plan,
    probes: plan.reduce((sum, entry) => sum + entry.probes, 0),
  };
  await store.put(tenant, run.run_id, run);
  request.log.info({run_id: run.run_id, target: run.target, probes: run.probes}, 'run queued');
  return reply.code(201).send(run);
});
`,
      solution: `import {randomUUID} from 'node:crypto';

import Fastify from 'fastify';

import * as catalog from 'redteam/catalog';
import {type Run, store} from 'redteam/runs';
import * as targets from 'redteam/targets';

export const app = Fastify();

interface RunBody {
  target: string;
  probe_set: string;
}

app.post('/v1/redteam/runs', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing X-Tenant-Id'});
  const idemKey = request.headers['idempotency-key'];
  if (typeof idemKey !== 'string' || idemKey === '') return reply.code(400).send({error: 'Idempotency-Key is required'});
  const body = (request.body ?? {}) as Partial<RunBody>;
  const target = typeof body.target === 'string' ? targets.resolve(body.target) : null;
  if (target === null) return reply.code(400).send({error: 'target is not registered'});
  if (target.environment === targets.PRODUCTION) return reply.code(403).send({error: 'production targets are refused'});
  const plan = typeof body.probe_set === 'string' ? catalog.plan(body.probe_set) : null;
  if (plan === null) return reply.code(400).send({error: 'probe_set is not in the catalog'});

  const stored = await store.get(tenant, idemKey);
  if (stored !== null) return reply.code(200).send(stored);

  const run: Run = {
    run_id: randomUUID(),
    status: 'queued',
    target: target.name,
    endpoint: target.endpoint,
    probe_set: body.probe_set as string,
    plan,
    probes: plan.reduce((sum, entry) => sum + entry.probes, 0),
  };
  await store.put(tenant, idemKey, run);
  request.log.info({run_id: run.run_id, target: run.target, probes: run.probes}, 'run queued');
  return reply.code(201).send(run);
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"log"
	"net/http"

	"github.com/google/uuid"

	"redteam/catalog" // catalog.Plan(name) — provided
	"redteam/runs"    // runs.Run, runs.Get(ctx, tenant, idemKey), runs.Put(ctx, tenant, idemKey, run) — provided
)

type RunRequest struct {
	Target   string \`json:"target"\`
	ProbeSet string \`json:"probe_set"\`
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func totalProbes(plan []catalog.Planned) int {
	total := 0
	for _, entry := range plan {
		total += entry.Probes
	}
	return total
}

func startRun(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-Tenant-Id"})
		return
	}
	var body RunRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	plan := catalog.Plan(body.ProbeSet)
	if plan == nil {
		plan = catalog.Plan("baseline")
	}
	run := runs.Run{
		RunID:    uuid.NewString(),
		Status:   "queued",
		Target:   body.Target,
		Endpoint: body.Target,
		ProbeSet: body.ProbeSet,
		Plan:     plan,
		Probes:   totalProbes(plan),
	}
	if err := runs.Put(r.Context(), tenant, run.RunID, run); err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	log.Printf("redteam run=%s target=%s probes=%d", run.RunID, run.Target, run.Probes)
	writeJSON(rw, http.StatusCreated, run)
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/redteam/runs", startRun)
}

func main() {
	mux := http.NewServeMux()
	register(mux)
	log.Fatal(http.ListenAndServe(":8443", mux))
}
`,
      solution: `package main

import (
	"encoding/json"
	"log"
	"net/http"

	"github.com/google/uuid"

	"redteam/catalog" // catalog.Plan(name) — provided
	"redteam/runs"    // runs.Run, runs.Get(ctx, tenant, idemKey), runs.Put(ctx, tenant, idemKey, run) — provided
	"redteam/targets" // targets.Resolve(name), targets.Production — provided
)

type RunRequest struct {
	Target   string \`json:"target"\`
	ProbeSet string \`json:"probe_set"\`
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func totalProbes(plan []catalog.Planned) int {
	total := 0
	for _, entry := range plan {
		total += entry.Probes
	}
	return total
}

func startRun(rw http.ResponseWriter, r *http.Request) {
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
	var body RunRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	target, ok := targets.Resolve(body.Target)
	if !ok {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "target is not registered"})
		return
	}
	if target.Environment == targets.Production {
		writeJSON(rw, http.StatusForbidden, map[string]string{"error": "production targets are refused"})
		return
	}
	plan := catalog.Plan(body.ProbeSet)
	if plan == nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "probe_set is not in the catalog"})
		return
	}

	stored, err := runs.Get(r.Context(), tenant, idemKey)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	if stored != nil {
		writeJSON(rw, http.StatusOK, stored)
		return
	}

	run := runs.Run{
		RunID:    uuid.NewString(),
		Status:   "queued",
		Target:   target.Name,
		Endpoint: target.Endpoint,
		ProbeSet: body.ProbeSet,
		Plan:     plan,
		Probes:   totalProbes(plan),
	}
	if err := runs.Put(r.Context(), tenant, idemKey, run); err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	log.Printf("redteam run=%s target=%s probes=%d", run.RunID, run.Target, run.Probes)
	writeJSON(rw, http.StatusCreated, run)
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/redteam/runs", startRun)
}

func main() {
	mux := http.NewServeMux()
	register(mux)
	log.Fatal(http.ListenAndServe(":8443", mux))
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

import redteam.{Catalog, Planned, Run, Runs}

final case class RunRequest(target: String, probe_set: String)

object RedTeamApi {
  implicit val system: ActorSystem = ActorSystem("red-team-runner")
  implicit val requestFormat: RootJsonFormat[RunRequest] = jsonFormat2(RunRequest)
  implicit val plannedFormat: RootJsonFormat[Planned] = jsonFormat2(Planned)
  implicit val runFormat: RootJsonFormat[Run] = jsonFormat7(Run)

  val route: Route =
    path("v1" / "redteam" / "runs") {
      post {
        optionalHeaderValueByName("X-Tenant-Id") { tenantOpt =>
          entity(as[RunRequest]) { body =>
            // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
            if (!tenantOpt.exists(_.nonEmpty)) {
              complete(StatusCodes.Unauthorized, """{"error":"missing X-Tenant-Id"}""")
            } else {
              val tenant = tenantOpt.get
              val plan = Catalog.plan(body.probe_set).orElse(Catalog.plan("baseline")).getOrElse(Nil)
              val run = Run(UUID.randomUUID().toString, "queued", body.target, body.target, body.probe_set, plan, plan.map(_.probes).sum)
              Runs.put(tenant, run.run_id, run)
              system.log.info(s"redteam run=\${run.run_id} target=\${run.target} probes=\${run.probes}")
              complete(StatusCodes.Created, run)
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
      solution: `import java.util.UUID

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

import redteam.{Catalog, Planned, Run, Runs, Targets}

final case class RunRequest(target: String, probe_set: String)

object RedTeamApi {
  implicit val system: ActorSystem = ActorSystem("red-team-runner")
  implicit val requestFormat: RootJsonFormat[RunRequest] = jsonFormat2(RunRequest)
  implicit val plannedFormat: RootJsonFormat[Planned] = jsonFormat2(Planned)
  implicit val runFormat: RootJsonFormat[Run] = jsonFormat7(Run)

  def startRun(tenant: String, idemKey: String, body: RunRequest): Route =
    Targets.resolve(body.target) match {
      case None =>
        complete(StatusCodes.BadRequest, """{"error":"target is not registered"}""")
      case Some(target) if target.environment == Targets.Production =>
        complete(StatusCodes.Forbidden, """{"error":"production targets are refused"}""")
      case Some(target) =>
        Catalog.plan(body.probe_set) match {
          case None =>
            complete(StatusCodes.BadRequest, """{"error":"probe_set is not in the catalog"}""")
          case Some(plan) =>
            Runs.get(tenant, idemKey) match {
              case Some(stored) =>
                complete(StatusCodes.OK, stored.run)
              case None =>
                val run = Run(UUID.randomUUID().toString, "queued", target.name, target.endpoint, body.probe_set, plan, plan.map(_.probes).sum)
                Runs.put(tenant, idemKey, run)
                system.log.info(s"redteam run=\${run.run_id} target=\${run.target} probes=\${run.probes}")
                complete(StatusCodes.Created, run)
            }
        }
    }

  val route: Route =
    path("v1" / "redteam" / "runs") {
      post {
        optionalHeaderValueByName("X-Tenant-Id") { tenantOpt =>
          optionalHeaderValueByName("Idempotency-Key") { idemOpt =>
            entity(as[RunRequest]) { body =>
              if (!tenantOpt.exists(_.nonEmpty)) {
                complete(StatusCodes.Unauthorized, """{"error":"missing X-Tenant-Id"}""")
              } else if (!idemOpt.exists(_.nonEmpty)) {
                complete(StatusCodes.BadRequest, """{"error":"Idempotency-Key is required"}""")
              } else {
                startRun(tenantOpt.get, idemOpt.get, body)
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

#include "ids.h"              // new_uuid() — provided
#include "redteam/catalog.h"  // catalog::plan(name) — provided
#include "redteam/runs.h"     // runs::get(tenant, idem_key), runs::put(tenant, idem_key, run) — provided

using json = nlohmann::json;

int total_probes(const json& plan) {
  int total = 0;
  for (const auto& entry : plan) total += entry.value("probes", 0);
  return total;
}

void start_run(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) {
    res.status = 401;
    res.set_content(R"({"error":"missing X-Tenant-Id"})", "application/json");
    return;
  }
  const json body = json::parse(req.body, nullptr, false);
  if (!body.is_object()) {
    res.status = 400;
    res.set_content(R"({"error":"invalid json"})", "application/json");
    return;
  }
  const std::string probe_set = body.value("probe_set", std::string());
  const json plan = catalog::plan(probe_set).value_or(*catalog::plan("baseline"));
  const json run = {
      {"run_id", new_uuid()},
      {"status", "queued"},
      {"target", body.value("target", std::string())},
      {"endpoint", body.value("target", std::string())},
      {"probe_set", probe_set},
      {"plan", plan},
      {"probes", total_probes(plan)},
  };
  runs::put(tenant, run["run_id"].get<std::string>(), run);
  std::cerr << "redteam run=" << run["run_id"] << " target=" << run["target"] << "\\n";
  res.status = 201;
  res.set_content(run.dump(), "application/json");
}

void register_routes(httplib::Server& svr) { svr.Post("/v1/redteam/runs", start_run); }

int main() {
  httplib::Server svr;
  register_routes(svr);
  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <iostream>
#include <string>

#include "ids.h"              // new_uuid() — provided
#include "redteam/catalog.h"  // catalog::plan(name) — provided
#include "redteam/runs.h"     // runs::get(tenant, idem_key), runs::put(tenant, idem_key, run) — provided
#include "redteam/targets.h"  // targets::resolve(name), targets::kProduction — provided

using json = nlohmann::json;

int total_probes(const json& plan) {
  int total = 0;
  for (const auto& entry : plan) total += entry.value("probes", 0);
  return total;
}

void reject(httplib::Response& res, int status, const std::string& error) {
  res.status = status;
  res.set_content(json({{"error", error}}).dump(), "application/json");
}

void start_run(const httplib::Request& req, httplib::Response& res) {
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) return reject(res, 401, "missing X-Tenant-Id");
  const std::string idem_key = req.get_header_value("Idempotency-Key");
  if (idem_key.empty()) return reject(res, 400, "Idempotency-Key is required");
  const json body = json::parse(req.body, nullptr, false);
  if (!body.is_object() || !body.contains("target") || !body["target"].is_string()) return reject(res, 400, "target is not registered");
  const auto target = targets::resolve(body["target"].get<std::string>());
  if (!target) return reject(res, 400, "target is not registered");
  if (target->environment == targets::kProduction) return reject(res, 403, "production targets are refused");
  const std::string probe_set = body.contains("probe_set") && body["probe_set"].is_string() ? body["probe_set"].get<std::string>() : "";
  const auto plan = catalog::plan(probe_set);
  if (!plan) return reject(res, 400, "probe_set is not in the catalog");

  if (const auto stored = runs::get(tenant, idem_key)) {
    res.status = 200;
    res.set_content(stored->dump(), "application/json");
    return;
  }
  const json run = {
      {"run_id", new_uuid()},
      {"status", "queued"},
      {"target", target->name},
      {"endpoint", target->endpoint},
      {"probe_set", probe_set},
      {"plan", *plan},
      {"probes", total_probes(*plan)},
  };
  runs::put(tenant, idem_key, run);
  std::cerr << "redteam run=" << run["run_id"] << " target=" << target->name << "\\n";
  res.status = 201;
  res.set_content(run.dump(), "application/json");
}

void register_routes(httplib::Server& svr) { svr.Post("/v1/redteam/runs", start_run); }

int main() {
  httplib::Server svr;
  register_routes(svr);
  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  harness: {
    python: `import json

GOOD = {"target": "checkout-shadow", "probe_set": "baseline"}
FIELDS = ("run_id", "status", "target", "endpoint", "probe_set", "plan", "probes")


def _api(ctx):
    m = ctx.load("api")
    return ctx.client(m.app)


async def _post(c, body, key="k-1", tenant="t1", with_key=True):
    headers = {"X-Tenant-Id": tenant}
    if with_key:
        headers["Idempotency-Key"] = key
    return await c.post("/v1/redteam/runs", json=body, headers=headers)


def _runs(ctx):
    return ctx.redis.keys("redteam:run:*")


async def check_route(ctx):
    async with _api(ctx) as c:
        r = await _post(c, GOOD)
        assert r.status_code == 201, f"a valid start answered {r.status_code}: {r.text}"
        run = r.json()
        for key in FIELDS:
            assert key in run, f"the 201 body lacks {key!r}: {run}"
        assert run["status"] == "queued" and run["target"] == "checkout-shadow" and run["probe_set"] == "baseline", f"the run echoes the request with status queued: {run}"
        assert run["probes"] == 10, f"the baseline set plans 10 probes, the run says {run['probes']}"
        raw = ctx.redis.get(f"redteam:run:{run['run_id']}")
        assert raw is not None, f"the run {run['run_id']} must be in the run store (redteam:run:{{id}}): keys {sorted(ctx.redis.keys('redteam:*'))}"
        r = await c.post("/v1/redteam/runs", json=GOOD, headers={"Idempotency-Key": "k-1"})
        assert r.status_code == 401, f"without X-Tenant-Id the start must answer 401, got {r.status_code}"


async def check_resolve_registered_target(ctx):
    async with _api(ctx) as c:
        r = await _post(c, {**GOOD, "target": "billing-db.internal:5432"}, key="k-bad")
        assert r.status_code == 400, f"a target nobody registered (billing-db.internal:5432) answered {r.status_code}, expected 400: the runner would point probes at whatever host the caller typed"
        assert _runs(ctx) == [], f"a refused start must store no run, found {_runs(ctx)}"
        r = await _post(c, {**GOOD, "target": "search-staging"}, key="k-ok")
        assert r.status_code == 201, f"search-staging is registered, got {r.status_code}: {r.text}"
        endpoint = r.json().get("endpoint")
        assert endpoint == "search-staging.sandbox.internal", f"the run's endpoint must be the registry's (search-staging.sandbox.internal), got {endpoint!r}: the caller names a target, the registry says where it lives"


async def check_refuse_production(ctx):
    async with _api(ctx) as c:
        r = await _post(c, {**GOOD, "target": "payments-prod"}, key="k-prod")
        assert r.status_code == 403, f"payments-prod is registered with environment production and answered {r.status_code}, expected 403"
        assert _runs(ctx) == [], f"a refused production target must store no run, found {[json.loads(ctx.redis.get(k)) for k in _runs(ctx)]}"
        r = await _post(c, {**GOOD, "target": "checkout-shadow"}, key="k-shadow")
        assert r.status_code == 201, f"a shadow target is fine, got {r.status_code}: {r.text}"


async def check_idempotent_replay(ctx):
    async with _api(ctx) as c:
        r = await _post(c, GOOD, with_key=False)
        assert r.status_code == 400, f"a start without Idempotency-Key answered {r.status_code}, expected 400"
        first = await _post(c, GOOD, key="k-7")
        assert first.status_code == 201, f"the first start answered {first.status_code}: {first.text}"
        replay = await _post(c, GOOD, key="k-7")
        assert replay.status_code == 200, f"a replay of the same (tenant, Idempotency-Key) answered {replay.status_code}, expected 200 with the stored run (the client retried; it must not start a second run against the target)"
        assert replay.json()["run_id"] == first.json()["run_id"], f"the replay must answer the same run: got {replay.json()['run_id']}, the first start made {first.json()['run_id']}"
        assert len(_runs(ctx)) == 1, f"one key, one run: the store holds {len(_runs(ctx))} runs after a start and its replay"
        other = await _post(c, GOOD, key="k-7", tenant="t2")
        assert other.status_code == 201 and other.json()["run_id"] != first.json()["run_id"], "another tenant reusing the key gets its own run (keys are per tenant)"


async def check_known_probe_set(ctx):
    async with _api(ctx) as c:
        r = await _post(c, {**GOOD, "probe_set": "everything"}, key="k-bad")
        assert r.status_code == 400, f"a probe set the catalog lacks (everything) answered {r.status_code}, expected 400: it must not turn into another set"
        assert _runs(ctx) == [], f"a refused probe set must store no run, found {_runs(ctx)}"
        r = await _post(c, {**GOOD, "probe_set": "injection-only"}, key="k-inj")
        assert r.status_code == 201, f"injection-only is in the catalog, got {r.status_code}: {r.text}"
        run = r.json()
        assert run["plan"] == [{"category": "prompt-injection", "probes": 6}] and run["probes"] == 6, f"the run carries the catalog's plan for injection-only (6 prompt-injection probes): {run}"
`,
    typescript: `const GOOD = {target: 'checkout-shadow', probe_set: 'baseline'};
const FIELDS = ['run_id', 'status', 'target', 'endpoint', 'probe_set', 'plan', 'probes'];

function api(ctx) {
  const m = ctx.load('api');
  return ctx.client(m.app);
}

async function post(c, body, {key = 'k-1', tenant = 't1', withKey = true} = {}) {
  const headers: Record<string, string> = {'X-Tenant-Id': tenant};
  if (withKey) headers['Idempotency-Key'] = key;
  return c.post('/v1/redteam/runs', {body, headers});
}

const runKeys = ctx => ctx.redis.keys('redteam:run:*');

export async function check_route(ctx) {
  const c = api(ctx);
  const r = await post(c, GOOD);
  assert.equal(r.status, 201, \`a valid start answered \${r.status}: \${r.text}\`);
  const run = r.json();
  for (const key of FIELDS) assert(key in run, \`the 201 body lacks \${key}: \${r.text}\`);
  assert(run.status === 'queued' && run.target === 'checkout-shadow' && run.probe_set === 'baseline', \`the run echoes the request with status queued: \${r.text}\`);
  assert.equal(run.probes, 10, \`the baseline set plans 10 probes, the run says \${run.probes}\`);
  assert(ctx.redis.get(\`redteam:run:\${run.run_id}\`) !== null, \`the run \${run.run_id} must be in the run store (redteam:run:{id}): keys \${JSON.stringify(ctx.redis.keys('redteam:*').sort())}\`);
  const noTenant = await c.post('/v1/redteam/runs', {body: GOOD, headers: {'Idempotency-Key': 'k-1'}});
  assert.equal(noTenant.status, 401, \`without X-Tenant-Id the start must answer 401, got \${noTenant.status}\`);
}

export async function check_resolve_registered_target(ctx) {
  const c = api(ctx);
  let r = await post(c, {...GOOD, target: 'billing-db.internal:5432'}, {key: 'k-bad'});
  assert.equal(r.status, 400, \`a target nobody registered (billing-db.internal:5432) answered \${r.status}, expected 400: the runner would point probes at whatever host the caller typed\`);
  assert.deepEqual(runKeys(ctx), [], \`a refused start must store no run, found \${JSON.stringify(runKeys(ctx))}\`);
  r = await post(c, {...GOOD, target: 'search-staging'}, {key: 'k-ok'});
  assert.equal(r.status, 201, \`search-staging is registered, got \${r.status}: \${r.text}\`);
  assert.equal(r.json().endpoint, 'search-staging.sandbox.internal', \`the run's endpoint must be the registry's (search-staging.sandbox.internal), got \${JSON.stringify(r.json().endpoint)}: the caller names a target, the registry says where it lives\`);
}

export async function check_refuse_production(ctx) {
  const c = api(ctx);
  let r = await post(c, {...GOOD, target: 'payments-prod'}, {key: 'k-prod'});
  assert.equal(r.status, 403, \`payments-prod is registered with environment production and answered \${r.status}, expected 403\`);
  assert.deepEqual(runKeys(ctx), [], \`a refused production target must store no run, found \${JSON.stringify(runKeys(ctx))}\`);
  r = await post(c, {...GOOD, target: 'checkout-shadow'}, {key: 'k-shadow'});
  assert.equal(r.status, 201, \`a shadow target is fine, got \${r.status}: \${r.text}\`);
}

export async function check_idempotent_replay(ctx) {
  const c = api(ctx);
  const noKey = await post(c, GOOD, {withKey: false});
  assert.equal(noKey.status, 400, \`a start without Idempotency-Key answered \${noKey.status}, expected 400\`);
  const first = await post(c, GOOD, {key: 'k-7'});
  assert.equal(first.status, 201, \`the first start answered \${first.status}: \${first.text}\`);
  const replay = await post(c, GOOD, {key: 'k-7'});
  assert.equal(replay.status, 200, \`a replay of the same (tenant, Idempotency-Key) answered \${replay.status}, expected 200 with the stored run (the client retried; it must not start a second run against the target)\`);
  assert.equal(replay.json().run_id, first.json().run_id, \`the replay must answer the same run: got \${replay.json().run_id}, the first start made \${first.json().run_id}\`);
  assert.equal(runKeys(ctx).length, 1, \`one key, one run: the store holds \${runKeys(ctx).length} runs after a start and its replay\`);
  const other = await post(c, GOOD, {key: 'k-7', tenant: 't2'});
  assert(other.status === 201 && other.json().run_id !== first.json().run_id, 'another tenant reusing the key gets its own run (keys are per tenant)');
}

export async function check_known_probe_set(ctx) {
  const c = api(ctx);
  let r = await post(c, {...GOOD, probe_set: 'everything'}, {key: 'k-bad'});
  assert.equal(r.status, 400, \`a probe set the catalog lacks (everything) answered \${r.status}, expected 400: it must not turn into another set\`);
  assert.deepEqual(runKeys(ctx), [], \`a refused probe set must store no run, found \${JSON.stringify(runKeys(ctx))}\`);
  r = await post(c, {...GOOD, probe_set: 'injection-only'}, {key: 'k-inj'});
  assert.equal(r.status, 201, \`injection-only is in the catalog, got \${r.status}: \${r.text}\`);
  const run = r.json();
  assert(JSON.stringify(run.plan) === JSON.stringify([{category: 'prompt-injection', probes: 6}]) && run.probes === 6, \`the run carries the catalog's plan for injection-only (6 prompt-injection probes): \${r.text}\`);
}
`,
    go: `package main

import (
	"net/http"

	"leetbuild/harness"
)

var apiGood = map[string]any{"target": "checkout-shadow", "probe_set": "baseline"}

func apiClient(ctx *harness.Ctx) *harness.HTTP {
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

func apiWith(field string, value any) map[string]any {
	out := map[string]any{}
	for k, v := range apiGood {
		out[k] = v
	}
	out[field] = value
	return out
}

func apiPost(c *harness.HTTP, body map[string]any, key, tenant string) *harness.Response {
	return c.Post("/v1/redteam/runs", body, "X-Tenant-Id", tenant, "Idempotency-Key", key)
}

func apiRun(ctx *harness.Ctx, r *harness.Response) map[string]any {
	run, ok := r.JSON().(map[string]any)
	ctx.Assert(ok, "the body must be a JSON object: %s", r.Text())
	return run
}

func CheckRoute(ctx *harness.Ctx) {
	c := apiClient(ctx)
	r := apiPost(c, apiGood, "k-1", "t1")
	ctx.Equal(r.Status, 201, "a valid start (%s)", r.Text())
	run := apiRun(ctx, r)
	for _, key := range []string{"run_id", "status", "target", "endpoint", "probe_set", "plan", "probes"} {
		_, ok := run[key]
		ctx.Assert(ok, "the 201 body lacks %s: %s", key, r.Text())
	}
	ctx.Assert(run["status"] == "queued" && run["target"] == "checkout-shadow" && run["probe_set"] == "baseline", "the run echoes the request with status queued: %s", r.Text())
	ctx.Equal(run["probes"], float64(10), "the baseline set plans 10 probes; the run's probes")
	id, _ := run["run_id"].(string)
	_, stored := ctx.Redis.Get("redteam:run:" + id)
	ctx.Assert(stored, "the run %s must be in the run store (redteam:run:{id}): keys %v", id, ctx.Redis.Keys("redteam:*"))
	noTenant := c.Post("/v1/redteam/runs", apiGood, "Idempotency-Key", "k-1")
	ctx.Equal(noTenant.Status, 401, "without X-Tenant-Id the start")
}

func CheckResolveRegisteredTarget(ctx *harness.Ctx) {
	c := apiClient(ctx)
	r := apiPost(c, apiWith("target", "billing-db.internal:5432"), "k-bad", "t1")
	ctx.Equal(r.Status, 400, "a target nobody registered (billing-db.internal:5432): the runner would point probes at whatever host the caller typed")
	ctx.Equal(len(ctx.Redis.Keys("redteam:run:*")), 0, "a refused start must store no run; runs stored")
	r = apiPost(c, apiWith("target", "search-staging"), "k-ok", "t1")
	ctx.Equal(r.Status, 201, "search-staging is registered (%s)", r.Text())
	ctx.Equal(apiRun(ctx, r)["endpoint"], "search-staging.sandbox.internal", "the caller names a target, the registry says where it lives; the run's endpoint")
}

func CheckRefuseProduction(ctx *harness.Ctx) {
	c := apiClient(ctx)
	r := apiPost(c, apiWith("target", "payments-prod"), "k-prod", "t1")
	ctx.Equal(r.Status, 403, "payments-prod is registered with environment production")
	ctx.Equal(len(ctx.Redis.Keys("redteam:run:*")), 0, "a refused production target must store no run; runs stored")
	r = apiPost(c, apiWith("target", "checkout-shadow"), "k-shadow", "t1")
	ctx.Equal(r.Status, 201, "a shadow target is fine (%s)", r.Text())
}

func CheckIdempotentReplay(ctx *harness.Ctx) {
	c := apiClient(ctx)
	noKey := c.Post("/v1/redteam/runs", apiGood, "X-Tenant-Id", "t1")
	ctx.Equal(noKey.Status, 400, "a start without Idempotency-Key")
	first := apiPost(c, apiGood, "k-7", "t1")
	ctx.Equal(first.Status, 201, "the first start (%s)", first.Text())
	replay := apiPost(c, apiGood, "k-7", "t1")
	ctx.Equal(replay.Status, 200, "a replay of the same (tenant, Idempotency-Key) must answer the stored run (the client retried; it must not start a second run against the target)")
	ctx.Equal(apiRun(ctx, replay)["run_id"], apiRun(ctx, first)["run_id"], "the replay must answer the same run")
	ctx.Equal(len(ctx.Redis.Keys("redteam:run:*")), 1, "one key, one run: runs stored after a start and its replay")
	other := apiPost(c, apiGood, "k-7", "t2")
	ctx.Assert(other.Status == 201 && apiRun(ctx, other)["run_id"] != apiRun(ctx, first)["run_id"], "another tenant reusing the key gets its own run (keys are per tenant)")
}

func CheckKnownProbeSet(ctx *harness.Ctx) {
	c := apiClient(ctx)
	r := apiPost(c, apiWith("probe_set", "everything"), "k-bad", "t1")
	ctx.Equal(r.Status, 400, "a probe set the catalog lacks (everything) must not turn into another set")
	ctx.Equal(len(ctx.Redis.Keys("redteam:run:*")), 0, "a refused probe set must store no run; runs stored")
	r = apiPost(c, apiWith("probe_set", "injection-only"), "k-inj", "t1")
	ctx.Equal(r.Status, 201, "injection-only is in the catalog (%s)", r.Text())
	run := apiRun(ctx, r)
	ctx.Equal(run["plan"], []any{map[string]any{"category": "prompt-injection", "probes": float64(6)}}, "the run carries the catalog's plan for injection-only")
	ctx.Equal(run["probes"], float64(6), "injection-only plans 6 probes; the run's probes")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <string>

namespace {

using json = nlohmann::json;

const json kGood = {{"target", "checkout-shadow"}, {"probe_set", "baseline"}};

struct Api {
  httplib::Server svr;
  harness::HTTP http;
  explicit Api(harness::Ctx& ctx) : http(ctx.HTTP(svr)) { register_routes(svr); }

  harness::Response post(const json& body, const std::string& key = "k-1", const std::string& tenant = "t1") {
    return http.Post("/v1/redteam/runs", body.dump(), "X-Tenant-Id", tenant, "Idempotency-Key", key);
  }
};

json with(json body, const std::string& field, const json& value) {
  body[field] = value;
  return body;
}

json runOf(harness::Ctx& ctx, const harness::Response& r) {
  const json run = json::parse(r.Text(), nullptr, false);
  ctx.Assert(run.is_object(), "the body must be a JSON object: %s", r.Text());
  return run;
}

}  // namespace

void CheckRoute(harness::Ctx& ctx) {
  Api api(ctx);
  const auto r = api.post(kGood);
  ctx.Equal(r.Status, 201, "a valid start (%s)", r.Text());
  const json run = runOf(ctx, r);
  for (const char* key : {"run_id", "status", "target", "endpoint", "probe_set", "plan", "probes"}) {
    ctx.Assert(run.contains(key), "the 201 body lacks %s: %s", key, r.Text());
  }
  ctx.Assert(run["status"] == "queued" && run["target"] == "checkout-shadow" && run["probe_set"] == "baseline", "the run echoes the request with status queued: %s", r.Text());
  ctx.Assert(run["probes"] == 10, "the baseline set plans 10 probes, the run says %s", run["probes"].dump());
  const std::string id = run["run_id"].is_string() ? run["run_id"].get<std::string>() : "";
  ctx.Assert(ctx.Redis.Get("redteam:run:" + id).has_value(), "the run %s must be in the run store (redteam:run:{id}): keys %v", id, ctx.Redis.Keys("redteam:*"));
  const auto noTenant = api.http.Post("/v1/redteam/runs", kGood.dump(), "Idempotency-Key", "k-1");
  ctx.Equal(noTenant.Status, 401, "without X-Tenant-Id the start");
}

void CheckResolveRegisteredTarget(harness::Ctx& ctx) {
  Api api(ctx);
  auto r = api.post(with(kGood, "target", "billing-db.internal:5432"), "k-bad");
  ctx.Equal(r.Status, 400, "a target nobody registered (billing-db.internal:5432): the runner would point probes at whatever host the caller typed");
  ctx.Equal(ctx.Redis.Keys("redteam:run:*").size(), 0, "a refused start must store no run; runs stored");
  r = api.post(with(kGood, "target", "search-staging"), "k-ok");
  ctx.Equal(r.Status, 201, "search-staging is registered (%s)", r.Text());
  ctx.Assert(runOf(ctx, r).value("endpoint", "") == "search-staging.sandbox.internal", "the run's endpoint must be the registry's (search-staging.sandbox.internal): the caller names a target, the registry says where it lives (%s)", r.Text());
}

void CheckRefuseProduction(harness::Ctx& ctx) {
  Api api(ctx);
  auto r = api.post(with(kGood, "target", "payments-prod"), "k-prod");
  ctx.Equal(r.Status, 403, "payments-prod is registered with environment production");
  ctx.Equal(ctx.Redis.Keys("redteam:run:*").size(), 0, "a refused production target must store no run; runs stored");
  r = api.post(with(kGood, "target", "checkout-shadow"), "k-shadow");
  ctx.Equal(r.Status, 201, "a shadow target is fine (%s)", r.Text());
}

void CheckIdempotentReplay(harness::Ctx& ctx) {
  Api api(ctx);
  const auto noKey = api.http.Post("/v1/redteam/runs", kGood.dump(), "X-Tenant-Id", "t1");
  ctx.Equal(noKey.Status, 400, "a start without Idempotency-Key");
  const auto first = api.post(kGood, "k-7");
  ctx.Equal(first.Status, 201, "the first start (%s)", first.Text());
  const auto replay = api.post(kGood, "k-7");
  ctx.Equal(replay.Status, 200, "a replay of the same (tenant, Idempotency-Key) must answer the stored run (the client retried; it must not start a second run against the target)");
  ctx.Equal(runOf(ctx, replay)["run_id"], runOf(ctx, first)["run_id"], "the replay must answer the same run");
  ctx.Equal(ctx.Redis.Keys("redteam:run:*").size(), 1, "one key, one run: runs stored after a start and its replay");
  const auto other = api.post(kGood, "k-7", "t2");
  ctx.Assert(other.Status == 201 && runOf(ctx, other)["run_id"] != runOf(ctx, first)["run_id"], "another tenant reusing the key gets its own run (keys are per tenant)");
}

void CheckKnownProbeSet(harness::Ctx& ctx) {
  Api api(ctx);
  auto r = api.post(with(kGood, "probe_set", "everything"), "k-bad");
  ctx.Equal(r.Status, 400, "a probe set the catalog lacks (everything) must not turn into another set");
  ctx.Equal(ctx.Redis.Keys("redteam:run:*").size(), 0, "a refused probe set must store no run; runs stored");
  r = api.post(with(kGood, "probe_set", "injection-only"), "k-inj");
  ctx.Equal(r.Status, 201, "injection-only is in the catalog (%s)", r.Text());
  const json run = runOf(ctx, r);
  ctx.Assert(run["plan"] == json::array({{{"category", "prompt-injection"}, {"probes", 6}}}) && run["probes"] == 6,
             "the run carries the catalog's plan for injection-only (6 prompt-injection probes): %s", r.Text());
}
`,
  },
  hints: [
    'Symptom: a run aimed at a hostname nobody registered is accepted, a run against payments-prod is queued, a typo in the probe set runs ten probes anyway, and a retried submission starts a second run.',
    'Mechanism: the handler copies `body.target` into `endpoint` without asking the registry, never reads an environment, falls back to the baseline plan when the catalog has no match, and stores the run under its own fresh id.',
    'Change: guards in order (tenant 401, Idempotency-Key 400, `targets.resolve` 400, environment `PRODUCTION` 403, `catalog.plan` 400), then `store.get(tenant, key)` answers 200 on a hit; `store.put(tenant, key, run)` with the registry endpoint.',
  ],
  debrief: `Every decision happens before the run exists, because a stored run is work a runner will pick up. The registry turns the caller's string into a record the platform owns, so a hostname is not an input and the environment test sits next to that lookup; refusing production at submission is cheaper than trusting every runner to check. Refusing an unknown probe set rather than substituting one keeps the run's plan equal to what the operator asked for, which step 5's report depends on. Keying by \`(tenant, Idempotency-Key)\` turns a retry into a read. Hosted red-team platforms usually go further: a target is registered with an owner who must approve each run, and the approval names a time window.`,
};
