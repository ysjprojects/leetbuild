import type {Step} from '@/lib/types';

export const readStep: Step = {
  id: 'read',
  title: 'GET /v1/runs/{id}: where it is and why',
  concept: 'http',
  file: 'read',
  focus: ['client', 'engine', 'redis'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it answers
\`GET /v1/runs/{id}\` with the definition's newest step names and calls that the run's progress. It
compiles, it serves the demo, and it hides three production flaws. Review it like the engine owner,
fix it, and prove the fix with the checks below.

Implement \`GET /v1/runs/{run_id}\`, the one read an operator makes while a run is stuck.

- The tenant comes from the authenticated \`X-Tenant-Id\` header; a missing tenant is **401**. The
  run is fetched with \`store.get(tenant, run_id)\`, so a run that belongs to another tenant — or
  does not exist at all — is **404**, never 403 and never a body. Run ids are not enumerable by
  probing which ones answer.
- The body reports the **checkpoint**, not the definition: \`current_step\` and \`checkpoint_at\`
  come from the run's stored state. A run that started on version 3 reports the step version 3 is
  on, even if version 4 was published since.
- \`pending_effects\` is the pinned steps whose effect never completed, computed as
  \`ledger.incomplete(run_id, run.pinned_steps)\`. It is the answer to "what is this run waiting
  on", so it is never omitted.
- \`last_error\` is the checkpoint's last error, \`null\` when the run has not failed.
- A **stalled** run — no advance for longer than \`STALL_AFTER_S\` — additionally reports
  \`lease_holder\` and \`lease_age_s\`, so an operator knows which worker to look at instead of
  guessing. A moving run reports no lease at all.

**Failure mode the checks target.** The draft resolves the definition's newest step list and calls
it the run's progress, so after any publish an operator reads a step the run is not on and debugs
the wrong thing; it drops pending effects from the body, so the one field that explains a stuck run
is missing; and it looks the run up by id alone, so any tenant can read any other tenant's run. All
three are invisible in the demo and obvious in an incident.`,
  sequence: {
    participants: ['Operator', 'Workflow Engine', 'Run checkpoint (Redis)', 'Effect ledger'],
    messages: [
      {from: 'Operator', to: 'Workflow Engine', label: 'GET /v1/runs/run_8f · X-Tenant-Id', kind: 'sync'},
      {from: 'Workflow Engine', to: 'Workflow Engine', label: 'no tenant → 401', kind: 'sync'},
      {
        from: 'Workflow Engine',
        to: 'Run checkpoint (Redis)',
        label: 'store.get(tenant, run_id) · run:{tenant}:{run_id}',
        kind: 'sync',
      },
      {
        from: 'Run checkpoint (Redis)',
        to: 'Workflow Engine',
        label: 'current_step · checkpoint_at · lease_holder · lease_at · last_error',
        kind: 'reply',
      },
      {from: 'Workflow Engine', to: 'Workflow Engine', label: 'foreign or unknown run → 404, not 403', kind: 'sync'},
      {from: 'Workflow Engine', to: 'Effect ledger', label: 'incomplete(run_id, pinned_steps)', kind: 'sync'},
      {from: 'Effect ledger', to: 'Workflow Engine', label: 'the steps whose effect never completed', kind: 'reply'},
      {
        from: 'Workflow Engine',
        to: 'Operator',
        label: '200 {current_step, checkpoint_at, pending_effects, last_error}',
        kind: 'reply',
      },
      {
        from: 'Workflow Engine',
        to: 'Operator',
        label: '· lease_holder + lease_age_s when stalled',
        kind: 'reply',
      },
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Registers GET /v1/runs/{id}',
      detail:
        '`GET /v1/runs/{run_id}` is registered. The draft registers the same route, so this check is the floor the other four build on.',
      match: {
        python: {all: [/@app\.get\(\s*["']\/v1\/runs\/\{run_id\}["']/]},
        typescript: {all: [/app\.get\(\s*['"]\/v1\/runs\/:runId['"]/]},
        go: {all: [/HandleFunc\(\s*"GET \/v1\/runs\/\{runId\}"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"runs"\s*\/\s*Segment\s*\)/, /\bget\s*\{/]},
        cpp: {all: [/svr\.Get\(\s*R"\(\/v1\/runs\//]},
      },
    },
    {
      id: 'tenant-scope',
      title: 'Scopes the run to the calling tenant',
      detail:
        'The tenant comes from `X-Tenant-Id` (a missing tenant is **401**) and the run is fetched with `store.get(tenant, run_id)`; a run that belongs to another tenant, or does not exist, is **404** — never 403 and never a body, so run ids cannot be probed for existence. The draft looks the run up by id alone.',
      match: {
        python: {all: [/X-Tenant-Id/, /store\.get\(/, /status_code\s*=\s*404/]},
        typescript: {all: [/x-tenant-id/, /store\.get\(/, /code\(\s*404\s*\)/]},
        go: {all: [/"X-Tenant-Id"/, /store\.Get\(/, /StatusNotFound/]},
        scala: {all: [/X-Tenant-Id/, /store\.get\(/, /StatusCodes\.NotFound/]},
        cpp: {all: [/X-Tenant-Id/, /store\.get\(/, /\b404\b/]},
      },
    },
    {
      id: 'pending',
      title: 'Reports the effects that are still pending',
      detail:
        '`pending_effects` is the pinned steps whose effect never completed, computed as `ledger.incomplete(run_id, run.pinned_steps)`. The draft omits the field entirely, so the one thing an operator needs to know about a stuck run is missing.',
      match: {
        python: {all: [/pending_effects/, /ledger\.incomplete\(/]},
        typescript: {all: [/pending_effects/, /ledger\.incomplete\(/]},
        go: {all: [/PendingEffects/, /ledger\.Incomplete\(/]},
        scala: {all: [/pendingEffects/, /ledger\.incomplete\(/]},
        cpp: {all: [/pending_effects/, /ledger\.incomplete\(/]},
      },
    },
    {
      id: 'stall',
      title: 'Names the lease holder and its age for a stalled run',
      detail:
        'A run that has not advanced for longer than `STALL_AFTER_S` reports `lease_holder` and `lease_age_s`, so the operator knows which worker to look at. The draft reports no lease at all.',
      match: {
        python: {all: [/lease_holder/, /lease_age_s/, /STALL_AFTER_S/]},
        typescript: {all: [/lease_holder/, /lease_age_s/, /STALL_AFTER_S/]},
        go: {all: [/leaseHolder/, /leaseAgeSeconds/, /stallAfterSeconds/]},
        scala: {all: [/leaseHolder/, /leaseAgeSeconds/, /StallAfterSeconds/]},
        cpp: {all: [/lease_holder/, /lease_age_s/, /kStallAfterSeconds/]},
      },
    },
    {
      id: 'view',
      title: 'Reads the run checkpoint, not the newest definition',
      detail:
        "The body reports the run's own `current_step` and `checkpoint_at`, and never the newest definition's step names. The draft calls `store.latest(...)` and answers with the definition instead of the run.",
      match: {
        python: {all: [/current_step/, /checkpoint_at/], none: [/store\.latest\(/]},
        typescript: {all: [/current_step/, /checkpoint_at/], none: [/store\.latest\(/]},
        go: {all: [/CurrentStep/, /CheckpointAt/], none: [/store\.Latest\(/]},
        scala: {all: [/currentStep/, /checkpointAt/], none: [/store\.latest\(/]},
        cpp: {all: [/current_step/, /checkpoint_at/], none: [/store\.latest\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import logging

from fastapi import FastAPI
from fastapi.responses import JSONResponse

app = FastAPI()
logger = logging.getLogger("workflow")


class RunStore:
    def latest(self, run_id: str) -> dict | None:
        """The newest definition step list for the run."""
        raise NotImplementedError


store = RunStore()


@app.get("/v1/runs/{run_id}")
def read_run(run_id: str) -> JSONResponse:
    # TODO: this draft answers from the newest definition's step names instead of the run's
    # checkpoint, hides the effects that are still pending, and serves any tenant's run - there is
    # no tenant scope and no 404. Review all three.
    definition = store.latest(run_id)
    logger.info("run read run=%s", run_id)
    return JSONResponse(
        {"run_id": run_id, "steps": definition["steps"] if definition else [], "status": "running"},
        status_code=200,
    )
`,
      solution: `import logging
import time

import redis
from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse

app = FastAPI()
logger = logging.getLogger("workflow")

STALL_AFTER_S = 300


class RunStore:
    """The run's checkpoint, as the engine keeps it in Redis."""

    def __init__(self, r: redis.Redis) -> None:
        self.r = r

    def get(self, tenant: str, run_id: str) -> dict | None:
        """The checkpoint hash at run:{tenant}:{run_id} - current_step, checkpoint_at,
        pinned_steps, lease_holder, lease_at and last_error - or None for a foreign or
        unknown run."""
        raise NotImplementedError


class EffectLedger:
    def incomplete(self, run_id: str, pinned_steps: list[str]) -> list[str]:
        """The pinned steps whose effect never completed."""
        raise NotImplementedError


store = RunStore(redis.Redis())
ledger = EffectLedger()


@app.get("/v1/runs/{run_id}")
def read_run(
    run_id: str, tenant: str | None = Header(default=None, alias="X-Tenant-Id")
) -> JSONResponse:
    if tenant is None or tenant == "":
        raise HTTPException(status_code=401, detail="missing X-Tenant-Id")
    run = store.get(tenant, run_id)
    if run is None:
        raise HTTPException(status_code=404, detail="run not found")
    now = int(time.time())
    view = {
        "run_id": run_id,
        "current_step": run["current_step"],
        "checkpoint_at": run["checkpoint_at"],
        "pending_effects": ledger.incomplete(run_id, run["pinned_steps"]),
        "last_error": run["last_error"],
    }
    if now - run["checkpoint_at"] > STALL_AFTER_S:
        lease_age_s = now - run["lease_at"]
        view["lease_holder"] = run["lease_holder"]
        view["lease_age_s"] = lease_age_s
    logger.info("run read tenant=%s run=%s step=%s", tenant, run_id, run["current_step"])
    return JSONResponse(view, status_code=200)
`,
    },
    typescript: {
      starter: `/** GET /v1/runs/:runId: a model-generated draft that answers from the newest definition. */
import Fastify from 'fastify';

export const app = Fastify();

export interface RunStore {
  latest(runId: string): Promise<{steps: string[]} | null>;
}

export const store: RunStore = {
  latest: async () => {
    throw new Error('not implemented');
  },
};

app.get('/v1/runs/:runId', async (request, reply) => {
  // TODO: this draft answers from the newest definition's step names instead of the run's
  // checkpoint, hides the effects that are still pending, and serves any tenant's run - there is
  // no tenant scope and no 404. Review all three.
  const {runId} = request.params as {runId: string};
  const definition = await store.latest(runId);
  request.log.info({runId}, 'run read');
  return reply.code(200).send({run_id: runId, steps: definition?.steps ?? [], status: 'running'});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** GET /v1/runs/:runId: the run's checkpoint, scoped to the calling tenant. */
import Fastify from 'fastify';

export const app = Fastify();

const STALL_AFTER_S = 300;

export interface RunCheckpoint {
  pinned_steps: string[];
  current_step: string;
  checkpoint_at: number;
  lease_holder: string;
  lease_at: number;
  last_error: string | null;
}

export interface RunStore {
  get(tenant: string, runId: string): Promise<RunCheckpoint | null>;
}

export const store: RunStore = {
  get: async () => {
    throw new Error('not implemented');
  },
};

export interface EffectLedger {
  incomplete(runId: string, pinnedSteps: string[]): Promise<string[]>;
}

export const ledger: EffectLedger = {
  incomplete: async () => {
    throw new Error('not implemented');
  },
};

app.get('/v1/runs/:runId', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '')
    return reply.code(401).send({error: 'missing X-Tenant-Id'});
  const {runId} = request.params as {runId: string};
  const run = await store.get(tenant, runId);
  if (run === null) return reply.code(404).send({error: 'run not found'});
  const now = Math.floor(Date.now() / 1000);
  const view: Record<string, unknown> = {
    run_id: runId,
    current_step: run.current_step,
    checkpoint_at: run.checkpoint_at,
    pending_effects: await ledger.incomplete(runId, run.pinned_steps),
    last_error: run.last_error,
  };
  if (now - run.checkpoint_at > STALL_AFTER_S) {
    view.lease_holder = run.lease_holder;
    view.lease_age_s = now - run.lease_at;
  }
  request.log.info({tenant, runId, step: run.current_step}, 'run read');
  return reply.code(200).send(view);
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
)

type DefinitionStore struct{}

func (s *DefinitionStore) Latest(ctx context.Context, runID string) ([]string, error) {
	return nil, nil
}

var store = &DefinitionStore{}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func readRun(rw http.ResponseWriter, r *http.Request) {
	// TODO: this draft answers from the newest definition's step names instead of the run's
	// checkpoint, hides the effects that are still pending, and serves any tenant's run - there is
	// no tenant scope and no 404. Review all three.
	runID := r.PathValue("runId")
	steps, _ := store.Latest(r.Context(), runID)
	if steps == nil {
		steps = []string{}
	}
	log.Printf("run read run=%s", runID)
	writeJSON(rw, http.StatusOK, map[string]any{"run_id": runID, "steps": steps, "status": "running"})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/runs/{runId}", readRun)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"time"
)

const stallAfterSeconds = 300

// Run is the checkpoint the engine keeps for one run, under run:{tenant}:{runID} in Redis.
type Run struct {
	PinnedSteps  []string
	CurrentStep  string
	CheckpointAt int64
	LeaseHolder  string
	LeaseAt      int64
	LastError    string
}

// RunStore is the checkpoint store. Get is tenant-scoped by construction, so a foreign run is
// indistinguishable from a missing one.
type RunStore struct{}

func (s *RunStore) Get(ctx context.Context, tenant, runID string) (*Run, error) {
	return nil, nil
}

// EffectLedger is the ledger of step effects: which pinned steps never completed.
type EffectLedger struct{}

func (l *EffectLedger) Incomplete(ctx context.Context, runID string, pinnedSteps []string) ([]string, error) {
	return nil, nil
}

var (
	store  = &RunStore{}
	ledger = &EffectLedger{}
)

// RunView is the body of the read: the checkpoint, the pending effects and the error, plus the
// lease only while the run is stalled.
type RunView struct {
	RunID          string   \`json:"run_id"\`
	CurrentStep    string   \`json:"current_step"\`
	CheckpointAt   int64    \`json:"checkpoint_at"\`
	PendingEffects []string \`json:"pending_effects"\`
	LastError      *string  \`json:"last_error"\`
	LeaseHolder    string   \`json:"lease_holder,omitempty"\`
	LeaseAgeS      int64    \`json:"lease_age_s,omitempty"\`
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func readRun(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-Tenant-Id"})
		return
	}
	runID := r.PathValue("runId")
	run, err := store.Get(r.Context(), tenant, runID)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	if run == nil {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "run not found"})
		return
	}
	pendingEffects, err := ledger.Incomplete(r.Context(), runID, run.PinnedSteps)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	var lastError *string
	if run.LastError != "" {
		lastError = &run.LastError
	}
	now := time.Now().Unix()
	view := RunView{
		RunID:          runID,
		CurrentStep:    run.CurrentStep,
		CheckpointAt:   run.CheckpointAt,
		PendingEffects: pendingEffects,
		LastError:      lastError,
	}
	if now-run.CheckpointAt > stallAfterSeconds {
		leaseHolder := run.LeaseHolder
		leaseAgeSeconds := now - run.LeaseAt
		view.LeaseHolder = leaseHolder
		view.LeaseAgeS = leaseAgeSeconds
	}
	log.Printf("run read tenant=%s run=%s step=%s", tenant, runID, run.CurrentStep)
	writeJSON(rw, http.StatusOK, view)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/runs/{runId}", readRun)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

final case class Definition(version: Int, steps: List[String])

trait DefinitionStore {
  def latest(runId: String): Option[Definition]
}

object DefinitionStore {
  def open(): DefinitionStore = new DefinitionStore {
    def latest(runId: String): Option[Definition] = None
  }
}

object RunReadApi {
  implicit val system: ActorSystem = ActorSystem("workflow")

  val store = DefinitionStore.open()

  val route: Route =
    path("v1" / "runs" / Segment) { runId =>
      get {
        // TODO: this draft answers from the newest definition's step names instead of the run's
        // checkpoint, hides the effects that are still pending, and serves any tenant's run -
        // there is no tenant scope and no 404. Review all three.
        val steps = store.latest(runId).map(_.steps).getOrElse(Nil)
        system.log.info(s"run read run=$runId")
        complete(
          StatusCodes.OK,
          JsObject("run_id" -> JsString(runId), "steps" -> JsArray(steps.map(JsString(_)).toVector)),
        )
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
import spray.json._

final case class RunCheckpoint(
    pinnedSteps: List[String],
    currentStep: String,
    checkpointAt: Long,
    leaseHolder: String,
    leaseAt: Long,
    lastError: Option[String],
)

trait RunStore {
  /** The checkpoint hash at run:{tenant}:{runId}, or None for a foreign or unknown run. */
  def get(tenant: String, runId: String): Option[RunCheckpoint]
}

object RunStore {
  def open(): RunStore = new RunStore {
    def get(tenant: String, runId: String): Option[RunCheckpoint] = None
  }
}

trait EffectLedger {
  /** The run's pinned steps whose effect never completed. */
  def incomplete(runId: String, pinnedSteps: List[String]): List[String]
}

object EffectLedger {
  def open(): EffectLedger = new EffectLedger {
    def incomplete(runId: String, pinnedSteps: List[String]): List[String] = Nil
  }
}

object RunReadApi {
  implicit val system: ActorSystem = ActorSystem("workflow")

  val StallAfterSeconds = 300

  val store = RunStore.open()
  val ledger = EffectLedger.open()

  val route: Route =
    path("v1" / "runs" / Segment) { runId =>
      get {
        optionalHeaderValueByName("X-Tenant-Id") { tenantOpt =>
          val tenant = tenantOpt.getOrElse("")
          if (tenant.isEmpty) {
            complete(StatusCodes.Unauthorized, """{"error":"missing X-Tenant-Id"}""")
          } else {
            store.get(tenant, runId) match {
              case None =>
                complete(StatusCodes.NotFound, """{"error":"run not found"}""")
              case Some(run) =>
                val now = System.currentTimeMillis() / 1000
                val pendingEffects = ledger.incomplete(runId, run.pinnedSteps)
                val lastError: JsValue = run.lastError match {
                  case Some(err) => JsString(err)
                  case None      => JsNull
                }
                val view = JsObject(
                  "run_id" -> JsString(runId),
                  "current_step" -> JsString(run.currentStep),
                  "checkpoint_at" -> JsNumber(run.checkpointAt),
                  "pending_effects" -> JsArray(pendingEffects.map(step => JsString(step)).toVector),
                  "last_error" -> lastError,
                )
                val stalled = now - run.checkpointAt > StallAfterSeconds
                val leaseHolder = run.leaseHolder
                val leaseAgeSeconds = now - run.leaseAt
                val fields =
                  if (stalled)
                    view.fields + ("lease_holder" -> JsString(leaseHolder)) + ("lease_age_s" -> JsNumber(leaseAgeSeconds))
                  else view.fields
                system.log.info(s"run read tenant=$tenant run=$runId step=\${run.currentStep}")
                complete(StatusCodes.OK, JsObject(fields))
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
#include <optional>
#include <string>
#include <vector>

using json = nlohmann::json;

// The draft stores definitions, not runs: the newest step list is all it can answer with.
struct DefinitionStore {
  std::optional<std::vector<std::string>> latest(const std::string& run_id);
};

DefinitionStore store;

int main() {
  httplib::Server svr;

  svr.Get(R"(/v1/runs/([^/]+))", [](const httplib::Request& req, httplib::Response& res) {
    // TODO: this draft answers from the newest definition's step names instead of the run's
    // checkpoint, hides the effects that are still pending, and serves any tenant's run - there is
    // no tenant scope and no 404. Review all three.
    const auto runId = req.matches[1].str();
    const auto steps = store.latest(runId);
    json run = {
        {"run_id", runId},
        {"steps", steps ? *steps : std::vector<std::string>{}},
        {"status", "running"},
    };
    std::cerr << "run read run=" << runId << "\\n";
    res.status = 200;
    res.set_content(run.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <iostream>
#include <optional>
#include <string>
#include <vector>

using json = nlohmann::json;

constexpr int kStallAfterSeconds = 300;

// The checkpoint the engine keeps for one run, under run:{tenant}:{run_id} in Redis.
struct RunCheckpoint {
  std::vector<std::string> pinned_steps;
  std::string current_step;
  long checkpoint_at = 0;
  std::string lease_holder;
  long lease_at = 0;
  std::string last_error;
};

// Both seams are tenant-scoped by construction: a foreign run reads exactly like a missing one.
struct RunStore {
  std::optional<RunCheckpoint> get(const std::string& tenant, const std::string& run_id);
};

// The ledger of step effects: which of the pinned steps never completed.
struct EffectLedger {
  std::vector<std::string> incomplete(const std::string& run_id,
                                      const std::vector<std::string>& pinned_steps);
};

RunStore store;
EffectLedger ledger;
long unixSeconds();

int main() {
  httplib::Server svr;

  svr.Get(R"(/v1/runs/([^/]+))", [](const httplib::Request& req, httplib::Response& res) {
    const auto tenant = req.get_header_value("X-Tenant-Id");
    if (tenant.empty()) {
      res.status = 401;
      res.set_content(R"({"error":"missing X-Tenant-Id"})", "application/json");
      return;
    }
    const auto runId = req.matches[1].str();
    const auto run = store.get(tenant, runId);
    if (!run) {
      res.status = 404;
      res.set_content(R"({"error":"run not found"})", "application/json");
      return;
    }
    const long now = unixSeconds();
    json view = {
        {"run_id", runId},
        {"current_step", run->current_step},
        {"checkpoint_at", run->checkpoint_at},
        {"pending_effects", ledger.incomplete(runId, run->pinned_steps)},
        {"last_error", nullptr},
    };
    if (!run->last_error.empty()) view["last_error"] = run->last_error;
    if (now - run->checkpoint_at > kStallAfterSeconds) {
      view["lease_holder"] = run->lease_holder;
      view["lease_age_s"] = now - run->lease_at;
    }
    std::cerr << "run read tenant=" << tenant << " run=" << runId << "\\n";
    res.status = 200;
    res.set_content(view.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  hints: [
    'Scope the lookup before writing the body: read `X-Tenant-Id`, answer **401** when it is absent, then fetch the run with `store.get(tenant, run_id)` and answer **404** when that returns nothing. A run resolved by id alone can never be scoped, so the signature of the lookup is the first thing to change.',
    "The run's state lives in the checkpoint hash: `current_step`, `checkpoint_at`, `lease_holder`, `lease_at`, `last_error`. The definition's step names are a property of a version and change the moment someone publishes, so resolving them here reports a step the run is not on. The pinned steps are only an input to the ledger, never the answer.",
    'A stalled run is the one case where the lease matters: compare `now - checkpoint_at` against `STALL_AFTER_S` and only past it add `lease_holder` and `lease_age_s` (`now - lease_at`). Fill `pending_effects` from `ledger.incomplete(run_id, run.pinned_steps)` and report `last_error` as `null`, not by dropping the key.',
  ],
  debrief: `The interviewer is testing whether you can review a read model over state that another component owns. The draft reads fine because the demo publishes one version, starts one run and never publishes again: the definition's step list and the run's step happen to agree, so nobody notices that the endpoint is describing the wrong object. Once a version 4 exists, an operator debugging version 3 is looking at a step the run will never execute, and the incident review blames the engine. The second defect is about the question an operator actually asks — a stalled run is not stuck because of where it is but because of what it is waiting on, and that is the ledger's answer, so a read that omits pending effects sends the operator to the wrong system. The third is tenancy: a run id is a guessable identifier, and a lookup that ignores the tenant turns a read endpoint into a cross-tenant leak, which is why a foreign run must answer 404 rather than 403 — a 403 confirms the id exists. In production this endpoint also reads from a replica or a projection rather than the coordination Redis, returns a cursor-friendly error summary instead of one error string, and treats a lease that is old but whose holder is still heartbeating as a different case from one whose holder has vanished.`,
};
