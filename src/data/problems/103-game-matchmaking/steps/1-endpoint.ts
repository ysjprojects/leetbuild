import type {Step} from '@/lib/types';

export const endpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/matchmaking/tickets: one player, one ticket',
  concept: 'http',
  file: 'api',
  focus: ['client', 'api', 'redis'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it registers the queue route,
parses the body and answers **201**. It compiles, it serves the demo, and it hides three production
flaws. Review it like the service owner, fix it, and prove the fix with the checks below.

Implement \`POST /v1/matchmaking/tickets\` with body \`{"skill": 1520, "party": ["p2", "p3"]}\`.

- The player comes from the authenticated \`X-Player-Id\` header; a missing player is **401**.
- \`skill\` is a rating on the supported band \`SKILL_MIN..SKILL_MAX\`. A rating outside the band is
  **clamped** to the nearest edge — an unbounded rating, a negative one above all, lands the ticket
  in a bucket no opponent can ever reach, so the player waits forever.
- \`party\` is optional and may hold at most \`MAX_PARTY_SIZE\` (**5**) additional members; a sixth
  member is **400**. The owner plus the party is the participant set, and a duplicate in it is
  **400** — two copies of one player in one roster is the same bug as two rosters.
- A player may hold **one open ticket**. A second ticket for a player who already has one is
  **409**, and the response carries the **original ticket id**, so the caller can poll the ticket it
  already owns instead of queueing a duplicate.
- The ticket is written to \`ticket:{ticket_id}\`, the pointer \`{OPEN_TICKET}:{player}\` is set with
  \`NX\` and the ticket TTL for **every participant**, and the ticket joins its skill bucket
  \`pool:{bucket}\`, where \`bucket = clamp(skill) // BUCKET_WIDTH\`.
- Log the decision with the player, the ticket id and the bucket — this is the entry point of the
  queue, so its key and its ordering are what on-call asks about first.

**Failure mode the checks target.** The draft enqueues whatever it is handed: a party of six, a
negative rating, and a second ticket for a player who is already waiting. Each one corrupts the pool
in a different way — the oversized party creates a roster no server can seat, the out-of-band rating
creates an unreachable bucket, and the duplicate ticket is how one player ends up in two games. The
one-open-ticket guard is the quiet one: without the pointer the second enqueue looks exactly like a
first one.`,
  sequence: {
    participants: ['Game client', 'Matchmaking API', 'Redis pools'],
    messages: [
      {from: 'Game client', to: 'Matchmaking API', label: 'POST /v1/matchmaking/tickets · X-Player-Id', kind: 'sync'},
      {from: 'Matchmaking API', to: 'Matchmaking API', label: 'validate player · party · skill band', kind: 'sync'},
      {from: 'Matchmaking API', to: 'Redis pools', label: 'GET matchmaking:open:{player}', kind: 'sync'},
      {from: 'Redis pools', to: 'Matchmaking API', label: 'original ticket id / nil', kind: 'reply'},
      {from: 'Matchmaking API', to: 'Redis pools', label: 'SET …:{pid} ticket_id NX EX 900', kind: 'sync'},
      {from: 'Redis pools', to: 'Matchmaking API', label: 'ok / nil', kind: 'reply'},
      {from: 'Matchmaking API', to: 'Redis pools', label: 'ZADD pool:{bucket}', kind: 'sync'},
      {from: 'Matchmaking API', to: 'Game client', label: '201 {ticket_id, skill, participants}', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Handles POST /v1/matchmaking/tickets',
      detail: 'Register the queue route on `POST /v1/matchmaking/tickets`.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/matchmaking\/tickets["']/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/matchmaking\/tickets['"]/]},
        go: {all: [/HandleFunc\(\s*"POST \/v1\/matchmaking\/tickets"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"matchmaking"\s*\/\s*"tickets"\s*\)/, /\bpost\s*\{/]},
        cpp: {all: [/svr\.Post\(\s*"\/v1\/matchmaking\/tickets"/]},
      },
    },
    {
      id: 'player-required',
      title: 'Authenticates the player',
      detail:
        'The player is required — **401** when `X-Player-Id` is absent or empty — and it is the key the ticket is registered under. The draft reads the header and trusts whatever it finds, so a missing player creates a ticket nobody owns.',
      match: {
        python: {all: [/X-Player-Id/, /status_code\s*=\s*401/]},
        typescript: {all: [/x-player-id/, /code\(\s*401\s*\)/]},
        go: {all: [/X-Player-Id/, /StatusUnauthorized/]},
        scala: {all: [/X-Player-Id/, /StatusCodes\.Unauthorized/]},
        cpp: {all: [/X-Player-Id/, /res\.status\s*=\s*401/]},
      },
    },
    {
      id: 'party-cap',
      title: 'Caps the party at five members',
      detail:
        'The party holds at most `MAX_PARTY_SIZE` (**5**) members and anything larger is **400**. The draft takes the party as given, so a six-member party produces a roster the allocator can never seat.',
      match: {
        python: {all: [/MAX_PARTY_SIZE/, /status_code\s*=\s*400/]},
        typescript: {all: [/MAX_PARTY_SIZE/, /code\(\s*400\s*\)/]},
        go: {all: [/maxPartySize/, /StatusBadRequest/]},
        scala: {all: [/MaxPartySize/, /StatusCodes\.BadRequest/]},
        cpp: {all: [/kMaxPartySize/, /res\.status\s*=\s*400/]},
      },
    },
    {
      id: 'skill-band',
      title: 'Keeps the rating inside the supported band',
      detail:
        '`skill` is bounded by `SKILL_MIN` and `SKILL_MAX` before the ticket reaches a bucket. The draft enqueues any number, including negatives, so the ticket lands in a bucket no opponent will ever join.',
      match: {
        python: {all: [/SKILL_MIN/, /SKILL_MAX/]},
        typescript: {all: [/SKILL_MIN/, /SKILL_MAX/]},
        go: {all: [/skillMin/, /skillMax/]},
        scala: {all: [/SkillMin/, /SkillMax/]},
        cpp: {all: [/kSkillMin/, /kSkillMax/]},
      },
    },
    {
      id: 'one-open-ticket',
      title: 'Allows one open ticket per player',
      detail:
        'The pointer `{OPEN_TICKET}:{player}` is set with `NX` for every participant, and a second ticket for a player who already holds one is **409** carrying the **original ticket id**. The draft has no such guard, so a player can be claimed into two matches at once.',
      match: {
        python: {all: [/OPEN_TICKET/, /status_code\s*=\s*409/, /ticket_id/]},
        typescript: {all: [/OPEN_TICKET/, /code\(\s*409\s*\)/, /ticketId/]},
        go: {all: [/openTicketKey/, /StatusConflict/, /TicketID/]},
        scala: {all: [/OpenTicket/, /StatusCodes\.Conflict/, /ticketId/]},
        cpp: {all: [/OPEN_TICKET/, /res\.status\s*=\s*409/, /ticket_id/]},
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

BUCKET_WIDTH = 100
TICKET_TTL_S = 900


class TicketRequest(BaseModel):
    skill: float = 1500
    party: list[str] = []


@app.post("/v1/matchmaking/tickets", status_code=201)
def create_ticket(
    body: TicketRequest,
    player: str = Header(default="", alias="X-Player-Id"),
) -> dict:
    # TODO: this draft lets a party grow past five members, lets one player hold unlimited open
    # tickets so they can be matched into two games at once, and enqueues any skill value including
    # negatives. Guard the party size, the skill band and the one-open-ticket rule before the ticket
    # reaches the pool.
    ticket_id = str(uuid.uuid4())
    participants = [player, *body.party]
    ticket = {
        "ticket_id": ticket_id,
        "player_id": player,
        "skill": body.skill,
        "party": body.party,
        "participants": participants,
    }
    r.set(f"ticket:{ticket_id}", json.dumps(ticket), ex=TICKET_TTL_S)
    bucket = int(body.skill // BUCKET_WIDTH)
    r.zadd(f"pool:{bucket}", {ticket_id: body.skill})
    return ticket
`,
      solution: `import json
import uuid

import redis
from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)

SKILL_MIN = 0.0
SKILL_MAX = 4000.0
BUCKET_WIDTH = 100
MAX_PARTY_SIZE = 5
OPEN_TICKET = "matchmaking:open"
TICKET_TTL_S = 900


class TicketRequest(BaseModel):
    skill: float = 1500
    party: list[str] = []


def open_ticket_key(player_id: str) -> str:
    return f"{OPEN_TICKET}:{player_id}"


def ticket_key(ticket_id: str) -> str:
    return f"ticket:{ticket_id}"


def clamp_skill(skill: float) -> float:
    return max(SKILL_MIN, min(SKILL_MAX, skill))


@app.post("/v1/matchmaking/tickets", status_code=201)
def create_ticket(
    body: TicketRequest,
    player: str | None = Header(default=None, alias="X-Player-Id"),
) -> dict:
    if player is None or player == "":
        raise HTTPException(status_code=401, detail="missing X-Player-Id")
    if len(body.party) > MAX_PARTY_SIZE:
        raise HTTPException(status_code=400, detail="party exceeds MAX_PARTY_SIZE")
    participants = [player, *body.party]
    if len(set(participants)) != len(participants):
        raise HTTPException(status_code=400, detail="duplicate player in party")

    skill = clamp_skill(body.skill)
    for pid in participants:
        existing = r.get(open_ticket_key(pid))
        if existing is not None:
            raise HTTPException(
                status_code=409,
                detail={"error": "player already has an open ticket", "ticket_id": existing},
            )

    ticket_id = str(uuid.uuid4())
    for pid in participants:
        claimed = r.set(open_ticket_key(pid), ticket_id, nx=True, ex=TICKET_TTL_S)
        if not claimed:
            existing = r.get(open_ticket_key(pid))
            raise HTTPException(
                status_code=409,
                detail={"error": "player already has an open ticket", "ticket_id": existing},
            )

    ticket = {
        "ticket_id": ticket_id,
        "player_id": player,
        "skill": skill,
        "party": body.party,
        "participants": participants,
    }
    r.set(ticket_key(ticket_id), json.dumps(ticket), ex=TICKET_TTL_S)
    bucket = int(skill // BUCKET_WIDTH)
    r.zadd(f"pool:{bucket}", {ticket_id: skill})
    return ticket
`,
    },
    typescript: {
      starter: `/** POST /v1/matchmaking/tickets: a model-generated draft that enqueues whatever it is handed. */
import {randomUUID} from 'node:crypto';

import Fastify from 'fastify';
import {Redis} from 'ioredis';

export const app = Fastify();
const r = new Redis('redis://redis:6379');

const BUCKET_WIDTH = 100;
const TICKET_TTL_S = 900;

interface TicketRequest {
  skill?: number;
  party?: string[];
}

app.post('/v1/matchmaking/tickets', async (request, reply) => {
  // TODO: this draft lets a party grow past five members, lets one player hold unlimited open
  // tickets so they can be matched into two games at once, and enqueues any skill value including
  // negatives. Guard the party size, the skill band and the one-open-ticket rule before the ticket
  // reaches the pool.
  const player = request.headers['x-player-id'] as string;
  const body = (request.body ?? {}) as TicketRequest;
  const party = body.party ?? [];
  const skill = body.skill ?? 1500;
  const participants = [player, ...party];
  const ticketId = randomUUID();
  const ticket = {ticket_id: ticketId, player_id: player, skill, party, participants};
  await r.set('ticket:' + ticketId, JSON.stringify(ticket), 'EX', TICKET_TTL_S);
  const bucket = Math.floor(skill / BUCKET_WIDTH);
  await r.zadd('pool:' + bucket, String(skill), ticketId);
  return reply.code(201).send(ticket);
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** POST /v1/matchmaking/tickets: one player, one open ticket. */
import {randomUUID} from 'node:crypto';

import Fastify from 'fastify';
import {Redis} from 'ioredis';

export const app = Fastify();
const r = new Redis('redis://redis:6379');

const SKILL_MIN = 0;
const SKILL_MAX = 4000;
const BUCKET_WIDTH = 100;
const MAX_PARTY_SIZE = 5;
const TICKET_TTL_S = 900;
const OPEN_TICKET = 'matchmaking:open';

interface TicketRequest {
  skill?: number;
  party?: string[];
}

function openTicketKey(playerId: string): string {
  return OPEN_TICKET + ':' + playerId;
}

function ticketKey(ticketId: string): string {
  return 'ticket:' + ticketId;
}

function clampSkill(skill: number): number {
  return Math.max(SKILL_MIN, Math.min(SKILL_MAX, skill));
}

app.post('/v1/matchmaking/tickets', async (request, reply) => {
  const player = request.headers['x-player-id'];
  if (typeof player !== 'string' || player === '') return reply.code(401).send({error: 'missing X-Player-Id'});

  const body = (request.body ?? {}) as TicketRequest;
  const party = body.party ?? [];
  if (party.length > MAX_PARTY_SIZE)
    return reply.code(400).send({error: 'party exceeds MAX_PARTY_SIZE'});

  const participants = [player, ...party];
  if (new Set(participants).size !== participants.length)
    return reply.code(400).send({error: 'duplicate player in party'});

  const skill = clampSkill(body.skill ?? 1500);

  for (const pid of participants) {
    const existing = await r.get(openTicketKey(pid));
    if (existing !== null)
      return reply.code(409).send({error: 'player already has an open ticket', ticket_id: existing});
  }

  const ticketId = randomUUID();
  for (const pid of participants) {
    const claimed = await r.set(openTicketKey(pid), ticketId, 'EX', TICKET_TTL_S, 'NX');
    if (claimed === null)
      return reply
        .code(409)
        .send({error: 'player already has an open ticket', ticket_id: await r.get(openTicketKey(pid))});
  }

  const ticket = {ticket_id: ticketId, player_id: player, skill, party, participants};
  await r.set(ticketKey(ticketId), JSON.stringify(ticket), 'EX', TICKET_TTL_S);
  await r.zadd('pool:' + Math.floor(skill / BUCKET_WIDTH), String(skill), ticketId);
  return reply.code(201).send(ticket);
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"strconv"

	"github.com/google/uuid"
	"github.com/redis/go-redis/v9"
)

const (
	bucketWidth = 100
	ticketTtlS  = 900
)

type TicketRequest struct {
	Skill float64  \`json:"skill"\`
	Party []string \`json:"party"\`
}

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func createTicket(rw http.ResponseWriter, req *http.Request) {
	ctx := req.Context()
	player := req.Header.Get("X-Player-Id")
	var body TicketRequest
	if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	// TODO: this draft lets a party grow past five members, lets one player hold unlimited open
	// tickets so they can be matched into two games at once, and enqueues any skill value including
	// negatives. Guard the party size, the skill band and the one-open-ticket rule before the ticket
	// reaches the pool.
	ticketID := uuid.NewString()
	ticket := map[string]any{
		"ticket_id":    ticketID,
		"player_id":    player,
		"skill":        body.Skill,
		"party":        body.Party,
		"participants": append([]string{player}, body.Party...),
	}
	rdb.Set(ctx, "ticket:"+ticketID, mustJSON(ticket), ticketTtlS*1e9)
	bucket := int(body.Skill) / bucketWidth
	rdb.ZAdd(ctx, "pool:"+strconv.Itoa(bucket), redis.Z{Score: body.Skill, Member: ticketID})
	writeJSON(rw, http.StatusCreated, ticket)
}

func mustJSON(v any) string {
	b, _ := json.Marshal(v)
	return string(b)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/matchmaking/tickets", createTicket)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"strconv"
	"time"

	"github.com/google/uuid"
	"github.com/redis/go-redis/v9"
)

const (
	skillMin    = 0.0
	skillMax    = 4000.0
	bucketWidth = 100
	maxPartySize = 5
	ticketTtlS  = 900
	openTicket  = "matchmaking:open"
)

type TicketRequest struct {
	Skill float64  \`json:"skill"\`
	Party []string \`json:"party"\`
}

type TicketConflict struct {
	Error    string \`json:"error"\`
	TicketID string \`json:"ticket_id"\`
}

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

func openTicketKey(playerID string) string {
	return openTicket + ":" + playerID
}

func ticketKey(ticketID string) string {
	return "ticket:" + ticketID
}

func clampSkill(skill float64) float64 {
	if skill < skillMin {
		return skillMin
	}
	if skill > skillMax {
		return skillMax
	}
	return skill
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func conflict(rw http.ResponseWriter, existing string) {
	writeJSON(rw, http.StatusConflict, TicketConflict{
		Error:    "player already has an open ticket",
		TicketID: existing,
	})
}

func createTicket(rw http.ResponseWriter, req *http.Request) {
	ctx := req.Context()
	player := req.Header.Get("X-Player-Id")
	if player == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-Player-Id"})
		return
	}
	var body TicketRequest
	if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	if len(body.Party) > maxPartySize {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "party exceeds MAX_PARTY_SIZE"})
		return
	}
	participants := append([]string{player}, body.Party...)
	seen := map[string]bool{}
	for _, pid := range participants {
		if seen[pid] {
			writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "duplicate player in party"})
			return
		}
		seen[pid] = true
	}
	skill := clampSkill(body.Skill)
	for _, pid := range participants {
		existing, _ := rdb.Get(ctx, openTicketKey(pid)).Result()
		if existing != "" {
			conflict(rw, existing)
			return
		}
	}
	ticketID := uuid.NewString()
	ttl := time.Duration(ticketTtlS) * time.Second
	for _, pid := range participants {
		ok, _ := rdb.SetNX(ctx, openTicketKey(pid), ticketID, ttl).Result()
		if !ok {
			existing, _ := rdb.Get(ctx, openTicketKey(pid)).Result()
			conflict(rw, existing)
			return
		}
	}
	ticket := map[string]any{
		"ticket_id":    ticketID,
		"player_id":    player,
		"skill":        skill,
		"party":        body.Party,
		"participants": participants,
	}
	payload, _ := json.Marshal(ticket)
	rdb.Set(ctx, ticketKey(ticketID), payload, ttl)
	rdb.ZAdd(ctx, "pool:"+strconv.Itoa(int(skill)/bucketWidth), redis.Z{Score: skill, Member: ticketID})
	log.Printf("ticket player=%s ticket_id=%s bucket=%d", player, ticketID, int(skill)/bucketWidth)
	writeJSON(rw, http.StatusCreated, ticket)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/matchmaking/tickets", createTicket)
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
import redis.clients.jedis.Jedis
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

import java.util.UUID

final case class TicketRequest(skill: Double, party: List[String])
final case class Ticket(ticket_id: String, player_id: String, skill: Double, party: List[String], participants: List[String])

object MatchmakingApi {
  implicit val system: ActorSystem = ActorSystem("game-matchmaking")
  implicit val requestFormat: RootJsonFormat[TicketRequest] = jsonFormat2(TicketRequest)
  implicit val ticketFormat: RootJsonFormat[Ticket] = jsonFormat5(Ticket)

  val BucketWidth = 100
  val TicketTtlS = 900

  val jedis = new Jedis("redis", 6379)

  val route: Route =
    path("v1" / "matchmaking" / "tickets") {
      post {
        headerValueByName("X-Player-Id") { player =>
          entity(as[TicketRequest]) { body =>
            // TODO: this draft lets a party grow past five members, lets one player hold unlimited
            // open tickets so they can be matched into two games at once, and enqueues any skill
            // value including negatives. Guard the party size, the skill band and the one-open-ticket
            // rule before the ticket reaches the pool.
            val ticketId = UUID.randomUUID().toString
            val participants = player :: body.party
            val ticket = Ticket(ticketId, player, body.skill, body.party, participants)
            jedis.set("ticket:" + ticketId, ticket.toJson.compactPrint)
            val bucket = (body.skill / BucketWidth).toInt
            jedis.zadd("pool:" + bucket, body.skill, ticketId)
            complete(StatusCodes.Created, ticket)
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
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import redis.clients.jedis.Jedis
import redis.clients.jedis.params.SetParams
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

import java.util.UUID

final case class TicketRequest(skill: Double, party: List[String])
final case class Ticket(ticket_id: String, player_id: String, skill: Double, party: List[String], participants: List[String])

object MatchmakingApi {
  implicit val system: ActorSystem = ActorSystem("game-matchmaking")
  implicit val requestFormat: RootJsonFormat[TicketRequest] = jsonFormat2(TicketRequest)
  implicit val ticketFormat: RootJsonFormat[Ticket] = jsonFormat5(Ticket)

  val SkillMin = 0.0
  val SkillMax = 4000.0
  val BucketWidth = 100
  val MaxPartySize = 5
  val TicketTtlS = 900
  val OpenTicket = "matchmaking:open"

  val jedis = new Jedis("redis", 6379)

  def openTicketKey(playerId: String): String = OpenTicket + ":" + playerId
  def ticketKey(ticketId: String): String = "ticket:" + ticketId
  def clampSkill(skill: Double): Double = math.max(SkillMin, math.min(SkillMax, skill))

  val route: Route =
    path("v1" / "matchmaking" / "tickets") {
      post {
        optionalHeaderValueByName("X-Player-Id") { playerOpt =>
          entity(as[TicketRequest]) { body =>
            if (!playerOpt.exists(_.nonEmpty)) {
              complete(StatusCodes.Unauthorized, """{"error":"missing X-Player-Id"}""")
            } else if (body.party.size > MaxPartySize) {
              complete(StatusCodes.BadRequest, """{"error":"party exceeds MAX_PARTY_SIZE"}""")
            } else {
              val player = playerOpt.get
              val participants = player :: body.party
              if (participants.distinct.size != participants.size) {
                complete(StatusCodes.BadRequest, """{"error":"duplicate player in party"}""")
              } else {
                val skill = clampSkill(body.skill)
                val blocked = participants.find(pid => Option(jedis.get(openTicketKey(pid))).exists(_.nonEmpty))
                blocked match {
                  case Some(pid) =>
                    val existing = jedis.get(openTicketKey(pid))
                    complete(
                      StatusCodes.Conflict,
                      s"""{"error":"player already has an open ticket","ticket_id":"$existing"}"""
                    )
                  case None =>
                    val ticketId = UUID.randomUUID().toString
                    val params = SetParams.setParams().nx().ex(TicketTtlS)
                    val refused = participants.find(pid => jedis.set(openTicketKey(pid), ticketId, params) == null)
                    refused match {
                      case Some(pid) =>
                        val existing = jedis.get(openTicketKey(pid))
                        complete(
                          StatusCodes.Conflict,
                          s"""{"error":"player already has an open ticket","ticket_id":"$existing"}"""
                        )
                      case None =>
                        val ticket = Ticket(ticketId, player, skill, body.party, participants)
                        jedis.set(ticketKey(ticketId), ticket.toJson.compactPrint)
                        val bucket = (skill / BucketWidth).toInt
                        jedis.zadd("pool:" + bucket, skill, ticketId)
                        system.log.info(s"ticket player=$player ticket_id=$ticketId bucket=$bucket")
                        complete(StatusCodes.Created, ticket)
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
#include <sw/redis++/redis++.h>

#include <string>
#include <vector>

using json = nlohmann::json;
using sw::redis::Redis;

constexpr int kBucketWidth = 100;
constexpr int kTicketTtlS = 900;

Redis r("tcp://redis:6379");
std::string uuidString();

int main() {
  httplib::Server svr;

  svr.Post("/v1/matchmaking/tickets", [](const httplib::Request& req, httplib::Response& res) {
    // TODO: this draft lets a party grow past five members, lets one player hold unlimited open
    // tickets so they can be matched into two games at once, and enqueues any skill value including
    // negatives. Guard the party size, the skill band and the one-open-ticket rule before the ticket
    // reaches the pool.
    const auto player = req.get_header_value("X-Player-Id");
    const json body = json::parse(req.body, nullptr, false);
    const double skill = body.value("skill", 1500.0);
    const std::vector<std::string> party = body.value("party", std::vector<std::string>{});
    const auto ticketId = uuidString();
    std::vector<std::string> participants{player};
    participants.insert(participants.end(), party.begin(), party.end());
    const json ticket = {
        {"ticket_id", ticketId},
        {"player_id", player},
        {"skill", skill},
        {"party", party},
        {"participants", participants},
    };
    r.set("ticket:" + ticketId, ticket.dump(), std::chrono::seconds(kTicketTtlS));
    const int bucket = static_cast<int>(skill) / kBucketWidth;
    r.zadd("pool:" + std::to_string(bucket), ticketId, skill);
    res.status = 201;
    res.set_content(ticket.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <algorithm>
#include <string>
#include <vector>

using json = nlohmann::json;
using sw::redis::Redis;

constexpr double kSkillMin = 0.0;
constexpr double kSkillMax = 4000.0;
constexpr int kBucketWidth = 100;
constexpr int kMaxPartySize = 5;
constexpr int kTicketTtlS = 900;
constexpr const char* OPEN_TICKET = "matchmaking:open";

Redis r("tcp://redis:6379");
std::string uuidString();

std::string openTicketKey(const std::string& playerId) {
  return std::string(OPEN_TICKET) + ":" + playerId;
}

double clampSkill(double skill) {
  return std::max(kSkillMin, std::min(kSkillMax, skill));
}

int main() {
  httplib::Server svr;

  svr.Post("/v1/matchmaking/tickets", [](const httplib::Request& req, httplib::Response& res) {
    const auto player = req.get_header_value("X-Player-Id");
    if (player.empty()) {
      res.status = 401;
      res.set_content(R"({"error":"missing X-Player-Id"})", "application/json");
      return;
    }
    const json body = json::parse(req.body, nullptr, false);
    const std::vector<std::string> party = body.value("party", std::vector<std::string>{});
    if (static_cast<int>(party.size()) > kMaxPartySize) {
      res.status = 400;
      res.set_content(R"({"error":"party exceeds MAX_PARTY_SIZE"})", "application/json");
      return;
    }
    std::vector<std::string> participants{player};
    participants.insert(participants.end(), party.begin(), party.end());
    std::vector<std::string> unique = participants;
    std::sort(unique.begin(), unique.end());
    if (std::adjacent_find(unique.begin(), unique.end()) != unique.end()) {
      res.status = 400;
      res.set_content(R"({"error":"duplicate player in party"})", "application/json");
      return;
    }
    const double skill = clampSkill(body.value("skill", 1500.0));
    for (const auto& pid : participants) {
      const auto existing = r.get(openTicketKey(pid));
      if (existing) {
        res.status = 409;
        res.set_content(
            json{{"error", "player already has an open ticket"}, {"ticket_id", *existing}}.dump(),
            "application/json");
        return;
      }
    }
    const auto ticketId = uuidString();
    for (const auto& pid : participants) {
      const bool claimed =
          r.set(openTicketKey(pid), ticketId, std::chrono::seconds(kTicketTtlS), sw::redis::UpdateType::NOT_EXIST);
      if (!claimed) {
        const auto existing = r.get(openTicketKey(pid));
        res.status = 409;
        res.set_content(
            json{{"error", "player already has an open ticket"}, {"ticket_id", existing.value_or("")}}.dump(),
            "application/json");
        return;
      }
    }
    const json ticket = {
        {"ticket_id", ticketId},
        {"player_id", player},
        {"skill", skill},
        {"party", party},
        {"participants", participants},
    };
    r.set("ticket:" + ticketId, ticket.dump(), std::chrono::seconds(kTicketTtlS));
    const int bucket = static_cast<int>(skill) / kBucketWidth;
    r.zadd("pool:" + std::to_string(bucket), ticketId, skill);
    res.status = 201;
    res.set_content(ticket.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  hints: [
    'Write the guard clauses first, in cost order: player, party size, skill band, then the open ticket. Each one returns before the ticket is written, so a malformed request can never leave a ticket or a pointer behind.',
    'The one-open-ticket rule needs a pointer **per participant**, not just the owner: the party members are players too and can be queued elsewhere. `SET {OPEN_TICKET}:{pid} ticket_id NX EX TICKET_TTL_S` is the guard; when the set fails, read the pointer to return the original ticket id.',
    'Clamp the rating before you derive the bucket. `bucket = clamp(skill) // BUCKET_WIDTH` keeps the band in one place, and an out-of-band rating can no longer create a bucket that no opponent will ever join. Keep `SKILL_MIN` and `SKILL_MAX` as named constants so the band is a policy, not a literal.',
  ],
  debrief: `The interviewer is testing whether you can review a generated write path on the entry point of a queue. The draft reads fine because the demo posts well-formed requests from one player who never retries. Three defects are being checked: the party cap (a six-member party is a roster the allocator cannot seat), the skill band (an out-of-band or negative rating lands the ticket in a bucket nobody joins, so the player waits forever), and the one-open-ticket rule. The last one is the subtle one: the ticket id is minted by the server, and without a pointer keyed by the player there is nothing that stops the same player — or a member of their party — from being enqueued twice and claimed into two rosters. The check on the original ticket id matters too: a 409 that says "you already have a ticket" without telling the caller which one is useless to a client that has to poll. Real queues add a ticket TTL, a per-bucket \`SKILL_MIN\`/band policy, and a party-wide "ready check" so the whole party is claimed or none of it is — which is exactly the next step.`,
};
