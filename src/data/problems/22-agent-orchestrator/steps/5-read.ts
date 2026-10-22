import type {Step} from '@/lib/types';

export const readStep: Step = {
  id: 'read',
  title: 'GET /v1/agent/runs/{id}: status and transcript tail',
  concept: 'http',
  file: 'read',
  focus: ['client', 'api', 'transcript', 'redis'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it loads the run, returns its
state and hands back the whole transcript. It compiles, it serves the demo, and it hides three
production flaws. Review it like the service owner, fix it, and prove the fix with the checks below.

Implement \`GET /v1/agent/runs/{id}\`, the endpoint a client polls after starting a run.

- The tenant comes from the authenticated \`X-Tenant-Id\` header; a missing tenant is **401**.
- The response carries the run **status**, the **budget remaining** (\`max_steps - steps_used\`) and
  the page of steps.
- The transcript is paginated by step sequence and **bounded to the last 20 steps**: a 40-step run
  answers with 20 steps and a \`next_cursor\`, never with all 40. The draft returns the whole
  transcript, so a long run is a multi-megabyte response on every poll.
- \`cursor\` addresses older steps: it is the opaque value the previous page returned (the step
  sequence, base64-encoded). Anything that does not decode to a non-negative integer is **400**; the
  draft forwards whatever arrives to the store because "it came from us".
- A run that does not exist **or belongs to another tenant** is **404**, and both cases answer the
  same way, so run ids cannot be probed for existence. The draft serves the transcript of any run id
  the caller knows.

**Failure mode the checks target.** Three separate contracts. Bounded pages (an unbounded transcript
turns a status poll into a bandwidth incident). Validated cursors (an unvalidated cursor reaches the
store as a query parameter — and the first version of it will be handed straight to SQL). Ownership
(the read path is where tenant isolation is usually lost: the write path authenticates, and the read
path trusts the id).`,
  sequence: {
    participants: ['Client', 'Run API', 'Run state', 'Transcript'],
    messages: [
      {from: 'Client', to: 'Run API', label: 'GET /v1/agent/runs/{id} · X-Tenant-Id · ?cursor=…', kind: 'sync'},
      {from: 'Run API', to: 'Run state', label: 'load run:{id}', kind: 'sync'},
      {from: 'Run state', to: 'Run API', label: 'state · tenant · max_steps · steps_used', kind: 'reply'},
      {from: 'Run API', to: 'Run API', label: 'tenant owns the run? cursor decodes?', kind: 'sync'},
      {from: 'Run API', to: 'Transcript', label: 'page(run, seq < before, 20)', kind: 'sync'},
      {from: 'Transcript', to: 'Run API', label: '20 steps, newest first', kind: 'reply'},
      {
        from: 'Run API',
        to: 'Client',
        label: '200 {status, budget_remaining, steps, next_cursor} · else 404',
        kind: 'reply',
      },
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Serves GET /v1/agent/runs/{id}',
      detail: 'Register the run-read route on `GET /v1/agent/runs/{id}` with the run id as a path parameter.',
      match: {
        python: {all: [/@app\.get\(\s*["']\/v1\/agent\/runs\/\{run_id\}["']/]},
        typescript: {all: [/app\.get\(\s*['"]\/v1\/agent\/runs\/:runId['"]/]},
        go: {all: [/HandleFunc\(\s*"GET \/v1\/agent\/runs\/\{run_id\}"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"agent"\s*\/\s*"runs"\s*\/\s*Segment\s*\)/, /\bget\s*\{/]},
        cpp: {all: [/svr\.Get\(/, /\/v1\/agent\/runs\/\(/]},
      },
    },
    {
      id: 'page-limit',
      title: 'Bounds the transcript to the last 20 steps',
      detail:
        'One page-size constant (20) is passed to the transcript read, so a 40-step run answers with 20 steps and a cursor — never with the whole transcript. The draft returns every step it can find.',
      match: {
        python: {all: [/TAIL_LIMIT/, /transcript\.page\(/]},
        typescript: {all: [/TAIL_LIMIT/, /transcript\.page\(/]},
        go: {all: [/tailLimit/, /transcript\.Page\(/]},
        scala: {all: [/TailLimit/, /transcript\.page\(/]},
        cpp: {all: [/kTailLimit/, /transcript\.page\(/]},
      },
    },
    {
      id: 'cursor',
      title: 'Rejects a malformed cursor with 400',
      detail:
        'The cursor is decoded — base64 of the next step sequence — and must resolve to a non-negative integer; anything else is **400** before the store is touched. The draft passes the raw query value straight to the transcript read.',
      match: {
        python: {all: [/urlsafe_b64decode/, /status_code\s*=\s*400/]},
        typescript: {all: [/Buffer\.from\([^)]*['"]base64url['"]\)/, /code\(\s*400\s*\)/]},
        go: {all: [/base64\./, /StatusBadRequest/]},
        scala: {all: [/Base64/, /StatusCodes\.BadRequest/]},
        cpp: {all: [/base64Decode/, /\b400\b/]},
      },
    },
    {
      id: 'tenant-scope',
      title: 'Answers 404 for a run the caller does not own',
      detail:
        'The loaded run is compared against the authenticated tenant and a missing or foreign run is the same **404**. The draft serves the transcript of any run id the caller names, so one tenant can read another tenant’s task steps.',
      match: {
        python: {all: [/status_code\s*=\s*404/, /run\.get\("tenant"\)\s*!=\s*tenant/]},
        typescript: {all: [/code\(\s*404\s*\)/, /run\.tenant\s*!==\s*tenant/]},
        go: {all: [/StatusNotFound/, /run\.Tenant\s*!=\s*tenant/]},
        scala: {all: [/StatusCodes\.NotFound/, /run\.tenant\s*!=\s*tenant/]},
        cpp: {all: [/\b404\b/, /run->value\("tenant",\s*""\)\s*!=\s*tenant/]},
      },
    },
    {
      id: 'shape',
      title: 'Returns status, budget remaining and the next cursor',
      detail:
        'The body carries `status`, `budget_remaining` (`max_steps - steps_used`) and `next_cursor` for the following page of older steps, so a client can render progress and resume without re-fetching the tail.',
      match: {
        python: {all: [/budget_remaining/, /next_cursor/]},
        typescript: {all: [/budget_remaining/, /next_cursor/]},
        go: {all: [/budget_remaining/, /next_cursor/]},
        scala: {all: [/budget_remaining/, /next_cursor/]},
        cpp: {all: [/budget_remaining/, /next_cursor/]},
      },
    },
  ],
  code: {
    python: {
      starter: `from fastapi import FastAPI, Header, Query
from fastapi.responses import JSONResponse

app = FastAPI()


class RunStore:
    def load(self, run_id: str) -> dict | None:
        """The run document (tenant, state, max_steps, steps_used), or None."""
        raise NotImplementedError


class Transcript:
    def all(self, run_id: str) -> list[dict]:
        """Every step of the run, oldest first."""
        raise NotImplementedError


runs = RunStore()
transcript = Transcript()


@app.get("/v1/agent/runs/{run_id}")
def read_run(
    run_id: str,
    tenant: str = Header(alias="X-Tenant-Id"),
    cursor: str | None = Query(default=None),
) -> JSONResponse:
    # TODO: the draft returns the whole transcript, forwards the cursor untouched, and serves any
    # run id the caller knows. Review all three.
    run = runs.load(run_id)
    return JSONResponse({"run_id": run_id, "status": run["state"], "steps": transcript.all(run_id)})
`,
      solution: `import base64

from fastapi import FastAPI, Header, HTTPException, Query
from fastapi.responses import JSONResponse

app = FastAPI()

TAIL_LIMIT = 20
TAIL_FROM_SEQ = 1 << 62


class RunStore:
    def load(self, run_id: str) -> dict | None:
        """The run document (tenant, state, max_steps, steps_used), or None."""
        raise NotImplementedError


class Transcript:
    def page(self, run_id: str, before_seq: int, limit: int) -> list[dict]:
        """Up to \`limit\` steps with seq < before_seq, newest first."""
        raise NotImplementedError


runs = RunStore()
transcript = Transcript()


def decode_cursor(cursor: str) -> int:
    try:
        before_seq = int(base64.urlsafe_b64decode(cursor.encode()).decode())
    except (ValueError, UnicodeDecodeError):
        raise HTTPException(status_code=400, detail="malformed cursor")
    if before_seq < 0:
        raise HTTPException(status_code=400, detail="malformed cursor")
    return before_seq


def encode_cursor(seq: int) -> str:
    return base64.urlsafe_b64encode(str(seq).encode()).decode()


@app.get("/v1/agent/runs/{run_id}")
def read_run(
    run_id: str,
    tenant: str | None = Header(default=None, alias="X-Tenant-Id"),
    cursor: str | None = Query(default=None),
) -> JSONResponse:
    if tenant is None or tenant == "":
        raise HTTPException(status_code=401, detail="missing X-Tenant-Id")
    before_seq = decode_cursor(cursor) if cursor is not None else TAIL_FROM_SEQ

    run = runs.load(run_id)
    if run is None or run.get("tenant") != tenant:
        raise HTTPException(status_code=404, detail="no such run")

    steps = transcript.page(run_id, before_seq, TAIL_LIMIT)
    next_cursor = encode_cursor(steps[-1]["seq"]) if len(steps) == TAIL_LIMIT else None
    return JSONResponse(
        {
            "run_id": run_id,
            "status": run["state"],
            "budget_remaining": run["max_steps"] - run["steps_used"],
            "steps": steps,
            "next_cursor": next_cursor,
        }
    )
`,
    },
    typescript: {
      starter: `/** GET /v1/agent/runs/:runId: a model-generated draft that returns the whole transcript. */
import Fastify from 'fastify';

export const app = Fastify();

class RunStore {
  async load(runId: string): Promise<{tenant: string; state: string; max_steps: number; steps_used: number} | null> {
    throw new Error('not implemented');
  }
}

class Transcript {
  async all(runId: string): Promise<{seq: number}[]> {
    throw new Error('not implemented');
  }
}

const runs = new RunStore();
const transcript = new Transcript();

app.get('/v1/agent/runs/:runId', async (request, reply) => {
  // TODO: the draft returns the whole transcript, forwards the cursor untouched, and serves any
  // run id the caller knows. Review all three.
  const tenant = request.headers['x-tenant-id'] as string;
  const {runId} = request.params as {runId: string};
  const run = await runs.load(runId);
  return reply.code(200).send({run_id: runId, status: run?.state, steps: await transcript.all(runId), tenant});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** GET /v1/agent/runs/:runId: status, budget remaining and a bounded transcript tail. */
import Fastify from 'fastify';

export const app = Fastify();

const TAIL_LIMIT = 20;
const TAIL_FROM_SEQ = 1 << 62;

interface Run {
  tenant: string;
  state: string;
  max_steps: number;
  steps_used: number;
}

interface Step {
  seq: number;
  tool: string;
  state: string;
}

class RunStore {
  async load(runId: string): Promise<Run | null> {
    throw new Error('not implemented');
  }
}

class Transcript {
  async page(runId: string, beforeSeq: number, limit: number): Promise<Step[]> {
    throw new Error('not implemented');
  }
}

const runs = new RunStore();
const transcript = new Transcript();

function decodeCursor(cursor: string): number {
  const text = Buffer.from(cursor, 'base64url').toString('utf8');
  if (!/^\\d+$/.test(text)) throw new SyntaxError('malformed cursor');
  return Number.parseInt(text, 10);
}

function encodeCursor(seq: number): string {
  return Buffer.from(String(seq), 'utf8').toString('base64url');
}

app.get('/v1/agent/runs/:runId', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing X-Tenant-Id'});

  const {runId} = request.params as {runId: string};
  const {cursor} = request.query as {cursor?: string};
  let beforeSeq = TAIL_FROM_SEQ;
  if (cursor !== undefined) {
    try {
      beforeSeq = decodeCursor(cursor);
    } catch {
      return reply.code(400).send({error: 'malformed cursor'});
    }
  }

  const run = await runs.load(runId);
  if (run === null || run.tenant !== tenant) return reply.code(404).send({error: 'no such run'});

  const steps = await transcript.page(runId, beforeSeq, TAIL_LIMIT);
  const nextCursor = steps.length === TAIL_LIMIT ? encodeCursor(steps[steps.length - 1].seq) : null;
  return reply.code(200).send({
    run_id: runId,
    status: run.state,
    budget_remaining: run.max_steps - run.steps_used,
    steps,
    next_cursor: nextCursor,
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

type RunDoc struct {
	Tenant    string \`json:"tenant"\`
	State     string \`json:"state"\`
	MaxSteps  int    \`json:"max_steps"\`
	StepsUsed int    \`json:"steps_used"\`
}

type Step struct {
	Seq  int64  \`json:"seq"\`
	Tool string \`json:"tool"\`
}

type RunStore struct{}

func (s *RunStore) Load(ctx context.Context, runID string) (*RunDoc, error) {
	return nil, nil
}

type Transcript struct{}

func (t *Transcript) All(ctx context.Context, runID string) ([]Step, error) {
	return nil, nil
}

var runs = &RunStore{}
var transcript = &Transcript{}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func readRun(rw http.ResponseWriter, r *http.Request) {
	// TODO: the draft returns the whole transcript, forwards the cursor untouched, and serves any
	// run id the caller knows. Review all three.
	runID := r.PathValue("run_id")
	run, _ := runs.Load(r.Context(), runID)
	steps, _ := transcript.All(r.Context(), runID)
	writeJSON(rw, http.StatusOK, map[string]any{"run_id": runID, "status": run.State, "steps": steps})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/agent/runs/{run_id}", readRun)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
      solution: `package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"log"
	"net/http"
	"strconv"
)

const (
	tailLimit  = 20
	tailFromSeq = int64(1) << 62
)

type RunDoc struct {
	Tenant    string \`json:"tenant"\`
	State     string \`json:"state"\`
	MaxSteps  int    \`json:"max_steps"\`
	StepsUsed int    \`json:"steps_used"\`
}

type Step struct {
	Seq  int64  \`json:"seq"\`
	Tool string \`json:"tool"\`
}

type RunStore struct{}

func (s *RunStore) Load(ctx context.Context, runID string) (*RunDoc, error) {
	return nil, nil
}

type Transcript struct{}

func (t *Transcript) Page(ctx context.Context, runID string, beforeSeq int64, limit int) ([]Step, error) {
	return nil, nil
}

var runs = &RunStore{}
var transcript = &Transcript{}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func decodeCursor(raw string) (int64, bool) {
	decoded, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil {
		return 0, false
	}
	seq, err := strconv.ParseInt(string(decoded), 10, 64)
	if err != nil || seq < 0 {
		return 0, false
	}
	return seq, true
}

func readRun(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-Tenant-Id"})
		return
	}
	beforeSeq := tailFromSeq
	if raw := r.URL.Query().Get("cursor"); raw != "" {
		seq, ok := decodeCursor(raw)
		if !ok {
			writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "malformed cursor"})
			return
		}
		beforeSeq = seq
	}
	runID := r.PathValue("run_id")
	run, err := runs.Load(r.Context(), runID)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	if run == nil || run.Tenant != tenant {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "no such run"})
		return
	}
	steps, err := transcript.Page(r.Context(), runID, beforeSeq, tailLimit)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	next := ""
	if len(steps) == tailLimit && len(steps) > 0 {
		next = base64.RawURLEncoding.EncodeToString([]byte(strconv.FormatInt(steps[len(steps)-1].Seq, 10)))
	}
	log.Printf("run read tenant=%s run=%s steps=%d", tenant, runID, len(steps))
	writeJSON(rw, http.StatusOK, map[string]any{
		"run_id":           runID,
		"status":           run.State,
		"budget_remaining": run.MaxSteps - run.StepsUsed,
		"steps":            steps,
		"next_cursor":      next,
	})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/agent/runs/{run_id}", readRun)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model.StatusCodes
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class RunDoc(tenant: String, state: String, max_steps: Int, steps_used: Int)
final case class Step(seq: Long, tool: String)

object Read {
  implicit val system: ActorSystem = ActorSystem("agent-orchestrator")
  implicit val stepFormat: RootJsonFormat[Step] = jsonFormat2(Step)

  val runs = RunStore.open()
  val transcript = Transcript.open()

  val route: Route =
    path("v1" / "agent" / "runs" / Segment) { runId =>
      get {
        headerValueByName("X-Tenant-Id") { tenant =>
          // TODO: the draft returns the whole transcript, forwards the cursor untouched, and serves
          // any run id the caller knows. Review all three.
          val run = runs.load(runId)
          val steps = transcript.all(runId)
          complete(StatusCodes.OK, s"""{"run_id":"$runId","steps":\${steps.size},"tenant":"$tenant"}""")
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
import java.util.Base64

final case class RunDoc(tenant: String, state: String, max_steps: Int, steps_used: Int)
final case class Step(seq: Long, tool: String)
final case class RunView(run_id: String, status: String, budget_remaining: Int, steps: List[Step], next_cursor: Option[String])

object Read {
  implicit val system: ActorSystem = ActorSystem("agent-orchestrator")
  implicit val stepFormat: RootJsonFormat[Step] = jsonFormat2(Step)
  implicit val runViewFormat: RootJsonFormat[RunView] = jsonFormat5(RunView)

  val TailLimit = 20
  val TailFromSeq = 1L << 62

  val runs = RunStore.open()
  val transcript = Transcript.open()

  def decodeCursor(raw: String): Option[Long] =
    try {
      val text = new String(Base64.getUrlDecoder.decode(raw), StandardCharsets.UTF_8)
      if (text.nonEmpty && text.forall(_.isDigit)) Some(text.toLong) else None
    } catch {
      case _: IllegalArgumentException => None
    }

  def encodeCursor(seq: Long): String =
    Base64.getUrlEncoder.withoutPadding.encodeToString(seq.toString.getBytes(StandardCharsets.UTF_8))

  val route: Route =
    path("v1" / "agent" / "runs" / Segment) { runId =>
      get {
        optionalHeaderValueByName("X-Tenant-Id") { tenantOpt =>
          parameter("cursor".?) { cursorOpt =>
            val tenant = tenantOpt.filter(_.nonEmpty)
            val beforeSeq = cursorOpt match {
              case None => Right(TailFromSeq)
              case Some(raw) => decodeCursor(raw).toRight(())
            }
            if (tenant.isEmpty) {
              complete(StatusCodes.Unauthorized, """{"error":"missing X-Tenant-Id"}""")
            } else if (beforeSeq.isLeft) {
              complete(StatusCodes.BadRequest, """{"error":"malformed cursor"}""")
            } else {
              runs.load(runId) match {
                case Some(run) if run.tenant != tenant.get =>
                  complete(StatusCodes.NotFound, """{"error":"no such run"}""")
                case Some(run) =>
                  val steps = transcript.page(runId, beforeSeq.toOption.get, TailLimit)
                  val next = if (steps.size == TailLimit) steps.lastOption.map(s => encodeCursor(s.seq)) else None
                  complete(
                    StatusCodes.OK,
                    RunView(runId, run.state, run.max_steps - run.steps_used, steps, next)
                  )
                case None =>
                  complete(StatusCodes.NotFound, """{"error":"no such run"}""")
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
  std::optional<json> load(const std::string& runId);
};

struct Transcript {
  json all(const std::string& runId);
};

RunStore runs;
Transcript transcript;

int main() {
  httplib::Server svr;

  svr.Get(R"(/v1/agent/runs/(d+))", [](const httplib::Request& req, httplib::Response& res) {
    const auto runId = req.matches[1].str();
    // TODO: the draft returns the whole transcript, forwards the cursor untouched, and serves any
    // run id the caller knows. Review all three.
    const auto run = runs.load(runId);
    res.status = 200;
    res.set_content(json{{"run_id", runId}, {"status", run->value("state", "")}, {"steps", transcript.all(runId)}}.dump(),
                    "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <iostream>
#include <optional>
#include <string>

using json = nlohmann::json;

constexpr int kTailLimit = 20;
constexpr long long kTailFromSeq = 1LL << 62;

struct RunStore {
  std::optional<json> load(const std::string& runId);
};

struct Transcript {
  json page(const std::string& runId, long long beforeSeq, int limit);
};

RunStore runs;
Transcript transcript;

std::optional<std::string> base64Decode(const std::string& in) {
  static const std::string kAlphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  std::string out;
  int value = 0;
  int bits = -8;
  for (char c : in) {
    if (c == '=') break;
    const auto pos = kAlphabet.find(c);
    if (pos == std::string::npos) return std::nullopt;
    value = (value << 6) + static_cast<int>(pos);
    bits += 6;
    if (bits >= 0) {
      out.push_back(static_cast<char>((value >> bits) & 0xFF));
      bits -= 8;
    }
  }
  return out;
}

std::optional<long long> decodeCursor(const std::string& raw) {
  const auto text = base64Decode(raw);
  if (!text || text->empty()) return std::nullopt;
  for (char c : *text) {
    if (c < '0' || c > '9') return std::nullopt;
  }
  return std::stoll(*text);
}

int main() {
  httplib::Server svr;

  svr.Get(R"(/v1/agent/runs/(d+))", [](const httplib::Request& req, httplib::Response& res) {
    const auto tenant = req.get_header_value("X-Tenant-Id");
    if (tenant.empty()) {
      res.status = 401;
      res.set_content(R"({"error":"missing X-Tenant-Id"})", "application/json");
      return;
    }
    long long beforeSeq = kTailFromSeq;
    const auto raw = req.get_param_value("cursor");
    if (!raw.empty()) {
      const auto seq = decodeCursor(raw);
      if (!seq) {
        res.status = 400;
        res.set_content(R"({"error":"malformed cursor"})", "application/json");
        return;
      }
      beforeSeq = *seq;
    }
    const auto runId = req.matches[1].str();
    const auto run = runs.load(runId);
    if (!run || run->value("tenant", "") != tenant) {
      res.status = 404;
      res.set_content(R"({"error":"no such run"})", "application/json");
      return;
    }
    const auto steps = transcript.page(runId, beforeSeq, kTailLimit);
    const auto next = steps.size() == static_cast<std::size_t>(kTailLimit)
                          ? json(steps.back().value("seq", 0))
                          : json(nullptr);
    res.status = 200;
    res.set_content(json{{"run_id", runId},
                         {"status", run->value("state", "")},
                         {"budget_remaining", run->value("max_steps", 0) - run->value("steps_used", 0)},
                         {"steps", steps},
                         {"next_cursor", next}}
                        .dump(),
                    "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  hints: [
    'Order the guards by cost: tenant, then cursor, then the store. A malformed cursor must be rejected before any read, and the ownership check must happen before a single step leaves the store — a 404 that leaks a different body for an existing run is a run-id oracle.',
    'The page size is a server constant, not a query parameter: `20` is passed to the transcript read, and the cursor for the next page is the sequence of the oldest step you returned. The client asks for `?cursor=…`, never for `?limit=100000`.',
    'Make the cursor opaque and validated: encode the step sequence (base64), decode it on the way in, and treat anything that is not a non-negative integer as 400. Opaque cursors stop clients from inventing offsets, and validating them is the difference between a query parameter and an injection surface.',
  ],
  debrief: `The interviewer is testing whether you can review a read path with the same suspicion as a write path. The draft looks fine because the demo polls a two-step run and reads it as itself. Three defects are being checked: an unbounded transcript (status polling should never stream a whole run), an unvalidated cursor (which reaches the store as an attacker-controlled value), and missing ownership (the classic tenant-isolation hole, since the write path authenticated and the read path only looked up an id). The shape check is the fourth contract: a poll response has to carry the status, the remaining budget and a way to page, or the client will re-fetch the tail on every tick. Real platforms add ETags or sequence-based long polling so a poller gets a cheap 304, a separate endpoint for the full export, and an audit log of who read whose transcript.`,
};
