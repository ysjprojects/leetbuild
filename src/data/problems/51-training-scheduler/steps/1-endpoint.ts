import type {Step} from '@/lib/types';

export const trainingEndpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/training/runs: a run that starts exactly once',
  concept: 'http',
  file: 'api',
  focus: ['client', 'scheduler', 'store', 'redis'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it registers the route, mints a
run id and answers \`201 queued\`. It compiles, it serves the demo, and it hides four production
flaws. Review it like the owner of the scheduler, fix it, and prove the fix with the checks below.

Implement \`POST /v1/training/runs\` with body
\`{"dataset_version": "…", "recipe_version": "…", "priority": 5}\`.

- The tenant comes from the authenticated \`X-Tenant-Id\` header; a missing tenant is **401**.
- \`Idempotency-Key\` is required (**400** when missing). A retry with the same \`(tenant, key)\`
  returns the **original run** — the same \`run_id\`, and no second entry in the queue.
- \`dataset_version\` is a non-empty string of at most **128** characters (**400** otherwise).
- \`recipe_version\` must be one of the recipe registry's versions (**400** for anything else, and the
  rejection happens **before** the run is enqueued: an unknown recipe must never reach a GPU).
- \`priority\` is an integer, defaults to **5**, and is **clamped** into the supported range
  \`0..9\` and then mapped into **3** bands (high when the priority is at least 7, normal from 3, low
  below that). \`999999\` becomes \`9\`, in the high band — never an unbounded jump past every queue.
- The \`run_id\` is issued by the **scheduler** (a fresh UUID) and persisted under
  \`(tenant, Idempotency-Key)\` **before** the response, so a scheduler restart can replay the
  submission instead of starting a second run.
- Answer \`201\` with the run: \`{"run_id", "state": "queued", "priority", "band"}\`; a replayed
  submission answers \`200\` with the stored run.
- Log the decision (run id, tenant, band) — the dataset and recipe contents never appear in a log
  line.

**Failure mode the checks target.** An unclamped priority lets any caller jump every band, and it is
the flaw that stays invisible until two teams compete for the same fleet. The recipe check is the
one that costs money: without it a typo in a recipe version consumes a GPU slot for a job that can
only fail. The retry is the quiet one: a client that times out and retries the *same* key starts a
second run, so one submission trains two models and bills twice.`,
  sequence: {
    participants: ['Client', 'Training Scheduler', 'run store', 'Redis queue'],
    messages: [
      {
        from: 'Client',
        to: 'Training Scheduler',
        label: 'POST /v1/training/runs · X-Tenant-Id · Idempotency-Key',
        kind: 'sync',
      },
      {from: 'Training Scheduler', to: 'Training Scheduler', label: 'validate versions · clamp priority', kind: 'sync'},
      {from: 'Training Scheduler', to: 'run store', label: 'get(tenant, idem_key)', kind: 'sync'},
      {from: 'run store', to: 'Training Scheduler', label: 'stored run / none', kind: 'reply'},
      {from: 'Training Scheduler', to: 'run store', label: 'put(tenant, idem_key, run)', kind: 'sync'},
      {from: 'Training Scheduler', to: 'Redis queue', label: 'enqueue(run) at its band position', kind: 'async'},
      {from: 'Training Scheduler', to: 'Client', label: '201 {run_id, state: queued, band}', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Handles POST /v1/training/runs',
      detail: 'Register the submission route on `POST /v1/training/runs`.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/training\/runs["']/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/training\/runs['"]/]},
        go: {all: [/HandleFunc\(\s*"POST \/v1\/training\/runs"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"training"\s*\/\s*"runs"\s*\)/, /\bpost\s*\{/]},
        cpp: {all: [/svr\.Post\(\s*"\/v1\/training\/runs"/]},
      },
    },
    {
      id: 'priority-band',
      title: 'Clamps priority into the supported bands',
      detail:
        'Priority is clamped to `0..9` and mapped to one of 3 bands before the run is queued. The draft passes the caller’s integer straight through, so `999999` outranks every band.',
      match: {
        python: {
          all: [/PRIORITY_MIN/, /PRIORITY_MAX/, /PRIORITY_BANDS/, /def clamp_priority\(/, /def priority_band\(/],
        },
        typescript: {
          all: [
            /PRIORITY_MIN/,
            /PRIORITY_MAX/,
            /PRIORITY_BANDS/,
            /function clampPriority\(/,
            /function priorityBand\(/,
          ],
        },
        go: {all: [/priorityMin/, /priorityMax/, /priorityBands/, /func clampPriority\(/, /func priorityBand\(/]},
        scala: {all: [/PriorityMin/, /PriorityMax/, /PriorityBands/, /def clampPriority\(/, /def priorityBand\(/]},
        cpp: {all: [/kPriorityMin/, /kPriorityMax/, /kPriorityBands/, /clampPriority\(/, /priorityBand\(/]},
      },
    },
    {
      id: 'idempotency',
      title: 'A replay of (tenant, Idempotency-Key) returns the original run',
      detail:
        '`Idempotency-Key` is required and the run is stored under `(tenant, key)`: a retry returns the stored run instead of queueing a second one. The draft ignores the header entirely.',
      match: {
        python: {all: [/Idempotency-Key/, /runs\.get\(/, /runs\.put\(/]},
        typescript: {all: [/idempotency-key/, /runs\.get\(/, /runs\.put\(/]},
        go: {all: [/Idempotency-Key/, /runs\.Get\(/, /runs\.Put\(/]},
        scala: {all: [/Idempotency-Key/, /runs\.get\(/, /runs\.put\(/]},
        cpp: {all: [/Idempotency-Key/, /runs\.get\(/, /runs\.put\(/]},
      },
    },
    {
      id: 'recipe-version',
      title: 'An unknown recipe version is 400 before the run is enqueued',
      detail:
        'The recipe version is checked against the registry and rejected with **400** before any queue write. The draft never looks the recipe up, so a typo consumes a GPU slot.',
      match: {
        python: {all: [/KNOWN_RECIPES/, /HTTPException\(status_code=400/], order: [/KNOWN_RECIPES/, /enqueue\(/]},
        typescript: {all: [/KNOWN_RECIPES/, /code\(400\)/], order: [/KNOWN_RECIPES/, /enqueue\(/]},
        go: {all: [/knownRecipes/, /StatusBadRequest/], order: [/knownRecipes/, /queue\.Enqueue\(/]},
        scala: {all: [/KnownRecipes/, /StatusCodes\.BadRequest/], order: [/KnownRecipes/, /queue\.enqueue\(/]},
        cpp: {all: [/kKnownRecipes/, /\b400\b/], order: [/kKnownRecipes/, /queue\.enqueue\(/]},
      },
    },
    {
      id: 'durable-run',
      title: 'The scheduler issues the run id and persists the run before answering',
      detail:
        'The run id is a scheduler-issued UUID, written to the run store under `(tenant, key)` before the response, so a restart replays the submission rather than losing it. The draft mints a counter-based id and stores nothing.',
      match: {
        python: {all: [/uuid\.uuid4\(\)/, /runs\.put\(/, /run_id/]},
        typescript: {all: [/randomUUID\(\)/, /runs\.put\(/, /run_id/]},
        go: {all: [/uuid\.NewString\(\)/, /runs\.Put\(/, /run_id/]},
        scala: {all: [/UUID\.randomUUID\(\)/, /runs\.put\(/, /run_id/]},
        cpp: {all: [/uuidString\(\)/, /runs\.put\(/, /run_id/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import itertools
import logging

from fastapi import FastAPI, Header
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()
logger = logging.getLogger("trainsched")

run_counter = itertools.count(1)


class SubmitRequest(BaseModel):
    dataset_version: str
    recipe_version: str
    priority: int = 5


class RunStore:
    def __init__(self) -> None:
        self._by_key: dict[tuple[str, str], dict] = {}

    def get(self, tenant: str, idem_key: str) -> dict | None:
        """The run stored for (tenant, Idempotency-Key), if any."""
        raise NotImplementedError

    def put(self, tenant: str, idem_key: str, run: dict) -> None:
        """Persist the run under (tenant, Idempotency-Key)."""
        raise NotImplementedError


runs = RunStore()


@app.post("/v1/training/runs")
def submit(body: SubmitRequest, tenant: str = Header(alias="X-Tenant-Id")) -> JSONResponse:
    # TODO: this draft takes the caller's priority unchanged, ignores Idempotency-Key, never
    # checks the recipe version against the registry, and mints a new run id on every retry.
    # Review all four before a run is allowed to reach a GPU.
    run_id = f"run-{next(run_counter)}"
    logger.info("run queued run_id=%s tenant=%s priority=%d", run_id, tenant, body.priority)
    return JSONResponse(
        {"run_id": run_id, "state": "queued", "priority": body.priority},
        status_code=201,
    )
`,
      solution: `import logging
import uuid

from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()
logger = logging.getLogger("trainsched")

PRIORITY_MIN = 0
PRIORITY_MAX = 9
PRIORITY_BANDS = 3
HIGH_PRIORITY_MIN = 7
NORMAL_PRIORITY_MIN = 3
MAX_VERSION_LEN = 128
KNOWN_RECIPES = {"recipe-transformer-v1", "recipe-diffusion-v2", "recipe-embed-v3"}


class SubmitRequest(BaseModel):
    dataset_version: str
    recipe_version: str
    priority: int = 5


class RunStore:
    def get(self, tenant: str, idem_key: str) -> dict | None:
        """The run stored for (tenant, Idempotency-Key), if any."""
        raise NotImplementedError

    def put(self, tenant: str, idem_key: str, run: dict) -> None:
        """Persist the run under (tenant, Idempotency-Key)."""
        raise NotImplementedError


class RunQueue:
    def enqueue(self, run: dict) -> None:
        """Add the run to the Redis queue at its band's position."""
        raise NotImplementedError


runs = RunStore()
queue = RunQueue()


def clamp_priority(priority: int) -> int:
    return min(max(priority, PRIORITY_MIN), PRIORITY_MAX)


def priority_band(priority: int) -> int:
    clamped = clamp_priority(priority)
    if clamped >= HIGH_PRIORITY_MIN:
        return 0
    if clamped >= NORMAL_PRIORITY_MIN:
        return 1
    return 2


def version_ok(value: str) -> bool:
    return isinstance(value, str) and 0 < len(value) <= MAX_VERSION_LEN


@app.post("/v1/training/runs")
def submit(
    body: SubmitRequest,
    tenant: str | None = Header(default=None, alias="X-Tenant-Id"),
    idem_key: str | None = Header(default=None, alias="Idempotency-Key"),
) -> JSONResponse:
    if tenant is None or tenant == "":
        raise HTTPException(status_code=401, detail="missing X-Tenant-Id")
    if idem_key is None or idem_key == "":
        raise HTTPException(status_code=400, detail="Idempotency-Key is required")
    if not version_ok(body.dataset_version):
        raise HTTPException(status_code=400, detail="dataset_version must be 1..128 chars")
    if body.recipe_version not in KNOWN_RECIPES:
        raise HTTPException(status_code=400, detail="unknown recipe version")

    stored = runs.get(tenant, idem_key)
    if stored is not None:
        return JSONResponse(stored, status_code=200)

    priority = clamp_priority(body.priority)
    run = {
        "run_id": str(uuid.uuid4()),
        "tenant": tenant,
        "state": "queued",
        "priority": priority,
        "band": priority_band(priority),
        "recipe_version": body.recipe_version,
        "dataset_version": body.dataset_version,
    }
    runs.put(tenant, idem_key, run)
    queue.enqueue(run)
    logger.info("run queued run_id=%s tenant=%s band=%d", run["run_id"], tenant, run["band"])
    return JSONResponse(run, status_code=201)
`,
    },
    typescript: {
      starter: `/** POST /v1/training/runs: a model-generated draft that queues anything it is given. */
import Fastify from 'fastify';

export const app = Fastify();

let runCounter = 0;

interface SubmitBody {
  dataset_version: string;
  recipe_version: string;
  priority?: number;
}

app.post('/v1/training/runs', async (request, reply) => {
  // TODO: this draft takes the caller's priority unchanged, ignores Idempotency-Key, never checks
  // the recipe version against the registry, and mints a new run id on every retry. Review all four.
  const tenant = request.headers['x-tenant-id'] as string;
  const body = request.body as SubmitBody;
  const runId = \`run-\${++runCounter}\`;
  request.log.info({runId, tenant, priority: body.priority ?? 5}, 'run queued');
  return reply.code(201).send({run_id: runId, state: 'queued', priority: body.priority ?? 5});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** POST /v1/training/runs: admitted, clamped and idempotent submissions. */
import {randomUUID} from 'node:crypto';

import Fastify from 'fastify';

export const app = Fastify();

const PRIORITY_MIN = 0;
const PRIORITY_MAX = 9;
const PRIORITY_BANDS = 3;
const HIGH_PRIORITY_MIN = 7;
const NORMAL_PRIORITY_MIN = 3;
const MAX_VERSION_LEN = 128;
const KNOWN_RECIPES: Record<string, true> = {
  'recipe-transformer-v1': true,
  'recipe-diffusion-v2': true,
  'recipe-embed-v3': true,
};

interface SubmitBody {
  dataset_version: string;
  recipe_version: string;
  priority?: number;
}

interface Run {
  run_id: string;
  tenant: string;
  state: string;
  priority: number;
  band: number;
  recipe_version: string;
  dataset_version: string;
}

/** The run store and the queue are the platform's; this step only calls them. */
class RunStore {
  async get(tenant: string, idemKey: string): Promise<Run | null> {
    throw new Error('provided by the platform');
  }

  async put(tenant: string, idemKey: string, run: Run): Promise<void> {
    throw new Error('provided by the platform');
  }
}

class RunQueue {
  async enqueue(run: Run): Promise<void> {
    throw new Error('provided by the platform');
  }
}

const runs = new RunStore();
const queue = new RunQueue();

function clampPriority(priority: number): number {
  return Math.min(Math.max(priority, PRIORITY_MIN), PRIORITY_MAX);
}

function priorityBand(priority: number): number {
  const clamped = clampPriority(priority);
  if (clamped >= HIGH_PRIORITY_MIN) return 0;
  if (clamped >= NORMAL_PRIORITY_MIN) return 1;
  return 2;
}

const versionOk = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= MAX_VERSION_LEN;

app.post('/v1/training/runs', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing X-Tenant-Id'});
  const idemKey = request.headers['idempotency-key'];
  if (typeof idemKey !== 'string' || idemKey === '')
    return reply.code(400).send({error: 'Idempotency-Key is required'});

  const body = request.body as Partial<SubmitBody> | null;
  if (body === null || typeof body !== 'object') return reply.code(400).send({error: 'invalid body'});
  if (!versionOk(body.dataset_version))
    return reply.code(400).send({error: 'dataset_version must be 1..128 chars'});
  const recipeVersion = body.recipe_version;
  if (typeof recipeVersion !== 'string' || KNOWN_RECIPES[recipeVersion] !== true)
    return reply.code(400).send({error: 'unknown recipe version'});

  const stored = await runs.get(tenant, idemKey);
  if (stored !== null) return reply.code(200).send(stored);

  const priority = clampPriority(Number.isInteger(body.priority) ? (body.priority as number) : 5);
  const run: Run = {
    run_id: randomUUID(),
    tenant,
    state: 'queued',
    priority,
    band: priorityBand(priority),
    recipe_version: recipeVersion,
    dataset_version: body.dataset_version as string,
  };
  await runs.put(tenant, idemKey, run);
  await queue.enqueue(run);
  request.log.info({run_id: run.run_id, tenant, band: run.band}, 'run queued');
  return reply.code(201).send(run);
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
)

var runCounter int

type SubmitRequest struct {
	DatasetVersion string \`json:"dataset_version"\`
	RecipeVersion  string \`json:"recipe_version"\`
	Priority       int    \`json:"priority"\`
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func submit(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	var body SubmitRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	// TODO: this draft takes the caller's priority unchanged, ignores Idempotency-Key, never checks
	// the recipe version against the registry, and mints a new run id on every retry.
	runCounter++
	runID := fmt.Sprintf("run-%d", runCounter)
	log.Printf("run queued run_id=%s tenant=%s priority=%d", runID, tenant, body.Priority)
	writeJSON(rw, http.StatusCreated, map[string]any{
		"run_id":   runID,
		"state":    "queued",
		"priority": body.Priority,
	})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/training/runs", submit)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
      solution: `package main

import (
	"encoding/json"
	"log"
	"net/http"

	"github.com/google/uuid"
)

const (
	priorityMin       = 0
	priorityMax       = 9
	priorityBands     = 3
	highPriorityMin   = 7
	normalPriorityMin = 3
	maxVersionLen     = 128
)

var knownRecipes = map[string]bool{
	"recipe-transformer-v1": true,
	"recipe-diffusion-v2":   true,
	"recipe-embed-v3":       true,
}

type SubmitRequest struct {
	DatasetVersion string \`json:"dataset_version"\`
	RecipeVersion  string \`json:"recipe_version"\`
	Priority       int    \`json:"priority"\`
}

// RunStore and RunQueue are the platform's; this step only calls them.
type RunStore struct{}

func (s *RunStore) Get(ctx context.Context, tenant, idemKey string) (map[string]any, error) {
	return nil, nil
}

func (s *RunStore) Put(ctx context.Context, tenant, idemKey string, run map[string]any) error {
	return nil
}

type RunQueue struct{}

func (q *RunQueue) Enqueue(ctx context.Context, run map[string]any) error {
	return nil
}

var (
	runs  = &RunStore{}
	queue = &RunQueue{}
)

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func clampPriority(priority int) int {
	if priority < priorityMin {
		return priorityMin
	}
	if priority > priorityMax {
		return priorityMax
	}
	return priority
}

func priorityBand(priority int) int {
	clamped := clampPriority(priority)
	switch {
	case clamped >= highPriorityMin:
		return 0
	case clamped >= normalPriorityMin:
		return 1
	default:
		return priorityBands - 1
	}
}

func submit(rw http.ResponseWriter, r *http.Request) {
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
	var body SubmitRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	if len(body.DatasetVersion) == 0 || len(body.DatasetVersion) > maxVersionLen {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "dataset_version must be 1..128 chars"})
		return
	}
	if !knownRecipes[body.RecipeVersion] {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "unknown recipe version"})
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
	priority := clampPriority(body.Priority)
	run := map[string]any{
		"run_id":          uuid.NewString(),
		"tenant":          tenant,
		"state":           "queued",
		"priority":        priority,
		"band":            priorityBand(priority),
		"recipe_version":  body.RecipeVersion,
		"dataset_version": body.DatasetVersion,
	}
	if err := runs.Put(r.Context(), tenant, idemKey, run); err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	if err := queue.Enqueue(r.Context(), run); err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	log.Printf("run queued run_id=%s tenant=%s band=%d", run["run_id"], tenant, run["band"])
	writeJSON(rw, http.StatusCreated, run)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/training/runs", submit)
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

final case class SubmitRequest(dataset_version: String, recipe_version: String, priority: Int)

object TrainingApi {
  implicit val system: ActorSystem = ActorSystem("trainsched")
  implicit val submitFormat: RootJsonFormat[SubmitRequest] = jsonFormat3(SubmitRequest)

  private var runCounter = 0

  val route: Route =
    path("v1" / "training" / "runs") {
      post {
        entity(as[SubmitRequest]) { body =>
          // TODO: this draft takes the caller's priority unchanged, ignores Idempotency-Key, never
          // checks the recipe version against the registry, and mints a new run id on every retry.
          runCounter += 1
          val runId = s"run-$runCounter"
          system.log.info(s"run queued run_id=$runId priority=\${body.priority}")
          complete(StatusCodes.Created, s"""{"run_id":"$runId","state":"queued","priority":\${body.priority}}""")
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

final case class SubmitRequest(dataset_version: String, recipe_version: String, priority: Int)
final case class Run(
    run_id: String,
    tenant: String,
    state: String,
    priority: Int,
    band: Int,
    recipe_version: String,
    dataset_version: String,
)

// The run store and the queue are the platform's; this step only calls them.
final class RunStore {
  def get(tenant: String, idemKey: String): Option[Run] = ???
  def put(tenant: String, idemKey: String, run: Run): Unit = ???
}

object RunStore {
  def open(): RunStore = new RunStore
}

final class RunQueue {
  def enqueue(run: Run): Unit = ???
}

object TrainingApi {
  implicit val system: ActorSystem = ActorSystem("trainsched")
  implicit val submitFormat: RootJsonFormat[SubmitRequest] = jsonFormat3(SubmitRequest)
  implicit val runFormat: RootJsonFormat[Run] = jsonFormat7(Run)

  val PriorityMin = 0
  val PriorityMax = 9
  val PriorityBands = 3
  val HighPriorityMin = 7
  val NormalPriorityMin = 3
  val MaxVersionLen = 128
  val KnownRecipes = Set("recipe-transformer-v1", "recipe-diffusion-v2", "recipe-embed-v3")

  val runs = RunStore.open()
  val queue = new RunQueue

  def clampPriority(priority: Int): Int = math.max(PriorityMin, math.min(PriorityMax, priority))

  def priorityBand(priority: Int): Int = {
    val clamped = clampPriority(priority)
    if (clamped >= HighPriorityMin) 0
    else if (clamped >= NormalPriorityMin) 1
    else PriorityBands - 1
  }

  private def versionOk(value: String): Boolean =
    value.nonEmpty && value.getBytes(StandardCharsets.UTF_8).length <= MaxVersionLen

  val route: Route =
    path("v1" / "training" / "runs") {
      post {
        optionalHeaderValueByName("X-Tenant-Id") { tenantOpt =>
          optionalHeaderValueByName("Idempotency-Key") { idemOpt =>
            entity(as[SubmitRequest]) { body =>
              if (!tenantOpt.exists(_.nonEmpty)) {
                complete(StatusCodes.Unauthorized, """{"error":"missing X-Tenant-Id"}""")
              } else if (!idemOpt.exists(_.nonEmpty)) {
                complete(StatusCodes.BadRequest, """{"error":"Idempotency-Key is required"}""")
              } else if (!versionOk(body.dataset_version)) {
                complete(StatusCodes.BadRequest, """{"error":"dataset_version must be 1..128 chars"}""")
              } else if (!KnownRecipes.contains(body.recipe_version)) {
                complete(StatusCodes.BadRequest, """{"error":"unknown recipe version"}""")
              } else {
                val tenant = tenantOpt.get
                val idemKey = idemOpt.get
                runs.get(tenant, idemKey) match {
                  case Some(stored) =>
                    complete(StatusCodes.OK, stored)
                  case None =>
                    val priority = clampPriority(body.priority)
                    val run = Run(
                      UUID.randomUUID().toString,
                      tenant,
                      "queued",
                      priority,
                      priorityBand(priority),
                      body.recipe_version,
                      body.dataset_version,
                    )
                    runs.put(tenant, idemKey, run)
                    queue.enqueue(run)
                    system.log.info(s"run queued run_id=\${run.run_id} tenant=$tenant band=\${run.band}")
                    complete(StatusCodes.Created, run)
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

using json = nlohmann::json;

int main() {
  httplib::Server svr;

  svr.Post("/v1/training/runs", [](const httplib::Request& req, httplib::Response& res) {
    const auto tenant = req.get_header_value("X-Tenant-Id");
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) {
      res.status = 400;
      res.set_content(R"({"error":"invalid json"})", "application/json");
      return;
    }
    // TODO: this draft takes the caller's priority unchanged, ignores Idempotency-Key, never
    // checks the recipe version against the registry, and mints a new run id on every retry.
    static int runCounter = 0;
    const auto runId = "run-" + std::to_string(++runCounter);
    const int priority = body.value("priority", 5);
    std::cerr << "run queued run_id=" << runId << " tenant=" << tenant << " priority=" << priority << "\\n";
    res.status = 201;
    res.set_content(json{{"run_id", runId}, {"state", "queued"}, {"priority", priority}}.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <iostream>
#include <optional>
#include <set>
#include <string>

using json = nlohmann::json;

constexpr int kPriorityMin = 0;
constexpr int kPriorityMax = 9;
constexpr int kPriorityBands = 3;
constexpr int kHighPriorityMin = 7;
constexpr int kNormalPriorityMin = 3;
constexpr std::size_t kMaxVersionLen = 128;
const std::set<std::string> kKnownRecipes = {"recipe-transformer-v1", "recipe-diffusion-v2", "recipe-embed-v3"};

// The run store and the queue are the platform's; this step only calls them.
struct RunStore {
  std::optional<json> get(const std::string& tenant, const std::string& idemKey);
  void put(const std::string& tenant, const std::string& idemKey, const json& run);
};

struct RunQueue {
  void enqueue(const json& run);
};

RunStore runs;
RunQueue queue;
std::string uuidString();

int clampPriority(int priority) {
  if (priority < kPriorityMin) return kPriorityMin;
  if (priority > kPriorityMax) return kPriorityMax;
  return priority;
}

int priorityBand(int priority) {
  const int clamped = clampPriority(priority);
  if (clamped >= kHighPriorityMin) return 0;
  if (clamped >= kNormalPriorityMin) return 1;
  return kPriorityBands - 1;
}

int main() {
  httplib::Server svr;

  svr.Post("/v1/training/runs", [](const httplib::Request& req, httplib::Response& res) {
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
    const auto datasetVersion = body.value("dataset_version", std::string());
    if (datasetVersion.empty() || datasetVersion.size() > kMaxVersionLen) {
      res.status = 400;
      res.set_content(R"({"error":"dataset_version must be 1..128 chars"})", "application/json");
      return;
    }
    const auto recipeVersion = body.value("recipe_version", std::string());
    if (kKnownRecipes.count(recipeVersion) == 0) {
      res.status = 400;
      res.set_content(R"({"error":"unknown recipe version"})", "application/json");
      return;
    }
    const auto stored = runs.get(tenant, idemKey);
    if (stored) {
      res.status = 200;
      res.set_content(stored->dump(), "application/json");
      return;
    }
    const int priority = clampPriority(body.value("priority", 5));
    const json run = {
        {"run_id", uuidString()},
        {"tenant", tenant},
        {"state", "queued"},
        {"priority", priority},
        {"band", priorityBand(priority)},
        {"recipe_version", recipeVersion},
        {"dataset_version", datasetVersion},
    };
    runs.put(tenant, idemKey, run);
    queue.enqueue(run);
    std::cerr << "run queued run_id=" << run["run_id"] << " tenant=" << tenant << " band=" << run["band"] << "\\n";
    res.status = 201;
    res.set_content(run.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  hints: [
    'Order the guard clauses by cost: tenant, Idempotency-Key, the shape of the versions, and only then the recipe registry lookup. Every one of them answers before `runs.save` and `queue.enqueue`, so a rejected submission never occupies a queue position.',
    'Clamp, then band — never band the raw integer. `min(max(priority, PRIORITY_MIN), PRIORITY_MAX)` is what keeps a caller-provided `999999` inside the same three bands as everyone else, and the band is what the queue orders by.',
    'Idempotency is keyed by `(tenant, Idempotency-Key)` and stores the **run**, not the request: the replay has to return the original `run_id` and the original band, which is only possible if the scheduler issued and persisted the id before it answered.',
  ],
  debrief: `The interviewer is testing whether you can review a generated handler at the admission boundary. The
draft reads fine because the demo submits a valid recipe from one tenant and never retries. Four
defects are being checked: authentication of the tenant, the recipe-registry lookup that must happen
before a GPU is reserved, the clamp that keeps priority inside supported bands (a starvation problem
when it is missing, a fairness problem when it is added carelessly), and idempotency keyed by tenant
so a client timeout cannot start a second training run. The fifth habit is the durable id: the
scheduler issues it and writes the run down before answering, which is what makes "the submit
survived a restart" a true statement rather than a hope. Real schedulers add per-tenant quotas, a
submission rate limit, and a run-request audit row per accepted submission.`,
};
