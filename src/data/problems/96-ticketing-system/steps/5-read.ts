import type {Step} from '@/lib/types';

export const readStep: Step = {
  id: 'read',
  title: 'GET /v1/tickets/{id}: a private timeline paged by keyset',
  concept: 'http',
  file: 'read',
  focus: ['requester', 'agent', 'api', 'store'],
  task: `## Task

**Starting point.** The starter serves the ticket page: \`GET /v1/tickets/{id}?limit=&offset=\` reads
the ticket and \`store.page_at(ticket_id, offset, limit)\` (newest first) and answers
\`{ticket_id, state, notes, next_offset}\` to whoever asks. The page renders, and it hides 3 flaws.

**Failure mode the checks target.** A customer reads the agents' internal notes about them, any
caller reads any ticket by id, and a note posted while someone scrolls shifts every offset, so the
next page repeats a note it already showed.

- The caller is \`X-Actor-Id\` (**401** without one) and \`X-Actor-Role\`, \`requester\` or \`agent\`
  (**403** otherwise). A requester reads only a ticket whose \`requester_id\` is theirs (**403**).
- A note whose \`visibility\` is \`internal\` is left out for a requester and kept for an agent.
- Pages are keyset: \`cursor\` is the \`seq\` to read below (a cursor that is not a positive integer
  is **400**), \`store.page(ticket_id, before_seq, limit)\` fetches the page, and \`next_cursor\` is
  the \`seq\` of the last note **fetched**, as a string, or \`null\` when the page was not full. The
  response is \`{ticket_id, state, notes, next_cursor}\`; \`limit\` stays 1 to 100, default 20.`,
  sequence: {
    participants: ['Requester', 'Agent', 'Ticket API', 'Ticket store'],
    messages: [
      {
        from: 'Requester',
        to: 'Ticket API',
        label: 'GET /v1/tickets/T-1?limit=20 · X-Actor-Role: requester',
        kind: 'sync',
      },
      {from: 'Ticket API', to: 'Ticket store', label: 'get_ticket(T-1) · requester_id = caller?', kind: 'sync'},
      {from: 'Ticket API', to: 'Ticket store', label: 'page(T-1, before_seq, 20) · newest first', kind: 'sync'},
      {
        from: 'Ticket API',
        to: 'Requester',
        label: '200 public notes · next_cursor = seq of the last fetched',
        kind: 'reply',
      },
      {from: 'Agent', to: 'Ticket API', label: 'GET …?cursor=41 · X-Actor-Role: agent', kind: 'sync'},
      {from: 'Ticket API', to: 'Agent', label: '200 notes below seq 41, internal ones included', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Serves the ticket page',
      detail: 'Register `GET /v1/tickets/{id}` answering the ticket’s `notes`.',
      match: {
        python: {all: [/@app\.get\(\s*["']\/v1\/tickets\/\{ticket_id\}["']/, /["']notes["']/]},
        typescript: {all: [/app\.get\(\s*['"]\/v1\/tickets\/:\w+['"]/, /\bnotes\b/]},
        go: {all: [/HandleFunc\(\s*"GET \/v1\/tickets\/\{id\}"/, /"notes"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"tickets"\s*\/\s*Segment\s*\)/, /\bget\s*\{/, /"notes"/]},
        cpp: {all: [/svr\.Get\(\s*R"\(\/v1\/tickets\//, /"notes"/]},
      },
    },
    {
      id: 'internal-hidden',
      title: 'Internal notes stay with the agents',
      detail:
        'The role from `X-Actor-Role` decides what the page carries: a note whose `visibility` is `internal` is dropped for a requester and kept for an agent. The starter returns every note to every caller.',
      match: {
        python: {all: [/x-actor-role/i, /\["visibility"\]\s*!=\s*["']internal["']/]},
        typescript: {all: [/x-actor-role/i, /\.visibility\s*!==\s*'internal'/]},
        go: {all: [/X-Actor-Role/i, /\.Visibility\s*!=\s*"internal"/]},
        scala: {all: [/X-Actor-Role/i, /\.visibility\s*!=\s*"internal"/]},
        cpp: {all: [/X-Actor-Role/i, /\.visibility\s*!=\s*"internal"/]},
      },
    },
    {
      id: 'requester-scope',
      title: 'A requester reads only their own ticket',
      detail:
        'A requester whose id is not the ticket’s `requester_id` is answered **403**, and a caller without `X-Actor-Id` **401**; the starter answers any ticket to anyone who knows its id.',
      match: {
        python: {all: [/\["requester_id"\]\s*!=|!=\s*\w+\["requester_id"\]/, /\b403\b/, /\b401\b/]},
        typescript: {all: [/\.requester_id\s*!==|!==\s*\w+\.requester_id/, /\b403\b/, /\b401\b/]},
        go: {all: [/\.RequesterID\s*!=|!=\s*\w+\.RequesterID/, /StatusForbidden/, /StatusUnauthorized/]},
        scala: {all: [/\.requesterId\s*!=|!=\s*\w+\.requesterId/, /Forbidden/, /Unauthorized/]},
        cpp: {all: [/(\.|->)requester_id\s*!=|!=\s*\w+(\.|->)requester_id/, /\b403\b/, /\b401\b/]},
      },
    },
    {
      id: 'keyset-cursor',
      title: 'Pages by keyset cursor, never by offset',
      detail:
        'The page is `store.page(ticket_id, before_seq, limit)` below the `cursor`, and `next_cursor` is the `seq` of the last note fetched, so a note posted while someone scrolls neither repeats nor hides one; the starter counts rows with `offset`.',
      match: {
        python: {all: [/store\.page\(/, /next_cursor/], none: [/page_at\(|\boffset\b/]},
        typescript: {all: [/\bpage\(/, /next_cursor/], none: [/pageAt\(|\boffset\b/]},
        go: {all: [/store\.Page\(/, /next_cursor/], none: [/PageAt\(|\boffset\b/]},
        scala: {all: [/Store\.page\(/, /next_cursor/], none: [/pageAt\(|\boffset\b/]},
        cpp: {all: [/store::page\(/, /next_cursor/], none: [/pageAt\(|\boffset\b/]},
      },
    },
  ],
  code: {
    python: {
      starter: `from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from tickets import store  # get_ticket, page, page_at

app = FastAPI()

DEFAULT_LIMIT = 20
MAX_LIMIT = 100


@app.get("/v1/tickets/{ticket_id}")
def read_ticket(ticket_id: str, request: Request):
    # TODO: this starter has 3 flaws. The task says where to look; the checks say what must change.
    ticket = store.get_ticket(ticket_id)
    if ticket is None:
        return JSONResponse({"error": "unknown ticket"}, status_code=404)
    limit = request.query_params.get("limit", str(DEFAULT_LIMIT))
    if not limit.isdigit() or not 1 <= int(limit) <= MAX_LIMIT:
        return JSONResponse({"error": f"limit must be 1 to {MAX_LIMIT}"}, status_code=400)
    offset = int(request.query_params.get("offset", "0"))
    notes = store.page_at(ticket_id, offset, int(limit))
    next_offset = offset + int(limit) if len(notes) == int(limit) else None
    return {"ticket_id": ticket_id, "state": ticket["state"], "notes": notes, "next_offset": next_offset}
`,
      solution: `from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse

from tickets import store  # get_ticket, page, page_at

app = FastAPI()

DEFAULT_LIMIT = 20
MAX_LIMIT = 100
ROLES = ("requester", "agent")


def caller(request: Request) -> tuple[str, str]:
    """X-Actor-Id (401 without one) and X-Actor-Role, requester or agent (403 otherwise)."""
    actor_id = request.headers.get("x-actor-id", "")
    role = request.headers.get("x-actor-role", "")
    if not actor_id:
        raise HTTPException(status_code=401, detail="X-Actor-Id is required")
    if role not in ROLES:
        raise HTTPException(status_code=403, detail="X-Actor-Role must be requester or agent")
    return actor_id, role


@app.get("/v1/tickets/{ticket_id}")
def read_ticket(ticket_id: str, request: Request):
    actor_id, role = caller(request)
    ticket = store.get_ticket(ticket_id)
    if ticket is None:
        return JSONResponse({"error": "unknown ticket"}, status_code=404)
    if role == "requester" and ticket["requester_id"] != actor_id:
        return JSONResponse({"error": "this ticket belongs to another requester"}, status_code=403)
    limit = request.query_params.get("limit", str(DEFAULT_LIMIT))
    if not limit.isdigit() or not 1 <= int(limit) <= MAX_LIMIT:
        return JSONResponse({"error": f"limit must be 1 to {MAX_LIMIT}"}, status_code=400)
    cursor = request.query_params.get("cursor")
    if cursor is not None and (not cursor.isdigit() or int(cursor) < 1):
        return JSONResponse({"error": "invalid cursor"}, status_code=400)
    # A keyset page: below the cursor's seq, so notes posted meanwhile shift nothing.
    entries = store.page(ticket_id, int(cursor) if cursor else None, int(limit))
    include_internal = role == "agent"
    notes = [n for n in entries if include_internal or n["visibility"] != "internal"]
    # The cursor follows what was fetched, not what was shown: a page of internal notes still advances.
    next_cursor = str(entries[-1]["seq"]) if len(entries) == int(limit) else None
    return {"ticket_id": ticket_id, "state": ticket["state"], "notes": notes, "next_cursor": next_cursor}
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';

import {getTicket, page, pageAt} from 'tickets/store';

export const app = Fastify();

export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;

app.get('/v1/tickets/:ticketId', async (request, reply) => {
  // TODO: this starter has 3 flaws. The task says where to look; the checks say what must change.
  const {ticketId} = request.params as {ticketId: string};
  const query = request.query as {limit?: string; offset?: string};
  const ticket = await getTicket(ticketId);
  if (ticket === null) return reply.code(404).send({error: 'unknown ticket'});
  const limit = Number(query.limit ?? DEFAULT_LIMIT);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) return reply.code(400).send({error: \`limit must be 1 to \${MAX_LIMIT}\`});
  const offset = Number(query.offset ?? 0);
  const notes = await pageAt(ticketId, offset, limit);
  const nextOffset = notes.length === limit ? offset + limit : null;
  return {ticket_id: ticketId, state: ticket.state, notes, next_offset: nextOffset};
});
`,
      solution: `import Fastify, {type FastifyRequest} from 'fastify';

import {getTicket, page, pageAt} from 'tickets/store';

export const app = Fastify();

export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;
const ROLES = ['requester', 'agent'];

type Caller = {actorId: string; role: string} | {status: number; error: string};

/** X-Actor-Id (401 without one) and X-Actor-Role, requester or agent (403 otherwise). */
function caller(request: FastifyRequest): Caller {
  const actorId = request.headers['x-actor-id'];
  const role = request.headers['x-actor-role'];
  if (typeof actorId !== 'string' || actorId === '') return {status: 401, error: 'X-Actor-Id is required'};
  if (typeof role !== 'string' || !ROLES.includes(role)) return {status: 403, error: 'X-Actor-Role must be requester or agent'};
  return {actorId, role};
}

app.get('/v1/tickets/:ticketId', async (request, reply) => {
  const who = caller(request);
  if ('status' in who) return reply.code(who.status).send({error: who.error});
  const {ticketId} = request.params as {ticketId: string};
  const query = request.query as {limit?: string; cursor?: string};
  const ticket = await getTicket(ticketId);
  if (ticket === null) return reply.code(404).send({error: 'unknown ticket'});
  if (who.role === 'requester' && ticket.requester_id !== who.actorId) return reply.code(403).send({error: 'this ticket belongs to another requester'});
  const limit = Number(query.limit ?? DEFAULT_LIMIT);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) return reply.code(400).send({error: \`limit must be 1 to \${MAX_LIMIT}\`});
  if (query.cursor !== undefined && !/^[1-9]\\d*$/.test(query.cursor)) return reply.code(400).send({error: 'invalid cursor'});
  // A keyset page: below the cursor's seq, so notes posted meanwhile shift nothing.
  const entries = await page(ticketId, query.cursor === undefined ? null : Number(query.cursor), limit);
  const includeInternal = who.role === 'agent';
  const notes = entries.filter(n => includeInternal || n.visibility !== 'internal');
  // The cursor follows what was fetched, not what was shown: a page of internal notes still advances.
  const nextCursor = entries.length === limit ? String(entries[entries.length - 1].seq) : null;
  return {ticket_id: ticketId, state: ticket.state, notes, next_cursor: nextCursor};
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"net/http"
	"strconv"

	"tickets/store" // store.GetTicket, Page, PageAt
)

const (
	defaultLimit = 20
	maxLimit     = 100
)

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func readTicket(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has 3 flaws. The task says where to look; the checks say what must change.
	ticketID := r.PathValue("id")
	ticket := store.GetTicket(r.Context(), ticketID)
	if ticket == nil {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "unknown ticket"})
		return
	}
	limit := defaultLimit
	if raw := r.URL.Query().Get("limit"); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil || n < 1 || n > maxLimit {
			writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "limit must be 1 to 100"})
			return
		}
		limit = n
	}
	offset, _ := strconv.Atoi(r.URL.Query().Get("offset"))
	notes := store.PageAt(r.Context(), ticketID, offset, limit)
	var nextOffset any
	if len(notes) == limit {
		nextOffset = offset + limit
	}
	writeJSON(rw, http.StatusOK, map[string]any{"ticket_id": ticketID, "state": ticket.State, "notes": notes, "next_offset": nextOffset})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/tickets/{id}", readTicket)
}
`,
      solution: `package main

import (
	"encoding/json"
	"net/http"
	"slices"
	"strconv"

	"tickets/store" // store.GetTicket, Page, PageAt
)

const (
	defaultLimit = 20
	maxLimit     = 100
)

var roles = []string{"requester", "agent"}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

// caller is X-Actor-Id (401 without one) and X-Actor-Role, requester or agent (403 otherwise); ok is false once the error is written.
func caller(rw http.ResponseWriter, r *http.Request) (actorID, role string, ok bool) {
	actorID, role = r.Header.Get("X-Actor-Id"), r.Header.Get("X-Actor-Role")
	if actorID == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "X-Actor-Id is required"})
		return "", "", false
	}
	if !slices.Contains(roles, role) {
		writeJSON(rw, http.StatusForbidden, map[string]string{"error": "X-Actor-Role must be requester or agent"})
		return "", "", false
	}
	return actorID, role, true
}

func readTicket(rw http.ResponseWriter, r *http.Request) {
	actorID, role, ok := caller(rw, r)
	if !ok {
		return
	}
	ticketID := r.PathValue("id")
	ticket := store.GetTicket(r.Context(), ticketID)
	if ticket == nil {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "unknown ticket"})
		return
	}
	if role == "requester" && ticket.RequesterID != actorID {
		writeJSON(rw, http.StatusForbidden, map[string]string{"error": "this ticket belongs to another requester"})
		return
	}
	limit := defaultLimit
	if raw := r.URL.Query().Get("limit"); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil || n < 1 || n > maxLimit {
			writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "limit must be 1 to 100"})
			return
		}
		limit = n
	}
	var beforeSeq int64
	if raw := r.URL.Query().Get("cursor"); raw != "" {
		n, err := strconv.ParseInt(raw, 10, 64)
		if err != nil || n < 1 {
			writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid cursor"})
			return
		}
		beforeSeq = n
	}
	// A keyset page: below the cursor's seq, so notes posted meanwhile shift nothing.
	entries := store.Page(r.Context(), ticketID, beforeSeq, limit)
	includeInternal := role == "agent"
	notes := []store.Note{}
	for _, n := range entries {
		if includeInternal || n.Visibility != "internal" {
			notes = append(notes, n)
		}
	}
	// The cursor follows what was fetched, not what was shown: a page of internal notes still advances.
	var nextCursor any
	if len(entries) == limit {
		nextCursor = strconv.FormatInt(entries[len(entries)-1].Seq, 10)
	}
	writeJSON(rw, http.StatusOK, map[string]any{"ticket_id": ticketID, "state": ticket.State, "notes": notes, "next_cursor": nextCursor})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/tickets/{id}", readTicket)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import tickets.Store // Store.getTicket, page, pageAt, toJson

object Read {
  val DefaultLimit = 20
  val MaxLimit = 100

  private def json(status: StatusCode, body: JsValue): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  private def error(status: StatusCode, message: String): HttpResponse = json(status, JsObject("error" -> JsString(message)))

  private def read(ticketId: String, params: Map[String, String]): HttpResponse =
    Store.getTicket(ticketId) match {
      case None => error(StatusCodes.NotFound, "unknown ticket")
      case Some(ticket) =>
        params.get("limit").getOrElse(DefaultLimit.toString).toIntOption.filter(n => n >= 1 && n <= MaxLimit) match {
          case None => error(StatusCodes.BadRequest, s"limit must be 1 to $MaxLimit")
          case Some(limit) =>
            val offset = params.get("offset").flatMap(_.toIntOption).getOrElse(0)
            val notes = Store.pageAt(ticketId, offset, limit)
            val nextOffset = if (notes.size == limit) JsNumber(offset + limit) else JsNull
            json(StatusCodes.OK, JsObject(
              "ticket_id" -> JsString(ticketId), "state" -> JsString(ticket.state),
              "notes" -> JsArray(notes.map(n => Store.toJson(n)).toVector), "next_offset" -> nextOffset))
        }
    }

  val route: Route = path("v1" / "tickets" / Segment) { ticketId =>
    get {
      // TODO: this starter has 3 flaws. The task says where to look; the checks say what must change.
      parameterMap { params => complete(read(ticketId, params)) }
    }
  }
}
`,
      solution: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import tickets.Store // Store.getTicket, page, pageAt, toJson

object Read {
  val DefaultLimit = 20
  val MaxLimit = 100
  val Roles: Seq[String] = Seq("requester", "agent")

  private def json(status: StatusCode, body: JsValue): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  private def error(status: StatusCode, message: String): HttpResponse = json(status, JsObject("error" -> JsString(message)))

  /** X-Actor-Id (401 without one) and X-Actor-Role, requester or agent (403 otherwise). */
  private def caller(inner: (String, String) => Route): Route =
    optionalHeaderValueByName("X-Actor-Id") { actorId =>
      optionalHeaderValueByName("X-Actor-Role") { role =>
        (actorId.filter(_.nonEmpty), role.filter(Roles.contains)) match {
          case (None, _) => complete(error(StatusCodes.Unauthorized, "X-Actor-Id is required"))
          case (_, None) => complete(error(StatusCodes.Forbidden, "X-Actor-Role must be requester or agent"))
          case (Some(id), Some(r)) => inner(id, r)
        }
      }
    }

  private def read(ticketId: String, actorId: String, role: String, params: Map[String, String]): HttpResponse = {
    val limit = params.get("limit").getOrElse(DefaultLimit.toString).toIntOption.filter(n => n >= 1 && n <= MaxLimit)
    val cursor = params.get("cursor").map(_.toLongOption.filter(_ >= 1))
    Store.getTicket(ticketId) match {
      case None => error(StatusCodes.NotFound, "unknown ticket")
      case Some(ticket) if role == "requester" && ticket.requesterId != actorId =>
        error(StatusCodes.Forbidden, "this ticket belongs to another requester")
      case Some(_) if limit.isEmpty => error(StatusCodes.BadRequest, s"limit must be 1 to $MaxLimit")
      case Some(_) if cursor.exists(_.isEmpty) => error(StatusCodes.BadRequest, "invalid cursor")
      case Some(ticket) =>
        // A keyset page: below the cursor's seq, so notes posted meanwhile shift nothing.
        val entries = Store.page(ticketId, cursor.flatten, limit.get)
        val includeInternal = role == "agent"
        val notes = entries.filter(n => includeInternal || n.visibility != "internal")
        // The cursor follows what was fetched, not what was shown: a page of internal notes still advances.
        val nextCursor = if (entries.size == limit.get) JsString(entries.last.seq.toString) else JsNull
        json(StatusCodes.OK, JsObject(
          "ticket_id" -> JsString(ticketId), "state" -> JsString(ticket.state),
          "notes" -> JsArray(notes.map(n => Store.toJson(n)).toVector), "next_cursor" -> nextCursor))
    }
  }

  val route: Route = path("v1" / "tickets" / Segment) { ticketId =>
    get {
      caller { (actorId, role) =>
        parameterMap { params => complete(read(ticketId, actorId, role, params)) }
      }
    }
  }
}
`,
    },
    cpp: {
      starter: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <algorithm>
#include <string>

#include "tickets/store.h"  // store::getTicket, page, pageAt, toJson

using json = nlohmann::json;

constexpr long long kDefaultLimit = 20;
constexpr long long kMaxLimit = 100;

void reply(httplib::Response& res, int status, const json& body) {
  res.status = status;
  res.set_content(body.dump(), "application/json");
}

// The query parameter as a whole non-negative number, or -1.
long long number(const httplib::Request& req, const std::string& name, long long fallback) {
  if (!req.has_param(name)) return fallback;
  const std::string raw = req.get_param_value(name);
  if (raw.empty() || raw.size() > 18 || raw.find_first_not_of("0123456789") != std::string::npos) return -1;
  return std::stoll(raw);
}

void read_ticket(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has 3 flaws. The task says where to look; the checks say what must change.
  const std::string ticket_id = req.matches[1];
  const auto ticket = store::getTicket(ticket_id);
  if (!ticket) return reply(res, 404, {{"error", "unknown ticket"}});
  const long long limit = number(req, "limit", kDefaultLimit);
  if (limit < 1 || limit > kMaxLimit) return reply(res, 400, {{"error", "limit must be 1 to 100"}});
  const long long offset = std::max(0LL, number(req, "offset", 0));
  json notes = json::array();
  for (const auto& note : store::pageAt(ticket_id, offset, limit)) notes.push_back(store::toJson(note));
  const json next_offset = static_cast<long long>(notes.size()) == limit ? json(offset + limit) : json(nullptr);
  reply(res, 200, {{"ticket_id", ticket_id}, {"state", ticket->state}, {"notes", notes}, {"next_offset", next_offset}});
}

void register_routes(httplib::Server& svr) { svr.Get(R"(/v1/tickets/([\\w-]+))", read_ticket); }
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <string>

#include "tickets/store.h"  // store::getTicket, page, pageAt, toJson

using json = nlohmann::json;

constexpr long long kDefaultLimit = 20;
constexpr long long kMaxLimit = 100;

void reply(httplib::Response& res, int status, const json& body) {
  res.status = status;
  res.set_content(body.dump(), "application/json");
}

// The query parameter as a whole non-negative number, or -1.
long long number(const httplib::Request& req, const std::string& name, long long fallback) {
  if (!req.has_param(name)) return fallback;
  const std::string raw = req.get_param_value(name);
  if (raw.empty() || raw.size() > 18 || raw.find_first_not_of("0123456789") != std::string::npos) return -1;
  return std::stoll(raw);
}

void read_ticket(const httplib::Request& req, httplib::Response& res) {
  const std::string actor_id = req.get_header_value("X-Actor-Id");
  const std::string role = req.get_header_value("X-Actor-Role");
  if (actor_id.empty()) return reply(res, 401, {{"error", "X-Actor-Id is required"}});
  if (role != "requester" && role != "agent") return reply(res, 403, {{"error", "X-Actor-Role must be requester or agent"}});
  const std::string ticket_id = req.matches[1];
  const auto ticket = store::getTicket(ticket_id);
  if (!ticket) return reply(res, 404, {{"error", "unknown ticket"}});
  if (role == "requester" && ticket->requester_id != actor_id) {
    return reply(res, 403, {{"error", "this ticket belongs to another requester"}});
  }
  const long long limit = number(req, "limit", kDefaultLimit);
  if (limit < 1 || limit > kMaxLimit) return reply(res, 400, {{"error", "limit must be 1 to 100"}});
  const long long before_seq = number(req, "cursor", 0);
  if (req.has_param("cursor") && before_seq < 1) return reply(res, 400, {{"error", "invalid cursor"}});
  // A keyset page: below the cursor's seq, so notes posted meanwhile shift nothing.
  const auto entries = store::page(ticket_id, before_seq, limit);
  const bool include_internal = role == "agent";
  json notes = json::array();
  for (const auto& note : entries) {
    if (include_internal || note.visibility != "internal") notes.push_back(store::toJson(note));
  }
  // The cursor follows what was fetched, not what was shown: a page of internal notes still advances.
  const json next_cursor =
      static_cast<long long>(entries.size()) == limit ? json(std::to_string(entries.back().seq)) : json(nullptr);
  reply(res, 200, {{"ticket_id", ticket_id}, {"state", ticket->state}, {"notes", notes}, {"next_cursor", next_cursor}});
}

void register_routes(httplib::Server& svr) { svr.Get(R"(/v1/tickets/([\\w-]+))", read_ticket); }
`,
    },
  },
  harness: {
    python: `from tickets import store

R1 = {"X-Actor-Id": "R-1", "X-Actor-Role": "requester"}
R2 = {"X-Actor-Id": "R-2", "X-Actor-Role": "requester"}
AGENT = {"X-Actor-Id": "A-7", "X-Actor-Role": "agent"}
INTERNAL = "Customer is on the fraud watchlist, do not refund."


def _seed(notes):
    ticket_id = store.create_ticket("R-1", "Invoice 4471 charged twice")["id"]
    for author, visibility, body in notes:
        store.append_note(ticket_id, author, visibility, body)
    return ticket_id


def _bodies(r):
    return [n["body"] for n in r.json().get("notes", [])]


async def _read(c, ticket_id, headers, **params):
    return await c.get(f"/v1/tickets/{ticket_id}", headers=headers, params=params)


def _api(ctx):
    return ctx.client(ctx.load("read").app)


async def check_route(ctx):
    t = _seed([("R-1", "public", "My card was charged twice."), ("A-7", "public", "We refunded the second charge.")])
    async with _api(ctx) as c:
        r = await _read(c, t, AGENT)
    assert r.status_code == 200, f"GET /v1/tickets/{t} answered {r.status_code}: {r.text}"
    assert r.json().get("ticket_id") == t and r.json().get("state") == "open", f"the page must name the ticket and its state, got {r.text}"
    assert _bodies(r) == ["We refunded the second charge.", "My card was charged twice."], f"the page must list the notes newest first, got {_bodies(r)}"


async def check_internal_hidden(ctx):
    t = _seed([("R-1", "public", "My card was charged twice."), ("A-7", "internal", INTERNAL), ("A-7", "public", "We refunded the second charge.")])
    async with _api(ctx) as c:
        mine = await _read(c, t, R1)
        agent = await _read(c, t, AGENT)
    assert mine.status_code == 200, f"the requester reading their ticket answered {mine.status_code}: {mine.text}"
    assert INTERNAL not in mine.text, f"the requester's page carries an internal note: {_bodies(mine)}. Leave out visibility internal for a requester"
    assert _bodies(mine) == ["We refunded the second charge.", "My card was charged twice."], f"the requester must see the public notes, got {_bodies(mine)}"
    assert INTERNAL in _bodies(agent), f"an agent's page must keep the internal note, got {_bodies(agent)}"


async def check_requester_scope(ctx):
    t = _seed([("R-1", "public", "My card was charged twice.")])
    async with _api(ctx) as c:
        other = await _read(c, t, R2)
        assert other.status_code == 403, f"requester R-2 reading R-1's ticket answered {other.status_code}: a requester reads only their own tickets, expected 403"
        anonymous = await _read(c, t, {"X-Actor-Role": "requester"})
        assert anonymous.status_code == 401, f"a read without X-Actor-Id answered {anonymous.status_code}, expected 401"
        admin = await _read(c, t, {"X-Actor-Id": "R-1", "X-Actor-Role": "admin"})
        assert admin.status_code == 403, f"X-Actor-Role admin answered {admin.status_code}, expected 403"
        own = await _read(c, t, R1)
        agent = await _read(c, t, AGENT)
    assert own.status_code == 200 and agent.status_code == 200, f"the owner and an agent must read the ticket, got {own.status_code} and {agent.status_code}"


async def check_keyset_cursor(ctx):
    t = _seed([("A-7", "public", f"note {i}") for i in range(1, 6)])
    async with _api(ctx) as c:
        first = await _read(c, t, AGENT, limit=2)
        assert _bodies(first) == ["note 5", "note 4"], f"the first page of 2 must be the two newest notes, got {_bodies(first)}"
        cursor = first.json().get("next_cursor")
        assert isinstance(cursor, str) and cursor, f"a full page must carry next_cursor, got {first.text}"
        store.append_note(t, "R-1", "public", "note 6")  # posted while the agent scrolls
        second = await _read(c, t, AGENT, limit=2, cursor=cursor)
        assert _bodies(second) == ["note 3", "note 2"], f"after a note was posted, the second page is {_bodies(second)}, expected note 3 and note 2: the page must continue below the last note fetched"
        third = await _read(c, t, AGENT, limit=2, cursor=second.json().get("next_cursor"))
        assert _bodies(third) == ["note 1"] and third.json().get("next_cursor") is None, f"the last page must be note 1 with next_cursor null, got {third.text}"
        bad = await _read(c, t, AGENT, cursor="abc")
        assert bad.status_code == 400, f"cursor=abc answered {bad.status_code}, expected 400"
        # A requester walks a timeline whose newest notes are internal: every public note once, and the walk ends.
        t2 = _seed([("R-1", "public", "p1"), ("A-7", "internal", "i1"), ("A-7", "internal", "i2"), ("A-7", "public", "p2"), ("A-7", "internal", "i3")])
        seen, cursor = [], None
        for _ in range(10):
            r = await _read(c, t2, R1, limit=2, **({"cursor": cursor} if cursor else {}))
            seen += _bodies(r)
            cursor = r.json().get("next_cursor")
            if cursor is None:
                break
    assert seen == ["p2", "p1"], f"a requester paging the whole timeline saw {seen}, expected p2 then p1: next_cursor must follow the last note fetched, not the last one shown"
`,
    typescript: `const R1 = {'X-Actor-Id': 'R-1', 'X-Actor-Role': 'requester'};
const R2 = {'X-Actor-Id': 'R-2', 'X-Actor-Role': 'requester'};
const AGENT = {'X-Actor-Id': 'A-7', 'X-Actor-Role': 'agent'};
const INTERNAL = 'Customer is on the fraud watchlist, do not refund.';

function reader(ctx) {
  return {c: ctx.client(ctx.load('read').app), store: ctx.load('/support/tickets/store.ts')};
}

async function seed(store, notes: [string, string, string][]): Promise<string> {
  const ticketId = (await store.createTicket('R-1', 'Invoice 4471 charged twice')).id;
  for (const [author, visibility, body] of notes) await store.appendNote(ticketId, author, visibility, body);
  return ticketId;
}

const bodies = r => (r.json().notes ?? []).map(n => n.body);

function read(c, ticketId: string, headers: Record<string, string>, query: Record<string, string> = {}) {
  const qs = new URLSearchParams(query).toString();
  return c.get(\`/v1/tickets/\${ticketId}\${qs ? \`?\${qs}\` : ''}\`, {headers});
}

export async function check_route(ctx) {
  const {c, store} = reader(ctx);
  const t = await seed(store, [['R-1', 'public', 'My card was charged twice.'], ['A-7', 'public', 'We refunded the second charge.']]);
  const r = await read(c, t, AGENT);
  assert.equal(r.status, 200, \`GET /v1/tickets/\${t} answered \${r.status}: \${r.text}\`);
  assert(r.json().ticket_id === t && r.json().state === 'open', \`the page must name the ticket and its state, got \${r.text}\`);
  assert.deepStrictEqual(bodies(r), ['We refunded the second charge.', 'My card was charged twice.'], \`the page must list the notes newest first, got \${JSON.stringify(bodies(r))}\`);
}

export async function check_internal_hidden(ctx) {
  const {c, store} = reader(ctx);
  const t = await seed(store, [['R-1', 'public', 'My card was charged twice.'], ['A-7', 'internal', INTERNAL], ['A-7', 'public', 'We refunded the second charge.']]);
  const mine = await read(c, t, R1);
  const agent = await read(c, t, AGENT);
  assert.equal(mine.status, 200, \`the requester reading their ticket answered \${mine.status}: \${mine.text}\`);
  assert(!mine.text.includes(INTERNAL), \`the requester's page carries an internal note: \${JSON.stringify(bodies(mine))}. Leave out visibility internal for a requester\`);
  assert.deepStrictEqual(bodies(mine), ['We refunded the second charge.', 'My card was charged twice.'], 'the requester must see the public notes');
  assert(bodies(agent).includes(INTERNAL), \`an agent's page must keep the internal note, got \${JSON.stringify(bodies(agent))}\`);
}

export async function check_requester_scope(ctx) {
  const {c, store} = reader(ctx);
  const t = await seed(store, [['R-1', 'public', 'My card was charged twice.']]);
  const other = await read(c, t, R2);
  assert.equal(other.status, 403, \`requester R-2 reading R-1's ticket answered \${other.status}: a requester reads only their own tickets, expected 403\`);
  const anonymous = await read(c, t, {'X-Actor-Role': 'requester'});
  assert.equal(anonymous.status, 401, \`a read without X-Actor-Id answered \${anonymous.status}, expected 401\`);
  const admin = await read(c, t, {'X-Actor-Id': 'R-1', 'X-Actor-Role': 'admin'});
  assert.equal(admin.status, 403, \`X-Actor-Role admin answered \${admin.status}, expected 403\`);
  const own = await read(c, t, R1);
  const agent = await read(c, t, AGENT);
  assert(own.status === 200 && agent.status === 200, \`the owner and an agent must read the ticket, got \${own.status} and \${agent.status}\`);
}

export async function check_keyset_cursor(ctx) {
  const {c, store} = reader(ctx);
  const t = await seed(store, [1, 2, 3, 4, 5].map(i => ['A-7', 'public', \`note \${i}\`] as [string, string, string]));
  const first = await read(c, t, AGENT, {limit: '2'});
  assert.deepStrictEqual(bodies(first), ['note 5', 'note 4'], \`the first page of 2 must be the two newest notes, got \${JSON.stringify(bodies(first))}\`);
  const cursor = first.json().next_cursor;
  assert(typeof cursor === 'string' && cursor !== '', \`a full page must carry next_cursor, got \${first.text}\`);
  await store.appendNote(t, 'R-1', 'public', 'note 6'); // posted while the agent scrolls
  const second = await read(c, t, AGENT, {limit: '2', cursor});
  assert.deepStrictEqual(bodies(second), ['note 3', 'note 2'], \`after a note was posted, the second page is \${JSON.stringify(bodies(second))}, expected note 3 and note 2: the page must continue below the last note fetched\`);
  const third = await read(c, t, AGENT, {limit: '2', cursor: second.json().next_cursor});
  assert(JSON.stringify(bodies(third)) === '["note 1"]' && third.json().next_cursor === null, \`the last page must be note 1 with next_cursor null, got \${third.text}\`);
  const bad = await read(c, t, AGENT, {cursor: 'abc'});
  assert.equal(bad.status, 400, \`cursor=abc answered \${bad.status}, expected 400\`);
  // A requester walks a timeline whose newest notes are internal: every public note once, and the walk ends.
  const t2 = await seed(store, [['R-1', 'public', 'p1'], ['A-7', 'internal', 'i1'], ['A-7', 'internal', 'i2'], ['A-7', 'public', 'p2'], ['A-7', 'internal', 'i3']]);
  const seen: string[] = [];
  let next: string | null = null;
  for (let i = 0; i < 10; i++) {
    const r = await read(c, t2, R1, next === null ? {limit: '2'} : {limit: '2', cursor: next});
    seen.push(...bodies(r));
    next = r.json().next_cursor ?? null;
    if (next === null) break;
  }
  assert.deepStrictEqual(seen, ['p2', 'p1'], \`a requester paging the whole timeline saw \${JSON.stringify(seen)}, expected p2 then p1: next_cursor must follow the last note fetched, not the last one shown\`);
}
`,
    go: `package main

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"strings"

	"tickets/store"

	"leetbuild/harness"
)

const readInternal = "Customer is on the fraud watchlist, do not refund."

var (
	readBg    = context.Background()
	readR1    = []string{"X-Actor-Id", "R-1", "X-Actor-Role", "requester"}
	readR2    = []string{"X-Actor-Id", "R-2", "X-Actor-Role", "requester"}
	readAgent = []string{"X-Actor-Id", "A-7", "X-Actor-Role", "agent"}
)

type readPage struct {
	TicketID   string       \`json:"ticket_id"\`
	State      string       \`json:"state"\`
	Notes      []store.Note \`json:"notes"\`
	NextCursor *string      \`json:"next_cursor"\`
}

func readClient(ctx *harness.Ctx) *harness.HTTP {
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

func readSeed(ctx *harness.Ctx, notes [][3]string) string {
	ticketID := store.CreateTicket(readBg, "R-1", "Invoice 4471 charged twice").ID
	for _, n := range notes {
		_, err := store.AppendNote(readBg, ticketID, n[0], n[1], n[2])
		ctx.NoError(err, "AppendNote failed")
	}
	return ticketID
}

func readGet(c *harness.HTTP, ticketID string, who []string, query url.Values) (*harness.Response, readPage) {
	path := "/v1/tickets/" + ticketID
	if len(query) > 0 {
		path += "?" + query.Encode()
	}
	r := c.Get(path, who...)
	var page readPage
	r.Decode(&page)
	return r, page
}

func readBodies(page readPage) []string {
	out := []string{}
	for _, n := range page.Notes {
		out = append(out, n.Body)
	}
	return out
}

func CheckRoute(ctx *harness.Ctx) {
	c := readClient(ctx)
	t := readSeed(ctx, [][3]string{{"R-1", "public", "My card was charged twice."}, {"A-7", "public", "We refunded the second charge."}})
	r, page := readGet(c, t, readAgent, nil)
	ctx.Equal(r.Status, 200, "GET /v1/tickets/%s (%s)", t, r.Text())
	ctx.Assert(page.TicketID == t && page.State == "open", "the page must name the ticket and its state, got %s", r.Text())
	ctx.Equal(readBodies(page), []string{"We refunded the second charge.", "My card was charged twice."}, "the page must list the notes newest first")
}

func CheckInternalHidden(ctx *harness.Ctx) {
	c := readClient(ctx)
	t := readSeed(ctx, [][3]string{{"R-1", "public", "My card was charged twice."}, {"A-7", "internal", readInternal}, {"A-7", "public", "We refunded the second charge."}})
	mine, minePage := readGet(c, t, readR1, nil)
	ctx.Equal(mine.Status, 200, "the requester reading their ticket (%s)", mine.Text())
	ctx.Assert(!strings.Contains(mine.Text(), readInternal), "the requester's page carries an internal note: %q. Leave out visibility internal for a requester", readBodies(minePage))
	ctx.Equal(readBodies(minePage), []string{"We refunded the second charge.", "My card was charged twice."}, "the requester must see the public notes")
	_, agentPage := readGet(c, t, readAgent, nil)
	ctx.Assert(strings.Contains(strings.Join(readBodies(agentPage), "|"), readInternal), "an agent's page must keep the internal note, got %q", readBodies(agentPage))
}

func CheckRequesterScope(ctx *harness.Ctx) {
	c := readClient(ctx)
	t := readSeed(ctx, [][3]string{{"R-1", "public", "My card was charged twice."}})
	r, _ := readGet(c, t, readR2, nil)
	ctx.Equal(r.Status, 403, "requester R-2 reading R-1's ticket (a requester reads only their own tickets)")
	r, _ = readGet(c, t, []string{"X-Actor-Role", "requester"}, nil)
	ctx.Equal(r.Status, 401, "a read without X-Actor-Id")
	r, _ = readGet(c, t, []string{"X-Actor-Id", "R-1", "X-Actor-Role", "admin"}, nil)
	ctx.Equal(r.Status, 403, "X-Actor-Role admin")
	own, _ := readGet(c, t, readR1, nil)
	agent, _ := readGet(c, t, readAgent, nil)
	ctx.Assert(own.Status == 200 && agent.Status == 200, "the owner and an agent must read the ticket, got %d and %d", own.Status, agent.Status)
}

func CheckKeysetCursor(ctx *harness.Ctx) {
	c := readClient(ctx)
	var five [][3]string
	for i := 1; i <= 5; i++ {
		five = append(five, [3]string{"A-7", "public", fmt.Sprintf("note %d", i)})
	}
	t := readSeed(ctx, five)
	first, firstPage := readGet(c, t, readAgent, url.Values{"limit": {"2"}})
	ctx.Equal(readBodies(firstPage), []string{"note 5", "note 4"}, "the first page of 2 must be the two newest notes")
	ctx.Assert(firstPage.NextCursor != nil && *firstPage.NextCursor != "", "a full page must carry next_cursor, got %s", first.Text())
	store.AppendNote(readBg, t, "R-1", "public", "note 6") // posted while the agent scrolls
	_, second := readGet(c, t, readAgent, url.Values{"limit": {"2"}, "cursor": {*firstPage.NextCursor}})
	ctx.Equal(readBodies(second), []string{"note 3", "note 2"}, "after a note was posted, the page must continue below the last note fetched; the second page")
	ctx.Assert(second.NextCursor != nil, "the second page was full and must carry next_cursor")
	third, thirdPage := readGet(c, t, readAgent, url.Values{"limit": {"2"}, "cursor": {*second.NextCursor}})
	ctx.Assert(len(thirdPage.Notes) == 1 && thirdPage.Notes[0].Body == "note 1" && thirdPage.NextCursor == nil, "the last page must be note 1 with next_cursor null, got %s", third.Text())
	bad, _ := readGet(c, t, readAgent, url.Values{"cursor": {"abc"}})
	ctx.Equal(bad.Status, 400, "cursor=abc")
	// A requester walks a timeline whose newest notes are internal: every public note once, and the walk ends.
	t2 := readSeed(ctx, [][3]string{{"R-1", "public", "p1"}, {"A-7", "internal", "i1"}, {"A-7", "internal", "i2"}, {"A-7", "public", "p2"}, {"A-7", "internal", "i3"}})
	seen := []string{}
	query := url.Values{"limit": {"2"}}
	for i := 0; i < 10; i++ {
		_, page := readGet(c, t2, readR1, query)
		seen = append(seen, readBodies(page)...)
		if page.NextCursor == nil {
			break
		}
		query = url.Values{"limit": {"2"}, "cursor": {*page.NextCursor}}
	}
	ctx.Equal(seen, []string{"p2", "p1"}, "a requester paging the whole timeline must see every public note once (next_cursor follows the last note fetched, not the last one shown)")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <array>
#include <string>
#include <vector>

#include "tickets/store.h"

using json = nlohmann::json;

namespace {

const std::string kInternal = "Customer is on the fraud watchlist, do not refund.";

struct Actor {
  std::string id;
  std::string role;
};
const Actor kR1{"R-1", "requester"};
const Actor kR2{"R-2", "requester"};
const Actor kAgent{"A-7", "agent"};

harness::HTTP reader(harness::Ctx& ctx) {
  static httplib::Server* svr = nullptr;
  delete svr;
  svr = new httplib::Server;
  register_routes(*svr);
  return ctx.HTTP(*svr);
}

std::string seed(const std::vector<std::array<std::string, 3>>& notes) {
  const std::string ticket_id = store::createTicket("R-1", "Invoice 4471 charged twice").id;
  for (const auto& n : notes) store::appendNote(ticket_id, n[0], n[1], n[2]);
  return ticket_id;
}

harness::Response readAs(harness::HTTP& c, const std::string& ticket_id, const Actor& who, const std::string& query = "") {
  const std::string path = "/v1/tickets/" + ticket_id + (query.empty() ? "" : "?" + query);
  if (who.id.empty()) return c.Get(path, "X-Actor-Role", who.role);
  return c.Get(path, "X-Actor-Id", who.id, "X-Actor-Role", who.role);
}

json pageOf(const harness::Response& r) {
  const json page = json::parse(r.Text(), nullptr, false);
  return page.is_object() ? page : json::object();
}

std::vector<std::string> bodies(const harness::Response& r) {
  std::vector<std::string> out;
  const json page = pageOf(r);
  if (page.contains("notes") && page["notes"].is_array()) {
    for (const auto& n : page["notes"]) out.push_back(n.value("body", ""));
  }
  return out;
}

std::string cursorOf(const harness::Response& r) {
  const json page = pageOf(r);
  return page.contains("next_cursor") && page["next_cursor"].is_string() ? page["next_cursor"].get<std::string>() : "";
}

}  // namespace

void CheckRoute(harness::Ctx& ctx) {
  auto c = reader(ctx);
  const std::string t = seed({{"R-1", "public", "My card was charged twice."}, {"A-7", "public", "We refunded the second charge."}});
  const auto r = readAs(c, t, kAgent);
  ctx.Equal(r.Status, 200, "GET /v1/tickets/%s (%s)", t, r.Text());
  ctx.Assert(pageOf(r).value("ticket_id", "") == t && pageOf(r).value("state", "") == "open", "the page must name the ticket and its state, got %s", r.Text());
  ctx.Equal(bodies(r), {"We refunded the second charge.", "My card was charged twice."}, "the page must list the notes newest first");
}

void CheckInternalHidden(harness::Ctx& ctx) {
  auto c = reader(ctx);
  const std::string t = seed({{"R-1", "public", "My card was charged twice."}, {"A-7", "internal", kInternal}, {"A-7", "public", "We refunded the second charge."}});
  const auto mine = readAs(c, t, kR1);
  ctx.Equal(mine.Status, 200, "the requester reading their ticket (%s)", mine.Text());
  ctx.Assert(mine.Text().find(kInternal) == std::string::npos, "the requester's page carries an internal note: %q. Leave out visibility internal for a requester", bodies(mine));
  ctx.Equal(bodies(mine), {"We refunded the second charge.", "My card was charged twice."}, "the requester must see the public notes");
  const auto agent = readAs(c, t, kAgent);
  ctx.Assert(agent.Text().find(kInternal) != std::string::npos, "an agent's page must keep the internal note, got %q", bodies(agent));
}

void CheckRequesterScope(harness::Ctx& ctx) {
  auto c = reader(ctx);
  const std::string t = seed({{"R-1", "public", "My card was charged twice."}});
  ctx.Equal(readAs(c, t, kR2).Status, 403, "requester R-2 reading R-1's ticket (a requester reads only their own tickets)");
  ctx.Equal(readAs(c, t, Actor{"", "requester"}).Status, 401, "a read without X-Actor-Id");
  ctx.Equal(readAs(c, t, Actor{"R-1", "admin"}).Status, 403, "X-Actor-Role admin");
  const int own = readAs(c, t, kR1).Status;
  const int agent = readAs(c, t, kAgent).Status;
  ctx.Assert(own == 200 && agent == 200, "the owner and an agent must read the ticket, got %d and %d", own, agent);
}

void CheckKeysetCursor(harness::Ctx& ctx) {
  auto c = reader(ctx);
  std::vector<std::array<std::string, 3>> five;
  for (int i = 1; i <= 5; ++i) five.push_back({"A-7", "public", "note " + std::to_string(i)});
  const std::string t = seed(five);
  const auto first = readAs(c, t, kAgent, "limit=2");
  ctx.Equal(bodies(first), {"note 5", "note 4"}, "the first page of 2 must be the two newest notes");
  const std::string cursor = cursorOf(first);
  ctx.Assert(!cursor.empty(), "a full page must carry next_cursor, got %s", first.Text());
  store::appendNote(t, "R-1", "public", "note 6");  // posted while the agent scrolls
  const auto second = readAs(c, t, kAgent, "limit=2&cursor=" + cursor);
  ctx.Equal(bodies(second), {"note 3", "note 2"}, "after a note was posted, the page must continue below the last note fetched; the second page");
  const auto third = readAs(c, t, kAgent, "limit=2&cursor=" + cursorOf(second));
  ctx.Assert(bodies(third) == std::vector<std::string>{"note 1"} && pageOf(third).contains("next_cursor") && pageOf(third)["next_cursor"].is_null(),
             "the last page must be note 1 with next_cursor null, got %s", third.Text());
  ctx.Equal(readAs(c, t, kAgent, "cursor=abc").Status, 400, "cursor=abc");
  // A requester walks a timeline whose newest notes are internal: every public note once, and the walk ends.
  const std::string t2 = seed({{"R-1", "public", "p1"}, {"A-7", "internal", "i1"}, {"A-7", "internal", "i2"}, {"A-7", "public", "p2"}, {"A-7", "internal", "i3"}});
  std::vector<std::string> seen;
  std::string next;
  for (int i = 0; i < 10; ++i) {
    const auto r = readAs(c, t2, kR1, next.empty() ? "limit=2" : "limit=2&cursor=" + next);
    for (const auto& b : bodies(r)) seen.push_back(b);
    next = cursorOf(r);
    if (next.empty()) break;
  }
  ctx.Equal(seen, {"p2", "p1"}, "a requester paging the whole timeline must see every public note once (next_cursor follows the last note fetched, not the last one shown)");
}
`,
  },
  hints: [
    'Read a ticket as its requester: the agents’ internal note is on the page. Read it as another requester: it answers 200. Post a note between two page loads: the second page starts with a note the first already showed.',
    'The handler never reads `X-Actor-Id` or `X-Actor-Role`, so it cannot tell a customer from an agent, nor the owner from a stranger. `page_at` counts rows from the newest, and a new note pushes every row one place down.',
    'Read the caller (401/403) and 403 a requester who is not `requester_id`; fetch `store.page(ticket_id, before_seq, limit)`, drop `visibility == "internal"` unless the role is `agent`, and set `next_cursor` from the last note fetched when the page was full.',
  ],
  debrief: `Visibility is decided per note and per caller at the one place every read passes through, which is why the role and the owner check sit in the handler rather than in the client that renders the page. A keyset cursor names a position in the data, the \`seq\` of the last note fetched, so a note posted at the head cannot shift what comes below it; an offset names a position in a list that keeps changing. The cursor follows what was fetched rather than what was shown, or a requester's page full of internal notes would end the walk early. Production timelines encode the cursor opaquely with the sort key and a signature, so clients cannot forge one, and cache the requester's view separately from the agent's.`,
};
