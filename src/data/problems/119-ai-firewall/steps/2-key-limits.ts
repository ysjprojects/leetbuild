import type {Step} from '@/lib/types';

export const keyLimitsStep: Step = {
  id: 'key-limits',
  title: 'Per-key rate limit: one atomic window before any cost',
  concept: 'redis',
  guides: ['atomic-state', 'keys-and-expiry'],
  file: 'rate_limit',
  focus: ['aifw', 'redis', 'guard'],
  task: `## Task

**Starting point.** The starter is the per-key limit installed on step 1's app around every
\`POST /v1/chat\`: \`check_limit(api_key)\` reads the caller's count from Redis and answers
\`(allowed, retry_after)\`, and the middleware answers **429** when it says no. A key with requests
left gets through, so the demo passes. It hides four flaws.

**Failure mode the checks target.** The limit is the answer to model denial of service: a cap on
what one API key may send in a window. A read followed by a separate increment lets concurrent
requests all see the same count and all pass; a key without a window and an expiry locks a busy
caller out for good; a bare 429 makes well-behaved clients retry at once; and a limit consulted
after the handler ran has already paid for the detector and the model on the request it refuses.

- **120 requests** per **60-second window** per API key, under \`aifw:rl:{api_key}:{window}\` with
  \`window = floor(unix_seconds / WINDOW_S)\`.
- One **Lua script** does \`INCR\`, sets \`EXPIRE\` when it created the key, and returns the count
  and the key's \`TTL\`: one server-side step.
- Over the limit: **429** with \`Retry-After\` (the TTL, in seconds) and nothing else called.
- The limit runs **before** the handler; a request without a key is the route's 401, not a window.`,
  sequence: {
    participants: ['Client', 'aifw', 'Redis', 'PromptGuard'],
    messages: [
      {from: 'Client', to: 'aifw', label: 'POST /v1/chat · X-Api-Key: key-7f3a', kind: 'sync'},
      {from: 'aifw', to: 'Redis', label: 'EVAL limit · KEYS[aifw:rl:key-7f3a:29876543]', kind: 'sync'},
      {from: 'Redis', to: 'aifw', label: '{count, ttl}', kind: 'reply'},
      {from: 'aifw', to: 'Client', label: '429 · Retry-After: ttl when count > 120', kind: 'reply'},
      {from: 'aifw', to: 'PromptGuard', label: 'decide(prompt, rid) only under the limit', kind: 'sync'},
    ],
  },
  hints: [
    'A flood of 400 requests in a second got 190 answered; the same key is still refused the next morning; refused clients hammer; the detector bill for the flood matched the flood, not the limit.',
    'A count read on the client is stale when the increment lands; a key without a window in its name is one key forever; a middleware after the handler refuses what it already served.',
    'One `EVAL`: `INCR`, `EXPIRE` when the count is 1, return `{count, TTL}`; key `aifw:rl:{api_key}:{floor(now / 60)}`; `Retry-After` from the TTL; the check before the handler, 429 without calling it.',
  ],
  checks: [
    {
      id: 'atomic',
      title: 'Counts with one atomic Lua script',
      detail:
        'The count is incremented and read in one `EVAL` that runs `INCR` on the server, so two replicas cannot both see the same count. The starter reads with `GET` and increments afterwards.',
      match: {
        python: {all: [/redis\.call\(\s*['"]INCR['"]/, /\.eval\(|register_script\(|\.evalsha\(/], none: [/\.incr\(/]},
        typescript: {all: [/redis\.call\(\s*['"]INCR['"]/, /\.eval\(|defineCommand\(|\.evalsha\(/], none: [/\.incr\(/]},
        go: {all: [/redis\.call\(\s*['"]INCR['"]/, /NewScript\(|\.Eval\(|\.EvalSha\(/], none: [/\.Incr\(/]},
        scala: {all: [/redis\.call\(\s*['"]INCR['"]/, /\.eval(sha)?\(/], none: [/\.incr\(/]},
        cpp: {all: [/redis\.call\(\s*['"]INCR['"]/, /\.eval(sha)?[<(]/], none: [/\.incr\(/]},
      },
    },
    {
      id: 'window-ttl',
      title: 'Keys by window and expires the key when it is created',
      detail:
        'The key is `aifw:rl:{api_key}:{window}` with the window from `WINDOW_S`, and the same script that creates the count sets its `EXPIRE` and returns its `TTL`, so the key never exists without an expiry. The starter keys by API key alone and sets no expiry, so the count only grows.',
      match: {
        python: {all: [/aifw:rl:\{[^}]+\}:\{[^}]+\}/, /WINDOW_S/, /EXPIRE/, /TTL/]},
        typescript: {all: [/aifw:rl:\$\{[^}]+\}:\$\{[^}]+\}/, /WINDOW_S/, /EXPIRE/, /TTL/]},
        go: {all: [/aifw:rl:%s:%d/, /windowSeconds/, /EXPIRE/, /TTL/]},
        scala: {all: [/aifw:rl:\$\{?\w+\}?:\$\{?\w+\}?/, /WindowSeconds/, /EXPIRE/, /TTL/]},
        cpp: {all: [/"aifw:rl:"/, /kWindowSeconds/, /EXPIRE/, /TTL/]},
      },
    },
    {
      id: 'retry-after',
      title: 'Answers 429 with Retry-After from the TTL',
      detail:
        'Over the limit the answer is `429 Too Many Requests` with a `Retry-After` header holding the TTL the script returned. The starter sends a bare 429.',
      match: {
        python: {all: [/Retry-After/, /status_code\s*=\s*429|HTTP_429/]},
        typescript: {all: [/Retry-After/, /code\(\s*429\s*\)|status(Code)?\s*[:=(]\s*429/]},
        go: {all: [/Retry-After/, /StatusTooManyRequests|\b429\b/]},
        scala: {all: [/Retry-After/, /StatusCodes\.TooManyRequests|\b429\b/]},
        cpp: {all: [/Retry-After/, /status\s*=\s*429/]},
      },
    },
    {
      id: 'limit-first',
      title: 'Refuses before the handler runs',
      detail:
        'The limit is consulted before the request reaches the handler, so a refused request costs no detector call and no model call; a request without a key goes straight to the route’s 401 and opens no window. The starter lets the handler run first and refuses afterwards.',
      match: {
        python: {order: [/=\s*check_limit\(/, /call_next\(/]},
        typescript: {
          all: [/addHook\(\s*['"](onRequest|preHandler)['"]/],
          none: [/addHook\(\s*['"](onSend|onResponse|preSerialization)['"]/],
        },
        go: {order: [/:=\s*checkLimit\(/, /next\.ServeHTTP\(/], none: [/httptest\./]},
        scala: {none: [/mapResponse|mapRouteResult/]},
        cpp: {all: [/set_pre_routing_handler\(/], none: [/set_post_routing_handler\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import redis
from fastapi import Request
from fastapi.responses import JSONResponse

from firewall_api import app

r = redis.Redis(host="redis", port=6379, decode_responses=True)

LIMIT_REQUESTS = 120


def check_limit(api_key: str) -> tuple[bool, int]:
    """(allowed, retry_after): the caller's count in the window against LIMIT_REQUESTS."""
    # TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
    key = f"aifw:rl:{api_key}"
    count = int(r.get(key) or 0)
    if count >= LIMIT_REQUESTS:
        return False, 60
    r.incr(key)
    return True, 60


@app.middleware("http")
async def rate_limit(request: Request, call_next):
    """The per-key limit on every request the proxy serves."""
    response = await call_next(request)
    api_key = request.headers.get("x-api-key", "")
    if not api_key:
        return response
    allowed, _ = check_limit(api_key)
    if not allowed:
        return JSONResponse({"error": "rate limit exceeded"}, status_code=429)
    return response
`,
      solution: `import time

import redis
from fastapi import Request
from fastapi.responses import JSONResponse

from firewall_api import app

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
    """(allowed, retry_after): one INCR + EXPIRE on the server, so concurrent requests cannot all pass."""
    window = int(time.time()) // WINDOW_S
    count, ttl = r.eval(LIMIT_LUA, 1, limit_key(api_key, window), WINDOW_S)
    return int(count) <= LIMIT_REQUESTS, max(int(ttl), 1)


@app.middleware("http")
async def rate_limit(request: Request, call_next):
    """The per-key limit on every request the proxy serves, before the handler runs."""
    api_key = request.headers.get("x-api-key", "")
    if api_key:  # a request without a key is the route's 401, not a window
        allowed, retry_after = check_limit(api_key)
        if not allowed:
            return JSONResponse(
                {"error": "rate limit exceeded"}, status_code=429, headers={"Retry-After": str(retry_after)}
            )
    return await call_next(request)
`,
    },
    typescript: {
      starter: `/** Per-key limit on every request the proxy serves. */
import {Redis} from 'ioredis';

import {app} from './firewall_api';

const r = new Redis('redis://redis:6379');

export const LIMIT_REQUESTS = 120;

/** [allowed, retryAfter]: the caller's count in the window against LIMIT_REQUESTS. */
export async function checkLimit(apiKey: string): Promise<[boolean, number]> {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  const key = \`aifw:rl:\${apiKey}\`;
  const count = Number((await r.get(key)) ?? 0);
  if (count >= LIMIT_REQUESTS) return [false, 60];
  await r.incr(key);
  return [true, 60];
}

app.addHook('onSend', async (request, reply, payload) => {
  const apiKey = request.headers['x-api-key'];
  if (typeof apiKey !== 'string' || apiKey === '') return payload;
  const [allowed] = await checkLimit(apiKey);
  if (!allowed) {
    void reply.code(429).type('application/json');
    return JSON.stringify({error: 'rate limit exceeded'});
  }
  return payload;
});
`,
      solution: `/** Per-key limit: one atomic INCR + EXPIRE per window, consulted before the handler runs. */
import {Redis} from 'ioredis';

import {app} from './firewall_api';

const r = new Redis('redis://redis:6379');

export const WINDOW_S = 60;
export const LIMIT_REQUESTS = 120;

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

/** [allowed, retryAfter]: one INCR + EXPIRE on the server, so concurrent requests cannot all pass. */
export async function checkLimit(apiKey: string): Promise<[boolean, number]> {
  const window = Math.floor(Date.now() / 1000 / WINDOW_S);
  const [count, ttl] = (await r.eval(LIMIT_LUA, 1, limitKey(apiKey, window), String(WINDOW_S))) as [number, number];
  return [count <= LIMIT_REQUESTS, Math.max(ttl, 1)];
}

app.addHook('onRequest', async (request, reply) => {
  const apiKey = request.headers['x-api-key'];
  if (typeof apiKey !== 'string' || apiKey === '') return; // the route answers 401
  const [allowed, retryAfter] = await checkLimit(apiKey);
  if (!allowed) {
    return reply.code(429).header('Retry-After', String(retryAfter)).send({error: 'rate limit exceeded'});
  }
});
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"

	"github.com/redis/go-redis/v9"
)

const limitRequests = 120

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// checkLimit returns (allowed, retryAfter): the caller's count in the window against limitRequests.
func checkLimit(ctx context.Context, apiKey string) (bool, int64) {
	// TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
	key := fmt.Sprintf("aifw:rl:%s", apiKey)
	count, _ := rdb.Get(ctx, key).Int64()
	if count >= limitRequests {
		return false, 60
	}
	rdb.Incr(ctx, key)
	return true, 60
}

// rateLimit is the per-key limit on every request the proxy serves.
func rateLimit(next http.Handler) http.Handler {
	return http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
		apiKey := r.Header.Get("X-Api-Key")
		if apiKey == "" {
			next.ServeHTTP(rw, r)
			return
		}
		served := httptest.NewRecorder()
		next.ServeHTTP(served, r)
		allowed, _ := checkLimit(r.Context(), apiKey)
		if !allowed {
			http.Error(rw, "rate limit exceeded", http.StatusTooManyRequests)
			return
		}
		for name, values := range served.Header() {
			rw.Header()[name] = values
		}
		rw.WriteHeader(served.Code)
		_, _ = rw.Write(served.Body.Bytes())
	})
}
`,
      solution: `package main

import (
	"context"
	"fmt"
	"net/http"
	"time"

	"github.com/redis/go-redis/v9"
)

const (
	windowSeconds = 60
	limitRequests = 120
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

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

// checkLimit returns (allowed, retryAfter): one INCR + EXPIRE on the server, so concurrent requests cannot all pass.
func checkLimit(ctx context.Context, apiKey string) (bool, int64) {
	window := time.Now().Unix() / windowSeconds
	values, err := limitScript.Run(ctx, rdb, []string{limitKey(apiKey, window)}, windowSeconds).Int64Slice()
	if err != nil {
		return true, windowSeconds // Redis down: the detector still stands between the caller and the model
	}
	ttl := values[1]
	if ttl < 1 {
		ttl = 1
	}
	return values[0] <= limitRequests, ttl
}

// rateLimit is the per-key limit on every request the proxy serves, consulted before the handler runs.
func rateLimit(next http.Handler) http.Handler {
	return http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
		if apiKey := r.Header.Get("X-Api-Key"); apiKey != "" { // a request without a key is the route's 401
			allowed, retryAfter := checkLimit(r.Context(), apiKey)
			if !allowed {
				rw.Header().Set("Retry-After", fmt.Sprintf("%d", retryAfter))
				http.Error(rw, "rate limit exceeded", http.StatusTooManyRequests)
				return
			}
		}
		next.ServeHTTP(rw, r)
	})
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directive0
import org.apache.pekko.http.scaladsl.server.Directives._
import redis.clients.jedis.JedisPooled

object RateLimit {
  val LimitRequests = 120L
  val jedis = new JedisPooled("redis", 6379)

  /** (allowed, retryAfter): the caller's count in the window against LimitRequests. */
  def checkLimit(apiKey: String): (Boolean, Long) = {
    // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
    val key = s"aifw:rl:$apiKey"
    val count = Option(jedis.get(key)).map(_.toLong).getOrElse(0L)
    if (count >= LimitRequests) {
      (false, 60L)
    } else {
      jedis.incr(key)
      (true, 60L)
    }
  }

  /** The per-key limit on every request the proxy serves. */
  val rateLimited: Directive0 =
    optionalHeaderValueByName("X-Api-Key").flatMap[Unit] {
      case None => pass
      case Some(apiKey) =>
        mapResponse { response =>
          val (allowed, _) = checkLimit(apiKey)
          if (allowed) response
          else HttpResponse(StatusCodes.TooManyRequests, entity = HttpEntity(ContentTypes.\`application/json\`, """{"error":"rate limit exceeded"}"""))
        }
    }
}
`,
      solution: `import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.model.headers.RawHeader
import org.apache.pekko.http.scaladsl.server.Directive0
import org.apache.pekko.http.scaladsl.server.Directives._
import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

object RateLimit {
  val WindowSeconds = 60L
  val LimitRequests = 120L
  val jedis = new JedisPooled("redis", 6379)

  val LimitLua: String =
    """local count = redis.call('INCR', KEYS[1])
      |if count == 1 then
      |  redis.call('EXPIRE', KEYS[1], ARGV[1])
      |end
      |return {count, redis.call('TTL', KEYS[1])}
      |""".stripMargin

  def limitKey(apiKey: String, window: Long): String = s"aifw:rl:$apiKey:$window"

  /** (allowed, retryAfter): one INCR + EXPIRE on the server, so concurrent requests cannot all pass. */
  def checkLimit(apiKey: String): (Boolean, Long) = {
    val window = System.currentTimeMillis() / 1000 / WindowSeconds
    val reply = jedis
      .eval(LimitLua, List(limitKey(apiKey, window)).asJava, List(WindowSeconds.toString).asJava)
      .asInstanceOf[java.util.List[java.lang.Long]]
      .asScala
    (reply(0).longValue <= LimitRequests, math.max(reply(1).longValue, 1L))
  }

  /** The per-key limit on every request the proxy serves, consulted before the route runs. */
  val rateLimited: Directive0 =
    optionalHeaderValueByName("X-Api-Key").flatMap[Unit] {
      case None => pass // the route answers 401
      case Some(apiKey) =>
        checkLimit(apiKey) match {
          case (true, _) => pass
          case (false, retryAfter) =>
            complete(
              HttpResponse(
                StatusCodes.TooManyRequests,
                headers = List(RawHeader("Retry-After", retryAfter.toString)),
                entity = HttpEntity(ContentTypes.\`application/json\`, """{"error":"rate limit exceeded"}""")
              )
            )
        }
    }
}
`,
    },
    cpp: {
      starter: `// Per-key rate limit on every request the proxy serves.
#pragma once

#include <httplib.h>
#include <sw/redis++/redis++.h>

#include <string>
#include <utility>

constexpr long long kLimitRequests = 120;

inline sw::redis::Redis& limit_redis() {
  static sw::redis::Redis redis("tcp://redis:6379");
  return redis;
}

// {allowed, retry_after}: the caller's count in the window against kLimitRequests.
inline std::pair<bool, long long> checkLimit(const std::string& apiKey) {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  const std::string key = "aifw:rl:" + apiKey;
  const auto raw = limit_redis().get(key);
  const long long count = raw ? std::stoll(*raw) : 0;
  if (count >= kLimitRequests) return {false, 60};
  limit_redis().incr(key);
  return {true, 60};
}

// Installs the per-key limit on the proxy's server.
inline void install_rate_limit(httplib::Server& svr) {
  svr.set_post_routing_handler([](const httplib::Request& req, httplib::Response& res) {
    const std::string apiKey = req.get_header_value("X-Api-Key");
    if (apiKey.empty()) return;
    const auto [allowed, retry_after] = checkLimit(apiKey);
    if (!allowed) {
      res.status = 429;
      res.set_content(R"({"error":"rate limit exceeded"})", "application/json");
    }
  });
}
`,
      solution: `// Per-key rate limit: one atomic INCR + EXPIRE per window, consulted before the route runs.
#pragma once

#include <httplib.h>
#include <sw/redis++/redis++.h>

#include <algorithm>
#include <chrono>
#include <iterator>
#include <string>
#include <utility>
#include <vector>

constexpr long long kWindowSeconds = 60;
constexpr long long kLimitRequests = 120;

const char* const kLimitLua = R"LUA(
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
return {count, redis.call('TTL', KEYS[1])}
)LUA";

inline sw::redis::Redis& limit_redis() {
  static sw::redis::Redis redis("tcp://redis:6379");
  return redis;
}

inline std::string limitKey(const std::string& apiKey, long long window) {
  return "aifw:rl:" + apiKey + ":" + std::to_string(window);
}

// {allowed, retry_after}: one INCR + EXPIRE on the server, so concurrent requests cannot all pass.
inline std::pair<bool, long long> checkLimit(const std::string& apiKey) {
  const long long now =
      std::chrono::duration_cast<std::chrono::seconds>(std::chrono::system_clock::now().time_since_epoch()).count();
  std::vector<long long> reply;
  limit_redis().eval(kLimitLua, {limitKey(apiKey, now / kWindowSeconds)}, {std::to_string(kWindowSeconds)},
                     std::back_inserter(reply));
  return {reply[0] <= kLimitRequests, std::max(reply[1], 1LL)};
}

// Installs the per-key limit on the proxy's server, ahead of every route.
inline void install_rate_limit(httplib::Server& svr) {
  svr.set_pre_routing_handler([](const httplib::Request& req, httplib::Response& res) {
    const std::string apiKey = req.get_header_value("X-Api-Key");
    if (apiKey.empty()) return httplib::Server::HandlerResponse::Unhandled;  // the route answers 401
    const auto [allowed, retry_after] = checkLimit(apiKey);
    if (!allowed) {
      res.status = 429;
      res.set_header("Retry-After", std::to_string(retry_after));
      res.set_content(R"({"error":"rate limit exceeded"})", "application/json");
      return httplib::Server::HandlerResponse::Handled;
    }
    return httplib::Server::HandlerResponse::Unhandled;
  });
}
`,
    },
  },
  harness: {
    python: `import sys

import firewall_pb2
import firewall_pb2_grpc

K = {"X-Api-Key": "key-7f3a"}
BODY = {"model": "assistant-v2", "input": {"prompt": "What is the capital of France?"}}
LIMIT = 120


def _window_key(ctx):
    """The key of the current window: aifw:rl:key-7f3a:{floor(now / 60)} on the virtual clock."""
    return f"aifw:rl:key-7f3a:{int(ctx.clock.time()) // 60}"


class Guard(firewall_pb2_grpc.PromptGuardServicer):
    def Detect(self, request, context):
        return firewall_pb2.DetectReply(score=99)


class Assistant(firewall_pb2_grpc.AssistantServicer):
    def Chat(self, request, context):
        return firewall_pb2.ChatReply(text="Paris is the capital of France.")


def _aifw(ctx):
    """Step 1's app with the limit installed on it: the app rate_limit imported, not a fresh one."""
    # Start 15 s into a minute: the window cannot roll over mid-check, and a window's TTL (60 s from
    # its first request) outlasts the minute it counts, so Retry-After is the TTL, not the minute's rest.
    ctx.clock.advance(75 - ctx.clock.time() % 60)
    ctx.grpc.serve(firewall_pb2_grpc.add_PromptGuardServicer_to_server, Guard())
    ctx.grpc.serve(firewall_pb2_grpc.add_AssistantServicer_to_server, Assistant())
    ctx.load("rate_limit")
    return sys.modules["firewall_api"].app


def _retry_after(ctx, r, what):
    """Retry-After as an int, checked against the window key's TTL at the time of the answer."""
    value = r.headers.get("retry-after")
    assert value is not None, f"{what}: the 429 carries no Retry-After header; send the TTL the script returned"
    ttl = ctx.redis.ttl(_window_key(ctx))
    assert value.isdigit() and abs(int(value) - ttl) <= 1, f"{what}: Retry-After is {value!r} while the window's TTL is {ttl}: Retry-After is the TTL the script returned, in seconds"
    return int(value)


async def _burst(c, n, headers=K):
    return [(await c.post("/v1/chat", json=BODY, headers=headers)).status_code for _ in range(n)]


def _window_keys(ctx):
    return sorted(ctx.redis.keys("aifw:rl:*"))


def _detects(ctx):
    return len(ctx.grpc.calls_to("Detect"))


async def check_atomic(ctx):
    app = _aifw(ctx)
    # Another replica's requests land right after the first command that touches the window, so the
    # window is full by the time this request is counted.
    def fill():
        for key in ctx.redis.keys("aifw:rl:*"):
            ctx.redis.set(key, LIMIT, keepttl=True)

    window_key = _window_key(ctx)
    probes = [ctx.redis_after(window_key, fill), ctx.redis_after("aifw:rl:key-7f3a", fill)]
    async with ctx.client(app) as c:
        first = await c.post("/v1/chat", json=BODY, headers=K)
        assert first.status_code == 200, f"the first request on a fresh key answered {first.status_code}: {first.text}"
        assert any(p.fired for p in probes), f"the request touched none of {window_key} / aifw:rl:key-7f3a in Redis (keys: {_window_keys(ctx)})"
        keys = _window_keys(ctx)
        count = int(ctx.redis.get(keys[0]))
        assert count <= LIMIT, f"the window holds {count} after a request that was admitted: another replica filled it between your read and your increment, and your check used the stale count. Increment and check must be one server-side step (EVAL with INCR), not GET then INCR"
        second = await c.post("/v1/chat", json=BODY, headers=K)
        assert second.status_code == 429, f"with the window filled by another replica the next request answered {second.status_code}, expected 429"


async def check_window_ttl(ctx):
    app = _aifw(ctx)
    window_key = _window_key(ctx)
    # The key's TTL the moment the first command that touched it has run: one script has already set it.
    born = ctx.redis_after(window_key, lambda: ctx.redis.ttl(window_key))
    async with ctx.client(app) as c:
        statuses = await _burst(c, LIMIT + 1)
        assert statuses == [200] * LIMIT + [429], f"a fresh key gets {LIMIT} requests, then 429: got {statuses.count(200)} x 200 and {statuses.count(429)} x 429 (last: {statuses[-1]})"
        keys = _window_keys(ctx)
        assert keys == [window_key], f"the window keys are {keys}, expected [{window_key!r}]: aifw:rl:{{api_key}}:{{window}} with window = floor(now / 60)"
        ttl = ctx.redis.ttl(window_key)
        assert 0 < ttl <= 60, f"{window_key} has TTL {ttl}: the script must EXPIRE the key it created (60 s), or the count lives forever"
        assert born.fired and born.result is not None and 0 < born.result <= 60, f"right after the first command that touched {window_key} its TTL was {born.result}: EXPIRE ran in a command of its own, so a replica that dies in between leaves a count that never expires. The script sets EXPIRE when it creates the key"
        ctx.clock.advance(61)
        r = await c.post("/v1/chat", json=BODY, headers=K)
        assert r.status_code == 200, f"61 s later, in a new window, the caller answered {r.status_code}, expected 200: the window must reset"
        keys = _window_keys(ctx)
        assert keys == [_window_key(ctx)], f"the window keys 61 s later are {keys}, expected only {_window_key(ctx)} (the old window expired)"


async def check_retry_after(ctx):
    app = _aifw(ctx)
    async with ctx.client(app) as c:
        await _burst(c, LIMIT)
        r = await c.post("/v1/chat", json=BODY, headers=K)
        assert r.status_code == 429, f"request {LIMIT + 1} answered {r.status_code}, expected 429"
        first = _retry_after(ctx, r, "on the first refusal")
        assert first <= 60, f"Retry-After is {first} right after the window was created, expected at most 60"
        ctx.clock.advance(20)
        r = await c.post("/v1/chat", json=BODY, headers=K)
        assert r.status_code == 429, f"20 s into the window request {LIMIT + 2} answered {r.status_code}, expected 429"
        later = _retry_after(ctx, r, "20 s into the window")
        assert later <= first - 19, f"Retry-After went from {first} to {later} over 20 s: it must follow the TTL down, not restate a constant"
        other = await c.post("/v1/chat", json=BODY, headers={"X-Api-Key": "key-b2c9"})
        assert other.status_code == 200, f"another key answered {other.status_code}: windows are per key"


async def check_limit_first(ctx):
    app = _aifw(ctx)
    async with ctx.client(app) as c:
        statuses = await _burst(c, LIMIT + 1)
        assert statuses[-1] == 429, f"request {LIMIT + 1} answered {statuses[-1]}, expected 429"
        detects = _detects(ctx)
        chats = len(ctx.grpc.calls_to("Chat"))
        assert detects == LIMIT, f"{LIMIT + 1} requests made {detects} Detect calls: the refused request was scored before the limit answered. The limit runs before the handler; a refused request costs nothing"
        assert chats == LIMIT, f"{LIMIT + 1} requests made {chats} Chat calls: the refused request reached the application"
        before = _window_keys(ctx)
        r = await c.post("/v1/chat", json=BODY)
        assert r.status_code == 401, f"a request without a key answered {r.status_code}, expected the route's 401"
        assert _window_keys(ctx) == before, f"a request without a key left the window keys {_window_keys(ctx)} (before: {before}): it is the route's 401, not a window of its own"
`,
    typescript: `const K = {'X-Api-Key': 'key-7f3a'};
const BODY = {model: 'assistant-v2', input: {prompt: 'What is the capital of France?'}};
const LIMIT = 120;
/** The key of the current window: aifw:rl:key-7f3a:{floor(now / 60)} on the virtual clock. */
const windowKey = ctx => \`aifw:rl:key-7f3a:\${Math.floor(ctx.clock.now() / 60000)}\`;

/** Step 1's app with the limit installed on it (the instance rate_limit imported). */
function aifw(ctx) {
  // Start 15 s into a minute: the window cannot roll over mid-check, and a window's TTL (60 s from
  // its first request) outlasts the minute it counts, so Retry-After is the TTL, not the minute's rest.
  ctx.clock.advance(75 - (ctx.clock.now() / 1000) % 60);
  const pkg = ctx.proto('firewall.proto');
  ctx.grpc.serve(pkg.firewall.PromptGuard.service, {
    Detect(_call, callback) {
      callback(null, {score: 99, tags: []});
    },
  });
  ctx.grpc.serve(pkg.firewall.Assistant.service, {
    Chat(_call, callback) {
      callback(null, {text: 'Paris is the capital of France.'});
    },
  });
  ctx.load('rate_limit');
  const {app} = ctx.load('firewall_api');
  return ctx.client(app);
}

/** Retry-After as a number, checked against the window key's TTL at the time of the answer. */
function retryAfter(ctx, r, what: string): number {
  const value = r.headers['retry-after'];
  assert(value !== undefined, \`\${what}: the 429 carries no Retry-After header; send the TTL the script returned\`);
  const ttl = Number(ctx.redis.ttl(windowKey(ctx)));
  assert(/^\\d+$/.test(String(value)) && Math.abs(Number(value) - ttl) <= 1, \`\${what}: Retry-After is \${JSON.stringify(value)} while the window's TTL is \${ttl}: Retry-After is the TTL the script returned, in seconds\`);
  return Number(value);
}
async function burst(c, n: number, headers: Record<string, string> = K): Promise<number[]> {
  const statuses: number[] = [];
  for (let i = 0; i < n; i += 1) statuses.push((await c.post('/v1/chat', {json: BODY, headers})).status);
  return statuses;
}

const windowKeys = ctx => (ctx.redis.keys('aifw:rl:*') as string[]).sort();

export async function check_atomic(ctx) {
  const c = aifw(ctx);
  // Another replica's requests land right after the first command that touches the window, so the
  // window is full by the time this request is counted.
  const fill = () => {
    for (const key of ctx.redis.keys('aifw:rl:*') as string[]) ctx.redis.set(key, LIMIT, 'KEEPTTL');
  };
  const probes = [ctx.redisAfter(windowKey(ctx), fill), ctx.redisAfter('aifw:rl:key-7f3a', fill)];
  const first = await c.post('/v1/chat', {json: BODY, headers: K});
  assert.equal(first.status, 200, \`the first request on a fresh key answered \${first.status}: \${first.text}\`);
  assert(probes.some(p => p.fired), \`the request touched none of \${windowKey(ctx)} / aifw:rl:key-7f3a in Redis (keys: \${JSON.stringify(windowKeys(ctx))})\`);
  const keys = windowKeys(ctx);
  const count = Number(ctx.redis.get(keys[0]));
  assert(count <= LIMIT, \`the window holds \${count} after a request that was admitted: another replica filled it between your read and your increment, and your check used the stale count. Increment and check must be one server-side step (EVAL with INCR), not GET then INCR\`);
  const second = await c.post('/v1/chat', {json: BODY, headers: K});
  assert.equal(second.status, 429, \`with the window filled by another replica the next request answered \${second.status}, expected 429\`);
}

export async function check_window_ttl(ctx) {
  const c = aifw(ctx);
  const key = windowKey(ctx);
  // The key's TTL the moment the first command that touched it has run: one script has already set it.
  const born = ctx.redisAfter(key, () => Number(ctx.redis.ttl(key)));
  const statuses = await burst(c, LIMIT + 1);
  assert.deepEqual(statuses, [...Array(LIMIT).fill(200), 429], \`a fresh key gets \${LIMIT} requests, then 429: got \${statuses.filter(s => s === 200).length} x 200 and \${statuses.filter(s => s === 429).length} x 429 (last: \${statuses.at(-1)})\`);
  let keys = windowKeys(ctx);
  assert.deepEqual(keys, [key], \`the window keys are \${JSON.stringify(keys)}, expected ["\${key}"]: aifw:rl:\\\${apiKey}:\\\${window} with window = floor(now / 60)\`);
  const ttl = Number(ctx.redis.ttl(key));
  assert(ttl > 0 && ttl <= 60, \`\${key} has TTL \${ttl}: the script must EXPIRE the key it created (60 s), or the count lives forever\`);
  assert(born.fired && born.result > 0 && born.result <= 60, \`right after the first command that touched \${key} its TTL was \${born.result}: EXPIRE ran in a command of its own, so a replica that dies in between leaves a count that never expires. The script sets EXPIRE when it creates the key\`);
  ctx.clock.advance(61);
  const r = await c.post('/v1/chat', {json: BODY, headers: K});
  assert.equal(r.status, 200, \`61 s later, in a new window, the caller answered \${r.status}, expected 200: the window must reset\`);
  keys = windowKeys(ctx);
  assert.deepEqual(keys, [windowKey(ctx)], \`the window keys 61 s later are \${JSON.stringify(keys)}, expected only \${windowKey(ctx)} (the old window expired)\`);
}

export async function check_retry_after(ctx) {
  const c = aifw(ctx);
  await burst(c, LIMIT);
  let r = await c.post('/v1/chat', {json: BODY, headers: K});
  assert.equal(r.status, 429, \`request \${LIMIT + 1} answered \${r.status}, expected 429\`);
  const first = retryAfter(ctx, r, 'on the first refusal');
  assert(first <= 60, \`Retry-After is \${first} right after the window was created, expected at most 60\`);
  ctx.clock.advance(20);
  r = await c.post('/v1/chat', {json: BODY, headers: K});
  assert.equal(r.status, 429, \`20 s into the window request \${LIMIT + 2} answered \${r.status}, expected 429\`);
  const later = retryAfter(ctx, r, '20 s into the window');
  assert(later <= first - 19, \`Retry-After went from \${first} to \${later} over 20 s: it must follow the TTL down, not restate a constant\`);
  const other = await c.post('/v1/chat', {json: BODY, headers: {'X-Api-Key': 'key-b2c9'}});
  assert.equal(other.status, 200, \`another key answered \${other.status}: windows are per key\`);
}

export async function check_limit_first(ctx) {
  const c = aifw(ctx);
  const statuses = await burst(c, LIMIT + 1);
  assert.equal(statuses.at(-1), 429, \`request \${LIMIT + 1} answered \${statuses.at(-1)}, expected 429\`);
  const detects = ctx.grpc.callsTo('Detect').length;
  const chats = ctx.grpc.callsTo('Chat').length;
  assert.equal(detects, LIMIT, \`\${LIMIT + 1} requests made \${detects} Detect calls: the refused request was scored before the limit answered. The limit runs before the handler (an onRequest hook); a refused request costs nothing\`);
  assert.equal(chats, LIMIT, \`\${LIMIT + 1} requests made \${chats} Chat calls: the refused request reached the application\`);
  const before = windowKeys(ctx);
  const r = await c.post('/v1/chat', {json: BODY});
  assert.equal(r.status, 401, \`a request without a key answered \${r.status}, expected the route's 401\`);
  assert.deepEqual(windowKeys(ctx), before, \`a request without a key left the window keys \${JSON.stringify(windowKeys(ctx))} (before: \${JSON.stringify(before)}): it is the route's 401, not a window of its own\`);
}
`,
    go: `package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	"leetbuild/harness"

	pb "aifw/gen/firewall"
)

const (
	limitKeyName    = "key-7f3a"
	limitBody       = \`{"model":"assistant-v2","input":{"prompt":"What is the capital of France?"}}\`
	limitCheckCount = 120
)

// limitWindowKey is the key of the current window: aifw:rl:key-7f3a:{floor(now / 60)} on the virtual clock.
func limitWindowKey(ctx *harness.Ctx) string {
	return fmt.Sprintf("aifw:rl:key-7f3a:%d", ctx.Clock.Now()/60000)
}

type limitGuard struct{ pb.UnimplementedPromptGuardServer }

func (limitGuard) Detect(_ context.Context, _ *pb.DetectRequest) (*pb.DetectReply, error) {
	return &pb.DetectReply{Score: 99}, nil
}

type limitAssistant struct{ pb.UnimplementedAssistantServer }

func (limitAssistant) Chat(_ context.Context, _ *pb.ChatRequest) (*pb.ChatReply, error) {
	return &pb.ChatReply{Text: "Paris is the capital of France."}, nil
}

// limitedProxy is rateLimit wrapped around step 1's handler. The Go runtime compiles one step's
// file at a time, so the handler is stood in here: a key check, the detector, the application.
func limitedProxy(ctx *harness.Ctx) *harness.HTTP {
	// Start 15 s into a minute: the window cannot roll over mid-check, and a window's TTL (60 s from
	// its first request) outlasts the minute it counts, so Retry-After is the TTL, not the minute's rest.
	ctx.Clock.Advance(75 - float64(ctx.Clock.Now()%60000)/1000)
	pb.RegisterPromptGuardServer(ctx.GRPC.Server(""), &limitGuard{})
	pb.RegisterAssistantServer(ctx.GRPC.Server(""), &limitAssistant{})
	guardConn, _ := grpc.NewClient("promptguard:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
	guard := pb.NewPromptGuardClient(guardConn)
	appConn, _ := grpc.NewClient("llm-app:9001", grpc.WithTransportCredentials(insecure.NewCredentials()))
	app := pb.NewAssistantClient(appConn)
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/chat", func(rw http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Api-Key") == "" {
			http.Error(rw, "missing X-Api-Key", http.StatusUnauthorized)
			return
		}
		var body struct {
			Input struct {
				Prompt string \`json:"prompt"\`
			} \`json:"input"\`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		if _, err := guard.Detect(r.Context(), &pb.DetectRequest{Prompt: body.Input.Prompt, RequestId: "r"}); err != nil {
			http.Error(rw, err.Error(), http.StatusBadGateway)
			return
		}
		reply, err := app.Chat(r.Context(), &pb.ChatRequest{Prompt: body.Input.Prompt, RequestId: "r"})
		if err != nil {
			http.Error(rw, err.Error(), http.StatusBadGateway)
			return
		}
		rw.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(rw).Encode(map[string]string{"output": reply.GetText()})
	})
	return ctx.HTTP(rateLimit(mux))
}

func limitPost(c *harness.HTTP, header ...string) *harness.Response {
	return c.Post("/v1/chat", limitBody, append([]string{"Content-Type", "application/json"}, header...)...)
}

func limitBurst(c *harness.HTTP, n int) []int {
	statuses := make([]int, 0, n)
	for range n {
		statuses = append(statuses, limitPost(c, "X-Api-Key", limitKeyName).Status)
	}
	return statuses
}

func limitStatuses(n, status int, tail ...int) []int {
	out := make([]int, 0, n+len(tail))
	for range n {
		out = append(out, status)
	}
	return append(out, tail...)
}

// limitRetryAfter is Retry-After as a number, checked against the window key's TTL at the time of the answer.
func limitRetryAfter(ctx *harness.Ctx, r *harness.Response, what string) int64 {
	value := r.Header.Get("Retry-After")
	ctx.Assert(value != "", "%s: the 429 carries no Retry-After header; send the TTL the script returned", what)
	ttl := ctx.Redis.TTL(limitWindowKey(ctx))
	n, err := strconv.ParseInt(value, 10, 64)
	ctx.Assert(err == nil && n-ttl <= 1 && ttl-n <= 1, "%s: Retry-After is %q while the window's TTL is %d: Retry-After is the TTL the script returned, in seconds", what, value, ttl)
	return n
}

func CheckAtomic(ctx *harness.Ctx) {
	c := limitedProxy(ctx)
	// Another replica's requests land right after the first command that touches the window, so the
	// window is full by the time this request is counted.
	fill := func() any {
		for _, key := range ctx.Redis.Keys("aifw:rl:*") {
			ctx.Redis.Do("SET", key, limitCheckCount, "KEEPTTL")
		}
		return nil
	}
	windowKey := limitWindowKey(ctx)
	a, b := ctx.Redis.After(windowKey, fill), ctx.Redis.After("aifw:rl:key-7f3a", fill)
	first := limitPost(c, "X-Api-Key", limitKeyName)
	ctx.Equal(first.Status, 200, "the first request on a fresh key (%s)", first.Text())
	ctx.Assert(a.Fired || b.Fired, "the request touched none of %s / aifw:rl:key-7f3a in Redis (keys: %v)", windowKey, ctx.Redis.Keys("aifw:rl:*"))
	keys := ctx.Redis.Keys("aifw:rl:*")
	raw, _ := ctx.Redis.Get(keys[0])
	count, _ := strconv.Atoi(raw)
	ctx.Assert(count <= limitCheckCount, "the window holds %d after a request that was admitted: another replica filled it between your read and your increment, and your check used the stale count. Increment and check must be one server-side step (EVAL with INCR), not GET then INCR", count)
	second := limitPost(c, "X-Api-Key", limitKeyName)
	ctx.Equal(second.Status, 429, "with the window filled by another replica the next request")
}

func CheckWindowTtl(ctx *harness.Ctx) {
	c := limitedProxy(ctx)
	windowKey := limitWindowKey(ctx)
	// The key's TTL the moment the first command that touched it has run: one script has already set it.
	bornTTL := int64(0)
	born := ctx.Redis.After(windowKey, func() any {
		bornTTL = ctx.Redis.TTL(windowKey)
		return nil
	})
	ctx.Equal(limitBurst(c, limitCheckCount+1), limitStatuses(limitCheckCount, 200, 429), "a fresh key gets %d requests, then 429", limitCheckCount)
	ctx.Equal(ctx.Redis.Keys("aifw:rl:*"), []string{windowKey}, "the window keys (aifw:rl:%%s:%%d with window = floor(now / 60))")
	ttl := ctx.Redis.TTL(windowKey)
	ctx.Assert(ttl > 0 && ttl <= 60, "%s has TTL %d: the script must EXPIRE the key it created (60 s), or the count lives forever", windowKey, ttl)
	ctx.Assert(born.Fired && bornTTL > 0 && bornTTL <= 60, "right after the first command that touched %s its TTL was %d: EXPIRE ran in a command of its own, so a replica that dies in between leaves a count that never expires. The script sets EXPIRE when it creates the key", windowKey, bornTTL)
	ctx.Clock.Advance(61)
	r := limitPost(c, "X-Api-Key", limitKeyName)
	ctx.Equal(r.Status, 200, "61 s later, in a new window, the caller (the window must reset)")
	ctx.Equal(ctx.Redis.Keys("aifw:rl:*"), []string{limitWindowKey(ctx)}, "the window keys 61 s later (the old window expired)")
}

func CheckRetryAfter(ctx *harness.Ctx) {
	c := limitedProxy(ctx)
	limitBurst(c, limitCheckCount)
	r := limitPost(c, "X-Api-Key", limitKeyName)
	ctx.Equal(r.Status, 429, "request %d", limitCheckCount+1)
	first := limitRetryAfter(ctx, r, "on the first refusal")
	ctx.Assert(first <= 60, "Retry-After is %d right after the window was created, expected at most 60", first)
	ctx.Clock.Advance(20)
	r = limitPost(c, "X-Api-Key", limitKeyName)
	ctx.Equal(r.Status, 429, "20 s into the window request %d", limitCheckCount+2)
	later := limitRetryAfter(ctx, r, "20 s into the window")
	ctx.Assert(later <= first-19, "Retry-After went from %d to %d over 20 s: it must follow the TTL down, not restate a constant", first, later)
	other := limitPost(c, "X-Api-Key", "key-b2c9")
	ctx.Equal(other.Status, 200, "another key (windows are per key)")
}

func CheckLimitFirst(ctx *harness.Ctx) {
	c := limitedProxy(ctx)
	statuses := limitBurst(c, limitCheckCount+1)
	ctx.Equal(statuses[len(statuses)-1], 429, "request %d", limitCheckCount+1)
	detects := len(ctx.GRPC.CallsTo("Detect", ""))
	chats := len(ctx.GRPC.CallsTo("Chat", ""))
	ctx.Equal(detects, limitCheckCount, "%d requests' Detect calls: the refused request was scored before the limit answered. The limit runs before next.ServeHTTP; a refused request costs nothing", limitCheckCount+1)
	ctx.Equal(chats, limitCheckCount, "%d requests' Chat calls: the refused request reached the application", limitCheckCount+1)
	before := ctx.Redis.Keys("aifw:rl:*")
	r := limitPost(c)
	ctx.Equal(r.Status, 401, "a request without a key (the route's 401)")
	ctx.Equal(ctx.Redis.Keys("aifw:rl:*"), before, "the window keys after a request without a key (it is the route's 401, not a window of its own)")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <cstdlib>
#include <string>
#include <vector>

#include "firewall_api.cpp"

namespace {

const std::string kLimitKeyName = "key-7f3a";

// The key of the current window: aifw:rl:key-7f3a:{floor(now / 60)} on the virtual clock.
std::string limitWindowKey(harness::Ctx& ctx) { return "aifw:rl:key-7f3a:" + std::to_string(ctx.Clock.Now() / 60000); }
const std::string kLimitBody = R"({"model":"assistant-v2","input":{"prompt":"What is the capital of France?"}})";
constexpr int kLimitCount = 120;

class LimitGuard final : public firewall::PromptGuard::Service {
 public:
  grpc::Status Detect(grpc::ServerContext*, const firewall::DetectRequest*, firewall::DetectReply* reply) override {
    reply->set_score(99);
    return grpc::Status::OK;
  }
};

class LimitAssistant final : public firewall::Assistant::Service {
 public:
  grpc::Status Chat(grpc::ServerContext*, const firewall::ChatRequest*, firewall::ChatReply* reply) override {
    reply->set_text("Paris is the capital of France.");
    return grpc::Status::OK;
  }
};

// Step 1's handler with the limit installed ahead of it.
struct LimitedProxy {
  LimitGuard guard;
  LimitAssistant assistant;
  httplib::Server svr;
};

LimitedProxy* proxy = nullptr;

harness::HTTP limitedProxy(harness::Ctx& ctx) {
  // Start 15 s into a minute: the window cannot roll over mid-check, and a window's TTL (60 s from
  // its first request) outlasts the minute it counts, so Retry-After is the TTL, not the minute's rest.
  ctx.Clock.Advance(75 - static_cast<double>(ctx.Clock.Now() % 60000) / 1000);
  delete proxy;
  proxy = new LimitedProxy;
  ctx.GRPC.Server("")->RegisterService(&proxy->guard);
  ctx.GRPC.Server("")->RegisterService(&proxy->assistant);
  install_rate_limit(proxy->svr);
  register_chat(proxy->svr);
  return ctx.HTTP(proxy->svr);
}

template <class... H>
harness::Response limitPost(harness::HTTP& c, const H&... header) {
  return c.Post("/v1/chat", kLimitBody, "Content-Type", "application/json", header...);
}

std::vector<int> limitBurst(harness::HTTP& c, int n) {
  std::vector<int> statuses;
  for (int i = 0; i < n; i++) statuses.push_back(limitPost(c, "X-Api-Key", kLimitKeyName).Status);
  return statuses;
}

std::vector<int> limitStatuses(int n, int status, std::vector<int> tail = {}) {
  std::vector<int> out(static_cast<size_t>(n), status);
  out.insert(out.end(), tail.begin(), tail.end());
  return out;
}

// Retry-After as a number, checked against the window key's TTL at the time of the answer.
long long limitRetryAfter(harness::Ctx& ctx, const harness::Response& r, const std::string& what) {
  const std::string value = r.HeaderValue("Retry-After");
  ctx.Assert(!value.empty(), "%s: the 429 carries no Retry-After header; send the TTL the script returned", what);
  const long long ttl = ctx.Redis.TTL(limitWindowKey(ctx));
  char* end = nullptr;
  const long long n = std::strtoll(value.c_str(), &end, 10);
  ctx.Assert(end != value.c_str() && *end == 0 && n - ttl <= 1 && ttl - n <= 1,
             "%s: Retry-After is %q while the window's TTL is %d: Retry-After is the TTL the script returned, in seconds",
             what, value, ttl);
  return n;
}

}  // namespace

void CheckAtomic(harness::Ctx& ctx) {
  auto c = limitedProxy(ctx);
  // Another replica's requests land right after the first command that touches the window, so the
  // window is full by the time this request is counted.
  bool fired = false;
  const auto fill = [&ctx, &fired] {
    fired = true;
    for (const auto& key : ctx.Redis.Keys("aifw:rl:*")) ctx.Redis.Do("SET", key, kLimitCount, "KEEPTTL");
  };
  const std::string windowKey = limitWindowKey(ctx);
  ctx.Redis.After(windowKey, fill);
  ctx.Redis.After("aifw:rl:key-7f3a", fill);
  const auto first = limitPost(c, "X-Api-Key", kLimitKeyName);
  ctx.Equal(first.Status, 200, "the first request on a fresh key (%s)", first.Text());
  ctx.Assert(fired, "the request touched none of %s / aifw:rl:key-7f3a in Redis (keys: %v)", windowKey,
             ctx.Redis.Keys("aifw:rl:*"));
  const auto keys = ctx.Redis.Keys("aifw:rl:*");
  const long long count = std::strtoll(ctx.Redis.Get(keys[0]).value_or("0").c_str(), nullptr, 10);
  ctx.Assert(count <= kLimitCount,
             "the window holds %d after a request that was admitted: another replica filled it between your read and "
             "your increment, and your check used the stale count. Increment and check must be one server-side step "
             "(EVAL with INCR), not GET then INCR",
             count);
  const auto second = limitPost(c, "X-Api-Key", kLimitKeyName);
  ctx.Equal(second.Status, 429, "with the window filled by another replica the next request");
}

void CheckWindowTtl(harness::Ctx& ctx) {
  auto c = limitedProxy(ctx);
  const std::string windowKey = limitWindowKey(ctx);
  // The key's TTL the moment the first command that touched it has run: one script has already set it.
  bool born = false;
  long long bornTtl = 0;
  ctx.Redis.After(windowKey, [&ctx, &born, &bornTtl, windowKey] {
    born = true;
    bornTtl = ctx.Redis.TTL(windowKey);
  });
  ctx.Equal(limitBurst(c, kLimitCount + 1), limitStatuses(kLimitCount, 200, {429}), "a fresh key gets %d requests, then 429",
            kLimitCount);
  ctx.Equal(ctx.Redis.Keys("aifw:rl:*"), {windowKey},
            "the window keys (aifw:rl:{api_key}:{window} with window = floor(now / 60))");
  const long long ttl = ctx.Redis.TTL(windowKey);
  ctx.Assert(ttl > 0 && ttl <= 60, "%s has TTL %d: the script must EXPIRE the key it created (60 s), or the count lives forever",
             windowKey, ttl);
  ctx.Assert(born && bornTtl > 0 && bornTtl <= 60,
             "right after the first command that touched %s its TTL was %d: EXPIRE ran in a command of its own, so a "
             "replica that dies in between leaves a count that never expires. The script sets EXPIRE when it creates "
             "the key",
             windowKey, bornTtl);
  ctx.Clock.Advance(61);
  const auto r = limitPost(c, "X-Api-Key", kLimitKeyName);
  ctx.Equal(r.Status, 200, "61 s later, in a new window, the caller (the window must reset)");
  ctx.Equal(ctx.Redis.Keys("aifw:rl:*"), {limitWindowKey(ctx)}, "the window keys 61 s later (the old window expired)");
}

void CheckRetryAfter(harness::Ctx& ctx) {
  auto c = limitedProxy(ctx);
  limitBurst(c, kLimitCount);
  auto r = limitPost(c, "X-Api-Key", kLimitKeyName);
  ctx.Equal(r.Status, 429, "request %d", kLimitCount + 1);
  const long long first = limitRetryAfter(ctx, r, "on the first refusal");
  ctx.Assert(first <= 60, "Retry-After is %d right after the window was created, expected at most 60", first);
  ctx.Clock.Advance(20);
  r = limitPost(c, "X-Api-Key", kLimitKeyName);
  ctx.Equal(r.Status, 429, "20 s into the window request %d", kLimitCount + 2);
  const long long later = limitRetryAfter(ctx, r, "20 s into the window");
  ctx.Assert(later <= first - 19, "Retry-After went from %d to %d over 20 s: it must follow the TTL down, not restate a constant",
             first, later);
  const auto other = limitPost(c, "X-Api-Key", "key-b2c9");
  ctx.Equal(other.Status, 200, "another key (windows are per key)");
}

void CheckLimitFirst(harness::Ctx& ctx) {
  auto c = limitedProxy(ctx);
  const auto statuses = limitBurst(c, kLimitCount + 1);
  ctx.Equal(statuses.back(), 429, "request %d", kLimitCount + 1);
  const auto detects = ctx.GRPC.CallsTo("Detect").size();
  const auto chats = ctx.GRPC.CallsTo("Chat").size();
  ctx.Equal(detects, kLimitCount,
            "%d requests' Detect calls: the refused request was scored before the limit answered. The limit runs in a "
            "pre-routing handler; a refused request costs nothing",
            kLimitCount + 1);
  ctx.Equal(chats, kLimitCount, "%d requests' Chat calls: the refused request reached the application", kLimitCount + 1);
  const auto before = ctx.Redis.Keys("aifw:rl:*");
  const auto r = limitPost(c);
  ctx.Equal(r.Status, 401, "a request without a key (the route's 401)");
  ctx.Equal(ctx.Redis.Keys("aifw:rl:*"), before,
            "the window keys after a request without a key (it is the route's 401, not a window of its own)");
}
`,
  },
  debrief: `The script exists because a limit is a comparison against a number that other replicas are changing: only the server can increment and compare in one step, which is also why the expiry is set inside the script at the moment the count is created. The window goes into the key name so a new minute is a new key and the old one is garbage Redis collects on its own. \`Retry-After\` turns a refusal into a schedule. Production firewalls keep a second limit per IP beside the per-key one, use a sliding window or a token bucket where a hard minute boundary would let a caller double up at the edge, and fail open on a Redis outage because the detector still stands between the caller and the model.`,
};
