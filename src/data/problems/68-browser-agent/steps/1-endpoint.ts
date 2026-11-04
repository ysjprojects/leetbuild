import type {Step} from '@/lib/types';

export const endpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/browser/sessions: a session is a policy and a budget',
  concept: 'http',
  file: 'api',
  focus: ['client', 'api', 'profile', 'redis'],
  task: `## Task

**Starting point.** The starter serves \`POST /v1/browser/sessions\` with body \`{task, profile,
start_url?, max_steps}\` and the tenant in \`X-Tenant-Id\` (401 when missing). It resolves the
profile with \`profiles.get_profile\`, starts the session at \`start_url\` or the profile's
\`entry\`, stores it with \`sessions.create_session\` and answers 201 with \`sessions.public_view\`.
It serves the demo and hides three flaws.

**Failure mode the checks target.** An unknown profile quietly runs under \`public-web\`, and a
\`start_url\` the profile does not allow (\`http://169.254.169.254/…\`) becomes the session's first
page; a request without \`max_steps\` gets an unlimited budget; a client that retries after a
timeout starts a second browser.

- An unknown \`profile\` is **400**. A \`start_url\` goes through
  \`profiles.authorize_navigation(profile, url)\`; a refused one is **400** with the reason.
  Without one, the session starts at the profile's \`entry\`.
- \`max_steps\` is required, **1 to 60** (\`MAX_STEPS\`); anything else is **400**.
- \`Idempotency-Key\` is required (**400**). Look \`(tenant, key)\` up with
  \`sessions.session_for_key\` before creating: a replay answers **200** with the stored session,
  and a new session is recorded with \`sessions.remember_key\`.`,
  sequence: {
    participants: ['Client', 'Session API', 'Egress profiles', 'Redis'],
    messages: [
      {
        from: 'Client',
        to: 'Session API',
        label: 'POST /v1/browser/sessions · X-Tenant-Id · Idempotency-Key',
        kind: 'sync',
      },
      {from: 'Session API', to: 'Egress profiles', label: 'get_profile(name) → unknown: 400', kind: 'sync'},
      {
        from: 'Session API',
        to: 'Egress profiles',
        label: 'authorize_navigation(profile, start_url) → reason: 400',
        kind: 'sync',
      },
      {from: 'Session API', to: 'Redis', label: 'session_for_key(tenant, key) → replay: 200', kind: 'sync'},
      {from: 'Session API', to: 'Redis', label: 'create_session · remember_key', kind: 'sync'},
      {
        from: 'Session API',
        to: 'Client',
        label: '201 {session_id, current_url, max_steps, budget_remaining}',
        kind: 'reply',
      },
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Starts a session on POST /v1/browser/sessions',
      detail:
        'Register `POST /v1/browser/sessions`: a valid request is stored as a session of the caller’s tenant and answered 201 with its public view; a request without `X-Tenant-Id` is 401.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/browser\/sessions["']/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/browser\/sessions['"]/]},
        go: {all: [/HandleFunc\(\s*"POST \/v1\/browser\/sessions"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"browser"\s*\/\s*"sessions"\s*\)/, /\bpost\s*\{/]},
        cpp: {all: [/svr\.Post\(\s*"\/v1\/browser\/sessions"/]},
      },
    },
    {
      id: 'profile',
      title: 'Refuses an unknown profile and an off-profile start URL',
      detail:
        'An unknown profile is 400 rather than a fallback to `DEFAULT_PROFILE`, and a `start_url` goes through `authorize_navigation`/`authorizeNavigation` before it becomes the first page; a refused one is 400.',
      match: {
        python: {all: [/profiles\.authorize_navigation\(/], none: [/DEFAULT_PROFILE/]},
        typescript: {all: [/authorizeNavigation\(/], none: [/DEFAULT_PROFILE/]},
        go: {all: [/profiles\.AuthorizeNavigation\(/], none: [/defaultProfile/]},
        scala: {all: [/Profiles\.authorizeNavigation\(/], none: [/DefaultProfile/]},
        cpp: {all: [/profiles::authorizeNavigation\(/], none: [/kDefaultProfile/]},
      },
    },
    {
      id: 'budget',
      title: 'Requires a step budget from 1 to 60',
      detail:
        '`max_steps` is required and bounded by `MAX_STEPS` (60); a missing, zero or larger budget is 400. The starter reads a missing budget as `UNLIMITED`.',
      match: {
        python: {all: [/MAX_STEPS\s*=\s*60\b/], none: [/UNLIMITED/]},
        typescript: {all: [/MAX_STEPS\s*=\s*60\b/], none: [/UNLIMITED/]},
        go: {all: [/maxSteps\s*=\s*60\b/], none: [/\bunlimited\b/]},
        scala: {all: [/MaxSteps\s*=\s*60L?\b/], none: [/\bUnlimited\b/]},
        cpp: {all: [/kMaxSteps\s*=\s*60\b/], none: [/kUnlimited/]},
      },
    },
    {
      id: 'idempotency',
      title: 'Keys a start by (tenant, Idempotency-Key)',
      detail:
        '`Idempotency-Key` is required (400 without it), the stored session is looked up with `session_for_key`/`sessionForKey` before a session is created, a replay answers 200 with it, and a new session is recorded with `remember_key`/`rememberKey`.',
      match: {
        python: {
          all: [/idempotency-key/i, /sessions\.session_for_key\(/, /sessions\.remember_key\(/],
          order: [/sessions\.session_for_key\(/, /sessions\.create_session\(/],
        },
        typescript: {
          all: [/idempotency-key/i, /sessionForKey\(/, /rememberKey\(/],
          order: [/sessionForKey\(/, /createSession\(/],
        },
        go: {
          all: [/Idempotency-Key/i, /sessions\.SessionForKey\(/, /sessions\.RememberKey\(/],
          order: [/sessions\.SessionForKey\(/, /sessions\.CreateSession\(/],
        },
        scala: {
          all: [/Idempotency-Key/i, /Sessions\.sessionForKey\(/, /Sessions\.rememberKey\(/],
          order: [/Sessions\.sessionForKey\(/, /Sessions\.createSession\(/],
        },
        cpp: {
          all: [/Idempotency-Key/i, /sessions::sessionForKey\(/, /sessions::rememberKey\(/],
          order: [/sessions::sessionForKey\(/, /sessions::createSession\(/],
        },
      },
    },
  ],
  code: {
    python: {
      starter: `from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from browser import profiles  # get_profile, authorize_navigation
from browser import sessions  # create_session, load_session, session_for_key, remember_key, public_view

app = FastAPI()

MAX_TASK_BYTES = 4096
DEFAULT_PROFILE = "public-web"
UNLIMITED = 0


class SessionRequest(BaseModel):
    task: str
    profile: str = DEFAULT_PROFILE
    start_url: str | None = None
    max_steps: int = UNLIMITED


@app.post("/v1/browser/sessions")
def start_session(body: SessionRequest, request: Request) -> JSONResponse:
    # TODO: this starter has three flaws. The task says where to look; the checks say what must change.
    tenant = request.headers.get("x-tenant-id", "")
    if not tenant:
        raise HTTPException(status_code=401, detail="X-Tenant-Id is required")
    if not 0 < len(body.task.encode("utf-8")) <= MAX_TASK_BYTES:
        raise HTTPException(status_code=400, detail="task must be 1 to 4096 bytes")
    profile = profiles.get_profile(body.profile) or profiles.get_profile(DEFAULT_PROFILE)
    session = sessions.create_session(tenant, profile["name"], body.task, body.max_steps, body.start_url or profile["entry"])
    return JSONResponse(sessions.public_view(session), status_code=201)
`,
      solution: `from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from browser import profiles  # get_profile, authorize_navigation
from browser import sessions  # create_session, load_session, session_for_key, remember_key, public_view

app = FastAPI()

MAX_TASK_BYTES = 4096
MIN_STEPS = 1
MAX_STEPS = 60


class SessionRequest(BaseModel):
    task: str
    profile: str
    start_url: str | None = None
    max_steps: int | None = None


@app.post("/v1/browser/sessions")
def start_session(body: SessionRequest, request: Request) -> JSONResponse:
    tenant = request.headers.get("x-tenant-id", "")
    if not tenant:
        raise HTTPException(status_code=401, detail="X-Tenant-Id is required")
    key = request.headers.get("idempotency-key", "")
    if not key:
        raise HTTPException(status_code=400, detail="Idempotency-Key is required")
    if not 0 < len(body.task.encode("utf-8")) <= MAX_TASK_BYTES:
        raise HTTPException(status_code=400, detail="task must be 1 to 4096 bytes")
    profile = profiles.get_profile(body.profile)
    if profile is None:
        raise HTTPException(status_code=400, detail=f"unknown egress profile {body.profile!r}")
    if body.max_steps is None or not MIN_STEPS <= body.max_steps <= MAX_STEPS:
        raise HTTPException(status_code=400, detail=f"max_steps must be {MIN_STEPS} to {MAX_STEPS}")
    if body.start_url:
        # The caller may choose where inside the profile to start, never a page outside it.
        reason = profiles.authorize_navigation(profile, body.start_url)
        if reason:
            raise HTTPException(status_code=400, detail=reason)
    existing = sessions.session_for_key(tenant, key)
    if existing is not None:
        return JSONResponse(sessions.public_view(sessions.load_session(existing)), status_code=200)
    session = sessions.create_session(tenant, profile["name"], body.task, body.max_steps, body.start_url or profile["entry"])
    sessions.remember_key(tenant, key, session["session_id"])
    return JSONResponse(sessions.public_view(session), status_code=201)
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';

import {authorizeNavigation, getProfile} from 'browser/profiles';
import {createSession, loadSession, publicView, rememberKey, sessionForKey} from 'browser/sessions';

export const app = Fastify();

export const MAX_TASK_BYTES = 4096;
export const DEFAULT_PROFILE = 'public-web';
export const UNLIMITED = 0;

interface SessionRequest {
  task?: string;
  profile?: string;
  start_url?: string;
  max_steps?: number;
}

app.post('/v1/browser/sessions', async (request, reply) => {
  // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'X-Tenant-Id is required'});
  const body = request.body as SessionRequest;
  const task = body.task ?? '';
  const bytes = new TextEncoder().encode(task).length;
  if (bytes === 0 || bytes > MAX_TASK_BYTES) return reply.code(400).send({error: 'task must be 1 to 4096 bytes'});
  const profile = getProfile(body.profile ?? DEFAULT_PROFILE) ?? getProfile(DEFAULT_PROFILE)!;
  const session = await createSession(tenant, profile.name, task, body.max_steps ?? UNLIMITED, body.start_url || profile.entry);
  return reply.code(201).send(publicView(session));
});
`,
      solution: `import Fastify from 'fastify';

import {authorizeNavigation, getProfile} from 'browser/profiles';
import {createSession, loadSession, publicView, rememberKey, sessionForKey} from 'browser/sessions';

export const app = Fastify();

export const MAX_TASK_BYTES = 4096;
export const MIN_STEPS = 1;
export const MAX_STEPS = 60;

interface SessionRequest {
  task?: string;
  profile?: string;
  start_url?: string;
  max_steps?: number;
}

app.post('/v1/browser/sessions', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'X-Tenant-Id is required'});
  const key = request.headers['idempotency-key'];
  if (typeof key !== 'string' || key === '') return reply.code(400).send({error: 'Idempotency-Key is required'});
  const body = request.body as SessionRequest;
  const task = body.task ?? '';
  const bytes = new TextEncoder().encode(task).length;
  if (bytes === 0 || bytes > MAX_TASK_BYTES) return reply.code(400).send({error: 'task must be 1 to 4096 bytes'});
  const profile = getProfile(body.profile ?? '');
  if (profile === null) return reply.code(400).send({error: \`unknown egress profile \${body.profile}\`});
  const steps = body.max_steps;
  if (!Number.isInteger(steps) || steps! < MIN_STEPS || steps! > MAX_STEPS) {
    return reply.code(400).send({error: \`max_steps must be \${MIN_STEPS} to \${MAX_STEPS}\`});
  }
  if (body.start_url) {
    // The caller may choose where inside the profile to start, never a page outside it.
    const reason = authorizeNavigation(profile, body.start_url);
    if (reason !== '') return reply.code(400).send({error: reason});
  }
  const existing = await sessionForKey(tenant, key);
  if (existing !== null) return reply.code(200).send(publicView((await loadSession(existing))!));
  const session = await createSession(tenant, profile.name, task, steps!, body.start_url || profile.entry);
  await rememberKey(tenant, key, session.session_id);
  return reply.code(201).send(publicView(session));
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"net/http"

	"browser/profiles" // profiles.GetProfile, AuthorizeNavigation
	"browser/sessions" // sessions.CreateSession, LoadSession, SessionForKey, RememberKey, PublicView
)

const (
	maxTaskBytes   = 4096
	defaultProfile = "public-web"
	unlimited      = 0
)

type sessionRequest struct {
	Task     string \`json:"task"\`
	Profile  string \`json:"profile"\`
	StartURL string \`json:"start_url"\`
	MaxSteps int    \`json:"max_steps"\`
}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func fail(rw http.ResponseWriter, status int, message string) {
	writeJSON(rw, status, map[string]string{"error": message})
}

func startSession(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has three flaws. The task says where to look; the checks say what must change.
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		fail(rw, http.StatusUnauthorized, "X-Tenant-Id is required")
		return
	}
	body := sessionRequest{MaxSteps: unlimited}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		fail(rw, http.StatusBadRequest, "the body must be JSON")
		return
	}
	if body.Task == "" || len(body.Task) > maxTaskBytes {
		fail(rw, http.StatusBadRequest, "task must be 1 to 4096 bytes")
		return
	}
	profile := profiles.GetProfile(body.Profile)
	if profile == nil {
		profile = profiles.GetProfile(defaultProfile)
	}
	current := profile.Entry
	if body.StartURL != "" {
		current = body.StartURL
	}
	session := sessions.CreateSession(r.Context(), tenant, profile.Name, body.Task, body.MaxSteps, current)
	writeJSON(rw, http.StatusCreated, sessions.PublicView(session))
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/browser/sessions", startSession)
}
`,
      solution: `package main

import (
	"encoding/json"
	"fmt"
	"net/http"

	"browser/profiles" // profiles.GetProfile, AuthorizeNavigation
	"browser/sessions" // sessions.CreateSession, LoadSession, SessionForKey, RememberKey, PublicView
)

const (
	maxTaskBytes = 4096
	minSteps     = 1
	maxSteps     = 60
)

type sessionRequest struct {
	Task     string \`json:"task"\`
	Profile  string \`json:"profile"\`
	StartURL string \`json:"start_url"\`
	MaxSteps *int   \`json:"max_steps"\`
}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func fail(rw http.ResponseWriter, status int, message string) {
	writeJSON(rw, status, map[string]string{"error": message})
}

func startSession(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		fail(rw, http.StatusUnauthorized, "X-Tenant-Id is required")
		return
	}
	key := r.Header.Get("Idempotency-Key")
	if key == "" {
		fail(rw, http.StatusBadRequest, "Idempotency-Key is required")
		return
	}
	var body sessionRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		fail(rw, http.StatusBadRequest, "the body must be JSON")
		return
	}
	if body.Task == "" || len(body.Task) > maxTaskBytes {
		fail(rw, http.StatusBadRequest, "task must be 1 to 4096 bytes")
		return
	}
	profile := profiles.GetProfile(body.Profile)
	if profile == nil {
		fail(rw, http.StatusBadRequest, "unknown egress profile "+body.Profile)
		return
	}
	if body.MaxSteps == nil || *body.MaxSteps < minSteps || *body.MaxSteps > maxSteps {
		fail(rw, http.StatusBadRequest, fmt.Sprintf("max_steps must be %d to %d", minSteps, maxSteps))
		return
	}
	current := profile.Entry
	if body.StartURL != "" {
		// The caller may choose where inside the profile to start, never a page outside it.
		if reason := profiles.AuthorizeNavigation(profile, body.StartURL); reason != "" {
			fail(rw, http.StatusBadRequest, reason)
			return
		}
		current = body.StartURL
	}
	if existing := sessions.SessionForKey(r.Context(), tenant, key); existing != "" {
		writeJSON(rw, http.StatusOK, sessions.PublicView(sessions.LoadSession(r.Context(), existing)))
		return
	}
	session := sessions.CreateSession(r.Context(), tenant, profile.Name, body.Task, *body.MaxSteps, current)
	sessions.RememberKey(r.Context(), tenant, key, session.ID)
	writeJSON(rw, http.StatusCreated, sessions.PublicView(session))
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/browser/sessions", startSession)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import browser.Profiles // Profiles.getProfile, authorizeNavigation
import browser.Sessions // Sessions.createSession, loadSession, sessionForKey, rememberKey, publicView

object Api {
  val MaxTaskBytes = 4096
  val DefaultProfile = "public-web"
  val Unlimited = 0L

  private def json(status: StatusCode, body: JsObject): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  private def error(status: StatusCode, message: String): HttpResponse = json(status, JsObject("error" -> JsString(message)))

  private def text(body: JsObject, name: String): Option[String] = body.fields.get(name).collect { case JsString(s) => s }

  def start(tenant: String, raw: String): HttpResponse = {
    // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
    val body = raw.parseJson.asJsObject
    val task = text(body, "task").getOrElse("")
    if (task.isEmpty || task.getBytes("UTF-8").length > MaxTaskBytes) error(StatusCodes.BadRequest, "task must be 1 to 4096 bytes")
    else {
      val profile = Profiles.getProfile(text(body, "profile").getOrElse(DefaultProfile)).getOrElse(Profiles.getProfile(DefaultProfile).get)
      val maxSteps = body.fields.get("max_steps").collect { case JsNumber(n) => n.toLong }.getOrElse(Unlimited)
      val session = Sessions.createSession(tenant, profile.name, task, maxSteps, text(body, "start_url").filter(_.nonEmpty).getOrElse(profile.entry))
      json(StatusCodes.Created, Sessions.publicView(session))
    }
  }

  val route: Route = path("v1" / "browser" / "sessions") {
    post {
      optionalHeaderValueByName("X-Tenant-Id") { tenant =>
        entity(as[String]) { raw =>
          tenant.filter(_.nonEmpty) match {
            case None => complete(error(StatusCodes.Unauthorized, "X-Tenant-Id is required"))
            case Some(t) => complete(start(t, raw))
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

import browser.Profiles // Profiles.getProfile, authorizeNavigation
import browser.Sessions // Sessions.createSession, loadSession, sessionForKey, rememberKey, publicView

object Api {
  val MaxTaskBytes = 4096
  val MinSteps = 1L
  val MaxSteps = 60L

  private def json(status: StatusCode, body: JsObject): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  private def error(status: StatusCode, message: String): HttpResponse = json(status, JsObject("error" -> JsString(message)))

  private def text(body: JsObject, name: String): Option[String] = body.fields.get(name).collect { case JsString(s) => s }

  def start(tenant: String, key: String, raw: String): HttpResponse = {
    val body = raw.parseJson.asJsObject
    val task = text(body, "task").getOrElse("")
    val maxSteps = body.fields.get("max_steps").collect { case JsNumber(n) if n.isValidLong => n.toLong }
    val startUrl = text(body, "start_url").filter(_.nonEmpty)
    if (task.isEmpty || task.getBytes("UTF-8").length > MaxTaskBytes) error(StatusCodes.BadRequest, "task must be 1 to 4096 bytes")
    else
      Profiles.getProfile(text(body, "profile").getOrElse("")) match {
        case None => error(StatusCodes.BadRequest, "unknown egress profile")
        case Some(profile) =>
          // The caller may choose where inside the profile to start, never a page outside it.
          val refused = startUrl.map(Profiles.authorizeNavigation(profile, _)).filter(_.nonEmpty)
          if (!maxSteps.exists(n => n >= MinSteps && n <= MaxSteps)) error(StatusCodes.BadRequest, s"max_steps must be $MinSteps to $MaxSteps")
          else if (refused.nonEmpty) error(StatusCodes.BadRequest, refused.get)
          else
            Sessions.sessionForKey(tenant, key).flatMap(Sessions.loadSession) match {
              case Some(existing) => json(StatusCodes.OK, Sessions.publicView(existing))
              case None =>
                val session = Sessions.createSession(tenant, profile.name, task, maxSteps.get, startUrl.getOrElse(profile.entry))
                Sessions.rememberKey(tenant, key, session.sessionId)
                json(StatusCodes.Created, Sessions.publicView(session))
            }
      }
  }

  val route: Route = path("v1" / "browser" / "sessions") {
    post {
      optionalHeaderValueByName("X-Tenant-Id") { tenant =>
        optionalHeaderValueByName("Idempotency-Key") { key =>
          entity(as[String]) { raw =>
            (tenant.filter(_.nonEmpty), key.filter(_.nonEmpty)) match {
              case (None, _) => complete(error(StatusCodes.Unauthorized, "X-Tenant-Id is required"))
              case (_, None) => complete(error(StatusCodes.BadRequest, "Idempotency-Key is required"))
              case (Some(t), Some(k)) => complete(start(t, k, raw))
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

#include <string>

#include "browser/profiles.h"  // profiles::getProfile, authorizeNavigation
#include "browser/sessions.h"  // sessions::createSession, loadSession, sessionForKey, rememberKey, publicView

using json = nlohmann::json;

constexpr size_t kMaxTaskBytes = 4096;
const std::string kDefaultProfile = "public-web";
constexpr long kUnlimited = 0;

void fail(httplib::Response& res, int status, const std::string& message) {
  res.status = status;
  res.set_content(json{{"error", message}}.dump(), "application/json");
}

void start_session(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) return fail(res, 401, "X-Tenant-Id is required");
  const json body = json::parse(req.body, nullptr, false);
  if (!body.is_object()) return fail(res, 400, "the body must be JSON");
  const std::string task = body.value("task", "");
  if (task.empty() || task.size() > kMaxTaskBytes) return fail(res, 400, "task must be 1 to 4096 bytes");
  auto profile = profiles::getProfile(body.value("profile", kDefaultProfile));
  if (!profile) profile = profiles::getProfile(kDefaultProfile);
  const std::string start_url = body.value("start_url", "");
  const sessions::Session session =
      sessions::createSession(tenant, profile->name, task, body.value("max_steps", kUnlimited), start_url.empty() ? profile->entry : start_url);
  res.status = 201;
  res.set_content(sessions::publicView(session).dump(), "application/json");
}

void register_routes(httplib::Server& svr) { svr.Post("/v1/browser/sessions", start_session); }
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <string>

#include "browser/profiles.h"  // profiles::getProfile, authorizeNavigation
#include "browser/sessions.h"  // sessions::createSession, loadSession, sessionForKey, rememberKey, publicView

using json = nlohmann::json;

constexpr size_t kMaxTaskBytes = 4096;
constexpr long kMinSteps = 1;
constexpr long kMaxSteps = 60;

void fail(httplib::Response& res, int status, const std::string& message) {
  res.status = status;
  res.set_content(json{{"error", message}}.dump(), "application/json");
}

void start_session(const httplib::Request& req, httplib::Response& res) {
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) return fail(res, 401, "X-Tenant-Id is required");
  const std::string key = req.get_header_value("Idempotency-Key");
  if (key.empty()) return fail(res, 400, "Idempotency-Key is required");
  const json body = json::parse(req.body, nullptr, false);
  if (!body.is_object()) return fail(res, 400, "the body must be JSON");
  const std::string task = body.value("task", "");
  if (task.empty() || task.size() > kMaxTaskBytes) return fail(res, 400, "task must be 1 to 4096 bytes");
  const auto profile = profiles::getProfile(body.value("profile", ""));
  if (!profile) return fail(res, 400, "unknown egress profile");
  if (!body.contains("max_steps") || !body["max_steps"].is_number_integer()) return fail(res, 400, "max_steps is required");
  const long max_steps = body["max_steps"].get<long>();
  if (max_steps < kMinSteps || max_steps > kMaxSteps) return fail(res, 400, "max_steps must be 1 to 60");
  const std::string start_url = body.value("start_url", "");
  if (!start_url.empty()) {
    // The caller may choose where inside the profile to start, never a page outside it.
    const std::string reason = profiles::authorizeNavigation(*profile, start_url);
    if (!reason.empty()) return fail(res, 400, reason);
  }
  if (const auto existing = sessions::sessionForKey(tenant, key)) {
    res.status = 200;
    res.set_content(sessions::publicView(*sessions::loadSession(*existing)).dump(), "application/json");
    return;
  }
  const sessions::Session session =
      sessions::createSession(tenant, profile->name, task, max_steps, start_url.empty() ? profile->entry : start_url);
  sessions::rememberKey(tenant, key, session.session_id);
  res.status = 201;
  res.set_content(sessions::publicView(session).dump(), "application/json");
}

void register_routes(httplib::Server& svr) { svr.Post("/v1/browser/sessions", start_session); }
`,
    },
  },
  harness: {
    python: `from browser import sessions

ENTRY = "https://www.example.com/"
BODY = {"task": "find the price of the 2 L kettle", "profile": "public-web", "max_steps": 10}


def _api(ctx):
    return ctx.client(ctx.load("api").app)


async def _start(c, body, key="k-1", tenant="acme"):
    headers = {}
    if tenant:
        headers["X-Tenant-Id"] = tenant
    if key:
        headers["Idempotency-Key"] = key
    return await c.post("/v1/browser/sessions", json=body, headers=headers)


def _stored(ctx):
    return sorted(ctx.redis.keys("browser:session:*"))


async def check_route(ctx):
    async with _api(ctx) as c:
        r = await _start(c, BODY)
        assert r.status_code == 201, f"POST /v1/browser/sessions answered {r.status_code}: {r.text}"
        body = r.json()
        session = sessions.load_session(str(body.get("session_id")))
        assert session is not None, f"the answer names session {body.get('session_id')!r}, which is not stored under browser:session:{{id}}"
        assert session["tenant"] == "acme" and session["profile"] == "public-web", f"the stored session belongs to {session['tenant']!r} under {session['profile']!r}, expected acme under public-web"
        assert body.get("current_url") == ENTRY, f"a session without start_url starts at the profile's entry {ENTRY}, got {body.get('current_url')!r}"
        assert body.get("budget_remaining") == 10, f"a session of 10 steps answered budget_remaining {body.get('budget_remaining')!r}"
        r = await _start(c, BODY, key="k-2", tenant=None)
    assert r.status_code == 401, f"a start without X-Tenant-Id answered {r.status_code}, expected 401"


async def check_profile(ctx):
    async with _api(ctx) as c:
        r = await _start(c, {**BODY, "profile": "intranet"}, key="k-1")
        assert r.status_code == 400, f"a start with profile 'intranet', which the catalog does not have, answered {r.status_code} {r.text}: it must be 400, not a session under another profile"
        r = await _start(c, {**BODY, "start_url": "http://169.254.169.254/latest/meta-data/"}, key="k-2")
        assert r.status_code == 400, f"a start_url outside the profile (http://169.254.169.254/…) answered {r.status_code} {r.text}: authorize it against the profile and refuse it with 400"
        assert _stored(ctx) == [], f"refused starts left sessions behind: {_stored(ctx)}"
        r = await _start(c, {**BODY, "start_url": "https://en.wikipedia.org/wiki/Kettle"}, key="k-3")
    assert r.status_code == 201, f"a start_url the profile allows answered {r.status_code}: {r.text}"
    assert r.json().get("current_url") == "https://en.wikipedia.org/wiki/Kettle", f"an allowed start_url must be the first page, got {r.json().get('current_url')!r}"


async def check_budget(ctx):
    no_budget = {k: v for k, v in BODY.items() if k != "max_steps"}
    async with _api(ctx) as c:
        for key, body, label in (("k-1", no_budget, "without max_steps"), ("k-2", {**BODY, "max_steps": 0}, "with max_steps 0"), ("k-3", {**BODY, "max_steps": 61}, "with max_steps 61")):
            r = await _start(c, body, key=key)
            assert r.status_code == 400, f"a start {label} answered {r.status_code} {r.text}: the budget is required, 1 to 60 steps"
        assert _stored(ctx) == [], f"starts without a valid budget left sessions behind: {_stored(ctx)}"
        r = await _start(c, {**BODY, "max_steps": 60}, key="k-4")
    assert r.status_code == 201 and r.json().get("budget_remaining") == 60, f"a start with max_steps 60 answered {r.status_code} {r.text}, expected 201 with budget_remaining 60"


async def check_idempotency(ctx):
    async with _api(ctx) as c:
        first = await _start(c, BODY, key="k-1")
        assert first.status_code == 201, f"the first start answered {first.status_code}: {first.text}"
        replay = await _start(c, BODY, key="k-1")
        assert replay.status_code == 200 and replay.json().get("session_id") == first.json().get("session_id"), f"a retry with the same Idempotency-Key answered {replay.status_code} {replay.text}: it must answer 200 with session {first.json().get('session_id')!r}"
        assert len(_stored(ctx)) == 1, f"one start and its retry stored {_stored(ctx)}"
        other = await _start(c, BODY, key="k-1", tenant="globex")
        assert other.status_code == 201 and other.json().get("session_id") != first.json().get("session_id"), f"the same key from another tenant answered {other.status_code} {other.text}: it is another request and starts its own session"
        missing = await _start(c, BODY, key=None)
    assert missing.status_code == 400, f"a start without Idempotency-Key answered {missing.status_code}, expected 400"
`,
    typescript: `const ENTRY = 'https://www.example.com/';
const BODY = {task: 'find the price of the 2 L kettle', profile: 'public-web', max_steps: 10};

function api(ctx) {
  return {c: ctx.client(ctx.load('api').app), sessions: ctx.load('/support/browser/sessions.ts')};
}

function start(c, body, key: string | null = 'k-1', tenant: string | null = 'acme') {
  const headers: Record<string, string> = {};
  if (tenant) headers['X-Tenant-Id'] = tenant;
  if (key) headers['Idempotency-Key'] = key;
  return c.post('/v1/browser/sessions', {json: body, headers});
}

const stored = (ctx): string[] => ctx.redis.keys('browser:session:*').sort();

export async function check_route(ctx) {
  const {c, sessions} = api(ctx);
  let r = await start(c, BODY);
  assert.equal(r.status, 201, \`POST /v1/browser/sessions answered \${r.status}: \${r.text}\`);
  const body = r.json();
  const session = await sessions.loadSession(String(body.session_id));
  assert(session !== null, \`the answer names session \${body.session_id}, which is not stored under browser:session:{id}\`);
  assert(session.tenant === 'acme' && session.profile === 'public-web', \`the stored session belongs to \${session.tenant} under \${session.profile}, expected acme under public-web\`);
  assert.equal(body.current_url, ENTRY, \`a session without start_url starts at the profile's entry \${ENTRY}, got \${body.current_url}\`);
  assert.equal(body.budget_remaining, 10, \`a session of 10 steps answered budget_remaining \${body.budget_remaining}\`);
  r = await start(c, BODY, 'k-2', null);
  assert.equal(r.status, 401, \`a start without X-Tenant-Id answered \${r.status}, expected 401\`);
}

export async function check_profile(ctx) {
  const {c} = api(ctx);
  let r = await start(c, {...BODY, profile: 'intranet'}, 'k-1');
  assert.equal(r.status, 400, \`a start with profile 'intranet', which the catalog does not have, answered \${r.status} \${r.text}: it must be 400, not a session under another profile\`);
  r = await start(c, {...BODY, start_url: 'http://169.254.169.254/latest/meta-data/'}, 'k-2');
  assert.equal(r.status, 400, \`a start_url outside the profile (http://169.254.169.254/…) answered \${r.status} \${r.text}: authorize it against the profile and refuse it with 400\`);
  assert.deepStrictEqual(stored(ctx), [], \`refused starts left sessions behind: \${JSON.stringify(stored(ctx))}\`);
  r = await start(c, {...BODY, start_url: 'https://en.wikipedia.org/wiki/Kettle'}, 'k-3');
  assert.equal(r.status, 201, \`a start_url the profile allows answered \${r.status}: \${r.text}\`);
  assert.equal(r.json().current_url, 'https://en.wikipedia.org/wiki/Kettle', \`an allowed start_url must be the first page, got \${r.json().current_url}\`);
}

export async function check_budget(ctx) {
  const {c} = api(ctx);
  const {max_steps: _, ...noBudget} = BODY;
  for (const [key, body, label] of [['k-1', noBudget, 'without max_steps'], ['k-2', {...BODY, max_steps: 0}, 'with max_steps 0'], ['k-3', {...BODY, max_steps: 61}, 'with max_steps 61']] as const) {
    const r = await start(c, body, key);
    assert.equal(r.status, 400, \`a start \${label} answered \${r.status} \${r.text}: the budget is required, 1 to 60 steps\`);
  }
  assert.deepStrictEqual(stored(ctx), [], \`starts without a valid budget left sessions behind: \${JSON.stringify(stored(ctx))}\`);
  const r = await start(c, {...BODY, max_steps: 60}, 'k-4');
  assert(r.status === 201 && r.json().budget_remaining === 60, \`a start with max_steps 60 answered \${r.status} \${r.text}, expected 201 with budget_remaining 60\`);
}

export async function check_idempotency(ctx) {
  const {c} = api(ctx);
  const first = await start(c, BODY, 'k-1');
  assert.equal(first.status, 201, \`the first start answered \${first.status}: \${first.text}\`);
  const replay = await start(c, BODY, 'k-1');
  assert(replay.status === 200 && replay.json().session_id === first.json().session_id, \`a retry with the same Idempotency-Key answered \${replay.status} \${replay.text}: it must answer 200 with session \${first.json().session_id}\`);
  assert.equal(stored(ctx).length, 1, \`one start and its retry stored \${JSON.stringify(stored(ctx))}\`);
  const other = await start(c, BODY, 'k-1', 'globex');
  assert(other.status === 201 && other.json().session_id !== first.json().session_id, \`the same key from another tenant answered \${other.status} \${other.text}: it is another request and starts its own session\`);
  const missing = await start(c, BODY, null);
  assert.equal(missing.status, 400, \`a start without Idempotency-Key answered \${missing.status}, expected 400\`);
}
`,
    go: `package main

import (
	"context"
	"net/http"

	"browser/sessions"

	"leetbuild/harness"
)

const entry = "https://www.example.com/"

func body(changes map[string]any, drop string) map[string]any {
	out := map[string]any{"task": "find the price of the 2 L kettle", "profile": "public-web", "max_steps": 10}
	for k, v := range changes {
		out[k] = v
	}
	delete(out, drop)
	return out
}

func api(ctx *harness.Ctx) *harness.HTTP {
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

func start(c *harness.HTTP, b map[string]any, key string) *harness.Response {
	return c.Post("/v1/browser/sessions", b, "X-Tenant-Id", "acme", "Idempotency-Key", key)
}

type view struct {
	SessionID       string \`json:"session_id"\`
	CurrentURL      string \`json:"current_url"\`
	BudgetRemaining int    \`json:"budget_remaining"\`
}

func viewOf(r *harness.Response) view {
	var v view
	r.Decode(&v)
	return v
}

func CheckRoute(ctx *harness.Ctx) {
	c := api(ctx)
	r := start(c, body(nil, ""), "k-1")
	ctx.Equal(r.Status, 201, "POST /v1/browser/sessions (%s)", r.Text())
	v := viewOf(r)
	session := sessions.LoadSession(context.Background(), v.SessionID)
	ctx.Assert(session != nil, "the answer names session %q, which is not stored under browser:session:{id}", v.SessionID)
	ctx.Assert(session.Tenant == "acme" && session.Profile == "public-web", "the stored session belongs to %q under %q, expected acme under public-web", session.Tenant, session.Profile)
	ctx.Equal(v.CurrentURL, entry, "a session without start_url starts at the profile's entry; current_url")
	ctx.Equal(v.BudgetRemaining, 10, "a session of 10 steps; budget_remaining")
	r = c.Post("/v1/browser/sessions", body(nil, ""), "Idempotency-Key", "k-2")
	ctx.Equal(r.Status, 401, "a start without X-Tenant-Id")
}

func CheckProfile(ctx *harness.Ctx) {
	c := api(ctx)
	r := start(c, body(map[string]any{"profile": "intranet"}, ""), "k-1")
	ctx.Equal(r.Status, 400, "a start with profile 'intranet', which the catalog does not have, must be 400, not a session under another profile (%s)", r.Text())
	r = start(c, body(map[string]any{"start_url": "http://169.254.169.254/latest/meta-data/"}, ""), "k-2")
	ctx.Equal(r.Status, 400, "a start_url outside the profile (http://169.254.169.254/…) must be authorized against the profile and refused (%s)", r.Text())
	ctx.Equal(len(ctx.Redis.Keys("browser:session:*")), 0, "refused starts must leave no session; stored sessions")
	r = start(c, body(map[string]any{"start_url": "https://en.wikipedia.org/wiki/Kettle"}, ""), "k-3")
	ctx.Equal(r.Status, 201, "a start_url the profile allows (%s)", r.Text())
	ctx.Equal(viewOf(r).CurrentURL, "https://en.wikipedia.org/wiki/Kettle", "an allowed start_url must be the first page; current_url")
}

func CheckBudget(ctx *harness.Ctx) {
	c := api(ctx)
	cases := []struct {
		key, label string
		b          map[string]any
	}{
		{"k-1", "without max_steps", body(nil, "max_steps")},
		{"k-2", "with max_steps 0", body(map[string]any{"max_steps": 0}, "")},
		{"k-3", "with max_steps 61", body(map[string]any{"max_steps": 61}, "")},
	}
	for _, tc := range cases {
		r := start(c, tc.b, tc.key)
		ctx.Equal(r.Status, 400, "a start %s must be refused: the budget is required, 1 to 60 steps (%s)", tc.label, r.Text())
	}
	ctx.Equal(len(ctx.Redis.Keys("browser:session:*")), 0, "starts without a valid budget must leave no session; stored sessions")
	r := start(c, body(map[string]any{"max_steps": 60}, ""), "k-4")
	ctx.Assert(r.Status == 201 && viewOf(r).BudgetRemaining == 60, "a start with max_steps 60 answered %d %s, expected 201 with budget_remaining 60", r.Status, r.Text())
}

func CheckIdempotency(ctx *harness.Ctx) {
	c := api(ctx)
	first := start(c, body(nil, ""), "k-1")
	ctx.Equal(first.Status, 201, "the first start (%s)", first.Text())
	replay := start(c, body(nil, ""), "k-1")
	ctx.Assert(replay.Status == 200 && viewOf(replay).SessionID == viewOf(first).SessionID, "a retry with the same Idempotency-Key answered %d %s: it must answer 200 with session %q", replay.Status, replay.Text(), viewOf(first).SessionID)
	ctx.Equal(len(ctx.Redis.Keys("browser:session:*")), 1, "one start and its retry; stored sessions")
	other := c.Post("/v1/browser/sessions", body(nil, ""), "X-Tenant-Id", "globex", "Idempotency-Key", "k-1")
	ctx.Assert(other.Status == 201 && viewOf(other).SessionID != viewOf(first).SessionID, "the same key from another tenant answered %d %s: it is another request and starts its own session", other.Status, other.Text())
	missing := c.Post("/v1/browser/sessions", body(nil, ""), "X-Tenant-Id", "acme")
	ctx.Equal(missing.Status, 400, "a start without Idempotency-Key")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <string>
#include <vector>

#include "browser/sessions.h"

namespace {

const std::string kEntry = "https://www.example.com/";

nlohmann::json body() { return {{"task", "find the price of the 2 L kettle"}, {"profile", "public-web"}, {"max_steps", 10}}; }

harness::HTTP api(harness::Ctx& ctx) {
  static httplib::Server* svr = nullptr;
  delete svr;
  svr = new httplib::Server;
  register_routes(*svr);
  return ctx.HTTP(*svr);
}

harness::Response start(harness::HTTP& c, const nlohmann::json& b, const std::string& key, const std::string& tenant = "acme") {
  return c.Post("/v1/browser/sessions", b.dump(), "Content-Type", "application/json", "X-Tenant-Id", tenant, "Idempotency-Key", key);
}

nlohmann::json viewOf(const harness::Response& r) {
  const auto v = nlohmann::json::parse(r.Text(), nullptr, false);
  return v.is_object() ? v : nlohmann::json::object();
}

}  // namespace

void CheckRoute(harness::Ctx& ctx) {
  auto c = api(ctx);
  auto r = start(c, body(), "k-1");
  ctx.Equal(r.Status, 201, "POST /v1/browser/sessions (%s)", r.Text());
  const auto v = viewOf(r);
  const auto session = sessions::loadSession(v.value("session_id", ""));
  ctx.Assert(session.has_value(), "the answer names session %q, which is not stored under browser:session:{id}", v.value("session_id", ""));
  ctx.Assert(session->tenant == "acme" && session->profile == "public-web", "the stored session belongs to %q under %q, expected acme under public-web", session->tenant, session->profile);
  ctx.Equal(v.value("current_url", ""), kEntry, "a session without start_url starts at the profile's entry; current_url");
  ctx.Equal(v.value("budget_remaining", 0L), 10, "a session of 10 steps; budget_remaining");
  r = c.Post("/v1/browser/sessions", body().dump(), "Content-Type", "application/json", "Idempotency-Key", "k-2");
  ctx.Equal(r.Status, 401, "a start without X-Tenant-Id");
}

void CheckProfile(harness::Ctx& ctx) {
  auto c = api(ctx);
  auto b = body();
  b["profile"] = "intranet";
  auto r = start(c, b, "k-1");
  ctx.Equal(r.Status, 400, "a start with profile 'intranet', which the catalog does not have, must be 400, not a session under another profile (%s)", r.Text());
  b = body();
  b["start_url"] = "http://169.254.169.254/latest/meta-data/";
  r = start(c, b, "k-2");
  ctx.Equal(r.Status, 400, "a start_url outside the profile (http://169.254.169.254/…) must be authorized against the profile and refused (%s)", r.Text());
  ctx.Equal(ctx.Redis.Keys("browser:session:*"), std::vector<std::string>{}, "refused starts must leave no session; stored");
  b["start_url"] = "https://en.wikipedia.org/wiki/Kettle";
  r = start(c, b, "k-3");
  ctx.Equal(r.Status, 201, "a start_url the profile allows (%s)", r.Text());
  ctx.Equal(viewOf(r).value("current_url", ""), "https://en.wikipedia.org/wiki/Kettle", "an allowed start_url must be the first page; current_url");
}

void CheckBudget(harness::Ctx& ctx) {
  auto c = api(ctx);
  auto none = body();
  none.erase("max_steps");
  auto zero = body();
  zero["max_steps"] = 0;
  auto over = body();
  over["max_steps"] = 61;
  const std::vector<std::pair<nlohmann::json, std::string>> cases = {{none, "without max_steps"}, {zero, "with max_steps 0"}, {over, "with max_steps 61"}};
  int n = 0;
  for (const auto& [b, label] : cases) {
    const auto r = start(c, b, "k-" + std::to_string(++n));
    ctx.Equal(r.Status, 400, "a start %s must be refused: the budget is required, 1 to 60 steps (%s)", label, r.Text());
  }
  ctx.Equal(ctx.Redis.Keys("browser:session:*"), std::vector<std::string>{}, "starts without a valid budget must leave no session; stored");
  auto full = body();
  full["max_steps"] = 60;
  const auto r = start(c, full, "k-4");
  ctx.Assert(r.Status == 201 && viewOf(r).value("budget_remaining", 0L) == 60, "a start with max_steps 60 answered %d %s, expected 201 with budget_remaining 60", r.Status, r.Text());
}

void CheckIdempotency(harness::Ctx& ctx) {
  auto c = api(ctx);
  const auto first = start(c, body(), "k-1");
  ctx.Equal(first.Status, 201, "the first start (%s)", first.Text());
  const std::string id = viewOf(first).value("session_id", "");
  const auto replay = start(c, body(), "k-1");
  ctx.Assert(replay.Status == 200 && viewOf(replay).value("session_id", "") == id, "a retry with the same Idempotency-Key answered %d %s: it must answer 200 with session %q", replay.Status, replay.Text(), id);
  ctx.Equal(ctx.Redis.Keys("browser:session:*").size(), 1, "one start and its retry; stored sessions");
  const auto other = start(c, body(), "k-1", "globex");
  ctx.Assert(other.Status == 201 && viewOf(other).value("session_id", "") != id, "the same key from another tenant answered %d %s: it is another request and starts its own session", other.Status, other.Text());
  const auto missing = c.Post("/v1/browser/sessions", body().dump(), "Content-Type", "application/json", "X-Tenant-Id", "acme");
  ctx.Equal(missing.Status, 400, "a start without Idempotency-Key");
}
`,
  },
  hints: [
    'Start a session with profile `intranet`, or with `start_url` pointing at the metadata address: both get a 201. Leave out `max_steps` and the session has no budget; retry the same request and a second session appears in Redis.',
    'The profile lookup falls back to `DEFAULT_PROFILE` instead of failing, and `start_url` never meets `authorize_navigation`. `max_steps` defaults to `UNLIMITED`, and nothing reads `Idempotency-Key`, so each retry calls `create_session` again.',
    '400 when `get_profile` returns nothing; 400 with the reason when `authorize_navigation(profile, start_url)` is not empty; 400 unless `1 <= max_steps <= MAX_STEPS`; then `session_for_key` (200 on a hit), else `create_session` and `remember_key`.',
  ],
  debrief: `The session is the policy, so everything the policy rests on is decided at the door: the profile comes from the server's catalog, a caller's starting page has to fit inside it, and the budget is a number the request must state. A fallback profile is the most dangerous default here because it turns a typo into whatever the fallback allows. The idempotency record is keyed by tenant and key because two tenants' keys are unrelated strings that may collide. Production session APIs also expire idempotency records after a day, store a hash of the request body with the key so a reused key with a different task is refused, and cap concurrent sessions per tenant.`,
};
