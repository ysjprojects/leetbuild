import type {Step} from '@/lib/types';

export const endpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/agent/runs: start a bounded run',
  concept: 'http',
  file: 'api',
  focus: ['client', 'api', 'redis', 'catalog'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it registers the route, decodes
the body, mints a run id and answers 202. It compiles, it serves the demo, and it hides four
production flaws. Review it like the service owner, fix it, and prove the fix with the checks below.

Implement \`POST /v1/agent/runs\` with body
\`{"task": "…", "tools": ["search", "fetch_url"], "max_steps": 12}\`.

- The tenant comes from the authenticated \`X-Tenant-Id\` header; a missing tenant is **401**.
- \`task\` is a non-empty string of at most **8 KiB** (\`8 << 10\` bytes of UTF-8); anything larger is
  **413**.
- \`tools\` is an allowlist, not a wish list: every name must be served by the server's tool catalog,
  and a request naming a tool the server does not serve is **400** *before* any run exists.
- \`max_steps\` is required and must be an integer from **1** to **40**; omitted or out of range is
  **400**. A budget that defaults to "unlimited" is how one task runs until someone notices the bill.
- \`Idempotency-Key\` is required (**400** when missing). A retry with the same \`(tenant, key)\`
  returns the stored run instead of starting a second one — one task, one run.
- Log the start with tenant, run id, step budget and tool count — never the task text.

**Failure mode the checks target.** The draft accepts whatever tool names arrive, so a caller can
hand the agent \`charge_card\` on a run that was only supposed to search; it treats an omitted
\`max_steps\` as unlimited, so the step loop has no ceiling to hit; it never re-reads
\`Idempotency-Key\`, so a client retrying a start request duplicates the whole run; and it validates
nothing about the task, so 50 MiB of prose reaches the model and the log pipeline.`,
  sequence: {
    participants: ['Client', 'Run API', 'Run state', 'tool catalog'],
    messages: [
      {from: 'Client', to: 'Run API', label: 'POST /v1/agent/runs · X-Tenant-Id · Idempotency-Key', kind: 'sync'},
      {from: 'Run API', to: 'tool catalog', label: 'every requested tool is served?', kind: 'sync'},
      {from: 'tool catalog', to: 'Run API', label: 'catalog entry or unknown', kind: 'reply'},
      {from: 'Run API', to: 'Run state', label: 'get(tenant, idem_key)', kind: 'sync'},
      {from: 'Run state', to: 'Run API', label: 'stored run / none', kind: 'reply'},
      {from: 'Run API', to: 'Run state', label: 'put(tenant, idem_key, run)', kind: 'async'},
      {from: 'Run API', to: 'Client', label: '202 {run_id, status, budget}', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Handles POST /v1/agent/runs',
      detail: 'Register the run-start route on `POST /v1/agent/runs`.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/agent\/runs["']/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/agent\/runs['"]/]},
        go: {all: [/HandleFunc\(\s*"POST \/v1\/agent\/runs"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"agent"\s*\/\s*"runs"\s*\)/, /\bpost\s*\{/]},
        cpp: {all: [/svr\.Post\(\s*"\/v1\/agent\/runs"/]},
      },
    },
    {
      id: 'task-cap',
      title: 'Caps the task at 8 KiB',
      detail:
        'A task over `8 << 10` UTF-8 bytes is **413**, and an empty task is **400**. The draft streams whatever arrives to the model and the log, so one request carries unbounded tenant content into every downstream sink.',
      match: {
        python: {all: [/MAX_TASK_BYTES/, /status_code\s*=\s*413/]},
        typescript: {all: [/MAX_TASK_BYTES/, /code\(\s*413\s*\)/]},
        go: {all: [/maxTaskBytes/, /StatusRequestEntityTooLarge/]},
        scala: {all: [/MaxTaskBytes/, /StatusCodes\.RequestEntityTooLarge/]},
        cpp: {all: [/kMaxTaskBytes/, /\b413\b/]},
      },
    },
    {
      id: 'allowlist',
      title: 'Rejects tools the catalog does not serve',
      detail:
        'Every name in `tools` is checked against the server catalog and an unknown one is **400** before the run is created. The draft forwards the caller’s list untouched, so the agent gets whatever capability the caller names — including side-effecting tools it was never granted.',
      match: {
        python: {all: [/TOOL_CATALOG/, /status_code\s*=\s*400/]},
        typescript: {all: [/TOOL_CATALOG/, /code\(\s*400\s*\)/]},
        go: {all: [/toolCatalog/, /StatusBadRequest/]},
        scala: {all: [/ToolCatalog/, /StatusCodes\.BadRequest/]},
        cpp: {all: [/kToolCatalog/, /\b400\b/]},
      },
    },
    {
      id: 'budget',
      title: 'Requires a step budget from 1 to 40',
      detail:
        '`max_steps` is mandatory and must be in `1..40`; omitted or out of range is **400**. The draft lets an omitted budget run unlimited, which is the difference between a bounded agent and an open-ended spend.',
      match: {
        python: {all: [/MIN_STEPS/, /MAX_STEPS/, /status_code\s*=\s*400/]},
        typescript: {all: [/MIN_STEPS/, /MAX_STEPS/, /code\(\s*400\s*\)/]},
        go: {all: [/minSteps/, /maxSteps/, /StatusBadRequest/]},
        scala: {all: [/MinSteps/, /MaxSteps/, /StatusCodes\.BadRequest/]},
        cpp: {all: [/kMinSteps/, /kMaxSteps/, /\b400\b/]},
      },
    },
    {
      id: 'idempotency-key',
      title: 'Keys retries by (tenant, Idempotency-Key)',
      detail:
        '`Idempotency-Key` is required and the run is stored under `(tenant, key)`; a replay returns the stored run with 200 instead of starting a second. The draft ignores the header, so every client retry spawns a duplicate run that spends its own budget.',
      match: {
        python: {all: [/Idempotency-Key/, /store\.get\(/, /store\.put\(/]},
        typescript: {all: [/idempotency-key/, /store\.get\(/, /store\.put\(/]},
        go: {all: [/Idempotency-Key/, /store\.Get\(/, /store\.Put\(/]},
        scala: {all: [/Idempotency-Key/, /store\.get\(/, /store\.put\(/]},
        cpp: {all: [/Idempotency-Key/, /store\.get\(/, /store\.put\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import logging
import uuid

from fastapi import FastAPI, Header
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()
logger = logging.getLogger("orchestrator")


class RunRequest(BaseModel):
    task: str
    tools: list[str] = []
    max_steps: int | None = None


class RunStore:
    def get(self, tenant: str, idem_key: str) -> dict | None:
        """The run stored for (tenant, idem_key), if any."""
        raise NotImplementedError

    def put(self, tenant: str, idem_key: str, run: dict) -> None:
        """Store the run under (tenant, idem_key)."""
        raise NotImplementedError


store = RunStore()


@app.post("/v1/agent/runs")
def start_run(body: RunRequest, tenant: str = Header(alias="X-Tenant-Id")) -> JSONResponse:
    # TODO: the draft forwards the caller's tool list unvalidated, treats an omitted budget as
    # unlimited, caps nothing about the task, and starts a fresh run on every retry. Review all four.
    run = {"run_id": str(uuid.uuid4()), "status": "pending", "max_steps": body.max_steps}
    logger.info("run start tenant=%s run=%s task=%r", tenant, run["run_id"], body.task)
    return JSONResponse(run, status_code=202)
`,
      solution: `import logging
import uuid

from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()
logger = logging.getLogger("orchestrator")

MAX_TASK_BYTES = 8 << 10
MIN_STEPS = 1
MAX_STEPS = 40
TOOL_CATALOG = frozenset({"search", "fetch_url", "run_sql", "send_email", "charge_card"})


class RunRequest(BaseModel):
    task: str
    tools: list[str] = []
    max_steps: int | None = None


class RunStore:
    def get(self, tenant: str, idem_key: str) -> dict | None:
        """The run stored for (tenant, idem_key), if any."""
        raise NotImplementedError

    def put(self, tenant: str, idem_key: str, run: dict) -> None:
        """Store the run under (tenant, idem_key)."""
        raise NotImplementedError


store = RunStore()


@app.post("/v1/agent/runs")
def start_run(
    body: RunRequest,
    tenant: str | None = Header(default=None, alias="X-Tenant-Id"),
    idem_key: str | None = Header(default=None, alias="Idempotency-Key"),
) -> JSONResponse:
    if tenant is None or tenant == "":
        raise HTTPException(status_code=401, detail="missing X-Tenant-Id")
    if idem_key is None or idem_key == "":
        raise HTTPException(status_code=400, detail="Idempotency-Key is required")
    if body.task == "":
        raise HTTPException(status_code=400, detail="task must be a non-empty string")
    if len(body.task.encode("utf-8")) > MAX_TASK_BYTES:
        raise HTTPException(status_code=413, detail="task exceeds 8 KiB")
    tools = sorted(set(body.tools))
    unknown = [name for name in tools if name not in TOOL_CATALOG]
    if unknown:
        raise HTTPException(status_code=400, detail=f"unknown tools: {', '.join(unknown)}")
    if body.max_steps is None:
        raise HTTPException(status_code=400, detail="max_steps is required")
    if not MIN_STEPS <= body.max_steps <= MAX_STEPS:
        raise HTTPException(status_code=400, detail="max_steps must be 1..40")

    stored = store.get(tenant, idem_key)
    if stored is not None:
        return JSONResponse(stored, status_code=200)

    run = {
        "run_id": str(uuid.uuid4()),
        "status": "pending",
        "max_steps": body.max_steps,
        "steps_used": 0,
        "tools": tools,
    }
    store.put(tenant, idem_key, run)
    logger.info(
        "run start tenant=%s run=%s steps=%d tools=%d", tenant, run["run_id"], body.max_steps, len(tools)
    )
    return JSONResponse(run, status_code=202)
`,
    },
    typescript: {
      starter: `/** POST /v1/agent/runs: a model-generated draft that trusts the caller's tool list. */
import {randomUUID} from 'node:crypto';

import Fastify from 'fastify';

export const app = Fastify();

interface RunBody {
  task: string;
  tools?: string[];
  max_steps?: number;
}

app.post('/v1/agent/runs', async (request, reply) => {
  // TODO: the draft forwards the caller's tool list unvalidated, treats an omitted budget as
  // unlimited, caps nothing about the task, and starts a fresh run on every retry. Review all four.
  const tenant = request.headers['x-tenant-id'] as string;
  const body = request.body as RunBody;
  const run = {run_id: randomUUID(), status: 'pending', max_steps: body.max_steps, tools: body.tools ?? []};
  request.log.info({tenant, run_id: run.run_id, task: body.task}, 'run started');
  return reply.code(202).send(run);
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** POST /v1/agent/runs: validated, allowlisted and idempotent run starts. */
import {randomUUID} from 'node:crypto';

import Fastify from 'fastify';

import {store} from './state';

export const app = Fastify();

const MAX_TASK_BYTES = 8 << 10;
const MIN_STEPS = 1;
const MAX_STEPS = 40;
const TOOL_CATALOG: Record<string, true> = {
  search: true,
  fetch_url: true,
  run_sql: true,
  send_email: true,
  charge_card: true,
};

interface RunBody {
  task: string;
  tools?: string[];
  max_steps?: number;
}

interface Run {
  run_id: string;
  status: string;
  max_steps: number;
  steps_used: number;
  tools: string[];
}

app.post('/v1/agent/runs', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing X-Tenant-Id'});
  const idemKey = request.headers['idempotency-key'];
  if (typeof idemKey !== 'string' || idemKey === '')
    return reply.code(400).send({error: 'Idempotency-Key is required'});

  const body = request.body as Partial<RunBody> | null;
  if (body === null || typeof body !== 'object' || typeof body.task !== 'string' || body.task === '')
    return reply.code(400).send({error: 'task must be a non-empty string'});
  if (Buffer.byteLength(body.task, 'utf8') > MAX_TASK_BYTES)
    return reply.code(413).send({error: 'task exceeds 8 KiB'});

  const tools = [...new Set(body.tools ?? [])].sort();
  const unknown = tools.filter(name => TOOL_CATALOG[name] !== true);
  if (unknown.length > 0) return reply.code(400).send({error: \`unknown tools: \${unknown.join(', ')}\`});

  const maxSteps = body.max_steps;
  if (maxSteps === undefined) return reply.code(400).send({error: 'max_steps is required'});
  if (!Number.isInteger(maxSteps) || maxSteps < MIN_STEPS || maxSteps > MAX_STEPS)
    return reply.code(400).send({error: 'max_steps must be 1..40'});

  const stored: Run | null = await store.get(tenant, idemKey);
  if (stored !== null) return reply.code(200).send(stored);

  const run: Run = {run_id: randomUUID(), status: 'pending', max_steps: maxSteps, steps_used: 0, tools};
  await store.put(tenant, idemKey, run);
  request.log.info({tenant, run_id: run.run_id, max_steps: maxSteps, tools: tools.length}, 'run started');
  return reply.code(202).send(run);
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

type RunRequest struct {
	Task     string   \`json:"task"\`
	Tools    []string \`json:"tools"\`
	MaxSteps int      \`json:"max_steps"\`
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func startRun(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	var body RunRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	// TODO: the draft forwards the caller's tool list unvalidated, treats an omitted budget as
	// unlimited, caps nothing about the task, and starts a fresh run on every retry. Review all four.
	run := map[string]any{"run_id": uuid.NewString(), "status": "pending", "max_steps": body.MaxSteps, "tools": body.Tools}
	log.Printf("run start tenant=%s run=%s task=%q", tenant, run["run_id"], body.Task)
	writeJSON(rw, http.StatusAccepted, run)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/agent/runs", startRun)
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
	maxTaskBytes = 8 << 10
	minSteps     = 1
	maxSteps     = 40
)

var toolCatalog = map[string]bool{
	"search":      true,
	"fetch_url":   true,
	"run_sql":     true,
	"send_email":  true,
	"charge_card": true,
}

type RunRequest struct {
	Task     string   \`json:"task"\`
	Tools    []string \`json:"tools"\`
	MaxSteps int      \`json:"max_steps"\`
}

type Run struct {
	RunID     string   \`json:"run_id"\`
	Status    string   \`json:"status"\`
	MaxSteps  int      \`json:"max_steps"\`
	StepsUsed int      \`json:"steps_used"\`
	Tools     []string \`json:"tools"\`
}

type RunStore struct{}

func (s *RunStore) Get(ctx context.Context, tenant, idemKey string) (*Run, error) {
	return nil, nil
}

func (s *RunStore) Put(ctx context.Context, tenant, idemKey string, run *Run) error {
	return nil
}

var store = &RunStore{}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func unique(names []string) []string {
	seen := map[string]bool{}
	out := make([]string, 0, len(names))
	for _, name := range names {
		if !seen[name] {
			seen[name] = true
			out = append(out, name)
		}
	}
	return out
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
	if body.Task == "" {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "task must be a non-empty string"})
		return
	}
	if len([]byte(body.Task)) > maxTaskBytes {
		writeJSON(rw, http.StatusRequestEntityTooLarge, map[string]string{"error": "task exceeds 8 KiB"})
		return
	}
	tools := unique(body.Tools)
	for _, name := range tools {
		if !toolCatalog[name] {
			writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "unknown tool " + name})
			return
		}
	}
	if body.MaxSteps < minSteps || body.MaxSteps > maxSteps {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "max_steps must be 1..40"})
		return
	}

	stored, err := store.Get(r.Context(), tenant, idemKey)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	if stored != nil {
		writeJSON(rw, http.StatusOK, stored)
		return
	}
	run := &Run{RunID: uuid.NewString(), Status: "pending", MaxSteps: body.MaxSteps, StepsUsed: 0, Tools: tools}
	if err := store.Put(r.Context(), tenant, idemKey, run); err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	log.Printf("run start tenant=%s run=%s steps=%d tools=%d", tenant, run.RunID, run.MaxSteps, len(tools))
	writeJSON(rw, http.StatusAccepted, run)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/agent/runs", startRun)
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

import java.util.UUID

final case class RunRequest(task: String, tools: List[String] = List.empty, max_steps: Option[Int] = None)
final case class Run(run_id: String, status: String, max_steps: Option[Int], tools: List[String])

object Api {
  implicit val system: ActorSystem = ActorSystem("agent-orchestrator")
  implicit val runRequestFormat: RootJsonFormat[RunRequest] = jsonFormat3(RunRequest)
  implicit val runFormat: RootJsonFormat[Run] = jsonFormat4(Run)

  val store = RunStore.open()

  val route: Route =
    path("v1" / "agent" / "runs") {
      post {
        headerValueByName("X-Tenant-Id") { tenant =>
          entity(as[RunRequest]) { body =>
            // TODO: the draft forwards the caller's tool list unvalidated, treats an omitted budget
            // as unlimited, caps nothing about the task, and starts a fresh run on every retry.
            val run = Run(UUID.randomUUID().toString, "pending", body.max_steps, body.tools)
            system.log.info(s"run start tenant=$tenant run=\${run.run_id} task=\${body.task}")
            complete(StatusCodes.Accepted, run)
          }
        }
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
import org.apache.pekko.http.scaladsl.model.StatusCodes
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

import java.nio.charset.StandardCharsets
import java.util.UUID

final case class RunRequest(task: String, tools: List[String] = List.empty, max_steps: Option[Int] = None)
final case class Run(run_id: String, status: String, max_steps: Int, steps_used: Int, tools: List[String])

object Api {
  implicit val system: ActorSystem = ActorSystem("agent-orchestrator")
  implicit val runRequestFormat: RootJsonFormat[RunRequest] = jsonFormat3(RunRequest)
  implicit val runFormat: RootJsonFormat[Run] = jsonFormat5(Run)

  val MaxTaskBytes = 8 << 10
  val MinSteps = 1
  val MaxSteps = 40
  val ToolCatalog = Set("search", "fetch_url", "run_sql", "send_email", "charge_card")

  val store = RunStore.open()

  val route: Route =
    path("v1" / "agent" / "runs") {
      post {
        optionalHeaderValueByName("X-Tenant-Id") { tenantOpt =>
          optionalHeaderValueByName("Idempotency-Key") { idemOpt =>
            entity(as[RunRequest]) { body =>
              val tools = body.tools.distinct.sorted
              val unknown = tools.filterNot(ToolCatalog.contains)
              val steps = body.max_steps.filter(n => n >= MinSteps && n <= MaxSteps)
              if (!tenantOpt.exists(_.nonEmpty)) {
                complete(StatusCodes.Unauthorized, """{"error":"missing X-Tenant-Id"}""")
              } else if (!idemOpt.exists(_.nonEmpty)) {
                complete(StatusCodes.BadRequest, """{"error":"Idempotency-Key is required"}""")
              } else if (body.task.isEmpty) {
                complete(StatusCodes.BadRequest, """{"error":"task must be a non-empty string"}""")
              } else if (body.task.getBytes(StandardCharsets.UTF_8).length > MaxTaskBytes) {
                complete(StatusCodes.RequestEntityTooLarge, """{"error":"task exceeds 8 KiB"}""")
              } else if (unknown.nonEmpty) {
                complete(StatusCodes.BadRequest, s"""{"error":"unknown tools: \${unknown.mkString(", ")}"}""")
              } else if (steps.isEmpty) {
                complete(StatusCodes.BadRequest, """{"error":"max_steps must be 1..40"}""")
              } else {
                val tenant = tenantOpt.get
                val idemKey = idemOpt.get
                store.get(tenant, idemKey) match {
                  case Some(stored) =>
                    complete(StatusCodes.OK, stored)
                  case None =>
                    val run = Run(UUID.randomUUID().toString, "pending", steps.get, 0, tools)
                    store.put(tenant, idemKey, run)
                    system.log.info(
                      s"run start tenant=$tenant run=\${run.run_id} steps=\${run.max_steps} tools=\${tools.size}"
                    )
                    complete(StatusCodes.Accepted, run)
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

struct RunStore {
  std::optional<json> get(const std::string& tenant, const std::string& idemKey);
  void put(const std::string& tenant, const std::string& idemKey, const json& run);
};

RunStore store;
std::string uuidString();

int main() {
  httplib::Server svr;

  svr.Post("/v1/agent/runs", [](const httplib::Request& req, httplib::Response& res) {
    const auto tenant = req.get_header_value("X-Tenant-Id");
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) {
      res.status = 400;
      res.set_content(R"({"error":"invalid json"})", "application/json");
      return;
    }
    // TODO: the draft forwards the caller's tool list unvalidated, treats an omitted budget as
    // unlimited, caps nothing about the task, and starts a fresh run on every retry. Review all four.
    const json run = {
        {"run_id", uuidString()},
        {"status", "pending"},
        {"max_steps", body.value("max_steps", 0)},
        {"tools", body.value("tools", json::array())},
    };
    std::cerr << "run start tenant=" << tenant << " run=" << run["run_id"] << " task=" << body.value("task", "")
              << "\\n";
    res.status = 202;
    res.set_content(run.dump(), "application/json");
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
#include <vector>

using json = nlohmann::json;

constexpr std::size_t kMaxTaskBytes = 8 << 10;
constexpr int kMinSteps = 1;
constexpr int kMaxSteps = 40;
const std::set<std::string> kToolCatalog = {"search", "fetch_url", "run_sql", "send_email", "charge_card"};

struct RunStore {
  std::optional<json> get(const std::string& tenant, const std::string& idemKey);
  void put(const std::string& tenant, const std::string& idemKey, const json& run);
};

RunStore store;
std::string uuidString();

json error(const std::string& message) { return json{{"error", message}}; }

int main() {
  httplib::Server svr;

  svr.Post("/v1/agent/runs", [](const httplib::Request& req, httplib::Response& res) {
    const auto tenant = req.get_header_value("X-Tenant-Id");
    if (tenant.empty()) {
      res.status = 401;
      res.set_content(error("missing X-Tenant-Id").dump(), "application/json");
      return;
    }
    const auto idemKey = req.get_header_value("Idempotency-Key");
    if (idemKey.empty()) {
      res.status = 400;
      res.set_content(error("Idempotency-Key is required").dump(), "application/json");
      return;
    }
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object() || !body.contains("task") || !body["task"].is_string() || body["task"].get<std::string>().empty()) {
      res.status = 400;
      res.set_content(error("task must be a non-empty string").dump(), "application/json");
      return;
    }
    const auto task = body["task"].get<std::string>();
    if (task.size() > kMaxTaskBytes) {
      res.status = 413;
      res.set_content(error("task exceeds 8 KiB").dump(), "application/json");
      return;
    }
    std::set<std::string> tools;
    for (const auto& name : body.value("tools", json::array())) tools.insert(name.get<std::string>());
    for (const auto& name : tools) {
      if (kToolCatalog.count(name) == 0) {
        res.status = 400;
        res.set_content(error("unknown tool " + name).dump(), "application/json");
        return;
      }
    }
    const auto maxSteps = body.contains("max_steps") && body["max_steps"].is_number_integer()
                              ? std::optional<int>(body["max_steps"].get<int>())
                              : std::nullopt;
    if (!maxSteps || *maxSteps < kMinSteps || *maxSteps > kMaxSteps) {
      res.status = 400;
      res.set_content(error("max_steps must be 1..40").dump(), "application/json");
      return;
    }
    const auto stored = store.get(tenant, idemKey);
    if (stored) {
      res.status = 200;
      res.set_content(stored->dump(), "application/json");
      return;
    }
    const json run = {
        {"run_id", uuidString()},
        {"status", "pending"},
        {"max_steps", *maxSteps},
        {"steps_used", 0},
        {"tools", tools},
    };
    store.put(tenant, idemKey, run);
    std::cerr << "run start tenant=" << tenant << " run=" << run["run_id"] << " steps=" << *maxSteps
              << " tools=" << tools.size() << "\\n";
    res.status = 202;
    res.set_content(run.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  hints: [
    'Write the guard clauses first, in cost order: tenant, Idempotency-Key, task shape, byte length, tool allowlist, step budget. Each one answers before any run, worker or model exists, so a malformed request can never start something you have to cancel.',
    'The allowlist is a server-side set, not a caller promise: resolve the names against the catalog and reject the request before you mint a run id. Sorting and de-duplicating the list keeps the stored run canonical, so two callers sending the same tools in a different order get the same run.',
    'The idempotency lookup is keyed by `(tenant, key)` and happens before the run is created; a hit returns the stored run with 200. Store the run — not a hash of the request — because the retry has to be able to read the id it is resuming.',
  ],
  debrief: `The interviewer is testing whether you can review a generated handler at the trust boundary. The draft reads fine because the demo sends one well-formed request from one tenant and never retries. Four separate defects are being checked: a capability allowlist resolved against the server catalog (the caller names tools, the server decides which exist), a mandatory step budget (an agent without one is an unbounded spend), input caps that reject 8 KiB-plus tasks before they reach the model, and idempotency keyed by tenant so a client retry resumes a run instead of cloning it. The task text is the quiet one: it is tenant content on its way to a model, so it belongs in the run row and nowhere in the logs. Real platforms add a per-tenant quota on concurrent runs, a catalog that also carries each tool's deadline and side-effect class, and a signed approval for tools above a risk tier.`,
};
