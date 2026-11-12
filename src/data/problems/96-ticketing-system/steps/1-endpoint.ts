import type {Step} from '@/lib/types';

export const endpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/tickets: a transition table in front of the state',
  concept: 'http',
  file: 'api',
  focus: ['requester', 'agent', 'api', 'store'],
  task: `## Task

**Starting point.** The starter serves the write side of ticketd on the ticket store (\`tickets.store\`,
provided): \`POST /v1/tickets\` with \`{subject, body}\` opens a ticket for the caller in \`X-Actor-Id\`
and appends the body as its first note, and \`PATCH /v1/tickets/{id}\` with \`{state}\` moves the
ticket through \`store.transition\`. It serves the demo and hides 4 flaws.

**Failure mode the checks target.** A customer closes a ticket in one call, any caller moves any
ticket by id, a ticket closed last month walks back into the queue, and every create writes the
customer's words into the log.

- \`STATES\` are \`open\`, \`pending\`, \`resolved\`, \`closed\`; another state is **400**.
  \`ALLOWED_TRANSITIONS\`: \`open\` → \`pending\`, \`resolved\`; \`pending\` → \`open\`, \`resolved\`;
  \`resolved\` → \`open\`, \`closed\`; \`closed\` → \`open\`. Any other move is **409** with
  \`{"error": "illegal transition", "from", "allowed"}\`.
- \`X-Actor-Role\` is \`requester\` or \`agent\` (**403** otherwise; no \`X-Actor-Id\` is **401**). An
  agent moves any ticket, a requester only one whose \`requester_id\` is theirs (**403**).
- \`closed\` → \`open\` only while \`closed_at\` is within \`REOPEN_WINDOW_SECONDS\` (7 days); later the
  move is **409** with an empty \`allowed\`.
- Log ids, roles and states, not the subject or the body.`,
  sequence: {
    participants: ['Requester', 'Agent', 'Ticket API', 'Ticket store'],
    messages: [
      {from: 'Requester', to: 'Ticket API', label: 'POST /v1/tickets · X-Actor-Id · X-Actor-Role', kind: 'sync'},
      {from: 'Ticket API', to: 'Ticket store', label: 'create_ticket · append_note(body)', kind: 'sync'},
      {from: 'Agent', to: 'Ticket API', label: 'PATCH /v1/tickets/T-1 {state: resolved}', kind: 'sync'},
      {from: 'Ticket API', to: 'Ticket store', label: 'get_ticket(T-1)', kind: 'sync'},
      {from: 'Ticket store', to: 'Ticket API', label: 'state · requester_id · closed_at', kind: 'reply'},
      {from: 'Ticket API', to: 'Ticket API', label: 'role · owner · ALLOWED_TRANSITIONS · reopen window', kind: 'sync'},
      {from: 'Ticket API', to: 'Ticket store', label: 'transition(T-1, open, resolved)', kind: 'sync'},
      {from: 'Ticket API', to: 'Agent', label: '200 ticket · 403 · 409 {from, allowed}', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Opens and moves tickets',
      detail: 'Register `POST /v1/tickets` and `PATCH /v1/tickets/{id}`.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/tickets["']/, /@app\.patch\(\s*["']\/v1\/tickets\/\{ticket_id\}["']/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/tickets['"]/, /app\.patch\(\s*['"]\/v1\/tickets\/:\w+['"]/]},
        go: {all: [/HandleFunc\(\s*"POST \/v1\/tickets"/, /HandleFunc\(\s*"PATCH \/v1\/tickets\/\{id\}"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"tickets"\s*\)/, /\bpatch\s*\{/]},
        cpp: {all: [/svr\.Post\(\s*"\/v1\/tickets"/, /svr\.Patch\(/]},
      },
    },
    {
      id: 'transition-guard',
      title: 'Moves a ticket only along the transition table',
      detail:
        'The handler consults `ALLOWED_TRANSITIONS` for the ticket’s current state and answers **409** with the states allowed from here; an unknown state is **400**. The starter hands the body’s `state` to `store.transition` as it came, so `open → closed` succeeds.',
      match: {
        python: {all: [/ALLOWED_TRANSITIONS\s*=/, /ALLOWED_TRANSITIONS\[/, /["']allowed["']/, /\b400\b/]},
        typescript: {all: [/ALLOWED_TRANSITIONS\s*[:=]/, /ALLOWED_TRANSITIONS\[/, /\ballowed\b/, /\b400\b/]},
        go: {all: [/allowedTransitions\s*=/, /allowedTransitions\[/, /"allowed"/, /StatusBadRequest|\b400\b/]},
        scala: {all: [/AllowedTransitions\s*[:=]/, /AllowedTransitions\(/, /"allowed"/, /BadRequest/]},
        cpp: {all: [/kAllowedTransitions\s*=/, /kAllowedTransitions\.at\(/, /"allowed"/, /\b400\b/]},
      },
    },
    {
      id: 'actor-scope',
      title: 'Scopes a requester to their own ticket',
      detail:
        'The role comes from `X-Actor-Role` (`requester` or `agent`, **403** otherwise): an agent moves any ticket, a requester only one whose `requester_id` is theirs. The starter reads no role and compares no owner, so any caller moves any ticket by id.',
      match: {
        python: {all: [/x-actor-role/i, /\["requester_id"\]\s*!=|!=\s*\w+\["requester_id"\]/, /\b403\b/]},
        typescript: {all: [/x-actor-role/i, /\.requester_id\s*!==|!==\s*\w+\.requester_id/, /\b403\b/]},
        go: {all: [/X-Actor-Role/i, /\.RequesterID\s*!=|!=\s*\w+\.RequesterID/, /StatusForbidden|\b403\b/]},
        scala: {all: [/X-Actor-Role/i, /\.requesterId\s*!=|!=\s*\w+\.requesterId/, /Forbidden/]},
        cpp: {all: [/X-Actor-Role/i, /(\.|->)requester_id\s*!=|!=\s*\w+(\.|->)requester_id/, /\b403\b/]},
      },
    },
    {
      id: 'reopen-window',
      title: 'Reopens a closed ticket only inside the window',
      detail:
        '`closed → open` is allowed only while the ticket’s `closed_at` is within `REOPEN_WINDOW_SECONDS` (7 days); later the move is **409** with an empty `allowed`. The starter has no window, so a ticket closed a month ago reopens.',
      match: {
        python: {
          all: [
            /REOPEN_WINDOW_SECONDS\s*=/,
            /closed_at[^\n]*REOPEN_WINDOW_SECONDS|REOPEN_WINDOW_SECONDS[^\n]*closed_at/,
          ],
        },
        typescript: {
          all: [
            /REOPEN_WINDOW_SECONDS\s*=/,
            /closed_at[^\n]*REOPEN_WINDOW_SECONDS|REOPEN_WINDOW_SECONDS[^\n]*closed_at/,
          ],
        },
        go: {all: [/reopenWindowSeconds\s*=/, /ClosedAt[^\n]*reopenWindowSeconds|reopenWindowSeconds[^\n]*ClosedAt/]},
        scala: {
          all: [/ReopenWindowSeconds\s*[:=]/, /closedAt[^\n]*ReopenWindowSeconds|ReopenWindowSeconds[^\n]*closedAt/],
        },
        cpp: {
          all: [/kReopenWindowSeconds\s*=/, /closed_at[^\n]*kReopenWindowSeconds|kReopenWindowSeconds[^\n]*closed_at/],
        },
      },
    },
    {
      id: 'no-content-in-logs',
      title: 'Logs ids and states, never the subject or the body',
      detail:
        'The write path logs the ticket id, the caller, the role and the states; the subject and the body text never reach a log line. The starter logs both on every create.',
      match: {
        python: {all: [/logger\.info\(/], none: [/logger\.\w+\([^)]*\b(subject|body)\b/]},
        typescript: {all: [/\.log\.info\(/], none: [/log\.\w+\([^)]*\b(subject|body)\b/]},
        go: {all: [/log\.Printf\(/], none: [/log\.Printf\([^)]*\b(Subject|Body|subject|body)\b/]},
        scala: {all: [/log\.info\(/], none: [/log\.\w+\([^)]*\b(subject|body|text)\b/]},
        cpp: {all: [/std::clog\s*<</], none: [/std::clog[^;]*\b(subject|body|text)\b/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import logging

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from tickets import store  # create_ticket, get_ticket, transition, append_note

app = FastAPI()
logger = logging.getLogger("ticketd")


class TicketCreate(BaseModel):
    subject: str
    body: str = ""


class TicketMove(BaseModel):
    state: str


@app.post("/v1/tickets", status_code=201)
def open_ticket(payload: TicketCreate, request: Request):
    actor_id = request.headers.get("x-actor-id", "")
    if not actor_id:
        return JSONResponse({"error": "X-Actor-Id is required"}, status_code=401)
    ticket = store.create_ticket(actor_id, payload.subject)
    if payload.body:
        store.append_note(ticket["id"], actor_id, "public", payload.body)
    logger.info("ticket created id=%s requester=%s subject=%r body=%r", ticket["id"], actor_id, payload.subject, payload.body)
    return ticket


@app.patch("/v1/tickets/{ticket_id}")
def move_ticket(ticket_id: str, payload: TicketMove, request: Request):
    # TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
    actor_id = request.headers.get("x-actor-id", "")
    if not actor_id:
        return JSONResponse({"error": "X-Actor-Id is required"}, status_code=401)
    ticket = store.get_ticket(ticket_id)
    if ticket is None:
        return JSONResponse({"error": "unknown ticket"}, status_code=404)
    if not store.transition(ticket_id, ticket["state"], payload.state):
        return JSONResponse({"error": "the ticket changed meanwhile"}, status_code=409)
    logger.info("ticket moved id=%s to=%s", ticket_id, payload.state)
    return store.get_ticket(ticket_id)
`,
      solution: `import logging
import time

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from tickets import store  # create_ticket, get_ticket, transition, append_note

app = FastAPI()
logger = logging.getLogger("ticketd")

STATES = ("open", "pending", "resolved", "closed")
ALLOWED_TRANSITIONS = {
    "open": ["pending", "resolved"],
    "pending": ["open", "resolved"],
    "resolved": ["open", "closed"],
    "closed": ["open"],
}
REOPEN_WINDOW_SECONDS = 7 * 24 * 3600
ROLES = ("requester", "agent")


class TicketCreate(BaseModel):
    subject: str
    body: str = ""


class TicketMove(BaseModel):
    state: str


def caller(request: Request) -> tuple[str, str]:
    """X-Actor-Id (401 without one) and X-Actor-Role, requester or agent (403 otherwise)."""
    actor_id = request.headers.get("x-actor-id", "")
    role = request.headers.get("x-actor-role", "")
    if not actor_id:
        raise HTTPException(status_code=401, detail="X-Actor-Id is required")
    if role not in ROLES:
        raise HTTPException(status_code=403, detail="X-Actor-Role must be requester or agent")
    return actor_id, role


def allowed_from(ticket: dict) -> list[str]:
    """Where the ticket may move now: the table, minus a reopen past its window."""
    if ticket["state"] == "closed" and time.time() - (ticket["closed_at"] or 0) > REOPEN_WINDOW_SECONDS:
        return []
    return ALLOWED_TRANSITIONS[ticket["state"]]


@app.post("/v1/tickets", status_code=201)
def open_ticket(payload: TicketCreate, request: Request):
    actor_id, _ = caller(request)
    ticket = store.create_ticket(actor_id, payload.subject)
    if payload.body:
        store.append_note(ticket["id"], actor_id, "public", payload.body)
    logger.info("ticket created id=%s requester=%s", ticket["id"], actor_id)
    return ticket


@app.patch("/v1/tickets/{ticket_id}")
def move_ticket(ticket_id: str, payload: TicketMove, request: Request):
    actor_id, role = caller(request)
    ticket = store.get_ticket(ticket_id)
    if ticket is None:
        return JSONResponse({"error": "unknown ticket"}, status_code=404)
    if role == "requester" and ticket["requester_id"] != actor_id:
        return JSONResponse({"error": "this ticket belongs to another requester"}, status_code=403)
    if payload.state not in STATES:
        return JSONResponse({"error": f"unknown state {payload.state}"}, status_code=400)
    allowed = allowed_from(ticket)
    if payload.state not in allowed:
        return JSONResponse({"error": "illegal transition", "from": ticket["state"], "allowed": allowed}, status_code=409)
    if not store.transition(ticket_id, ticket["state"], payload.state):
        return JSONResponse({"error": "the ticket changed meanwhile"}, status_code=409)
    logger.info("ticket moved id=%s from=%s to=%s role=%s", ticket_id, ticket["state"], payload.state, role)
    return store.get_ticket(ticket_id)
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';

import {appendNote, createTicket, getTicket, transition} from 'tickets/store';

export const app = Fastify({logger: true});

app.post('/v1/tickets', async (request, reply) => {
  const actorId = request.headers['x-actor-id'];
  if (typeof actorId !== 'string' || actorId === '') return reply.code(401).send({error: 'X-Actor-Id is required'});
  const {subject, body} = request.body as {subject: string; body?: string};
  const ticket = await createTicket(actorId, subject);
  if (body) await appendNote(ticket.id, actorId, 'public', body);
  request.log.info({ticket_id: ticket.id, requester_id: actorId, subject, body}, 'ticket created');
  return reply.code(201).send(ticket);
});

app.patch('/v1/tickets/:ticketId', async (request, reply) => {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  const actorId = request.headers['x-actor-id'];
  if (typeof actorId !== 'string' || actorId === '') return reply.code(401).send({error: 'X-Actor-Id is required'});
  const {ticketId} = request.params as {ticketId: string};
  const {state} = request.body as {state: string};
  const ticket = await getTicket(ticketId);
  if (ticket === null) return reply.code(404).send({error: 'unknown ticket'});
  if (!(await transition(ticketId, ticket.state, state))) return reply.code(409).send({error: 'the ticket changed meanwhile'});
  request.log.info({ticket_id: ticketId, to: state}, 'ticket moved');
  return getTicket(ticketId);
});
`,
      solution: `import Fastify, {type FastifyRequest} from 'fastify';

import {type Ticket, appendNote, createTicket, getTicket, transition} from 'tickets/store';

export const app = Fastify({logger: true});

export const STATES = ['open', 'pending', 'resolved', 'closed'];
export const ALLOWED_TRANSITIONS: Record<string, string[]> = {
  open: ['pending', 'resolved'],
  pending: ['open', 'resolved'],
  resolved: ['open', 'closed'],
  closed: ['open'],
};
export const REOPEN_WINDOW_SECONDS = 7 * 24 * 3600;
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

/** Where the ticket may move now: the table, minus a reopen past its window. */
function allowedFrom(ticket: Ticket): string[] {
  if (ticket.state === 'closed' && Date.now() / 1000 - (ticket.closed_at ?? 0) > REOPEN_WINDOW_SECONDS) return [];
  return ALLOWED_TRANSITIONS[ticket.state];
}

app.post('/v1/tickets', async (request, reply) => {
  const who = caller(request);
  if ('status' in who) return reply.code(who.status).send({error: who.error});
  const {subject, body} = request.body as {subject: string; body?: string};
  const ticket = await createTicket(who.actorId, subject);
  if (body) await appendNote(ticket.id, who.actorId, 'public', body);
  request.log.info({ticket_id: ticket.id, requester_id: who.actorId}, 'ticket created');
  return reply.code(201).send(ticket);
});

app.patch('/v1/tickets/:ticketId', async (request, reply) => {
  const who = caller(request);
  if ('status' in who) return reply.code(who.status).send({error: who.error});
  const {ticketId} = request.params as {ticketId: string};
  const {state} = request.body as {state: string};
  const ticket = await getTicket(ticketId);
  if (ticket === null) return reply.code(404).send({error: 'unknown ticket'});
  if (who.role === 'requester' && ticket.requester_id !== who.actorId) return reply.code(403).send({error: 'this ticket belongs to another requester'});
  if (!STATES.includes(state)) return reply.code(400).send({error: \`unknown state \${state}\`});
  const allowed = allowedFrom(ticket);
  if (!allowed.includes(state)) return reply.code(409).send({error: 'illegal transition', from: ticket.state, allowed});
  if (!(await transition(ticketId, ticket.state, state))) return reply.code(409).send({error: 'the ticket changed meanwhile'});
  request.log.info({ticket_id: ticketId, from: ticket.state, to: state, role: who.role}, 'ticket moved');
  return getTicket(ticketId);
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"log"
	"net/http"

	"tickets/store" // store.CreateTicket, GetTicket, Transition, AppendNote
)

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func openTicket(rw http.ResponseWriter, r *http.Request) {
	actorID := r.Header.Get("X-Actor-Id")
	if actorID == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "X-Actor-Id is required"})
		return
	}
	var in struct {
		Subject string \`json:"subject"\`
		Body    string \`json:"body"\`
	}
	json.NewDecoder(r.Body).Decode(&in)
	ticket := store.CreateTicket(r.Context(), actorID, in.Subject)
	if in.Body != "" {
		store.AppendNote(r.Context(), ticket.ID, actorID, "public", in.Body)
	}
	log.Printf("ticket created id=%s requester=%s subject=%q body=%q", ticket.ID, actorID, in.Subject, in.Body)
	writeJSON(rw, http.StatusCreated, ticket)
}

func moveTicket(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
	actorID := r.Header.Get("X-Actor-Id")
	if actorID == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "X-Actor-Id is required"})
		return
	}
	ticketID := r.PathValue("id")
	var in struct {
		State string \`json:"state"\`
	}
	json.NewDecoder(r.Body).Decode(&in)
	ticket := store.GetTicket(r.Context(), ticketID)
	if ticket == nil {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "unknown ticket"})
		return
	}
	moved, err := store.Transition(r.Context(), ticketID, ticket.State, in.State)
	if err != nil {
		writeJSON(rw, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	if !moved {
		writeJSON(rw, http.StatusConflict, map[string]string{"error": "the ticket changed meanwhile"})
		return
	}
	log.Printf("ticket moved id=%s to=%s", ticketID, in.State)
	writeJSON(rw, http.StatusOK, store.GetTicket(r.Context(), ticketID))
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/tickets", openTicket)
	mux.HandleFunc("PATCH /v1/tickets/{id}", moveTicket)
}
`,
      solution: `package main

import (
	"encoding/json"
	"log"
	"net/http"
	"slices"
	"time"

	"tickets/store" // store.CreateTicket, GetTicket, Transition, AppendNote
)

var states = []string{"open", "pending", "resolved", "closed"}

var allowedTransitions = map[string][]string{
	"open":     {"pending", "resolved"},
	"pending":  {"open", "resolved"},
	"resolved": {"open", "closed"},
	"closed":   {"open"},
}

const reopenWindowSeconds = 7 * 24 * 3600

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

// allowedFrom is where the ticket may move now: the table, minus a reopen past its window.
func allowedFrom(ticket *store.Ticket) []string {
	if ticket.State == "closed" && time.Now().Unix()-ticket.ClosedAt > reopenWindowSeconds {
		return []string{}
	}
	return allowedTransitions[ticket.State]
}

func openTicket(rw http.ResponseWriter, r *http.Request) {
	actorID, _, ok := caller(rw, r)
	if !ok {
		return
	}
	var in struct {
		Subject string \`json:"subject"\`
		Body    string \`json:"body"\`
	}
	json.NewDecoder(r.Body).Decode(&in)
	ticket := store.CreateTicket(r.Context(), actorID, in.Subject)
	if in.Body != "" {
		store.AppendNote(r.Context(), ticket.ID, actorID, "public", in.Body)
	}
	log.Printf("ticket created id=%s requester=%s", ticket.ID, actorID)
	writeJSON(rw, http.StatusCreated, ticket)
}

func moveTicket(rw http.ResponseWriter, r *http.Request) {
	actorID, role, ok := caller(rw, r)
	if !ok {
		return
	}
	ticketID := r.PathValue("id")
	var in struct {
		State string \`json:"state"\`
	}
	json.NewDecoder(r.Body).Decode(&in)
	ticket := store.GetTicket(r.Context(), ticketID)
	if ticket == nil {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "unknown ticket"})
		return
	}
	if role == "requester" && ticket.RequesterID != actorID {
		writeJSON(rw, http.StatusForbidden, map[string]string{"error": "this ticket belongs to another requester"})
		return
	}
	if !slices.Contains(states, in.State) {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "unknown state " + in.State})
		return
	}
	allowed := allowedFrom(ticket)
	if !slices.Contains(allowed, in.State) {
		writeJSON(rw, http.StatusConflict, map[string]any{"error": "illegal transition", "from": ticket.State, "allowed": allowed})
		return
	}
	moved, err := store.Transition(r.Context(), ticketID, ticket.State, in.State)
	if err != nil {
		writeJSON(rw, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	if !moved {
		writeJSON(rw, http.StatusConflict, map[string]string{"error": "the ticket changed meanwhile"})
		return
	}
	log.Printf("ticket moved id=%s from=%s to=%s role=%s", ticketID, ticket.State, in.State, role)
	writeJSON(rw, http.StatusOK, store.GetTicket(r.Context(), ticketID))
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/tickets", openTicket)
	mux.HandleFunc("PATCH /v1/tickets/{id}", moveTicket)
}
`,
    },
    scala: {
      starter: `import java.util.logging.Logger

import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import tickets.Store // Store.createTicket, getTicket, transition, appendNote

object Api {
  private val log = Logger.getLogger("ticketd")

  private def json(status: StatusCode, body: JsValue): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  private def error(status: StatusCode, message: String): HttpResponse = json(status, JsObject("error" -> JsString(message)))

  private def field(raw: String, name: String): String =
    raw.parseJson.asJsObject.fields.get(name).collect { case JsString(s) => s }.getOrElse("")

  private def move(ticketId: String, state: String): HttpResponse =
    Store.getTicket(ticketId) match {
      case None => error(StatusCodes.NotFound, "unknown ticket")
      case Some(t) =>
        if (!Store.transition(ticketId, t.state, state)) error(StatusCodes.Conflict, "the ticket changed meanwhile")
        else {
          log.info(s"ticket moved id=$ticketId to=$state")
          json(StatusCodes.OK, Store.toJson(Store.getTicket(ticketId).get))
        }
    }

  val route: Route = concat(
    path("v1" / "tickets") {
      post {
        optionalHeaderValueByName("X-Actor-Id") {
          case None | Some("") => complete(error(StatusCodes.Unauthorized, "X-Actor-Id is required"))
          case Some(actorId) =>
            entity(as[String]) { raw =>
              val subject = field(raw, "subject")
              val text = field(raw, "body")
              val ticket = Store.createTicket(actorId, subject)
              if (text.nonEmpty) Store.appendNote(ticket.id, actorId, "public", text)
              log.info(s"ticket created id=\${ticket.id} requester=$actorId subject=$subject body=$text")
              complete(json(StatusCodes.Created, Store.toJson(ticket)))
            }
        }
      }
    },
    path("v1" / "tickets" / Segment) { ticketId =>
      patch {
        // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
        optionalHeaderValueByName("X-Actor-Id") {
          case None | Some("") => complete(error(StatusCodes.Unauthorized, "X-Actor-Id is required"))
          case Some(_) => entity(as[String]) { raw => complete(move(ticketId, field(raw, "state"))) }
        }
      }
    },
  )
}
`,
      solution: `import java.util.logging.Logger

import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import tickets.Store // Store.createTicket, getTicket, transition, appendNote

object Api {
  val States: Seq[String] = Seq("open", "pending", "resolved", "closed")
  val AllowedTransitions: Map[String, Seq[String]] = Map(
    "open" -> Seq("pending", "resolved"),
    "pending" -> Seq("open", "resolved"),
    "resolved" -> Seq("open", "closed"),
    "closed" -> Seq("open"))
  val ReopenWindowSeconds: Long = 7L * 24 * 3600
  val Roles: Seq[String] = Seq("requester", "agent")

  private val log = Logger.getLogger("ticketd")

  private def json(status: StatusCode, body: JsValue): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  private def error(status: StatusCode, message: String): HttpResponse = json(status, JsObject("error" -> JsString(message)))

  private def field(raw: String, name: String): String =
    raw.parseJson.asJsObject.fields.get(name).collect { case JsString(s) => s }.getOrElse("")

  /** Where the ticket may move now: the table, minus a reopen past its window. */
  private def allowedFrom(ticket: Store.Ticket): Seq[String] =
    if (ticket.state == "closed" && System.currentTimeMillis() / 1000 - ticket.closedAt.getOrElse(0L) > ReopenWindowSeconds) Seq.empty
    else AllowedTransitions(ticket.state)

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

  private def move(ticketId: String, actorId: String, role: String, state: String): HttpResponse =
    Store.getTicket(ticketId) match {
      case None => error(StatusCodes.NotFound, "unknown ticket")
      case Some(t) if role == "requester" && t.requesterId != actorId => error(StatusCodes.Forbidden, "this ticket belongs to another requester")
      case Some(_) if !States.contains(state) => error(StatusCodes.BadRequest, s"unknown state $state")
      case Some(t) =>
        val allowed = allowedFrom(t)
        if (!allowed.contains(state))
          json(StatusCodes.Conflict, JsObject("error" -> JsString("illegal transition"), "from" -> JsString(t.state), "allowed" -> JsArray(allowed.map(JsString(_)).toVector)))
        else if (!Store.transition(ticketId, t.state, state)) error(StatusCodes.Conflict, "the ticket changed meanwhile")
        else {
          log.info(s"ticket moved id=$ticketId from=\${t.state} to=$state role=$role")
          json(StatusCodes.OK, Store.toJson(Store.getTicket(ticketId).get))
        }
    }

  val route: Route = concat(
    path("v1" / "tickets") {
      post {
        caller { (actorId, _) =>
          entity(as[String]) { raw =>
            val ticket = Store.createTicket(actorId, field(raw, "subject"))
            val note = field(raw, "body")
            if (note.nonEmpty) Store.appendNote(ticket.id, actorId, "public", note)
            log.info(s"ticket created id=\${ticket.id} requester=$actorId")
            complete(json(StatusCodes.Created, Store.toJson(ticket)))
          }
        }
      }
    },
    path("v1" / "tickets" / Segment) { ticketId =>
      patch {
        caller { (actorId, role) =>
          entity(as[String]) { raw => complete(move(ticketId, actorId, role, field(raw, "state"))) }
        }
      }
    },
  )
}
`,
    },
    cpp: {
      starter: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <iostream>
#include <string>

#include "tickets/store.h"  // store::createTicket, getTicket, transition, appendNote, toJson

using json = nlohmann::json;

void reply(httplib::Response& res, int status, const json& body) {
  res.status = status;
  res.set_content(body.dump(), "application/json");
}

void open_ticket(const httplib::Request& req, httplib::Response& res) {
  const std::string actor_id = req.get_header_value("X-Actor-Id");
  if (actor_id.empty()) return reply(res, 401, {{"error", "X-Actor-Id is required"}});
  const json in = json::parse(req.body);
  const std::string subject = in.value("subject", "");
  const std::string text = in.value("body", "");
  const store::Ticket ticket = store::createTicket(actor_id, subject);
  if (!text.empty()) store::appendNote(ticket.id, actor_id, "public", text);
  std::clog << "ticket created id=" << ticket.id << " requester=" << actor_id << " subject=" << subject << " body=" << text << "\\n";
  reply(res, 201, store::toJson(ticket));
}

void move_ticket(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  const std::string actor_id = req.get_header_value("X-Actor-Id");
  if (actor_id.empty()) return reply(res, 401, {{"error", "X-Actor-Id is required"}});
  const std::string ticket_id = req.matches[1];
  const std::string state = json::parse(req.body).value("state", "");
  const auto ticket = store::getTicket(ticket_id);
  if (!ticket) return reply(res, 404, {{"error", "unknown ticket"}});
  if (!store::transition(ticket_id, ticket->state, state)) return reply(res, 409, {{"error", "the ticket changed meanwhile"}});
  std::clog << "ticket moved id=" << ticket_id << " to=" << state << "\\n";
  reply(res, 200, store::toJson(*store::getTicket(ticket_id)));
}

void register_routes(httplib::Server& svr) {
  svr.Post("/v1/tickets", open_ticket);
  svr.Patch(R"(/v1/tickets/([\\w-]+))", move_ticket);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <algorithm>
#include <chrono>
#include <iostream>
#include <map>
#include <string>
#include <vector>

#include "tickets/store.h"  // store::createTicket, getTicket, transition, appendNote, toJson

using json = nlohmann::json;

const std::vector<std::string> kStates = {"open", "pending", "resolved", "closed"};
const std::map<std::string, std::vector<std::string>> kAllowedTransitions = {
    {"open", {"pending", "resolved"}},
    {"pending", {"open", "resolved"}},
    {"resolved", {"open", "closed"}},
    {"closed", {"open"}},
};
constexpr long long kReopenWindowSeconds = 7LL * 24 * 3600;
const std::vector<std::string> kRoles = {"requester", "agent"};

void reply(httplib::Response& res, int status, const json& body) {
  res.status = status;
  res.set_content(body.dump(), "application/json");
}

bool listed(const std::vector<std::string>& items, const std::string& item) {
  return std::find(items.begin(), items.end(), item) != items.end();
}

// X-Actor-Id (401 without one) and X-Actor-Role, requester or agent (403 otherwise); false once the error is written.
bool caller(const httplib::Request& req, httplib::Response& res, std::string& actor_id, std::string& role) {
  actor_id = req.get_header_value("X-Actor-Id");
  role = req.get_header_value("X-Actor-Role");
  if (actor_id.empty()) {
    reply(res, 401, {{"error", "X-Actor-Id is required"}});
    return false;
  }
  if (!listed(kRoles, role)) {
    reply(res, 403, {{"error", "X-Actor-Role must be requester or agent"}});
    return false;
  }
  return true;
}

// Where the ticket may move now: the table, minus a reopen past its window.
std::vector<std::string> allowed_from(const store::Ticket& ticket) {
  const long long now =
      std::chrono::duration_cast<std::chrono::seconds>(std::chrono::system_clock::now().time_since_epoch()).count();
  if (ticket.state == "closed" && now - ticket.closed_at > kReopenWindowSeconds) return {};
  return kAllowedTransitions.at(ticket.state);
}

void open_ticket(const httplib::Request& req, httplib::Response& res) {
  std::string actor_id, role;
  if (!caller(req, res, actor_id, role)) return;
  const json in = json::parse(req.body);
  const store::Ticket ticket = store::createTicket(actor_id, in.value("subject", ""));
  const std::string note = in.value("body", "");
  if (!note.empty()) store::appendNote(ticket.id, actor_id, "public", note);
  std::clog << "ticket created id=" << ticket.id << " requester=" << actor_id << "\\n";
  reply(res, 201, store::toJson(ticket));
}

void move_ticket(const httplib::Request& req, httplib::Response& res) {
  std::string actor_id, role;
  if (!caller(req, res, actor_id, role)) return;
  const std::string ticket_id = req.matches[1];
  const std::string state = json::parse(req.body).value("state", "");
  const auto ticket = store::getTicket(ticket_id);
  if (!ticket) return reply(res, 404, {{"error", "unknown ticket"}});
  if (role == "requester" && ticket->requester_id != actor_id) {
    return reply(res, 403, {{"error", "this ticket belongs to another requester"}});
  }
  if (!listed(kStates, state)) return reply(res, 400, {{"error", "unknown state " + state}});
  const std::vector<std::string> allowed = allowed_from(*ticket);
  if (!listed(allowed, state)) {
    return reply(res, 409, {{"error", "illegal transition"}, {"from", ticket->state}, {"allowed", allowed}});
  }
  if (!store::transition(ticket_id, ticket->state, state)) return reply(res, 409, {{"error", "the ticket changed meanwhile"}});
  std::clog << "ticket moved id=" << ticket_id << " from=" << ticket->state << " to=" << state << " role=" << role << "\\n";
  reply(res, 200, store::toJson(*store::getTicket(ticket_id)));
}

void register_routes(httplib::Server& svr) {
  svr.Post("/v1/tickets", open_ticket);
  svr.Patch(R"(/v1/tickets/([\\w-]+))", move_ticket);
}
`,
    },
  },
  harness: {
    python: `import logging

from tickets import store

R1 = {"X-Actor-Id": "R-1", "X-Actor-Role": "requester"}
R2 = {"X-Actor-Id": "R-2", "X-Actor-Role": "requester"}
AGENT = {"X-Actor-Id": "A-7", "X-Actor-Role": "agent"}
SUBJECT = "Invoice 4471 charged twice"
BODY = "My card ending 4917 was charged twice for invoice 4471."
DAY = 24 * 3600


def _api(ctx):
    return ctx.client(ctx.load("api").app)


async def _open(c, headers=R1):
    r = await c.post("/v1/tickets", json={"subject": SUBJECT, "body": BODY}, headers=headers)
    assert r.status_code == 201, f"POST /v1/tickets answered {r.status_code}: {r.text}"
    ticket = r.json()
    assert ticket.get("state") == "open", f"a new ticket must be open, got {ticket}"
    return ticket["id"]


async def _move(c, ticket_id, state, headers=AGENT):
    return await c.patch(f"/v1/tickets/{ticket_id}", json={"state": state}, headers=headers)


async def _walk(c, ticket_id, *states):
    for state in states:
        r = await _move(c, ticket_id, state)
        assert r.status_code == 200, f"an agent moving {ticket_id} to {state} answered {r.status_code}: {r.text}"


async def check_route(ctx):
    async with _api(ctx) as c:
        ticket_id = await _open(c)
        r = await _move(c, ticket_id, "pending", R1)
    assert r.status_code == 200, f"the requester moving their ticket open → pending answered {r.status_code}: {r.text}"
    assert r.json().get("state") == "pending", f"the move must answer the ticket in its new state, got {r.json()}"
    stored = store.get_ticket(ticket_id)
    assert stored["state"] == "pending" and stored["requester_id"] == "R-1", f"the store holds {stored}"
    notes = store.page(ticket_id, None, 10)
    assert [n["body"] for n in notes] == [BODY], f"the create must append the body as the first note, the ticket has {notes}"


async def check_transition_guard(ctx):
    async with _api(ctx) as c:
        ticket_id = await _open(c)
        r = await _move(c, ticket_id, "closed", R1)
        assert r.status_code == 409, f"open → closed answered {r.status_code} ({r.text}): a ticket closes only from resolved, expected 409"
        body = r.json()
        assert body.get("from") == "open" and sorted(body.get("allowed") or []) == ["pending", "resolved"], f"the 409 must name the current state and the states allowed from it, got {body}"
        assert store.get_ticket(ticket_id)["state"] == "open", f"a refused move changed the ticket: {store.get_ticket(ticket_id)}"
        r = await _move(c, ticket_id, "archived")
        assert r.status_code == 400, f"state 'archived' answered {r.status_code}: a state outside STATES is 400"
        await _walk(c, ticket_id, "resolved", "closed")
        r = await _move(c, ticket_id, "pending")
    assert r.status_code == 409 and r.json().get("allowed") == ["open"], f"closed → pending answered {r.status_code} {r.text}, expected 409 allowing only open"


async def check_actor_scope(ctx):
    async with _api(ctx) as c:
        ticket_id = await _open(c)
        r = await _move(c, ticket_id, "pending", R2)
        assert r.status_code == 403, f"requester R-2 moving R-1's ticket answered {r.status_code}: a requester moves only their own tickets, expected 403"
        assert store.get_ticket(ticket_id)["state"] == "open", "another requester's move changed the ticket"
        r = await _move(c, ticket_id, "pending", {"X-Actor-Id": "R-1", "X-Actor-Role": "admin"})
        assert r.status_code == 403, f"X-Actor-Role admin answered {r.status_code}: a role other than requester or agent is 403"
        r = await _move(c, ticket_id, "pending", {"X-Actor-Role": "agent"})
        assert r.status_code == 401, f"a move without X-Actor-Id answered {r.status_code}, expected 401"
        r = await _move(c, ticket_id, "pending", AGENT)
    assert r.status_code == 200, f"an agent moving any ticket answered {r.status_code}: {r.text}"


async def check_reopen_window(ctx):
    async with _api(ctx) as c:
        ticket_id = await _open(c)
        await _walk(c, ticket_id, "resolved", "closed")
        ctx.clock.advance(3 * DAY)
        r = await _move(c, ticket_id, "open", R1)
        assert r.status_code == 200, f"reopening 3 days after the close answered {r.status_code}: {r.text}"
        await _walk(c, ticket_id, "resolved", "closed")
        ctx.clock.advance(8 * DAY)
        r = await _move(c, ticket_id, "open", R1)
        assert r.status_code == 409, f"reopening 8 days after the close answered {r.status_code}: past REOPEN_WINDOW_SECONDS (7 days) the move is 409"
        assert r.json().get("allowed") == [], f"a reopen past the window has nowhere to go: allowed must be empty, got {r.json()}"
    assert store.get_ticket(ticket_id)["state"] == "closed", f"the stale reopen changed the ticket: {store.get_ticket(ticket_id)}"


class _Lines(logging.Handler):
    def __init__(self):
        super().__init__(logging.DEBUG)
        self.lines = []

    def emit(self, record):
        self.lines.append(record.getMessage())


async def check_no_content_in_logs(ctx):
    lines = _Lines()
    root = logging.getLogger()
    level = root.level
    root.addHandler(lines)
    root.setLevel(logging.DEBUG)
    try:
        async with _api(ctx) as c:
            ticket_id = await _open(c)
            await _move(c, ticket_id, "pending", R1)
    finally:
        root.removeHandler(lines)
        root.setLevel(level)
    text = "\\n".join(lines.lines)
    assert ticket_id in text, f"the write path must log the ticket id; it logged {lines.lines}"
    for words in (SUBJECT, BODY, "4917"):
        assert words not in text, f"a log line carries what the customer wrote ({words!r}): {lines.lines}. Log ids, roles and states"
`,
    typescript: `const R1 = {'X-Actor-Id': 'R-1', 'X-Actor-Role': 'requester'};
const R2 = {'X-Actor-Id': 'R-2', 'X-Actor-Role': 'requester'};
const AGENT = {'X-Actor-Id': 'A-7', 'X-Actor-Role': 'agent'};
const SUBJECT = 'Invoice 4471 charged twice';
const BODY = 'My card ending 4917 was charged twice for invoice 4471.';
const DAY = 24 * 3600;

function api(ctx) {
  const m = ctx.load('api');
  return {c: ctx.client(m.app), store: ctx.load('/support/tickets/store.ts')};
}

async function open(c, headers = R1): Promise<string> {
  const r = await c.post('/v1/tickets', {json: {subject: SUBJECT, body: BODY}, headers});
  assert.equal(r.status, 201, \`POST /v1/tickets answered \${r.status}: \${r.text}\`);
  assert.equal(r.json().state, 'open', \`a new ticket must be open, got \${r.text}\`);
  return r.json().id;
}

const move = (c, ticketId: string, state: string, headers: Record<string, string> = AGENT) =>
  c.patch(\`/v1/tickets/\${ticketId}\`, {json: {state}, headers});

async function walk(c, ticketId: string, ...states: string[]): Promise<void> {
  for (const state of states) {
    const r = await move(c, ticketId, state);
    assert.equal(r.status, 200, \`an agent moving \${ticketId} to \${state} answered \${r.status}: \${r.text}\`);
  }
}

export async function check_route(ctx) {
  const {c, store} = api(ctx);
  const ticketId = await open(c);
  const r = await move(c, ticketId, 'pending', R1);
  assert.equal(r.status, 200, \`the requester moving their ticket open → pending answered \${r.status}: \${r.text}\`);
  assert.equal(r.json().state, 'pending', \`the move must answer the ticket in its new state, got \${r.text}\`);
  const stored = await store.getTicket(ticketId);
  assert(stored.state === 'pending' && stored.requester_id === 'R-1', \`the store holds \${JSON.stringify(stored)}\`);
  const notes = await store.page(ticketId, null, 10);
  assert.deepStrictEqual(notes.map(n => n.body), [BODY], \`the create must append the body as the first note, the ticket has \${JSON.stringify(notes)}\`);
}

export async function check_transition_guard(ctx) {
  const {c, store} = api(ctx);
  const ticketId = await open(c);
  let r = await move(c, ticketId, 'closed', R1);
  assert.equal(r.status, 409, \`open → closed answered \${r.status} (\${r.text}): a ticket closes only from resolved, expected 409\`);
  const body = r.json();
  assert(body.from === 'open' && JSON.stringify([...(body.allowed ?? [])].sort()) === '["pending","resolved"]', \`the 409 must name the current state and the states allowed from it, got \${r.text}\`);
  assert.equal((await store.getTicket(ticketId)).state, 'open', 'a refused move changed the ticket');
  r = await move(c, ticketId, 'archived');
  assert.equal(r.status, 400, \`state 'archived' answered \${r.status}: a state outside STATES is 400\`);
  await walk(c, ticketId, 'resolved', 'closed');
  r = await move(c, ticketId, 'pending');
  assert(r.status === 409 && JSON.stringify(r.json().allowed) === '["open"]', \`closed → pending answered \${r.status} \${r.text}, expected 409 allowing only open\`);
}

export async function check_actor_scope(ctx) {
  const {c, store} = api(ctx);
  const ticketId = await open(c);
  let r = await move(c, ticketId, 'pending', R2);
  assert.equal(r.status, 403, \`requester R-2 moving R-1's ticket answered \${r.status}: a requester moves only their own tickets, expected 403\`);
  assert.equal((await store.getTicket(ticketId)).state, 'open', "another requester's move changed the ticket");
  r = await move(c, ticketId, 'pending', {'X-Actor-Id': 'R-1', 'X-Actor-Role': 'admin'});
  assert.equal(r.status, 403, \`X-Actor-Role admin answered \${r.status}: a role other than requester or agent is 403\`);
  r = await move(c, ticketId, 'pending', {'X-Actor-Role': 'agent'});
  assert.equal(r.status, 401, \`a move without X-Actor-Id answered \${r.status}, expected 401\`);
  r = await move(c, ticketId, 'pending', AGENT);
  assert.equal(r.status, 200, \`an agent moving any ticket answered \${r.status}: \${r.text}\`);
}

export async function check_reopen_window(ctx) {
  const {c, store} = api(ctx);
  const ticketId = await open(c);
  await walk(c, ticketId, 'resolved', 'closed');
  ctx.clock.advance(3 * DAY);
  let r = await move(c, ticketId, 'open', R1);
  assert.equal(r.status, 200, \`reopening 3 days after the close answered \${r.status}: \${r.text}\`);
  await walk(c, ticketId, 'resolved', 'closed');
  ctx.clock.advance(8 * DAY);
  r = await move(c, ticketId, 'open', R1);
  assert.equal(r.status, 409, \`reopening 8 days after the close answered \${r.status}: past REOPEN_WINDOW_SECONDS (7 days) the move is 409\`);
  assert.deepStrictEqual(r.json().allowed, [], \`a reopen past the window has nowhere to go: allowed must be empty, got \${r.text}\`);
  assert.equal((await store.getTicket(ticketId)).state, 'closed', 'the stale reopen changed the ticket');
}

export async function check_no_content_in_logs(ctx) {
  const lines: string[] = [];
  const real = {log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug};
  console.log = console.info = console.warn = console.error = console.debug = (...args: unknown[]) =>
    void lines.push(args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  let ticketId = '';
  try {
    const {c} = api(ctx);
    ticketId = await open(c);
    await move(c, ticketId, 'pending', R1);
  } finally {
    Object.assign(console, real);
  }
  const text = lines.join('\\n');
  assert(text.includes(ticketId), \`the write path must log the ticket id; it logged \${JSON.stringify(lines)}\`);
  for (const words of [SUBJECT, BODY, '4917']) {
    assert(!text.includes(words), \`a log line carries what the customer wrote (\${JSON.stringify(words)}): \${JSON.stringify(lines)}. Log ids, roles and states\`);
  }
}
`,
    go: `package main

import (
	"bytes"
	"context"
	"log"
	"net/http"
	"os"
	"sort"
	"strings"

	"tickets/store"

	"leetbuild/harness"
)

const (
	apiSubject = "Invoice 4471 charged twice"
	apiBody    = "My card ending 4917 was charged twice for invoice 4471."
	apiDay     = 24 * 3600
)

var (
	apiR1    = []string{"X-Actor-Id", "R-1", "X-Actor-Role", "requester"}
	apiR2    = []string{"X-Actor-Id", "R-2", "X-Actor-Role", "requester"}
	apiAgent = []string{"X-Actor-Id", "A-7", "X-Actor-Role", "agent"}
)

type apiRefusal struct {
	From    string   \`json:"from"\`
	Allowed []string \`json:"allowed"\`
}

func apiClient(ctx *harness.Ctx) *harness.HTTP {
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

func apiOpen(ctx *harness.Ctx, c *harness.HTTP) string {
	r := c.Post("/v1/tickets", map[string]string{"subject": apiSubject, "body": apiBody}, apiR1...)
	ctx.Equal(r.Status, 201, "POST /v1/tickets (%s)", r.Text())
	var ticket store.Ticket
	r.Decode(&ticket)
	ctx.Equal(ticket.State, "open", "a new ticket's state")
	return ticket.ID
}

func apiMove(c *harness.HTTP, ticketID, state string, who []string) *harness.Response {
	return c.Patch("/v1/tickets/"+ticketID, map[string]string{"state": state}, who...)
}

func apiWalk(ctx *harness.Ctx, c *harness.HTTP, ticketID string, states ...string) {
	for _, state := range states {
		r := apiMove(c, ticketID, state, apiAgent)
		ctx.Equal(r.Status, 200, "an agent moving %s to %s (%s)", ticketID, state, r.Text())
	}
}

func apiState(ticketID string) string { return store.GetTicket(context.Background(), ticketID).State }

func CheckRoute(ctx *harness.Ctx) {
	c := apiClient(ctx)
	ticketID := apiOpen(ctx, c)
	r := apiMove(c, ticketID, "pending", apiR1)
	ctx.Equal(r.Status, 200, "the requester moving their ticket open → pending (%s)", r.Text())
	ctx.Assert(strings.Contains(r.Text(), \`"pending"\`), "the move must answer the ticket in its new state, got %s", r.Text())
	stored := store.GetTicket(context.Background(), ticketID)
	ctx.Assert(stored.State == "pending" && stored.RequesterID == "R-1", "the store holds %+v", stored)
	notes := store.Page(context.Background(), ticketID, 0, 10)
	ctx.Assert(len(notes) == 1 && notes[0].Body == apiBody, "the create must append the body as the first note, the ticket has %+v", notes)
}

func CheckTransitionGuard(ctx *harness.Ctx) {
	c := apiClient(ctx)
	ticketID := apiOpen(ctx, c)
	r := apiMove(c, ticketID, "closed", apiR1)
	ctx.Equal(r.Status, 409, "open → closed (%s): a ticket closes only from resolved", r.Text())
	var refusal apiRefusal
	r.Decode(&refusal)
	sort.Strings(refusal.Allowed)
	ctx.Assert(refusal.From == "open" && strings.Join(refusal.Allowed, ",") == "pending,resolved", "the 409 must name the current state and the states allowed from it, got %s", r.Text())
	ctx.Equal(apiState(ticketID), "open", "a refused move must leave the ticket; its state")
	r = apiMove(c, ticketID, "archived", apiAgent)
	ctx.Equal(r.Status, 400, "state 'archived' (a state outside states is 400)")
	apiWalk(ctx, c, ticketID, "resolved", "closed")
	r = apiMove(c, ticketID, "pending", apiAgent)
	refusal = apiRefusal{}
	r.Decode(&refusal)
	ctx.Assert(r.Status == 409 && strings.Join(refusal.Allowed, ",") == "open", "closed → pending answered %d %s, expected 409 allowing only open", r.Status, r.Text())
}

func CheckActorScope(ctx *harness.Ctx) {
	c := apiClient(ctx)
	ticketID := apiOpen(ctx, c)
	r := apiMove(c, ticketID, "pending", apiR2)
	ctx.Equal(r.Status, 403, "requester R-2 moving R-1's ticket (a requester moves only their own tickets)")
	ctx.Equal(apiState(ticketID), "open", "another requester's move must leave the ticket; its state")
	r = apiMove(c, ticketID, "pending", []string{"X-Actor-Id", "R-1", "X-Actor-Role", "admin"})
	ctx.Equal(r.Status, 403, "X-Actor-Role admin (a role other than requester or agent is 403)")
	r = apiMove(c, ticketID, "pending", []string{"X-Actor-Role", "agent"})
	ctx.Equal(r.Status, 401, "a move without X-Actor-Id")
	r = apiMove(c, ticketID, "pending", apiAgent)
	ctx.Equal(r.Status, 200, "an agent moving any ticket (%s)", r.Text())
}

func CheckReopenWindow(ctx *harness.Ctx) {
	c := apiClient(ctx)
	ticketID := apiOpen(ctx, c)
	apiWalk(ctx, c, ticketID, "resolved", "closed")
	ctx.Clock.Advance(3 * apiDay)
	r := apiMove(c, ticketID, "open", apiR1)
	ctx.Equal(r.Status, 200, "reopening 3 days after the close (%s)", r.Text())
	apiWalk(ctx, c, ticketID, "resolved", "closed")
	ctx.Clock.Advance(8 * apiDay)
	r = apiMove(c, ticketID, "open", apiR1)
	ctx.Equal(r.Status, 409, "reopening 8 days after the close (past reopenWindowSeconds, 7 days, the move is 409)")
	var refusal apiRefusal
	r.Decode(&refusal)
	ctx.Assert(refusal.Allowed != nil && len(refusal.Allowed) == 0, "a reopen past the window has nowhere to go: allowed must be empty, got %s", r.Text())
	ctx.Equal(apiState(ticketID), "closed", "the stale reopen must leave the ticket; its state")
}

func CheckNoContentInLogs(ctx *harness.Ctx) {
	var logged bytes.Buffer
	log.SetOutput(&logged)
	defer log.SetOutput(os.Stderr)
	c := apiClient(ctx)
	ticketID := apiOpen(ctx, c)
	apiMove(c, ticketID, "pending", apiR1)
	text := logged.String()
	ctx.Assert(strings.Contains(text, ticketID), "the write path must log the ticket id; it logged %q", text)
	for _, words := range []string{apiSubject, apiBody, "4917"} {
		ctx.Assert(!strings.Contains(text, words), "a log line carries what the customer wrote (%q): %q. Log ids, roles and states", words, text)
	}
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <algorithm>
#include <iostream>
#include <sstream>
#include <string>
#include <vector>

#include "tickets/store.h"

using json = nlohmann::json;

namespace {

const std::string kSubject = "Invoice 4471 charged twice";
const std::string kBody = "My card ending 4917 was charged twice for invoice 4471.";
constexpr double kDay = 24 * 3600;

struct Actor {
  std::string id;
  std::string role;
};
const Actor kR1{"R-1", "requester"};
const Actor kR2{"R-2", "requester"};
const Actor kAgent{"A-7", "agent"};

harness::HTTP api(harness::Ctx& ctx) {
  static httplib::Server* svr = nullptr;
  delete svr;
  svr = new httplib::Server;
  register_routes(*svr);
  return ctx.HTTP(*svr);
}

std::string openTicket(harness::Ctx& ctx, harness::HTTP& c) {
  const auto r = c.Post("/v1/tickets", json{{"subject", kSubject}, {"body", kBody}}.dump(), "Content-Type", "application/json",
                        "X-Actor-Id", kR1.id, "X-Actor-Role", kR1.role);
  ctx.Equal(r.Status, 201, "POST /v1/tickets (%s)", r.Text());
  const json ticket = json::parse(r.Text());
  ctx.Equal(ticket.value("state", ""), "open", "a new ticket's state");
  return ticket.value("id", "");
}

harness::Response moveTo(harness::HTTP& c, const std::string& ticket_id, const std::string& state, const Actor& who) {
  const std::string body = json{{"state", state}}.dump();
  if (who.id.empty()) return c.Patch("/v1/tickets/" + ticket_id, body, "Content-Type", "application/json", "X-Actor-Role", who.role);
  return c.Patch("/v1/tickets/" + ticket_id, body, "Content-Type", "application/json", "X-Actor-Id", who.id, "X-Actor-Role", who.role);
}

void walk(harness::Ctx& ctx, harness::HTTP& c, const std::string& ticket_id, const std::vector<std::string>& states) {
  for (const auto& state : states) {
    const auto r = moveTo(c, ticket_id, state, kAgent);
    ctx.Equal(r.Status, 200, "an agent moving %s to %s (%s)", ticket_id, state, r.Text());
  }
}

std::vector<std::string> allowedOf(const harness::Response& r) {
  const json body = json::parse(r.Text(), nullptr, false);
  if (!body.is_object() || !body.contains("allowed") || !body["allowed"].is_array()) return {"<none>"};
  auto allowed = body["allowed"].get<std::vector<std::string>>();
  std::sort(allowed.begin(), allowed.end());
  return allowed;
}

std::string stateOf(const std::string& ticket_id) { return store::getTicket(ticket_id)->state; }

}  // namespace

void CheckRoute(harness::Ctx& ctx) {
  auto c = api(ctx);
  const std::string ticket_id = openTicket(ctx, c);
  const auto r = moveTo(c, ticket_id, "pending", kR1);
  ctx.Equal(r.Status, 200, "the requester moving their ticket open → pending (%s)", r.Text());
  ctx.Assert(r.Text().find("\\"pending\\"") != std::string::npos, "the move must answer the ticket in its new state, got %s", r.Text());
  const auto stored = store::getTicket(ticket_id);
  ctx.Assert(stored->state == "pending" && stored->requester_id == "R-1", "the store holds state %q, requester %q", stored->state, stored->requester_id);
  const auto notes = store::page(ticket_id, 0, 10);
  ctx.Assert(notes.size() == 1 && notes[0].body == kBody, "the create must append the body as the first note, the ticket has %d notes", notes.size());
}

void CheckTransitionGuard(harness::Ctx& ctx) {
  auto c = api(ctx);
  const std::string ticket_id = openTicket(ctx, c);
  auto r = moveTo(c, ticket_id, "closed", kR1);
  ctx.Equal(r.Status, 409, "open → closed (%s): a ticket closes only from resolved", r.Text());
  ctx.Assert(json::parse(r.Text(), nullptr, false).value("from", "") == "open", "the 409 must name the current state, got %s", r.Text());
  ctx.Equal(allowedOf(r), {"pending", "resolved"}, "the 409 must list the states allowed from open");
  ctx.Equal(stateOf(ticket_id), "open", "a refused move must leave the ticket; its state");
  r = moveTo(c, ticket_id, "archived", kAgent);
  ctx.Equal(r.Status, 400, "state 'archived' (a state outside kStates is 400)");
  walk(ctx, c, ticket_id, {"resolved", "closed"});
  r = moveTo(c, ticket_id, "pending", kAgent);
  ctx.Assert(r.Status == 409 && allowedOf(r) == std::vector<std::string>{"open"}, "closed → pending answered %d %s, expected 409 allowing only open", r.Status, r.Text());
}

void CheckActorScope(harness::Ctx& ctx) {
  auto c = api(ctx);
  const std::string ticket_id = openTicket(ctx, c);
  auto r = moveTo(c, ticket_id, "pending", kR2);
  ctx.Equal(r.Status, 403, "requester R-2 moving R-1's ticket (a requester moves only their own tickets)");
  ctx.Equal(stateOf(ticket_id), "open", "another requester's move must leave the ticket; its state");
  r = moveTo(c, ticket_id, "pending", Actor{"R-1", "admin"});
  ctx.Equal(r.Status, 403, "X-Actor-Role admin (a role other than requester or agent is 403)");
  r = moveTo(c, ticket_id, "pending", Actor{"", "agent"});
  ctx.Equal(r.Status, 401, "a move without X-Actor-Id");
  r = moveTo(c, ticket_id, "pending", kAgent);
  ctx.Equal(r.Status, 200, "an agent moving any ticket (%s)", r.Text());
}

void CheckReopenWindow(harness::Ctx& ctx) {
  auto c = api(ctx);
  const std::string ticket_id = openTicket(ctx, c);
  walk(ctx, c, ticket_id, {"resolved", "closed"});
  ctx.Clock.Advance(3 * kDay);
  auto r = moveTo(c, ticket_id, "open", kR1);
  ctx.Equal(r.Status, 200, "reopening 3 days after the close (%s)", r.Text());
  walk(ctx, c, ticket_id, {"resolved", "closed"});
  ctx.Clock.Advance(8 * kDay);
  r = moveTo(c, ticket_id, "open", kR1);
  ctx.Equal(r.Status, 409, "reopening 8 days after the close (past kReopenWindowSeconds, 7 days, the move is 409)");
  ctx.Equal(allowedOf(r), std::vector<std::string>{}, "a reopen past the window has nowhere to go: allowed must be empty");
  ctx.Equal(stateOf(ticket_id), "closed", "the stale reopen must leave the ticket; its state");
}

void CheckNoContentInLogs(harness::Ctx& ctx) {
  std::ostringstream logged;
  auto* clg = std::clog.rdbuf(logged.rdbuf());
  auto* err = std::cerr.rdbuf(logged.rdbuf());
  auto* out = std::cout.rdbuf(logged.rdbuf());
  std::string ticket_id;
  try {
    auto c = api(ctx);
    ticket_id = openTicket(ctx, c);
    moveTo(c, ticket_id, "pending", kR1);
  } catch (...) {
    std::clog.rdbuf(clg);
    std::cerr.rdbuf(err);
    std::cout.rdbuf(out);
    throw;
  }
  std::clog.rdbuf(clg);
  std::cerr.rdbuf(err);
  std::cout.rdbuf(out);
  const std::string text = logged.str();
  ctx.Assert(text.find(ticket_id) != std::string::npos, "the write path must log the ticket id; it logged %q", text);
  for (const std::string& words : {kSubject, kBody, std::string("4917")}) {
    ctx.Assert(text.find(words) == std::string::npos, "a log line carries what the customer wrote (%q): %q. Log ids, roles and states", words, text);
  }
}
`,
  },
  hints: [
    'As requester R-1, PATCH your new ticket to `closed`: it closes. As R-2, PATCH R-1’s ticket: it moves. Close a ticket, wait eight days, reopen it: it reopens. Then read the log.',
    'The handler passes the body’s `state` straight to `store.transition`, which only checks that nobody moved the ticket meanwhile. Nothing reads `X-Actor-Role`, compares `requester_id` or looks at `closed_at`, and the create logs `subject` and `body`.',
    'Read the caller (401/403), then for a requester require `ticket.requester_id == actor_id` (403), 400 on a state outside `STATES`, 409 with `allowed` unless the state is in `allowed_from(ticket)` (the table, empty for a stale reopen); log ids and states only.',
  ],
  debrief: `The table is the state machine: the handler asks it where a ticket may go from here, which is why the 409 can name the allowed moves and why the write that follows is a compare-and-set on the state the table approved. Ownership is a comparison of the ticket's \`requester_id\` with the caller, because the role header only says what kind of caller this is. The reopen window needs \`closed_at\` and a clock, so it lives next to the table and empties \`allowed\` once the week is over. Zendesk goes further: an automation closes solved tickets after a few days, and a reply to a closed ticket opens a follow-up ticket linked to the old one, so a closed ticket's history stays as it was.`,
};
