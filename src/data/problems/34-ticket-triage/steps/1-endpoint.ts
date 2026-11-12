import type {Step} from '@/lib/types';

export const triageEndpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/tickets/triage: the caller does not pick its own queue',
  concept: 'http',
  guides: ['request-boundaries', 'idempotent-requests'],
  file: 'api',
  focus: ['client', 'triage', 'rules', 'db'],
  task: `## Task

**Starting point.** The starter serves \`POST /v1/tickets/triage\` with body
\`{text, priority?, queue?}\`: it reads the tenant from \`X-Tenant-Id\` (401 without one), routes the
text with the provided ruleset (\`rules.rule_decision\`), mints a ticket id (\`store.new_ticket_id\`),
lets the body's \`queue\` and \`priority\` override the decision, records the answer under the
\`Idempotency-Key\` (\`store.save_decision\`) and returns \`{ticket_id, tenant, queue, priority,
confidence, fallback_reason, ruleset_version}\`. It serves the demo and hides three flaws.

**Failure mode the checks target.** A customer who sends \`"priority": "urgent"\` jumps the agents'
queue; one pasted log dump becomes a ticket every later stage pays for; and a webhook that retries
after a timeout files the same ticket twice.

- Queue and priority come from the text alone: \`priority\` and \`queue\` in the body are accepted
  and ignored.
- \`text\` is required and at most \`MAX_TEXT_BYTES\` = 32 KiB of UTF-8, counted in bytes: a blank
  one is **400**, a longer one **413**, both before a ticket id is minted.
- \`Idempotency-Key\` is required (**400**). Look \`(tenant, key)\` up with \`store.decision_for_key\`
  before triaging and answer the recorded routing on a replay; another tenant's key is another
  ticket.`,
  sequence: {
    participants: ['Support inbox', 'triage-api', 'Ruleset v3', 'routing store'],
    messages: [
      {
        from: 'Support inbox',
        to: 'triage-api',
        label: 'POST /v1/tickets/triage · X-Tenant-Id · Idempotency-Key',
        kind: 'sync',
      },
      {from: 'triage-api', to: 'triage-api', label: 'text blank → 400 · over 32 KiB → 413', kind: 'sync'},
      {from: 'triage-api', to: 'routing store', label: 'decision_for_key(tenant, key)', kind: 'sync'},
      {from: 'routing store', to: 'triage-api', label: 'recorded routing → answered as is', kind: 'reply'},
      {from: 'triage-api', to: 'Ruleset v3', label: 'rule_decision(text) · body priority ignored', kind: 'sync'},
      {
        from: 'triage-api',
        to: 'routing store',
        label: 'new_ticket_id · save_decision(tenant, key, routing)',
        kind: 'sync',
      },
      {
        from: 'triage-api',
        to: 'Support inbox',
        label: '200 {ticket_id, queue, priority, ruleset_version}',
        kind: 'reply',
      },
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Registers POST /v1/tickets/triage',
      detail:
        'Register `POST /v1/tickets/triage`; it answers a routing for an authenticated tenant and 401 without `X-Tenant-Id`.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/tickets\/triage["']/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/tickets\/triage['"]/]},
        go: {all: [/HandleFunc\(\s*"POST \/v1\/tickets\/triage"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"tickets"\s*\/\s*"triage"\s*\)/, /\bpost\b/]},
        cpp: {all: [/svr\.Post\(\s*"\/v1\/tickets\/triage"/]},
      },
    },
    {
      id: 'server-side-routing',
      title: 'Takes queue and priority from the text, not the body',
      detail:
        'The routing is the ruleset decision for the text (`rule_decision`/`ruleDecision`); nothing reads `priority` or `queue` from the request body, so a caller cannot route itself.',
      match: {
        python: {all: [/rules\.rule_decision\(/], none: [/body\.(priority|queue)\b/]},
        typescript: {all: [/ruleDecision\(/], none: [/body\.(priority|queue)\b/]},
        go: {all: [/rules\.RuleDecision\(/], none: [/body\.(Priority|Queue)\b/]},
        scala: {all: [/Rules\.ruleDecision\(/], none: [/body\.get\(\s*"(priority|queue)"\s*\)/]},
        cpp: {all: [/rules::ruleDecision\(/], none: [/value\(\s*"(priority|queue)"/]},
      },
    },
    {
      id: 'text-cap',
      title: 'Answers 400 for a blank text and 413 past 32 KiB, before any work',
      detail:
        'The text is measured in UTF-8 bytes against the 32 KiB cap (**413**) and a blank text is **400**, both before the ruleset runs and before a ticket id is minted.',
      match: {
        python: {all: [/\b413\b/, /\.encode\(/], order: [/>\s*MAX_TEXT_BYTES/, /rules\.rule_decision\(/]},
        typescript: {
          all: [/\b413\b/, /TextEncoder|Buffer\.byteLength/],
          order: [/>\s*MAX_TEXT_BYTES/, /ruleDecision\(/],
        },
        go: {all: [/StatusRequestEntityTooLarge|\b413\b/], order: [/>\s*maxTextBytes/, /rules\.RuleDecision\(/]},
        scala: {
          all: [/PayloadTooLarge|RequestEntityTooLarge|ContentTooLarge|\b413\b/, /getBytes/],
          order: [/>\s*MaxTextBytes/, /Rules\.ruleDecision\(/],
        },
        cpp: {all: [/\b413\b/], order: [/>\s*kMaxTextBytes/, /rules::ruleDecision\(/]},
      },
    },
    {
      id: 'idempotency-key',
      title: 'Answers a replayed Idempotency-Key with the recorded routing',
      detail:
        '`Idempotency-Key` is required (400) and `(tenant, key)` is looked up (`decision_for_key`/`decisionForKey`) before a ticket id is minted; a replay answers the recorded routing.',
      match: {
        python: {all: [/idempotency-key/i, /\b400\b/], order: [/store\.decision_for_key\(/, /store\.new_ticket_id\(/]},
        typescript: {all: [/idempotency-key/i, /\b400\b/], order: [/await decisionForKey\(/, /await newTicketId\(/]},
        go: {
          all: [/Idempotency-Key/i, /StatusBadRequest|\b400\b/],
          order: [/store\.DecisionForKey\(/, /store\.NewTicketID\(/],
        },
        scala: {
          all: [/Idempotency-Key/i, /BadRequest|\b400\b/],
          order: [/Store\.decisionForKey\(/, /Store\.newTicketId\(/],
        },
        cpp: {all: [/Idempotency-Key/i, /\b400\b/], order: [/store::decisionForKey\(/, /store::newTicketId\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `from fastapi import FastAPI, HTTPException, Request
from pydantic import BaseModel

from triage import rules  # rules.rule_decision(text)
from triage import store  # store.new_ticket_id, decision_for_key, save_decision

app = FastAPI()


class TriageRequest(BaseModel):
    text: str = ""
    priority: str | None = None
    queue: str | None = None


@app.post("/v1/tickets/triage")
def triage(body: TriageRequest, request: Request) -> dict:
    # TODO: this starter has three flaws. The task says where to look; the checks say what must change.
    tenant = request.headers.get("x-tenant-id", "")
    if not tenant:
        raise HTTPException(status_code=401, detail="X-Tenant-Id is required")
    routing = {"ticket_id": store.new_ticket_id(), "tenant": tenant, **rules.rule_decision(body.text)}
    if body.queue:
        routing["queue"] = body.queue
    if body.priority:
        routing["priority"] = body.priority
    store.save_decision(tenant, request.headers.get("idempotency-key", ""), routing)
    return routing
`,
      solution: `from fastapi import FastAPI, HTTPException, Request
from pydantic import BaseModel

from triage import rules  # rules.rule_decision(text)
from triage import store  # store.new_ticket_id, decision_for_key, save_decision

app = FastAPI()

MAX_TEXT_BYTES = 32 * 1024


class TriageRequest(BaseModel):
    """priority and queue are accepted for wire compatibility and ignored."""

    text: str = ""
    priority: str | None = None
    queue: str | None = None


@app.post("/v1/tickets/triage")
def triage(body: TriageRequest, request: Request) -> dict:
    tenant = request.headers.get("x-tenant-id", "")
    if not tenant:
        raise HTTPException(status_code=401, detail="X-Tenant-Id is required")
    key = request.headers.get("idempotency-key", "")
    if not key:
        raise HTTPException(status_code=400, detail="Idempotency-Key is required")
    if not body.text.strip():
        raise HTTPException(status_code=400, detail="text is required")
    if len(body.text.encode("utf-8")) > MAX_TEXT_BYTES:
        raise HTTPException(status_code=413, detail="text exceeds 32 KiB")
    recorded = store.decision_for_key(tenant, key)
    if recorded is not None:
        return recorded  # a webhook retry gets the routing the first delivery got
    routing = {"ticket_id": store.new_ticket_id(), "tenant": tenant, **rules.rule_decision(body.text)}
    store.save_decision(tenant, key, routing)
    return routing
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';

import {ruleDecision} from 'triage/rules';
import {decisionForKey, newTicketId, saveDecision} from 'triage/store';

export const app = Fastify();

interface TriageBody {
  text?: string;
  priority?: string;
  queue?: string;
}

app.post('/v1/tickets/triage', async (request, reply) => {
  // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'X-Tenant-Id is required'});
  const body = (request.body ?? {}) as TriageBody;
  const routing: Record<string, unknown> = {ticket_id: await newTicketId(), tenant, ...ruleDecision(body.text ?? '')};
  if (body.queue) routing.queue = body.queue;
  if (body.priority) routing.priority = body.priority;
  await saveDecision(tenant, String(request.headers['idempotency-key'] ?? ''), routing);
  return routing;
});
`,
      solution: `import Fastify from 'fastify';

import {ruleDecision} from 'triage/rules';
import {decisionForKey, newTicketId, saveDecision} from 'triage/store';

export const app = Fastify();

export const MAX_TEXT_BYTES = 32 * 1024;

/** priority and queue are accepted for wire compatibility and ignored. */
interface TriageBody {
  text?: string;
  priority?: string;
  queue?: string;
}

app.post('/v1/tickets/triage', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'X-Tenant-Id is required'});
  const key = request.headers['idempotency-key'];
  if (typeof key !== 'string' || key === '') return reply.code(400).send({error: 'Idempotency-Key is required'});
  const body = (request.body ?? {}) as TriageBody;
  const text = typeof body.text === 'string' ? body.text : '';
  if (text.trim() === '') return reply.code(400).send({error: 'text is required'});
  if (new TextEncoder().encode(text).length > MAX_TEXT_BYTES) return reply.code(413).send({error: 'text exceeds 32 KiB'});
  const recorded = await decisionForKey(tenant, key);
  if (recorded !== null) return recorded; // a webhook retry gets the routing the first delivery got
  const routing = {ticket_id: await newTicketId(), tenant, ...ruleDecision(text)};
  await saveDecision(tenant, key, routing);
  return routing;
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"net/http"

	"triage/rules" // rules.RuleDecision(text) rules.Decision
	"triage/store" // store.NewTicketID, DecisionForKey, SaveDecision
)

type triageRequest struct {
	Text     string \`json:"text"\`
	Priority string \`json:"priority"\`
	Queue    string \`json:"queue"\`
}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func triageTicket(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has three flaws. The task says where to look; the checks say what must change.
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		http.Error(rw, "X-Tenant-Id is required", http.StatusUnauthorized)
		return
	}
	var body triageRequest
	json.NewDecoder(r.Body).Decode(&body)
	d := rules.RuleDecision(body.Text)
	routing := map[string]any{"ticket_id": store.NewTicketID(r.Context()), "tenant": tenant, "queue": d.Queue, "priority": d.Priority,
		"confidence": d.Confidence, "fallback_reason": d.FallbackReason, "ruleset_version": d.RulesetVersion}
	if body.Queue != "" {
		routing["queue"] = body.Queue
	}
	if body.Priority != "" {
		routing["priority"] = body.Priority
	}
	store.SaveDecision(r.Context(), tenant, r.Header.Get("Idempotency-Key"), routing)
	writeJSON(rw, http.StatusOK, routing)
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/tickets/triage", triageTicket)
}
`,
      solution: `package main

import (
	"encoding/json"
	"net/http"
	"strings"

	"triage/rules" // rules.RuleDecision(text) rules.Decision
	"triage/store" // store.NewTicketID, DecisionForKey, SaveDecision
)

const maxTextBytes = 32 * 1024

// triageRequest keeps priority and queue for wire compatibility; nothing reads them.
type triageRequest struct {
	Text     string \`json:"text"\`
	Priority string \`json:"priority"\`
	Queue    string \`json:"queue"\`
}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func triageTicket(rw http.ResponseWriter, r *http.Request) {
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
	var body triageRequest
	json.NewDecoder(r.Body).Decode(&body)
	if strings.TrimSpace(body.Text) == "" {
		http.Error(rw, "text is required", http.StatusBadRequest)
		return
	}
	if len(body.Text) > maxTextBytes { // len counts UTF-8 bytes
		http.Error(rw, "text exceeds 32 KiB", http.StatusRequestEntityTooLarge)
		return
	}
	if recorded := store.DecisionForKey(r.Context(), tenant, key); recorded != nil {
		writeJSON(rw, http.StatusOK, recorded) // a webhook retry gets the routing the first delivery got
		return
	}
	d := rules.RuleDecision(body.Text)
	routing := map[string]any{"ticket_id": store.NewTicketID(r.Context()), "tenant": tenant, "queue": d.Queue, "priority": d.Priority,
		"confidence": d.Confidence, "fallback_reason": d.FallbackReason, "ruleset_version": d.RulesetVersion}
	store.SaveDecision(r.Context(), tenant, key, routing)
	writeJSON(rw, http.StatusOK, routing)
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/tickets/triage", triageTicket)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import triage.{Rules, Store} // Rules.ruleDecision(text); Store.newTicketId, decisionForKey, saveDecision

object TriageApi {
  private def json(status: StatusCode, body: JsObject): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  private def routing(ticketId: String, tenant: String, d: Rules.Decision): JsObject = JsObject(
    "ticket_id" -> JsString(ticketId), "tenant" -> JsString(tenant), "queue" -> JsString(d.queue), "priority" -> JsString(d.priority),
    "confidence" -> JsNumber(d.confidence), "fallback_reason" -> JsString(d.fallbackReason), "ruleset_version" -> JsString(d.rulesetVersion))

  val route: Route = path("v1" / "tickets" / "triage") {
    post {
      (optionalHeaderValueByName("X-Tenant-Id") & optionalHeaderValueByName("Idempotency-Key")) { (tenantOpt, keyOpt) =>
        entity(as[String]) { raw =>
          // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
          val body = raw.parseJson.asJsObject.fields
          val text = body.get("text").collect { case JsString(s) => s }.getOrElse("")
          tenantOpt.filter(_.nonEmpty) match {
            case None => complete(StatusCodes.Unauthorized -> "X-Tenant-Id is required")
            case Some(tenant) =>
              val d = Rules.ruleDecision(text)
              val queue = body.get("queue").collect { case JsString(q) => q }.getOrElse(d.queue)
              val priority = body.get("priority").collect { case JsString(p) => p }.getOrElse(d.priority)
              val answer = routing(Store.newTicketId(), tenant, d.copy(queue = queue, priority = priority))
              Store.saveDecision(tenant, keyOpt.getOrElse(""), answer)
              complete(json(StatusCodes.OK, answer))
          }
        }
      }
    }
  }
}
`,
      solution: `import java.nio.charset.StandardCharsets.UTF_8

import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import triage.{Rules, Store} // Rules.ruleDecision(text); Store.newTicketId, decisionForKey, saveDecision

object TriageApi {
  val MaxTextBytes: Int = 32 * 1024

  private def json(status: StatusCode, body: JsObject): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  private def routing(ticketId: String, tenant: String, d: Rules.Decision): JsObject = JsObject(
    "ticket_id" -> JsString(ticketId), "tenant" -> JsString(tenant), "queue" -> JsString(d.queue), "priority" -> JsString(d.priority),
    "confidence" -> JsNumber(d.confidence), "fallback_reason" -> JsString(d.fallbackReason), "ruleset_version" -> JsString(d.rulesetVersion))

  val route: Route = path("v1" / "tickets" / "triage") {
    post {
      (optionalHeaderValueByName("X-Tenant-Id") & optionalHeaderValueByName("Idempotency-Key")) { (tenantOpt, keyOpt) =>
        entity(as[String]) { raw =>
          // priority and queue in the body are accepted for wire compatibility and ignored.
          val text = raw.parseJson.asJsObject.fields.get("text").collect { case JsString(s) => s }.getOrElse("")
          (tenantOpt.filter(_.nonEmpty), keyOpt.filter(_.nonEmpty)) match {
            case (None, _) => complete(StatusCodes.Unauthorized -> "X-Tenant-Id is required")
            case (_, None) => complete(StatusCodes.BadRequest -> "Idempotency-Key is required")
            case _ if text.trim.isEmpty => complete(StatusCodes.BadRequest -> "text is required")
            case _ if text.getBytes(UTF_8).length > MaxTextBytes => complete(StatusCodes.PayloadTooLarge -> "text exceeds 32 KiB")
            case (Some(tenant), Some(key)) =>
              Store.decisionForKey(tenant, key) match {
                case Some(recorded) => complete(json(StatusCodes.OK, recorded)) // a webhook retry gets the first answer
                case None =>
                  val answer = routing(Store.newTicketId(), tenant, Rules.ruleDecision(text))
                  Store.saveDecision(tenant, key, answer)
                  complete(json(StatusCodes.OK, answer))
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

#include "triage/rules.h"  // rules::ruleDecision(text) -> rules::Decision
#include "triage/store.h"  // store::newTicketId, decisionForKey, saveDecision

using json = nlohmann::json;

void triage_ticket(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) {
    res.status = 401;
    res.set_content("X-Tenant-Id is required", "text/plain");
    return;
  }
  const json body = json::parse(req.body, nullptr, false);
  const std::string text = body.is_object() ? body.value("text", "") : "";
  const rules::Decision d = rules::ruleDecision(text);
  json routing = {{"ticket_id", store::newTicketId()}, {"tenant", tenant}, {"queue", d.queue}, {"priority", d.priority},
                  {"confidence", d.confidence}, {"fallback_reason", d.fallback_reason}, {"ruleset_version", d.ruleset_version}};
  if (body.is_object() && !body.value("queue", "").empty()) routing["queue"] = body.value("queue", "");
  if (body.is_object() && !body.value("priority", "").empty()) routing["priority"] = body.value("priority", "");
  store::saveDecision(tenant, req.get_header_value("Idempotency-Key"), routing);
  res.set_content(routing.dump(), "application/json");
}

void register_routes(httplib::Server& svr) { svr.Post("/v1/tickets/triage", triage_ticket); }
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <string>

#include "triage/rules.h"  // rules::ruleDecision(text) -> rules::Decision
#include "triage/store.h"  // store::newTicketId, decisionForKey, saveDecision

using json = nlohmann::json;

constexpr size_t kMaxTextBytes = 32 * 1024;

void reject(httplib::Response& res, int status, const std::string& message) {
  res.status = status;
  res.set_content(message, "text/plain");
}

void triage_ticket(const httplib::Request& req, httplib::Response& res) {
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) return reject(res, 401, "X-Tenant-Id is required");
  const std::string key = req.get_header_value("Idempotency-Key");
  if (key.empty()) return reject(res, 400, "Idempotency-Key is required");
  // priority and queue in the body are accepted for wire compatibility and ignored.
  const json body = json::parse(req.body, nullptr, false);
  const std::string text = body.is_object() && body.contains("text") && body["text"].is_string() ? body["text"].get<std::string>() : "";
  if (text.find_first_not_of(" \\t\\r\\n") == std::string::npos) return reject(res, 400, "text is required");
  if (text.size() > kMaxTextBytes) return reject(res, 413, "text exceeds 32 KiB");  // size() counts UTF-8 bytes
  if (const auto recorded = store::decisionForKey(tenant, key)) {
    res.set_content(recorded->dump(), "application/json");  // a webhook retry gets the routing the first delivery got
    return;
  }
  const rules::Decision d = rules::ruleDecision(text);
  const json routing = {{"ticket_id", store::newTicketId()}, {"tenant", tenant}, {"queue", d.queue}, {"priority", d.priority},
                        {"confidence", d.confidence}, {"fallback_reason", d.fallback_reason}, {"ruleset_version", d.ruleset_version}};
  store::saveDecision(tenant, key, routing);
  res.set_content(routing.dump(), "application/json");
}

void register_routes(httplib::Server& svr) { svr.Post("/v1/tickets/triage", triage_ticket); }
`,
    },
  },
  harness: {
    python: `from triage import store

PATH = "/v1/tickets/triage"
INVOICE = "Refund for invoice 4411: the payment was charged twice"


def _api(ctx):
    return ctx.client(ctx.load("api").app)


def _headers(tenant="acme", key="k-1"):
    headers = {}
    if tenant:
        headers["X-Tenant-Id"] = tenant
    if key:
        headers["Idempotency-Key"] = key
    return headers


async def check_route(ctx):
    async with _api(ctx) as c:
        r = await c.post(PATH, json={"text": INVOICE}, headers=_headers())
        assert r.status_code == 200, f"POST {PATH} answered {r.status_code}: {r.text}"
        body = r.json()
        assert body.get("queue") == "billing" and body.get("priority") == "normal", f"an invoice ticket must be routed to billing at normal priority, got {body}"
        assert str(body.get("ticket_id", "")).startswith("t-") and body.get("tenant") == "acme", f"the routing must carry the minted ticket id and the tenant, got {body}"
        assert body.get("ruleset_version") == "v3", f"the routing must name the ruleset that decided (v3), got {body}"
        r = await c.post(PATH, json={"text": INVOICE}, headers=_headers(tenant="", key="k-2"))
    assert r.status_code == 401, f"a request without X-Tenant-Id answered {r.status_code}, expected 401"


async def check_server_side_routing(ctx):
    async with _api(ctx) as c:
        r = await c.post(PATH, json={"text": INVOICE, "priority": "urgent", "queue": "vip"}, headers=_headers())
        assert r.status_code == 200, f"POST {PATH} answered {r.status_code}: {r.text}"
        body = r.json()
        assert body.get("priority") == "normal", f"the caller sent priority urgent and the ticket was routed at {body.get('priority')!r}: priority comes from the text (normal for an invoice), the body's priority is ignored"
        assert body.get("queue") == "billing", f"the caller sent queue vip and the ticket was routed to {body.get('queue')!r}: the queue comes from the text (billing), the body's queue is ignored"
        recorded = store.decision_for_key("acme", "k-1")
        assert recorded is not None and recorded.get("queue") == "billing" and recorded.get("priority") == "normal", f"the recorded routing must be the server's decision, got {recorded}"
        r = await c.post(PATH, json={"text": "Production outage: every login fails", "priority": "low"}, headers=_headers(key="k-2"))
    body = r.json()
    assert body.get("priority") == "urgent" and body.get("queue") == "account", f"an outage that blocks logins must be routed to account as urgent whatever the body says, got {body}"


async def check_text_cap(ctx):
    async with _api(ctx) as c:
        big = "x" * (32 * 1024 + 1)
        r = await c.post(PATH, json={"text": big}, headers=_headers(key="k-big"))
        assert r.status_code == 413, f"a 32 769-byte ticket answered {r.status_code}, expected 413: the text is capped at 32 KiB before any work"
        wide = "\\u00e9" * (16 * 1024 + 1)
        r = await c.post(PATH, json={"text": wide}, headers=_headers(key="k-wide"))
        assert r.status_code == 413, f"a ticket of 16 385 characters (32 770 bytes of UTF-8) answered {r.status_code}, expected 413: the cap counts bytes, not characters"
        assert ctx.redis.get("ticket:seq") is None, f"an oversized ticket was given a ticket id (ticket:seq is {ctx.redis.get('ticket:seq')}): reject it before minting one"
        for blank in ("", "   "):
            r = await c.post(PATH, json={"text": blank}, headers=_headers(key=f"k-blank-{len(blank)}"))
            assert r.status_code == 400, f"a ticket with text {blank!r} answered {r.status_code}, expected 400"
        r = await c.post(PATH, json={"priority": "low"}, headers=_headers(key="k-none"))
        assert r.status_code == 400, f"a ticket without text answered {r.status_code}, expected 400"
        r = await c.post(PATH, json={"text": "a" * (32 * 1024)}, headers=_headers(key="k-max"))
    assert r.status_code == 200, f"a ticket of exactly 32 KiB answered {r.status_code}, expected 200"


async def check_idempotency_key(ctx):
    async with _api(ctx) as c:
        first = await c.post(PATH, json={"text": INVOICE}, headers=_headers(key="hook-77"))
        assert first.status_code == 200, f"the first delivery answered {first.status_code}: {first.text}"
        retry = await c.post(PATH, json={"text": INVOICE}, headers=_headers(key="hook-77"))
        assert retry.status_code == 200 and retry.json() == first.json(), f"a webhook retry with the same Idempotency-Key must answer the recorded routing: first {first.json()}, retry {retry.json()}"
        assert ctx.redis.get("ticket:seq") == "1", f"the retry minted another ticket (ticket:seq is {ctx.redis.get('ticket:seq')}): look (tenant, key) up before triaging"
        other = await c.post(PATH, json={"text": INVOICE}, headers=_headers(tenant="globex", key="hook-77"))
        assert other.status_code == 200 and other.json().get("tenant") == "globex" and other.json().get("ticket_id") != first.json().get("ticket_id"), f"globex sending the key acme used is another ticket, got {other.status_code} {other.text}"
        none = await c.post(PATH, json={"text": INVOICE}, headers=_headers(key=""))
    assert none.status_code == 400, f"a request without Idempotency-Key answered {none.status_code}, expected 400"
`,
    typescript: `const PATH = '/v1/tickets/triage';
const INVOICE = 'Refund for invoice 4411: the payment was charged twice';

function api(ctx) {
  return {c: ctx.client(ctx.load('api').app), store: ctx.load('/support/triage/store.ts')};
}

function headers(tenant = 'acme', key = 'k-1'): Record<string, string> {
  const out: Record<string, string> = {};
  if (tenant) out['X-Tenant-Id'] = tenant;
  if (key) out['Idempotency-Key'] = key;
  return out;
}

export async function check_route(ctx) {
  const {c} = api(ctx);
  let r = await c.post(PATH, {json: {text: INVOICE}, headers: headers()});
  assert.equal(r.status, 200, \`POST \${PATH} answered \${r.status}: \${r.text}\`);
  const body = r.json();
  assert(body.queue === 'billing' && body.priority === 'normal', \`an invoice ticket must be routed to billing at normal priority, got \${r.text}\`);
  assert(String(body.ticket_id ?? '').startsWith('t-') && body.tenant === 'acme', \`the routing must carry the minted ticket id and the tenant, got \${r.text}\`);
  assert.equal(body.ruleset_version, 'v3', \`the routing must name the ruleset that decided (v3), got \${r.text}\`);
  r = await c.post(PATH, {json: {text: INVOICE}, headers: headers('', 'k-2')});
  assert.equal(r.status, 401, \`a request without X-Tenant-Id answered \${r.status}, expected 401\`);
}

export async function check_server_side_routing(ctx) {
  const {c, store} = api(ctx);
  let r = await c.post(PATH, {json: {text: INVOICE, priority: 'urgent', queue: 'vip'}, headers: headers()});
  assert.equal(r.status, 200, \`POST \${PATH} answered \${r.status}: \${r.text}\`);
  let body = r.json();
  assert.equal(body.priority, 'normal', \`the caller sent priority urgent and the ticket was routed at \${JSON.stringify(body.priority)}: priority comes from the text (normal for an invoice), the body's priority is ignored\`);
  assert.equal(body.queue, 'billing', \`the caller sent queue vip and the ticket was routed to \${JSON.stringify(body.queue)}: the queue comes from the text (billing), the body's queue is ignored\`);
  const recorded = await store.decisionForKey('acme', 'k-1');
  assert(recorded !== null && recorded.queue === 'billing' && recorded.priority === 'normal', \`the recorded routing must be the server's decision, got \${JSON.stringify(recorded)}\`);
  r = await c.post(PATH, {json: {text: 'Production outage: every login fails', priority: 'low'}, headers: headers('acme', 'k-2')});
  body = r.json();
  assert(body.priority === 'urgent' && body.queue === 'account', \`an outage that blocks logins must be routed to account as urgent whatever the body says, got \${r.text}\`);
}

export async function check_text_cap(ctx) {
  const {c} = api(ctx);
  let r = await c.post(PATH, {json: {text: 'x'.repeat(32 * 1024 + 1)}, headers: headers('acme', 'k-big')});
  assert.equal(r.status, 413, \`a 32 769-byte ticket answered \${r.status}, expected 413: the text is capped at 32 KiB before any work\`);
  r = await c.post(PATH, {json: {text: '\\u00e9'.repeat(16 * 1024 + 1)}, headers: headers('acme', 'k-wide')});
  assert.equal(r.status, 413, \`a ticket of 16 385 characters (32 770 bytes of UTF-8) answered \${r.status}, expected 413: the cap counts bytes, not characters\`);
  assert.equal(ctx.redis.get('ticket:seq'), null, \`an oversized ticket was given a ticket id (ticket:seq is \${ctx.redis.get('ticket:seq')}): reject it before minting one\`);
  for (const blank of ['', '   ']) {
    r = await c.post(PATH, {json: {text: blank}, headers: headers('acme', \`k-blank-\${blank.length}\`)});
    assert.equal(r.status, 400, \`a ticket with text \${JSON.stringify(blank)} answered \${r.status}, expected 400\`);
  }
  r = await c.post(PATH, {json: {priority: 'low'}, headers: headers('acme', 'k-none')});
  assert.equal(r.status, 400, \`a ticket without text answered \${r.status}, expected 400\`);
  r = await c.post(PATH, {json: {text: 'a'.repeat(32 * 1024)}, headers: headers('acme', 'k-max')});
  assert.equal(r.status, 200, \`a ticket of exactly 32 KiB answered \${r.status}, expected 200\`);
}

export async function check_idempotency_key(ctx) {
  const {c} = api(ctx);
  const first = await c.post(PATH, {json: {text: INVOICE}, headers: headers('acme', 'hook-77')});
  assert.equal(first.status, 200, \`the first delivery answered \${first.status}: \${first.text}\`);
  const retry = await c.post(PATH, {json: {text: INVOICE}, headers: headers('acme', 'hook-77')});
  assert(retry.status === 200 && JSON.stringify(retry.json()) === JSON.stringify(first.json()), \`a webhook retry with the same Idempotency-Key must answer the recorded routing: first \${first.text}, retry \${retry.text}\`);
  assert.equal(ctx.redis.get('ticket:seq'), '1', \`the retry minted another ticket (ticket:seq is \${ctx.redis.get('ticket:seq')}): look (tenant, key) up before triaging\`);
  const other = await c.post(PATH, {json: {text: INVOICE}, headers: headers('globex', 'hook-77')});
  assert(other.status === 200 && other.json().tenant === 'globex' && other.json().ticket_id !== first.json().ticket_id, \`globex sending the key acme used is another ticket, got \${other.status} \${other.text}\`);
  const none = await c.post(PATH, {json: {text: INVOICE}, headers: headers('acme', '')});
  assert.equal(none.status, 400, \`a request without Idempotency-Key answered \${none.status}, expected 400\`);
}
`,
    go: `package main

import (
	"context"
	"net/http"
	"strings"

	"triage/store"

	"leetbuild/harness"
)

const (
	triagePath = "/v1/tickets/triage"
	invoice    = "Refund for invoice 4411: the payment was charged twice"
)

func api(ctx *harness.Ctx) *harness.HTTP {
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

func post(c *harness.HTTP, body any, tenant, key string) *harness.Response {
	var header []string
	if tenant != "" {
		header = append(header, "X-Tenant-Id", tenant)
	}
	if key != "" {
		header = append(header, "Idempotency-Key", key)
	}
	return c.Post(triagePath, body, header...)
}

func routingOf(ctx *harness.Ctx, r *harness.Response) map[string]any {
	ctx.Equal(r.Status, 200, "POST %s answered %s", triagePath, r.Text())
	body, _ := r.JSON().(map[string]any)
	return body
}

func ticketSeq(ctx *harness.Ctx) string {
	seq, _ := ctx.Redis.Get("ticket:seq")
	return seq
}

func CheckRoute(ctx *harness.Ctx) {
	c := api(ctx)
	body := routingOf(ctx, post(c, map[string]string{"text": invoice}, "acme", "k-1"))
	ctx.Assert(body["queue"] == "billing" && body["priority"] == "normal", "an invoice ticket must be routed to billing at normal priority, got %v", body)
	id, _ := body["ticket_id"].(string)
	ctx.Assert(strings.HasPrefix(id, "t-") && body["tenant"] == "acme", "the routing must carry the minted ticket id and the tenant, got %v", body)
	ctx.Equal(body["ruleset_version"], "v3", "the routing must name the ruleset that decided")
	r := post(c, map[string]string{"text": invoice}, "", "k-2")
	ctx.Equal(r.Status, 401, "a request without X-Tenant-Id")
}

func CheckServerSideRouting(ctx *harness.Ctx) {
	c := api(ctx)
	body := routingOf(ctx, post(c, map[string]string{"text": invoice, "priority": "urgent", "queue": "vip"}, "acme", "k-1"))
	ctx.Equal(body["priority"], "normal", "the caller sent priority urgent: priority comes from the text (normal for an invoice), the body's priority is ignored; the routed priority")
	ctx.Equal(body["queue"], "billing", "the caller sent queue vip: the queue comes from the text (billing), the body's queue is ignored; the routed queue")
	recorded := store.DecisionForKey(context.Background(), "acme", "k-1")
	ctx.Assert(recorded != nil && recorded["queue"] == "billing" && recorded["priority"] == "normal", "the recorded routing must be the server's decision, got %v", recorded)
	body = routingOf(ctx, post(c, map[string]string{"text": "Production outage: every login fails", "priority": "low"}, "acme", "k-2"))
	ctx.Assert(body["priority"] == "urgent" && body["queue"] == "account", "an outage that blocks logins must be routed to account as urgent whatever the body says, got %v", body)
}

func CheckTextCap(ctx *harness.Ctx) {
	c := api(ctx)
	r := post(c, map[string]string{"text": strings.Repeat("x", 32*1024+1)}, "acme", "k-big")
	ctx.Equal(r.Status, 413, "a 32 769-byte ticket must be refused before any work (the cap is 32 KiB)")
	r = post(c, map[string]string{"text": strings.Repeat("\\u00e9", 16*1024+1)}, "acme", "k-wide")
	ctx.Equal(r.Status, 413, "a ticket of 16 385 characters (32 770 bytes of UTF-8) must be refused: the cap counts bytes, not characters")
	ctx.Equal(ticketSeq(ctx), "", "an oversized ticket must be refused before a ticket id is minted; ticket:seq")
	for _, blank := range []string{"", "   "} {
		r = post(c, map[string]string{"text": blank}, "acme", "k-blank-"+strings.Repeat("s", len(blank)))
		ctx.Equal(r.Status, 400, "a ticket with text %q", blank)
	}
	r = post(c, map[string]string{"priority": "low"}, "acme", "k-none")
	ctx.Equal(r.Status, 400, "a ticket without text")
	r = post(c, map[string]string{"text": strings.Repeat("a", 32*1024)}, "acme", "k-max")
	ctx.Equal(r.Status, 200, "a ticket of exactly 32 KiB")
}

func CheckIdempotencyKey(ctx *harness.Ctx) {
	c := api(ctx)
	first := post(c, map[string]string{"text": invoice}, "acme", "hook-77")
	ctx.Equal(first.Status, 200, "the first delivery (%s)", first.Text())
	retry := post(c, map[string]string{"text": invoice}, "acme", "hook-77")
	ctx.Assert(retry.Status == 200 && strings.TrimSpace(retry.Text()) == strings.TrimSpace(first.Text()), "a webhook retry with the same Idempotency-Key must answer the recorded routing: first %s, retry %s", first.Text(), retry.Text())
	ctx.Equal(ticketSeq(ctx), "1", "the retry must not mint another ticket (look (tenant, key) up before triaging); ticket:seq")
	other := routingOf(ctx, post(c, map[string]string{"text": invoice}, "globex", "hook-77"))
	firstBody, _ := first.JSON().(map[string]any)
	ctx.Assert(other["tenant"] == "globex" && other["ticket_id"] != firstBody["ticket_id"], "globex sending the key acme used is another ticket, got %v", other)
	none := post(c, map[string]string{"text": invoice}, "acme", "")
	ctx.Equal(none.Status, 400, "a request without Idempotency-Key")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <string>
#include <vector>

namespace {

const std::string kPath = "/v1/tickets/triage";
const std::string kInvoice = "Refund for invoice 4411: the payment was charged twice";

harness::HTTP api(harness::Ctx& ctx) {
  static httplib::Server* svr = nullptr;
  delete svr;
  svr = new httplib::Server;
  register_routes(*svr);
  return ctx.HTTP(*svr);
}

harness::Response post(harness::HTTP& c, const nlohmann::json& body, const std::string& tenant, const std::string& key) {
  std::vector<std::string> headers = {"Content-Type", "application/json"};
  if (!tenant.empty()) headers.insert(headers.end(), {"X-Tenant-Id", tenant});
  if (!key.empty()) headers.insert(headers.end(), {"Idempotency-Key", key});
  return c.Send("POST", kPath, body.dump(), headers);
}

nlohmann::json routingOf(harness::Ctx& ctx, const harness::Response& r) {
  ctx.Equal(r.Status, 200, "POST %s answered %s", kPath, r.Text());
  return nlohmann::json::parse(r.Text(), nullptr, false);
}

std::string repeat(const std::string& s, size_t n) {
  std::string out;
  for (size_t i = 0; i < n; ++i) out += s;
  return out;
}

}  // namespace

void CheckRoute(harness::Ctx& ctx) {
  auto c = api(ctx);
  const auto body = routingOf(ctx, post(c, {{"text", kInvoice}}, "acme", "k-1"));
  ctx.Assert(body.value("queue", "") == "billing" && body.value("priority", "") == "normal", "an invoice ticket must be routed to billing at normal priority, got %s", body.dump());
  ctx.Assert(body.value("ticket_id", "").rfind("t-", 0) == 0 && body.value("tenant", "") == "acme", "the routing must carry the minted ticket id and the tenant, got %s", body.dump());
  ctx.Equal(body.value("ruleset_version", ""), "v3", "the routing must name the ruleset that decided");
  const auto r = post(c, {{"text", kInvoice}}, "", "k-2");
  ctx.Equal(r.Status, 401, "a request without X-Tenant-Id");
}

void CheckServerSideRouting(harness::Ctx& ctx) {
  auto c = api(ctx);
  auto body = routingOf(ctx, post(c, {{"text", kInvoice}, {"priority", "urgent"}, {"queue", "vip"}}, "acme", "k-1"));
  ctx.Equal(body.value("priority", ""), "normal", "the caller sent priority urgent: priority comes from the text (normal for an invoice), the body's priority is ignored; the routed priority");
  ctx.Equal(body.value("queue", ""), "billing", "the caller sent queue vip: the queue comes from the text (billing), the body's queue is ignored; the routed queue");
  const auto recorded = store::decisionForKey("acme", "k-1");
  ctx.Assert(recorded && recorded->value("queue", "") == "billing" && recorded->value("priority", "") == "normal", "the recorded routing must be the server's decision, got %s", recorded ? recorded->dump() : "none");
  body = routingOf(ctx, post(c, {{"text", "Production outage: every login fails"}, {"priority", "low"}}, "acme", "k-2"));
  ctx.Assert(body.value("priority", "") == "urgent" && body.value("queue", "") == "account", "an outage that blocks logins must be routed to account as urgent whatever the body says, got %s", body.dump());
}

void CheckTextCap(harness::Ctx& ctx) {
  auto c = api(ctx);
  auto r = post(c, {{"text", repeat("x", 32 * 1024 + 1)}}, "acme", "k-big");
  ctx.Equal(r.Status, 413, "a 32 769-byte ticket must be refused before any work (the cap is 32 KiB)");
  r = post(c, {{"text", repeat("\\u00e9", 16 * 1024 + 1)}}, "acme", "k-wide");
  ctx.Equal(r.Status, 413, "a ticket of 16 385 characters (32 770 bytes of UTF-8) must be refused: the cap counts bytes, not characters");
  ctx.Assert(!ctx.Redis.Get("ticket:seq"), "an oversized ticket was given a ticket id (ticket:seq is %s): reject it before minting one", ctx.Redis.Get("ticket:seq").value_or(""));
  for (const std::string blank : {"", "   "}) {
    r = post(c, {{"text", blank}}, "acme", "k-blank-" + std::to_string(blank.size()));
    ctx.Equal(r.Status, 400, "a ticket with text %q", blank);
  }
  r = post(c, {{"priority", "low"}}, "acme", "k-none");
  ctx.Equal(r.Status, 400, "a ticket without text");
  r = post(c, {{"text", repeat("a", 32 * 1024)}}, "acme", "k-max");
  ctx.Equal(r.Status, 200, "a ticket of exactly 32 KiB");
}

void CheckIdempotencyKey(harness::Ctx& ctx) {
  auto c = api(ctx);
  const auto first = post(c, {{"text", kInvoice}}, "acme", "hook-77");
  ctx.Equal(first.Status, 200, "the first delivery (%s)", first.Text());
  const auto retry = post(c, {{"text", kInvoice}}, "acme", "hook-77");
  ctx.Assert(retry.Status == 200 && nlohmann::json::parse(retry.Text(), nullptr, false) == nlohmann::json::parse(first.Text(), nullptr, false),
             "a webhook retry with the same Idempotency-Key must answer the recorded routing: first %s, retry %s", first.Text(), retry.Text());
  ctx.Equal(ctx.Redis.Get("ticket:seq"), std::optional<std::string>("1"), "the retry must not mint another ticket (look (tenant, key) up before triaging); ticket:seq");
  const auto other = routingOf(ctx, post(c, {{"text", kInvoice}}, "globex", "hook-77"));
  const auto firstBody = nlohmann::json::parse(first.Text(), nullptr, false);
  ctx.Assert(other.value("tenant", "") == "globex" && other.value("ticket_id", "") != firstBody.value("ticket_id", ""), "globex sending the key acme used is another ticket, got %s", other.dump());
  const auto none = post(c, {{"text", kInvoice}}, "acme", "");
  ctx.Equal(none.Status, 400, "a request without Idempotency-Key");
}
`,
  },
  hints: [
    'Post an invoice ticket with `"priority": "urgent"` in the body and it comes back urgent; deliver the same webhook twice and you get two ticket ids; post 40 KiB of log and it is routed.',
    "The handler copies the body's `queue` and `priority` over the rule decision, nothing measures the text before it is routed, and `save_decision` writes the answer under the key while nothing reads it back.",
    'Drop the two overrides. Answer 400 for a missing key or blank text and 413 when `len(text.encode())` exceeds `MAX_TEXT_BYTES`; then return `store.decision_for_key(tenant, key)` if set, else decide, mint and `save_decision`.',
  ],
  debrief: `Authority over the routing moves to the server: \`priority\` and \`queue\` stay on the request model so old clients keep working, but nothing reads them, so a customer cannot buy a faster lane with a field. The guards run cheapest first, and the cap counts bytes because that is what storage, the classifier and every later stage pay for. The idempotency record is keyed by tenant and key, so a webhook retry gets the first answer and two tenants' keys never collide. Production triage services also expire those records on the sender's retry horizon, keep a redacted preview of oversized tickets instead of dropping them, and log which ruleset version made each decision.`,
};
