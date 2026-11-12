import type {Step} from '@/lib/types';

export const readStep: Step = {
  id: 'read',
  title: 'GET /v1/matches/{id}: pending players stay on the roster',
  concept: 'http',
  guides: ['honest-reads', 'request-boundaries'],
  file: 'read',
  focus: ['client', 'api', 'redis'],
  task: `## Task

**Starting point.** The starter serves \`GET /v1/matches/{id}\`: it loads the match with
\`store.get_match\` (404 when there is none) and answers \`{match_id, state, server_id, players}\`,
where \`players\` lists the players in \`match["joined"]\` as \`{player_id, join_state: "joined"}\`
and \`state\` is \`in_game\` once a server is set, \`allocating\` before. A joined player's lobby
renders; it hides 3 flaws.

**Failure mode the checks target.** Anyone who guesses a match id reads its roster and its server
address. A lobby cannot show "waiting for 2 of 3", because players who have not joined are left
out. And \`in_game\` tells every client to leave the lobby while the slowest one is still
connecting; an abandoned match reads as \`allocating\` forever.

- The caller is \`X-Player-Id\` (**401** without it). Look the match up (**404**), then a caller who
  is not in \`match["players"]\` is **403**.
- \`players\` lists **every** participant in roster order, each with \`join_state\` \`joined\` or
  \`pending\`.
- \`state\` follows the joins: \`abandoned\` for an abandoned match, \`allocating\` without a server,
  \`joining\` while anyone is pending, \`in_game\` once every participant has joined.`,
  sequence: {
    participants: ['Game client', 'Matchmaking API', 'Redis'],
    messages: [
      {from: 'Game client', to: 'Matchmaking API', label: 'GET /v1/matches/m-1 · X-Player-Id: p2', kind: 'sync'},
      {from: 'Matchmaking API', to: 'Redis', label: 'get_match(m-1): players · joined · server · state', kind: 'sync'},
      {
        from: 'Matchmaking API',
        to: 'Matchmaking API',
        label: 'p2 on the roster? · join state per player',
        kind: 'sync',
      },
      {
        from: 'Matchmaking API',
        to: 'Game client',
        label: '200 {state: "joining", players: [p1 joined, p2 pending, p3 pending]}',
        kind: 'reply',
      },
      {from: 'Matchmaking API', to: 'Game client', label: '403 for a caller not on the roster', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Serves GET /v1/matches/{id}',
      detail: 'A participant reads the match: **200** with its id and the server it was placed on.',
      match: {
        python: {all: [/@app\.get\(\s*["']\/v1\/matches\/\{match_id\}["']/, /store\.get_match\(/]},
        typescript: {all: [/app\.get\(\s*['"]\/v1\/matches\/:matchId['"]/, /getMatch\(/]},
        go: {all: [/HandleFunc\(\s*"GET \/v1\/matches\/\{id\}"/, /store\.GetMatch\(/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"matches"\s*\/\s*Segment\s*\)/, /\bget\s*\{/, /Store\.getMatch\(/]},
        cpp: {all: [/svr\.Get\(\s*R"\(\/v1\/matches\//, /store::getMatch\(/]},
      },
    },
    {
      id: 'participant-scope',
      title: "Only the match's players read it",
      detail:
        "No `X-Player-Id` is **401**; an unknown match is **404**; a caller who is not in the match's players is **403**, and the answer carries no roster or server.",
      match: {
        python: {all: [/x-player-id/i, /\b401\b/, /\b403\b/, /not in match\[["']players["']\]/]},
        typescript: {all: [/x-player-id/i, /code\(\s*401\s*\)/, /code\(\s*403\s*\)/, /match\.players\.includes\(/]},
        go: {all: [/X-Player-Id/i, /StatusUnauthorized|\b401\b/, /StatusForbidden|\b403\b/]},
        scala: {all: [/X-Player-Id/i, /Unauthorized/, /Forbidden/, /m\.players\.contains\(/]},
        cpp: {all: [/X-Player-Id/i, /\b401\b/, /\b403\b/]},
      },
    },
    {
      id: 'pending-visible',
      title: 'Every participant is listed, pending ones as pending',
      detail:
        '`players` is built from the whole roster (`players`), each with `join_state` `joined` or `pending`; the starter lists the joined set only.',
      match: {
        python: {
          all: [/["']pending["']/, /for \w+ in match\[["']players["']\]/],
          none: [/for \w+ in match\[["']joined["']\]/],
        },
        typescript: {all: [/'pending'/, /match\.players\.map\(/], none: [/match\.joined\.map\(/]},
        go: {all: [/"pending"/, /range m\.Players/], none: [/range m\.Joined \{[^}]*players = append/]},
        scala: {all: [/"pending"/, /m\.players\.map/], none: [/m\.joined\.map/]},
        cpp: {all: [/"pending"/, /:\s*m->players\)/], none: [/:\s*m->joined\)/]},
      },
    },
    {
      id: 'state-from-joins',
      title: 'in_game only once every participant has joined',
      detail:
        '`state` is `abandoned` for an abandoned match, `allocating` before a server, `joining` while anyone is pending and `in_game` once every participant has joined; the starter derives it from the server id alone.',
      match: {
        python: {all: [/["']joining["']/, /["']abandoned["']/, /["']in_game["']/]},
        typescript: {all: [/'joining'/, /'abandoned'/, /'in_game'/]},
        go: {all: [/"joining"/, /"abandoned"/, /"in_game"/]},
        scala: {all: [/"joining"/, /"abandoned"/, /"in_game"/]},
        cpp: {all: [/"joining"/, /"abandoned"/, /"in_game"/]},
      },
    },
  ],
  code: {
    python: {
      starter: `from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from matchmaking import store  # get_match

app = FastAPI()


@app.get("/v1/matches/{match_id}")
def read_match(match_id: str, request: Request) -> JSONResponse:
    # TODO: this starter has 3 flaws. The task says where to look; the checks say what must change.
    match = store.get_match(match_id)
    if match is None:
        return JSONResponse({"error": "no such match"}, status_code=404)
    players = [{"player_id": p, "join_state": "joined"} for p in match["joined"]]
    state = "in_game" if match["server_id"] else "allocating"
    return JSONResponse({"match_id": match_id, "state": state, "server_id": match["server_id"], "players": players})
`,
      solution: `from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from matchmaking import store  # get_match

app = FastAPI()


def match_state(match: dict) -> str:
    """The state machine follows the joins, not the allocation."""
    if match["state"] == "abandoned":
        return "abandoned"
    if match["server_id"] is None:
        return "allocating"
    if set(match["players"]) <= set(match["joined"]):
        return "in_game"
    return "joining"


@app.get("/v1/matches/{match_id}")
def read_match(match_id: str, request: Request) -> JSONResponse:
    player = request.headers.get("x-player-id", "")
    if not player:
        return JSONResponse({"error": "X-Player-Id is required"}, status_code=401)
    match = store.get_match(match_id)
    if match is None:
        return JSONResponse({"error": "no such match"}, status_code=404)
    if player not in match["players"]:
        # A roster and a server address are for the players in the match.
        return JSONResponse({"error": "not a participant"}, status_code=403)
    joined = set(match["joined"])
    players = [{"player_id": p, "join_state": "joined" if p in joined else "pending"} for p in match["players"]]
    return JSONResponse({"match_id": match_id, "state": match_state(match), "server_id": match["server_id"], "players": players})
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';

import {getMatch} from 'matchmaking/store';

export const app = Fastify();

app.get('/v1/matches/:matchId', async (request, reply) => {
  // TODO: this starter has 3 flaws. The task says where to look; the checks say what must change.
  const {matchId} = request.params as {matchId: string};
  const match = await getMatch(matchId);
  if (match === null) return reply.code(404).send({error: 'no such match'});
  const players = match.joined.map(p => ({player_id: p, join_state: 'joined'}));
  const state = match.server_id ? 'in_game' : 'allocating';
  return {match_id: matchId, state, server_id: match.server_id, players};
});
`,
      solution: `import Fastify from 'fastify';

import {type Match, getMatch} from 'matchmaking/store';

export const app = Fastify();

/** The state machine follows the joins, not the allocation. */
function matchState(match: Match): string {
  if (match.state === 'abandoned') return 'abandoned';
  if (match.server_id === null) return 'allocating';
  if (match.players.every(p => match.joined.includes(p))) return 'in_game';
  return 'joining';
}

app.get('/v1/matches/:matchId', async (request, reply) => {
  const player = (request.headers['x-player-id'] as string | undefined) ?? '';
  if (player === '') return reply.code(401).send({error: 'X-Player-Id is required'});
  const {matchId} = request.params as {matchId: string};
  const match = await getMatch(matchId);
  if (match === null) return reply.code(404).send({error: 'no such match'});
  // A roster and a server address are for the players in the match.
  if (!match.players.includes(player)) return reply.code(403).send({error: 'not a participant'});
  const players = match.players.map(p => ({player_id: p, join_state: match.joined.includes(p) ? 'joined' : 'pending'}));
  return {match_id: matchId, state: matchState(match), server_id: match.server_id, players};
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"net/http"

	"matchmaking/store" // store.GetMatch
)

type playerView struct {
	PlayerID  string \`json:"player_id"\`
	JoinState string \`json:"join_state"\`
}

type matchView struct {
	MatchID  string       \`json:"match_id"\`
	State    string       \`json:"state"\`
	ServerID *string      \`json:"server_id"\`
	Players  []playerView \`json:"players"\`
}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func readMatch(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has 3 flaws. The task says where to look; the checks say what must change.
	m := store.GetMatch(r.Context(), r.PathValue("id"))
	if m == nil {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "no such match"})
		return
	}
	players := []playerView{}
	for _, p := range m.Joined {
		players = append(players, playerView{PlayerID: p, JoinState: "joined"})
	}
	view := matchView{MatchID: m.MatchID, State: "allocating", Players: players}
	if m.ServerID != "" {
		view.ServerID = &m.ServerID
		view.State = "in_game"
	}
	writeJSON(rw, http.StatusOK, view)
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/matches/{id}", readMatch)
}
`,
      solution: `package main

import (
	"encoding/json"
	"net/http"

	"matchmaking/store" // store.GetMatch
)

type playerView struct {
	PlayerID  string \`json:"player_id"\`
	JoinState string \`json:"join_state"\`
}

type matchView struct {
	MatchID  string       \`json:"match_id"\`
	State    string       \`json:"state"\`
	ServerID *string      \`json:"server_id"\`
	Players  []playerView \`json:"players"\`
}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

// matchState follows the joins, not the allocation.
func matchState(m *store.Match, joined map[string]bool) string {
	if m.State == "abandoned" {
		return "abandoned"
	}
	if m.ServerID == "" {
		return "allocating"
	}
	for _, p := range m.Players {
		if !joined[p] {
			return "joining"
		}
	}
	return "in_game"
}

func readMatch(rw http.ResponseWriter, r *http.Request) {
	player := r.Header.Get("X-Player-Id")
	if player == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "X-Player-Id is required"})
		return
	}
	m := store.GetMatch(r.Context(), r.PathValue("id"))
	if m == nil {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "no such match"})
		return
	}
	joined := map[string]bool{}
	for _, p := range m.Joined {
		joined[p] = true
	}
	member := false
	for _, p := range m.Players {
		member = member || p == player
	}
	if !member {
		// A roster and a server address are for the players in the match.
		writeJSON(rw, http.StatusForbidden, map[string]string{"error": "not a participant"})
		return
	}
	players := []playerView{}
	for _, p := range m.Players {
		state := "pending"
		if joined[p] {
			state = "joined"
		}
		players = append(players, playerView{PlayerID: p, JoinState: state})
	}
	view := matchView{MatchID: m.MatchID, State: matchState(m, joined), Players: players}
	if m.ServerID != "" {
		view.ServerID = &m.ServerID
	}
	writeJSON(rw, http.StatusOK, view)
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/matches/{id}", readMatch)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import matchmaking.Store // Store.getMatch

object Read {
  private def json(status: StatusCode, body: JsObject): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  val route: Route = path("v1" / "matches" / Segment) { matchId =>
    get {
      // TODO: this starter has 3 flaws. The task says where to look; the checks say what must change.
      Store.getMatch(matchId) match {
        case None => complete(json(StatusCodes.NotFound, JsObject("error" -> JsString("no such match"))))
        case Some(m) =>
          val players = m.joined.map(p => JsObject("player_id" -> JsString(p), "join_state" -> JsString("joined")))
          val state = if (m.serverId.isDefined) "in_game" else "allocating"
          complete(json(StatusCodes.OK, JsObject(
            "match_id" -> JsString(matchId), "state" -> JsString(state),
            "server_id" -> m.serverId.fold[JsValue](JsNull)(JsString(_)), "players" -> JsArray(players.toVector))))
      }
    }
  }
}
`,
      solution: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import matchmaking.Store // Store.getMatch

object Read {
  private def json(status: StatusCode, body: JsObject): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  private def error(status: StatusCode, message: String): HttpResponse = json(status, JsObject("error" -> JsString(message)))

  /** The state machine follows the joins, not the allocation. */
  def matchState(m: Store.Match): String =
    if (m.state == "abandoned") "abandoned"
    else if (m.serverId.isEmpty) "allocating"
    else if (m.players.forall(m.joined.contains)) "in_game"
    else "joining"

  val route: Route = path("v1" / "matches" / Segment) { matchId =>
    get {
      optionalHeaderValueByName("X-Player-Id") {
        case None | Some("") => complete(error(StatusCodes.Unauthorized, "X-Player-Id is required"))
        case Some(player) =>
          Store.getMatch(matchId) match {
            case None => complete(error(StatusCodes.NotFound, "no such match"))
            // A roster and a server address are for the players in the match.
            case Some(m) if !m.players.contains(player) => complete(error(StatusCodes.Forbidden, "not a participant"))
            case Some(m) =>
              val players = m.players.map { p =>
                JsObject("player_id" -> JsString(p), "join_state" -> JsString(if (m.joined.contains(p)) "joined" else "pending"))
              }
              complete(json(StatusCodes.OK, JsObject(
                "match_id" -> JsString(matchId), "state" -> JsString(matchState(m)),
                "server_id" -> m.serverId.fold[JsValue](JsNull)(JsString(_)), "players" -> JsArray(players.toVector))))
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

#include "matchmaking/store.h"  // store::getMatch

using json = nlohmann::json;

void read_match(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has 3 flaws. The task says where to look; the checks say what must change.
  const auto m = store::getMatch(req.matches[1]);
  if (!m) {
    res.status = 404;
    res.set_content(json{{"error", "no such match"}}.dump(), "application/json");
    return;
  }
  json players = json::array();
  for (const std::string& p : m->joined) players.push_back(json{{"player_id", p}, {"join_state", "joined"}});
  const std::string state = m->server_id.empty() ? "allocating" : "in_game";
  const json server = m->server_id.empty() ? json(nullptr) : json(m->server_id);
  res.set_content(json{{"match_id", m->match_id}, {"state", state}, {"server_id", server}, {"players", players}}.dump(), "application/json");
}

void register_routes(httplib::Server& svr) { svr.Get(R"(/v1/matches/([\\w-]+))", read_match); }
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <algorithm>
#include <string>

#include "matchmaking/store.h"  // store::getMatch

using json = nlohmann::json;

void reply(httplib::Response& res, int status, const json& body) {
  res.status = status;
  res.set_content(body.dump(), "application/json");
}

bool joinedBy(const store::Match& m, const std::string& player) { return std::find(m.joined.begin(), m.joined.end(), player) != m.joined.end(); }

// The state machine follows the joins, not the allocation.
std::string matchState(const store::Match& m) {
  if (m.state == "abandoned") return "abandoned";
  if (m.server_id.empty()) return "allocating";
  for (const std::string& p : m.players) {
    if (!joinedBy(m, p)) return "joining";
  }
  return "in_game";
}

void read_match(const httplib::Request& req, httplib::Response& res) {
  const std::string player = req.get_header_value("X-Player-Id");
  if (player.empty()) return reply(res, 401, json{{"error", "X-Player-Id is required"}});
  const auto m = store::getMatch(req.matches[1]);
  if (!m) return reply(res, 404, json{{"error", "no such match"}});
  // A roster and a server address are for the players in the match.
  if (std::find(m->players.begin(), m->players.end(), player) == m->players.end()) return reply(res, 403, json{{"error", "not a participant"}});
  json players = json::array();
  for (const std::string& p : m->players) players.push_back(json{{"player_id", p}, {"join_state", joinedBy(*m, p) ? "joined" : "pending"}});
  const json server = m->server_id.empty() ? json(nullptr) : json(m->server_id);
  reply(res, 200, json{{"match_id", m->match_id}, {"state", matchState(*m)}, {"server_id", server}, {"players", players}});
}

void register_routes(httplib::Server& svr) { svr.Get(R"(/v1/matches/([\\w-]+))", read_match); }
`,
    },
  },
  harness: {
    python: `from matchmaking import store


def _match():
    """m-1 in pool 15: t1 is a party of p1 and p2, t3 a solo p3."""
    store.enqueue("t1", "p1", 1500, ["p1", "p2"])
    store.enqueue("t3", "p3", 1510, ["p3"])
    store.create_match("m-1", 15, ["t1", "t3"])


def _api(ctx):
    return ctx.client(ctx.load("read").app)


async def _read(c, player, match_id="m-1"):
    headers = {} if player is None else {"X-Player-Id": player}
    return await c.get(f"/v1/matches/{match_id}", headers=headers)


async def check_route(ctx):
    _match()
    store.set_server("m-1", "gs-m-1")
    store.confirm_join("m-1", "p1")
    async with _api(ctx) as c:
        r = await _read(c, "p1")
    assert r.status_code == 200, f"GET /v1/matches/m-1 as p1 answered {r.status_code}: {r.text}"
    body = r.json()
    assert body.get("match_id") == "m-1" and body.get("server_id") == "gs-m-1", f"the read must carry the match id and its server, got {body}"
    assert {"player_id": "p1", "join_state": "joined"} in body.get("players", []), f"p1 joined, the roster is {body.get('players')}"


async def check_participant_scope(ctx):
    _match()
    store.set_server("m-1", "gs-m-1")
    async with _api(ctx) as c:
        missing = await _read(c, None)
        outsider = await _read(c, "p9")
        unknown = await _read(c, "p1", "m-404")
        member = await _read(c, "p2")
    assert missing.status_code == 401, f"a read without X-Player-Id answered {missing.status_code}, expected 401"
    assert outsider.status_code == 403, f"p9 is not in m-1, yet the read answered {outsider.status_code}, expected 403"
    assert "gs-m-1" not in outsider.text and "p1" not in outsider.text, f"the refusal leaks the roster or the server: {outsider.text}"
    assert unknown.status_code == 404, f"an unknown match answered {unknown.status_code}, expected 404"
    assert member.status_code == 200, f"p2 plays in m-1 through p1's party, yet the read answered {member.status_code}: {member.text}"


async def check_pending_visible(ctx):
    _match()
    store.set_server("m-1", "gs-m-1")
    store.confirm_join("m-1", "p1")
    async with _api(ctx) as c:
        r = await _read(c, "p2")
    assert r.status_code == 200, f"p2 reading its own match answered {r.status_code}: {r.text}"
    players = r.json().get("players")
    expected = [
        {"player_id": "p1", "join_state": "joined"},
        {"player_id": "p2", "join_state": "pending"},
        {"player_id": "p3", "join_state": "pending"},
    ]
    assert players == expected, f"the roster is {players}, expected every participant with its join state {expected}: a lobby cannot show who it is waiting for"


async def check_state_from_joins(ctx):
    _match()
    async with _api(ctx) as c:
        states = [(await _read(c, "p1")).json().get("state")]
        store.set_server("m-1", "gs-m-1")
        states.append((await _read(c, "p1")).json().get("state"))
        store.confirm_join("m-1", "p1")
        store.confirm_join("m-1", "p2")
        states.append((await _read(c, "p1")).json().get("state"))
        store.confirm_join("m-1", "p3")
        states.append((await _read(c, "p1")).json().get("state"))
        store.enqueue("t4", "p4", 1520, ["p4"])
        store.create_match("m-2", 15, ["t4"])
        store.abandon("m-2", "allocation_failed")
        abandoned = (await _read(c, "p4", "m-2")).json().get("state")
    assert states == ["allocating", "joining", "joining", "in_game"], f"through allocation and the joins the state read {states}, expected allocating, joining, joining, in_game: in_game sends every client out of the lobby"
    assert abandoned == "abandoned", f"an abandoned match reads {abandoned!r}, expected 'abandoned'"
`,
    typescript: `async function match(store) {
  await store.enqueue('t1', 'p1', 1500, ['p1', 'p2']);
  await store.enqueue('t3', 'p3', 1510, ['p3']);
  await store.createMatch('m-1', 15, ['t1', 't3']);
}

function api(ctx) {
  return {c: ctx.client(ctx.load('read').app), store: ctx.load('/support/matchmaking/store.ts')};
}

const read = (c, player: string | null, matchId = 'm-1') => c.get(\`/v1/matches/\${matchId}\`, {headers: player === null ? {} : {'X-Player-Id': player}});

export async function check_route(ctx) {
  const {c, store} = api(ctx);
  await match(store);
  await store.setServer('m-1', 'gs-m-1');
  await store.confirmJoin('m-1', 'p1');
  const r = await read(c, 'p1');
  assert.equal(r.status, 200, \`GET /v1/matches/m-1 as p1 answered \${r.status}: \${r.text}\`);
  const body = r.json();
  assert(body.match_id === 'm-1' && body.server_id === 'gs-m-1', \`the read must carry the match id and its server, got \${r.text}\`);
  assert((body.players ?? []).some(p => p.player_id === 'p1' && p.join_state === 'joined'), \`p1 joined, the roster is \${JSON.stringify(body.players)}\`);
}

export async function check_participant_scope(ctx) {
  const {c, store} = api(ctx);
  await match(store);
  await store.setServer('m-1', 'gs-m-1');
  const missing = await read(c, null);
  const outsider = await read(c, 'p9');
  const unknown = await read(c, 'p1', 'm-404');
  const member = await read(c, 'p2');
  assert.equal(missing.status, 401, \`a read without X-Player-Id answered \${missing.status}, expected 401\`);
  assert.equal(outsider.status, 403, \`p9 is not in m-1, yet the read answered \${outsider.status}, expected 403\`);
  assert(!outsider.text.includes('gs-m-1') && !outsider.text.includes('p1'), \`the refusal leaks the roster or the server: \${outsider.text}\`);
  assert.equal(unknown.status, 404, \`an unknown match answered \${unknown.status}, expected 404\`);
  assert.equal(member.status, 200, \`p2 plays in m-1 through p1's party, yet the read answered \${member.status}: \${member.text}\`);
}

export async function check_pending_visible(ctx) {
  const {c, store} = api(ctx);
  await match(store);
  await store.setServer('m-1', 'gs-m-1');
  await store.confirmJoin('m-1', 'p1');
  const r = await read(c, 'p2');
  assert.equal(r.status, 200, \`p2 reading its own match answered \${r.status}: \${r.text}\`);
  const expected = [
    {player_id: 'p1', join_state: 'joined'},
    {player_id: 'p2', join_state: 'pending'},
    {player_id: 'p3', join_state: 'pending'},
  ];
  assert.deepStrictEqual(r.json().players, expected, \`the roster is \${JSON.stringify(r.json().players)}, expected every participant with its join state: a lobby cannot show who it is waiting for\`);
}

export async function check_state_from_joins(ctx) {
  const {c, store} = api(ctx);
  await match(store);
  const states = [(await read(c, 'p1')).json().state];
  await store.setServer('m-1', 'gs-m-1');
  states.push((await read(c, 'p1')).json().state);
  await store.confirmJoin('m-1', 'p1');
  await store.confirmJoin('m-1', 'p2');
  states.push((await read(c, 'p1')).json().state);
  await store.confirmJoin('m-1', 'p3');
  states.push((await read(c, 'p1')).json().state);
  await store.enqueue('t4', 'p4', 1520, ['p4']);
  await store.createMatch('m-2', 15, ['t4']);
  await store.abandon('m-2', 'allocation_failed');
  const abandoned = (await read(c, 'p4', 'm-2')).json().state;
  assert.deepStrictEqual(states, ['allocating', 'joining', 'joining', 'in_game'], \`through allocation and the joins the state read \${JSON.stringify(states)}, expected allocating, joining, joining, in_game: in_game sends every client out of the lobby\`);
  assert.equal(abandoned, 'abandoned', \`an abandoned match reads \${JSON.stringify(abandoned)}, expected "abandoned"\`);
}
`,
    go: `package main

import (
	"context"
	"net/http"
	"strings"

	"matchmaking/store"

	"leetbuild/harness"
)

var readBg = context.Background()

// readSetup is m-1 in pool 15: t1 is a party of p1 and p2, t3 a solo p3.
func readSetup() {
	store.Enqueue(readBg, "t1", "p1", 1500, []string{"p1", "p2"})
	store.Enqueue(readBg, "t3", "p3", 1510, []string{"p3"})
	store.CreateMatch(readBg, "m-1", 15, []string{"t1", "t3"})
}

func readClient(ctx *harness.Ctx) *harness.HTTP {
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

func readAs(c *harness.HTTP, player, matchID string) *harness.Response {
	if player == "" {
		return c.Get("/v1/matches/" + matchID)
	}
	return c.Get("/v1/matches/"+matchID, "X-Player-Id", player)
}

type readPlayer struct {
	PlayerID  string \`json:"player_id"\`
	JoinState string \`json:"join_state"\`
}

type readView struct {
	MatchID  string       \`json:"match_id"\`
	State    string       \`json:"state"\`
	ServerID *string      \`json:"server_id"\`
	Players  []readPlayer \`json:"players"\`
}

func readDecode(r *harness.Response) readView {
	var v readView
	r.Decode(&v)
	return v
}

func CheckRoute(ctx *harness.Ctx) {
	readSetup()
	store.SetServer(readBg, "m-1", "gs-m-1")
	store.ConfirmJoin(readBg, "m-1", "p1")
	c := readClient(ctx)
	r := readAs(c, "p1", "m-1")
	ctx.Equal(r.Status, 200, "GET /v1/matches/m-1 as p1 (%s)", r.Text())
	v := readDecode(r)
	ctx.Assert(v.MatchID == "m-1" && v.ServerID != nil && *v.ServerID == "gs-m-1", "the read must carry the match id and its server, got %s", r.Text())
	found := false
	for _, p := range v.Players {
		found = found || (p.PlayerID == "p1" && p.JoinState == "joined")
	}
	ctx.Assert(found, "p1 joined, the roster is %+v", v.Players)
}

func CheckParticipantScope(ctx *harness.Ctx) {
	readSetup()
	store.SetServer(readBg, "m-1", "gs-m-1")
	c := readClient(ctx)
	missing := readAs(c, "", "m-1")
	outsider := readAs(c, "p9", "m-1")
	unknown := readAs(c, "p1", "m-404")
	member := readAs(c, "p2", "m-1")
	ctx.Equal(missing.Status, 401, "a read without X-Player-Id")
	ctx.Equal(outsider.Status, 403, "p9 is not in m-1; the read")
	ctx.Assert(!strings.Contains(outsider.Text(), "gs-m-1") && !strings.Contains(outsider.Text(), "p1"), "the refusal leaks the roster or the server: %s", outsider.Text())
	ctx.Equal(unknown.Status, 404, "an unknown match")
	ctx.Equal(member.Status, 200, "p2 plays in m-1 through p1's party; the read (%s)", member.Text())
}

func CheckPendingVisible(ctx *harness.Ctx) {
	readSetup()
	store.SetServer(readBg, "m-1", "gs-m-1")
	store.ConfirmJoin(readBg, "m-1", "p1")
	c := readClient(ctx)
	r := readAs(c, "p2", "m-1")
	ctx.Equal(r.Status, 200, "p2 reading its own match (%s)", r.Text())
	want := []readPlayer{{"p1", "joined"}, {"p2", "pending"}, {"p3", "pending"}}
	ctx.Equal(readDecode(r).Players, want, "the roster must list every participant with its join state (a lobby cannot show who it is waiting for)")
}

func CheckStateFromJoins(ctx *harness.Ctx) {
	readSetup()
	c := readClient(ctx)
	states := []string{readDecode(readAs(c, "p1", "m-1")).State}
	store.SetServer(readBg, "m-1", "gs-m-1")
	states = append(states, readDecode(readAs(c, "p1", "m-1")).State)
	store.ConfirmJoin(readBg, "m-1", "p1")
	store.ConfirmJoin(readBg, "m-1", "p2")
	states = append(states, readDecode(readAs(c, "p1", "m-1")).State)
	store.ConfirmJoin(readBg, "m-1", "p3")
	states = append(states, readDecode(readAs(c, "p1", "m-1")).State)
	store.Enqueue(readBg, "t4", "p4", 1520, []string{"p4"})
	store.CreateMatch(readBg, "m-2", 15, []string{"t4"})
	store.Abandon(readBg, "m-2", "allocation_failed")
	abandoned := readDecode(readAs(c, "p4", "m-2")).State
	ctx.Equal(states, []string{"allocating", "joining", "joining", "in_game"}, "through allocation and the joins the state must read allocating, joining, joining, in_game (in_game sends every client out of the lobby)")
	ctx.Equal(abandoned, "abandoned", "an abandoned match's state")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <string>
#include <vector>

#include "matchmaking/store.h"

namespace {

// m-1 in pool 15: t1 is a party of p1 and p2, t3 a solo p3.
void readSetup() {
  store::enqueue("t1", "p1", 1500, {"p1", "p2"});
  store::enqueue("t3", "p3", 1510, {"p3"});
  store::createMatch("m-1", 15, {"t1", "t3"});
}

harness::HTTP readClient(harness::Ctx& ctx) {
  static httplib::Server* svr = nullptr;
  delete svr;
  svr = new httplib::Server;
  register_routes(*svr);
  return ctx.HTTP(*svr);
}

harness::Response readAs(harness::HTTP& c, const std::string& player, const std::string& match_id) {
  if (player.empty()) return c.Get("/v1/matches/" + match_id);
  return c.Get("/v1/matches/" + match_id, "X-Player-Id", player);
}

nlohmann::json bodyOf(const harness::Response& r) { return nlohmann::json::parse(r.Text(), nullptr, false); }

std::string stateOf(const harness::Response& r) {
  const auto body = bodyOf(r);
  return body.is_object() && body.contains("state") && body["state"].is_string() ? body["state"].get<std::string>() : "";
}

}  // namespace

void CheckRoute(harness::Ctx& ctx) {
  readSetup();
  store::setServer("m-1", "gs-m-1");
  store::confirmJoin("m-1", "p1");
  auto c = readClient(ctx);
  const auto r = readAs(c, "p1", "m-1");
  ctx.Equal(r.Status, 200, "GET /v1/matches/m-1 as p1 (%s)", r.Text());
  const auto body = bodyOf(r);
  ctx.Assert(body.is_object() && body.value("match_id", nlohmann::json()) == "m-1" && body.value("server_id", nlohmann::json()) == "gs-m-1", "the read must carry the match id and its server, got %s", r.Text());
  bool found = false;
  for (const auto& p : body.is_object() ? body.value("players", nlohmann::json::array()) : nlohmann::json::array()) {
    found = found || (p.value("player_id", "") == "p1" && p.value("join_state", "") == "joined");
  }
  ctx.Assert(found, "p1 joined, the roster is %s", r.Text());
}

void CheckParticipantScope(harness::Ctx& ctx) {
  readSetup();
  store::setServer("m-1", "gs-m-1");
  auto c = readClient(ctx);
  const auto missing = readAs(c, "", "m-1");
  const auto outsider = readAs(c, "p9", "m-1");
  const auto unknown = readAs(c, "p1", "m-404");
  const auto member = readAs(c, "p2", "m-1");
  ctx.Equal(missing.Status, 401, "a read without X-Player-Id");
  ctx.Equal(outsider.Status, 403, "p9 is not in m-1; the read");
  ctx.Assert(outsider.Text().find("gs-m-1") == std::string::npos && outsider.Text().find("p1") == std::string::npos, "the refusal leaks the roster or the server: %s", outsider.Text());
  ctx.Equal(unknown.Status, 404, "an unknown match");
  ctx.Equal(member.Status, 200, "p2 plays in m-1 through p1's party; the read (%s)", member.Text());
}

void CheckPendingVisible(harness::Ctx& ctx) {
  readSetup();
  store::setServer("m-1", "gs-m-1");
  store::confirmJoin("m-1", "p1");
  auto c = readClient(ctx);
  const auto r = readAs(c, "p2", "m-1");
  ctx.Equal(r.Status, 200, "p2 reading its own match (%s)", r.Text());
  const nlohmann::json want = nlohmann::json::array({{{"player_id", "p1"}, {"join_state", "joined"}}, {{"player_id", "p2"}, {"join_state", "pending"}}, {{"player_id", "p3"}, {"join_state", "pending"}}});
  const auto body = bodyOf(r);
  ctx.Assert(body.is_object() && body.value("players", nlohmann::json()) == want, "the roster is %s, expected every participant with its join state: a lobby cannot show who it is waiting for", body.is_object() ? body.value("players", nlohmann::json()).dump() : r.Text());
}

void CheckStateFromJoins(harness::Ctx& ctx) {
  readSetup();
  auto c = readClient(ctx);
  std::vector<std::string> states = {stateOf(readAs(c, "p1", "m-1"))};
  store::setServer("m-1", "gs-m-1");
  states.push_back(stateOf(readAs(c, "p1", "m-1")));
  store::confirmJoin("m-1", "p1");
  store::confirmJoin("m-1", "p2");
  states.push_back(stateOf(readAs(c, "p1", "m-1")));
  store::confirmJoin("m-1", "p3");
  states.push_back(stateOf(readAs(c, "p1", "m-1")));
  store::enqueue("t4", "p4", 1520, {"p4"});
  store::createMatch("m-2", 15, {"t4"});
  store::abandon("m-2", "allocation_failed");
  const std::string abandoned = stateOf(readAs(c, "p4", "m-2"));
  ctx.Equal(states, std::vector<std::string>{"allocating", "joining", "joining", "in_game"}, "through allocation and the joins the state must read allocating, joining, joining, in_game (in_game sends every client out of the lobby)");
  ctx.Equal(abandoned, "abandoned", "an abandoned match's state");
}
`,
  },
  hints: [
    'Read a match as a player who is not in it: you get the roster and the server. Read it while one client is still connecting: that player is missing, and the state already says in_game.',
    'The handler never looks at the caller, builds the list from the joined set instead of the roster, and decides the state from whether a server id exists, which is true long before anyone has joined.',
    '401 without `X-Player-Id`, 404 on no match, 403 when the caller is not in `match["players"]`. Map `match["players"]` to joined or pending, and derive the state: abandoned, allocating without a server, in_game when every player joined, else joining.',
  ],
  debrief: `The lobby is a view over the roster, so it has to be built from the roster and not from the subset that has already arrived; "pending" is information the client needs, not noise to filter out. The state is derived from the same facts every time it is read, which keeps it consistent with the per-player list next to it: \`in_game\` and a pending player can never appear in one response. The membership check comes after the lookup and before anything about the match is built, so a refusal carries nothing. Production lobbies push these transitions over a websocket instead of being polled, time out a join that never completes so the match can be abandoned and its players requeued, and show other players' presence without exposing the server address to spectators.`,
};
