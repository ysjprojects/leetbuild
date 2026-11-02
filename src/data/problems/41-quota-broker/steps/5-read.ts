import type {Step} from '@/lib/types';

export const readStep: Step = {
  id: 'read',
  title: 'GET /v1/quotas/{team}: a read that matches the enforcement',
  concept: 'http',
  file: 'read',
  focus: ['client', 'broker', 'redis'],
  task: `## Task

**Starting point.** The starter serves \`GET /v1/quotas/{team}\`: it \`HGETALL\`s
\`quota:aggregate:{team}\`, a hash a nightly job fills, and answers \`{"team", "quota", "reserved",
"available": limit - reserved}\` for whatever team is in the path. It serves the demo and
hides four flaws.

**Failure mode the checks target.** A scheduler reads \`available: 4\`, asks for four, and gets a
409, because the aggregate does not include anything reserved since last night and the formula
ignores \`consumed\`. Any caller can also read any team's numbers.

- The tenant comes from \`X-Team-Id\`; missing is **401**, a path team that differs is **403** (a
  quota is not secret enough for 404, but it is not another team's to read).
- \`window\` is a required query parameter matched against \`WINDOW_RE\` (\`YYYY-MM-DDTHH:MMZ\`),
  else **400**. Capacity is per window, so a read without one has no answer.
- Read \`limit\`, \`reserved\` and \`consumed\` with \`hgetall\` from \`quota:{team}:{window}\`, the
  hash the reserve script mutates.
- \`available = limit - reserved - consumed\`, floored at 0. Return \`{"team", "window", "quota",
  "reserved", "consumed", "available"}\`; the reported number must be the number a fresh
  reservation would be granted.`,
  sequence: {
    participants: ['Client', 'Quota Broker', 'Redis'],
    messages: [
      {from: 'Client', to: 'Quota Broker', label: 'GET /v1/quotas/team-a?window=2026-10-21T14:00Z', kind: 'sync'},
      {
        from: 'Quota Broker',
        to: 'Quota Broker',
        label: '401 missing team · 403 foreign team · 400 bad window',
        kind: 'sync',
      },
      {from: 'Quota Broker', to: 'Redis', label: 'HGETALL quota:team-a:2026-10-21T14:00Z', kind: 'sync'},
      {from: 'Redis', to: 'Quota Broker', label: 'limit, reserved, consumed', kind: 'reply'},
      {from: 'Quota Broker', to: 'Quota Broker', label: 'available = limit - reserved - consumed', kind: 'sync'},
      {from: 'Quota Broker', to: 'Client', label: '200 {quota, reserved, consumed, available}', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Registers GET /v1/quotas/{team}',
      detail:
        'The quota read is registered on the team-scoped path, the same resource the reserve path enforces against.',
      match: {
        python: {all: [/@app\.get\(\s*["']\/v1\/quotas\/\{team\}["']/]},
        typescript: {all: [/app\.get\(\s*['"]\/v1\/quotas\/:team['"]/]},
        go: {all: [/HandleFunc\(\s*"GET \/v1\/quotas\/\{team\}"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"quotas"\s*\/\s*Segment\s*\)/]},
        cpp: {all: [/svr\.Get\(\s*"\/v1\/quotas\/:team"/]},
      },
    },
    {
      id: 'same-ledger',
      title: 'Reads the ledger the reserve path writes',
      detail:
        'The counters come from the `quota:{team}:{window}` hash the reserve script mutates, so the read cannot disagree with the enforcement. The starter reads a nightly aggregate instead, which ignores everything reserved today.',
      match: {
        python: {all: [/quota:\{team\}:\{window\}/, /hgetall\(/]},
        typescript: {all: [/quota:\$\{team\}:\$\{window\}/, /hgetall\(/]},
        go: {all: [/"quota:"\s*\+\s*team\s*\+\s*":"\s*\+\s*window/, /HGetAll\(/]},
        scala: {all: [/quota:\$team:\$window/, /hgetAll\(/]},
        cpp: {all: [/"quota:"\s*\+\s*team\s*\+\s*":"\s*\+\s*window/, /hgetall\(/]},
      },
    },
    {
      id: 'available-formula',
      title: 'Computes available from quota, reserved and consumed',
      detail:
        '`available = quota - reserved - consumed` (floored at 0) over the ledger’s own fields, so the number reported is the number a reservation would be granted. The starter subtracts its aggregate’s reserved count from the limit and calls the difference available.',
      match: {
        python: {all: [/available/, /limit/, /reserved/, /consumed/]},
        typescript: {all: [/available/, /limit/, /reserved/, /consumed/]},
        go: {all: [/Available/, /limit/, /[Rr]eserved/, /[Cc]onsumed/]},
        scala: {all: [/available/, /limit/, /reserved/, /consumed/]},
        cpp: {all: [/available/, /limit/, /reserved/, /consumed/]},
      },
    },
    {
      id: 'team-scope',
      title: 'Answers only for the authenticated team',
      detail:
        'A missing `X-Team-Id` is **401** and a path team that is not the authenticated one is **403**. The starter serves any team id in the path, so any caller can enumerate another team’s capacity.',
      match: {
        python: {all: [/X-Team-Id/, /status_code\s*=\s*401/, /status_code\s*=\s*403/]},
        typescript: {all: [/x-team-id/, /code\(\s*401\s*\)/, /code\(\s*403\s*\)/]},
        go: {all: [/X-Team-Id/, /StatusUnauthorized/, /StatusForbidden/]},
        scala: {all: [/X-Team-Id/, /StatusCodes\.Unauthorized/, /StatusCodes\.Forbidden/]},
        cpp: {all: [/X-Team-Id/, /\b401\b/, /\b403\b/]},
      },
    },
    {
      id: 'window-validated',
      title: 'Requires and validates the window',
      detail:
        'The window is a required query parameter matched against the same `YYYY-MM-DDTHH:MMZ` pattern, and a malformed one is **400**. Without a window the read has nothing to report, because capacity is per window.',
      match: {
        python: {all: [/WINDOW_RE/, /status_code\s*=\s*400/]},
        typescript: {all: [/WINDOW_RE/, /code\(\s*400\s*\)/]},
        go: {all: [/windowPattern/, /StatusBadRequest/]},
        scala: {all: [/WindowPattern/, /StatusCodes\.BadRequest/]},
        cpp: {all: [/kWindowRe/, /\b400\b/]},
      },
    },
  ],
  code: {
    python: {
      starter: `"""GET /v1/quotas/{team}: the read used by schedulers and dashboards."""
import redis
from fastapi import FastAPI

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)


@app.get("/v1/quotas/{team}")
def read_quota(team: str) -> dict:
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    aggregate = r.hgetall(f"quota:aggregate:{team}")
    limit = int(aggregate.get("limit", 0))
    reserved = int(aggregate.get("reserved", 0))
    return {"team": team, "quota": limit, "reserved": reserved, "available": limit - reserved}
`,
      solution: `"""GET /v1/quotas/{team}: the read the reserve path would actually honour."""
import re

import redis
from fastapi import FastAPI, Header, HTTPException, Query

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)

WINDOW_RE = re.compile(r"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}Z$")


@app.get("/v1/quotas/{team}")
def read_quota(
    team: str,
    window: str = Query(...),
    caller: str | None = Header(default=None, alias="X-Team-Id"),
) -> dict:
    if caller is None or caller == "":
        raise HTTPException(status_code=401, detail="missing X-Team-Id")
    if caller != team:
        raise HTTPException(status_code=403, detail="team mismatch")
    if not WINDOW_RE.match(window):
        raise HTTPException(status_code=400, detail="window must be YYYY-MM-DDTHH:MMZ")

    # The same hash the reserve script mutates: the read cannot disagree with the enforcement.
    state = r.hgetall(f"quota:{team}:{window}")
    limit = int(state.get("limit", 0))
    reserved = int(state.get("reserved", 0))
    consumed = int(state.get("consumed", 0))
    available = max(limit - reserved - consumed, 0)
    return {
        "team": team,
        "window": window,
        "quota": limit,
        "reserved": reserved,
        "consumed": consumed,
        "available": available,
    }
`,
    },
    typescript: {
      starter: `/** GET /v1/quotas/:team: the read used by schedulers and dashboards. */
import Fastify from 'fastify';
import {Redis} from 'ioredis';

export const app = Fastify();
const r = new Redis('redis://redis:6379');

app.get('/v1/quotas/:team', async (request, reply) => {
  const {team} = request.params as {team: string};
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const aggregate = await r.hgetall(\`quota:aggregate:\${team}\`);
  const limit = Number(aggregate.limit ?? 0);
  const reserved = Number(aggregate.reserved ?? 0);
  return reply.code(200).send({team, quota: limit, reserved, available: limit - reserved});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** GET /v1/quotas/:team: the read the reserve path would actually honour. */
import Fastify from 'fastify';
import {Redis} from 'ioredis';

export const app = Fastify();
const r = new Redis('redis://redis:6379');

const WINDOW_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}Z$/;

app.get('/v1/quotas/:team', async (request, reply) => {
  const {team} = request.params as {team: string};
  const caller = request.headers['x-team-id'];
  if (typeof caller !== 'string' || caller === '') return reply.code(401).send({error: 'missing X-Team-Id'});
  if (caller !== team) return reply.code(403).send({error: 'team mismatch'});
  const {window} = request.query as {window?: string};
  if (typeof window !== 'string' || !WINDOW_RE.test(window))
    return reply.code(400).send({error: 'window must be YYYY-MM-DDTHH:MMZ'});

  // The same hash the reserve script mutates: the read cannot disagree with the enforcement.
  const state = await r.hgetall(\`quota:\${team}:\${window}\`);
  const limit = Number(state.limit ?? 0);
  const reserved = Number(state.reserved ?? 0);
  const consumed = Number(state.consumed ?? 0);
  const available = Math.max(limit - reserved - consumed, 0);
  return reply.code(200).send({team, window, quota: limit, reserved, consumed, available});
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
	"strconv"

	"github.com/redis/go-redis/v9"
)

var rdb *redis.Client

func readQuota(rw http.ResponseWriter, r *http.Request) {
	ctx := context.Background()
	team := r.PathValue("team")
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	aggregate, _ := rdb.HGetAll(ctx, "quota:aggregate:"+team).Result()
	limit, _ := strconv.Atoi(aggregate["limit"])
	reserved, _ := strconv.Atoi(aggregate["reserved"])
	body, _ := json.Marshal(map[string]any{
		"team":      team,
		"quota":     limit,
		"reserved":  reserved,
		"available": limit - reserved,
	})
	rw.Header().Set("Content-Type", "application/json")
	_, _ = rw.Write(body)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/quotas/{team}", readQuota)
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"net/http"
	"regexp"
	"strconv"
)

var windowPattern = regexp.MustCompile("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}Z$")

// available = limit - reserved - consumed, over the ledger the reserve script writes.
func computeAvailable(limit, reserved, consumed int) int {
	available := limit - reserved - consumed
	if available < 0 {
		return 0
	}
	return available
}

func readQuota(rw http.ResponseWriter, r *http.Request) {
	ctx := context.Background()
	team := r.PathValue("team")
	caller := r.Header.Get("X-Team-Id")
	if caller == "" {
		http.Error(rw, \`{"error":"missing X-Team-Id"}\`, http.StatusUnauthorized)
		return
	}
	if caller != team {
		http.Error(rw, \`{"error":"team mismatch"}\`, http.StatusForbidden)
		return
	}
	window := r.URL.Query().Get("window")
	if !windowPattern.MatchString(window) {
		http.Error(rw, \`{"error":"window must be YYYY-MM-DDTHH:MMZ"}\`, http.StatusBadRequest)
		return
	}
	state, err := rdb.HGetAll(ctx, "quota:"+team+":"+window).Result()
	if err != nil {
		http.Error(rw, \`{"error":"ledger unavailable"}\`, http.StatusServiceUnavailable)
		return
	}
	limit, _ := strconv.Atoi(state["limit"])
	reserved, _ := strconv.Atoi(state["reserved"])
	consumed, _ := strconv.Atoi(state["consumed"])
	body, _ := json.Marshal(map[string]any{
		"team":      team,
		"window":    window,
		"quota":     limit,
		"reserved":  reserved,
		"consumed":  consumed,
		"available": computeAvailable(limit, reserved, consumed),
	})
	rw.Header().Set("Content-Type", "application/json")
	_, _ = rw.Write(body)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/quotas/{team}", readQuota)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.model.StatusCodes
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import redis.clients.jedis.Jedis
import scala.jdk.CollectionConverters._

object ReadApi {
  implicit val system: ActorSystem = ActorSystem("quota-broker")
  val jedis = new Jedis("redis", 6379)

  val route: Route =
    path("v1" / "quotas" / Segment) { team =>
      get {
        // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
        val aggregate = jedis.hgetAll(s"quota:aggregate:$team").asScala.toMap
        val limit = aggregate.getOrElse("limit", "0").toInt
        val reserved = aggregate.getOrElse("reserved", "0").toInt
        complete(
          StatusCodes.OK,
          s"""{"team":"$team","quota":$limit,"reserved":$reserved,"available":\${limit - reserved}}""")
      }
    }

  def main(args: Array[String]): Unit = {
    Http().newServerAt("0.0.0.0", 8443).bind(route)
  }
}
`,
      solution: `import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.model.StatusCodes
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import redis.clients.jedis.Jedis
import scala.jdk.CollectionConverters._

object ReadApi {
  implicit val system: ActorSystem = ActorSystem("quota-broker")
  val WindowPattern = "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}Z$".r
  val jedis = new Jedis("redis", 6379)

  val route: Route =
    path("v1" / "quotas" / Segment) { team =>
      get {
        optionalHeaderValueByName("X-Team-Id") { callerOpt =>
          parameter("window") { window =>
            if (!callerOpt.exists(_.nonEmpty)) {
              complete(StatusCodes.Unauthorized, """{"error":"missing X-Team-Id"}""")
            } else if (!callerOpt.contains(team)) {
              complete(StatusCodes.Forbidden, """{"error":"team mismatch"}""")
            } else if (WindowPattern.findFirstIn(window).isEmpty) {
              complete(StatusCodes.BadRequest, """{"error":"window must be YYYY-MM-DDTHH:MMZ"}""")
            } else {
              // The same hash the reserve script mutates: the read cannot disagree with it.
              val state = jedis.hgetAll(s"quota:$team:$window").asScala.toMap
              val limit = state.getOrElse("limit", "0").toInt
              val reserved = state.getOrElse("reserved", "0").toInt
              val consumed = state.getOrElse("consumed", "0").toInt
              val available = math.max(limit - reserved - consumed, 0)
              complete(
                StatusCodes.OK,
                s"""{"team":"$team","window":"$window","quota":$limit,"reserved":$reserved,"consumed":$consumed,"available":$available}""")
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

#include <iterator>
#include <string>
#include <unordered_map>

using json = nlohmann::json;

int main() {
  sw::redis::Redis redis("tcp://redis:6379");
  httplib::Server svr;

  svr.Get("/v1/quotas/:team", [&redis](const httplib::Request& req, httplib::Response& res) {
    const auto team = req.path_params.at("team");
    // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    std::unordered_map<std::string, std::string> aggregate;
    redis.hgetall("quota:aggregate:" + team, std::inserter(aggregate, aggregate.end()));
    const int limit = aggregate.count("limit") ? std::stoi(aggregate["limit"]) : 0;
    const int reserved = aggregate.count("reserved") ? std::stoi(aggregate["reserved"]) : 0;
    res.set_content(
        json{{"team", team}, {"quota", limit}, {"reserved", reserved}, {"available", limit - reserved}}.dump(),
        "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <algorithm>
#include <iterator>
#include <regex>
#include <string>
#include <unordered_map>

using json = nlohmann::json;

const std::regex kWindowRe(R"(^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}Z$)");

int counter(const std::unordered_map<std::string, std::string>& state, const std::string& field) {
  const auto it = state.find(field);
  return it == state.end() ? 0 : std::stoi(it->second);
}

int main() {
  sw::redis::Redis redis("tcp://redis:6379");
  httplib::Server svr;

  svr.Get("/v1/quotas/:team", [&redis](const httplib::Request& req, httplib::Response& res) {
    const auto team = req.path_params.at("team");
    const auto caller = req.get_header_value("X-Team-Id");
    if (caller.empty()) {
      res.status = 401;
      res.set_content(R"({"error":"missing X-Team-Id"})", "application/json");
      return;
    }
    if (caller != team) {
      res.status = 403;
      res.set_content(R"({"error":"team mismatch"})", "application/json");
      return;
    }
    const auto window = req.get_param_value("window");
    if (!std::regex_match(window, kWindowRe)) {
      res.status = 400;
      res.set_content(R"({"error":"window must be YYYY-MM-DDTHH:MMZ"})", "application/json");
      return;
    }
    // The same hash the reserve script mutates: the read cannot disagree with the enforcement.
    std::unordered_map<std::string, std::string> state;
    redis.hgetall("quota:" + team + ":" + window, std::inserter(state, state.end()));
    const int limit = counter(state, "limit");
    const int reserved = counter(state, "reserved");
    const int consumed = counter(state, "consumed");
    const int available = std::max(limit - reserved - consumed, 0);
    res.set_content(
        json{{"team", team},
             {"window", window},
             {"quota", limit},
             {"reserved", reserved},
             {"consumed", consumed},
             {"available", available}}
            .dump(),
        "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  hints: [
    'The dashboard shows team-a with 12 GPUs available at 15:00. Their scheduler asks for 8 and is refused with 409. At 02:00 the dashboard quietly drops to 0.',
    '`quota:aggregate:{team}` is written by a nightly job, so every reservation since then is invisible to the read. The reserve script writes `quota:{team}:{window}`, a different key with a `consumed` field the read ignores.',
    '`hgetall(f"quota:{team}:{window}")`, `available = max(0, limit - reserved - consumed)`, with `window` required and matched by `WINDOW_RE`. Then the `X-Team-Id` guard: 401 missing, 403 on a path mismatch.',
  ],
  debrief: `Reporting and enforcement have to share one source of truth. A read derived from an aggregate
pipeline answers a different question from the reserve path, and the gap is the same-day traffic
nobody has rolled up yet, so a scheduler reads four free GPUs, asks for four and is refused. The fix
is not a shorter aggregate interval; it is reading the hash the reserve script mutates, so the
reported value is by construction the value a reservation would be granted. Authorization gets the
right status: a foreign team id is 403, a missing identity 401. Production brokers also return the
ledger's version with the read so a caller can detect a stale snapshot, and keep per-window history
in a separate store so a capacity chart is not mistaken for the reservation system.`,
};
