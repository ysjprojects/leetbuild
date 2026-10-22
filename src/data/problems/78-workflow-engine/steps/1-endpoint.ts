import type {Step} from '@/lib/types';

export const endpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/workflows: definitions are immutable, runs are bounded',
  concept: 'http',
  file: 'api',
  focus: ['client', 'engine', 'db'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it registers both routes,
parses the bodies and answers with the run it just created. It compiles, it serves the demo, and it
hides three production flaws. Review it like the engine owner, fix it, and prove the fix with the
checks below.

Implement the run API as two routes.

- \`POST /v1/workflows\` publishes a definition version: body
  \`{"name": "signup", "version": 3, "steps": ["create_account", "send_welcome"],
  "edges": [["create_account", "send_welcome"]]}\`. A published \`(name, version)\` is
  **immutable** — publishing it again is **409** — and a definition whose step graph contains a
  cycle is **422 at publish time**, never at run time and never a run that spins to its step cap.
- \`POST /v1/runs\` starts a run from
  \`{"workflow": "signup", "version": 3, "input": {…}, "max_steps": 50}\`. The run **pins** the
  definition version and that version's step list at start, so a publish while the run is in flight
  cannot change what the run does. An unknown \`(workflow, version)\` is **404**.
- The input document is serialized JSON of at most **64 KiB** (\`1 << 16\` bytes); a larger one is
  **413**.
- \`max_steps\` is an integer from **1** to **500** (**400** otherwise) and defaults to 3. It is the
  cap the runner enforces, so a bounded run can never loop forever.
- The response carries \`run_id\`, \`workflow\`, \`definition_version\`, \`pinned_steps\` and
  \`max_steps\`.

**Failure mode the checks target.** The draft resolves the *latest* definition on every advance, so
publishing version 4 during a version-3 run silently changes the steps that run executes — sometimes
between two steps, always irreproducibly. It also accepts inputs of any size, so one request can pin
a gigabyte into the checkpoint, and it publishes cyclic definitions, so the only thing that ever
stopped such a run was the step cap. Pinning, capping and refusing are the three behaviors the
checks look for.`,
  sequence: {
    participants: ['Client', 'Workflow Engine', 'definition store'],
    messages: [
      {
        from: 'Client',
        to: 'Workflow Engine',
        label: 'POST /v1/workflows · name · version · steps · edges',
        kind: 'sync',
      },
      {from: 'Workflow Engine', to: 'Workflow Engine', label: 'find a cycle · reject with 422', kind: 'sync'},
      {from: 'Workflow Engine', to: 'definition store', label: 'publish immutable version', kind: 'async'},
      {from: 'Client', to: 'Workflow Engine', label: 'POST /v1/runs · version · input · max_steps', kind: 'sync'},
      {from: 'Workflow Engine', to: 'Workflow Engine', label: 'cap the input · cap max_steps', kind: 'sync'},
      {from: 'Workflow Engine', to: 'definition store', label: 'get(name, requested version)', kind: 'sync'},
      {from: 'definition store', to: 'Workflow Engine', label: 'steps of that pinned version', kind: 'reply'},
      {
        from: 'Workflow Engine',
        to: 'Client',
        label: '202 {run_id, definition_version, pinned_steps, max_steps}',
        kind: 'reply',
      },
    ],
  },
  checks: [
    {
      id: 'routes',
      title: 'Publishes a definition and starts a run',
      detail:
        '`POST /v1/workflows` publishes a definition version and `POST /v1/runs` starts a run against one. The draft already registers both, so this check is the floor the other four build on.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/workflows["']/, /@app\.post\(\s*["']\/v1\/runs["']/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/workflows['"]/, /app\.post\(\s*['"]\/v1\/runs['"]/]},
        go: {all: [/HandleFunc\(\s*"POST \/v1\/workflows"/, /HandleFunc\(\s*"POST \/v1\/runs"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"workflows"\s*\)/, /path\(\s*"v1"\s*\/\s*"runs"\s*\)/]},
        cpp: {all: [/svr\.Post\(\s*"\/v1\/workflows"/, /svr\.Post\(\s*"\/v1\/runs"/]},
      },
    },
    {
      id: 'cycle',
      title: 'Refuses a cyclic definition at publish time',
      detail:
        'A definition whose step graph contains a cycle is rejected with **422** when it is published, so a run can never spin whatever its cap is. The draft publishes it and only ever stops it when the run exhausts the cap.',
      match: {
        python: {all: [/has_cycle\(/, /status_code\s*=\s*422/]},
        typescript: {all: [/hasCycle\(/, /code\(\s*422\s*\)/]},
        go: {all: [/hasCycle\(/, /StatusUnprocessableEntity/]},
        scala: {all: [/hasCycle\(/, /StatusCodes\.UnprocessableEntity/]},
        cpp: {all: [/hasCycle\(/, /\b422\b/]},
      },
    },
    {
      id: 'pin',
      title: 'Pins the definition version for the life of the run',
      detail:
        'A run stores the version it started on and the step list of that version, resolved once at start and reported as `definition_version` and `pinned_steps`. The draft stores no version and re-reads the newest definition, so a publish mid-flight silently changes what the run does.',
      match: {
        python: {all: [/definition_version/, /pinned_steps/, /store\.get\(/]},
        typescript: {all: [/definition_version/, /pinned_steps/, /store\.get\(/]},
        go: {all: [/DefinitionVersion/, /PinnedSteps/, /store\.Get\(/]},
        scala: {all: [/definitionVersion/, /pinnedSteps/, /store\.get\(/]},
        cpp: {all: [/definition_version/, /pinned_steps/, /store\.get\(/]},
      },
    },
    {
      id: 'bounds',
      title: 'Caps the input document and the step budget',
      detail:
        'An input document over `1 << 16` bytes is **413** and `max_steps` outside 1..500 is **400**. The draft accepts inputs of any size and any step budget, so one request can pin a gigabyte of input and a run is only bounded by the worker.',
      match: {
        python: {all: [/MAX_INPUT_BYTES/, /MAX_STEPS/, /status_code\s*=\s*413/, /status_code\s*=\s*400/]},
        typescript: {all: [/MAX_INPUT_BYTES/, /MAX_STEPS/, /code\(\s*413\s*\)/, /code\(\s*400\s*\)/]},
        go: {all: [/maxInputBytes/, /maxSteps/, /StatusRequestEntityTooLarge/, /StatusBadRequest/]},
        scala: {all: [/MaxInputBytes/, /MaxSteps/, /StatusCodes\.RequestEntityTooLarge/, /StatusCodes\.BadRequest/]},
        cpp: {all: [/kMaxInputBytes/, /kMaxSteps/, /\b413\b/, /\b400\b/]},
      },
    },
    {
      id: 'immutable',
      title: 'Keeps a published version immutable',
      detail:
        'A version that already exists is checked before the write and publishing it again is **409**. The draft upserts, so a deploy that re-publishes version 3 changes a definition that running runs are pinned to.',
      match: {
        python: {all: [/store\.exists\(/, /status_code\s*=\s*409/]},
        typescript: {all: [/store\.exists\(/, /code\(\s*409\s*\)/]},
        go: {all: [/store\.Exists\(/, /StatusConflict/]},
        scala: {all: [/store\.exists\(/, /StatusCodes\.Conflict/]},
        cpp: {all: [/store\.exists\(/, /\b409\b/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import logging

from fastapi import FastAPI
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()
logger = logging.getLogger("workflow")


class PublishRequest(BaseModel):
    name: str
    version: int
    steps: list[str]
    edges: list[list[str]] = []


class RunRequest(BaseModel):
    workflow: str
    input: dict = {}
    max_steps: int = 3


class DefinitionStore:
    def put(self, name: str, version: int, steps: list[str]) -> None:
        """Store the definition under (name, version)."""
        raise NotImplementedError

    def latest(self, name: str) -> dict | None:
        """The newest definition version published under name."""
        raise NotImplementedError


store = DefinitionStore()


@app.post("/v1/workflows")
def publish(body: PublishRequest) -> JSONResponse:
    # TODO: this draft publishes any definition, cycle or not, and overwrites an existing
    # (name, version) instead of refusing to mutate a published one.
    store.put(body.name, body.version, body.steps)
    return JSONResponse({"name": body.name, "version": body.version}, status_code=201)


@app.post("/v1/runs")
def start_run(body: RunRequest) -> JSONResponse:
    # TODO: this draft resolves the newest definition instead of pinning the version the run
    # started on, and validates neither the size of the input document nor max_steps.
    definition = store.latest(body.workflow)
    run = {
        "run_id": "run-1",
        "workflow": body.workflow,
        "steps": definition["steps"] if definition else [],
        "input": body.input,
    }
    logger.info("run started workflow=%s", body.workflow)
    return JSONResponse(run, status_code=202)
`,
      solution: `import json
import logging
import uuid

from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()
logger = logging.getLogger("workflow")

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
    max_steps: int = 3


class DefinitionStore:
    def publish(self, name: str, version: int, steps: list[str]) -> None:
        """Write one immutable definition version."""
        raise NotImplementedError

    def exists(self, name: str, version: int) -> bool:
        """True when (name, version) has already been published."""
        raise NotImplementedError

    def get(self, name: str, version: int) -> dict | None:
        """The definition pinned as (name, version), if it exists."""
        raise NotImplementedError


store = DefinitionStore()


def has_cycle(steps: list[str], edges: list[list[str]]) -> bool:
    """True when the step graph has a cycle, so the run could spin to its step cap."""
    adjacency: dict[str, list[str]] = {step: [] for step in steps}
    for source, target in edges:
        adjacency.setdefault(source, []).append(target)
    visiting: set[str] = set()
    settled: set[str] = set()

    def visit(node: str) -> bool:
        if node in settled:
            return False
        if node in visiting:
            return True
        visiting.add(node)
        for target in adjacency.get(node, []):
            if visit(target):
                return True
        visiting.discard(node)
        settled.add(node)
        return False

    return any(visit(step) for step in steps)


@app.post("/v1/workflows")
def publish(body: PublishRequest) -> JSONResponse:
    if len(body.steps) == 0:
        raise HTTPException(status_code=400, detail="definition has no steps")
    if has_cycle(body.steps, body.edges):
        raise HTTPException(status_code=422, detail="definition contains a cycle")
    if store.exists(body.name, body.version):
        raise HTTPException(status_code=409, detail="version is immutable")
    store.publish(body.name, body.version, body.steps)
    return JSONResponse({"name": body.name, "version": body.version}, status_code=201)


@app.post("/v1/runs")
def start_run(body: RunRequest) -> JSONResponse:
    if len(json.dumps(body.input).encode("utf-8")) > MAX_INPUT_BYTES:
        raise HTTPException(status_code=413, detail="input exceeds 64 KiB")
    if not 1 <= body.max_steps <= MAX_STEPS:
        raise HTTPException(status_code=400, detail="max_steps must be 1..500")
    definition = store.get(body.workflow, body.version)
    if definition is None:
        raise HTTPException(status_code=404, detail="unknown definition version")
    run = {
        "run_id": str(uuid.uuid4()),
        "workflow": body.workflow,
        "definition_version": body.version,
        "pinned_steps": definition["steps"],
        "max_steps": body.max_steps,
    }
    logger.info("run started workflow=%s version=%d", body.workflow, body.version)
    return JSONResponse(run, status_code=202)
`,
    },
    typescript: {
      starter: `/** POST /v1/workflows and POST /v1/runs: a model-generated draft that floats a run to the newest definition. */
import Fastify from 'fastify';

export const app = Fastify();

interface PublishBody {
  name: string;
  version: number;
  steps: string[];
  edges?: string[][];
}

interface RunBody {
  workflow: string;
  input?: Record<string, unknown>;
  max_steps?: number;
}

export const store = {
  put: async (_name: string, _version: number, _steps: string[]): Promise<void> => {
    throw new Error('not implemented');
  },
  latest: async (_name: string): Promise<{steps: string[]} | null> => {
    throw new Error('not implemented');
  },
};

app.post('/v1/workflows', async (request, reply) => {
  // TODO: this draft publishes any definition, cycle or not, and overwrites an existing
  // (name, version) instead of refusing to mutate a published one.
  const body = request.body as PublishBody;
  await store.put(body.name, body.version, body.steps);
  return reply.code(201).send({name: body.name, version: body.version});
});

app.post('/v1/runs', async (request, reply) => {
  // TODO: this draft resolves the newest definition instead of pinning the version the run
  // started on, and validates neither the size of the input document nor max_steps.
  const body = request.body as RunBody;
  const definition = await store.latest(body.workflow);
  return reply.code(202).send({
    run_id: 'run-1',
    workflow: body.workflow,
    steps: definition?.steps ?? [],
    input: body.input ?? {},
  });
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** POST /v1/workflows and POST /v1/runs: immutable versions, pinned runs and bounded inputs. */
import {randomUUID} from 'node:crypto';

import Fastify from 'fastify';

export const app = Fastify();

const MAX_INPUT_BYTES = 1 << 16;
const MAX_STEPS = 500;

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

export interface DefinitionStore {
  publish(name: string, version: number, steps: string[]): Promise<void>;
  exists(name: string, version: number): Promise<boolean>;
  get(name: string, version: number): Promise<{steps: string[]} | null>;
}

export const store: DefinitionStore = {
  publish: async () => {
    throw new Error('not implemented');
  },
  exists: async () => {
    throw new Error('not implemented');
  },
  get: async () => {
    throw new Error('not implemented');
  },
};

/** True when the step graph has a cycle, so the run could spin to its step cap. */
function hasCycle(steps: string[], edges: string[][]): boolean {
  const adjacency = new Map<string, string[]>(steps.map(step => [step, []]));
  for (const [source, target] of edges) adjacency.set(source, [...(adjacency.get(source) ?? []), target]);
  const visiting = new Set<string>();
  const settled = new Set<string>();
  const visit = (node: string): boolean => {
    if (settled.has(node)) return false;
    if (visiting.has(node)) return true;
    visiting.add(node);
    for (const target of adjacency.get(node) ?? []) if (visit(target)) return true;
    visiting.delete(node);
    settled.add(node);
    return false;
  };
  return steps.some(visit);
}

app.post('/v1/workflows', async (request, reply) => {
  const body = request.body as PublishBody;
  if (!Array.isArray(body.steps) || body.steps.length === 0)
    return reply.code(400).send({error: 'definition has no steps'});
  if (hasCycle(body.steps, body.edges ?? [])) return reply.code(422).send({error: 'definition contains a cycle'});
  if (await store.exists(body.name, body.version)) return reply.code(409).send({error: 'version is immutable'});
  await store.publish(body.name, body.version, body.steps);
  return reply.code(201).send({name: body.name, version: body.version});
});

app.post('/v1/runs', async (request, reply) => {
  const body = request.body as RunBody;
  const input = body.input ?? {};
  if (Buffer.byteLength(JSON.stringify(input), 'utf8') > MAX_INPUT_BYTES)
    return reply.code(413).send({error: 'input exceeds 64 KiB'});
  const maxSteps = body.max_steps ?? 3;
  if (!Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > MAX_STEPS)
    return reply.code(400).send({error: 'max_steps must be 1..500'});
  const definition = await store.get(body.workflow, body.version);
  if (definition === null) return reply.code(404).send({error: 'unknown definition version'});
  request.log.info({workflow: body.workflow, version: body.version}, 'run started');
  return reply.code(202).send({
    run_id: randomUUID(),
    workflow: body.workflow,
    definition_version: body.version,
    pinned_steps: definition.steps,
    max_steps: maxSteps,
  });
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

type PublishRequest struct {
	Name    string     \`json:"name"\`
	Version int        \`json:"version"\`
	Steps   []string   \`json:"steps"\`
	Edges   [][]string \`json:"edges"\`
}

type RunRequest struct {
	Workflow string         \`json:"workflow"\`
	Input    map[string]any \`json:"input"\`
	MaxSteps int            \`json:"max_steps"\`
}

type DefinitionStore struct{}

func (s *DefinitionStore) Put(ctx context.Context, name string, version int, steps []string) error {
	return nil
}

func (s *DefinitionStore) Latest(ctx context.Context, name string) (map[string]any, error) {
	return nil, nil
}

var store = &DefinitionStore{}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func publish(rw http.ResponseWriter, r *http.Request) {
	// TODO: this draft publishes any definition, cycle or not, and overwrites an existing
	// (name, version) instead of refusing to mutate a published one.
	var body PublishRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	store.Put(r.Context(), body.Name, body.Version, body.Steps)
	writeJSON(rw, http.StatusCreated, map[string]any{"name": body.Name, "version": body.Version})
}

func startRun(rw http.ResponseWriter, r *http.Request) {
	// TODO: this draft resolves the newest definition instead of pinning the version the run
	// started on, and validates neither the size of the input document nor max_steps.
	var body RunRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	definition, _ := store.Latest(r.Context(), body.Workflow)
	steps := []string{}
	if definition != nil {
		if pinned, ok := definition["steps"].([]string); ok {
			steps = pinned
		}
	}
	writeJSON(rw, http.StatusAccepted, map[string]any{
		"run_id":   "run-1",
		"workflow": body.Workflow,
		"steps":    steps,
		"input":    body.Input,
	})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/workflows", publish)
	mux.HandleFunc("POST /v1/runs", startRun)
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

const (
	maxInputBytes = 1 << 16
	maxSteps      = 500
)

type PublishRequest struct {
	Name    string     \`json:"name"\`
	Version int        \`json:"version"\`
	Steps   []string   \`json:"steps"\`
	Edges   [][]string \`json:"edges"\`
}

type RunRequest struct {
	Workflow string         \`json:"workflow"\`
	Version  int            \`json:"version"\`
	Input    map[string]any \`json:"input"\`
	MaxSteps int            \`json:"max_steps"\`
}

type Run struct {
	RunID             string   \`json:"run_id"\`
	Workflow          string   \`json:"workflow"\`
	DefinitionVersion int      \`json:"definition_version"\`
	PinnedSteps       []string \`json:"pinned_steps"\`
	MaxSteps          int      \`json:"max_steps"\`
}

type DefinitionStore struct{}

func (s *DefinitionStore) Publish(ctx context.Context, name string, version int, steps []string) error {
	return nil
}

func (s *DefinitionStore) Exists(ctx context.Context, name string, version int) (bool, error) {
	return false, nil
}

func (s *DefinitionStore) Get(ctx context.Context, name string, version int) ([]string, error) {
	return nil, nil
}

var store = &DefinitionStore{}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

// hasCycle walks the step graph once, so a cyclic definition is refused at publish time.
func hasCycle(steps []string, edges [][]string) bool {
	adjacency := map[string][]string{}
	for _, step := range steps {
		adjacency[step] = []string{}
	}
	for _, edge := range edges {
		if len(edge) == 2 {
			adjacency[edge[0]] = append(adjacency[edge[0]], edge[1])
		}
	}
	visiting := map[string]bool{}
	settled := map[string]bool{}
	var visit func(node string) bool
	visit = func(node string) bool {
		if settled[node] {
			return false
		}
		if visiting[node] {
			return true
		}
		visiting[node] = true
		for _, target := range adjacency[node] {
			if visit(target) {
				return true
			}
		}
		delete(visiting, node)
		settled[node] = true
		return false
	}
	for _, step := range steps {
		if visit(step) {
			return true
		}
	}
	return false
}

func publish(rw http.ResponseWriter, r *http.Request) {
	var body PublishRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	if len(body.Steps) == 0 {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "definition has no steps"})
		return
	}
	if hasCycle(body.Steps, body.Edges) {
		writeJSON(rw, http.StatusUnprocessableEntity, map[string]string{"error": "definition contains a cycle"})
		return
	}
	exists, err := store.Exists(r.Context(), body.Name, body.Version)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	if exists {
		writeJSON(rw, http.StatusConflict, map[string]string{"error": "version is immutable"})
		return
	}
	if err := store.Publish(r.Context(), body.Name, body.Version, body.Steps); err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	writeJSON(rw, http.StatusCreated, map[string]any{"name": body.Name, "version": body.Version})
}

func startRun(rw http.ResponseWriter, r *http.Request) {
	var body RunRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	document, _ := json.Marshal(body.Input)
	if len(document) > maxInputBytes {
		writeJSON(rw, http.StatusRequestEntityTooLarge, map[string]string{"error": "input exceeds 64 KiB"})
		return
	}
	if body.MaxSteps == 0 {
		body.MaxSteps = 3
	}
	if body.MaxSteps < 1 || body.MaxSteps > maxSteps {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "max_steps must be 1..500"})
		return
	}
	pinnedSteps, err := store.Get(r.Context(), body.Workflow, body.Version)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	if pinnedSteps == nil {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "unknown definition version"})
		return
	}
	run := Run{
		RunID:             uuid.NewString(),
		Workflow:          body.Workflow,
		DefinitionVersion: body.Version,
		PinnedSteps:       pinnedSteps,
		MaxSteps:          body.MaxSteps,
	}
	log.Printf("run started workflow=%s version=%d", body.Workflow, body.Version)
	writeJSON(rw, http.StatusAccepted, run)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/workflows", publish)
	mux.HandleFunc("POST /v1/runs", startRun)
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
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class PublishRequest(name: String, version: Int, steps: List[String], edges: List[List[String]] = Nil)
final case class Definition(name: String, version: Int, steps: List[String])
final case class RunRequest(workflow: String, input: Map[String, String] = Map.empty, max_steps: Int = 3)

trait DefinitionStore {
  def put(name: String, version: Int, steps: List[String]): Unit
  def latest(name: String): Option[Definition]
}

object DefinitionStore {
  def open(): DefinitionStore = new DefinitionStore {
    def put(name: String, version: Int, steps: List[String]): Unit = ()
    def latest(name: String): Option[Definition] = None
  }
}

object WorkflowApi {
  implicit val system: ActorSystem = ActorSystem("workflow")
  implicit val publishFormat: RootJsonFormat[PublishRequest] = jsonFormat4(PublishRequest)
  implicit val runFormat: RootJsonFormat[RunRequest] = jsonFormat3(RunRequest)

  val store = DefinitionStore.open()

  val route: Route =
    path("v1" / "workflows") {
      post {
        entity(as[PublishRequest]) { body =>
          // TODO: this draft publishes any definition, cycle or not, and overwrites an existing
          // (name, version) instead of refusing to mutate a published one.
          store.put(body.name, body.version, body.steps)
          complete(StatusCodes.Created, s"""{"name":"\${body.name}","version":\${body.version}}""")
        }
      }
    } ~
      path("v1" / "runs") {
        post {
          entity(as[RunRequest]) { body =>
            // TODO: this draft resolves the newest definition instead of pinning the version the
            // run started on, and validates neither the input size nor max_steps.
            val definition = store.latest(body.workflow)
            val steps = definition.map(_.steps).getOrElse(Nil)
            complete(
              StatusCodes.Accepted,
              s"""{"run_id":"run-1","workflow":"\${body.workflow}","steps":\${steps.mkString("\\"", "\\",\\"", "\\"")}}"""
            )
          }
        }
      }

  def main(args: Array[String]): Unit = {
    Http().newServerAt("0.0.0.0", 8443).bind(route)
  }
}
`,
      solution: `import java.nio.charset.StandardCharsets
import java.util.UUID

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class PublishRequest(name: String, version: Int, steps: List[String], edges: List[List[String]] = Nil)
final case class Definition(name: String, version: Int, steps: List[String])
final case class RunRequest(workflow: String, version: Int, input: Map[String, String] = Map.empty, max_steps: Int = 3)

trait DefinitionStore {
  def publish(name: String, version: Int, steps: List[String]): Unit
  def exists(name: String, version: Int): Boolean
  def get(name: String, version: Int): Option[Definition]
}

object DefinitionStore {
  def open(): DefinitionStore = new DefinitionStore {
    def publish(name: String, version: Int, steps: List[String]): Unit = ()
    def exists(name: String, version: Int): Boolean = false
    def get(name: String, version: Int): Option[Definition] = None
  }
}

object WorkflowApi {
  implicit val system: ActorSystem = ActorSystem("workflow")
  implicit val publishFormat: RootJsonFormat[PublishRequest] = jsonFormat4(PublishRequest)
  implicit val runFormat: RootJsonFormat[RunRequest] = jsonFormat4(RunRequest)

  val MaxInputBytes = 1 << 16
  val MaxSteps = 500

  val store = DefinitionStore.open()

  def hasCycle(steps: List[String], edges: List[List[String]]): Boolean = {
    val adjacency: Map[String, List[String]] =
      steps.map(step => step -> edges.collect { case List(source, target) if source == step => target }).toMap
    val visiting = scala.collection.mutable.Set.empty[String]
    val settled = scala.collection.mutable.Set.empty[String]
    def visit(node: String): Boolean = {
      if (settled.contains(node)) false
      else if (visiting.contains(node)) true
      else {
        visiting += node
        val cyclic = adjacency.getOrElse(node, Nil).exists(visit)
        visiting -= node
        settled += node
        cyclic
      }
    }
    steps.exists(visit)
  }

  val route: Route =
    path("v1" / "workflows") {
      post {
        entity(as[PublishRequest]) { body =>
          if (body.steps.isEmpty) {
            complete(StatusCodes.BadRequest, """{"error":"definition has no steps"}""")
          } else if (hasCycle(body.steps, body.edges)) {
            complete(StatusCodes.UnprocessableEntity, """{"error":"definition contains a cycle"}""")
          } else if (store.exists(body.name, body.version)) {
            complete(StatusCodes.Conflict, """{"error":"version is immutable"}""")
          } else {
            store.publish(body.name, body.version, body.steps)
            complete(StatusCodes.Created, s"""{"name":"\${body.name}","version":\${body.version}}""")
          }
        }
      }
    } ~
      path("v1" / "runs") {
        post {
          entity(as[RunRequest]) { body =>
            val inputBytes = body.input.toString.getBytes(StandardCharsets.UTF_8).length
            if (inputBytes > MaxInputBytes) {
              complete(StatusCodes.RequestEntityTooLarge, """{"error":"input exceeds 64 KiB"}""")
            } else if (body.max_steps < 1 || body.max_steps > MaxSteps) {
              complete(StatusCodes.BadRequest, """{"error":"max_steps must be 1..500"}""")
            } else {
              store.get(body.workflow, body.version) match {
                case None =>
                  complete(StatusCodes.NotFound, """{"error":"unknown definition version"}""")
                case Some(definition) =>
                  system.log.info(s"run started workflow=\${body.workflow} version=\${body.version}")
                  val runId = UUID.randomUUID().toString
                  val definitionVersion = body.version
                  val pinnedSteps = definition.steps.mkString("\\"", "\\",\\"", "\\"")
                  complete(
                    StatusCodes.Accepted,
                    s"""{"run_id":"$runId","workflow":"\${body.workflow}","definition_version":$definitionVersion,"pinned_steps":$pinnedSteps,"max_steps":\${body.max_steps}}"""
                  )
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
  void put(const std::string& name, int version, const std::vector<std::string>& steps);
  std::optional<json> latest(const std::string& name);
};

DefinitionStore store;

int main() {
  httplib::Server svr;

  svr.Post("/v1/workflows", [](const httplib::Request& req, httplib::Response& res) {
    // TODO: this draft publishes any definition, cycle or not, and overwrites an existing
    // (name, version) instead of refusing to mutate a published one.
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) {
      res.status = 400;
      res.set_content(R"({"error":"invalid json"})", "application/json");
      return;
    }
    store.put(body.value("name", std::string()), body.value("version", 0),
              body.value("steps", std::vector<std::string>()));
    res.status = 201;
    res.set_content(json{{"name", body.value("name", std::string())}, {"version", body.value("version", 0)}}.dump(),
                    "application/json");
  });

  svr.Post("/v1/runs", [](const httplib::Request& req, httplib::Response& res) {
    // TODO: this draft resolves the newest definition instead of pinning the version the run
    // started on, and validates neither the size of the input document nor max_steps.
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) {
      res.status = 400;
      res.set_content(R"({"error":"invalid json"})", "application/json");
      return;
    }
    const auto newest = store.latest(body.value("workflow", std::string()));
    json run = {
        {"run_id", "run-1"},
        {"workflow", body.value("workflow", std::string())},
        {"steps", newest ? (*newest)["steps"] : json::array()},
        {"input", body.value("input", json::object())},
    };
    res.status = 202;
    res.set_content(run.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <functional>
#include <iostream>
#include <map>
#include <optional>
#include <set>
#include <string>
#include <vector>

using json = nlohmann::json;

constexpr std::size_t kMaxInputBytes = 1 << 16;
constexpr int kMaxSteps = 500;

struct Definition {
  int version = 0;
  std::vector<std::string> steps;
};

struct DefinitionStore {
  void publish(const std::string& name, int version, const std::vector<std::string>& steps);
  bool exists(const std::string& name, int version);
  std::optional<Definition> get(const std::string& name, int version);
};

DefinitionStore store;
std::string uuidString();

/** True when the step graph has a cycle, so the run could spin to its step cap. */
bool hasCycle(const std::vector<std::string>& steps, const std::vector<std::vector<std::string>>& edges) {
  std::map<std::string, std::vector<std::string>> adjacency;
  for (const auto& step : steps) adjacency[step];
  for (const auto& edge : edges) {
    if (edge.size() == 2) adjacency[edge[0]].push_back(edge[1]);
  }
  std::set<std::string> visiting;
  std::set<std::string> settled;
  std::function<bool(const std::string&)> visit = [&](const std::string& node) -> bool {
    if (settled.count(node) != 0) return false;
    if (visiting.count(node) != 0) return true;
    visiting.insert(node);
    for (const auto& target : adjacency[node]) {
      if (visit(target)) return true;
    }
    visiting.erase(node);
    settled.insert(node);
    return false;
  };
  for (const auto& step : steps) {
    if (visit(step)) return true;
  }
  return false;
}

int main() {
  httplib::Server svr;

  svr.Post("/v1/workflows", [](const httplib::Request& req, httplib::Response& res) {
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object() || !body.contains("steps")) {
      res.status = 400;
      res.set_content(R"({"error":"definition has no steps"})", "application/json");
      return;
    }
    const auto steps = body["steps"].get<std::vector<std::string>>();
    if (steps.empty()) {
      res.status = 400;
      res.set_content(R"({"error":"definition has no steps"})", "application/json");
      return;
    }
    const auto edges = body.value("edges", std::vector<std::vector<std::string>>());
    if (hasCycle(steps, edges)) {
      res.status = 422;
      res.set_content(R"({"error":"definition contains a cycle"})", "application/json");
      return;
    }
    const auto name = body.value("name", std::string());
    const int version = body.value("version", 0);
    if (store.exists(name, version)) {
      res.status = 409;
      res.set_content(R"({"error":"version is immutable"})", "application/json");
      return;
    }
    store.publish(name, version, steps);
    res.status = 201;
    res.set_content(json{{"name", name}, {"version", version}}.dump(), "application/json");
  });

  svr.Post("/v1/runs", [](const httplib::Request& req, httplib::Response& res) {
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) {
      res.status = 400;
      res.set_content(R"({"error":"invalid json"})", "application/json");
      return;
    }
    const auto input = body.value("input", json::object());
    if (input.dump().size() > kMaxInputBytes) {
      res.status = 413;
      res.set_content(R"({"error":"input exceeds 64 KiB"})", "application/json");
      return;
    }
    const int maxSteps = body.value("max_steps", 3);
    if (maxSteps < 1 || maxSteps > kMaxSteps) {
      res.status = 400;
      res.set_content(R"({"error":"max_steps must be 1..500"})", "application/json");
      return;
    }
    const auto workflow = body.value("workflow", std::string());
    const int version = body.value("version", 0);
    const auto definition = store.get(workflow, version);
    if (!definition) {
      res.status = 404;
      res.set_content(R"({"error":"unknown definition version"})", "application/json");
      return;
    }
    json run = {
        {"run_id", uuidString()},
        {"workflow", workflow},
        {"definition_version", version},
        {"pinned_steps", definition->steps},
        {"max_steps", maxSteps},
    };
    std::cerr << "run started workflow=" << workflow << " version=" << version << "\\n";
    res.status = 202;
    res.set_content(run.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  hints: [
    'Write the publish path first: a definition with no steps is useless, a definition with a cycle is a run that can only end at the step cap, and a version that already exists must never be overwritten. Each of those is a cheap rejection before any run exists.',
    'The run path pins, it does not look up. Store the version and the step list in the run record at start (`definition_version`, `pinned_steps`) and read the definition exactly once, with the version the caller named — never `latest`, which is a different run’s definition the moment someone publishes again.',
    'Size the input the way the engine will store it: serialize the document and compare its byte length against `1 << 16`, and range-check `max_steps` from 1 to 500. Both rejections happen before the run record is written, so a rejected request leaves nothing behind.',
  ],
  debrief: `The interviewer is testing whether you can review a generated handler at the boundary where a definition becomes a run. The draft reads fine because the demo publishes once, starts one run and never deploys in between. Three defects are being checked, and each one is a class of production incident: a run that follows the newest definition turns every mid-flight deploy into an irreproducible run; an uncapped input document lets one request pin an unbounded amount of data into the checkpoint; and a published cyclic definition has no end other than the step cap, which is exactly the sort of run that pages someone at 03:00. The immutability check is the one that is easy to miss: an upsert on \`(name, version)\` looks harmless until a redeploy re-publishes a version that runs are pinned to, and then the pinned version is no longer what it was. In a real engine the pin also carries the definition's own hash, so the store can refuse a re-publish that changes any byte, and starting a run returns a \`202\` with the run id rather than the whole definition.`,
};
