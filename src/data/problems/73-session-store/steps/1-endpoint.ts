import type {Step} from '@/lib/types';

export const endpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/sessions: a login mints a new session id',
  concept: 'http',
  guides: ['request-boundaries'],
  file: 'api',
  focus: ['client', 'api', 'redis'],
  task: `## Task

**Starting point.** The starter serves \`POST /v1/sessions\` on the session store (\`sessions.store\`,
provided). It reads the bearer token from \`Authorization\`, looks up what the login flow asserted
for it (\`store.assertion\`, **401** when there is nothing), takes \`device_class\` from the JSON body
when the client sent one, and writes the session with \`store.put_session\` under the id the client
presented in \`X-Session-Id\` (a fresh one otherwise). It answers **201**
\`{session_id, user_id, device_class}\`. It serves the demo and hides four flaws.

**Failure mode the checks target.** An attacker plants a session id in a victim's browser; the victim
logs in and the planted id is now signed in as the victim. The id the client held before the login
keeps working after it. A client labels its own device. A login stopped at the MFA prompt opens a
session.

- Every login mints a fresh id (\`store.new_session_id\`), never the one the client presented.
- The id in \`X-Session-Id\` is retired in the same request (\`store.retire_session\`).
- \`device_class\` is the assertion's; the body's label is ignored.
- Only an assertion whose \`status\` is \`"complete"\` opens a session; anything else is **401** and
  writes nothing.`,
  sequence: {
    participants: ['Client', 'Session API', 'Session store'],
    messages: [
      {from: 'Client', to: 'Session API', label: 'POST /v1/sessions · Bearer token · X-Session-Id', kind: 'sync'},
      {from: 'Session API', to: 'Session store', label: 'assertion(token) → user, device, status', kind: 'sync'},
      {from: 'Session API', to: 'Session API', label: 'status != "complete" → 401', kind: 'sync'},
      {from: 'Session API', to: 'Session store', label: 'put_session(new_session_id(), …)', kind: 'sync'},
      {from: 'Session API', to: 'Session store', label: 'retire_session(presented id)', kind: 'sync'},
      {from: 'Session API', to: 'Client', label: '201 {session_id, user_id, device_class}', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Registers POST /v1/sessions',
      detail: 'A login with a complete assertion answers 201 with a session the store can read.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/sessions["']/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/sessions['"]/]},
        go: {all: [/HandleFunc\(\s*"POST \/v1\/sessions"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"sessions"\s*\)/, /\bpost\b/]},
        cpp: {all: [/svr\.Post\(\s*"\/v1\/sessions"/]},
      },
    },
    {
      id: 'rotate',
      title: 'A login mints a fresh session id',
      detail:
        'The session id comes from `new_session_id`/`newSessionId`, never from `X-Session-Id`: a login on a planted id answers another id, and the planted one does not belong to the user. The starter writes the session under the id the client presented.',
      match: {
        python: {all: [/session_id\s*=\s*store\.new_session_id\(\)/], none: [/x-session-id["']\s*\)\s*or\b/i]},
        typescript: {all: [/sessionId\s*=\s*newSessionId\(\)/], none: [/x-session-id['"]\][^;\n]*\|\|/i]},
        go: {
          all: [/sessionID\s*:=\s*store\.NewSessionID\(\)/],
          none: [/sessionID\s*:=\s*r\.Header\.Get\(\s*"X-Session-Id"/],
        },
        scala: {all: [/sessionId\s*=\s*Store\.newSessionId\(\)/], none: [/getOrElse\(Store\.newSessionId\(\)\)/]},
        cpp: {
          all: [/session_id\s*=\s*store::newSessionId\(\)/],
          none: [/session_id\s*=\s*req\.get_header_value\(\s*"X-Session-Id"/],
        },
      },
    },
    {
      id: 'invalidate-old',
      title: 'The presented id is retired in the same request',
      detail:
        "After the login the id from `X-Session-Id` no longer reads and is gone from the user's set (`retire_session`/`retireSession`). The starter leaves it live.",
      match: {
        python: {all: [/store\.retire_session\(/]},
        typescript: {all: [/\bretireSession\(/]},
        go: {all: [/store\.RetireSession\(/]},
        scala: {all: [/Store\.retireSession\(/]},
        cpp: {all: [/store::retireSession\(/]},
      },
    },
    {
      id: 'device-from-token',
      title: 'The device class comes from the assertion',
      detail:
        'A body that labels the device `desktop` on a login the assertion saw from `mobile` is stored and answered as `mobile`. The starter prefers the body.',
      match: {
        python: {
          all: [/device_class\s*=\s*claims\[["']device_class["']\]/],
          none: [/body\.get\(\s*["']device_class["']/],
        },
        typescript: {all: [/deviceClass\s*=\s*claims\.device_class/], none: [/body\.device_class/]},
        go: {all: [/deviceClass\s*:=\s*claims\.DeviceClass/], none: [/body\.DeviceClass/]},
        scala: {all: [/deviceClass\s*=\s*claims\.deviceClass/], none: [/getOrElse\(claims\.deviceClass\)/]},
        cpp: {all: [/std::string device_class\s*=\s*claims->device_class/], none: [/body\.value\(\s*"device_class"/]},
      },
    },
    {
      id: 'auth-assertion',
      title: 'Only a complete assertion opens a session',
      detail:
        'An assertion whose `status` is not `"complete"` (MFA still pending) is **401** and writes no session. The starter accepts any assertion that exists.',
      match: {
        python: {all: [/["']complete["']/, /\b401\b/]},
        typescript: {all: [/['"]complete['"]/, /\b401\b/]},
        go: {all: [/"complete"/, /StatusUnauthorized/]},
        scala: {all: [/"complete"/, /Unauthorized/]},
        cpp: {all: [/"complete"/, /\b401\b/]},
      },
    },
  ],
  code: {
    python: {
      starter: `from fastapi import FastAPI, HTTPException, Request

from sessions import store  # assertion, new_session_id, put_session, retire_session

app = FastAPI()


@app.post("/v1/sessions", status_code=201)
async def create_session(request: Request) -> dict:
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    token = request.headers.get("authorization", "").removeprefix("Bearer ").strip()
    claims = store.assertion(token)
    if claims is None:
        raise HTTPException(status_code=401, detail="no auth assertion for this token")
    body = await request.json() if await request.body() else {}
    device_class = body.get("device_class") or claims["device_class"]
    session_id = request.headers.get("x-session-id") or store.new_session_id()
    store.put_session(session_id, claims["user_id"], device_class, token)
    return {"session_id": session_id, "user_id": claims["user_id"], "device_class": device_class}
`,
      solution: `from fastapi import FastAPI, HTTPException, Request

from sessions import store  # assertion, new_session_id, put_session, retire_session

app = FastAPI()


@app.post("/v1/sessions", status_code=201)
async def create_session(request: Request) -> dict:
    token = request.headers.get("authorization", "").removeprefix("Bearer ").strip()
    claims = store.assertion(token)
    # A login stopped before its last factor is not a login.
    if claims is None or claims["status"] != "complete":
        raise HTTPException(status_code=401, detail="no completed auth assertion for this token")
    # What the login flow saw, not what the client says about itself.
    device_class = claims["device_class"]
    old_id = request.headers.get("x-session-id")
    # The server picks the id when privilege changes: nothing chosen before the login carries it.
    session_id = store.new_session_id()
    store.put_session(session_id, claims["user_id"], device_class, token)
    if old_id:
        store.retire_session(old_id)
    return {"session_id": session_id, "user_id": claims["user_id"], "device_class": device_class}
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';

import {assertion, newSessionId, putSession, retireSession} from 'sessions/store';

export const app = Fastify();

app.post('/v1/sessions', async (request, reply) => {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const token = (request.headers.authorization ?? '').replace(/^Bearer /, '').trim();
  const claims = await assertion(token);
  if (claims === null) return reply.code(401).send({error: 'no auth assertion for this token'});
  const body = (request.body ?? {}) as {device_class?: string};
  const deviceClass = body.device_class || claims.device_class;
  const sessionId = (request.headers['x-session-id'] as string | undefined) || newSessionId();
  await putSession(sessionId, claims.user_id, deviceClass, token);
  return reply.code(201).send({session_id: sessionId, user_id: claims.user_id, device_class: deviceClass});
});
`,
      solution: `import Fastify from 'fastify';

import {assertion, newSessionId, putSession, retireSession} from 'sessions/store';

export const app = Fastify();

app.post('/v1/sessions', async (request, reply) => {
  const token = (request.headers.authorization ?? '').replace(/^Bearer /, '').trim();
  const claims = await assertion(token);
  // A login stopped before its last factor is not a login.
  if (claims === null || claims.status !== 'complete') {
    return reply.code(401).send({error: 'no completed auth assertion for this token'});
  }
  // What the login flow saw, not what the client says about itself.
  const deviceClass = claims.device_class;
  const oldId = request.headers['x-session-id'] as string | undefined;
  // The server picks the id when privilege changes: nothing chosen before the login carries it.
  const sessionId = newSessionId();
  await putSession(sessionId, claims.user_id, deviceClass, token);
  if (oldId) await retireSession(oldId);
  return reply.code(201).send({session_id: sessionId, user_id: claims.user_id, device_class: deviceClass});
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"net/http"
	"strings"

	"sessions/store" // store.AssertionFor, NewSessionID, PutSession, RetireSession
)

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func createSession(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	token := strings.TrimSpace(strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "))
	claims := store.AssertionFor(r.Context(), token)
	if claims == nil {
		http.Error(rw, "no auth assertion for this token", http.StatusUnauthorized)
		return
	}
	var body struct {
		DeviceClass string \`json:"device_class"\`
	}
	json.NewDecoder(r.Body).Decode(&body)
	deviceClass := body.DeviceClass
	if deviceClass == "" {
		deviceClass = claims.DeviceClass
	}
	sessionID := r.Header.Get("X-Session-Id")
	if sessionID == "" {
		sessionID = store.NewSessionID()
	}
	if err := store.PutSession(r.Context(), sessionID, claims.UserID, deviceClass, token); err != nil {
		http.Error(rw, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(rw, http.StatusCreated, map[string]string{"session_id": sessionID, "user_id": claims.UserID, "device_class": deviceClass})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/sessions", createSession)
}
`,
      solution: `package main

import (
	"encoding/json"
	"net/http"
	"strings"

	"sessions/store" // store.AssertionFor, NewSessionID, PutSession, RetireSession
)

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func createSession(rw http.ResponseWriter, r *http.Request) {
	token := strings.TrimSpace(strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "))
	claims := store.AssertionFor(r.Context(), token)
	// A login stopped before its last factor is not a login.
	if claims == nil || claims.Status != "complete" {
		http.Error(rw, "no completed auth assertion for this token", http.StatusUnauthorized)
		return
	}
	// What the login flow saw, not what the client says about itself.
	deviceClass := claims.DeviceClass
	oldID := r.Header.Get("X-Session-Id")
	// The server picks the id when privilege changes: nothing chosen before the login carries it.
	sessionID := store.NewSessionID()
	if err := store.PutSession(r.Context(), sessionID, claims.UserID, deviceClass, token); err != nil {
		http.Error(rw, err.Error(), http.StatusInternalServerError)
		return
	}
	if oldID != "" {
		if err := store.RetireSession(r.Context(), oldID); err != nil {
			http.Error(rw, err.Error(), http.StatusInternalServerError)
			return
		}
	}
	writeJSON(rw, http.StatusCreated, map[string]string{"session_id": sessionID, "user_id": claims.UserID, "device_class": deviceClass})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/sessions", createSession)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import sessions.Store // Store.assertion, newSessionId, putSession, retireSession

object Api {
  private def created(sessionId: String, userId: String, deviceClass: String): HttpResponse = {
    val body = JsObject("session_id" -> JsString(sessionId), "user_id" -> JsString(userId), "device_class" -> JsString(deviceClass))
    HttpResponse(StatusCodes.Created, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))
  }

  /** The device_class label of a request body, if it carries one. */
  private def label(raw: String): Option[String] =
    if (raw.trim.isEmpty) None
    else raw.parseJson.asJsObject.fields.get("device_class").collect { case JsString(s) => s }

  val route: Route = path("v1" / "sessions") {
    post {
      optionalHeaderValueByName("Authorization") { authorization =>
        optionalHeaderValueByName("X-Session-Id") { presented =>
          entity(as[String]) { raw =>
            // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
            val token = authorization.getOrElse("").stripPrefix("Bearer ").trim
            Store.assertion(token) match {
              case None => complete(StatusCodes.Unauthorized -> "no auth assertion for this token")
              case Some(claims) =>
                val deviceClass = label(raw).filter(_.nonEmpty).getOrElse(claims.deviceClass)
                val sessionId = presented.filter(_.nonEmpty).getOrElse(Store.newSessionId())
                Store.putSession(sessionId, claims.userId, deviceClass, token)
                complete(created(sessionId, claims.userId, deviceClass))
            }
          }
        }
      }
    }
  }
}
`,
      solution: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import sessions.Store // Store.assertion, newSessionId, putSession, retireSession

object Api {
  private def created(sessionId: String, userId: String, deviceClass: String): HttpResponse = {
    val body = JsObject("session_id" -> JsString(sessionId), "user_id" -> JsString(userId), "device_class" -> JsString(deviceClass))
    HttpResponse(StatusCodes.Created, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))
  }

  val route: Route = path("v1" / "sessions") {
    post {
      optionalHeaderValueByName("Authorization") { authorization =>
        optionalHeaderValueByName("X-Session-Id") { presented =>
          val token = authorization.getOrElse("").stripPrefix("Bearer ").trim
          Store.assertion(token) match {
            // A login stopped before its last factor is not a login.
            case Some(claims) if claims.status == "complete" =>
              // What the login flow saw, not what the client says about itself.
              val deviceClass = claims.deviceClass
              // The server picks the id when privilege changes: nothing chosen before the login carries it.
              val sessionId = Store.newSessionId()
              Store.putSession(sessionId, claims.userId, deviceClass, token)
              presented.filter(_.nonEmpty).foreach(id => Store.retireSession(id))
              complete(created(sessionId, claims.userId, deviceClass))
            case _ => complete(StatusCodes.Unauthorized -> "no completed auth assertion for this token")
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

#include <string>

#include "sessions/store.h"  // store::assertion, newSessionId, putSession, retireSession

using json = nlohmann::json;

void create_session(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  std::string token = req.get_header_value("Authorization");
  if (token.rfind("Bearer ", 0) == 0) token = token.substr(7);
  const auto claims = store::assertion(token);
  if (!claims) {
    res.status = 401;
    res.set_content("no auth assertion for this token", "text/plain");
    return;
  }
  const json body = json::parse(req.body.empty() ? "{}" : req.body, nullptr, false);
  std::string device_class = body.is_object() ? body.value("device_class", "") : "";
  if (device_class.empty()) device_class = claims->device_class;
  std::string session_id = req.get_header_value("X-Session-Id");
  if (session_id.empty()) session_id = store::newSessionId();
  store::putSession(session_id, claims->user_id, device_class, token);
  res.status = 201;
  res.set_content(json{{"session_id", session_id}, {"user_id", claims->user_id}, {"device_class", device_class}}.dump(), "application/json");
}

void register_routes(httplib::Server& svr) { svr.Post("/v1/sessions", create_session); }
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <string>

#include "sessions/store.h"  // store::assertion, newSessionId, putSession, retireSession

using json = nlohmann::json;

void create_session(const httplib::Request& req, httplib::Response& res) {
  std::string token = req.get_header_value("Authorization");
  if (token.rfind("Bearer ", 0) == 0) token = token.substr(7);
  const auto claims = store::assertion(token);
  // A login stopped before its last factor is not a login.
  if (!claims || claims->status != "complete") {
    res.status = 401;
    res.set_content("no completed auth assertion for this token", "text/plain");
    return;
  }
  // What the login flow saw, not what the client says about itself.
  const std::string device_class = claims->device_class;
  const std::string old_id = req.get_header_value("X-Session-Id");
  // The server picks the id when privilege changes: nothing chosen before the login carries it.
  const std::string session_id = store::newSessionId();
  store::putSession(session_id, claims->user_id, device_class, token);
  if (!old_id.empty()) store::retireSession(old_id);
  res.status = 201;
  res.set_content(json{{"session_id", session_id}, {"user_id", claims->user_id}, {"device_class", device_class}}.dump(), "application/json");
}

void register_routes(httplib::Server& svr) { svr.Post("/v1/sessions", create_session); }
`,
    },
  },
  harness: {
    python: `import time

from sessions import store

ASSERTIONS = {
    "tok-1": ("u-1", "mobile", "complete"),
    "tok-pending": ("u-1", "mobile", "mfa_pending"),
}


def _api(ctx):
    for token, (user_id, device_class, status) in ASSERTIONS.items():
        ctx.redis.hset(f"assertion:{token}", mapping={"user_id": user_id, "device_class": device_class, "status": status})
    return ctx.client(ctx.load("api").app)


def _headers(token=None, session_id=None):
    headers = {} if token is None else {"Authorization": f"Bearer {token}"}
    if session_id is not None:
        headers["X-Session-Id"] = session_id
    return headers


def _plant(ctx, session_id):
    """An anonymous pre-login session: the id a browser holds before anyone signs in, the one an attacker plants."""
    now = int(time.time())
    ctx.redis.hset(f"session:{session_id}", mapping={"user_id": "", "device_class": "web", "token_hash": "", "created_at": now, "last_seen": now, "rotation": 0})
    ctx.redis.expire(f"session:{session_id}", store.SLIDING_TTL_S)


async def _login(c, token="tok-1", session_id=None, body=None):
    r = await c.post("/v1/sessions", headers=_headers(token, session_id), json=body)
    assert r.status_code == 201, f"a login with a complete assertion answered {r.status_code}: {r.text}"
    return r.json()


async def check_route(ctx):
    async with _api(ctx) as c:
        body = await _login(c)
    session_id = body.get("session_id")
    assert session_id and body.get("user_id") == "u-1", f"the login answered {body}, expected a session_id and user_id u-1"
    record = store.read_session(session_id)
    assert record is not None and record["user_id"] == "u-1", f"the store has no session for u-1 under {session_id}: {record}"
    assert session_id in store.user_sessions("u-1"), f"u-1's set holds {store.user_sessions('u-1')}, expected {session_id}"


async def check_rotate(ctx):
    _plant(ctx, "planted-1")
    async with _api(ctx) as c:
        body = await _login(c, session_id="planted-1")
    session_id = body.get("session_id")
    assert session_id != "planted-1", "a login on X-Session-Id planted-1 answered planted-1: an id an attacker planted before the login is now signed in as u-1. Mint a fresh id at every login"
    planted = store.read_session("planted-1")
    assert planted is None or planted["user_id"] != "u-1", f"planted-1 now belongs to u-1: {planted}"
    record = store.read_session(session_id)
    assert record is not None and record["user_id"] == "u-1", f"the fresh id {session_id} must hold u-1's session, the store has {record}"


async def check_invalidate_old(ctx):
    _plant(ctx, "planted-1")
    async with _api(ctx) as c:
        first = await _login(c, session_id="planted-1")
        assert store.read_session("planted-1") is None, f"after the login the id the client presented (planted-1) still reads as {store.read_session('planted-1')}: retire it in the same request"
        old = first["session_id"]
        again = await _login(c, session_id=old)
    assert store.read_session(old) is None, f"a second login on {old} left it live: {store.read_session(old)}"
    ids = store.user_sessions("u-1")
    assert old not in ids and again["session_id"] in ids, f"u-1's set holds {ids}: the retired id must leave it, the new one must be in it"


async def check_device_from_token(ctx):
    async with _api(ctx) as c:
        body = await _login(c, body={"device_class": "desktop"})
    assert body.get("device_class") == "mobile", f"the login answered device_class {body.get('device_class')!r}: the assertion saw mobile, the body's label must not override it"
    record = store.read_session(body["session_id"])
    assert record is not None and record["device_class"] == "mobile", f"the stored session has device_class {record and record['device_class']!r}, expected the assertion's mobile"


async def check_auth_assertion(ctx):
    async with _api(ctx) as c:
        missing = await c.post("/v1/sessions")
        assert missing.status_code == 401, f"a login with no token answered {missing.status_code}, expected 401"
        pending = await c.post("/v1/sessions", headers=_headers("tok-pending"))
        assert pending.status_code == 401, f"a login whose assertion is still mfa_pending answered {pending.status_code}, expected 401: the second factor never passed"
        assert ctx.redis.keys("session:*") == [], f"the refused login wrote {ctx.redis.keys('session:*')}"
        await _login(c)
`,
    typescript: `function api(ctx) {
  ctx.redis.hset('assertion:tok-1', 'user_id', 'u-1', 'device_class', 'mobile', 'status', 'complete');
  ctx.redis.hset('assertion:tok-pending', 'user_id', 'u-1', 'device_class', 'mobile', 'status', 'mfa_pending');
  return {c: ctx.client(ctx.load('api').app), store: ctx.load('/support/sessions/store.ts')};
}

const headers = (token: string | null, sessionId: string | null = null): Record<string, string> => ({
  ...(token === null ? {} : {Authorization: \`Bearer \${token}\`}),
  ...(sessionId === null ? {} : {'X-Session-Id': sessionId}),
});

/** An anonymous pre-login session: the id a browser holds before anyone signs in, the one an attacker plants. */
function plant(ctx, sessionId: string): void {
  const now = String(Math.floor(ctx.clock.now() / 1000));
  ctx.redis.hset(\`session:\${sessionId}\`, 'user_id', '', 'device_class', 'web', 'token_hash', '', 'created_at', now, 'last_seen', now, 'rotation', '0');
  ctx.redis.expire(\`session:\${sessionId}\`, 900);
}

async function login(c, sessionId: string | null = null, body: Record<string, unknown> | null = null) {
  const r = await c.post('/v1/sessions', body === null ? {headers: headers('tok-1', sessionId)} : {headers: headers('tok-1', sessionId), json: body});
  assert.equal(r.status, 201, \`a login with a complete assertion answered \${r.status}: \${r.text}\`);
  return r.json();
}

export async function check_route(ctx) {
  const {c, store} = api(ctx);
  const body = await login(c);
  assert(body.session_id && body.user_id === 'u-1', \`the login answered \${JSON.stringify(body)}, expected a session_id and user_id u-1\`);
  const record = await store.readSession(body.session_id);
  assert(record !== null && record.user_id === 'u-1', \`the store has no session for u-1 under \${body.session_id}: \${JSON.stringify(record)}\`);
  const ids = await store.userSessions('u-1');
  assert(ids.includes(body.session_id), \`u-1's set holds \${JSON.stringify(ids)}, expected \${body.session_id}\`);
}

export async function check_rotate(ctx) {
  plant(ctx, 'planted-1');
  const {c, store} = api(ctx);
  const body = await login(c, 'planted-1');
  assert.notEqual(body.session_id, 'planted-1', 'a login on X-Session-Id planted-1 answered planted-1: an id an attacker planted before the login is now signed in as u-1. Mint a fresh id at every login');
  const planted = await store.readSession('planted-1');
  assert(planted === null || planted.user_id !== 'u-1', \`planted-1 now belongs to u-1: \${JSON.stringify(planted)}\`);
  const record = await store.readSession(body.session_id);
  assert(record !== null && record.user_id === 'u-1', \`the fresh id \${body.session_id} must hold u-1's session, the store has \${JSON.stringify(record)}\`);
}

export async function check_invalidate_old(ctx) {
  plant(ctx, 'planted-1');
  const {c, store} = api(ctx);
  const first = await login(c, 'planted-1');
  const planted = await store.readSession('planted-1');
  assert.equal(planted, null, \`after the login the id the client presented (planted-1) still reads as \${JSON.stringify(planted)}: retire it in the same request\`);
  const old = first.session_id;
  const again = await login(c, old);
  assert.equal(await store.readSession(old), null, \`a second login on \${old} left it live\`);
  const ids = await store.userSessions('u-1');
  assert(!ids.includes(old) && ids.includes(again.session_id), \`u-1's set holds \${JSON.stringify(ids)}: the retired id must leave it, the new one must be in it\`);
}

export async function check_device_from_token(ctx) {
  const {c, store} = api(ctx);
  const body = await login(c, null, {device_class: 'desktop'});
  assert.equal(body.device_class, 'mobile', \`the login answered device_class \${JSON.stringify(body.device_class)}: the assertion saw mobile, the body's label must not override it\`);
  const record = await store.readSession(body.session_id);
  assert(record !== null && record.device_class === 'mobile', \`the stored session has device_class \${JSON.stringify(record?.device_class)}, expected the assertion's mobile\`);
}

export async function check_auth_assertion(ctx) {
  const {c} = api(ctx);
  const missing = await c.post('/v1/sessions');
  assert.equal(missing.status, 401, \`a login with no token answered \${missing.status}, expected 401\`);
  const pending = await c.post('/v1/sessions', {headers: headers('tok-pending')});
  assert.equal(pending.status, 401, \`a login whose assertion is still mfa_pending answered \${pending.status}, expected 401: the second factor never passed\`);
  const written = ctx.redis.keys('session:*');
  assert.deepEqual(written, [], \`the refused login wrote \${JSON.stringify(written)}\`);
  await login(c);
}
`,
    go: `package main

import (
	"context"
	"fmt"
	"net/http"
	"slices"

	"sessions/store"

	"leetbuild/harness"
)

var bg = context.Background()

func api(ctx *harness.Ctx) *harness.HTTP {
	ctx.Redis.Do("HSET", "assertion:tok-1", "user_id", "u-1", "device_class", "mobile", "status", "complete")
	ctx.Redis.Do("HSET", "assertion:tok-pending", "user_id", "u-1", "device_class", "mobile", "status", "mfa_pending")
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

// plant writes an anonymous pre-login session: the id a browser holds before anyone signs in, the one an attacker plants.
func plant(ctx *harness.Ctx, sessionID string) {
	now := ctx.Clock.Now() / 1000
	ctx.Redis.Do("HSET", "session:"+sessionID, "user_id", "", "device_class", "web", "token_hash", "", "created_at", now, "last_seen", now, "rotation", 0)
	ctx.Redis.Do("EXPIRE", "session:"+sessionID, 900)
}

type loginBody struct {
	SessionID   string \`json:"session_id"\`
	UserID      string \`json:"user_id"\`
	DeviceClass string \`json:"device_class"\`
}

func login(ctx *harness.Ctx, c *harness.HTTP, sessionID string, body any) loginBody {
	header := []string{"Authorization", "Bearer tok-1"}
	if sessionID != "" {
		header = append(header, "X-Session-Id", sessionID)
	}
	r := c.Post("/v1/sessions", body, header...)
	ctx.Equal(r.Status, 201, "a login with a complete assertion (%s)", r.Text())
	var out loginBody
	r.Decode(&out)
	return out
}

func CheckRoute(ctx *harness.Ctx) {
	c := api(ctx)
	body := login(ctx, c, "", nil)
	ctx.Assert(body.SessionID != "" && body.UserID == "u-1", "the login answered %+v, expected a session_id and user_id u-1", body)
	record := store.ReadSession(bg, body.SessionID)
	ctx.Assert(record != nil && record.UserID == "u-1", "the store has no session for u-1 under %s: %+v", body.SessionID, record)
	ids := store.UserSessions(bg, "u-1")
	ctx.Assert(slices.Contains(ids, body.SessionID), "u-1's set holds %v, expected %s", ids, body.SessionID)
}

func CheckRotate(ctx *harness.Ctx) {
	plant(ctx, "planted-1")
	c := api(ctx)
	body := login(ctx, c, "planted-1", nil)
	ctx.Assert(body.SessionID != "planted-1", "a login on X-Session-Id planted-1 answered planted-1: an id an attacker planted before the login is now signed in as u-1. Mint a fresh id at every login")
	planted := store.ReadSession(bg, "planted-1")
	ctx.Assert(planted == nil || planted.UserID != "u-1", "planted-1 now belongs to u-1: %+v", planted)
	record := store.ReadSession(bg, body.SessionID)
	ctx.Assert(record != nil && record.UserID == "u-1", "the fresh id %s must hold u-1's session, the store has %+v", body.SessionID, record)
}

func CheckInvalidateOld(ctx *harness.Ctx) {
	plant(ctx, "planted-1")
	c := api(ctx)
	first := login(ctx, c, "planted-1", nil)
	planted := store.ReadSession(bg, "planted-1")
	ctx.Assert(planted == nil, "after the login the id the client presented (planted-1) still reads as %+v: retire it in the same request", planted)
	again := login(ctx, c, first.SessionID, nil)
	ctx.Assert(store.ReadSession(bg, first.SessionID) == nil, "a second login on %s left it live", first.SessionID)
	ids := store.UserSessions(bg, "u-1")
	ctx.Assert(!slices.Contains(ids, first.SessionID) && slices.Contains(ids, again.SessionID), "u-1's set holds %v: the retired id must leave it, the new one must be in it", ids)
}

func CheckDeviceFromToken(ctx *harness.Ctx) {
	c := api(ctx)
	body := login(ctx, c, "", map[string]string{"device_class": "desktop"})
	ctx.Equal(body.DeviceClass, "mobile", "the assertion saw mobile, the body's label must not override it; the answered device_class")
	record := store.ReadSession(bg, body.SessionID)
	ctx.Assert(record != nil && record.DeviceClass == "mobile", "the stored session must carry the assertion's device class mobile, got %+v", record)
}

func CheckAuthAssertion(ctx *harness.Ctx) {
	c := api(ctx)
	missing := c.Post("/v1/sessions", nil)
	ctx.Equal(missing.Status, 401, "a login with no token")
	pending := c.Post("/v1/sessions", nil, "Authorization", "Bearer tok-pending")
	ctx.Equal(pending.Status, 401, "a login whose assertion is still mfa_pending (the second factor never passed)")
	written := ctx.Redis.Keys("session:*")
	ctx.Assert(len(written) == 0, "the refused login wrote %s", fmt.Sprint(written))
	login(ctx, c, "", nil)
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <algorithm>
#include <string>
#include <vector>

#include "sessions/store.h"

namespace {

harness::HTTP api(harness::Ctx& ctx) {
  ctx.Redis.Do("HSET", "assertion:tok-1", "user_id", "u-1", "device_class", "mobile", "status", "complete");
  ctx.Redis.Do("HSET", "assertion:tok-pending", "user_id", "u-1", "device_class", "mobile", "status", "mfa_pending");
  static httplib::Server* svr = nullptr;
  delete svr;
  svr = new httplib::Server;
  register_routes(*svr);
  return ctx.HTTP(*svr);
}

// An anonymous pre-login session: the id a browser holds before anyone signs in, the one an attacker plants.
void plant(harness::Ctx& ctx, const std::string& session_id) {
  const long long now = ctx.Clock.Now() / 1000;
  ctx.Redis.Do("HSET", "session:" + session_id, "user_id", "", "device_class", "web", "token_hash", "", "created_at", now, "last_seen", now, "rotation", 0);
  ctx.Redis.Do("EXPIRE", "session:" + session_id, 900);
}

nlohmann::json login(harness::Ctx& ctx, harness::HTTP& c, const std::string& session_id = "", const std::string& body = "") {
  const auto r = session_id.empty()
                     ? c.Post("/v1/sessions", body, "Content-Type", "application/json", "Authorization", "Bearer tok-1")
                     : c.Post("/v1/sessions", body, "Content-Type", "application/json", "Authorization", "Bearer tok-1", "X-Session-Id", session_id);
  ctx.Equal(r.Status, 201, "a login with a complete assertion (%s)", r.Text());
  const auto out = nlohmann::json::parse(r.Text(), nullptr, false);
  return out.is_object() ? out : nlohmann::json::object();
}

bool contains(const std::vector<std::string>& ids, const std::string& id) { return std::find(ids.begin(), ids.end(), id) != ids.end(); }

}  // namespace

void CheckRoute(harness::Ctx& ctx) {
  auto c = api(ctx);
  const auto body = login(ctx, c);
  const std::string session_id = body.value("session_id", "");
  ctx.Assert(!session_id.empty() && body.value("user_id", "") == "u-1", "the login answered %s, expected a session_id and user_id u-1", body.dump());
  const auto record = store::readSession(session_id);
  ctx.Assert(record && record->user_id == "u-1", "the store has no session for u-1 under %s", session_id);
  ctx.Assert(contains(store::userSessions("u-1"), session_id), "u-1's set must hold %s", session_id);
}

void CheckRotate(harness::Ctx& ctx) {
  plant(ctx, "planted-1");
  auto c = api(ctx);
  const std::string session_id = login(ctx, c, "planted-1").value("session_id", "");
  ctx.Assert(session_id != "planted-1",
             "a login on X-Session-Id planted-1 answered planted-1: an id an attacker planted before the login is now signed in as u-1. Mint a fresh id at every login");
  const auto planted = store::readSession("planted-1");
  ctx.Assert(!planted || planted->user_id != "u-1", "planted-1 now belongs to u-1");
  const auto record = store::readSession(session_id);
  ctx.Assert(record && record->user_id == "u-1", "the fresh id %s must hold u-1's session", session_id);
}

void CheckInvalidateOld(harness::Ctx& ctx) {
  plant(ctx, "planted-1");
  auto c = api(ctx);
  const std::string old = login(ctx, c, "planted-1").value("session_id", "");
  ctx.Assert(!store::readSession("planted-1"), "after the login the id the client presented (planted-1) still reads: retire it in the same request");
  const std::string fresh = login(ctx, c, old).value("session_id", "");
  ctx.Assert(!store::readSession(old), "a second login on %s left it live", old);
  const auto ids = store::userSessions("u-1");
  ctx.Assert(!contains(ids, old) && contains(ids, fresh), "u-1's set holds %v: the retired id must leave it, the new one must be in it", ids);
}

void CheckDeviceFromToken(harness::Ctx& ctx) {
  auto c = api(ctx);
  const auto body = login(ctx, c, "", R"({"device_class": "desktop"})");
  ctx.Equal(body.value("device_class", ""), "mobile", "the assertion saw mobile, the body's label must not override it; the answered device_class");
  const auto record = store::readSession(body.value("session_id", ""));
  ctx.Assert(record && record->device_class == "mobile", "the stored session must carry the assertion's device class mobile, got %q", record ? record->device_class : "");
}

void CheckAuthAssertion(harness::Ctx& ctx) {
  auto c = api(ctx);
  const auto missing = c.Post("/v1/sessions", "");
  ctx.Equal(missing.Status, 401, "a login with no token");
  const auto pending = c.Post("/v1/sessions", "", "Authorization", "Bearer tok-pending");
  ctx.Equal(pending.Status, 401, "a login whose assertion is still mfa_pending (the second factor never passed)");
  const auto written = ctx.Redis.Keys("session:*");
  ctx.Assert(written.empty(), "the refused login wrote %v", written);
  login(ctx, c);
}
`,
  },
  hints: [
    'Put an id in `X-Session-Id`, log in, and read that id back from the store: it now belongs to the user. Send a token whose MFA is still pending: it gets a session too.',
    "The handler writes under whatever id the client presented, so the pre-login id lives on as the signed-in one; it prefers the body's device label; and it asks only whether an assertion exists, not whether it is complete.",
    '401 unless the assertion\'s `status` is `"complete"`; take `device_class` from the assertion; `put_session` under `store.new_session_id()`, then `retire_session` the id from `X-Session-Id` when there was one.',
  ],
  debrief: `Session fixation is fixed by the shape of the login: the server picks the id at the moment privilege changes, so nothing a client chose before that moment carries the new privilege. Retiring the presented id in the same request closes the other half, since the pre-login id stops working for whoever else holds it. The device class and the completion status come from the assertion because they are facts about how the user authenticated, and only the login flow saw them. Production session layers also bind the id to a cookie with \`Secure\`, \`HttpOnly\` and \`SameSite\`, rotate again at every later privilege change (a sudo prompt, an admin console), and record which factors the login used so a step-up can ask for one more.`,
};
