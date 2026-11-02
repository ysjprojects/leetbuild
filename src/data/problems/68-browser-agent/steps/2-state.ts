import type {Step} from '@/lib/types';

export const stateStep: Step = {
  id: 'state',
  title: 'Redis session state with step leases and TTL',
  concept: 'redis',
  file: 'state',
  focus: ['api', 'redis', 'worker'],
  task: `## Task

**Starting point.** The starter handles \`POST /v1/browser/sessions/{id}/steps\` by looking the session up in a module-level \`SESSIONS\` dictionary (\`step_index\`, \`budget_remaining\`, the page's HTML), bumping the index, decrementing the budget and returning the document. It serves the demo and hides five flaws.

**Failure mode the checks target.** The state is process-local, so a driver restart "starts over" with a fresh budget. Nothing takes a lease, so two workers both advance one session, and nothing expires. The page's HTML in the document turns a state key into a copy of every page the agent touched.

Session state lives in **Redis** under one hash per session, \`session:{id}\`:

- The hash is the state: \`step_index\`, \`budget_remaining\`, \`page_ref\`, \`lease_owner\`, \`lease_expires_at\`, \`status\`. A restarted driver resumes the same budget.
- Each accepted action takes or refreshes a **45-second lease** (\`LEASE_TTL_S = 45\`) on the key; its expiry lets the next worker recover a dead driver's session.
- The transition is **one atomic** Lua \`EVAL\`: read the lease owner, refuse a second worker with **409**, \`HINCRBY\` one step, store the page reference, refresh the TTL.
- The hash holds **references, not content**: \`page_ref\` is a handle the driver resolves; page HTML does not enter the key.
- The budget is charged **once per accepted action**; at zero the status records \`budget_exhausted\`.`,
  sequence: {
    participants: ['Worker', 'Session state', 'Browser driver'],
    messages: [
      {from: 'Worker', to: 'Session state', label: 'EVAL take_lease(session:{id}, worker_id, 45)', kind: 'sync'},
      {from: 'Session state', to: 'Worker', label: '1 granted · 0 leased by another worker', kind: 'reply'},
      {from: 'Worker', to: 'Session state', label: 'HINCRBY budget_remaining -1 · HSET page_ref', kind: 'sync'},
      {from: 'Session state', to: 'Worker', label: 'step_index, budget_remaining', kind: 'reply'},
      {from: 'Worker', to: 'Session state', label: 'EXPIRE session:{id} · reaped when the work stops', kind: 'async'},
      {from: 'Worker', to: 'Browser driver', label: 'Act on the page reference the state points at', kind: 'async'},
    ],
  },
  checks: [
    {
      id: 'state-key',
      title: 'Keeps session state in Redis under session:{id}',
      detail:
        'Every piece of session state — step index, budget, page reference, lease — is read and written in one Redis hash built by a `session_key(session_id)` helper, so the driver process owns nothing. The starter keeps a module-level dictionary of sessions in the driver, so a restart loses the budget and the step index.',
      match: {
        python: {all: [/def session_key\(/, /r\.hset\(|r\.hgetall\(/], none: [/^SESSIONS\s*=/m]},
        typescript: {all: [/function sessionKey\(/, /redis\.hset\(|redis\.hgetall\(/], none: [/const SESSIONS/]},
        go: {all: [/func sessionKey\(/, /rdb\.HSet\(|rdb\.HGetAll\(/], none: [/var SESSIONS/]},
        scala: {all: [/def sessionKey\(/, /jedis\.hset\(|jedis\.hgetAll\(/], none: [/val SESSIONS/]},
        cpp: {all: [/sessionKey\(/, /redis\.hset\(|redis\.hgetall\(/], none: [/SESSIONS/]},
      },
    },
    {
      id: 'lease-ttl',
      title: 'Extends a 45-second lease on every action',
      detail:
        'Each accepted action refreshes a `LEASE_TTL_S = 45` lease on the session key in the same atomic script that takes it, so a driver that dies mid-action loses the lease within 45 seconds and its session becomes recoverable. The starter sets no expiry anywhere: a crashed driver leaves a session nobody can take over and a key that never goes away.',
      match: {
        python: {all: [/LEASE_TTL_S = 45/, /EXPIRE/, /eval\(/]},
        typescript: {all: [/LEASE_TTL_S = 45/, /expire\(/, /eval\(/]},
        go: {all: [/leaseTtlS\s*=\s*45/, /Expire\(/, /NewScript\(/]},
        scala: {all: [/LeaseTtlS = 45/, /expire\(/, /eval\(/]},
        cpp: {all: [/kLeaseTtlS = 45/, /expire\(/, /eval\(/]},
      },
    },
    {
      id: 'lease-guard',
      title: 'Refuses a second worker on a leased session',
      detail:
        'The script reads `lease_owner` and returns 0 when another worker holds the lease, and the caller answers **409** instead of advancing the session. The starter has no lease at all, so two workers pointed at one session both charge its budget and both drive the browser.',
      match: {
        python: {all: [/lease_owner/, /409/]},
        typescript: {all: [/lease_owner/, /409/]},
        go: {all: [/lease_owner/, /409/]},
        scala: {all: [/lease_owner/, /409/]},
        cpp: {all: [/lease_owner/, /409/]},
      },
    },
    {
      id: 'budget-in-state',
      title: 'Keeps the budget in the hash so a restart resumes it',
      detail:
        'The remaining budget is a field of `session:{id}` — charged with `HINCRBY` and read back with `HGETALL` — so a restarted driver resumes the same budget instead of minting a new one. The starter decrements a Python/JS object, so the budget dies with the process and the session "starts over" after a restart.',
      match: {
        python: {all: [/budget_remaining/, /hincrby\(/, /hgetall\(|hget\(/]},
        typescript: {all: [/budget_remaining/, /hincrby\(/, /hgetall\(|hget\(/]},
        go: {all: [/budget_remaining/, /HIncrBy\(/, /HGetAll\(|HGet\(/]},
        scala: {all: [/budget_remaining/, /hincrBy\(/, /hgetAll\(|hget\(/]},
        cpp: {all: [/budget_remaining/, /hincrby\(/, /hgetall\(|hget\(/]},
      },
    },
    {
      id: 'reference-not-content',
      title: 'Stores a page reference, never the page content',
      detail:
        'The document carries `page_ref` — a handle the driver resolves — and no page markup: the session key must not become a copy of every page the agent visited. The starter writes the page’s HTML into the session document "so the next action can read it", which is how a state key turns into a second copy of the customer’s browsing.',
      match: {
        python: {all: [/page_ref/], none: [/html/i]},
        typescript: {all: [/page_ref/], none: [/html/i]},
        go: {all: [/page_ref/], none: [/html/i]},
        scala: {all: [/page_ref/], none: [/html/i]},
        cpp: {all: [/page_ref/], none: [/html/i]},
      },
    },
  ],
  code: {
    python: {
      starter: `import logging

import redis
from fastapi import FastAPI, Header
from fastapi.responses import JSONResponse

app = FastAPI()
logger = logging.getLogger("browser.state")
r = redis.Redis(host="redis", port=6379)

SESSIONS = {}


@app.post("/v1/browser/sessions/{session_id}/steps")
def advance(session_id: str, worker: str = Header(alias="X-Worker-Id")) -> JSONResponse:
    # TODO: this starter has five flaws. The task says where to look; the checks say what must change.
    session = SESSIONS.setdefault(
        session_id, {"step_index": 0, "budget_remaining": 20, "page": {"html": "<html>…"}}
    )
    session["step_index"] += 1
    session["budget_remaining"] -= 1
    logger.info("step session=%s index=%d worker=%s", session_id, session["step_index"], worker)
    return JSONResponse(session)
`,
      solution: `import logging

import redis
from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse

app = FastAPI()
logger = logging.getLogger("browser.state")
r = redis.Redis(host="redis", port=6379)

LEASE_TTL_S = 45
STATE_TTL_S = 30 * 60

# One atomic transition: take or verify the lease, charge a step, store the page reference, refresh
# the TTL. Two workers cannot both spend the same step, and a dead driver's lease expires.
TAKE_LEASE = """
local owner = redis.call('HGET', KEYS[1], 'lease_owner')
if owner and owner ~= ARGV[1] then return 0 end
redis.call('HSET', KEYS[1], 'lease_owner', ARGV[1])
redis.call('HSET', KEYS[1], 'lease_expires_at', ARGV[3])
redis.call('EXPIRE', KEYS[1], ARGV[2])
return 1
"""


def session_key(session_id: str) -> str:
    """Every piece of session state lives in this one Redis hash, never in the driver process."""
    return "session:" + session_id


def advance(session_id: str, worker_id: str, page_ref: str, lease_expires_at: int) -> dict:
    """Charge one step under the lease; the budget survives the driver that took it."""
    key = session_key(session_id)
    granted = r.eval(TAKE_LEASE, 1, key, worker_id, LEASE_TTL_S, lease_expires_at)
    if granted != 1:
        raise HTTPException(status_code=409, detail="session is leased by another worker")
    remaining = r.hincrby(key, "budget_remaining", -1)
    if remaining < 0:
        r.hincrby(key, "budget_remaining", 1)
        r.hset(key, "status", "budget_exhausted")
        raise HTTPException(status_code=409, detail="step budget exhausted")
    step_index = r.hincrby(key, "step_index", 1)
    r.hset(key, mapping={"page_ref": page_ref, "status": "running"})
    r.expire(key, STATE_TTL_S)
    logger.info("step session=%s index=%d remaining=%d", session_id, step_index, remaining)
    return {
        "session_id": session_id,
        "step_index": step_index,
        "budget_remaining": remaining,
        "page_ref": page_ref,
    }


def resume(session_id: str) -> dict:
    """A restarted driver reads the same document: the lease and the budget are in Redis."""
    state = r.hgetall(session_key(session_id))
    if not state:
        raise HTTPException(status_code=404, detail="session not found")
    return {
        "session_id": session_id,
        "step_index": int(state.get("step_index", 0)),
        "budget_remaining": int(state.get("budget_remaining", 0)),
        "page_ref": state.get("page_ref", ""),
        "lease_owner": state.get("lease_owner", ""),
    }


@app.post("/v1/browser/sessions/{session_id}/steps")
def advance_route(
    session_id: str,
    page_ref: str = Header(alias="X-Page-Ref"),
    worker: str = Header(alias="X-Worker-Id"),
) -> JSONResponse:
    return JSONResponse(advance(session_id, worker, page_ref, 0))
`,
    },
    typescript: {
      starter: `/** The step loop's session state, kept in this process. */
import Fastify from 'fastify';

export const app = Fastify();

const SESSIONS: Record<string, {step_index: number; budget_remaining: number; page: {html: string}}> = {};

app.post('/v1/browser/sessions/:sessionId/steps', async (request, reply) => {
  // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
  const {sessionId} = request.params as {sessionId: string};
  const worker = request.headers['x-worker-id'] as string;
  const session = (SESSIONS[sessionId] ??= {step_index: 0, budget_remaining: 20, page: {html: '<html>…'}});
  session.step_index += 1;
  session.budget_remaining -= 1;
  request.log.info({sessionId, step_index: session.step_index, worker}, 'step');
  return reply.code(202).send(session);
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** The step loop's session state, kept in one Redis hash per session. */
import Redis from 'ioredis';

export const redis = new Redis({host: 'redis', port: 6379});

const LEASE_TTL_S = 45;
const STATE_TTL_S = 30 * 60;

/**
 * One atomic transition: take or verify the lease, charge a step, store the page reference, refresh
 * the TTL. Two workers cannot both spend the same step, and a dead driver's lease expires.
 */
const TAKE_LEASE = \`
local owner = redis.call('HGET', KEYS[1], 'lease_owner')
if owner and owner ~= ARGV[1] then return 0 end
redis.call('HSET', KEYS[1], 'lease_owner', ARGV[1])
redis.call('HSET', KEYS[1], 'lease_expires_at', ARGV[3])
redis.call('EXPIRE', KEYS[1], ARGV[2])
return 1
\`;

export function sessionKey(sessionId: string): string {
  return 'session:' + sessionId;
}

export interface SessionState {
  session_id: string;
  step_index: number;
  budget_remaining: number;
  page_ref: string;
  lease_owner: string;
}

export async function advance(
  sessionId: string,
  workerId: string,
  pageRef: string,
  leaseExpiresAt: number,
): Promise<SessionState> {
  const key = sessionKey(sessionId);
  const granted = await redis.eval(TAKE_LEASE, 1, key, workerId, LEASE_TTL_S, leaseExpiresAt);
  if (granted !== 1) throw new Error('409: session is leased by another worker');
  const remaining = await redis.hincrby(key, 'budget_remaining', -1);
  if (remaining < 0) {
    await redis.hincrby(key, 'budget_remaining', 1);
    await redis.hset(key, 'status', 'budget_exhausted');
    throw new Error('409: step budget exhausted');
  }
  const stepIndex = await redis.hincrby(key, 'step_index', 1);
  await redis.hset(key, 'page_ref', pageRef);
  await redis.hset(key, 'status', 'running');
  await redis.expire(key, STATE_TTL_S);
  return {session_id: sessionId, step_index: stepIndex, budget_remaining: remaining, page_ref: pageRef, lease_owner: workerId};
}

export async function resume(sessionId: string): Promise<SessionState> {
  const state = await redis.hgetall(sessionKey(sessionId));
  if (Object.keys(state).length === 0) throw new Error('404: session not found');
  return {
    session_id: sessionId,
    step_index: Number(state.step_index ?? 0),
    budget_remaining: Number(state.budget_remaining ?? 0),
    page_ref: state.page_ref ?? '',
    lease_owner: state.lease_owner ?? '',
  };
}
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"log"
	"net/http"
	"strconv"
)

var SESSIONS = map[string]map[string]any{}

func advance(w http.ResponseWriter, r *http.Request) {
	// TODO: this starter has five flaws. The task says where to look; the checks say what must change.
	sessionID := r.PathValue("session_id")
	session, ok := SESSIONS[sessionID]
	if !ok {
		session = map[string]any{"step_index": 0, "budget_remaining": 20, "page": map[string]any{"html": "<html>…"}}
		SESSIONS[sessionID] = session
	}
	session["step_index"] = session["step_index"].(int) + 1
	session["budget_remaining"] = session["budget_remaining"].(int) - 1
	log.Printf("step session=%s index=%v", sessionID, session["step_index"])
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(session)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/browser/sessions/{session_id}/steps", advance)
	log.Fatal(http.ListenAndServe(":8443", mux))
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"strconv"

	"github.com/redis/go-redis/v9"
)

const (
	leaseTtlS = 45
	stateTtlS = 30 * 60
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// takeLease is one atomic transition: take or verify the lease, charge a step, store the page
// reference, refresh the TTL. A dead driver's lease expires instead of stranding the session.
var takeLease = redis.NewScript(\`
local owner = redis.call('HGET', KEYS[1], 'lease_owner')
if owner and owner ~= ARGV[1] then return 0 end
redis.call('HSET', KEYS[1], 'lease_owner', ARGV[1])
redis.call('HSET', KEYS[1], 'lease_expires_at', ARGV[3])
redis.call('EXPIRE', KEYS[1], ARGV[2])
return 1
\`)

func sessionKey(sessionID string) string {
	return "session:" + sessionID
}

type sessionState struct {
	SessionID       string \`json:"session_id"\`
	StepIndex       int    \`json:"step_index"\`
	BudgetRemaining int    \`json:"budget_remaining"\`
	PageRef         string \`json:"page_ref"\`
	LeaseOwner      string \`json:"lease_owner"\`
}

func advance(ctx context.Context, sessionID string, workerID string, pageRef string, leaseExpiresAt int64) (sessionState, error) {
	key := sessionKey(sessionID)
	granted, err := takeLease.Run(ctx, rdb, []string{key}, workerID, leaseTtlS, leaseExpiresAt).Int()
	if err != nil {
		return sessionState{}, err
	}
	if granted != 1 {
		return sessionState{}, errors.New("409: session is leased by another worker")
	}
	remaining, err := rdb.HIncrBy(ctx, key, "budget_remaining", -1).Result()
	if err != nil {
		return sessionState{}, err
	}
	if remaining < 0 {
		_ = rdb.HIncrBy(ctx, key, "budget_remaining", 1).Err()
		_ = rdb.HSet(ctx, key, "status", "budget_exhausted").Err()
		return sessionState{}, errors.New("409: step budget exhausted")
	}
	stepIndex, err := rdb.HIncrBy(ctx, key, "step_index", 1).Result()
	if err != nil {
		return sessionState{}, err
	}
	_ = rdb.HSet(ctx, key, "page_ref", pageRef).Err()
	_ = rdb.HSet(ctx, key, "status", "running").Err()
	_ = rdb.Expire(ctx, key, stateTtlS).Err()
	log.Printf("step session=%s index=%d remaining=%d", sessionID, stepIndex, remaining)
	return sessionState{
		SessionID:       sessionID,
		StepIndex:       int(stepIndex),
		BudgetRemaining: int(remaining),
		PageRef:         pageRef,
		LeaseOwner:      workerID,
	}, nil
}

func resume(ctx context.Context, sessionID string) (sessionState, error) {
	state, err := rdb.HGetAll(ctx, sessionKey(sessionID)).Result()
	if err != nil {
		return sessionState{}, err
	}
	if len(state) == 0 {
		return sessionState{}, errors.New("404: session not found")
	}
	stepIndex, _ := strconv.Atoi(state["step_index"])
	remaining, _ := strconv.Atoi(state["budget_remaining"])
	return sessionState{
		SessionID:       sessionID,
		StepIndex:       stepIndex,
		BudgetRemaining: remaining,
		PageRef:         state["page_ref"],
		LeaseOwner:      state["lease_owner"],
	}, nil
}

func advanceRoute(w http.ResponseWriter, r *http.Request) {
	state, err := advance(r.Context(), r.PathValue("session_id"), r.Header.Get("X-Worker-Id"), r.Header.Get("X-Page-Ref"), 0)
	if err != nil {
		http.Error(w, err.Error(), http.StatusConflict)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(state)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/browser/sessions/{session_id}/steps", advanceRoute)
	log.Fatal(http.ListenAndServe(":8443", mux))
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import redis.clients.jedis.Jedis
import spray.json._

object SessionState {
  implicit val system: ActorSystem = ActorSystem("browser-agent")
  val jedis = new Jedis("redis", 6379)

  val SESSIONS: scala.collection.mutable.Map[String, Map[String, Any]] = scala.collection.mutable.Map.empty

  def jsonEntity(body: String): ResponseEntity =
    HttpEntity(ContentTypes.\`application/json\`, body)

  val route: Route =
    path("v1" / "browser" / "sessions" / Segment / "steps") { sessionId =>
      post {
        // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
        val session = SESSIONS.getOrElseUpdate(sessionId, Map("step_index" -> 0, "budget_remaining" -> 20, "html" -> "<html>…"))
        complete(StatusCodes.Accepted, jsonEntity(s"""{"session_id":"$sessionId","step_index":1}"""))
      }
    }

  def main(args: Array[String]): Unit = {
    Http().newServerAt("0.0.0.0", 8443).bind(route)
  }
}
`,
      solution: `import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import redis.clients.jedis.Jedis
import spray.json._

import scala.jdk.CollectionConverters._

final case class SessionStateRow(
    session_id: String,
    step_index: Int,
    budget_remaining: Int,
    page_ref: String,
    lease_owner: String
)

object SessionStore {
  implicit val system: ActorSystem = ActorSystem("browser-agent")
  val jedis = new Jedis("redis", 6379)

  val LeaseTtlS = 45
  val StateTtlS = 30 * 60

  /** One atomic transition: lease, budget charge and page reference in a single script. */
  val TakeLease: String =
    """local owner = redis.call('HGET', KEYS[1], 'lease_owner')
      |if owner and owner ~= ARGV[1] then return 0 end
      |redis.call('HSET', KEYS[1], 'lease_owner', ARGV[1])
      |redis.call('HSET', KEYS[1], 'lease_expires_at', ARGV[3])
      |redis.call('EXPIRE', KEYS[1], ARGV[2])
      |return 1""".stripMargin

  def sessionKey(sessionId: String): String = "session:" + sessionId

  def advance(sessionId: String, workerId: String, pageRef: String, leaseExpiresAt: Long): SessionStateRow = {
    val key = sessionKey(sessionId)
    val granted = jedis.eval(TakeLease, 1, key, workerId, LeaseTtlS.toString, leaseExpiresAt.toString).asInstanceOf[Long]
    if (granted != 1L) throw new IllegalStateException("409: session is leased by another worker")
    val remaining = jedis.hincrBy(key, "budget_remaining", -1)
    if (remaining < 0) {
      jedis.hincrBy(key, "budget_remaining", 1)
      jedis.hset(key, "status", "budget_exhausted")
      throw new IllegalStateException("409: step budget exhausted")
    }
    val stepIndex = jedis.hincrBy(key, "step_index", 1)
    jedis.hset(key, "page_ref", pageRef)
    jedis.hset(key, "status", "running")
    jedis.expire(key, StateTtlS)
    SessionStateRow(sessionId, stepIndex.toInt, remaining.toInt, pageRef, workerId)
  }

  def resume(sessionId: String): SessionStateRow = {
    val state = jedis.hgetAll(sessionKey(sessionId)).asScala.toMap
    if (state.isEmpty) throw new NoSuchElementException("404: session not found")
    SessionStateRow(
      sessionId,
      state.getOrElse("step_index", "0").toInt,
      state.getOrElse("budget_remaining", "0").toInt,
      state.getOrElse("page_ref", ""),
      state.getOrElse("lease_owner", "")
    )
  }
}

object SessionState {
  def jsonEntity(body: String): ResponseEntity =
    HttpEntity(ContentTypes.\`application/json\`, body)

  val route: Route =
    path("v1" / "browser" / "sessions" / Segment / "steps") { sessionId =>
      post {
        optionalHeaderValueByName("X-Worker-Id") { worker =>
          val row = SessionStore.advance(sessionId, worker.getOrElse(""), "", 0L)
          complete(
            StatusCodes.Accepted,
            jsonEntity(
              s"""{"session_id":"\${row.session_id}","step_index":\${row.step_index},"budget_remaining":\${row.budget_remaining},"page_ref":"\${row.page_ref}"}"""
            )
          )
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

#include <map>
#include <string>

using json = nlohmann::json;

// The step loop's session state, kept in this process.
std::map<std::string, json> SESSIONS;

int main() {
  httplib::Server svr;

  svr.Post(R"(/v1/browser/sessions/([^/]+)/steps)", [](const httplib::Request& req, httplib::Response& res) {
    // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
    const auto sessionId = req.matches[1].str();
    auto& session = SESSIONS[sessionId];
    if (session.is_null())
      session = json{{"step_index", 0}, {"budget_remaining", 20}, {"page", {{"html", "<html>…"}}}};
    session["step_index"] = session["step_index"].get<int>() + 1;
    session["budget_remaining"] = session["budget_remaining"].get<int>() - 1;
    res.status = 202;
    res.set_content(session.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <map>
#include <string>

using json = nlohmann::json;

constexpr int kLeaseTtlS = 45;
constexpr int kStateTtlS = 30 * 60;

// One atomic transition: take or verify the lease, charge a step, store the page reference, refresh
// the TTL. A dead driver's lease expires instead of stranding the session.
const std::string kTakeLease =
    "local owner = redis.call('HGET', KEYS[1], 'lease_owner')\\n"
    "if owner and owner ~= ARGV[1] then return 0 end\\n"
    "redis.call('HSET', KEYS[1], 'lease_owner', ARGV[1])\\n"
    "redis.call('HSET', KEYS[1], 'lease_expires_at', ARGV[3])\\n"
    "redis.call('EXPIRE', KEYS[1], ARGV[2])\\n"
    "return 1\\n";

static std::string sessionKey(const std::string& sessionId) { return "session:" + sessionId; }

static json advance(sw::redis::Redis& redis, const std::string& sessionId, const std::string& workerId,
                    const std::string& pageRef, long long leaseExpiresAt) {
  const auto key = sessionKey(sessionId);
  const auto granted = redis.eval(kTakeLease, {key}, {workerId, std::to_string(kLeaseTtlS), std::to_string(leaseExpiresAt)});
  if (granted != 1) throw std::runtime_error("409: session is leased by another worker");
  const auto remaining = redis.hincrby(key, "budget_remaining", -1);
  if (remaining < 0) {
    redis.hincrby(key, "budget_remaining", 1);
    redis.hset(key, "status", "budget_exhausted");
    throw std::runtime_error("409: step budget exhausted");
  }
  const auto stepIndex = redis.hincrby(key, "step_index", 1);
  redis.hset(key, "page_ref", pageRef);
  redis.hset(key, "status", "running");
  redis.expire(key, kStateTtlS);
  return json{{"session_id", sessionId}, {"step_index", stepIndex}, {"budget_remaining", remaining}, {"page_ref", pageRef}};
}

static json resume(sw::redis::Redis& redis, const std::string& sessionId) {
  const auto state = redis.hgetall(sessionKey(sessionId));
  if (state.empty()) throw std::runtime_error("404: session not found");
  const auto field = [&state](const std::string& name) {
    const auto it = state.find(name);
    return it == state.end() ? std::string() : it->second;
  };
  return json{{"session_id", sessionId},
              {"step_index", field("step_index").empty() ? 0 : std::stoi(field("step_index"))},
              {"budget_remaining", field("budget_remaining").empty() ? 0 : std::stoi(field("budget_remaining"))},
              {"page_ref", field("page_ref")},
              {"lease_owner", field("lease_owner")}};
}

int main() {
  httplib::Server svr;
  sw::redis::Redis redis("tcp://redis:6379");

  svr.Post(R"(/v1/browser/sessions/([^/]+)/steps)", [&](const httplib::Request& req, httplib::Response& res) {
    const auto sessionId = req.matches[1].str();
    try {
      const auto state = advance(redis, sessionId, req.get_header_value("X-Worker-Id"), req.get_header_value("X-Page-Ref"), 0);
      res.status = 202;
      res.set_content(state.dump(), "application/json");
    } catch (const std::exception& err) {
      res.status = 409;
      res.set_content(json{{"error", err.what()}}.dump(), "application/json");
    }
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  hints: [
    'Restart the driver mid-session and the next step reports step_index 1 and a full budget of 20 again. Point two workers at one session and both advance it; the key never goes away.',
    'The handler keeps sessions in the process-local SESSIONS dict, decrements a Python int and stores the page html inside the document; the Redis client is unused, so there is no lease, TTL or shared budget.',
    'Replace SESSIONS with a session_key(id) hash; advance via one r.eval Lua script that checks lease_owner (409 on mismatch), HINCRBY budget_remaining, sets page_ref and EXPIREs with LEASE_TTL_S = 45; read with hgetall.',
  ],
  debrief: `The fix puts the whole session into one Redis hash and makes the only transition a single Lua script, because every property the step needs (mutual exclusion, a charged budget, an expiry) has to hold across a driver restart and across two workers racing. A lease refreshed on each accepted action gives exclusion and recovery from one primitive: a live driver keeps it, a dead driver loses it within 45 seconds and the next worker takes over. Keeping only \`page_ref\` in the hash keeps the state key from becoming a second copy of the customer's browsing. Production platforms usually add a fencing token to the lease, so a worker that paused past its expiry and woke up cannot write a stale result over the new owner's progress.`,
};
