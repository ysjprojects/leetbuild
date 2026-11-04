import type {Step} from '@/lib/types';

export const readStep: Step = {
  id: 'read',
  title: 'GET /v1/browser/sessions/{id}: the owner’s bounded trace and a screenshot that expires',
  concept: 'http',
  file: 'read',
  focus: ['client', 'api', 'redis', 'store', 'artifact'],
  task: `## Task

**Starting point.** The starter serves \`GET /v1/browser/sessions/{id}\` with the tenant in
\`X-Tenant-Id\` (401 when missing): it loads the session with \`sessions.load_session\` (404 when
missing) and answers its \`sessions.public_view\` with \`steps\`, the whole trace from
\`trace.read_trace\`, and \`screenshot\`, \`{url: screenshots.public_url(id, step_index)}\`. It
serves the demo and hides three flaws.

**Failure mode the checks target.** Any tenant that learns a session id reads that session's trace;
a session of a few hundred steps answers all of them at once; the screenshot link works for anyone,
for as long as the object exists.

- A session of another tenant is **404** with the same body as a missing id.
- \`steps\` is the last **\`TRACE_LIMIT\` = 50** steps of the trace, in step order.
- \`screenshot\` is \`screenshots.sign_screenshot(id, step_index, SCREENSHOT_TTL_S)\` with
  **\`SCREENSHOT_TTL_S\` = 900**: \`{url, expires_at}\`, signed afresh on every read.`,
  sequence: {
    participants: ['Client', 'Session API', 'Redis', 'Trace store', 'Screenshot store'],
    messages: [
      {from: 'Client', to: 'Session API', label: 'GET /v1/browser/sessions/{id} · X-Tenant-Id', kind: 'sync'},
      {
        from: 'Session API',
        to: 'Redis',
        label: 'load_session(id) → another tenant: 404 like a missing id',
        kind: 'sync',
      },
      {from: 'Session API', to: 'Trace store', label: 'read_trace(id) → last TRACE_LIMIT steps', kind: 'sync'},
      {from: 'Session API', to: 'Screenshot store', label: 'sign_screenshot(id, step, 900 s)', kind: 'sync'},
      {
        from: 'Session API',
        to: 'Client',
        label: '200 {budget_remaining, steps, screenshot: {url, expires_at}}',
        kind: 'reply',
      },
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Serves GET /v1/browser/sessions/{id}',
      detail:
        'Register `GET /v1/browser/sessions/{id}`: the owner reads the session’s public view with its `steps` and `screenshot`; a request without `X-Tenant-Id` is 401.',
      match: {
        python: {all: [/@app\.get\(\s*["']\/v1\/browser\/sessions\/\{session_id\}["']/]},
        typescript: {all: [/app\.get\(\s*['"]\/v1\/browser\/sessions\/:/]},
        go: {all: [/HandleFunc\(\s*"GET \/v1\/browser\/sessions\/\{id\}"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"browser"\s*\/\s*"sessions"\s*\/\s*Segment\s*\)/, /\bget\s*\{/]},
        cpp: {all: [/svr\.Get\(\s*R"\(\/v1\/browser\/sessions\//]},
      },
    },
    {
      id: 'tenant-scope',
      title: 'A foreign session answers like a missing one',
      detail:
        'The session’s owning tenant is compared with the caller’s; another tenant’s session is 404 with the body a missing id gets. The starter looks the session up by id alone.',
      match: {
        python: {all: [/\[["']tenant["']\]\s*!=\s*tenant|tenant\s*!=\s*session\[["']tenant["']\]/]},
        typescript: {all: [/\.tenant\s*!==\s*tenant|tenant\s*!==\s*session\.tenant/]},
        go: {all: [/\.Tenant\s*!=\s*tenant|tenant\s*!=\s*session\.Tenant/]},
        scala: {all: [/\.tenant\s*!=\s*tenant|_\.tenant\s*==\s*tenant/]},
        cpp: {all: [/->tenant\s*!=\s*tenant|tenant\s*!=\s*session->tenant/]},
      },
    },
    {
      id: 'trace-bounded',
      title: 'Answers the last 50 steps',
      detail:
        '`steps` is the tail of the trace, `TRACE_LIMIT` (50) steps in step order; the starter answers the whole trace.',
      match: {
        python: {all: [/TRACE_LIMIT\s*=\s*50\b/, /\[\s*-TRACE_LIMIT\s*:\s*\]/]},
        typescript: {all: [/TRACE_LIMIT\s*=\s*50\b/, /\.slice\(\s*-TRACE_LIMIT\s*\)/]},
        go: {all: [/traceLimit\s*=\s*50\b/, /len\(steps\)\s*-\s*traceLimit/]},
        scala: {all: [/TraceLimit\s*=\s*50\b/, /takeRight\(\s*TraceLimit\s*\)/]},
        cpp: {all: [/kTraceLimit\s*=\s*50\b/, /steps\.end\(\)\s*-\s*kTraceLimit/]},
      },
    },
    {
      id: 'screenshot-expiry',
      title: 'The screenshot reference is signed and expires within 15 minutes',
      detail:
        'The screenshot is `sign_screenshot`/`signScreenshot` with `SCREENSHOT_TTL_S` (900), answered with its `expires_at` and signed on each read; the starter answers the store’s permanent `public_url`.',
      match: {
        python: {all: [/screenshots\.sign_screenshot\(/, /SCREENSHOT_TTL_S\s*=\s*900\b/], none: [/public_url\(/]},
        typescript: {all: [/signScreenshot\(/, /SCREENSHOT_TTL_S\s*=\s*900\b/], none: [/publicUrl\(/]},
        go: {all: [/screenshots\.SignScreenshot\(/, /screenshotTTLS\s*=\s*900\b/], none: [/screenshots\.PublicURL\(/]},
        scala: {
          all: [/Screenshots\.signScreenshot\(/, /ScreenshotTtlS\s*=\s*900L?\b/],
          none: [/Screenshots\.publicUrl\(/],
        },
        cpp: {
          all: [/screenshots::signScreenshot\(/, /kScreenshotTtlS\s*=\s*900\b/],
          none: [/screenshots::publicUrl\(/],
        },
      },
    },
  ],
  code: {
    python: {
      starter: `from fastapi import FastAPI, HTTPException, Request

from browser import screenshots  # public_url, sign_screenshot
from browser import sessions  # load_session, public_view
from browser import trace  # read_trace

app = FastAPI()


@app.get("/v1/browser/sessions/{session_id}")
def read_session(session_id: str, request: Request) -> dict:
    # TODO: this starter has three flaws. The task says where to look; the checks say what must change.
    tenant = request.headers.get("x-tenant-id", "")
    if not tenant:
        raise HTTPException(status_code=401, detail="X-Tenant-Id is required")
    session = sessions.load_session(session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="no such session")
    steps = trace.read_trace(session_id)
    shot = {"url": screenshots.public_url(session_id, session["step_index"])}
    return {**sessions.public_view(session), "steps": steps, "screenshot": shot}
`,
      solution: `from fastapi import FastAPI, HTTPException, Request

from browser import screenshots  # public_url, sign_screenshot
from browser import sessions  # load_session, public_view
from browser import trace  # read_trace

app = FastAPI()

TRACE_LIMIT = 50
SCREENSHOT_TTL_S = 900


@app.get("/v1/browser/sessions/{session_id}")
def read_session(session_id: str, request: Request) -> dict:
    tenant = request.headers.get("x-tenant-id", "")
    if not tenant:
        raise HTTPException(status_code=401, detail="X-Tenant-Id is required")
    session = sessions.load_session(session_id)
    # Another tenant's session answers exactly like a missing one: the id confirms nothing.
    if session is None or session["tenant"] != tenant:
        raise HTTPException(status_code=404, detail="no such session")
    steps = trace.read_trace(session_id)[-TRACE_LIMIT:]
    shot = screenshots.sign_screenshot(session_id, session["step_index"], SCREENSHOT_TTL_S)
    return {**sessions.public_view(session), "steps": steps, "screenshot": shot}
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';

import {publicUrl, signScreenshot} from 'browser/screenshots';
import {loadSession, publicView} from 'browser/sessions';
import {readTrace} from 'browser/trace';

export const app = Fastify();

app.get('/v1/browser/sessions/:sessionId', async (request, reply) => {
  // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'X-Tenant-Id is required'});
  const {sessionId} = request.params as {sessionId: string};
  const session = await loadSession(sessionId);
  if (session === null) return reply.code(404).send({error: 'no such session'});
  const steps = await readTrace(sessionId);
  const screenshot = {url: publicUrl(sessionId, session.step_index)};
  return {...publicView(session), steps, screenshot};
});
`,
      solution: `import Fastify from 'fastify';

import {publicUrl, signScreenshot} from 'browser/screenshots';
import {loadSession, publicView} from 'browser/sessions';
import {readTrace} from 'browser/trace';

export const app = Fastify();

export const TRACE_LIMIT = 50;
export const SCREENSHOT_TTL_S = 900;

app.get('/v1/browser/sessions/:sessionId', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'X-Tenant-Id is required'});
  const {sessionId} = request.params as {sessionId: string};
  const session = await loadSession(sessionId);
  // Another tenant's session answers exactly like a missing one: the id confirms nothing.
  if (session === null || session.tenant !== tenant) return reply.code(404).send({error: 'no such session'});
  const steps = (await readTrace(sessionId)).slice(-TRACE_LIMIT);
  const screenshot = signScreenshot(sessionId, session.step_index, SCREENSHOT_TTL_S);
  return {...publicView(session), steps, screenshot};
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"net/http"

	"browser/screenshots" // screenshots.PublicURL, SignScreenshot
	"browser/sessions"    // sessions.LoadSession, PublicView
	"browser/trace"       // trace.ReadTrace
)

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func readSession(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has three flaws. The task says where to look; the checks say what must change.
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "X-Tenant-Id is required"})
		return
	}
	sessionID := r.PathValue("id")
	session := sessions.LoadSession(r.Context(), sessionID)
	if session == nil {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "no such session"})
		return
	}
	steps, err := trace.ReadTrace(r.Context(), sessionID)
	if err != nil {
		writeJSON(rw, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	view := sessions.PublicView(session)
	view["steps"] = steps
	view["screenshot"] = map[string]string{"url": screenshots.PublicURL(sessionID, session.StepIndex)}
	writeJSON(rw, http.StatusOK, view)
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/browser/sessions/{id}", readSession)
}
`,
      solution: `package main

import (
	"encoding/json"
	"net/http"

	"browser/screenshots" // screenshots.PublicURL, SignScreenshot
	"browser/sessions"    // sessions.LoadSession, PublicView
	"browser/trace"       // trace.ReadTrace
)

const (
	traceLimit     = 50
	screenshotTTLS = 900
)

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func readSession(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "X-Tenant-Id is required"})
		return
	}
	sessionID := r.PathValue("id")
	session := sessions.LoadSession(r.Context(), sessionID)
	// Another tenant's session answers exactly like a missing one: the id confirms nothing.
	if session == nil || session.Tenant != tenant {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "no such session"})
		return
	}
	steps, err := trace.ReadTrace(r.Context(), sessionID)
	if err != nil {
		writeJSON(rw, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	if len(steps) > traceLimit {
		steps = steps[len(steps)-traceLimit:]
	}
	view := sessions.PublicView(session)
	view["steps"] = steps
	view["screenshot"] = screenshots.SignScreenshot(sessionID, session.StepIndex, screenshotTTLS)
	writeJSON(rw, http.StatusOK, view)
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/browser/sessions/{id}", readSession)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import browser.Screenshots // Screenshots.publicUrl, signScreenshot
import browser.Sessions    // Sessions.loadSession, publicView
import browser.Trace       // Trace.readTrace

object Read {
  private def json(status: StatusCode, body: JsObject): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  private def error(status: StatusCode, message: String): HttpResponse = json(status, JsObject("error" -> JsString(message)))

  def read(tenant: String, sessionId: String): HttpResponse =
    // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
    Sessions.loadSession(sessionId) match {
      case None => error(StatusCodes.NotFound, "no such session")
      case Some(session) =>
        val steps = Trace.readTrace(sessionId)
        val screenshot = JsObject("url" -> JsString(Screenshots.publicUrl(sessionId, session.stepIndex)))
        json(StatusCodes.OK, JsObject(Sessions.publicView(session).fields ++ Map("steps" -> JsArray(steps.toVector), "screenshot" -> screenshot)))
    }

  val route: Route = path("v1" / "browser" / "sessions" / Segment) { sessionId =>
    get {
      optionalHeaderValueByName("X-Tenant-Id") { tenant =>
        tenant.filter(_.nonEmpty) match {
          case None => complete(error(StatusCodes.Unauthorized, "X-Tenant-Id is required"))
          case Some(t) => complete(read(t, sessionId))
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

import browser.Screenshots // Screenshots.publicUrl, signScreenshot
import browser.Sessions    // Sessions.loadSession, publicView
import browser.Trace       // Trace.readTrace

object Read {
  val TraceLimit = 50
  val ScreenshotTtlS = 900L

  private def json(status: StatusCode, body: JsObject): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  private def error(status: StatusCode, message: String): HttpResponse = json(status, JsObject("error" -> JsString(message)))

  def read(tenant: String, sessionId: String): HttpResponse =
    // Another tenant's session answers exactly like a missing one: the id confirms nothing.
    Sessions.loadSession(sessionId).filter(_.tenant == tenant) match {
      case None => error(StatusCodes.NotFound, "no such session")
      case Some(session) =>
        val steps = Trace.readTrace(sessionId).takeRight(TraceLimit)
        val shot = Screenshots.signScreenshot(sessionId, session.stepIndex, ScreenshotTtlS)
        val screenshot = JsObject("url" -> JsString(shot.url), "expires_at" -> JsNumber(shot.expiresAt))
        json(StatusCodes.OK, JsObject(Sessions.publicView(session).fields ++ Map("steps" -> JsArray(steps.toVector), "screenshot" -> screenshot)))
    }

  val route: Route = path("v1" / "browser" / "sessions" / Segment) { sessionId =>
    get {
      optionalHeaderValueByName("X-Tenant-Id") { tenant =>
        tenant.filter(_.nonEmpty) match {
          case None => complete(error(StatusCodes.Unauthorized, "X-Tenant-Id is required"))
          case Some(t) => complete(read(t, sessionId))
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

#include "browser/screenshots.h"  // screenshots::publicUrl, signScreenshot
#include "browser/sessions.h"     // sessions::loadSession, publicView
#include "browser/trace.h"        // trace::readTrace

using json = nlohmann::json;

void fail(httplib::Response& res, int status, const std::string& message) {
  res.status = status;
  res.set_content(json{{"error", message}}.dump(), "application/json");
}

void read_session(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) return fail(res, 401, "X-Tenant-Id is required");
  const std::string session_id = req.matches[1];
  const auto session = sessions::loadSession(session_id);
  if (!session) return fail(res, 404, "no such session");
  const std::vector<json> steps = trace::readTrace(session_id);
  json view = sessions::publicView(*session);
  view["steps"] = steps;
  view["screenshot"] = json{{"url", screenshots::publicUrl(session_id, session->step_index)}};
  res.set_content(view.dump(), "application/json");
}

void register_routes(httplib::Server& svr) { svr.Get(R"(/v1/browser/sessions/([\\w-]+))", read_session); }
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <string>
#include <vector>

#include "browser/screenshots.h"  // screenshots::publicUrl, signScreenshot
#include "browser/sessions.h"     // sessions::loadSession, publicView
#include "browser/trace.h"        // trace::readTrace

using json = nlohmann::json;

constexpr long kTraceLimit = 50;
constexpr long long kScreenshotTtlS = 900;

void fail(httplib::Response& res, int status, const std::string& message) {
  res.status = status;
  res.set_content(json{{"error", message}}.dump(), "application/json");
}

void read_session(const httplib::Request& req, httplib::Response& res) {
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) return fail(res, 401, "X-Tenant-Id is required");
  const std::string session_id = req.matches[1];
  const auto session = sessions::loadSession(session_id);
  // Another tenant's session answers exactly like a missing one: the id confirms nothing.
  if (!session || session->tenant != tenant) return fail(res, 404, "no such session");
  std::vector<json> steps = trace::readTrace(session_id);
  if (static_cast<long>(steps.size()) > kTraceLimit) steps.erase(steps.begin(), steps.end() - kTraceLimit);
  const screenshots::Shot shot = screenshots::signScreenshot(session_id, session->step_index, kScreenshotTtlS);
  json view = sessions::publicView(*session);
  view["steps"] = steps;
  view["screenshot"] = json{{"url", shot.url}, {"expires_at", shot.expires_at}};
  res.set_content(view.dump(), "application/json");
}

void register_routes(httplib::Server& svr) { svr.Get(R"(/v1/browser/sessions/([\\w-]+))", read_session); }
`,
    },
  },
  harness: {
    python: `import time

from browser import screenshots, sessions, trace


def _world(ctx, steps=3):
    sid = sessions.create_session("acme", "public-web", "buy a kettle", 200, "https://www.example.com/")["session_id"]
    for index in range(1, steps + 1):
        trace.append_step(sid, {"session_id": sid, "step_index": index, "action": "click", "outcome": "ok", "reason": "", "target_digest": trace.digest(f"#b{index}")})
    ctx.redis.hset(sessions.session_key(sid), mapping={"step_index": steps, "budget_remaining": 200 - steps})
    return ctx.client(ctx.load("read").app), sid


async def _get(c, sid, tenant="acme"):
    return await c.get(f"/v1/browser/sessions/{sid}", headers={"X-Tenant-Id": tenant} if tenant else {})


async def check_route(ctx):
    c, sid = _world(ctx)
    async with c:
        r = await _get(c, sid)
        assert r.status_code == 200, f"GET /v1/browser/sessions/{sid} answered {r.status_code}: {r.text}"
        body = r.json()
        assert body.get("session_id") == sid and body.get("budget_remaining") == 197, f"the read must answer the session's view (budget_remaining 197), got {body}"
        assert [s.get("step_index") for s in body.get("steps", [])] == [1, 2, 3], f"the read must answer the trace, got steps {body.get('steps')}"
        assert body.get("screenshot", {}).get("url"), f"the read must answer a screenshot reference, got {body.get('screenshot')}"
        r = await _get(c, sid, tenant=None)
    assert r.status_code == 401, f"a read without X-Tenant-Id answered {r.status_code}, expected 401"


async def check_tenant_scope(ctx):
    c, sid = _world(ctx)
    async with c:
        foreign = await _get(c, sid, tenant="globex")
        missing = await _get(c, "s-404", tenant="globex")
    assert foreign.status_code == 404, f"tenant globex read acme's session {sid} and got {foreign.status_code}: {foreign.text[:200]}. A foreign session must be 404"
    assert foreign.text == missing.text, f"a foreign session answered {foreign.text!r} and a missing one {missing.text!r}: they must be indistinguishable"


async def check_trace_bounded(ctx):
    c, sid = _world(ctx, steps=60)
    async with c:
        r = await _get(c, sid)
    assert r.status_code == 200, f"the read answered {r.status_code}: {r.text[:200]}"
    indexes = [s.get("step_index") for s in r.json().get("steps", [])]
    assert indexes == list(range(11, 61)), f"a 60-step session answered {len(indexes)} steps ({indexes[:3]}…{indexes[-3:]}): it must answer the last TRACE_LIMIT = 50, steps 11 to 60 in order"


async def check_screenshot_expiry(ctx):
    c, sid = _world(ctx)
    async with c:
        first = (await _get(c, sid)).json().get("screenshot", {})
        now = int(time.time())
        assert "expires_at" in first, f"the screenshot reference {first} has no expires_at: a permanent URL is a read credential for life"
        assert 0 < first["expires_at"] - now <= 900, f"the screenshot expires {first['expires_at'] - now} s from now, expected at most SCREENSHOT_TTL_S = 900"
        assert screenshots.verify(first["url"], now), f"the screenshot store refuses {first['url']}: sign it with sign_screenshot"
        assert not screenshots.verify(first["url"], now + 901), "the screenshot URL still works 901 s later"
        ctx.clock.advance(600)
        second = (await _get(c, sid)).json().get("screenshot", {})
    assert second.get("expires_at", 0) > first["expires_at"], f"a read 600 s later answered the same expiry {second.get('expires_at')}: sign the reference on every read"
`,
    typescript: `async function world(ctx, steps = 3) {
  const sessions = ctx.load('/support/browser/sessions.ts');
  const trace = ctx.load('/support/browser/trace.ts');
  const sid = (await sessions.createSession('acme', 'public-web', 'buy a kettle', 200, 'https://www.example.com/')).session_id;
  for (let index = 1; index <= steps; index++) {
    await trace.appendStep(sid, {session_id: sid, step_index: index, action: 'click', outcome: 'ok', reason: '', target_digest: trace.digest(\`#b\${index}\`)});
  }
  ctx.redis.hset(sessions.sessionKey(sid), {step_index: String(steps), budget_remaining: String(200 - steps)});
  return {c: ctx.client(ctx.load('read').app), sid};
}

const get = (c, sid: string, tenant: string | null = 'acme') =>
  c.get(\`/v1/browser/sessions/\${sid}\`, {headers: tenant ? {'X-Tenant-Id': tenant} : {}});

export async function check_route(ctx) {
  const {c, sid} = await world(ctx);
  let r = await get(c, sid);
  assert.equal(r.status, 200, \`GET /v1/browser/sessions/\${sid} answered \${r.status}: \${r.text}\`);
  const body = r.json();
  assert(body.session_id === sid && body.budget_remaining === 197, \`the read must answer the session's view (budget_remaining 197), got \${r.text}\`);
  assert.deepStrictEqual((body.steps ?? []).map(s => s.step_index), [1, 2, 3], \`the read must answer the trace, got steps \${JSON.stringify(body.steps)}\`);
  assert(body.screenshot?.url, \`the read must answer a screenshot reference, got \${JSON.stringify(body.screenshot)}\`);
  r = await get(c, sid, null);
  assert.equal(r.status, 401, \`a read without X-Tenant-Id answered \${r.status}, expected 401\`);
}

export async function check_tenant_scope(ctx) {
  const {c, sid} = await world(ctx);
  const foreign = await get(c, sid, 'globex');
  const missing = await get(c, 's-404', 'globex');
  assert.equal(foreign.status, 404, \`tenant globex read acme's session \${sid} and got \${foreign.status}: \${foreign.text.slice(0, 200)}. A foreign session must be 404\`);
  assert.equal(foreign.text, missing.text, \`a foreign session answered \${foreign.text} and a missing one \${missing.text}: they must be indistinguishable\`);
}

export async function check_trace_bounded(ctx) {
  const {c, sid} = await world(ctx, 60);
  const r = await get(c, sid);
  assert.equal(r.status, 200, \`the read answered \${r.status}: \${r.text.slice(0, 200)}\`);
  const indexes = (r.json().steps ?? []).map(s => s.step_index);
  const want = Array.from({length: 50}, (_, i) => i + 11);
  assert.deepStrictEqual(indexes, want, \`a 60-step session answered \${indexes.length} steps: it must answer the last TRACE_LIMIT = 50, steps 11 to 60 in order\`);
}

export async function check_screenshot_expiry(ctx) {
  const {c, sid} = await world(ctx);
  const {verify} = ctx.load('/support/browser/screenshots.ts');
  const first = (await get(c, sid)).json().screenshot ?? {};
  const now = Math.floor(ctx.clock.now() / 1000);
  assert(typeof first.expires_at === 'number', \`the screenshot reference \${JSON.stringify(first)} has no expires_at: a permanent URL is a read credential for life\`);
  assert(first.expires_at - now > 0 && first.expires_at - now <= 900, \`the screenshot expires \${first.expires_at - now} s from now, expected at most SCREENSHOT_TTL_S = 900\`);
  assert(verify(first.url, now), \`the screenshot store refuses \${first.url}: sign it with signScreenshot\`);
  assert(!verify(first.url, now + 901), 'the screenshot URL still works 901 s later');
  ctx.clock.advance(600);
  const second = (await get(c, sid)).json().screenshot ?? {};
  assert((second.expires_at ?? 0) > first.expires_at, \`a read 600 s later answered the same expiry \${second.expires_at}: sign the reference on every read\`);
}
`,
    go: `package main

import (
	"context"
	"fmt"
	"net/http"

	"browser/screenshots"
	"browser/sessions"
	"browser/trace"

	"leetbuild/harness"
)

var readBg = context.Background()

func world(ctx *harness.Ctx, steps int) (*harness.HTTP, string) {
	sid := sessions.CreateSession(readBg, "acme", "public-web", "buy a kettle", 200, "https://www.example.com/").ID
	for index := 1; index <= steps; index++ {
		trace.AppendStep(readBg, sid, map[string]any{"session_id": sid, "step_index": index, "action": "click", "outcome": "ok", "reason": "", "target_digest": trace.Digest(fmt.Sprintf("#b%d", index))})
	}
	ctx.Redis.Do("HSET", sessions.SessionKey(sid), "step_index", fmt.Sprint(steps), "budget_remaining", fmt.Sprint(200-steps))
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux), sid
}

type readView struct {
	SessionID       string \`json:"session_id"\`
	BudgetRemaining int    \`json:"budget_remaining"\`
	Steps           []struct {
		StepIndex int \`json:"step_index"\`
	} \`json:"steps"\`
	Screenshot struct {
		URL       string \`json:"url"\`
		ExpiresAt int64  \`json:"expires_at"\`
	} \`json:"screenshot"\`
}

func read(c *harness.HTTP, sid, tenant string) (*harness.Response, readView) {
	r := c.Get("/v1/browser/sessions/"+sid, "X-Tenant-Id", tenant)
	var v readView
	if r.Status == 200 {
		r.Decode(&v)
	}
	return r, v
}

func indexes(v readView) []int {
	out := []int{}
	for _, s := range v.Steps {
		out = append(out, s.StepIndex)
	}
	return out
}

func CheckRoute(ctx *harness.Ctx) {
	c, sid := world(ctx, 3)
	r, v := read(c, sid, "acme")
	ctx.Equal(r.Status, 200, "GET /v1/browser/sessions/%s (%s)", sid, r.Text())
	ctx.Assert(v.SessionID == sid && v.BudgetRemaining == 197, "the read must answer the session's view (budget_remaining 197), got %s", r.Text())
	ctx.Equal(indexes(v), []int{1, 2, 3}, "the read must answer the trace; steps")
	ctx.Assert(v.Screenshot.URL != "", "the read must answer a screenshot reference, got %s", r.Text())
	r = c.Get("/v1/browser/sessions/" + sid)
	ctx.Equal(r.Status, 401, "a read without X-Tenant-Id")
}

func CheckTenantScope(ctx *harness.Ctx) {
	c, sid := world(ctx, 3)
	foreign, _ := read(c, sid, "globex")
	missing, _ := read(c, "s-404", "globex")
	ctx.Equal(foreign.Status, 404, "tenant globex read acme's session %s: a foreign session must be 404 (%s)", sid, foreign.Text())
	ctx.Equal(foreign.Text(), missing.Text(), "a foreign session and a missing one must be indistinguishable; the body")
}

func CheckTraceBounded(ctx *harness.Ctx) {
	c, sid := world(ctx, 60)
	r, v := read(c, sid, "acme")
	ctx.Equal(r.Status, 200, "the read (%s)", r.Text())
	want := []int{}
	for i := 11; i <= 60; i++ {
		want = append(want, i)
	}
	ctx.Equal(indexes(v), want, "a 60-step session must answer the last traceLimit = 50 steps, 11 to 60 in order; steps")
}

func CheckScreenshotExpiry(ctx *harness.Ctx) {
	c, sid := world(ctx, 3)
	_, first := read(c, sid, "acme")
	now := ctx.Clock.Now() / 1000
	ctx.Assert(first.Screenshot.ExpiresAt > 0, "the screenshot reference has no expires_at: a permanent URL is a read credential for life")
	ctx.Assert(first.Screenshot.ExpiresAt-now > 0 && first.Screenshot.ExpiresAt-now <= 900, "the screenshot expires %d s from now, expected at most screenshotTTLS = 900", first.Screenshot.ExpiresAt-now)
	ctx.Assert(screenshots.Verify(first.Screenshot.URL, now), "the screenshot store refuses %s: sign it with SignScreenshot", first.Screenshot.URL)
	ctx.Assert(!screenshots.Verify(first.Screenshot.URL, now+901), "the screenshot URL still works 901 s later")
	ctx.Clock.Advance(600)
	_, second := read(c, sid, "acme")
	ctx.Assert(second.Screenshot.ExpiresAt > first.Screenshot.ExpiresAt, "a read 600 s later answered the same expiry %d: sign the reference on every read", second.Screenshot.ExpiresAt)
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <string>
#include <vector>

#include "browser/screenshots.h"
#include "browser/sessions.h"
#include "browser/trace.h"

namespace {

struct World {
  harness::HTTP c;
  std::string sid;
};

World world(harness::Ctx& ctx, long steps) {
  static httplib::Server* svr = nullptr;
  delete svr;
  svr = new httplib::Server;
  register_routes(*svr);
  const std::string sid = sessions::createSession("acme", "public-web", "buy a kettle", 200, "https://www.example.com/").session_id;
  for (long index = 1; index <= steps; index++) {
    trace::appendStep(sid, {{"session_id", sid}, {"step_index", index}, {"action", "click"}, {"outcome", "ok"}, {"reason", ""}, {"target_digest", trace::digest("#b" + std::to_string(index))}});
  }
  ctx.Redis.Do("HSET", sessions::sessionKey(sid), "step_index", std::to_string(steps), "budget_remaining", std::to_string(200 - steps));
  return World{ctx.HTTP(*svr), sid};
}

nlohmann::json bodyOf(const harness::Response& r) {
  const auto v = nlohmann::json::parse(r.Text(), nullptr, false);
  return v.is_object() ? v : nlohmann::json::object();
}

std::vector<long> indexes(const nlohmann::json& body) {
  std::vector<long> out;
  if (body.contains("steps") && body["steps"].is_array()) {
    for (const auto& s : body["steps"]) out.push_back(s.value("step_index", 0L));
  }
  return out;
}

}  // namespace

void CheckRoute(harness::Ctx& ctx) {
  auto w = world(ctx, 3);
  auto r = w.c.Get("/v1/browser/sessions/" + w.sid, "X-Tenant-Id", "acme");
  ctx.Equal(r.Status, 200, "GET /v1/browser/sessions/%s (%s)", w.sid, r.Text());
  const auto body = bodyOf(r);
  ctx.Assert(body.value("session_id", "") == w.sid && body.value("budget_remaining", 0L) == 197, "the read must answer the session's view (budget_remaining 197), got %s", r.Text());
  ctx.Equal(indexes(body), std::vector<long>{1, 2, 3}, "the read must answer the trace; steps");
  ctx.Assert(body.contains("screenshot") && !body["screenshot"].value("url", "").empty(), "the read must answer a screenshot reference, got %s", r.Text());
  r = w.c.Get("/v1/browser/sessions/" + w.sid);
  ctx.Equal(r.Status, 401, "a read without X-Tenant-Id");
}

void CheckTenantScope(harness::Ctx& ctx) {
  auto w = world(ctx, 3);
  const auto foreign = w.c.Get("/v1/browser/sessions/" + w.sid, "X-Tenant-Id", "globex");
  const auto missing = w.c.Get("/v1/browser/sessions/s-404", "X-Tenant-Id", "globex");
  ctx.Equal(foreign.Status, 404, "tenant globex read acme's session %s: a foreign session must be 404 (%s)", w.sid, foreign.Text());
  ctx.Equal(foreign.Text(), missing.Text(), "a foreign session and a missing one must be indistinguishable; the body");
}

void CheckTraceBounded(harness::Ctx& ctx) {
  auto w = world(ctx, 60);
  const auto r = w.c.Get("/v1/browser/sessions/" + w.sid, "X-Tenant-Id", "acme");
  ctx.Equal(r.Status, 200, "the read (%s)", r.Text());
  std::vector<long> want;
  for (long i = 11; i <= 60; i++) want.push_back(i);
  ctx.Equal(indexes(bodyOf(r)), want, "a 60-step session must answer the last kTraceLimit = 50 steps, 11 to 60 in order; steps");
}

void CheckScreenshotExpiry(harness::Ctx& ctx) {
  auto w = world(ctx, 3);
  const auto first = bodyOf(w.c.Get("/v1/browser/sessions/" + w.sid, "X-Tenant-Id", "acme")).value("screenshot", nlohmann::json::object());
  const long long now = ctx.Clock.Now() / 1000;
  const long long expires = first.value("expires_at", 0LL);
  ctx.Assert(expires > 0, "the screenshot reference %s has no expires_at: a permanent URL is a read credential for life", first.dump());
  ctx.Assert(expires - now > 0 && expires - now <= 900, "the screenshot expires %d s from now, expected at most kScreenshotTtlS = 900", expires - now);
  ctx.Assert(screenshots::verify(first.value("url", ""), now), "the screenshot store refuses %s: sign it with signScreenshot", first.value("url", ""));
  ctx.Assert(!screenshots::verify(first.value("url", ""), now + 901), "the screenshot URL still works 901 s later");
  ctx.Clock.Advance(600);
  const auto second = bodyOf(w.c.Get("/v1/browser/sessions/" + w.sid, "X-Tenant-Id", "acme")).value("screenshot", nlohmann::json::object());
  ctx.Assert(second.value("expires_at", 0LL) > expires, "a read 600 s later answered the same expiry %d: sign the reference on every read", second.value("expires_at", 0LL));
}
`,
  },
  hints: [
    'Read a session with another tenant’s header: the whole trace comes back. Read a long session: every step comes back in one response. Open the screenshot URL a day later: it still works.',
    'The session is looked up by id alone and never compared with the caller’s tenant; `read_trace` is answered whole; `public_url` is the store’s permanent address, with no expiry and no signature.',
    '404 with the missing-id body when `session["tenant"] != tenant`; answer `read_trace(id)[-TRACE_LIMIT:]`; answer `sign_screenshot(id, session["step_index"], SCREENSHOT_TTL_S)` on every read.',
  ],
  debrief: `On the read path an id stops being a secret and becomes a guess, so ownership is checked on every read, and a foreign session looks exactly like a missing one: a 403 would confirm the id exists. The trace limit bounds a response by design rather than by the longest session anyone ran. A signed reference that expires turns the screenshot URL from a credential into a short-lived capability, and signing per read means a link pasted into a ticket stops working within fifteen minutes. Production replays page the trace with a cursor, sign with a rotated key the store verifies without a call, and log each replay as an access to the session.`,
};
