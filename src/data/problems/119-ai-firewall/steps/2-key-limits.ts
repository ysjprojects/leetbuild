import type {Step} from '@/lib/types';

export const keyLimitsStep: Step = {
  id: 'key-limits',
  title: 'Per-key rate limit: one atomic window before any cost',
  concept: 'redis',
  file: 'rate_limit',
  focus: ['aifw', 'redis', 'guard'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: a key with requests left gets
through, so the demo passes. It hides a race, a leak, a bare refusal and a wrong order of
operations. Find them, fix them, and prove the fix.

Implement the per-API-key rate limit the firewall applies to every \`POST /v1/chat\`. The source
describes it as the answer to **model denial of service**: a cap on the requests one IP address or
API key may send in a window, so one caller cannot consume the model's capacity or budget.

- Each API key gets **120 requests** per **60-second window**. The key is
  \`aifw:rl:{api_key}:{window}\` where \`window\` is \`floor(unix_seconds / WINDOW_S)\` — a
  window-less key never resets.
- One **atomic Lua \`EVAL\`** does \`INCR\`, sets \`EXPIRE\` when the counter was just created, and
  returns the count and the key's \`TTL\`. A client-side \`GET\` followed by \`INCR\` lets concurrent
  requests all observe a count below the limit and all pass.
- Over the limit, answer **429** with \`Retry-After\` (seconds, the TTL the script returned) and do
  not touch the detector or the application.
- The limit runs **before** the detector: a request that will be refused must not pay for a
  detection call. The draft scores first and limits second.

**Failure mode the checks target.** Under load, \`GET\` then \`INCR\` admits more than 120 requests
in the window — exactly the burst the limit exists for; a key without an expiry locks a busy caller
out forever; a 429 without \`Retry-After\` makes well-behaved clients retry immediately; and scoring
before limiting means every refused request has already cost a detector call.`,
  sequence: {
    participants: ['aifw', 'Redis', 'PromptGuard'],
    messages: [
      {from: 'aifw', to: 'Redis', label: 'EVAL limit · KEYS[aifw:rl:k_7f3a:29876543]', kind: 'sync'},
      {from: 'Redis', to: 'aifw', label: '{count, ttl}', kind: 'reply'},
      {from: 'aifw', to: 'aifw', label: '429 Retry-After: ttl when count > 120, nothing else called', kind: 'sync'},
      {from: 'aifw', to: 'PromptGuard', label: 'decide(prompt, rid) only after the limit', kind: 'sync'},
      {from: 'PromptGuard', to: 'aifw', label: '{action, score, tags}', kind: 'reply'},
    ],
  },
  hints: [
    'Everything happens on the server: `INCR` the window key, `EXPIRE` it when `INCR` returned 1, read `TTL`, return both numbers. `GET` followed by `INCR` from the client leaves a gap where every concurrent request sees the same count.',
    'The window belongs in the key: `aifw:rl:{api_key}:{window}` with `window = floor(now / WINDOW_S)`. The expiry set at creation then makes the key die with its window instead of counting forever.',
    'A 429 is a contract, not a status: `Retry-After` is the TTL the script returned, and the handler returns before `decide(` is called. Move the limit above the detector call.',
  ],
  checks: [
    {
      id: 'atomic',
      title: 'Counts with one atomic Lua script',
      detail:
        'The counter is incremented and checked inside one `EVAL`/`NewScript` call that runs `INCR` on the server. The draft does a client-side `GET` and a separate `INCR`, so concurrent requests all pass the same check.',
      match: {
        python: {all: [/LIMIT_LUA/, /\.eval\(/, /INCR/]},
        typescript: {all: [/LIMIT_LUA/, /\.eval\(/, /INCR/]},
        go: {all: [/(limitScript|NewScript)/, /\.Run\(/, /INCR/]},
        scala: {all: [/LimitLua/, /\.eval\(/, /INCR/]},
        cpp: {all: [/kLimitLua/, /\.eval</, /INCR/]},
      },
    },
    {
      id: 'window-ttl',
      title: 'Keys by window and expires the key on first write',
      detail:
        'The key is `aifw:rl:{api_key}:{window}` built from `WINDOW_S`, and the script sets `EXPIRE` when it creates the key and returns its `TTL`. Without the window and the expiry the count never resets.',
      match: {
        python: {all: [/aifw:rl:\{api_key\}:\{window\}/, /WINDOW_S/, /EXPIRE/, /TTL/]},
        typescript: {all: [/aifw:rl:\$\{apiKey\}:\$\{window\}/, /WINDOW_S/, /EXPIRE/, /TTL/]},
        go: {all: [/aifw:rl:%s:%d/, /windowSeconds/, /EXPIRE/, /TTL/]},
        scala: {all: [/aifw:rl:\$apiKey:\$window/, /WindowSeconds/, /EXPIRE/, /TTL/]},
        cpp: {all: [/"aifw:rl:"/, /kWindowSeconds/, /EXPIRE/, /TTL/]},
      },
    },
    {
      id: 'retry-after',
      title: 'Answers 429 with Retry-After from the TTL',
      detail:
        'Over the limit, the response is `429 Too Many Requests` with a `Retry-After` header built from the TTL the script returned. The draft sends a bare 429.',
      match: {
        python: {all: [/Retry-After/, /status_code\s*=\s*429/]},
        typescript: {all: [/Retry-After/, /\.code\(\s*429\s*\)/]},
        go: {all: [/Retry-After/, /StatusTooManyRequests/]},
        scala: {all: [/Retry-After/, /StatusCodes\.TooManyRequests/]},
        cpp: {all: [/Retry-After/, /status\s*=\s*429/]},
      },
    },
    {
      id: 'limit-first',
      title: 'Limits before the detector is called',
      detail:
        'The limit check runs before `decide(`; a refused request never costs a detection call. The draft scores the prompt first and checks the limit afterwards.',
      match: {
        python: {order: [/=\s*check_limit\(/, /=\s*await\s+decide\(/]},
        typescript: {order: [/=\s*await\s+checkLimit\(/, /=\s*await\s+decide\(/]},
        go: {order: [/:=\s*checkLimit\(/, /:=\s*decide\(/]},
        scala: {order: [/=\s*checkLimit\(/, /=\s*Detect\.decide\(/]},
        cpp: {order: [/=\s*checkLimit\(/, /=\s*decide\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import redis
from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.responses import JSONResponse

from detect import decide
from firewall_api import forward, prompt_at, PROMPT_PATH

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)

LIMIT_REQUESTS = 120


def check_limit(api_key: str) -> tuple[bool, int]:
    # TODO: replace the client-side GET-then-INCR with one atomic EVAL, put the window in the key
    # and expire it on first write, and run the limit before the detector instead of after it.
    key = f"aifw:rl:{api_key}"
    count = int(r.get(key) or 0)
    if count >= LIMIT_REQUESTS:
        return False, 60
    r.incr(key)
    return True, 60


@app.post("/v1/chat")
async def chat(request: Request, api_key: str = Header(alias="X-Api-Key")) -> JSONResponse:
    body = await request.json()
    prompt = prompt_at(body, PROMPT_PATH) or ""
    decision = await decide(prompt, "")
    allowed, _ = check_limit(api_key)
    if not allowed:
        raise HTTPException(status_code=429, detail="rate limit exceeded")
    if decision.action == "block":
        return JSONResponse({"error": "blocked"}, status_code=403)
    return await forward(body)
`,
      solution: `import time

import redis
from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.responses import JSONResponse

from detect import decide
from firewall_api import forward, prompt_at, PROMPT_PATH

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)

WINDOW_S = 60
LIMIT_REQUESTS = 120

LIMIT_LUA = """
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
return {count, redis.call('TTL', KEYS[1])}
"""


def limit_key(api_key: str, window: int) -> str:
    return f"aifw:rl:{api_key}:{window}"


def check_limit(api_key: str) -> tuple[bool, int]:
    """(allowed, ttl): one INCR + EXPIRE on the server, so concurrent requests cannot all pass."""
    window = int(time.time()) // WINDOW_S
    count, ttl = r.eval(LIMIT_LUA, 1, limit_key(api_key, window), WINDOW_S)
    return int(count) <= LIMIT_REQUESTS, int(ttl)


@app.post("/v1/chat")
async def chat(request: Request, api_key: str = Header(alias="X-Api-Key")) -> JSONResponse:
    allowed, ttl = check_limit(api_key)
    if not allowed:
        raise HTTPException(
            status_code=429, detail="rate limit exceeded", headers={"Retry-After": str(max(ttl, 1))}
        )
    body = await request.json()
    prompt = prompt_at(body, PROMPT_PATH) or ""
    decision = await decide(prompt, "")
    if decision.action == "block":
        return JSONResponse({"error": "blocked"}, status_code=403)
    return await forward(body)
`,
    },
    typescript: {
      starter: `/** Per-key limit: a model-generated draft that reads, then increments, and never expires. */
import Fastify from 'fastify';
import {Redis} from 'ioredis';

import {decide} from './detect';
import {forward, promptAt, PROMPT_PATH} from './firewall_api';

export const app = Fastify();
const r = new Redis('redis://redis:6379');

const LIMIT_REQUESTS = 120;

async function checkLimit(apiKey: string): Promise<[boolean, number]> {
  // TODO: replace the client-side GET-then-INCR with one atomic EVAL, put the window in the key
  // and expire it on first write, and run the limit before the detector instead of after it.
  const key = \`aifw:rl:\${apiKey}\`;
  const count = Number((await r.get(key)) ?? 0);
  if (count >= LIMIT_REQUESTS) return [false, 60];
  await r.incr(key);
  return [true, 60];
}

app.post('/v1/chat', async (request, reply) => {
  const apiKey = request.headers['x-api-key'] as string;
  const prompt = promptAt(request.body, PROMPT_PATH) ?? '';
  const decision = await decide(prompt, '');
  const [allowed] = await checkLimit(apiKey);
  if (!allowed) return reply.code(429).send({error: 'rate limit exceeded'});
  if (decision.action === 'block') return reply.code(403).send({error: 'blocked'});
  return forward(request.body, reply);
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** Per-key limit: one atomic INCR + EXPIRE per window, checked before the detector is paid for. */
import Fastify from 'fastify';
import {Redis} from 'ioredis';

import {decide} from './detect';
import {forward, promptAt, PROMPT_PATH} from './firewall_api';

export const app = Fastify();
const r = new Redis('redis://redis:6379');

const WINDOW_S = 60;
const LIMIT_REQUESTS = 120;

const LIMIT_LUA = \`
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
return {count, redis.call('TTL', KEYS[1])}
\`;

function limitKey(apiKey: string, window: number): string {
  return \`aifw:rl:\${apiKey}:\${window}\`;
}

/** [allowed, ttl]: one INCR + EXPIRE on the server, so concurrent requests cannot all pass. */
async function checkLimit(apiKey: string): Promise<[boolean, number]> {
  const window = Math.floor(Date.now() / 1000 / WINDOW_S);
  const [count, ttl] = (await r.eval(LIMIT_LUA, 1, limitKey(apiKey, window), String(WINDOW_S))) as [
    number,
    number,
  ];
  return [count <= LIMIT_REQUESTS, ttl];
}

app.post('/v1/chat', async (request, reply) => {
  const apiKey = request.headers['x-api-key'] as string;
  const [allowed, ttl] = await checkLimit(apiKey);
  if (!allowed) {
    return reply
      .code(429)
      .header('Retry-After', String(Math.max(ttl, 1)))
      .send({error: 'rate limit exceeded'});
  }
  const prompt = promptAt(request.body, PROMPT_PATH) ?? '';
  const decision = await decide(prompt, '');
  if (decision.action === 'block') return reply.code(403).send({error: 'blocked'});
  return forward(request.body, reply);
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"fmt"
	"io"
	"net/http"

	"github.com/redis/go-redis/v9"
)

const limitRequests = 120

var rdb *redis.Client

func checkLimit(ctx context.Context, apiKey string) (bool, int64) {
	// TODO: replace the client-side GET-then-INCR with one atomic EVAL, put the window in the key
	// and expire it on first write, and run the limit before the detector instead of after it.
	key := fmt.Sprintf("aifw:rl:%s", apiKey)
	count, _ := rdb.Get(ctx, key).Int64()
	if count >= limitRequests {
		return false, 60
	}
	rdb.Incr(ctx, key)
	return true, 60
}

func chat(rw http.ResponseWriter, r *http.Request) {
	apiKey := r.Header.Get("X-Api-Key")
	raw, _ := io.ReadAll(r.Body)
	decision, _ := decide(r.Context(), promptAt(raw, promptPath), "")
	allowed, _ := checkLimit(r.Context(), apiKey)
	if !allowed {
		rw.WriteHeader(http.StatusTooManyRequests)
		return
	}
	if decision.Action == "block" {
		rw.WriteHeader(http.StatusForbidden)
		return
	}
	forward(rw, r, raw)
}
`,
      solution: `package main

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/redis/go-redis/v9"
)

const (
	windowSeconds = 60
	limitRequests = 120
)

var rdb *redis.Client

var limitScript = redis.NewScript(\`
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
return {count, redis.call('TTL', KEYS[1])}
\`)

func limitKey(apiKey string, window int64) string {
	return fmt.Sprintf("aifw:rl:%s:%d", apiKey, window)
}

// checkLimit returns (allowed, ttl): one INCR + EXPIRE on the server, so concurrent requests cannot all pass.
func checkLimit(ctx context.Context, apiKey string) (bool, int64) {
	window := time.Now().Unix() / windowSeconds
	values, err := limitScript.Run(ctx, rdb, []string{limitKey(apiKey, window)}, windowSeconds).Int64Slice()
	if err != nil {
		return false, windowSeconds
	}
	return values[0] <= limitRequests, values[1]
}

func chat(rw http.ResponseWriter, r *http.Request) {
	apiKey := r.Header.Get("X-Api-Key")
	allowed, ttl := checkLimit(r.Context(), apiKey)
	if !allowed {
		if ttl < 1 {
			ttl = 1
		}
		rw.Header().Set("Retry-After", fmt.Sprintf("%d", ttl))
		rw.WriteHeader(http.StatusTooManyRequests)
		return
	}
	raw, _ := io.ReadAll(r.Body)
	decision, _ := decide(r.Context(), promptAt(raw, promptPath), "")
	if decision.Action == "block" {
		rw.WriteHeader(http.StatusForbidden)
		return
	}
	forward(rw, r, raw)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import redis.clients.jedis.Jedis
import spray.json._

object RateLimit {
  implicit val system: ActorSystem = ActorSystem("aifw")

  val LimitRequests = 120L
  val jedis = new Jedis("redis", 6379)

  // TODO: replace the client-side GET-then-INCR with one atomic EVAL, put the window in the key
  // and expire it on first write, and run the limit before the detector instead of after it.
  def checkLimit(apiKey: String): (Boolean, Long) = {
    val key = s"aifw:rl:$apiKey"
    val count = Option(jedis.get(key)).map(_.toLong).getOrElse(0L)
    if (count >= LimitRequests) {
      (false, 60L)
    } else {
      jedis.incr(key)
      (true, 60L)
    }
  }

  val route: Route =
    path("v1" / "chat") {
      post {
        headerValueByName("X-Api-Key") { apiKey =>
          entity(as[String]) { raw =>
            val prompt = FirewallApi.promptAt(raw.parseJson, FirewallApi.PromptPath).getOrElse("")
            val decision = Detect.decide(prompt, "")
            val (allowed, _) = checkLimit(apiKey)
            if (!allowed) {
              complete(StatusCodes.TooManyRequests, """{"error":"rate limit exceeded"}""")
            } else if (decision.action == "block") {
              complete(StatusCodes.Forbidden, """{"error":"blocked"}""")
            } else {
              complete(FirewallApi.forward(raw))
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
      solution: `import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.model.headers.RawHeader
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import redis.clients.jedis.Jedis
import spray.json._

object RateLimit {
  implicit val system: ActorSystem = ActorSystem("aifw")

  val WindowSeconds = 60L
  val LimitRequests = 120L
  val jedis = new Jedis("redis", 6379)

  val LimitLua =
    """
      |local count = redis.call('INCR', KEYS[1])
      |if count == 1 then
      |  redis.call('EXPIRE', KEYS[1], ARGV[1])
      |end
      |return {count, redis.call('TTL', KEYS[1])}
      |""".stripMargin

  def limitKey(apiKey: String, window: Long): String = s"aifw:rl:$apiKey:$window"

  /** (allowed, ttl): one INCR + EXPIRE on the server, so concurrent requests cannot all pass. */
  def checkLimit(apiKey: String): (Boolean, Long) = {
    val window = System.currentTimeMillis() / 1000 / WindowSeconds
    val result = jedis
      .eval(LimitLua, 1, limitKey(apiKey, window), WindowSeconds.toString)
      .asInstanceOf[java.util.List[Long]]
    (result.get(0) <= LimitRequests, result.get(1))
  }

  val route: Route =
    path("v1" / "chat") {
      post {
        headerValueByName("X-Api-Key") { apiKey =>
          entity(as[String]) { raw =>
            val (allowed, ttl) = checkLimit(apiKey)
            if (!allowed) {
              complete(
                HttpResponse(
                  StatusCodes.TooManyRequests,
                  headers = List(RawHeader("Retry-After", math.max(ttl, 1L).toString)),
                  entity = HttpEntity(ContentTypes.\`application/json\`, """{"error":"rate limit exceeded"}""")
                )
              )
            } else {
              val prompt = FirewallApi.promptAt(raw.parseJson, FirewallApi.PromptPath).getOrElse("")
              val decision = Detect.decide(prompt, "")
              if (decision.action == "block") {
                complete(StatusCodes.Forbidden, """{"error":"blocked"}""")
              } else {
                complete(FirewallApi.forward(raw))
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
#include <utility>

#include "detect.h"
#include "firewall_api.h"

using json = nlohmann::json;

constexpr long long kLimitRequests = 120;

std::pair<bool, long long> checkLimit(sw::redis::Redis& redis, const std::string& apiKey) {
  // TODO: replace the client-side GET-then-INCR with one atomic EVAL, put the window in the key
  // and expire it on first write, and run the limit before the detector instead of after it.
  const auto key = "aifw:rl:" + apiKey;
  const auto raw = redis.get(key);
  const long long count = raw ? std::stoll(*raw) : 0;
  if (count >= kLimitRequests) return {false, 60};
  redis.incr(key);
  return {true, 60};
}

int main() {
  sw::redis::Redis redis("tcp://redis:6379");
  httplib::Server svr;

  svr.Post("/v1/chat", [&redis](const httplib::Request& req, httplib::Response& res) {
    const auto apiKey = req.get_header_value("X-Api-Key");
    const json body = json::parse(req.body, nullptr, false);
    const auto prompt = promptAt(body, kPromptPath).value_or("");
    const Decision decision = decide(prompt, "");
    const auto [allowed, ttl] = checkLimit(redis, apiKey);
    if (!allowed) {
      res.status = 429;
      res.set_content(R"({"error":"rate limit exceeded"})", "application/json");
      return;
    }
    if (decision.action == "block") {
      res.status = 403;
      res.set_content(R"({"error":"blocked"})", "application/json");
      return;
    }
    forward(req.body, res);
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <algorithm>
#include <chrono>
#include <string>
#include <utility>
#include <vector>

#include "detect.h"
#include "firewall_api.h"

using json = nlohmann::json;

constexpr long long kWindowSeconds = 60;
constexpr long long kLimitRequests = 120;

const char* kLimitLua = R"LUA(
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
return {count, redis.call('TTL', KEYS[1])}
)LUA";

std::string limitKey(const std::string& apiKey, long long window) {
  return "aifw:rl:" + apiKey + ":" + std::to_string(window);
}

// {allowed, ttl}: one INCR + EXPIRE on the server, so concurrent requests cannot all pass.
std::pair<bool, long long> checkLimit(sw::redis::Redis& redis, const std::string& apiKey) {
  const auto window = std::chrono::duration_cast<std::chrono::seconds>(
                          std::chrono::system_clock::now().time_since_epoch())
                          .count() /
                      kWindowSeconds;
  const auto result = redis.eval<std::vector<long long>>(kLimitLua, {limitKey(apiKey, window)}, {kWindowSeconds});
  return {result[0] <= kLimitRequests, result[1]};
}

int main() {
  sw::redis::Redis redis("tcp://redis:6379");
  httplib::Server svr;

  svr.Post("/v1/chat", [&redis](const httplib::Request& req, httplib::Response& res) {
    const auto apiKey = req.get_header_value("X-Api-Key");
    const auto [allowed, ttl] = checkLimit(redis, apiKey);
    if (!allowed) {
      res.status = 429;
      res.set_header("Retry-After", std::to_string(std::max(ttl, 1LL)));
      res.set_content(R"({"error":"rate limit exceeded"})", "application/json");
      return;
    }
    const json body = json::parse(req.body, nullptr, false);
    const auto prompt = promptAt(body, kPromptPath).value_or("");
    const Decision decision = decide(prompt, "");
    if (decision.action == "block") {
      res.status = 403;
      res.set_content(R"({"error":"blocked"})", "application/json");
      return;
    }
    forward(req.body, res);
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  debrief: `The interview question behind this step is atomicity under concurrency, applied to the one defence the source names against model denial of service. A read-then-increment limiter passes every serial test and fails exactly when a caller floods the model, which is when the limit matters: one Lua script makes increment, expiry and TTL a single server-side step. The window in the key and the expiry set at creation make the count reset instead of accumulating; \`Retry-After\` from the TTL turns a refusal into a schedule; and running the limit before the detector keeps the firewall's own cost bounded — a refused request that already paid for a detection call is a smaller version of the attack the limit prevents. Real firewalls add a second limit per IP address, as the source does, sliding windows, and a cost-weighted budget on tokens as well as requests.`,
};
