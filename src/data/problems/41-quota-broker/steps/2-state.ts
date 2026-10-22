import type {Step} from '@/lib/types';

export const stateStep: Step = {
  id: 'state',
  title: 'Redis reservation ledger with expiry on first write',
  concept: 'redis',
  file: 'state',
  focus: ['broker', 'redis'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it reads the window hash,
decides there is room, increments the counter, and the demo shows a reservation. It compiles, it
passes every serial test, and it oversells the window the moment two reserves overlap. Review it,
fix it, and prove the fix.

Implement the reservation ledger behind the reserve endpoint:

- Reservations live in **one Redis hash per (team, window)**: \`quota:{team}:{window}\`, with the
  fields \`limit\`, \`reserved\` and \`consumed\`, plus **one key per reservation**:
  \`reservation:{team}:{reservation_id}\` holding its \`window\`, \`resource_class\` and \`amount\`.
  The window belongs in the key — the cap is per window, and reservations from one window must never
  be counted against the next.
- **Take, release and expiry setup happen in one Lua script.** The draft calls \`HGET\` and then
  \`HINCRBY\` from the client, so two callers both read \`reserved = 4\` against a limit of 8 and
  both increment: the window oversells by exactly the concurrency. \`EVAL\` reads the counter,
  compares and increments as a single step, so the loser sees the winner’s write.
- The window key **expires**, set on the **first write** (and refreshed on every take), so the
  ledger is not immortal. When the window closes, its key vanishes — which is the mechanism by which
  unconsumed reservations return to the pool; the reservation keys expire with it.
- A **released reservation refunds its own window**: the release script reads the reservation’s
  recorded window and decrements that window’s \`reserved\` counter in the same script, so capacity
  is available to the next caller immediately. A release that names a different window must be
  refused instead of decrementing somebody else’s counter.

**Failure mode the checks target.** Three things have to hold: the take is atomic (two concurrent
reservations can never exceed the window’s limit), an expired window’s keys are gone rather than
counted forever, and a release makes the capacity reservable again on the next call.

**What to keep.** The hash-of-counters shape and the per-reservation key are right. The fix is the
atomicity, the key scope and the expiry.`,
  sequence: {
    participants: ['Quota Broker', 'Second Quota Broker', 'Redis'],
    messages: [
      {from: 'Quota Broker', to: 'Redis', label: 'EVAL take+check+expire quota:team-a:2026-10-21T14:00Z', kind: 'sync'},
      {
        from: 'Second Quota Broker',
        to: 'Redis',
        label: 'EVAL take+check+expire quota:team-a:2026-10-21T14:00Z',
        kind: 'sync',
      },
      {from: 'Redis', to: 'Quota Broker', label: '1 — reserved 4 → 8, EXPIRE on first write', kind: 'reply'},
      {from: 'Redis', to: 'Second Quota Broker', label: '0 — the window cannot cover it', kind: 'reply'},
      {from: 'Quota Broker', to: 'Redis', label: 'EVAL release reservation:team-a:res-1', kind: 'sync'},
      {from: 'Redis', to: 'Quota Broker', label: 'reserved 8 → 4 · capacity is reservable again', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'window-key',
      title: 'Scopes the ledger to (team, window)',
      detail:
        'The counter hash is keyed by the team **and** the window, so one team’s windows never share capacity. The draft keys by team alone, so a stale window keeps consuming the next one’s quota.',
      match: {
        python: {all: [/quota:\{team\}:\{window\}/]},
        typescript: {all: [/quota:\$\{team\}:\$\{window\}/]},
        go: {all: [/"quota:"\s*\+\s*team\s*\+\s*":"\s*\+\s*window/]},
        scala: {all: [/quota:\$team:\$window/]},
        cpp: {all: [/"quota:"\s*\+\s*team\s*\+\s*":"\s*\+\s*window/]},
      },
    },
    {
      id: 'atomic-take',
      title: 'Takes and checks the counter in one atomic script',
      detail:
        'A single Lua `EVAL` reads `reserved`, compares it with the limit and increments as one step. The draft issues `HGET` and then `HINCRBY` from the client, so two concurrent reserves both observe the same free capacity and both take it.',
      match: {
        python: {all: [/RESERVE_LUA/, /\.eval\(/]},
        typescript: {all: [/RESERVE_LUA/, /\.eval\(/]},
        go: {all: [/reserveScript/, /\.Run\(/]},
        scala: {all: [/ReserveLua/, /\.eval\(/]},
        cpp: {all: [/kReserveLua/, /\.eval</]},
      },
    },
    {
      id: 'expire-window',
      title: 'Expires the window key at the first write',
      detail:
        'The script sets `EXPIRE` with a named TTL, so the window’s ledger disappears when the window closes instead of counting forever. The draft never expires anything.',
      match: {
        python: {all: [/EXPIRE/, /TTL_S/]},
        typescript: {all: [/EXPIRE/, /TTL_S/]},
        go: {all: [/EXPIRE/, /ttlSeconds/]},
        scala: {all: [/EXPIRE/, /TtlSeconds/]},
        cpp: {all: [/EXPIRE/, /kTtlSeconds/]},
      },
    },
    {
      id: 'release-refund',
      title: 'Refunds capacity in the same script as the release',
      detail:
        'Releasing decrements the window’s `reserved` counter and deletes the reservation key atomically, so the next caller can reserve immediately. The draft has no release path at all, so a cancelled job holds its GPUs until the window closes.',
      match: {
        python: {all: [/RELEASE_LUA/, /def release\(/]},
        typescript: {all: [/RELEASE_LUA/, /async function release\(/]},
        go: {all: [/releaseScript/, /func.*Release\(/]},
        scala: {all: [/ReleaseLua/, /def release\(/]},
        cpp: {all: [/kReleaseLua/, /release\(/]},
      },
    },
    {
      id: 'window-guard',
      title: 'Refunds only the window the reservation recorded',
      detail:
        'The reservation key stores its window and the release script refuses a release that names a different one, so a reservation from an expired window cannot decrement the next window’s counter. The draft keeps no per-reservation record, so there is nothing to guard.',
      match: {
        python: {all: [/WINDOW_MISMATCH/, /reservation:\{team\}:\{reservation_id\}/]},
        typescript: {all: [/WINDOW_MISMATCH/, /reservation:\$\{team\}:\$\{reservationId\}/]},
        go: {all: [/windowMismatch/, /"reservation:"\s*\+\s*team/]},
        scala: {all: [/WindowMismatch/, /reservation:\$team:\$reservationId/]},
        cpp: {all: [/kWindowMismatch/, /"reservation:"\s*\+\s*team/]},
      },
    },
  ],
  code: {
    python: {
      starter: `"""Reservation ledger: a model-generated draft that reads and increments from the client."""
import uuid

import redis
from fastapi import FastAPI
from pydantic import BaseModel

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)

LIMIT = 64


class ReserveRequest(BaseModel):
    window: str
    resource_class: str
    amount: int


@app.post("/v1/quotas/{team}/reserve")
def reserve(team: str, body: ReserveRequest) -> dict:
    # TODO: this draft reads the counter and increments it in two separate commands, so two
    # concurrent reserves both see the same free capacity; and it keys by team alone, so a
    # reservation from an expired window still counts against the next one. Move the take, the
    # check and the expiry into one Lua script and read (release) the reservation back out of it.
    key = f"quota:{team}"
    reserved = int(r.hget(key, "reserved") or 0)
    if reserved + body.amount > LIMIT:
        return {"error": "quota_exhausted"}
    r.hincrby(key, "reserved", body.amount)
    return {"reservation_id": uuid.uuid4().hex, "reserved": reserved + body.amount}
`,
      solution: `"""Reservation ledger: one atomic take per (team, window), an expiring key and a real release."""
import uuid

import redis
from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)

TTL_S = 3600
DEFAULT_LIMIT = 64
WINDOW_MISMATCH = "window mismatch"

RESERVE_LUA = """
local reserved = tonumber(redis.call('HGET', KEYS[1], 'reserved') or '0')
local amount = tonumber(ARGV[2])
if reserved + amount > tonumber(ARGV[3]) then
  return 0
end
redis.call('HINCRBY', KEYS[1], 'reserved', amount)
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[4]))
redis.call('HSET', KEYS[2], 'window', ARGV[1], 'resource_class', ARGV[5], 'amount', amount)
redis.call('EXPIRE', KEYS[2], tonumber(ARGV[4]))
return 1
"""

RELEASE_LUA = """
local recorded = redis.call('HGET', KEYS[2], 'window')
if not recorded then
  return -1
end
if recorded ~= ARGV[1] then
  return -2
end
local amount = tonumber(redis.call('HGET', KEYS[2], 'amount'))
redis.call('HINCRBY', KEYS[1], 'reserved', -amount)
redis.call('DEL', KEYS[2])
return amount
"""


class ReserveRequest(BaseModel):
    window: str
    resource_class: str
    amount: int


def quota_key(team: str, window: str) -> str:
    return f"quota:{team}:{window}"


def reservation_key(team: str, reservation_id: str) -> str:
    return f"reservation:{team}:{reservation_id}"


def reserve(team: str, window: str, resource_class: str, amount: int) -> str | None:
    reservation_id = uuid.uuid4().hex
    taken = r.eval(
        RESERVE_LUA,
        2,
        quota_key(team, window),
        reservation_key(team, reservation_id),
        window,
        amount,
        DEFAULT_LIMIT,
        TTL_S,
        resource_class,
    )
    return reservation_id if int(taken) == 1 else None


def release(team: str, reservation_id: str, window: str) -> int:
    refunded = r.eval(
        RELEASE_LUA,
        2,
        quota_key(team, window),
        reservation_key(team, reservation_id),
        window,
    )
    if int(refunded) == -2:
        raise HTTPException(status_code=409, detail=WINDOW_MISMATCH)
    return 0 if int(refunded) < 0 else int(refunded)


@app.post("/v1/quotas/{team}/reserve")
def reserve_endpoint(team: str, body: ReserveRequest, caller: str = Header(alias="X-Team-Id")) -> dict:
    if caller != team:
        raise HTTPException(status_code=403, detail="team mismatch")
    reservation_id = reserve(team, body.window, body.resource_class, body.amount)
    if reservation_id is None:
        raise HTTPException(status_code=409, detail="quota_exhausted")
    return {"reservation_id": reservation_id, "window": body.window, "amount": body.amount}
`,
    },
    typescript: {
      starter: `/** Reservation ledger: a model-generated draft that reads and increments from the client. */
import Fastify from 'fastify';
import {Redis} from 'ioredis';
import {randomUUID} from 'node:crypto';

export const app = Fastify();
const r = new Redis('redis://redis:6379');

const LIMIT = 64;

interface ReserveBody {
  window: string;
  resource_class: string;
  amount: number;
}

app.post('/v1/quotas/:team/reserve', async (request, reply) => {
  const {team} = request.params as {team: string};
  const body = request.body as ReserveBody;
  // TODO: this draft reads the counter and increments it in two separate commands, so two
  // concurrent reserves both see the same free capacity; and it keys by team alone, so a
  // reservation from an expired window still counts against the next one. Move the take, the
  // check and the expiry into one Lua script and read (release) the reservation back out of it.
  const key = \`quota:\${team}\`;
  const reserved = Number((await r.hget(key, 'reserved')) ?? 0);
  if (reserved + body.amount > LIMIT) return reply.code(409).send({error: 'quota_exhausted'});
  await r.hincrby(key, 'reserved', body.amount);
  return reply.code(201).send({reservation_id: randomUUID(), reserved: reserved + body.amount});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** Reservation ledger: one atomic take per (team, window), an expiring key and a real release. */
import Fastify from 'fastify';
import {Redis} from 'ioredis';
import {randomUUID} from 'node:crypto';

export const app = Fastify();
const r = new Redis('redis://redis:6379');

const TTL_S = 3600;
const DEFAULT_LIMIT = 64;
const WINDOW_MISMATCH = 'window mismatch';

const RESERVE_LUA = \`
local reserved = tonumber(redis.call('HGET', KEYS[1], 'reserved') or '0')
local amount = tonumber(ARGV[2])
if reserved + amount > tonumber(ARGV[3]) then
  return 0
end
redis.call('HINCRBY', KEYS[1], 'reserved', amount)
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[4]))
redis.call('HSET', KEYS[2], 'window', ARGV[1], 'resource_class', ARGV[5], 'amount', amount)
redis.call('EXPIRE', KEYS[2], tonumber(ARGV[4]))
return 1
\`;

const RELEASE_LUA = \`
local recorded = redis.call('HGET', KEYS[2], 'window')
if not recorded then
  return -1
end
if recorded ~= ARGV[1] then
  return -2
end
local amount = tonumber(redis.call('HGET', KEYS[2], 'amount'))
redis.call('HINCRBY', KEYS[1], 'reserved', -amount)
redis.call('DEL', KEYS[2])
return amount
\`;

interface ReserveBody {
  window: string;
  resource_class: string;
  amount: number;
}

function quotaKey(team: string, window: string): string {
  return \`quota:\${team}:\${window}\`;
}

function reservationKey(team: string, reservationId: string): string {
  return \`reservation:\${team}:\${reservationId}\`;
}

async function reserve(team: string, window: string, resourceClass: string, amount: number): Promise<string | null> {
  const reservationId = randomUUID();
  const taken = await r.eval(
    RESERVE_LUA,
    2,
    quotaKey(team, window),
    reservationKey(team, reservationId),
    window,
    String(amount),
    String(DEFAULT_LIMIT),
    String(TTL_S),
    resourceClass,
  );
  return Number(taken) === 1 ? reservationId : null;
}

async function release(team: string, reservationId: string, window: string): Promise<number> {
  const refunded = await r.eval(
    RELEASE_LUA,
    2,
    quotaKey(team, window),
    reservationKey(team, reservationId),
    window,
  );
  if (Number(refunded) === -2) {
    const error = new Error(WINDOW_MISMATCH) as Error & {statusCode: number};
    error.statusCode = 409;
    throw error;
  }
  return Number(refunded) < 0 ? 0 : Number(refunded);
}

app.post('/v1/quotas/:team/reserve', async (request, reply) => {
  const {team} = request.params as {team: string};
  const caller = request.headers['x-team-id'];
  if (caller !== team) return reply.code(403).send({error: 'team mismatch'});
  const body = request.body as ReserveBody;
  const reservationId = await reserve(team, body.window, body.resource_class, body.amount);
  if (reservationId === null) return reply.code(409).send({error: 'quota_exhausted'});
  return reply.code(201).send({reservation_id: reservationId, window: body.window, amount: body.amount});
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

const limit = 64

var rdb *redis.Client

type reserveRequest struct {
	Window        string \`json:"window"\`
	ResourceClass string \`json:"resource_class"\`
	Amount        int    \`json:"amount"\`
}

func reserve(rw http.ResponseWriter, r *http.Request) {
	ctx := context.Background()
	team := r.PathValue("team")
	var body reserveRequest
	_ = json.NewDecoder(r.Body).Decode(&body)
	// TODO: this draft reads the counter and increments it in two separate commands, so two
	// concurrent reserves both see the same free capacity; and it keys by team alone, so a
	// reservation from an expired window still counts against the next one. Move the take, the
	// check and the expiry into one Lua script and read (release) the reservation back out of it.
	key := "quota:" + team
	reserved, _ := rdb.HGet(ctx, key, "reserved").Int()
	if reserved+body.Amount > limit {
		http.Error(rw, \`{"error":"quota_exhausted"}\`, http.StatusConflict)
		return
	}
	rdb.HIncrBy(ctx, key, "reserved", int64(body.Amount))
	payload, _ := json.Marshal(map[string]any{"reservation_id": uuid.NewString(), "reserved": reserved + body.Amount})
	_, _ = rw.Write(payload)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/quotas/{team}/reserve", reserve)
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"

	"github.com/google/uuid"
	"github.com/redis/go-redis/v9"
)

const (
	defaultLimit = 64
	ttlSeconds   = 3600
)

var windowMismatch = errors.New("window mismatch")

var (
	rdb           *redis.Client
	reserveScript = redis.NewScript(\`
local reserved = tonumber(redis.call('HGET', KEYS[1], 'reserved') or '0')
local amount = tonumber(ARGV[2])
if reserved + amount > tonumber(ARGV[3]) then
  return 0
end
redis.call('HINCRBY', KEYS[1], 'reserved', amount)
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[4]))
redis.call('HSET', KEYS[2], 'window', ARGV[1], 'resource_class', ARGV[5], 'amount', amount)
redis.call('EXPIRE', KEYS[2], tonumber(ARGV[4]))
return 1
\`)
	releaseScript = redis.NewScript(\`
local recorded = redis.call('HGET', KEYS[2], 'window')
if not recorded then
  return -1
end
if recorded ~= ARGV[1] then
  return -2
end
local amount = tonumber(redis.call('HGET', KEYS[2], 'amount'))
redis.call('HINCRBY', KEYS[1], 'reserved', -amount)
redis.call('DEL', KEYS[2])
return amount
\`)
)

type reserveRequest struct {
	Window        string \`json:"window"\`
	ResourceClass string \`json:"resource_class"\`
	Amount        int    \`json:"amount"\`
}

func quotaKey(team, window string) string {
	return "quota:" + team + ":" + window
}

func reservationKey(team, reservationID string) string {
	return "reservation:" + team + ":" + reservationID
}

// Reserve takes amount units atomically and returns the reservation id, or "" when the window
// cannot cover it.
func Reserve(ctx context.Context, team, window, resourceClass string, amount int) (string, error) {
	reservationID := uuid.NewString()
	taken, err := reserveScript.Run(
		ctx,
		rdb,
		[]string{quotaKey(team, window), reservationKey(team, reservationID)},
		window,
		amount,
		defaultLimit,
		ttlSeconds,
		resourceClass,
	).Int()
	if err != nil {
		return "", err
	}
	if taken != 1 {
		return "", nil
	}
	return reservationID, nil
}

// Release refunds the window the reservation recorded, so capacity is reservable again at once.
func Release(ctx context.Context, team, reservationID, window string) (int, error) {
	refunded, err := releaseScript.Run(
		ctx,
		rdb,
		[]string{quotaKey(team, window), reservationKey(team, reservationID)},
		window,
	).Int()
	if err != nil {
		return 0, err
	}
	if refunded == -2 {
		return 0, windowMismatch
	}
	if refunded < 0 {
		return 0, nil
	}
	return refunded, nil
}

func reserve(rw http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	team := r.PathValue("team")
	if r.Header.Get("X-Team-Id") != team {
		http.Error(rw, \`{"error":"team mismatch"}\`, http.StatusForbidden)
		return
	}
	var body reserveRequest
	_ = json.NewDecoder(r.Body).Decode(&body)
	reservationID, err := Reserve(ctx, team, body.Window, body.ResourceClass, body.Amount)
	if err != nil {
		http.Error(rw, \`{"error":"ledger unavailable"}\`, http.StatusServiceUnavailable)
		return
	}
	if reservationID == "" {
		http.Error(rw, \`{"error":"quota_exhausted"}\`, http.StatusConflict)
		return
	}
	payload, _ := json.Marshal(map[string]any{
		"reservation_id": reservationID,
		"window":         body.Window,
		"amount":         body.Amount,
	})
	rw.WriteHeader(http.StatusCreated)
	_, _ = rw.Write(payload)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/quotas/{team}/reserve", reserve)
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
import java.util.UUID

final case class ReserveRequest(window: String, resource_class: String, amount: Int)

object StateApi {
  implicit val system: ActorSystem = ActorSystem("quota-broker")
  implicit val reserveFormat: RootJsonFormat[ReserveRequest] = jsonFormat3(ReserveRequest)
  val Limit = 64
  val jedis = new Jedis("redis", 6379)

  val route: Route =
    path("v1" / "quotas" / Segment / "reserve") { team =>
      post {
        entity(as[ReserveRequest]) { body =>
          // TODO: this draft reads the counter and increments it in two separate commands, so two
          // concurrent reserves both see the same free capacity; and it keys by team alone, so a
          // reservation from an expired window still counts against the next one. Move the take,
          // the check and the expiry into one Lua script and read (release) the reservation back.
          val key = s"quota:$team"
          val reserved = Option(jedis.hget(key, "reserved")).map(_.toInt).getOrElse(0)
          if (reserved + body.amount > Limit) {
            complete(StatusCodes.Conflict, """{"error":"quota_exhausted"}""")
          } else {
            jedis.hincrBy(key, "reserved", body.amount.toLong)
            complete(StatusCodes.Created, s"""{"reservation_id":"\${UUID.randomUUID().toString}"}""")
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
import java.util.UUID

final case class ReserveRequest(window: String, resource_class: String, amount: Int)

object StateApi {
  implicit val system: ActorSystem = ActorSystem("quota-broker")
  implicit val reserveFormat: RootJsonFormat[ReserveRequest] = jsonFormat3(ReserveRequest)

  val DefaultLimit = 64
  val TtlSeconds = 3600
  val WindowMismatch = "window mismatch"
  val jedis = new Jedis("redis", 6379)

  val ReserveLua =
    """
      |local reserved = tonumber(redis.call('HGET', KEYS[1], 'reserved') or '0')
      |local amount = tonumber(ARGV[2])
      |if reserved + amount > tonumber(ARGV[3]) then
      |  return 0
      |end
      |redis.call('HINCRBY', KEYS[1], 'reserved', amount)
      |redis.call('EXPIRE', KEYS[1], tonumber(ARGV[4]))
      |redis.call('HSET', KEYS[2], 'window', ARGV[1], 'resource_class', ARGV[5], 'amount', amount)
      |redis.call('EXPIRE', KEYS[2], tonumber(ARGV[4]))
      |return 1
      |""".stripMargin

  val ReleaseLua =
    """
      |local recorded = redis.call('HGET', KEYS[2], 'window')
      |if not recorded then
      |  return -1
      |end
      |if recorded ~= ARGV[1] then
      |  return -2
      |end
      |local amount = tonumber(redis.call('HGET', KEYS[2], 'amount'))
      |redis.call('HINCRBY', KEYS[1], 'reserved', -amount)
      |redis.call('DEL', KEYS[2])
      |return amount
      |""".stripMargin

  def quotaKey(team: String, window: String): String = s"quota:$team:$window"

  def reservationKey(team: String, reservationId: String): String = s"reservation:$team:$reservationId"

  def reserve(team: String, window: String, resourceClass: String, amount: Int): Option[String] = {
    val reservationId = UUID.randomUUID().toString
    val taken = jedis.eval(
      ReserveLua,
      2,
      quotaKey(team, window),
      reservationKey(team, reservationId),
      window,
      amount.toString,
      DefaultLimit.toString,
      TtlSeconds.toString,
      resourceClass)
    if (taken == 1L) Some(reservationId) else None
  }

  /** Refunds only the window the reservation recorded, so capacity is reservable again at once. */
  def release(team: String, reservationId: String, window: String): Long = {
    val refunded = jedis.eval(
      ReleaseLua,
      2,
      quotaKey(team, window),
      reservationKey(team, reservationId),
      window)
    if (refunded == -2L) throw new IllegalArgumentException(WindowMismatch)
    if (refunded < 0L) 0L else refunded
  }

  val route: Route =
    path("v1" / "quotas" / Segment / "reserve") { team =>
      post {
        headerValueByName("X-Team-Id") { caller =>
          entity(as[ReserveRequest]) { body =>
            if (caller != team) {
              complete(StatusCodes.Forbidden, """{"error":"team mismatch"}""")
            } else {
              reserve(team, body.window, body.resource_class, body.amount) match {
                case Some(reservationId) =>
                  complete(
                    StatusCodes.Created,
                    s"""{"reservation_id":"$reservationId","window":"\${body.window}","amount":\${body.amount}}""")
                case None => complete(StatusCodes.Conflict, """{"error":"quota_exhausted"}""")
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

#include <string>

using json = nlohmann::json;

constexpr long long kLimit = 64;

int main() {
  sw::redis::Redis redis("tcp://redis:6379");
  httplib::Server svr;

  svr.Post("/v1/quotas/:team/reserve", [&redis](const httplib::Request& req, httplib::Response& res) {
    const auto team = req.path_params.at("team");
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) body = json::object();
    // TODO: this draft reads the counter and increments it in two separate commands, so two
    // concurrent reserves both see the same free capacity; and it keys by team alone, so a
    // reservation from an expired window still counts against the next one. Move the take, the
    // check and the expiry into one Lua script and read (release) the reservation back out of it.
    const auto key = "quota:" + team;
    auto reserved_raw = redis.hget(key, "reserved");
    const long long reserved = reserved_raw ? std::stoll(*reserved_raw) : 0;
    const long long amount = body.value("amount", 0);
    if (reserved + amount > kLimit) {
      res.status = 409;
      res.set_content(R"({"error":"quota_exhausted"})", "application/json");
      return;
    }
    redis.hincrby(key, "reserved", amount);
    res.status = 201;
    res.set_content(json{{"reservation_id", "res-1"}, {"reserved", reserved + amount}}.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <stdexcept>
#include <string>
#include <vector>

using json = nlohmann::json;

constexpr long long kDefaultLimit = 64;
constexpr long long kTtlSeconds = 3600;
const std::string kWindowMismatch = "window mismatch";

const std::string kReserveLua = R"(
local reserved = tonumber(redis.call('HGET', KEYS[1], 'reserved') or '0')
local amount = tonumber(ARGV[2])
if reserved + amount > tonumber(ARGV[3]) then
  return 0
end
redis.call('HINCRBY', KEYS[1], 'reserved', amount)
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[4]))
redis.call('HSET', KEYS[2], 'window', ARGV[1], 'resource_class', ARGV[5], 'amount', amount)
redis.call('EXPIRE', KEYS[2], tonumber(ARGV[4]))
return 1
)";

const std::string kReleaseLua = R"(
local recorded = redis.call('HGET', KEYS[2], 'window')
if not recorded then
  return -1
end
if recorded ~= ARGV[1] then
  return -2
end
local amount = tonumber(redis.call('HGET', KEYS[2], 'amount'))
redis.call('HINCRBY', KEYS[1], 'reserved', -amount)
redis.call('DEL', KEYS[2])
return amount
)";

std::string quota_key(const std::string& team, const std::string& window) {
  return "quota:" + team + ":" + window;
}

std::string reservation_key(const std::string& team, const std::string& reservation_id) {
  return "reservation:" + team + ":" + reservation_id;
}

std::string reserve(
    sw::redis::Redis& redis,
    const std::string& team,
    const std::string& window,
    const std::string& resource_class,
    long long amount) {
  const std::string reservation_id = "res-" + team;
  const std::vector<std::string> keys = {quota_key(team, window), reservation_key(team, reservation_id)};
  const std::vector<std::string> args = {
      window,
      std::to_string(amount),
      std::to_string(kDefaultLimit),
      std::to_string(kTtlSeconds),
      resource_class};
  const auto taken = redis.eval<long long>(kReserveLua, keys.begin(), keys.end(), args.begin(), args.end());
  return taken == 1 ? reservation_id : std::string();
}

/** Refunds only the window the reservation recorded, so capacity is reservable again at once. */
long long release(
    sw::redis::Redis& redis,
    const std::string& team,
    const std::string& reservation_id,
    const std::string& window) {
  const std::vector<std::string> keys = {quota_key(team, window), reservation_key(team, reservation_id)};
  const std::vector<std::string> args = {window};
  const auto refunded = redis.eval<long long>(kReleaseLua, keys.begin(), keys.end(), args.begin(), args.end());
  if (refunded == -2) throw std::runtime_error(kWindowMismatch);
  return refunded < 0 ? 0 : refunded;
}

int main() {
  sw::redis::Redis redis("tcp://redis:6379");
  httplib::Server svr;

  svr.Post("/v1/quotas/:team/reserve", [&redis](const httplib::Request& req, httplib::Response& res) {
    const auto team = req.path_params.at("team");
    if (req.get_header_value("X-Team-Id") != team) {
      res.status = 403;
      res.set_content(R"({"error":"team mismatch"})", "application/json");
      return;
    }
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) body = json::object();
    const auto window = body.value("window", std::string());
    const auto resource_class = body.value("resource_class", std::string());
    const long long amount = body.value("amount", 0);
    const auto reservation_id = reserve(redis, team, window, resource_class, amount);
    if (reservation_id.empty()) {
      res.status = 409;
      res.set_content(R"({"error":"quota_exhausted"})", "application/json");
      return;
    }
    res.status = 201;
    res.set_content(
        json{{"reservation_id", reservation_id}, {"window", window}, {"amount", amount}}.dump(),
        "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  hints: [
    'One script, not three commands. `HGET` then compare then `HINCRBY` from the client leaves a window between the read and the write where a second reserve sees the same free capacity; `EVAL` makes the read, the compare and the increment a single step.',
    'The window is part of the key, not a field. `quota:{team}:{window}` means a reservation can only be counted against the window it was taken from, and `EXPIRE` on that key — set on the first write — is what returns the pool when the window closes.',
    'Release is a write, so it needs the same treatment: read the reservation’s own `window` from `reservation:{team}:{reservation_id}`, decrement that window’s counter and delete the reservation in one script. Refusing a release that names another window keeps an expired window from borrowing the next one’s capacity.',
  ],
  debrief: `The interview question behind this step is where the invariant lives. A quota check performed in
the application is a read followed by a write, and the gap between them is proportional to
concurrency — which is exactly when the check matters. Moving the take into Redis as one script
makes the check and the mutation indivisible, so the second caller observes the first one’s
reservation rather than the state before it. The key layout is the second half: capacity is per
(team, window), so the window belongs in the key, and a TTL set on the first write is what makes
abandoned reservations return to the pool without a reaper. The release path is the third: it must
refund the window the reservation actually recorded, because a reservation whose window has expired
has already been returned and must never decrement the next window’s counter. Real brokers add an
in-flight counter for requests holding capacity across a call, a maximum hold time, and a durable
replay of grants so a Redis flush cannot silently free everything.`,
};
