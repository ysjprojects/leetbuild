import type {Step} from '@/lib/types';

export const endpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/workflows and /v1/runs: immutable versions, pinned runs',
  concept: 'http',
  guides: ['request-boundaries', 'idempotent-requests'],
  file: 'api',
  focus: ['client', 'engine', 'redis'],
  task: `## Task

**Starting point.** \`POST /v1/workflows\` writes the body's \`{name, version, steps, edges}\` with
\`definitions.put\` and answers 201. \`POST /v1/runs\` (tenant in \`X-Tenant-Id\`) takes
\`{workflow, version, input, max_steps}\`, looks up \`definitions.latest(workflow)\`, starts the run
on it with \`runs.create\` and answers 202 with \`run_id\`, \`workflow\`, \`definition_version\`,
\`pinned_steps\` and \`max_steps\`. It serves the demo and hides four flaws.

**Failure mode the checks target.** A deploy publishes version 4 and a client asking for version 3
gets a version-4 run; re-publishing version 3 rewrites the steps every v3 run depends on; a cyclic
graph is accepted; a 70 KB input or a budget of 0 steps is stored.

- A graph with a cycle is **422** at publish time (\`definitions.has_cycle\`).
- An existing \`(name, version)\` is **409**: check \`definitions.exists\` before \`definitions.put\`.
- The run pins the version the body names, \`definitions.get(workflow, version)\`, and an
  unpublished one is **404**.
- Serialized \`input\` over \`MAX_INPUT_BYTES\` (\`1 << 16\`) is **413** and \`max_steps\` outside
  1..\`MAX_STEPS\` (500) is **400** (the same names in each language's casing), both before
  \`runs.create\`.`,
  sequence: {
    participants: ['Client', 'workflowd', 'Redis'],
    messages: [
      {from: 'Client', to: 'workflowd', label: 'POST /v1/workflows {name, version, steps, edges}', kind: 'sync'},
      {from: 'workflowd', to: 'workflowd', label: 'has_cycle → 422', kind: 'sync'},
      {from: 'workflowd', to: 'Redis', label: 'exists(signup, 3) → 409 · else put', kind: 'sync'},
      {from: 'Client', to: 'workflowd', label: 'POST /v1/runs {workflow, version: 3, input, max_steps}', kind: 'sync'},
      {
        from: 'workflowd',
        to: 'workflowd',
        label: 'input ≤ 64 KiB → else 413 · 1 ≤ max_steps ≤ 500 → else 400',
        kind: 'sync',
      },
      {from: 'workflowd', to: 'Redis', label: 'get(signup, 3) → 404 when absent', kind: 'sync'},
      {from: 'workflowd', to: 'Redis', label: 'runs.create · pinned_steps of v3 · checkpoint', kind: 'sync'},
      {from: 'workflowd', to: 'Client', label: '202 {run_id, definition_version: 3, pinned_steps}', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'cycle',
      title: 'Refuses a cyclic definition at publish time',
      detail:
        'Publishing steps a, b, c with edges a → b → c → a answers **422** and stores nothing, while an acyclic graph is stored. The starter stores the cycle, and a run of it only stops when its step budget runs out.',
      match: {
        python: {all: [/definitions\.has_cycle\(/, /status_code\s*=\s*422/]},
        typescript: {all: [/definitions\.hasCycle\(/, /code\(\s*422\s*\)/]},
        go: {all: [/definitions\.HasCycle\(/, /StatusUnprocessableEntity/]},
        scala: {all: [/Definitions\.hasCycle\(/, /StatusCodes\.UnprocessableEntity/]},
        cpp: {all: [/definitions::hasCycle\(/, /\b422\b/]},
      },
    },
    {
      id: 'immutable',
      title: 'Keeps a published version immutable',
      detail:
        'Re-publishing `signup` version 3 with other steps answers **409** and version 3 keeps its steps. The starter overwrites the hash, so every run pinned to version 3 changes under it.',
      match: {
        python: {all: [/status_code\s*=\s*409/], order: [/definitions\.exists\(/, /definitions\.put\(/]},
        typescript: {all: [/code\(\s*409\s*\)/], order: [/definitions\.exists\(/, /definitions\.put\(/]},
        go: {all: [/StatusConflict/], order: [/definitions\.Exists\(/, /definitions\.Put\(/]},
        scala: {all: [/StatusCodes\.Conflict/], order: [/Definitions\.exists\(/, /Definitions\.put\(/]},
        cpp: {all: [/\b409\b/], order: [/definitions::exists\(/, /definitions::put\(/]},
      },
    },
    {
      id: 'pin',
      title: 'Pins the version the run asked for',
      detail:
        'With versions 3 and 4 published, a run of version 3 answers and stores `definition_version` 3 with the steps of version 3; a run of a version never published is **404**. The starter starts every run on the newest version.',
      match: {
        python: {all: [/definitions\.get\(/], none: [/definitions\.latest\(/]},
        typescript: {all: [/definitions\.get\(/], none: [/definitions\.latest\(/]},
        go: {all: [/definitions\.Get\(/], none: [/definitions\.Latest\(/]},
        scala: {all: [/Definitions\.get\(/], none: [/Definitions\.latest\(/]},
        cpp: {all: [/definitions::get\(/], none: [/definitions::latest\(/]},
      },
    },
    {
      id: 'bounds',
      title: 'Caps the input document and the step budget',
      detail:
        'A 70 KB input answers **413**, `max_steps` 0 or 501 answers **400**, and none of them writes a run record; `max_steps` 500 with a small input is accepted. The starter stores whatever arrives.',
      match: {
        python: {all: [/MAX_INPUT_BYTES/, /\bMAX_STEPS\b/, /status_code\s*=\s*413/, /status_code\s*=\s*400/]},
        typescript: {all: [/MAX_INPUT_BYTES/, /\bMAX_STEPS\b/, /code\(\s*413\s*\)/, /code\(\s*400\s*\)/]},
        go: {all: [/maxInputBytes/, /\bmaxSteps\b/, /StatusRequestEntityTooLarge/]},
        scala: {all: [/MaxInputBytes/, /\bMaxSteps\b/, /StatusCodes\.PayloadTooLarge/, /StatusCodes\.BadRequest/]},
        cpp: {all: [/kMaxInputBytes/, /\bkMaxSteps\b/, /\b413\b/, /\b400\b/]},
      },
    },
  ],
  code: {
    python: {
      starter: `from fastapi import FastAPI, HTTPException, Request
from pydantic import BaseModel

from workflow import definitions, runs  # definitions.has_cycle, exists, get, latest, put · runs.create, get

app = FastAPI()


class PublishRequest(BaseModel):
    name: str
    version: int
    steps: list[str]
    edges: list[list[str]] = []


class RunRequest(BaseModel):
    workflow: str
    version: int
    input: dict = {}
    max_steps: int = 50


def run_view(run: dict) -> dict:
    return {name: run[name] for name in ("run_id", "workflow", "definition_version", "pinned_steps", "max_steps")}


@app.post("/v1/workflows", status_code=201)
def publish_workflow(body: PublishRequest) -> dict:
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    definitions.put(body.name, body.version, body.steps, body.edges)
    return {"name": body.name, "version": body.version}


@app.post("/v1/runs", status_code=202)
def start_run(body: RunRequest, request: Request) -> dict:
    tenant = request.headers.get("x-tenant-id", "")
    if not tenant:
        raise HTTPException(status_code=401, detail="X-Tenant-Id is required")
    definition = definitions.latest(body.workflow)
    if definition is None:
        raise HTTPException(status_code=404, detail=f"{body.workflow} is not published")
    run = runs.create(tenant, body.workflow, definition["version"], definition["steps"], body.input, body.max_steps)
    return run_view(run)
`,
      solution: `import json

from fastapi import FastAPI, HTTPException, Request
from pydantic import BaseModel

from workflow import definitions, runs  # definitions.has_cycle, exists, get, latest, put · runs.create, get

app = FastAPI()

MAX_INPUT_BYTES = 1 << 16
MAX_STEPS = 500


class PublishRequest(BaseModel):
    name: str
    version: int
    steps: list[str]
    edges: list[list[str]] = []


class RunRequest(BaseModel):
    workflow: str
    version: int
    input: dict = {}
    max_steps: int = 50


def run_view(run: dict) -> dict:
    return {name: run[name] for name in ("run_id", "workflow", "definition_version", "pinned_steps", "max_steps")}


@app.post("/v1/workflows", status_code=201)
def publish_workflow(body: PublishRequest) -> dict:
    if definitions.has_cycle(body.steps, body.edges):
        raise HTTPException(status_code=422, detail="the step graph has a cycle")
    # A published version never changes: runs are pinned to it.
    if definitions.exists(body.name, body.version):
        raise HTTPException(status_code=409, detail=f"{body.name} v{body.version} is already published")
    definitions.put(body.name, body.version, body.steps, body.edges)
    return {"name": body.name, "version": body.version}


@app.post("/v1/runs", status_code=202)
def start_run(body: RunRequest, request: Request) -> dict:
    tenant = request.headers.get("x-tenant-id", "")
    if not tenant:
        raise HTTPException(status_code=401, detail="X-Tenant-Id is required")
    if len(json.dumps(body.input).encode()) > MAX_INPUT_BYTES:
        raise HTTPException(status_code=413, detail=f"input is over {MAX_INPUT_BYTES} bytes")
    if not 1 <= body.max_steps <= MAX_STEPS:
        raise HTTPException(status_code=400, detail=f"max_steps must be within 1..{MAX_STEPS}")
    # Resolved once: the run keeps this version's steps whatever is published later.
    definition = definitions.get(body.workflow, body.version)
    if definition is None:
        raise HTTPException(status_code=404, detail=f"{body.workflow} v{body.version} is not published")
    run = runs.create(tenant, body.workflow, definition["version"], definition["steps"], body.input, body.max_steps)
    return run_view(run)
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';

import * as definitions from 'workflow/definitions'; // hasCycle, exists, get, latest, put
import * as runs from 'workflow/runs'; // create, get

export const app = Fastify();

interface PublishBody {
  name: string;
  version: number;
  steps: string[];
  edges?: string[][];
}

interface RunBody {
  workflow: string;
  version: number;
  input?: Record<string, unknown>;
  max_steps?: number;
}

const runView = ({run_id, workflow, definition_version, pinned_steps, max_steps}: runs.Run) => ({
  run_id,
  workflow,
  definition_version,
  pinned_steps,
  max_steps,
});

app.post('/v1/workflows', async (request, reply) => {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const {name, version, steps, edges = []} = request.body as PublishBody;
  await definitions.put(name, version, steps, edges);
  return reply.code(201).send({name, version});
});

app.post('/v1/runs', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'X-Tenant-Id is required'});
  const {workflow, input = {}, max_steps = 50} = request.body as RunBody;
  const definition = await definitions.latest(workflow);
  if (definition === null) return reply.code(404).send({error: \`\${workflow} is not published\`});
  const run = await runs.create(tenant, workflow, definition.version, definition.steps, input, max_steps);
  return reply.code(202).send(runView(run));
});
`,
      solution: `import Fastify from 'fastify';

import * as definitions from 'workflow/definitions'; // hasCycle, exists, get, latest, put
import * as runs from 'workflow/runs'; // create, get

export const app = Fastify();

export const MAX_INPUT_BYTES = 1 << 16;
export const MAX_STEPS = 500;

interface PublishBody {
  name: string;
  version: number;
  steps: string[];
  edges?: string[][];
}

interface RunBody {
  workflow: string;
  version: number;
  input?: Record<string, unknown>;
  max_steps?: number;
}

const runView = ({run_id, workflow, definition_version, pinned_steps, max_steps}: runs.Run) => ({
  run_id,
  workflow,
  definition_version,
  pinned_steps,
  max_steps,
});

app.post('/v1/workflows', async (request, reply) => {
  const {name, version, steps, edges = []} = request.body as PublishBody;
  if (definitions.hasCycle(steps, edges)) return reply.code(422).send({error: 'the step graph has a cycle'});
  // A published version never changes: runs are pinned to it.
  if (await definitions.exists(name, version)) return reply.code(409).send({error: \`\${name} v\${version} is already published\`});
  await definitions.put(name, version, steps, edges);
  return reply.code(201).send({name, version});
});

app.post('/v1/runs', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'X-Tenant-Id is required'});
  const {workflow, version, input = {}, max_steps = 50} = request.body as RunBody;
  if (new TextEncoder().encode(JSON.stringify(input)).length > MAX_INPUT_BYTES) {
    return reply.code(413).send({error: \`input is over \${MAX_INPUT_BYTES} bytes\`});
  }
  if (!(max_steps >= 1 && max_steps <= MAX_STEPS)) return reply.code(400).send({error: \`max_steps must be within 1..\${MAX_STEPS}\`});
  // Resolved once: the run keeps this version's steps whatever is published later.
  const definition = await definitions.get(workflow, version);
  if (definition === null) return reply.code(404).send({error: \`\${workflow} v\${version} is not published\`});
  const run = await runs.create(tenant, workflow, definition.version, definition.steps, input, max_steps);
  return reply.code(202).send(runView(run));
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"net/http"

	"workflow/definitions" // definitions.HasCycle, Exists, Get, Latest, Put
	"workflow/runs"        // runs.Create, Get
)

type publishRequest struct {
	Name    string     \`json:"name"\`
	Version int        \`json:"version"\`
	Steps   []string   \`json:"steps"\`
	Edges   [][]string \`json:"edges"\`
}

type runRequest struct {
	Workflow string          \`json:"workflow"\`
	Version  int             \`json:"version"\`
	Input    json.RawMessage \`json:"input"\`
	MaxSteps int             \`json:"max_steps"\`
}

type runView struct {
	RunID             string   \`json:"run_id"\`
	Workflow          string   \`json:"workflow"\`
	DefinitionVersion int      \`json:"definition_version"\`
	PinnedSteps       []string \`json:"pinned_steps"\`
	MaxSteps          int      \`json:"max_steps"\`
}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func publishWorkflow(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	var body publishRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(rw, err.Error(), http.StatusBadRequest)
		return
	}
	definitions.Put(r.Context(), body.Name, body.Version, body.Steps, body.Edges)
	writeJSON(rw, http.StatusCreated, map[string]any{"name": body.Name, "version": body.Version})
}

func startRun(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		http.Error(rw, "X-Tenant-Id is required", http.StatusUnauthorized)
		return
	}
	body := runRequest{MaxSteps: 50}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(rw, err.Error(), http.StatusBadRequest)
		return
	}
	definition := definitions.Latest(r.Context(), body.Workflow)
	if definition == nil {
		http.Error(rw, body.Workflow+" is not published", http.StatusNotFound)
		return
	}
	input := map[string]any{}
	if len(body.Input) > 0 {
		json.Unmarshal(body.Input, &input)
	}
	run := runs.Create(r.Context(), tenant, body.Workflow, definition.Version, definition.Steps, input, body.MaxSteps)
	writeJSON(rw, http.StatusAccepted, runView{run.RunID, run.Workflow, run.DefinitionVersion, run.PinnedSteps, run.MaxSteps})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/workflows", publishWorkflow)
	mux.HandleFunc("POST /v1/runs", startRun)
}
`,
      solution: `package main

import (
	"encoding/json"
	"fmt"
	"net/http"

	"workflow/definitions" // definitions.HasCycle, Exists, Get, Latest, Put
	"workflow/runs"        // runs.Create, Get
)

const (
	maxInputBytes = 1 << 16
	maxSteps      = 500
)

type publishRequest struct {
	Name    string     \`json:"name"\`
	Version int        \`json:"version"\`
	Steps   []string   \`json:"steps"\`
	Edges   [][]string \`json:"edges"\`
}

type runRequest struct {
	Workflow string          \`json:"workflow"\`
	Version  int             \`json:"version"\`
	Input    json.RawMessage \`json:"input"\`
	MaxSteps int             \`json:"max_steps"\`
}

type runView struct {
	RunID             string   \`json:"run_id"\`
	Workflow          string   \`json:"workflow"\`
	DefinitionVersion int      \`json:"definition_version"\`
	PinnedSteps       []string \`json:"pinned_steps"\`
	MaxSteps          int      \`json:"max_steps"\`
}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func publishWorkflow(rw http.ResponseWriter, r *http.Request) {
	var body publishRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(rw, err.Error(), http.StatusBadRequest)
		return
	}
	if definitions.HasCycle(body.Steps, body.Edges) {
		http.Error(rw, "the step graph has a cycle", http.StatusUnprocessableEntity)
		return
	}
	// A published version never changes: runs are pinned to it.
	if definitions.Exists(r.Context(), body.Name, body.Version) {
		http.Error(rw, fmt.Sprintf("%s v%d is already published", body.Name, body.Version), http.StatusConflict)
		return
	}
	definitions.Put(r.Context(), body.Name, body.Version, body.Steps, body.Edges)
	writeJSON(rw, http.StatusCreated, map[string]any{"name": body.Name, "version": body.Version})
}

func startRun(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		http.Error(rw, "X-Tenant-Id is required", http.StatusUnauthorized)
		return
	}
	body := runRequest{MaxSteps: 50}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(rw, err.Error(), http.StatusBadRequest)
		return
	}
	if len(body.Input) > maxInputBytes {
		http.Error(rw, fmt.Sprintf("input is over %d bytes", maxInputBytes), http.StatusRequestEntityTooLarge)
		return
	}
	if body.MaxSteps < 1 || body.MaxSteps > maxSteps {
		http.Error(rw, fmt.Sprintf("max_steps must be within 1..%d", maxSteps), http.StatusBadRequest)
		return
	}
	// Resolved once: the run keeps this version's steps whatever is published later.
	definition := definitions.Get(r.Context(), body.Workflow, body.Version)
	if definition == nil {
		http.Error(rw, fmt.Sprintf("%s v%d is not published", body.Workflow, body.Version), http.StatusNotFound)
		return
	}
	input := map[string]any{}
	if len(body.Input) > 0 {
		json.Unmarshal(body.Input, &input)
	}
	run := runs.Create(r.Context(), tenant, body.Workflow, definition.Version, definition.Steps, input, body.MaxSteps)
	writeJSON(rw, http.StatusAccepted, runView{run.RunID, run.Workflow, run.DefinitionVersion, run.PinnedSteps, run.MaxSteps})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/workflows", publishWorkflow)
	mux.HandleFunc("POST /v1/runs", startRun)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._
import spray.json.DefaultJsonProtocol._

import workflow.{Definitions, Runs} // Definitions.hasCycle, exists, get, latest, put · Runs.create, get

object Api {
  private def json(status: StatusCode, body: JsValue): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  private def runView(run: Runs.Run): JsObject = JsObject(
    "run_id" -> JsString(run.runId), "workflow" -> JsString(run.workflow), "definition_version" -> JsNumber(run.definitionVersion),
    "pinned_steps" -> run.pinnedSteps.toJson, "max_steps" -> JsNumber(run.maxSteps))

  val route: Route = concat(
    path("v1" / "workflows") {
      post {
        entity(as[String]) { raw =>
          // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
          val body = raw.parseJson.asJsObject.fields
          val name = body("name").convertTo[String]
          val version = body("version").convertTo[Long]
          val steps = body("steps").convertTo[Seq[String]]
          val edges = body.get("edges").map(_.convertTo[Seq[Seq[String]]]).getOrElse(Seq.empty)
          Definitions.put(name, version, steps, edges)
          complete(json(StatusCodes.Created, JsObject("name" -> JsString(name), "version" -> JsNumber(version))))
        }
      }
    },
    path("v1" / "runs") {
      post {
        optionalHeaderValueByName("X-Tenant-Id") {
          case None | Some("") => complete(StatusCodes.Unauthorized -> "X-Tenant-Id is required")
          case Some(tenant) =>
            entity(as[String]) { raw =>
              val body = raw.parseJson.asJsObject.fields
              val workflowName = body("workflow").convertTo[String]
              val input = body.get("input").map(_.asJsObject).getOrElse(JsObject.empty)
              val maxSteps = body.get("max_steps").map(_.convertTo[Int]).getOrElse(50)
              Definitions.latest(workflowName) match {
                case None => complete(StatusCodes.NotFound -> s"$workflowName is not published")
                case Some(definition) =>
                  val run = Runs.create(tenant, workflowName, definition.version, definition.steps, input, maxSteps)
                  complete(json(StatusCodes.Accepted, runView(run)))
              }
            }
        }
      }
    },
  )
}
`,
      solution: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._
import spray.json.DefaultJsonProtocol._

import workflow.{Definitions, Runs} // Definitions.hasCycle, exists, get, latest, put · Runs.create, get

object Api {
  val MaxInputBytes: Int = 1 << 16
  val MaxSteps = 500

  private def json(status: StatusCode, body: JsValue): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  private def runView(run: Runs.Run): JsObject = JsObject(
    "run_id" -> JsString(run.runId), "workflow" -> JsString(run.workflow), "definition_version" -> JsNumber(run.definitionVersion),
    "pinned_steps" -> run.pinnedSteps.toJson, "max_steps" -> JsNumber(run.maxSteps))

  val route: Route = concat(
    path("v1" / "workflows") {
      post {
        entity(as[String]) { raw =>
          val body = raw.parseJson.asJsObject.fields
          val name = body("name").convertTo[String]
          val version = body("version").convertTo[Long]
          val steps = body("steps").convertTo[Seq[String]]
          val edges = body.get("edges").map(_.convertTo[Seq[Seq[String]]]).getOrElse(Seq.empty)
          if (Definitions.hasCycle(steps, edges)) complete(StatusCodes.UnprocessableEntity -> "the step graph has a cycle")
          // A published version never changes: runs are pinned to it.
          else if (Definitions.exists(name, version)) complete(StatusCodes.Conflict -> s"$name v$version is already published")
          else {
            Definitions.put(name, version, steps, edges)
            complete(json(StatusCodes.Created, JsObject("name" -> JsString(name), "version" -> JsNumber(version))))
          }
        }
      }
    },
    path("v1" / "runs") {
      post {
        optionalHeaderValueByName("X-Tenant-Id") {
          case None | Some("") => complete(StatusCodes.Unauthorized -> "X-Tenant-Id is required")
          case Some(tenant) =>
            entity(as[String]) { raw =>
              val body = raw.parseJson.asJsObject.fields
              val workflowName = body("workflow").convertTo[String]
              val version = body("version").convertTo[Long]
              val input = body.get("input").map(_.asJsObject).getOrElse(JsObject.empty)
              val maxSteps = body.get("max_steps").map(_.convertTo[Int]).getOrElse(50)
              if (input.compactPrint.getBytes("UTF-8").length > MaxInputBytes) complete(StatusCodes.PayloadTooLarge -> s"input is over $MaxInputBytes bytes")
              else if (maxSteps < 1 || maxSteps > MaxSteps) complete(StatusCodes.BadRequest -> s"max_steps must be within 1..$MaxSteps")
              else
                // Resolved once: the run keeps this version's steps whatever is published later.
                Definitions.get(workflowName, version) match {
                  case None => complete(StatusCodes.NotFound -> s"$workflowName v$version is not published")
                  case Some(definition) =>
                    val run = Runs.create(tenant, workflowName, definition.version, definition.steps, input, maxSteps)
                    complete(json(StatusCodes.Accepted, runView(run)))
                }
            }
        }
      }
    },
  )
}
`,
    },
    cpp: {
      starter: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <string>
#include <vector>

#include "workflow/definitions.h"  // definitions::hasCycle, exists, get, latest, put
#include "workflow/runs.h"         // runs::create, get

using json = nlohmann::json;

json runView(const runs::Run& run) {
  return json{{"run_id", run.run_id}, {"workflow", run.workflow}, {"definition_version", run.definition_version},
              {"pinned_steps", run.pinned_steps}, {"max_steps", run.max_steps}};
}

void answerError(httplib::Response& res, int status, const std::string& message) {
  res.status = status;
  res.set_content(json{{"error", message}}.dump(), "application/json");
}

void publish_workflow(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const json body = json::parse(req.body);
  const std::string name = body.value("name", "");
  const long version = body.value("version", 0L);
  const auto steps = body.value("steps", std::vector<std::string>{});
  const auto edges = body.value("edges", std::vector<std::vector<std::string>>{});
  definitions::put(name, version, steps, edges);
  res.status = 201;
  res.set_content(json{{"name", name}, {"version", version}}.dump(), "application/json");
}

void start_run(const httplib::Request& req, httplib::Response& res) {
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) return answerError(res, 401, "X-Tenant-Id is required");
  const json body = json::parse(req.body);
  const std::string workflow = body.value("workflow", "");
  const json input = body.value("input", json::object());
  const long max_steps = body.value("max_steps", 50L);
  const auto definition = definitions::latest(workflow);
  if (!definition) return answerError(res, 404, workflow + " is not published");
  const runs::Run run = runs::create(tenant, workflow, definition->version, definition->steps, input, max_steps);
  res.status = 202;
  res.set_content(runView(run).dump(), "application/json");
}

void register_routes(httplib::Server& svr) {
  svr.Post("/v1/workflows", publish_workflow);
  svr.Post("/v1/runs", start_run);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <string>
#include <vector>

#include "workflow/definitions.h"  // definitions::hasCycle, exists, get, latest, put
#include "workflow/runs.h"         // runs::create, get

using json = nlohmann::json;

constexpr size_t kMaxInputBytes = 1 << 16;
constexpr long kMaxSteps = 500;

json runView(const runs::Run& run) {
  return json{{"run_id", run.run_id}, {"workflow", run.workflow}, {"definition_version", run.definition_version},
              {"pinned_steps", run.pinned_steps}, {"max_steps", run.max_steps}};
}

void answerError(httplib::Response& res, int status, const std::string& message) {
  res.status = status;
  res.set_content(json{{"error", message}}.dump(), "application/json");
}

void publish_workflow(const httplib::Request& req, httplib::Response& res) {
  const json body = json::parse(req.body);
  const std::string name = body.value("name", "");
  const long version = body.value("version", 0L);
  const auto steps = body.value("steps", std::vector<std::string>{});
  const auto edges = body.value("edges", std::vector<std::vector<std::string>>{});
  if (definitions::hasCycle(steps, edges)) return answerError(res, 422, "the step graph has a cycle");
  // A published version never changes: runs are pinned to it.
  if (definitions::exists(name, version)) return answerError(res, 409, name + " v" + std::to_string(version) + " is already published");
  definitions::put(name, version, steps, edges);
  res.status = 201;
  res.set_content(json{{"name", name}, {"version", version}}.dump(), "application/json");
}

void start_run(const httplib::Request& req, httplib::Response& res) {
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) return answerError(res, 401, "X-Tenant-Id is required");
  const json body = json::parse(req.body);
  const std::string workflow = body.value("workflow", "");
  const long version = body.value("version", 0L);
  const json input = body.value("input", json::object());
  const long max_steps = body.value("max_steps", 50L);
  if (input.dump().size() > kMaxInputBytes) return answerError(res, 413, "input is over " + std::to_string(kMaxInputBytes) + " bytes");
  if (max_steps < 1 || max_steps > kMaxSteps) return answerError(res, 400, "max_steps must be within 1.." + std::to_string(kMaxSteps));
  // Resolved once: the run keeps this version's steps whatever is published later.
  const auto definition = definitions::get(workflow, version);
  if (!definition) return answerError(res, 404, workflow + " v" + std::to_string(version) + " is not published");
  const runs::Run run = runs::create(tenant, workflow, definition->version, definition->steps, input, max_steps);
  res.status = 202;
  res.set_content(runView(run).dump(), "application/json");
}

void register_routes(httplib::Server& svr) {
  svr.Post("/v1/workflows", publish_workflow);
  svr.Post("/v1/runs", start_run);
}
`,
    },
  },
  harness: {
    python: `from workflow import definitions, runs

V3 = {"name": "signup", "version": 3, "steps": ["create_account", "send_welcome"], "edges": [["create_account", "send_welcome"]]}
V4 = {
    "name": "signup",
    "version": 4,
    "steps": ["create_account", "send_welcome", "notify_sales"],
    "edges": [["create_account", "send_welcome"], ["send_welcome", "notify_sales"]],
}
TENANT = {"X-Tenant-Id": "t1"}


def _api(ctx):
    return ctx.client(ctx.load("api").app)


def _run(version=3, input_doc=None, max_steps=50):
    return {"workflow": "signup", "version": version, "input": {"email": "ada@example.com"} if input_doc is None else input_doc, "max_steps": max_steps}


async def check_cycle(ctx):
    async with _api(ctx) as c:
        loop = {"name": "loop", "version": 1, "steps": ["a", "b", "c"], "edges": [["a", "b"], ["b", "c"], ["c", "a"]]}
        r = await c.post("/v1/workflows", json=loop)
        assert r.status_code == 422, f"publishing a graph whose edges run a → b → c → a answered {r.status_code}, expected 422: a run of it never reaches a last step"
        assert definitions.get("loop", 1) is None, f"the cyclic graph was stored: {definitions.get('loop', 1)}"
        r = await c.post("/v1/workflows", json=V3)
    assert r.status_code == 201, f"publishing an acyclic graph answered {r.status_code}: {r.text}"
    assert definitions.get("signup", 3) is not None, "the acyclic graph must be stored"


async def check_immutable(ctx):
    async with _api(ctx) as c:
        r = await c.post("/v1/workflows", json=V3)
        assert r.status_code == 201, f"the first publish of signup v3 answered {r.status_code}: {r.text}"
        r = await c.post("/v1/workflows", json={**V3, "steps": ["create_account"], "edges": []})
    assert r.status_code == 409, f"re-publishing signup v3 with other steps answered {r.status_code}, expected 409"
    stored = definitions.get("signup", 3)["steps"]
    assert stored == V3["steps"], f"re-publishing signup v3 rewrote it to {stored}: every run pinned to v3 now runs other steps"


async def check_pin(ctx):
    async with _api(ctx) as c:
        await c.post("/v1/workflows", json=V3)
        await c.post("/v1/workflows", json=V4)
        r = await c.post("/v1/runs", json=_run(3), headers=TENANT)
        assert r.status_code == 202, f"starting a run of signup v3 answered {r.status_code}: {r.text}"
        body = r.json()
        assert body.get("definition_version") == 3 and body.get("pinned_steps") == V3["steps"], f"a run that asked for signup v3 answered {body}: it must pin version 3 and its steps, whatever was published later"
        run = runs.get(body["run_id"])
        assert run["definition_version"] == 3 and run["pinned_steps"] == V3["steps"], f"the stored run is {run}, expected version 3 and its steps"
        r = await c.post("/v1/runs", json=_run(9), headers=TENANT)
    assert r.status_code == 404, f"a run of signup v9, never published, answered {r.status_code}, expected 404"


async def check_bounds(ctx):
    async with _api(ctx) as c:
        await c.post("/v1/workflows", json=V3)
        r = await c.post("/v1/runs", json=_run(input_doc={"blob": "x" * 70000}), headers=TENANT)
        assert r.status_code == 413, f"a 70 KB input answered {r.status_code}, expected 413 (MAX_INPUT_BYTES = 1 << 16)"
        for budget in (0, 501):
            r = await c.post("/v1/runs", json=_run(max_steps=budget), headers=TENANT)
            assert r.status_code == 400, f"max_steps {budget} answered {r.status_code}, expected 400 (1..MAX_STEPS = 500)"
        stored = sorted(ctx.redis.keys("run:run-*"))
        assert stored == [], f"rejected requests wrote run records: {stored}"
        r = await c.post("/v1/runs", json=_run(max_steps=500), headers=TENANT)
    assert r.status_code == 202, f"max_steps 500 with a small input answered {r.status_code}: {r.text}"
`,
    typescript: `const V3 = {name: 'signup', version: 3, steps: ['create_account', 'send_welcome'], edges: [['create_account', 'send_welcome']]};
const V4 = {
  name: 'signup',
  version: 4,
  steps: ['create_account', 'send_welcome', 'notify_sales'],
  edges: [
    ['create_account', 'send_welcome'],
    ['send_welcome', 'notify_sales'],
  ],
};
const TENANT = {'X-Tenant-Id': 't1'};

function api(ctx) {
  return {
    c: ctx.client(ctx.load('api').app),
    definitions: ctx.load('/support/workflow/definitions.ts'),
    runs: ctx.load('/support/workflow/runs.ts'),
  };
}

const run = (version = 3, input: Record<string, unknown> = {email: 'ada@example.com'}, max_steps = 50) => ({workflow: 'signup', version, input, max_steps});

export async function check_cycle(ctx) {
  const {c, definitions} = api(ctx);
  const loop = {name: 'loop', version: 1, steps: ['a', 'b', 'c'], edges: [['a', 'b'], ['b', 'c'], ['c', 'a']]};
  let r = await c.post('/v1/workflows', {json: loop});
  assert.equal(r.status, 422, \`publishing a graph whose edges run a → b → c → a answered \${r.status}, expected 422: a run of it never reaches a last step\`);
  assert.equal(await definitions.get('loop', 1), null, 'the cyclic graph was stored');
  r = await c.post('/v1/workflows', {json: V3});
  assert.equal(r.status, 201, \`publishing an acyclic graph answered \${r.status}: \${r.text}\`);
  assert.notEqual(await definitions.get('signup', 3), null, 'the acyclic graph must be stored');
}

export async function check_immutable(ctx) {
  const {c, definitions} = api(ctx);
  let r = await c.post('/v1/workflows', {json: V3});
  assert.equal(r.status, 201, \`the first publish of signup v3 answered \${r.status}: \${r.text}\`);
  r = await c.post('/v1/workflows', {json: {...V3, steps: ['create_account'], edges: []}});
  assert.equal(r.status, 409, \`re-publishing signup v3 with other steps answered \${r.status}, expected 409\`);
  const stored = (await definitions.get('signup', 3)).steps;
  assert.deepStrictEqual(stored, V3.steps, \`re-publishing signup v3 rewrote it to \${JSON.stringify(stored)}: every run pinned to v3 now runs other steps\`);
}

export async function check_pin(ctx) {
  const {c, runs} = api(ctx);
  await c.post('/v1/workflows', {json: V3});
  await c.post('/v1/workflows', {json: V4});
  let r = await c.post('/v1/runs', {json: run(3), headers: TENANT});
  assert.equal(r.status, 202, \`starting a run of signup v3 answered \${r.status}: \${r.text}\`);
  const body = r.json();
  assert(
    body.definition_version === 3 && JSON.stringify(body.pinned_steps) === JSON.stringify(V3.steps),
    \`a run that asked for signup v3 answered \${r.text}: it must pin version 3 and its steps, whatever was published later\`,
  );
  const stored = await runs.get(body.run_id);
  assert(stored.definition_version === 3 && JSON.stringify(stored.pinned_steps) === JSON.stringify(V3.steps), \`the stored run is \${JSON.stringify(stored)}, expected version 3 and its steps\`);
  r = await c.post('/v1/runs', {json: run(9), headers: TENANT});
  assert.equal(r.status, 404, \`a run of signup v9, never published, answered \${r.status}, expected 404\`);
}

export async function check_bounds(ctx) {
  const {c} = api(ctx);
  await c.post('/v1/workflows', {json: V3});
  let r = await c.post('/v1/runs', {json: run(3, {blob: 'x'.repeat(70000)}), headers: TENANT});
  assert.equal(r.status, 413, \`a 70 KB input answered \${r.status}, expected 413 (MAX_INPUT_BYTES = 1 << 16)\`);
  for (const budget of [0, 501]) {
    r = await c.post('/v1/runs', {json: run(3, {}, budget), headers: TENANT});
    assert.equal(r.status, 400, \`max_steps \${budget} answered \${r.status}, expected 400 (1..MAX_STEPS = 500)\`);
  }
  const stored = ctx.redis.keys('run:run-*');
  assert.deepStrictEqual(stored, [], \`rejected requests wrote run records: \${JSON.stringify(stored)}\`);
  r = await c.post('/v1/runs', {json: run(3, {email: 'ada@example.com'}, 500), headers: TENANT});
  assert.equal(r.status, 202, \`max_steps 500 with a small input answered \${r.status}: \${r.text}\`);
}
`,
    go: `package main

import (
	"context"
	"net/http"
	"strings"

	"workflow/definitions"
	"workflow/runs"

	"leetbuild/harness"
)

var (
	apiBg = context.Background()
	v3    = map[string]any{"name": "signup", "version": 3, "steps": []string{"create_account", "send_welcome"}, "edges": [][]string{{"create_account", "send_welcome"}}}
	v4    = map[string]any{
		"name": "signup", "version": 4, "steps": []string{"create_account", "send_welcome", "notify_sales"},
		"edges": [][]string{{"create_account", "send_welcome"}, {"send_welcome", "notify_sales"}},
	}
	v3Steps = []string{"create_account", "send_welcome"}
)

func api(ctx *harness.Ctx) *harness.HTTP {
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

func runBody(version int, input map[string]any, maxSteps int) map[string]any {
	return map[string]any{"workflow": "signup", "version": version, "input": input, "max_steps": maxSteps}
}

var email = map[string]any{"email": "ada@example.com"}

func CheckCycle(ctx *harness.Ctx) {
	c := api(ctx)
	loop := map[string]any{"name": "loop", "version": 1, "steps": []string{"a", "b", "c"}, "edges": [][]string{{"a", "b"}, {"b", "c"}, {"c", "a"}}}
	r := c.Post("/v1/workflows", loop)
	ctx.Equal(r.Status, 422, "publishing a graph whose edges run a → b → c → a (a run of it never reaches a last step); the status")
	ctx.Assert(definitions.Get(apiBg, "loop", 1) == nil, "the cyclic graph was stored: %+v", definitions.Get(apiBg, "loop", 1))
	r = c.Post("/v1/workflows", v3)
	ctx.Equal(r.Status, 201, "publishing an acyclic graph (%s); the status", r.Text())
	ctx.Assert(definitions.Get(apiBg, "signup", 3) != nil, "the acyclic graph must be stored")
}

func CheckImmutable(ctx *harness.Ctx) {
	c := api(ctx)
	r := c.Post("/v1/workflows", v3)
	ctx.Equal(r.Status, 201, "the first publish of signup v3 (%s); the status", r.Text())
	rewrite := map[string]any{"name": "signup", "version": 3, "steps": []string{"create_account"}, "edges": [][]string{}}
	r = c.Post("/v1/workflows", rewrite)
	ctx.Equal(r.Status, 409, "re-publishing signup v3 with other steps; the status")
	ctx.Equal(definitions.Get(apiBg, "signup", 3).Steps, v3Steps, "re-publishing signup v3 must not rewrite it (every run pinned to v3 would run other steps); its steps")
}

func CheckPin(ctx *harness.Ctx) {
	c := api(ctx)
	c.Post("/v1/workflows", v3)
	c.Post("/v1/workflows", v4)
	r := c.Post("/v1/runs", runBody(3, email, 50), "X-Tenant-Id", "t1")
	ctx.Equal(r.Status, 202, "starting a run of signup v3 (%s); the status", r.Text())
	var body struct {
		RunID             string   \`json:"run_id"\`
		DefinitionVersion int      \`json:"definition_version"\`
		PinnedSteps       []string \`json:"pinned_steps"\`
	}
	r.Decode(&body)
	ctx.Assert(body.DefinitionVersion == 3 && strings.Join(body.PinnedSteps, ",") == strings.Join(v3Steps, ","), "a run that asked for signup v3 answered %s: it must pin version 3 and its steps, whatever was published later", r.Text())
	stored := runs.Get(apiBg, body.RunID)
	ctx.Assert(stored != nil && stored.DefinitionVersion == 3 && strings.Join(stored.PinnedSteps, ",") == strings.Join(v3Steps, ","), "the stored run is %+v, expected version 3 and its steps", stored)
	r = c.Post("/v1/runs", runBody(9, email, 50), "X-Tenant-Id", "t1")
	ctx.Equal(r.Status, 404, "a run of signup v9, never published; the status")
}

func CheckBounds(ctx *harness.Ctx) {
	c := api(ctx)
	c.Post("/v1/workflows", v3)
	r := c.Post("/v1/runs", runBody(3, map[string]any{"blob": strings.Repeat("x", 70000)}, 50), "X-Tenant-Id", "t1")
	ctx.Equal(r.Status, 413, "a 70 KB input (maxInputBytes = 1 << 16); the status")
	for _, budget := range []int{0, 501} {
		r = c.Post("/v1/runs", runBody(3, map[string]any{}, budget), "X-Tenant-Id", "t1")
		ctx.Equal(r.Status, 400, "max_steps %d (1..maxSteps = 500); the status", budget)
	}
	ctx.Equal(ctx.Redis.Keys("run:run-*"), []string{}, "rejected requests must not write run records; the run keys")
	r = c.Post("/v1/runs", runBody(3, email, 500), "X-Tenant-Id", "t1")
	ctx.Equal(r.Status, 202, "max_steps 500 with a small input (%s); the status", r.Text())
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <string>
#include <vector>

#include "workflow/definitions.h"
#include "workflow/runs.h"

namespace {

const std::string kV3 = R"({"name": "signup", "version": 3, "steps": ["create_account", "send_welcome"], "edges": [["create_account", "send_welcome"]]})";
const std::string kV4 =
    R"({"name": "signup", "version": 4, "steps": ["create_account", "send_welcome", "notify_sales"], "edges": [["create_account", "send_welcome"], ["send_welcome", "notify_sales"]]})";
const std::vector<std::string> kV3Steps = {"create_account", "send_welcome"};

harness::HTTP api(harness::Ctx& ctx) {
  static httplib::Server* svr = nullptr;
  delete svr;
  svr = new httplib::Server;
  register_routes(*svr);
  return ctx.HTTP(*svr);
}

harness::Response post(harness::HTTP& c, const std::string& path, const std::string& body) {
  return c.Post(path, body, "Content-Type", "application/json", "X-Tenant-Id", "t1");
}

std::string runBody(long version, const nlohmann::json& input, long max_steps) {
  return nlohmann::json{{"workflow", "signup"}, {"version", version}, {"input", input}, {"max_steps", max_steps}}.dump();
}

const nlohmann::json kEmail = {{"email", "ada@example.com"}};

}  // namespace

void CheckCycle(harness::Ctx& ctx) {
  auto c = api(ctx);
  auto r = post(c, "/v1/workflows", R"({"name": "loop", "version": 1, "steps": ["a", "b", "c"], "edges": [["a", "b"], ["b", "c"], ["c", "a"]]})");
  ctx.Equal(r.Status, 422, "publishing a graph whose edges run a → b → c → a (a run of it never reaches a last step); the status");
  ctx.Assert(!definitions::get("loop", 1), "the cyclic graph was stored");
  r = post(c, "/v1/workflows", kV3);
  ctx.Equal(r.Status, 201, "publishing an acyclic graph (%s); the status", r.Text());
  ctx.Assert(definitions::get("signup", 3).has_value(), "the acyclic graph must be stored");
}

void CheckImmutable(harness::Ctx& ctx) {
  auto c = api(ctx);
  auto r = post(c, "/v1/workflows", kV3);
  ctx.Equal(r.Status, 201, "the first publish of signup v3 (%s); the status", r.Text());
  r = post(c, "/v1/workflows", R"({"name": "signup", "version": 3, "steps": ["create_account"], "edges": []})");
  ctx.Equal(r.Status, 409, "re-publishing signup v3 with other steps; the status");
  ctx.Equal(definitions::get("signup", 3)->steps, kV3Steps, "re-publishing signup v3 must not rewrite it (every run pinned to v3 would run other steps); its steps");
}

void CheckPin(harness::Ctx& ctx) {
  auto c = api(ctx);
  post(c, "/v1/workflows", kV3);
  post(c, "/v1/workflows", kV4);
  auto r = post(c, "/v1/runs", runBody(3, kEmail, 50));
  ctx.Equal(r.Status, 202, "starting a run of signup v3 (%s); the status", r.Text());
  const auto body = nlohmann::json::parse(r.Text(), nullptr, false);
  const bool pinned = body.is_object() && body.value("definition_version", 0L) == 3 && body.value("pinned_steps", std::vector<std::string>{}) == kV3Steps;
  ctx.Assert(pinned, "a run that asked for signup v3 answered %s: it must pin version 3 and its steps, whatever was published later", r.Text());
  const auto stored = runs::get(body.value("run_id", ""));
  ctx.Assert(stored && stored->definition_version == 3 && stored->pinned_steps == kV3Steps, "the stored run must hold version 3 and its steps");
  r = post(c, "/v1/runs", runBody(9, kEmail, 50));
  ctx.Equal(r.Status, 404, "a run of signup v9, never published; the status");
}

void CheckBounds(harness::Ctx& ctx) {
  auto c = api(ctx);
  post(c, "/v1/workflows", kV3);
  auto r = post(c, "/v1/runs", runBody(3, nlohmann::json{{"blob", std::string(70000, 'x')}}, 50));
  ctx.Equal(r.Status, 413, "a 70 KB input (kMaxInputBytes = 1 << 16); the status");
  for (const long budget : {0L, 501L}) {
    r = post(c, "/v1/runs", runBody(3, nlohmann::json::object(), budget));
    ctx.Equal(r.Status, 400, "max_steps %d (1..kMaxSteps = 500); the status", budget);
  }
  ctx.Equal(ctx.Redis.Keys("run:run-*"), std::vector<std::string>{}, "rejected requests must not write run records; the run keys");
  r = post(c, "/v1/runs", runBody(3, kEmail, 500));
  ctx.Equal(r.Status, 202, "max_steps 500 with a small input (%s); the status", r.Text());
}
`,
  },
  hints: [
    'Publish signup v4 while a client still asks for v3: the 202 says `definition_version` 4. Re-publish v3 with fewer steps and v3 changes; a graph with a cycle is stored without complaint.',
    "`start_run` reads `definitions.latest` and never looks at the body's version. `publish_workflow` hands everything to `definitions.put`, which overwrites the hash, and nothing measures the input or the budget.",
    'Publish: `has_cycle` → 422, `exists` → 409, then `put`. Start: 413 when `len(json.dumps(input).encode()) > MAX_INPUT_BYTES`, 400 unless `1 <= max_steps <= MAX_STEPS`, then `definitions.get(workflow, version)` (404) and `runs.create`.',
  ],
  debrief: `Each fix sits at the moment its information exists. At publish time the whole graph is in hand, so a cycle and a duplicate version are cheap rejections no run ever sees. At start the run copies its version's step list, because a run that resolves "latest" behaves according to deploy timing instead of what the client asked for. The bounds run before \`runs.create\`, so a rejected request leaves nothing to clean up. Temporal solves the same problem for code: a Pinned workflow finishes on the worker build it started on, and moving it is an explicit operator command. Engines that let a definition change under a running workflow also need a migration story, such as a patch marker the workflow checks before taking the new branch.`,
};
