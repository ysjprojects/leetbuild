import type {Step} from '@/lib/types';

export const stateStep: Step = {
  id: 'state',
  title: 'Recent-turn buffer: atomic, capped, expiring',
  concept: 'redis',
  file: 'state',
  focus: ['api', 'redis'],
  task: `## Task

The starter is a plausible model-generated draft: a turn is pushed onto a list and the demo shows
it. Two appends in flight and one colliding session id break it. Find the flaws, fix them, and
prove the fix.

Implement the recent-turn buffer behind the append endpoint:

- Recent turns live in **one Redis list per (tenant, session)**:
  \`turns:{tenant}:{session_id}\`. The tenant in the key is not cosmetic — two tenants can pick the
  same session id, and the draft's \`turns:{session_id}\` key puts them in one buffer where they
  read each other's turns.
- The list holds the **last 50 turns**: push the new turn, then trim to the most recent 50. The
  trim keeps the newest end (\`LTRIM 0 49\`) and drops the oldest.
- The list **expires 24 hours after the last write** (\`EXPIRE 86400\`), so an abandoned session
  frees itself instead of living forever.
- Append, trim and expiry are **one atomic script**. The draft issues \`LPUSH\` and then a
  client-side \`LTRIM\`; two concurrent appends can interleave them, and whichever trim runs last
  may drop the turn the other append just added.

**Failure mode the checks target.** Under a small cap a concurrent pair of appends must lose
nothing: exactly one turn is trimmed past the cap, never an appended turn. The draft also leaks
memory because nothing ever expires, and it lets one tenant's session id collide with another's.

## What to keep

The list is the right structure (newest at the head, a single key per conversation). The fix is the
key scope and the atomicity: one Lua script that pushes, trims to the cap and refreshes the TTL.`,
  sequence: {
    participants: ['Memory API', 'Second Memory API', 'Redis'],
    messages: [
      {from: 'Memory API', to: 'Redis', label: 'EVAL push+trim+expire turns:acme:s-1', kind: 'sync'},
      {from: 'Second Memory API', to: 'Redis', label: 'EVAL push+trim+expire turns:acme:s-1', kind: 'sync'},
      {from: 'Redis', to: 'Memory API', label: 'LLEN 50 · oldest dropped, TTL refreshed', kind: 'reply'},
      {from: 'Redis', to: 'Second Memory API', label: 'LLEN 50 · no turn lost between appends', kind: 'reply'},
      {
        from: 'Memory API',
        to: 'Memory API',
        label: 'keys differ for another tenant with the same session id',
        kind: 'sync',
      },
    ],
  },
  hints: [
    'One script, not three commands. `LPUSH` followed by a client-side `LTRIM` leaves a gap: a second append can land between them, and whichever trim runs last can drop the newer turn. `EVAL` runs the whole sequence as one step.',
    'The key is a scope, not a label: `turns:{tenant}:{session}`. Two tenants that pick the same session id must never share a list, and the tenant comes from the authenticated context, not the payload.',
    'An unbounded list is a memory leak with a latency story attached. Put `EXPIRE` in the same script, 86400 seconds, refreshed on every write, so an idle session disappears without a background reaper.',
  ],
  checks: [
    {
      id: 'key-prefix',
      title: 'Stores turns under a session-keyed list',
      detail: 'Turns are stored in a Redis list whose key is namespaced for the chat buffer.',
      match: {
        python: {all: [/turns:/]},
        typescript: {all: [/turns:/]},
        go: {all: [/turns:/]},
        scala: {all: [/turns:/]},
        cpp: {all: [/turns:/]},
      },
    },
    {
      id: 'tenant-key',
      title: 'Scopes the buffer to (tenant, session)',
      detail:
        'The key is `turns:{tenant}:{session}`; a key built from the session id alone lets two tenants that share a session id read one buffer.',
      match: {
        python: {all: [/turns:\{tenant\}:\{id\}|turns:\{tenant\}:\{session_id\}/]},
        typescript: {all: [/turns:\$\{tenant\}:\$\{id\}/]},
        go: {all: [/turns:"\s*\+\s*tenant/]},
        scala: {all: [/turns:\$tenant:\$id/]},
        cpp: {all: [/turns:"\s*\+\s*tenant/]},
      },
    },
    {
      id: 'atomic-lua',
      title: 'Pushes, trims and expires in one atomic script',
      detail:
        'A single Lua `EVAL` does the push, the trim and the expiry. The draft splits them into client-side calls, so two concurrent appends can interleave and lose a turn.',
      match: {
        python: {all: [/BUFFER_LUA/, /\.eval\(/]},
        typescript: {all: [/BUFFER_LUA/, /\.eval\(/]},
        go: {all: [/(bufferScript|NewScript)/, /\.Run\(/]},
        scala: {all: [/BufferLua/, /\.eval\(/]},
        cpp: {all: [/kBufferLua/, /\.eval</]},
      },
    },
    {
      id: 'cap-50',
      title: 'Trims the list to the last 50 turns',
      detail:
        'The script trims to `LTRIM 0 (cap - 1)` with a 50-turn cap, so the buffer is bounded no matter how long the conversation runs.',
      match: {
        python: {all: [/LTRIM/, /MAX_TURNS/]},
        typescript: {all: [/LTRIM/, /MAX_TURNS/]},
        go: {all: [/LTRIM/, /maxTurns/]},
        scala: {all: [/LTRIM/, /MaxTurns/]},
        cpp: {all: [/LTRIM/, /kMaxTurns/]},
      },
    },
    {
      id: 'ttl-24h',
      title: 'Expires the buffer 24 hours after the last write',
      detail:
        'The script sets `EXPIRE` to 86400 seconds on every write. The draft never sets a TTL, so idle sessions accumulate and memory only grows.',
      match: {
        python: {all: [/EXPIRE/, /86400|86_400/]},
        typescript: {all: [/EXPIRE/, /86400|86_400/]},
        go: {all: [/EXPIRE/, /86400|86_400/]},
        scala: {all: [/EXPIRE/, /86400|86_400/]},
        cpp: {all: [/EXPIRE/, /86400|86_400/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json

import redis
from fastapi import FastAPI
from pydantic import BaseModel

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)


class Turn(BaseModel):
    turn_id: str
    role: str
    content: str


@app.post("/v1/sessions/{id}/turns")
def append_turn(id: str, turn: Turn) -> dict:
    # TODO: build the key from the (tenant, session) pair, and keep the append, the trim and the
    # expiry inside one atomic script so a concurrent pair of appends cannot lose a turn.
    r.lpush(f"turns:{id}", json.dumps(turn.model_dump()))
    r.ltrim(f"turns:{id}", 0, 49)
    return {"session_id": id, "turn_id": turn.turn_id}
`,
      solution: `import json

import redis
from fastapi import FastAPI, Header
from pydantic import BaseModel

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)

MAX_TURNS = 50
TTL_S = 86_400

BUFFER_LUA = """
redis.call('LPUSH', KEYS[1], ARGV[1])
redis.call('LTRIM', KEYS[1], 0, tonumber(ARGV[2]) - 1)
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[3]))
return redis.call('LLEN', KEYS[1])
"""


class Turn(BaseModel):
    turn_id: str
    role: str
    content: str


@app.post("/v1/sessions/{id}/turns")
def append_turn(id: str, turn: Turn, tenant: str = Header(alias="X-Tenant-Id")) -> dict:
    key = f"turns:{tenant}:{id}"
    depth = r.eval(BUFFER_LUA, 1, key, json.dumps(turn.model_dump()), MAX_TURNS, TTL_S)
    return {"session_id": id, "turn_id": turn.turn_id, "buffered": int(depth)}
`,
    },
    typescript: {
      starter: `/** POST /v1/sessions/:id/turns: a model-generated draft that trims from the client. */
import Fastify from 'fastify';
import {Redis} from 'ioredis';

export const app = Fastify();
const r = new Redis('redis://redis:6379');

interface Turn {
  turn_id: string;
  role: string;
  content: string;
}

app.post('/v1/sessions/:id/turns', async (request, reply) => {
  const {id} = request.params as {id: string};
  const turn = request.body as Turn;
  // TODO: build the key from the (tenant, session) pair, and keep the append, the trim and the
  // expiry inside one atomic script so a concurrent pair of appends cannot lose a turn.
  await r.lpush(\`turns:\${id}\`, JSON.stringify(turn));
  await r.ltrim(\`turns:\${id}\`, 0, 49);
  return reply.code(201).send({session_id: id, turn_id: turn.turn_id});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** POST /v1/sessions/:id/turns: append, trim and expire in one atomic script. */
import Fastify from 'fastify';
import {Redis} from 'ioredis';

export const app = Fastify();
const r = new Redis('redis://redis:6379');

const MAX_TURNS = 50;
const TTL_S = 86_400;

const BUFFER_LUA = \`
redis.call('LPUSH', KEYS[1], ARGV[1])
redis.call('LTRIM', KEYS[1], 0, tonumber(ARGV[2]) - 1)
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[3]))
return redis.call('LLEN', KEYS[1])
\`;

interface Turn {
  turn_id: string;
  role: string;
  content: string;
}

app.post('/v1/sessions/:id/turns', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'] as string;
  const {id} = request.params as {id: string};
  const turn = request.body as Turn;
  const depth = await r.eval(
    BUFFER_LUA,
    1,
    \`turns:\${tenant}:\${id}\`,
    JSON.stringify(turn),
    String(MAX_TURNS),
    String(TTL_S),
  );
  return reply.code(201).send({session_id: id, turn_id: turn.turn_id, buffered: Number(depth)});
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

	"github.com/redis/go-redis/v9"
)

var rdb *redis.Client

func appendTurn(rw http.ResponseWriter, r *http.Request) {
	ctx := context.Background()
	id := r.PathValue("id")
	var turn map[string]any
	_ = json.NewDecoder(r.Body).Decode(&turn)
	// TODO: build the key from the (tenant, session) pair, and keep the append, the trim and the
	// expiry inside one atomic script so a concurrent pair of appends cannot lose a turn.
	payload, _ := json.Marshal(turn)
	key := "turns:" + id
	rdb.LPush(ctx, key, payload)
	rdb.LTrim(ctx, key, 0, 49)
	rw.WriteHeader(http.StatusCreated)
	_, _ = rw.Write([]byte(\`{"session_id":"\` + id + \`"}\`))
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
	"fmt"
	"net/http"

	"github.com/redis/go-redis/v9"
)

const (
	maxTurns = 50
	ttlS     = 86400
)

var (
	rdb          *redis.Client
	bufferScript = redis.NewScript(\`
redis.call('LPUSH', KEYS[1], ARGV[1])
redis.call('LTRIM', KEYS[1], 0, tonumber(ARGV[2]) - 1)
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[3]))
return redis.call('LLEN', KEYS[1])
\`)
)

func appendTurn(rw http.ResponseWriter, r *http.Request) {
	ctx := context.Background()
	tenant := r.Header.Get("X-Tenant-Id")
	id := r.PathValue("id")
	var turn map[string]any
	_ = json.NewDecoder(r.Body).Decode(&turn)
	payload, _ := json.Marshal(turn)
	depth, err := bufferScript.Run(ctx, rdb, []string{"turns:" + tenant + ":" + id}, payload, maxTurns, ttlS).Int()
	if err != nil {
		http.Error(rw, \`{"error":"buffer append failed"}\`, http.StatusInternalServerError)
		return
	}
	rw.WriteHeader(http.StatusCreated)
	_, _ = rw.Write([]byte(\`{"session_id":"\` + id + \`","buffered":\` + fmt.Sprintf("%d", depth) + \`}\`))
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
import org.apache.pekko.http.scaladsl.model.StatusCodes
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import redis.clients.jedis.Jedis

object StateApi {
  implicit val system: ActorSystem = ActorSystem("chat-memory")
  val jedis = new Jedis("redis", 6379)

  val route: Route =
    path("v1" / "sessions" / Segment / "turns") { id =>
      post {
        entity(as[String]) { payload =>
          // TODO: build the key from the (tenant, session) pair, and keep the append, the trim and
          // the expiry inside one atomic script so a concurrent pair of appends cannot lose a turn.
          jedis.lpush(s"turns:$id", payload)
          jedis.ltrim(s"turns:$id", 0, 49)
          complete(StatusCodes.Created, s"""{"session_id":"$id"}""")
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
import org.apache.pekko.http.scaladsl.model.StatusCodes
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import redis.clients.jedis.Jedis

object StateApi {
  implicit val system: ActorSystem = ActorSystem("chat-memory")
  val MaxTurns = 50
  val TtlSeconds = 86400
  val jedis = new Jedis("redis", 6379)

  val BufferLua =
    """
      |redis.call('LPUSH', KEYS[1], ARGV[1])
      |redis.call('LTRIM', KEYS[1], 0, tonumber(ARGV[2]) - 1)
      |redis.call('EXPIRE', KEYS[1], tonumber(ARGV[3]))
      |return redis.call('LLEN', KEYS[1])
      |""".stripMargin

  val route: Route =
    path("v1" / "sessions" / Segment / "turns") { id =>
      post {
        headerValueByName("X-Tenant-Id") { tenant =>
          entity(as[String]) { payload =>
            val key = s"turns:$tenant:$id"
            val depth = jedis.eval(BufferLua, 1, key, payload, MaxTurns.toString, TtlSeconds.toString)
            complete(StatusCodes.Created, s"""{"session_id":"$id","buffered":$depth}""")
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

int main() {
  sw::redis::Redis redis("tcp://redis:6379");
  httplib::Server svr;

  svr.Post("/v1/sessions/:id/turns", [&redis](const httplib::Request& req, httplib::Response& res) {
    const auto id = req.path_params.at("id");
    // TODO: build the key from the (tenant, session) pair, and keep the append, the trim and the
    // expiry inside one atomic script so a concurrent pair of appends cannot lose a turn.
    redis.lpush("turns:" + id, req.body);
    redis.ltrim("turns:" + id, 0, 49);
    res.status = 201;
    res.set_content(json{{"session_id", id}}.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <string>
#include <vector>

using json = nlohmann::json;

constexpr long long kMaxTurns = 50;
constexpr long long kTtlSeconds = 86400;

const std::string kBufferLua = R"(
redis.call('LPUSH', KEYS[1], ARGV[1])
redis.call('LTRIM', KEYS[1], 0, tonumber(ARGV[2]) - 1)
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[3]))
return redis.call('LLEN', KEYS[1])
)";

int main() {
  sw::redis::Redis redis("tcp://redis:6379");
  httplib::Server svr;

  svr.Post("/v1/sessions/:id/turns", [&redis](const httplib::Request& req, httplib::Response& res) {
    const auto tenant = req.get_header_value("X-Tenant-Id");
    const auto id = req.path_params.at("id");
    const std::vector<std::string> keys = {"turns:" + tenant + ":" + id};
    const std::vector<std::string> args = {req.body, std::to_string(kMaxTurns), std::to_string(kTtlSeconds)};
    const auto depth = redis.eval<long long>(kBufferLua, keys.begin(), keys.end(), args.begin(), args.end());
    res.status = 201;
    res.set_content(json{{"session_id", id}, {"buffered", depth}}.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  debrief: `The interview question behind this step is atomicity plus scope. A push-then-trim buffer looks
correct in every serial test and loses a turn exactly when two appends overlap, which is when a
real conversation is busiest. One Lua script makes push, trim and expire a single step, and it can
refresh the TTL in the same call, so there is no path where a turn is appended but never trimmed or
a list lives forever. The key is the second half: a session id is chosen by the client, and two
tenants can collide on it, so the key must carry the authenticated tenant. Interviewers listen for
the bounded-write argument too — a list that only grows is a memory leak with a latency story
attached, and the fix belongs at the write path, not in a reaper that runs hours later.`,
};
