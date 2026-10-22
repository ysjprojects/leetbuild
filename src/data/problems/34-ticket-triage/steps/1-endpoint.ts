import type {Step} from '@/lib/types';

export const triageEndpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/tickets/triage: the caller does not pick its own queue',
  concept: 'http',
  file: 'api',
  focus: ['client', 'triage', 'db', 'redis'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it registers the route, parses
the body and returns a routing decision. It compiles, it serves the demo, and it hides three
production flaws. Review it like the service owner, fix it, and prove the fix with the checks below.

Implement \`POST /v1/tickets/triage\` with body \`{"text": "…", "priority": "…", "queue": "…"}\`.

- The tenant comes from the authenticated \`X-Tenant-Id\` header; a missing tenant is **401**.
- \`text\` is a non-empty string of at most **32 KiB** (\`1 << 15\` bytes) of UTF-8; a larger ticket
  is **413** *before* any classification work, and a missing or empty \`text\` is **400**.
- \`priority\` and \`queue\` are accepted for wire compatibility and **ignored**: the queue, the
  priority and the extracted fields are chosen server-side from the ticket text. Never echo a
  caller-supplied \`queue\` or \`priority\` into the routing decision — the caller describes the
  problem, triage decides where it goes.
- The ticket is hashed (\`sha256(text)\` truncated to 32 hex characters) and looked up as
  \`(tenant, ticket_hash)\`. A replayed \`Idempotency-Key\` for the same ticket returns the stored
  routing with **200** instead of re-triaging.
- \`Idempotency-Key\` is required (**400** when missing).
- Log the decision with tenant, queue, priority and hash — never the ticket text.

**Failure mode the checks target.** Trusting \`priority\` and \`queue\` from the body lets an angry
customer self-assign \`critical\` and jump the human queue; skipping the size cap turns one pasted
stack trace into unbounded classifier work; and an endpoint with no idempotency key re-triages the
same ticket on every webhook retry, minting duplicate routings. The ticket text in the log line is
the quiet one: it ships customer content into the log pipeline on every request.`,
  sequence: {
    participants: ['Support client', 'triage-api', 'routing store'],
    messages: [
      {
        from: 'Support client',
        to: 'triage-api',
        label: 'POST /v1/tickets/triage · X-Tenant-Id · Idempotency-Key',
        kind: 'sync',
      },
      {from: 'triage-api', to: 'triage-api', label: 'cap text at 32 KiB · hash the ticket', kind: 'sync'},
      {from: 'triage-api', to: 'routing store', label: 'get(tenant, ticket_hash)', kind: 'sync'},
      {from: 'routing store', to: 'triage-api', label: 'stored routing / none', kind: 'reply'},
      {
        from: 'triage-api',
        to: 'triage-api',
        label: 'derive queue · priority · fields from the text',
        kind: 'sync',
      },
      {from: 'triage-api', to: 'routing store', label: 'put(tenant, ticket_hash, routing)', kind: 'async'},
      {from: 'triage-api', to: 'Support client', label: '200 {ticket_id, queue, priority, fields}', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Handles POST /v1/tickets/triage',
      detail: 'Register the triage route on `POST /v1/tickets/triage`.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/tickets\/triage["']/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/tickets\/triage['"]/]},
        go: {all: [/HandleFunc\(\s*"POST \/v1\/tickets\/triage"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"tickets"\s*\/\s*"triage"\s*\)/, /\bpost\s*\{/]},
        cpp: {all: [/svr\.Post\(\s*"\/v1\/tickets\/triage"/]},
      },
    },
    {
      id: 'text-cap',
      title: 'Rejects a text over 32 KiB before classifying',
      detail:
        'The ticket text is capped at `1 << 15` bytes with **413**, and a missing or empty `text` is **400**, both before any classification call. The draft reads the text straight into the classifier, so one pasted stack trace costs whatever the classifier charges.',
      match: {
        python: {
          all: [/MAX_TEXT_BYTES/, /status_code\s*=\s*413/, /status_code\s*=\s*400/],
          order: [/MAX_TEXT_BYTES/, /derive_queue\(/],
        },
        typescript: {
          all: [/MAX_TEXT_BYTES/, /code\(\s*413\s*\)/, /code\(\s*400\s*\)/],
          order: [/MAX_TEXT_BYTES/, /deriveQueue\(/],
        },
        go: {
          all: [/maxTextBytes/, /StatusRequestEntityTooLarge/, /StatusBadRequest/],
          order: [/maxTextBytes/, /deriveQueue\(/],
        },
        scala: {
          all: [/MaxTextBytes/, /StatusCodes\.RequestEntityTooLarge/, /StatusCodes\.BadRequest/],
          order: [/MaxTextBytes/, /deriveQueue\(/],
        },
        cpp: {
          all: [/kMaxTextBytes/, /status\s*=\s*413/, /status\s*=\s*400/],
          order: [/kMaxTextBytes/, /deriveQueue\(/],
        },
      },
    },
    {
      id: 'server-side-routing',
      title: 'Chooses queue, priority and fields server-side',
      detail:
        'The queue and priority come from the ticket text through the server-side derivation, and the body’s `priority`/`queue` are never read. The draft uses `body.priority` and `body.queue` when present, so a caller routes itself.',
      match: {
        python: {
          all: [/PRIORITIES/, /derive_queue\(/, /derive_priority\(/, /extract_fields\(/],
          none: [/body\.priority/, /body\.queue/],
        },
        typescript: {
          all: [/PRIORITIES/, /deriveQueue\(/, /derivePriority\(/, /extractFields\(/],
          none: [/body\.priority/, /body\.queue/],
        },
        go: {
          all: [/priorities/, /deriveQueue\(/, /derivePriority\(/, /extractFields\(/],
          none: [/body\.Priority/, /body\.Queue/],
        },
        scala: {
          all: [/Priorities/, /deriveQueue\(/, /derivePriority\(/, /extractFields\(/],
          none: [/body\.priority/, /body\.queue/],
        },
        cpp: {
          all: [/kPriorities/, /deriveQueue\(/, /derivePriority\(/, /extractFields\(/],
          none: [/value\(\s*"priority"/, /value\(\s*"queue"/],
        },
      },
    },
    {
      id: 'idempotency-key',
      title: 'Keys a replay by (tenant, ticket hash)',
      detail:
        '`Idempotency-Key` is required and the routing is stored under `(tenant, ticket_hash)`; a replay returns the stored routing instead of triaging twice. The draft ignores the header entirely, so every webhook retry mints a new routing.',
      match: {
        python: {all: [/Idempotency-Key/, /ticket_hash/, /store\.get\(/, /store\.put\(/]},
        typescript: {all: [/idempotency-key/, /ticketHash/, /store\.get\(/, /store\.put\(/]},
        go: {all: [/Idempotency-Key/, /ticketHash/, /store\.Get\(/, /store\.Put\(/]},
        scala: {all: [/Idempotency-Key/, /ticketHash/, /store\.get\(/, /store\.put\(/]},
        cpp: {all: [/Idempotency-Key/, /ticketHash/, /store\.get\(/, /store\.put\(/]},
      },
    },
    {
      id: 'no-ticket-log',
      title: 'Logs the decision, never the ticket text',
      detail:
        'The routing decision is logged with tenant, queue, priority and hash; the ticket text never reaches a log line. The draft logs `text` on every request.',
      match: {
        python: {all: [/logger\.info\(/], none: [/logger\.\w+\([^)]*text/]},
        typescript: {all: [/\.log\.info\(/], none: [/log\.\w+\([^)]*text/]},
        go: {all: [/log\.Printf\(/], none: [/log\.\w+\([^)]*[Tt]ext/]},
        scala: {all: [/log\.info\(/], none: [/log\.info\([^)]*text/]},
        cpp: {all: [/(std::)?(cerr|clog)\s*<</], none: [/(std::)?(cerr|clog)[^;]*text/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import logging

from fastapi import FastAPI, Header
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()
logger = logging.getLogger("triage")


class TriageRequest(BaseModel):
    text: str
    priority: str | None = None
    queue: str | None = None


class RoutingStore:
    def get(self, tenant: str, ticket_hash: str) -> dict | None:
        """The routing stored for (tenant, ticket hash), if any."""
        raise NotImplementedError

    def put(self, tenant: str, ticket_hash: str, routing: dict) -> None:
        """Store the routing under (tenant, ticket hash)."""
        raise NotImplementedError


store = RoutingStore()

QUEUES = ("billing", "delivery", "account", "general")
PRIORITIES = ("low", "normal", "high", "critical")
KEYWORDS = {
    "billing": ("invoice", "refund", "charge", "payment"),
    "delivery": ("shipment", "delivery", "tracking", "parcel"),
    "account": ("password", "login", "locked", "sign-in"),
}
URGENT = ("outage", "down", "data loss", "breach")


def derive_queue(text: str) -> str:
    lowered = text.lower()
    for queue, words in KEYWORDS.items():
        if any(word in lowered for word in words):
            return queue
    return "general"


def derive_priority(text: str) -> str:
    return "critical" if any(word in text.lower() for word in URGENT) else "normal"


def extract_fields(text: str) -> dict:
    return {"subject": text.splitlines()[0][:120]}


@app.post("/v1/tickets/triage")
def triage(body: TriageRequest, tenant: str = Header(alias="X-Tenant-Id")) -> JSONResponse:
    # TODO: this draft trusts the caller's priority and queue, never checks the 32 KiB cap, and
    # has no Idempotency-Key, so every retry re-triages the ticket. It also logs the text.
    queue = body.queue or "general"
    priority = body.priority or "normal"
    logger.info("triage tenant=%s queue=%s text=%r", tenant, queue, body.text)
    return JSONResponse(
        {"queue": queue, "priority": priority, "fields": extract_fields(body.text)}, status_code=200
    )
`,
      solution: `import hashlib
import logging
import uuid

from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()
logger = logging.getLogger("triage")

MAX_TEXT_BYTES = 1 << 15
KEYWORDS = {
    "billing": ("invoice", "refund", "charge", "payment"),
    "delivery": ("shipment", "delivery", "tracking", "parcel"),
    "account": ("password", "login", "locked", "sign-in"),
}
URGENT = ("outage", "down", "data loss", "breach")
PRIORITIES = ("low", "normal", "high", "critical")
QUEUES = ("billing", "delivery", "account", "general")


class TriageRequest(BaseModel):
    """Priority and queue are accepted for wire compatibility and deliberately ignored."""

    text: str
    priority: str | None = None
    queue: str | None = None


class RoutingStore:
    def get(self, tenant: str, ticket_hash: str) -> dict | None:
        """The routing stored for (tenant, ticket hash), if any."""
        raise NotImplementedError

    def put(self, tenant: str, ticket_hash: str, routing: dict) -> None:
        """Store the routing under (tenant, ticket hash)."""
        raise NotImplementedError


store = RoutingStore()


def derive_queue(text: str) -> str:
    lowered = text.lower()
    for queue, words in KEYWORDS.items():
        if any(word in lowered for word in words):
            return queue
    return "general"


def derive_priority(text: str) -> str:
    return "critical" if any(word in text.lower() for word in URGENT) else "normal"


def extract_fields(text: str) -> dict:
    order = next((word for word in text.split() if word.startswith("INC-")), None)
    return {"subject": text.splitlines()[0][:120], "order": order}


@app.post("/v1/tickets/triage")
def triage(
    body: TriageRequest,
    tenant: str | None = Header(default=None, alias="X-Tenant-Id"),
    idem_key: str | None = Header(default=None, alias="Idempotency-Key"),
) -> JSONResponse:
    if tenant is None or tenant == "":
        raise HTTPException(status_code=401, detail="missing X-Tenant-Id")
    if idem_key is None or idem_key == "":
        raise HTTPException(status_code=400, detail="Idempotency-Key is required")
    if body.text == "":
        raise HTTPException(status_code=400, detail="text must be a non-empty string")
    if len(body.text.encode("utf-8")) > MAX_TEXT_BYTES:
        raise HTTPException(status_code=413, detail="text exceeds 32 KiB")

    ticket_hash = hashlib.sha256(body.text.encode("utf-8")).hexdigest()[:32]
    stored = store.get(tenant, ticket_hash)
    if stored is not None:
        return JSONResponse(stored, status_code=200)

    routing = {
        "ticket_id": str(uuid.uuid4()),
        "ticket_hash": ticket_hash,
        "queue": derive_queue(body.text),
        "priority": derive_priority(body.text),
        "fields": extract_fields(body.text),
        "idempotency_key": idem_key,
    }
    store.put(tenant, ticket_hash, routing)
    logger.info(
        "triage tenant=%s queue=%s priority=%s hash=%s",
        tenant,
        routing["queue"],
        routing["priority"],
        ticket_hash,
    )
    return JSONResponse(routing, status_code=200)
`,
    },
    typescript: {
      starter: `/** POST /v1/tickets/triage: a model-generated draft that lets callers route themselves. */
import Fastify from 'fastify';

export const app = Fastify();

interface TriageBody {
  text: string;
  priority?: string;
  queue?: string;
}

const KEYWORDS: Record<string, string[]> = {
  billing: ['invoice', 'refund', 'charge', 'payment'],
  delivery: ['shipment', 'delivery', 'tracking', 'parcel'],
  account: ['password', 'login', 'locked', 'sign-in'],
};

function deriveQueue(text: string): string {
  const lowered = text.toLowerCase();
  for (const [queue, words] of Object.entries(KEYWORDS)) if (words.some(w => lowered.includes(w))) return queue;
  return 'general';
}

function derivePriority(text: string): string {
  return ['outage', 'down', 'data loss', 'breach'].some(w => text.toLowerCase().includes(w)) ? 'critical' : 'normal';
}

function extractFields(text: string): Record<string, string> {
  return {subject: text.split('\\n')[0].slice(0, 120)};
}

app.post('/v1/tickets/triage', async (request, reply) => {
  // TODO: this draft trusts the caller's priority and queue, never checks the 32 KiB cap, and has
  // no Idempotency-Key, so every retry re-triages the ticket. It also logs the text.
  const tenant = request.headers['x-tenant-id'] as string;
  const body = request.body as TriageBody;
  const queue = body.queue !== undefined && body.queue !== '' ? body.queue : deriveQueue(body.text);
  const priority = body.priority !== undefined && body.priority !== '' ? body.priority : derivePriority(body.text);
  request.log.info({tenant, queue, text: body.text}, 'triaged');
  return reply.code(200).send({queue, priority, fields: extractFields(body.text)});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** POST /v1/tickets/triage: the queue and priority are chosen server-side. */
import {createHash, randomUUID} from 'node:crypto';

import Fastify from 'fastify';

export const app = Fastify();

const MAX_TEXT_BYTES = 1 << 15;
const PRIORITIES = ['low', 'normal', 'high', 'critical'];
const QUEUES = ['billing', 'delivery', 'account', 'general'];
const KEYWORDS: Record<string, string[]> = {
  billing: ['invoice', 'refund', 'charge', 'payment'],
  delivery: ['shipment', 'delivery', 'tracking', 'parcel'],
  account: ['password', 'login', 'locked', 'sign-in'],
};

interface TriageBody {
  text: string;
  /** Accepted for wire compatibility and ignored: callers do not route themselves. */
  priority?: string;
  queue?: string;
}

interface Routing {
  ticket_id: string;
  ticket_hash: string;
  queue: string;
  priority: string;
  fields: Record<string, string>;
}

class RoutingStore {
  async get(tenant: string, ticketHash: string): Promise<Routing | null> {
    throw new Error('routing store not configured');
  }

  async put(tenant: string, ticketHash: string, routing: Routing): Promise<void> {
    throw new Error('routing store not configured');
  }
}

const store = new RoutingStore();

function deriveQueue(text: string): string {
  const lowered = text.toLowerCase();
  for (const [queue, words] of Object.entries(KEYWORDS)) if (words.some(w => lowered.includes(w))) return queue;
  return 'general';
}

function derivePriority(text: string): string {
  return ['outage', 'down', 'data loss', 'breach'].some(w => text.toLowerCase().includes(w)) ? 'critical' : 'normal';
}

function extractFields(text: string): Record<string, string> {
  const order = text.split(/\\s+/).find(word => word.startsWith('INC-'));
  return {subject: text.split('\\n')[0].slice(0, 120), ...(order === undefined ? {} : {order})};
}

app.post('/v1/tickets/triage', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing X-Tenant-Id'});
  const idemKey = request.headers['idempotency-key'];
  if (typeof idemKey !== 'string' || idemKey === '')
    return reply.code(400).send({error: 'Idempotency-Key is required'});

  const body = request.body as Partial<TriageBody> | null;
  if (body === null || typeof body !== 'object' || typeof body.text !== 'string' || body.text === '')
    return reply.code(400).send({error: 'text must be a non-empty string'});
  if (Buffer.byteLength(body.text, 'utf8') > MAX_TEXT_BYTES)
    return reply.code(413).send({error: 'text exceeds 32 KiB'});

  const ticketHash = createHash('sha256').update(body.text, 'utf8').digest('hex').slice(0, 32);
  const stored = await store.get(tenant, ticketHash);
  if (stored !== null) return reply.code(200).send(stored);

  const routing: Routing = {
    ticket_id: randomUUID(),
    ticket_hash: ticketHash,
    queue: deriveQueue(body.text),
    priority: derivePriority(body.text),
    fields: extractFields(body.text),
  };
  await store.put(tenant, ticketHash, routing);
  request.log.info({tenant, queue: routing.queue, priority: routing.priority, hash: ticketHash}, 'triaged');
  return reply.code(200).send(routing);
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
	"strings"
)

type TriageRequest struct {
	Text     string \`json:"text"\`
	Priority string \`json:"priority"\`
	Queue    string \`json:"queue"\`
}

var keywords = map[string][]string{
	"billing":  {"invoice", "refund", "charge", "payment"},
	"delivery": {"shipment", "delivery", "tracking", "parcel"},
	"account":  {"password", "login", "locked", "sign-in"},
}

func deriveQueue(text string) string {
	lowered := strings.ToLower(text)
	for queue, words := range keywords {
		for _, word := range words {
			if strings.Contains(lowered, word) {
				return queue
			}
		}
	}
	return "general"
}

func derivePriority(text string) string {
	lowered := strings.ToLower(text)
	for _, word := range []string{"outage", "down", "data loss", "breach"} {
		if strings.Contains(lowered, word) {
			return "critical"
		}
	}
	return "normal"
}

func extractFields(text string) map[string]string {
	return map[string]string{"subject": text}
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func triage(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	var body TriageRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	// TODO: this draft trusts the caller's priority and queue, never checks the 32 KiB cap, and has
	// no Idempotency-Key, so every retry re-triages the ticket. It also logs the text.
	queue := body.Queue
	if queue == "" {
		queue = deriveQueue(body.Text)
	}
	priority := body.Priority
	if priority == "" {
		priority = derivePriority(body.Text)
	}
	log.Printf("triage tenant=%s queue=%s text=%q", tenant, queue, body.Text)
	writeJSON(rw, http.StatusOK, map[string]any{"queue": queue, "priority": priority, "fields": extractFields(body.Text)})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/tickets/triage", triage)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
      solution: `package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"log"
	"net/http"
	"strings"

	"github.com/google/uuid"
)

const maxTextBytes = 1 << 15

var priorities = []string{"low", "normal", "high", "critical"}

var keywords = map[string][]string{
	"billing":  {"invoice", "refund", "charge", "payment"},
	"delivery": {"shipment", "delivery", "tracking", "parcel"},
	"account":  {"password", "login", "locked", "sign-in"},
}

type TriageRequest struct {
	Text string \`json:"text"\`
	// Priority and Queue are accepted for wire compatibility and deliberately ignored.
	Priority string \`json:"priority"\`
	Queue    string \`json:"queue"\`
}

type RoutingStore struct{}

func (s *RoutingStore) Get(tenant, ticketHash string) (map[string]any, error) {
	return nil, nil
}

func (s *RoutingStore) Put(tenant, ticketHash string, routing map[string]any) error {
	return nil
}

var store = &RoutingStore{}

func deriveQueue(text string) string {
	lowered := strings.ToLower(text)
	for queue, words := range keywords {
		for _, word := range words {
			if strings.Contains(lowered, word) {
				return queue
			}
		}
	}
	return "general"
}

func derivePriority(text string) string {
	lowered := strings.ToLower(text)
	for _, word := range []string{"outage", "down", "data loss", "breach"} {
		if strings.Contains(lowered, word) {
			return "critical"
		}
	}
	return "normal"
}

func extractFields(text string) map[string]string {
	fields := map[string]string{"subject": strings.SplitN(text, "\n", 2)[0]}
	for _, word := range strings.Fields(text) {
		if strings.HasPrefix(word, "INC-") {
			fields["order"] = word
		}
	}
	return fields
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func triage(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-Tenant-Id"})
		return
	}
	idemKey := r.Header.Get("Idempotency-Key")
	if idemKey == "" {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "Idempotency-Key is required"})
		return
	}
	var body TriageRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	if body.Text == "" {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "text must be a non-empty string"})
		return
	}
	if len([]byte(body.Text)) > maxTextBytes {
		writeJSON(rw, http.StatusRequestEntityTooLarge, map[string]string{"error": "text exceeds 32 KiB"})
		return
	}
	sum := sha256.Sum256([]byte(body.Text))
	ticketHash := hex.EncodeToString(sum[:])[:32]
	stored, err := store.Get(tenant, ticketHash)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	if stored != nil {
		writeJSON(rw, http.StatusOK, stored)
		return
	}
	routing := map[string]any{
		"ticket_id":       uuid.NewString(),
		"ticket_hash":     ticketHash,
		"queue":           deriveQueue(body.Text),
		"priority":        derivePriority(body.Text),
		"fields":          extractFields(body.Text),
		"idempotency_key": idemKey,
	}
	if err := store.Put(tenant, ticketHash, routing); err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	log.Printf("triage tenant=%s queue=%s priority=%s hash=%s", tenant, routing["queue"], routing["priority"], ticketHash)
	writeJSON(rw, http.StatusOK, routing)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/tickets/triage", triage)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class TriageRequest(text: String, priority: String, queue: String)
final case class Routing(ticket_id: String, queue: String, priority: String)

object TriageApi {
  implicit val system: ActorSystem = ActorSystem("ticket-triage")
  implicit val requestFormat: RootJsonFormat[TriageRequest] = jsonFormat3(TriageRequest)

  val Keywords = Map(
    "billing" -> Seq("invoice", "refund", "charge", "payment"),
    "delivery" -> Seq("shipment", "delivery", "tracking", "parcel"),
    "account" -> Seq("password", "login", "locked", "sign-in")
  )
  val Urgent = Seq("outage", "down", "data loss", "breach")

  def deriveQueue(text: String): String =
    Keywords.collectFirst { case (queue, words) if words.exists(text.toLowerCase.contains) => queue }
      .getOrElse("general")

  def derivePriority(text: String): String =
    if (Urgent.exists(text.toLowerCase.contains)) "critical" else "normal"

  def extractFields(text: String): Map[String, String] = Map("subject" -> text.take(120))

  val route: Route =
    path("v1" / "tickets" / "triage") {
      post {
        headerValueByName("X-Tenant-Id") { tenant =>
          entity(as[TriageRequest]) { body =>
            // TODO: this draft trusts the caller's priority and queue, never checks the 32 KiB cap,
            // and has no Idempotency-Key, so every retry re-triages the ticket. It logs the text.
            val queue = if (body.queue.nonEmpty) body.queue else deriveQueue(body.text)
            val priority = if (body.priority.nonEmpty) body.priority else derivePriority(body.text)
            system.log.info(s"triage tenant=$tenant queue=$queue text=\${body.text}")
            complete(StatusCodes.OK, s"""{"queue":"$queue","priority":"$priority"}""")
          }
        }
      }
    }

  def main(args: Array[String]): Unit = {
    Http().newServerAt("0.0.0.0", 8443).bind(route)
  }
}
`,
      solution: `import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.util.UUID

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class TriageRequest(text: String, priority: Option[String], queue: Option[String])
final case class Routing(ticket_id: String, ticket_hash: String, queue: String, priority: String)

object TriageApi {
  implicit val system: ActorSystem = ActorSystem("ticket-triage")
  implicit val requestFormat: RootJsonFormat[TriageRequest] = jsonFormat3(TriageRequest)

  val MaxTextBytes = 1 << 15
  val Priorities = Seq("low", "normal", "high", "critical")
  val Queues = Seq("billing", "delivery", "account", "general")
  val Keywords = Map(
    "billing" -> Seq("invoice", "refund", "charge", "payment"),
    "delivery" -> Seq("shipment", "delivery", "tracking", "parcel"),
    "account" -> Seq("password", "login", "locked", "sign-in")
  )
  val Urgent = Seq("outage", "down", "data loss", "breach")

  def deriveQueue(text: String): String =
    Keywords.collectFirst { case (queue, words) if words.exists(text.toLowerCase.contains) => queue }
      .getOrElse("general")

  def derivePriority(text: String): String =
    if (Urgent.exists(text.toLowerCase.contains)) "critical" else "normal"

  def extractFields(text: String): Map[String, String] =
    Map("subject" -> text.take(120), "order" -> text.split("\\\\s+").find(_.startsWith("INC-")).getOrElse(""))

  def ticketHash(text: String): String =
    MessageDigest.getInstance("SHA-256").digest(text.getBytes(StandardCharsets.UTF_8)).take(16).map("%02x".format(_)).mkString

  val store = RoutingStore.open()

  val route: Route =
    path("v1" / "tickets" / "triage") {
      post {
        optionalHeaderValueByName("X-Tenant-Id") { tenantOpt =>
          optionalHeaderValueByName("Idempotency-Key") { idemOpt =>
            entity(as[TriageRequest]) { body =>
              if (!tenantOpt.exists(_.nonEmpty)) {
                complete(StatusCodes.Unauthorized, """{"error":"missing X-Tenant-Id"}""")
              } else if (!idemOpt.exists(_.nonEmpty)) {
                complete(StatusCodes.BadRequest, """{"error":"Idempotency-Key is required"}""")
              } else if (body.text.isEmpty) {
                complete(StatusCodes.BadRequest, """{"error":"text must be a non-empty string"}""")
              } else if (body.text.getBytes(StandardCharsets.UTF_8).length > MaxTextBytes) {
                complete(StatusCodes.RequestEntityTooLarge, """{"error":"text exceeds 32 KiB"}""")
              } else {
                val tenant = tenantOpt.get
                val hash = ticketHash(body.text)
                store.get(tenant, hash) match {
                  case Some(stored) =>
                    complete(StatusCodes.OK, stored)
                  case None =>
                    val routing = Routing(
                      UUID.randomUUID().toString,
                      hash,
                      deriveQueue(body.text),
                      derivePriority(body.text)
                    )
                    store.put(tenant, hash, routing)
                    system.log.info(s"triage tenant=$tenant queue=\${routing.queue} priority=\${routing.priority} hash=$hash")
                    complete(StatusCodes.OK, routing)
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
#include <map>
#include <string>
#include <vector>

using json = nlohmann::json;

const std::map<std::string, std::vector<std::string>> kKeywords = {
    {"billing", {"invoice", "refund", "charge", "payment"}},
    {"delivery", {"shipment", "delivery", "tracking", "parcel"}},
    {"account", {"password", "login", "locked", "sign-in"}},
};

std::string lower(const std::string& text) {
  std::string out = text;
  for (char& c : out) c = static_cast<char>(std::tolower(c));
  return out;
}

std::string deriveQueue(const std::string& text) {
  const auto lowered = lower(text);
  for (const auto& [queue, words] : kKeywords)
    for (const auto& word : words)
      if (lowered.find(word) != std::string::npos) return queue;
  return "general";
}

std::string derivePriority(const std::string& text) {
  const auto lowered = lower(text);
  for (const auto& word : {"outage", "down", "data loss", "breach"})
    if (lowered.find(word) != std::string::npos) return "critical";
  return "normal";
}

std::map<std::string, std::string> extractFields(const std::string& text) {
  return {{"subject", text.substr(0, 120)}};
}

int main() {
  httplib::Server svr;

  svr.Post("/v1/tickets/triage", [](const httplib::Request& req, httplib::Response& res) {
    const auto tenant = req.get_header_value("X-Tenant-Id");
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) {
      res.status = 400;
      res.set_content(R"({"error":"invalid json"})", "application/json");
      return;
    }
    // TODO: this draft trusts the caller's priority and queue, never checks the 32 KiB cap, and has
    // no Idempotency-Key, so every retry re-triages the ticket. It also logs the text.
    const auto text = body.value("text", std::string());
    const auto queue = body.value("queue", deriveQueue(text));
    const auto priority = body.value("priority", derivePriority(text));
    std::cerr << "triage tenant=" << tenant << " text=" << text << "\\n";
    res.status = 200;
    res.set_content(json{{"queue", queue}, {"priority", priority}}.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <algorithm>
#include <cctype>
#include <iostream>
#include <map>
#include <set>
#include <string>
#include <vector>

using json = nlohmann::json;

constexpr std::size_t kMaxTextBytes = 1 << 15;
const std::vector<std::string> kPriorities = {"low", "normal", "high", "critical"};
const std::vector<std::string> kQueues = {"billing", "delivery", "account", "general"};
const std::map<std::string, std::vector<std::string>> kKeywords = {
    {"billing", {"invoice", "refund", "charge", "payment"}},
    {"delivery", {"shipment", "delivery", "tracking", "parcel"}},
    {"account", {"password", "login", "locked", "sign-in"}},
};

struct RoutingStore {
  std::optional<json> get(const std::string& tenant, const std::string& ticketHash);
  void put(const std::string& tenant, const std::string& ticketHash, const json& routing);
};

RoutingStore store;
std::string sha256Hex(const std::string& text);
std::string uuidString();

std::string lower(const std::string& text) {
  std::string out = text;
  for (char& c : out) c = static_cast<char>(std::tolower(c));
  return out;
}

std::string deriveQueue(const std::string& text) {
  const auto lowered = lower(text);
  for (const auto& [queue, words] : kKeywords)
    for (const auto& word : words)
      if (lowered.find(word) != std::string::npos) return queue;
  return "general";
}

std::string derivePriority(const std::string& text) {
  const auto lowered = lower(text);
  for (const auto& word : {"outage", "down", "data loss", "breach"})
    if (lowered.find(word) != std::string::npos) return "critical";
  return "normal";
}

std::map<std::string, std::string> extractFields(const std::string& text) {
  return {{"subject", text.substr(0, 120)}};
}

int main() {
  httplib::Server svr;

  svr.Post("/v1/tickets/triage", [](const httplib::Request& req, httplib::Response& res) {
    const auto tenant = req.get_header_value("X-Tenant-Id");
    if (tenant.empty()) {
      res.status = 401;
      res.set_content(R"({"error":"missing X-Tenant-Id"})", "application/json");
      return;
    }
    const auto idemKey = req.get_header_value("Idempotency-Key");
    if (idemKey.empty()) {
      res.status = 400;
      res.set_content(R"({"error":"Idempotency-Key is required"})", "application/json");
      return;
    }
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object() || !body.contains("text") || !body["text"].is_string()) {
      res.status = 400;
      res.set_content(R"({"error":"text must be a non-empty string"})", "application/json");
      return;
    }
    const auto text = body["text"].get<std::string>();
    if (text.empty()) {
      res.status = 400;
      res.set_content(R"({"error":"text must be a non-empty string"})", "application/json");
      return;
    }
    if (text.size() > kMaxTextBytes) {
      res.status = 413;
      res.set_content(R"({"error":"text exceeds 32 KiB"})", "application/json");
      return;
    }
    const std::string ticketHash = sha256Hex(text).substr(0, 32);
    const auto stored = store.get(tenant, ticketHash);
    if (stored) {
      res.status = 200;
      res.set_content(stored->dump(), "application/json");
      return;
    }
    const json routing = {
        {"ticket_id", uuidString()},
        {"ticket_hash", ticketHash},
        {"queue", deriveQueue(text)},
        {"priority", derivePriority(text)},
        {"fields", extractFields(text)},
        {"idempotency_key", idemKey},
    };
    store.put(tenant, ticketHash, routing);
    std::cerr << "triage tenant=" << tenant << " queue=" << routing["queue"] << " priority=" << routing["priority"]
              << " hash=" << ticketHash << "\\n";
    res.status = 200;
    res.set_content(routing.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  hints: [
    'Write the guard clauses first, in cost order: tenant, Idempotency-Key, text shape, byte length, then the hash lookup. Every one of them returns before the classifier is touched, so a malformed ticket can never cost a model call.',
    'The routing decision is not a field you echo back — `derive_queue` and `derive_priority` take the ticket text only. Keeping `priority` and `queue` on the request model but never reading them is the point: the wire format stays compatible while the authority moves to the server.',
    'The log line is a contract: tenant, queue, priority, hash. The ticket text belongs to the customer; if you need it for debugging, log its length or its hash. `logger.info(..., body.text)` ships customer content into every log sink.',
  ],
  debrief: `The interviewer is testing whether you can review a generated handler at the trust boundary. The draft reads fine because the demo sends well-formed tickets from one tenant and never retries. Three defects are being checked: server-side routing (the caller describes the problem, triage picks the queue — a body-supplied \`priority: "critical"\` must never change where the ticket lands), a cheap input cap (32 KiB rejected with 413 before any expensive work), and idempotency keyed by the ticket hash so a webhook retry returns the original routing instead of minting a second one. The log line is the one candidates miss: ticket text is customer content and may never be logged verbatim. Real triage services add per-tenant queue overrides from config, a redacted text preview for agents, and a routing audit record that names the ruleset version.`,
};
