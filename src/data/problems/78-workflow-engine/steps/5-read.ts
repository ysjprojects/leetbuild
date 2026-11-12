import type {Step} from '@/lib/types';

export const readStep: Step = {
  id: 'read',
  title: 'GET /v1/runs/{id}: where the run is and why',
  concept: 'http',
  guides: ['honest-reads', 'request-boundaries'],
  file: 'read',
  focus: ['client', 'engine', 'redis', 'ledger'],
  task: `## Task

**Starting point.** \`GET /v1/runs/{run_id}\` reads the run with \`runs.get\`, looks up
\`definitions.latest(run["workflow"])\` and answers 200 with \`run_id\`, \`workflow\`, that
definition's \`steps\` and \`"status": "running"\`. It serves the demo and hides four flaws.

**Failure mode the checks target.** Any caller reads any tenant's run. After version 4 is published,
an operator reads steps the version-3 run will never execute, and nothing says where it is. A run
stuck on a step looks like a run that is moving, and so does a finished one.

- The tenant comes from \`X-Tenant-Id\` (**401** when absent); another tenant's run is **404**,
  like an unknown one.
- From the run: \`definition_version\` and \`pinned_steps\`; from \`checkpoint.read(run_id)\`:
  \`current_step\`, \`completed\` (a list) and \`checkpoint_at\` (its \`updated_at\`).
- \`pending_effects\` is \`ledger.incomplete(run_id, pinned_steps)\`.
- \`status\` is \`succeeded\` when \`current_step\` is \`""\`, \`stalled\` when the checkpoint is older
  than \`STALL_AFTER_S\` (300 s; the same name in each language's casing), otherwise \`running\`.`,
  sequence: {
    participants: ['Operator', 'workflowd', 'Redis', 'Effect ledger'],
    messages: [
      {from: 'Operator', to: 'workflowd', label: 'GET /v1/runs/run-1 · X-Tenant-Id: t1', kind: 'sync'},
      {from: 'workflowd', to: 'workflowd', label: 'no tenant → 401', kind: 'sync'},
      {from: 'workflowd', to: 'Redis', label: 'runs.get(run-1) · another tenant → 404', kind: 'sync'},
      {from: 'workflowd', to: 'Redis', label: 'checkpoint.read(run-1)', kind: 'sync'},
      {from: 'workflowd', to: 'Effect ledger', label: 'incomplete(run-1, pinned_steps)', kind: 'sync'},
      {
        from: 'workflowd',
        to: 'Operator',
        label: '200 {pinned_steps, current_step, checkpoint_at, pending_effects, status}',
        kind: 'reply',
      },
    ],
  },
  checks: [
    {
      id: 'tenant-scope',
      title: 'Scopes the run to the calling tenant',
      detail:
        "A request without `X-Tenant-Id` is **401**; tenant t2 reading t1's run gets **404** with none of the run in the body, like an unknown run. The starter answers anyone.",
      match: {
        python: {
          all: [/x-tenant-id/i, /status_code\s*=\s*401/, /\["tenant"\]\s*!=\s*tenant|tenant\s*!=\s*run\["tenant"\]/],
        },
        typescript: {all: [/x-tenant-id/i, /code\(\s*401\s*\)/, /\.tenant\s*!==\s*tenant|tenant\s*!==\s*run\.tenant/]},
        go: {all: [/X-Tenant-Id/i, /StatusUnauthorized/, /\.Tenant\s*!=\s*tenant|tenant\s*!=\s*run\.Tenant/]},
        scala: {all: [/X-Tenant-Id/i, /StatusCodes\.Unauthorized/, /_\.tenant\s*==\s*tenant|\.tenant\s*!=\s*tenant/]},
        cpp: {all: [/X-Tenant-Id/i, /\b401\b/, /->tenant\s*!=\s*tenant|tenant\s*!=\s*run->tenant/]},
      },
    },
    {
      id: 'view',
      title: 'Reports the pinned steps and the checkpoint',
      detail:
        "With version 4 published, a version-3 run reports `definition_version` 3, its pinned steps, and the checkpoint's `current_step`, `completed` and `checkpoint_at`. The starter reports the newest definition and no position.",
      match: {
        python: {all: [/checkpoint\.read\(/, /pinned_steps/], none: [/definitions\.latest\(/]},
        typescript: {all: [/checkpoint\.read\(/, /pinned_steps/], none: [/definitions\.latest\(/]},
        go: {all: [/checkpoint\.Read\(/, /pinned_steps/], none: [/definitions\.Latest\(/]},
        scala: {all: [/Checkpoint\.read\(/, /pinned_steps/], none: [/Definitions\.latest\(/]},
        cpp: {all: [/checkpoint::read\(/, /pinned_steps/], none: [/definitions::latest\(/]},
      },
    },
    {
      id: 'pending',
      title: 'Reports the effects that are still pending',
      detail:
        'With `create_account` recorded in the ledger, `pending_effects` is `["send_welcome"]`. The starter has no such field, so an operator cannot see what a stuck run is waiting on.',
      match: {
        python: {all: [/pending_effects/, /ledger\.incomplete\(/]},
        typescript: {all: [/pending_effects/, /ledger\.incomplete\(/]},
        go: {all: [/pending_effects/, /ledger\.Incomplete\(/]},
        scala: {all: [/pending_effects/, /Ledger\.incomplete\(/]},
        cpp: {all: [/pending_effects/, /ledger::incomplete\(/]},
      },
    },
    {
      id: 'status',
      title: 'Derives the status from the checkpoint',
      detail:
        'A checkpoint written now or 100 s ago is `running`, one written 600 s ago is `stalled`, and `current_step` `""` is `succeeded`. The starter says `running` for every run.',
      match: {
        python: {all: [/STALL_AFTER_S/, /"stalled"/, /"succeeded"/]},
        typescript: {all: [/STALL_AFTER_S/, /'stalled'/, /'succeeded'/]},
        go: {all: [/stallAfterSeconds/, /"stalled"/, /"succeeded"/]},
        scala: {all: [/StallAfterSeconds/, /"stalled"/, /"succeeded"/]},
        cpp: {all: [/kStallAfterSeconds/, /"stalled"/, /"succeeded"/]},
      },
    },
  ],
  code: {
    python: {
      starter: `from fastapi import FastAPI, HTTPException, Request

from workflow import checkpoint, definitions, ledger, runs  # checkpoint.read · definitions.latest · ledger.incomplete · runs.get

app = FastAPI()


@app.get("/v1/runs/{run_id}")
def read_run(run_id: str, request: Request) -> dict:
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    run = runs.get(run_id)
    if run is None:
        raise HTTPException(status_code=404, detail="no such run")
    definition = definitions.latest(run["workflow"])
    return {"run_id": run_id, "workflow": run["workflow"], "steps": definition["steps"] if definition else [], "status": "running"}
`,
      solution: `import time

from fastapi import FastAPI, HTTPException, Request

from workflow import checkpoint, definitions, ledger, runs  # checkpoint.read · definitions.latest · ledger.incomplete · runs.get

app = FastAPI()

STALL_AFTER_S = 300


@app.get("/v1/runs/{run_id}")
def read_run(run_id: str, request: Request) -> dict:
    tenant = request.headers.get("x-tenant-id", "")
    if not tenant:
        raise HTTPException(status_code=401, detail="X-Tenant-Id is required")
    run = runs.get(run_id)
    # Another tenant's run answers exactly like a missing one, so run ids cannot be probed.
    if run is None or run["tenant"] != tenant:
        raise HTTPException(status_code=404, detail="no such run")
    # The run's own records: its pinned steps, its checkpoint, its ledger. Never the newest definition.
    state = checkpoint.read(run_id)
    current_step = state.get("current_step", "")
    checkpoint_at = int(state.get("updated_at") or run["started_at"])
    if current_step == "":
        status = "succeeded"
    elif time.time() - checkpoint_at > STALL_AFTER_S:
        status = "stalled"
    else:
        status = "running"
    return {
        "run_id": run_id,
        "workflow": run["workflow"],
        "definition_version": run["definition_version"],
        "pinned_steps": run["pinned_steps"],
        "current_step": current_step,
        "completed": [step for step in state.get("completed", "").split(",") if step],
        "checkpoint_at": checkpoint_at,
        "pending_effects": ledger.incomplete(run_id, run["pinned_steps"]),
        "status": status,
    }
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';

import * as checkpoint from 'workflow/checkpoint'; // read
import * as definitions from 'workflow/definitions'; // latest
import * as ledger from 'workflow/ledger'; // incomplete
import * as runs from 'workflow/runs'; // get

export const app = Fastify();

app.get('/v1/runs/:runId', async (request, reply) => {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const {runId} = request.params as {runId: string};
  const run = await runs.get(runId);
  if (run === null) return reply.code(404).send({error: 'no such run'});
  const definition = await definitions.latest(run.workflow);
  return {run_id: runId, workflow: run.workflow, steps: definition?.steps ?? [], status: 'running'};
});
`,
      solution: `import Fastify from 'fastify';

import * as checkpoint from 'workflow/checkpoint'; // read
import * as definitions from 'workflow/definitions'; // latest
import * as ledger from 'workflow/ledger'; // incomplete
import * as runs from 'workflow/runs'; // get

export const app = Fastify();

export const STALL_AFTER_S = 300;

app.get('/v1/runs/:runId', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'X-Tenant-Id is required'});
  const {runId} = request.params as {runId: string};
  const run = await runs.get(runId);
  // Another tenant's run answers exactly like a missing one, so run ids cannot be probed.
  if (run === null || run.tenant !== tenant) return reply.code(404).send({error: 'no such run'});
  // The run's own records: its pinned steps, its checkpoint, its ledger. Never the newest definition.
  const state = await checkpoint.read(runId);
  const currentStep = state.current_step ?? '';
  const checkpointAt = Number(state.updated_at ?? run.started_at);
  let status = 'running';
  if (currentStep === '') status = 'succeeded';
  else if (Date.now() / 1000 - checkpointAt > STALL_AFTER_S) status = 'stalled';
  return {
    run_id: runId,
    workflow: run.workflow,
    definition_version: run.definition_version,
    pinned_steps: run.pinned_steps,
    current_step: currentStep,
    completed: (state.completed ?? '').split(',').filter(step => step !== ''),
    checkpoint_at: checkpointAt,
    pending_effects: await ledger.incomplete(runId, run.pinned_steps),
    status,
  };
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"net/http"

	"workflow/definitions" // definitions.Latest
	"workflow/runs"        // runs.Get
)

// The run checkpoint and the effect ledger are the packages workflow/checkpoint
// (checkpoint.Read(ctx, runID) map[string]string) and workflow/ledger
// (ledger.Incomplete(ctx, runID, steps) []string).

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func readRun(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	run := runs.Get(r.Context(), r.PathValue("runId"))
	if run == nil {
		http.Error(rw, "no such run", http.StatusNotFound)
		return
	}
	steps := []string{}
	if definition := definitions.Latest(r.Context(), run.Workflow); definition != nil {
		steps = definition.Steps
	}
	writeJSON(rw, http.StatusOK, map[string]any{"run_id": run.RunID, "workflow": run.Workflow, "steps": steps, "status": "running"})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/runs/{runId}", readRun)
}
`,
      solution: `package main

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"time"

	"workflow/checkpoint" // checkpoint.Read(ctx, runID) map[string]string
	"workflow/ledger"     // ledger.Incomplete(ctx, runID, steps) []string
	"workflow/runs"       // runs.Get
)

const stallAfterSeconds = 300

type runView struct {
	RunID             string   \`json:"run_id"\`
	Workflow          string   \`json:"workflow"\`
	DefinitionVersion int      \`json:"definition_version"\`
	PinnedSteps       []string \`json:"pinned_steps"\`
	CurrentStep       string   \`json:"current_step"\`
	Completed         []string \`json:"completed"\`
	CheckpointAt      int64    \`json:"checkpoint_at"\`
	PendingEffects    []string \`json:"pending_effects"\`
	Status            string   \`json:"status"\`
}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func readRun(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		http.Error(rw, "X-Tenant-Id is required", http.StatusUnauthorized)
		return
	}
	runID := r.PathValue("runId")
	run := runs.Get(r.Context(), runID)
	// Another tenant's run answers exactly like a missing one, so run ids cannot be probed.
	if run == nil || run.Tenant != tenant {
		http.Error(rw, "no such run", http.StatusNotFound)
		return
	}
	// The run's own records: its pinned steps, its checkpoint, its ledger. Never the newest definition.
	state := checkpoint.Read(r.Context(), runID)
	checkpointAt := run.StartedAt
	if at, err := strconv.ParseInt(state["updated_at"], 10, 64); err == nil {
		checkpointAt = at
	}
	completed := []string{}
	for _, step := range strings.Split(state["completed"], ",") {
		if step != "" {
			completed = append(completed, step)
		}
	}
	status := "running"
	if state["current_step"] == "" {
		status = "succeeded"
	} else if time.Now().Unix()-checkpointAt > stallAfterSeconds {
		status = "stalled"
	}
	writeJSON(rw, http.StatusOK, runView{
		RunID: runID, Workflow: run.Workflow, DefinitionVersion: run.DefinitionVersion, PinnedSteps: run.PinnedSteps,
		CurrentStep: state["current_step"], Completed: completed, CheckpointAt: checkpointAt,
		PendingEffects: ledger.Incomplete(r.Context(), runID, run.PinnedSteps), Status: status,
	})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/runs/{runId}", readRun)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._
import spray.json.DefaultJsonProtocol._

import workflow.{Checkpoint, Definitions, Ledger, Runs} // Checkpoint.read · Definitions.latest · Ledger.incomplete · Runs.get

object Read {
  val route: Route =
    path("v1" / "runs" / Segment) { runId =>
      get {
        // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
        Runs.get(runId) match {
          case None => complete(StatusCodes.NotFound -> "no such run")
          case Some(run) =>
            val steps = Definitions.latest(run.workflow).map(_.steps).getOrElse(Seq.empty)
            val body = JsObject("run_id" -> JsString(runId), "workflow" -> JsString(run.workflow), "steps" -> steps.toJson, "status" -> JsString("running"))
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
import spray.json.DefaultJsonProtocol._

import workflow.{Checkpoint, Definitions, Ledger, Runs} // Checkpoint.read · Definitions.latest · Ledger.incomplete · Runs.get

object Read {
  val StallAfterSeconds = 300L

  val route: Route =
    path("v1" / "runs" / Segment) { runId =>
      get {
        optionalHeaderValueByName("X-Tenant-Id") {
          case None | Some("") => complete(StatusCodes.Unauthorized -> "X-Tenant-Id is required")
          case Some(tenant) =>
            // Another tenant's run answers exactly like a missing one, so run ids cannot be probed.
            Runs.get(runId).filter(_.tenant == tenant) match {
              case None => complete(StatusCodes.NotFound -> "no such run")
              case Some(run) =>
                // The run's own records: its pinned steps, its checkpoint, its ledger. Never the newest definition.
                val state = Checkpoint.read(runId)
                val currentStep = state.getOrElse("current_step", "")
                val checkpointAt = state.get("updated_at").map(_.toLong).getOrElse(run.startedAt)
                val status =
                  if (currentStep.isEmpty) "succeeded"
                  else if (System.currentTimeMillis() / 1000 - checkpointAt > StallAfterSeconds) "stalled"
                  else "running"
                val body = JsObject(
                  "run_id" -> JsString(runId), "workflow" -> JsString(run.workflow), "definition_version" -> JsNumber(run.definitionVersion),
                  "pinned_steps" -> run.pinnedSteps.toJson, "current_step" -> JsString(currentStep),
                  "completed" -> state.getOrElse("completed", "").split(",").filter(_.nonEmpty).toSeq.toJson,
                  "checkpoint_at" -> JsNumber(checkpointAt), "pending_effects" -> Ledger.incomplete(runId, run.pinnedSteps).toJson,
                  "status" -> JsString(status))
                complete(HttpResponse(StatusCodes.OK, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint)))
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
#include <vector>

#include "workflow/checkpoint.h"   // checkpoint::read
#include "workflow/definitions.h"  // definitions::latest
#include "workflow/ledger.h"       // ledger::incomplete
#include "workflow/runs.h"         // runs::get

using json = nlohmann::json;

void read_run(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const auto run = runs::get(req.matches[1]);
  if (!run) {
    res.status = 404;
    res.set_content(json{{"error", "no such run"}}.dump(), "application/json");
    return;
  }
  const auto definition = definitions::latest(run->workflow);
  const std::vector<std::string> steps = definition ? definition->steps : std::vector<std::string>{};
  res.set_content(json{{"run_id", run->run_id}, {"workflow", run->workflow}, {"steps", steps}, {"status", "running"}}.dump(), "application/json");
}

void register_routes(httplib::Server& svr) {
  svr.Get(R"(/v1/runs/([\\w-]+))", read_run);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <chrono>
#include <sstream>
#include <string>
#include <vector>

#include "workflow/checkpoint.h"   // checkpoint::read
#include "workflow/definitions.h"  // definitions::latest
#include "workflow/ledger.h"       // ledger::incomplete
#include "workflow/runs.h"         // runs::get

using json = nlohmann::json;

constexpr long long kStallAfterSeconds = 300;

void answerError(httplib::Response& res, int status, const std::string& message) {
  res.status = status;
  res.set_content(json{{"error", message}}.dump(), "application/json");
}

void read_run(const httplib::Request& req, httplib::Response& res) {
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) return answerError(res, 401, "X-Tenant-Id is required");
  const std::string run_id = req.matches[1];
  const auto run = runs::get(run_id);
  // Another tenant's run answers exactly like a missing one, so run ids cannot be probed.
  if (!run || run->tenant != tenant) return answerError(res, 404, "no such run");
  // The run's own records: its pinned steps, its checkpoint, its ledger. Never the newest definition.
  const auto state = checkpoint::read(run_id);
  const auto field = [&state](const std::string& name) {
    const auto it = state.find(name);
    return it == state.end() ? std::string() : it->second;
  };
  const std::string current_step = field("current_step");
  const long long checkpoint_at = field("updated_at").empty() ? run->started_at : std::stoll(field("updated_at"));
  std::vector<std::string> completed;
  std::stringstream trail(field("completed"));
  for (std::string step; std::getline(trail, step, ',');) {
    if (!step.empty()) completed.push_back(step);
  }
  const long long now = std::chrono::duration_cast<std::chrono::seconds>(std::chrono::system_clock::now().time_since_epoch()).count();
  const std::string status = current_step.empty() ? "succeeded" : now - checkpoint_at > kStallAfterSeconds ? "stalled" : "running";
  const json body = {{"run_id", run_id},
                     {"workflow", run->workflow},
                     {"definition_version", run->definition_version},
                     {"pinned_steps", run->pinned_steps},
                     {"current_step", current_step},
                     {"completed", completed},
                     {"checkpoint_at", checkpoint_at},
                     {"pending_effects", ledger::incomplete(run_id, run->pinned_steps)},
                     {"status", status}};
  res.set_content(body.dump(), "application/json");
}

void register_routes(httplib::Server& svr) {
  svr.Get(R"(/v1/runs/([\\w-]+))", read_run);
}
`,
    },
  },
  harness: {
    python: `import time

from workflow import definitions, ledger, runs

V3 = ["create_account", "send_welcome"]
V4 = ["create_account", "send_welcome", "notify_sales"]


def _setup(ctx):
    definitions.put("signup", 3, V3, [["create_account", "send_welcome"]])
    definitions.put("signup", 4, V4, [["create_account", "send_welcome"], ["send_welcome", "notify_sales"]])
    run = runs.create("t1", "signup", 3, V3, {"email": "ada@example.com"}, 50)
    return ctx.client(ctx.load("read").app), run["run_id"]


def _checkpoint(ctx, run_id, current_step, completed, updated_at):
    ctx.redis.hset(f"run:{run_id}:checkpoint", mapping={"current_step": current_step, "completed": completed, "updated_at": updated_at})


async def _read(c, run_id, tenant="t1"):
    headers = {"X-Tenant-Id": tenant} if tenant else {}
    return await c.get(f"/v1/runs/{run_id}", headers=headers)


async def check_tenant_scope(ctx):
    c, run_id = _setup(ctx)
    async with c:
        r = await _read(c, run_id, tenant=None)
        assert r.status_code == 401, f"a request without X-Tenant-Id answered {r.status_code}, expected 401"
        r = await _read(c, run_id, tenant="t2")
        assert r.status_code == 404, f"tenant t2 reading t1's run answered {r.status_code}, expected 404 (exactly what an unknown run answers)"
        assert "signup" not in r.text and "create_account" not in r.text, f"the 404 for another tenant's run carries the run: {r.text}"
        r = await _read(c, "run-404")
        assert r.status_code == 404, f"an unknown run answered {r.status_code}, expected 404"
        r = await _read(c, run_id)
    assert r.status_code == 200, f"t1 reading its own run answered {r.status_code}: {r.text}"


async def check_view(ctx):
    c, run_id = _setup(ctx)
    now = int(time.time())
    _checkpoint(ctx, run_id, "send_welcome", "create_account", now)
    async with c:
        r = await _read(c, run_id)
    assert r.status_code == 200, f"GET /v1/runs/{run_id} answered {r.status_code}: {r.text}"
    body = r.json()
    assert body.get("definition_version") == 3 and body.get("pinned_steps") == V3, f"a version-3 run answered {body}: it must report version 3 and its pinned steps, not the newest definition"
    assert body.get("current_step") == "send_welcome" and body.get("completed") == ["create_account"], f"the body says current_step {body.get('current_step')!r}, completed {body.get('completed')!r}; the checkpoint says send_welcome after create_account"
    assert body.get("checkpoint_at") == now, f"checkpoint_at is {body.get('checkpoint_at')!r}, expected the checkpoint's updated_at {now}"


async def check_pending(ctx):
    c, run_id = _setup(ctx)
    _checkpoint(ctx, run_id, "send_welcome", "create_account", int(time.time()))
    ledger.record(f"{run_id}:create_account", "acct-1")
    async with c:
        r = await _read(c, run_id)
    pending = r.json().get("pending_effects")
    assert pending == ["send_welcome"], f"with create_account recorded in the ledger, pending_effects is {pending!r}, expected ['send_welcome']"


async def check_status(ctx):
    c, run_id = _setup(ctx)
    now = int(time.time())
    async with c:
        for age, expected in ((0, "running"), (100, "running"), (600, "stalled")):
            _checkpoint(ctx, run_id, "send_welcome", "create_account", now - age)
            r = await _read(c, run_id)
            status = r.json().get("status")
            assert status == expected, f"a checkpoint written {age} s ago reports status {status!r}, expected {expected!r} (STALL_AFTER_S = 300)"
        _checkpoint(ctx, run_id, "", "create_account,send_welcome", now)
        r = await _read(c, run_id)
    status = r.json().get("status")
    assert status == "succeeded", f"a run whose current_step is '' reports status {status!r}, expected 'succeeded'"
`,
    typescript: `const V3 = ['create_account', 'send_welcome'];
const V4 = ['create_account', 'send_welcome', 'notify_sales'];

async function setup(ctx) {
  const definitions = ctx.load('/support/workflow/definitions.ts');
  const runs = ctx.load('/support/workflow/runs.ts');
  await definitions.put('signup', 3, V3, [['create_account', 'send_welcome']]);
  await definitions.put('signup', 4, V4, [
    ['create_account', 'send_welcome'],
    ['send_welcome', 'notify_sales'],
  ]);
  const run = await runs.create('t1', 'signup', 3, V3, {email: 'ada@example.com'}, 50);
  return {c: ctx.client(ctx.load('read').app), runId: run.run_id as string, ledger: ctx.load('/support/workflow/ledger.ts')};
}

const nowS = (): number => Math.floor(Date.now() / 1000);

function setCheckpoint(ctx, runId: string, currentStep: string, completed: string, updatedAt: number): void {
  ctx.redis.hset(\`run:\${runId}:checkpoint\`, 'current_step', currentStep, 'completed', completed, 'updated_at', String(updatedAt));
}

const read = (c, runId: string, tenant: string | null = 't1') => c.get(\`/v1/runs/\${runId}\`, {headers: tenant === null ? {} : {'X-Tenant-Id': tenant}});

export async function check_tenant_scope(ctx) {
  const {c, runId} = await setup(ctx);
  let r = await read(c, runId, null);
  assert.equal(r.status, 401, \`a request without X-Tenant-Id answered \${r.status}, expected 401\`);
  r = await read(c, runId, 't2');
  assert.equal(r.status, 404, \`tenant t2 reading t1's run answered \${r.status}, expected 404 (exactly what an unknown run answers)\`);
  assert(!r.text.includes('signup') && !r.text.includes('create_account'), \`the 404 for another tenant's run carries the run: \${r.text}\`);
  r = await read(c, 'run-404');
  assert.equal(r.status, 404, \`an unknown run answered \${r.status}, expected 404\`);
  r = await read(c, runId);
  assert.equal(r.status, 200, \`t1 reading its own run answered \${r.status}: \${r.text}\`);
}

export async function check_view(ctx) {
  const {c, runId} = await setup(ctx);
  const now = nowS();
  setCheckpoint(ctx, runId, 'send_welcome', 'create_account', now);
  const r = await read(c, runId);
  assert.equal(r.status, 200, \`GET /v1/runs/\${runId} answered \${r.status}: \${r.text}\`);
  const body = r.json();
  assert(body.definition_version === 3 && JSON.stringify(body.pinned_steps) === JSON.stringify(V3), \`a version-3 run answered \${r.text}: it must report version 3 and its pinned steps, not the newest definition\`);
  assert(
    body.current_step === 'send_welcome' && JSON.stringify(body.completed) === JSON.stringify(['create_account']),
    \`the body says current_step \${JSON.stringify(body.current_step)}, completed \${JSON.stringify(body.completed)}; the checkpoint says send_welcome after create_account\`,
  );
  assert.equal(body.checkpoint_at, now, "checkpoint_at must be the checkpoint's updated_at");
}

export async function check_pending(ctx) {
  const {c, runId, ledger} = await setup(ctx);
  setCheckpoint(ctx, runId, 'send_welcome', 'create_account', nowS());
  await ledger.record(\`\${runId}:create_account\`, 'acct-1');
  const pending = (await read(c, runId)).json().pending_effects;
  assert.deepStrictEqual(pending, ['send_welcome'], \`with create_account recorded in the ledger, pending_effects is \${JSON.stringify(pending)}, expected ["send_welcome"]\`);
}

export async function check_status(ctx) {
  const {c, runId} = await setup(ctx);
  const now = nowS();
  for (const [age, expected] of [
    [0, 'running'],
    [100, 'running'],
    [600, 'stalled'],
  ] as const) {
    setCheckpoint(ctx, runId, 'send_welcome', 'create_account', now - age);
    const status = (await read(c, runId)).json().status;
    assert.equal(status, expected, \`a checkpoint written \${age} s ago reports status \${JSON.stringify(status)}, expected \${expected} (STALL_AFTER_S = 300)\`);
  }
  setCheckpoint(ctx, runId, '', 'create_account,send_welcome', now);
  const status = (await read(c, runId)).json().status;
  assert.equal(status, 'succeeded', \`a run whose current_step is '' reports status \${JSON.stringify(status)}, expected succeeded\`);
}
`,
    go: `package main

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"time"

	"workflow/definitions"
	"workflow/ledger"
	"workflow/runs"

	"leetbuild/harness"
)

var (
	readBg = context.Background()
	readV3 = []string{"create_account", "send_welcome"}
	readV4 = []string{"create_account", "send_welcome", "notify_sales"}
)

type readBody struct {
	DefinitionVersion int      \`json:"definition_version"\`
	PinnedSteps       []string \`json:"pinned_steps"\`
	CurrentStep       string   \`json:"current_step"\`
	Completed         []string \`json:"completed"\`
	CheckpointAt      int64    \`json:"checkpoint_at"\`
	PendingEffects    []string \`json:"pending_effects"\`
	Status            string   \`json:"status"\`
}

func readSetup(ctx *harness.Ctx) (*harness.HTTP, string) {
	definitions.Put(readBg, "signup", 3, readV3, [][]string{{"create_account", "send_welcome"}})
	definitions.Put(readBg, "signup", 4, readV4, [][]string{{"create_account", "send_welcome"}, {"send_welcome", "notify_sales"}})
	run := runs.Create(readBg, "t1", "signup", 3, readV3, map[string]any{"email": "ada@example.com"}, 50)
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux), run.RunID
}

func setCheckpoint(ctx *harness.Ctx, runID, currentStep, completed string, updatedAt int64) {
	ctx.Redis.Do("HSET", "run:"+runID+":checkpoint", "current_step", currentStep, "completed", completed, "updated_at", fmt.Sprint(updatedAt))
}

func readAs(c *harness.HTTP, runID, tenant string) *harness.Response {
	if tenant == "" {
		return c.Get("/v1/runs/" + runID)
	}
	return c.Get("/v1/runs/"+runID, "X-Tenant-Id", tenant)
}

func decodeRead(r *harness.Response) readBody {
	var body readBody
	r.Decode(&body)
	return body
}

func CheckTenantScope(ctx *harness.Ctx) {
	c, runID := readSetup(ctx)
	ctx.Equal(readAs(c, runID, "").Status, 401, "a request without X-Tenant-Id; the status")
	r := readAs(c, runID, "t2")
	ctx.Equal(r.Status, 404, "tenant t2 reading t1's run must get exactly what an unknown run gets; the status")
	ctx.Assert(!strings.Contains(r.Text(), "signup") && !strings.Contains(r.Text(), "create_account"), "the 404 for another tenant's run carries the run: %s", r.Text())
	ctx.Equal(readAs(c, "run-404", "t1").Status, 404, "an unknown run; the status")
	r = readAs(c, runID, "t1")
	ctx.Equal(r.Status, 200, "t1 reading its own run (%s); the status", r.Text())
}

func CheckView(ctx *harness.Ctx) {
	c, runID := readSetup(ctx)
	now := time.Now().Unix()
	setCheckpoint(ctx, runID, "send_welcome", "create_account", now)
	r := readAs(c, runID, "t1")
	ctx.Equal(r.Status, 200, "GET /v1/runs/%s (%s); the status", runID, r.Text())
	body := decodeRead(r)
	ctx.Assert(body.DefinitionVersion == 3 && strings.Join(body.PinnedSteps, ",") == strings.Join(readV3, ","), "a version-3 run answered %s: it must report version 3 and its pinned steps, not the newest definition", r.Text())
	ctx.Assert(body.CurrentStep == "send_welcome" && strings.Join(body.Completed, ",") == "create_account", "the body says current_step %q, completed %q; the checkpoint says send_welcome after create_account", body.CurrentStep, body.Completed)
	ctx.Equal(body.CheckpointAt, now, "checkpoint_at must be the checkpoint's updated_at")
}

func CheckPending(ctx *harness.Ctx) {
	c, runID := readSetup(ctx)
	setCheckpoint(ctx, runID, "send_welcome", "create_account", time.Now().Unix())
	ledger.Record(readBg, runID+":create_account", "acct-1")
	ctx.Equal(decodeRead(readAs(c, runID, "t1")).PendingEffects, []string{"send_welcome"}, "with create_account recorded in the ledger, pending_effects")
}

func CheckStatus(ctx *harness.Ctx) {
	c, runID := readSetup(ctx)
	now := time.Now().Unix()
	for _, tc := range []struct {
		age  int64
		want string
	}{{0, "running"}, {100, "running"}, {600, "stalled"}} {
		setCheckpoint(ctx, runID, "send_welcome", "create_account", now-tc.age)
		ctx.Equal(decodeRead(readAs(c, runID, "t1")).Status, tc.want, "a checkpoint written %d s ago (stallAfterSeconds = 300); the status", tc.age)
	}
	setCheckpoint(ctx, runID, "", "create_account,send_welcome", now)
	ctx.Equal(decodeRead(readAs(c, runID, "t1")).Status, "succeeded", "a run whose current_step is ''; the status")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <chrono>
#include <string>
#include <vector>

#include "workflow/definitions.h"
#include "workflow/ledger.h"
#include "workflow/runs.h"

namespace {

const std::vector<std::string> kV3 = {"create_account", "send_welcome"};
const std::vector<std::string> kV4 = {"create_account", "send_welcome", "notify_sales"};

struct Fixture {
  harness::HTTP c;
  std::string run_id;
};

Fixture setup(harness::Ctx& ctx) {
  definitions::put("signup", 3, kV3, {{"create_account", "send_welcome"}});
  definitions::put("signup", 4, kV4, {{"create_account", "send_welcome"}, {"send_welcome", "notify_sales"}});
  const runs::Run run = runs::create("t1", "signup", 3, kV3, nlohmann::json{{"email", "ada@example.com"}}, 50);
  static httplib::Server* svr = nullptr;
  delete svr;
  svr = new httplib::Server;
  register_routes(*svr);
  return Fixture{ctx.HTTP(*svr), run.run_id};
}

long long nowSeconds() {
  return std::chrono::duration_cast<std::chrono::seconds>(std::chrono::system_clock::now().time_since_epoch()).count();
}

void setCheckpoint(harness::Ctx& ctx, const std::string& run_id, const std::string& current_step, const std::string& completed, long long updated_at) {
  ctx.Redis.Do("HSET", "run:" + run_id + ":checkpoint", "current_step", current_step, "completed", completed, "updated_at", std::to_string(updated_at));
}

nlohmann::json body(const harness::Response& r) {
  const auto parsed = nlohmann::json::parse(r.Text(), nullptr, false);
  return parsed.is_object() ? parsed : nlohmann::json::object();
}

}  // namespace

void CheckTenantScope(harness::Ctx& ctx) {
  auto f = setup(ctx);
  ctx.Equal(f.c.Get("/v1/runs/" + f.run_id).Status, 401, "a request without X-Tenant-Id; the status");
  auto r = f.c.Get("/v1/runs/" + f.run_id, "X-Tenant-Id", "t2");
  ctx.Equal(r.Status, 404, "tenant t2 reading t1's run must get exactly what an unknown run gets; the status");
  ctx.Assert(r.Text().find("signup") == std::string::npos && r.Text().find("create_account") == std::string::npos, "the 404 for another tenant's run carries the run: %s", r.Text());
  ctx.Equal(f.c.Get("/v1/runs/run-404", "X-Tenant-Id", "t1").Status, 404, "an unknown run; the status");
  r = f.c.Get("/v1/runs/" + f.run_id, "X-Tenant-Id", "t1");
  ctx.Equal(r.Status, 200, "t1 reading its own run (%s); the status", r.Text());
}

void CheckView(harness::Ctx& ctx) {
  auto f = setup(ctx);
  const long long now = nowSeconds();
  setCheckpoint(ctx, f.run_id, "send_welcome", "create_account", now);
  const auto r = f.c.Get("/v1/runs/" + f.run_id, "X-Tenant-Id", "t1");
  ctx.Equal(r.Status, 200, "GET /v1/runs/%s (%s); the status", f.run_id, r.Text());
  const auto b = body(r);
  ctx.Assert(b.value("definition_version", 0L) == 3 && b.value("pinned_steps", std::vector<std::string>{}) == kV3, "a version-3 run answered %s: it must report version 3 and its pinned steps, not the newest definition", r.Text());
  ctx.Assert(b.value("current_step", "") == "send_welcome" && b.value("completed", std::vector<std::string>{}) == std::vector<std::string>{"create_account"},
             "the body is %s; the checkpoint says send_welcome after create_account", r.Text());
  ctx.Equal(b.value("checkpoint_at", 0LL), now, "checkpoint_at must be the checkpoint's updated_at");
}

void CheckPending(harness::Ctx& ctx) {
  auto f = setup(ctx);
  setCheckpoint(ctx, f.run_id, "send_welcome", "create_account", nowSeconds());
  ledger::record(f.run_id + ":create_account", "acct-1");
  const auto b = body(f.c.Get("/v1/runs/" + f.run_id, "X-Tenant-Id", "t1"));
  ctx.Equal(b.value("pending_effects", std::vector<std::string>{}), std::vector<std::string>{"send_welcome"}, "with create_account recorded in the ledger, pending_effects");
}

void CheckStatus(harness::Ctx& ctx) {
  auto f = setup(ctx);
  const long long now = nowSeconds();
  const std::vector<std::pair<long long, std::string>> cases = {{0, "running"}, {100, "running"}, {600, "stalled"}};
  for (const auto& [age, want] : cases) {
    setCheckpoint(ctx, f.run_id, "send_welcome", "create_account", now - age);
    ctx.Equal(body(f.c.Get("/v1/runs/" + f.run_id, "X-Tenant-Id", "t1")).value("status", ""), want, "a checkpoint written %d s ago (kStallAfterSeconds = 300); the status", age);
  }
  setCheckpoint(ctx, f.run_id, "", "create_account,send_welcome", now);
  ctx.Equal(body(f.c.Get("/v1/runs/" + f.run_id, "X-Tenant-Id", "t1")).value("status", ""), "succeeded", "a run whose current_step is ''; the status");
}
`,
  },
  hints: [
    "Open a version-3 run after version 4 is published: the body lists `notify_sales`, which the run will never execute. It says `running` for a run untouched for an hour and for one that finished, and another tenant's id works too.",
    "`read_run` answers from `definitions.latest`, the newest definition, instead of the run's pinned steps and checkpoint. It never reads `X-Tenant-Id`, and the status is a constant.",
    '401 without `X-Tenant-Id`, 404 when `run["tenant"] != tenant`; `state = checkpoint.read(run_id)`; answer `pinned_steps`, `current_step`, `completed`, `checkpoint_at`, `ledger.incomplete(run_id, pinned_steps)` and a status from `current_step` and `STALL_AFTER_S`.',
  ],
  debrief: `The endpoint describes one run, so every field comes from that run's own records: the pinned steps from the run, the position from the checkpoint, the pending effects from the ledger. In the demo the newest definition and the pinned one agree, which is why the starter looks right until the next publish. A foreign run answers 404 rather than 403 so a caller cannot learn which run ids exist. The status is derived, not stored: \`stalled\` is a fact about time since the last advance, and it sends an operator to the worker before the mailer. Temporal's \`DescribeWorkflowExecution\` answers the same question with its pending activities, each with an attempt count and the last failure, which this endpoint does not track yet.`,
};
