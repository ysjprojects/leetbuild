import type {Step} from '@/lib/types';

export const endpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/voice/sessions: a session with a codec contract',
  concept: 'http',
  guides: ['request-boundaries', 'idempotent-requests'],
  file: 'api',
  focus: ['client', 'gateway', 'redis'],
  task: `## Task

**Starting point.** The starter serves \`POST /v1/voice/sessions\` on the session store
(\`voice.sessions\`, provided): it reads \`X-Tenant-Id\` (falling back to \`public\`), takes
\`{codec, sample_rate, max_duration_s}\`, turns a missing or zero duration into
\`DEFAULT_DURATION_S\` (a day) and answers 201 with a fresh \`sessions.create(...)\` every time. It
serves the demo call and hides four flaws.

**Failure mode the checks target.** An anonymous caller gets a session; a format the media pipeline
cannot decode is admitted and dies mid-sentence; a forgotten or huge duration holds a stream for a
day; and a phone that reconnects on a flaky network forks the call into a second session.

- No \`X-Tenant-Id\`, or an empty one, is **401**, and nothing is created.
- \`SUPPORTED_FORMATS\` maps a codec to its sample rates: \`opus\` 16000 or 48000, \`pcm16\` 16000 or
  24000, \`g711_ulaw\` 8000. Any other pair is **415**.
- \`max_duration_s\` defaults to \`DEFAULT_DURATION_S\` (1800) and must be 1 to \`MAX_DURATION_S\`
  (1800); anything else is **400**.
- \`Idempotency-Key\` is required (**400**). Look the pair up with \`sessions.find(tenant, key)\`
  before creating: a replay answers **200** with the stored session, its \`turn_count\` included; a
  new session answers **201** and is recorded with \`sessions.remember\`.`,
  sequence: {
    participants: ['Client', 'Voice Gateway', 'Session store'],
    messages: [
      {
        from: 'Client',
        to: 'Voice Gateway',
        label: 'POST /v1/voice/sessions · X-Tenant-Id · Idempotency-Key · {codec, sample_rate}',
        kind: 'sync',
      },
      {
        from: 'Voice Gateway',
        to: 'Voice Gateway',
        label: 'tenant 401 · key 400 · format 415 · duration 400',
        kind: 'sync',
      },
      {from: 'Voice Gateway', to: 'Session store', label: 'find(tenant, key)', kind: 'sync'},
      {from: 'Session store', to: 'Voice Gateway', label: 'stored session → 200', kind: 'reply'},
      {from: 'Voice Gateway', to: 'Session store', label: 'create(…) · remember(tenant, key, id)', kind: 'sync'},
      {
        from: 'Voice Gateway',
        to: 'Client',
        label: '201 {session_id, codec, sample_rate, max_duration_s, turn_count}',
        kind: 'reply',
      },
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Registers POST /v1/voice/sessions',
      detail:
        'Register the session route on `POST /v1/voice/sessions`; a valid request answers 201 with the stored session.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/voice\/sessions["']/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/voice\/sessions['"]/]},
        go: {all: [/HandleFunc\(\s*"POST \/v1\/voice\/sessions"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"voice"\s*\/\s*"sessions"\s*\)/, /\bpost\s*\{/]},
        cpp: {all: [/svr\.Post\(\s*"\/v1\/voice\/sessions"/]},
      },
    },
    {
      id: 'tenant',
      title: 'A request without a tenant is 401',
      detail:
        'The tenant is `X-Tenant-Id`; a missing or empty header answers **401** before anything is created. The starter falls back to a `public` tenant.',
      match: {
        python: {all: [/x-tenant-id/i, /\b401\b/], none: [/["']public["']/]},
        typescript: {all: [/x-tenant-id/i, /\b401\b/], none: [/['"]public['"]/]},
        go: {all: [/X-Tenant-Id/i, /StatusUnauthorized|\b401\b/], none: [/"public"/]},
        scala: {all: [/X-Tenant-Id/i, /Unauthorized|\b401\b/], none: [/"public"/]},
        cpp: {all: [/X-Tenant-Id/i, /\b401\b/], none: [/"public"/]},
      },
    },
    {
      id: 'formats',
      title: 'A codec and sample rate outside SUPPORTED_FORMATS is 415',
      detail:
        '`SUPPORTED_FORMATS` maps each codec to the sample rates the media pipeline decodes; a pair that is not in it answers **415**.',
      match: {
        python: {all: [/SUPPORTED_FORMATS\s*=/, /\b415\b/]},
        typescript: {all: [/SUPPORTED_FORMATS\s*[:=]/, /\b415\b/]},
        go: {all: [/supportedFormats\s*=/, /StatusUnsupportedMediaType|\b415\b/]},
        scala: {all: [/SupportedFormats\s*[:=]/, /UnsupportedMediaType|\b415\b/]},
        cpp: {all: [/kSupportedFormats\s*=/, /\b415\b/]},
      },
    },
    {
      id: 'duration',
      title: 'A session lasts at most 30 minutes, 30 by default',
      detail:
        '`DEFAULT_DURATION_S` and `MAX_DURATION_S` are 1800: an omitted `max_duration_s` becomes 1800 and a value outside 1 to 1800 answers **400**. The starter defaults to a day.',
      match: {
        python: {all: [/MAX_DURATION_S\s*=\s*1800/, /DEFAULT_DURATION_S\s*=\s*1800/], none: [/86400/]},
        typescript: {all: [/MAX_DURATION_S\s*=\s*1800/, /DEFAULT_DURATION_S\s*=\s*1800/], none: [/86400/]},
        go: {all: [/maxDurationS\s*=\s*1800/, /defaultDurationS\s*=\s*1800/], none: [/86400/]},
        scala: {all: [/MaxDurationS\s*=\s*1800/, /DefaultDurationS\s*=\s*1800/], none: [/86400/]},
        cpp: {all: [/kMaxDurationS\s*=\s*1800/, /kDefaultDurationS\s*=\s*1800/], none: [/86400/]},
      },
    },
    {
      id: 'idempotent-resume',
      title: 'A replayed Idempotency-Key resumes the session it created',
      detail:
        '`Idempotency-Key` is required (400 without it) and `sessions.find(tenant, key)` runs before `sessions.create`: a replay answers 200 with the stored session, a new one is recorded with `sessions.remember`.',
      match: {
        python: {
          all: [/idempotency-key/i, /sessions\.find\(/, /sessions\.remember\(/],
          order: [/sessions\.find\(/, /sessions\.create\(/],
        },
        typescript: {all: [/idempotency-key/i, /\bfind\(/, /\bremember\(/], order: [/await find\(/, /await create\(/]},
        go: {
          all: [/Idempotency-Key/i, /sessions\.Find\(/, /sessions\.Remember\(/],
          order: [/sessions\.Find\(/, /sessions\.Create\(/],
        },
        scala: {
          all: [/Idempotency-Key/i, /Sessions\.find\(/, /Sessions\.remember\(/],
          order: [/Sessions\.find\(/, /Sessions\.create\(/],
        },
        cpp: {
          all: [/Idempotency-Key/i, /sessions::find\(/, /sessions::remember\(/],
          order: [/sessions::find\(/, /sessions::create\(/],
        },
      },
    },
  ],
  code: {
    python: {
      starter: `from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from voice import sessions  # create, get, find, remember

app = FastAPI()

DEFAULT_DURATION_S = 86400


class CreateSession(BaseModel):
    codec: str
    sample_rate: int
    max_duration_s: int | None = None


@app.post("/v1/voice/sessions")
def create_session(body: CreateSession, request: Request) -> JSONResponse:
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    tenant = request.headers.get("x-tenant-id") or "public"
    duration = body.max_duration_s or DEFAULT_DURATION_S
    session = sessions.create(tenant, body.codec, body.sample_rate, duration)
    return JSONResponse(session, status_code=201)
`,
      solution: `from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from voice import sessions  # create, get, find, remember

app = FastAPI()

# The pairs the media pipeline decodes: a sample rate means something only for its codec.
SUPPORTED_FORMATS = {"opus": {16000, 48000}, "pcm16": {16000, 24000}, "g711_ulaw": {8000}}
DEFAULT_DURATION_S = 1800
MAX_DURATION_S = 1800


class CreateSession(BaseModel):
    codec: str
    sample_rate: int
    max_duration_s: int | None = None


@app.post("/v1/voice/sessions")
def create_session(body: CreateSession, request: Request) -> JSONResponse:
    tenant = request.headers.get("x-tenant-id", "")
    if not tenant:
        raise HTTPException(status_code=401, detail="X-Tenant-Id is required")
    key = request.headers.get("idempotency-key", "")
    if not key:
        raise HTTPException(status_code=400, detail="Idempotency-Key is required")
    if body.sample_rate not in SUPPORTED_FORMATS.get(body.codec, set()):
        raise HTTPException(status_code=415, detail=f"unsupported audio format {body.codec} at {body.sample_rate} Hz")
    duration = DEFAULT_DURATION_S if body.max_duration_s is None else body.max_duration_s
    if not 1 <= duration <= MAX_DURATION_S:
        raise HTTPException(status_code=400, detail=f"max_duration_s must be 1 to {MAX_DURATION_S}")
    existing = sessions.find(tenant, key)
    if existing is not None:
        return JSONResponse(existing)  # a reconnect resumes the call it started
    session = sessions.create(tenant, body.codec, body.sample_rate, duration)
    sessions.remember(tenant, key, session["session_id"])
    return JSONResponse(session, status_code=201)
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';

import {create, find, remember} from 'voice/sessions';

export const app = Fastify();

export const DEFAULT_DURATION_S = 86400;

interface CreateSession {
  codec: string;
  sample_rate: number;
  max_duration_s?: number | null;
}

app.post('/v1/voice/sessions', async (request, reply) => {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const tenant = (request.headers['x-tenant-id'] as string | undefined) || 'public';
  const body = request.body as CreateSession;
  const duration = body.max_duration_s || DEFAULT_DURATION_S;
  const session = await create(tenant, body.codec, body.sample_rate, duration);
  return reply.code(201).send(session);
});
`,
      solution: `import Fastify from 'fastify';

import {create, find, remember} from 'voice/sessions';

export const app = Fastify();

// The pairs the media pipeline decodes: a sample rate means something only for its codec.
export const SUPPORTED_FORMATS: Record<string, number[]> = {opus: [16000, 48000], pcm16: [16000, 24000], g711_ulaw: [8000]};
export const DEFAULT_DURATION_S = 1800;
export const MAX_DURATION_S = 1800;

interface CreateSession {
  codec: string;
  sample_rate: number;
  max_duration_s?: number | null;
}

app.post('/v1/voice/sessions', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'X-Tenant-Id is required'});
  const key = request.headers['idempotency-key'];
  if (typeof key !== 'string' || key === '') return reply.code(400).send({error: 'Idempotency-Key is required'});
  const body = request.body as CreateSession;
  if (!(SUPPORTED_FORMATS[body.codec] ?? []).includes(body.sample_rate))
    return reply.code(415).send({error: \`unsupported audio format \${body.codec} at \${body.sample_rate} Hz\`});
  const duration = body.max_duration_s ?? DEFAULT_DURATION_S;
  if (!Number.isInteger(duration) || duration < 1 || duration > MAX_DURATION_S)
    return reply.code(400).send({error: \`max_duration_s must be 1 to \${MAX_DURATION_S}\`});
  const existing = await find(tenant, key);
  if (existing !== null) return reply.code(200).send(existing); // a reconnect resumes the call it started
  const session = await create(tenant, body.codec, body.sample_rate, duration);
  await remember(tenant, key, session.session_id);
  return reply.code(201).send(session);
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"net/http"

	"voice/sessions" // sessions.Create, Get, Find, Remember
)

const defaultDurationS = 86400

type createSession struct {
	Codec        string \`json:"codec"\`
	SampleRate   int    \`json:"sample_rate"\`
	MaxDurationS *int   \`json:"max_duration_s"\`
}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func createSessionHandler(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		tenant = "public"
	}
	var body createSession
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(rw, "invalid body", http.StatusBadRequest)
		return
	}
	duration := defaultDurationS
	if body.MaxDurationS != nil && *body.MaxDurationS != 0 {
		duration = *body.MaxDurationS
	}
	session := sessions.Create(r.Context(), tenant, body.Codec, body.SampleRate, duration)
	writeJSON(rw, http.StatusCreated, session)
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/voice/sessions", createSessionHandler)
}
`,
      solution: `package main

import (
	"encoding/json"
	"fmt"
	"net/http"

	"voice/sessions" // sessions.Create, Get, Find, Remember
)

// supportedFormats are the pairs the media pipeline decodes: a sample rate means something only for its codec.
var supportedFormats = map[string][]int{"opus": {16000, 48000}, "pcm16": {16000, 24000}, "g711_ulaw": {8000}}

const (
	defaultDurationS = 1800
	maxDurationS     = 1800
)

type createSession struct {
	Codec        string \`json:"codec"\`
	SampleRate   int    \`json:"sample_rate"\`
	MaxDurationS *int   \`json:"max_duration_s"\`
}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func supported(codec string, sampleRate int) bool {
	for _, rate := range supportedFormats[codec] {
		if rate == sampleRate {
			return true
		}
	}
	return false
}

func createSessionHandler(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		http.Error(rw, "X-Tenant-Id is required", http.StatusUnauthorized)
		return
	}
	key := r.Header.Get("Idempotency-Key")
	if key == "" {
		http.Error(rw, "Idempotency-Key is required", http.StatusBadRequest)
		return
	}
	var body createSession
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(rw, "invalid body", http.StatusBadRequest)
		return
	}
	if !supported(body.Codec, body.SampleRate) {
		http.Error(rw, fmt.Sprintf("unsupported audio format %s at %d Hz", body.Codec, body.SampleRate), http.StatusUnsupportedMediaType)
		return
	}
	duration := defaultDurationS
	if body.MaxDurationS != nil {
		duration = *body.MaxDurationS
	}
	if duration < 1 || duration > maxDurationS {
		http.Error(rw, fmt.Sprintf("max_duration_s must be 1 to %d", maxDurationS), http.StatusBadRequest)
		return
	}
	if existing := sessions.Find(r.Context(), tenant, key); existing != nil {
		writeJSON(rw, http.StatusOK, existing) // a reconnect resumes the call it started
		return
	}
	session := sessions.Create(r.Context(), tenant, body.Codec, body.SampleRate, duration)
	sessions.Remember(r.Context(), tenant, key, session.SessionID)
	writeJSON(rw, http.StatusCreated, session)
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/voice/sessions", createSessionHandler)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._
import spray.json.DefaultJsonProtocol._

import voice.Sessions // Sessions.create, get, find, remember

object Api {
  val DefaultDurationS = 86400

  private def json(status: StatusCode, body: JsObject): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  val route: Route = path("v1" / "voice" / "sessions") {
    post {
      optionalHeaderValueByName("X-Tenant-Id") { tenantHeader =>
        entity(as[String]) { raw =>
          // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
          val tenant = tenantHeader.filter(_.nonEmpty).getOrElse("public")
          val body = raw.parseJson.asJsObject.fields
          val duration = body.get("max_duration_s").map(_.convertTo[Int]).filter(_ != 0).getOrElse(DefaultDurationS)
          val session = Sessions.create(tenant, body("codec").convertTo[String], body("sample_rate").convertTo[Int], duration)
          complete(json(StatusCodes.Created, session.toJson))
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
import spray.json.DefaultJsonProtocol._

import voice.Sessions // Sessions.create, get, find, remember

object Api {
  /** The pairs the media pipeline decodes: a sample rate means something only for its codec. */
  val SupportedFormats: Map[String, Set[Int]] = Map("opus" -> Set(16000, 48000), "pcm16" -> Set(16000, 24000), "g711_ulaw" -> Set(8000))
  val DefaultDurationS = 1800
  val MaxDurationS = 1800

  private def json(status: StatusCode, body: JsObject): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  val route: Route = path("v1" / "voice" / "sessions") {
    post {
      (optionalHeaderValueByName("X-Tenant-Id") & optionalHeaderValueByName("Idempotency-Key")) { (tenantHeader, keyHeader) =>
        entity(as[String]) { raw =>
          (tenantHeader.filter(_.nonEmpty), keyHeader.filter(_.nonEmpty)) match {
            case (None, _) => complete(StatusCodes.Unauthorized -> "X-Tenant-Id is required")
            case (_, None) => complete(StatusCodes.BadRequest -> "Idempotency-Key is required")
            case (Some(tenant), Some(key)) =>
              val body = raw.parseJson.asJsObject.fields
              val codec = body("codec").convertTo[String]
              val sampleRate = body("sample_rate").convertTo[Int]
              val duration = body.get("max_duration_s").map(_.convertTo[Int]).getOrElse(DefaultDurationS)
              if (!SupportedFormats.get(codec).exists(_.contains(sampleRate)))
                complete(StatusCodes.UnsupportedMediaType -> s"unsupported audio format $codec at $sampleRate Hz")
              else if (duration < 1 || duration > MaxDurationS)
                complete(StatusCodes.BadRequest -> s"max_duration_s must be 1 to $MaxDurationS")
              else
                Sessions.find(tenant, key) match {
                  case Some(existing) => complete(json(StatusCodes.OK, existing.toJson)) // a reconnect resumes the call it started
                  case None =>
                    val session = Sessions.create(tenant, codec, sampleRate, duration)
                    Sessions.remember(tenant, key, session.sessionId)
                    complete(json(StatusCodes.Created, session.toJson))
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

#include "voice/sessions.h"  // sessions::create, get, find, remember

using json = nlohmann::json;

const long kDefaultDurationS = 86400;

void create_session(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) tenant = "public";
  const json body = json::parse(req.body);
  const long requested = body.value("max_duration_s", 0L);
  const long duration = requested != 0 ? requested : kDefaultDurationS;
  const sessions::Session session = sessions::create(tenant, body.value("codec", ""), body.value("sample_rate", 0L), duration);
  res.status = 201;
  res.set_content(sessions::toJson(session).dump(), "application/json");
}

void register_routes(httplib::Server& svr) { svr.Post("/v1/voice/sessions", create_session); }
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <map>
#include <set>
#include <string>

#include "voice/sessions.h"  // sessions::create, get, find, remember

using json = nlohmann::json;

// The pairs the media pipeline decodes: a sample rate means something only for its codec.
const std::map<std::string, std::set<long>> kSupportedFormats = {
    {"opus", {16000, 48000}}, {"pcm16", {16000, 24000}}, {"g711_ulaw", {8000}}};
const long kDefaultDurationS = 1800;
const long kMaxDurationS = 1800;

void fail(httplib::Response& res, int status, const std::string& message) {
  res.status = status;
  res.set_content(message, "text/plain");
}

void create_session(const httplib::Request& req, httplib::Response& res) {
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) return fail(res, 401, "X-Tenant-Id is required");
  const std::string key = req.get_header_value("Idempotency-Key");
  if (key.empty()) return fail(res, 400, "Idempotency-Key is required");
  const json body = json::parse(req.body);
  const std::string codec = body.value("codec", "");
  const long sample_rate = body.value("sample_rate", 0L);
  const auto format = kSupportedFormats.find(codec);
  if (format == kSupportedFormats.end() || format->second.count(sample_rate) == 0)
    return fail(res, 415, "unsupported audio format " + codec + " at " + std::to_string(sample_rate) + " Hz");
  const long duration = body.contains("max_duration_s") ? body["max_duration_s"].get<long>() : kDefaultDurationS;
  if (duration < 1 || duration > kMaxDurationS) return fail(res, 400, "max_duration_s must be 1 to 1800");
  if (const auto existing = sessions::find(tenant, key)) {
    res.set_content(sessions::toJson(*existing).dump(), "application/json");  // a reconnect resumes the call it started
    return;
  }
  const sessions::Session session = sessions::create(tenant, codec, sample_rate, duration);
  sessions::remember(tenant, key, session.session_id);
  res.status = 201;
  res.set_content(sessions::toJson(session).dump(), "application/json");
}

void register_routes(httplib::Server& svr) { svr.Post("/v1/voice/sessions", create_session); }
`,
    },
  },
  harness: {
    python: `from voice import sessions

BODY = {"codec": "pcm16", "sample_rate": 24000}


def _api(ctx):
    return ctx.client(ctx.load("api").app)


def _headers(tenant="acme", key="k-1"):
    headers = {}
    if tenant is not None:
        headers["X-Tenant-Id"] = tenant
    if key is not None:
        headers["Idempotency-Key"] = key
    return headers


async def check_route(ctx):
    async with _api(ctx) as c:
        r = await c.post("/v1/voice/sessions", json={**BODY, "max_duration_s": 600}, headers=_headers())
    assert r.status_code == 201, f"POST /v1/voice/sessions answered {r.status_code}: {r.text}"
    body = r.json()
    stored = sessions.get(body.get("session_id", ""))
    assert stored is not None, f"the answer names session {body.get('session_id')!r}, which the session store does not hold"
    assert stored["tenant"] == "acme" and stored["codec"] == "pcm16" and stored["sample_rate"] == 24000, f"the stored session is {stored}, expected tenant acme, pcm16 at 24000 Hz"
    assert body.get("max_duration_s") == 600 and body.get("turn_count") == 0, f"the answer must carry the session, got {body}"


async def check_tenant(ctx):
    async with _api(ctx) as c:
        missing = await c.post("/v1/voice/sessions", json=BODY, headers=_headers(tenant=None))
        empty = await c.post("/v1/voice/sessions", json=BODY, headers=_headers(tenant="", key="k-2"))
    assert missing.status_code == 401, f"a request without X-Tenant-Id answered {missing.status_code}: {missing.text}. An anonymous caller must not get a session"
    assert empty.status_code == 401, f"a request with an empty X-Tenant-Id answered {empty.status_code}, expected 401"
    created = ctx.redis.keys("voice:session:vs-*")
    assert created == [], f"requests without a tenant created {created}: nothing may be created before the tenant is known"


async def check_formats(ctx):
    async with _api(ctx) as c:
        for codec, rate in (("flac", 44100), ("opus", 44100), ("g711_ulaw", 48000), ("pcm16", 8000)):
            r = await c.post("/v1/voice/sessions", json={"codec": codec, "sample_rate": rate}, headers=_headers(key=f"k-{codec}-{rate}"))
            assert r.status_code == 415, f"{codec} at {rate} Hz answered {r.status_code}, expected 415: the media pipeline cannot decode that pair"
        for codec, rate in (("opus", 48000), ("pcm16", 16000), ("g711_ulaw", 8000)):
            r = await c.post("/v1/voice/sessions", json={"codec": codec, "sample_rate": rate}, headers=_headers(key=f"k-{codec}-{rate}"))
            assert r.status_code == 201, f"{codec} at {rate} Hz is a supported pair but answered {r.status_code}: {r.text}"


async def check_duration(ctx):
    async with _api(ctx) as c:
        r = await c.post("/v1/voice/sessions", json=BODY, headers=_headers())
        assert r.status_code == 201, f"a session without max_duration_s answered {r.status_code}: {r.text}"
        assert r.json().get("max_duration_s") == 1800, f"an omitted max_duration_s became {r.json().get('max_duration_s')}, expected the 1800 s default"
        for value in (3600, 86400, 0, -5):
            r = await c.post("/v1/voice/sessions", json={**BODY, "max_duration_s": value}, headers=_headers(key=f"k-{value}"))
            assert r.status_code == 400, f"max_duration_s = {value} answered {r.status_code}, expected 400: a session lasts 1 to 1800 s"
        r = await c.post("/v1/voice/sessions", json={**BODY, "max_duration_s": 1800}, headers=_headers(key="k-max"))
    assert r.status_code == 201 and r.json().get("max_duration_s") == 1800, f"max_duration_s = 1800 is allowed, it answered {r.status_code} {r.text}"


async def check_idempotent_resume(ctx):
    async with _api(ctx) as c:
        first = await c.post("/v1/voice/sessions", json=BODY, headers=_headers())
        assert first.status_code == 201, f"the first create answered {first.status_code}: {first.text}"
        session_id = first.json()["session_id"]
        ctx.redis.hset(f"voice:session:{session_id}", "turn_count", 3)  # three turns in, the network drops
        replay = await c.post("/v1/voice/sessions", json=BODY, headers=_headers())
        assert replay.status_code == 200, f"a replay of Idempotency-Key k-1 answered {replay.status_code}, expected 200 with the session it created"
        assert replay.json().get("session_id") == session_id, f"a replay forked the call: it answered {replay.json().get('session_id')}, the key created {session_id}"
        assert replay.json().get("turn_count") == 3, f"a replay must answer the stored session (turn_count 3), got {replay.json()}"
        other = await c.post("/v1/voice/sessions", json=BODY, headers=_headers(tenant="globex"))
        assert other.status_code == 201 and other.json().get("session_id") != session_id, f"another tenant with the same key got {other.status_code} {other.text}: keys are scoped by tenant"
        fresh = await c.post("/v1/voice/sessions", json=BODY, headers=_headers(key="k-2"))
        assert fresh.status_code == 201 and fresh.json().get("session_id") != session_id, f"a new key must create a new session, got {fresh.status_code} {fresh.text}"
        none = await c.post("/v1/voice/sessions", json=BODY, headers=_headers(key=None))
    assert none.status_code == 400, f"a create without Idempotency-Key answered {none.status_code}, expected 400"
`,
    typescript: `const BODY = {codec: 'pcm16', sample_rate: 24000};

function api(ctx) {
  const m = ctx.load('api');
  return {c: ctx.client(m.app), sessions: ctx.load('/support/voice/sessions.ts')};
}

function headers(tenant: string | null = 'acme', key: string | null = 'k-1'): Record<string, string> {
  const out: Record<string, string> = {};
  if (tenant !== null) out['X-Tenant-Id'] = tenant;
  if (key !== null) out['Idempotency-Key'] = key;
  return out;
}

const post = (c, body, h: Record<string, string>) => c.post('/v1/voice/sessions', {json: body, headers: h});

export async function check_route(ctx) {
  const {c, sessions} = api(ctx);
  const r = await post(c, {...BODY, max_duration_s: 600}, headers());
  assert.equal(r.status, 201, \`POST /v1/voice/sessions answered \${r.status}: \${r.text}\`);
  const body = r.json();
  const stored = await sessions.get(body.session_id ?? '');
  assert(stored !== null, \`the answer names session \${body.session_id}, which the session store does not hold\`);
  assert(stored.tenant === 'acme' && stored.codec === 'pcm16' && stored.sample_rate === 24000, \`the stored session is \${JSON.stringify(stored)}, expected tenant acme, pcm16 at 24000 Hz\`);
  assert(body.max_duration_s === 600 && body.turn_count === 0, \`the answer must carry the session, got \${r.text}\`);
}

export async function check_tenant(ctx) {
  const {c} = api(ctx);
  const missing = await post(c, BODY, headers(null));
  const empty = await post(c, BODY, headers('', 'k-2'));
  assert.equal(missing.status, 401, \`a request without X-Tenant-Id answered \${missing.status}: \${missing.text}. An anonymous caller must not get a session\`);
  assert.equal(empty.status, 401, \`a request with an empty X-Tenant-Id answered \${empty.status}, expected 401\`);
  const created = ctx.redis.keys('voice:session:vs-*');
  assert.equal(created.length, 0, \`requests without a tenant created \${JSON.stringify(created)}: nothing may be created before the tenant is known\`);
}

export async function check_formats(ctx) {
  const {c} = api(ctx);
  for (const [codec, rate] of [['flac', 44100], ['opus', 44100], ['g711_ulaw', 48000], ['pcm16', 8000]] as const) {
    const r = await post(c, {codec, sample_rate: rate}, headers('acme', \`k-\${codec}-\${rate}\`));
    assert.equal(r.status, 415, \`\${codec} at \${rate} Hz answered \${r.status}, expected 415: the media pipeline cannot decode that pair\`);
  }
  for (const [codec, rate] of [['opus', 48000], ['pcm16', 16000], ['g711_ulaw', 8000]] as const) {
    const r = await post(c, {codec, sample_rate: rate}, headers('acme', \`k-\${codec}-\${rate}\`));
    assert.equal(r.status, 201, \`\${codec} at \${rate} Hz is a supported pair but answered \${r.status}: \${r.text}\`);
  }
}

export async function check_duration(ctx) {
  const {c} = api(ctx);
  let r = await post(c, BODY, headers());
  assert.equal(r.status, 201, \`a session without max_duration_s answered \${r.status}: \${r.text}\`);
  assert.equal(r.json().max_duration_s, 1800, \`an omitted max_duration_s became \${r.json().max_duration_s}, expected the 1800 s default\`);
  for (const value of [3600, 86400, 0, -5]) {
    r = await post(c, {...BODY, max_duration_s: value}, headers('acme', \`k-\${value}\`));
    assert.equal(r.status, 400, \`max_duration_s = \${value} answered \${r.status}, expected 400: a session lasts 1 to 1800 s\`);
  }
  r = await post(c, {...BODY, max_duration_s: 1800}, headers('acme', 'k-max'));
  assert(r.status === 201 && r.json().max_duration_s === 1800, \`max_duration_s = 1800 is allowed, it answered \${r.status} \${r.text}\`);
}

export async function check_idempotent_resume(ctx) {
  const {c} = api(ctx);
  const first = await post(c, BODY, headers());
  assert.equal(first.status, 201, \`the first create answered \${first.status}: \${first.text}\`);
  const sessionId = first.json().session_id;
  ctx.redis.hset(\`voice:session:\${sessionId}\`, 'turn_count', '3'); // three turns in, the network drops
  const replay = await post(c, BODY, headers());
  assert.equal(replay.status, 200, \`a replay of Idempotency-Key k-1 answered \${replay.status}, expected 200 with the session it created\`);
  assert.equal(replay.json().session_id, sessionId, \`a replay forked the call: it answered \${replay.json().session_id}, the key created \${sessionId}\`);
  assert.equal(replay.json().turn_count, 3, \`a replay must answer the stored session (turn_count 3), got \${replay.text}\`);
  const other = await post(c, BODY, headers('globex'));
  assert(other.status === 201 && other.json().session_id !== sessionId, \`another tenant with the same key got \${other.status} \${other.text}: keys are scoped by tenant\`);
  const fresh = await post(c, BODY, headers('acme', 'k-2'));
  assert(fresh.status === 201 && fresh.json().session_id !== sessionId, \`a new key must create a new session, got \${fresh.status} \${fresh.text}\`);
  const none = await post(c, BODY, headers('acme', null));
  assert.equal(none.status, 400, \`a create without Idempotency-Key answered \${none.status}, expected 400\`);
}
`,
    go: `package main

import (
	"context"
	"fmt"
	"net/http"

	"voice/sessions"

	"leetbuild/harness"
)

var sessionBody = map[string]any{"codec": "pcm16", "sample_rate": 24000}

func api(ctx *harness.Ctx) *harness.HTTP {
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

type sessionAnswer struct {
	SessionID    string \`json:"session_id"\`
	MaxDurationS int    \`json:"max_duration_s"\`
	TurnCount    int    \`json:"turn_count"\`
}

func answerOf(r *harness.Response) sessionAnswer {
	var a sessionAnswer
	if r.Status == 200 || r.Status == 201 {
		r.Decode(&a)
	}
	return a
}

func withDuration(seconds int) map[string]any {
	return map[string]any{"codec": "pcm16", "sample_rate": 24000, "max_duration_s": seconds}
}

func CheckRoute(ctx *harness.Ctx) {
	r := api(ctx).Post("/v1/voice/sessions", withDuration(600), "X-Tenant-Id", "acme", "Idempotency-Key", "k-1")
	ctx.Equal(r.Status, 201, "POST /v1/voice/sessions (%s)", r.Text())
	a := answerOf(r)
	stored := sessions.Get(context.Background(), a.SessionID)
	ctx.Assert(stored != nil, "the answer names session %q, which the session store does not hold", a.SessionID)
	ctx.Assert(stored.Tenant == "acme" && stored.Codec == "pcm16" && stored.SampleRate == 24000, "the stored session is %+v, expected tenant acme, pcm16 at 24000 Hz", stored)
	ctx.Assert(a.MaxDurationS == 600 && a.TurnCount == 0, "the answer must carry the session, got %s", r.Text())
}

func CheckTenant(ctx *harness.Ctx) {
	c := api(ctx)
	missing := c.Post("/v1/voice/sessions", sessionBody, "Idempotency-Key", "k-1")
	empty := c.Post("/v1/voice/sessions", sessionBody, "X-Tenant-Id", "", "Idempotency-Key", "k-2")
	ctx.Equal(missing.Status, 401, "a request without X-Tenant-Id (%s): an anonymous caller must not get a session; the status", missing.Text())
	ctx.Equal(empty.Status, 401, "a request with an empty X-Tenant-Id; the status")
	created := ctx.Redis.Keys("voice:session:vs-*")
	ctx.Assert(len(created) == 0, "requests without a tenant created %q: nothing may be created before the tenant is known", created)
}

func CheckFormats(ctx *harness.Ctx) {
	c := api(ctx)
	for _, f := range []struct {
		codec string
		rate  int
	}{{"flac", 44100}, {"opus", 44100}, {"g711_ulaw", 48000}, {"pcm16", 8000}} {
		r := c.Post("/v1/voice/sessions", map[string]any{"codec": f.codec, "sample_rate": f.rate}, "X-Tenant-Id", "acme", "Idempotency-Key", fmt.Sprintf("k-%s-%d", f.codec, f.rate))
		ctx.Equal(r.Status, 415, "%s at %d Hz: the media pipeline cannot decode that pair; the status", f.codec, f.rate)
	}
	for _, f := range []struct {
		codec string
		rate  int
	}{{"opus", 48000}, {"pcm16", 16000}, {"g711_ulaw", 8000}} {
		r := c.Post("/v1/voice/sessions", map[string]any{"codec": f.codec, "sample_rate": f.rate}, "X-Tenant-Id", "acme", "Idempotency-Key", fmt.Sprintf("k-%s-%d", f.codec, f.rate))
		ctx.Equal(r.Status, 201, "%s at %d Hz is a supported pair (%s); the status", f.codec, f.rate, r.Text())
	}
}

func CheckDuration(ctx *harness.Ctx) {
	c := api(ctx)
	r := c.Post("/v1/voice/sessions", sessionBody, "X-Tenant-Id", "acme", "Idempotency-Key", "k-1")
	ctx.Equal(r.Status, 201, "a session without max_duration_s (%s)", r.Text())
	ctx.Equal(answerOf(r).MaxDurationS, 1800, "an omitted max_duration_s must become the 1800 s default; it became")
	for _, value := range []int{3600, 86400, 0, -5} {
		r = c.Post("/v1/voice/sessions", withDuration(value), "X-Tenant-Id", "acme", "Idempotency-Key", fmt.Sprintf("k-%d", value))
		ctx.Equal(r.Status, 400, "max_duration_s = %d: a session lasts 1 to 1800 s; the status", value)
	}
	r = c.Post("/v1/voice/sessions", withDuration(1800), "X-Tenant-Id", "acme", "Idempotency-Key", "k-max")
	ctx.Assert(r.Status == 201 && answerOf(r).MaxDurationS == 1800, "max_duration_s = 1800 is allowed, it answered %d %s", r.Status, r.Text())
}

func CheckIdempotentResume(ctx *harness.Ctx) {
	c := api(ctx)
	first := c.Post("/v1/voice/sessions", sessionBody, "X-Tenant-Id", "acme", "Idempotency-Key", "k-1")
	ctx.Equal(first.Status, 201, "the first create (%s)", first.Text())
	sessionID := answerOf(first).SessionID
	ctx.Redis.Do("HSET", "voice:session:"+sessionID, "turn_count", 3) // three turns in, the network drops
	replay := c.Post("/v1/voice/sessions", sessionBody, "X-Tenant-Id", "acme", "Idempotency-Key", "k-1")
	ctx.Equal(replay.Status, 200, "a replay of Idempotency-Key k-1 must answer 200 with the session it created; the status")
	ctx.Equal(answerOf(replay).SessionID, sessionID, "a replay forked the call; the session it answered")
	ctx.Equal(answerOf(replay).TurnCount, 3, "a replay must answer the stored session; its turn_count")
	other := c.Post("/v1/voice/sessions", sessionBody, "X-Tenant-Id", "globex", "Idempotency-Key", "k-1")
	ctx.Assert(other.Status == 201 && answerOf(other).SessionID != sessionID, "another tenant with the same key got %d %s: keys are scoped by tenant", other.Status, other.Text())
	fresh := c.Post("/v1/voice/sessions", sessionBody, "X-Tenant-Id", "acme", "Idempotency-Key", "k-2")
	ctx.Assert(fresh.Status == 201 && answerOf(fresh).SessionID != sessionID, "a new key must create a new session, got %d %s", fresh.Status, fresh.Text())
	none := c.Post("/v1/voice/sessions", sessionBody, "X-Tenant-Id", "acme")
	ctx.Equal(none.Status, 400, "a create without Idempotency-Key; the status")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <string>
#include <utility>
#include <vector>

namespace {

const std::string kBody = R"({"codec": "pcm16", "sample_rate": 24000})";

harness::HTTP api(harness::Ctx& ctx) {
  static httplib::Server* svr = nullptr;
  delete svr;
  svr = new httplib::Server;
  register_routes(*svr);
  return ctx.HTTP(*svr);
}

harness::Response create(harness::HTTP& c, const std::string& body, const std::string& tenant, const std::string& key) {
  return c.Post("/v1/voice/sessions", body, "Content-Type", "application/json", "X-Tenant-Id", tenant, "Idempotency-Key", key);
}

nlohmann::json answerOf(const harness::Response& r) {
  return r.Status == 200 || r.Status == 201 ? nlohmann::json::parse(r.Text()) : nlohmann::json::object();
}

std::string withDuration(long seconds) {
  return R"({"codec": "pcm16", "sample_rate": 24000, "max_duration_s": )" + std::to_string(seconds) + "}";
}

std::string format(const std::string& codec, long rate) {
  return R"({"codec": ")" + codec + R"(", "sample_rate": )" + std::to_string(rate) + "}";
}

}  // namespace

void CheckRoute(harness::Ctx& ctx) {
  auto c = api(ctx);
  const auto r = create(c, withDuration(600), "acme", "k-1");
  ctx.Equal(r.Status, 201, "POST /v1/voice/sessions (%s)", r.Text());
  const auto a = answerOf(r);
  const auto stored = sessions::get(a.value("session_id", ""));
  ctx.Assert(stored.has_value(), "the answer names session %q, which the session store does not hold", a.value("session_id", ""));
  ctx.Assert(stored->tenant == "acme" && stored->codec == "pcm16" && stored->sample_rate == 24000, "the stored session is %s, expected tenant acme, pcm16 at 24000 Hz", sessions::toJson(*stored).dump());
  ctx.Assert(a.value("max_duration_s", 0L) == 600 && a.value("turn_count", -1L) == 0, "the answer must carry the session, got %s", r.Text());
}

void CheckTenant(harness::Ctx& ctx) {
  auto c = api(ctx);
  const auto missing = c.Post("/v1/voice/sessions", kBody, "Content-Type", "application/json", "Idempotency-Key", "k-1");
  const auto empty = create(c, kBody, "", "k-2");
  ctx.Equal(missing.Status, 401, "a request without X-Tenant-Id (%s): an anonymous caller must not get a session; the status", missing.Text());
  ctx.Equal(empty.Status, 401, "a request with an empty X-Tenant-Id; the status");
  const auto created = ctx.Redis.Keys("voice:session:vs-*");
  ctx.Assert(created.empty(), "requests without a tenant created %q: nothing may be created before the tenant is known", created);
}

void CheckFormats(harness::Ctx& ctx) {
  auto c = api(ctx);
  const std::vector<std::pair<std::string, long>> refused = {{"flac", 44100}, {"opus", 44100}, {"g711_ulaw", 48000}, {"pcm16", 8000}};
  for (const auto& [codec, rate] : refused) {
    const auto r = create(c, format(codec, rate), "acme", "k-" + codec + "-" + std::to_string(rate));
    ctx.Equal(r.Status, 415, "%s at %d Hz: the media pipeline cannot decode that pair; the status", codec, rate);
  }
  const std::vector<std::pair<std::string, long>> accepted = {{"opus", 48000}, {"pcm16", 16000}, {"g711_ulaw", 8000}};
  for (const auto& [codec, rate] : accepted) {
    const auto r = create(c, format(codec, rate), "acme", "k-" + codec + "-" + std::to_string(rate));
    ctx.Equal(r.Status, 201, "%s at %d Hz is a supported pair (%s); the status", codec, rate, r.Text());
  }
}

void CheckDuration(harness::Ctx& ctx) {
  auto c = api(ctx);
  auto r = create(c, kBody, "acme", "k-1");
  ctx.Equal(r.Status, 201, "a session without max_duration_s (%s)", r.Text());
  ctx.Equal(answerOf(r).value("max_duration_s", 0L), 1800, "an omitted max_duration_s must become the 1800 s default; it became");
  for (const long value : {3600L, 86400L, 0L, -5L}) {
    r = create(c, withDuration(value), "acme", "k-" + std::to_string(value));
    ctx.Equal(r.Status, 400, "max_duration_s = %d: a session lasts 1 to 1800 s; the status", value);
  }
  r = create(c, withDuration(1800), "acme", "k-max");
  ctx.Assert(r.Status == 201 && answerOf(r).value("max_duration_s", 0L) == 1800, "max_duration_s = 1800 is allowed, it answered %d %s", r.Status, r.Text());
}

void CheckIdempotentResume(harness::Ctx& ctx) {
  auto c = api(ctx);
  const auto first = create(c, kBody, "acme", "k-1");
  ctx.Equal(first.Status, 201, "the first create (%s)", first.Text());
  const std::string session_id = answerOf(first).value("session_id", "");
  ctx.Redis.Do("HSET", "voice:session:" + session_id, "turn_count", "3");  // three turns in, the network drops
  const auto replay = create(c, kBody, "acme", "k-1");
  ctx.Equal(replay.Status, 200, "a replay of Idempotency-Key k-1 must answer 200 with the session it created; the status");
  ctx.Equal(answerOf(replay).value("session_id", ""), session_id, "a replay forked the call; the session it answered");
  ctx.Equal(answerOf(replay).value("turn_count", 0L), 3, "a replay must answer the stored session; its turn_count");
  const auto other = create(c, kBody, "globex", "k-1");
  ctx.Assert(other.Status == 201 && answerOf(other).value("session_id", "") != session_id, "another tenant with the same key got %d %s: keys are scoped by tenant", other.Status, other.Text());
  const auto fresh = create(c, kBody, "acme", "k-2");
  ctx.Assert(fresh.Status == 201 && answerOf(fresh).value("session_id", "") != session_id, "a new key must create a new session, got %d %s", fresh.Status, fresh.Text());
  const auto none = c.Post("/v1/voice/sessions", kBody, "Content-Type", "application/json", "X-Tenant-Id", "acme");
  ctx.Equal(none.Status, 400, "a create without Idempotency-Key; the status");
}
`,
  },
  hints: [
    "A caller's phone hops from Wi-Fi to cellular and reconnects: the agent greets them again and the bill shows two sessions. A request with no tenant header, or a FLAC stream, gets a session too.",
    'The handler trusts the request: the tenant falls back to `public`, any codec and rate pass, a missing or zero duration becomes a day, and it calls `sessions.create` without reading `Idempotency-Key`.',
    '401 on an empty tenant, 400 without a key, 415 unless `sample_rate` is in `SUPPORTED_FORMATS[codec]`, default 1800 and 400 outside 1 to 1800; then answer `sessions.find(tenant, key)` with 200, else create, `remember`, 201.',
  ],
  debrief: `The guards run in cost order, each one protecting something more expensive than itself: the tenant before any state, the format before a media stream is reserved, the duration before a stream can outlive its caller. The format is a pair rather than two lists because a sample rate only means something for its codec; G.711 at 48 kHz is not a stream anyone decodes. The idempotency record is scoped by tenant, so two customers who pick the same key never share a call, and it answers the stored session, so a reconnect sees the turns the call already had. Production gateways also cap concurrent sessions per tenant, negotiate a format instead of refusing it, and close a session the media path has not touched for a while.`,
};
