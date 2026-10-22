import type {Step} from '@/lib/types';

export const readStep: Step = {
  id: 'read',
  title: 'GET /v1/sessions/{id}/context: assembled, capped, tenant-scoped',
  concept: 'http',
  file: 'read',
  focus: ['client', 'api', 'redis'],
  task: `## Task

The starter is a plausible model-generated draft: a context comes back and the demo shows a
conversation. It authorizes nothing, bounds nothing, and serves a stale cache. Find the flaws, fix
them, and prove the fix.

Implement the context-read endpoint used when a model call or the UI needs the conversation:

- \`GET /v1/sessions/{id}/context\` returns the **summary plus the recent buffer**. The tenant comes
  from the request context and the session is authorized like any other read: a foreign session id
  answers **404**, never another tenant's conversation.
- The assembled context is capped at **6000 tokens**. Drop from the **oldest** end until the budget
  fits, so the newest turns always survive; the draft loads the whole list and never measures it.
- The response carries the **turn ids** the UI cites (\`turn_id\`) alongside the role and content,
  so a reviewer can point at the exact turn that produced an answer.
- The cache key includes the **latest turn id**: \`context:{tenant}:{session}:{latest_turn_id}\`.
  The draft caches under \`context:{session}\` for 60 seconds, so a read right after an append can
  return a context without the new turn.

**Failure mode the checks target.** A read after an append must see the new turn, a foreign session
must answer 404, and the turns dropped at the 6000-token cap must be the oldest ones.

## What to keep

The shape of the response (summary plus turns) and the 60-second cache are fine. The fix is the
authorization, the budget and the cache key.`,
  sequence: {
    participants: ['Client', 'Memory API', 'Redis'],
    messages: [
      {from: 'Client', to: 'Memory API', label: 'GET /v1/sessions/s-1/context', kind: 'sync'},
      {from: 'Memory API', to: 'Redis', label: 'HGET sessions s-1 · LRANGE turns:acme:s-1 0 49', kind: 'sync'},
      {from: 'Redis', to: 'Memory API', label: 'owner = acme · newest-first turns', kind: 'reply'},
      {from: 'Memory API', to: 'Memory API', label: '404 foreign session · cap 6000 dropping the oldest', kind: 'sync'},
      {from: 'Memory API', to: 'Redis', label: 'GET context:acme:s-1:{latest_turn_id}', kind: 'sync'},
      {from: 'Redis', to: 'Memory API', label: 'cached body · or nil after the latest append', kind: 'reply'},
      {from: 'Memory API', to: 'Client', label: '{summary, turns:[{turn_id, role, content}]}', kind: 'reply'},
    ],
  },
  hints: [
    'Authorize the read like the write: `assert_tenant_owns(tenant, id)` before a single key is read, and answer `404` so a foreign session id is indistinguishable from a missing one.',
    'Walk the turns from the newest end and subtract an estimated cost per turn; stop when the next turn would cross 6000 tokens. Truncating that way keeps the newest turns and drops the oldest, which is the half of the conversation a UI can still summarize.',
    'Put the latest turn id in the cache key. `context:{tenant}:{session}:{latest_turn_id}` changes the moment a turn is appended, so a read-after-append misses the stale entry instead of serving it; the old entry expires on its own.',
  ],
  checks: [
    {
      id: 'tenant-ownership',
      title: 'Authorizes the read against the authenticated tenant',
      detail:
        'The session owner is compared with the request tenant before any key is read, and a foreign session answers `404`. The draft serves any session id in the path.',
      match: {
        python: {all: [/assert_tenant_owns/, /404/]},
        typescript: {all: [/assertTenantOwns/, /404/]},
        go: {all: [/assertTenantOwns/, /StatusNotFound|404/]},
        scala: {all: [/assertTenantOwns/, /NotFound|404/]},
        cpp: {all: [/assert_tenant_owns/, /404/]},
      },
    },
    {
      id: 'token-cap',
      title: 'Caps the assembled context at 6000 tokens',
      detail:
        'The context budget is a named 6000-token constant and the assembled summary plus turns must fit it. The draft returns everything the list holds.',
      match: {
        python: {all: [/MAX_CONTEXT_TOKENS/, /6000/]},
        typescript: {all: [/MAX_CONTEXT_TOKENS/, /6000/]},
        go: {all: [/maxContextTokens/, /6000/]},
        scala: {all: [/MaxContextTokens/, /6000/]},
        cpp: {all: [/kMaxContextTokens/, /6000/]},
      },
    },
    {
      id: 'oldest-first',
      title: 'Truncates from the oldest end',
      detail:
        'The truncation walks the newest-first buffer and keeps what fits, so the oldest turns are the ones dropped. It also bounds how much of the list is loaded.',
      match: {
        python: {all: [/truncate_to_budget/, /MAX_RECENT_TURNS/]},
        typescript: {all: [/truncateToBudget/, /MAX_RECENT_TURNS/]},
        go: {all: [/truncateToBudget/, /maxRecentTurns/]},
        scala: {all: [/truncateToBudget/, /MaxRecentTurns/]},
        cpp: {all: [/truncate_to_budget/, /kMaxRecentTurns/]},
      },
    },
    {
      id: 'fresh-cache',
      title: 'Invalidates the cache when a new turn lands',
      detail:
        'The cache key carries the latest turn id, so an append changes the key and the next read misses the stale entry. The draft caches per session and serves the old context for the whole TTL.',
      match: {
        python: {all: [/latest_turn_id/]},
        typescript: {all: [/latestTurnId/]},
        go: {all: [/latestTurnID/]},
        scala: {all: [/latestTurnId/]},
        cpp: {all: [/latest_turn_id/]},
      },
    },
    {
      id: 'citable-ids',
      title: 'Returns turn ids the UI can cite',
      detail:
        'Every returned turn carries its `turn_id` alongside the role and content, so an answer can be traced back to the exact turn.',
      match: {
        python: {all: [/turn_id/]},
        typescript: {all: [/turn_id/]},
        go: {all: [/turn_id/]},
        scala: {all: [/turn_id/]},
        cpp: {all: [/turn_id/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json

import redis
from fastapi import FastAPI

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)


@app.get("/v1/sessions/{id}/context")
def read_context(id: str) -> dict:
    # TODO: check that the session belongs to the tenant and answer 404 otherwise, cap the context
    # at 6000 tokens by dropping the oldest turns first, and key the cache on the latest turn id so
    # a read after an append does not return a stale context.
    cached = r.get(f"context:{id}")
    if cached is not None:
        return json.loads(cached)
    summary = r.get(f"summary:{id}")
    raw = r.lrange(f"turns:{id}", 0, -1)
    turns = [json.loads(t) for t in raw]
    body = {
        "summary": summary,
        "turns": [
            {"turn_id": t["turn_id"], "role": t["role"], "content": t["content"]} for t in turns
        ],
    }
    r.set(f"context:{id}", json.dumps(body), ex=60)
    return body
`,
      solution: `import json

import redis
from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)

MAX_CONTEXT_TOKENS = 6000
MAX_RECENT_TURNS = 50


class Turn(BaseModel):
    turn_id: str
    role: str
    content: str


def assert_tenant_owns(tenant: str, session_id: str) -> None:
    owner = r.hget("sessions", session_id)
    if owner != tenant:
        raise HTTPException(status_code=404, detail="session not found")


def truncate_to_budget(turns: list[Turn], summary: str | None) -> list[Turn]:
    budget = MAX_CONTEXT_TOKENS - (len(summary) // 4 if summary else 0)
    kept: list[Turn] = []
    for turn in turns:
        cost = len(turn.content) // 4
        if cost > budget:
            break
        kept.append(turn)
        budget -= cost
    return list(reversed(kept))


@app.get("/v1/sessions/{id}/context")
def read_context(id: str, tenant: str = Header(alias="X-Tenant-Id")) -> dict:
    assert_tenant_owns(tenant, id)
    summary = r.get(f"summary:{tenant}:{id}")
    raw = r.lrange(f"turns:{tenant}:{id}", 0, MAX_RECENT_TURNS - 1)
    turns = [Turn(**json.loads(t)) for t in raw]
    latest_turn_id = turns[0].turn_id if turns else "empty"
    cached = r.get(f"context:{tenant}:{id}:{latest_turn_id}")
    if cached is not None:
        return json.loads(cached)
    body = {
        "summary": summary,
        "turns": [
            {"turn_id": t.turn_id, "role": t.role, "content": t.content}
            for t in truncate_to_budget(turns, summary)
        ],
    }
    r.set(f"context:{tenant}:{id}:{latest_turn_id}", json.dumps(body), ex=60)
    return body
`,
    },
    typescript: {
      starter: `/** GET /v1/sessions/:id/context: a model-generated draft that caches forever and authorizes nothing. */
import Fastify from 'fastify';
import {Redis} from 'ioredis';

export const app = Fastify();
const r = new Redis('redis://redis:6379');

interface Turn {
  turn_id: string;
  role: string;
  content: string;
}

app.get('/v1/sessions/:id/context', async (request, reply) => {
  const {id} = request.params as {id: string};
  // TODO: check that the session belongs to the tenant and answer 404 otherwise, cap the context
  // at 6000 tokens by dropping the oldest turns first, and key the cache on the latest turn id so
  // a read after an append does not return a stale context.
  const cached = await r.get(\`context:\${id}\`);
  if (cached !== null) return reply.code(200).send(JSON.parse(cached));
  const summary = await r.get(\`summary:\${id}\`);
  const raw = await r.lrange(\`turns:\${id}\`, 0, -1);
  const turns = raw.map(entry => JSON.parse(entry) as Turn);
  const body = {
    summary,
    turns: turns.map(turn => ({turn_id: turn.turn_id, role: turn.role, content: turn.content})),
  };
  await r.set(\`context:\${id}\`, JSON.stringify(body), 'EX', 60);
  return reply.code(200).send(body);
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** GET /v1/sessions/:id/context: authorize, cap and cache under the latest turn id. */
import Fastify from 'fastify';
import {Redis} from 'ioredis';

export const app = Fastify();
const r = new Redis('redis://redis:6379');

const MAX_CONTEXT_TOKENS = 6000;
const MAX_RECENT_TURNS = 50;

interface Turn {
  turn_id: string;
  role: string;
  content: string;
}

async function assertTenantOwns(tenant: string, sessionId: string): Promise<void> {
  const owner = await r.hget('sessions', sessionId);
  if (owner !== tenant) {
    const error = new Error('session not found') as Error & {statusCode: number};
    error.statusCode = 404;
    throw error;
  }
}

function truncateToBudget(turns: Turn[], summary: string | null): Turn[] {
  let budget = MAX_CONTEXT_TOKENS - (summary === null ? 0 : Math.ceil(summary.length / 4));
  const kept: Turn[] = [];
  for (const turn of turns) {
    const cost = Math.ceil(turn.content.length / 4);
    if (cost > budget) break;
    kept.push(turn);
    budget -= cost;
  }
  return kept.reverse();
}

app.get('/v1/sessions/:id/context', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'] as string;
  const {id} = request.params as {id: string};
  await assertTenantOwns(tenant, id);
  const summary = await r.get(\`summary:\${tenant}:\${id}\`);
  const raw = await r.lrange(\`turns:\${tenant}:\${id}\`, 0, MAX_RECENT_TURNS - 1);
  const turns = raw.map(entry => JSON.parse(entry) as Turn);
  const latestTurnId = turns.length === 0 ? 'empty' : turns[0].turn_id;
  const cached = await r.get(\`context:\${tenant}:\${id}:\${latestTurnId}\`);
  if (cached !== null) return reply.code(200).send(JSON.parse(cached));
  const body = {
    summary,
    turns: truncateToBudget(turns, summary).map(turn => ({
      turn_id: turn.turn_id,
      role: turn.role,
      content: turn.content,
    })),
  };
  await r.set(\`context:\${tenant}:\${id}:\${latestTurnId}\`, JSON.stringify(body), 'EX', 60);
  return reply.code(200).send(body);
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

type turn struct {
	TurnID  string \`json:"turn_id"\`
	Role    string \`json:"role"\`
	Content string \`json:"content"\`
}

func readContext(rw http.ResponseWriter, r *http.Request) {
	ctx := context.Background()
	id := r.PathValue("id")
	// TODO: check that the session belongs to the tenant and answer 404 otherwise, cap the context
	// at 6000 tokens by dropping the oldest turns first, and key the cache on the latest turn id so
	// a read after an append does not return a stale context.
	if cached, err := rdb.Get(ctx, "context:"+id).Result(); err == nil {
		rw.Header().Set("Content-Type", "application/json")
		_, _ = rw.Write([]byte(cached))
		return
	}
	summary, _ := rdb.Get(ctx, "summary:"+id).Result()
	raw, _ := rdb.LRange(ctx, "turns:"+id, 0, -1).Result()
	turns := make([]turn, 0, len(raw))
	for _, entry := range raw {
		var t turn
		_ = json.Unmarshal([]byte(entry), &t)
		turns = append(turns, t)
	}
	body, _ := json.Marshal(map[string]any{"summary": summary, "turns": turns})
	rdb.Set(ctx, "context:"+id, body, 0)
	rw.Header().Set("Content-Type", "application/json")
	_, _ = rw.Write(body)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/sessions/{id}/context", readContext)
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"

	"github.com/redis/go-redis/v9"
)

const (
	maxContextTokens = 6000
	maxRecentTurns   = 50
)

var rdb *redis.Client

type turn struct {
	TurnID  string \`json:"turn_id"\`
	Role    string \`json:"role"\`
	Content string \`json:"content"\`
}

func assertTenantOwns(ctx context.Context, tenant, sessionID string) error {
	owner, err := rdb.HGet(ctx, "sessions", sessionID).Result()
	if err != nil || owner != tenant {
		return errors.New("session not found")
	}
	return nil
}

func truncateToBudget(turns []turn, summary string) []turn {
	budget := maxContextTokens - len(summary)/4
	kept := make([]turn, 0, len(turns))
	for _, t := range turns {
		cost := len(t.Content) / 4
		if cost > budget {
			break
		}
		kept = append(kept, t)
		budget -= cost
	}
	for i, j := 0, len(kept)-1; i < j; i, j = i+1, j-1 {
		kept[i], kept[j] = kept[j], kept[i]
	}
	return kept
}

func readContext(rw http.ResponseWriter, r *http.Request) {
	ctx := context.Background()
	tenant := r.Header.Get("X-Tenant-Id")
	id := r.PathValue("id")
	if err := assertTenantOwns(ctx, tenant, id); err != nil {
		http.Error(rw, \`{"error":"session not found"}\`, http.StatusNotFound)
		return
	}
	summary, _ := rdb.Get(ctx, "summary:"+tenant+":"+id).Result()
	raw, _ := rdb.LRange(ctx, "turns:"+tenant+":"+id, 0, maxRecentTurns-1).Result()
	turns := make([]turn, 0, len(raw))
	for _, entry := range raw {
		var t turn
		_ = json.Unmarshal([]byte(entry), &t)
		turns = append(turns, t)
	}
	latestTurnID := "empty"
	if len(turns) > 0 {
		latestTurnID = turns[0].TurnID
	}
	if cached, err := rdb.Get(ctx, "context:"+tenant+":"+id+":"+latestTurnID).Result(); err == nil {
		rw.Header().Set("Content-Type", "application/json")
		_, _ = rw.Write([]byte(cached))
		return
	}
	body, _ := json.Marshal(map[string]any{"summary": summary, "turns": truncateToBudget(turns, summary)})
	rdb.Set(ctx, "context:"+tenant+":"+id+":"+latestTurnID, body, 0)
	rw.Header().Set("Content-Type", "application/json")
	_, _ = rw.Write(body)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/sessions/{id}/context", readContext)
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
import spray.json._

object ContextApi {
  implicit val system: ActorSystem = ActorSystem("chat-memory")
  val jedis = new Jedis("redis", 6379)

  val route: Route =
    path("v1" / "sessions" / Segment / "context") { id =>
      get {
        // TODO: check that the session belongs to the tenant and answer 404 otherwise, cap the
        // context at 6000 tokens by dropping the oldest turns first, and key the cache on the
        // latest turn id so a read after an append does not return a stale context.
        Option(jedis.get(s"context:$id")) match {
          case Some(cached) => complete(StatusCodes.OK, cached)
          case None =>
            val summary = Option(jedis.get(s"summary:$id"))
            val raw = jedis.lrange(s"turns:$id", 0, -1).asScala.toList
            val cited = raw.map { entry =>
              val turn = entry.parseJson.asJsObject
              JsObject(
                "turn_id" -> turn.fields("turn_id"),
                "role" -> turn.fields("role"),
                "content" -> turn.fields("content")
              )
            }
            val body = JsObject(
              "summary" -> summary.map(JsString(_)).getOrElse(JsNull),
              "turns" -> JsArray(cited.toVector)
            ).compactPrint
            jedis.set(s"context:$id", body)
            complete(StatusCodes.OK, body)
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
import scala.jdk.CollectionConverters._
import spray.json._

object ContextApi {
  implicit val system: ActorSystem = ActorSystem("chat-memory")
  val MaxContextTokens = 6000
  val MaxRecentTurns = 50
  val jedis = new Jedis("redis", 6379)

  def assertTenantOwns(tenant: String, sessionId: String): Unit = {
    val owner = Option(jedis.hget("sessions", sessionId))
    if (!owner.contains(tenant)) throw new NoSuchElementException("session not found")
  }

  def truncateToBudget(turns: List[JsObject], summaryTokens: Int): List[JsObject] = {
    var budget = MaxContextTokens - summaryTokens
    val kept = scala.collection.mutable.ListBuffer.empty[JsObject]
    turns.foreach { turn =>
      val cost = turn.fields("content").compactPrint.length / 4
      if (cost <= budget) {
        kept += turn
        budget -= cost
      }
    }
    kept.reverse.toList
  }

  val route: Route =
    path("v1" / "sessions" / Segment / "context") { id =>
      get {
        headerValueByName("X-Tenant-Id") { tenant =>
          try {
            assertTenantOwns(tenant, id)
            val summary = Option(jedis.get(s"summary:$tenant:$id"))
            val raw = jedis.lrange(s"turns:$tenant:$id", 0, MaxRecentTurns - 1).asScala.toList
            val turns = raw.map(_.parseJson.asJsObject)
            val latestTurnId = turns.headOption.map(_.fields("turn_id").compactPrint).getOrElse("empty")
            Option(jedis.get(s"context:$tenant:$id:$latestTurnId")) match {
              case Some(cached) => complete(StatusCodes.OK, cached)
              case None =>
                val kept = truncateToBudget(turns, summary.map(_.length / 4).getOrElse(0))
                val cited = kept.map { turn =>
                  JsObject(
                    "turn_id" -> turn.fields("turn_id"),
                    "role" -> turn.fields("role"),
                    "content" -> turn.fields("content")
                  )
                }
                val body = JsObject(
                  "summary" -> summary.map(JsString(_)).getOrElse(JsNull),
                  "turns" -> JsArray(cited.toVector)
                ).compactPrint
                jedis.set(s"context:$tenant:$id:$latestTurnId", body)
                complete(StatusCodes.OK, body)
            }
          } catch {
            case _: NoSuchElementException => complete(StatusCodes.NotFound, """{"error":"session not found"}""")
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
#include <vector>

using json = nlohmann::json;

int main() {
  sw::redis::Redis redis("tcp://redis:6379");
  httplib::Server svr;

  svr.Get("/v1/sessions/:id/context", [&redis](const httplib::Request& req, httplib::Response& res) {
    const auto id = req.path_params.at("id");
    // TODO: check that the session belongs to the tenant and answer 404 otherwise, cap the context
    // at 6000 tokens by dropping the oldest turns first, and key the cache on the latest turn id so
    // a read after an append does not return a stale context.
    auto cached = redis.get("context:" + id);
    if (cached) {
      res.set_content(*cached, "application/json");
      return;
    }
    auto summary = redis.get("summary:" + id);
    std::vector<std::string> raw;
    redis.lrange("turns:" + id, 0, -1, std::back_inserter(raw));
    json turns = json::array();
    for (const auto& entry : raw) {
      json turn = json::parse(entry, nullptr, false);
      if (!turn.is_object()) continue;
      turns.push_back(json{{"turn_id", turn.value("turn_id", std::string())},
                           {"role", turn.value("role", std::string())},
                           {"content", turn.value("content", std::string())}});
    }
    const auto body = json{{"summary", summary ? json(*summary) : json(nullptr)}, {"turns", turns}}.dump();
    redis.set("context:" + id, body);
    res.set_content(body, "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <algorithm>
#include <iterator>
#include <stdexcept>
#include <string>
#include <vector>

using json = nlohmann::json;

constexpr std::size_t kMaxContextTokens = 6000;
constexpr long long kMaxRecentTurns = 50;

void assert_tenant_owns(sw::redis::Redis& redis, const std::string& tenant, const std::string& session_id) {
  auto owner = redis.hget("sessions", session_id);
  if (!owner || *owner != tenant) throw std::runtime_error("session not found");
}

std::vector<json> truncate_to_budget(std::vector<json> turns, std::size_t summary_tokens) {
  std::size_t budget = kMaxContextTokens - summary_tokens;
  std::vector<json> kept;
  for (const auto& turn : turns) {
    const auto cost = turn.value("content", std::string()).size() / 4;
    if (cost > budget) break;
    kept.push_back(turn);
    budget -= cost;
  }
  std::reverse(kept.begin(), kept.end());
  return kept;
}

int main() {
  sw::redis::Redis redis("tcp://redis:6379");
  httplib::Server svr;

  svr.Get("/v1/sessions/:id/context", [&redis](const httplib::Request& req, httplib::Response& res) {
    const auto tenant = req.get_header_value("X-Tenant-Id");
    const auto id = req.path_params.at("id");
    try {
      assert_tenant_owns(redis, tenant, id);
    } catch (const std::runtime_error&) {
      res.status = 404;
      res.set_content(R"({"error":"session not found"})", "application/json");
      return;
    }
    auto summary = redis.get("summary:" + tenant + ":" + id);
    std::vector<std::string> raw;
    redis.lrange("turns:" + tenant + ":" + id, 0, kMaxRecentTurns - 1, std::back_inserter(raw));
    std::vector<json> turns;
    for (const auto& entry : raw) {
      json turn = json::parse(entry, nullptr, false);
      if (turn.is_object()) turns.push_back(turn);
    }
    const auto latest_turn_id = turns.empty() ? std::string("empty") : turns.front().value("turn_id", std::string());
    auto cached = redis.get("context:" + tenant + ":" + id + ":" + latest_turn_id);
    if (cached) {
      res.set_content(*cached, "application/json");
      return;
    }
    const auto kept = truncate_to_budget(turns, summary ? summary->size() / 4 : 0);
    json cited = json::array();
    for (const auto& turn : kept) {
      cited.push_back(json{{"turn_id", turn.value("turn_id", std::string())},
                           {"role", turn.value("role", std::string())},
                           {"content", turn.value("content", std::string())}});
    }
    const auto body = json{{"summary", summary ? json(*summary) : json(nullptr)}, {"turns", cited}}.dump();
    redis.set("context:" + tenant + ":" + id + ":" + latest_turn_id, body);
    res.set_content(body, "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  debrief: `The interview question behind this step is a read path with three obligations that are easy to
skip because the happy path works without them. The first is authorization: a read is not safer
than a write, and a session id in a path is still a claim, so the owner check runs before any key
is touched and a foreign session is a 404 rather than another tenant's conversation. The second is
budget: the model call has a token limit, and the assembler must drop the oldest turns to fit it,
which means walking the newest-first buffer and stopping when the next turn would cross the cap.
The third is freshness: a cache keyed only by session id serves a context that no longer exists
after the next append, so the key must carry the latest turn id and change with the conversation.
The 60-second TTL is then just garbage collection, not correctness.`,
};
