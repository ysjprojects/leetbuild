import type {Step} from '@/lib/types';

export const trainingEndpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/training/runs: one clamped, known, idempotent run',
  concept: 'http',
  file: 'api',
  focus: ['client', 'scheduler', 'store', 'redis'],
  task: `## Task

**Starting point.** The starter serves \`POST /v1/training/runs\` with body
\`{"dataset_version", "recipe_version", "priority"}\`: it reads \`X-Tenant-Id\` (**401** without it),
mints \`run-<epoch ms>\` as the run id, maps the priority to a band with
\`(PRIORITY_MAX - priority) // BAND_WIDTH\`, writes the row with \`runs.put\`, queues it with
\`queue.enqueue\` (both provided in \`trainsched\`) and answers **201** \`{run_id, state, priority, band}\`.
It serves the demo and hides four flaws.

**Failure mode the checks target.** A caller sends \`priority: 999999\` and lands ahead of every
high-band run; a typo in \`recipe_version\` is queued and holds a GPU slot for a job that can only
fail; a client that times out and retries starts a second run; and two submissions in the same
millisecond share one id, so the second overwrites the first.

- \`priority\` (default 4) is clamped into \`PRIORITY_MIN..PRIORITY_MAX\` (0..8) before the band is
  computed: band 0 holds 6..8, band 1 holds 3..5, band 2 holds 0..2.
- \`recipe_version\` must be in \`KNOWN_RECIPES\`; anything else is **400** and nothing is written.
- \`Idempotency-Key\` is required (**400**). \`runs.run_for_key(tenant, key)\` answers a retry with the
  run it created (**200**); a new run is bound with \`runs.bind_key\`.
- The run id comes from \`runs.new_run_id()\`, a Redis sequence every replica shares.`,
  sequence: {
    participants: ['Client', 'Training Scheduler', 'run store', 'Redis queue'],
    messages: [
      {
        from: 'Client',
        to: 'Training Scheduler',
        label: 'POST /v1/training/runs · X-Tenant-Id · Idempotency-Key',
        kind: 'sync',
      },
      {from: 'Training Scheduler', to: 'run store', label: 'run_for_key(tenant, key)', kind: 'sync'},
      {from: 'run store', to: 'Training Scheduler', label: 'the run a retry created → 200', kind: 'reply'},
      {
        from: 'Training Scheduler',
        to: 'Training Scheduler',
        label: 'KNOWN_RECIPES → 400 · clamp priority → band',
        kind: 'sync',
      },
      {from: 'Training Scheduler', to: 'run store', label: 'new_run_id · put(run) · bind_key', kind: 'sync'},
      {from: 'Training Scheduler', to: 'Redis queue', label: 'enqueue(run_id, band, enqueued_at_ms)', kind: 'sync'},
      {from: 'Training Scheduler', to: 'Client', label: '201 {run_id, state: queued, priority, band}', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Queues a valid submission on POST /v1/training/runs',
      detail:
        'A valid submission answers **201** with the run id and `state: "queued"`, its row is in the run store and it waits in `training:queue`.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/training\/runs["']/, /queue\.enqueue\(/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/training\/runs['"]/, /enqueue\(/]},
        go: {all: [/HandleFunc\(\s*"POST \/v1\/training\/runs"/, /queue\.Enqueue\(/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"training"\s*\/\s*"runs"\s*\)/, /\bpost\s*\{/, /Queue\.enqueue\(/]},
        cpp: {all: [/svr\.Post\(\s*"\/v1\/training\/runs"/, /queue::enqueue\(/]},
      },
    },
    {
      id: 'priority-band',
      title: 'Clamps the priority before it picks the band',
      detail:
        '`priority: 999999` is answered as priority 8 in band 0 and waits behind a priority-8 run submitted earlier; `-5` is priority 0 in band 2. The starter bands the raw integer, so a large value scores ahead of the whole queue.',
      match: {
        python: {all: [/min\([^\n]*PRIORITY_MAX|>\s*PRIORITY_MAX/, /max\([^\n]*PRIORITY_MIN|<\s*PRIORITY_MIN/]},
        typescript: {
          all: [/Math\.min\([^\n]*PRIORITY_MAX|>\s*PRIORITY_MAX/, /Math\.max\([^\n]*PRIORITY_MIN|<\s*PRIORITY_MIN/],
        },
        go: {all: [/min\([^\n]*priorityMax|>\s*priorityMax/, /max\([^\n]*priorityMin|<\s*priorityMin/]},
        scala: {all: [/min\([^\n]*PriorityMax|>\s*PriorityMax/, /max\([^\n]*PriorityMin|<\s*PriorityMin/]},
        cpp: {
          all: [
            /clamp\([^\n]*kPriorityMax|min\([^\n]*kPriorityMax|>\s*kPriorityMax/,
            /clamp\([^\n]*kPriorityMin|max\([^\n]*kPriorityMin|<\s*kPriorityMin/,
          ],
        },
      },
    },
    {
      id: 'recipe-version',
      title: 'Rejects an unknown recipe before anything is written',
      detail:
        'A `recipe_version` outside `KNOWN_RECIPES` is **400**, with no run row and no queue entry. The starter queues whatever it is sent.',
      match: {
        python: {all: [/not in KNOWN_RECIPES/, /\b400\b/], order: [/not in KNOWN_RECIPES/, /queue\.enqueue\(/]},
        typescript: {all: [/KNOWN_RECIPES\.has\(/, /\b400\b/], order: [/KNOWN_RECIPES\.has\(/, /enqueue\(run/]},
        go: {all: [/knownRecipes\[/, /StatusBadRequest|\b400\b/], order: [/knownRecipes\[/, /queue\.Enqueue\(/]},
        scala: {
          all: [/KnownRecipes\.contains\(/, /BadRequest/],
          order: [/KnownRecipes\.contains\(/, /Queue\.enqueue\(/],
        },
        cpp: {
          all: [/kKnownRecipes\.(count|find|contains)\(/, /\b400\b/],
          order: [/kKnownRecipes\.(count|find|contains)\(/, /queue::enqueue\(/],
        },
      },
    },
    {
      id: 'idempotency',
      title: 'A retry of (tenant, Idempotency-Key) answers the run it created',
      detail:
        '`Idempotency-Key` is required (**400**); the key is looked up with `run_for_key` before anything is queued and a new run is bound with `bind_key`, so a retry answers **200** with the same `run_id` and the queue holds one entry. The starter ignores the header.',
      match: {
        python: {
          all: [/idempotency-key/i, /runs\.run_for_key\(/, /runs\.bind_key\(/],
          order: [/runs\.run_for_key\(/, /queue\.enqueue\(/],
        },
        typescript: {all: [/idempotency-key/i, /runForKey\(/, /bindKey\(/], order: [/runForKey\(/, /enqueue\(run/]},
        go: {
          all: [/Idempotency-Key/i, /runs\.RunForKey\(/, /runs\.BindKey\(/],
          order: [/runs\.RunForKey\(/, /queue\.Enqueue\(/],
        },
        scala: {
          all: [/Idempotency-Key/i, /Runs\.runForKey\(/, /Runs\.bindKey\(/],
          order: [/Runs\.runForKey\(/, /Queue\.enqueue\(/],
        },
        cpp: {
          all: [/Idempotency-Key/i, /runs::runForKey\(/, /runs::bindKey\(/],
          order: [/runs::runForKey\(/, /queue::enqueue\(/],
        },
      },
    },
    {
      id: 'unique-run-id',
      title: 'Takes the run id from the shared sequence',
      detail:
        'Two submissions in the same millisecond get two run ids and keep two rows. The starter derives the id from the clock, so the second run overwrites the first.',
      match: {
        python: {all: [/runs\.new_run_id\(\)/], none: [/f["']run-\{/]},
        typescript: {all: [/newRunId\(\)/], none: [/`run-\$\{/]},
        go: {all: [/runs\.NewRunID\(/], none: [/"run-%d"|"run-"\s*\+/]},
        scala: {all: [/Runs\.newRunId\(\)/], none: [/s"run-\$/]},
        cpp: {all: [/runs::newRunId\(\)/], none: [/"run-"\s*\+/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import time

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from trainsched import queue, runs  # runs.new_run_id, put, get, run_for_key, bind_key; queue.enqueue

app = FastAPI()

PRIORITY_MIN = 0
PRIORITY_MAX = 8
BAND_WIDTH = 3  # band 0: priorities 6-8, band 1: 3-5, band 2: 0-2
KNOWN_RECIPES = {"llama-ft-v3", "vit-pretrain-v1", "embed-distill-v2"}


class Submission(BaseModel):
    dataset_version: str
    recipe_version: str
    priority: int = 4


def view(run: dict) -> dict:
    return {"run_id": run["run_id"], "state": run["state"], "priority": run["priority"], "band": run["band"]}


@app.post("/v1/training/runs")
def submit(body: Submission, request: Request) -> JSONResponse:
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    tenant = request.headers.get("x-tenant-id", "")
    if not tenant:
        raise HTTPException(status_code=401, detail="X-Tenant-Id is required")
    now_ms = int(time.time() * 1000)
    run = {
        "run_id": f"run-{now_ms}",
        "tenant": tenant,
        "recipe_version": body.recipe_version,
        "dataset_version": body.dataset_version,
        "priority": body.priority,
        "band": (PRIORITY_MAX - body.priority) // BAND_WIDTH,
        "state": "queued",
        "enqueued_at_ms": now_ms,
    }
    runs.put(run)
    queue.enqueue(run["run_id"], run["band"], run["enqueued_at_ms"])
    return JSONResponse(view(run), status_code=201)
`,
      solution: `import time

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from trainsched import queue, runs  # runs.new_run_id, put, get, run_for_key, bind_key; queue.enqueue

app = FastAPI()

PRIORITY_MIN = 0
PRIORITY_MAX = 8
BAND_WIDTH = 3  # band 0: priorities 6-8, band 1: 3-5, band 2: 0-2
KNOWN_RECIPES = {"llama-ft-v3", "vit-pretrain-v1", "embed-distill-v2"}


class Submission(BaseModel):
    dataset_version: str
    recipe_version: str
    priority: int = 4


def view(run: dict) -> dict:
    return {"run_id": run["run_id"], "state": run["state"], "priority": run["priority"], "band": run["band"]}


@app.post("/v1/training/runs")
def submit(body: Submission, request: Request) -> JSONResponse:
    tenant = request.headers.get("x-tenant-id", "")
    if not tenant:
        raise HTTPException(status_code=401, detail="X-Tenant-Id is required")
    key = request.headers.get("idempotency-key", "")
    if not key:
        raise HTTPException(status_code=400, detail="Idempotency-Key is required")
    replayed = runs.run_for_key(tenant, key)
    if replayed is not None:
        return JSONResponse(view(runs.get(replayed)), status_code=200)  # a retry answers the run it created
    if body.recipe_version not in KNOWN_RECIPES:
        raise HTTPException(status_code=400, detail=f"unknown recipe_version {body.recipe_version!r}")
    # Clamp first: the band is computed from a priority the scheduler supports.
    priority = min(max(body.priority, PRIORITY_MIN), PRIORITY_MAX)
    run = {
        "run_id": runs.new_run_id(),
        "tenant": tenant,
        "recipe_version": body.recipe_version,
        "dataset_version": body.dataset_version,
        "priority": priority,
        "band": (PRIORITY_MAX - priority) // BAND_WIDTH,
        "state": "queued",
        "enqueued_at_ms": int(time.time() * 1000),
    }
    runs.put(run)
    runs.bind_key(tenant, key, run["run_id"])
    queue.enqueue(run["run_id"], run["band"], run["enqueued_at_ms"])
    return JSONResponse(view(run), status_code=201)
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';

import {enqueue} from 'trainsched/queue';
import {type Run, bindKey, get, newRunId, put, runForKey} from 'trainsched/runs';

export const app = Fastify();

export const PRIORITY_MIN = 0;
export const PRIORITY_MAX = 8;
export const BAND_WIDTH = 3; // band 0: priorities 6-8, band 1: 3-5, band 2: 0-2
export const KNOWN_RECIPES = new Set(['llama-ft-v3', 'vit-pretrain-v1', 'embed-distill-v2']);

interface Submission {
  dataset_version: string;
  recipe_version: string;
  priority?: number;
}

const view = (run: Run) => ({run_id: run.run_id, state: run.state, priority: run.priority, band: run.band});

app.post('/v1/training/runs', async (request, reply) => {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'X-Tenant-Id is required'});
  const body = request.body as Submission;
  const priority = body.priority ?? 4;
  const nowMs = Date.now();
  const run: Run = {
    run_id: \`run-\${nowMs}\`,
    tenant,
    recipe_version: body.recipe_version,
    dataset_version: body.dataset_version,
    priority,
    band: Math.floor((PRIORITY_MAX - priority) / BAND_WIDTH),
    state: 'queued',
    enqueued_at_ms: nowMs,
    worker: '',
    nodes: [],
    checkpoint_id: '',
  };
  await put(run);
  await enqueue(run.run_id, run.band, run.enqueued_at_ms);
  return reply.code(201).send(view(run));
});
`,
      solution: `import Fastify from 'fastify';

import {enqueue} from 'trainsched/queue';
import {type Run, bindKey, get, newRunId, put, runForKey} from 'trainsched/runs';

export const app = Fastify();

export const PRIORITY_MIN = 0;
export const PRIORITY_MAX = 8;
export const BAND_WIDTH = 3; // band 0: priorities 6-8, band 1: 3-5, band 2: 0-2
export const KNOWN_RECIPES = new Set(['llama-ft-v3', 'vit-pretrain-v1', 'embed-distill-v2']);

interface Submission {
  dataset_version: string;
  recipe_version: string;
  priority?: number;
}

const view = (run: Run) => ({run_id: run.run_id, state: run.state, priority: run.priority, band: run.band});

app.post('/v1/training/runs', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'X-Tenant-Id is required'});
  const key = request.headers['idempotency-key'];
  if (typeof key !== 'string' || key === '') return reply.code(400).send({error: 'Idempotency-Key is required'});
  const replayed = await runForKey(tenant, key);
  if (replayed !== null) return reply.code(200).send(view((await get(replayed)) as Run)); // a retry answers the run it created
  const body = request.body as Submission;
  if (!KNOWN_RECIPES.has(body.recipe_version)) return reply.code(400).send({error: \`unknown recipe_version \${body.recipe_version}\`});
  // Clamp first: the band is computed from a priority the scheduler supports.
  const priority = Math.min(Math.max(body.priority ?? 4, PRIORITY_MIN), PRIORITY_MAX);
  const run: Run = {
    run_id: await newRunId(),
    tenant,
    recipe_version: body.recipe_version,
    dataset_version: body.dataset_version,
    priority,
    band: Math.floor((PRIORITY_MAX - priority) / BAND_WIDTH),
    state: 'queued',
    enqueued_at_ms: Date.now(),
    worker: '',
    nodes: [],
    checkpoint_id: '',
  };
  await put(run);
  await bindKey(tenant, key, run.run_id);
  await enqueue(run.run_id, run.band, run.enqueued_at_ms);
  return reply.code(201).send(view(run));
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"trainsched/queue" // queue.Enqueue
	"trainsched/runs"  // runs.NewRunID, Put, Get, RunForKey, BindKey
)

const (
	priorityMin = 0
	priorityMax = 8
	bandWidth   = 3 // band 0: priorities 6-8, band 1: 3-5, band 2: 0-2
)

var knownRecipes = map[string]bool{"llama-ft-v3": true, "vit-pretrain-v1": true, "embed-distill-v2": true}

type submission struct {
	DatasetVersion string \`json:"dataset_version"\`
	RecipeVersion  string \`json:"recipe_version"\`
	Priority       int    \`json:"priority"\`
}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func view(run *runs.Run) map[string]any {
	return map[string]any{"run_id": run.RunID, "state": run.State, "priority": run.Priority, "band": run.Band}
}

func submit(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "X-Tenant-Id is required"})
		return
	}
	body := submission{Priority: 4}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid JSON body"})
		return
	}
	nowMs := time.Now().UnixMilli()
	run := &runs.Run{
		RunID: fmt.Sprintf("run-%d", nowMs), Tenant: tenant, RecipeVersion: body.RecipeVersion, DatasetVersion: body.DatasetVersion,
		Priority: body.Priority, Band: (priorityMax - body.Priority) / bandWidth, State: "queued", EnqueuedAtMs: nowMs, Nodes: []string{},
	}
	if err := runs.Put(r.Context(), run); err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": err.Error()})
		return
	}
	queue.Enqueue(r.Context(), run.RunID, run.Band, run.EnqueuedAtMs)
	writeJSON(rw, http.StatusCreated, view(run))
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/training/runs", submit)
}
`,
      solution: `package main

import (
	"encoding/json"
	"net/http"
	"time"

	"trainsched/queue" // queue.Enqueue
	"trainsched/runs"  // runs.NewRunID, Put, Get, RunForKey, BindKey
)

const (
	priorityMin = 0
	priorityMax = 8
	bandWidth   = 3 // band 0: priorities 6-8, band 1: 3-5, band 2: 0-2
)

var knownRecipes = map[string]bool{"llama-ft-v3": true, "vit-pretrain-v1": true, "embed-distill-v2": true}

type submission struct {
	DatasetVersion string \`json:"dataset_version"\`
	RecipeVersion  string \`json:"recipe_version"\`
	Priority       int    \`json:"priority"\`
}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func view(run *runs.Run) map[string]any {
	return map[string]any{"run_id": run.RunID, "state": run.State, "priority": run.Priority, "band": run.Band}
}

func submit(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "X-Tenant-Id is required"})
		return
	}
	key := r.Header.Get("Idempotency-Key")
	if key == "" {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "Idempotency-Key is required"})
		return
	}
	if replayed := runs.RunForKey(r.Context(), tenant, key); replayed != "" {
		writeJSON(rw, http.StatusOK, view(runs.Get(r.Context(), replayed))) // a retry answers the run it created
		return
	}
	body := submission{Priority: 4}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid JSON body"})
		return
	}
	if !knownRecipes[body.RecipeVersion] {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "unknown recipe_version " + body.RecipeVersion})
		return
	}
	// Clamp first: the band is computed from a priority the scheduler supports.
	priority := body.Priority
	if priority < priorityMin {
		priority = priorityMin
	}
	if priority > priorityMax {
		priority = priorityMax
	}
	run := &runs.Run{
		RunID: runs.NewRunID(r.Context()), Tenant: tenant, RecipeVersion: body.RecipeVersion, DatasetVersion: body.DatasetVersion,
		Priority: priority, Band: (priorityMax - priority) / bandWidth, State: "queued", EnqueuedAtMs: time.Now().UnixMilli(), Nodes: []string{},
	}
	if err := runs.Put(r.Context(), run); err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": err.Error()})
		return
	}
	runs.BindKey(r.Context(), tenant, key, run.RunID)
	queue.Enqueue(r.Context(), run.RunID, run.Band, run.EnqueuedAtMs)
	writeJSON(rw, http.StatusCreated, view(run))
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/training/runs", submit)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import trainsched.{Queue, Runs} // Runs.newRunId, put, get, runForKey, bindKey; Queue.enqueue

object Submit {
  val PriorityMin = 0
  val PriorityMax = 8
  val BandWidth = 3 // band 0: priorities 6-8, band 1: 3-5, band 2: 0-2
  val KnownRecipes: Set[String] = Set("llama-ft-v3", "vit-pretrain-v1", "embed-distill-v2")

  private def json(status: StatusCode, body: JsObject): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  private def view(run: Runs.Run): JsObject =
    JsObject("run_id" -> JsString(run.runId), "state" -> JsString(run.state), "priority" -> JsNumber(run.priority), "band" -> JsNumber(run.band))

  private def text(body: JsObject, name: String): String = body.fields.get(name).collect { case JsString(s) => s }.getOrElse("")

  val route: Route =
    path("v1" / "training" / "runs") {
      post {
        optionalHeaderValueByName("X-Tenant-Id") { tenant =>
          entity(as[String]) { raw =>
            // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
            tenant.filter(_.nonEmpty) match {
              case None => complete(StatusCodes.Unauthorized -> "X-Tenant-Id is required")
              case Some(t) =>
                val body = raw.parseJson.asJsObject
                val priority = body.fields.get("priority").collect { case JsNumber(n) => n.toInt }.getOrElse(4)
                val nowMs = System.currentTimeMillis()
                val run = Runs.Run(s"run-$nowMs", t, text(body, "recipe_version"), text(body, "dataset_version"), priority, (PriorityMax - priority) / BandWidth, "queued", nowMs)
                Runs.put(run)
                Queue.enqueue(run.runId, run.band, run.enqueuedAtMs)
                complete(json(StatusCodes.Created, view(run)))
            }
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

import trainsched.{Queue, Runs} // Runs.newRunId, put, get, runForKey, bindKey; Queue.enqueue

object Submit {
  val PriorityMin = 0
  val PriorityMax = 8
  val BandWidth = 3 // band 0: priorities 6-8, band 1: 3-5, band 2: 0-2
  val KnownRecipes: Set[String] = Set("llama-ft-v3", "vit-pretrain-v1", "embed-distill-v2")

  private def json(status: StatusCode, body: JsObject): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  private def view(run: Runs.Run): JsObject =
    JsObject("run_id" -> JsString(run.runId), "state" -> JsString(run.state), "priority" -> JsNumber(run.priority), "band" -> JsNumber(run.band))

  private def text(body: JsObject, name: String): String = body.fields.get(name).collect { case JsString(s) => s }.getOrElse("")

  val route: Route =
    path("v1" / "training" / "runs") {
      post {
        optionalHeaderValueByName("X-Tenant-Id") { tenant =>
          optionalHeaderValueByName("Idempotency-Key") { key =>
            entity(as[String]) { raw =>
              (tenant.filter(_.nonEmpty), key.filter(_.nonEmpty)) match {
                case (None, _) => complete(StatusCodes.Unauthorized -> "X-Tenant-Id is required")
                case (_, None) => complete(StatusCodes.BadRequest -> "Idempotency-Key is required")
                case (Some(t), Some(k)) =>
                  Runs.runForKey(t, k).flatMap(Runs.get) match {
                    case Some(replayed) => complete(json(StatusCodes.OK, view(replayed))) // a retry answers the run it created
                    case None =>
                      val body = raw.parseJson.asJsObject
                      val recipe = text(body, "recipe_version")
                      if (!KnownRecipes.contains(recipe)) complete(StatusCodes.BadRequest -> s"unknown recipe_version $recipe")
                      else {
                        // Clamp first: the band is computed from a priority the scheduler supports.
                        val requested = body.fields.get("priority").collect { case JsNumber(n) => n.toInt }.getOrElse(4)
                        val priority = math.min(math.max(requested, PriorityMin), PriorityMax)
                        val run = Runs.Run(Runs.newRunId(), t, recipe, text(body, "dataset_version"), priority, (PriorityMax - priority) / BandWidth, "queued", System.currentTimeMillis())
                        Runs.put(run)
                        Runs.bindKey(t, k, run.runId)
                        Queue.enqueue(run.runId, run.band, run.enqueuedAtMs)
                        complete(json(StatusCodes.Created, view(run)))
                      }
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

#include <chrono>
#include <set>
#include <string>

#include "trainsched/queue.h"  // queue::enqueue
#include "trainsched/runs.h"   // runs::newRunId, put, get, runForKey, bindKey

using json = nlohmann::json;

constexpr int kPriorityMin = 0;
constexpr int kPriorityMax = 8;
constexpr int kBandWidth = 3;  // band 0: priorities 6-8, band 1: 3-5, band 2: 0-2
const std::set<std::string> kKnownRecipes = {"llama-ft-v3", "vit-pretrain-v1", "embed-distill-v2"};

json view(const runs::Run& run) {
  return json{{"run_id", run.run_id}, {"state", run.state}, {"priority", run.priority}, {"band", run.band}};
}

void fail(httplib::Response& res, int status, const std::string& message) {
  res.status = status;
  res.set_content(json{{"error", message}}.dump(), "application/json");
}

long long nowMs() {
  return std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count();
}

void submit(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) return fail(res, 401, "X-Tenant-Id is required");
  const json body = json::parse(req.body, nullptr, false);
  if (!body.is_object()) return fail(res, 400, "invalid JSON body");
  const int priority = body.value("priority", 4);
  runs::Run run;
  run.enqueued_at_ms = nowMs();
  run.run_id = "run-" + std::to_string(run.enqueued_at_ms);
  run.tenant = tenant;
  run.recipe_version = body.value("recipe_version", "");
  run.dataset_version = body.value("dataset_version", "");
  run.priority = priority;
  run.band = (kPriorityMax - priority) / kBandWidth;
  run.state = "queued";
  runs::put(run);
  queue::enqueue(run.run_id, run.band, run.enqueued_at_ms);
  res.status = 201;
  res.set_content(view(run).dump(), "application/json");
}

void register_routes(httplib::Server& svr) { svr.Post("/v1/training/runs", submit); }
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <algorithm>
#include <chrono>
#include <set>
#include <string>

#include "trainsched/queue.h"  // queue::enqueue
#include "trainsched/runs.h"   // runs::newRunId, put, get, runForKey, bindKey

using json = nlohmann::json;

constexpr int kPriorityMin = 0;
constexpr int kPriorityMax = 8;
constexpr int kBandWidth = 3;  // band 0: priorities 6-8, band 1: 3-5, band 2: 0-2
const std::set<std::string> kKnownRecipes = {"llama-ft-v3", "vit-pretrain-v1", "embed-distill-v2"};

json view(const runs::Run& run) {
  return json{{"run_id", run.run_id}, {"state", run.state}, {"priority", run.priority}, {"band", run.band}};
}

void fail(httplib::Response& res, int status, const std::string& message) {
  res.status = status;
  res.set_content(json{{"error", message}}.dump(), "application/json");
}

long long nowMs() {
  return std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count();
}

void submit(const httplib::Request& req, httplib::Response& res) {
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) return fail(res, 401, "X-Tenant-Id is required");
  const std::string key = req.get_header_value("Idempotency-Key");
  if (key.empty()) return fail(res, 400, "Idempotency-Key is required");
  if (const auto replayed = runs::runForKey(tenant, key)) {
    res.set_content(view(*runs::get(*replayed)).dump(), "application/json");  // a retry answers the run it created
    return;
  }
  const json body = json::parse(req.body, nullptr, false);
  if (!body.is_object()) return fail(res, 400, "invalid JSON body");
  const std::string recipe = body.value("recipe_version", "");
  if (kKnownRecipes.count(recipe) == 0) return fail(res, 400, "unknown recipe_version " + recipe);
  // Clamp first: the band is computed from a priority the scheduler supports.
  const int priority = std::clamp(body.value("priority", 4), kPriorityMin, kPriorityMax);
  runs::Run run;
  run.run_id = runs::newRunId();
  run.tenant = tenant;
  run.recipe_version = recipe;
  run.dataset_version = body.value("dataset_version", "");
  run.priority = priority;
  run.band = (kPriorityMax - priority) / kBandWidth;
  run.state = "queued";
  run.enqueued_at_ms = nowMs();
  runs::put(run);
  runs::bindKey(tenant, key, run.run_id);
  queue::enqueue(run.run_id, run.band, run.enqueued_at_ms);
  res.status = 201;
  res.set_content(view(run).dump(), "application/json");
}

void register_routes(httplib::Server& svr) { svr.Post("/v1/training/runs", submit); }
`,
    },
  },
  harness: {
    python: `from trainsched import runs

GOOD = {"dataset_version": "ds-2026-10", "recipe_version": "llama-ft-v3", "priority": 5}


def _api(ctx):
    return ctx.client(ctx.load("api").app)


async def _submit(c, body=GOOD, tenant="t1", key="k-1"):
    headers = {}
    if tenant:
        headers["X-Tenant-Id"] = tenant
    if key:
        headers["Idempotency-Key"] = key
    return await c.post("/v1/training/runs", json=body, headers=headers)


def _created(r, what):
    assert r.status_code == 201, f"{what} answered {r.status_code}: {r.text}"
    return r.json()


async def check_route(ctx):
    async with _api(ctx) as c:
        body = _created(await _submit(c), "a valid submission")
    assert body.get("state") == "queued" and body.get("run_id"), f"the answer must carry the run id and state queued, got {body}"
    run = runs.get(body["run_id"])
    assert run is not None and run["tenant"] == "t1" and run["recipe_version"] == "llama-ft-v3", f"the run store holds {run} for {body['run_id']}"
    assert ctx.redis.zscore("training:queue", body["run_id"]) is not None, f"{body['run_id']} is not in training:queue"


async def check_priority_band(ctx):
    async with _api(ctx) as c:
        first = _created(await _submit(c, {**GOOD, "priority": 8}, key="k-1"), "a priority-8 submission")
        ctx.clock.advance(1)
        greedy = _created(await _submit(c, {**GOOD, "priority": 999999}, key="k-2"), "a priority-999999 submission")
        low = _created(await _submit(c, {**GOOD, "priority": -5}, key="k-3"), "a priority -5 submission")
    assert greedy.get("priority") == 8 and greedy.get("band") == 0, f"priority 999999 was answered as {greedy}: clamp it to 8 first, which is band 0"
    assert low.get("priority") == 0 and low.get("band") == 2, f"priority -5 was answered as {low}: clamp it to 0 first, which is band 2"
    order = ctx.redis.zrange("training:queue", 0, -1)
    assert order[:2] == [first["run_id"], greedy["run_id"]], f"training:queue is ordered {order}: the priority-8 run submitted first must stay ahead of the clamped 999999, not behind it"


async def check_recipe_version(ctx):
    async with _api(ctx) as c:
        r = await _submit(c, {**GOOD, "recipe_version": "llama-ft-v33"})
    assert r.status_code == 400, f"an unknown recipe_version answered {r.status_code}, expected 400"
    assert ctx.redis.zcard("training:queue") == 0, f"an unknown recipe was queued: training:queue holds {ctx.redis.zrange('training:queue', 0, -1)}"
    assert ctx.redis.keys("run:run-*") == [], f"an unknown recipe left a run row: {ctx.redis.keys('run:run-*')}"


async def check_idempotency(ctx):
    async with _api(ctx) as c:
        first = _created(await _submit(c, key="k-1"), "the first submission")
        retry = await _submit(c, key="k-1")
        assert retry.status_code == 200, f"a retry with the same Idempotency-Key answered {retry.status_code}, expected 200 with the run it created"
        assert retry.json().get("run_id") == first["run_id"], f"the retry answered run {retry.json().get('run_id')}, the first submission created {first['run_id']}"
        assert ctx.redis.zcard("training:queue") == 1, f"one submission retried once queued {ctx.redis.zcard('training:queue')} runs"
        other = _created(await _submit(c, tenant="t2", key="k-1"), "another tenant's submission with the same key")
        assert other["run_id"] != first["run_id"], "another tenant's key k-1 replayed the first tenant's run: bind the key per tenant"
        none = await _submit(c, key=None)
    assert none.status_code == 400, f"a submission without Idempotency-Key answered {none.status_code}, expected 400"


async def check_unique_run_id(ctx):
    async with _api(ctx) as c:
        a = _created(await _submit(c, key="k-1"), "the first submission")
        b = _created(await _submit(c, {**GOOD, "recipe_version": "vit-pretrain-v1"}, key="k-2"), "the second submission")
    assert a["run_id"] != b["run_id"], f"two submissions in the same millisecond both got {a['run_id']}: take the id from runs.new_run_id()"
    run = runs.get(a["run_id"])
    assert run is not None and run["recipe_version"] == "llama-ft-v3", f"the first run's row now reads {run}: the second submission overwrote it"
    assert ctx.redis.zcard("training:queue") == 2, f"two submissions left {ctx.redis.zcard('training:queue')} runs in training:queue"
`,
    typescript: `const GOOD = {dataset_version: 'ds-2026-10', recipe_version: 'llama-ft-v3', priority: 5};

function api(ctx) {
  return {c: ctx.client(ctx.load('api').app), runs: ctx.load('/support/trainsched/runs.ts')};
}

function submit(c, body: object = GOOD, tenant: string | null = 't1', key: string | null = 'k-1') {
  const headers: Record<string, string> = {};
  if (tenant !== null) headers['X-Tenant-Id'] = tenant;
  if (key !== null) headers['Idempotency-Key'] = key;
  return c.post('/v1/training/runs', {json: body, headers});
}

function created(r, what: string) {
  assert.equal(r.status, 201, \`\${what} answered \${r.status}: \${r.text}\`);
  return r.json();
}

export async function check_route(ctx) {
  const {c, runs} = api(ctx);
  const body = created(await submit(c), 'a valid submission');
  assert(body.state === 'queued' && body.run_id, \`the answer must carry the run id and state queued, got \${JSON.stringify(body)}\`);
  const run = await runs.get(body.run_id);
  assert(run !== null && run.tenant === 't1' && run.recipe_version === 'llama-ft-v3', \`the run store holds \${JSON.stringify(run)} for \${body.run_id}\`);
  assert(ctx.redis.zscore('training:queue', body.run_id) !== null, \`\${body.run_id} is not in training:queue\`);
}

export async function check_priority_band(ctx) {
  const {c} = api(ctx);
  const first = created(await submit(c, {...GOOD, priority: 8}, 't1', 'k-1'), 'a priority-8 submission');
  ctx.clock.advance(1);
  const greedy = created(await submit(c, {...GOOD, priority: 999999}, 't1', 'k-2'), 'a priority-999999 submission');
  const low = created(await submit(c, {...GOOD, priority: -5}, 't1', 'k-3'), 'a priority -5 submission');
  assert(greedy.priority === 8 && greedy.band === 0, \`priority 999999 was answered as \${JSON.stringify(greedy)}: clamp it to 8 first, which is band 0\`);
  assert(low.priority === 0 && low.band === 2, \`priority -5 was answered as \${JSON.stringify(low)}: clamp it to 0 first, which is band 2\`);
  const order = ctx.redis.zrange('training:queue', 0, -1);
  assert.deepEqual(order.slice(0, 2), [first.run_id, greedy.run_id], \`training:queue is ordered \${JSON.stringify(order)}: the priority-8 run submitted first must stay ahead of the clamped 999999, not behind it\`);
}

export async function check_recipe_version(ctx) {
  const {c} = api(ctx);
  const r = await submit(c, {...GOOD, recipe_version: 'llama-ft-v33'});
  assert.equal(r.status, 400, \`an unknown recipe_version answered \${r.status}, expected 400\`);
  assert.equal(ctx.redis.zcard('training:queue'), 0, \`an unknown recipe was queued: training:queue holds \${JSON.stringify(ctx.redis.zrange('training:queue', 0, -1))}\`);
  assert.deepEqual(ctx.redis.keys('run:run-*'), [], \`an unknown recipe left a run row: \${JSON.stringify(ctx.redis.keys('run:run-*'))}\`);
}

export async function check_idempotency(ctx) {
  const {c} = api(ctx);
  const first = created(await submit(c, GOOD, 't1', 'k-1'), 'the first submission');
  const retry = await submit(c, GOOD, 't1', 'k-1');
  assert.equal(retry.status, 200, \`a retry with the same Idempotency-Key answered \${retry.status}, expected 200 with the run it created\`);
  assert.equal(retry.json().run_id, first.run_id, \`the retry answered run \${retry.json().run_id}, the first submission created \${first.run_id}\`);
  assert.equal(ctx.redis.zcard('training:queue'), 1, \`one submission retried once queued \${ctx.redis.zcard('training:queue')} runs\`);
  const other = created(await submit(c, GOOD, 't2', 'k-1'), "another tenant's submission with the same key");
  assert.notEqual(other.run_id, first.run_id, "another tenant's key k-1 replayed the first tenant's run: bind the key per tenant");
  const none = await submit(c, GOOD, 't1', null);
  assert.equal(none.status, 400, \`a submission without Idempotency-Key answered \${none.status}, expected 400\`);
}

export async function check_unique_run_id(ctx) {
  const {c, runs} = api(ctx);
  const a = created(await submit(c, GOOD, 't1', 'k-1'), 'the first submission');
  const b = created(await submit(c, {...GOOD, recipe_version: 'vit-pretrain-v1'}, 't1', 'k-2'), 'the second submission');
  assert.notEqual(a.run_id, b.run_id, \`two submissions in the same millisecond both got \${a.run_id}: take the id from newRunId()\`);
  const run = await runs.get(a.run_id);
  assert(run !== null && run.recipe_version === 'llama-ft-v3', \`the first run's row now reads \${JSON.stringify(run)}: the second submission overwrote it\`);
  assert.equal(ctx.redis.zcard('training:queue'), 2, \`two submissions left \${ctx.redis.zcard('training:queue')} runs in training:queue\`);
}
`,
    go: `package main

import (
	"context"
	"net/http"

	"trainsched/runs"

	"leetbuild/harness"
)

var good = map[string]any{"dataset_version": "ds-2026-10", "recipe_version": "llama-ft-v3", "priority": 5}

func withField(name string, value any) map[string]any {
	out := map[string]any{}
	for k, v := range good {
		out[k] = v
	}
	out[name] = value
	return out
}

func api(ctx *harness.Ctx) *harness.HTTP {
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

func post(c *harness.HTTP, body map[string]any, tenant, key string) *harness.Response {
	header := []string{}
	if tenant != "" {
		header = append(header, "X-Tenant-Id", tenant)
	}
	if key != "" {
		header = append(header, "Idempotency-Key", key)
	}
	return c.Post("/v1/training/runs", body, header...)
}

type answer struct {
	RunID    string \`json:"run_id"\`
	State    string \`json:"state"\`
	Priority int    \`json:"priority"\`
	Band     int    \`json:"band"\`
}

func created(ctx *harness.Ctx, r *harness.Response, what string) answer {
	ctx.Equal(r.Status, 201, "%s (%s)", what, r.Text())
	var a answer
	r.Decode(&a)
	return a
}

func queued(ctx *harness.Ctx) []string {
	out := []string{}
	for _, z := range ctx.Redis.ZRangeWithScores("training:queue", 0, -1) {
		out = append(out, z.Member)
	}
	return out
}

func CheckRoute(ctx *harness.Ctx) {
	c := api(ctx)
	a := created(ctx, post(c, good, "t1", "k-1"), "a valid submission")
	ctx.Assert(a.State == "queued" && a.RunID != "", "the answer must carry the run id and state queued, got %+v", a)
	run := runs.Get(context.Background(), a.RunID)
	ctx.Assert(run != nil && run.Tenant == "t1" && run.RecipeVersion == "llama-ft-v3", "the run store holds %+v for %s", run, a.RunID)
	_, ok := ctx.Redis.ZScore("training:queue", a.RunID)
	ctx.Assert(ok, "%s is not in training:queue", a.RunID)
}

func CheckPriorityBand(ctx *harness.Ctx) {
	c := api(ctx)
	first := created(ctx, post(c, withField("priority", 8), "t1", "k-1"), "a priority-8 submission")
	ctx.Clock.Advance(1)
	greedy := created(ctx, post(c, withField("priority", 999999), "t1", "k-2"), "a priority-999999 submission")
	low := created(ctx, post(c, withField("priority", -5), "t1", "k-3"), "a priority -5 submission")
	ctx.Assert(greedy.Priority == 8 && greedy.Band == 0, "priority 999999 was answered as %+v: clamp it to 8 first, which is band 0", greedy)
	ctx.Assert(low.Priority == 0 && low.Band == 2, "priority -5 was answered as %+v: clamp it to 0 first, which is band 2", low)
	order := queued(ctx)
	ctx.Assert(len(order) >= 2 && order[0] == first.RunID && order[1] == greedy.RunID, "training:queue is ordered %v: the priority-8 run submitted first must stay ahead of the clamped 999999, not behind it", order)
}

func CheckRecipeVersion(ctx *harness.Ctx) {
	c := api(ctx)
	r := post(c, withField("recipe_version", "llama-ft-v33"), "t1", "k-1")
	ctx.Equal(r.Status, 400, "an unknown recipe_version must be rejected; the status")
	ctx.Equal(len(queued(ctx)), 0, "an unknown recipe must not be queued; the runs in training:queue")
	ctx.Equal(len(ctx.Redis.Keys("run:run-*")), 0, "an unknown recipe must not leave a run row; the rows")
}

func CheckIdempotency(ctx *harness.Ctx) {
	c := api(ctx)
	first := created(ctx, post(c, good, "t1", "k-1"), "the first submission")
	retry := post(c, good, "t1", "k-1")
	ctx.Equal(retry.Status, 200, "a retry with the same Idempotency-Key must answer the run it created; the status")
	var replay answer
	retry.Decode(&replay)
	ctx.Equal(replay.RunID, first.RunID, "the retry's run id")
	ctx.Equal(len(queued(ctx)), 1, "one submission retried once; the runs in training:queue")
	other := created(ctx, post(c, good, "t2", "k-1"), "another tenant's submission with the same key")
	ctx.Assert(other.RunID != first.RunID, "another tenant's key k-1 replayed the first tenant's run: bind the key per tenant")
	none := post(c, good, "t1", "")
	ctx.Equal(none.Status, 400, "a submission without Idempotency-Key; the status")
}

func CheckUniqueRunId(ctx *harness.Ctx) {
	c := api(ctx)
	a := created(ctx, post(c, good, "t1", "k-1"), "the first submission")
	b := created(ctx, post(c, withField("recipe_version", "vit-pretrain-v1"), "t1", "k-2"), "the second submission")
	ctx.Assert(a.RunID != b.RunID, "two submissions in the same millisecond both got %s: take the id from runs.NewRunID", a.RunID)
	run := runs.Get(context.Background(), a.RunID)
	ctx.Assert(run != nil && run.RecipeVersion == "llama-ft-v3", "the first run's row now reads %+v: the second submission overwrote it", run)
	ctx.Equal(len(queued(ctx)), 2, "two submissions; the runs in training:queue")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <string>
#include <vector>

namespace {

nlohmann::json good() {
  return nlohmann::json{{"dataset_version", "ds-2026-10"}, {"recipe_version", "llama-ft-v3"}, {"priority", 5}};
}

nlohmann::json withField(const std::string& name, const nlohmann::json& value) {
  nlohmann::json out = good();
  out[name] = value;
  return out;
}

harness::HTTP api(harness::Ctx& ctx) {
  static httplib::Server* svr = nullptr;
  delete svr;
  svr = new httplib::Server;
  register_routes(*svr);
  return ctx.HTTP(*svr);
}

harness::Response post(harness::HTTP& c, const nlohmann::json& body, const std::string& tenant, const std::string& key) {
  const std::string text = body.dump();
  if (tenant.empty()) return c.Post("/v1/training/runs", text, "Content-Type", "application/json", "Idempotency-Key", key);
  if (key.empty()) return c.Post("/v1/training/runs", text, "Content-Type", "application/json", "X-Tenant-Id", tenant);
  return c.Post("/v1/training/runs", text, "Content-Type", "application/json", "X-Tenant-Id", tenant, "Idempotency-Key", key);
}

nlohmann::json created(harness::Ctx& ctx, const harness::Response& r, const std::string& what) {
  ctx.Equal(r.Status, 201, "%s (%s)", what, r.Text());
  return nlohmann::json::parse(r.Text(), nullptr, false);
}

std::string field(const nlohmann::json& j, const std::string& name) {
  return j.is_object() && j.contains(name) && j[name].is_string() ? j[name].get<std::string>() : "";
}

long long number(const nlohmann::json& j, const std::string& name) {
  return j.is_object() && j.contains(name) && j[name].is_number() ? j[name].get<long long>() : -1;
}

std::vector<std::string> queued(harness::Ctx& ctx) {
  std::vector<std::string> out;
  for (const auto& z : ctx.Redis.ZRangeWithScores("training:queue", 0, -1)) out.push_back(z.Member);
  return out;
}

}  // namespace

void CheckRoute(harness::Ctx& ctx) {
  auto c = api(ctx);
  const auto a = created(ctx, post(c, good(), "t1", "k-1"), "a valid submission");
  ctx.Assert(field(a, "state") == "queued" && !field(a, "run_id").empty(), "the answer must carry the run id and state queued, got %s", a.dump());
  const auto run = runs::get(field(a, "run_id"));
  ctx.Assert(run && run->tenant == "t1" && run->recipe_version == "llama-ft-v3", "the run store has no row for %s with tenant t1 and recipe llama-ft-v3", field(a, "run_id"));
  ctx.Assert(ctx.Redis.ZScore("training:queue", field(a, "run_id")).has_value(), "%s is not in training:queue", field(a, "run_id"));
}

void CheckPriorityBand(harness::Ctx& ctx) {
  auto c = api(ctx);
  const auto first = created(ctx, post(c, withField("priority", 8), "t1", "k-1"), "a priority-8 submission");
  ctx.Clock.Advance(1);
  const auto greedy = created(ctx, post(c, withField("priority", 999999), "t1", "k-2"), "a priority-999999 submission");
  const auto low = created(ctx, post(c, withField("priority", -5), "t1", "k-3"), "a priority -5 submission");
  ctx.Assert(number(greedy, "priority") == 8 && number(greedy, "band") == 0, "priority 999999 was answered as %s: clamp it to 8 first, which is band 0", greedy.dump());
  ctx.Assert(number(low, "priority") == 0 && number(low, "band") == 2, "priority -5 was answered as %s: clamp it to 0 first, which is band 2", low.dump());
  const auto order = queued(ctx);
  ctx.Assert(order.size() >= 2 && order[0] == field(first, "run_id") && order[1] == field(greedy, "run_id"),
             "training:queue is ordered %q: the priority-8 run submitted first must stay ahead of the clamped 999999, not behind it", order);
}

void CheckRecipeVersion(harness::Ctx& ctx) {
  auto c = api(ctx);
  const auto r = post(c, withField("recipe_version", "llama-ft-v33"), "t1", "k-1");
  ctx.Equal(r.Status, 400, "an unknown recipe_version must be rejected; the status");
  ctx.Equal(queued(ctx).size(), 0, "an unknown recipe must not be queued; the runs in training:queue");
  ctx.Equal(ctx.Redis.Keys("run:run-*").size(), 0, "an unknown recipe must not leave a run row; the rows");
}

void CheckIdempotency(harness::Ctx& ctx) {
  auto c = api(ctx);
  const auto first = created(ctx, post(c, good(), "t1", "k-1"), "the first submission");
  const auto retry = post(c, good(), "t1", "k-1");
  ctx.Equal(retry.Status, 200, "a retry with the same Idempotency-Key must answer the run it created; the status");
  ctx.Equal(field(nlohmann::json::parse(retry.Text(), nullptr, false), "run_id"), field(first, "run_id"), "the retry's run id");
  ctx.Equal(queued(ctx).size(), 1, "one submission retried once; the runs in training:queue");
  const auto other = created(ctx, post(c, good(), "t2", "k-1"), "another tenant's submission with the same key");
  ctx.Assert(field(other, "run_id") != field(first, "run_id"), "another tenant's key k-1 replayed the first tenant's run: bind the key per tenant");
  const auto none = post(c, good(), "t1", "");
  ctx.Equal(none.Status, 400, "a submission without Idempotency-Key; the status");
}

void CheckUniqueRunId(harness::Ctx& ctx) {
  auto c = api(ctx);
  const auto a = created(ctx, post(c, good(), "t1", "k-1"), "the first submission");
  const auto b = created(ctx, post(c, withField("recipe_version", "vit-pretrain-v1"), "t1", "k-2"), "the second submission");
  ctx.Assert(field(a, "run_id") != field(b, "run_id"), "two submissions in the same millisecond both got %s: take the id from runs::newRunId()", field(a, "run_id"));
  const auto run = runs::get(field(a, "run_id"));
  ctx.Assert(run && run->recipe_version == "llama-ft-v3", "the first run's row now reads recipe %q: the second submission overwrote it", run ? run->recipe_version : "");
  ctx.Equal(queued(ctx).size(), 2, "two submissions; the runs in training:queue");
}
`,
  },
  hints: [
    'One tenant found that a huge priority puts its jobs first; a typo in a recipe holds a GPU until the job fails; a client that timed out now has two identical runs training.',
    'The band is computed from the raw integer, so nothing bounds it. Nothing reads `Idempotency-Key` or `KNOWN_RECIPES`, and an id built from the clock repeats whenever two requests share a millisecond.',
    'Require the key, answer `runs.run_for_key(tenant, key)` with 200, reject a recipe outside `KNOWN_RECIPES`, clamp with `min(max(priority, PRIORITY_MIN), PRIORITY_MAX)` before the band, then `runs.new_run_id()`, `put`, `bind_key`, `enqueue`.',
  ],
  debrief: `Every decision happens before the queue sees the run, because the queue is a promise of scarce hardware. The clamp comes before the band since the band is what the queue orders by; banding the raw integer lets one caller score ahead of the whole fleet. The recipe lookup comes before any write, so a typo costs a 400 and not a GPU-hour. The key is bound per tenant and looked up first, so a retry reads the first attempt's run, and the id comes from a sequence every replica shares instead of from a clock two requests can share. Production schedulers also cap how many runs a tenant may queue, expire the key bindings after a day, and check the dataset version against the data catalog.`,
};
