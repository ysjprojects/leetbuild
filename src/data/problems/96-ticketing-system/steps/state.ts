import type {Step} from '@/lib/types';

export const stateStep: Step = {
  id: 'state',
  title: 'Redis assignment locks and unread counters',
  concept: 'redis',
  file: 'state',
  focus: ['agent', 'api', 'redis', 'store'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft of the Redis layer: an agent
takes a ticket, replies, and the requester's badge moves. With one agent and no failures it is
right. It hides a double-ownership race, a lease that never comes back, and a badge that can drift
from the thread. Review it, fix it, and prove the fix with the checks below.

Implement the assignment and unread layer the ticket API and the support agents share:

- **The assignment is a lease, one per ticket.** The key is \`lease:{ticket_id}\` and it is taken in
  one round trip: \`SET ... EX LEASE_S NX\` (Python/TypeScript, \`LEASE_S = 120\`),
  \`SetNX\`/\`SetArgs\` with \`leaseTTL\` (Go), \`SetParams.nx().ex(LeaseSeconds)\` (Scala), TTL +
  \`UpdateType::NOT_EXIST\` (C++, \`kLeaseSeconds\`). The draft assigns with a plain \`SET\`, so a
  second agent overwrites the first and both believe they own the ticket.
- **A second owner is refused.** \`POST /v1/tickets/{id}/assign\` that loses the race answers
  **409** with the current owner; the lease's TTL is what frees a ticket when its agent stops
  heartbeating.
- **Release returns the ticket to the queue.** \`DELETE /v1/tickets/{id}/assign\` checks the
  holder, \`DEL\`s \`lease:{ticket_id}\` and pushes the ticket back onto \`assign:queue\`
  (\`LPUSH\`/\`ZADD\`); taking the ticket again removes it from the queue. The draft has no release
  path at all, so a ticket an agent puts down is stranded.
- **The unread badge moves with the message.** \`POST /v1/tickets/{id}/messages\` persists the
  message row and then updates the Redis pair — \`RPUSH ticket:{ticket_id}:thread\` and
  \`HINCRBY unread:{requester} {ticket_id} 1\` — in **one atomic unit** (one \`EVAL\`; a
  \`MULTI\`/\`EXEC\` pipeline is equivalent). The draft issues the append and the counter as two
  separate calls, so a crash between them leaves a message the badge never counted.

**Failure mode the checks target.** A plain \`SET\` lets two agents own one ticket; a lease with no
TTL is never released by a crashed agent, and no release path strands a ticket even when the agent
does put it down; and an append followed by a separate \`HINCRBY\` leaves the requester's badge one
message behind the moment the process dies between the two calls.`,
  sequence: {
    participants: ['Agent', 'Ticket API', 'Redis', 'Ticket store'],
    messages: [
      {from: 'Agent', to: 'Ticket API', label: 'POST /v1/tickets/T-1042/assign · X-Agent-Id', kind: 'sync'},
      {from: 'Ticket API', to: 'Redis', label: 'SET lease:T-1042 <agent> EX 120 NX', kind: 'sync'},
      {
        from: 'Redis',
        to: 'Ticket API',
        label: 'OK (lease won) / nil → 409 with the current owner',
        kind: 'reply',
      },
      {from: 'Agent', to: 'Ticket API', label: 'POST /v1/tickets/T-1042/messages {body}', kind: 'sync'},
      {from: 'Ticket API', to: 'Ticket store', label: 'append the message row (durable)', kind: 'sync'},
      {from: 'Ticket store', to: 'Ticket API', label: 'message_id note_88', kind: 'reply'},
      {
        from: 'Ticket API',
        to: 'Redis',
        label: 'EVAL · RPUSH ticket:T-1042:thread note_88 · HINCRBY unread:R-7 T-1042 1',
        kind: 'sync',
      },
      {from: 'Redis', to: 'Ticket API', label: '1 · the badge moved with the message', kind: 'reply'},
      {from: 'Agent', to: 'Ticket API', label: 'DELETE /v1/tickets/T-1042/assign', kind: 'sync'},
      {from: 'Ticket API', to: 'Redis', label: 'DEL lease:T-1042 · ZADD assign:queue T-1042', kind: 'sync'},
      {from: 'Redis', to: 'Ticket API', label: '1 · the ticket is back on the queue', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'lease-nx',
      title: 'The assignment lease is one SET with NX and a TTL',
      detail:
        'A ticket lease is taken in a single round trip: `SET lease:{ticket_id} {agent} EX 120 NX` (`nx=True, ex=LEASE_S` in Python, `SetNX`/`SetArgs` with `leaseTTL` in Go, `SetParams.nx().ex(LeaseSeconds)` in Scala, TTL + `UpdateType::NOT_EXIST` in C++). The draft assigns with a plain `SET`, so a second agent overwrites the first and both believe they own the ticket.',
      match: {
        python: {all: [/\.set\(/, /\bnx=True/, /\bex=LEASE_S/]},
        typescript: {all: [/\.set\(/, /'NX'/, /'EX'/, /LEASE_S/]},
        go: {all: [/SetNX|SetArgs/, /leaseTTL/]},
        scala: {all: [/SetParams/, /\.nx\(\)/, /LeaseSeconds/]},
        cpp: {all: [/\.set\(/, /NOT_EXIST/, /kLeaseSeconds/]},
      },
    },
    {
      id: 'lease-release',
      title: 'Release deletes the lease key',
      detail:
        'Releasing an assignment deletes `lease:{ticket_id}` after checking the caller is the holder, so the ticket can be claimed again. The draft answers release with an `OK` and never touches the key: a ticket an agent puts down stays leased to that agent.',
      match: {
        python: {all: [/\.delete\([^\n]*(key|lease)/, /lease_key\(/]},
        typescript: {all: [/\.del\(/, /leaseKey\(/]},
        go: {all: [/\.Del\(/, /leaseKey\(/]},
        scala: {all: [/\.del\(/, /leaseKey\(/]},
        cpp: {all: [/\.del\(/, /leaseKey\(/]},
      },
    },
    {
      id: 'atomic-append',
      title: 'The message append and the unread badge move in one atomic unit',
      detail:
        'One `EVAL`/`NewScript` call carries both writes: `RPUSH ticket:{ticket_id}:thread` and `HINCRBY unread:{requester} {ticket_id} 1` (a `MULTI`/`EXEC` pipeline is equivalent). The draft issues them as two separate round trips, so a crash between them leaves a message the badge never counted.',
      match: {
        python: {all: [/(APPEND_LUA|\.pipeline\(|\.multi\()/, /(\.eval\(|\.execute\()/, /RPUSH/, /HINCRBY/]},
        typescript: {all: [/(APPEND_LUA|\.pipeline\(|\.multi\()/, /(\.eval\(|\.exec\()/, /RPUSH/, /HINCRBY/]},
        go: {all: [/(appendScript|NewScript|TxPipelined)/, /(\.Run\(|\.TxPipelined\()/, /RPUSH/, /HINCRBY/]},
        scala: {all: [/(AppendLua|\.pipeline\(|\.multi\()/, /(\.eval\(|\.sync\()/, /RPUSH/, /HINCRBY/]},
        cpp: {all: [/(kAppendLua|\.pipeline\()/, /(\.eval<|\.exec\()/, /RPUSH/, /HINCRBY/]},
      },
    },
    {
      id: 'lease-conflict',
      title: 'A second owner is refused with 409',
      detail:
        'When the lease is already held, the assignment answers `409 Conflict` with the current owner instead of assigning the ticket to a second agent. The draft writes the lease unconditionally and reports success, so two agents work the same ticket and split the thread.',
      match: {
        python: {all: [/status_code\s*=\s*409/, /(already|held|owner)/]},
        typescript: {all: [/\.code\(\s*409\s*\)/, /(already|held|owner)/]},
        go: {all: [/StatusConflict/, /(already|held|owner)/]},
        scala: {all: [/StatusCodes\.Conflict/, /(already|held|owner)/]},
        cpp: {all: [/status\s*=\s*409/, /(already|held|owner)/]},
      },
    },
    {
      id: 'queue-return',
      title: 'A released lease puts the ticket back on the queue',
      detail:
        'Release pushes the ticket back onto `assign:queue` (`ZADD` the claim order; the list form `LPUSH` is fine) after deleting the lease, and taking the ticket removes it again, so the next agent can pick it up. The draft has no release path, so a dropped ticket is stranded off the queue.',
      match: {
        python: {all: [/\.zadd\(|\.lpush\(/, /QUEUE/]},
        typescript: {all: [/\.zadd\(|\.lpush\(/, /QUEUE/]},
        go: {all: [/\.ZAdd\(|\.LPush\(/, /\bqueueKey\b/]},
        scala: {all: [/\.zadd\(|\.lpush\(/, /QueueKey/]},
        cpp: {all: [/\.zadd\(|\.lpush\(/, /kQueueKey/]},
      },
    },
  ],
  code: {
    python: {
      starter: `"""Assignment leases and unread badges: a model-generated draft of the Redis layer."""
import redis
from fastapi import FastAPI, Header
from pydantic import BaseModel

from store import store

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)


class Message(BaseModel):
    body: str
    visibility: str = "public"


def lease_key(ticket_id: str) -> str:
    return f"lease:{ticket_id}"


def thread_key(ticket_id: str) -> str:
    return f"ticket:{ticket_id}:thread"


def unread_key(requester: str) -> str:
    return f"unread:{requester}"


@app.post("/v1/tickets/{ticket_id}/assign")
def assign(ticket_id: str, agent: str = Header(alias="X-Agent-Id")) -> dict:
    # TODO: this SET has no NX and no TTL, so a second agent overwrites the current owner and both
    # of them believe they own the ticket.
    r.set(lease_key(ticket_id), agent)
    return {"ticket": ticket_id, "agent": agent}


@app.delete("/v1/tickets/{ticket_id}/assign")
def release(ticket_id: str, agent: str = Header(alias="X-Agent-Id")) -> dict:
    # TODO: release is a no-op — the lease is never deleted and the ticket never returns to the queue.
    return {"ticket": ticket_id, "released": True}


@app.post("/v1/tickets/{ticket_id}/messages")
def add_message(ticket_id: str, message: Message, agent: str = Header(alias="X-Agent-Id")) -> dict:
    ticket = store.get_ticket(ticket_id)
    message_id = store.append_message(ticket_id, agent, message.body, message.visibility)
    # TODO: the append and the unread counter are two round trips — a crash between them loses the badge.
    r.rpush(thread_key(ticket_id), message_id)
    r.hincrby(unread_key(ticket["requester"]), ticket_id, 1)
    return {"message_id": message_id}
`,
      solution: `"""Assignment leases and unread badges: one lease per ticket, one script per message."""
import time

import redis
from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel

from store import store

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)

LEASE_S = 120
QUEUE = "assign:queue"

APPEND_LUA = """
redis.call('RPUSH', KEYS[1], ARGV[1])
redis.call('HINCRBY', KEYS[2], ARGV[2], 1)
return redis.call('HLEN', KEYS[2])
"""


class Message(BaseModel):
    body: str
    visibility: str = "public"


def lease_key(ticket_id: str) -> str:
    return f"lease:{ticket_id}"


def thread_key(ticket_id: str) -> str:
    return f"ticket:{ticket_id}:thread"


def unread_key(requester: str) -> str:
    return f"unread:{requester}"


@app.post("/v1/tickets/{ticket_id}/assign")
def assign(ticket_id: str, agent: str = Header(alias="X-Agent-Id")) -> dict:
    key = lease_key(ticket_id)
    if not r.set(key, agent, nx=True, ex=LEASE_S):
        raise HTTPException(status_code=409, detail=f"ticket held by {r.get(key)}")
    r.zrem(QUEUE, ticket_id)
    return {"ticket": ticket_id, "agent": agent, "lease_seconds": LEASE_S}


@app.delete("/v1/tickets/{ticket_id}/assign")
def release(ticket_id: str, agent: str = Header(alias="X-Agent-Id")) -> dict:
    key = lease_key(ticket_id)
    if r.get(key) not in (None, agent):
        raise HTTPException(status_code=403, detail="release the lease as its holder")
    r.delete(key)
    r.zadd(QUEUE, {ticket_id: time.time()})
    return {"ticket": ticket_id, "requeued": True}


@app.post("/v1/tickets/{ticket_id}/messages")
def add_message(ticket_id: str, message: Message, agent: str = Header(alias="X-Agent-Id")) -> dict:
    ticket = store.get_ticket(ticket_id)
    message_id = store.append_message(ticket_id, agent, message.body, message.visibility)
    unread = r.eval(
        APPEND_LUA, 2, thread_key(ticket_id), unread_key(ticket["requester"]), message_id, ticket_id
    )
    return {"message_id": message_id, "unread": int(unread)}
`,
    },
    typescript: {
      starter: `/** Assignment leases and unread badges: a model-generated draft of the Redis layer. */
import Fastify from 'fastify';
import {Redis} from 'ioredis';

import {store} from './store';

export const app = Fastify();
const r = new Redis('redis://redis:6379');

const leaseKey = (ticketId: string): string => \`lease:\${ticketId}\`;
const threadKey = (ticketId: string): string => \`ticket:\${ticketId}:thread\`;
const unreadKey = (requester: string): string => \`unread:\${requester}\`;

app.post('/v1/tickets/:id/assign', async (request, reply) => {
  const ticketId = (request.params as {id: string}).id;
  const agent = request.headers['x-agent-id'] as string;
  // TODO: this SET has no NX and no TTL, so a second agent overwrites the current owner and both
  // of them believe they own the ticket.
  await r.set(leaseKey(ticketId), agent);
  return reply.code(200).send({ticket: ticketId, agent});
});

app.delete('/v1/tickets/:id/assign', async (request, reply) => {
  const ticketId = (request.params as {id: string}).id;
  // TODO: release is a no-op — the lease is never deleted and the ticket never returns to the queue.
  return reply.code(200).send({ticket: ticketId, released: true});
});

app.post('/v1/tickets/:id/messages', async (request, reply) => {
  const ticketId = (request.params as {id: string}).id;
  const agent = request.headers['x-agent-id'] as string;
  const body = request.body as {body: string; visibility?: string};
  const ticket = await store.getTicket(ticketId);
  const messageId = await store.appendMessage(ticketId, agent, body.body, body.visibility ?? 'public');
  // TODO: the append and the unread counter are two round trips — a crash between them loses the badge.
  await r.rpush(threadKey(ticketId), messageId);
  await r.hincrby(unreadKey(ticket.requester), ticketId, 1);
  return reply.code(201).send({message_id: messageId});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** Assignment leases and unread badges: one lease per ticket, one script per message. */
import Fastify from 'fastify';
import {Redis} from 'ioredis';

import {store} from './store';

export const app = Fastify();
const r = new Redis('redis://redis:6379');

const LEASE_S = 120;
const QUEUE = 'assign:queue';

const APPEND_LUA = \`
redis.call('RPUSH', KEYS[1], ARGV[1])
redis.call('HINCRBY', KEYS[2], ARGV[2], 1)
return redis.call('HLEN', KEYS[2])
\`;

const leaseKey = (ticketId: string): string => \`lease:\${ticketId}\`;
const threadKey = (ticketId: string): string => \`ticket:\${ticketId}:thread\`;
const unreadKey = (requester: string): string => \`unread:\${requester}\`;

app.post('/v1/tickets/:id/assign', async (request, reply) => {
  const ticketId = (request.params as {id: string}).id;
  const agent = request.headers['x-agent-id'] as string;
  const key = leaseKey(ticketId);
  const won = await r.set(key, agent, 'EX', LEASE_S, 'NX');
  if (won === null) {
    const owner = await r.get(key);
    return reply.code(409).send({error: 'ticket already owned', owner});
  }
  await r.zrem(QUEUE, ticketId);
  return reply.code(200).send({ticket: ticketId, agent, lease_seconds: LEASE_S});
});

app.delete('/v1/tickets/:id/assign', async (request, reply) => {
  const ticketId = (request.params as {id: string}).id;
  const agent = request.headers['x-agent-id'] as string;
  const key = leaseKey(ticketId);
  const owner = await r.get(key);
  if (owner !== null && owner !== agent) {
    return reply.code(403).send({error: 'release the lease as its holder', owner});
  }
  await r.del(key);
  await r.zadd(QUEUE, Date.now(), ticketId);
  return reply.code(204).send();
});

app.post('/v1/tickets/:id/messages', async (request, reply) => {
  const ticketId = (request.params as {id: string}).id;
  const agent = request.headers['x-agent-id'] as string;
  const body = request.body as {body: string; visibility?: string};
  const ticket = await store.getTicket(ticketId);
  const messageId = await store.appendMessage(ticketId, agent, body.body, body.visibility ?? 'public');
  const unread = await r.eval(APPEND_LUA, 2, threadKey(ticketId), unreadKey(ticket.requester), messageId, ticketId);
  return reply.code(201).send({message_id: messageId, unread: Number(unread)});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
    },
    go: {
      starter: `// Assignment leases and unread badges: a model-generated draft of the Redis layer.
package main

import (
	"context"
	"encoding/json"
	"net/http"

	"github.com/redis/go-redis/v9"

	"ticketd/store"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

func leaseKey(ticketID string) string { return "lease:" + ticketID }

func threadKey(ticketID string) string { return "ticket:" + ticketID + ":thread" }

func unreadKey(requester string) string { return "unread:" + requester }

func writeJSON(rw http.ResponseWriter, status int, payload any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	_ = json.NewEncoder(rw).Encode(payload)
}

func assign(rw http.ResponseWriter, req *http.Request) {
	ctx := req.Context()
	ticketID := req.PathValue("id")
	agent := req.Header.Get("X-Agent-Id")
	// TODO: this SET has no NX and no TTL, so a second agent overwrites the current owner and both
	// of them believe they own the ticket.
	_ = rdb.Set(ctx, leaseKey(ticketID), agent, 0)
	writeJSON(rw, http.StatusOK, map[string]string{"ticket": ticketID, "agent": agent})
}

func release(rw http.ResponseWriter, req *http.Request) {
	ticketID := req.PathValue("id")
	// TODO: release is a no-op — the lease is never deleted and the ticket never returns to the queue.
	writeJSON(rw, http.StatusOK, map[string]any{"ticket": ticketID, "released": true})
}

func addMessage(rw http.ResponseWriter, req *http.Request) {
	ctx := req.Context()
	ticketID := req.PathValue("id")
	agent := req.Header.Get("X-Agent-Id")
	body := struct {
		Body       string \`json:"body"\`
		Visibility string \`json:"visibility"\`
	}{}
	_ = json.NewDecoder(req.Body).Decode(&body)
	ticket, err := store.GetTicket(ctx, ticketID)
	if err != nil {
		rw.WriteHeader(http.StatusNotFound)
		return
	}
	messageID, err := store.AppendMessage(ctx, ticketID, agent, body.Body)
	if err != nil {
		rw.WriteHeader(http.StatusInternalServerError)
		return
	}
	// TODO: the append and the unread counter are two round trips — a crash between them loses the badge.
	_ = rdb.RPush(ctx, threadKey(ticketID), messageID)
	_ = rdb.HIncrBy(ctx, unreadKey(ticket.Requester), ticketID, 1)
	writeJSON(rw, http.StatusCreated, map[string]any{"message_id": messageID})
}

func main() {
	http.HandleFunc("POST /v1/tickets/{id}/assign", assign)
	http.HandleFunc("DELETE /v1/tickets/{id}/assign", release)
	http.HandleFunc("POST /v1/tickets/{id}/messages", addMessage)
	_ = http.ListenAndServe(":8443", nil)
}
`,
      solution: `// Assignment leases and unread badges: one lease per ticket, one script per message.
package main

import (
	"context"
	"encoding/json"
	"net/http"
	"time"

	"github.com/redis/go-redis/v9"

	"ticketd/store"
)

const (
	leaseTTL = 120 * time.Second
	queueKey = "assign:queue"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// One script owns both keys: the thread append and the requester's unread badge move together.
var appendScript = redis.NewScript(\`
redis.call('RPUSH', KEYS[1], ARGV[1])
redis.call('HINCRBY', KEYS[2], ARGV[2], 1)
return redis.call('HLEN', KEYS[2])
\`)

func leaseKey(ticketID string) string { return "lease:" + ticketID }

func threadKey(ticketID string) string { return "ticket:" + ticketID + ":thread" }

func unreadKey(requester string) string { return "unread:" + requester }

func writeJSON(rw http.ResponseWriter, status int, payload any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	_ = json.NewEncoder(rw).Encode(payload)
}

func assign(rw http.ResponseWriter, req *http.Request) {
	ctx := req.Context()
	ticketID := req.PathValue("id")
	agent := req.Header.Get("X-Agent-Id")
	key := leaseKey(ticketID)
	won, err := rdb.SetNX(ctx, key, agent, leaseTTL).Result()
	if err != nil {
		rw.WriteHeader(http.StatusServiceUnavailable)
		return
	}
	if !won {
		owner, _ := rdb.Get(ctx, key).Result()
		writeJSON(rw, http.StatusConflict, map[string]string{"error": "ticket already owned", "owner": owner})
		return
	}
	rdb.ZRem(ctx, queueKey, ticketID)
	writeJSON(rw, http.StatusOK, map[string]any{"ticket": ticketID, "agent": agent, "lease_seconds": int(leaseTTL.Seconds())})
}

func release(rw http.ResponseWriter, req *http.Request) {
	ctx := req.Context()
	ticketID := req.PathValue("id")
	agent := req.Header.Get("X-Agent-Id")
	key := leaseKey(ticketID)
	owner, _ := rdb.Get(ctx, key).Result()
	if owner != "" && owner != agent {
		writeJSON(rw, http.StatusForbidden, map[string]string{"error": "release the lease as its holder", "owner": owner})
		return
	}
	rdb.Del(ctx, key)
	rdb.ZAdd(ctx, queueKey, redis.Z{Score: float64(time.Now().Unix()), Member: ticketID})
	rw.WriteHeader(http.StatusNoContent)
}

func addMessage(rw http.ResponseWriter, req *http.Request) {
	ctx := req.Context()
	ticketID := req.PathValue("id")
	agent := req.Header.Get("X-Agent-Id")
	body := struct {
		Body       string \`json:"body"\`
		Visibility string \`json:"visibility"\`
	}{}
	_ = json.NewDecoder(req.Body).Decode(&body)
	ticket, err := store.GetTicket(ctx, ticketID)
	if err != nil {
		rw.WriteHeader(http.StatusNotFound)
		return
	}
	messageID, err := store.AppendMessage(ctx, ticketID, agent, body.Body)
	if err != nil {
		rw.WriteHeader(http.StatusInternalServerError)
		return
	}
	unread, err := appendScript.Run(ctx, rdb, []string{threadKey(ticketID), unreadKey(ticket.Requester)}, messageID, ticketID).Int64()
	if err != nil {
		rw.WriteHeader(http.StatusServiceUnavailable)
		return
	}
	writeJSON(rw, http.StatusCreated, map[string]any{"message_id": messageID, "unread": unread})
}

func main() {
	http.HandleFunc("POST /v1/tickets/{id}/assign", assign)
	http.HandleFunc("DELETE /v1/tickets/{id}/assign", release)
	http.HandleFunc("POST /v1/tickets/{id}/messages", addMessage)
	_ = http.ListenAndServe(":8443", nil)
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
import redis.clients.jedis.Jedis
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class Message(body: String, visibility: Option[String])

/** Provided: the ticket store module (rows of tickets and notes). */
trait TicketStore {
  def requesterOf(ticketId: String): String
  def appendMessage(ticketId: String, agent: String, body: String): String
}

object TicketState {
  implicit val system: ActorSystem = ActorSystem("ticketd")
  implicit val messageFormat: RootJsonFormat[Message] = jsonFormat2(Message)
  val store: TicketStore = ???

  val jedis = new Jedis("redis", 6379)

  def leaseKey(ticketId: String): String = s"lease:$ticketId"
  def threadKey(ticketId: String): String = s"ticket:$ticketId:thread"
  def unreadKey(requester: String): String = s"unread:$requester"

  def claim(ticketId: String, agent: String): Unit = {
    // TODO: this SET has no NX and no TTL, so a second agent overwrites the current owner and both
    // of them believe they own the ticket.
    jedis.set(leaseKey(ticketId), agent)
    ()
  }

  def release(ticketId: String, agent: String): Unit = {
    // TODO: release is a no-op — the lease is never deleted and the ticket never returns to the queue.
    ()
  }

  val route: Route =
    concat(
      path("v1" / "tickets" / Segment / "assign") { ticketId =>
        headerValueByName("X-Agent-Id") { agent =>
          post {
            claim(ticketId, agent)
            complete(StatusCodes.OK, s"""{"ticket":"$ticketId","agent":"$agent"}""")
          } ~
            delete {
              release(ticketId, agent)
              complete(StatusCodes.OK, s"""{"ticket":"$ticketId","released":true}""")
            }
        }
      },
      path("v1" / "tickets" / Segment / "messages") { ticketId =>
        headerValueByName("X-Agent-Id") { agent =>
          post {
            entity(as[Message]) { message =>
              val messageId = store.appendMessage(ticketId, agent, message.body)
              // TODO: the append and the unread counter are two round trips — a crash between them loses the badge.
              jedis.rpush(threadKey(ticketId), messageId)
              jedis.hincrby(unreadKey(store.requesterOf(ticketId)), ticketId, 1)
              complete(StatusCodes.Created, s"""{"message_id":"$messageId"}""")
            }
          }
        }
      }
    )

  def main(args: Array[String]): Unit = {
    Http().newServerAt("0.0.0.0", 8443).bind(route)
  }
}
`,
      solution: `import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import redis.clients.jedis.Jedis
import redis.clients.jedis.params.SetParams
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class Message(body: String, visibility: Option[String])

/** Provided: the ticket store module (rows of tickets and notes). */
trait TicketStore {
  def requesterOf(ticketId: String): String
  def appendMessage(ticketId: String, agent: String, body: String): String
}

object TicketState {
  implicit val system: ActorSystem = ActorSystem("ticketd")
  implicit val messageFormat: RootJsonFormat[Message] = jsonFormat2(Message)
  val store: TicketStore = ???

  val LeaseSeconds = 120L
  val QueueKey = "assign:queue"
  val jedis = new Jedis("redis", 6379)

  // One script owns both keys: the thread append and the requester's unread badge move together.
  val AppendLua =
    """
      |redis.call('RPUSH', KEYS[1], ARGV[1])
      |redis.call('HINCRBY', KEYS[2], ARGV[2], 1)
      |return redis.call('HLEN', KEYS[2])
      |""".stripMargin

  def leaseKey(ticketId: String): String = s"lease:$ticketId"
  def threadKey(ticketId: String): String = s"ticket:$ticketId:thread"
  def unreadKey(requester: String): String = s"unread:$requester"

  /** Atomic claim with a lease; false when another agent already holds the ticket. */
  def claim(ticketId: String, agent: String): Boolean = {
    val won = jedis.set(leaseKey(ticketId), agent, SetParams.setParams().nx().ex(LeaseSeconds))
    if (won == null) false
    else {
      jedis.zrem(QueueKey, ticketId)
      true
    }
  }

  /** Drop the lease, but only for its holder, and put the ticket back on the assignment queue. */
  def release(ticketId: String, agent: String): Boolean = {
    val owner = Option(jedis.get(leaseKey(ticketId)))
    if (owner.exists(_ != agent)) false
    else {
      jedis.del(leaseKey(ticketId))
      jedis.zadd(QueueKey, System.currentTimeMillis().toDouble, ticketId)
      true
    }
  }

  def appendMessage(ticketId: String, requester: String, messageId: String): Long = {
    val keys = java.util.List.of(threadKey(ticketId), unreadKey(requester))
    val args = java.util.List.of(messageId, ticketId)
    jedis.eval(AppendLua, keys, args).asInstanceOf[java.lang.Long]
  }

  val route: Route =
    concat(
      path("v1" / "tickets" / Segment / "assign") { ticketId =>
        headerValueByName("X-Agent-Id") { agent =>
          post {
            if (claim(ticketId, agent)) {
              complete(StatusCodes.OK, s"""{"ticket":"$ticketId","agent":"$agent","lease_seconds":$LeaseSeconds}""")
            } else {
              complete(
                HttpResponse(
                  StatusCodes.Conflict,
                  entity = HttpEntity(
                    ContentTypes.\`application/json\`,
                    s"""{"error":"ticket already owned","owner":"\${jedis.get(leaseKey(ticketId))}"}"""
                  )
                )
              )
            }
          } ~
            delete {
              if (release(ticketId, agent)) complete(StatusCodes.NoContent)
              else complete(StatusCodes.Forbidden, """{"error":"release the lease as its holder"}""")
            }
        }
      },
      path("v1" / "tickets" / Segment / "messages") { ticketId =>
        headerValueByName("X-Agent-Id") { agent =>
          post {
            entity(as[Message]) { message =>
              val messageId = store.appendMessage(ticketId, agent, message.body)
              val unread = appendMessage(ticketId, store.requesterOf(ticketId), messageId)
              complete(StatusCodes.Created, s"""{"message_id":"$messageId","unread":$unread}""")
            }
          }
        }
      }
    )

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

#include <string>

using json = nlohmann::json;

// Provided: the ticket store module (rows of tickets and notes).
struct TicketStore {
  std::string requester_of(const std::string& ticket_id);
  std::string append_message(const std::string& ticket_id, const std::string& agent, const std::string& body);
};

TicketStore store;

std::string leaseKey(const std::string& ticket_id) { return "lease:" + ticket_id; }

std::string threadKey(const std::string& ticket_id) { return "ticket:" + ticket_id + ":thread"; }

std::string unreadKey(const std::string& requester) { return "unread:" + requester; }

int main() {
  sw::redis::Redis redis("tcp://redis:6379");
  httplib::Server svr;

  svr.Post(R"(/v1/tickets/([\\w-]+)/assign)", [&redis](const httplib::Request& req, httplib::Response& res) {
    const std::string ticket_id = req.matches[1];
    const std::string agent = req.get_header_value("X-Agent-Id");
    // TODO: this SET has no NX and no TTL, so a second agent overwrites the current owner and both
    // of them believe they own the ticket.
    redis.set(leaseKey(ticket_id), agent);
    res.status = 200;
    res.set_content(json{{"ticket", ticket_id}, {"agent", agent}}.dump(), "application/json");
  });

  svr.Delete(R"(/v1/tickets/([\\w-]+)/assign)", [](const httplib::Request& req, httplib::Response& res) {
    const std::string ticket_id = req.matches[1];
    // TODO: release is a no-op — the lease is never deleted and the ticket never returns to the queue.
    res.status = 200;
    res.set_content(json{{"ticket", ticket_id}, {"released", true}}.dump(), "application/json");
  });

  svr.Post(R"(/v1/tickets/([\\w-]+)/messages)", [&redis](const httplib::Request& req, httplib::Response& res) {
    const std::string ticket_id = req.matches[1];
    const std::string agent = req.get_header_value("X-Agent-Id");
    const auto message_id = store.append_message(ticket_id, agent, req.body);
    // TODO: the append and the unread counter are two round trips — a crash between them loses the badge.
    redis.rpush(threadKey(ticket_id), message_id);
    redis.hincrby(unreadKey(store.requester_of(ticket_id)), ticket_id, 1);
    res.status = 201;
    res.set_content(json{{"message_id", message_id}}.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <chrono>
#include <string>

using json = nlohmann::json;

constexpr long long kLeaseSeconds = 120;
const char* kQueueKey = "assign:queue";

// One script owns both keys: the thread append and the requester's unread badge move together.
const std::string kAppendLua = R"LUA(
redis.call('RPUSH', KEYS[1], ARGV[1])
redis.call('HINCRBY', KEYS[2], ARGV[2], 1)
return redis.call('HLEN', KEYS[2])
)LUA";

// Provided: the ticket store module (rows of tickets and notes).
struct TicketStore {
  std::string requester_of(const std::string& ticket_id);
  std::string append_message(const std::string& ticket_id, const std::string& agent, const std::string& body);
};

TicketStore store;

std::string leaseKey(const std::string& ticket_id) { return "lease:" + ticket_id; }

std::string threadKey(const std::string& ticket_id) { return "ticket:" + ticket_id + ":thread"; }

std::string unreadKey(const std::string& requester) { return "unread:" + requester; }

int main() {
  sw::redis::Redis redis("tcp://redis:6379");
  httplib::Server svr;

  svr.Post(R"(/v1/tickets/([\\w-]+)/assign)", [&redis](const httplib::Request& req, httplib::Response& res) {
    const std::string ticket_id = req.matches[1];
    const std::string agent = req.get_header_value("X-Agent-Id");
    const bool won = redis.set(leaseKey(ticket_id), agent, std::chrono::seconds(kLeaseSeconds),
                               sw::redis::UpdateType::NOT_EXIST);
    if (!won) {
      res.status = 409;
      res.set_content(
          json{{"error", "ticket already owned"}, {"owner", *redis.get(leaseKey(ticket_id))}}.dump(),
          "application/json");
      return;
    }
    redis.zrem(kQueueKey, ticket_id);
    res.status = 200;
    res.set_content(json{{"ticket", ticket_id}, {"agent", agent}, {"lease_seconds", kLeaseSeconds}}.dump(),
                    "application/json");
  });

  svr.Delete(R"(/v1/tickets/([\\w-]+)/assign)", [&redis](const httplib::Request& req, httplib::Response& res) {
    const std::string ticket_id = req.matches[1];
    const std::string agent = req.get_header_value("X-Agent-Id");
    const auto owner = redis.get(leaseKey(ticket_id));
    if (owner && *owner != agent) {
      res.status = 403;
      res.set_content(json{{"error", "release the lease as its holder"}, {"owner", *owner}}.dump(),
                      "application/json");
      return;
    }
    redis.del(leaseKey(ticket_id));
    const auto now = std::chrono::duration_cast<std::chrono::seconds>(
                         std::chrono::system_clock::now().time_since_epoch())
                         .count();
    redis.zadd(kQueueKey, ticket_id, static_cast<double>(now));
    res.status = 204;
  });

  svr.Post(R"(/v1/tickets/([\\w-]+)/messages)", [&redis](const httplib::Request& req, httplib::Response& res) {
    const std::string ticket_id = req.matches[1];
    const std::string agent = req.get_header_value("X-Agent-Id");
    const auto message_id = store.append_message(ticket_id, agent, req.body);
    const auto unread = redis.eval<long long>(
        kAppendLua, {threadKey(ticket_id), unreadKey(store.requester_of(ticket_id))}, {message_id, ticket_id});
    res.status = 201;
    res.set_content(json{{"message_id", message_id}, {"unread", unread}}.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  hints: [
    'The lease is one command: `SET lease:{ticket_id} {agent} EX 120 NX`. A `GET` followed by a `SET`, or a `SET` with no `NX`, is check-then-act — two agents both read the ticket as free and both write it, and last-writer-wins silently fires the previous owner. Only the caller the command answers `OK` to owns the ticket.',
    'Release is a compare-and-delete on the same key, then a push back onto `assign:queue`, because a ticket nobody owns must be offerable again. Keep the TTL: it is the only thing that frees a ticket whose agent stopped heartbeating. In the draft the release handler answers `OK` while the key stays behind, so the ticket is stranded.',
    "The append and the badge are two writes to two keys, and two keys are two round trips unless one script carries them: `RPUSH` the message id and `HINCRBY` the requester's counter inside one `EVAL`. A crash between the calls leaves a message in the thread that the badge never counted — and the badge is the only place that fact is stored.",
  ],
  debrief: `The interview question behind this step is ownership under failure: a lease is the only honest way to say "this one agent owns this one ticket right now". A plain \`SET\` looks equivalent because it always writes, but it has no notion of "already taken" and no notion of "taken until", so the ticket ends up with two owners and no way back to the queue. The same instinct produces \`GET\`-then-\`SET\` and the bare \`DEL\` release — a delete can remove a lease that now belongs to someone else, which is why the release path checks the holder first (or does the compare-and-delete in Lua). Candidates also miss the two-key write: the append and the unread badge are separate commands, so a crash between them leaves a message nobody is told about, and the badge is the only place that fact lives. Real systems go further: a heartbeat extends the lease while the agent is actually working, an expired lease escalates instead of quietly returning to the queue, the unread badge is derived from an append-only thread plus a per-requester pointer so it cannot drift, and the lease value carries the holder plus a fencing token so a stale agent's writes can be rejected after its lease expired.`,
};
