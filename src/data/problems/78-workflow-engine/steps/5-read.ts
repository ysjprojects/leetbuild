import type {Step} from '@/lib/types';

export const readStep: Step = {
  id: 'read',
  title: 'GET /v1/runs/{id}: where it is and why',
  concept: 'http',
  file: 'read',
  focus: ['client', 'engine', 'redis'],
  task: `## Task

**Starting point.** The starter's \`GET /v1/runs/{run_id}\` calls \`store.latest(run_id)\` and
answers 200 with the run id, that definition's step names and \`"status": "running"\`. It serves the
demo and hides four flaws.

**Failure mode the checks target.** After any later publish, an operator reads a step the run is not
on. The body does not say what the run is waiting on, so a stuck run sends the operator to the
wrong system. The lookup is by id alone, so any tenant can read any other tenant's run.

Requirements:

- The tenant comes from the \`X-Tenant-Id\` header; a missing tenant is **401**. Fetch the run with
  \`store.get(tenant, run_id)\`; a run that belongs to another tenant or does not exist is **404**,
  not 403 and not a body, so run ids cannot be probed.
- The body reports the checkpoint, not the definition: \`current_step\` and \`checkpoint_at\` come
  from the run's stored state, and \`store.latest\` is not called.
- \`pending_effects\` is the pinned steps whose effect has not completed:
  \`ledger.incomplete(run_id, run.pinned_steps)\`.
- \`last_error\` is the checkpoint's last error, \`null\` when the run has not failed.
- A run with no advance for longer than \`STALL_AFTER_S\` additionally reports \`lease_holder\` and
  \`lease_age_s\`; a moving run reports no lease.`,
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
        '`GET /v1/runs/{run_id}` is registered. The starter registers the same route, so this check is the floor the other four build on.',
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
        'The tenant comes from `X-Tenant-Id` (a missing tenant is **401**) and the run is fetched with `store.get(tenant, run_id)`; a run that belongs to another tenant, or does not exist, is **404** — never 403 and never a body, so run ids cannot be probed for existence. The starter looks the run up by id alone.',
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
        '`pending_effects` is the pinned steps whose effect never completed, computed as `ledger.incomplete(run_id, run.pinned_steps)`. The starter omits the field entirely, so the one thing an operator needs to know about a stuck run is missing.',
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
        'A run that has not advanced for longer than `STALL_AFTER_S` reports `lease_holder` and `lease_age_s`, so the operator knows which worker to look at. The starter reports no lease at all.',
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
        "The body reports the run's own `current_step` and `checkpoint_at`, and never the newest definition's step names. The starter calls `store.latest(...)` and answers with the definition instead of the run.",
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
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
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
      starter: `/** GET /v1/runs/:runId: report a run's progress. */
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
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
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
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
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
        // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
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

struct DefinitionStore {
  std::optional<std::vector<std::string>> latest(const std::string& run_id);
};

DefinitionStore store;

int main() {
  httplib::Server svr;

  svr.Get(R"(/v1/runs/([^/]+))", [](const httplib::Request& req, httplib::Response& res) {
    // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
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
    'Symptom: after version 4 is published, an operator opens a version-3 run and sees a step it will never execute, and nothing in the body says what the run is waiting on.',
    "Mechanism: `read_run` calls `store.latest(run_id)` and returns that definition's step names; it reads no checkpoint, no ledger and no tenant header, so any caller sees any run.",
    'Fix: `X-Tenant-Id` (401 if absent), `store.get(tenant, run_id)` (404), then `current_step`, `checkpoint_at`, `pending_effects` from `ledger.incomplete`, and past `STALL_AFTER_S` add `lease_holder`, `lease_age_s`.',
  ],
  debrief: `The endpoint describes the run, so its data comes from the object that is the run: the checkpoint hash, with the pinned steps used only as input to the ledger. In the demo the newest definition and the run's step agree, which is why the starter looks right; once a later version exists they diverge and an operator debugs a step the run will not execute. \`pending_effects\` comes from the ledger because a stalled run is stuck on what it is waiting for, not on where it is. A foreign run answers 404 rather than 403 because a 403 confirms the id exists. Production read models serve this from a projection rather than the coordination Redis, and treat a lease whose holder still heartbeats differently from an abandoned one.`,
};
