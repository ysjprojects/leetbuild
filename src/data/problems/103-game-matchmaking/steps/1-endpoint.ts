import type {Step} from '@/lib/types';

export const endpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/matchmaking/tickets: one player, one open ticket',
  concept: 'http',
  guides: ['request-boundaries', 'atomic-state'],
  file: 'api',
  focus: ['client', 'api', 'redis'],
  task: `## Task

**Starting point.** The starter serves \`POST /v1/matchmaking/tickets\` with body
\`{"skill": 1520, "party": ["p2", "p3"]}\`: it reads the player from \`X-Player-Id\`, takes an id from
\`store.next_ticket_id()\`, calls \`store.enqueue(ticket_id, player, skill, participants)\` (provided:
the ticket hash, \`ZADD pool:{bucket}\`, the depth counter) and answers **201** with the ticket id,
skill, bucket and participants. It serves the demo and hides 4 flaws.

**Failure mode the checks target.** The starter queues whatever arrives: a ticket nobody owns, a
party of six, a rating of -50 in a bucket where nobody else waits, and a second ticket for a player
who is already waiting, which is how one player ends up in two games.

- A missing or empty \`X-Player-Id\` is **401**.
- \`party\` holds at most \`MAX_PARTY_SIZE\` (5) members; more, or a player listed twice (the owner
  included), is **400**.
- \`skill\` is clamped to \`SKILL_MIN\`..\`SKILL_MAX\` (0..4000) before the bucket is derived.
- One open ticket per player: \`SET open:{player} <ticket_id> NX EX 900\` (\`store.open_key\`) for
  every participant before the enqueue. A player who already holds one makes the request **409**
  with \`{"ticket_id": <the open ticket>}\`, and the pointers this request took are deleted again.
- A refused request writes nothing.`,
  sequence: {
    participants: ['Game client', 'Matchmaking API', 'Redis'],
    messages: [
      {from: 'Game client', to: 'Matchmaking API', label: 'POST /v1/matchmaking/tickets · X-Player-Id', kind: 'sync'},
      {from: 'Matchmaking API', to: 'Matchmaking API', label: 'player · party ≤ 5 · clamp skill', kind: 'sync'},
      {from: 'Matchmaking API', to: 'Redis', label: 'SET open:{pid} t-7 NX EX 900 (each participant)', kind: 'sync'},
      {from: 'Redis', to: 'Matchmaking API', label: 'OK · or nil: GET open:{pid} → 409', kind: 'reply'},
      {
        from: 'Matchmaking API',
        to: 'Redis',
        label: 'enqueue: HSET ticket · ZADD pool:15 · HINCRBY depth',
        kind: 'sync',
      },
      {
        from: 'Matchmaking API',
        to: 'Game client',
        label: '201 {ticket_id, skill, bucket, participants}',
        kind: 'reply',
      },
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Queues a ticket on POST /v1/matchmaking/tickets',
      detail:
        'A valid request answers **201** with the ticket id, skill, bucket and participants, and the ticket waits in `pool:{bucket}` scored by its skill.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/matchmaking\/tickets["']/, /store\.enqueue\(/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/matchmaking\/tickets['"]/, /enqueue\(/]},
        go: {all: [/HandleFunc\(\s*"POST \/v1\/matchmaking\/tickets"/, /store\.Enqueue\(/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"matchmaking"\s*\/\s*"tickets"\s*\)/, /\bpost\s*\{/, /Store\.enqueue\(/]},
        cpp: {all: [/svr\.Post\(\s*"\/v1\/matchmaking\/tickets"/, /store::enqueue\(/]},
      },
    },
    {
      id: 'player-required',
      title: 'A ticket needs a player: 401 without X-Player-Id',
      detail:
        'A missing or empty `X-Player-Id` answers **401** before anything is written; the starter queues a ticket owned by the empty string.',
      match: {
        python: {all: [/x-player-id/i, /\b401\b/]},
        typescript: {all: [/x-player-id/i, /code\(\s*401\s*\)/]},
        go: {all: [/X-Player-Id/i, /StatusUnauthorized|\b401\b/]},
        scala: {all: [/X-Player-Id/i, /Unauthorized|\b401\b/]},
        cpp: {all: [/X-Player-Id/i, /\b401\b/]},
      },
    },
    {
      id: 'party-cap',
      title: 'A party holds at most five members, each once',
      detail: 'More than `MAX_PARTY_SIZE` (5) members, or a player listed twice, answers **400** and queues nothing.',
      match: {
        python: {all: [/MAX_PARTY_SIZE\s*=\s*5\b/, /len\([^)\n]*party\)\s*>\s*MAX_PARTY_SIZE/, /\b400\b/]},
        typescript: {all: [/MAX_PARTY_SIZE\s*=\s*5\b/, /party\.length\s*>\s*MAX_PARTY_SIZE/, /code\(\s*400\s*\)/]},
        go: {all: [/maxPartySize\s*=\s*5\b/, /len\([^)\n]*Party\)\s*>\s*maxPartySize/, /StatusBadRequest|\b400\b/]},
        scala: {all: [/MaxPartySize\s*=\s*5\b/, /party\.(size|length)\s*>\s*MaxPartySize/, /BadRequest|\b400\b/]},
        cpp: {all: [/kMaxPartySize\s*=\s*5\b/, /party\.size\(\)\s*>\s*kMaxPartySize/, /\b400\b/]},
      },
    },
    {
      id: 'skill-band',
      title: 'Clamps the rating to the supported band',
      detail:
        '`skill` is clamped to `SKILL_MIN`..`SKILL_MAX` before the bucket is derived, so -50 waits in bucket 0 and 9000 in bucket 40.',
      match: {
        python: {all: [/SKILL_MIN\s*=\s*0\b/, /SKILL_MAX\s*=\s*4000\b/, /max\(|min\(/]},
        typescript: {all: [/SKILL_MIN\s*=\s*0\b/, /SKILL_MAX\s*=\s*4000\b/, /Math\.(max|min)\(/]},
        go: {all: [/skillMin\s*=\s*0\b/, /skillMax\s*=\s*4000\b/, /skill\s*[<>]=?\s*skill(Min|Max)|max\(|min\(/]},
        scala: {all: [/SkillMin\s*=\s*0L?\b/, /SkillMax\s*=\s*4000L?\b/, /\.max\(|\.min\(|math\.(max|min)|clamp/]},
        cpp: {all: [/kSkillMin\s*=\s*0\b/, /kSkillMax\s*=\s*4000\b/, /std::(clamp|max|min)\(/]},
      },
    },
    {
      id: 'one-open-ticket',
      title: 'One open ticket per player: 409 with the original id',
      detail:
        'Every participant takes `open:{player}` with `SET … NX EX` before the enqueue; a player who already holds one answers **409** with that ticket id, and the pointers the refused request took are deleted.',
      match: {
        python: {all: [/store\.open_key\(/, /nx\s*=\s*True/, /\b409\b/]},
        typescript: {all: [/openKey\(/, /['"]NX['"]/, /code\(\s*409\s*\)/]},
        go: {all: [/store\.OpenKey\(/, /\.SetNX\(|\.SetArgs\(/, /StatusConflict|\b409\b/]},
        scala: {all: [/Store\.openKey\(/, /\.nx\(\)/, /Conflict|\b409\b/]},
        cpp: {all: [/store::openKey\(/, /UpdateType::NOT_EXIST/, /\b409\b/]},
      },
    },
  ],
  code: {
    python: {
      starter: `from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from matchmaking import store  # next_ticket_id, enqueue, open_key, get_ticket

app = FastAPI()


class TicketRequest(BaseModel):
    skill: int = 1500
    party: list[str] = []


@app.post("/v1/matchmaking/tickets")
def create_ticket(body: TicketRequest, request: Request) -> JSONResponse:
    # TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
    player = request.headers.get("x-player-id", "")
    participants = [player, *body.party]
    ticket = store.enqueue(store.next_ticket_id(), player, body.skill, participants)
    return JSONResponse(
        {
            "ticket_id": ticket["ticket_id"],
            "player_id": player,
            "skill": ticket["skill"],
            "bucket": ticket["bucket"],
            "participants": participants,
        },
        status_code=201,
    )
`,
      solution: `import redis
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from matchmaking import store  # next_ticket_id, enqueue, open_key, get_ticket

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)

SKILL_MIN = 0
SKILL_MAX = 4000
MAX_PARTY_SIZE = 5
TICKET_TTL_S = 900


class TicketRequest(BaseModel):
    skill: int = 1500
    party: list[str] = []


@app.post("/v1/matchmaking/tickets")
def create_ticket(body: TicketRequest, request: Request) -> JSONResponse:
    player = request.headers.get("x-player-id", "")
    if not player:
        return JSONResponse({"error": "X-Player-Id is required"}, status_code=401)
    if len(body.party) > MAX_PARTY_SIZE:
        return JSONResponse({"error": f"a party holds at most {MAX_PARTY_SIZE} members"}, status_code=400)
    participants = [player, *body.party]
    if len(set(participants)) != len(participants):
        return JSONResponse({"error": "a player is listed twice"}, status_code=400)
    skill = max(SKILL_MIN, min(SKILL_MAX, body.skill))

    ticket_id = store.next_ticket_id()
    taken = []
    for pid in participants:
        # One open ticket per player: the pointer is taken before the ticket exists.
        if not r.set(store.open_key(pid), ticket_id, nx=True, ex=TICKET_TTL_S):
            existing = r.get(store.open_key(pid))
            for other in taken:
                r.delete(store.open_key(other))
            return JSONResponse({"error": f"{pid} already has an open ticket", "ticket_id": existing}, status_code=409)
        taken.append(pid)

    ticket = store.enqueue(ticket_id, player, skill, participants)
    return JSONResponse(
        {
            "ticket_id": ticket_id,
            "player_id": player,
            "skill": ticket["skill"],
            "bucket": ticket["bucket"],
            "participants": participants,
        },
        status_code=201,
    )
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';

import {enqueue, nextTicketId} from 'matchmaking/store';

export const app = Fastify();

interface TicketRequest {
  skill?: number;
  party?: string[];
}

app.post('/v1/matchmaking/tickets', async (request, reply) => {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  const player = (request.headers['x-player-id'] as string | undefined) ?? '';
  const body = (request.body ?? {}) as TicketRequest;
  const participants = [player, ...(body.party ?? [])];
  const ticket = await enqueue(await nextTicketId(), player, body.skill ?? 1500, participants);
  return reply.code(201).send({ticket_id: ticket.ticket_id, player_id: player, skill: ticket.skill, bucket: ticket.bucket, participants});
});
`,
      solution: `import Fastify from 'fastify';
import Redis from 'ioredis';

import {enqueue, nextTicketId, openKey} from 'matchmaking/store';

export const app = Fastify();
const redis = new Redis({host: 'redis', port: 6379});

export const SKILL_MIN = 0;
export const SKILL_MAX = 4000;
export const MAX_PARTY_SIZE = 5;
export const TICKET_TTL_S = 900;

interface TicketRequest {
  skill?: number;
  party?: string[];
}

app.post('/v1/matchmaking/tickets', async (request, reply) => {
  const player = (request.headers['x-player-id'] as string | undefined) ?? '';
  if (player === '') return reply.code(401).send({error: 'X-Player-Id is required'});
  const body = (request.body ?? {}) as TicketRequest;
  const party = body.party ?? [];
  if (party.length > MAX_PARTY_SIZE) return reply.code(400).send({error: \`a party holds at most \${MAX_PARTY_SIZE} members\`});
  const participants = [player, ...party];
  if (new Set(participants).size !== participants.length) return reply.code(400).send({error: 'a player is listed twice'});
  const skill = Math.min(SKILL_MAX, Math.max(SKILL_MIN, body.skill ?? 1500));

  const ticketId = await nextTicketId();
  const taken: string[] = [];
  for (const pid of participants) {
    // One open ticket per player: the pointer is taken before the ticket exists.
    if ((await redis.set(openKey(pid), ticketId, 'EX', TICKET_TTL_S, 'NX')) === null) {
      const existing = await redis.get(openKey(pid));
      for (const other of taken) await redis.del(openKey(other));
      return reply.code(409).send({error: \`\${pid} already has an open ticket\`, ticket_id: existing});
    }
    taken.push(pid);
  }

  const ticket = await enqueue(ticketId, player, skill, participants);
  return reply.code(201).send({ticket_id: ticketId, player_id: player, skill: ticket.skill, bucket: ticket.bucket, participants});
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"net/http"

	"matchmaking/store" // store.NextTicketID, Enqueue, OpenKey, GetTicket
)

type ticketRequest struct {
	Skill *int     \`json:"skill"\`
	Party []string \`json:"party"\`
}

type ticketResponse struct {
	TicketID     string   \`json:"ticket_id"\`
	PlayerID     string   \`json:"player_id"\`
	Skill        int      \`json:"skill"\`
	Bucket       int      \`json:"bucket"\`
	Participants []string \`json:"participants"\`
}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func createTicket(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
	player := r.Header.Get("X-Player-Id")
	var body ticketRequest
	json.NewDecoder(r.Body).Decode(&body)
	skill := 1500
	if body.Skill != nil {
		skill = *body.Skill
	}
	participants := append([]string{player}, body.Party...)
	ticket := store.Enqueue(r.Context(), store.NextTicketID(r.Context()), player, skill, participants)
	writeJSON(rw, http.StatusCreated, ticketResponse{TicketID: ticket.TicketID, PlayerID: player, Skill: ticket.Skill, Bucket: ticket.Bucket, Participants: participants})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/matchmaking/tickets", createTicket)
}
`,
      solution: `package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/redis/go-redis/v9"

	"matchmaking/store" // store.NextTicketID, Enqueue, OpenKey, GetTicket
)

const (
	skillMin     = 0
	skillMax     = 4000
	maxPartySize = 5
	ticketTTL    = 900 * time.Second
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

type ticketRequest struct {
	Skill *int     \`json:"skill"\`
	Party []string \`json:"party"\`
}

type ticketResponse struct {
	TicketID     string   \`json:"ticket_id"\`
	PlayerID     string   \`json:"player_id"\`
	Skill        int      \`json:"skill"\`
	Bucket       int      \`json:"bucket"\`
	Participants []string \`json:"participants"\`
}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func createTicket(rw http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	player := r.Header.Get("X-Player-Id")
	if player == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "X-Player-Id is required"})
		return
	}
	var body ticketRequest
	json.NewDecoder(r.Body).Decode(&body)
	if len(body.Party) > maxPartySize {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": fmt.Sprintf("a party holds at most %d members", maxPartySize)})
		return
	}
	participants := append([]string{player}, body.Party...)
	seen := map[string]bool{}
	for _, pid := range participants {
		if seen[pid] {
			writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "a player is listed twice"})
			return
		}
		seen[pid] = true
	}
	skill := 1500
	if body.Skill != nil {
		skill = *body.Skill
	}
	if skill < skillMin {
		skill = skillMin
	}
	if skill > skillMax {
		skill = skillMax
	}

	ticketID := store.NextTicketID(ctx)
	taken := []string{}
	for _, pid := range participants {
		// One open ticket per player: the pointer is taken before the ticket exists.
		ok, err := rdb.SetNX(ctx, store.OpenKey(pid), ticketID, ticketTTL).Result()
		if err != nil {
			http.Error(rw, err.Error(), http.StatusInternalServerError)
			return
		}
		if !ok {
			existing := rdb.Get(ctx, store.OpenKey(pid)).Val()
			for _, other := range taken {
				rdb.Del(ctx, store.OpenKey(other))
			}
			writeJSON(rw, http.StatusConflict, map[string]string{"error": pid + " already has an open ticket", "ticket_id": existing})
			return
		}
		taken = append(taken, pid)
	}

	ticket := store.Enqueue(ctx, ticketID, player, skill, participants)
	writeJSON(rw, http.StatusCreated, ticketResponse{TicketID: ticketID, PlayerID: player, Skill: ticket.Skill, Bucket: ticket.Bucket, Participants: participants})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/matchmaking/tickets", createTicket)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import matchmaking.Store // Store.nextTicketId, enqueue, openKey, getTicket

object Api {
  private def json(status: StatusCode, body: JsObject): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  private def created(ticket: Store.Ticket, player: String, participants: Seq[String]): HttpResponse =
    json(StatusCodes.Created, JsObject(
      "ticket_id" -> JsString(ticket.ticketId), "player_id" -> JsString(player), "skill" -> JsNumber(ticket.skill),
      "bucket" -> JsNumber(ticket.bucket), "participants" -> JsArray(participants.map(JsString(_)).toVector)))

  val route: Route = path("v1" / "matchmaking" / "tickets") {
    post {
      optionalHeaderValueByName("X-Player-Id") { header =>
        entity(as[String]) { raw =>
          // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
          val player = header.getOrElse("")
          val body = raw.parseJson.asJsObject.fields
          val skill = body.get("skill").collect { case JsNumber(n) => n.toLong }.getOrElse(1500L)
          val party = body.get("party").collect { case JsArray(items) => items.collect { case JsString(s) => s } }.getOrElse(Vector.empty)
          val participants = player +: party
          val ticket = Store.enqueue(Store.nextTicketId(), player, skill, participants)
          complete(created(ticket, player, participants))
        }
      }
    }
  }
}
`,
      solution: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import redis.clients.jedis.JedisPooled
import redis.clients.jedis.params.SetParams
import spray.json._

import matchmaking.Store // Store.nextTicketId, enqueue, openKey, getTicket

object Api {
  val SkillMin = 0L
  val SkillMax = 4000L
  val MaxPartySize = 5
  val TicketTtlS = 900L

  private val jedis = new JedisPooled("redis", 6379)

  private def json(status: StatusCode, body: JsObject): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  private def error(status: StatusCode, message: String): HttpResponse = json(status, JsObject("error" -> JsString(message)))

  private def created(ticket: Store.Ticket, player: String, participants: Seq[String]): HttpResponse =
    json(StatusCodes.Created, JsObject(
      "ticket_id" -> JsString(ticket.ticketId), "player_id" -> JsString(player), "skill" -> JsNumber(ticket.skill),
      "bucket" -> JsNumber(ticket.bucket), "participants" -> JsArray(participants.map(JsString(_)).toVector)))

  /** Takes open:{pid} for every participant; the first player who already holds a ticket, with that ticket. */
  private def takePointers(ticketId: String, participants: Seq[String]): Option[(String, String)] = {
    val taken = scala.collection.mutable.ArrayBuffer.empty[String]
    val holder = participants.find { pid =>
      val ok = jedis.set(Store.openKey(pid), ticketId, SetParams.setParams().nx().ex(TicketTtlS)) != null
      if (ok) taken += pid
      !ok
    }
    holder.map { pid =>
      val existing = Option(jedis.get(Store.openKey(pid))).getOrElse("")
      taken.foreach(other => jedis.del(Store.openKey(other)))
      pid -> existing
    }
  }

  val route: Route = path("v1" / "matchmaking" / "tickets") {
    post {
      optionalHeaderValueByName("X-Player-Id") { header =>
        entity(as[String]) { raw =>
          val player = header.getOrElse("")
          val body = raw.parseJson.asJsObject.fields
          val skill = body.get("skill").collect { case JsNumber(n) => n.toLong }.getOrElse(1500L)
          val party = body.get("party").collect { case JsArray(items) => items.collect { case JsString(s) => s } }.getOrElse(Vector.empty)
          val participants = player +: party
          if (player.isEmpty) complete(error(StatusCodes.Unauthorized, "X-Player-Id is required"))
          else if (party.size > MaxPartySize) complete(error(StatusCodes.BadRequest, s"a party holds at most $MaxPartySize members"))
          else if (participants.distinct.size != participants.size) complete(error(StatusCodes.BadRequest, "a player is listed twice"))
          else {
            val ticketId = Store.nextTicketId()
            // One open ticket per player: the pointers are taken before the ticket exists.
            takePointers(ticketId, participants) match {
              case Some((pid, existing)) =>
                complete(json(StatusCodes.Conflict, JsObject("error" -> JsString(s"$pid already has an open ticket"), "ticket_id" -> JsString(existing))))
              case None =>
                val ticket = Store.enqueue(ticketId, player, skill.max(SkillMin).min(SkillMax), participants)
                complete(created(ticket, player, participants))
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
#include <vector>

#include "matchmaking/store.h"  // store::nextTicketId, enqueue, openKey, getTicket

using json = nlohmann::json;

void create_ticket(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  const std::string player = req.get_header_value("X-Player-Id");
  const json body = json::parse(req.body.empty() ? "{}" : req.body);
  const long skill = body.value("skill", 1500L);
  std::vector<std::string> participants = {player};
  for (const json& member : body.value("party", json::array())) participants.push_back(member.get<std::string>());
  const store::Ticket ticket = store::enqueue(store::nextTicketId(), player, skill, participants);
  res.status = 201;
  res.set_content(json{{"ticket_id", ticket.ticket_id}, {"player_id", player}, {"skill", ticket.skill}, {"bucket", ticket.bucket}, {"participants", participants}}.dump(),
                  "application/json");
}

void register_routes(httplib::Server& svr) { svr.Post("/v1/matchmaking/tickets", create_ticket); }
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <algorithm>
#include <chrono>
#include <set>
#include <string>
#include <vector>

#include "matchmaking/store.h"  // store::nextTicketId, enqueue, openKey, getTicket

using json = nlohmann::json;

constexpr long kSkillMin = 0;
constexpr long kSkillMax = 4000;
constexpr size_t kMaxPartySize = 5;
constexpr std::chrono::seconds kTicketTtl{900};

sw::redis::Redis redis("tcp://redis:6379");

void reply(httplib::Response& res, int status, const json& body) {
  res.status = status;
  res.set_content(body.dump(), "application/json");
}

void create_ticket(const httplib::Request& req, httplib::Response& res) {
  const std::string player = req.get_header_value("X-Player-Id");
  if (player.empty()) return reply(res, 401, json{{"error", "X-Player-Id is required"}});
  const json body = json::parse(req.body.empty() ? "{}" : req.body);
  const json party = body.value("party", json::array());
  if (party.size() > kMaxPartySize) return reply(res, 400, json{{"error", "a party holds at most 5 members"}});
  std::vector<std::string> participants = {player};
  for (const json& member : party) participants.push_back(member.get<std::string>());
  if (std::set<std::string>(participants.begin(), participants.end()).size() != participants.size()) {
    return reply(res, 400, json{{"error", "a player is listed twice"}});
  }
  const long skill = std::clamp(body.value("skill", 1500L), kSkillMin, kSkillMax);

  const std::string ticket_id = store::nextTicketId();
  std::vector<std::string> taken;
  for (const std::string& pid : participants) {
    // One open ticket per player: the pointer is taken before the ticket exists.
    if (!redis.set(store::openKey(pid), ticket_id, kTicketTtl, sw::redis::UpdateType::NOT_EXIST)) {
      const auto existing = redis.get(store::openKey(pid));
      for (const std::string& other : taken) redis.del(store::openKey(other));
      return reply(res, 409, json{{"error", pid + " already has an open ticket"}, {"ticket_id", existing ? *existing : ""}});
    }
    taken.push_back(pid);
  }

  const store::Ticket ticket = store::enqueue(ticket_id, player, skill, participants);
  reply(res, 201, json{{"ticket_id", ticket_id}, {"player_id", player}, {"skill", ticket.skill}, {"bucket", ticket.bucket}, {"participants", participants}});
}

void register_routes(httplib::Server& svr) { svr.Post("/v1/matchmaking/tickets", create_ticket); }
`,
    },
  },
  harness: {
    python: `from matchmaking import store


def _api(ctx):
    return ctx.client(ctx.load("api").app)


async def _queue(c, player, skill=1520, party=None):
    headers = {} if player is None else {"X-Player-Id": player}
    body = {"skill": skill}
    if party is not None:
        body["party"] = party
    return await c.post("/v1/matchmaking/tickets", json=body, headers=headers)


def _queued(ctx):
    """Every ticket id waiting in any pool."""
    return sorted(m for k in ctx.redis.keys("pool:*") if k != "pool:depth" for m in ctx.redis.zrange(k, 0, -1))


async def check_route(ctx):
    async with _api(ctx) as c:
        r = await _queue(c, "p1", 1520, ["p2", "p3"])
    assert r.status_code == 201, f"POST /v1/matchmaking/tickets answered {r.status_code}: {r.text}"
    body = r.json()
    ticket_id = body.get("ticket_id")
    assert body.get("skill") == 1520 and body.get("bucket") == 15, f"a 1520 rating must wait in bucket 15, the response is {body}"
    assert body.get("participants") == ["p1", "p2", "p3"], f"the participants are the owner, then the party: {body}"
    assert ctx.redis.zscore("pool:15", ticket_id) == 1520, f"ticket {ticket_id} is not in pool:15 scored 1520 (pools: {_queued(ctx)})"
    assert store.get_ticket(ticket_id)["owner"] == "p1", f"the ticket's owner is {store.get_ticket(ticket_id)}"


async def check_player_required(ctx):
    async with _api(ctx) as c:
        missing = await _queue(c, None)
        empty = await _queue(c, "")
    assert missing.status_code == 401, f"a request without X-Player-Id answered {missing.status_code}, expected 401"
    assert empty.status_code == 401, f"a request with an empty X-Player-Id answered {empty.status_code}, expected 401"
    assert _queued(ctx) == [], f"tickets nobody owns are waiting in the pool: {_queued(ctx)}. A matchmaker would claim them and no client would ever join"


async def check_party_cap(ctx):
    async with _api(ctx) as c:
        six = await _queue(c, "a1", 1500, [f"a{i}" for i in range(2, 8)])
        five = await _queue(c, "b1", 1500, [f"b{i}" for i in range(2, 7)])
        twice = await _queue(c, "c1", 1500, ["c2", "c2"])
        owner = await _queue(c, "d1", 1500, ["d1"])
    assert six.status_code == 400, f"a party of six answered {six.status_code}, expected 400: no server seats that roster"
    assert five.status_code == 201, f"a party of five answered {five.status_code}: {five.text}"
    assert twice.status_code == 400, f"a party listing c2 twice answered {twice.status_code}, expected 400"
    assert owner.status_code == 400, f"a party listing its owner answered {owner.status_code}, expected 400"
    assert _queued(ctx) == [five.json()["ticket_id"]], f"only the party of five may wait in the pool, it holds {_queued(ctx)}"


async def check_skill_band(ctx):
    async with _api(ctx) as c:
        low = await _queue(c, "p1", -50)
        high = await _queue(c, "p2", 9000)
    assert low.status_code == 201 and high.status_code == 201, f"out-of-band ratings are clamped, not refused: {low.status_code} {high.status_code}"
    assert low.json().get("skill") == 0 and low.json().get("bucket") == 0, f"a rating of -50 must be clamped to 0 in bucket 0, the response is {low.json()}"
    assert high.json().get("skill") == 4000 and high.json().get("bucket") == 40, f"a rating of 9000 must be clamped to 4000 in bucket 40, the response is {high.json()}"
    stray = sorted(k for k in ctx.redis.keys("pool:*") if k not in ("pool:0", "pool:40", "pool:depth"))
    assert not stray, f"tickets wait in {stray}, buckets no opponent rating reaches"


async def check_one_open_ticket(ctx):
    async with _api(ctx) as c:
        first = await _queue(c, "p1", 1520)
        assert first.status_code == 201, f"the first ticket answered {first.status_code}: {first.text}"
        original = first.json()["ticket_id"]
        second = await _queue(c, "p1", 1600)
        assert second.status_code == 409, f"a second ticket for p1 answered {second.status_code}, expected 409: p1 now waits twice and can be claimed into two games"
        assert second.json().get("ticket_id") == original, f"the 409 must carry the open ticket {original}, got {second.text}"
        member = await _queue(c, "p9", 1500, ["p1"])
        assert member.status_code == 409 and member.json().get("ticket_id") == original, f"a party with p1, who already waits on {original}, answered {member.status_code} {member.text}, expected 409 with {original}"
        alone = await _queue(c, "p9", 1500)
        assert alone.status_code == 201, f"p9 alone answered {alone.status_code} {alone.text}: the refused party request left open:p9 behind"
        party = await _queue(c, "p5", 1500, ["p6"])
        later = await _queue(c, "p6", 1500)
    assert later.status_code == 409 and later.json().get("ticket_id") == party.json()["ticket_id"], f"p6 is queued in p5's party, yet a ticket of p6's own answered {later.status_code} {later.text}"
    assert 0 < ctx.redis.ttl("open:p1") <= 900, f"open:p1 has TTL {ctx.redis.ttl('open:p1')}: the pointer must expire with the ticket (EX 900)"
    assert sorted(_queued(ctx)) == sorted([original, alone.json()["ticket_id"], party.json()["ticket_id"]]), f"the pool holds {_queued(ctx)}"
`,
    typescript: `function api(ctx) {
  return {c: ctx.client(ctx.load('api').app), store: ctx.load('/support/matchmaking/store.ts')};
}

const queue = (c, player: string | null, skill = 1520, party?: string[]) =>
  c.post('/v1/matchmaking/tickets', {json: party === undefined ? {skill} : {skill, party}, headers: player === null ? {} : {'X-Player-Id': player}});

/** Every ticket id waiting in any pool. */
function queued(ctx): string[] {
  const keys = (ctx.redis.keys('pool:*') as string[]).filter(k => k !== 'pool:depth');
  return keys.flatMap(k => ctx.redis.zrange(k, 0, -1) as string[]).sort();
}

export async function check_route(ctx) {
  const {c, store} = api(ctx);
  const r = await queue(c, 'p1', 1520, ['p2', 'p3']);
  assert.equal(r.status, 201, \`POST /v1/matchmaking/tickets answered \${r.status}: \${r.text}\`);
  const body = r.json();
  assert(body.skill === 1520 && body.bucket === 15, \`a 1520 rating must wait in bucket 15, the response is \${r.text}\`);
  assert.deepStrictEqual(body.participants, ['p1', 'p2', 'p3'], \`the participants are the owner, then the party: \${r.text}\`);
  assert.equal(Number(ctx.redis.zscore('pool:15', body.ticket_id)), 1520, \`ticket \${body.ticket_id} is not in pool:15 scored 1520 (pools: \${JSON.stringify(queued(ctx))})\`);
  assert.equal((await store.getTicket(body.ticket_id)).owner, 'p1', 'the ticket must be owned by p1');
}

export async function check_player_required(ctx) {
  const {c} = api(ctx);
  const missing = await queue(c, null);
  const empty = await queue(c, '');
  assert.equal(missing.status, 401, \`a request without X-Player-Id answered \${missing.status}, expected 401\`);
  assert.equal(empty.status, 401, \`a request with an empty X-Player-Id answered \${empty.status}, expected 401\`);
  assert.deepStrictEqual(queued(ctx), [], \`tickets nobody owns are waiting in the pool: \${JSON.stringify(queued(ctx))}. A matchmaker would claim them and no client would ever join\`);
}

export async function check_party_cap(ctx) {
  const {c} = api(ctx);
  const six = await queue(c, 'a1', 1500, ['a2', 'a3', 'a4', 'a5', 'a6', 'a7']);
  const five = await queue(c, 'b1', 1500, ['b2', 'b3', 'b4', 'b5', 'b6']);
  const twice = await queue(c, 'c1', 1500, ['c2', 'c2']);
  const owner = await queue(c, 'd1', 1500, ['d1']);
  assert.equal(six.status, 400, \`a party of six answered \${six.status}, expected 400: no server seats that roster\`);
  assert.equal(five.status, 201, \`a party of five answered \${five.status}: \${five.text}\`);
  assert.equal(twice.status, 400, \`a party listing c2 twice answered \${twice.status}, expected 400\`);
  assert.equal(owner.status, 400, \`a party listing its owner answered \${owner.status}, expected 400\`);
  assert.deepStrictEqual(queued(ctx), [five.json().ticket_id], \`only the party of five may wait in the pool, it holds \${JSON.stringify(queued(ctx))}\`);
}

export async function check_skill_band(ctx) {
  const {c} = api(ctx);
  const low = await queue(c, 'p1', -50);
  const high = await queue(c, 'p2', 9000);
  assert(low.status === 201 && high.status === 201, \`out-of-band ratings are clamped, not refused: \${low.status} \${high.status}\`);
  assert(low.json().skill === 0 && low.json().bucket === 0, \`a rating of -50 must be clamped to 0 in bucket 0, the response is \${low.text}\`);
  assert(high.json().skill === 4000 && high.json().bucket === 40, \`a rating of 9000 must be clamped to 4000 in bucket 40, the response is \${high.text}\`);
  const stray = (ctx.redis.keys('pool:*') as string[]).filter(k => !['pool:0', 'pool:40', 'pool:depth'].includes(k));
  assert.deepStrictEqual(stray, [], \`tickets wait in \${JSON.stringify(stray)}, buckets no opponent rating reaches\`);
}

export async function check_one_open_ticket(ctx) {
  const {c} = api(ctx);
  const first = await queue(c, 'p1', 1520);
  assert.equal(first.status, 201, \`the first ticket answered \${first.status}: \${first.text}\`);
  const original = first.json().ticket_id;
  const second = await queue(c, 'p1', 1600);
  assert.equal(second.status, 409, \`a second ticket for p1 answered \${second.status}, expected 409: p1 now waits twice and can be claimed into two games\`);
  assert.equal(second.json().ticket_id, original, \`the 409 must carry the open ticket \${original}, got \${second.text}\`);
  const member = await queue(c, 'p9', 1500, ['p1']);
  assert(member.status === 409 && member.json().ticket_id === original, \`a party with p1, who already waits on \${original}, answered \${member.status} \${member.text}, expected 409 with \${original}\`);
  const alone = await queue(c, 'p9', 1500);
  assert.equal(alone.status, 201, \`p9 alone answered \${alone.status} \${alone.text}: the refused party request left open:p9 behind\`);
  const party = await queue(c, 'p5', 1500, ['p6']);
  const later = await queue(c, 'p6', 1500);
  assert(later.status === 409 && later.json().ticket_id === party.json().ticket_id, \`p6 is queued in p5's party, yet a ticket of p6's own answered \${later.status} \${later.text}\`);
  const ttl = ctx.redis.ttl('open:p1');
  assert(ttl > 0 && ttl <= 900, \`open:p1 has TTL \${ttl}: the pointer must expire with the ticket (EX 900)\`);
  assert.deepStrictEqual(queued(ctx), [original, alone.json().ticket_id, party.json().ticket_id].sort(), \`the pool holds \${JSON.stringify(queued(ctx))}\`);
}
`,
    go: `package main

import (
	"context"
	"net/http"
	"sort"

	"matchmaking/store"

	"leetbuild/harness"
)

func apiClient(ctx *harness.Ctx) *harness.HTTP {
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

func queue(c *harness.HTTP, player string, skill int, party []string) *harness.Response {
	body := map[string]any{"skill": skill}
	if party != nil {
		body["party"] = party
	}
	if player == "-" {
		return c.Post("/v1/matchmaking/tickets", body)
	}
	return c.Post("/v1/matchmaking/tickets", body, "X-Player-Id", player)
}

type queuedTicket struct {
	TicketID     string   \`json:"ticket_id"\`
	Skill        int      \`json:"skill"\`
	Bucket       int      \`json:"bucket"\`
	Participants []string \`json:"participants"\`
}

func decodeTicket(r *harness.Response) queuedTicket {
	var t queuedTicket
	r.Decode(&t)
	return t
}

// queued is every ticket id waiting in any pool, sorted.
func queued(ctx *harness.Ctx) []string {
	ids := []string{}
	for _, k := range ctx.Redis.Keys("pool:*") {
		if k == "pool:depth" {
			continue
		}
		for _, z := range ctx.Redis.ZRangeWithScores(k, 0, -1) {
			ids = append(ids, z.Member)
		}
	}
	sort.Strings(ids)
	return ids
}

func CheckRoute(ctx *harness.Ctx) {
	c := apiClient(ctx)
	r := queue(c, "p1", 1520, []string{"p2", "p3"})
	ctx.Equal(r.Status, 201, "POST /v1/matchmaking/tickets (%s)", r.Text())
	t := decodeTicket(r)
	ctx.Assert(t.Skill == 1520 && t.Bucket == 15, "a 1520 rating must wait in bucket 15, the response is %s", r.Text())
	ctx.Equal(t.Participants, []string{"p1", "p2", "p3"}, "the participants are the owner, then the party")
	score, ok := ctx.Redis.ZScore("pool:15", t.TicketID)
	ctx.Assert(ok && score == 1520, "ticket %s is not in pool:15 scored 1520 (pools: %v)", t.TicketID, queued(ctx))
	ctx.Equal(store.GetTicket(context.Background(), t.TicketID).Owner, "p1", "the ticket's owner")
}

func CheckPlayerRequired(ctx *harness.Ctx) {
	c := apiClient(ctx)
	missing := queue(c, "-", 1520, nil)
	empty := queue(c, "", 1520, nil)
	ctx.Equal(missing.Status, 401, "a request without X-Player-Id")
	ctx.Equal(empty.Status, 401, "a request with an empty X-Player-Id")
	ctx.Equal(queued(ctx), []string{}, "tickets nobody owns must not wait in the pool (a matchmaker would claim them and no client would ever join); the pool")
}

func CheckPartyCap(ctx *harness.Ctx) {
	c := apiClient(ctx)
	six := queue(c, "a1", 1500, []string{"a2", "a3", "a4", "a5", "a6", "a7"})
	five := queue(c, "b1", 1500, []string{"b2", "b3", "b4", "b5", "b6"})
	twice := queue(c, "c1", 1500, []string{"c2", "c2"})
	owner := queue(c, "d1", 1500, []string{"d1"})
	ctx.Equal(six.Status, 400, "a party of six (no server seats that roster)")
	ctx.Equal(five.Status, 201, "a party of five (%s)", five.Text())
	ctx.Equal(twice.Status, 400, "a party listing c2 twice")
	ctx.Equal(owner.Status, 400, "a party listing its owner")
	ctx.Equal(queued(ctx), []string{decodeTicket(five).TicketID}, "only the party of five may wait in the pool; the pool")
}

func CheckSkillBand(ctx *harness.Ctx) {
	c := apiClient(ctx)
	low := queue(c, "p1", -50, nil)
	high := queue(c, "p2", 9000, nil)
	ctx.Assert(low.Status == 201 && high.Status == 201, "out-of-band ratings are clamped, not refused: %d %d", low.Status, high.Status)
	l, h := decodeTicket(low), decodeTicket(high)
	ctx.Assert(l.Skill == 0 && l.Bucket == 0, "a rating of -50 must be clamped to 0 in bucket 0, the response is %s", low.Text())
	ctx.Assert(h.Skill == 4000 && h.Bucket == 40, "a rating of 9000 must be clamped to 4000 in bucket 40, the response is %s", high.Text())
	stray := []string{}
	for _, k := range ctx.Redis.Keys("pool:*") {
		if k != "pool:0" && k != "pool:40" && k != "pool:depth" {
			stray = append(stray, k)
		}
	}
	ctx.Equal(stray, []string{}, "no ticket may wait in a bucket no opponent rating reaches; the stray pools")
}

func CheckOneOpenTicket(ctx *harness.Ctx) {
	c := apiClient(ctx)
	first := queue(c, "p1", 1520, nil)
	ctx.Equal(first.Status, 201, "the first ticket (%s)", first.Text())
	original := decodeTicket(first).TicketID
	second := queue(c, "p1", 1600, nil)
	ctx.Equal(second.Status, 409, "a second ticket for p1 (p1 now waits twice and can be claimed into two games)")
	ctx.Equal(decodeTicket(second).TicketID, original, "the 409 must carry the open ticket")
	member := queue(c, "p9", 1500, []string{"p1"})
	ctx.Assert(member.Status == 409 && decodeTicket(member).TicketID == original, "a party with p1, who already waits on %s, answered %d %s, expected 409 with %s", original, member.Status, member.Text(), original)
	alone := queue(c, "p9", 1500, nil)
	ctx.Equal(alone.Status, 201, "p9 alone, after the refused party request (it must not leave open:p9 behind): %s", alone.Text())
	party := queue(c, "p5", 1500, []string{"p6"})
	later := queue(c, "p6", 1500, nil)
	ctx.Assert(later.Status == 409 && decodeTicket(later).TicketID == decodeTicket(party).TicketID, "p6 is queued in p5's party, yet a ticket of p6's own answered %d %s", later.Status, later.Text())
	ttl := ctx.Redis.TTL("open:p1")
	ctx.Assert(ttl > 0 && ttl <= 900, "open:p1 has TTL %d: the pointer must expire with the ticket (EX 900)", ttl)
	want := []string{original, decodeTicket(alone).TicketID, decodeTicket(party).TicketID}
	sort.Strings(want)
	ctx.Equal(queued(ctx), want, "the pool")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <algorithm>
#include <string>
#include <vector>

#include "matchmaking/store.h"

namespace {

harness::HTTP apiClient(harness::Ctx& ctx) {
  static httplib::Server* svr = nullptr;
  delete svr;
  svr = new httplib::Server;
  register_routes(*svr);
  return ctx.HTTP(*svr);
}

harness::Response queue(harness::HTTP& c, const std::string& player, long skill, const std::vector<std::string>& party = {}) {
  nlohmann::json body{{"skill", skill}};
  if (!party.empty()) body["party"] = party;
  if (player == "-") return c.Post("/v1/matchmaking/tickets", body.dump(), "Content-Type", "application/json");
  return c.Post("/v1/matchmaking/tickets", body.dump(), "Content-Type", "application/json", "X-Player-Id", player);
}

nlohmann::json bodyOf(const harness::Response& r) { return nlohmann::json::parse(r.Text(), nullptr, false); }

std::string ticketIdOf(const harness::Response& r) {
  const auto body = bodyOf(r);
  return body.is_object() && body.contains("ticket_id") && body["ticket_id"].is_string() ? body["ticket_id"].get<std::string>() : "";
}

long numberOf(const harness::Response& r, const char* field) {
  const auto body = bodyOf(r);
  return body.is_object() && body.contains(field) && body[field].is_number() ? body[field].get<long>() : -999;
}

// Every ticket id waiting in any pool, sorted.
std::vector<std::string> queued(harness::Ctx& ctx) {
  std::vector<std::string> ids;
  for (const auto& k : ctx.Redis.Keys("pool:*")) {
    if (k == "pool:depth") continue;
    for (const auto& z : ctx.Redis.ZRangeWithScores(k, 0, -1)) ids.push_back(z.Member);
  }
  std::sort(ids.begin(), ids.end());
  return ids;
}

}  // namespace

void CheckRoute(harness::Ctx& ctx) {
  auto c = apiClient(ctx);
  const auto r = queue(c, "p1", 1520, {"p2", "p3"});
  ctx.Equal(r.Status, 201, "POST /v1/matchmaking/tickets (%s)", r.Text());
  ctx.Assert(numberOf(r, "skill") == 1520 && numberOf(r, "bucket") == 15, "a 1520 rating must wait in bucket 15, the response is %s", r.Text());
  const auto body = bodyOf(r);
  ctx.Assert(body.is_object() && body.value("participants", nlohmann::json()) == nlohmann::json({"p1", "p2", "p3"}), "the participants are the owner, then the party: %s", r.Text());
  const std::string ticket_id = ticketIdOf(r);
  ctx.Equal(ctx.Redis.ZScore("pool:15", ticket_id), std::optional<double>(1520), "ticket %s in pool:15 (its score)", ticket_id);
  const auto ticket = store::getTicket(ticket_id);
  ctx.Assert(ticket && ticket->owner == "p1", "the ticket must be owned by p1");
}

void CheckPlayerRequired(harness::Ctx& ctx) {
  auto c = apiClient(ctx);
  const auto missing = queue(c, "-", 1520);
  const auto empty = queue(c, "", 1520);
  ctx.Equal(missing.Status, 401, "a request without X-Player-Id");
  ctx.Equal(empty.Status, 401, "a request with an empty X-Player-Id");
  ctx.Equal(queued(ctx), std::vector<std::string>{}, "tickets nobody owns must not wait in the pool (a matchmaker would claim them and no client would ever join); the pool");
}

void CheckPartyCap(harness::Ctx& ctx) {
  auto c = apiClient(ctx);
  const auto six = queue(c, "a1", 1500, {"a2", "a3", "a4", "a5", "a6", "a7"});
  const auto five = queue(c, "b1", 1500, {"b2", "b3", "b4", "b5", "b6"});
  const auto twice = queue(c, "c1", 1500, {"c2", "c2"});
  const auto owner = queue(c, "d1", 1500, {"d1"});
  ctx.Equal(six.Status, 400, "a party of six (no server seats that roster)");
  ctx.Equal(five.Status, 201, "a party of five (%s)", five.Text());
  ctx.Equal(twice.Status, 400, "a party listing c2 twice");
  ctx.Equal(owner.Status, 400, "a party listing its owner");
  ctx.Equal(queued(ctx), std::vector<std::string>{ticketIdOf(five)}, "only the party of five may wait in the pool; the pool");
}

void CheckSkillBand(harness::Ctx& ctx) {
  auto c = apiClient(ctx);
  const auto low = queue(c, "p1", -50);
  const auto high = queue(c, "p2", 9000);
  ctx.Assert(low.Status == 201 && high.Status == 201, "out-of-band ratings are clamped, not refused: %d %d", low.Status, high.Status);
  ctx.Assert(numberOf(low, "skill") == 0 && numberOf(low, "bucket") == 0, "a rating of -50 must be clamped to 0 in bucket 0, the response is %s", low.Text());
  ctx.Assert(numberOf(high, "skill") == 4000 && numberOf(high, "bucket") == 40, "a rating of 9000 must be clamped to 4000 in bucket 40, the response is %s", high.Text());
  std::vector<std::string> stray;
  for (const auto& k : ctx.Redis.Keys("pool:*")) {
    if (k != "pool:0" && k != "pool:40" && k != "pool:depth") stray.push_back(k);
  }
  ctx.Equal(stray, std::vector<std::string>{}, "no ticket may wait in a bucket no opponent rating reaches; the stray pools");
}

void CheckOneOpenTicket(harness::Ctx& ctx) {
  auto c = apiClient(ctx);
  const auto first = queue(c, "p1", 1520);
  ctx.Equal(first.Status, 201, "the first ticket (%s)", first.Text());
  const std::string original = ticketIdOf(first);
  const auto second = queue(c, "p1", 1600);
  ctx.Equal(second.Status, 409, "a second ticket for p1 (p1 now waits twice and can be claimed into two games)");
  ctx.Equal(ticketIdOf(second), original, "the 409 must carry the open ticket");
  const auto member = queue(c, "p9", 1500, {"p1"});
  ctx.Assert(member.Status == 409 && ticketIdOf(member) == original, "a party with p1, who already waits on %s, answered %d %s, expected 409 with %s", original, member.Status, member.Text(), original);
  const auto alone = queue(c, "p9", 1500);
  ctx.Equal(alone.Status, 201, "p9 alone, after the refused party request (it must not leave open:p9 behind): %s", alone.Text());
  const auto party = queue(c, "p5", 1500, {"p6"});
  const auto later = queue(c, "p6", 1500);
  ctx.Assert(later.Status == 409 && ticketIdOf(later) == ticketIdOf(party), "p6 is queued in p5's party, yet a ticket of p6's own answered %d %s", later.Status, later.Text());
  const long long ttl = ctx.Redis.TTL("open:p1");
  ctx.Assert(ttl > 0 && ttl <= 900, "open:p1 has TTL %d: the pointer must expire with the ticket (EX 900)", ttl);
  std::vector<std::string> want = {original, ticketIdOf(alone), ticketIdOf(party)};
  std::sort(want.begin(), want.end());
  ctx.Equal(queued(ctx), want, "the pool");
}
`,
  },
  hints: [
    'Queue p1 twice: both requests answer 201 and p1 waits in the pool twice. A request with no header, a party of six and a rating of -50 are queued as well.',
    'The handler goes straight from the body to `store.enqueue`: nothing checks the header, the party or the band, and nothing records that a player already holds a ticket, so the second request cannot see the first.',
    "Answer 401 on an empty header, 400 above `MAX_PARTY_SIZE` or on a duplicate, clamp the skill, then `SET open:{pid} ticket_id NX EX 900` per participant; on a refusal delete the pointers you took and answer 409 with the holder's ticket id.",
  ],
  debrief: `The guards run before any write, so a refused request leaves no ticket, pointer or pool entry behind. The open-ticket pointer is taken with \`NX\` for every participant, not only the owner, because a party member is a player who may already wait on a ticket of their own; \`NX\` is what makes two concurrent requests for one player resolve to one winner. Its TTL matches the ticket's life, so a client that vanished frees the player on its own. The 409 carries the open ticket id, which lets the client poll the ticket it already has instead of queueing again. Production queues also snapshot the rating on the ticket, so a rating change while waiting cannot move a ticket between pools, and they rate-limit queueing per account.`,
};
