import type {Step} from '@/lib/types';

export const readStep: Step = {
  id: 'read',
  title: 'GET /v1/matches/{id}: a state that does not lie to players',
  concept: 'http',
  file: 'read',
  focus: ['client', 'api', 'store'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it looks up a match and returns
it. It compiles, the happy path renders a lobby, and it hides three flaws — two of which the players
notice before you do. Review it, fix it, and prove the fix.

Implement \`GET /v1/matches/{id}\`:

- The caller is authenticated by \`X-Player-Id\` (**401** when absent) and the read is **scoped to
  participants**: a player who is not on the roster gets **403**, not the match. The draft lets any
  player read any match, which leaks rosters, ratings and server addresses.
- The response carries the **roster**, the **server assignment**, each player's **join state** and
  the **state machine position**. Join state is **per-player truth**: \`joined\` for a player whose
  client has confirmed, \`pending\` for one who has not. The draft filters the pending players out of
  the response entirely, so a client cannot tell the difference between "not in this match" and
  "still connecting".
- The state machine position must follow the joins, not the allocation: a match is \`joining\` while
  any participant is \`pending\`, \`in_game\` only once **every** participant has joined, and
  \`abandoned\` if it ended without starting. The draft reports \`in_game\` the moment allocation
  succeeds, so the client renders a game that has not begun.
- A claimed ticket that has not joined is shown **as such**: \`pending\` in the roster and reflected
  in the state machine. Hiding it is what makes the read lie.
- The read touches only the match the caller belongs to: look the match up, then check membership
  before you build the response.

**Failure mode the checks target.** The per-player join state is the one players feel: with pending
players hidden, a lobby cannot say "waiting for 2 of 5", and a client that was dropped has no way to
see that it is still expected. The state machine is the one that corrupts the UI: "in_game" tells
every client to hide the lobby and start rendering a game, and it is wrong for as long as the
slowest client is connecting. The participant scope is the security one: an unauthenticated-by-membership
read hands out other players' data to anyone who can guess a match id.`,
  sequence: {
    participants: ['Game client', 'Matchmaking API', 'Match store'],
    messages: [
      {from: 'Game client', to: 'Matchmaking API', label: 'GET /v1/matches/{id} · X-Player-Id', kind: 'sync'},
      {from: 'Matchmaking API', to: 'Match store', label: 'get(match_id)', kind: 'sync'},
      {from: 'Match store', to: 'Matchmaking API', label: 'roster · joins · server id', kind: 'reply'},
      {
        from: 'Matchmaking API',
        to: 'Matchmaking API',
        label: 'membership check · state machine from joins',
        kind: 'sync',
      },
      {
        from: 'Matchmaking API',
        to: 'Game client',
        label: '200 {roster, join_state, state_machine, server_id}',
        kind: 'reply',
      },
      {from: 'Matchmaking API', to: 'Game client', label: '403 when the caller is not a participant', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'match-read',
      title: 'Handles GET /v1/matches/{id}',
      detail: 'Register the match read on `GET /v1/matches/{id}`.',
      match: {
        python: {all: [/@app\.get\(\s*["']\/v1\/matches\//]},
        typescript: {all: [/app\.get\(\s*['"]\/v1\/matches\//]},
        go: {all: [/HandleFunc\(\s*"GET \/v1\/matches\//]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"matches"\s*\/\s*Segment\s*\)/, /\bget\s*\{/]},
        cpp: {all: [/svr\.Get\(\s*"\/v1\/matches\//]},
      },
    },
    {
      id: 'participant-scope',
      title: 'Scopes the read to participants',
      detail:
        'The caller must be on the roster — a player who is not a participant gets **403**. The draft returns the match to anyone who asks, so rosters and server addresses leak.',
      match: {
        python: {all: [/participants/, /status_code\s*=\s*403/]},
        typescript: {all: [/participants/, /code\(\s*403\s*\)/]},
        go: {all: [/[Pp]articipants/, /StatusForbidden/]},
        scala: {all: [/participants/, /StatusCodes\.Forbidden/]},
        cpp: {all: [/participants/, /res\.status\s*=\s*403/]},
      },
    },
    {
      id: 'join-state',
      title: 'Reports the per-player join state',
      detail:
        'Every participant appears in the response with a `join_state` of `joined` or `pending`. The draft drops the `pending` players, so a connecting client looks absent instead of pending.',
      match: {
        python: {all: [/join_state/, /pending/]},
        typescript: {all: [/joinState/, /pending/]},
        go: {all: [/JoinState/, /pending/]},
        scala: {all: [/joinState/, /pending/]},
        cpp: {all: [/join_state/, /pending/]},
      },
    },
    {
      id: 'state-machine',
      title: 'Derives the state machine from the joins',
      detail:
        'The reported `state_machine` is `joining` while any participant is `pending`, `in_game` only when every participant has joined, and `abandoned` when the match ended without starting. The draft reports `in_game` as soon as allocation succeeds.',
      match: {
        python: {all: [/state_machine/, /in_game/]},
        typescript: {all: [/state_machine/, /in_game/]},
        go: {all: [/state_machine/, /inGame/]},
        scala: {all: [/stateMachine/, /in_game/]},
        cpp: {all: [/state_machine/, /in_game/]},
      },
    },
    {
      id: 'pending-visible',
      title: 'Shows the pending players in the roster',
      detail:
        'The roster lists **every** participant, pending ones included, so a client can render "waiting for 2 of 5". The draft sends a shortened roster of joined players only.',
      match: {
        python: {all: [/roster/, /pending/]},
        typescript: {all: [/roster/, /pending/]},
        go: {all: [/roster/, /pending/]},
        scala: {all: [/roster/, /pending/]},
        cpp: {all: [/roster/, /pending/]},
      },
    },
  ],
  code: {
    python: {
      starter: `"""Match read: a model-generated draft that reports in-game as soon as allocation succeeds."""
from fastapi import FastAPI, Header
from fastapi.responses import JSONResponse

app = FastAPI()


class MatchStore:
    def get(self, match_id: str) -> dict | None:
        """The match row: players, joined flags and server id."""
        raise NotImplementedError


store = MatchStore()


@app.get("/v1/matches/{match_id}")
def read_match(
    match_id: str,
    player: str = Header(default="", alias="X-Player-Id"),
) -> JSONResponse:
    # TODO: this draft reports in-game as soon as allocation succeeds, hides every player whose join is
    # still pending, and lets any player read any match. Report the state machine position derived from
    # the joins, show the per-player join state including pending, and scope the read to participants.
    match = store.get(match_id)
    players = [pid for pid, joined in match["joined"].items() if joined]
    return JSONResponse(
        {
            "match_id": match_id,
            "state": "in_game" if match["server_id"] else "allocating",
            "server_id": match["server_id"],
            "players": players,
        }
    )
`,
      solution: `"""Match read: the state a player is actually in, scoped to participants."""
from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse

app = FastAPI()

IN_GAME = "in_game"


class MatchStore:
    def get(self, match_id: str) -> dict | None:
        """The match row: participants, joins and server id."""
        raise NotImplementedError


store = MatchStore()


def match_state(join_state: dict[str, str]) -> str:
    if any(state == "pending" for state in join_state.values()):
        return "joining"
    if all(state == "joined" for state in join_state.values()):
        return IN_GAME
    return "abandoned"


@app.get("/v1/matches/{match_id}")
def read_match(
    match_id: str,
    player: str | None = Header(default=None, alias="X-Player-Id"),
) -> JSONResponse:
    if player is None or player == "":
        raise HTTPException(status_code=401, detail="missing X-Player-Id")
    match = store.get(match_id)
    if match is None:
        raise HTTPException(status_code=404, detail="no such match")

    participants = match["participants"]
    if player not in participants:
        raise HTTPException(status_code=403, detail="not a participant of this match")

    join_state = {pid: match["joins"].get(pid, "pending") for pid in participants}
    roster = [{"player_id": pid, "join_state": join_state[pid]} for pid in participants]
    return JSONResponse(
        {
            "match_id": match_id,
            "state_machine": match_state(join_state),
            "server_id": match["server_id"],
            "roster": roster,
        }
    )
`,
    },
    typescript: {
      starter: `/** Match read: a model-generated draft that reports in-game as soon as allocation succeeds. */
import Fastify from 'fastify';

export const app = Fastify();

interface MatchRow {
  players: string[];
  joined: Record<string, boolean>;
  serverId: string | null;
}

app.get('/v1/matches/:matchId', async (request, reply) => {
  // TODO: this draft reports in-game as soon as allocation succeeds, hides every player whose join is
  // still pending, and lets any player read any match. Report the state machine position derived from
  // the joins, show the per-player join state including pending, and scope the read to participants.
  const {matchId} = request.params as {matchId: string};
  const match = (await store.get(matchId)) as MatchRow;
  const players = match.players.filter(pid => match.joined[pid]);
  return reply.send({
    match_id: matchId,
    state: match.serverId === null ? 'allocating' : 'in_game',
    server_id: match.serverId,
    players,
  });
});
`,
      solution: `/** Match read: the state a player is actually in, scoped to participants. */
import Fastify from 'fastify';

export const app = Fastify();

const IN_GAME = 'in_game';

interface MatchRow {
  participants: string[];
  joins: Record<string, string>;
  serverId: string | null;
}

export function matchState(joinState: Record<string, string>): string {
  const states = Object.values(joinState);
  if (states.some(state => state === 'pending')) return 'joining';
  if (states.every(state => state === 'joined')) return IN_GAME;
  return 'abandoned';
}

app.get('/v1/matches/:matchId', async (request, reply) => {
  const player = request.headers['x-player-id'];
  if (typeof player !== 'string' || player === '') return reply.code(401).send({error: 'missing X-Player-Id'});

  const {matchId} = request.params as {matchId: string};
  const match = (await store.get(matchId)) as MatchRow | null;
  if (match === null) return reply.code(404).send({error: 'no such match'});

  const participants = match.participants;
  if (!participants.includes(player))
    return reply.code(403).send({error: 'not a participant of this match'});

  const joinState: Record<string, string> = {};
  for (const pid of participants) joinState[pid] = match.joins[pid] ?? 'pending';
  const roster = participants.map(pid => ({player_id: pid, join_state: joinState[pid]}));
  return reply.send({
    match_id: matchId,
    state_machine: matchState(joinState),
    server_id: match.serverId,
    roster,
  });
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"log"
	"net/http"
)

type MatchRow struct {
	Players  []string        \`json:"players"\`
	Joined   map[string]bool \`json:"joined"\`
	ServerID string          \`json:"server_id"\`
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func readMatch(rw http.ResponseWriter, req *http.Request) {
	// TODO: this draft reports in-game as soon as allocation succeeds, hides every player whose join
	// is still pending, and lets any player read any match. Report the state machine position derived
	// from the joins, show the per-player join state including pending, and scope the read to
	// participants.
	match, _ := store.Get(req.Context(), req.PathValue("matchID"))
	players := make([]string, 0, len(match.Players))
	for _, pid := range match.Players {
		if match.Joined[pid] {
			players = append(players, pid)
		}
	}
	writeJSON(rw, http.StatusOK, map[string]any{
		"match_id":  req.PathValue("matchID"),
		"state":     "in_game",
		"server_id": match.ServerID,
		"players":   players,
	})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/matches/{matchID}", readMatch)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
      solution: `package main

import (
	"encoding/json"
	"log"
	"net/http"
	"slices"
)

const inGame = "in_game"

type PlayerJoin struct {
	PlayerID  string \`json:"player_id"\`
	JoinState string \`json:"join_state"\`
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func matchState(joinState map[string]string) string {
	for _, state := range joinState {
		if state == "pending" {
			return "joining"
		}
	}
	for _, state := range joinState {
		if state != "joined" {
			return "abandoned"
		}
	}
	return inGame
}

func readMatch(rw http.ResponseWriter, req *http.Request) {
	player := req.Header.Get("X-Player-Id")
	if player == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-Player-Id"})
		return
	}
	matchID := req.PathValue("matchID")
	match, err := store.Get(req.Context(), matchID)
	if err != nil {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "no such match"})
		return
	}
	participants := match.Participants
	if !slices.Contains(participants, player) {
		writeJSON(rw, http.StatusForbidden, map[string]string{"error": "not a participant of this match"})
		return
	}
	joinState := make(map[string]string, len(participants))
	for _, pid := range participants {
		state, ok := match.Joins[pid]
		if !ok {
			state = "pending"
		}
		joinState[pid] = state
	}
	roster := make([]PlayerJoin, 0, len(participants))
	for _, pid := range participants {
		roster = append(roster, PlayerJoin{PlayerID: pid, JoinState: joinState[pid]})
	}
	writeJSON(rw, http.StatusOK, map[string]any{
		"match_id":      matchID,
		"state_machine": matchState(joinState),
		"server_id":     match.ServerID,
		"roster":        roster,
	})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/matches/{matchID}", readMatch)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
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

object MatchReadApi {
  implicit val system: ActorSystem = ActorSystem("game-matchmaking")

  val route: Route =
    path("v1" / "matches" / Segment) { matchId =>
      get {
        headerValueByName("X-Player-Id") { _ =>
          // TODO: this draft reports in-game as soon as allocation succeeds, hides every player whose
          // join is still pending, and lets any player read any match. Report the state machine
          // position derived from the joins, show the per-player join state including pending, and
          // scope the read to participants.
          val players = store.joinedPlayers(matchId)
          val playersJson = players.map(pid => s"""{"player_id":"$pid"}""").mkString(",")
          complete(
            StatusCodes.OK,
            s"""{"match_id":"$matchId","state":"in_game","players":[$playersJson]}"""
          )
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

object MatchReadApi {
  implicit val system: ActorSystem = ActorSystem("game-matchmaking")

  val InGame = "in_game"

  def matchState(joinState: Map[String, String]): String = {
    if (joinState.values.exists(_ == "pending")) "joining"
    else if (joinState.values.forall(_ == "joined")) InGame
    else "abandoned"
  }

  val route: Route =
    path("v1" / "matches" / Segment) { matchId =>
      get {
        optionalHeaderValueByName("X-Player-Id") { playerOpt =>
          if (!playerOpt.exists(_.nonEmpty)) {
            complete(StatusCodes.Unauthorized, """{"error":"missing X-Player-Id"}""")
          } else {
            val player = playerOpt.get
            val participants = store.participants(matchId)
            if (!participants.contains(player)) {
              complete(StatusCodes.Forbidden, """{"error":"not a participant of this match"}""")
            } else {
              val joinState = participants.map(pid => pid -> store.joinState(matchId, pid)).toMap
              val roster = participants.map { pid =>
                val state = joinState(pid)
                s"""{"player_id":"$pid","join_state":"$state"}"""
              }
              val rosterJson = roster.mkString(",")
              val stateMachine = matchState(joinState)
              val serverId = store.serverId(matchId)
              complete(
                StatusCodes.OK,
                s"""{"match_id":"$matchId","state_machine":"$stateMachine","server_id":"$serverId","roster":[$rosterJson]}"""
              )
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

#include <string>
#include <vector>

using json = nlohmann::json;

int main() {
  httplib::Server svr;

  svr.Get("/v1/matches/:matchId", [](const httplib::Request& req, httplib::Response& res) {
    // TODO: this draft reports in-game as soon as allocation succeeds, hides every player whose join
    // is still pending, and lets any player read any match. Report the state machine position derived
    // from the joins, show the per-player join state including pending, and scope the read to
    // participants.
    const auto matchId = req.path_params.at("matchId");
    const auto match = store.get(matchId);
    std::vector<std::string> players;
    for (const auto& pid : match->players) {
      if (match->joined.at(pid)) {
        players.push_back(pid);
      }
    }
    res.status = 200;
    res.set_content(
        json{{"match_id", matchId}, {"state", "in_game"}, {"server_id", match->serverId}, {"players", players}}.dump(),
        "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <algorithm>
#include <map>
#include <string>
#include <vector>

using json = nlohmann::json;

const std::string kInGame = "in_game";

std::string matchState(const std::map<std::string, std::string>& joinState) {
  bool pending = false;
  bool allJoined = true;
  for (const auto& [pid, state] : joinState) {
    if (state == "pending") {
      pending = true;
    }
    if (state != "joined") {
      allJoined = false;
    }
  }
  if (pending) return "joining";
  if (allJoined) return kInGame;
  return "abandoned";
}

int main() {
  httplib::Server svr;

  svr.Get("/v1/matches/:matchId", [](const httplib::Request& req, httplib::Response& res) {
    const auto player = req.get_header_value("X-Player-Id");
    if (player.empty()) {
      res.status = 401;
      res.set_content(R"({"error":"missing X-Player-Id"})", "application/json");
      return;
    }
    const auto matchId = req.path_params.at("matchId");
    const auto match = store.get(matchId);
    if (!match) {
      res.status = 404;
      res.set_content(R"({"error":"no such match"})", "application/json");
      return;
    }
    const auto participants = match->participants;
    if (std::find(participants.begin(), participants.end(), player) == participants.end()) {
      res.status = 403;
      res.set_content(R"({"error":"not a participant of this match"})", "application/json");
      return;
    }
    std::map<std::string, std::string> joinState;
    for (const auto& pid : participants) {
      const auto it = match->joins.find(pid);
      joinState[pid] = it == match->joins.end() ? "pending" : it->second;
    }
    json roster = json::array();
    for (const auto& pid : participants) {
      roster.push_back(json{{"player_id", pid}, {"join_state", joinState[pid]}});
    }
    res.status = 200;
    res.set_content(
        json{{"match_id", matchId},
             {"state_machine", matchState(joinState)},
             {"server_id", match->serverId},
             {"roster", roster}}
            .dump(),
        "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  hints: [
    'Look up the match, then check membership before you build anything: `player in participants` (or `contains`) and **403** when it fails. A read that is not scoped to the caller is a data leak with a friendly name.',
    'Join state is per player, so the shape is a map from player id to `joined`/`pending`, with `pending` as the default for anyone the store has not heard from yet. Build the roster from **all** participants, not from the ones who already joined — the pending ones are exactly what the lobby needs to render.',
    "The state machine is a function of the joins, not of the allocation: `joining` while any participant is `pending`, `in_game` only when all of them are `joined`, and `abandoned` when the match ended without starting. Reporting `in_game` from `server_id` is the draft's bug — the server exists long before the players are in it.",
  ],
  debrief: `The interviewer is testing whether the read is a projection of the truth rather than a convenience. Three things are being checked. Scope: a match read is participant-scoped, because the roster, the ratings in it and the server address belong to the players in the match. Per-player truth: join state is a property of each player, so a claimed-but-not-joined ticket is shown as pending and the client can render "waiting for 2 of 5" instead of an empty lobby. And the state machine: it has to be derived from the joins, because "in_game" is the event that tells every client to stop waiting — deriving it from the allocation makes the UI lie for exactly as long as the slowest client takes to connect. The draft gets all three wrong in a plausible way: each of \`state = server_id ? "in_game" : "allocating"\`, filtering the roster to joined players, and skipping the membership check is a line of code that reads fine. Real match reads expose a monotonic \`revision\` so clients can drop stale responses, a \`retry_after\` hint per pending player, and a compacted match-state topic so a reconnecting client can resync without polling this endpoint.`,
};
