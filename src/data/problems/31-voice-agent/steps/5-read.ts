import type {Step} from '@/lib/types';

export const readStep: Step = {
  id: 'read',
  title: 'GET /v1/voice/sessions/{id}: a tenant-scoped transcript in pages',
  concept: 'http',
  guides: ['honest-reads', 'request-boundaries'],
  file: 'read',
  focus: ['client', 'gateway', 'redis', 'transcripts'],
  task: `## Task

**Starting point.** The starter serves \`GET /v1/voice/sessions/{session_id}\` on the provided stores:
it looks the session up with \`sessions.get\`, reads up to 10,000 turns with
\`transcripts.list_turns(session_id, -1, 10000)\` and answers \`{session_id, turns}\` with every stored
row as it is. It serves the demo transcript and hides four flaws.

**Failure mode the checks target.** Any caller who guesses a session id reads another company's call;
a 30-minute call answers one huge array; and every turn carries the path of the raw recording the
redaction was meant to stand in for.

- The tenant is \`X-Tenant-Id\` (**401** without it). A session of another tenant is **404**, with the
  same body as a session that does not exist.
- A page holds \`limit\` turns (default \`DEFAULT_LIMIT\`, 100) and never more than \`MAX_TURNS\` (500);
  a \`limit\` that is not a positive integer is **400**.
- \`next_cursor\` is the last \`turn_index\` of the page when more turns follow, else \`null\`;
  \`?cursor=\` continues after it.
- Each turn is \`turn_index\`, \`started_at\`, \`ended_at\`, \`text\` and \`redaction_spans\`, and no
  \`audio_path\`.`,
  sequence: {
    participants: ['Client', 'Voice Gateway', 'Session store', 'Transcript store'],
    messages: [
      {
        from: 'Client',
        to: 'Voice Gateway',
        label: 'GET /v1/voice/sessions/{id}?limit=100&cursor=99 · X-Tenant-Id',
        kind: 'sync',
      },
      {from: 'Voice Gateway', to: 'Session store', label: 'get(id) → tenant matches? else 404', kind: 'sync'},
      {from: 'Voice Gateway', to: 'Transcript store', label: 'list_turns(id, after 99, 101)', kind: 'sync'},
      {from: 'Transcript store', to: 'Voice Gateway', label: 'turns 100 … 200', kind: 'reply'},
      {from: 'Voice Gateway', to: 'Client', label: '200 {turns: 100 … 199, next_cursor: "199"}', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Registers GET /v1/voice/sessions/{id}',
      detail:
        'Register the transcript route on `GET /v1/voice/sessions/{session_id}`; it answers the turns in `turn_index` order.',
      match: {
        python: {all: [/@app\.get\(\s*["']\/v1\/voice\/sessions\/\{session_id\}["']/]},
        typescript: {all: [/app\.get\(\s*['"]\/v1\/voice\/sessions\/:sessionId['"]/]},
        go: {all: [/HandleFunc\(\s*"GET \/v1\/voice\/sessions\/\{id\}"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"voice"\s*\/\s*"sessions"\s*\/\s*Segment\s*\)/, /\bget\s*\{/]},
        cpp: {all: [/svr\.Get\(\s*R"\(\/v1\/voice\/sessions\//]},
      },
    },
    {
      id: 'tenant-scope',
      title: "A foreign session is 404, never another tenant's transcript",
      detail:
        'The tenant is `X-Tenant-Id` (401 without it) and a session whose tenant differs answers **404** with the same body as a missing one; the starter never reads the tenant.',
      match: {
        python: {all: [/x-tenant-id/i, /\btenant\b[^\n]*!=|!=[^\n]*\btenant\b/]},
        typescript: {all: [/x-tenant-id/i, /\.tenant\s*!==|!==\s*[\w.]*tenant/]},
        go: {all: [/X-Tenant-Id/i, /\.Tenant\s*!=|!=\s*[\w.]*Tenant/]},
        scala: {all: [/X-Tenant-Id/i, /\.tenant\s*[!=]=|[!=]=\s*[\w.]*tenant/]},
        cpp: {all: [/X-Tenant-Id/i, /(->|\.)tenant\s*!=|!=\s*[\w.>-]*tenant/]},
      },
    },
    {
      id: 'turn-cap',
      title: 'Caps every page at 500 turns, 100 by default',
      detail:
        'A page holds `limit` turns, `DEFAULT_LIMIT` (100) when the caller sends none, clamped to `MAX_TURNS` (500); the starter reads 10,000.',
      match: {
        python: {all: [/MAX_TURNS\s*=\s*500/, /DEFAULT_LIMIT\s*=\s*100/], none: [/10_?000/]},
        typescript: {all: [/MAX_TURNS\s*=\s*500/, /DEFAULT_LIMIT\s*=\s*100/], none: [/10_?000/]},
        go: {all: [/maxTurns\s*=\s*500/, /defaultLimit\s*=\s*100/], none: [/10_?000/]},
        scala: {all: [/MaxTurns\s*=\s*500/, /DefaultLimit\s*=\s*100/], none: [/10_?000/]},
        cpp: {all: [/kMaxTurns\s*=\s*500/, /kDefaultLimit\s*=\s*100/], none: [/10'?000/]},
      },
    },
    {
      id: 'cursor',
      title: 'Pages the transcript with a cursor over the turn index',
      detail:
        'The response carries `next_cursor`, the last `turn_index` of a full page or null on the last one, and `?cursor=` continues after it, so a client walks a long call page by page.',
      match: {
        python: {all: [/next_cursor/, /["']cursor["']/]},
        typescript: {all: [/next_cursor/, /cursor\?\s*:/]},
        go: {all: [/next_cursor/, /"cursor"/]},
        scala: {all: [/next_cursor/, /"cursor"/]},
        cpp: {all: [/next_cursor/, /"cursor"/]},
      },
    },
    {
      id: 'no-audio-path',
      title: 'Answers redaction spans, never a recording path',
      detail:
        'Each turn is built from `turn_index`, `started_at`, `ended_at`, `text` and `redaction_spans`, and `audio_path` appears nowhere in the file; the starter passes the stored rows through.',
      match: {
        python: {all: [/["']redaction_spans["']/], none: [/audio_path/]},
        typescript: {all: [/redaction_spans:/], none: [/audio_path/]},
        go: {all: [/RedactionSpans/], none: [/AudioPath|audio_path/]},
        scala: {all: [/"redaction_spans"/], none: [/audioPath|audio_path/]},
        cpp: {all: [/"redaction_spans"/], none: [/audio_path/]},
      },
    },
  ],
  code: {
    python: {
      starter: `from fastapi import FastAPI, HTTPException

from voice import sessions, transcripts  # sessions.get; transcripts.list_turns

app = FastAPI()


@app.get("/v1/voice/sessions/{session_id}")
def read_transcript(session_id: str) -> dict:
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    session = sessions.get(session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="no such session")
    turns = transcripts.list_turns(session_id, -1, 10000)
    return {"session_id": session_id, "turns": turns}
`,
      solution: `from fastapi import FastAPI, HTTPException, Request

from voice import sessions, transcripts  # sessions.get; transcripts.list_turns

app = FastAPI()

MAX_TURNS = 500
DEFAULT_LIMIT = 100
# What a reader gets of a turn: the redacted text and its spans, never where the recording is.
TURN_FIELDS = ("turn_index", "started_at", "ended_at", "text", "redaction_spans")


@app.get("/v1/voice/sessions/{session_id}")
def read_transcript(session_id: str, request: Request) -> dict:
    tenant = request.headers.get("x-tenant-id", "")
    if not tenant:
        raise HTTPException(status_code=401, detail="X-Tenant-Id is required")
    session = sessions.get(session_id)
    if session is None or session["tenant"] != tenant:
        raise HTTPException(status_code=404, detail="no such session")  # a foreign session looks exactly like a missing one
    try:
        limit = int(request.query_params.get("limit", DEFAULT_LIMIT))
        after = int(request.query_params.get("cursor", -1))
    except ValueError:
        raise HTTPException(status_code=400, detail="limit and cursor are integers")
    if limit < 1:
        raise HTTPException(status_code=400, detail="limit must be positive")
    limit = min(limit, MAX_TURNS)
    rows = transcripts.list_turns(session_id, after, limit + 1)  # one past the page: is there a next one?
    page = rows[:limit]
    next_cursor = str(page[-1]["turn_index"]) if len(rows) > limit else None
    return {"session_id": session_id, "turns": [{name: row[name] for name in TURN_FIELDS} for row in page], "next_cursor": next_cursor}
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';

import {get} from 'voice/sessions';
import {listTurns} from 'voice/transcripts';

export const app = Fastify();

app.get('/v1/voice/sessions/:sessionId', async (request, reply) => {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const {sessionId} = request.params as {sessionId: string};
  const session = await get(sessionId);
  if (session === null) return reply.code(404).send({error: 'no such session'});
  const turns = await listTurns(sessionId, -1, 10000);
  return {session_id: sessionId, turns};
});
`,
      solution: `import Fastify from 'fastify';

import {get} from 'voice/sessions';
import {listTurns} from 'voice/transcripts';

export const app = Fastify();

export const MAX_TURNS = 500;
export const DEFAULT_LIMIT = 100;

const integer = (text: string | undefined, fallback: number): number | null =>
  text === undefined ? fallback : /^-?\\d+$/.test(text) ? Number(text) : null;

app.get('/v1/voice/sessions/:sessionId', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'X-Tenant-Id is required'});
  const {sessionId} = request.params as {sessionId: string};
  const session = await get(sessionId);
  // A foreign session looks exactly like a missing one.
  if (session === null || session.tenant !== tenant) return reply.code(404).send({error: 'no such session'});
  const {limit: limitText, cursor} = request.query as {limit?: string; cursor?: string};
  const requested = integer(limitText, DEFAULT_LIMIT);
  const after = integer(cursor, -1);
  if (requested === null || after === null || requested < 1) return reply.code(400).send({error: 'limit and cursor are integers, limit positive'});
  const limit = Math.min(requested, MAX_TURNS);
  const rows = await listTurns(sessionId, after, limit + 1); // one past the page: is there a next one?
  const page = rows.slice(0, limit);
  // What a reader gets of a turn: the redacted text and its spans, never where the recording is.
  const turns = page.map(t => ({
    turn_index: t.turn_index,
    started_at: t.started_at,
    ended_at: t.ended_at,
    text: t.text,
    redaction_spans: t.redaction_spans,
  }));
  const nextCursor = rows.length > limit ? String(page[page.length - 1].turn_index) : null;
  return {session_id: sessionId, turns, next_cursor: nextCursor};
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"net/http"

	"voice/sessions"    // sessions.Get
	"voice/transcripts" // transcripts.ListTurns
)

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func readTranscript(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	sessionID := r.PathValue("id")
	if sessions.Get(r.Context(), sessionID) == nil {
		http.Error(rw, "no such session", http.StatusNotFound)
		return
	}
	turns := transcripts.ListTurns(r.Context(), sessionID, -1, 10000)
	writeJSON(rw, http.StatusOK, map[string]any{"session_id": sessionID, "turns": turns})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/voice/sessions/{id}", readTranscript)
}
`,
      solution: `package main

import (
	"encoding/json"
	"net/http"
	"strconv"

	"voice/sessions"    // sessions.Get
	"voice/transcripts" // transcripts.ListTurns
)

const (
	maxTurns     = 500
	defaultLimit = 100
)

// turnView is what a reader gets of a turn: the redacted text and its spans, never where the recording is.
type turnView struct {
	TurnIndex      int     \`json:"turn_index"\`
	StartedAt      int64   \`json:"started_at"\`
	EndedAt        int64   \`json:"ended_at"\`
	Text           string  \`json:"text"\`
	RedactionSpans [][]int \`json:"redaction_spans"\`
}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

// integer is the query parameter as an int, fallback when absent; false when it is not one.
func integer(r *http.Request, name string, fallback int) (int, bool) {
	text := r.URL.Query().Get(name)
	if text == "" {
		return fallback, true
	}
	n, err := strconv.Atoi(text)
	return n, err == nil
}

func readTranscript(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		http.Error(rw, "X-Tenant-Id is required", http.StatusUnauthorized)
		return
	}
	sessionID := r.PathValue("id")
	session := sessions.Get(r.Context(), sessionID)
	if session == nil || session.Tenant != tenant {
		http.Error(rw, "no such session", http.StatusNotFound) // a foreign session looks exactly like a missing one
		return
	}
	limit, okLimit := integer(r, "limit", defaultLimit)
	after, okCursor := integer(r, "cursor", -1)
	if !okLimit || !okCursor || limit < 1 {
		http.Error(rw, "limit and cursor are integers, limit positive", http.StatusBadRequest)
		return
	}
	limit = min(limit, maxTurns)
	rows := transcripts.ListTurns(r.Context(), sessionID, after, limit+1) // one past the page: is there a next one?
	page := rows[:min(len(rows), limit)]
	turns := []turnView{}
	for _, t := range page {
		turns = append(turns, turnView{TurnIndex: t.TurnIndex, StartedAt: t.StartedAt, EndedAt: t.EndedAt, Text: t.Text, RedactionSpans: t.RedactionSpans})
	}
	var nextCursor any
	if len(rows) > limit {
		nextCursor = strconv.Itoa(page[len(page)-1].TurnIndex)
	}
	writeJSON(rw, http.StatusOK, map[string]any{"session_id": sessionID, "turns": turns, "next_cursor": nextCursor})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/voice/sessions/{id}", readTranscript)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._
import spray.json.DefaultJsonProtocol._

import voice.{Sessions, Transcripts} // Sessions.get; Transcripts.listTurns

object Read {
  private def json(status: StatusCode, body: JsObject): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  private def turnJson(t: Transcripts.Turn): JsObject = JsObject(
    "turn_index" -> JsNumber(t.turnIndex), "started_at" -> JsNumber(t.startedAt), "ended_at" -> JsNumber(t.endedAt),
    "text" -> JsString(t.text), "redaction_spans" -> t.redactionSpans.toJson, "audio_path" -> JsString(t.audioPath))

  val route: Route = path("v1" / "voice" / "sessions" / Segment) { sessionId =>
    get {
      // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
      Sessions.get(sessionId) match {
        case None => complete(StatusCodes.NotFound -> "no such session")
        case Some(_) =>
          val turns = Transcripts.listTurns(sessionId, -1, 10000)
          complete(json(StatusCodes.OK, JsObject("session_id" -> JsString(sessionId), "turns" -> JsArray(turns.map(turnJson).toVector))))
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

import voice.{Sessions, Transcripts} // Sessions.get; Transcripts.listTurns

import scala.util.Try

object Read {
  val MaxTurns = 500
  val DefaultLimit = 100

  private def json(status: StatusCode, body: JsObject): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  /** What a reader gets of a turn: the redacted text and its spans, never where the recording is. */
  private def turnJson(t: Transcripts.Turn): JsObject = JsObject(
    "turn_index" -> JsNumber(t.turnIndex), "started_at" -> JsNumber(t.startedAt), "ended_at" -> JsNumber(t.endedAt),
    "text" -> JsString(t.text), "redaction_spans" -> t.redactionSpans.toJson)

  val route: Route = path("v1" / "voice" / "sessions" / Segment) { sessionId =>
    get {
      (optionalHeaderValueByName("X-Tenant-Id") & parameters("limit".optional, "cursor".optional)) { (tenantHeader, limitText, cursor) =>
        tenantHeader.filter(_.nonEmpty) match {
          case None => complete(StatusCodes.Unauthorized -> "X-Tenant-Id is required")
          case Some(tenant) =>
            Sessions.get(sessionId).filter(_.tenant == tenant) match {
              case None => complete(StatusCodes.NotFound -> "no such session") // a foreign session looks exactly like a missing one
              case Some(_) =>
                (Try(limitText.fold(DefaultLimit)(_.toInt)).toOption, Try(cursor.fold(-1)(_.toInt)).toOption) match {
                  case (Some(requested), Some(after)) if requested >= 1 =>
                    val limit = math.min(requested, MaxTurns)
                    val rows = Transcripts.listTurns(sessionId, after, limit + 1) // one past the page: is there a next one?
                    val page = rows.take(limit)
                    val nextCursor = if (rows.size > limit) JsString(page.last.turnIndex.toString) else JsNull
                    complete(json(StatusCodes.OK, JsObject(
                      "session_id" -> JsString(sessionId), "turns" -> JsArray(page.map(turnJson).toVector), "next_cursor" -> nextCursor)))
                  case _ => complete(StatusCodes.BadRequest -> "limit and cursor are integers, limit positive")
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

#include "voice/sessions.h"     // sessions::get
#include "voice/transcripts.h"  // transcripts::listTurns

using json = nlohmann::json;

json turnJson(const transcripts::Turn& t) {
  return {{"turn_index", t.turn_index}, {"started_at", t.started_at}, {"ended_at", t.ended_at},
          {"text", t.text},             {"redaction_spans", t.redaction_spans}, {"audio_path", t.audio_path}};
}

void read_transcript(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const std::string session_id = req.matches[1];
  if (!sessions::get(session_id)) {
    res.status = 404;
    res.set_content("no such session", "text/plain");
    return;
  }
  json turns = json::array();
  for (const auto& t : transcripts::listTurns(session_id, -1, 10000)) turns.push_back(turnJson(t));
  res.set_content(json{{"session_id", session_id}, {"turns", turns}}.dump(), "application/json");
}

void register_routes(httplib::Server& svr) { svr.Get(R"(/v1/voice/sessions/([\\w-]+))", read_transcript); }
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <algorithm>
#include <optional>
#include <string>

#include "voice/sessions.h"     // sessions::get
#include "voice/transcripts.h"  // transcripts::listTurns

using json = nlohmann::json;

const long kMaxTurns = 500;
const long kDefaultLimit = 100;

// What a reader gets of a turn: the redacted text and its spans, never where the recording is.
json turnJson(const transcripts::Turn& t) {
  return {{"turn_index", t.turn_index}, {"started_at", t.started_at}, {"ended_at", t.ended_at},
          {"text", t.text},             {"redaction_spans", t.redaction_spans}};
}

// The query parameter as an integer, fallback when absent; none when it is not one.
std::optional<long> integer(const httplib::Request& req, const std::string& name, long fallback) {
  if (!req.has_param(name)) return fallback;
  const std::string text = req.get_param_value(name);
  size_t used = 0;
  try {
    const long n = std::stol(text, &used);
    if (used == text.size()) return n;
  } catch (const std::exception&) {
  }
  return std::nullopt;
}

void fail(httplib::Response& res, int status, const std::string& message) {
  res.status = status;
  res.set_content(message, "text/plain");
}

void read_transcript(const httplib::Request& req, httplib::Response& res) {
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) return fail(res, 401, "X-Tenant-Id is required");
  const std::string session_id = req.matches[1];
  const auto session = sessions::get(session_id);
  if (!session || session->tenant != tenant) return fail(res, 404, "no such session");  // a foreign session looks exactly like a missing one
  const auto requested = integer(req, "limit", kDefaultLimit);
  const auto after = integer(req, "cursor", -1);
  if (!requested || !after || *requested < 1) return fail(res, 400, "limit and cursor are integers, limit positive");
  const long limit = std::min(*requested, kMaxTurns);
  const auto rows = transcripts::listTurns(session_id, *after, limit + 1);  // one past the page: is there a next one?
  json turns = json::array();
  for (size_t i = 0; i < rows.size() && static_cast<long>(i) < limit; i++) turns.push_back(turnJson(rows[i]));
  const json next_cursor = static_cast<long>(rows.size()) > limit ? json(std::to_string(rows[limit - 1].turn_index)) : json(nullptr);
  res.set_content(json{{"session_id", session_id}, {"turns", turns}, {"next_cursor", next_cursor}}.dump(), "application/json");
}

void register_routes(httplib::Server& svr) { svr.Get(R"(/v1/voice/sessions/([\\w-]+))", read_transcript); }
`,
    },
  },
  harness: {
    python: `from voice import sessions, transcripts

SPOKEN = "Sure, call me back on 415 555 0134 after six."
REDACTED = "Sure, call me back on [redacted] after six."
FIELDS = ["ended_at", "redaction_spans", "started_at", "text", "turn_index"]
T0 = 1_700_000_000_000


def _call(turns, tenant="acme"):
    """A session of tenant with turns stored the way the transcript consumer stores them."""
    session_id = sessions.create(tenant, "pcm16", 24000, 1800)["session_id"]
    for i in range(turns):
        ref = transcripts.redact(session_id, i, SPOKEN)
        transcripts.insert_turn({"session_id": session_id, "tenant": tenant, "turn_index": i, "started_at": T0 + i * 4000, "ended_at": T0 + i * 4000 + 3200, "transcript_ref": ref})
    return session_id


def _api(ctx):
    return ctx.client(ctx.load("read").app)


async def check_route(ctx):
    session_id = _call(3)
    async with _api(ctx) as c:
        r = await c.get(f"/v1/voice/sessions/{session_id}", headers={"X-Tenant-Id": "acme"})
    assert r.status_code == 200, f"GET /v1/voice/sessions/{session_id} answered {r.status_code}: {r.text}"
    turns = r.json().get("turns")
    assert [t.get("turn_index") for t in turns] == [0, 1, 2], f"the transcript must list turns 0, 1, 2 in order, got {turns}"
    assert all(t.get("text") == REDACTED for t in turns), f"each turn carries its redacted text, got {turns[0]}"


async def check_tenant_scope(ctx):
    session_id = _call(2, tenant="acme")
    async with _api(ctx) as c:
        foreign = await c.get(f"/v1/voice/sessions/{session_id}", headers={"X-Tenant-Id": "globex"})
        missing = await c.get("/v1/voice/sessions/vs-999", headers={"X-Tenant-Id": "globex"})
        anonymous = await c.get(f"/v1/voice/sessions/{session_id}")
    assert foreign.status_code == 404, f"tenant globex read acme's session and got {foreign.status_code}: {foreign.text[:200]}. Another tenant's session must be 404"
    assert foreign.text == missing.text, f"a foreign session answered {foreign.text!r}, a missing one {missing.text!r}: the two must be indistinguishable"
    assert anonymous.status_code == 401, f"a read without X-Tenant-Id answered {anonymous.status_code}, expected 401"


async def check_turn_cap(ctx):
    session_id = _call(520)
    async with _api(ctx) as c:
        big = await c.get(f"/v1/voice/sessions/{session_id}", params={"limit": 1000}, headers={"X-Tenant-Id": "acme"})
        default = await c.get(f"/v1/voice/sessions/{session_id}", headers={"X-Tenant-Id": "acme"})
        bad = await c.get(f"/v1/voice/sessions/{session_id}", params={"limit": 0}, headers={"X-Tenant-Id": "acme"})
    assert big.status_code == 200, f"limit=1000 answered {big.status_code}: {big.text[:200]}"
    assert len(big.json()["turns"]) == 500, f"limit=1000 on a 520-turn call answered {len(big.json()['turns'])} turns: a page holds at most MAX_TURNS (500)"
    assert len(default.json()["turns"]) == 100, f"without limit the page holds {len(default.json()['turns'])} turns, expected DEFAULT_LIMIT (100)"
    assert bad.status_code == 400, f"limit=0 answered {bad.status_code}, expected 400"


async def check_cursor(ctx):
    session_id = _call(250)
    seen, sizes, cursor = [], [], None
    async with _api(ctx) as c:
        for _ in range(5):
            params = {"limit": 100} if cursor is None else {"limit": 100, "cursor": cursor}
            r = await c.get(f"/v1/voice/sessions/{session_id}", params=params, headers={"X-Tenant-Id": "acme"})
            assert r.status_code == 200, f"a page answered {r.status_code}: {r.text[:200]}"
            body = r.json()
            assert "next_cursor" in body, f"the response carries no next_cursor: a client cannot walk past the first page (keys: {sorted(body)})"
            seen += [t["turn_index"] for t in body["turns"]]
            sizes.append(len(body["turns"]))
            cursor = body["next_cursor"]
            if cursor is None:
                break
    assert sizes == [100, 100, 50], f"walking 250 turns 100 at a time gave pages of {sizes}, expected 100, 100, 50 and then next_cursor null"
    assert seen == list(range(250)), "following next_cursor must visit every turn once, in order"


async def check_no_audio_path(ctx):
    session_id = _call(2)
    async with _api(ctx) as c:
        r = await c.get(f"/v1/voice/sessions/{session_id}", headers={"X-Tenant-Id": "acme"})
    assert "s3://" not in r.text, f"the transcript hands out the recording's location: {r.text[:300]}. Answer the redacted text and its spans only"
    for turn in r.json()["turns"]:
        assert sorted(turn) == FIELDS, f"a turn must carry exactly {FIELDS}, got {sorted(turn)}"
        assert turn["redaction_spans"] == [[22, 32]], f"redaction_spans must locate [redacted] in the text, got {turn['redaction_spans']}"
`,
    typescript: `const SPOKEN = 'Sure, call me back on 415 555 0134 after six.';
const REDACTED = 'Sure, call me back on [redacted] after six.';
const FIELDS = ['ended_at', 'redaction_spans', 'started_at', 'text', 'turn_index'];
const T0 = 1_700_000_000_000;

/** A session of tenant with turns stored the way the transcript consumer stores them. */
async function call(ctx, turns: number, tenant = 'acme'): Promise<string> {
  const sessions = ctx.load('/support/voice/sessions.ts');
  const transcripts = ctx.load('/support/voice/transcripts.ts');
  const sessionId = (await sessions.create(tenant, 'pcm16', 24000, 1800)).session_id;
  for (let i = 0; i < turns; i += 1) {
    const ref = await transcripts.redact(sessionId, i, SPOKEN);
    await transcripts.insertTurn({session_id: sessionId, tenant, turn_index: i, started_at: T0 + i * 4000, ended_at: T0 + i * 4000 + 3200, transcript_ref: ref});
  }
  return sessionId;
}

const api = ctx => ctx.client(ctx.load('read').app);
const read = (c, sessionId: string, query: Record<string, string> = {}, tenant: string | null = 'acme') =>
  c.get(\`/v1/voice/sessions/\${sessionId}\`, {query, headers: tenant === null ? {} : {'X-Tenant-Id': tenant}});

export async function check_route(ctx) {
  const sessionId = await call(ctx, 3);
  const r = await read(api(ctx), sessionId);
  assert.equal(r.status, 200, \`GET /v1/voice/sessions/\${sessionId} answered \${r.status}: \${r.text}\`);
  const turns = r.json().turns;
  assert.deepStrictEqual(turns.map(t => t.turn_index), [0, 1, 2], \`the transcript must list turns 0, 1, 2 in order, got \${r.text}\`);
  assert(turns.every(t => t.text === REDACTED), \`each turn carries its redacted text, got \${JSON.stringify(turns[0])}\`);
}

export async function check_tenant_scope(ctx) {
  const sessionId = await call(ctx, 2, 'acme');
  const c = api(ctx);
  const foreign = await read(c, sessionId, {}, 'globex');
  const missing = await read(c, 'vs-999', {}, 'globex');
  const anonymous = await read(c, sessionId, {}, null);
  assert.equal(foreign.status, 404, \`tenant globex read acme's session and got \${foreign.status}: \${foreign.text.slice(0, 200)}. Another tenant's session must be 404\`);
  assert.equal(foreign.text, missing.text, \`a foreign session answered \${foreign.text}, a missing one \${missing.text}: the two must be indistinguishable\`);
  assert.equal(anonymous.status, 401, \`a read without X-Tenant-Id answered \${anonymous.status}, expected 401\`);
}

export async function check_turn_cap(ctx) {
  const sessionId = await call(ctx, 520);
  const c = api(ctx);
  const big = await read(c, sessionId, {limit: '1000'});
  const fallback = await read(c, sessionId);
  const bad = await read(c, sessionId, {limit: '0'});
  assert.equal(big.status, 200, \`limit=1000 answered \${big.status}: \${big.text.slice(0, 200)}\`);
  assert.equal(big.json().turns.length, 500, \`limit=1000 on a 520-turn call answered \${big.json().turns.length} turns: a page holds at most MAX_TURNS (500)\`);
  assert.equal(fallback.json().turns.length, 100, \`without limit the page holds \${fallback.json().turns.length} turns, expected DEFAULT_LIMIT (100)\`);
  assert.equal(bad.status, 400, \`limit=0 answered \${bad.status}, expected 400\`);
}

export async function check_cursor(ctx) {
  const sessionId = await call(ctx, 250);
  const c = api(ctx);
  const seen: number[] = [];
  const sizes: number[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < 5; i += 1) {
    const r = await read(c, sessionId, cursor === null ? {limit: '100'} : {limit: '100', cursor});
    assert.equal(r.status, 200, \`a page answered \${r.status}: \${r.text.slice(0, 200)}\`);
    const body = r.json();
    assert('next_cursor' in body, \`the response carries no next_cursor: a client cannot walk past the first page (keys: \${Object.keys(body)})\`);
    seen.push(...body.turns.map(t => t.turn_index));
    sizes.push(body.turns.length);
    cursor = body.next_cursor;
    if (cursor === null) break;
  }
  assert.deepStrictEqual(sizes, [100, 100, 50], \`walking 250 turns 100 at a time gave pages of \${JSON.stringify(sizes)}, expected 100, 100, 50 and then next_cursor null\`);
  assert.deepStrictEqual(seen, Array.from({length: 250}, (_, i) => i), 'following next_cursor must visit every turn once, in order');
}

export async function check_no_audio_path(ctx) {
  const sessionId = await call(ctx, 2);
  const r = await read(api(ctx), sessionId);
  assert(!r.text.includes('s3://'), \`the transcript hands out the recording's location: \${r.text.slice(0, 300)}. Answer the redacted text and its spans only\`);
  for (const turn of r.json().turns) {
    assert.deepStrictEqual(Object.keys(turn).sort(), FIELDS, \`a turn must carry exactly \${FIELDS}, got \${Object.keys(turn).sort()}\`);
    assert.deepStrictEqual(turn.redaction_spans, [[22, 32]], \`redaction_spans must locate [redacted] in the text, got \${JSON.stringify(turn.redaction_spans)}\`);
  }
}
`,
    go: `package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"strings"

	"leetbuild/harness"

	"voice/sessions"
	"voice/transcripts"
)

const (
	readSpoken   = "Sure, call me back on 415 555 0134 after six."
	readRedacted = "Sure, call me back on [redacted] after six."
	readT0       = int64(1_700_000_000_000)
)

var readBg = context.Background()

// seedCall is a session of tenant with turns stored the way the transcript consumer stores them.
func seedCall(ctx *harness.Ctx, turns int, tenant string) string {
	sessionID := sessions.Create(readBg, tenant, "pcm16", 24000, 1800).SessionID
	for i := 0; i < turns; i++ {
		ref := transcripts.Redact(readBg, sessionID, i, readSpoken)
		err := transcripts.InsertTurn(readBg, transcripts.Event{SessionID: sessionID, Tenant: tenant, TurnIndex: i, StartedAt: readT0 + int64(i)*4000, EndedAt: readT0 + int64(i)*4000 + 3200, TranscriptRef: ref})
		ctx.NoError(err, "seeding turn %d failed", i)
	}
	return sessionID
}

func readAPI(ctx *harness.Ctx) *harness.HTTP {
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

type page struct {
	Turns      []map[string]any \`json:"turns"\`
	NextCursor *string          \`json:"next_cursor"\`
}

func pageOf(r *harness.Response) (page, map[string]any) {
	var p page
	var raw map[string]any
	r.Decode(&p)
	r.Decode(&raw)
	return p, raw
}

func turnIndexes(p page) []any {
	out := []any{}
	for _, t := range p.Turns {
		out = append(out, t["turn_index"])
	}
	return out
}

func CheckRoute(ctx *harness.Ctx) {
	sessionID := seedCall(ctx, 3, "acme")
	r := readAPI(ctx).Get("/v1/voice/sessions/"+sessionID, "X-Tenant-Id", "acme")
	ctx.Equal(r.Status, 200, "GET /v1/voice/sessions/%s (%s)", sessionID, r.Text())
	p, _ := pageOf(r)
	ctx.Equal(turnIndexes(p), []any{0, 1, 2}, "the transcript must list turns 0, 1, 2 in order")
	for _, t := range p.Turns {
		ctx.Equal(t["text"], readRedacted, "each turn carries its redacted text")
	}
}

func CheckTenantScope(ctx *harness.Ctx) {
	sessionID := seedCall(ctx, 2, "acme")
	c := readAPI(ctx)
	foreign := c.Get("/v1/voice/sessions/"+sessionID, "X-Tenant-Id", "globex")
	missing := c.Get("/v1/voice/sessions/vs-999", "X-Tenant-Id", "globex")
	anonymous := c.Get("/v1/voice/sessions/" + sessionID)
	ctx.Equal(foreign.Status, 404, "tenant globex read acme's session (%.200s): another tenant's session must be 404; the status", foreign.Text())
	ctx.Equal(foreign.Text(), missing.Text(), "a foreign session and a missing one must be indistinguishable; the bodies")
	ctx.Equal(anonymous.Status, 401, "a read without X-Tenant-Id; the status")
}

func CheckTurnCap(ctx *harness.Ctx) {
	sessionID := seedCall(ctx, 520, "acme")
	c := readAPI(ctx)
	big := c.Get("/v1/voice/sessions/"+sessionID+"?limit=1000", "X-Tenant-Id", "acme")
	ctx.Equal(big.Status, 200, "limit=1000 (%.200s)", big.Text())
	p, _ := pageOf(big)
	ctx.Equal(len(p.Turns), 500, "limit=1000 on a 520-turn call: a page holds at most maxTurns (500); the turns")
	fallback, _ := pageOf(c.Get("/v1/voice/sessions/"+sessionID, "X-Tenant-Id", "acme"))
	ctx.Equal(len(fallback.Turns), 100, "without limit, the page must hold defaultLimit (100) turns; the turns")
	bad := c.Get("/v1/voice/sessions/"+sessionID+"?limit=0", "X-Tenant-Id", "acme")
	ctx.Equal(bad.Status, 400, "limit=0; the status")
}

func CheckCursor(ctx *harness.Ctx) {
	sessionID := seedCall(ctx, 250, "acme")
	c := readAPI(ctx)
	seen := []any{}
	sizes := []int{}
	cursor := ""
	for i := 0; i < 5; i++ {
		path := "/v1/voice/sessions/" + sessionID + "?limit=100"
		if cursor != "" {
			path += "&cursor=" + cursor
		}
		r := c.Get(path, "X-Tenant-Id", "acme")
		ctx.Equal(r.Status, 200, "a page (%.200s)", r.Text())
		p, raw := pageOf(r)
		_, has := raw["next_cursor"]
		keys := []string{}
		for k := range raw {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		ctx.Assert(has, "the response carries no next_cursor: a client cannot walk past the first page (keys: %v)", keys)
		seen = append(seen, turnIndexes(p)...)
		sizes = append(sizes, len(p.Turns))
		if p.NextCursor == nil {
			break
		}
		cursor = *p.NextCursor
	}
	ctx.Equal(sizes, []int{100, 100, 50}, "walking 250 turns 100 at a time, then next_cursor null; the page sizes")
	want := []any{}
	for i := 0; i < 250; i++ {
		want = append(want, i)
	}
	ctx.Assert(fmt.Sprint(seen) == fmt.Sprint(want), "following next_cursor must visit every turn once, in order")
}

func CheckNoAudioPath(ctx *harness.Ctx) {
	sessionID := seedCall(ctx, 2, "acme")
	r := readAPI(ctx).Get("/v1/voice/sessions/"+sessionID, "X-Tenant-Id", "acme")
	ctx.Assert(!strings.Contains(r.Text(), "s3://"), "the transcript hands out the recording's location: %.300s. Answer the redacted text and its spans only", r.Text())
	p, _ := pageOf(r)
	for _, t := range p.Turns {
		keys := []string{}
		for k := range t {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		ctx.Equal(keys, []string{"ended_at", "redaction_spans", "started_at", "text", "turn_index"}, "the fields of a turn")
		spans, _ := json.Marshal(t["redaction_spans"])
		ctx.Equal(string(spans), "[[22,32]]", "redaction_spans must locate [redacted] in the text")
	}
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <string>
#include <vector>

using json = nlohmann::json;

namespace {

const std::string kSpoken = "Sure, call me back on 415 555 0134 after six.";
const std::string kRedacted = "Sure, call me back on [redacted] after six.";
const long long kT0 = 1700000000000LL;

// A session of tenant with turns stored the way the transcript consumer stores them.
std::string seedCall(long turns, const std::string& tenant = "acme") {
  const std::string session_id = sessions::create(tenant, "pcm16", 24000, 1800).session_id;
  for (long i = 0; i < turns; i++) {
    const std::string ref = transcripts::redact(session_id, i, kSpoken);
    transcripts::insertTurn({{"session_id", session_id}, {"tenant", tenant}, {"turn_index", i}, {"started_at", kT0 + i * 4000},
                             {"ended_at", kT0 + i * 4000 + 3200}, {"transcript_ref", ref}});
  }
  return session_id;
}

harness::HTTP api(harness::Ctx& ctx) {
  static httplib::Server* svr = nullptr;
  delete svr;
  svr = new httplib::Server;
  register_routes(*svr);
  return ctx.HTTP(*svr);
}

json bodyOf(harness::Ctx& ctx, const harness::Response& r) {
  try {
    return json::parse(r.Text());
  } catch (const std::exception&) {
    ctx.Fatalf("the response (%d) is not JSON: %.200s", r.Status, r.Text());
  }
}

std::vector<long> indexes(const json& body) {
  std::vector<long> out;
  for (const auto& t : body.value("turns", json::array())) out.push_back(t.value("turn_index", -1L));
  return out;
}

}  // namespace

void CheckRoute(harness::Ctx& ctx) {
  const std::string session_id = seedCall(3);
  auto c = api(ctx);
  const auto r = c.Get("/v1/voice/sessions/" + session_id, "X-Tenant-Id", "acme");
  ctx.Equal(r.Status, 200, "GET /v1/voice/sessions/%s (%s)", session_id, r.Text());
  const json body = bodyOf(ctx, r);
  ctx.Equal(indexes(body), std::vector<long>{0, 1, 2}, "the transcript must list turns 0, 1, 2 in order");
  for (const auto& t : body["turns"]) ctx.Equal(t.value("text", ""), kRedacted, "each turn carries its redacted text");
}

void CheckTenantScope(harness::Ctx& ctx) {
  const std::string session_id = seedCall(2, "acme");
  auto c = api(ctx);
  const auto foreign = c.Get("/v1/voice/sessions/" + session_id, "X-Tenant-Id", "globex");
  const auto missing = c.Get("/v1/voice/sessions/vs-999", "X-Tenant-Id", "globex");
  const auto anonymous = c.Get("/v1/voice/sessions/" + session_id);
  ctx.Equal(foreign.Status, 404, "tenant globex read acme's session (%.200s): another tenant's session must be 404; the status", foreign.Text());
  ctx.Equal(foreign.Text(), missing.Text(), "a foreign session and a missing one must be indistinguishable; the bodies");
  ctx.Equal(anonymous.Status, 401, "a read without X-Tenant-Id; the status");
}

void CheckTurnCap(harness::Ctx& ctx) {
  const std::string session_id = seedCall(520);
  auto c = api(ctx);
  const auto big = c.Get("/v1/voice/sessions/" + session_id + "?limit=1000", "X-Tenant-Id", "acme");
  ctx.Equal(big.Status, 200, "limit=1000 (%.200s)", big.Text());
  ctx.Equal(bodyOf(ctx, big)["turns"].size(), 500, "limit=1000 on a 520-turn call: a page holds at most kMaxTurns (500); the turns");
  const auto fallback = c.Get("/v1/voice/sessions/" + session_id, "X-Tenant-Id", "acme");
  ctx.Equal(bodyOf(ctx, fallback)["turns"].size(), 100, "without limit, the page must hold kDefaultLimit (100) turns; the turns");
  const auto bad = c.Get("/v1/voice/sessions/" + session_id + "?limit=0", "X-Tenant-Id", "acme");
  ctx.Equal(bad.Status, 400, "limit=0; the status");
}

void CheckCursor(harness::Ctx& ctx) {
  const std::string session_id = seedCall(250);
  auto c = api(ctx);
  std::vector<long> seen;
  std::vector<size_t> sizes;
  std::string cursor;
  for (int i = 0; i < 5; i++) {
    const std::string path = "/v1/voice/sessions/" + session_id + "?limit=100" + (cursor.empty() ? "" : "&cursor=" + cursor);
    const auto r = c.Get(path, "X-Tenant-Id", "acme");
    ctx.Equal(r.Status, 200, "a page (%.200s)", r.Text());
    const json body = bodyOf(ctx, r);
    ctx.Assert(body.contains("next_cursor"), "the response carries no next_cursor: a client cannot walk past the first page (%.200s)", r.Text());
    for (const long t : indexes(body)) seen.push_back(t);
    sizes.push_back(body["turns"].size());
    if (body["next_cursor"].is_null()) break;
    cursor = body["next_cursor"].get<std::string>();
  }
  ctx.Equal(sizes, std::vector<size_t>{100, 100, 50}, "walking 250 turns 100 at a time, then next_cursor null; the page sizes");
  std::vector<long> want;
  for (long i = 0; i < 250; i++) want.push_back(i);
  ctx.Assert(seen == want, "following next_cursor must visit every turn once, in order");
}

void CheckNoAudioPath(harness::Ctx& ctx) {
  const std::string session_id = seedCall(2);
  auto c = api(ctx);
  const auto r = c.Get("/v1/voice/sessions/" + session_id, "X-Tenant-Id", "acme");
  ctx.Assert(r.Text().find("s3://") == std::string::npos, "the transcript hands out the recording's location: %.300s. Answer the redacted text and its spans only", r.Text());
  for (const auto& t : bodyOf(ctx, r)["turns"]) {
    std::vector<std::string> keys;
    for (const auto& [k, v] : t.items()) keys.push_back(k);
    ctx.Equal(keys, std::vector<std::string>{"ended_at", "redaction_spans", "started_at", "text", "turn_index"}, "the fields of a turn");
    ctx.Equal(t["redaction_spans"].dump(), "[[22,32]]", "redaction_spans must locate [redacted] in the text");
  }
}
`,
  },
  hints: [
    "A customer changes the session id in a transcript link and reads another company's call; a long call's transcript takes seconds to load, and every turn links to the raw recording.",
    'The handler looks the session up by id alone and never reads `X-Tenant-Id`, asks the store for 10,000 turns with no way to continue, and passes the stored rows through, `audio_path` included.',
    '401 without a tenant, 404 when `session["tenant"]` differs; clamp `limit` to `MAX_TURNS` (default 100), read `list_turns(id, cursor, limit + 1)`, set `next_cursor` when the extra row came back, and copy the five turn fields.',
  ],
  debrief: `Scope comes first because a transcript is the most sensitive thing the service holds, and a foreign session answers exactly like a missing one so the endpoint cannot tell anyone which sessions exist. The page is bounded on the server because a client's limit is a request; reading one row past the page is the cheap way to know a next page exists without counting. The cursor is the last turn index, which stays right while the consumer keeps appending turns behind it, where an offset would not. The response names its fields instead of passing rows through, so a column the store gains later cannot leak by default. Production readers also sign the cursor, log who read which transcript, and serve recordings through short-lived URLs behind their own permission.`,
};
