import type {Step} from '@/lib/types';

export const turnEndpointStep: Step = {
  id: 'turn-endpoint',
  title: 'POST /v1/conversations/{id}/messages: verified role, capped, idempotent',
  concept: 'http',
  file: 'turn_api',
  focus: ['client', 'api', 'db', 'workflow'],
  task: `## Task

**Starting point.** The starter registers \`POST /v1/conversations/{conversation}/messages\` with
body \`{"text": "…"}\`, parses the body, runs the Chain of Thought workflow inside the request and
answers 200 with the model's text. It serves the demo and hides 4 flaws.

**Failure mode the checks target.** A role read from the body lets any customer run agent-only
tools; an uncapped \`text\` is re-sent to the model on every iteration; an endpoint without an
idempotency key turns one client retry into two turns and two executions of whatever write tool
the model chose; a loop run inline lets the HTTP timeout, not the platform, end the turn.

- The actor comes from the verified bearer token: \`auth.verify(authorization)\` returns the
  principal (tenant, actor id, role) or nothing. No principal is **401**. The **role** is the
  principal's role, not a field of the body.
- \`text\` is a non-empty string of at most **8 KiB** (\`8 << 10\` bytes) of UTF-8; empty is
  **400**, larger is **413**.
- \`Idempotency-Key\` is required (**400** when missing). A retry with the same
  \`(conversation, key)\` returns the stored turn instead of starting a second one.
- The turn is **enqueued** for the workflow (\`workflow.enqueue\`) and the response is **202**
  with \`{"turn_id": "…"}\`.
- Log conversation, turn id and role, not the text.`,
  sequence: {
    participants: ['Client', 'apv2 API', 'turn store', 'CoT workflow'],
    messages: [
      {from: 'Client', to: 'apv2 API', label: 'POST …/messages · Authorization · Idempotency-Key', kind: 'sync'},
      {from: 'apv2 API', to: 'apv2 API', label: 'auth.verify → principal · caps', kind: 'sync'},
      {from: 'apv2 API', to: 'turn store', label: 'get(conversation, idem_key)', kind: 'sync'},
      {from: 'turn store', to: 'apv2 API', label: 'stored turn / none', kind: 'reply'},
      {from: 'apv2 API', to: 'turn store', label: 'put(conversation, idem_key, turn)', kind: 'sync'},
      {from: 'apv2 API', to: 'CoT workflow', label: 'enqueue(turn)', kind: 'async'},
      {from: 'apv2 API', to: 'Client', label: '202 {turn_id}', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Handles POST /v1/conversations/{conversation}/messages',
      detail: 'Register the message route on `POST /v1/conversations/{conversation}/messages`.',
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
      title: 'Takes the role from the verified principal, 401 without one',
      detail:
        'The bearer token is verified with `auth.verify`; no principal is **401**, and the turn carries the principal’s role. The starter takes `role` from the request body, so a customer can claim to be an agent.',
      match: {
        python: {all: [/auth\.verify\(/, /status_code\s*=\s*401/], none: [/body\.role/]},
        typescript: {all: [/auth\.verify\(/, /code\(\s*401\s*\)/], none: [/body\.role/]},
        go: {all: [/auth\.Verify\(/, /StatusUnauthorized/], none: [/body\.Role/]},
        scala: {all: [/Auth\.verify\(/, /StatusCodes\.Unauthorized/], none: [/body\.role/]},
        cpp: {all: [/auth\.verify\(/, /\b401\b/], none: [/body\.value\(\s*"role"/, /body\["role"\]/]},
      },
    },
    {
      id: 'caps',
      title: 'Rejects empty text with 400 and text over 8 KiB with 413',
      detail:
        'A `MAX_TEXT_BYTES` cap of `8 << 10` bytes answers **413**, an empty `text` answers **400**. The starter forwards whatever arrives to the workflow, where every reasoning iteration re-sends it to the model.',
      match: {
        python: {all: [/MAX_TEXT_BYTES/, /status_code\s*=\s*413/, /status_code\s*=\s*400/]},
        typescript: {all: [/MAX_TEXT_BYTES/, /code\(\s*413\s*\)/, /code\(\s*400\s*\)/]},
        go: {all: [/maxTextBytes/, /StatusRequestEntityTooLarge/, /StatusBadRequest/]},
        scala: {all: [/MaxTextBytes/, /StatusCodes\.RequestEntityTooLarge/, /StatusCodes\.BadRequest/]},
        cpp: {all: [/kMaxTextBytes/, /\b413\b/, /\b400\b/]},
      },
    },
    {
      id: 'idempotency',
      title: 'Keys retries by (conversation, Idempotency-Key)',
      detail:
        '`Idempotency-Key` is required and the turn is stored under `(conversation, key)`; a replay returns the stored turn instead of enqueuing a second one. The starter ignores the header and starts a new turn per request.',
      match: {
        python: {all: [/Idempotency-Key/, /turns\.get\(/, /turns\.put\(/]},
        typescript: {all: [/idempotency-key/, /turns\.get\(/, /turns\.put\(/]},
        go: {all: [/Idempotency-Key/, /turns\.Get\(/, /turns\.Put\(/]},
        scala: {all: [/Idempotency-Key/, /turns\.get\(/, /turns\.put\(/]},
        cpp: {all: [/Idempotency-Key/, /turns\.get\(/, /turns\.put\(/]},
      },
    },
    {
      id: 'accepted',
      title: 'Enqueues the turn and answers 202',
      detail:
        'The turn is handed to the workflow with `enqueue` and the handler answers **202** with the turn id. The starter runs the whole reasoning loop inside the request and answers 200 with the text.',
      match: {
        python: {all: [/workflow\.enqueue\(/, /status_code\s*=\s*202/], none: [/workflow\.run\(/]},
        typescript: {all: [/workflow\.enqueue\(/, /code\(\s*202\s*\)/], none: [/workflow\.run\(/]},
        go: {all: [/workflow\.Enqueue\(/, /StatusAccepted/], none: [/workflow\.Run\(/]},
        scala: {all: [/workflow\.enqueue\(/, /StatusCodes\.Accepted/], none: [/workflow\.run\(/]},
        cpp: {all: [/workflow\.enqueue\(/, /\b202\b/], none: [/workflow\.run\(/]},
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
logger = logging.getLogger("apv2")


class MessageRequest(BaseModel):
    text: str
    role: str = "customer"


class Principal:
    tenant: str
    actor_id: str
    role: str


class Auth:
    def verify(self, authorization: str | None) -> Principal | None:
        """The principal behind a bearer token, or None when missing or invalid."""
        raise NotImplementedError


class TurnStore:
    def get(self, conversation: str, idem_key: str) -> dict | None:
        """The turn stored for (conversation, idem_key), if any."""
        raise NotImplementedError

    def put(self, conversation: str, idem_key: str, turn: dict) -> None:
        """Store the turn under (conversation, idem_key)."""
        raise NotImplementedError


class Workflow:
    def run(self, turn: dict) -> dict:
        """Run the Chain of Thought loop to completion and return the answer."""
        raise NotImplementedError

    def enqueue(self, turn: dict) -> None:
        """Hand the turn to the workflow engine; it runs outside the request."""
        raise NotImplementedError


auth = Auth()
turns = TurnStore()
workflow = Workflow()


@app.post("/v1/conversations/{conversation}/messages")
def post_message(
    conversation: str,
    body: MessageRequest,
    authorization: str | None = Header(default=None),
) -> JSONResponse:
    # TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
    principal = auth.verify(authorization)
    actor = principal.actor_id if principal is not None else "anonymous"
    turn = {
        "turn_id": str(uuid.uuid4()),
        "conversation": conversation,
        "actor": actor,
        "role": body.role,
        "text": body.text,
    }
    logger.info("turn conversation=%s actor=%s text=%r", conversation, actor, body.text)
    answer = workflow.run(turn)
    return JSONResponse({"turn_id": turn["turn_id"], "answer": answer["text"]}, status_code=200)
`,
      solution: `import logging
import uuid

from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()
logger = logging.getLogger("apv2")

MAX_TEXT_BYTES = 8 << 10


class MessageRequest(BaseModel):
    text: str


class Principal:
    tenant: str
    actor_id: str
    role: str


class Auth:
    def verify(self, authorization: str | None) -> Principal | None:
        """The principal behind a bearer token, or None when missing or invalid."""
        raise NotImplementedError


class TurnStore:
    def get(self, conversation: str, idem_key: str) -> dict | None:
        """The turn stored for (conversation, idem_key), if any."""
        raise NotImplementedError

    def put(self, conversation: str, idem_key: str, turn: dict) -> None:
        """Store the turn under (conversation, idem_key)."""
        raise NotImplementedError


class Workflow:
    def run(self, turn: dict) -> dict:
        """Run the Chain of Thought loop to completion and return the answer."""
        raise NotImplementedError

    def enqueue(self, turn: dict) -> None:
        """Hand the turn to the workflow engine; it runs outside the request."""
        raise NotImplementedError


auth = Auth()
turns = TurnStore()
workflow = Workflow()


@app.post("/v1/conversations/{conversation}/messages")
def post_message(
    conversation: str,
    body: MessageRequest,
    authorization: str | None = Header(default=None),
    idem_key: str | None = Header(default=None, alias="Idempotency-Key"),
) -> JSONResponse:
    principal = auth.verify(authorization)
    if principal is None:
        raise HTTPException(status_code=401, detail="missing or invalid bearer token")
    if idem_key is None or idem_key == "":
        raise HTTPException(status_code=400, detail="Idempotency-Key is required")
    if body.text == "":
        raise HTTPException(status_code=400, detail="text must be a non-empty string")
    if len(body.text.encode("utf-8")) > MAX_TEXT_BYTES:
        raise HTTPException(status_code=413, detail="text exceeds 8 KiB")

    stored = turns.get(conversation, idem_key)
    if stored is not None:
        return JSONResponse(stored, status_code=202)

    turn = {
        "turn_id": str(uuid.uuid4()),
        "conversation": conversation,
        "tenant": principal.tenant,
        "actor": principal.actor_id,
        "role": principal.role,
        "text": body.text,
    }
    accepted = {"turn_id": turn["turn_id"]}
    turns.put(conversation, idem_key, accepted)
    workflow.enqueue(turn)
    logger.info("turn conversation=%s turn=%s role=%s", conversation, turn["turn_id"], principal.role)
    return JSONResponse(accepted, status_code=202)
`,
    },
    typescript: {
      starter: `/** POST /v1/conversations/:conversation/messages: accepts one support turn and answers it. */
import {randomUUID} from 'node:crypto';

import Fastify from 'fastify';

import {auth, turns, workflow} from './platform';

export const app = Fastify();

interface MessageBody {
  text: string;
  role?: string;
}

app.post('/v1/conversations/:conversation/messages', async (request, reply) => {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  const {conversation} = request.params as {conversation: string};
  const body = request.body as MessageBody;
  const principal = auth.verify(request.headers.authorization);
  const actor = principal?.actorId ?? 'anonymous';
  const turn = {
    turn_id: randomUUID(),
    conversation,
    actor,
    role: body.role ?? 'customer',
    text: body.text,
  };
  request.log.info({conversation, actor, text: body.text}, 'turn');
  const answer = await workflow.run(turn);
  return reply.code(200).send({turn_id: turn.turn_id, answer: answer.text});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** POST /v1/conversations/:conversation/messages: verified principal, capped text, idempotent, 202. */
import {randomUUID} from 'node:crypto';

import Fastify from 'fastify';

import {auth, turns, workflow} from './platform';

export const app = Fastify();

const MAX_TEXT_BYTES = 8 << 10;

interface MessageBody {
  text: string;
}

interface Accepted {
  turn_id: string;
}

app.post('/v1/conversations/:conversation/messages', async (request, reply) => {
  const {conversation} = request.params as {conversation: string};
  const principal = auth.verify(request.headers.authorization);
  if (principal === null) return reply.code(401).send({error: 'missing or invalid bearer token'});
  const idemKey = request.headers['idempotency-key'];
  if (typeof idemKey !== 'string' || idemKey === '')
    return reply.code(400).send({error: 'Idempotency-Key is required'});

  const body = request.body as Partial<MessageBody> | null;
  if (body === null || typeof body !== 'object' || typeof body.text !== 'string' || body.text === '')
    return reply.code(400).send({error: 'text must be a non-empty string'});
  if (Buffer.byteLength(body.text, 'utf8') > MAX_TEXT_BYTES)
    return reply.code(413).send({error: 'text exceeds 8 KiB'});

  const stored: Accepted | null = await turns.get(conversation, idemKey);
  if (stored !== null) return reply.code(202).send(stored);

  const turn = {
    turn_id: randomUUID(),
    conversation,
    tenant: principal.tenant,
    actor: principal.actorId,
    role: principal.role,
    text: body.text,
  };
  const accepted: Accepted = {turn_id: turn.turn_id};
  await turns.put(conversation, idemKey, accepted);
  await workflow.enqueue(turn);
  request.log.info({conversation, turn_id: turn.turn_id, role: principal.role}, 'turn accepted');
  return reply.code(202).send(accepted);
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

type MessageRequest struct {
	Text string \`json:"text"\`
	Role string \`json:"role"\`
}

type Principal struct {
	Tenant  string
	ActorID string
	Role    string
}

type Auth struct{}

// Verify returns the principal behind a bearer token, or nil when missing or invalid.
func (a *Auth) Verify(authorization string) *Principal {
	return nil
}

type Workflow struct{}

// Run executes the Chain of Thought loop to completion and returns the answer.
func (w *Workflow) Run(turn map[string]any) (map[string]any, error) {
	return nil, nil
}

// Enqueue hands the turn to the workflow engine; it runs outside the request.
func (w *Workflow) Enqueue(turn map[string]any) error {
	return nil
}

var (
	auth     = &Auth{}
	workflow = &Workflow{}
)

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func postMessage(rw http.ResponseWriter, r *http.Request) {
	conversation := r.PathValue("conversation")
	var body MessageRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	// TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
	principal := auth.Verify(r.Header.Get("Authorization"))
	actor := "anonymous"
	if principal != nil {
		actor = principal.ActorID
	}
	role := body.Role
	if role == "" {
		role = "customer"
	}
	turn := map[string]any{
		"turn_id":      uuid.NewString(),
		"conversation": conversation,
		"actor":        actor,
		"role":         role,
		"text":         body.Text,
	}
	log.Printf("turn conversation=%s actor=%s text=%q", conversation, actor, body.Text)
	answer, err := workflow.Run(turn)
	if err != nil {
		writeJSON(rw, http.StatusBadGateway, map[string]string{"error": "workflow failed"})
		return
	}
	writeJSON(rw, http.StatusOK, map[string]any{"turn_id": turn["turn_id"], "answer": answer["text"]})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/conversations/{conversation}/messages", postMessage)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"

	"github.com/google/uuid"
)

const maxTextBytes = 8 << 10

type MessageRequest struct {
	Text string \`json:"text"\`
}

type Principal struct {
	Tenant  string
	ActorID string
	Role    string
}

type Auth struct{}

// Verify returns the principal behind a bearer token, or nil when missing or invalid.
func (a *Auth) Verify(authorization string) *Principal {
	return nil
}

type TurnStore struct{}

// Get returns the turn stored for (conversation, idemKey), if any.
func (s *TurnStore) Get(ctx context.Context, conversation, idemKey string) (map[string]any, error) {
	return nil, nil
}

// Put stores the turn under (conversation, idemKey).
func (s *TurnStore) Put(ctx context.Context, conversation, idemKey string, turn map[string]any) error {
	return nil
}

type Workflow struct{}

// Run executes the Chain of Thought loop to completion and returns the answer.
func (w *Workflow) Run(turn map[string]any) (map[string]any, error) {
	return nil, nil
}

// Enqueue hands the turn to the workflow engine; it runs outside the request.
func (w *Workflow) Enqueue(turn map[string]any) error {
	return nil
}

var (
	auth     = &Auth{}
	turns    = &TurnStore{}
	workflow = &Workflow{}
)

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func postMessage(rw http.ResponseWriter, r *http.Request) {
	conversation := r.PathValue("conversation")
	principal := auth.Verify(r.Header.Get("Authorization"))
	if principal == nil {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing or invalid bearer token"})
		return
	}
	idemKey := r.Header.Get("Idempotency-Key")
	if idemKey == "" {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "Idempotency-Key is required"})
		return
	}
	var body MessageRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	if body.Text == "" {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "text must be a non-empty string"})
		return
	}
	if len([]byte(body.Text)) > maxTextBytes {
		writeJSON(rw, http.StatusRequestEntityTooLarge, map[string]string{"error": "text exceeds 8 KiB"})
		return
	}
	stored, err := turns.Get(r.Context(), conversation, idemKey)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	if stored != nil {
		writeJSON(rw, http.StatusAccepted, stored)
		return
	}
	turnID := uuid.NewString()
	turn := map[string]any{
		"turn_id":      turnID,
		"conversation": conversation,
		"tenant":       principal.Tenant,
		"actor":        principal.ActorID,
		"role":         principal.Role,
		"text":         body.Text,
	}
	accepted := map[string]any{"turn_id": turnID}
	if err := turns.Put(r.Context(), conversation, idemKey, accepted); err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	if err := workflow.Enqueue(turn); err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	log.Printf("turn conversation=%s turn=%s role=%s", conversation, turnID, principal.Role)
	writeJSON(rw, http.StatusAccepted, accepted)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/conversations/{conversation}/messages", postMessage)
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

final case class MessageRequest(text: String, role: Option[String])
final case class Principal(tenant: String, actorId: String, role: String)
final case class Turn(turnId: String, conversation: String, actor: String, role: String, text: String)

object Auth {
  /** The principal behind a bearer token, or None when missing or invalid. */
  def verify(authorization: Option[String]): Option[Principal] = ???
}

object Workflow {
  /** Runs the Chain of Thought loop to completion and returns the answer text. */
  def run(turn: Turn): String = ???

  /** Hands the turn to the workflow engine; it runs outside the request. */
  def enqueue(turn: Turn): Unit = ???
}

object TurnApi {
  implicit val system: ActorSystem = ActorSystem("apv2")
  implicit val messageFormat: RootJsonFormat[MessageRequest] = jsonFormat2(MessageRequest)

  val workflow = Workflow

  val route: Route =
    path("v1" / "conversations" / Segment / "messages") { conversation =>
      post {
        optionalHeaderValueByName("Authorization") { authorization =>
          entity(as[MessageRequest]) { body =>
            // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
            val actor = Auth.verify(authorization).map(_.actorId).getOrElse("anonymous")
            val turn = Turn(UUID.randomUUID().toString, conversation, actor, body.role.getOrElse("customer"), body.text)
            system.log.info(s"turn conversation=$conversation actor=$actor text=\${body.text}")
            val answer = workflow.run(turn)
            complete(StatusCodes.OK, s"""{"turn_id":"\${turn.turnId}","answer":"$answer"}""")
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
import java.util.UUID

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class MessageRequest(text: String)
final case class Principal(tenant: String, actorId: String, role: String)
final case class Turn(turnId: String, conversation: String, tenant: String, actor: String, role: String, text: String)
final case class Accepted(turn_id: String)

object Auth {
  /** The principal behind a bearer token, or None when missing or invalid. */
  def verify(authorization: Option[String]): Option[Principal] = ???
}

object TurnStore {
  /** The turn stored for (conversation, idemKey), if any. */
  def get(conversation: String, idemKey: String): Option[Accepted] = ???

  /** Stores the turn under (conversation, idemKey). */
  def put(conversation: String, idemKey: String, accepted: Accepted): Unit = ???
}

object Workflow {
  /** Runs the Chain of Thought loop to completion and returns the answer text. */
  def run(turn: Turn): String = ???

  /** Hands the turn to the workflow engine; it runs outside the request. */
  def enqueue(turn: Turn): Unit = ???
}

object TurnApi {
  implicit val system: ActorSystem = ActorSystem("apv2")
  implicit val messageFormat: RootJsonFormat[MessageRequest] = jsonFormat1(MessageRequest)
  implicit val acceptedFormat: RootJsonFormat[Accepted] = jsonFormat1(Accepted)

  val MaxTextBytes = 8 << 10

  val turns = TurnStore
  val workflow = Workflow

  val route: Route =
    path("v1" / "conversations" / Segment / "messages") { conversation =>
      post {
        optionalHeaderValueByName("Authorization") { authorization =>
          optionalHeaderValueByName("Idempotency-Key") { idemOpt =>
            entity(as[MessageRequest]) { body =>
              Auth.verify(authorization) match {
                case None =>
                  complete(StatusCodes.Unauthorized, """{"error":"missing or invalid bearer token"}""")
                case Some(principal) =>
                  if (!idemOpt.exists(_.nonEmpty)) {
                    complete(StatusCodes.BadRequest, """{"error":"Idempotency-Key is required"}""")
                  } else if (body.text.isEmpty) {
                    complete(StatusCodes.BadRequest, """{"error":"text must be a non-empty string"}""")
                  } else if (body.text.getBytes(StandardCharsets.UTF_8).length > MaxTextBytes) {
                    complete(StatusCodes.RequestEntityTooLarge, """{"error":"text exceeds 8 KiB"}""")
                  } else {
                    val idemKey = idemOpt.get
                    turns.get(conversation, idemKey) match {
                      case Some(stored) =>
                        complete(StatusCodes.Accepted, stored)
                      case None =>
                        val turn = Turn(
                          UUID.randomUUID().toString,
                          conversation,
                          principal.tenant,
                          principal.actorId,
                          principal.role,
                          body.text
                        )
                        val accepted = Accepted(turn.turnId)
                        turns.put(conversation, idemKey, accepted)
                        workflow.enqueue(turn)
                        system.log.info(s"turn conversation=$conversation turn=\${turn.turnId} role=\${principal.role}")
                        complete(StatusCodes.Accepted, accepted)
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

struct Principal {
  std::string tenant;
  std::string actorId;
  std::string role;
};

struct Auth {
  // The principal behind a bearer token, or nullopt when missing or invalid.
  std::optional<Principal> verify(const std::string& authorization);
};

struct Workflow {
  // Runs the Chain of Thought loop to completion and returns the answer.
  json run(const json& turn);
  // Hands the turn to the workflow engine; it runs outside the request.
  void enqueue(const json& turn);
};

Auth auth;
Workflow workflow;
std::string uuidString();

int main() {
  httplib::SSLServer svr("cert.pem", "key.pem");

  svr.Post(R"(/v1/conversations/([A-Za-z0-9-]+)/messages)", [](const httplib::Request& req, httplib::Response& res) {
    const std::string conversation = req.matches[1].str();
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) {
      res.status = 400;
      res.set_content(R"({"error":"invalid json"})", "application/json");
      return;
    }
    // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
    const auto principal = auth.verify(req.get_header_value("Authorization"));
    const std::string actor = principal ? principal->actorId : "anonymous";
    const auto text = body.value("text", std::string());
    const json turn = {
        {"turn_id", uuidString()},
        {"conversation", conversation},
        {"actor", actor},
        {"role", body.value("role", std::string("customer"))},
        {"text", text},
    };
    std::cerr << "turn conversation=" << conversation << " actor=" << actor << " text=" << text << "\\n";
    const json answer = workflow.run(turn);
    res.status = 200;
    res.set_content(json{{"turn_id", turn["turn_id"]}, {"answer", answer["text"]}}.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <iostream>
#include <optional>
#include <string>

using json = nlohmann::json;

constexpr std::size_t kMaxTextBytes = 8 << 10;

struct Principal {
  std::string tenant;
  std::string actorId;
  std::string role;
};

struct Auth {
  // The principal behind a bearer token, or nullopt when missing or invalid.
  std::optional<Principal> verify(const std::string& authorization);
};

struct TurnStore {
  std::optional<json> get(const std::string& conversation, const std::string& idemKey);
  void put(const std::string& conversation, const std::string& idemKey, const json& accepted);
};

struct Workflow {
  // Runs the Chain of Thought loop to completion and returns the answer.
  json run(const json& turn);
  // Hands the turn to the workflow engine; it runs outside the request.
  void enqueue(const json& turn);
};

Auth auth;
TurnStore turns;
Workflow workflow;
std::string uuidString();

int main() {
  httplib::SSLServer svr("cert.pem", "key.pem");

  svr.Post(R"(/v1/conversations/([A-Za-z0-9-]+)/messages)", [](const httplib::Request& req, httplib::Response& res) {
    const std::string conversation = req.matches[1].str();
    const auto principal = auth.verify(req.get_header_value("Authorization"));
    if (!principal) {
      res.status = 401;
      res.set_content(R"({"error":"missing or invalid bearer token"})", "application/json");
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
      res.set_content(R"({"error":"text exceeds 8 KiB"})", "application/json");
      return;
    }
    const auto stored = turns.get(conversation, idemKey);
    if (stored) {
      res.status = 202;
      res.set_content(stored->dump(), "application/json");
      return;
    }
    const std::string turnId = uuidString();
    const json turn = {
        {"turn_id", turnId},
        {"conversation", conversation},
        {"tenant", principal->tenant},
        {"actor", principal->actorId},
        {"role", principal->role},
        {"text", text},
    };
    const json accepted = {{"turn_id", turnId}};
    turns.put(conversation, idemKey, accepted);
    workflow.enqueue(turn);
    std::cerr << "turn conversation=" << conversation << " turn=" << turnId << " role=" << principal->role << "\\n";
    res.status = 202;
    res.set_content(accepted.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  hints: [
    'A customer who sends `"role": "agent"` gets agent tools; a client that retries a timed-out POST gets two answers and, if the model chose `issue_refund`, two refunds; a long paste hangs for seconds.',
    'The handler copies `body.role` into the turn, ignores `Idempotency-Key`, caps nothing, and calls `workflow.run` inline, so every retry re-runs the whole reasoning loop with the full text.',
    'Return 401 without a principal, 400 without the key or with empty text, 413 over `MAX_TEXT_BYTES`; look up `turns.get((conversation, key))`, else `turns.put`, `workflow.enqueue(turn)`, answer 202 with `{turn_id}`.',
  ],
  debrief: `The fix is a handler that trusts only what it verified and does only what it can finish inside one request. The role rides on the principal because it decides which tools the reasoning loop may call; a body field is a self-granted privilege. The byte cap matters more here than on an ordinary API, since every byte of the text is re-sent to the model on every iteration. The idempotency key is scoped to the conversation so a retry finds the stored turn before anything is enqueued, and the 202 moves the multi-second loop into the workflow engine, where the client polls for the answer. Production platforms also check conversation ownership, apply per-actor rate limits, and mint a request-scoped trace id that step 5 carries into every event.`,
};
