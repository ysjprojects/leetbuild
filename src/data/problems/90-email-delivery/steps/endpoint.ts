import type {Step} from '@/lib/types';

export const endpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/emails: refusals before the queue',
  concept: 'http',
  file: 'api',
  focus: ['client', 'api', 'redis', 'store'],
  task: `## Task

**Starting point.** The starter serves \`POST /v1/emails\` with body \`{"recipient", "template_id",
"subject", "variables"}\` and the caller's \`X-Tenant-Id\`: it queues the message
(\`store.enqueue\`), then asks \`gate.admit(recipient)\` and answers **409** for a suppressed
recipient, **429** over the rate limit, else **202** \`{"message_id"}\`. It serves the demo and hides
four flaws.

**Failure mode the checks target.** A refused send is already on the relay's queue, so the customer
who unsubscribed gets the mail anyway; a client retry after a timeout queues a second copy; an
unknown template or a huge variables map goes to the relay; and a subject with \`\\r\\n\` adds
headers to the message.

- \`gate.admit\` runs before \`store.enqueue\`: a suppressed (409) or rate-limited (429) send is
  never queued.
- \`Idempotency-Key\` is required (**400** without it). \`store.find_send(tenant, key)\` answers a
  replay with the first message id; a fresh send records its id with \`store.remember_send\`.
- \`template_id\` is one of \`KNOWN_TEMPLATES\` (\`welcome\`, \`receipt\`, \`password_reset\`), else
  **400**; variable names and values total at most \`MAX_VARIABLES_BYTES\` (8 KiB of UTF-8), else
  **413**.
- A \`\\r\` or \`\\n\` in the subject or in any variable value is **400**.`,
  sequence: {
    participants: ['Client', 'Email API', 'Gate', 'Message store'],
    messages: [
      {from: 'Client', to: 'Email API', label: 'POST /v1/emails · Idempotency-Key · X-Tenant-Id', kind: 'sync'},
      {from: 'Email API', to: 'Email API', label: 'key · template · 8 KiB · CRLF → 400 / 413', kind: 'sync'},
      {from: 'Email API', to: 'Message store', label: 'find_send(tenant, key) → replay', kind: 'sync'},
      {from: 'Email API', to: 'Gate', label: 'admit(recipient)', kind: 'sync'},
      {from: 'Gate', to: 'Email API', label: 'ok · suppressed → 409 · rate_limited → 429', kind: 'reply'},
      {from: 'Email API', to: 'Message store', label: 'enqueue · remember_send', kind: 'sync'},
      {from: 'Email API', to: 'Client', label: '202 {message_id}', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Queues a valid send on POST /v1/emails',
      detail: 'Register `POST /v1/emails`; a valid send answers **202** with the `message_id` of a queued message.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/emails["']/, /store\.enqueue\(/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/emails['"]/, /\benqueue\(/]},
        go: {all: [/HandleFunc\(\s*"POST \/v1\/emails"/, /store\.Enqueue\(/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"emails"\s*\)/, /\bpost\s*\{/, /Store\.enqueue\(/]},
        cpp: {all: [/svr\.Post\(\s*"\/v1\/emails"/, /store::enqueue\(/]},
      },
    },
    {
      id: 'suppression-first',
      title: 'Asks the gate before queueing',
      detail:
        'A suppressed recipient is refused with **409** and a rate-limited one with **429**, and neither message reaches `mail:queue`; the starter enqueues first and asks the gate afterwards.',
      match: {
        python: {all: [/\b409\b/, /\b429\b/], order: [/gate\.admit\(/, /store\.enqueue\(/]},
        typescript: {all: [/\b409\b/, /\b429\b/], order: [/\badmit\(/, /\benqueue\(/]},
        go: {
          all: [/StatusConflict|\b409\b/, /StatusTooManyRequests|\b429\b/],
          order: [/gate\.Admit\(/, /store\.Enqueue\(/],
        },
        scala: {all: [/Conflict|\b409\b/, /TooManyRequests|\b429\b/], order: [/Gate\.admit\(/, /Store\.enqueue\(/]},
        cpp: {all: [/\b409\b/, /\b429\b/], order: [/gate::admit\(/, /store::enqueue\(/]},
      },
    },
    {
      id: 'idempotency-key',
      title: 'Keys a retry by (tenant, Idempotency-Key)',
      detail:
        '`Idempotency-Key` is required (**400** without it); `find_send`/`findSend` answers a replay with the first message id before anything is queued, and a fresh send records its id with `remember_send`/`rememberSend`.',
      match: {
        python: {
          all: [/idempotency-key/i, /store\.find_send\(/, /store\.remember_send\(/, /\b400\b/],
          order: [/store\.find_send\(/, /store\.enqueue\(/],
        },
        typescript: {
          all: [/idempotency-key/i, /findSend\(/, /rememberSend\(/, /\b400\b/],
          order: [/findSend\(/, /\benqueue\(/],
        },
        go: {
          all: [/Idempotency-Key/i, /store\.FindSend\(/, /store\.RememberSend\(/, /StatusBadRequest|\b400\b/],
          order: [/store\.FindSend\(/, /store\.Enqueue\(/],
        },
        scala: {
          all: [/Idempotency-Key/i, /Store\.findSend\(/, /Store\.rememberSend\(/, /BadRequest|\b400\b/],
          order: [/Store\.findSend\(/, /Store\.enqueue\(/],
        },
        cpp: {
          all: [/Idempotency-Key/i, /store::findSend\(/, /store::rememberSend\(/, /\b400\b/],
          order: [/store::findSend\(/, /store::enqueue\(/],
        },
      },
    },
    {
      id: 'validate-template-variables',
      title: 'Known templates and an 8 KiB variables cap',
      detail:
        'A `template_id` outside `KNOWN_TEMPLATES` is **400** and variables over `MAX_VARIABLES_BYTES` (8 KiB, names and values in UTF-8) are **413**, before anything is queued.',
      match: {
        python: {all: [/KNOWN_TEMPLATES/, /MAX_VARIABLES_BYTES\s*=\s*(8\s*\*\s*1024|8192)/, /\b413\b/]},
        typescript: {all: [/KNOWN_TEMPLATES/, /MAX_VARIABLES_BYTES\s*=\s*(8\s*\*\s*1024|8192)/, /\b413\b/]},
        go: {
          all: [
            /knownTemplates/,
            /maxVariablesBytes\s*=\s*(8\s*\*\s*1024|8192)/,
            /StatusRequestEntityTooLarge|\b413\b/,
          ],
        },
        scala: {
          all: [
            /KnownTemplates/,
            /MaxVariablesBytes(:\s*Int)?\s*=\s*(8\s*\*\s*1024|8192)/,
            /PayloadTooLarge|ContentTooLarge|\b413\b/,
          ],
        },
        cpp: {all: [/kKnownTemplates/, /kMaxVariablesBytes\s*=\s*(8\s*\*\s*1024|8192)/, /\b413\b/]},
      },
    },
    {
      id: 'reject-crlf',
      title: 'Rejects line breaks in the subject and variables',
      detail:
        "A subject or variable value containing `\\r` or `\\n` is **400**: the relay writes them into header lines, where a line break starts a header of the caller's choosing.",
      match: {
        python: {all: [/has_crlf\(/, /\\r/, /\\n/]},
        typescript: {all: [/hasCrlf\b/, /\\r/, /\\n/]},
        go: {all: [/hasCRLF\(/, /\\r/, /\\n/]},
        scala: {all: [/hasCrlf\b/, /\\r/, /\\n/]},
        cpp: {all: [/hasCrlf\(/, /\\r/, /\\n/]},
      },
    },
  ],
  code: {
    python: {
      starter: `from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from mail import gate, store  # gate.admit(address) -> "ok" | "suppressed" | "rate_limited"; store.enqueue, find_send, remember_send

app = FastAPI()


class SendRequest(BaseModel):
    recipient: str
    template_id: str
    subject: str = ""
    variables: dict[str, str] = {}


@app.post("/v1/emails")
def send_email(body: SendRequest, request: Request) -> JSONResponse:
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    tenant = request.headers.get("x-tenant-id", "")
    message_id = store.enqueue(tenant, body.recipient, body.template_id, body.subject, body.variables)
    verdict = gate.admit(body.recipient)
    if verdict == "suppressed":
        return JSONResponse({"error": "recipient is suppressed"}, status_code=409)
    if verdict == "rate_limited":
        return JSONResponse({"error": "too many emails to this recipient"}, status_code=429)
    return JSONResponse({"message_id": message_id}, status_code=202)
`,
      solution: `from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from mail import gate, store  # gate.admit(address) -> "ok" | "suppressed" | "rate_limited"; store.enqueue, find_send, remember_send

app = FastAPI()

KNOWN_TEMPLATES = {"welcome", "receipt", "password_reset"}
MAX_VARIABLES_BYTES = 8 * 1024


class SendRequest(BaseModel):
    recipient: str
    template_id: str
    subject: str = ""
    variables: dict[str, str] = {}


def has_crlf(value: str) -> bool:
    return "\\r" in value or "\\n" in value


@app.post("/v1/emails")
def send_email(body: SendRequest, request: Request) -> JSONResponse:
    tenant = request.headers.get("x-tenant-id", "")
    key = request.headers.get("idempotency-key", "")
    if not key:
        return JSONResponse({"error": "Idempotency-Key is required"}, status_code=400)
    if body.template_id not in KNOWN_TEMPLATES:
        return JSONResponse({"error": "unknown template"}, status_code=400)
    size = sum(len(name.encode()) + len(value.encode()) for name, value in body.variables.items())
    if size > MAX_VARIABLES_BYTES:
        return JSONResponse({"error": "variables over 8 KiB"}, status_code=413)
    if has_crlf(body.subject) or any(has_crlf(value) for value in body.variables.values()):
        return JSONResponse({"error": "line break in the subject or a variable"}, status_code=400)
    sent = store.find_send(tenant, key)
    if sent is not None:
        return JSONResponse({"message_id": sent}, status_code=202)  # a retry answers the first message id
    # Every refusal happens before the message reaches the relay's queue.
    verdict = gate.admit(body.recipient)
    if verdict == "suppressed":
        return JSONResponse({"error": "recipient is suppressed"}, status_code=409)
    if verdict == "rate_limited":
        return JSONResponse({"error": "too many emails to this recipient"}, status_code=429)
    message_id = store.enqueue(tenant, body.recipient, body.template_id, body.subject, body.variables)
    store.remember_send(tenant, key, message_id)
    return JSONResponse({"message_id": message_id}, status_code=202)
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';

import {admit} from 'mail/gate'; // admit(address) → 'ok' | 'suppressed' | 'rate_limited'
import {enqueue, findSend, rememberSend} from 'mail/store';

export const app = Fastify();

interface SendRequest {
  recipient: string;
  template_id: string;
  subject?: string;
  variables?: Record<string, string>;
}

app.post('/v1/emails', async (request, reply) => {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const body = request.body as SendRequest;
  const tenant = String(request.headers['x-tenant-id'] ?? '');
  const messageId = await enqueue(tenant, body.recipient, body.template_id, body.subject ?? '', body.variables ?? {});
  const verdict = await admit(body.recipient);
  if (verdict === 'suppressed') return reply.code(409).send({error: 'recipient is suppressed'});
  if (verdict === 'rate_limited') return reply.code(429).send({error: 'too many emails to this recipient'});
  return reply.code(202).send({message_id: messageId});
});
`,
      solution: `import Fastify from 'fastify';

import {admit} from 'mail/gate'; // admit(address) → 'ok' | 'suppressed' | 'rate_limited'
import {enqueue, findSend, rememberSend} from 'mail/store';

export const app = Fastify();

const KNOWN_TEMPLATES = new Set(['welcome', 'receipt', 'password_reset']);
const MAX_VARIABLES_BYTES = 8 * 1024;

interface SendRequest {
  recipient: string;
  template_id: string;
  subject?: string;
  variables?: Record<string, string>;
}

const hasCrlf = (value: string): boolean => value.includes('\\r') || value.includes('\\n');

app.post('/v1/emails', async (request, reply) => {
  const body = request.body as SendRequest;
  const tenant = String(request.headers['x-tenant-id'] ?? '');
  const key = request.headers['idempotency-key'];
  if (typeof key !== 'string' || key === '') return reply.code(400).send({error: 'Idempotency-Key is required'});
  const subject = body.subject ?? '';
  const variables = body.variables ?? {};
  if (!KNOWN_TEMPLATES.has(body.template_id)) return reply.code(400).send({error: 'unknown template'});
  let size = 0;
  for (const [name, value] of Object.entries(variables)) size += Buffer.byteLength(name) + Buffer.byteLength(value);
  if (size > MAX_VARIABLES_BYTES) return reply.code(413).send({error: 'variables over 8 KiB'});
  if (hasCrlf(subject) || Object.values(variables).some(hasCrlf)) {
    return reply.code(400).send({error: 'line break in the subject or a variable'});
  }
  const sent = await findSend(tenant, key);
  if (sent !== null) return reply.code(202).send({message_id: sent}); // a retry answers the first message id
  // Every refusal happens before the message reaches the relay's queue.
  const verdict = await admit(body.recipient);
  if (verdict === 'suppressed') return reply.code(409).send({error: 'recipient is suppressed'});
  if (verdict === 'rate_limited') return reply.code(429).send({error: 'too many emails to this recipient'});
  const messageId = await enqueue(tenant, body.recipient, body.template_id, subject, variables);
  await rememberSend(tenant, key, messageId);
  return reply.code(202).send({message_id: messageId});
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"net/http"

	"mail/gate"  // gate.Admit(ctx, address) → "ok", "suppressed" or "rate_limited"
	"mail/store" // store.Enqueue, FindSend, RememberSend
)

type sendRequest struct {
	Recipient  string            \`json:"recipient"\`
	TemplateID string            \`json:"template_id"\`
	Subject    string            \`json:"subject"\`
	Variables  map[string]string \`json:"variables"\`
}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func sendEmail(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	var body sendRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	tenant := r.Header.Get("X-Tenant-Id")
	messageID := store.Enqueue(r.Context(), tenant, body.Recipient, body.TemplateID, body.Subject, body.Variables)
	verdict, err := gate.Admit(r.Context(), body.Recipient)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "try again"})
		return
	}
	switch verdict {
	case "suppressed":
		writeJSON(rw, http.StatusConflict, map[string]string{"error": "recipient is suppressed"})
		return
	case "rate_limited":
		writeJSON(rw, http.StatusTooManyRequests, map[string]string{"error": "too many emails to this recipient"})
		return
	}
	writeJSON(rw, http.StatusAccepted, map[string]string{"message_id": messageID})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/emails", sendEmail)
}
`,
      solution: `package main

import (
	"encoding/json"
	"net/http"
	"strings"

	"mail/gate"  // gate.Admit(ctx, address) → "ok", "suppressed" or "rate_limited"
	"mail/store" // store.Enqueue, FindSend, RememberSend
)

var knownTemplates = map[string]bool{"welcome": true, "receipt": true, "password_reset": true}

const maxVariablesBytes = 8 * 1024

type sendRequest struct {
	Recipient  string            \`json:"recipient"\`
	TemplateID string            \`json:"template_id"\`
	Subject    string            \`json:"subject"\`
	Variables  map[string]string \`json:"variables"\`
}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func hasCRLF(value string) bool { return strings.ContainsAny(value, "\\r\\n") }

func sendEmail(rw http.ResponseWriter, r *http.Request) {
	var body sendRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	tenant := r.Header.Get("X-Tenant-Id")
	key := r.Header.Get("Idempotency-Key")
	if key == "" {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "Idempotency-Key is required"})
		return
	}
	if !knownTemplates[body.TemplateID] {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "unknown template"})
		return
	}
	size := 0
	crlf := hasCRLF(body.Subject)
	for name, value := range body.Variables {
		size += len(name) + len(value)
		crlf = crlf || hasCRLF(value)
	}
	if size > maxVariablesBytes {
		writeJSON(rw, http.StatusRequestEntityTooLarge, map[string]string{"error": "variables over 8 KiB"})
		return
	}
	if crlf {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "line break in the subject or a variable"})
		return
	}
	if sent := store.FindSend(r.Context(), tenant, key); sent != "" {
		writeJSON(rw, http.StatusAccepted, map[string]string{"message_id": sent}) // a retry answers the first message id
		return
	}
	// Every refusal happens before the message reaches the relay's queue.
	verdict, err := gate.Admit(r.Context(), body.Recipient)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "try again"})
		return
	}
	switch verdict {
	case "suppressed":
		writeJSON(rw, http.StatusConflict, map[string]string{"error": "recipient is suppressed"})
		return
	case "rate_limited":
		writeJSON(rw, http.StatusTooManyRequests, map[string]string{"error": "too many emails to this recipient"})
		return
	}
	messageID := store.Enqueue(r.Context(), tenant, body.Recipient, body.TemplateID, body.Subject, body.Variables)
	store.RememberSend(r.Context(), tenant, key, messageID)
	writeJSON(rw, http.StatusAccepted, map[string]string{"message_id": messageID})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/emails", sendEmail)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._
import spray.json.DefaultJsonProtocol._

import mail.{Gate, Store} // Gate.admit(address): "ok", "suppressed" or "rate_limited"; Store.enqueue, findSend, rememberSend

object Api {
  private def json(status: StatusCode, body: JsObject): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  private def error(status: StatusCode, message: String): HttpResponse = json(status, JsObject("error" -> JsString(message)))

  private def text(fields: Map[String, JsValue], name: String): String = fields.get(name).collect { case JsString(s) => s }.getOrElse("")

  val route: Route = path("v1" / "emails") {
    post {
      optionalHeaderValueByName("X-Tenant-Id") { tenantHeader =>
        entity(as[String]) { raw =>
          // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
          val body = raw.parseJson.asJsObject.fields
          val tenant = tenantHeader.getOrElse("")
          val recipient = text(body, "recipient")
          val variables = body.get("variables").map(_.convertTo[Map[String, String]]).getOrElse(Map.empty[String, String])
          val messageId = Store.enqueue(tenant, recipient, text(body, "template_id"), text(body, "subject"), variables)
          complete(Gate.admit(recipient) match {
            case "suppressed" => error(StatusCodes.Conflict, "recipient is suppressed")
            case "rate_limited" => error(StatusCodes.TooManyRequests, "too many emails to this recipient")
            case _ => json(StatusCodes.Accepted, JsObject("message_id" -> JsString(messageId)))
          })
        }
      }
    }
  }
}
`,
      solution: `import java.nio.charset.StandardCharsets

import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._
import spray.json.DefaultJsonProtocol._

import mail.{Gate, Store} // Gate.admit(address): "ok", "suppressed" or "rate_limited"; Store.enqueue, findSend, rememberSend

object Api {
  val KnownTemplates: Set[String] = Set("welcome", "receipt", "password_reset")
  val MaxVariablesBytes: Int = 8 * 1024

  private def json(status: StatusCode, body: JsObject): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  private def error(status: StatusCode, message: String): HttpResponse = json(status, JsObject("error" -> JsString(message)))

  private def accepted(messageId: String): HttpResponse = json(StatusCodes.Accepted, JsObject("message_id" -> JsString(messageId)))

  private def text(fields: Map[String, JsValue], name: String): String = fields.get(name).collect { case JsString(s) => s }.getOrElse("")

  private def hasCrlf(value: String): Boolean = value.contains('\\r') || value.contains('\\n')

  private def bytes(value: String): Int = value.getBytes(StandardCharsets.UTF_8).length

  private def send(tenant: String, key: String, recipient: String, templateId: String, subject: String, variables: Map[String, String]): HttpResponse =
    if (key.isEmpty) error(StatusCodes.BadRequest, "Idempotency-Key is required")
    else if (!KnownTemplates.contains(templateId)) error(StatusCodes.BadRequest, "unknown template")
    else if (variables.map { case (name, value) => bytes(name) + bytes(value) }.sum > MaxVariablesBytes)
      error(StatusCodes.PayloadTooLarge, "variables over 8 KiB")
    else if (hasCrlf(subject) || variables.values.exists(hasCrlf)) error(StatusCodes.BadRequest, "line break in the subject or a variable")
    else
      Store.findSend(tenant, key) match {
        case Some(sent) => accepted(sent) // a retry answers the first message id
        case None =>
          // Every refusal happens before the message reaches the relay's queue.
          Gate.admit(recipient) match {
            case "suppressed" => error(StatusCodes.Conflict, "recipient is suppressed")
            case "rate_limited" => error(StatusCodes.TooManyRequests, "too many emails to this recipient")
            case _ =>
              val messageId = Store.enqueue(tenant, recipient, templateId, subject, variables)
              Store.rememberSend(tenant, key, messageId)
              accepted(messageId)
          }
      }

  val route: Route = path("v1" / "emails") {
    post {
      optionalHeaderValueByName("X-Tenant-Id") { tenantHeader =>
        optionalHeaderValueByName("Idempotency-Key") { keyHeader =>
          entity(as[String]) { raw =>
            val body = raw.parseJson.asJsObject.fields
            val variables = body.get("variables").map(_.convertTo[Map[String, String]]).getOrElse(Map.empty[String, String])
            complete(send(tenantHeader.getOrElse(""), keyHeader.getOrElse(""), text(body, "recipient"), text(body, "template_id"),
              text(body, "subject"), variables))
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

#include <map>
#include <string>

#include "mail/gate.h"   // mail::gate::admit(address) -> "ok", "suppressed" or "rate_limited"
#include "mail/store.h"  // mail::store::enqueue, findSend, rememberSend

using json = nlohmann::json;
namespace store = mail::store;
namespace gate = mail::gate;

void reply(httplib::Response& res, int status, const json& body) {
  res.status = status;
  res.set_content(body.dump(), "application/json");
}

void send_email(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const json body = json::parse(req.body, nullptr, false);
  if (body.is_discarded() || !body.is_object()) return reply(res, 400, {{"error", "invalid body"}});
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  const std::string recipient = body.value("recipient", "");
  const auto variables = body.value("variables", std::map<std::string, std::string>{});
  const std::string message_id = store::enqueue(tenant, recipient, body.value("template_id", ""), body.value("subject", ""), variables);
  const std::string verdict = gate::admit(recipient);
  if (verdict == "suppressed") return reply(res, 409, {{"error", "recipient is suppressed"}});
  if (verdict == "rate_limited") return reply(res, 429, {{"error", "too many emails to this recipient"}});
  reply(res, 202, {{"message_id", message_id}});
}

void register_routes(httplib::Server& svr) { svr.Post("/v1/emails", send_email); }
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <map>
#include <set>
#include <string>

#include "mail/gate.h"   // mail::gate::admit(address) -> "ok", "suppressed" or "rate_limited"
#include "mail/store.h"  // mail::store::enqueue, findSend, rememberSend

using json = nlohmann::json;
namespace store = mail::store;
namespace gate = mail::gate;

const std::set<std::string> kKnownTemplates = {"welcome", "receipt", "password_reset"};
constexpr std::size_t kMaxVariablesBytes = 8 * 1024;

void reply(httplib::Response& res, int status, const json& body) {
  res.status = status;
  res.set_content(body.dump(), "application/json");
}

bool hasCrlf(const std::string& value) { return value.find_first_of("\\r\\n") != std::string::npos; }

void send_email(const httplib::Request& req, httplib::Response& res) {
  const json body = json::parse(req.body, nullptr, false);
  if (body.is_discarded() || !body.is_object()) return reply(res, 400, {{"error", "invalid body"}});
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  const std::string key = req.get_header_value("Idempotency-Key");
  if (key.empty()) return reply(res, 400, {{"error", "Idempotency-Key is required"}});
  const std::string recipient = body.value("recipient", "");
  const std::string template_id = body.value("template_id", "");
  const std::string subject = body.value("subject", "");
  const auto variables = body.value("variables", std::map<std::string, std::string>{});
  if (!kKnownTemplates.count(template_id)) return reply(res, 400, {{"error", "unknown template"}});
  std::size_t size = 0;
  bool crlf = hasCrlf(subject);
  for (const auto& [name, value] : variables) {
    size += name.size() + value.size();
    crlf = crlf || hasCrlf(value);
  }
  if (size > kMaxVariablesBytes) return reply(res, 413, {{"error", "variables over 8 KiB"}});
  if (crlf) return reply(res, 400, {{"error", "line break in the subject or a variable"}});
  if (const auto sent = store::findSend(tenant, key)) return reply(res, 202, {{"message_id", *sent}});  // a retry answers the first message id
  // Every refusal happens before the message reaches the relay's queue.
  const std::string verdict = gate::admit(recipient);
  if (verdict == "suppressed") return reply(res, 409, {{"error", "recipient is suppressed"}});
  if (verdict == "rate_limited") return reply(res, 429, {{"error", "too many emails to this recipient"}});
  const std::string message_id = store::enqueue(tenant, recipient, template_id, subject, variables);
  store::rememberSend(tenant, key, message_id);
  reply(res, 202, {{"message_id", message_id}});
}

void register_routes(httplib::Server& svr) { svr.Post("/v1/emails", send_email); }
`,
    },
  },
  harness: {
    python: `VALID = {"recipient": "ana@example.com", "template_id": "welcome", "subject": "Welcome, Ana", "variables": {"first_name": "Ana"}}


def _api(ctx):
    return ctx.client(ctx.load("api").app)


def _headers(key, tenant="t-1"):
    return {"Idempotency-Key": key, "X-Tenant-Id": tenant}


def _queue(ctx):
    return ctx.redis.lrange("mail:queue", 0, -1)


async def check_route(ctx):
    async with _api(ctx) as c:
        r = await c.post("/v1/emails", json=VALID, headers=_headers("k-1"))
    assert r.status_code == 202, f"POST /v1/emails answered {r.status_code}: {r.text}"
    message_id = r.json().get("message_id")
    assert message_id, f"the 202 must carry the message_id, got {r.text}"
    message = ctx.redis.hgetall(f"mail:msg:{message_id}")
    assert message.get("state") == "queued" and message.get("recipient") == "ana@example.com" and message.get("tenant") == "t-1", f"mail:msg:{message_id} holds {message}, expected a queued message to ana@example.com for t-1"
    assert _queue(ctx) == [message_id], f"mail:queue holds {_queue(ctx)}, expected [{message_id!r}]"


async def check_suppression_first(ctx):
    ctx.redis.sadd("mail:suppressed", "gone@example.com")
    async with _api(ctx) as c:
        r = await c.post("/v1/emails", json={**VALID, "recipient": "gone@example.com"}, headers=_headers("k-1"))
        assert r.status_code == 409, f"a send to a suppressed recipient answered {r.status_code}, expected 409"
        assert _queue(ctx) == [], f"the send was refused with 409, yet mail:queue holds {_queue(ctx)}: the relay will mail the customer who unsubscribed. Ask the gate before enqueueing"
        codes = []
        for n in range(6):
            r = await c.post("/v1/emails", json={**VALID, "recipient": "busy@example.com"}, headers=_headers(f"r-{n}"))
            codes.append(r.status_code)
    assert codes == [202] * 5 + [429], f"six sends to one recipient within a minute answered {codes}, expected five 202 and a 429"
    assert len(_queue(ctx)) == 5, f"after five admitted sends and one refused, mail:queue holds {len(_queue(ctx))} messages, expected 5: a refused send must not be queued"


async def check_idempotency_key(ctx):
    async with _api(ctx) as c:
        first = await c.post("/v1/emails", json=VALID, headers=_headers("k-1"))
        assert first.status_code == 202, f"the first send answered {first.status_code}: {first.text}"
        replay = await c.post("/v1/emails", json=VALID, headers=_headers("k-1"))
        assert replay.status_code == 202 and replay.json().get("message_id") == first.json().get("message_id"), f"a retry with the same Idempotency-Key must answer the first message id: first {first.text}, retry {replay.status_code} {replay.text}"
        assert len(_queue(ctx)) == 1, f"a retry with the same Idempotency-Key left {len(_queue(ctx))} messages on mail:queue: the customer gets the email twice"
        other = await c.post("/v1/emails", json=VALID, headers=_headers("k-1", tenant="t-2"))
        assert other.status_code == 202 and other.json().get("message_id") != first.json().get("message_id"), f"another tenant using the same key is another send, got {other.status_code} {other.text}"
        missing = await c.post("/v1/emails", json=VALID, headers={"X-Tenant-Id": "t-1"})
    assert missing.status_code == 400, f"a send without Idempotency-Key answered {missing.status_code}, expected 400"
    assert len(_queue(ctx)) == 2, f"mail:queue holds {_queue(ctx)}, expected the two distinct sends"


async def check_validate_template_variables(ctx):
    async with _api(ctx) as c:
        r = await c.post("/v1/emails", json={**VALID, "template_id": "promo_blast"}, headers=_headers("k-1"))
        assert r.status_code == 400, f"an unknown template_id answered {r.status_code}, expected 400"
        r = await c.post("/v1/emails", json={**VALID, "variables": {"note": "x" * 9000}}, headers=_headers("k-2"))
        assert r.status_code == 413, f"9 KB of variables answered {r.status_code}, expected 413"
        assert _queue(ctx) == [], f"refused sends were queued: {_queue(ctx)}"
        r = await c.post("/v1/emails", json={**VALID, "variables": {"note": "x" * (8192 - 4)}}, headers=_headers("k-3"))
    assert r.status_code == 202, f"exactly 8 KiB of variables (name and value) answered {r.status_code}, expected 202"
    assert len(_queue(ctx)) == 1, f"mail:queue holds {_queue(ctx)}, expected the one valid send"


async def check_reject_crlf(ctx):
    async with _api(ctx) as c:
        r = await c.post("/v1/emails", json={**VALID, "subject": "Welcome\\r\\nBcc: list@example.net"}, headers=_headers("k-1"))
        assert r.status_code == 400, f"a subject with CRLF answered {r.status_code}, expected 400: the relay writes it into a header line"
        r = await c.post("/v1/emails", json={**VALID, "variables": {"first_name": "Ana\\nBcc: list@example.net"}}, headers=_headers("k-2"))
        assert r.status_code == 400, f"a variable value with a line feed answered {r.status_code}, expected 400"
        assert _queue(ctx) == [], f"sends carrying header injections were queued: {_queue(ctx)}"
        r = await c.post("/v1/emails", json=VALID, headers=_headers("k-3"))
    assert r.status_code == 202, f"a clean send answered {r.status_code}: {r.text}"
`,
    typescript: `const VALID = {recipient: 'ana@example.com', template_id: 'welcome', subject: 'Welcome, Ana', variables: {first_name: 'Ana'}};

const headers = (key: string, tenant = 't-1') => ({'Idempotency-Key': key, 'X-Tenant-Id': tenant});

function api(ctx) {
  const c = ctx.client(ctx.load('api').app);
  const queue = (): string[] => ctx.redis.lrange('mail:queue', 0, -1);
  const send = (body, key: string, tenant = 't-1') => c.post('/v1/emails', {json: body, headers: headers(key, tenant)});
  return {c, queue, send};
}

export async function check_route(ctx) {
  const {queue, send} = api(ctx);
  const r = await send(VALID, 'k-1');
  assert.equal(r.status, 202, \`POST /v1/emails answered \${r.status}: \${r.text}\`);
  const messageId = r.json().message_id;
  assert(messageId, \`the 202 must carry the message_id, got \${r.text}\`);
  const message = ctx.redis.hgetall(\`mail:msg:\${messageId}\`);
  assert(message.state === 'queued' && message.recipient === 'ana@example.com' && message.tenant === 't-1', \`mail:msg:\${messageId} holds \${JSON.stringify(message)}, expected a queued message to ana@example.com for t-1\`);
  assert.deepStrictEqual(queue(), [messageId], \`mail:queue holds \${JSON.stringify(queue())}\`);
}

export async function check_suppression_first(ctx) {
  const {queue, send} = api(ctx);
  ctx.redis.sadd('mail:suppressed', 'gone@example.com');
  let r = await send({...VALID, recipient: 'gone@example.com'}, 'k-1');
  assert.equal(r.status, 409, \`a send to a suppressed recipient answered \${r.status}, expected 409\`);
  assert.deepStrictEqual(queue(), [], \`the send was refused with 409, yet mail:queue holds \${JSON.stringify(queue())}: the relay will mail the customer who unsubscribed. Ask the gate before enqueueing\`);
  const codes: number[] = [];
  for (let n = 0; n < 6; n++) {
    r = await send({...VALID, recipient: 'busy@example.com'}, \`r-\${n}\`);
    codes.push(r.status);
  }
  assert.deepStrictEqual(codes, [202, 202, 202, 202, 202, 429], \`six sends to one recipient within a minute answered \${JSON.stringify(codes)}, expected five 202 and a 429\`);
  assert.equal(queue().length, 5, \`after five admitted sends and one refused, mail:queue holds \${queue().length} messages: a refused send must not be queued\`);
}

export async function check_idempotency_key(ctx) {
  const {c, queue, send} = api(ctx);
  const first = await send(VALID, 'k-1');
  assert.equal(first.status, 202, \`the first send answered \${first.status}: \${first.text}\`);
  const replay = await send(VALID, 'k-1');
  assert(replay.status === 202 && replay.json().message_id === first.json().message_id, \`a retry with the same Idempotency-Key must answer the first message id: first \${first.text}, retry \${replay.status} \${replay.text}\`);
  assert.equal(queue().length, 1, \`a retry with the same Idempotency-Key left \${queue().length} messages on mail:queue: the customer gets the email twice\`);
  const other = await send(VALID, 'k-1', 't-2');
  assert(other.status === 202 && other.json().message_id !== first.json().message_id, \`another tenant using the same key is another send, got \${other.status} \${other.text}\`);
  const missing = await c.post('/v1/emails', {json: VALID, headers: {'X-Tenant-Id': 't-1'}});
  assert.equal(missing.status, 400, \`a send without Idempotency-Key answered \${missing.status}, expected 400\`);
  assert.equal(queue().length, 2, \`mail:queue holds \${JSON.stringify(queue())}, expected the two distinct sends\`);
}

export async function check_validate_template_variables(ctx) {
  const {queue, send} = api(ctx);
  let r = await send({...VALID, template_id: 'promo_blast'}, 'k-1');
  assert.equal(r.status, 400, \`an unknown template_id answered \${r.status}, expected 400\`);
  r = await send({...VALID, variables: {note: 'x'.repeat(9000)}}, 'k-2');
  assert.equal(r.status, 413, \`9 KB of variables answered \${r.status}, expected 413\`);
  assert.deepStrictEqual(queue(), [], \`refused sends were queued: \${JSON.stringify(queue())}\`);
  r = await send({...VALID, variables: {note: 'x'.repeat(8192 - 4)}}, 'k-3');
  assert.equal(r.status, 202, \`exactly 8 KiB of variables (name and value) answered \${r.status}, expected 202\`);
  assert.equal(queue().length, 1, \`mail:queue holds \${JSON.stringify(queue())}, expected the one valid send\`);
}

export async function check_reject_crlf(ctx) {
  const {queue, send} = api(ctx);
  let r = await send({...VALID, subject: 'Welcome\\r\\nBcc: list@example.net'}, 'k-1');
  assert.equal(r.status, 400, \`a subject with CRLF answered \${r.status}, expected 400: the relay writes it into a header line\`);
  r = await send({...VALID, variables: {first_name: 'Ana\\nBcc: list@example.net'}}, 'k-2');
  assert.equal(r.status, 400, \`a variable value with a line feed answered \${r.status}, expected 400\`);
  assert.deepStrictEqual(queue(), [], \`sends carrying header injections were queued: \${JSON.stringify(queue())}\`);
  r = await send(VALID, 'k-3');
  assert.equal(r.status, 202, \`a clean send answered \${r.status}: \${r.text}\`);
}
`,
    go: `package main

import (
	"fmt"
	"net/http"
	"strings"

	"leetbuild/harness"
)

func validBody() map[string]any {
	return map[string]any{"recipient": "ana@example.com", "template_id": "welcome", "subject": "Welcome, Ana", "variables": map[string]string{"first_name": "Ana"}}
}

func withField(name string, value any) map[string]any {
	body := validBody()
	body[name] = value
	return body
}

func api(ctx *harness.Ctx) *harness.HTTP {
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

func post(c *harness.HTTP, body map[string]any, key, tenant string) *harness.Response {
	header := []string{"X-Tenant-Id", tenant}
	if key != "" {
		header = append(header, "Idempotency-Key", key)
	}
	return c.Post("/v1/emails", body, header...)
}

func idOf(r *harness.Response) string {
	var body struct {
		MessageID string \`json:"message_id"\`
	}
	r.Decode(&body)
	return body.MessageID
}

func queue(ctx *harness.Ctx) []string { return ctx.Redis.LRange("mail:queue", 0, -1) }

func CheckRoute(ctx *harness.Ctx) {
	c := api(ctx)
	r := post(c, validBody(), "k-1", "t-1")
	ctx.Equal(r.Status, 202, "POST /v1/emails (%s)", r.Text())
	messageID := idOf(r)
	ctx.Assert(messageID != "", "the 202 must carry the message_id, got %s", r.Text())
	message := ctx.Redis.HGetAll("mail:msg:" + messageID)
	ctx.Assert(message["state"] == "queued" && message["recipient"] == "ana@example.com" && message["tenant"] == "t-1", "mail:msg:%s holds %v, expected a queued message to ana@example.com for t-1", messageID, message)
	ctx.Equal(queue(ctx), []string{messageID}, "mail:queue")
}

func CheckSuppressionFirst(ctx *harness.Ctx) {
	c := api(ctx)
	ctx.Redis.Do("SADD", "mail:suppressed", "gone@example.com")
	r := post(c, withField("recipient", "gone@example.com"), "k-1", "t-1")
	ctx.Equal(r.Status, 409, "a send to a suppressed recipient")
	ctx.Assert(len(queue(ctx)) == 0, "the send was refused with 409, yet mail:queue holds %q: the relay will mail the customer who unsubscribed. Ask the gate before enqueueing", queue(ctx))
	var codes []int
	for n := 0; n < 6; n++ {
		codes = append(codes, post(c, withField("recipient", "busy@example.com"), fmt.Sprintf("r-%d", n), "t-1").Status)
	}
	ctx.Equal(codes, []int{202, 202, 202, 202, 202, 429}, "six sends to one recipient within a minute (five 202 and a 429)")
	ctx.Equal(len(queue(ctx)), 5, "after five admitted sends and one refused, the messages on mail:queue (a refused send must not be queued)")
}

func CheckIdempotencyKey(ctx *harness.Ctx) {
	c := api(ctx)
	first := post(c, validBody(), "k-1", "t-1")
	ctx.Equal(first.Status, 202, "the first send (%s)", first.Text())
	replay := post(c, validBody(), "k-1", "t-1")
	ctx.Assert(replay.Status == 202 && idOf(replay) == idOf(first), "a retry with the same Idempotency-Key must answer the first message id: first %s, retry %d %s", first.Text(), replay.Status, replay.Text())
	ctx.Equal(len(queue(ctx)), 1, "a retry with the same Idempotency-Key must not queue a second copy; the messages on mail:queue")
	other := post(c, validBody(), "k-1", "t-2")
	ctx.Assert(other.Status == 202 && idOf(other) != idOf(first), "another tenant using the same key is another send, got %d %s", other.Status, other.Text())
	missing := post(c, validBody(), "", "t-1")
	ctx.Equal(missing.Status, 400, "a send without Idempotency-Key")
	ctx.Equal(len(queue(ctx)), 2, "the two distinct sends on mail:queue")
}

func CheckValidateTemplateVariables(ctx *harness.Ctx) {
	c := api(ctx)
	r := post(c, withField("template_id", "promo_blast"), "k-1", "t-1")
	ctx.Equal(r.Status, 400, "an unknown template_id")
	r = post(c, withField("variables", map[string]string{"note": strings.Repeat("x", 9000)}), "k-2", "t-1")
	ctx.Equal(r.Status, 413, "9 KB of variables")
	ctx.Assert(len(queue(ctx)) == 0, "refused sends were queued: %q", queue(ctx))
	r = post(c, withField("variables", map[string]string{"note": strings.Repeat("x", 8192-4)}), "k-3", "t-1")
	ctx.Equal(r.Status, 202, "exactly 8 KiB of variables (name and value)")
	ctx.Equal(len(queue(ctx)), 1, "the one valid send on mail:queue")
}

func CheckRejectCrlf(ctx *harness.Ctx) {
	c := api(ctx)
	r := post(c, withField("subject", "Welcome\\r\\nBcc: list@example.net"), "k-1", "t-1")
	ctx.Equal(r.Status, 400, "a subject with CRLF (the relay writes it into a header line)")
	r = post(c, withField("variables", map[string]string{"first_name": "Ana\\nBcc: list@example.net"}), "k-2", "t-1")
	ctx.Equal(r.Status, 400, "a variable value with a line feed")
	ctx.Assert(len(queue(ctx)) == 0, "sends carrying header injections were queued: %q", queue(ctx))
	r = post(c, validBody(), "k-3", "t-1")
	ctx.Equal(r.Status, 202, "a clean send (%s)", r.Text())
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <string>
#include <vector>

namespace {

nlohmann::json validBody() {
  return {{"recipient", "ana@example.com"}, {"template_id", "welcome"}, {"subject", "Welcome, Ana"}, {"variables", {{"first_name", "Ana"}}}};
}

nlohmann::json withField(const std::string& name, const nlohmann::json& value) {
  nlohmann::json body = validBody();
  body[name] = value;
  return body;
}

harness::HTTP api(harness::Ctx& ctx) {
  static httplib::Server* svr = nullptr;
  delete svr;
  svr = new httplib::Server;
  register_routes(*svr);
  return ctx.HTTP(*svr);
}

harness::Response post(harness::HTTP& c, const nlohmann::json& body, const std::string& key, const std::string& tenant) {
  if (key.empty()) return c.Post("/v1/emails", body.dump(), "Content-Type", "application/json", "X-Tenant-Id", tenant);
  return c.Post("/v1/emails", body.dump(), "Content-Type", "application/json", "X-Tenant-Id", tenant, "Idempotency-Key", key);
}

std::string idOf(const harness::Response& r) {
  const auto body = nlohmann::json::parse(r.Text(), nullptr, false);
  return body.is_object() ? body.value("message_id", "") : "";
}

std::vector<std::string> queue(harness::Ctx& ctx) { return ctx.Redis.LRange("mail:queue", 0, -1); }

}  // namespace

void CheckRoute(harness::Ctx& ctx) {
  auto c = api(ctx);
  const auto r = post(c, validBody(), "k-1", "t-1");
  ctx.Equal(r.Status, 202, "POST /v1/emails (%s)", r.Text());
  const std::string message_id = idOf(r);
  ctx.Assert(!message_id.empty(), "the 202 must carry the message_id, got %s", r.Text());
  auto message = ctx.Redis.HGetAll("mail:msg:" + message_id);
  ctx.Assert(message["state"] == "queued" && message["recipient"] == "ana@example.com" && message["tenant"] == "t-1",
             "mail:msg:%s holds %v, expected a queued message to ana@example.com for t-1", message_id, message);
  ctx.Equal(queue(ctx), std::vector<std::string>{message_id}, "mail:queue");
}

void CheckSuppressionFirst(harness::Ctx& ctx) {
  auto c = api(ctx);
  ctx.Redis.Do("SADD", "mail:suppressed", "gone@example.com");
  const auto r = post(c, withField("recipient", "gone@example.com"), "k-1", "t-1");
  ctx.Equal(r.Status, 409, "a send to a suppressed recipient");
  ctx.Assert(queue(ctx).empty(), "the send was refused with 409, yet mail:queue holds %q: the relay will mail the customer who unsubscribed. Ask the gate before enqueueing", queue(ctx));
  std::vector<int> codes;
  for (int n = 0; n < 6; n++) codes.push_back(post(c, withField("recipient", "busy@example.com"), "r-" + std::to_string(n), "t-1").Status);
  ctx.Equal(codes, std::vector<int>{202, 202, 202, 202, 202, 429}, "six sends to one recipient within a minute (five 202 and a 429)");
  ctx.Equal(queue(ctx).size(), 5, "after five admitted sends and one refused, the messages on mail:queue (a refused send must not be queued)");
}

void CheckIdempotencyKey(harness::Ctx& ctx) {
  auto c = api(ctx);
  const auto first = post(c, validBody(), "k-1", "t-1");
  ctx.Equal(first.Status, 202, "the first send (%s)", first.Text());
  const auto replay = post(c, validBody(), "k-1", "t-1");
  ctx.Assert(replay.Status == 202 && idOf(replay) == idOf(first), "a retry with the same Idempotency-Key must answer the first message id: first %s, retry %d %s",
             first.Text(), replay.Status, replay.Text());
  ctx.Equal(queue(ctx).size(), 1, "a retry with the same Idempotency-Key must not queue a second copy; the messages on mail:queue");
  const auto other = post(c, validBody(), "k-1", "t-2");
  ctx.Assert(other.Status == 202 && idOf(other) != idOf(first), "another tenant using the same key is another send, got %d %s", other.Status, other.Text());
  const auto missing = post(c, validBody(), "", "t-1");
  ctx.Equal(missing.Status, 400, "a send without Idempotency-Key");
  ctx.Equal(queue(ctx).size(), 2, "the two distinct sends on mail:queue");
}

void CheckValidateTemplateVariables(harness::Ctx& ctx) {
  auto c = api(ctx);
  auto r = post(c, withField("template_id", "promo_blast"), "k-1", "t-1");
  ctx.Equal(r.Status, 400, "an unknown template_id");
  r = post(c, withField("variables", {{"note", std::string(9000, 'x')}}), "k-2", "t-1");
  ctx.Equal(r.Status, 413, "9 KB of variables");
  ctx.Assert(queue(ctx).empty(), "refused sends were queued: %q", queue(ctx));
  r = post(c, withField("variables", {{"note", std::string(8192 - 4, 'x')}}), "k-3", "t-1");
  ctx.Equal(r.Status, 202, "exactly 8 KiB of variables (name and value)");
  ctx.Equal(queue(ctx).size(), 1, "the one valid send on mail:queue");
}

void CheckRejectCrlf(harness::Ctx& ctx) {
  auto c = api(ctx);
  auto r = post(c, withField("subject", "Welcome\\r\\nBcc: list@example.net"), "k-1", "t-1");
  ctx.Equal(r.Status, 400, "a subject with CRLF (the relay writes it into a header line)");
  r = post(c, withField("variables", {{"first_name", "Ana\\nBcc: list@example.net"}}), "k-2", "t-1");
  ctx.Equal(r.Status, 400, "a variable value with a line feed");
  ctx.Assert(queue(ctx).empty(), "sends carrying header injections were queued: %q", queue(ctx));
  r = post(c, validBody(), "k-3", "t-1");
  ctx.Equal(r.Status, 202, "a clean send (%s)", r.Text());
}
`,
  },
  hints: [
    'Suppress an address and send to it: the API answers 409, yet the message is on `mail:queue` and the relay will mail it. Send twice with one `Idempotency-Key`: two messages are queued.',
    'The handler enqueues first and asks the gate afterwards, so a refusal only changes the status code. Nothing reads the key, the template list or the variables size, and the subject reaches the relay as typed.',
    'Validate first: the key (400), `KNOWN_TEMPLATES` (400), the 8 KiB byte total (413), `has_crlf` on the subject and every value (400). Then `find_send` for a replay, `gate.admit` (409, 429), and only then `enqueue` and `remember_send`.',
  ],
  debrief: `The handler is a funnel: every refusal sits above the one line that hands the message to the relay's queue, because a queued message will be mailed and a refusal after it is only a status code. The idempotency record is keyed by the tenant and the client's key, so a retry after a timeout reads the first message id instead of queueing a copy, and two tenants that pick the same key stay apart. The line-break rule exists because the relay writes the subject into a header line, where a CRLF ends one header and starts another. Production senders also check the address grammar, cap the rendered message rather than its variables, and expire idempotency records after a day or two.`,
};
