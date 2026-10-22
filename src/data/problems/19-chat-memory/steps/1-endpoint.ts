import type {Step} from '@/lib/types';

export const endpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/sessions/{id}/turns: append a validated turn',
  concept: 'http',
  file: 'api',
  focus: ['client', 'api', 'redis'],
  task: `## Task

The starter is a plausible model-generated draft: a turn lands in Redis, so the demo passes. The
handler trusts three things it must not — the session id in the path, the size of the body and the
role string. Find the flaws, fix them, and prove the fix.

Implement the turn-append endpoint used by every chat client:

- \`POST /v1/sessions/{id}/turns\`. The tenant comes from the authenticated request context
  (\`X-Tenant-Id\`), never from the path or the body. The session id in the path is a claim, not a
  proof: look up the session's owner and answer **404** when it belongs to another tenant, so a
  cross-tenant write can never create or read another tenant's buffer.
- The role must be \`user\` or \`assistant\`; anything else is a **400**. The draft folds an unknown
  or missing role into \`user\`, silently storing a system prompt as a user turn.
- \`content\` is capped at **32 KiB**, measured in UTF-8 bytes. Reject an oversized turn with
  **413 before any Redis write** — the draft appends first, so a multi-megabyte paste is already in
  the list by the time anyone looks at its size.
- The optional \`Idempotency-Key\` makes the append replay-safe: the first successful append stores
  its response under \`idem:{tenant}:{key}\`, and a replay returns that stored turn with **200**
  instead of appending a duplicate.

**Failure mode the checks target.** A caller from tenant B posts to tenant A's session id and the
draft writes into A's buffer; a 4 MB paste is accepted and stored; \`role: "system"\` becomes a
\`user\` turn; and a client that retries after a timeout doubles the conversation.

## What to keep

The response shape (\`session_id\`, \`turn_id\`, \`role\`) and the Redis list append are fine. The
fix is validation and identity: authorize the session, validate the role, measure the bytes, then
dedupe — all before the first write.`,
  sequence: {
    participants: ['Client', 'Memory API', 'Redis'],
    messages: [
      {from: 'Client', to: 'Memory API', label: 'POST /v1/sessions/s-1/turns + Idempotency-Key', kind: 'sync'},
      {from: 'Memory API', to: 'Redis', label: 'HGET sessions s-1', kind: 'sync'},
      {from: 'Redis', to: 'Memory API', label: 'owner = acme', kind: 'reply'},
      {
        from: 'Memory API',
        to: 'Memory API',
        label: '400 bad role · 413 over 32 KiB · 404 foreign session',
        kind: 'sync',
      },
      {from: 'Memory API', to: 'Redis', label: 'GET idem:acme:key-1', kind: 'sync'},
      {from: 'Redis', to: 'Memory API', label: 'nil, then SET idem ... NX after append', kind: 'reply'},
      {from: 'Memory API', to: 'Client', label: '201 turn · 200 on replay', kind: 'reply'},
    ],
  },
  hints: [
    'The tenant header is the only identity you can trust. `r.hget("sessions", id)` returns the owner; when it is not the caller, answer `404` rather than `403`, so the caller cannot even learn whether the session exists.',
    'Measure `len(content.encode("utf-8"))`, not `len(content)`: a character is not a byte and the cap is 32 KiB. Reject before the first Redis command so an oversized turn never reaches the buffer.',
    'The idempotency key is a claim too. `SET idem:{tenant}:{key} <response> EX 86400 NX` makes the first writer win; on replay the `GET` finds the stored response and the handler returns it without touching the list.',
  ],
  checks: [
    {
      id: 'route',
      title: 'Registers POST /v1/sessions/{id}/turns',
      detail:
        'The endpoint is registered on the session-scoped path, so the turn belongs to a session rather than to a free-floating buffer.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/sessions\/\{id\}\/turns["']/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/sessions\/:id\/turns['"]/]},
        go: {all: [/HandleFunc\(\s*"POST \/v1\/sessions\/\{id\}\/turns"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"sessions"\s*\/\s*Segment\s*\/\s*"turns"\s*\)/]},
        cpp: {all: [/svr\.Post\(\s*"\/v1\/sessions\/:id\/turns"/]},
      },
    },
    {
      id: 'tenant-ownership',
      title: 'Authorizes the session against the authenticated tenant',
      detail:
        'The session owner is loaded and compared with the tenant from the request context; a foreign session id answers `404`. The draft writes into whatever session id the path contains.',
      match: {
        python: {all: [/assert_tenant_owns/, /404/]},
        typescript: {all: [/assertTenantOwns/, /404/]},
        go: {all: [/assertTenantOwns/, /StatusNotFound|404/]},
        scala: {all: [/assertTenantOwns/, /NotFound|404/]},
        cpp: {all: [/assert_tenant_owns/, /404/]},
      },
    },
    {
      id: 'content-cap',
      title: 'Caps content at 32 KiB before the Redis write',
      detail:
        'The UTF-8 byte length is measured against a 32 KiB constant and an oversized turn is rejected with `413` before the append. The draft stores first and never checks.',
      match: {
        python: {all: [/MAX_CONTENT_BYTES/, /413/], order: [/MAX_CONTENT_BYTES/, /lpush\(/]},
        typescript: {all: [/MAX_CONTENT_BYTES/, /413/], order: [/MAX_CONTENT_BYTES/, /lpush\(/]},
        go: {all: [/maxContentBytes/, /RequestEntityTooLarge|413/], order: [/maxContentBytes/, /LPush\(/]},
        scala: {all: [/MaxContentBytes/, /PayloadTooLarge|413/], order: [/MaxContentBytes/, /lpush\(/]},
        cpp: {all: [/kMaxContentBytes/, /413/], order: [/kMaxContentBytes/, /lpush\(/]},
      },
    },
    {
      id: 'role-validation',
      title: 'Rejects a role that is neither user nor assistant',
      detail:
        'The role is checked against an explicit set and an unknown value answers `400`. The draft turns any unknown role into `user`.',
      match: {
        python: {all: [/VALID_ROLES/, /400/]},
        typescript: {all: [/VALID_ROLES/, /400/]},
        go: {all: [/validRoles/, /StatusBadRequest|400/]},
        scala: {all: [/ValidRoles/, /BadRequest|400/]},
        cpp: {all: [/kValidRoles/, /400/]},
      },
    },
    {
      id: 'idempotency-replay',
      title: 'Replays an Idempotency-Key instead of appending twice',
      detail:
        'The append stores its response under `idem:{tenant}:{key}` and a replay returns the stored turn with `200` before the append. The draft ignores the header entirely.',
      match: {
        python: {all: [/idem:/, /Idempotency-Key/], order: [/idem:/, /lpush\(/]},
        typescript: {all: [/idem:/, /idempotency[_-]key/i], order: [/idem:/, /lpush\(/]},
        go: {all: [/idem:/, /Idempotency-Key/], order: [/idem:/, /LPush\(/]},
        scala: {all: [/idem:/, /Idempotency-Key/], order: [/idem:/, /lpush\(/]},
        cpp: {all: [/idem:/, /Idempotency-Key/], order: [/idem:/, /lpush\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json
import uuid

import redis
from fastapi import FastAPI, Header
from pydantic import BaseModel

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)


class TurnBody(BaseModel):
    role: str | None = None
    content: str = ""


@app.post("/v1/sessions/{id}/turns")
def append_turn(id: str, body: TurnBody, tenant: str = Header(alias="X-Tenant-Id")) -> dict:
    # TODO: reject a session that does not belong to the tenant, validate the role instead of
    # defaulting it, cap the content at 32 KiB before any Redis write, and return the stored turn
    # when the same Idempotency-Key is replayed.
    role = body.role or "user"
    turn = {"turn_id": uuid.uuid4().hex, "role": role, "content": body.content}
    r.lpush(f"turns:{id}", json.dumps(turn))
    return {"session_id": id, "turn_id": turn["turn_id"], "role": role}
`,
      solution: `import json
import uuid

import redis
from fastapi import FastAPI, Header, HTTPException, Response
from pydantic import BaseModel

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)

MAX_CONTENT_BYTES = 32 * 1024
VALID_ROLES = {"user", "assistant"}
IDEM_TTL_S = 86_400


class TurnBody(BaseModel):
    role: str
    content: str


def turns_key(tenant: str, session_id: str) -> str:
    return f"turns:{tenant}:{session_id}"


def idem_key(tenant: str, key: str) -> str:
    return f"idem:{tenant}:{key}"


def assert_tenant_owns(tenant: str, session_id: str) -> None:
    owner = r.hget("sessions", session_id)
    if owner != tenant:
        raise HTTPException(status_code=404, detail="session not found")


@app.post("/v1/sessions/{id}/turns")
def append_turn(
    id: str,
    body: TurnBody,
    tenant: str = Header(alias="X-Tenant-Id"),
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
) -> Response:
    if body.role not in VALID_ROLES:
        raise HTTPException(status_code=400, detail="role must be user or assistant")
    if len(body.content.encode("utf-8")) > MAX_CONTENT_BYTES:
        raise HTTPException(status_code=413, detail="turn exceeds 32 KiB")
    assert_tenant_owns(tenant, id)
    if idempotency_key is not None:
        stored = r.get(idem_key(tenant, idempotency_key))
        if stored is not None:
            return Response(content=stored, media_type="application/json", status_code=200)
    turn = {"turn_id": uuid.uuid4().hex, "role": body.role, "content": body.content}
    r.lpush(turns_key(tenant, id), json.dumps(turn))
    body_json = json.dumps({"session_id": id, "turn_id": turn["turn_id"], "role": body.role})
    if idempotency_key is not None:
        r.set(idem_key(tenant, idempotency_key), body_json, ex=IDEM_TTL_S, nx=True)
    return Response(content=body_json, media_type="application/json", status_code=201)
`,
    },
    typescript: {
      starter: `/** POST /v1/sessions/:id/turns: a model-generated draft that trusts the path and the body. */
import Fastify from 'fastify';
import {Redis} from 'ioredis';
import {randomUUID} from 'node:crypto';

export const app = Fastify();
const r = new Redis('redis://redis:6379');

interface TurnBody {
  role?: string;
  content: string;
}

app.post('/v1/sessions/:id/turns', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'] as string;
  void tenant;
  const {id} = request.params as {id: string};
  const body = request.body as TurnBody;
  // TODO: reject a session that does not belong to the tenant, validate the role instead of
  // defaulting it, cap the content at 32 KiB before any Redis write, and return the stored turn
  // when the same Idempotency-Key is replayed.
  const turn = {turn_id: randomUUID(), role: body.role ?? 'user', content: body.content};
  await r.lpush(\`turns:\${id}\`, JSON.stringify(turn));
  return reply.code(201).send({session_id: id, turn_id: turn.turn_id, role: turn.role});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** POST /v1/sessions/:id/turns: authorize the session, validate the turn, dedupe the retry. */
import Fastify from 'fastify';
import {Redis} from 'ioredis';
import {randomUUID} from 'node:crypto';

export const app = Fastify();
const r = new Redis('redis://redis:6379');

const MAX_CONTENT_BYTES = 32 * 1024;
const VALID_ROLES: Record<string, true> = {user: true, assistant: true};
const IDEM_TTL_S = 86_400;

interface TurnBody {
  role: string;
  content: string;
}

function idemKey(tenant: string, key: string): string {
  return \`idem:\${tenant}:\${key}\`;
}

async function assertTenantOwns(tenant: string, sessionId: string): Promise<void> {
  const owner = await r.hget('sessions', sessionId);
  if (owner !== tenant) {
    const error = new Error('session not found') as Error & {statusCode: number};
    error.statusCode = 404;
    throw error;
  }
}

app.post('/v1/sessions/:id/turns', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'] as string;
  const {id} = request.params as {id: string};
  const body = request.body as TurnBody;
  const idempotencyKey = request.headers['idempotency-key'] as string | undefined;
  if (VALID_ROLES[body.role] !== true) {
    return reply.code(400).send({error: 'role must be user or assistant'});
  }
  if (Buffer.byteLength(body.content, 'utf8') > MAX_CONTENT_BYTES) {
    return reply.code(413).send({error: 'turn exceeds 32 KiB'});
  }
  await assertTenantOwns(tenant, id);
  if (idempotencyKey !== undefined) {
    const stored = await r.get(idemKey(tenant, idempotencyKey));
    if (stored !== null) return reply.code(200).send(JSON.parse(stored));
  }
  const turn = {turn_id: randomUUID(), role: body.role, content: body.content};
  await r.lpush(\`turns:\${tenant}:\${id}\`, JSON.stringify(turn));
  const response = {session_id: id, turn_id: turn.turn_id, role: body.role};
  if (idempotencyKey !== undefined) {
    await r.set(idemKey(tenant, idempotencyKey), JSON.stringify(response), 'EX', IDEM_TTL_S, 'NX');
  }
  return reply.code(201).send(response);
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"net/http"

	"github.com/google/uuid"
	"github.com/redis/go-redis/v9"
)

var rdb *redis.Client

type turnBody struct {
	Role    string \`json:"role"\`
	Content string \`json:"content"\`
}

func appendTurn(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	_ = tenant
	id := r.PathValue("id")
	var body turnBody
	_ = json.NewDecoder(r.Body).Decode(&body)
	// TODO: reject a session that does not belong to the tenant, validate the role instead of
	// defaulting it, cap the content at 32 KiB before any Redis write, and return the stored turn
	// when the same Idempotency-Key is replayed.
	role := body.Role
	if role == "" {
		role = "user"
	}
	turnID := uuid.NewString()
	turn, _ := json.Marshal(map[string]string{"turn_id": turnID, "role": role, "content": body.Content})
	rdb.LPush(context.Background(), "turns:"+id, turn)
	rw.WriteHeader(http.StatusCreated)
	_, _ = rw.Write([]byte(\`{"session_id":"\` + id + \`","turn_id":"\` + turnID + \`","role":"\` + role + \`"}\`))
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/sessions/{id}/turns", appendTurn)
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/redis/go-redis/v9"
)

const (
	maxContentBytes = 32 * 1024
	idemTTL         = 86400 * time.Second
)

var (
	rdb        *redis.Client
	validRoles = map[string]bool{"user": true, "assistant": true}
)

type turnBody struct {
	Role    string \`json:"role"\`
	Content string \`json:"content"\`
}

func turnsKey(tenant, sessionID string) string {
	return "turns:" + tenant + ":" + sessionID
}

func idemKey(tenant, key string) string {
	return "idem:" + tenant + ":" + key
}

func assertTenantOwns(ctx context.Context, tenant, sessionID string) error {
	owner, err := rdb.HGet(ctx, "sessions", sessionID).Result()
	if err != nil || owner != tenant {
		return errors.New("session not found")
	}
	return nil
}

func appendTurn(rw http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	tenant := r.Header.Get("X-Tenant-Id")
	id := r.PathValue("id")
	body := new(turnBody)
	_ = json.NewDecoder(r.Body).Decode(body)
	idempotencyKey := r.Header.Get("Idempotency-Key")
	if !validRoles[body.Role] {
		http.Error(rw, \`{"error":"role must be user or assistant"}\`, http.StatusBadRequest)
		return
	}
	if len(body.Content) > maxContentBytes {
		http.Error(rw, \`{"error":"turn exceeds 32 KiB"}\`, http.StatusRequestEntityTooLarge)
		return
	}
	if err := assertTenantOwns(ctx, tenant, id); err != nil {
		http.Error(rw, \`{"error":"session not found"}\`, http.StatusNotFound)
		return
	}
	if idempotencyKey != "" {
		if stored, err := rdb.Get(ctx, idemKey(tenant, idempotencyKey)).Result(); err == nil {
			rw.Header().Set("Content-Type", "application/json")
			_, _ = rw.Write([]byte(stored))
			return
		}
	}
	turnID := uuid.NewString()
	turn, _ := json.Marshal(map[string]string{"turn_id": turnID, "role": body.Role, "content": body.Content})
	rdb.LPush(ctx, turnsKey(tenant, id), turn)
	response, _ := json.Marshal(map[string]string{"session_id": id, "turn_id": turnID, "role": body.Role})
	if idempotencyKey != "" {
		rdb.SetNX(ctx, idemKey(tenant, idempotencyKey), response, idemTTL)
	}
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(http.StatusCreated)
	_, _ = rw.Write(response)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/sessions/{id}/turns", appendTurn)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model.StatusCodes
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import redis.clients.jedis.Jedis
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class TurnBody(role: Option[String], content: String)

object MemoryApi {
  implicit val system: ActorSystem = ActorSystem("chat-memory")
  implicit val turnFormat: RootJsonFormat[TurnBody] = jsonFormat2(TurnBody)

  val jedis = new Jedis("redis", 6379)

  val route: Route =
    path("v1" / "sessions" / Segment / "turns") { id =>
      post {
        headerValueByName("X-Tenant-Id") { tenant =>
          entity(as[TurnBody]) { body =>
            // TODO: reject a session that does not belong to the tenant, validate the role instead
            // of defaulting it, cap the content at 32 KiB before any Redis write, and return the
            // stored turn when the same Idempotency-Key is replayed.
            val role = body.role.getOrElse("user")
            val turnId = java.util.UUID.randomUUID().toString
            jedis.lpush(s"turns:$id", s"""{"turn_id":"$turnId","role":"$role","content":"\${body.content}"}""")
            complete(StatusCodes.Created, s"""{"session_id":"$id","turn_id":"$turnId","role":"$role"}""")
          }
        }
      }
    }

  def main(args: Array[String]): Unit = {
    Http().newServerAt("0.0.0.0", 8443).bind(route)
  }
}
`,
      solution: `import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model.StatusCodes
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import redis.clients.jedis.Jedis
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class TurnBody(role: String, content: String)

object MemoryApi {
  implicit val system: ActorSystem = ActorSystem("chat-memory")
  implicit val turnFormat: RootJsonFormat[TurnBody] = jsonFormat2(TurnBody)

  val MaxContentBytes = 32 * 1024
  val ValidRoles = Set("user", "assistant")
  val IdemTtlSeconds = 86400
  val jedis = new Jedis("redis", 6379)

  def turnsKey(tenant: String, sessionId: String): String = s"turns:$tenant:$sessionId"

  def idemKey(tenant: String, key: String): String = s"idem:$tenant:$key"

  def assertTenantOwns(tenant: String, sessionId: String): Unit = {
    val owner = Option(jedis.hget("sessions", sessionId))
    if (!owner.contains(tenant)) throw new NoSuchElementException("session not found")
  }

  val route: Route =
    path("v1" / "sessions" / Segment / "turns") { id =>
      post {
        headerValueByName("X-Tenant-Id") { tenant =>
          optionalHeaderValueByName("Idempotency-Key") { idem =>
            entity(as[TurnBody]) { body =>
              if (!ValidRoles.contains(body.role)) {
                complete(StatusCodes.BadRequest, """{"error":"role must be user or assistant"}""")
              } else if (body.content.getBytes("UTF-8").length > MaxContentBytes) {
                complete(StatusCodes.PayloadTooLarge, """{"error":"turn exceeds 32 KiB"}""")
              } else {
                try {
                  assertTenantOwns(tenant, id)
                  val replay = idem.flatMap(key => Option(jedis.get(idemKey(tenant, key))))
                  replay match {
                    case Some(stored) => complete(StatusCodes.OK, stored)
                    case None =>
                      val turnId = java.util.UUID.randomUUID().toString
                      jedis.lpush(turnsKey(tenant, id), s"""{"turn_id":"$turnId","role":"\${body.role}","content":"\${body.content}"}""")
                      val response = s"""{"session_id":"$id","turn_id":"$turnId","role":"\${body.role}"}"""
                      idem.foreach(key =>
                        jedis.set(idemKey(tenant, key), response, redis.clients.jedis.params.SetParams.setParams().nx().ex(IdemTtlSeconds))
                      )
                      complete(StatusCodes.Created, response)
                  }
                } catch {
                  case _: NoSuchElementException => complete(StatusCodes.NotFound, """{"error":"session not found"}""")
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
#include <sw/redis++/redis++.h>

#include <cstdlib>
#include <string>

using json = nlohmann::json;

int main() {
  sw::redis::Redis redis("tcp://redis:6379");
  httplib::Server svr;

  svr.Post("/v1/sessions/:id/turns", [&redis](const httplib::Request& req, httplib::Response& res) {
    const auto tenant = req.get_header_value("X-Tenant-Id");
    (void)tenant;
    const auto id = req.path_params.at("id");
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) body = json::object();
    // TODO: reject a session that does not belong to the tenant, validate the role instead of
    // defaulting it, cap the content at 32 KiB before any Redis write, and return the stored turn
    // when the same Idempotency-Key is replayed.
    const auto role = body.value("role", std::string("user"));
    const auto turnId = std::to_string(std::rand());
    json turn = {{"turn_id", turnId}, {"role", role}, {"content", body.value("content", std::string())}};
    redis.lpush("turns:" + id, turn.dump());
    res.status = 201;
    res.set_content(json{{"session_id", id}, {"turn_id", turnId}, {"role", role}}.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <cstdlib>
#include <stdexcept>
#include <string>

using json = nlohmann::json;

constexpr std::size_t kMaxContentBytes = 32 * 1024;
const std::set<std::string> kValidRoles = {"user", "assistant"};
constexpr long long kIdemTtlSeconds = 86400;

std::string turns_key(const std::string& tenant, const std::string& session_id) {
  return "turns:" + tenant + ":" + session_id;
}

std::string idem_key(const std::string& tenant, const std::string& key) {
  return "idem:" + tenant + ":" + key;
}

void assert_tenant_owns(sw::redis::Redis& redis, const std::string& tenant, const std::string& session_id) {
  auto owner = redis.hget("sessions", session_id);
  if (!owner || *owner != tenant) throw std::runtime_error("session not found");
}

int main() {
  sw::redis::Redis redis("tcp://redis:6379");
  httplib::Server svr;

  svr.Post("/v1/sessions/:id/turns", [&redis](const httplib::Request& req, httplib::Response& res) {
    const auto tenant = req.get_header_value("X-Tenant-Id");
    const auto id = req.path_params.at("id");
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) body = json::object();
    const auto idempotencyKey = req.get_header_value("Idempotency-Key");
    const auto role = body.value("role", std::string());
    if (kValidRoles.find(role) == kValidRoles.end()) {
      res.status = 400;
      res.set_content(R"({"error":"role must be user or assistant"})", "application/json");
      return;
    }
    const auto content = body.value("content", std::string());
    if (content.size() > kMaxContentBytes) {
      res.status = 413;
      res.set_content(R"({"error":"turn exceeds 32 KiB"})", "application/json");
      return;
    }
    try {
      assert_tenant_owns(redis, tenant, id);
      if (!idempotencyKey.empty()) {
        auto stored = redis.get(idem_key(tenant, idempotencyKey));
        if (stored) {
          res.status = 200;
          res.set_content(*stored, "application/json");
          return;
        }
      }
      const auto turnId = std::to_string(std::rand());
      json turn = {{"turn_id", turnId}, {"role", role}, {"content", content}};
      redis.lpush(turns_key(tenant, id), turn.dump());
      const auto response = json{{"session_id", id}, {"turn_id", turnId}, {"role", role}}.dump();
      if (!idempotencyKey.empty()) {
        redis.set(idem_key(tenant, idempotencyKey), response, std::chrono::seconds(kIdemTtlSeconds), sw::redis::UpdateType::NOT_EXIST);
      }
      res.status = 201;
      res.set_content(response, "application/json");
    } catch (const std::runtime_error&) {
      res.status = 404;
      res.set_content(R"({"error":"session not found"})", "application/json");
    }
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  debrief: `The interview question behind this step is the trust boundary of a write endpoint. Every field
the caller controls — the path, the body, the role, the idempotency key — is a claim, and the
service has to turn each claim into a fact it can prove: who owns the session, how many bytes
arrived, whether the role is one the schema allows, and whether this exact append already happened.
The draft passes the demo because the happy path is one tenant, one small turn, one attempt; it
fails exactly when a second tenant, a large paste or a retrying client shows up. Two details
interviewers listen for: measuring bytes rather than characters, and rejecting before the first
write so a bad request never leaves a trace in Redis. The replay-safe response is the third: a
client that retries after a timeout must get the turn it already created, not a second copy.`,
};
