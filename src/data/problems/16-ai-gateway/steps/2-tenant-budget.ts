import type {Step} from '@/lib/types';

export const tenantBudgetStep: Step = {
  id: 'tenant-budget',
  title: 'Daily budget: one atomic reservation',
  concept: 'redis',
  file: 'budget',
  focus: ['gateway', 'budget'],
  task: `## Task

The starter is a plausible model-generated draft: it passes the happy path — a tenant with budget
left gets its request through — but it hides a race and a leak. Find them, fix them, and prove the
fix.

Implement the daily token budget used by every chat request. The key is
\`budget:{tenant}:{yyyymmdd}\` in UTC and holds the **tokens remaining today**; the daily limit is
\`DAILY_TOKEN_BUDGET\`.

- Reserve \`estimated_input + max_tokens\` before the provider call. One **atomic Lua EVAL** must
  read the remaining budget, reject when the request does not fit, and decrement when it does.
  A read followed by a separate decrement lets two concurrent requests both see the same budget and
  overspend it.
- Set the TTL on the first write: the key must expire after \`BUDGET_TTL_S\`, not live forever.
- When the budget is insufficient, answer **429** with \`Retry-After\` (seconds) and
  \`X-RateLimit-Remaining\`, and do **not** call the provider.
- The tenant and the UTC day are both part of the key: \`budget:acme:20261020\`, not
  \`budget:acme\`.

The failure mode the checks target is a budget that looks correct in a serial test and overspends
under concurrency, and a key that never expires, silently resetting the tenant's spend on a deploy
or never resetting it at all.`,
  sequence: {
    participants: ['Gateway', 'Redis', 'Providers'],
    messages: [
      {from: 'Gateway', to: 'Redis', label: 'EVAL reserve · KEYS[budget:acme:20261020]', kind: 'sync'},
      {from: 'Redis', to: 'Gateway', label: '{1, 812340, 17402}', kind: 'reply'},
      {from: 'Gateway', to: 'Providers', label: 'Complete(...) only after the reservation', kind: 'sync'},
      {from: 'Providers', to: 'Gateway', label: 'CompleteReply{content, usage}', kind: 'reply'},
      {from: 'Gateway', to: 'Gateway', label: '429 {Retry-After, X-RateLimit-Remaining} when rejected', kind: 'sync'},
    ],
  },
  hints: [
    'The script must do all three things on the server: read the remaining value, decide, and decrement. Sending `GET` and then `DECRBY` from the client leaves a window between the two commands where another request can pass the same check.',
    'A new key needs both a starting value and an expiry, and Redis can set them together with `SET key value EX ttl`. The TTL is only set when the key is created; a decrement on an existing key must not extend the window.',
    'The 429 is not just a status: `Retry-After` tells the client how long to wait (the key TTL is a good answer) and `X-RateLimit-Remaining` lets it back off before the next refusal. Return from the handler before touching the provider stub.',
  ],
  checks: [
    {
      id: 'atomic',
      title: 'Reserves with one atomic Lua script',
      detail:
        'The read, the check and the decrement happen inside one `EVAL`/`register_script` call. A client-side `GET` followed by `DECRBY` races: two requests can both observe budget that only one of them can spend.',
      match: {
        python: {all: [/RESERVE_LUA/, /\.eval\(/, /DECRBY/, /GET/]},
        go: {all: [/NewScript\(/, /\.Run\(/, /DECRBY/, /GET/]},
        scala: {all: [/\.eval\(/, /DECRBY/, /GET/, /ReserveLua/]},
        cpp: {all: [/\.eval</, /DECRBY/, /GET/, /kReserveLua/]},
        typescript: {all: [/RESERVE_LUA/, /\.eval\(/, /DECRBY/, /GET/]},
      },
    },
    {
      id: 'ttl',
      title: 'Sets the daily-key expiry on first write',
      detail:
        'The script creates the key with `SET … EX BUDGET_TTL_S` and returns/uses its TTL. Without an expiry the daily budget never resets; with an expiry set by a separate call after the decrement, a failed request can leave a key that lives forever.',
      match: {
        python: {all: [/'EX'/, /TTL/]},
        go: {all: [/'EX'/, /TTL/]},
        scala: {all: [/'EX'/, /TTL/]},
        cpp: {all: [/'EX'/, /TTL/]},
        typescript: {all: [/'EX'/, /TTL/]},
      },
    },
    {
      id: 'reject-headers',
      title: 'Answers 429 with Retry-After and remaining budget',
      detail:
        'An exhausted tenant gets `429 Too Many Requests`, a `Retry-After` in seconds, and `X-RateLimit-Remaining`; the provider is not called.',
      match: {
        python: {all: [/Retry-After/, /X-RateLimit-Remaining/, /status_code\s*=\s*429/]},
        go: {all: [/Retry-After/, /X-RateLimit-Remaining/, /StatusTooManyRequests|\b429\b/]},
        scala: {all: [/Retry-After/, /X-RateLimit-Remaining/, /TooManyRequests|\b429\b/]},
        cpp: {all: [/Retry-After/, /X-RateLimit-Remaining/, /status\s*=\s*429/]},
        typescript: {all: [/Retry-After/, /X-RateLimit-Remaining/, /\.code\(\s*429\s*\)/]},
      },
    },
    {
      id: 'tenant-day-key',
      title: 'Keys by tenant and UTC day',
      detail:
        "The key is `budget:{tenant}:{yyyymmdd}` built from the authenticated tenant and the UTC date; a shared key or a tenant-less key lets one tenant spend another tenant's budget.",
      match: {
        python: {all: [/budget:\{tenant\}:\{day\}/, /%Y%m%d|%Y-%m-%d|strftime/]},
        go: {all: [/budget:%s:%s/, /20060102/]},
        scala: {all: [/budget:\$tenant:\$day/, /yyyyMMdd/]},
        cpp: {all: [/budget:/, /%Y%m%d/]},
        typescript: {all: [/budget:\$\{tenant\}:\$\{day\}/, /toISOString/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import time

import grpc
import redis

import providers_pb2
import providers_pb2_grpc
from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)

DAILY_TOKEN_BUDGET = 1_000_000
BUDGET_TTL_S = 2 * 24 * 3600

channel = grpc.insecure_channel("providers:9000")
providers = providers_pb2_grpc.ProviderStub(channel)


class ChatRequest(BaseModel):
    model: str = "gpt-4o-mini"
    messages: list[dict]
    max_tokens: int = 512


def budget_key(tenant: str) -> str:
    day = time.strftime("%Y%m%d", time.gmtime())
    return f"budget:{tenant}:{day}"


def charge(tenant: str, tokens: int) -> tuple[bool, int, int]:
    # TODO: one atomic EVAL: read, reject if tokens > left, DECRBY, and SET ... EX on first write
    key = budget_key(tenant)
    left = int(r.get(key) or DAILY_TOKEN_BUDGET)
    if tokens > left:
        return False, left, 0
    r.decrby(key, tokens)
    return True, left - tokens, 0


@app.post("/v1/chat")
def chat(body: ChatRequest, authorization: str | None = Header(default=None)):
    tenant = authorization.removeprefix("Bearer ") if authorization else ""
    wanted = sum(len(m.get("content", "")) for m in body.messages) // 4 + body.max_tokens
    ok, left, ttl = charge(tenant, wanted)
    if not ok:
        raise HTTPException(status_code=429, detail="daily token budget exhausted")
    request = providers_pb2.CompleteRequest(model=body.model, max_tokens=body.max_tokens)
    reply = providers.Complete(request, timeout=8.0)
    return {"id": "req", "content": reply.content, "usage": {"remaining": left}}
`,
      solution: `import time

import grpc
import redis

import providers_pb2
import providers_pb2_grpc
from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)

DAILY_TOKEN_BUDGET = 1_000_000
BUDGET_TTL_S = 2 * 24 * 3600

RESERVE_LUA = """
local left = tonumber(redis.call('GET', KEYS[1]))
if left == nil then
  redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3])
  left = tonumber(ARGV[2])
end
local want = tonumber(ARGV[1])
if want > left then
  return {0, left, redis.call('TTL', KEYS[1])}
end
redis.call('DECRBY', KEYS[1], want)
return {1, left - want, redis.call('TTL', KEYS[1])}
"""

channel = grpc.insecure_channel("providers:9000")
providers = providers_pb2_grpc.ProviderStub(channel)


class ChatRequest(BaseModel):
    model: str = "gpt-4o-mini"
    messages: list[dict]
    max_tokens: int = 512


def budget_key(tenant: str) -> str:
    day = time.strftime("%Y%m%d", time.gmtime())
    return f"budget:{tenant}:{day}"


def reserve(tenant: str, tokens: int) -> tuple[bool, int, int]:
    ok, left, ttl = r.eval(RESERVE_LUA, 1, budget_key(tenant), tokens, DAILY_TOKEN_BUDGET, BUDGET_TTL_S)
    return bool(ok), int(left), int(ttl)


@app.post("/v1/chat")
def chat(body: ChatRequest, authorization: str | None = Header(default=None)):
    tenant = authorization.removeprefix("Bearer ") if authorization else ""
    wanted = sum(len(m.get("content", "")) for m in body.messages) // 4 + body.max_tokens
    ok, left, ttl = reserve(tenant, wanted)
    if not ok:
        raise HTTPException(
            status_code=429,
            detail="daily token budget exhausted",
            headers={"Retry-After": str(max(ttl, 1)), "X-RateLimit-Remaining": str(left)},
        )
    request = providers_pb2.CompleteRequest(model=body.model, max_tokens=body.max_tokens)
    reply = providers.Complete(request, timeout=8.0)
    return {"id": "req", "content": reply.content, "usage": {"remaining": left}}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/redis/go-redis/v9"
	pb "gateway/providerspb"
)

const (
	dailyTokenBudget  = 1000000
	budgetTTLSeconds  = 2 * 24 * 3600
)

var (
	rdb       *redis.Client
	providers pb.ProviderClient
)

func budgetKey(tenant string) string {
	day := time.Now().UTC().Format("20060102")
	return fmt.Sprintf("budget:%s:%s", tenant, day)
}

func charge(ctx context.Context, tenant string, tokens int) (bool, int, int) {
	// TODO: replace get-then-decrby with redis.NewScript: read, check, DECRBY, SET ... EX on first write
	key := budgetKey(tenant)
	left, err := rdb.Get(ctx, key).Int()
	if err == redis.Nil {
		left = dailyTokenBudget
	}
	if tokens > left {
		return false, left, 0
	}
	rdb.DecrBy(ctx, key, int64(tokens))
	return true, left - tokens, 0
}

func chat(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("Authorization")
	body := struct {
		Model     string \`json:"model"\`
		Messages  []map[string]string \`json:"messages"\`
		MaxTokens int \`json:"max_tokens"\`
	}{}
	_ = json.NewDecoder(r.Body).Decode(&body)
	chars := 0
	for _, m := range body.Messages {
		chars += len(m["content"])
	}
	ok, left, _ := charge(r.Context(), tenant, chars/4+body.MaxTokens)
	if !ok {
		rw.WriteHeader(http.StatusTooManyRequests)
		return
	}
	_, _ = providers.Complete(r.Context(), &pb.CompleteRequest{Model: body.Model, MaxTokens: int32(body.MaxTokens)})
	rw.Header().Set("Content-Type", "application/json")
	_, _ = rw.Write([]byte(fmt.Sprintf(\`{"remaining":%d}\`, left)))
}

func main() {}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/redis/go-redis/v9"
	pb "gateway/providerspb"
)

const (
	dailyTokenBudget = 1000000
	budgetTTLSeconds = 2 * 24 * 3600
)

var (
	rdb       *redis.Client
	providers pb.ProviderClient
)

var reserveScript = redis.NewScript(\`
local left = tonumber(redis.call('GET', KEYS[1]))
if left == nil then
  redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3])
  left = tonumber(ARGV[2])
end
local want = tonumber(ARGV[1])
if want > left then
  return {0, left, redis.call('TTL', KEYS[1])}
end
redis.call('DECRBY', KEYS[1], want)
return {1, left - want, redis.call('TTL', KEYS[1])}
\`)

func budgetKey(tenant string) string {
	day := time.Now().UTC().Format("20060102")
	return fmt.Sprintf("budget:%s:%s", tenant, day)
}

func reserve(ctx context.Context, tenant string, tokens int) (bool, int64, int64) {
	values, err := reserveScript.Run(ctx, rdb, []string{budgetKey(tenant)}, tokens, dailyTokenBudget, budgetTTLSeconds).Int64Slice()
	if err != nil {
		panic(err)
	}
	return values[0] == 1, values[1], values[2]
}

func chat(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("Authorization")
	body := struct {
		Model     string              \`json:"model"\`
		Messages  []map[string]string \`json:"messages"\`
		MaxTokens int                 \`json:"max_tokens"\`
	}{}
	_ = json.NewDecoder(r.Body).Decode(&body)
	chars := 0
	for _, m := range body.Messages {
		chars += len(m["content"])
	}
	ok, left, ttl := reserve(r.Context(), tenant, chars/4+body.MaxTokens)
	if !ok {
		rw.Header().Set("Retry-After", fmt.Sprintf("%d", ttl))
		rw.Header().Set("X-RateLimit-Remaining", fmt.Sprintf("%d", left))
		rw.WriteHeader(http.StatusTooManyRequests)
		return
	}
	_, _ = providers.Complete(r.Context(), &pb.CompleteRequest{Model: body.Model, MaxTokens: int32(body.MaxTokens)})
	rw.Header().Set("Content-Type", "application/json")
	_, _ = rw.Write([]byte(fmt.Sprintf(\`{"remaining":%d}\`, left)))
}

func main() {}
`,
    },
    scala: {
      starter: `import java.text.SimpleDateFormat
import java.util.Date

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import redis.clients.jedis.Jedis

object BudgetApi {
  val DailyTokenBudget = 1000000L
  val BudgetTtlSeconds = 2L * 24 * 3600
  val jedis = new Jedis("redis", 6379)

  def budgetKey(tenant: String): String = {
    val day = new SimpleDateFormat("yyyyMMdd").format(new Date())
    s"budget:$tenant:$day"
  }

  // TODO: one atomic EVAL: read, check, DECRBY, and SET ... EX on first write
  def charge(tenant: String, tokens: Long): (Boolean, Long, Long) = {
    val key = budgetKey(tenant)
    val left = Option(jedis.get(key)).map(_.toLong).getOrElse(DailyTokenBudget)
    if (tokens > left) (false, left, 0L)
    else {
      jedis.decrBy(key, tokens)
      (true, left - tokens, 0L)
    }
  }

  private def json(status: StatusCode, body: String): Route =
    complete(HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body)))

  val route: Route =
    path("v1" / "chat") {
      post {
        headerValueByName("X-Tenant") { tenant =>
          entity(as[String]) { _ =>
            val (ok, left, _) = charge(tenant, 500)
            if (!ok) json(StatusCodes.TooManyRequests, """{"error":"daily token budget exhausted"}""")
            else json(StatusCodes.OK, """{"remaining":""" + left + "}")
          }
        }
      }
    }

  def main(args: Array[String]): Unit = {
    implicit val system: ActorSystem = ActorSystem("gateway")
    Http().newServerAt("0.0.0.0", 8443).bind(route)
  }
}
`,
      solution: `import java.text.SimpleDateFormat
import java.util.Date

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.model.headers.RawHeader
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import redis.clients.jedis.Jedis

object BudgetApi {
  val DailyTokenBudget = 1000000L
  val BudgetTtlSeconds = 2L * 24 * 3600
  val jedis = new Jedis("redis", 6379)

  val ReserveLua =
    """
      |local left = tonumber(redis.call('GET', KEYS[1]))
      |if left == nil then
      |  redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3])
      |  left = tonumber(ARGV[2])
      |end
      |local want = tonumber(ARGV[1])
      |if want > left then
      |  return {0, left, redis.call('TTL', KEYS[1])}
      |end
      |redis.call('DECRBY', KEYS[1], want)
      |return {1, left - want, redis.call('TTL', KEYS[1])}
      |""".stripMargin

  def budgetKey(tenant: String): String = {
    val day = new SimpleDateFormat("yyyyMMdd").format(new Date())
    s"budget:$tenant:$day"
  }

  def reserve(tenant: String, tokens: Long): (Boolean, Long, Long) = {
    val result = jedis
      .eval(ReserveLua, 1, budgetKey(tenant), tokens.toString, DailyTokenBudget.toString, BudgetTtlSeconds.toString)
      .asInstanceOf[java.util.List[Long]]
    (result.get(0) == 1L, result.get(1), result.get(2))
  }

  private def json(status: StatusCode, body: String, headers: List[HttpHeader] = Nil): Route =
    complete(HttpResponse(status, headers = headers, entity = HttpEntity(ContentTypes.\`application/json\`, body)))

  val route: Route =
    path("v1" / "chat") {
      post {
        headerValueByName("X-Tenant") { tenant =>
          entity(as[String]) { _ =>
            val (ok, left, ttl) = reserve(tenant, 500)
            if (!ok) {
              json(
                StatusCodes.TooManyRequests,
                """{"error":"daily token budget exhausted"}""",
                List(RawHeader("Retry-After", ttl.toString), RawHeader("X-RateLimit-Remaining", left.toString))
              )
            } else json(StatusCodes.OK, """{"remaining":""" + left + "}")
          }
        }
      }
    }

  def main(args: Array[String]): Unit = {
    implicit val system: ActorSystem = ActorSystem("gateway")
    Http().newServerAt("0.0.0.0", 8443).bind(route)
  }
}
`,
    },
    cpp: {
      starter: `#include <chrono>
#include <ctime>
#include <iomanip>
#include <sstream>
#include <string>
#include <tuple>

#include <httplib.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

using json = nlohmann::json;

constexpr long long kDailyTokenBudget = 1000000;
constexpr long long kBudgetTtlSeconds = 2 * 24 * 3600;

static std::string budget_key(const std::string& tenant) {
  const std::time_t now = std::time(nullptr);
  std::ostringstream day;
  day << std::put_time(std::gmtime(&now), "%Y%m%d");
  return "budget:" + tenant + ":" + day.str();
}

std::tuple<bool, long long, long long> charge(sw::redis::Redis& redis, const std::string& tenant, long long tokens) {
  // TODO: one atomic EVAL: read, check, DECRBY, and SET ... EX on first write
  const auto key = budget_key(tenant);
  auto raw = redis.get(key);
  long long left = raw ? std::stoll(*raw) : kDailyTokenBudget;
  if (tokens > left) return {false, left, 0};
  redis.decrby(key, tokens);
  return {true, left - tokens, 0};
}

int main() {
  sw::redis::Redis redis("tcp://redis:6379");
  httplib::SSLServer svr("cert.pem", "key.pem");

  svr.Post("/v1/chat", [&redis](const httplib::Request& req, httplib::Response& res) {
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) body = json::object();
    long long chars = 0;
    if (body.contains("messages") && body["messages"].is_array()) {
      for (const auto& m : body["messages"]) chars += static_cast<long long>(m.value("content", "").size());
    }
    const auto [ok, left, ttl] = charge(redis, req.get_header_value("X-Tenant"), chars / 4 + body.value("max_tokens", 512));
    if (!ok) {
      res.status = 429;
      res.set_content(R"({"error":"daily token budget exhausted"})", "application/json");
      return;
    }
    res.status = 200;
    res.set_content(json{{"remaining", left}}.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <chrono>
#include <cstdio>
#include <ctime>
#include <iomanip>
#include <sstream>
#include <string>
#include <tuple>

#include <httplib.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

using json = nlohmann::json;

constexpr long long kDailyTokenBudget = 1000000;
constexpr long long kBudgetTtlSeconds = 2 * 24 * 3600;

static const char* kReserveLua = R"(
local left = tonumber(redis.call('GET', KEYS[1]))
if left == nil then
  redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3])
  left = tonumber(ARGV[2])
end
local want = tonumber(ARGV[1])
if want > left then
  return '0:' .. tostring(left) .. ':' .. tostring(redis.call('TTL', KEYS[1]))
end
redis.call('DECRBY', KEYS[1], want)
return '1:' .. tostring(left - want) .. ':' .. tostring(redis.call('TTL', KEYS[1]))
)";

static std::string budget_key(const std::string& tenant) {
  const std::time_t now = std::time(nullptr);
  std::ostringstream day;
  day << std::put_time(std::gmtime(&now), "%Y%m%d");
  return "budget:" + tenant + ":" + day.str();
}

std::tuple<bool, long long, long long> reserve(sw::redis::Redis& redis, const std::string& tenant, long long tokens) {
  const auto raw = redis.eval<std::string>(
      kReserveLua,
      {budget_key(tenant)},
      {std::to_string(tokens), std::to_string(kDailyTokenBudget), std::to_string(kBudgetTtlSeconds)});
  int ok = 0;
  long long left = 0;
  long long ttl = 0;
  std::sscanf(raw.c_str(), "%d:%lld:%lld", &ok, &left, &ttl);
  return {ok == 1, left, ttl};
}

int main() {
  sw::redis::Redis redis("tcp://redis:6379");
  httplib::SSLServer svr("cert.pem", "key.pem");

  svr.Post("/v1/chat", [&redis](const httplib::Request& req, httplib::Response& res) {
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) body = json::object();
    long long chars = 0;
    if (body.contains("messages") && body["messages"].is_array()) {
      for (const auto& m : body["messages"]) chars += static_cast<long long>(m.value("content", "").size());
    }
    const auto [ok, left, ttl] = reserve(redis, req.get_header_value("X-Tenant"), chars / 4 + body.value("max_tokens", 512));
    if (!ok) {
      res.status = 429;
      res.set_header("Retry-After", std::to_string(ttl));
      res.set_header("X-RateLimit-Remaining", std::to_string(left));
      res.set_content(R"({"error":"daily token budget exhausted"})", "application/json");
      return;
    }
    res.status = 200;
    res.set_content(json{{"remaining", left}}.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';
import Redis from 'ioredis';

const app = Fastify();
const redis = new Redis({host: 'redis', port: 6379});

const DAILY_TOKEN_BUDGET = 1_000_000;
const BUDGET_TTL_S = 2 * 24 * 3600;

interface Message {
  content?: string;
}
interface ChatRequest {
  model?: string;
  messages: Message[];
  max_tokens: number;
}

function budgetKey(tenant: string): string {
  // TODO: include the UTC day so the key is budget:{tenant}:{yyyymmdd}
  return \`budget:\${tenant}\`;
}

function estimateTokens(body: ChatRequest): number {
  const characters = body.messages.reduce((sum, message) => sum + (message.content?.length ?? 0), 0);
  return Math.ceil(characters / 4);
}

async function charge(tenant: string, tokens: number): Promise<[boolean, number, number]> {
  // TODO: replace GET-then-DECRBY with one atomic EVAL; SET ... EX on the first write
  const key = budgetKey(tenant);
  const left = Number((await redis.get(key)) ?? DAILY_TOKEN_BUDGET);
  if (tokens > left) return [false, left, 0];
  await redis.decrby(key, tokens);
  return [true, left - tokens, 0];
}

app.post('/v1/chat', async (request, reply) => {
  const authorization = request.headers.authorization;
  if (authorization === undefined || !authorization.startsWith('Bearer ')) {
    return reply.code(401).send({error: 'missing bearer token'});
  }
  const tenant = authorization.slice('Bearer '.length);
  const body = request.body as ChatRequest;
  const [ok, left] = await charge(tenant, estimateTokens(body) + body.max_tokens);
  if (!ok) {
    return reply.code(429).send({error: 'daily token budget exhausted'});
  }
  return reply.code(200).send({remaining: left});
});

await app.listen({host: '0.0.0.0', port: 8443});
`,
      solution: `import Fastify from 'fastify';
import Redis from 'ioredis';

const app = Fastify();
const redis = new Redis({host: 'redis', port: 6379});

const DAILY_TOKEN_BUDGET = 1_000_000;
const BUDGET_TTL_S = 2 * 24 * 3600;

const RESERVE_LUA = \`
local left = tonumber(redis.call('GET', KEYS[1]))
if left == nil then
  redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3])
  left = tonumber(ARGV[2])
end
local want = tonumber(ARGV[1])
if want > left then
  return {0, left, redis.call('TTL', KEYS[1])}
end
redis.call('DECRBY', KEYS[1], want)
return {1, left - want, redis.call('TTL', KEYS[1])}
\`;

interface Message {
  content?: string;
}
interface ChatRequest {
  model?: string;
  messages: Message[];
  max_tokens: number;
}

function budgetKey(tenant: string): string {
  const day = new Date().toISOString().slice(0, 10).replaceAll('-', '');
  return \`budget:\${tenant}:\${day}\`;
}

function estimateTokens(body: ChatRequest): number {
  const characters = body.messages.reduce((sum, message) => sum + (message.content?.length ?? 0), 0);
  return Math.ceil(characters / 4);
}

async function reserve(tenant: string, tokens: number): Promise<[boolean, number, number]> {
  const [ok, left, ttl] = (await redis.eval(
    RESERVE_LUA,
    1,
    budgetKey(tenant),
    String(tokens),
    String(DAILY_TOKEN_BUDGET),
    String(BUDGET_TTL_S),
  )) as [number, number, number];
  return [ok === 1, left, ttl];
}

app.post('/v1/chat', async (request, reply) => {
  const authorization = request.headers.authorization;
  if (authorization === undefined || !authorization.startsWith('Bearer ')) {
    return reply.code(401).send({error: 'missing bearer token'});
  }
  const tenant = authorization.slice('Bearer '.length);
  const body = request.body as ChatRequest;
  const [ok, left, ttl] = await reserve(tenant, estimateTokens(body) + body.max_tokens);
  if (!ok) {
    return reply
      .header('Retry-After', String(Math.max(ttl, 1)))
      .header('X-RateLimit-Remaining', String(left))
      .code(429)
      .send({error: 'daily token budget exhausted'});
  }
  return reply.code(200).send({remaining: left});
});

await app.listen({host: '0.0.0.0', port: 8443});
`,
    },
  },
  debrief: `The interview signal is **distributed-state review**: can you see that a correct-looking happy path becomes wrong the moment two requests overlap, and that a key without an expiry is a correctness bug rather than an optimisation? The fix is one Lua script because Redis executes it atomically on the server; the client-side version has a real interleaving where both requests read the same remaining budget. Setting \`EX\` on the first write makes the daily window self-healing. A real gateway also records the reservation against the request id so a failed provider call can refund it, and uses a per-tenant rate limiter as well as a token budget.`,
};
