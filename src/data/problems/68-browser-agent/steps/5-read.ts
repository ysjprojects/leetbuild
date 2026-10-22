import type {Step} from '@/lib/types';

export const readStep: Step = {
  id: 'read',
  title: 'GET /v1/browser/sessions/{id}: replay without leaking',
  concept: 'http',
  file: 'read',
  focus: ['client', 'api', 'store', 'redis', 'artifact'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: the session it was asked for
comes back and the replay renders in the demo, so the read endpoint looks finished. It serves the
trace to any caller, hands out every typed value the agent typed into the page, and returns a
screenshot URL that never expires. Review it like the owner of the Session API, fix it, and prove the
fix with the checks below.

Implement \`GET /v1/browser/sessions/{id}\`, the read half of the Session API and the endpoint a
client polls to replay a session.

- The tenant comes from the authenticated \`X-Tenant-Id\` header; a missing tenant is **401**.
- The session's **owning tenant** is compared with the caller's: a session that belongs to another
  tenant answers **404**, exactly like a session id that does not exist — never **403**, never the
  body. The draft serves whichever session id it is given.
- The response is the **step trace** in \`step_index\` order, bounded to the last \`TRACE_LIMIT\`
  steps, plus the **budget outcome** (\`budget_remaining\`, \`budget_exhausted\`) read from the same
  Redis session state the state step maintains (\`HGET\`/\`HGETALL\` on \`session:{id}\`). The draft
  returns the whole \`input_log\` and asks Redis for nothing.
- Typed values appear **only as redacted field names**: each step carries \`redacted_fields\`, produced
  by the shared \`redact(...)\` helper, and the response never contains a typed input value or the
  captured page content. The draft ships \`typed_values\` and \`html\`.
- The final screenshot reference is **signed** with an expiry of at most **15 minutes**
  (\`SCREENSHOT_TTL_S = 900\`), re-signed on every request — never a permanent public bucket URL.

**Failure mode the checks target.** Three contracts in one handler. Scope, because the read path is
where tenant isolation is usually lost: the write path authenticated and the read path only looked up
an id. Redaction, because a replay that returns typed values and page content turns a status endpoint
into a copy of the very data redaction exists to protect. And expiry, because a permanent screenshot
URL is a read credential for the lifetime of the object — it leaks through logs, shared links and
error reports and never stops working.`,
  sequence: {
    participants: ['Client', 'Session API', 'Session state', 'Trace store', 'Screenshot store'],
    messages: [
      {from: 'Client', to: 'Session API', label: 'GET /v1/browser/sessions/{id} · X-Tenant-Id', kind: 'sync'},
      {
        from: 'Session API',
        to: 'Session state',
        label: 'HGETALL session:{id} · tenant · budget_remaining · budget_exhausted',
        kind: 'sync',
      },
      {from: 'Session state', to: 'Session API', label: 'owning tenant · budget outcome', kind: 'reply'},
      {from: 'Session API', to: 'Session API', label: 'owning tenant == caller? else 404', kind: 'sync'},
      {from: 'Session API', to: 'Trace store', label: 'last TRACE_LIMIT steps in step_index order', kind: 'sync'},
      {from: 'Trace store', to: 'Session API', label: 'steps with redacted_fields only', kind: 'reply'},
      {from: 'Session API', to: 'Screenshot store', label: 'sign(final ref, SCREENSHOT_TTL_S)', kind: 'sync'},
      {from: 'Screenshot store', to: 'Session API', label: 'signed url · expires_at', kind: 'reply'},
      {
        from: 'Session API',
        to: 'Client',
        label: '200 {steps, budget, screenshot} · 401 no tenant · 404 foreign',
        kind: 'reply',
      },
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Serves GET /v1/browser/sessions/{id}',
      detail:
        'Register the session-read route on `GET /v1/browser/sessions/{session_id}` with the session id as a path parameter.',
      match: {
        python: {all: [/@app\.get\(\s*["']\/v1\/browser\/sessions\/\{session_id\}["']/]},
        typescript: {all: [/app\.get\(\s*['"]\/v1\/browser\/sessions\/:sessionId['"]/]},
        go: {all: [/HandleFunc\(\s*"GET \/v1\/browser\/sessions\/\{session_id\}"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"browser"\s*\/\s*"sessions"\s*\/\s*Segment\s*\)/, /\bget\s*\{/]},
        cpp: {all: [/svr\.Get\(/, /\/v1\/browser\/sessions\//]},
      },
    },
    {
      id: 'tenant-scope',
      title: 'Answers 404 for a session the caller does not own',
      detail:
        'The owning tenant of `session:{id}` is compared with the caller’s `X-Tenant-Id`, and a foreign or unknown session is the same **404** — never the body. The draft serves whichever session id it is given, so one tenant can replay another tenant’s session.',
      match: {
        python: {all: [/status_code\s*=\s*404/, /owner\s*!=\s*tenant/]},
        typescript: {all: [/code\(\s*404\s*\)/, /owner\s*!==\s*tenant/]},
        go: {all: [/StatusNotFound/, /owner\s*!=\s*tenant/]},
        scala: {all: [/StatusCodes\.NotFound/, /owner\s*!=\s*tenant/]},
        cpp: {all: [/\b404\b/, /owner\s*!=\s*tenant/]},
      },
    },
    {
      id: 'no-typed-values',
      title: 'Replays field names, never typed values or page content',
      detail:
        'The replay carries `redacted_fields` from the shared `redact(...)` helper and the response contains no typed input value and no page content — `typed_values`, `input_value`, `values` and `html` never appear. The draft ships the typed values and the captured page "for debugging".',
      match: {
        python: {all: [/redacted_fields/, /redact\(/], none: [/typed_values/, /input_value/, /["']values["']/, /html/]},
        typescript: {
          all: [/redacted_fields/, /redact\(/],
          none: [/typed_values/, /input_value/, /['"]values['"]/, /html/],
        },
        go: {all: [/redacted_fields/, /redact\(/], none: [/typed_values/, /input_value/, /"values"/, /html/]},
        scala: {all: [/redacted_fields/, /redact\(/], none: [/typed_values/, /input_value/, /"values"/, /html/]},
        cpp: {all: [/redacted_fields/, /redact\(/], none: [/typed_values/, /input_value/, /"values"/, /html/]},
      },
    },
    {
      id: 'screenshot-expiry',
      title: 'Signs the screenshot reference with a 15-minute expiry',
      detail:
        'The screenshot reference is signed per request with an expiry of at most 900 seconds — `SCREENSHOT_TTL_S = 900` (`screenshotTtlS`, `ScreenshotTtlS`, `kScreenshotTtlS`) passed to the signer, which returns `expires_at`. The draft hands out a permanent public bucket URL.',
      match: {
        python: {all: [/SCREENSHOT_TTL_S\s*=\s*900/, /\.sign\(/, /expires_at/]},
        typescript: {all: [/SCREENSHOT_TTL_S\s*=\s*900/, /\.sign\(/, /expires_at/]},
        go: {all: [/screenshotTtlS\s*=\s*900/, /\.Sign\(/, /expires_at/]},
        scala: {all: [/ScreenshotTtlS\s*=\s*900/, /\.sign\(/, /expires_at/]},
        cpp: {all: [/kScreenshotTtlS\s*=\s*900/, /\.sign\(/, /expires_at/]},
      },
    },
    {
      id: 'trace-budget',
      title: 'Returns the bounded step trace with the budget from Redis',
      detail:
        'The body carries the trace — `step_index` order, bounded by a page-size constant (`TRACE_LIMIT` / `traceLimit` / `TraceLimit` / `kTraceLimit`) — plus the budget outcome (`budget_remaining`, `budget_exhausted`) read from the same `session:{id}` hash the worker writes with `HGETALL`. The draft returns the whole input log and reads no state.',
      match: {
        python: {
          all: [/step_index/, /TRACE_LIMIT/, /session:\{session_id\}/, /\.hgetall\(|\.hget\(/, /budget_remaining/],
        },
        typescript: {
          all: [
            /step_index/,
            /TRACE_LIMIT/,
            /['"]session:['"]\s*\+\s*sessionId/,
            /\.hgetall\(|\.hget\(/,
            /budget_remaining/,
          ],
        },
        go: {
          all: [/step_index/, /traceLimit/, /"session:"\s*\+\s*sessionID/, /\.HGetAll\(|\.HGet\(/, /budget_remaining/],
        },
        scala: {
          all: [/step_index/, /TraceLimit/, /s"session:\$sessionId"/, /\.hgetAll\(|\.hget\(/, /budget_remaining/],
        },
        cpp: {
          all: [/step_index/, /kTraceLimit/, /"session:"\s*\+\s*sessionId/, /\.hgetall\(|\.hget\(/, /budget_remaining/],
        },
      },
    },
  ],
  code: {
    python: {
      starter: `import redis
from fastapi import FastAPI, Header
from fastapi.responses import JSONResponse

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)


class SessionStore:
    def load(self, session_id: str) -> dict | None:
        """The session document, by id alone."""
        raise NotImplementedError


class TraceStore:
    def all(self, session_id: str) -> list[dict]:
        """The whole input log of the session, typed input and page content included."""
        raise NotImplementedError


sessions = SessionStore()
trace = TraceStore()


@app.get("/v1/browser/sessions/{session_id}")
def read_session(session_id: str, tenant: str = Header(alias="X-Tenant-Id")) -> JSONResponse:
    # TODO: this draft serves whichever session id it is given, replays the whole input log with the
    # typed values and the captured page content, and returns a permanent screenshot URL. Review all
    # three: scope the read to the caller's tenant, replay field names only, and sign the screenshot
    # with an expiry.
    session = sessions.load(session_id)
    steps = [
        {
            "step_index": step["step_index"],
            "action": step["action"],
            "typed_values": step["typed_values"],
            "html": step["html"],
        }
        for step in trace.all(session_id)
    ]
    return JSONResponse(
        {
            "session_id": session_id,
            "status": session["status"],
            "steps": steps,
            "screenshot_url": f"https://public-screenshots.example.com/{session_id}/final.png",
        }
    )
`,
      solution: `import redis
from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)

TRACE_LIMIT = 20
SCREENSHOT_TTL_S = 900
REDACTED_FIELDS = ("password", "card", "token")


class TraceStore:
    """Provided trace storage: the steps the worker appended for a session."""

    def page(self, session_id: str, limit: int) -> list[dict]:
        """Up to limit steps in step_index order, newest last, typed input still attached."""
        raise NotImplementedError


class ScreenshotSigner:
    """Provided signer: the store serves the object only for a valid signature."""

    def sign(self, session_id: str, ttl_s: int) -> dict:
        """Sign the final screenshot reference so it expires in ttl_s seconds."""
        raise NotImplementedError


trace = TraceStore()
signer = ScreenshotSigner()


def redact(typed_input: dict) -> list[str]:
    """The names of the fields the agent filled; what it typed never leaves the worker."""
    return sorted(name for name in typed_input if name.lower() in REDACTED_FIELDS)


def replay(step: dict) -> dict:
    """One step of the replay: field names, never the typed input or the page content."""
    return {
        "step_index": step["step_index"],
        "action": step["action"],
        "target_digest": step["target_digest"],
        "outcome": step["outcome"],
        "redacted_fields": redact(step["typed_input"]),
    }


@app.get("/v1/browser/sessions/{session_id}")
def read_session(
    session_id: str,
    tenant: str | None = Header(default=None, alias="X-Tenant-Id"),
) -> JSONResponse:
    if tenant is None or tenant == "":
        raise HTTPException(status_code=401, detail="missing X-Tenant-Id")

    session = r.hgetall(f"session:{session_id}")
    owner = session.get("tenant")
    if owner != tenant:
        raise HTTPException(status_code=404, detail="session not found")

    steps = [replay(step) for step in trace.page(session_id, TRACE_LIMIT)]
    screenshot = signer.sign(session_id, SCREENSHOT_TTL_S)
    return JSONResponse(
        {
            "session_id": session_id,
            "status": session.get("status", "unknown"),
            "steps": steps,
            "budget_remaining": int(session.get("budget_remaining", 0)),
            "budget_exhausted": session.get("budget_exhausted") == "true",
            "screenshot_url": screenshot["url"],
            "screenshot_expires_at": screenshot["expires_at"],
        }
    )
`,
    },
    typescript: {
      starter: `/** GET /v1/browser/sessions/:sessionId: a model-generated draft that replays everything. */
import Fastify from 'fastify';
import {Redis} from 'ioredis';

export const app = Fastify();
const r = new Redis('redis://redis:6379');

interface LoggedStep {
  step_index: number;
  action: string;
  typed_values: string[];
  html: string;
}

class SessionStore {
  /** The session document, by id alone. */
  async load(sessionId: string): Promise<{status: string} | null> {
    throw new Error('not implemented');
  }
}

class TraceStore {
  /** The whole input log of the session, typed input and page content included. */
  async all(sessionId: string): Promise<LoggedStep[]> {
    throw new Error('not implemented');
  }
}

const sessions = new SessionStore();
const trace = new TraceStore();

app.get('/v1/browser/sessions/:sessionId', async (request, reply) => {
  // TODO: this draft serves whichever session id it is given, replays the whole input log with the
  // typed values and the captured page content, and returns a permanent screenshot URL. Review all
  // three: scope the read to the caller's tenant, replay field names only, and sign the screenshot
  // with an expiry.
  const {sessionId} = request.params as {sessionId: string};
  const session = await sessions.load(sessionId);
  const steps = await trace.all(sessionId);
  return reply.code(200).send({
    session_id: sessionId,
    status: session?.status,
    steps,
    screenshot_url: 'https://public-screenshots.example.com/' + sessionId + '/final.png',
  });
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** GET /v1/browser/sessions/:sessionId: the bounded, scoped, redacted step replay. */
import Fastify from 'fastify';
import {Redis} from 'ioredis';

export const app = Fastify();
const r = new Redis('redis://redis:6379');

const TRACE_LIMIT = 20;
const SCREENSHOT_TTL_S = 900;
const REDACTED_FIELDS = ['password', 'card', 'token'];

interface StepRow {
  step_index: number;
  action: string;
  target_digest: string;
  outcome: string;
  typed_input: Record<string, string>;
}

interface ReplayStep {
  step_index: number;
  action: string;
  target_digest: string;
  outcome: string;
  redacted_fields: string[];
}

interface SignedShot {
  url: string;
  expires_at: number;
}

class TraceStore {
  /** Up to limit steps in step_index order, newest last, typed input still attached. */
  async page(sessionId: string, limit: number): Promise<StepRow[]> {
    throw new Error('not implemented');
  }
}

class ScreenshotSigner {
  /** Sign the final screenshot reference so it expires in ttlS seconds. */
  async sign(sessionId: string, ttlS: number): Promise<SignedShot> {
    throw new Error('not implemented');
  }
}

const trace = new TraceStore();
const signer = new ScreenshotSigner();

/** The names of the fields the agent filled; what it typed never leaves the worker. */
function redact(typedInput: Record<string, string>): string[] {
  return Object.keys(typedInput)
    .filter(name => REDACTED_FIELDS.includes(name.toLowerCase()))
    .sort();
}

/** One step of the replay: field names, never the typed input or the page content. */
function replay(step: StepRow): ReplayStep {
  return {
    step_index: step.step_index,
    action: step.action,
    target_digest: step.target_digest,
    outcome: step.outcome,
    redacted_fields: redact(step.typed_input),
  };
}

app.get('/v1/browser/sessions/:sessionId', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing X-Tenant-Id'});

  const {sessionId} = request.params as {sessionId: string};
  const session = await r.hgetall('session:' + sessionId);
  const owner = session.tenant;
  if (owner !== tenant) return reply.code(404).send({error: 'session not found'});

  const steps = (await trace.page(sessionId, TRACE_LIMIT)).map(replay);
  const shot = await signer.sign(sessionId, SCREENSHOT_TTL_S);
  return reply.code(200).send({
    session_id: sessionId,
    status: session.status ?? 'unknown',
    steps,
    budget_remaining: Number(session.budget_remaining ?? 0),
    budget_exhausted: session.budget_exhausted === 'true',
    screenshot_url: shot.url,
    screenshot_expires_at: shot.expires_at,
  });
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
)

type LoggedStep struct {
	StepIndex   int      \`json:"step_index"\`
	Action      string   \`json:"action"\`
	TypedInput  string   \`json:"typed_values"\`
	HTML        string   \`json:"html"\`
}

// SessionStore loads a session document by id alone.
type SessionStore struct{}

func (s *SessionStore) Load(sessionID string) (map[string]string, error) {
	return nil, nil
}

// TraceStore returns the whole input log of a session.
type TraceStore struct{}

func (s *TraceStore) All(sessionID string) ([]LoggedStep, error) {
	return nil, nil
}

var (
	sessions = &SessionStore{}
	trace    = &TraceStore{}
)

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	_ = json.NewEncoder(rw).Encode(body)
}

func readSession(rw http.ResponseWriter, r *http.Request) {
	// TODO: this draft serves whichever session id it is given, replays the whole input log with the
	// typed values and the captured page content, and returns a permanent screenshot URL. Review all
	// three: scope the read to the caller's tenant, replay field names only, and sign the screenshot
	// with an expiry.
	sessionID := r.PathValue("session_id")
	session, _ := sessions.Load(sessionID)
	steps, _ := trace.All(sessionID)
	writeJSON(rw, http.StatusOK, map[string]any{
		"session_id":     sessionID,
		"status":         session["status"],
		"steps":          steps,
		"screenshot_url": "https://public-screenshots.example.com/" + sessionID + "/final.png",
	})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/browser/sessions/{session_id}", readSession)
	log.Fatal(http.ListenAndServe(":8443", mux))
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"sort"
	"strconv"
	"strings"

	"github.com/redis/go-redis/v9"
)

const (
	traceLimit     = 20
	screenshotTtlS = 900
)

var rdb *redis.Client

// redactedFields names the sensitive fields; what the agent typed never leaves the worker.
var redactedFields = map[string]bool{"password": true, "card": true, "token": true}

// StepRow is one stored step of a session trace.
type StepRow struct {
	StepIndex    int            \`json:"step_index"\`
	Action       string         \`json:"action"\`
	TargetDigest string         \`json:"target_digest"\`
	Outcome      string         \`json:"outcome"\`
	TypedInput   map[string]any \`json:"typed_input"\`
}

// ReplayStep is one step as the client sees it: field names, never typed input.
type ReplayStep struct {
	StepIndex      int      \`json:"step_index"\`
	Action         string   \`json:"action"\`
	TargetDigest   string   \`json:"target_digest"\`
	Outcome        string   \`json:"outcome"\`
	RedactedFields []string \`json:"redacted_fields"\`
}

// SignedShot is the screenshot reference the signer produces.
type SignedShot struct {
	URL       string \`json:"url"\`
	ExpiresAt int64  \`json:"expires_at"\`
}

// TraceStore is the provided trace storage.
type TraceStore struct{}

func (s *TraceStore) Page(ctx context.Context, sessionID string, limit int) ([]StepRow, error) {
	return nil, nil
}

// ScreenshotSigner is the provided signer: the store serves the object only for a valid signature.
type ScreenshotSigner struct{}

func (s *ScreenshotSigner) Sign(ctx context.Context, sessionID string, ttlS int) (SignedShot, error) {
	return SignedShot{}, nil
}

var (
	trace  = &TraceStore{}
	signer = &ScreenshotSigner{}
)

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	_ = json.NewEncoder(rw).Encode(body)
}

// redact turns typed input into the names of the filled fields.
func redact(typedInput map[string]any) []string {
	names := make([]string, 0, len(typedInput))
	for name := range typedInput {
		if redactedFields[strings.ToLower(name)] {
			names = append(names, name)
		}
	}
	sort.Strings(names)
	return names
}

func replay(step StepRow) ReplayStep {
	return ReplayStep{
		StepIndex:      step.StepIndex,
		Action:         step.Action,
		TargetDigest:   step.TargetDigest,
		Outcome:        step.Outcome,
		RedactedFields: redact(step.TypedInput),
	}
}

func readSession(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-Tenant-Id"})
		return
	}
	sessionID := r.PathValue("session_id")
	session, err := rdb.HGetAll(r.Context(), "session:"+sessionID).Result()
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	owner := session["tenant"]
	if owner != tenant {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "session not found"})
		return
	}
	rows, err := trace.Page(r.Context(), sessionID, traceLimit)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	steps := make([]ReplayStep, 0, len(rows))
	for _, row := range rows {
		steps = append(steps, replay(row))
	}
	shot, err := signer.Sign(r.Context(), sessionID, screenshotTtlS)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	remaining, _ := strconv.Atoi(session["budget_remaining"])
	writeJSON(rw, http.StatusOK, map[string]any{
		"session_id":            sessionID,
		"status":                session["status"],
		"steps":                 steps,
		"budget_remaining":      remaining,
		"budget_exhausted":      session["budget_exhausted"] == "true",
		"screenshot_url":        shot.URL,
		"screenshot_expires_at": shot.ExpiresAt,
	})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/browser/sessions/{session_id}", readSession)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

final case class LoggedStep(step_index: Int, action: String, typed_values: List[String], html: String)

object SessionStore {
  /** The session document, by id alone. */
  def load(sessionId: String): Option[LoggedStep] = None
}

object TraceStore {
  /** The whole input log of the session, typed input and page content included. */
  def all(sessionId: String): List[LoggedStep] = Nil
}

object Read {
  implicit val system: ActorSystem = ActorSystem("browser-agent")

  def jsonEntity(body: String): ResponseEntity =
    HttpEntity(ContentTypes.\`application/json\`, body)

  val route: Route =
    path("v1" / "browser" / "sessions" / Segment) { sessionId =>
      get {
        // TODO: this draft serves whichever session id it is given, replays the whole input log with
        // the typed values and the captured page content, and returns a permanent screenshot URL.
        // Review all three: scope the read to the caller's tenant, replay field names only, and sign
        // the screenshot with an expiry.
        val session = SessionStore.load(sessionId)
        val steps = TraceStore.all(sessionId)
        complete(
          StatusCodes.OK,
          jsonEntity(
            s"""{"session_id":"$sessionId","steps":\${steps.size},"screenshot_url":"https://public-screenshots.example.com/$sessionId/final.png"}"""
          )
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
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import redis.clients.jedis.Jedis
import spray.json._

import scala.jdk.CollectionConverters._

/** One stored step of a session trace. */
final case class StepRow(step_index: Int, action: String, target_digest: String, outcome: String, typed_input: Map[String, String])
/** One step as the client sees it: field names, never typed input. */
final case class ReplayStep(step_index: Int, action: String, target_digest: String, outcome: String, redacted_fields: List[String])
final case class SignedShot(url: String, expires_at: Long)

object TraceStore {
  /** Up to limit steps in step_index order, newest last, typed input still attached. */
  def page(sessionId: String, limit: Int): List[StepRow] = Nil
}

object ScreenshotSigner {
  /** Sign the final screenshot reference so it expires in ttlS seconds. */
  def sign(sessionId: String, ttlS: Int): SignedShot = SignedShot("", 0L)
}

object Read {
  implicit val system: ActorSystem = ActorSystem("browser-agent")
  val jedis = new Jedis("redis", 6379)

  val TraceLimit = 20
  val ScreenshotTtlS = 900
  val RedactedFields = Set("password", "card", "token")

  def jsonEntity(body: String): ResponseEntity =
    HttpEntity(ContentTypes.\`application/json\`, body)

  /** The names of the fields the agent filled; what it typed never leaves the worker. */
  def redact(typedInput: Map[String, String]): List[String] =
    typedInput.keys.filter(name => RedactedFields.contains(name.toLowerCase)).toList.sorted

  def replay(step: StepRow): ReplayStep =
    ReplayStep(step.step_index, step.action, step.target_digest, step.outcome, redact(step.typed_input))

  def stepJson(step: ReplayStep): JsObject =
    JsObject(
      "step_index" -> JsNumber(step.step_index),
      "action" -> JsString(step.action),
      "target_digest" -> JsString(step.target_digest),
      "outcome" -> JsString(step.outcome),
      "redacted_fields" -> JsArray(step.redacted_fields.map(JsString(_)).toVector)
    )

  val route: Route =
    path("v1" / "browser" / "sessions" / Segment) { sessionId =>
      get {
        optionalHeaderValueByName("X-Tenant-Id") { tenantOpt =>
          val tenant = tenantOpt.filter(_.nonEmpty)
          if (tenant.isEmpty) {
            complete(StatusCodes.Unauthorized, jsonEntity("""{"error":"missing X-Tenant-Id"}"""))
          } else {
            val session = jedis.hgetAll(s"session:$sessionId").asScala.toMap
            val owner = session.getOrElse("tenant", "")
            if (owner != tenant.get) {
              complete(StatusCodes.NotFound, jsonEntity("""{"error":"session not found"}"""))
            } else {
              val steps = TraceStore.page(sessionId, TraceLimit).map(replay)
              val shot = ScreenshotSigner.sign(sessionId, ScreenshotTtlS)
              val response = JsObject(
                "session_id" -> JsString(sessionId),
                "status" -> JsString(session.getOrElse("status", "unknown")),
                "steps" -> JsArray(steps.map(stepJson).toVector),
                "budget_remaining" -> JsNumber(session.getOrElse("budget_remaining", "0").toInt),
                "budget_exhausted" -> JsBoolean(session.getOrElse("budget_exhausted", "false") == "true"),
                "screenshot_url" -> JsString(shot.url),
                "screenshot_expires_at" -> JsNumber(shot.expires_at)
              )
              complete(StatusCodes.OK, jsonEntity(response.compactPrint))
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

#include <optional>
#include <string>

using json = nlohmann::json;

struct LoggedStep {
  int stepIndex = 0;
  std::string action;
  std::string typedValues;
  std::string html;
};

// SessionStore loads a session document by id alone.
struct SessionStore {
  std::optional<json> load(const std::string& sessionId);
};

// TraceStore returns the whole input log of a session.
struct TraceStore {
  json all(const std::string& sessionId);
};

SessionStore sessions;
TraceStore trace;

int main() {
  httplib::Server svr;

  svr.Get(R"(/v1/browser/sessions/([^/]+))", [](const httplib::Request& req, httplib::Response& res) {
    // TODO: this draft serves whichever session id it is given, replays the whole input log with the
    // typed values and the captured page content, and returns a permanent screenshot URL. Review all
    // three: scope the read to the caller's tenant, replay field names only, and sign the screenshot
    // with an expiry.
    const auto sessionId = req.matches[1].str();
    const auto session = sessions.load(sessionId);
    res.status = 200;
    res.set_content(json{{"session_id", sessionId},
                         {"status", session->value("status", "")},
                         {"steps", trace.all(sessionId)},
                         {"screenshot_url", "https://public-screenshots.example.com/" + sessionId + "/final.png"}}
                        .dump(),
                    "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <algorithm>
#include <set>
#include <string>
#include <vector>

using json = nlohmann::json;

constexpr int kTraceLimit = 20;
constexpr int kScreenshotTtlS = 900;

// The sensitive field names; what the agent typed never leaves the worker.
const std::set<std::string> kRedactedFields = {"password", "card", "token"};

// StepRow is one stored step of a session trace.
struct StepRow {
  int stepIndex = 0;
  std::string action;
  std::string targetDigest;
  std::string outcome;
  json typedInput;
};

// ReplayStep is one step as the client sees it: field names, never typed input.
struct ReplayStep {
  int stepIndex = 0;
  std::string action;
  std::string targetDigest;
  std::string outcome;
  std::vector<std::string> redactedFields;
};

struct SignedShot {
  std::string url;
  long long expiresAt = 0;
};

// TraceStore is the provided trace storage.
struct TraceStore {
  std::vector<StepRow> page(const std::string& sessionId, int limit);
};

// ScreenshotSigner is the provided signer.
struct ScreenshotSigner {
  SignedShot sign(const std::string& sessionId, int ttlS);
};

TraceStore trace;
ScreenshotSigner signer;

// redact turns typed input into the names of the filled fields.
std::vector<std::string> redact(const json& typedInput) {
  std::vector<std::string> names;
  for (auto it = typedInput.begin(); it != typedInput.end(); ++it) {
    std::string name = it.key();
    std::transform(name.begin(), name.end(), name.begin(), [](unsigned char c) { return std::tolower(c); });
    if (kRedactedFields.count(name) > 0) names.push_back(it.key());
  }
  std::sort(names.begin(), names.end());
  return names;
}

ReplayStep replay(const StepRow& step) {
  return ReplayStep{step.stepIndex, step.action, step.targetDigest, step.outcome, redact(step.typedInput)};
}

json stepJson(const ReplayStep& step) {
  json fields = json::array();
  for (const auto& name : step.redactedFields) fields.push_back(name);
  return json{
      {"step_index", step.stepIndex},
      {"action", step.action},
      {"target_digest", step.targetDigest},
      {"outcome", step.outcome},
      {"redacted_fields", fields},
  };
}

int main() {
  httplib::Server svr;
  sw::redis::Redis redis("tcp://redis:6379");

  svr.Get(R"(/v1/browser/sessions/([^/]+))", [&](const httplib::Request& req, httplib::Response& res) {
    const auto tenant = req.get_header_value("X-Tenant-Id");
    if (tenant.empty()) {
      res.status = 401;
      res.set_content(R"({"error":"missing X-Tenant-Id"})", "application/json");
      return;
    }
    const auto sessionId = req.matches[1].str();
    const auto session = redis.hgetall("session:" + sessionId);
    const auto owner = session.count("tenant") ? session.at("tenant") : std::string();
    if (owner != tenant) {
      res.status = 404;
      res.set_content(R"({"error":"session not found"})", "application/json");
      return;
    }
    json steps = json::array();
    for (const auto& row : trace.page(sessionId, kTraceLimit)) steps.push_back(stepJson(replay(row)));
    const auto shot = signer.sign(sessionId, kScreenshotTtlS);
    const int remaining = session.count("budget_remaining") ? std::stoi(session.at("budget_remaining")) : 0;
    const bool exhausted = session.count("budget_exhausted") && session.at("budget_exhausted") == "true";
    res.status = 200;
    res.set_content(json{{"session_id", sessionId},
                         {"status", session.count("status") ? session.at("status") : std::string("unknown")},
                         {"steps", steps},
                         {"budget_remaining", remaining},
                         {"budget_exhausted", exhausted},
                         {"screenshot_url", shot.url},
                         {"screenshot_expires_at", shot.expiresAt}}
                        .dump(),
                    "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  hints: [
    'Authorize the read like a write: load `session:{id}` from Redis, compare its owning tenant with the authenticated `X-Tenant-Id`, and answer **401** when the header is missing and the same **404** for "no such session" and "someone else\'s". A different status or body for the two turns the endpoint into an oracle for which session ids exist.',
    'The replay is the dangerous payload: return `redacted_fields` per step — the names the shared `redact(...)` helper kept — and nothing else from the input. Shipping `typed_values` or the captured `html` "for debugging" is exactly what the redaction boundary exists to stop, and a status endpoint must not become a second copy of the customer\'s data.',
    'Read the budget outcome from the same hash the worker writes (`HGETALL session:{id}` → `budget_remaining`, `budget_exhausted`) so the read cannot disagree with enforcement, bound the trace with a server constant (`TRACE_LIMIT`), and mint the screenshot reference with a signer that stamps `expires_at = now + SCREENSHOT_TTL_S` (900 s) on every request. A public bucket URL is a permanent credential.',
  ],
  debrief: `The interviewer is testing whether you can review a read path with the same suspicion as a write path. The draft looks fine because the demo asks for a session it owns, replays two steps, and shows a screenshot. Three defects are being checked. Scope comes first — the read path is where tenant isolation is usually lost, because the write path authenticated and the read path only looked up an id, so the tenant in \`X-Tenant-Id\` has to own the session and a foreign session must be indistinguishable from a missing one: same \`404\`, same body, no timing hint. Redaction is second, and it is the one that outlives the incident: a replay that returns the typed values and the captured page turns a convenience endpoint into a copy of the data the pipeline redacts, and it is the same leak whether it ships in the body or in the logs. Expiry is third — a screenshot URL with no signature and no expiry is a read credential for the life of the object, and it spreads through links, logs and error reports where nothing can revoke it. The shape check is the fourth contract: the trace ordered by \`step_index\` and bounded by a server constant, with the budget outcome read from the same Redis state enforcement writes, so the number a client sees is the number that stops the next step. Real platforms add ETag or sequence-based long polling so a poller gets a cheap 304, a separate export endpoint for a full trace, and an audit record of who read whose session.`,
};
