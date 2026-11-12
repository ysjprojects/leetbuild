import type {Step} from '@/lib/types';

export const turnEndpointStep: Step = {
  id: 'turn-endpoint',
  title: 'POST /v1/conversations/{id}/messages: verified role, capped, idempotent',
  concept: 'http',
  guides: ['request-boundaries', 'idempotent-requests'],
  file: 'turn_api',
  focus: ['client', 'api', 'db', 'workflow'],
  task: `## Task

**Starting point.** The starter serves \`POST /v1/conversations/{conversation}/messages\` with body
\`{"text": "…"}\`: \`auth.verify\` turns the bearer token into a principal (401 without one), it
builds a turn \`{turn_id, tenant, conversation, actor, role, text}\`, looks it up with \`turns.get\`
under the \`Idempotency-Key\` (or the fresh turn id), stores it with \`turns.put\`, hands it to
\`workflow.enqueue\` and answers 202 \`{"turn_id", "status": "queued"}\`. It serves the demo and hides
4 flaws.

**Failure mode the checks target.** The role decides which tools the reasoning loop may run, and the
starter lets the body name it. Every byte of the text is re-sent to the model on every iteration,
uncapped. A retry without a key, or two replicas handling one retry at once, becomes two turns and two
runs of whatever write tool the model picks.

- \`role\` is the principal's role; a \`role\` in the body changes nothing.
- \`text\` is a non-empty string (**400** otherwise) of at most **8 KiB** of UTF-8
  (\`MAX_TEXT_BYTES = 8 << 10\`, counted in bytes); larger is **413**.
- \`Idempotency-Key\` is required (**400**). A replay of \`(conversation, key)\` answers 202 with the
  stored turn's id and enqueues nothing.
- Check and store in one command: \`turns.claim(conversation, key, turn)\` (one \`SET NX\`) returns the
  turn already stored, if any; only a turn this request stored is enqueued.
- Every rejection happens before anything is stored or enqueued.`,
  sequence: {
    participants: ['Client', 'apv2 API', 'turn store', 'CoT workflow'],
    messages: [
      {from: 'Client', to: 'apv2 API', label: 'POST …/messages · Authorization · Idempotency-Key', kind: 'sync'},
      {from: 'apv2 API', to: 'apv2 API', label: 'auth.verify → principal · 8 KiB cap', kind: 'sync'},
      {from: 'apv2 API', to: 'turn store', label: 'claim(conversation, key, turn) · SET NX', kind: 'sync'},
      {from: 'turn store', to: 'apv2 API', label: 'stored turn / none', kind: 'reply'},
      {from: 'apv2 API', to: 'CoT workflow', label: 'enqueue(turn)', kind: 'async'},
      {from: 'apv2 API', to: 'Client', label: '202 {turn_id, status: queued}', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Handles POST /v1/conversations/{conversation}/messages',
      detail:
        'A message with a valid bearer token answers 202 `{turn_id, status: "queued"}` and enqueues one turn carrying the tenant, conversation, actor and text; no token or an unknown one answers 401 and enqueues nothing.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/conversations\/\{conversation\}\/messages["']/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/conversations\/:conversation\/messages['"]/]},
        go: {all: [/HandleFunc\(\s*"POST \/v1\/conversations\/\{conversation\}\/messages"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"conversations"\s*\/\s*Segment\s*\/\s*"messages"\s*\)/, /\bpost\s*\{/]},
        cpp: {all: [/svr\.Post\(\s*R"\(\/v1\/conversations\//]},
      },
    },
    {
      id: 'principal',
      title: 'Takes the role from the verified principal',
      detail:
        'A guest token with `"role": "agent"` in the body enqueues a turn with role customer; an agent token enqueues role agent. The starter lets the body name the role.',
      match: {
        python: {all: [/principal\.role/], none: [/body\.get\(\s*["']role["']|body\[\s*["']role["']\s*\]/]},
        typescript: {all: [/principal\.role/], none: [/body\.role/]},
        go: {all: [/principal\.Role/], none: [/body\.Role/]},
        scala: {all: [/principal\.role/], none: [/\(\s*"role"\s*\)/]},
        cpp: {all: [/principal->role/], none: [/body\.value\(\s*"role"|body\[\s*"role"\s*\]/]},
      },
    },
    {
      id: 'text-cap',
      title: 'Rejects empty text with 400 and text over 8 KiB of UTF-8 with 413',
      detail:
        'An empty or missing text answers 400; 8193 bytes, or 3000 characters that are 9000 bytes, answer 413; exactly 8192 bytes is accepted; nothing rejected is enqueued. The starter forwards any text to the workflow.',
      match: {
        python: {all: [/MAX_TEXT_BYTES/, /status_code\s*=\s*413/, /\.encode\(/]},
        typescript: {all: [/MAX_TEXT_BYTES/, /code\(\s*413\s*\)/, /TextEncoder|byteLength/]},
        go: {all: [/maxTextBytes/, /StatusRequestEntityTooLarge/]},
        scala: {all: [/MaxTextBytes/, /StatusCodes\.(RequestEntityTooLarge|PayloadTooLarge)/, /getBytes/]},
        cpp: {all: [/kMaxTextBytes/, /\b413\b/]},
      },
    },
    {
      id: 'idempotency-key',
      title: 'Requires Idempotency-Key and answers a replay with the stored turn',
      detail:
        'A message without `Idempotency-Key` answers 400 and enqueues nothing; a replay of the same `(conversation, key)` answers 202 with the first turn id and enqueues nothing; the same key on another conversation is a new turn. The starter falls back to the fresh turn id, so a retry without a key is a second turn.',
      match: {
        python: {all: [/idempotency-key/i, /status_code\s*=\s*400/], none: [/["']idempotency-key["']\s*\)\s*or\b/i]},
        typescript: {all: [/idempotency-key/i, /code\(\s*400\s*\)/], none: [/\|\|\s*turn\.turn_id/]},
        go: {all: [/Idempotency-Key/, /StatusBadRequest/], none: [/idemKey\s*=\s*turn\.TurnID/]},
        scala: {all: [/Idempotency-Key/, /StatusCodes\.BadRequest/], none: [/getOrElse\(\s*turn\.turn_id\s*\)/]},
        cpp: {all: [/Idempotency-Key/, /\b400\b/], none: [/idem_key\s*=\s*turn\["turn_id"\]/]},
      },
    },
    {
      id: 'claim-race',
      title: 'Claims the key in one command, so a concurrent retry enqueues once',
      detail:
        'Another replica stores and enqueues its turn for the same `(conversation, key)` right after this request first touches the key: exactly one turn is enqueued and the answer names the stored turn. The starter reads with `turns.get`, then writes with `turns.put`, and both replicas enqueue.',
      match: {
        python: {all: [/turns\.claim\(/], none: [/turns\.put\(/]},
        typescript: {all: [/turns\.claim\(/], none: [/turns\.put\(/]},
        go: {all: [/turns\.Claim\(/], none: [/turns\.Put\(/]},
        scala: {all: [/Turns\.claim\(/], none: [/Turns\.put\(/]},
        cpp: {all: [/turns::claim\(/], none: [/turns::put\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import logging
import uuid

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from apv2 import auth, turns, workflow  # auth.verify, turns.get/put/claim, workflow.enqueue: provided

app = FastAPI()
logger = logging.getLogger("apv2")


@app.post("/v1/conversations/{conversation}/messages")
async def post_message(conversation: str, request: Request) -> JSONResponse:
    # TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
    principal = auth.verify(request.headers.get("authorization"))
    if principal is None:
        return JSONResponse({"error": "missing or invalid bearer token"}, status_code=401)
    body = await request.json()
    turn = {
        "turn_id": str(uuid.uuid4()),
        "tenant": principal.tenant,
        "conversation": conversation,
        "actor": principal.actor_id,
        "role": body.get("role", principal.role),
        "text": body.get("text", ""),
    }
    idem_key = request.headers.get("idempotency-key") or turn["turn_id"]
    stored = turns.get(conversation, idem_key)
    if stored is not None:
        return JSONResponse({"turn_id": stored["turn_id"], "status": "queued"}, status_code=202)
    turns.put(conversation, idem_key, turn)
    workflow.enqueue(turn)
    logger.info("turn conversation=%s turn=%s role=%s", conversation, turn["turn_id"], turn["role"])
    return JSONResponse({"turn_id": turn["turn_id"], "status": "queued"}, status_code=202)
`,
      solution: `import logging
import uuid

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from apv2 import auth, turns, workflow  # auth.verify, turns.get/put/claim, workflow.enqueue: provided

app = FastAPI()
logger = logging.getLogger("apv2")

MAX_TEXT_BYTES = 8 << 10


@app.post("/v1/conversations/{conversation}/messages")
async def post_message(conversation: str, request: Request) -> JSONResponse:
    principal = auth.verify(request.headers.get("authorization"))
    if principal is None:
        return JSONResponse({"error": "missing or invalid bearer token"}, status_code=401)
    idem_key = request.headers.get("idempotency-key", "")
    if idem_key == "":
        return JSONResponse({"error": "Idempotency-Key is required"}, status_code=400)
    body = await request.json()
    text = body.get("text") if isinstance(body, dict) else None
    if not isinstance(text, str) or text == "":
        return JSONResponse({"error": "text must be a non-empty string"}, status_code=400)
    if len(text.encode("utf-8")) > MAX_TEXT_BYTES:
        return JSONResponse({"error": "text exceeds 8 KiB"}, status_code=413)

    turn = {
        "turn_id": str(uuid.uuid4()),
        "tenant": principal.tenant,
        "conversation": conversation,
        "actor": principal.actor_id,
        "role": principal.role,  # the verified role decides which tools the loop may run
        "text": text,
    }
    stored = turns.claim(conversation, idem_key, turn)  # one SET NX: a concurrent retry finds this turn
    if stored is not None:
        return JSONResponse({"turn_id": stored["turn_id"], "status": "queued"}, status_code=202)
    workflow.enqueue(turn)
    logger.info("turn conversation=%s turn=%s role=%s", conversation, turn["turn_id"], turn["role"])
    return JSONResponse({"turn_id": turn["turn_id"], "status": "queued"}, status_code=202)
`,
    },
    typescript: {
      starter: `import {randomUUID} from 'node:crypto';

import Fastify from 'fastify';

import * as auth from 'apv2/auth';
import type {Turn} from 'apv2/model';
import * as turns from 'apv2/turns';
import * as workflow from 'apv2/workflow';

export const app = Fastify();

app.post('/v1/conversations/:conversation/messages', async (request, reply) => {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  const principal = auth.verify(request.headers.authorization);
  if (principal === null) return reply.code(401).send({error: 'missing or invalid bearer token'});
  const {conversation} = request.params as {conversation: string};
  const body = (request.body ?? {}) as {text?: string; role?: string};
  const turn: Turn = {
    turn_id: randomUUID(),
    tenant: principal.tenant,
    conversation,
    actor: principal.actor_id,
    role: body.role ?? principal.role,
    text: body.text ?? '',
  };
  const idemKey = (request.headers['idempotency-key'] as string | undefined) || turn.turn_id;
  const stored = await turns.get(conversation, idemKey);
  if (stored !== null) return reply.code(202).send({turn_id: stored.turn_id, status: 'queued'});
  await turns.put(conversation, idemKey, turn);
  await workflow.enqueue(turn);
  request.log.info({conversation, turn_id: turn.turn_id, role: turn.role}, 'turn queued');
  return reply.code(202).send({turn_id: turn.turn_id, status: 'queued'});
});
`,
      solution: `import {randomUUID} from 'node:crypto';

import Fastify from 'fastify';

import * as auth from 'apv2/auth';
import type {Turn} from 'apv2/model';
import * as turns from 'apv2/turns';
import * as workflow from 'apv2/workflow';

export const app = Fastify();

export const MAX_TEXT_BYTES = 8 << 10;

app.post('/v1/conversations/:conversation/messages', async (request, reply) => {
  const principal = auth.verify(request.headers.authorization);
  if (principal === null) return reply.code(401).send({error: 'missing or invalid bearer token'});
  const idemKey = request.headers['idempotency-key'];
  if (typeof idemKey !== 'string' || idemKey === '') return reply.code(400).send({error: 'Idempotency-Key is required'});
  const {conversation} = request.params as {conversation: string};
  const {text} = (request.body ?? {}) as {text?: unknown};
  if (typeof text !== 'string' || text === '') return reply.code(400).send({error: 'text must be a non-empty string'});
  if (new TextEncoder().encode(text).length > MAX_TEXT_BYTES) return reply.code(413).send({error: 'text exceeds 8 KiB'});

  const turn: Turn = {
    turn_id: randomUUID(),
    tenant: principal.tenant,
    conversation,
    actor: principal.actor_id,
    role: principal.role, // the verified role decides which tools the loop may run
    text,
  };
  const stored = await turns.claim(conversation, idemKey, turn); // one SET NX: a concurrent retry finds this turn
  if (stored !== null) return reply.code(202).send({turn_id: stored.turn_id, status: 'queued'});
  await workflow.enqueue(turn);
  request.log.info({conversation, turn_id: turn.turn_id, role: turn.role}, 'turn queued');
  return reply.code(202).send({turn_id: turn.turn_id, status: 'queued'});
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"log"
	"net/http"

	"github.com/google/uuid"

	"apv2/auth"     // auth.Verify(header) → principal, ok — provided
	"apv2/model"    // model.Turn
	"apv2/turns"    // turns.Get, turns.Put, turns.Claim — provided
	"apv2/workflow" // workflow.Enqueue — provided
)

type messageRequest struct {
	Text string \`json:"text"\`
	Role string \`json:"role"\`
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func postMessage(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
	principal, ok := auth.Verify(r.Header.Get("Authorization"))
	if !ok {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing or invalid bearer token"})
		return
	}
	var body messageRequest
	json.NewDecoder(r.Body).Decode(&body)
	role := body.Role
	if role == "" {
		role = principal.Role
	}
	conversation := r.PathValue("conversation")
	turn := model.Turn{TurnID: uuid.NewString(), Tenant: principal.Tenant, Conversation: conversation, Actor: principal.ActorID, Role: role, Text: body.Text}
	idemKey := r.Header.Get("Idempotency-Key")
	if idemKey == "" {
		idemKey = turn.TurnID
	}
	stored, err := turns.Get(r.Context(), conversation, idemKey)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	if stored != nil {
		writeJSON(rw, http.StatusAccepted, map[string]string{"turn_id": stored.TurnID, "status": "queued"})
		return
	}
	if err := turns.Put(r.Context(), conversation, idemKey, turn); err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	if err := workflow.Enqueue(r.Context(), turn); err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	log.Printf("turn conversation=%s turn=%s role=%s", conversation, turn.TurnID, turn.Role)
	writeJSON(rw, http.StatusAccepted, map[string]string{"turn_id": turn.TurnID, "status": "queued"})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/conversations/{conversation}/messages", postMessage)
}

func main() {
	mux := http.NewServeMux()
	register(mux)
	log.Fatal(http.ListenAndServe(":8443", mux))
}
`,
      solution: `package main

import (
	"encoding/json"
	"log"
	"net/http"

	"github.com/google/uuid"

	"apv2/auth"     // auth.Verify(header) → principal, ok — provided
	"apv2/model"    // model.Turn
	"apv2/turns"    // turns.Get, turns.Put, turns.Claim — provided
	"apv2/workflow" // workflow.Enqueue — provided
)

const maxTextBytes = 8 << 10

type messageRequest struct {
	Text string \`json:"text"\`
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func postMessage(rw http.ResponseWriter, r *http.Request) {
	principal, ok := auth.Verify(r.Header.Get("Authorization"))
	if !ok {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing or invalid bearer token"})
		return
	}
	idemKey := r.Header.Get("Idempotency-Key")
	if idemKey == "" {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "Idempotency-Key is required"})
		return
	}
	var body messageRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Text == "" {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "text must be a non-empty string"})
		return
	}
	if len(body.Text) > maxTextBytes { // len counts UTF-8 bytes
		writeJSON(rw, http.StatusRequestEntityTooLarge, map[string]string{"error": "text exceeds 8 KiB"})
		return
	}

	conversation := r.PathValue("conversation")
	// The verified role decides which tools the loop may run.
	turn := model.Turn{TurnID: uuid.NewString(), Tenant: principal.Tenant, Conversation: conversation, Actor: principal.ActorID, Role: principal.Role, Text: body.Text}
	stored, err := turns.Claim(r.Context(), conversation, idemKey, turn) // one SET NX: a concurrent retry finds this turn
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	if stored != nil {
		writeJSON(rw, http.StatusAccepted, map[string]string{"turn_id": stored.TurnID, "status": "queued"})
		return
	}
	if err := workflow.Enqueue(r.Context(), turn); err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	log.Printf("turn conversation=%s turn=%s role=%s", conversation, turn.TurnID, turn.Role)
	writeJSON(rw, http.StatusAccepted, map[string]string{"turn_id": turn.TurnID, "status": "queued"})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/conversations/{conversation}/messages", postMessage)
}

func main() {
	mux := http.NewServeMux()
	register(mux)
	log.Fatal(http.ListenAndServe(":8443", mux))
}
`,
    },
    scala: {
      starter: `import java.util.UUID

import scala.util.Try

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route

import apv2.{Auth, Turn, Turns, Workflow}

object TurnApi {
  implicit val system: ActorSystem = ActorSystem("apv2")

  private def json(status: StatusCode, body: ujson.Value): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, ujson.write(body)))

  private def accepted(turnId: String): HttpResponse = json(StatusCodes.Accepted, ujson.Obj("turn_id" -> turnId, "status" -> "queued"))

  val route: Route =
    path("v1" / "conversations" / Segment / "messages") { conversation =>
      post {
        optionalHeaderValueByName("Authorization") { authorization =>
          optionalHeaderValueByName("Idempotency-Key") { idemKey =>
            entity(as[String]) { raw =>
              // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
              Auth.verify(authorization) match {
                case None => complete(json(StatusCodes.Unauthorized, ujson.Obj("error" -> "missing or invalid bearer token")))
                case Some(principal) =>
                  val body = Try(ujson.read(raw)).getOrElse(ujson.Obj())
                  val role = Try(body("role").str).getOrElse(principal.role)
                  val text = Try(body("text").str).getOrElse("")
                  val turn = Turn(UUID.randomUUID().toString, principal.tenant, conversation, principal.actorId, role, text)
                  val key = idemKey.filter(_.nonEmpty).getOrElse(turn.turn_id)
                  Turns.get(conversation, key) match {
                    case Some(stored) => complete(accepted(stored.turn_id))
                    case None =>
                      Turns.put(conversation, key, turn)
                      Workflow.enqueue(turn)
                      system.log.info(s"turn conversation=$conversation turn=\${turn.turn_id} role=\${turn.role}")
                      complete(accepted(turn.turn_id))
                  }
              }
            }
          }
        }
      }
    }

  def main(args: Array[String]): Unit = {
    Http().newServerAt("0.0.0.0", 8443).bind(route)
    ()
  }
}
`,
      solution: `import java.nio.charset.StandardCharsets.UTF_8
import java.util.UUID

import scala.util.Try

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route

import apv2.{Auth, Turn, Turns, Workflow}

object TurnApi {
  implicit val system: ActorSystem = ActorSystem("apv2")

  val MaxTextBytes: Int = 8 << 10

  private def json(status: StatusCode, body: ujson.Value): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, ujson.write(body)))

  private def error(status: StatusCode, message: String): HttpResponse = json(status, ujson.Obj("error" -> message))

  private def accepted(turnId: String): HttpResponse = json(StatusCodes.Accepted, ujson.Obj("turn_id" -> turnId, "status" -> "queued"))

  val route: Route =
    path("v1" / "conversations" / Segment / "messages") { conversation =>
      post {
        optionalHeaderValueByName("Authorization") { authorization =>
          optionalHeaderValueByName("Idempotency-Key") { idemKey =>
            entity(as[String]) { raw =>
              val text = Try(ujson.read(raw)("text").str).getOrElse("")
              Auth.verify(authorization) match {
                case None => complete(error(StatusCodes.Unauthorized, "missing or invalid bearer token"))
                case Some(_) if !idemKey.exists(_.nonEmpty) => complete(error(StatusCodes.BadRequest, "Idempotency-Key is required"))
                case Some(_) if text.isEmpty => complete(error(StatusCodes.BadRequest, "text must be a non-empty string"))
                case Some(_) if text.getBytes(UTF_8).length > MaxTextBytes =>
                  complete(error(StatusCodes.PayloadTooLarge, "text exceeds 8 KiB"))
                case Some(principal) =>
                  // The verified role decides which tools the loop may run.
                  val turn = Turn(UUID.randomUUID().toString, principal.tenant, conversation, principal.actorId, principal.role, text)
                  Turns.claim(conversation, idemKey.get, turn) match { // one SET NX: a concurrent retry finds this turn
                    case Some(stored) => complete(accepted(stored.turn_id))
                    case None =>
                      Workflow.enqueue(turn)
                      system.log.info(s"turn conversation=$conversation turn=\${turn.turn_id} role=\${turn.role}")
                      complete(accepted(turn.turn_id))
                  }
              }
            }
          }
        }
      }
    }

  def main(args: Array[String]): Unit = {
    Http().newServerAt("0.0.0.0", 8443).bind(route)
    ()
  }
}
`,
    },
    cpp: {
      starter: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <iostream>
#include <string>

#include "apv2/auth.h"      // auth::verify(authorization) — provided
#include "apv2/turns.h"     // turns::get, turns::put, turns::claim — provided
#include "apv2/workflow.h"  // workflow::enqueue — provided
#include "ids.h"            // new_uuid() — provided

using json = nlohmann::json;

void reply(httplib::Response& res, int status, const json& body) {
  res.status = status;
  res.set_content(body.dump(), "application/json");
}

void post_message(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  const auto principal = auth::verify(req.get_header_value("Authorization"));
  if (!principal) return reply(res, 401, {{"error", "missing or invalid bearer token"}});
  json body = json::parse(req.body, nullptr, false);
  if (!body.is_object()) body = json::object();
  const std::string conversation = req.matches[1];
  const json turn = {
      {"turn_id", new_uuid()},
      {"tenant", principal->tenant},
      {"conversation", conversation},
      {"actor", principal->actor_id},
      {"role", body.value("role", principal->role)},
      {"text", body.value("text", std::string())},
  };
  std::string idem_key = req.get_header_value("Idempotency-Key");
  if (idem_key.empty()) idem_key = turn["turn_id"];
  if (const auto stored = turns::get(conversation, idem_key)) return reply(res, 202, {{"turn_id", (*stored)["turn_id"]}, {"status", "queued"}});
  turns::put(conversation, idem_key, turn);
  workflow::enqueue(turn);
  std::cerr << "turn conversation=" << conversation << " turn=" << turn["turn_id"].get<std::string>() << " role=" << turn["role"].get<std::string>() << "\\n";
  reply(res, 202, {{"turn_id", turn["turn_id"]}, {"status", "queued"}});
}

void register_routes(httplib::Server& svr) { svr.Post(R"(/v1/conversations/([\\w-]+)/messages)", post_message); }

int main() {
  httplib::Server svr;
  register_routes(svr);
  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <iostream>
#include <string>

#include "apv2/auth.h"      // auth::verify(authorization) — provided
#include "apv2/turns.h"     // turns::get, turns::put, turns::claim — provided
#include "apv2/workflow.h"  // workflow::enqueue — provided
#include "ids.h"            // new_uuid() — provided

using json = nlohmann::json;

constexpr size_t kMaxTextBytes = 8 << 10;

void reply(httplib::Response& res, int status, const json& body) {
  res.status = status;
  res.set_content(body.dump(), "application/json");
}

void post_message(const httplib::Request& req, httplib::Response& res) {
  const auto principal = auth::verify(req.get_header_value("Authorization"));
  if (!principal) return reply(res, 401, {{"error", "missing or invalid bearer token"}});
  const std::string idem_key = req.get_header_value("Idempotency-Key");
  if (idem_key.empty()) return reply(res, 400, {{"error", "Idempotency-Key is required"}});
  const json body = json::parse(req.body, nullptr, false);
  if (!body.is_object() || !body.contains("text") || !body["text"].is_string() || body["text"].get<std::string>().empty()) {
    return reply(res, 400, {{"error", "text must be a non-empty string"}});
  }
  const std::string text = body["text"];
  if (text.size() > kMaxTextBytes) return reply(res, 413, {{"error", "text exceeds 8 KiB"}});  // size() counts UTF-8 bytes

  const std::string conversation = req.matches[1];
  const json turn = {
      {"turn_id", new_uuid()},
      {"tenant", principal->tenant},
      {"conversation", conversation},
      {"actor", principal->actor_id},
      {"role", principal->role},  // the verified role decides which tools the loop may run
      {"text", text},
  };
  // One SET NX: a concurrent retry finds this turn.
  if (const auto stored = turns::claim(conversation, idem_key, turn)) return reply(res, 202, {{"turn_id", (*stored)["turn_id"]}, {"status", "queued"}});
  workflow::enqueue(turn);
  std::cerr << "turn conversation=" << conversation << " turn=" << turn["turn_id"].get<std::string>() << " role=" << principal->role << "\\n";
  reply(res, 202, {{"turn_id", turn["turn_id"]}, {"status", "queued"}});
}

void register_routes(httplib::Server& svr) { svr.Post(R"(/v1/conversations/([\\w-]+)/messages)", post_message); }

int main() {
  httplib::Server svr;
  register_routes(svr);
  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  harness: {
    python: `import json

QUESTION = "Where is my next reservation?"
QUEUE = "apv2:turns"


def _api(ctx):
    return ctx.client(ctx.load("turn_api").app)


async def _post(c, text=QUESTION, conversation="c-1", key="k-1", token="tok-guest-1", body=None):
    headers = {}
    if token is not None:
        headers["Authorization"] = f"Bearer {token}"
    if key is not None:
        headers["Idempotency-Key"] = key
    payload = body if body is not None else {"text": text}
    return await c.post(f"/v1/conversations/{conversation}/messages", json=payload, headers=headers)


def _queued(ctx):
    return [json.loads(raw) for raw in ctx.redis.lrange(QUEUE, 0, -1)]


async def check_route(ctx):
    async with _api(ctx) as c:
        r = await _post(c)
        assert r.status_code == 202, f"a valid message answered {r.status_code}: {r.text}"
        body = r.json()
        assert body.get("turn_id") and body.get("status") == "queued", f"the 202 body must be {{turn_id, status: queued}}, got {body}"
        queued = _queued(ctx)
        assert len(queued) == 1, f"one message must enqueue one turn on apv2:turns, found {len(queued)}"
        turn = queued[0]
        assert turn.get("turn_id") == body["turn_id"], f"the enqueued turn {turn.get('turn_id')!r} is not the one answered ({body['turn_id']!r})"
        for field, value in {"tenant": "t1", "conversation": "c-1", "actor": "guest-1", "text": QUESTION}.items():
            assert turn.get(field) == value, f"the enqueued turn's {field} is {turn.get(field)!r}, expected {value!r}: {turn}"
        r = await _post(c, token=None, key="k-2")
        assert r.status_code == 401, f"a message without a bearer token answered {r.status_code}, expected 401"
        r = await _post(c, token="tok-unknown", key="k-3")
        assert r.status_code == 401, f"a message with an unknown token answered {r.status_code}, expected 401"
        assert len(_queued(ctx)) == 1, "a rejected message must enqueue nothing"


async def check_principal(ctx):
    async with _api(ctx) as c:
        r = await _post(c, body={"text": "Refund my last stay", "role": "agent"})
        assert r.status_code == 202, f"a guest message answered {r.status_code}: {r.text}"
        turn = _queued(ctx)[-1]
        assert turn.get("role") == "customer", f"a guest token with \\"role\\": \\"agent\\" in the body enqueued a turn with role {turn.get('role')!r}: the role must come from the verified principal, or any guest runs agent-only tools"
        r = await _post(c, token="tok-agent-7", conversation="c-2", key="k-2")
        assert r.status_code == 202, f"an agent message answered {r.status_code}: {r.text}"
        turn = _queued(ctx)[-1]
        assert turn.get("role") == "agent" and turn.get("actor") == "agent-7", f"an agent token must enqueue role agent, actor agent-7: {turn}"


async def check_text_cap(ctx):
    async with _api(ctx) as c:
        r = await _post(c, text="", key="k-empty")
        assert r.status_code == 400, f"an empty text answered {r.status_code}, expected 400"
        r = await _post(c, body={}, key="k-none")
        assert r.status_code == 400, f"a body without text answered {r.status_code}, expected 400"
        r = await _post(c, text="a" * 8193, key="k-big")
        assert r.status_code == 413, f"8193 bytes of text answered {r.status_code}, expected 413: every byte is re-sent to the model on every iteration"
        r = await _post(c, text="\\u20ac" * 3000, key="k-euro")
        assert r.status_code == 413, f"3000 euro signs (9000 bytes of UTF-8) answered {r.status_code}, expected 413: the cap counts bytes, not characters"
        assert _queued(ctx) == [], f"rejected messages enqueued {len(_queued(ctx))} turns"
        r = await _post(c, text="a" * 8192, key="k-edge")
        assert r.status_code == 202, f"exactly 8192 bytes is within the cap, got {r.status_code}: {r.text}"


async def check_idempotency_key(ctx):
    async with _api(ctx) as c:
        r = await _post(c, key=None)
        assert r.status_code == 400, f"a message without Idempotency-Key answered {r.status_code}, expected 400: a retry of it could not be told from a new question"
        assert _queued(ctx) == [], "a message without Idempotency-Key must enqueue nothing"
        first = await _post(c, key="k-7")
        assert first.status_code == 202, f"the first message answered {first.status_code}: {first.text}"
        replay = await _post(c, key="k-7")
        assert replay.status_code == 202, f"a replay answered {replay.status_code}, expected 202 with the stored turn"
        assert replay.json().get("turn_id") == first.json().get("turn_id"), f"a replay of (c-1, k-7) answered turn {replay.json().get('turn_id')!r}, the first made {first.json().get('turn_id')!r}"
        assert len(_queued(ctx)) == 1, f"a message and its replay enqueued {len(_queued(ctx))} turns, expected 1"
        other = await _post(c, key="k-7", conversation="c-2")
        assert other.status_code == 202 and other.json().get("turn_id") != first.json().get("turn_id"), "the same key on another conversation is a new turn"


async def check_claim_race(ctx):
    rival = {"turn_id": "rival-turn", "tenant": "t1", "conversation": "c-1", "actor": "guest-1", "role": "customer", "text": QUESTION}

    def rival_replica():
        # Another replica handling the same retry stores its turn and enqueues it.
        if ctx.redis.set("turn:c-1:k-race", json.dumps(rival), ex=86400, nx=True):
            ctx.redis.rpush(QUEUE, json.dumps(rival))

    probe = ctx.redis_after("turn:c-1:k-race", rival_replica)
    async with _api(ctx) as c:
        r = await _post(c, key="k-race")
    assert probe.fired, "the handler never touched turn:c-1:k-race: store the turn under (conversation, Idempotency-Key)"
    assert r.status_code == 202, f"the message answered {r.status_code}: {r.text}"
    queued = _queued(ctx)
    assert len(queued) == 1, f"two replicas handled one retry and {len(queued)} turns were enqueued for one key: a read then a write leaves a gap another replica lands in. Claim the key in one command (turns.claim)"
    stored = json.loads(ctx.redis.get("turn:c-1:k-race"))
    assert r.json().get("turn_id") == stored["turn_id"], f"the answer names turn {r.json().get('turn_id')!r} but the key holds {stored['turn_id']!r}"
`,
    typescript: `const QUESTION = 'Where is my next reservation?';
const QUEUE = 'apv2:turns';

function api(ctx) {
  return ctx.client(ctx.load('turn_api').app);
}

async function post(c, {text = QUESTION, conversation = 'c-1', key = 'k-1' as string | null, token = 'tok-guest-1' as string | null, body = undefined as unknown} = {}) {
  const headers: Record<string, string> = {};
  if (token !== null) headers.Authorization = \`Bearer \${token}\`;
  if (key !== null) headers['Idempotency-Key'] = key;
  return c.post(\`/v1/conversations/\${conversation}/messages\`, {json: body ?? {text}, headers});
}

const queued = (ctx): Record<string, any>[] => ctx.redis.lrange(QUEUE, 0, -1).map((raw: string) => JSON.parse(raw));

export async function check_route(ctx) {
  const c = api(ctx);
  let r = await post(c);
  assert.equal(r.status, 202, \`a valid message answered \${r.status}: \${r.text}\`);
  const body = r.json();
  assert(body.turn_id && body.status === 'queued', \`the 202 body must be {turn_id, status: queued}, got \${r.text}\`);
  const turns = queued(ctx);
  assert.equal(turns.length, 1, \`one message must enqueue one turn on apv2:turns, found \${turns.length}\`);
  assert.equal(turns[0].turn_id, body.turn_id, \`the enqueued turn \${turns[0].turn_id} is not the one answered (\${body.turn_id})\`);
  for (const [field, value] of Object.entries({tenant: 't1', conversation: 'c-1', actor: 'guest-1', text: QUESTION})) {
    assert.equal(turns[0][field], value, \`the enqueued turn's \${field} is \${JSON.stringify(turns[0][field])}, expected \${value}: \${JSON.stringify(turns[0])}\`);
  }
  r = await post(c, {token: null, key: 'k-2'});
  assert.equal(r.status, 401, \`a message without a bearer token answered \${r.status}, expected 401\`);
  r = await post(c, {token: 'tok-unknown', key: 'k-3'});
  assert.equal(r.status, 401, \`a message with an unknown token answered \${r.status}, expected 401\`);
  assert.equal(queued(ctx).length, 1, 'a rejected message must enqueue nothing');
}

export async function check_principal(ctx) {
  const c = api(ctx);
  let r = await post(c, {body: {text: 'Refund my last stay', role: 'agent'}});
  assert.equal(r.status, 202, \`a guest message answered \${r.status}: \${r.text}\`);
  let turn = queued(ctx).at(-1);
  assert.equal(turn.role, 'customer', \`a guest token with "role": "agent" in the body enqueued a turn with role \${turn.role}: the role must come from the verified principal, or any guest runs agent-only tools\`);
  r = await post(c, {token: 'tok-agent-7', conversation: 'c-2', key: 'k-2'});
  assert.equal(r.status, 202, \`an agent message answered \${r.status}: \${r.text}\`);
  turn = queued(ctx).at(-1);
  assert(turn.role === 'agent' && turn.actor === 'agent-7', \`an agent token must enqueue role agent, actor agent-7: \${JSON.stringify(turn)}\`);
}

export async function check_text_cap(ctx) {
  const c = api(ctx);
  let r = await post(c, {text: '', key: 'k-empty'});
  assert.equal(r.status, 400, \`an empty text answered \${r.status}, expected 400\`);
  r = await post(c, {body: {}, key: 'k-none'});
  assert.equal(r.status, 400, \`a body without text answered \${r.status}, expected 400\`);
  r = await post(c, {text: 'a'.repeat(8193), key: 'k-big'});
  assert.equal(r.status, 413, \`8193 bytes of text answered \${r.status}, expected 413: every byte is re-sent to the model on every iteration\`);
  r = await post(c, {text: '\\u20ac'.repeat(3000), key: 'k-euro'});
  assert.equal(r.status, 413, \`3000 euro signs (9000 bytes of UTF-8) answered \${r.status}, expected 413: the cap counts bytes, not characters\`);
  assert.equal(queued(ctx).length, 0, \`rejected messages enqueued \${queued(ctx).length} turns\`);
  r = await post(c, {text: 'a'.repeat(8192), key: 'k-edge'});
  assert.equal(r.status, 202, \`exactly 8192 bytes is within the cap, got \${r.status}: \${r.text}\`);
}

export async function check_idempotency_key(ctx) {
  const c = api(ctx);
  const noKey = await post(c, {key: null});
  assert.equal(noKey.status, 400, \`a message without Idempotency-Key answered \${noKey.status}, expected 400: a retry of it could not be told from a new question\`);
  assert.equal(queued(ctx).length, 0, 'a message without Idempotency-Key must enqueue nothing');
  const first = await post(c, {key: 'k-7'});
  assert.equal(first.status, 202, \`the first message answered \${first.status}: \${first.text}\`);
  const replay = await post(c, {key: 'k-7'});
  assert.equal(replay.status, 202, \`a replay answered \${replay.status}, expected 202 with the stored turn\`);
  assert.equal(replay.json().turn_id, first.json().turn_id, \`a replay of (c-1, k-7) answered turn \${replay.json().turn_id}, the first made \${first.json().turn_id}\`);
  assert.equal(queued(ctx).length, 1, \`a message and its replay enqueued \${queued(ctx).length} turns, expected 1\`);
  const other = await post(c, {key: 'k-7', conversation: 'c-2'});
  assert(other.status === 202 && other.json().turn_id !== first.json().turn_id, 'the same key on another conversation is a new turn');
}

export async function check_claim_race(ctx) {
  const rival = {turn_id: 'rival-turn', tenant: 't1', conversation: 'c-1', actor: 'guest-1', role: 'customer', text: QUESTION};
  const probe = ctx.redisAfter('turn:c-1:k-race', () => {
    // Another replica handling the same retry stores its turn and enqueues it.
    if (ctx.redis.set('turn:c-1:k-race', JSON.stringify(rival), 'EX', 86400, 'NX') === 'OK') ctx.redis.rpush(QUEUE, JSON.stringify(rival));
  });
  const r = await post(api(ctx), {key: 'k-race'});
  assert(probe.fired, 'the handler never touched turn:c-1:k-race: store the turn under (conversation, Idempotency-Key)');
  assert.equal(r.status, 202, \`the message answered \${r.status}: \${r.text}\`);
  const turns = queued(ctx);
  assert.equal(turns.length, 1, \`two replicas handled one retry and \${turns.length} turns were enqueued for one key: a read then a write leaves a gap another replica lands in. Claim the key in one command (turns.claim)\`);
  const stored = JSON.parse(ctx.redis.get('turn:c-1:k-race'));
  assert.equal(r.json().turn_id, stored.turn_id, \`the answer names turn \${r.json().turn_id} but the key holds \${stored.turn_id}\`);
}
`,
    go: `package main

import (
	"encoding/json"
	"net/http"
	"strings"

	"leetbuild/harness"
)

const apiQuestion = "Where is my next reservation?"

func apiClient(ctx *harness.Ctx) *harness.HTTP {
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

func apiPost(c *harness.HTTP, conversation, key, token string, body any) *harness.Response {
	var headers []string
	if token != "" {
		headers = append(headers, "Authorization", "Bearer "+token)
	}
	if key != "" {
		headers = append(headers, "Idempotency-Key", key)
	}
	return c.Post("/v1/conversations/"+conversation+"/messages", body, headers...)
}

func apiText(text string) map[string]any { return map[string]any{"text": text} }

func apiQueued(ctx *harness.Ctx) []map[string]any {
	var out []map[string]any
	for _, raw := range ctx.Redis.LRange("apv2:turns", 0, -1) {
		var turn map[string]any
		ctx.NoError(json.Unmarshal([]byte(raw), &turn), "an enqueued turn must be JSON: %s", raw)
		out = append(out, turn)
	}
	return out
}

func apiTurnID(ctx *harness.Ctx, r *harness.Response) string {
	body, ok := r.JSON().(map[string]any)
	ctx.Assert(ok, "the body must be a JSON object: %s", r.Text())
	id, _ := body["turn_id"].(string)
	return id
}

func CheckRoute(ctx *harness.Ctx) {
	c := apiClient(ctx)
	r := apiPost(c, "c-1", "k-1", "tok-guest-1", apiText(apiQuestion))
	ctx.Equal(r.Status, 202, "a valid message (%s)", r.Text())
	body, _ := r.JSON().(map[string]any)
	ctx.Assert(body["turn_id"] != nil && body["turn_id"] != "" && body["status"] == "queued", "the 202 body must be {turn_id, status: queued}, got %s", r.Text())
	queued := apiQueued(ctx)
	ctx.Equal(len(queued), 1, "one message must enqueue one turn on apv2:turns; turns enqueued")
	ctx.Equal(queued[0]["turn_id"], body["turn_id"], "the enqueued turn must be the one answered")
	for field, value := range map[string]string{"tenant": "t1", "conversation": "c-1", "actor": "guest-1", "text": apiQuestion} {
		ctx.Equal(queued[0][field], value, "the enqueued turn's %s (%v)", field, queued[0])
	}
	ctx.Equal(apiPost(c, "c-1", "k-2", "", apiText(apiQuestion)).Status, 401, "a message without a bearer token")
	ctx.Equal(apiPost(c, "c-1", "k-3", "tok-unknown", apiText(apiQuestion)).Status, 401, "a message with an unknown token")
	ctx.Equal(len(apiQueued(ctx)), 1, "a rejected message must enqueue nothing; turns enqueued")
}

func CheckPrincipal(ctx *harness.Ctx) {
	c := apiClient(ctx)
	r := apiPost(c, "c-1", "k-1", "tok-guest-1", map[string]any{"text": "Refund my last stay", "role": "agent"})
	ctx.Equal(r.Status, 202, "a guest message (%s)", r.Text())
	queued := apiQueued(ctx)
	ctx.Equal(queued[len(queued)-1]["role"], "customer", "a guest token with \\"role\\": \\"agent\\" in the body: the enqueued turn's role must come from the verified principal, or any guest runs agent-only tools; the role")
	r = apiPost(c, "c-2", "k-2", "tok-agent-7", apiText(apiQuestion))
	ctx.Equal(r.Status, 202, "an agent message (%s)", r.Text())
	queued = apiQueued(ctx)
	turn := queued[len(queued)-1]
	ctx.Assert(turn["role"] == "agent" && turn["actor"] == "agent-7", "an agent token must enqueue role agent, actor agent-7: %v", turn)
}

func CheckTextCap(ctx *harness.Ctx) {
	c := apiClient(ctx)
	ctx.Equal(apiPost(c, "c-1", "k-empty", "tok-guest-1", apiText("")).Status, 400, "an empty text")
	ctx.Equal(apiPost(c, "c-1", "k-none", "tok-guest-1", map[string]any{}).Status, 400, "a body without text")
	ctx.Equal(apiPost(c, "c-1", "k-big", "tok-guest-1", apiText(strings.Repeat("a", 8193))).Status, 413, "8193 bytes of text (every byte is re-sent to the model on every iteration)")
	ctx.Equal(apiPost(c, "c-1", "k-euro", "tok-guest-1", apiText(strings.Repeat("\\u20ac", 3000))).Status, 413, "3000 euro signs, 9000 bytes of UTF-8 (the cap counts bytes, not characters)")
	ctx.Equal(len(apiQueued(ctx)), 0, "rejected messages must enqueue nothing; turns enqueued")
	r := apiPost(c, "c-1", "k-edge", "tok-guest-1", apiText(strings.Repeat("a", 8192)))
	ctx.Equal(r.Status, 202, "exactly 8192 bytes is within the cap (%s)", r.Text())
}

func CheckIdempotencyKey(ctx *harness.Ctx) {
	c := apiClient(ctx)
	ctx.Equal(apiPost(c, "c-1", "", "tok-guest-1", apiText(apiQuestion)).Status, 400, "a message without Idempotency-Key (a retry of it could not be told from a new question)")
	ctx.Equal(len(apiQueued(ctx)), 0, "a message without Idempotency-Key must enqueue nothing; turns enqueued")
	first := apiPost(c, "c-1", "k-7", "tok-guest-1", apiText(apiQuestion))
	ctx.Equal(first.Status, 202, "the first message (%s)", first.Text())
	replay := apiPost(c, "c-1", "k-7", "tok-guest-1", apiText(apiQuestion))
	ctx.Equal(replay.Status, 202, "a replay must answer 202 with the stored turn")
	ctx.Equal(apiTurnID(ctx, replay), apiTurnID(ctx, first), "a replay of (c-1, k-7) must answer the first turn id")
	ctx.Equal(len(apiQueued(ctx)), 1, "a message and its replay; turns enqueued")
	other := apiPost(c, "c-2", "k-7", "tok-guest-1", apiText(apiQuestion))
	ctx.Assert(other.Status == 202 && apiTurnID(ctx, other) != apiTurnID(ctx, first), "the same key on another conversation is a new turn")
}

func CheckClaimRace(ctx *harness.Ctx) {
	rival, _ := json.Marshal(map[string]string{"turn_id": "rival-turn", "tenant": "t1", "conversation": "c-1", "actor": "guest-1", "role": "customer", "text": apiQuestion})
	probe := ctx.Redis.After("turn:c-1:k-race", func() any {
		// Another replica handling the same retry stores its turn and enqueues it.
		if ctx.Redis.Set("turn:c-1:k-race", string(rival), "EX", 86400, "NX") {
			ctx.Redis.Do("RPUSH", "apv2:turns", string(rival))
		}
		return nil
	})
	r := apiPost(apiClient(ctx), "c-1", "k-race", "tok-guest-1", apiText(apiQuestion))
	ctx.Assert(probe.Fired, "the handler never touched turn:c-1:k-race: store the turn under (conversation, Idempotency-Key)")
	ctx.Equal(r.Status, 202, "the message (%s)", r.Text())
	ctx.Equal(len(apiQueued(ctx)), 1, "two replicas handled one retry: a read then a write leaves a gap another replica lands in, so claim the key in one command (turns.Claim); turns enqueued for one key")
	raw, _ := ctx.Redis.Get("turn:c-1:k-race")
	var stored map[string]any
	json.Unmarshal([]byte(raw), &stored)
	ctx.Equal(apiTurnID(ctx, r), stored["turn_id"], "the answer must name the turn the key holds")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <string>
#include <vector>

namespace {

using json = nlohmann::json;

const std::string kQuestion = "Where is my next reservation?";

struct Api {
  httplib::Server svr;
  harness::HTTP http;
  explicit Api(harness::Ctx& ctx) : http(ctx.HTTP(svr)) { register_routes(svr); }

  harness::Response post(const json& body, const std::string& conversation = "c-1", const std::string& key = "k-1",
                         const std::string& token = "tok-guest-1") {
    const std::string path = "/v1/conversations/" + conversation + "/messages";
    if (token.empty()) return http.Post(path, body.dump(), "Idempotency-Key", key);
    if (key.empty()) return http.Post(path, body.dump(), "Authorization", "Bearer " + token);
    return http.Post(path, body.dump(), "Authorization", "Bearer " + token, "Idempotency-Key", key);
  }
};

json text(const std::string& t) { return {{"text", t}}; }

std::vector<json> queued(harness::Ctx& ctx) {
  std::vector<json> out;
  for (const auto& raw : ctx.Redis.LRange("apv2:turns", 0, -1)) out.push_back(json::parse(raw, nullptr, false));
  return out;
}

std::string turnId(const harness::Response& r) {
  const json body = json::parse(r.Text(), nullptr, false);
  return body.is_object() && body.contains("turn_id") && body["turn_id"].is_string() ? body["turn_id"].get<std::string>() : "";
}

std::string repeat(const std::string& s, int n) {
  std::string out;
  for (int i = 0; i < n; i++) out += s;
  return out;
}

}  // namespace

void CheckRoute(harness::Ctx& ctx) {
  Api api(ctx);
  const auto r = api.post(text(kQuestion));
  ctx.Equal(r.Status, 202, "a valid message (%s)", r.Text());
  const json body = json::parse(r.Text(), nullptr, false);
  ctx.Assert(body.is_object() && !turnId(r).empty() && body.value("status", "") == "queued", "the 202 body must be {turn_id, status: queued}, got %s", r.Text());
  const auto turns = queued(ctx);
  ctx.Equal(turns.size(), 1, "one message must enqueue one turn on apv2:turns; turns enqueued");
  ctx.Equal(turns[0].value("turn_id", ""), turnId(r), "the enqueued turn must be the one answered");
  for (const auto& [field, value] : std::vector<std::pair<std::string, std::string>>{{"tenant", "t1"}, {"conversation", "c-1"}, {"actor", "guest-1"}, {"text", kQuestion}}) {
    ctx.Equal(turns[0].value(field, ""), value, "the enqueued turn's %s (%s)", field, turns[0].dump());
  }
  ctx.Equal(api.post(text(kQuestion), "c-1", "k-2", "").Status, 401, "a message without a bearer token");
  ctx.Equal(api.post(text(kQuestion), "c-1", "k-3", "tok-unknown").Status, 401, "a message with an unknown token");
  ctx.Equal(queued(ctx).size(), 1, "a rejected message must enqueue nothing; turns enqueued");
}

void CheckPrincipal(harness::Ctx& ctx) {
  Api api(ctx);
  auto r = api.post({{"text", "Refund my last stay"}, {"role", "agent"}});
  ctx.Equal(r.Status, 202, "a guest message (%s)", r.Text());
  ctx.Equal(queued(ctx).back().value("role", ""), "customer",
            "a guest token with \\"role\\": \\"agent\\" in the body: the enqueued turn's role must come from the verified principal, or any guest runs agent-only tools; the role");
  r = api.post(text(kQuestion), "c-2", "k-2", "tok-agent-7");
  ctx.Equal(r.Status, 202, "an agent message (%s)", r.Text());
  const json turn = queued(ctx).back();
  ctx.Assert(turn.value("role", "") == "agent" && turn.value("actor", "") == "agent-7", "an agent token must enqueue role agent, actor agent-7: %s", turn.dump());
}

void CheckTextCap(harness::Ctx& ctx) {
  Api api(ctx);
  ctx.Equal(api.post(text(""), "c-1", "k-empty").Status, 400, "an empty text");
  ctx.Equal(api.post(json::object(), "c-1", "k-none").Status, 400, "a body without text");
  ctx.Equal(api.post(text(std::string(8193, 'a')), "c-1", "k-big").Status, 413, "8193 bytes of text (every byte is re-sent to the model on every iteration)");
  ctx.Equal(api.post(text(repeat("\\u20ac", 3000)), "c-1", "k-euro").Status, 413, "3000 euro signs, 9000 bytes of UTF-8 (the cap counts bytes, not characters)");
  ctx.Equal(queued(ctx).size(), 0, "rejected messages must enqueue nothing; turns enqueued");
  const auto r = api.post(text(std::string(8192, 'a')), "c-1", "k-edge");
  ctx.Equal(r.Status, 202, "exactly 8192 bytes is within the cap (%s)", r.Text());
}

void CheckIdempotencyKey(harness::Ctx& ctx) {
  Api api(ctx);
  ctx.Equal(api.post(text(kQuestion), "c-1", "").Status, 400, "a message without Idempotency-Key (a retry of it could not be told from a new question)");
  ctx.Equal(queued(ctx).size(), 0, "a message without Idempotency-Key must enqueue nothing; turns enqueued");
  const auto first = api.post(text(kQuestion), "c-1", "k-7");
  ctx.Equal(first.Status, 202, "the first message (%s)", first.Text());
  const auto replay = api.post(text(kQuestion), "c-1", "k-7");
  ctx.Equal(replay.Status, 202, "a replay must answer 202 with the stored turn");
  ctx.Equal(turnId(replay), turnId(first), "a replay of (c-1, k-7) must answer the first turn id");
  ctx.Equal(queued(ctx).size(), 1, "a message and its replay; turns enqueued");
  const auto other = api.post(text(kQuestion), "c-2", "k-7");
  ctx.Assert(other.Status == 202 && turnId(other) != turnId(first), "the same key on another conversation is a new turn");
}

void CheckClaimRace(harness::Ctx& ctx) {
  const json rival = {{"turn_id", "rival-turn"}, {"tenant", "t1"}, {"conversation", "c-1"}, {"actor", "guest-1"}, {"role", "customer"}, {"text", kQuestion}};
  bool fired = false;
  ctx.Redis.After("turn:c-1:k-race", [&] {
    fired = true;
    // Another replica handling the same retry stores its turn and enqueues it.
    if (ctx.Redis.Set("turn:c-1:k-race", rival.dump(), "EX", 86400, "NX")) ctx.Redis.Do("RPUSH", "apv2:turns", rival.dump());
  });
  Api api(ctx);
  const auto r = api.post(text(kQuestion), "c-1", "k-race");
  ctx.Assert(fired, "the handler never touched turn:c-1:k-race: store the turn under (conversation, Idempotency-Key)");
  ctx.Equal(r.Status, 202, "the message (%s)", r.Text());
  ctx.Equal(queued(ctx).size(), 1,
            "two replicas handled one retry: a read then a write leaves a gap another replica lands in, so claim the key in one command (turns::claim); turns enqueued for one key");
  const json stored = json::parse(ctx.Redis.Get("turn:c-1:k-race").value_or("{}"), nullptr, false);
  ctx.Equal(turnId(r), stored.value("turn_id", ""), "the answer must name the turn the key holds");
}
`,
  },
  hints: [
    "Symptom: a guest's message reaches the workflow as an agent turn, a pasted 50 KB log is accepted, and a client that retried once, or whose retry two replicas handled together, gets two answers.",
    'Mechanism: the handler copies `role` from the body, never measures the text, falls back to the fresh turn id when `Idempotency-Key` is missing, and reads (`turns.get`) then writes (`turns.put`), leaving a gap a second replica lands in.',
    'Change: role from the principal; 400 without `Idempotency-Key` or text, 413 above `MAX_TEXT_BYTES` counted in UTF-8 bytes; replace get and put with `turns.claim(conversation, key, turn)` and enqueue only when it returns nothing.',
  ],
  debrief: `The handler trusts only what it verified and stores before it acts. The role rides on the principal because it decides which tools the reasoning loop may run; a body field is a self-granted privilege. The byte cap matters more here than on an ordinary API, since every byte is re-sent to the model on every iteration. The key is scoped to the conversation and claimed with one \`SET NX\`, so a retry handled by two replicas at once still yields one turn: a read followed by a write is a check whose answer is stale by the time it is used. Production platforms also check that the actor owns the conversation, rate-limit per actor, and mint a trace id here that every span of the turn carries.`,
};
