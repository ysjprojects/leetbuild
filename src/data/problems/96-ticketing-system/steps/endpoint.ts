import type {Step} from '@/lib/types';

export const endpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/tickets: transitions that are states, not strings',
  concept: 'http',
  file: 'api',
  focus: ['requester', 'agent', 'api', 'store'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it registers \`POST /v1/tickets\`,
reads the requester header, and stores whatever the caller sends. It compiles, it serves the demo, and
it hides five production flaws. Review it like the service owner, fix it, and prove the fix with the
checks below.

Implement \`POST /v1/tickets\` — one route for intake and for updates.

- The requester comes from the \`X-Requester-Id\` header; a missing id is **401**.
- The actor role comes from the \`X-Actor-Role\` header (\`requester\` | \`agent\`); an absent or
  unknown role is **403**.
- A request **without** an \`id\` creates a ticket: the subject is required (**400** when empty), the
  ticket records the caller as its \`requester_id\`, and its state is **\`open\`** — the caller never
  picks the initial state.
- A request **with** an \`id\` updates that ticket (unknown id → **404**). The requested \`state\` must
  be one of \`open\`, \`pending\`, \`resolved\`, \`closed\` (**400** otherwise) and must be in the ticket's
  allowed set. Keep that set as a table named \`ALLOWED_TRANSITIONS\` (or the local spelling —
  \`allowedTransitions\` / \`AllowedTransitions\` / \`kAllowedTransitions\`) instead of an \`if\` per state:

  - \`open\` → \`pending\`, \`resolved\`
  - \`pending\` → \`resolved\`, \`open\`
  - \`resolved\` → \`closed\`, \`open\`
  - \`closed\` → \`open\` (reopen only; see the window below)

  An illegal transition is **409** and the body carries the states the ticket may move to right now,
  e.g. \`{"error": "illegal transition", "from": "open", "allowed": ["pending", "resolved"]}\`. Never copy
  the caller's string onto the ticket: \`state\` is a state of the machine, not a free-form string.
- Actor scope: an \`agent\` may update any ticket; a \`requester\` may update only a ticket whose
  \`requester_id\` is their own — anyone else's ticket is **403**.
- Reopening — \`closed\` → \`open\` — is allowed only while the ticket was closed recently. Keep the
  window in a named constant in seconds (\`7 * 24 * 3600\`; \`REOPEN_WINDOW_SECONDS\`, or the local
  spelling such as \`reopenWindowSeconds\` / \`ReopenWindowSeconds\` / \`kReopenWindowSeconds\`), record
  when the ticket entered \`closed\`, and refuse a stale reopen with **409** and an empty \`allowed\` set.
  Clear that timestamp when the ticket leaves \`closed\`.
- Log **ids and states only** — never the subject and never the body text.

**Failure mode the checks target.** Copying \`state\` from the request body turns the state machine
into a string field, so a customer closes their own ticket in one call and support loses the signal
that the ticket was ever worked. A missing ownership check turns \`POST /v1/tickets\` into "edit any
ticket by id" for every authenticated caller. A reopen with no window lets a year-old closed ticket
walk back into the queue with no trace of why. And the subject and body of a support ticket are
customer content: logging them ships a customer's message into every log sink on every write.`,
  sequence: {
    participants: ['Requester', 'Agent', 'Ticket API', 'Ticket store'],
    messages: [
      {from: 'Requester', to: 'Ticket API', label: 'POST /v1/tickets · X-Requester-Id · X-Actor-Role', kind: 'sync'},
      {from: 'Agent', to: 'Ticket API', label: 'agent update: any ticket', kind: 'sync'},
      {from: 'Ticket API', to: 'Ticket store', label: 'get(ticket_id)', kind: 'sync'},
      {from: 'Ticket store', to: 'Ticket API', label: 'ticket / none', kind: 'reply'},
      {from: 'Ticket API', to: 'Ticket API', label: 'actor scope · allowed transitions · reopen window', kind: 'sync'},
      {from: 'Ticket API', to: 'Ticket store', label: 'put(ticket · state, closed_at)', kind: 'async'},
      {from: 'Ticket API', to: 'Requester', label: '201 / 200 ticket · 403 · 409 {allowed}', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'ticket-endpoint',
      title: 'Handles POST /v1/tickets',
      detail: 'Register the intake and update route on `POST /v1/tickets`.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/tickets["']/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/tickets['"]/]},
        go: {all: [/HandleFunc\(\s*"POST \/v1\/tickets"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"tickets"\s*\)/, /\bpost\s*\{/]},
        cpp: {all: [/svr\.Post\(\s*"\/v1\/tickets"/]},
      },
    },
    {
      id: 'transition-guard',
      title: 'Guards every state change with the allowed-transition table',
      detail:
        'The allowed set is a table the handler consults, and a move outside it answers **409** carrying the states that are allowed from here. The draft assigns the request body’s `state` straight onto the ticket, so `open → closed` succeeds and a customer can close their own ticket.',
      match: {
        python: {all: [/allowed_?transitions/i, /\b409\b/]},
        typescript: {all: [/allowed_?transitions/i, /\b409\b/]},
        go: {all: [/allowed_?transitions/i, /StatusConflict/]},
        scala: {all: [/allowed_?transitions/i, /StatusCodes\.Conflict/]},
        cpp: {all: [/allowed_?transitions/i, /\b409\b/]},
      },
    },
    {
      id: 'actor-scope',
      title: 'Scopes a requester to their own ticket',
      detail:
        'The role is read from `X-Actor-Role`: an agent may update any ticket, a requester only their own, and another requester’s ticket answers **403**. The draft never reads the role and never compares the ticket’s owner, so any caller edits any ticket by id.',
      match: {
        python: {all: [/x-actor-role/i, /\b403\b/]},
        typescript: {all: [/x-actor-role/i, /\b403\b/]},
        go: {all: [/x-actor-role/i, /StatusForbidden/]},
        scala: {all: [/x-actor-role/i, /StatusCodes\.Forbidden/]},
        cpp: {all: [/x-actor-role/i, /\b403\b/]},
      },
    },
    {
      id: 'reopen-window',
      title: 'Reopens a closed ticket only inside the window',
      detail:
        '`closed → open` is allowed only while the ticket was closed within a named window in seconds (7 days); the ticket stores when it was closed, and a stale reopen is **409** with an empty allowed set. The draft has no window and no close timestamp at all.',
      match: {
        python: {all: [/reopen_?window_?seconds/i, /closed_?at/i]},
        typescript: {all: [/reopen_?window_?seconds/i, /closed_?at/i]},
        go: {all: [/reopen_?window_?seconds/i, /closed_?at/i]},
        scala: {all: [/reopen_?window_?seconds/i, /closed_?at/i]},
        cpp: {all: [/reopen_?window_?seconds/i, /closed_?at/i]},
      },
    },
    {
      id: 'no-content-in-logs',
      title: 'Logs ids and states, never the subject or the body',
      detail:
        'The write path is logged with ids, roles and states; the subject and the body text never reach a log line. The draft logs `subject` and `body` on every create.',
      match: {
        python: {all: [/logger\.info\(/], none: [/logger\.\w+\([^)]*(subject|body|content)/i]},
        typescript: {all: [/\.log\.info\(/], none: [/log\.\w+\([^)]*(subject|body|content)/i]},
        go: {all: [/log\.Printf\(/], none: [/log\.\w+\([^)]*([Ss]ubject|[Bb]ody|[Cc]ontent)/]},
        scala: {all: [/log\.info\(/], none: [/log\.info\([^)]*(subject|body|content)/i]},
        cpp: {
          all: [/(std::)?(cerr|clog)\s*<</],
          none: [/(std::)?(cerr|clog)[^;]*([Ss]ubject|[Bb]ody|[Cc]ontent)/],
        },
      },
    },
  ],
  code: {
    python: {
      starter: `import logging
import uuid

from fastapi import FastAPI, Header
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()
logger = logging.getLogger("ticketd")


class TicketBody(BaseModel):
    id: str | None = None
    subject: str | None = None
    body: str | None = None
    state: str | None = None


class TicketStore:
    def add(self, ticket: dict) -> None:
        """Insert a new ticket."""
        raise NotImplementedError

    def get(self, ticket_id: str) -> dict | None:
        """The stored ticket, if any."""
        raise NotImplementedError

    def put(self, ticket_id: str, ticket: dict) -> None:
        """Persist the ticket."""
        raise NotImplementedError


store = TicketStore()


@app.post("/v1/tickets")
def tickets(
    body: TicketBody,
    requester_id: str = Header(alias="X-Requester-Id"),
) -> JSONResponse:
    # TODO: this draft copies the caller's state string onto the ticket, has no allowed-transition
    # table, lets any caller edit any ticket by id, has no reopen window, and logs the subject and
    # the body text. Review all five before this serves a real tenant.
    if body.id is None:
        ticket = {
            "id": str(uuid.uuid4()),
            "requester_id": requester_id,
            "subject": body.subject,
            "state": body.state or "open",
        }
        store.add(ticket)
        logger.info(
            "ticket created requester=%s subject=%r body=%r",
            requester_id,
            body.subject,
            body.body,
        )
        return JSONResponse(ticket, status_code=201)

    ticket = store.get(body.id)
    ticket["state"] = body.state
    store.put(body.id, ticket)
    logger.info("ticket updated ticket_id=%s state=%s", body.id, body.state)
    return JSONResponse(ticket, status_code=200)
`,
      solution: `import logging
import time
import uuid

from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()
logger = logging.getLogger("ticketd")

STATES = ("open", "pending", "resolved", "closed")
ALLOWED_TRANSITIONS = {
    "open": ["pending", "resolved"],
    "pending": ["resolved", "open"],
    "resolved": ["closed", "open"],
    "closed": ["open"],
}
REOPEN_WINDOW_SECONDS = 7 * 24 * 3600
ROLES = ("requester", "agent")


class TicketBody(BaseModel):
    id: str | None = None
    subject: str | None = None
    body: str | None = None
    state: str | None = None


class TicketStore:
    def add(self, ticket: dict) -> None:
        """Insert a new ticket."""
        raise NotImplementedError

    def get(self, ticket_id: str) -> dict | None:
        """The stored ticket, if any."""
        raise NotImplementedError

    def put(self, ticket_id: str, ticket: dict) -> None:
        """Persist the ticket."""
        raise NotImplementedError


store = TicketStore()


def allowed_next(state: str, closed_at: float | None, now: float) -> list[str]:
    """Where this ticket may move now: the table, minus a reopen that is past its window."""
    if state != "closed":
        return list(ALLOWED_TRANSITIONS[state])
    if closed_at is not None and now - closed_at <= REOPEN_WINDOW_SECONDS:
        return list(ALLOWED_TRANSITIONS["closed"])
    return []


@app.post("/v1/tickets")
def tickets(
    body: TicketBody,
    requester_id: str | None = Header(default=None, alias="X-Requester-Id"),
    actor_role: str | None = Header(default=None, alias="X-Actor-Role"),
) -> JSONResponse:
    if requester_id is None or requester_id == "":
        raise HTTPException(status_code=401, detail="missing X-Requester-Id")
    if actor_role not in ROLES:
        raise HTTPException(status_code=403, detail="X-Actor-Role must be requester or agent")

    if body.id is None:
        if body.subject is None or body.subject == "":
            raise HTTPException(status_code=400, detail="subject is required on create")
        ticket = {
            "id": str(uuid.uuid4()),
            "requester_id": requester_id,
            "subject": body.subject,
            "state": "open",
            "closed_at": None,
        }
        store.add(ticket)
        logger.info("ticket created ticket_id=%s requester=%s", ticket["id"], requester_id)
        return JSONResponse(ticket, status_code=201)

    ticket = store.get(body.id)
    if ticket is None:
        raise HTTPException(status_code=404, detail="unknown ticket")
    if actor_role == "requester" and ticket["requester_id"] != requester_id:
        raise HTTPException(status_code=403, detail="this ticket belongs to another requester")
    if body.state is None or body.state not in STATES:
        raise HTTPException(status_code=400, detail="unknown state")

    now = time.time()
    allowed = allowed_next(ticket["state"], ticket["closed_at"], now)
    if body.state not in allowed:
        return JSONResponse(
            {"error": "illegal transition", "from": ticket["state"], "allowed": allowed},
            status_code=409,
        )

    ticket["state"] = body.state
    ticket["closed_at"] = now if body.state == "closed" else None
    store.put(ticket["id"], ticket)
    logger.info(
        "ticket updated ticket_id=%s requester=%s role=%s state=%s",
        ticket["id"],
        requester_id,
        actor_role,
        ticket["state"],
    )
    return JSONResponse(ticket, status_code=200)
`,
    },
    typescript: {
      starter: `/** POST /v1/tickets: a model-generated draft that stores whatever state the caller sends. */
import {randomUUID} from 'node:crypto';

import Fastify from 'fastify';

import {store} from './store';

export const app = Fastify();

interface TicketBody {
  id?: string;
  subject?: string;
  body?: string;
  state?: string;
}

interface Ticket {
  id: string;
  requester_id: string;
  subject: string;
  state: string;
}

app.post('/v1/tickets', async (request, reply) => {
  // TODO: this draft copies the caller's state string onto the ticket, has no allowed-transition
  // table, lets any caller edit any ticket by id, has no reopen window, and logs the subject and
  // the body text. Review all five before this serves a real tenant.
  const requesterId = request.headers['x-requester-id'] as string;
  const body = request.body as TicketBody;

  if (body.id === undefined) {
    const ticket = {
      id: randomUUID(),
      requester_id: requesterId,
      subject: body.subject,
      state: body.state ?? 'open',
    };
    await store.add(ticket);
    request.log.info({ticket_id: ticket.id, subject: body.subject, body: body.body}, 'ticket created');
    return reply.code(201).send(ticket);
  }

  const ticket: Ticket = await store.get(body.id);
  ticket.state = body.state ?? ticket.state;
  await store.put(ticket.id, ticket);
  request.log.info({ticket_id: ticket.id, state: ticket.state}, 'ticket updated');
  return reply.code(200).send(ticket);
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** POST /v1/tickets: guarded transitions, per-ticket actor scope, and a reopen window. */
import {randomUUID} from 'node:crypto';

import Fastify from 'fastify';

import {store} from './store';

export const app = Fastify();

const STATES = ['open', 'pending', 'resolved', 'closed'] as const;
type TicketState = (typeof STATES)[number];

const ALLOWED_TRANSITIONS: Record<TicketState, TicketState[]> = {
  open: ['pending', 'resolved'],
  pending: ['resolved', 'open'],
  resolved: ['closed', 'open'],
  closed: ['open'],
};

const REOPEN_WINDOW_SECONDS = 7 * 24 * 3600;
const ROLES = ['requester', 'agent'];

interface TicketBody {
  id?: string;
  subject?: string;
  body?: string;
  state?: string;
}

interface Ticket {
  id: string;
  requester_id: string;
  subject: string;
  state: TicketState;
  closed_at: number | null;
}

const isState = (value: string): value is TicketState => (STATES as readonly string[]).includes(value);

/** Where this ticket may move now: the table, minus a reopen that is past its window. */
function allowedNext(state: TicketState, closedAt: number | null, now: number): TicketState[] {
  if (state !== 'closed') return ALLOWED_TRANSITIONS[state];
  if (closedAt !== null && now - closedAt <= REOPEN_WINDOW_SECONDS) return ALLOWED_TRANSITIONS.closed;
  return [];
}

app.post('/v1/tickets', async (request, reply) => {
  const requesterId = request.headers['x-requester-id'];
  if (typeof requesterId !== 'string' || requesterId === '')
    return reply.code(401).send({error: 'missing X-Requester-Id'});
  const actorRole = request.headers['x-actor-role'];
  if (actorRole !== 'requester' && actorRole !== 'agent')
    return reply.code(403).send({error: 'X-Actor-Role must be requester or agent'});

  const body = request.body as TicketBody;

  if (body.id === undefined) {
    if (typeof body.subject !== 'string' || body.subject === '')
      return reply.code(400).send({error: 'subject is required on create'});
    const ticket: Ticket = {
      id: randomUUID(),
      requester_id: requesterId,
      subject: body.subject,
      state: 'open',
      closed_at: null,
    };
    await store.add(ticket);
    request.log.info({ticket_id: ticket.id, requester_id: requesterId}, 'ticket created');
    return reply.code(201).send(ticket);
  }

  const ticket: Ticket | null = await store.get(body.id);
  if (ticket === null) return reply.code(404).send({error: 'unknown ticket'});
  if (actorRole === 'requester' && ticket.requester_id !== requesterId)
    return reply.code(403).send({error: 'this ticket belongs to another requester'});
  if (typeof body.state !== 'string' || !isState(body.state))
    return reply.code(400).send({error: 'unknown state'});

  const now = Date.now() / 1000;
  const allowed = allowedNext(ticket.state, ticket.closed_at, now);
  if (!allowed.includes(body.state))
    return reply.code(409).send({error: 'illegal transition', from: ticket.state, allowed});

  ticket.state = body.state;
  ticket.closed_at = body.state === 'closed' ? now : null;
  await store.put(ticket.id, ticket);
  request.log.info(
    {ticket_id: ticket.id, requester_id: requesterId, role: actorRole, state: ticket.state},
    'ticket updated',
  );
  return reply.code(200).send(ticket);
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

	"github.com/google/uuid"
)

type TicketRequest struct {
	ID      string \`json:"id"\`
	Subject string \`json:"subject"\`
	Body    string \`json:"body"\`
	State   string \`json:"state"\`
}

type Ticket struct {
	ID          string \`json:"id"\`
	RequesterID string \`json:"requester_id"\`
	Subject     string \`json:"subject"\`
	State       string \`json:"state"\`
}

type TicketStore struct{}

func (s *TicketStore) Get(id string) (*Ticket, error)      { return nil, nil }
func (s *TicketStore) Put(ticket *Ticket) error            { return nil }
func (s *TicketStore) Add(ticket *Ticket) error            { return nil }

var store = &TicketStore{}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func tickets(rw http.ResponseWriter, r *http.Request) {
	requesterID := r.Header.Get("X-Requester-Id")
	var in TicketRequest
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	// TODO: this draft copies the caller's state string onto the ticket, has no allowed-transition
	// table, lets any caller edit any ticket by id, has no reopen window, and logs the subject and
	// the body text. Review all five before this serves a real tenant.
	if in.ID == "" {
		state := in.State
		if state == "" {
			state = "open"
		}
		ticket := &Ticket{ID: uuid.NewString(), RequesterID: requesterID, Subject: in.Subject, State: state}
		store.Add(ticket)
		log.Printf("ticket created id=%s requester=%s subject=%q body=%q", ticket.ID, requesterID, in.Subject, in.Body)
		writeJSON(rw, http.StatusCreated, ticket)
		return
	}
	ticket, _ := store.Get(in.ID)
	ticket.State = in.State
	store.Put(ticket)
	log.Printf("ticket updated id=%s state=%s", in.ID, in.State)
	writeJSON(rw, http.StatusOK, ticket)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/tickets", tickets)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
      solution: `package main

import (
	"encoding/json"
	"log"
	"net/http"
	"time"

	"github.com/google/uuid"
)

const reopenWindowSeconds = 7 * 24 * 3600

var allowedTransitions = map[string][]string{
	"open":     {"pending", "resolved"},
	"pending":  {"resolved", "open"},
	"resolved": {"closed", "open"},
	"closed":   {"open"},
}

var states = map[string]bool{"open": true, "pending": true, "resolved": true, "closed": true}
var roles = map[string]bool{"requester": true, "agent": true}

type TicketRequest struct {
	ID      string \`json:"id"\`
	Subject string \`json:"subject"\`
	Body    string \`json:"body"\`
	State   string \`json:"state"\`
}

type Ticket struct {
	ID          string \`json:"id"\`
	RequesterID string \`json:"requester_id"\`
	Subject     string \`json:"subject"\`
	State       string \`json:"state"\`
	ClosedAt    *int64 \`json:"closed_at"\`
}

type TicketStore struct{}

func (s *TicketStore) Get(id string) (*Ticket, error) { return nil, nil }
func (s *TicketStore) Put(ticket *Ticket) error       { return nil }
func (s *TicketStore) Add(ticket *Ticket) error       { return nil }

var store = &TicketStore{}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func contains(list []string, want string) bool {
	for _, item := range list {
		if item == want {
			return true
		}
	}
	return false
}

// allowedNext is where this ticket may move now: the table, minus a reopen past its window.
func allowedNext(state string, closedAt *int64, now int64) []string {
	if state != "closed" {
		return allowedTransitions[state]
	}
	if closedAt != nil && now-*closedAt <= reopenWindowSeconds {
		return allowedTransitions["closed"]
	}
	return []string{}
}

func tickets(rw http.ResponseWriter, r *http.Request) {
	requesterID := r.Header.Get("X-Requester-Id")
	if requesterID == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-Requester-Id"})
		return
	}
	role := r.Header.Get("X-Actor-Role")
	if !roles[role] {
		writeJSON(rw, http.StatusForbidden, map[string]string{"error": "X-Actor-Role must be requester or agent"})
		return
	}
	var in TicketRequest
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}

	if in.ID == "" {
		if in.Subject == "" {
			writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "subject is required on create"})
			return
		}
		ticket := &Ticket{ID: uuid.NewString(), RequesterID: requesterID, Subject: in.Subject, State: "open"}
		if err := store.Add(ticket); err != nil {
			writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
			return
		}
		log.Printf("ticket created id=%s requester=%s", ticket.ID, requesterID)
		writeJSON(rw, http.StatusCreated, ticket)
		return
	}

	ticket, err := store.Get(in.ID)
	if err != nil || ticket == nil {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "unknown ticket"})
		return
	}
	if role == "requester" && ticket.RequesterID != requesterID {
		writeJSON(rw, http.StatusForbidden, map[string]string{"error": "this ticket belongs to another requester"})
		return
	}
	if !states[in.State] {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "unknown state"})
		return
	}

	now := time.Now().Unix()
	allowed := allowedNext(ticket.State, ticket.ClosedAt, now)
	if !contains(allowed, in.State) {
		writeJSON(rw, http.StatusConflict, map[string]any{
			"error":   "illegal transition",
			"from":    ticket.State,
			"allowed": allowed,
		})
		return
	}
	ticket.State = in.State
	if in.State == "closed" {
		ticket.ClosedAt = &now
	} else {
		ticket.ClosedAt = nil
	}
	if err := store.Put(ticket); err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	log.Printf("ticket updated id=%s requester=%s role=%s state=%s", ticket.ID, requesterID, role, ticket.State)
	writeJSON(rw, http.StatusOK, ticket)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/tickets", tickets)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
    },
    scala: {
      starter: `import java.util.UUID

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class TicketRequest(id: Option[String], subject: Option[String], body: Option[String], state: Option[String])
final case class Ticket(id: String, requester_id: String, subject: String, state: String)

object TicketApi {
  implicit val system: ActorSystem = ActorSystem("ticketd")
  implicit val requestFormat: RootJsonFormat[TicketRequest] = jsonFormat4(TicketRequest)
  implicit val ticketFormat: RootJsonFormat[Ticket] = jsonFormat4(Ticket)

  val store = TicketStore.open()

  val route: Route =
    path("v1" / "tickets") {
      post {
        headerValueByName("X-Requester-Id") { requesterId =>
          entity(as[TicketRequest]) { req =>
            // TODO: this draft copies the caller's state string onto the ticket, has no
            // allowed-transition table, lets any caller edit any ticket by id, has no reopen
            // window, and logs the subject and the body text. Review all five.
            req.id match {
              case None =>
                val ticket =
                  Ticket(UUID.randomUUID().toString, requesterId, req.subject.getOrElse(""), req.state.getOrElse("open"))
                store.add(ticket)
                system.log.info(s"ticket created subject=\${req.subject} body=\${req.body}")
                complete(StatusCodes.Created, ticket)
              case Some(id) =>
                val stored = store.get(id).get
                val updated = stored.copy(state = req.state.getOrElse(stored.state))
                store.put(updated)
                system.log.info(s"ticket updated id=$id state=\${updated.state}")
                complete(StatusCodes.OK, updated)
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
      solution: `import java.util.UUID

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class TicketRequest(id: Option[String], subject: Option[String], body: Option[String], state: Option[String])
final case class Ticket(
    id: String,
    requester_id: String,
    subject: String,
    state: String,
    closed_at: Option[Long],
)

object TicketApi {
  implicit val system: ActorSystem = ActorSystem("ticketd")
  implicit val requestFormat: RootJsonFormat[TicketRequest] = jsonFormat4(TicketRequest)
  implicit val ticketFormat: RootJsonFormat[Ticket] = jsonFormat5(Ticket)

  val States = Set("open", "pending", "resolved", "closed")
  val AllowedTransitions: Map[String, List[String]] = Map(
    "open" -> List("pending", "resolved"),
    "pending" -> List("resolved", "open"),
    "resolved" -> List("closed", "open"),
    "closed" -> List("open"),
  )
  val ReopenWindowSeconds = 7 * 24 * 3600
  val Roles = Set("requester", "agent")

  val store = TicketStore.open()

  /** Where this ticket may move now: the table, minus a reopen that is past its window. */
  def allowedNext(state: String, closedAt: Option[Long], now: Long): List[String] =
    if (state != "closed") AllowedTransitions(state)
    else
      closedAt match {
        case Some(at) if now - at <= ReopenWindowSeconds => AllowedTransitions("closed")
        case _                                           => Nil
      }

  val route: Route =
    path("v1" / "tickets") {
      post {
        optionalHeaderValueByName("X-Requester-Id") { requesterOpt =>
          optionalHeaderValueByName("X-Actor-Role") { roleOpt =>
            entity(as[TicketRequest]) { req =>
              if (!requesterOpt.exists(_.nonEmpty)) {
                complete(StatusCodes.Unauthorized, """{"error":"missing X-Requester-Id"}""")
              } else if (!roleOpt.exists(Roles.contains)) {
                complete(StatusCodes.Forbidden, """{"error":"X-Actor-Role must be requester or agent"}""")
              } else {
                val requesterId = requesterOpt.get
                val role = roleOpt.get
                req.id match {
                  case None =>
                    if (!req.subject.exists(_.nonEmpty)) {
                      complete(StatusCodes.BadRequest, """{"error":"subject is required on create"}""")
                    } else {
                      val ticket = Ticket(UUID.randomUUID().toString, requesterId, req.subject.get, "open", None)
                      store.add(ticket)
                      system.log.info(s"ticket created id=\${ticket.id} requester=$requesterId")
                      complete(StatusCodes.Created, ticket)
                    }
                  case Some(id) =>
                    store.get(id) match {
                      case None =>
                        complete(StatusCodes.NotFound, """{"error":"unknown ticket"}""")
                      case Some(ticket) if role == "requester" && ticket.requester_id != requesterId =>
                        complete(StatusCodes.Forbidden, """{"error":"this ticket belongs to another requester"}""")
                      case Some(ticket) if !req.state.exists(States.contains) =>
                        complete(StatusCodes.BadRequest, """{"error":"unknown state"}""")
                      case Some(ticket) =>
                        val now = System.currentTimeMillis() / 1000
                        val allowed = allowedNext(ticket.state, ticket.closed_at, now)
                        if (!allowed.contains(req.state.get)) {
                          val allowedJson = allowed.map(state => "\\"" + state + "\\"").mkString("[", ",", "]")
                          complete(
                            StatusCodes.Conflict,
                            s"""{"error":"illegal transition","from":"\${ticket.state}","allowed":$allowedJson}""",
                          )
                        } else {
                          val updated = ticket
                            .copy(state = req.state.get, closed_at = if (req.state.get == "closed") Some(now) else None)
                          store.put(updated)
                          system.log.info(
                            s"ticket updated id=\${updated.id} requester=$requesterId role=$role state=\${updated.state}",
                          )
                          complete(StatusCodes.OK, updated)
                        }
                    }
                }
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
#include <optional>
#include <string>

using json = nlohmann::json;

struct TicketStore {
  void add(const json& ticket);
  std::optional<json> get(const std::string& ticketId);
  void put(const std::string& ticketId, const json& ticket);
};

TicketStore store;
std::string uuidString();

int main() {
  httplib::Server svr;

  svr.Post("/v1/tickets", [](const httplib::Request& req, httplib::Response& res) {
    const auto requesterId = req.get_header_value("X-Requester-Id");
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) {
      res.status = 400;
      res.set_content(R"({"error":"invalid json"})", "application/json");
      return;
    }
    // TODO: this draft copies the caller's state string onto the ticket, has no allowed-transition
    // table, lets any caller edit any ticket by id, has no reopen window, and logs the subject and
    // the body text. Review all five before this serves a real tenant.
    if (!body.contains("id")) {
      json ticket = {
          {"id", uuidString()},
          {"requester_id", requesterId},
          {"subject", body.value("subject", std::string())},
          {"state", body.value("state", std::string("open"))},
      };
      store.add(ticket);
      std::cerr << "ticket created requester=" << requesterId << " subject=" << ticket["subject"]
                << " body=" << body.value("body", std::string()) << "\\n";
      res.status = 201;
      res.set_content(ticket.dump(), "application/json");
      return;
    }
    const auto ticketId = body.value("id", std::string());
    auto stored = store.get(ticketId);
    (*stored)["state"] = body.value("state", std::string());
    store.put(ticketId, *stored);
    res.status = 200;
    res.set_content(stored->dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <algorithm>
#include <chrono>
#include <iostream>
#include <map>
#include <optional>
#include <set>
#include <string>
#include <vector>

using json = nlohmann::json;

constexpr int64_t kReopenWindowSeconds = 7 * 24 * 3600;
const std::set<std::string> kStates = {"open", "pending", "resolved", "closed"};
const std::set<std::string> kRoles = {"requester", "agent"};
const std::map<std::string, std::vector<std::string>> kAllowedTransitions = {
    {"open", {"pending", "resolved"}},
    {"pending", {"resolved", "open"}},
    {"resolved", {"closed", "open"}},
    {"closed", {"open"}},
};

struct TicketStore {
  void add(const json& ticket);
  std::optional<json> get(const std::string& ticketId);
  void put(const std::string& ticketId, const json& ticket);
};

TicketStore store;
std::string uuidString();

void writeJSON(httplib::Response& res, int status, const json& payload) {
  res.status = status;
  res.set_content(payload.dump(), "application/json");
}

/** Where this ticket may move now: the table, minus a reopen that is past its window. */
std::vector<std::string> allowedNext(const std::string& state, const std::optional<int64_t>& closedAt, int64_t now) {
  if (state != "closed") return kAllowedTransitions.at(state);
  if (closedAt.has_value() && now - *closedAt <= kReopenWindowSeconds) return kAllowedTransitions.at("closed");
  return {};
}

int main() {
  httplib::Server svr;

  svr.Post("/v1/tickets", [](const httplib::Request& req, httplib::Response& res) {
    const auto requesterId = req.get_header_value("X-Requester-Id");
    if (requesterId.empty()) {
      writeJSON(res, 401, {{"error", "missing X-Requester-Id"}});
      return;
    }
    const auto role = req.get_header_value("X-Actor-Role");
    if (kRoles.count(role) == 0) {
      writeJSON(res, 403, {{"error", "X-Actor-Role must be requester or agent"}});
      return;
    }
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) {
      writeJSON(res, 400, {{"error", "invalid json"}});
      return;
    }

    if (!body.contains("id")) {
      const auto subject = body.value("subject", std::string());
      if (subject.empty()) {
        writeJSON(res, 400, {{"error", "subject is required on create"}});
        return;
      }
      json ticket = {
          {"id", uuidString()},
          {"requester_id", requesterId},
          {"subject", subject},
          {"state", "open"},
          {"closed_at", nullptr},
      };
      store.add(ticket);
      std::cerr << "ticket created ticket_id=" << ticket["id"].get<std::string>() << " requester=" << requesterId
                << "\\n";
      writeJSON(res, 201, ticket);
      return;
    }

    const auto ticketId = body.value("id", std::string());
    auto stored = store.get(ticketId);
    if (!stored.has_value()) {
      writeJSON(res, 404, {{"error", "unknown ticket"}});
      return;
    }
    json ticket = *stored;
    if (role == "requester" && ticket["requester_id"].get<std::string>() != requesterId) {
      writeJSON(res, 403, {{"error", "this ticket belongs to another requester"}});
      return;
    }
    const auto state = body.value("state", std::string());
    if (kStates.count(state) == 0) {
      writeJSON(res, 400, {{"error", "unknown state"}});
      return;
    }

    const auto now = std::chrono::duration_cast<std::chrono::seconds>(
                         std::chrono::system_clock::now().time_since_epoch())
                         .count();
    std::optional<int64_t> closedAt;
    if (ticket.contains("closed_at") && !ticket["closed_at"].is_null())
      closedAt = ticket["closed_at"].get<int64_t>();
    const auto allowed = allowedNext(ticket["state"].get<std::string>(), closedAt, now);
    if (std::find(allowed.begin(), allowed.end(), state) == allowed.end()) {
      writeJSON(res, 409, {{"error", "illegal transition"}, {"from", ticket["state"]}, {"allowed", allowed}});
      return;
    }

    ticket["state"] = state;
    ticket["closed_at"] = state == "closed" ? json(now) : json(nullptr);
    store.put(ticketId, ticket);
    std::cerr << "ticket updated ticket_id=" << ticketId << " requester=" << requesterId << " role=" << role
              << " state=" << state << "\\n";
    writeJSON(res, 200, ticket);
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  hints: [
    'Guard order: requester header (401), role header (403), then the body. Every guard is cheap and returns before the store is touched, and a missing role never falls back to `agent`.',
    'Make the machine data: `ALLOWED_TRANSITIONS[from]` is the set of legal `to` states, the handler compares the requested state against that set, answers **409** with `allowed` when it is missing, and stores the state the table approved — never the string the caller sent.',
    'Ownership is a field on the ticket, not a header: `requester` means `ticket.requester_id == X-Requester-Id`. The reopen window reads the ticket’s own `closed_at` against the clock, so a stale `closed` ticket refuses `open` with an empty allowed set.',
  ],
  debrief: `The interviewer is testing whether you can review a generated handler against a state machine instead of against a schema. The draft is believable because the demo only ever creates tickets and sets \`open\`; the flaws appear the moment a caller sends \`closed\`, sends someone else's ticket id, or returns to a ticket that was closed last year. Four review habits are being checked: transitions are data, not strings copied from the body (so the state machine lives in one table the handler consults, and the 409 answers with the legal moves); authorization is per record, not per session (the role header says what kind of actor you are, the ticket says whether it is yours); time-bound rules need both a clock and a stored timestamp, so reopening has an expiry the handler can evaluate; and support content is customer content, so logs carry ids and states only.

What candidates miss is usually the last two. They guard the transition table but treat reopen as just another edge, so nothing ages out and a closed ticket can be resurrected forever. And they add a \`log.info\` with the subject while debugging the create path, which then ships the customer's message into every log sink on every write — the one line in the diff that a security review will catch and the demo never will.

Real systems go one step further: the table and the window move into a single \`transition(ticket, to, actor, now)\` function shared by the HTTP handler, the queue consumer and the admin console, so no entry point can skip the rule, and the handler answers \`allowed\` from that same function instead of re-deriving it.`,
};
