import type {Step} from '@/lib/types';

export const endpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/redteam/runs: probes against test targets only',
  concept: 'http',
  file: 'api',
  focus: ['client', 'runner', 'db', 'sandbox'],
  task: `## Task

**Starting point.** The starter serves \`POST /v1/redteam/runs\` with body
\`{"target": "checkout-shadow", "probe_set": "prompt-injection"}\`: it reads the tenant header, looks
up the probe count, calls \`dispatch\` at the \`target\` string as written, and answers **202** with a
fresh \`uuid4\` run id. It serves the demo against one sandbox host and hides four flaws.

**Failure mode the checks target.** \`dispatch\` is called at whatever the caller typed into
\`target\`, so a typo points the whole probe set at a host nobody registered. No environment is
checked, so a production endpoint is a valid destination. Nothing is validated before \`dispatch\`
runs, so even a rejection would arrive with probes in flight. And \`Idempotency-Key\` is ignored, so
every client retry starts a new run and doubles the adversarial traffic.

- The tenant comes from \`X-Tenant-Id\`; a missing tenant is **401**.
- \`Idempotency-Key\` is required (**400** when missing). A replay with the same \`(tenant, key)\`
  returns the existing run (**200**) instead of starting a second one.
- \`target\` is a name, not a URL, resolved through \`TARGET_REGISTRY\`: an unregistered name is
  **400** and no probe is sent.
- A target whose \`environment\` is in \`PRODUCTION_ENVIRONMENTS\` is refused with **403** and no
  probe is sent.
- \`probe_set\` selects one of the platform's probe sets; the probe count is looked up server-side.
- Only after both checks pass does the run get an id and its probe set dispatched to the sandbox
  endpoint that hosts the target (**201**).`,
  sequence: {
    participants: ['Operator', 'Red Team Runner', 'target registry', 'probe sandbox'],
    messages: [
      {
        from: 'Operator',
        to: 'Red Team Runner',
        label: 'POST /v1/redteam/runs · X-Tenant-Id · Idempotency-Key',
        kind: 'sync',
      },
      {from: 'Red Team Runner', to: 'target registry', label: 'resolve(target)', kind: 'sync'},
      {from: 'target registry', to: 'Red Team Runner', label: 'endpoint + environment / none', kind: 'reply'},
      {from: 'Red Team Runner', to: 'Red Team Runner', label: '400 unknown · 403 production', kind: 'sync'},
      {from: 'Red Team Runner', to: 'probe sandbox', label: 'dispatch(probe_set)', kind: 'async'},
      {from: 'Red Team Runner', to: 'Operator', label: '201 {run_id, endpoint, probes}', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Handles POST /v1/redteam/runs',
      detail: 'Register the run-creation route on `POST /v1/redteam/runs`.',
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
        '`target` is looked up in `TARGET_REGISTRY` and an unknown name is **400** before anything is dispatched. The starter sends the caller’s string straight at the network, so no unregistered host is ever rejected.',
      match: {
        python: {all: [/TARGET_REGISTRY/, /resolve_target\(/, /status_code\s*=\s*400/]},
        typescript: {all: [/TARGET_REGISTRY/, /resolveTarget\(/, /code\(\s*400\s*\)/]},
        go: {all: [/targetRegistry/, /resolveTarget\(/, /StatusBadRequest/]},
        scala: {all: [/TargetRegistry/, /resolveTarget\(/, /StatusCodes\.BadRequest/]},
        cpp: {all: [/kTargetRegistry/, /resolveTarget\(/, /\b400\b/]},
      },
    },
    {
      id: 'refuse-production',
      title: 'Refuses a production target',
      detail:
        'A target whose environment is in `PRODUCTION_ENVIRONMENTS` is **403** and is never dispatched. The starter has no notion of an environment at all, which is how a red-team run reaches production.',
      match: {
        python: {all: [/PRODUCTION_ENVIRONMENTS/, /status_code\s*=\s*403/]},
        typescript: {all: [/PRODUCTION_ENVIRONMENTS/, /code\(\s*403\s*\)/]},
        go: {all: [/productionEnvironments/, /StatusForbidden/]},
        scala: {all: [/ProductionEnvironments/, /StatusCodes\.Forbidden/]},
        cpp: {all: [/kProductionEnvironments/, /\b403\b/]},
      },
    },
    {
      id: 'resolve-before-dispatch',
      title: 'Validates before any probe is sent',
      detail:
        'The registry lookup happens before the probe set is dispatched, so an unregistered or production target can never have probes in flight. A check that runs after `dispatch` is a log line, not a control.',
      match: {
        python: {order: [/resolve_target\(/, /dispatch\(/]},
        typescript: {order: [/resolveTarget\(/, /dispatch\(/]},
        go: {order: [/resolveTarget\(/, /dispatch\(/]},
        scala: {order: [/resolveTarget\(/, /dispatch\(/]},
        cpp: {order: [/resolveTarget\(/, /dispatch\(/]},
      },
    },
    {
      id: 'idempotent-replay',
      title: 'Keys retries by (tenant, Idempotency-Key)',
      detail:
        '`Idempotency-Key` is required and the run is stored under `(tenant, key)`; a replay returns the existing run instead of dispatching the probe set a second time. The starter ignores the header entirely.',
      match: {
        python: {all: [/Idempotency-Key/, /run_store\.get\(/, /run_store\.put\(/]},
        typescript: {all: [/idempotency-key/, /runStore\.get\(/, /runStore\.put\(/]},
        go: {all: [/Idempotency-Key/, /runStore\.Get\(/, /runStore\.Put\(/]},
        scala: {all: [/Idempotency-Key/, /runStore\.get\(/, /runStore\.put\(/]},
        cpp: {all: [/Idempotency-Key/, /runStore\.get\(/, /runStore\.put\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import uuid

from fastapi import FastAPI, Header
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()

PROBE_SETS = {"prompt-injection": 12, "data-exfil": 8, "resource-exhaustion": 6}


class RunRequest(BaseModel):
    target: str
    probe_set: str


class RunStore:
    def get(self, tenant: str, idem_key: str) -> dict | None:
        """The run stored for (tenant, idem_key), if any."""
        raise NotImplementedError

    def put(self, tenant: str, idem_key: str, run: dict) -> None:
        """Store the run under (tenant, idem_key)."""
        raise NotImplementedError


run_store = RunStore()


@app.post("/v1/redteam/runs")
def create_run(
    body: RunRequest,
    tenant: str = Header(alias="X-Tenant-Id"),
    idem_key: str | None = Header(default=None, alias="Idempotency-Key"),
) -> JSONResponse:
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    probes = PROBE_SETS.get(body.probe_set, 4)
    dispatch(body.target, body.probe_set, probes)
    return JSONResponse(
        {"run_id": str(uuid.uuid4()), "tenant": tenant, "target": body.target, "probes": probes},
        status_code=202,
    )
`,
      solution: `import uuid

from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()

TARGET_REGISTRY = {
    "checkout-shadow": {"endpoint": "sut-shadow.sandbox:9000", "environment": "sandbox"},
    "search-staging": {"endpoint": "sut-staging.sandbox:9000", "environment": "staging"},
}
PRODUCTION_ENVIRONMENTS = {"prod", "production"}
PROBE_SETS = {"prompt-injection": 12, "data-exfil": 8, "resource-exhaustion": 6}


class RunRequest(BaseModel):
    target: str
    probe_set: str


class RunStore:
    def get(self, tenant: str, idem_key: str) -> dict | None:
        """The run stored for (tenant, idem_key), if any."""
        raise NotImplementedError

    def put(self, tenant: str, idem_key: str, run: dict) -> None:
        """Store the run under (tenant, idem_key)."""
        raise NotImplementedError


run_store = RunStore()


def resolve_target(name: str) -> dict:
    """The registered target, or a refusal. Never returns a caller-supplied URL."""
    record = TARGET_REGISTRY.get(name)
    if record is None:
        raise HTTPException(status_code=400, detail="unknown target")
    if record["environment"] in PRODUCTION_ENVIRONMENTS:
        raise HTTPException(status_code=403, detail="production targets are refused")
    return record


def dispatch(endpoint: str, probe_set: str, probes: int) -> None:
    """Send the probe set at the sandbox endpoint that hosts the target."""
    raise NotImplementedError


@app.post("/v1/redteam/runs")
def create_run(
    body: RunRequest,
    tenant: str | None = Header(default=None, alias="X-Tenant-Id"),
    idem_key: str | None = Header(default=None, alias="Idempotency-Key"),
) -> JSONResponse:
    if tenant is None or tenant == "":
        raise HTTPException(status_code=401, detail="missing X-Tenant-Id")
    if idem_key is None or idem_key == "":
        raise HTTPException(status_code=400, detail="Idempotency-Key is required")
    if body.target == "" or body.probe_set == "":
        raise HTTPException(status_code=400, detail="target and probe_set are required")

    stored = run_store.get(tenant, idem_key)
    if stored is not None:
        return JSONResponse(stored, status_code=200)

    record = resolve_target(body.target)
    probes = PROBE_SETS.get(body.probe_set, 4)
    run = {
        "run_id": str(uuid.uuid4()),
        "tenant": tenant,
        "target": body.target,
        "endpoint": record["endpoint"],
        "probe_set": body.probe_set,
        "probes": probes,
        "status": "running",
    }
    run_store.put(tenant, idem_key, run)
    dispatch(record["endpoint"], body.probe_set, probes)
    return JSONResponse(run, status_code=201)
`,
    },
    typescript: {
      starter: `/** POST /v1/redteam/runs: flawed code that probes whatever it is handed. */
import {randomUUID} from 'node:crypto';

import Fastify from 'fastify';

export const app = Fastify();

const PROBE_SETS: Record<string, number> = {'prompt-injection': 12, 'data-exfil': 8, 'resource-exhaustion': 6};

interface RunBody {
  target: string;
  probe_set: string;
}

app.post('/v1/redteam/runs', async (request, reply) => {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const tenant = request.headers['x-tenant-id'] as string;
  const body = request.body as RunBody;
  const probes = PROBE_SETS[body.probe_set] ?? 4;
  dispatch(body.target, body.probe_set, probes);
  return reply.code(202).send({run_id: randomUUID(), tenant, target: body.target, probes});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** POST /v1/redteam/runs: only a registered, non-production target gets a probe set. */
import {randomUUID} from 'node:crypto';

import Fastify from 'fastify';

import {runStore} from './runs';

export const app = Fastify();

interface TargetRecord {
  endpoint: string;
  environment: string;
}

const TARGET_REGISTRY: Record<string, TargetRecord> = {
  'checkout-shadow': {endpoint: 'sut-shadow.sandbox:9000', environment: 'sandbox'},
  'search-staging': {endpoint: 'sut-staging.sandbox:9000', environment: 'staging'},
};
const PRODUCTION_ENVIRONMENTS: Record<string, true> = {prod: true, production: true};
const PROBE_SETS: Record<string, number> = {'prompt-injection': 12, 'data-exfil': 8, 'resource-exhaustion': 6};

interface RunBody {
  target: string;
  probe_set: string;
}

interface Run {
  run_id: string;
  tenant: string;
  target: string;
  endpoint: string;
  probe_set: string;
  probes: number;
  status: string;
}

/** The registered target, or null. Never resolves a caller-supplied URL. */
function resolveTarget(name: string): TargetRecord | null {
  return Object.prototype.hasOwnProperty.call(TARGET_REGISTRY, name) ? TARGET_REGISTRY[name] : null;
}

function dispatch(endpoint: string, probeSet: string, probes: number): void {
  // The sandbox, not the caller, owns the egress: probes leave from here.
  void {endpoint, probeSet, probes};
}

app.post('/v1/redteam/runs', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing X-Tenant-Id'});
  const idemKey = request.headers['idempotency-key'];
  if (typeof idemKey !== 'string' || idemKey === '')
    return reply.code(400).send({error: 'Idempotency-Key is required'});

  const stored: Run | null = await runStore.get(tenant, idemKey);
  if (stored !== null) return reply.code(200).send(stored);

  const body = request.body as Partial<RunBody> | null;
  if (body === null || typeof body !== 'object' || typeof body.target !== 'string' || body.target === '')
    return reply.code(400).send({error: 'target is required'});
  if (typeof body.probe_set !== 'string' || body.probe_set === '')
    return reply.code(400).send({error: 'probe_set is required'});

  const record = resolveTarget(body.target);
  if (record === null) return reply.code(400).send({error: 'unknown target'});
  if (PRODUCTION_ENVIRONMENTS[record.environment] === true)
    return reply.code(403).send({error: 'production targets are refused'});

  const run: Run = {
    run_id: randomUUID(),
    tenant,
    target: body.target,
    endpoint: record.endpoint,
    probe_set: body.probe_set,
    probes: PROBE_SETS[body.probe_set] ?? 4,
    status: 'running',
  };
  await runStore.put(tenant, idemKey, run);
  dispatch(record.endpoint, body.probe_set, run.probes);
  return reply.code(201).send(run);
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

var probeSets = map[string]int{"prompt-injection": 12, "data-exfil": 8, "resource-exhaustion": 6}

type RunRequest struct {
	Target   string \`json:"target"\`
	ProbeSet string \`json:"probe_set"\`
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func createRun(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	tenant := r.Header.Get("X-Tenant-Id")
	var body RunRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	probes := probeSets[body.ProbeSet]
	dispatch(r.Context(), body.Target, body.ProbeSet, probes)
	writeJSON(rw, http.StatusAccepted, map[string]any{
		"run_id": uuid.NewString(),
		"tenant": tenant,
		"target": body.Target,
		"probes": probes,
	})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/redteam/runs", createRun)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"

	"github.com/google/uuid"
)

type TargetRecord struct {
	Endpoint    string \`json:"endpoint"\`
	Environment string \`json:"environment"\`
}

var targetRegistry = map[string]TargetRecord{
	"checkout-shadow": {Endpoint: "sut-shadow.sandbox:9000", Environment: "sandbox"},
	"search-staging":  {Endpoint: "sut-staging.sandbox:9000", Environment: "staging"},
}

var productionEnvironments = map[string]bool{"prod": true, "production": true}

var probeSets = map[string]int{"prompt-injection": 12, "data-exfil": 8, "resource-exhaustion": 6}

type RunRequest struct {
	Target   string \`json:"target"\`
	ProbeSet string \`json:"probe_set"\`
}

type RunStore struct{}

func (s *RunStore) Get(ctx context.Context, tenant, idemKey string) (map[string]any, error) {
	return nil, nil
}

func (s *RunStore) Put(ctx context.Context, tenant, idemKey string, run map[string]any) error {
	return nil
}

var runStore = &RunStore{}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

// resolveTarget answers with the registered target and false for anything else, so a caller
// supplied URL can never be probed.
func resolveTarget(name string) (TargetRecord, bool) {
	record, ok := targetRegistry[name]
	return record, ok
}

func dispatch(ctx context.Context, endpoint, probeSet string, probes int) error {
	return nil
}

func createRun(rw http.ResponseWriter, r *http.Request) {
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
	stored, err := runStore.Get(r.Context(), tenant, idemKey)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "try again"})
		return
	}
	if stored != nil {
		writeJSON(rw, http.StatusOK, stored)
		return
	}
	var body RunRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	record, ok := resolveTarget(body.Target)
	if !ok {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "unknown target"})
		return
	}
	if productionEnvironments[record.Environment] {
		writeJSON(rw, http.StatusForbidden, map[string]string{"error": "production targets are refused"})
		return
	}
	run := map[string]any{
		"run_id":    uuid.NewString(),
		"tenant":    tenant,
		"target":    body.Target,
		"endpoint":  record.Endpoint,
		"probe_set": body.ProbeSet,
		"probes":    probeSets[body.ProbeSet],
		"status":    "running",
	}
	if err := runStore.Put(r.Context(), tenant, idemKey, run); err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "try again"})
		return
	}
	if err := dispatch(r.Context(), record.Endpoint, body.ProbeSet, probeSets[body.ProbeSet]); err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "try again"})
		return
	}
	writeJSON(rw, http.StatusCreated, run)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/redteam/runs", createRun)
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

final case class RunRequest(target: String, probe_set: String)

object Api {
  implicit val system: ActorSystem = ActorSystem("red-team-runner")
  implicit val runFormat: RootJsonFormat[RunRequest] = jsonFormat2(RunRequest)

  val ProbeSets = Map("prompt-injection" -> 12, "data-exfil" -> 8, "resource-exhaustion" -> 6)

  val route: Route =
    path("v1" / "redteam" / "runs") {
      post {
        headerValueByName("X-Tenant-Id") { tenant =>
          entity(as[RunRequest]) { body =>
            // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
            val probes = ProbeSets.getOrElse(body.probe_set, 4)
            dispatch(body.target, body.probe_set, probes)
            complete(
              StatusCodes.Accepted,
              s"""{"run_id":"\${UUID.randomUUID()}","tenant":"$tenant","target":"\${body.target}","probes":$probes}"""
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

final case class RunRequest(target: String, probe_set: String)
final case class TargetRecord(endpoint: String, environment: String)
final case class Run(
    run_id: String,
    tenant: String,
    target: String,
    endpoint: String,
    probe_set: String,
    probes: Int,
    status: String
)

object Api {
  implicit val system: ActorSystem = ActorSystem("red-team-runner")
  implicit val runFormat: RootJsonFormat[RunRequest] = jsonFormat2(RunRequest)
  implicit val targetFormat: RootJsonFormat[TargetRecord] = jsonFormat2(TargetRecord)
  implicit val runRecordFormat: RootJsonFormat[Run] = jsonFormat7(Run)

  val TargetRegistry = Map(
    "checkout-shadow" -> TargetRecord("sut-shadow.sandbox:9000", "sandbox"),
    "search-staging" -> TargetRecord("sut-staging.sandbox:9000", "staging")
  )
  val ProductionEnvironments = Set("prod", "production")
  val ProbeSets = Map("prompt-injection" -> 12, "data-exfil" -> 8, "resource-exhaustion" -> 6)

  val runStore = RunStore.open()

  def resolveTarget(name: String): Option[TargetRecord] = TargetRegistry.get(name)

  def dispatch(endpoint: String, probeSet: String, probes: Int): Unit = ()

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
                val tenant = tenantOpt.get
                val idemKey = idemOpt.get
                runStore.get(tenant, idemKey) match {
                  case Some(stored) =>
                    complete(StatusCodes.OK, stored)
                  case None =>
                    resolveTarget(body.target) match {
                      case None =>
                        complete(StatusCodes.BadRequest, """{"error":"unknown target"}""")
                      case Some(record) if ProductionEnvironments.contains(record.environment) =>
                        complete(StatusCodes.Forbidden, """{"error":"production targets are refused"}""")
                      case Some(record) =>
                        val run = Run(
                          UUID.randomUUID().toString,
                          tenant,
                          body.target,
                          record.endpoint,
                          body.probe_set,
                          ProbeSets.getOrElse(body.probe_set, 4),
                          "running"
                        )
                        runStore.put(tenant, idemKey, run)
                        dispatch(record.endpoint, body.probe_set, run.probes)
                        complete(StatusCodes.Created, run)
                    }
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
#include <map>
#include <string>

using json = nlohmann::json;

const std::map<std::string, int> kProbeSets = {
    {"prompt-injection", 12}, {"data-exfil", 8}, {"resource-exhaustion", 6}};

std::string uuidString();

int main() {
  httplib::Server svr;

  svr.Post("/v1/redteam/runs", [](const httplib::Request& req, httplib::Response& res) {
    const auto tenant = req.get_header_value("X-Tenant-Id");
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) body = json::object();
    // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    const auto target = body.value("target", std::string());
    const auto probeSet = body.value("probe_set", std::string());
    const int probes = kProbeSets.count(probeSet) > 0 ? kProbeSets.at(probeSet) : 4;
    dispatch(target, probeSet, probes);
    res.status = 202;
    res.set_content(
        json{{"run_id", uuidString()}, {"tenant", tenant}, {"target", target}, {"probes", probes}}.dump(),
        "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <iostream>
#include <map>
#include <optional>
#include <set>
#include <string>

using json = nlohmann::json;

struct TargetRecord {
  std::string endpoint;
  std::string environment;
};

const std::map<std::string, TargetRecord> kTargetRegistry = {
    {"checkout-shadow", {"sut-shadow.sandbox:9000", "sandbox"}},
    {"search-staging", {"sut-staging.sandbox:9000", "staging"}}};
const std::set<std::string> kProductionEnvironments = {"prod", "production"};
const std::map<std::string, int> kProbeSets = {
    {"prompt-injection", 12}, {"data-exfil", 8}, {"resource-exhaustion", 6}};

struct RunStore {
  std::optional<json> get(const std::string& tenant, const std::string& idemKey);
  void put(const std::string& tenant, const std::string& idemKey, const json& run);
};

RunStore runStore;
std::string uuidString();
void dispatch(const std::string& endpoint, const std::string& probeSet, int probes);

/** The registered target, or nothing: a caller-supplied URL is never probed. */
std::optional<TargetRecord> resolveTarget(const std::string& name) {
  const auto it = kTargetRegistry.find(name);
  if (it == kTargetRegistry.end()) return std::nullopt;
  return it->second;
}

int main() {
  httplib::Server svr;

  svr.Post("/v1/redteam/runs", [](const httplib::Request& req, httplib::Response& res) {
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
    const auto stored = runStore.get(tenant, idemKey);
    if (stored) {
      res.status = 200;
      res.set_content(stored->dump(), "application/json");
      return;
    }
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object() || !body.contains("target") || !body["target"].is_string()) {
      res.status = 400;
      res.set_content(R"({"error":"target is required"})", "application/json");
      return;
    }
    const auto target = body["target"].get<std::string>();
    const auto record = resolveTarget(target);
    if (!record) {
      res.status = 400;
      res.set_content(R"({"error":"unknown target"})", "application/json");
      return;
    }
    if (kProductionEnvironments.count(record->environment) > 0) {
      res.status = 403;
      res.set_content(R"({"error":"production targets are refused"})", "application/json");
      return;
    }
    const auto probeSet = body.value("probe_set", std::string());
    const int probes = kProbeSets.count(probeSet) > 0 ? kProbeSets.at(probeSet) : 4;
    const json run = {
        {"run_id", uuidString()},
        {"tenant", tenant},
        {"target", target},
        {"endpoint", record->endpoint},
        {"probe_set", probeSet},
        {"probes", probes},
        {"status", "running"},
    };
    runStore.put(tenant, idemKey, run);
    dispatch(record->endpoint, probeSet, probes);
    res.status = 201;
    res.set_content(run.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  hints: [
    'An operator retries a timed-out submission and the sandbox logs show the probe set ran twice; a second run, aimed at a hostname that exists in no registry, reached a production host.',
    'The handler passes `body.target` straight to `dispatch` and mints a new `uuid4` on every call: there is no registry lookup, no environment test, and `idem_key` is parsed but read nowhere.',
    'Before `dispatch`: look up `run_store.get(tenant, idem_key)` and return the stored run with 200; call `resolve_target` against `TARGET_REGISTRY` (400 unknown, 403 for `PRODUCTION_ENVIRONMENTS`); then `run_store.put` and dispatch.',
  ],
  debrief: `The fix has its shape because every decision happens before the side effect. A registry turns the caller's string into a key the platform owns, so a typo is a 400 and a hostname is not an input at all. The environment test sits next to that lookup, so a production target is refused while the probe set is still a number in memory. The idempotency lookup runs first of all, because the cheapest way to not double adversarial traffic is to never reach the dispatch call. Production platforms go further on the egress side: the sandbox itself carries an allowlist of hosts it may reach, so a bug in this handler cannot become an incident, and the runner proves it is allowed to probe with a short-lived token tied to the target record.`,
};
